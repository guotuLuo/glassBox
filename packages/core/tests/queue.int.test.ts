import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle, tasks } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  heartbeatTask,
  listEventsAfter,
  reapExpiredLeases,
} from "../src/queue.js";
import { sleep } from "../src/utils.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
});

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

async function enqueueHello(message: string, idempotencyKey?: string) {
  return enqueueTask(handle.db, {
    agentName: "hello",
    request: { message },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

async function taskRow(id: string) {
  const rows = await handle.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`task ${id} disappeared`);
  return row;
}

async function eventTypes(id: string): Promise<string[]> {
  const events = await listEventsAfter(handle.db, id, 0);
  return events.map((e) => e.eventType);
}

describe("耐久队列:认领与租约", () => {
  it("认领置 running、写租约、计投递次数;队列空时返回 null", async () => {
    const { task } = await enqueueHello("claim-basic");
    const claimed = await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 60 });
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.leaseOwner).toBe("A");
    expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claimed?.deliveryAttempts).toBe(1);

    // 唯一任务已被认领,第二个 worker 拿不到东西
    const second = await claimNextTask(handle.db, { workerId: "B", leaseSeconds: 60 });
    expect(second).toBeNull();

    expect(await completeTask(handle.db, task.id, "A", { ok: true })).toBe(true);
  });

  it("心跳只对当前租约持有者续期", async () => {
    const { task } = await enqueueHello("heartbeat");
    await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 60 });
    const before = (await taskRow(task.id)).leaseExpiresAt?.getTime() ?? 0;

    await sleep(50);
    expect(
      await heartbeatTask(handle.db, { taskId: task.id, workerId: "A", leaseSeconds: 120 }),
    ).toBe(true);
    const after = (await taskRow(task.id)).leaseExpiresAt?.getTime() ?? 0;
    expect(after).toBeGreaterThan(before);

    expect(
      await heartbeatTask(handle.db, { taskId: task.id, workerId: "B", leaseSeconds: 120 }),
    ).toBe(false);

    expect(await completeTask(handle.db, task.id, "A", { ok: true })).toBe(true);
  });
});

describe("耐久队列:过期重投递与终态唯一", () => {
  it("租约过期被 reaper 重投递,新 worker 完成,僵尸的终态写入被拒", async () => {
    const { task } = await enqueueHello("zombie");
    const first = await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 1 });
    expect(first?.id).toBe(task.id);

    await sleep(1_300); // 让租约过期(模拟 worker A 假死)
    const reaped = await reapExpiredLeases(handle.db);
    expect(reaped.requeued).toBe(1);
    expect((await taskRow(task.id)).status).toBe("queued");

    // 首次重投递退避为 0,B 立即可认领
    const second = await claimNextTask(handle.db, { workerId: "B", leaseSeconds: 60 });
    expect(second?.id).toBe(task.id);
    expect(second?.deliveryAttempts).toBe(2);

    expect(await completeTask(handle.db, task.id, "B", { by: "B" })).toBe(true);
    // 僵尸 A 苏醒补写终态:守卫拒绝,不产生第二个终态
    expect(await completeTask(handle.db, task.id, "A", { by: "A" })).toBe(false);
    expect(await failTask(handle.db, task.id, "A", "late failure")).toBe(false);

    const row = await taskRow(task.id);
    expect(row.status).toBe("succeeded");
    expect(row.result).toEqual({ by: "B" });
    const types = await eventTypes(task.id);
    expect(types.filter((t) => t === "task.succeeded")).toHaveLength(1);
    expect(types.filter((t) => t === "task.failed")).toHaveLength(0);
    expect(types).toContain("task.requeued");
  });

  it("投递次数耗尽进死信:status=failed + dead_letter 标志 + 事件", async () => {
    const { task } = await enqueueHello("dead-letter");
    await handle.db.update(tasks).set({ maxDeliveryAttempts: 1 }).where(eq(tasks.id, task.id));

    await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 1 });
    await sleep(1_300);
    const reaped = await reapExpiredLeases(handle.db);
    expect(reaped.deadLettered).toBe(1);
    expect(reaped.requeued).toBe(0);

    const row = await taskRow(task.id);
    expect(row.status).toBe("failed");
    expect(row.deadLetter).toBe(true);
    expect(row.error).toMatch(/exhausted/);
    expect(await eventTypes(task.id)).toContain("task.dead_lettered");

    // 死信不再可认领
    const again = await claimNextTask(handle.db, { workerId: "B", leaseSeconds: 60 });
    expect(again).toBeNull();
  });
});

describe("耐久队列:幂等键", () => {
  it("同 key 并发提交只入队一次,双方拿到同一任务", async () => {
    const key = "idem-race-0001";
    const [r1, r2] = await Promise.all([enqueueHello("first", key), enqueueHello("second", key)]);
    expect(r1.task.id).toBe(r2.task.id);
    expect([r1.inserted, r2.inserted].sort()).toEqual([false, true]);
    // 只发了一条 task.queued 事件
    const types = await eventTypes(r1.task.id);
    expect(types.filter((t) => t === "task.queued")).toHaveLength(1);
    expect(await completeTask(handle.db, r1.task.id, "none", {})).toBe(false); // 未认领不可完成
  });
});
