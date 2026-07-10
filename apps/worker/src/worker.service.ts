import { hostname } from "node:os";
import {
  claimNextTask,
  completeTask,
  errorMessage,
  failTask,
  heartbeatTask,
  type ModelGateway,
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
import { type AgentContext, buildGateway, LeaseLostError, resolveAgent } from "./agents.js";
import { DB } from "./db.provider.js";
import { intEnv } from "./env.js";

// 生产默认;混沌测试用环境变量压短(2s 租约 + 快 reaper)制造快速重投递
const IDLE_POLL_MS = intEnv("WORKER_IDLE_POLL_MS", 1_000);
const LEASE_SECONDS = intEnv("WORKER_LEASE_SECONDS", 60);
const HEARTBEAT_MS = Math.max(500, Math.floor((LEASE_SECONDS / 3) * 1_000));
const REAP_INTERVAL_MS = intEnv("WORKER_REAP_INTERVAL_MS", 5_000);

/**
 * 认领循环 + 租约生命周期。具体 agent 逻辑分派到 agents.ts。
 *  - 执行期间按租约 1/3 周期心跳;心跳失败即自知僵尸,让出并放弃写入(守卫兜底);
 *  - 每个 worker 顺带周期跑 reaper;
 *  - 优雅退出:停机不再认领,跑完手头任务;SIGKILL 靠租约过期 + reaper 收尸。
 * M1 仍欠:park/resume(waiting_* 三态)、LISTEN 唤醒、并发槽位(p-limit)。
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = `${hostname()}#${process.pid}`;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private lastReapAt = 0;
  private gateway: ModelGateway;

  constructor(@Inject(DB) private readonly dbh: DbHandle) {
    this.gateway = buildGateway(dbh);
  }

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
    const handler = resolveAgent(task.agentName);
    if (!handler) {
      await this.finishFail(task.id, `unknown agent "${task.agentName}"`);
      return;
    }

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
      const ctx: AgentContext = {
        dbh: this.dbh,
        task,
        isLeaseLost: () => leaseLost,
        gateway: this.gateway,
      };
      const result = await handler(ctx);
      if (leaseLost) return; // 让出:终态由新持有者负责
      const done = await completeTask(this.dbh.db, task.id, this.workerId, result);
      this.logger.log(
        done ? `task ${task.id} succeeded` : `task ${task.id} terminal write skipped (zombie)`,
      );
    } catch (err) {
      if (err instanceof LeaseLostError) return;
      await this.finishFail(task.id, errorMessage(err));
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
