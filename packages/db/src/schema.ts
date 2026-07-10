import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** RAG 向量维度:对齐 SiliconFlow bge-m3(1024);本地嵌入桩也产 1024 维,切真模型免迁移 */
export const EMBEDDING_DIM = 1024;

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

/**
 * trace 三表(EMAgent 0001 的 model_calls/tool_calls/task_steps 移植;agent_runs 暂并入 task,
 * fan-out 落地时再拆)。这是"玻璃盒"的本体:每一步、每次模型/工具调用都可回放、可计费。
 */
export const taskSteps = pgTable(
  "task_steps",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    stepIndex: integer("step_index").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ix_task_steps_task").on(t.taskId, t.id)],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    // 可空:评测/离线调用不挂任务
    taskId: uuid("task_id").references(() => tasks.id),
    stepId: bigint("step_id", { mode: "number" }).references(() => taskSteps.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(),
    request: jsonb("request"),
    response: jsonb("response"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costCny: doublePrecision("cost_cny"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_model_calls_task").on(t.taskId),
    index("ix_model_calls_created").on(t.createdAt),
  ],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    stepId: bigint("step_id", { mode: "number" }).references(() => taskSteps.id),
    toolName: text("tool_name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: text("status").notNull(),
    error: text("error"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_tool_calls_task").on(t.taskId)],
);

// ---------------- RAG(M3):摄取 / 分块 / 混合检索 ----------------

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    source: text("source").notNull(),
    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_documents_owner").on(t.ownerId)],
);

/**
 * 分块表:content 是原文片段;bigramDoc 是 bigram 分词后的检索串(解决中文 FTS,总纲 §6);
 * embedding 是向量。HNSW(向量)与 GIN(FTS 表达式索引)在迁移 SQL 里手工加(drizzle 不生成)。
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    bigramDoc: text("bigram_doc").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_chunks_document").on(t.documentId)],
);

/**
 * 长期记忆(M4;EMAgent memory 移植):owner 隔离、声明式 + 程序性双记忆。
 * 写入去重(相似度阈值)、召回相关性下限、按 owner 容量上限 —— 逻辑在 core/memory。
 * 复用 M3 的嵌入(同 1024 维向量)。
 */
export const memories = pgTable(
  "memories",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull(), // declarative | procedural
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("ix_memories_owner").on(t.ownerId)],
);

/** RAG 评测基线:每次评测跑分入库,可追踪召回率曲线(总纲 M3 验收) */
export const ragEvalRuns = pgTable("rag_eval_runs", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  label: text("label").notNull(),
  retriever: text("retriever").notNull(),
  hitRateAt3: doublePrecision("hit_rate_at_3").notNull(),
  hitRateAt5: doublePrecision("hit_rate_at_5").notNull(),
  mrr: doublePrecision("mrr").notNull(),
  cases: integer("cases").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
