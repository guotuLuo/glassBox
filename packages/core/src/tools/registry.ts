import type { ZodType } from "zod";

/**
 * 工具注册表(EMAgent tools + 风险策略移植)。
 * 每个工具声明 Zod 入参契约 + 风险等级;高风险工具的执行由 planner 挂审批 park(M2 后段)。
 */
export type ToolRiskLevel = "safe" | "low" | "moderate" | "high";

export interface ToolContext {
  taskId?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  risk: ToolRiskLevel;
  input: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolInvocationResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<I, O>(tool: ToolDefinition<I, O>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" already registered`);
    this.tools.set(tool.name, tool as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** 给 planner 的工具清单(名称 + 描述 + 风险),不含实现 */
  catalog(): Array<{ name: string; description: string; risk: ToolRiskLevel }> {
    return this.list().map((t) => ({ name: t.name, description: t.description, risk: t.risk }));
  }

  /** 统一执行入口:入参校验 → 执行 → 防御性包装(失败不抛,返回结构化错误) */
  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolInvocationResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool "${name}"` };
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message ?? "schema"}` };
    }
    try {
      const output = await tool.execute(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
