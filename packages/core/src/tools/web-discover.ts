/**
 * URL 发现:借用 OpenAI 兼容中转的 web_search 工具"找到相关网页",只取 URL,不取它的答案。
 * 用实测能稳定触发搜索的提法(自然问题 + 要求列出来源链接),再正则抽 URL。
 * 玻璃盒边界:这里只做"URL 发现",正文抓取与引用绑定由 GlassBox 自己完成(fetchPage + agent 循环)。
 */
export interface WebDiscoverConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function webDiscoverFromEnv(): WebDiscoverConfig | null {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: process.env.MODEL_SEARCH ?? "gpt-5.4-mini" };
}

const URL_RE = /https?:\/\/[^\s"'<>()\]},，。；]+/g;

/** 从中转 /responses 的 web_search 结果里抽出候选 URL(去重、去常见垃圾域) */
export async function discoverUrls(
  cfg: WebDiscoverConfig,
  query: string,
  limit = 5,
  timeoutMs = 40_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        instructions:
          "你是联网检索助手。必须调用 web_search 搜索用户的查询,并在回答结尾用「来源:」列出你参考过的每一个网页的完整 URL(每行一个)。务必真实联网,不要凭记忆编造链接。",
        input: `${query}\n\n请联网搜索,并在结尾完整列出所有参考来源的 URL。`,
        tools: [{ type: "web_search" }],
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      output?: Array<{
        type?: string;
        content?: Array<{ text?: string; annotations?: Array<{ url?: string }> }>;
      }>;
    };
    const msg = (json.output ?? []).find((o) => o.type === "message");
    const text = (msg?.content ?? []).map((c) => c.text ?? "").join("\n");
    const annotated = (msg?.content ?? [])
      .flatMap((c) => c.annotations ?? [])
      .map((a) => a.url)
      .filter((u): u is string => typeof u === "string");
    const fromText = text.match(URL_RE) ?? [];

    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...annotated, ...fromText]) {
      let url = raw.replace(/[.,;)\]}]+$/, "");
      try {
        const u = new URL(url);
        // 过滤搜索引擎/聚合垃圾,尽量取原始资料页
        if (/^(www\.)?(google|bing|baidu|duckduckgo)\./.test(u.hostname)) continue;
        url = u.toString();
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
