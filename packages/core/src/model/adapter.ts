import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

/**
 * 供应商适配器:网关的可测缝。AI SDK 只做模型 I/O(总纲 §4),
 * 重试/熔断/failover/成本核算全部在网关层自建。
 */
export interface AdapterRequest {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface AdapterResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelAdapter {
  /** 供应商名(openai-compat / deepseek / zhipu ...) */
  readonly provider: string;
  readonly model: string;
  generate(req: AdapterRequest): Promise<AdapterResponse>;
}

export interface OpenAICompatConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 端点风格。默认 chat completions(最广兼容:DeepSeek/智谱/多数中转都实现)。
   * "responses" 仅当供应商真正实现 OpenAI Responses API 时才用 —— 实测 packyapi 中转
   * 的 /responses 是逆向 Codex 的伪实现,结构非标准,故此处不默认 responses。
   */
  api?: "chat" | "responses";
}

/** OpenAI 兼容端点适配器(中转/DeepSeek/任何 openai 形状的 API 都走这) */
export function createOpenAICompatAdapter(cfg: OpenAICompatConfig): ModelAdapter {
  const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, name: cfg.provider });
  const model = cfg.api === "responses" ? openai.responses(cfg.model) : openai.chat(cfg.model);
  return {
    provider: cfg.provider,
    model: cfg.model,
    async generate(req: AdapterRequest): Promise<AdapterResponse> {
      const res = await generateText({
        model,
        ...(req.system ? { system: req.system } : {}),
        prompt: req.prompt,
        maxOutputTokens: req.maxOutputTokens ?? 2048,
      });
      return {
        text: res.text,
        promptTokens: res.usage?.inputTokens,
        completionTokens: res.usage?.outputTokens,
        totalTokens: res.usage?.totalTokens,
      };
    },
  };
}
