import type { AgentDecision, ClaimVerdict } from "@glassbox/contracts";
import {
  type AgentSynthesis,
  agentDecisionSchema,
  agentSynthesisSchema,
  claimVerdictSchema,
} from "@glassbox/contracts";
import { type Db, taskSteps } from "@glassbox/db";
import { eq, sql } from "drizzle-orm";
import type { ModelGateway } from "../model/gateway.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SearchHit } from "../tools/search.js";
import { errorMessage } from "../utils.js";

/**
 * 自适应研究 agent(EMAgent planner 移植):
 *   plan(hint) → [decide → act → observe]* → synthesize → 怀疑式 verify → 自纠一次。
 * 循环护栏:最大步数 + 同一失败动作重复即停(loop guard)。
 * 每一步落 task_steps,每次模型/工具调用由网关/注册表落 model_calls/tool_calls —— 玻璃盒。
 * 反幻觉:综合出的每条论断绑定检索片段(citation),再由 verify 层(不同型号)红黄绿裁定。
 */

export interface AgentDeps {
  db: Db;
  gateway: ModelGateway;
  tools: ToolRegistry;
  /** 每步向事件流发射(SSE 实时可见);缺省 no-op */
  emit?: (eventType: string, message: string, payload?: unknown) => Promise<void>;
}

export interface ResearchResult {
  question: string;
  synthesis: AgentSynthesis;
  verdicts: Array<{ claimIndex: number; rating: "green" | "yellow" | "red"; rationale: string }>;
  sources: SearchHit[];
  steps: number;
  finishReason: string;
}

const MAX_STEPS = 6;

export async function runResearchAgent(
  deps: AgentDeps,
  taskId: string,
  question: string,
): Promise<ResearchResult> {
  const { db, gateway, tools } = deps;
  const emit = deps.emit ?? (async () => undefined);
  let stepIndex = 0;

  const recordStep = async (
    name: string,
    body: () => Promise<{ output: unknown; status?: string }>,
  ): Promise<unknown> => {
    const idx = stepIndex++;
    const rows = await db
      .insert(taskSteps)
      .values({ taskId, stepIndex: idx, name, status: "running" })
      .returning({ id: taskSteps.id });
    const stepId = rows[0]?.id;
    try {
      const { output, status } = await body();
      await db
        .update(taskSteps)
        .set({ status: status ?? "succeeded", output: output as object, finishedAt: sql`now()` })
        .where(eq(taskSteps.id, stepId ?? -1));
      return output;
    } catch (err) {
      await db
        .update(taskSteps)
        .set({ status: "failed", error: errorMessage(err), finishedAt: sql`now()` })
        .where(eq(taskSteps.id, stepId ?? -1));
      throw err;
    }
  };

  // ---- plan ----
  await recordStep("plan", async () => {
    await emit("agent.plan", `规划:${question}`);
    return { output: { question, availableTools: tools.catalog() } };
  });

  // ---- decide → act → observe 循环 ----
  const sources: SearchHit[] = [];
  const seenActions = new Set<string>();
  let finishReason = "reached step limit";

  for (let loop = 0; loop < MAX_STEPS; loop++) {
    const observations =
      sources.map((s, i) => `[${i}] ${s.title}: ${s.snippet}`).join("\n") || "(暂无检索结果)";
    const decision = (await recordStep("decide", async () => {
      const res = await gateway.generateObject({
        tier: "cheap",
        purpose: "decide-next-action",
        taskId,
        system:
          "你是严谨的研究规划器。基于已有观察决定下一步:检索更多资料(use_tool web_search)或结束(finish)。已有足够资料就尽快 finish。",
        prompt: `研究问题:${question}\n\n可用工具:${JSON.stringify(tools.catalog())}\n\n已有观察:\n${observations}\n\n决定下一步。`,
        schema: agentDecisionSchema,
      });
      await emit("model.call", `decide via ${res.provider}/${res.model}`, {
        provider: res.provider,
        model: res.model,
        costCny: res.costCny,
      });
      await emit("agent.decide", res.object.reasoning.slice(0, 200), res.object.action);
      return { output: res.object };
    })) as AgentDecision;

    if (decision.action.kind === "finish") {
      finishReason = decision.action.reason;
      break;
    }
    const action = decision.action;

    // loop guard:同一 (tool,input) 动作重复即停
    const fingerprint = `${action.tool}:${JSON.stringify(action.input)}`;
    if (seenActions.has(fingerprint)) {
      finishReason = "loop guard: repeated action";
      break;
    }
    seenActions.add(fingerprint);

    await recordStep("act", async () => {
      const result = await tools.invoke(action.tool, action.input, { taskId });
      await emit("tool.call", `${action.tool} → ${result.ok ? "ok" : "err"}`, result);
      if (result.ok && Array.isArray(result.output)) {
        for (const hit of result.output as SearchHit[]) {
          if (!sources.some((s) => s.url === hit.url)) sources.push(hit);
        }
      }
      return { output: result, status: result.ok ? "succeeded" : "failed" };
    });
    await recordStep("observe", async () => {
      await emit("agent.observe", `已收集 ${sources.length} 条来源`);
      return { output: { sourceCount: sources.length } };
    });
  }

  // ---- synthesize:带引用综合 ----
  const numberedSources = sources
    .map((s, i) => `[${i}] ${s.title} (${s.url}): ${s.snippet}`)
    .join("\n");
  const synthesis = (await recordStep("synthesize", async () => {
    const res = await gateway.generateObject({
      tier: "strong",
      purpose: "synthesize-report",
      taskId,
      system:
        "你是严谨的研究综合器。只依据给定来源作答,每条论断必须用 citations 数组标注其来源编号,不得引用不存在的编号,不得编造来源外的事实。",
      prompt: `研究问题:${question}\n\n可用来源:\n${numberedSources || "(无来源)"}\n\n输出带引用的论断列表与摘要。`,
      schema: agentSynthesisSchema,
    });
    await emit("model.call", `synthesize via ${res.provider}/${res.model}`, {
      provider: res.provider,
      model: res.model,
      costCny: res.costCny,
    });
    await emit("agent.synthesize", `综合出 ${res.object.claims.length} 条论断`);
    return { output: res.object };
  })) as AgentSynthesis;

  // ---- verify:另一个型号做怀疑式核实,红黄绿 ----
  const verdicts = (await recordStep("verify", async () => {
    const claimsText = synthesis.claims
      .map((c, i) => `[claim ${i}] ${c.text}  (声称来源: ${c.citations.join(",")})`)
      .join("\n");
    const res = await gateway.generateObject({
      tier: "verify",
      purpose: "verify-claims",
      taskId,
      system:
        "你是独立事实核查员,倾向怀疑。对每条论断裁定:green=来源充分支持,yellow=部分支持或引用不当,red=来源不支持或疑似编造。只依据给定来源。",
      prompt: `来源:\n${numberedSources || "(无来源)"}\n\n待核查论断:\n${claimsText}\n\n对每条论断给出裁定。`,
      schema: claimVerdictSchema,
    });
    await emit("model.call", `verify via ${res.provider}/${res.model}`, {
      provider: res.provider,
      model: res.model,
      costCny: res.costCny,
    });
    const reds = res.object.verdicts.filter((v) => v.rating === "red").length;
    await emit("agent.verify", `核实完成:${reds} 条存疑(red)`, { verdicts: res.object.verdicts });
    return { output: res.object };
  })) as ClaimVerdict;

  return {
    question,
    synthesis,
    verdicts: verdicts.verdicts,
    sources,
    steps: stepIndex,
    finishReason,
  };
}
