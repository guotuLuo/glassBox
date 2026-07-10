import { describe, expect, it } from "vitest";
import { fetchPage } from "../src/tools/fetch-page.js";

// 离线可测:SSRF 与协议在发网络请求前就被拒(无需真实网络)
describe("网页抓取:抓取前防护", () => {
  it("拒绝私网/环回字面 IP,不发请求", async () => {
    const r = await fetchPage("http://127.0.0.1/secret");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ssrf/);
  });

  it("拒绝云元数据地址", async () => {
    const r = await fetchPage("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ssrf/);
  });

  it("拒绝非 http(s) 协议", async () => {
    const r = await fetchPage("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ssrf/);
  });
});
