import { type Db, documentChunks, documents } from "@glassbox/db";
import { sql } from "drizzle-orm";
import type { EmbeddingProvider } from "./embed.js";
import { bigramQuery } from "./tokenize.js";

/**
 * 混合检索(总纲 M3 本体):向量近邻 + FTS 词法,各自 top-N,用 RRF 融合。
 * 返回每个候选的分路诊断(向量排名/分、FTS 排名/分、融合分)—— 召回 playground 的数据源。
 * RRF(Reciprocal Rank Fusion):score = Σ 1/(k + rank),对分数尺度不敏感,工业界常用。
 */
export interface RetrievalCandidate {
  chunkId: number;
  documentId: string;
  documentTitle: string;
  source: string;
  content: string;
  vectorRank: number | null;
  vectorScore: number | null; // cosine 相似度(1 - 距离)
  ftsRank: number | null;
  ftsScore: number | null; // ts_rank
  fusedScore: number;
  finalRank: number;
}

export interface HybridOptions {
  perChannel?: number; // 每路取多少候选
  topK?: number; // 融合后返回多少
  rrfK?: number; // RRF 常数
  ownerId?: string;
}

interface Ranked {
  chunkId: number;
  documentId: string;
  documentTitle: string;
  source: string;
  content: string;
  score: number;
}

export async function vectorSearch(
  db: Db,
  embedder: EmbeddingProvider,
  query: string,
  limit: number,
  ownerId?: string,
): Promise<Ranked[]> {
  const [vec] = await embedder.embed([query]);
  if (!vec) return [];
  const literal = `[${vec.join(",")}]`;
  const rows = await db
    .select({
      chunkId: documentChunks.id,
      documentId: documentChunks.documentId,
      documentTitle: documents.title,
      source: documents.source,
      content: documentChunks.content,
      score: sql<number>`1 - (${documentChunks.embedding} <=> ${literal}::vector)`,
    })
    .from(documentChunks)
    .innerJoin(documents, sql`${documents.id} = ${documentChunks.documentId}`)
    .where(ownerId ? sql`${documents.ownerId} = ${ownerId}` : sql`true`)
    .orderBy(sql`${documentChunks.embedding} <=> ${literal}::vector`)
    .limit(limit);
  return rows;
}

export async function ftsSearch(
  db: Db,
  query: string,
  limit: number,
  ownerId?: string,
): Promise<Ranked[]> {
  const tsquery = bigramQuery(query);
  if (!tsquery) return [];
  const rows = await db
    .select({
      chunkId: documentChunks.id,
      documentId: documentChunks.documentId,
      documentTitle: documents.title,
      source: documents.source,
      content: documentChunks.content,
      score: sql<number>`ts_rank(to_tsvector('simple', ${documentChunks.bigramDoc}), to_tsquery('simple', ${tsquery}))`,
    })
    .from(documentChunks)
    .innerJoin(documents, sql`${documents.id} = ${documentChunks.documentId}`)
    .where(
      ownerId
        ? sql`${documents.ownerId} = ${ownerId} and to_tsvector('simple', ${documentChunks.bigramDoc}) @@ to_tsquery('simple', ${tsquery})`
        : sql`to_tsvector('simple', ${documentChunks.bigramDoc}) @@ to_tsquery('simple', ${tsquery})`,
    )
    .orderBy(
      sql`ts_rank(to_tsvector('simple', ${documentChunks.bigramDoc}), to_tsquery('simple', ${tsquery})) desc`,
    )
    .limit(limit);
  return rows;
}

export async function hybridSearch(
  db: Db,
  embedder: EmbeddingProvider,
  query: string,
  opts: HybridOptions = {},
): Promise<RetrievalCandidate[]> {
  const perChannel = opts.perChannel ?? 20;
  const topK = opts.topK ?? 10;
  const rrfK = opts.rrfK ?? 60;

  const [vecHits, ftsHits] = await Promise.all([
    vectorSearch(db, embedder, query, perChannel, opts.ownerId),
    ftsSearch(db, query, perChannel, opts.ownerId),
  ]);

  const vecRank = new Map<number, number>();
  const vecScore = new Map<number, number>();
  vecHits.forEach((h, i) => {
    vecRank.set(h.chunkId, i + 1);
    vecScore.set(h.chunkId, h.score);
  });
  const ftsRank = new Map<number, number>();
  const ftsScore = new Map<number, number>();
  ftsHits.forEach((h, i) => {
    ftsRank.set(h.chunkId, i + 1);
    ftsScore.set(h.chunkId, h.score);
  });

  const byId = new Map<number, Ranked>();
  for (const h of [...vecHits, ...ftsHits]) if (!byId.has(h.chunkId)) byId.set(h.chunkId, h);

  const fused = [...byId.values()].map((h) => {
    const vr = vecRank.get(h.chunkId);
    const fr = ftsRank.get(h.chunkId);
    const fusedScore = (vr ? 1 / (rrfK + vr) : 0) + (fr ? 1 / (rrfK + fr) : 0);
    return {
      chunkId: h.chunkId,
      documentId: h.documentId,
      documentTitle: h.documentTitle,
      source: h.source,
      content: h.content,
      vectorRank: vr ?? null,
      vectorScore: vecScore.get(h.chunkId) ?? null,
      ftsRank: fr ?? null,
      ftsScore: ftsScore.get(h.chunkId) ?? null,
      fusedScore,
      finalRank: 0,
    };
  });

  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  fused.forEach((c, i) => {
    c.finalRank = i + 1;
  });
  return fused.slice(0, topK);
}
