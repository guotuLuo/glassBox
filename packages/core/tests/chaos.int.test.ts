import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle, taskEvents, tasks } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { enqueueTask } from "../src/queue.js";
import { sleep } from "../src/utils.js";

/**
 * SIGKILL 混沌测试(EMAgent test_chaos/test_durability 的 TS 复刻):
 * 拉真实 worker 子进程(node --import tsx,单进程可直杀),执行中途硬杀,
 * 断言:全部任务收敛到 succeeded、终态事件每任务恰好一条、
 * 重投递有界、检查点把 step 重放压到「每次重投递至多一步」。
 * 注:Windows 上 SIGKILL 映射为 TerminateProcess(同样无清理机会);语义基准以 CI 的 Linux 为准。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");
const WORKER_DIR = path.resolve(here, "../../../apps/worker");

const TASK_COUNT = 8;
const HELLO_STEPS = 3;

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
const children: ChildProcess[] = [];
const childLogs = new Map<number, { buf: string }>();

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  await sleep(300);
  await handle?.pool.end();
  await container?.stop();
});

function spawnWorker(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      DATABASE_URL: container.getConnectionUri(),
      WORKER_LEASE_SECONDS: "2",
      WORKER_REAP_INTERVAL_MS: "500",
      WORKER_IDLE_POLL_MS: "200",
      HELLO_STEP_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { buf: "" };
  childLogs.set(child.pid ?? -1, log);
  child.stdout?.on("data", (d: Buffer) => {
    log.buf += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    log.buf += d.toString();
  });
  children.push(child);
  return child;
}

async function allRows() {
  return handle.db.select().from(tasks);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(300);
  }
  for (const [pid, log] of childLogs) {
    console.log(`--- worker ${pid} 日志尾部 ---\n${log.buf.slice(-1200)}`);
  }
  throw new Error(`waitFor 超时: ${label}`);
}

it("SIGKILL 混沌:执行中途连杀 worker,任务全部收敛且终态唯一、重放有界", async () => {
  const ids: string[] = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    const { task } = await enqueueTask(handle.db, {
      agentName: "hello",
      request: { message: `chaos-${i}` },
      maxDeliveryAttempts: 10,
    });
    ids.push(task.id);
  }

  // 第一刀:w1 正在执行时硬杀
  const w1 = spawnWorker();
  await waitFor(
    async () => (await allRows()).some((r) => r.status === "running"),
    30_000,
    "w1 开始执行",
  );
  w1.kill("SIGKILL");

  // 第二刀:w2 推进过若干任务、手头有活时硬杀(若它已清空队列则跳过)
  const w2 = spawnWorker();
  await waitFor(
    async () => (await allRows()).filter((r) => r.status === "succeeded").length >= 2,
    60_000,
    "w2 推进若干任务",
  );
  await waitFor(
    async () => {
      const rows = await allRows();
      return (
        rows.some((r) => r.status === "running") ||
        rows.every((r) => r.status === "succeeded" || r.status === "failed")
      );
    },
    30_000,
    "w2 手头有活或队列清空",
  );
  w2.kill("SIGKILL");

  // w3 收尾:全部任务必须收敛
  spawnWorker();
  await waitFor(
    async () => (await allRows()).every((r) => r.status === "succeeded" || r.status === "failed"),
    120_000,
    "全部任务终态",
  );

  const rows = await allRows();
  for (const row of rows) {
    expect(row.status).toBe("succeeded");
    expect(row.deadLetter).toBe(false);
    expect(row.deliveryAttempts).toBeLessThanOrEqual(10);
  }
  // 刀确实砍中过:至少一个任务经历重投递
  expect(Math.max(...rows.map((r) => r.deliveryAttempts))).toBeGreaterThanOrEqual(2);

  for (const id of ids) {
    const events = await handle.db.select().from(taskEvents).where(eq(taskEvents.taskId, id));
    const row = rows.find((r) => r.id === id);
    // 任务级终态 exactly-once
    expect(events.filter((e) => e.eventType === "task.succeeded")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "task.failed")).toHaveLength(0);
    // 检查点约束重放:每次重投递至多重放一步
    const steps = events.filter((e) => e.eventType === "hello.step").length;
    const deliveries = row?.deliveryAttempts ?? 1;
    expect(steps).toBeGreaterThanOrEqual(HELLO_STEPS);
    expect(steps).toBeLessThanOrEqual(HELLO_STEPS + (deliveries - 1));
  }
}, 180_000);
