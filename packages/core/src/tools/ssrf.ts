import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * SSRF 防护(总纲 §8 高频考点):抓取工具在发请求前必须解析 DNS 并拒绝私网/环回/保留地址,
 * 防止被诱导打内网。仅允许 http/https + 公网单播地址。
 * 局限(诚实):不防 TOCTOU(解析后 DNS 再变),生产需配合出口防火墙;此处覆盖启发式主线。
 */
export interface SsrfCheck {
  ok: boolean;
  reason?: string;
  resolvedIps?: string[];
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 环回
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // 环回 / 未指定
  if (lower.startsWith("fe80")) return true; // 链路本地
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // 唯一本地 ULA
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isBlockedIp(v4); // IPv4 映射地址
  }
  return false;
}

export async function assertPublicUrl(rawUrl: string): Promise<SsrfCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `blocked protocol: ${url.protocol}` };
  }
  const host = url.hostname;
  // 字面 IP:直接判定,不经过 DNS
  if (net.isIP(host)) {
    return isBlockedIp(host)
      ? { ok: false, reason: `blocked ip literal: ${host}`, resolvedIps: [host] }
      : { ok: true, resolvedIps: [host] };
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: `dns resolution failed: ${host}` };
  }
  const ips = records.map((r) => r.address);
  if (ips.length === 0) return { ok: false, reason: `no dns records: ${host}` };
  // 任一解析结果落私网即拒绝(防 DNS rebinding 的一半)
  const blocked = ips.find(isBlockedIp);
  if (blocked) return { ok: false, reason: `resolves to blocked ip: ${blocked}`, resolvedIps: ips };
  return { ok: true, resolvedIps: ips };
}
