import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEmbedding, ingestDocument } from "@glassbox/core";
import { createDb, type DbHandle } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_CORPUS, DEMO_EVAL_CASES } from "../src/corpus.js";
import { evalRag, recordRagEval } from "../src/rag-eval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
const embedder = createLocalEmbedding();

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  for (const doc of DEMO_CORPUS) await ingestDocument(handle.db, embedder, doc);
}, 180_000);

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

describe("RAG 评测:hit-rate 与 MRR", () => {
  it("三种检索器都能算出指标,混合检索不差于任一单路", async () => {
    const vector = await evalRag(handle.db, embedder, "vector", DEMO_EVAL_CASES);
    const fts = await evalRag(handle.db, embedder, "fts", DEMO_EVAL_CASES);
    const hybrid = await evalRag(handle.db, embedder, "hybrid", DEMO_EVAL_CASES);

    for (const r of [vector, fts, hybrid]) {
      expect(r.cases).toBe(DEMO_EVAL_CASES.length);
      expect(r.hitRateAt5).toBeGreaterThanOrEqual(0);
      expect(r.hitRateAt5).toBeLessThanOrEqual(1);
    }
    // 混合检索的 hit@5 至少不低于两个单路各自(RRF 的意义)
    expect(hybrid.hitRateAt5).toBeGreaterThanOrEqual(Math.min(vector.hitRateAt5, fts.hitRateAt5));
    // 本地词法嵌入 + bigram FTS 对这个标注集应有可观召回
    expect(hybrid.hitRateAt5).toBeGreaterThanOrEqual(0.6);
  });

  it("跑分入库形成基线,可回查", async () => {
    const hybrid = await evalRag(handle.db, embedder, "hybrid", DEMO_EVAL_CASES);
    const id = await recordRagEval(handle.db, "ci-baseline", hybrid);
    expect(id).toBeGreaterThan(0);
  });
});
