import { TASK_EVENTS_CHANNEL, type TaskEventNotification } from "@glassbox/contracts";
import { type Db, type TaskEventRow, type TaskRow, taskEvents, tasks } from "@glassbox/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";

/**
 * 耐久队列切片(M0 打底,M1 激活租约语义)。
 * 交付语义(总纲 §6 口径):执行 at-least-once,任务终态 exactly-once ——
 * 终态写入以 (id, lease_owner, status='running') 为守卫,僵尸 worker 的迟到写入变成 no-op;
 * 中途步骤(事件)在重投递后可能重复,消费方按事件 id 幂等。
 * M1 仍欠:park/resume、检查点恢复、SIGKILL 混沌测试。
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
 * SKIP LOCKED 让并发 worker 各拿各的行;租约窗口由 SQL 侧 now() 计算,应用时钟不参与。
 */
export async function claimNextTask(db: Db, input: ClaimInput): Promise<TaskRow | null> {
  return db.transaction(async (tx) => {
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
}

export interface HeartbeatInput {
  taskId: string;
  workerId: string;
  leaseSeconds: number;
}

/** 心跳续租:仍持有租约才续期;false = 租约已易主或任务已离开 running */
export async function heartbeatTask(db: Db, input: HeartbeatInput): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${input.leaseSeconds})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.leaseOwner, input.workerId),
        eq(tasks.status, "running"),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export interface ReapResult {
  requeued: number;
  deadLettered: number;
}

/**
 * 过期租约回收(reaper):worker 周期性调用,天然多实例安全——
 * UPDATE 原子生效,后到者的 WHERE 匹配不到已被改走的行。
 * 退避:第 n 次投递失败后等 (n-1)*5s(上限 60s)才再次可认领;首次重投递不等待。
 */
export async function reapExpiredLeases(db: Db): Promise<ReapResult> {
  const requeuedRows = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: sql`now() + make_interval(secs => greatest(least((${tasks.deliveryAttempts} - 1) * 5, 60), 0))`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.status, "running"),
          sql`${tasks.leaseExpiresAt} < now()`,
          sql`${tasks.deliveryAttempts} < ${tasks.maxDeliveryAttempts}`,
        ),
      )
      .returning({ id: tasks.id, attempts: tasks.deliveryAttempts });
    for (const row of rows) {
      await appendEvent(tx, {
        taskId: row.id,
        eventType: "task.requeued",
        message: `lease expired after delivery ${row.attempts}, requeued`,
        payload: { deliveryAttempts: row.attempts },
      });
    }
    return rows;
  });

  const deadRows = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        status: "failed",
        deadLetter: true,
        error: "lease expired and max delivery attempts exhausted",
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.status, "running"),
          sql`${tasks.leaseExpiresAt} < now()`,
          sql`${tasks.deliveryAttempts} >= ${tasks.maxDeliveryAttempts}`,
        ),
      )
      .returning({ id: tasks.id, attempts: tasks.deliveryAttempts });
    for (const row of rows) {
      await appendEvent(tx, {
        taskId: row.id,
        eventType: "task.dead_lettered",
        message: `max delivery attempts (${row.attempts}) exhausted`,
      });
    }
    return rows;
  });

  return { requeued: requeuedRows.length, deadLettered: deadRows.length };
}

/**
 * 完成:仅当调用方仍持有租约(终态 exactly-once 守卫)。
 * false = 租约已易主(本 worker 是僵尸),终态由新持有者负责,调用方必须放弃写入。
 */
export async function completeTask(
  db: Db,
  taskId: string,
  workerId: string,
  result: unknown,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        status: "succeeded",
        result,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, workerId), eq(tasks.status, "running")))
      .returning({ id: tasks.id });
    if (rows.length === 0) return false;
    await appendEvent(tx, { taskId, eventType: "task.succeeded", payload: { result } });
    return true;
  });
}

/** 失败(业务错误,非租约过期):同样受终态守卫;dead_letter 标志只由 reaper 置位 */
export async function failTask(
  db: Db,
  taskId: string,
  workerId: string,
  errorMessage: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({
        status: "failed",
        error: errorMessage,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, workerId), eq(tasks.status, "running")))
      .returning({ id: tasks.id });
    if (rows.length === 0) return false;
    await appendEvent(tx, { taskId, eventType: "task.failed", message: errorMessage });
    return true;
  });
}

/** 最近任务列表(工作台侧边栏;M1 控制台再加分页/筛选) */
export async function listRecentTasks(db: Db, limit: number): Promise<TaskRow[]> {
  return db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
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
