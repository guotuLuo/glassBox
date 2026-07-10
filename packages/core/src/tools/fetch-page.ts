import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { assertPublicUrl } from "./ssrf.js";

/**
 * 网页抓取 + 正文抽取(总纲 §8 抓取管线:自建、可控)。
 * 抓取前过 SSRF 防护(解析 DNS 拒私网);用 readability 抽主内容,去导航/广告噪声。
 * 诚实边界:抓取会失败(超时/反爬/非 HTML/大陆访问外网不稳),失败当一等公民 —— 返回 null 带原因。
 */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchResult {
  ok: boolean;
  page?: FetchedPage;
  reason?: string;
}

const UA = "Mozilla/5.0 (compatible; GlassBoxBot/0.1; +https://github.com/guotuLuo/glassBox)";
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 8_000;

export async function fetchPage(url: string, timeoutMs = 12_000): Promise<FetchResult> {
  const ssrf = await assertPublicUrl(url);
  if (!ssrf.ok) return { ok: false, reason: `ssrf: ${ssrf.reason}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return { ok: false, reason: `non-html: ${ct.slice(0, 40)}` };

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { ok: false, reason: "too large" };
    const html = new TextDecoder("utf-8").decode(buf);

    // jsdom 会执行/告警很多噪声,静默掉;不执行脚本
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    dom.window.close();

    const text = (article?.textContent ?? "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text || text.length < 80) return { ok: false, reason: "no extractable content" };

    return {
      ok: true,
      page: {
        url,
        title: (article?.title ?? url).trim().slice(0, 200),
        text: text.slice(0, MAX_TEXT_CHARS),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.includes("abort") ? "timeout" : msg.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}
