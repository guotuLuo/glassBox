import { embeddingFromEnv, ingestDocument } from "@glassbox/core";
import { createDb, documents } from "@glassbox/db";
import { DEMO_CORPUS } from "@glassbox/eval";
import { sql } from "drizzle-orm";
import { loadEnv, requireEnv } from "./env.js";

/** 摄取演示语料到 RAG 库(幂等:已有同名 source 则跳过)。`pnpm --filter @glassbox/api seed:rag` */
loadEnv();

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const embedder = embeddingFromEnv();
  let ingested = 0;
  for (const doc of DEMO_CORPUS) {
    const existing = await db
      .select({ id: documents.id })
      .from(documents)
      .where(sql`${documents.source} = ${doc.source}`)
      .limit(1);
    if (existing.length > 0) continue;
    const res = await ingestDocument(db, embedder, doc);
    console.log(`ingested ${doc.source} (${res.chunks} chunks)`);
    ingested++;
  }
  console.log(`done: ${ingested} new documents, embedder=${embedder.name}`);
  await pool.end();
}

void main();
