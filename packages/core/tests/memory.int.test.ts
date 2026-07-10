import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/memory.js";
import { createLocalEmbedding } from "../src/rag/embed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
const embedder = createLocalEmbedding();

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
}, 180_000);

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

describe("长期记忆", () => {
  it("owner 隔离:A 的记忆 B 召回不到", async () => {
    const store = new MemoryStore(handle.db, embedder);
    await store.write("owner-A", "declarative", "GlassBox 用 SKIP LOCKED 做任务队列");
    const bRecall = await store.recall("owner-B", "任务队列怎么做");
    expect(bRecall).toHaveLength(0);
    const aRecall = await store.recall("owner-A", "任务队列怎么做");
    expect(aRecall.length).toBeGreaterThan(0);
  });

  it("写入去重:高度相似的记忆不重复写", async () => {
    const store = new MemoryStore(handle.db, embedder, { dedupThreshold: 0.9 });
    const owner = "owner-dedup";
    expect(await store.write(owner, "declarative", "租约过期后 reaper 会重投递任务")).toBe(true);
    // 完全相同 → 相似度 1,去重
    expect(await store.write(owner, "declarative", "租约过期后 reaper 会重投递任务")).toBe(false);
    expect(await store.count(owner)).toBe(1);
    // 明显不同的记忆能写入
    expect(await store.write(owner, "procedural", "混合检索用 RRF 融合向量与全文两路")).toBe(true);
    expect(await store.count(owner)).toBe(2);
  });

  it("召回相关性下限:无关查询召回为空", async () => {
    const store = new MemoryStore(handle.db, embedder, { recallFloor: 0.5 });
    const owner = "owner-floor";
    await store.write(owner, "declarative", "PostgreSQL 的 FOR UPDATE SKIP LOCKED 跳过锁定行");
    const irrelevant = await store.recall(owner, "今天天气怎么样适合野餐吗");
    expect(irrelevant).toHaveLength(0);
  });

  it("容量上限:超出淘汰最久未用", async () => {
    const store = new MemoryStore(handle.db, embedder, { perOwnerCap: 3, dedupThreshold: 0.99 });
    const owner = "owner-cap";
    for (let i = 0; i < 5; i++) {
      await store.write(owner, "declarative", `记忆条目编号 ${i} 内容各不相同 alpha${i} beta${i}`);
    }
    expect(await store.count(owner)).toBeLessThanOrEqual(3);
  });
});
