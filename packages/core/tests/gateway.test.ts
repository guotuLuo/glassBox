import { describe, expect, it } from "vitest";
import type { AdapterResponse, ModelAdapter } from "../src/model/adapter.js";
import {
  AllProvidersFailedError,
  BudgetExceededError,
  createModelGateway,
  extractJson,
} from "../src/model/gateway.js";

// 无 DB、无网络的纯逻辑测试:重试/熔断/failover/预算,确定性、免费、CI 友好

function stubAdapter(
  provider: string,
  model: string,
  behavior: () => Promise<AdapterResponse>,
): ModelAdapter {
  return { provider, model, generate: behavior };
}

function okOnce(text: string): AdapterResponse {
  return { text, promptTokens: 10, completionTokens: 5, totalTokens: 15 };
}

describe("模型网关:重试与 failover", () => {
  it("首个供应商失败,重试后仍失败则 failover 到下一个", async () => {
    let aCalls = 0;
    let bCalls = 0;
    const a = stubAdapter("A", "m", async () => {
      aCalls++;
      throw new Error("A down");
    });
    const b = stubAdapter("B", "m", async () => {
      bCalls++;
      return okOnce("from-B");
    });
    const gw = createModelGateway({
      tiers: { cheap: [a, b] },
      attemptsPerProvider: 2,
      backoffMs: 1,
    });
    const res = await gw.generateText({ purpose: "t", prompt: "hi" });
    expect(res.text).toBe("from-B");
    expect(res.provider).toBe("B");
    expect(aCalls).toBe(2); // 重试满 2 次
    expect(bCalls).toBe(1);
  });

  it("全部供应商失败抛 AllProvidersFailedError,含各自原因", async () => {
    const a = stubAdapter("A", "m", async () => {
      throw new Error("boom-a");
    });
    const gw = createModelGateway({ tiers: { cheap: [a] }, attemptsPerProvider: 1, backoffMs: 1 });
    await expect(gw.generateText({ purpose: "t", prompt: "x" })).rejects.toThrow(
      AllProvidersFailedError,
    );
  });
});

describe("模型网关:熔断", () => {
  it("连续失败达阈值后开闸,冷却期内直接跳过该供应商", async () => {
    let calls = 0;
    const flaky = stubAdapter("F", "m", async () => {
      calls++;
      throw new Error("nope");
    });
    const backup = stubAdapter("G", "m", async () => okOnce("ok"));
    const clock = 1_000;
    const gw = createModelGateway({
      tiers: { cheap: [flaky, backup] },
      attemptsPerProvider: 1,
      backoffMs: 1,
      breakerThreshold: 2,
      breakerCooldownMs: 10_000,
      now: () => clock,
    });
    // 两轮失败把 flaky 的熔断打开(每轮 1 次尝试)
    await gw.generateText({ purpose: "t", prompt: "1" });
    await gw.generateText({ purpose: "t", prompt: "2" });
    const callsAfterOpen = calls;
    // 第三轮:flaky 熔断开着,直接落到 backup,不再触碰 flaky
    const res = await gw.generateText({ purpose: "t", prompt: "3" });
    expect(res.provider).toBe("G");
    expect(calls).toBe(callsAfterOpen); // flaky 未被再调用
  });
});

describe("模型网关:预算硬顶", () => {
  it("todaySpend 达到硬顶即拒绝(无 DB 时 spend=0,不触发)", async () => {
    const a = stubAdapter("A", "m", async () => okOnce("ok"));
    const gw = createModelGateway({ tiers: { cheap: [a] }, dailyBudgetCny: 0 });
    // budget=0 且 spend=0 → 0>=0 触发
    await expect(gw.generateText({ purpose: "t", prompt: "x" })).rejects.toThrow(
      BudgetExceededError,
    );
  });
});

describe("防御性 JSON 提取", () => {
  it("剥 markdown 围栏与前后噪声", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('这是结果:{"b":2}谢谢')).toEqual({ b: 2 });
    expect(extractJson("not json at all")).toBeNull();
  });
});

describe("结构化输出:提示词约束 + 修复重试", () => {
  it("首轮不合规,修复重试后通过", async () => {
    const { z } = await import("zod");
    let round = 0;
    const adapter = stubAdapter("A", "m", async () => {
      round++;
      return okOnce(round === 1 ? '{"n":"not-a-number"}' : '{"n":42}');
    });
    const gw = createModelGateway({ tiers: { cheap: [adapter] }, backoffMs: 1 });
    const res = await gw.generateObject({
      purpose: "t",
      prompt: "give n",
      schema: z.object({ n: z.number() }),
    });
    expect(res.object).toEqual({ n: 42 });
    expect(round).toBe(2);
  });
});
