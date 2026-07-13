import { createLocalEmbedding, ingestDocument } from "@glassbox/core";
import { createDb, documents } from "@glassbox/db";
import { sql } from "drizzle-orm";
import { DEMO_CORPUS, DEMO_EVAL_CASES } from "./corpus.js";
import { evalRag, type Retriever, recordRagEval } from "./rag-eval.js";

/**
 * 确定性 RAG 召回评测 CLI(总纲 M5:确定性 bench,可复现、免费、卡 CI)。
 * 本地 bigram 嵌入 → 完全确定,同语料同题集永远同分,适合做回归门禁。
 * 用法:DATABASE_URL=... EVAL_LABEL=<版本> GATE_HIT5=0.6 tsx src/run-rag-eval.ts
 * 混合检索 hit-rate@5 低于阈值则退出码 1(卡合并)。
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const embedder = createLocalEmbedding();
  const label = process.env.EVAL_LABEL ?? "local";
  const gate = Number(process.env.GATE_HIT5 ?? "0.6");

  // 幂等摄取演示语料
  for (const doc of DEMO_CORPUS) {
    const existing = await db
      .select({ id: documents.id })
      .from(documents)
      .where(sql`${documents.source} = ${doc.source}`)
      .limit(1);
    if (existing.length === 0) await ingestDocument(db, embedder, doc);
  }

  const retrievers: Retriever[] = ["vector", "fts", "hybrid"];
  const results = [];
  for (const r of retrievers) {
    const res = await evalRag(db, embedder, r, DEMO_EVAL_CASES);
    results.push(res);
    console.log(
      `${r.padEnd(7)} hit@3=${res.hitRateAt3.toFixed(3)} hit@5=${res.hitRateAt5.toFixed(3)} mrr=${res.mrr.toFixed(3)} (${res.cases} 题)`,
    );
  }

  const hybrid = results.find((r) => r.retriever === "hybrid");
  if (!hybrid) throw new Error("hybrid eval missing");
  const id = await recordRagEval(db, label, hybrid);
  console.log(`recorded run #${id} label="${label}"`);

  await pool.end();

  if (hybrid.hitRateAt5 < gate) {
    console.error(`GATE FAILED: hybrid hit@5 ${hybrid.hitRateAt5.toFixed(3)} < ${gate}`);
    process.exit(1);
  }
  console.log(`GATE PASSED: hybrid hit@5 ${hybrid.hitRateAt5.toFixed(3)} >= ${gate}`);
}

void main();
