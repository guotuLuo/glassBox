import { hostname } from "node:os";
import { helloInputSchema } from "@glassbox/contracts";
import {
  appendEvent,
  claimNextTask,
  completeTask,
  errorMessage,
  failTask,
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
const HELLO_STEPS = 3;
const HELLO_STEP_MS = 400;

/**
 * M0 认领循环:单并发轮询,拿到任务就执行 hello agent。
 * 优雅退出:收到停机信号后不再认领,跑完手头任务才归还进程(drain 语义雏形)。
 * M1 补齐:LISTEN 唤醒、心跳续租、过期重投递、并发槽位(p-limit)。
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = `${hostname()}#${process.pid}`;
  private stopping = false;
  private loop: Promise<void> | null = null;

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
    this.logger.log(`worker ${this.workerId} started (lease ${LEASE_SECONDS}s)`);
    while (!this.stopping) {
      try {
        const task = await claimNextTask(this.dbh.db, {
          workerId: this.workerId,
          leaseSeconds: LEASE_SECONDS,
        });
        if (!task) {
          await sleep(IDLE_POLL_MS);
          continue;
        }
        this.logger.log(`claimed task ${task.id} (${task.agentName})`);
        await this.execute(task);
      } catch (err) {
        this.logger.error(`loop iteration failed: ${errorMessage(err)}`);
        await sleep(IDLE_POLL_MS);
      }
    }
  }

  private async execute(task: TaskRow): Promise<void> {
    if (task.agentName !== "hello") {
      await failTask(this.dbh.db, task.id, `unknown agent "${task.agentName}"`);
      return;
    }
    try {
      const input = helloInputSchema.parse(task.request);
      for (let step = 1; step <= HELLO_STEPS; step++) {
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
      await completeTask(this.dbh.db, task.id, result);
      this.logger.log(`task ${task.id} succeeded`);
    } catch (err) {
      const message = errorMessage(err);
      await failTask(this.dbh.db, task.id, message);
      this.logger.warn(`task ${task.id} failed: ${message}`);
    }
  }
}
