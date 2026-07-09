import { EventEmitter } from "node:events";
import { TASK_EVENTS_CHANNEL, taskEventNotificationSchema } from "@glassbox/contracts";
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import pg from "pg";
import { requireEnv } from "./env.js";

/**
 * LISTEN 中继:独占一条 pg 连接监听 task_events,把"有新事件"的门铃
 * 按 taskId 分发给进程内订阅者(SSE handler)。真相在事件表,这里只搬指针。
 * 断线重连期间丢的 NOTIFY 由 SSE 侧的心跳兜底轮询补偿(M0 语义,M1 强化)。
 */
@Injectable()
export class TaskEventsRelay implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TaskEventsRelay.name);
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async onModuleInit(): Promise<void> {
    this.emitter.setMaxListeners(0);
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.end().catch(() => undefined);
  }

  /** 订阅某任务的门铃;返回退订函数 */
  subscribe(taskId: string, onDing: () => void): () => void {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, onDing);
    return () => this.emitter.off(channel, onDing);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
    client.on("error", (err) => this.logger.warn(`listen connection error: ${err.message}`));
    client.on("end", () => this.scheduleReconnect());
    client.on("notification", (msg) => this.onNotification(msg.payload));
    try {
      await client.connect();
      await client.query(`listen ${TASK_EVENTS_CHANNEL}`);
      this.client = client;
      this.logger.log(`listening on channel "${TASK_EVENTS_CHANNEL}"`);
    } catch (err) {
      this.logger.warn(`listen connect failed: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }

  private onNotification(payload: string | undefined): void {
    if (!payload) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.logger.warn(`ignoring malformed notification payload: ${payload}`);
      return;
    }
    const result = taskEventNotificationSchema.safeParse(parsed);
    if (!result.success) return;
    this.emitter.emit(`task:${result.data.taskId}`);
  }
}
