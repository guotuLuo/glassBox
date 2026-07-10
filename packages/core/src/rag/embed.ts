import { createHash } from "node:crypto";
import { EMBEDDING_DIM } from "@glassbox/db";
import { tokenize } from "./tokenize.js";

/**
 * 嵌入 provider 抽象(总纲 §4:分层可换)。
 *  - 本地桩(默认):token 哈希进 1024 维 + TF 加权 + L2 归一。这是"词法嵌入"——
 *    对中文按 bigram 命中,语义能力弱但离线/确定/免费,可测、可 CI;
 *  - openai-compat(真路径):SiliconFlow bge-m3 或任意 /embeddings 端点,配 key 即用。
 * 维度固定 1024(对齐 bge-m3),切换无需迁移。诚实声明:向量语义质量取决于真实 embedder。
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** 本地词法嵌入:确定性,无网络 */
export function createLocalEmbedding(dim = EMBEDDING_DIM): EmbeddingProvider {
  return {
    name: "local-bigram",
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array<number>(dim).fill(0);
        for (const token of tokenize(text)) {
          // 稳定哈希 → 桶;正负号也由哈希决定,减少碰撞抵消偏差
          const h = createHash("md5").update(token).digest();
          const bucket = h.readUInt32LE(0) % dim;
          const sign = (h[4] ?? 0) % 2 === 0 ? 1 : -1;
          vec[bucket] = (vec[bucket] ?? 0) + sign;
        }
        return l2normalize(vec);
      });
    },
  };
}

export interface OpenAIEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim?: number;
}

/** OpenAI 兼容 /embeddings(SiliconFlow bge-m3 等) */
export function createOpenAIEmbedding(cfg: OpenAIEmbeddingConfig): EmbeddingProvider {
  const dim = cfg.dim ?? EMBEDDING_DIM;
  return {
    name: `openai-compat:${cfg.model}`,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => d.embedding);
    },
  };
}

/** 从环境组装:配了 EMBEDDING_* 就用真 embedder,否则本地桩 */
export function embeddingFromEnv(): EmbeddingProvider {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  if (baseUrl && apiKey && model) {
    return createOpenAIEmbedding({
      baseUrl,
      apiKey,
      model,
      dim: process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : undefined,
    });
  }
  return createLocalEmbedding();
}
