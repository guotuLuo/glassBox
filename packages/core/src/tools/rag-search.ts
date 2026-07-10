import type { Db } from "@glassbox/db";
import { z } from "zod";
import type { EmbeddingProvider } from "../rag/embed.js";
import { hybridSearch } from "../rag/retrieve.js";
import type { ToolDefinition } from "./registry.js";
import type { SearchHit } from "./search.js";

/**
 * RAG 检索工具:把混合检索包成 agent 可调的工具,让研究 agent 从已摄取的语料库取证。
 * 这是 M3 与 M2 的接缝——摄取的文档真正进入研究管线,报告的引用指向真实片段。
 */
export function createRagSearchTool(
  db: Db,
  embedder: EmbeddingProvider,
): ToolDefinition<{ query: string; topK?: number }, SearchHit[]> {
  return {
    name: "web_search",
    description: "从知识库检索相关片段(向量+全文混合检索),返回命中的标题/来源/内容。",
    risk: "safe",
    input: z.object({
      query: z.string().min(1).max(300),
      topK: z.number().int().min(1).max(8).optional(),
    }),
    async execute({ query, topK = 4 }): Promise<SearchHit[]> {
      const candidates = await hybridSearch(db, embedder, query, { topK });
      return candidates.map((c, i) => ({
        id: i,
        title: c.documentTitle,
        url: c.source,
        snippet: c.content,
      }));
    },
  };
}
