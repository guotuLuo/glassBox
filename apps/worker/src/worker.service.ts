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
  saveCheckpoint,
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
import { z } from "zod";
import { DB } from "./db.provider.js";
import { intEnv } from "./env.js";

// 生产默认;混沌测试用环境变量压短(2s 租约 + 快 reaper)制造快速重投递
const IDLE_POLL_MS = intEnv("WORKER_IDLE_POLL_MS", 1_000);
const LEASE_SECONDS = intEnv("WORKER_LEASE_SECONDS", 60);
const HEARTBEAT_MS = Math.max(500, Math.floor((LEASE_SECONDS / 3) * 1_000));
const REAP_INTERVAL_MS = intEnv("WORKER_REAP_INTERVAL_MS", 5_000);
const HELLO_STEPS = 3;
const HELLO_STEP_MS = intEnv("HELLO_STEP_MS", 400);

/** hello agent 的检查点:最后一个已完成的 step */
const helloCheckpointSchema = z.object({ step: z.number().int().min(0).max(HELLO_STEPS) });

/**
 * 认领循环 + 租约生命周期 + 检查点续跑:
 *  - 执行期间按租约 1/3 周期心跳;心跳失败即自知僵尸,放弃后续写入(守卫兜底);
 *  - 每个 worker 顺带周期跑 reaper;
 *  - 每完成一步写检查点,重投递后从断点续跑(step 事件的重复被压到至多一步);
 *  - 优雅退出:停机不再认领,跑完手头任务;SIGKILL 则靠租约过期 + reaper 收尸。
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
      `worker ${this.workerId} started (lease ${LEASE_SECONDS}s, heartbeat ${HEARTBEAT_MS}ms, reap ${REAP_INTERVAL_MS}ms)`,
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
        // 检查点续跑:重投递的任务从断点继续,不从头再来
        const parsedCp = helloCheckpointSchema.safeParse(task.checkpoint);
        const startStep = parsedCp.success ? parsedCp.data.step : 0;
        if (startStep > 0) {
          this.logger.log(`task ${task.id} resuming from checkpoint step ${startStep}`);
        }
        for (let step = startStep + 1; step <= HELLO_STEPS; step++) {
          if (leaseLost) return;
          await sleep(HELLO_STEP_MS);
          await appendEvent(this.dbh.db, {
            taskId: task.id,
            eventType: "hello.step",
            message: `step ${step}/${HELLO_STEPS}`,
            payload: { step, total: HELLO_STEPS },
          });
          await saveCheckpoint(this.dbh.db, task.id, this.workerId, { step });
        }
        const result = {
          greeting: `Hello, ${input.message}!`,
          steps: HELLO_STEPS,
          workerId: this.workerId,
          resumedFromStep: startStep,
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
