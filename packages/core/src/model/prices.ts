/**
 * 价目表:CNY / 1M tokens。
 * 诚实声明:中转商计费不透明,以下为粗估,用于预算硬顶与成本可视;
 * 可用环境变量 MODEL_PRICES_JSON 整体覆盖(格式同 DEFAULT_PRICES)。
 */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "gpt-5.5": { inputPerM: 12, outputPerM: 60 },
  "gpt-5.4": { inputPerM: 9, outputPerM: 40 },
  "gpt-5.4-mini": { inputPerM: 2, outputPerM: 8 },
  // 国产主力到位后的占位
  "deepseek-chat": { inputPerM: 2, outputPerM: 8 },
  "glm-5.2": { inputPerM: 4, outputPerM: 16 },
};

export function resolvePrices(): Record<string, ModelPrice> {
  const raw = process.env.MODEL_PRICES_JSON;
  if (!raw) return DEFAULT_PRICES;
  try {
    return { ...DEFAULT_PRICES, ...(JSON.parse(raw) as Record<string, ModelPrice>) };
  } catch {
    return DEFAULT_PRICES;
  }
}

export function estimateCostCny(
  model: string,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): number | null {
  const price = resolvePrices()[model];
  if (!price || promptTokens === undefined || completionTokens === undefined) return null;
  return (promptTokens * price.inputPerM + completionTokens * price.outputPerM) / 1_000_000;
}
