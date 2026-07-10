import { z } from "zod";
import type { ToolDefinition } from "./registry.js";

/**
 * 检索工具的抽象与 M2 桩实现。
 * 现实(总纲 §12 记录):公司网关 unifiedsearch 不可用;博查 key 未配。
 * 因此提供确定性的内存语料检索,让 agent 循环可端到端跑通与可测;
 * M3 再接真实 provider(博查/自建抓取)。桩的存在与边界诚实标注。
 */
export interface SearchHit {
  id: number;
  title: string;
  url: string;
  snippet: string;
}

const CORPUS: Array<{ title: string; url: string; text: string; keywords: string[] }> = [
  {
    title: "SKIP LOCKED 与 PostgreSQL 队列",
    url: "https://example.org/skip-locked",
    text: "FOR UPDATE SKIP LOCKED 让并发消费者跳过已被锁定的行,从而把一张表安全地当作工作队列,避免消费者互相阻塞。",
    keywords: ["skip locked", "队列", "queue", "postgres", "并发"],
  },
  {
    title: "租约与过期重投递",
    url: "https://example.org/lease",
    text: "基于租约的任务分发通过 lease_expires_at 判定 worker 是否失联;过期后由 reaper 重投递,配合投递上限进入死信,实现 at-least-once 执行。",
    keywords: ["租约", "lease", "重投递", "死信", "durable", "耐久"],
  },
  {
    title: "引用级反幻觉",
    url: "https://example.org/citations",
    text: "把每条论断绑定到具体检索片段,再由另一个模型做 NLI 式核实并红黄绿标注,是比末尾贴链接更可审计的反幻觉方案。",
    keywords: ["引用", "citation", "反幻觉", "核实", "verify", "幻觉"],
  },
];

export function createSearchTool(): ToolDefinition<{ query: string; topK?: number }, SearchHit[]> {
  return {
    name: "web_search",
    description: "按关键词检索资料库,返回命中的标题/链接/摘要(M2 为确定性内存语料桩)。",
    risk: "safe",
    input: z.object({
      query: z.string().min(1).max(300),
      topK: z.number().int().min(1).max(5).optional(),
    }),
    async execute({ query, topK = 3 }): Promise<SearchHit[]> {
      const q = query.toLowerCase();
      const scored = CORPUS.map((doc, id) => {
        const score = doc.keywords.reduce((s, k) => (q.includes(k.toLowerCase()) ? s + 2 : s), 0);
        const textHit = doc.text.toLowerCase().includes(q) ? 1 : 0;
        return { id, doc, score: score + textHit };
      })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      const chosen = scored.length > 0 ? scored : CORPUS.map((doc, id) => ({ id, doc, score: 0 }));
      return chosen.slice(0, topK).map(({ id, doc }) => ({
        id,
        title: doc.title,
        url: doc.url,
        snippet: doc.text,
      }));
    },
  };
}
