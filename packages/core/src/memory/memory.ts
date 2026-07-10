import { type Db, type MemoryRow, memories } from "@glassbox/db";
import { asc, eq, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "../rag/embed.js";

/**
 * 长期记忆(EMAgent memory 移植,总纲 §3.8/§6):
 *  - owner 隔离:所有读写都带 ownerId;
 *  - 写入去重:与已有记忆余弦相似度超阈值则不重复写(避免记忆膨胀);
 *  - 召回相关性下限:低于下限的候选不返回(宁缺毋滥,防噪声污染 plan);
 *  - 按 owner 容量上限:超限淘汰(最久未用优先)。
 * 复用 M3 嵌入(1024 维)。声明式(declarative:事实/结论)+ 程序性(procedural:做法)双记忆。
 */
export type MemoryKind = "declarative" | "procedural";

export interface MemoryConfig {
  dedupThreshold?: number; // 写入去重相似度阈值
  recallFloor?: number; // 召回相关性下限
  perOwnerCap?: number; // 每 owner 记忆条数上限
}

/**
 * recallFloor 默认 0.15:适配本地 bigram 词法嵌入 —— 同域改写的相似度约 0.2,纯噪声约 0。
 * 诚实声明:换语义嵌入(bge-m3)后改写相似度升到 ~0.6,应把 floor 提到 ~0.35–0.5;
 * 故 floor 与 embedder 绑定,经 MEMORY_RECALL_FLOOR 可覆盖。
 */
const DEFAULTS = { dedupThreshold: 0.92, recallFloor: 0.15, perOwnerCap: 200 };

export interface RecalledMemory {
  id: number;
  content: string;
  kind: string;
  similarity: number;
}

export class MemoryStore {
  private readonly cfg: Required<MemoryConfig>;

  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    cfg: MemoryConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /** 召回:owner 内向量近邻,过相关性下限;命中的记忆计数 +1 */
  async recall(ownerId: string, query: string, limit = 5): Promise<RecalledMemory[]> {
    const [vec] = await this.embedder.embed([query]);
    if (!vec) return [];
    const literal = `[${vec.join(",")}]`;
    const rows = await this.db
      .select({
        id: memories.id,
        content: memories.content,
        kind: memories.kind,
        similarity: sql<number>`1 - (${memories.embedding} <=> ${literal}::vector)`,
      })
      .from(memories)
      .where(eq(memories.ownerId, ownerId))
      .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
      .limit(limit);
    const hits = rows.filter((r) => r.similarity >= this.cfg.recallFloor);
    if (hits.length > 0) {
      await this.db
        .update(memories)
        .set({ uses: sql`${memories.uses} + 1`, lastUsedAt: sql`now()` })
        .where(sql`${memories.id} in ${hits.map((h) => h.id)}`);
    }
    return hits;
  }

  /** 写入:去重(相似度超阈值跳过)+ 容量上限淘汰。返回是否实际写入 */
  async write(ownerId: string, kind: MemoryKind, content: string): Promise<boolean> {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const [vec] = await this.embedder.embed([trimmed]);
    if (!vec) return false;
    const literal = `[${vec.join(",")}]`;

    // 去重:owner 内最相似的一条
    const nearest = await this.db
      .select({ sim: sql<number>`1 - (${memories.embedding} <=> ${literal}::vector)` })
      .from(memories)
      .where(eq(memories.ownerId, ownerId))
      .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
      .limit(1);
    if ((nearest[0]?.sim ?? 0) >= this.cfg.dedupThreshold) return false;

    await this.db.insert(memories).values({ ownerId, kind, content: trimmed, embedding: vec });
    await this.enforceCap(ownerId);
    return true;
  }

  /** 容量上限:超出则删最久未用(lastUsedAt 空视为最久),保留最近活跃的 */
  private async enforceCap(ownerId: string): Promise<void> {
    const [countRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(eq(memories.ownerId, ownerId));
    const total = countRow?.n ?? 0;
    if (total <= this.cfg.perOwnerCap) return;
    const excess = total - this.cfg.perOwnerCap;
    const victims = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.ownerId, ownerId))
      .orderBy(sql`${memories.lastUsedAt} asc nulls first`, asc(memories.createdAt))
      .limit(excess);
    if (victims.length > 0) {
      await this.db.delete(memories).where(sql`${memories.id} in ${victims.map((v) => v.id)}`);
    }
  }

  async count(ownerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(eq(memories.ownerId, ownerId));
    return row?.n ?? 0;
  }
}

export type { MemoryRow };
