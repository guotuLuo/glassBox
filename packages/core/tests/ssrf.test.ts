import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "../src/tools/ssrf.js";

describe("SSRF 防护", () => {
  it("拒绝非 http(s) 协议", async () => {
    expect((await assertPublicUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await assertPublicUrl("ftp://host/x")).ok).toBe(false);
  });

  it("拒绝环回与私网字面 IP", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
      "http://172.16.5.5/",
      "http://[::1]/",
      "https://169.254.169.254/latest/meta-data/", // 云元数据
    ]) {
      const r = await assertPublicUrl(url);
      expect(r.ok, `${url} 应被拒`).toBe(false);
    }
  });

  it("放行公网字面 IP 与常规域名", async () => {
    expect((await assertPublicUrl("http://1.1.1.1/")).ok).toBe(true);
    const r = await assertPublicUrl("https://example.com/");
    expect(r.ok).toBe(true);
    expect(r.resolvedIps?.length).toBeGreaterThan(0);
  });

  it("拒绝畸形 URL", async () => {
    expect((await assertPublicUrl("http://")).ok).toBe(false);
    expect((await assertPublicUrl("not a url")).ok).toBe(false);
  });
});
