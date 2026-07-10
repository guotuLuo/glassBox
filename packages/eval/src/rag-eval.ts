import { type EmbeddingProvider, ftsSearch, hybridSearch, vectorSearch } from "@glassbox/core";
import { type Db, ragEvalRuns } from "@glassbox/db";

/**
 * RAG 召回评测:对标注集算 hit-rate@k 与 MRR,入库形成可追踪基线(总纲 M3 验收)。
 * 三种检索器对比(vector / fts / hybrid),用同一标注集,回答"混合到底有没有更好"。
 */
export interface RagEvalCase {
  query: string;
  /** 期望命中的来源(source),命中其一即算 hit */
  expectedSources: string[];
}

export type Retriever = "vector" | "fts" | "hybrid";

export interface RagEvalResult {
  retriever: Retriever;
  cases: number;
  hitRateAt3: number;
  hitRateAt5: number;
  mrr: number;
  detail: Array<{ query: string; hitRank: number | null }>;
}

async function retrieve(
  db: Db,
  embedder: EmbeddingProvider,
  retriever: Retriever,
  query: string,
  k: number,
): Promise<string[]> {
  if (retriever === "vector") {
    return (await vectorSearch(db, embedder, query, k)).map((h) => h.source);
  }
  if (retriever === "fts") {
    return (await ftsSearch(db, query, k)).map((h) => h.source);
  }
  return (await hybridSearch(db, embedder, query, { topK: k })).map((c) => c.source);
}

export async function evalRag(
  db: Db,
  embedder: EmbeddingProvider,
  retriever: Retriever,
  cases: RagEvalCase[],
): Promise<RagEvalResult> {
  const detail: RagEvalResult["detail"] = [];
  let hitAt3 = 0;
  let hitAt5 = 0;
  let reciprocalSum = 0;

  for (const testCase of cases) {
    const sources = await retrieve(db, embedder, retriever, testCase.query, 5);
    const expected = new Set(testCase.expectedSources);
    const hitRank = sources.findIndex((s) => expected.has(s));
    const rank = hitRank >= 0 ? hitRank + 1 : null;
    if (rank !== null && rank <= 3) hitAt3++;
    if (rank !== null && rank <= 5) hitAt5++;
    if (rank !== null) reciprocalSum += 1 / rank;
    detail.push({ query: testCase.query, hitRank: rank });
  }

  const n = cases.length || 1;
  return {
    retriever,
    cases: cases.length,
    hitRateAt3: hitAt3 / n,
    hitRateAt5: hitAt5 / n,
    mrr: reciprocalSum / n,
    detail,
  };
}

/** 跑分入库:形成可追踪的召回基线曲线 */
export async function recordRagEval(db: Db, label: string, result: RagEvalResult): Promise<number> {
  const rows = await db
    .insert(ragEvalRuns)
    .values({
      label,
      retriever: result.retriever,
      hitRateAt3: result.hitRateAt3,
      hitRateAt5: result.hitRateAt5,
      mrr: result.mrr,
      cases: result.cases,
      detail: result.detail,
    })
    .returning({ id: ragEvalRuns.id });
  return rows[0]?.id ?? -1;
}
