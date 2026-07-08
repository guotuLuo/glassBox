import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * 字段设计移植自 EMAgent migrations 0001/0003/0004/0005(总纲 §6)。
 * 有意偏差(PG-only,不再迁就 SQLite):
 *  - 时间戳 String → timestamptz:租约判定 lease_expires_at < now() 直接在 SQL 里做
 *  - *_json Text → jsonb;available_at 改 NOT NULL DEFAULT now(),认领谓词简化为 <= now()
 *  - task_events.id String uuid → bigint identity:回放/SSE 需要每任务事件的全序
 *  - progress/tags/metadata、agent_run_id 等 trace 列推迟到 M1 增量迁移
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id),
    agentName: text("agent_name").notNull(),
    status: text("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    error: text("error"),
    // 耐久队列(EMAgent 0003)
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    maxDeliveryAttempts: integer("max_delivery_attempts").notNull().default(3),
    deadLetter: boolean("dead_letter").notNull().default(false),
    idempotencyKey: text("idempotency_key"),
    // 检查点:park(审批/子任务/人输入)后精确恢复(EMAgent 0004)
    checkpoint: jsonb("checkpoint"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // 认领热路径:WHERE status='queued' AND available_at<=now() ... FOR UPDATE SKIP LOCKED
    index("ix_tasks_claim").on(t.status, t.availableAt),
    // 并发同 key 提交只允许一条插入(EMAgent 0005;PG 对 NULL 不判重)
    uniqueIndex("ux_tasks_idempotency_key").on(t.idempotencyKey),
    index("ix_tasks_lease_expires_at").on(t.leaseExpiresAt),
    index("ix_tasks_parent_task_id").on(t.parentTaskId),
    index("ix_tasks_created_at").on(t.createdAt),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    eventType: text("event_type").notNull(),
    message: text("message"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // SSE 增量拉取 + 回放:按 (task_id, id) 顺序消费
    index("ix_task_events_task_stream").on(t.taskId, t.id),
  ],
);
