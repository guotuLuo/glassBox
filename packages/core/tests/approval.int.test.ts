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
  listPendingApprovals,
  parkForApproval,
  reapExpiredLeases,
  resolveApproval,
  saveCheckpoint,
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
}, 180_000);

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

async function taskRow(id: string) {
  const rows = await handle.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("task gone");
  return row;
}

describe("审批 park / resume", () => {
  it("park→approve→精确恢复:草拟一次,批准后跨审批点完成", async () => {
    const { task } = await enqueueTask(handle.db, {
      agentName: "approval",
      request: { message: "发布公告" },
    });
    const claimed = await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 60 });
    expect(claimed?.id).toBe(task.id);

    // 草拟 + park
    await saveCheckpoint(handle.db, task.id, "A", { drafted: true });
    expect(
      await parkForApproval(handle.db, task.id, "A", {
        reason: "写动作需审批",
        checkpoint: { drafted: true, pendingApproval: true },
      }),
    ).toBe(true);

    let row = await taskRow(task.id);
    expect(row.status).toBe("waiting_approval");
    expect(row.leaseOwner).toBeNull(); // 租约已释放

    // park 的任务不可被认领(不在队列)
    expect(await claimNextTask(handle.db, { workerId: "B", leaseSeconds: 60 })).toBeNull();
    // reaper 不碰 waiting_approval
    expect((await reapExpiredLeases(handle.db)).requeued).toBe(0);

    // 出现在审批台
    const pending = await listPendingApprovals(handle.db);
    expect(pending.map((p) => p.id)).toContain(task.id);

    // 批准 → 回 queued,检查点带 decision
    expect(await resolveApproval(handle.db, task.id, "approve", "同意发布")).toBe(true);
    row = await taskRow(task.id);
    expect(row.status).toBe("queued");
    expect((row.checkpoint as { decision?: string }).decision).toBe("approved");

    // 新 worker 认领,从检查点恢复(草拟不重做)
    const resumed = await claimNextTask(handle.db, { workerId: "C", leaseSeconds: 60 });
    expect(resumed?.id).toBe(task.id);
    const cp = resumed?.checkpoint as {
      drafted?: boolean;
      decision?: string;
      approvalNote?: string;
    };
    expect(cp.drafted).toBe(true);
    expect(cp.decision).toBe("approved");
    expect(cp.approvalNote).toBe("同意发布");
    expect(await completeTask(handle.db, task.id, "C", { published: true })).toBe(true);
    expect((await taskRow(task.id)).status).toBe("succeeded");
  });

  it("reject → 终态 failed,不再被认领", async () => {
    const { task } = await enqueueTask(handle.db, {
      agentName: "approval",
      request: { message: "危险操作" },
    });
    await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 60 });
    await parkForApproval(handle.db, task.id, "A", { reason: "需审批", checkpoint: {} });

    expect(await resolveApproval(handle.db, task.id, "reject", "不批准")).toBe(true);
    const row = await taskRow(task.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/rejected/);
    // 已决议的不能再决议(守卫)
    expect(await resolveApproval(handle.db, task.id, "approve")).toBe(false);
  });

  it("park 的任务扛 worker 重启(纯 DB 态,无租约不过期)", async () => {
    const { task } = await enqueueTask(handle.db, {
      agentName: "approval",
      request: { message: "x" },
    });
    await claimNextTask(handle.db, { workerId: "A", leaseSeconds: 1 });
    await parkForApproval(handle.db, task.id, "A", { reason: "r", checkpoint: {} });
    await sleep(1_200); // 超过原租约时长
    await reapExpiredLeases(handle.db); // 即便 reaper 跑,也不该动它
    expect((await taskRow(task.id)).status).toBe("waiting_approval");
  });
});
