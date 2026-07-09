import { hostname } from "node:os";
import { helloInputSchema } from "@glassbox/contracts";
import {
  appendEvent,
  claimNextTask,
  completeTask,
  errorMessage,
  failTask,
  heartbeatTask,
  reapExpiredLeases,
  sleep,
} from "@glassbox/core";
import type { DbHandle, TaskRow } from "@glassbox/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { DB } from "./db.provider.js";

const IDLE_POLL_MS = 1_000;
const LEASE_SECONDS = 60;
const HEARTBEAT_MS = (LEASE_SECONDS / 3) * 1_000;
const REAP_INTERVAL_MS = 5_000;
const HELLO_STEPS = 3;
const HELLO_STEP_MS = 400;

/**
 * 认领循环 + 租约生命周期:
 *  - 执行期间按租约 1/3 周期心跳续租;心跳失败说明租约已易主(本进程成了僵尸),
 *    终态写入交给新持有者,这里只放弃(completeTask/failTask 的守卫兜底);
 *  - 每个 worker 顺带周期性跑 reaper,过期租约重投递 / 超限进死信,多实例天然安全;
 *  - 优雅退出:停机后不再认领,跑完手头任务才归还进程。
 * M1 仍欠:LISTEN 唤醒、并发槽位(p-limit)、park/检查点、SIGKILL 混沌测试。
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = `${hostname()}#${process.pid}`;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private lastReapAt = 0;

  constructor(@Inject(DB) private readonly dbh: DbHandle) {}

  onApplicationBootstrap(): void {
    this.loop = this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log("shutdown requested, draining current task...");
    this.stopping = true;
    await this.loop;
    await this.dbh.pool.end();
    this.logger.log("drained, bye");
  }

  private async runLoop(): Promise<void> {
    this.logger.log(
      `worker ${this.workerId} started (lease ${LEASE_SECONDS}s, heartbeat ${HEARTBEAT_MS / 1000}s)`,
    );
    while (!this.stopping) {
      try {
        await this.maybeReap();
        const task = await claimNextTask(this.dbh.db, {
          workerId: this.workerId,
          leaseSeconds: LEASE_SECONDS,
        });
        if (!task) {
          await sleep(IDLE_POLL_MS);
          continue;
        }
        this.logger.log(
          `claimed task ${task.id} (${task.agentName}, delivery ${task.deliveryAttempts})`,
        );
        await this.execute(task);
      } catch (err) {
        this.logger.error(`loop iteration failed: ${errorMessage(err)}`);
        await sleep(IDLE_POLL_MS);
      }
    }
  }

  private async maybeReap(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReapAt < REAP_INTERVAL_MS) return;
    this.lastReapAt = now;
    const { requeued, deadLettered } = await reapExpiredLeases(this.dbh.db);
    if (requeued > 0 || deadLettered > 0) {
      this.logger.warn(`reaper: requeued=${requeued} deadLettered=${deadLettered}`);
    }
  }

  private async execute(task: TaskRow): Promise<void> {
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void heartbeatTask(this.dbh.db, {
        taskId: task.id,
        workerId: this.workerId,
        leaseSeconds: LEASE_SECONDS,
      })
        .then((ok) => {
          if (!ok) {
            leaseLost = true;
            this.logger.warn(`lease lost for task ${task.id}, abandoning terminal write`);
          }
        })
        .catch((err) => this.logger.warn(`heartbeat failed: ${errorMessage(err)}`));
    }, HEARTBEAT_MS);

    try {
      if (task.agentName !== "hello") {
        await this.finishFail(task.id, `unknown agent "${task.agentName}"`);
        return;
      }
      try {
        const input = helloInputSchema.parse(task.request);
        for (let step = 1; step <= HELLO_STEPS; step++) {
          if (leaseLost) return;
          await sleep(HELLO_STEP_MS);
          await appendEvent(this.dbh.db, {
            taskId: task.id,
            eventType: "hello.step",
            message: `step ${step}/${HELLO_STEPS}`,
            payload: { step, total: HELLO_STEPS },
          });
        }
        const result = {
          greeting: `Hello, ${input.message}!`,
          steps: HELLO_STEPS,
          workerId: this.workerId,
        };
        const done = await completeTask(this.dbh.db, task.id, this.workerId, result);
        this.logger.log(
          done ? `task ${task.id} succeeded` : `task ${task.id} terminal write skipped (zombie)`,
        );
      } catch (err) {
        await this.finishFail(task.id, errorMessage(err));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finishFail(taskId: string, message: string): Promise<void> {
    const done = await failTask(this.dbh.db, taskId, this.workerId, message);
    this.logger.warn(
      done
        ? `task ${taskId} failed: ${message}`
        : `task ${taskId} fail write skipped (zombie): ${message}`,
    );
  }
}
