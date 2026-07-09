import { TASK_EVENTS_CHANNEL, type TaskEventNotification } from "@glassbox/contracts";
import { type Db, type TaskEventRow, type TaskRow, taskEvents, tasks } from "@glassbox/db";
import { and, eq, gt, sql } from "drizzle-orm";

/**
 * M0 队列切片:enqueue / claim / complete / fail + 事件追加。
 * 语义边界(诚实声明,M1 才补齐):
 *  - 租约只在认领时设置,尚无心跳续租与过期重投递(reaper);
 *  - failed 在 M0 是终态,delivery_attempts 计数已就位但重试策略未激活;
 *  - 事件与状态变更同事务提交,pg_notify 随事务提交后送达(门铃语义)。
 */

/** drizzle 事务回调里的执行器与 Db 同构,统一用该别名 */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AppendEventInput {
  taskId: string;
  eventType: string;
  message?: string;
  payload?: unknown;
}

/** 事件插入 + NOTIFY 门铃(载荷只带指针,正文永远回表取) */
export async function appendEvent(ex: DbExecutor, input: AppendEventInput): Promise<TaskEventRow> {
  const rows = await ex
    .insert(taskEvents)
    .values({
      taskId: input.taskId,
      eventType: input.eventType,
      message: input.message ?? null,
      payload: input.payload ?? null,
    })
    .returning();
  const event = rows[0];
  if (!event) throw new Error("task_events insert returned no row");
  const notification: TaskEventNotification = { taskId: event.taskId, eventId: event.id };
  await ex.execute(sql`select pg_notify(${TASK_EVENTS_CHANNEL}, ${JSON.stringify(notification)})`);
  return event;
}

export interface EnqueueInput {
  agentName: string;
  request: unknown;
  idempotencyKey?: string;
  createdBy?: string;
}

export interface EnqueueResult {
  task: TaskRow;
  /** false = 幂等键命中已有任务,本次未插入 */
  inserted: boolean;
}

/** 入队:插入 + task.queued 事件同事务;幂等键冲突时返回已存在任务 */
export async function enqueueTask(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(tasks)
      .values({
        agentName: input.agentName,
        request: input.request,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing({ target: tasks.idempotencyKey })
      .returning();
    const task = inserted[0];
    if (!task) {
      // 幂等键命中:返回既有任务,不重复发事件
      if (!input.idempotencyKey) throw new Error("task insert returned no row");
      const existing = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.idempotencyKey, input.idempotencyKey))
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error("idempotency conflict but existing task not found");
      return { task: found, inserted: false };
    }
    await appendEvent(tx, {
      taskId: task.id,
      eventType: "task.queued",
      message: `queued for agent "${task.agentName}"`,
    });
    return { task, inserted: true };
  });
}

export interface ClaimInput {
  workerId: string;
  leaseSeconds: number;
}

/**
 * 认领:UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)。
 * SKIP LOCKED 让并发 worker 各拿各的行,互不排队;租约窗口写入 lease_expires_at。
 */
export async function claimNextTask(db: Db, input: ClaimInput): Promise<TaskRow | null> {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        status: "running",
        leaseOwner: input.workerId,
        leaseExpiresAt: sql`now() + make_interval(secs => ${input.leaseSeconds})`,
        deliveryAttempts: sql`${tasks.deliveryAttempts} + 1`,
        startedAt: sql`coalesce(${tasks.startedAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(
        eq(
          tasks.id,
          sql`(
            select id from ${tasks}
            where ${tasks.status} = 'queued' and ${tasks.availableAt} <= now()
            order by ${tasks.availableAt}
            limit 1
            for update skip locked
          )`,
        ),
      )
      .returning();
    const task = rows[0];
    if (!task) return null;
    await appendEvent(tx, {
      taskId: task.id,
      eventType: "task.claimed",
      message: `claimed by ${input.workerId}`,
      payload: { deliveryAttempts: task.deliveryAttempts },
    });
    return task;
  });
  return claimed;
}

/** 完成:状态置 succeeded + 结果落库 + 终态事件,同事务 */
export async function completeTask(db: Db, taskId: string, result: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "succeeded",
        result,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, taskId));
    await appendEvent(tx, { taskId, eventType: "task.succeeded", payload: { result } });
  });
}

/** 失败:M0 下为终态(重投递策略 M1 激活) */
export async function failTask(db: Db, taskId: string, errorMessage: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "failed",
        error: errorMessage,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, taskId));
    await appendEvent(tx, { taskId, eventType: "task.failed", message: errorMessage });
  });
}

/** 单任务查询(api 出口用;查询逻辑收在 core,controller 不碰 SQL) */
export async function getTaskById(db: Db, taskId: string): Promise<TaskRow | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return rows[0] ?? null;
}

/** 回放/增量拉取:task 的事件流,按 id 全序 */
export async function listEventsAfter(
  db: Db,
  taskId: string,
  afterEventId: number,
): Promise<TaskEventRow[]> {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.id, afterEventId)))
    .orderBy(taskEvents.id);
}
