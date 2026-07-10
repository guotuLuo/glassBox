import { createOpenAICompatAdapter, type ModelAdapter } from "./adapter.js";
import type { ModelTier } from "./gateway.js";

/**
 * 从环境变量组装分层适配器(worker/api 的组合根用;测试注入 stub 不走这里)。
 * 当前现实:仅 GPT 中转在线(用户决策 2026-07-09:本地检验 + GPT)。
 * 供应商多样性(验证器 ≠ 综合的供应商)在国产 key 到位前先用不同型号近似,诚实标注。
 */
export function tiersFromEnv(): Partial<Record<ModelTier, ModelAdapter[]>> {
  const tiers: Partial<Record<ModelTier, ModelAdapter[]>> = {};

  const compatBase = process.env.OPENAI_COMPAT_BASE_URL;
  const compatKey = process.env.OPENAI_COMPAT_API_KEY;
  if (compatBase && compatKey) {
    const mk = (model: string) =>
      createOpenAICompatAdapter({
        provider: "openai-compat",
        baseUrl: compatBase,
        apiKey: compatKey,
        model,
      });
    tiers.cheap = [mk(process.env.MODEL_CHEAP ?? "gpt-5.4-mini")];
    tiers.strong = [mk(process.env.MODEL_STRONG ?? "gpt-5.5"), mk("gpt-5.4-mini")];
    tiers.verify = [mk(process.env.MODEL_VERIFY ?? "gpt-5.4")];
  }

  // DeepSeek 官方(国产主力,key 到位即自动生效,并排到各层最前)
  const dsKey = process.env.DEEPSEEK_API_KEY;
  if (dsKey) {
    const ds = createOpenAICompatAdapter({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: dsKey,
      model: "deepseek-chat",
    });
    tiers.cheap = [ds, ...(tiers.cheap ?? [])];
    tiers.strong = [ds, ...(tiers.strong ?? [])];
  }

  return tiers;
}
