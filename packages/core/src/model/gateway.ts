import { type Db, modelCalls } from "@glassbox/db";
import { sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { z } from "zod";
import { errorMessage, sleep } from "../utils.js";
import type { AdapterRequest, ModelAdapter } from "./adapter.js";
import { estimateCostCny } from "./prices.js";

/**
 * 模型网关(EMAgent gateway/failover/resilience 的 TS 移植):
 *  - 分层路由:cheap(decide/抽取)/ strong(综合)/ verify(与综合不同型号,总纲 §4);
 *  - 每供应商重试(退避)→ 熔断(连续失败开闸,冷却后半开)→ failover 到下一供应商;
 *  - 每次调用(含失败)记 model_calls:token/成本/延迟/状态 —— 玻璃盒的计费与回放数据源;
 *  - 钱包护栏:当日累计成本达到硬顶直接拒绝(总纲 §8,M0 第一天要求)。
 */

export type ModelTier = "cheap" | "strong" | "verify";

export interface GatewayConfig {
  /** 每层按优先级排列的适配器;verify 缺省回落到 cheap */
  tiers: Partial<Record<ModelTier, ModelAdapter[]>>;
  /** 记账用;缺省不落库(单测场景) */
  db?: Db;
  dailyBudgetCny?: number;
  attemptsPerProvider?: number;
  backoffMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  now?: () => number;
}

export interface GenerateInput {
  tier?: ModelTier;
  purpose: string;
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  taskId?: string;
  stepId?: number;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costCny: number | null;
  latencyMs: number;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`daily budget exhausted: spent ¥${spent.toFixed(2)} of ¥${budget.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export class AllProvidersFailedError extends Error {
  constructor(tier: string, causes: string[]) {
    super(`all providers failed for tier "${tier}": ${causes.join(" | ")}`);
    this.name = "AllProvidersFailedError";
  }
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

export interface ModelGateway {
  generateText(input: GenerateInput): Promise<GenerateResult>;
  generateObject<T>(
    input: GenerateInput & { schema: ZodType<T>; schemaName?: string },
  ): Promise<GenerateResult & { object: T }>;
  todaySpendCny(): Promise<number>;
}

export function createModelGateway(config: GatewayConfig): ModelGateway {
  const attempts = config.attemptsPerProvider ?? 2;
  const backoffMs = config.backoffMs ?? 500;
  const breakerThreshold = config.breakerThreshold ?? 3;
  const breakerCooldownMs = config.breakerCooldownMs ?? 30_000;
  const budget = config.dailyBudgetCny ?? Number(process.env.DAILY_BUDGET_CNY ?? 20);
  const now = config.now ?? Date.now;
  const breakers = new Map<ModelAdapter, BreakerState>();

  function breaker(adapter: ModelAdapter): BreakerState {
    let state = breakers.get(adapter);
    if (!state) {
      state = { consecutiveFailures: 0, openUntil: 0 };
      breakers.set(adapter, state);
    }
    return state;
  }

  async function todaySpendCny(): Promise<number> {
    if (!config.db) return 0;
    const rows = await config.db
      .select({ total: sql<number>`coalesce(sum(${modelCalls.costCny}), 0)::float8` })
      .from(modelCalls)
      .where(sql`${modelCalls.createdAt} >= date_trunc('day', now())`);
    return rows[0]?.total ?? 0;
  }

  async function record(entry: {
    input: GenerateInput;
    adapter: ModelAdapter;
    status: "succeeded" | "failed";
    latencyMs: number;
    text?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costCny?: number | null;
    error?: string;
  }): Promise<void> {
    if (!config.db) return;
    await config.db
      .insert(modelCalls)
      .values({
        taskId: entry.input.taskId ?? null,
        stepId: entry.input.stepId ?? null,
        provider: entry.adapter.provider,
        model: entry.adapter.model,
        purpose: entry.input.purpose,
        request: { system: entry.input.system ?? null, prompt: entry.input.prompt },
        response: entry.text !== undefined ? { text: entry.text } : null,
        promptTokens: entry.promptTokens ?? null,
        completionTokens: entry.completionTokens ?? null,
        totalTokens: entry.totalTokens ?? null,
        costCny: entry.costCny ?? null,
        latencyMs: entry.latencyMs,
        status: entry.status,
        error: entry.error ?? null,
      })
      .catch(() => undefined); // 记账失败不打断主流程,但也绝不静默吞主错误
  }

  async function generateText(input: GenerateInput): Promise<GenerateResult> {
    const tier = input.tier ?? "cheap";
    const adapters = config.tiers[tier] ?? config.tiers.cheap ?? [];
    if (adapters.length === 0) throw new Error(`no adapters configured for tier "${tier}"`);

    const spent = await todaySpendCny();
    if (spent >= budget) throw new BudgetExceededError(spent, budget);

    const causes: string[] = [];
    for (const adapter of adapters) {
      const state = breaker(adapter);
      if (state.openUntil > now()) {
        causes.push(`${adapter.provider}/${adapter.model}: circuit open`);
        continue;
      }
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const startedAt = now();
        try {
          const req: AdapterRequest = {
            ...(input.system ? { system: input.system } : {}),
            prompt: input.prompt,
            ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          };
          const res = await adapter.generate(req);
          const latencyMs = Math.max(0, now() - startedAt);
          const costCny = estimateCostCny(adapter.model, res.promptTokens, res.completionTokens);
          state.consecutiveFailures = 0;
          await record({
            input,
            adapter,
            status: "succeeded",
            latencyMs,
            text: res.text,
            promptTokens: res.promptTokens,
            completionTokens: res.completionTokens,
            totalTokens: res.totalTokens,
            costCny,
          });
          return {
            text: res.text,
            provider: adapter.provider,
            model: adapter.model,
            promptTokens: res.promptTokens,
            completionTokens: res.completionTokens,
            totalTokens: res.totalTokens,
            costCny,
            latencyMs,
          };
        } catch (err) {
          const latencyMs = Math.max(0, now() - startedAt);
          const message = errorMessage(err);
          causes.push(`${adapter.provider}/${adapter.model}#${attempt}: ${message}`);
          state.consecutiveFailures += 1;
          if (state.consecutiveFailures >= breakerThreshold) {
            state.openUntil = now() + breakerCooldownMs;
          }
          await record({ input, adapter, status: "failed", latencyMs, error: message });
          if (attempt < attempts) await sleep(backoffMs * attempt);
        }
      }
    }
    throw new AllProvidersFailedError(tier, causes);
  }

  /**
   * 结构化输出:提示词约束 + 防御性解析(EMAgent `_as_text` 思想)+ 一次修复重试。
   * 不依赖供应商的 structured output 能力,中转/国产模型通吃。
   */
  async function generateObject<T>(
    input: GenerateInput & { schema: ZodType<T>; schemaName?: string },
  ): Promise<GenerateResult & { object: T }> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(input.schema));
    const basePrompt = `${input.prompt}

输出要求:只输出一个 JSON 对象,不要 markdown 代码块,不要任何解释文字。JSON 必须符合以下 JSON Schema:
${jsonSchema}`;

    let lastError = "";
    for (let round = 1; round <= 2; round++) {
      const prompt =
        round === 1
          ? basePrompt
          : `${basePrompt}

你上一次的输出无法通过校验:${lastError}
请修正后重新只输出 JSON 对象。`;
      const res = await generateText({ ...input, prompt });
      const parsed = input.schema.safeParse(extractJson(res.text));
      if (parsed.success) return { ...res, object: parsed.data };
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 500);
    }
    throw new Error(`structured output failed after repair retry: ${lastError}`);
  }

  return { generateText, generateObject, todaySpendCny };
}

/** 防御性 JSON 提取:剥代码块围栏、截取首个 { 到末个 } */
export function extractJson(text: string): unknown {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
