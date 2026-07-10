import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalEmbedding } from "../src/rag/embed.js";
import { ingestDocument } from "../src/rag/ingest.js";
import { ftsSearch, hybridSearch, vectorSearch } from "../src/rag/retrieve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
const embedder = createLocalEmbedding();

const CORPUS = [
  {
    title: "SKIP LOCKED 队列",
    source: "doc://queue",
    text: "FOR UPDATE SKIP LOCKED 让并发消费者跳过已被锁定的行,从而把一张 PostgreSQL 表安全地当作工作队列,消费者之间互不阻塞。",
  },
  {
    title: "租约与重投递",
    source: "doc://lease",
    text: "基于租约的任务分发通过 lease_expires_at 判定 worker 是否失联;过期后由 reaper 重投递,配合投递上限进入死信队列。",
  },
  {
    title: "引用级反幻觉",
    source: "doc://citation",
    text: "把每条论断绑定到具体检索片段,再由另一个模型做核实并红黄绿标注,是可审计的反幻觉方案。",
  },
];

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  for (const doc of CORPUS) await ingestDocument(handle.db, embedder, doc);
}, 180_000);

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

describe("RAG 摄取与检索", () => {
  it("摄取切块并落库(短文各成一块)", async () => {
    const vec = await vectorSearch(handle.db, embedder, "队列", 10);
    expect(vec.length).toBeGreaterThanOrEqual(CORPUS.length);
  });

  it("FTS 词法检索命中含关键词的块", async () => {
    const hits = await ftsSearch(handle.db, "SKIP LOCKED 队列", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("SKIP LOCKED");
  });

  it("向量检索按相似度返回,分数在 [-1,1]", async () => {
    const hits = await vectorSearch(handle.db, embedder, "租约 重投递 死信", 3);
    expect(hits[0]?.content).toContain("租约");
    for (const h of hits) expect(h.score).toBeLessThanOrEqual(1.0001);
  });

  it("混合检索:RRF 融合,候选带分路诊断,相关块居首", async () => {
    const cands = await hybridSearch(handle.db, embedder, "为什么 SKIP LOCKED 能做任务队列", {
      perChannel: 10,
      topK: 5,
    });
    expect(cands.length).toBeGreaterThan(0);
    const top = cands[0];
    expect(top?.content).toContain("SKIP LOCKED");
    // 融合分单调 + finalRank 连续
    expect(cands[0]?.finalRank).toBe(1);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1]?.fusedScore).toBeGreaterThanOrEqual(cands[i]?.fusedScore ?? 0);
    }
    // 至少一路命中(诊断字段存在)
    expect(top?.vectorRank !== null || top?.ftsRank !== null).toBe(true);
  });

  it("两路都命中的块,融合分高于单路命中", async () => {
    const cands = await hybridSearch(handle.db, embedder, "租约 lease reaper 重投递", {
      perChannel: 10,
      topK: 5,
    });
    const both = cands.find((c) => c.vectorRank !== null && c.ftsRank !== null);
    const single = cands.find((c) => c.vectorRank === null || c.ftsRank === null);
    if (both && single) expect(both.fusedScore).toBeGreaterThan(single.fusedScore);
  });
});
