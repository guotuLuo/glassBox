import { z } from "zod";
import { tokenize } from "../rag/tokenize.js";
import { type FetchResult, fetchPage } from "./fetch-page.js";
import type { ToolDefinition } from "./registry.js";
import type { SearchHit } from "./search.js";
import { discoverUrls, type WebDiscoverConfig } from "./web-discover.js";

/**
 * 联网研究工具:发现 URL(中转 web_search)→ 自己抓取正文 → 取与查询最相关的片段作来源。
 * 玻璃盒:引用绑定的是 GlassBox 抓到的真实网页正文,不是模型的黑盒答案。
 * 为控成本/时延:每任务共享抓取缓存 + 总抓取上限;抓取失败降级(跳过并可见)。
 */
export interface WebResearchOptions {
  maxUrlsPerQuery?: number;
  totalFetchBudget?: number;
  onFetch?: (url: string, ok: boolean, reason?: string) => void;
}

/** 从页面正文里挑与查询最相关的一段(bigram token 重叠打分,无需嵌入,快且确定) */
function relevantSnippet(text: string, query: string, windowChars = 360): string {
  const qtokens = new Set(tokenize(query));
  if (qtokens.size === 0) return text.slice(0, windowChars);
  const step = 180;
  let best = text.slice(0, windowChars);
  let bestScore = -1;
  for (let i = 0; i < text.length; i += step) {
    const win = text.slice(i, i + windowChars);
    let score = 0;
    for (const t of tokenize(win)) if (qtokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = win;
    }
    if (i + windowChars >= text.length) break;
  }
  return best.trim();
}

export function createWebResearchTool(
  cfg: WebDiscoverConfig,
  opts: WebResearchOptions = {},
): ToolDefinition<{ query: string; topK?: number }, SearchHit[]> {
  const maxUrls = opts.maxUrlsPerQuery ?? 4;
  const budget = { remaining: opts.totalFetchBudget ?? 8 };
  const cache = new Map<string, FetchResult>();

  const fetchCached = async (url: string): Promise<FetchResult> => {
    const hit = cache.get(url);
    if (hit) return hit;
    if (budget.remaining <= 0) return { ok: false, reason: "fetch budget exhausted" };
    budget.remaining--;
    const res = await fetchPage(url);
    cache.set(url, res);
    opts.onFetch?.(url, res.ok, res.reason);
    return res;
  };

  return {
    name: "web_search",
    description: "联网检索:搜索网页、抓取正文,返回相关来源片段。",
    risk: "low",
    input: z.object({
      query: z.string().min(1).max(300),
      topK: z.number().int().min(1).max(6).optional(),
    }),
    async execute({ query, topK = 4 }): Promise<SearchHit[]> {
      const urls = await discoverUrls(cfg, query, maxUrls);
      const results = await Promise.all(urls.map((u) => fetchCached(u)));
      const hits: SearchHit[] = [];
      for (const r of results) {
        if (!r.ok || !r.page) continue;
        hits.push({
          id: hits.length,
          title: r.page.title,
          url: r.page.url,
          snippet: relevantSnippet(r.page.text, query),
        });
        if (hits.length >= topK) break;
      }
      return hits;
    },
  };
}
