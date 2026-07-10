import {
  type AgentSynthesis,
  agentSynthesisSchema,
  type ClaimVerdict,
  claimVerdictSchema,
  type SubQuestionPlan,
  subQuestionPlanSchema,
} from "@glassbox/contracts";
import { type Db, taskSteps } from "@glassbox/db";
import { eq, sql } from "drizzle-orm";
import type { ModelGateway } from "../model/gateway.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SearchHit } from "../tools/search.js";
import { errorMessage } from "../utils.js";

/**
 * 深度研究 agent(M4 旗舰):
 *   plan(拆子问题 + 注入召回记忆) → fan-out 并行多源检索 → 跨子问题综合(带引用)
 *   → 独立模型怀疑式核实(红黄绿)。
 * 相比 M2 的单问题 runResearchAgent,这里做课题分解与并行取证,来源覆盖更广;
 * 每个子问题在事件流里独立可见(玻璃盒展示 fan-out 树)。
 * 语义边界:当前为进程内并行(Promise.all,子问题≤4);耐久子任务(parent/child park/resume)
 * 是更深的版本,待 park/resume 机制补齐。
 */
export interface DeepResearchDeps {
  db: Db;
  gateway: ModelGateway;
  tools: ToolRegistry;
  emit?: (eventType: string, message: string, payload?: unknown) => Promise<void>;
  /** plan 步注入的召回记忆(owner 隔离,worker 提供);为空则跳过 */
  recalledMemories?: string[];
}

export interface DeepResearchResult {
  question: string;
  subQuestions: string[];
  synthesis: AgentSynthesis;
  verdicts: ClaimVerdict["verdicts"];
  sources: SearchHit[];
  steps: number;
}

const PER_SUBQUERY_TOPK = 3;

export async function runDeepResearch(
  deps: DeepResearchDeps,
  taskId: string,
  question: string,
): Promise<DeepResearchResult> {
  const { db, gateway, tools } = deps;
  const emit = deps.emit ?? (async () => undefined);
  const memories = deps.recalledMemories ?? [];
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
    const stepId = rows[0]?.id ?? -1;
    try {
      const { output, status } = await body();
      await db
        .update(taskSteps)
        .set({ status: status ?? "succeeded", output: output as object, finishedAt: sql`now()` })
        .where(eq(taskSteps.id, stepId));
      return output;
    } catch (err) {
      await db
        .update(taskSteps)
        .set({ status: "failed", error: errorMessage(err), finishedAt: sql`now()` })
        .where(eq(taskSteps.id, stepId));
      throw err;
    }
  };

  // ---- plan:拆子问题(注入召回记忆)----
  const memoryBlock =
    memories.length > 0
      ? `\n\n可能相关的既往记忆(供参考,不必强用):\n${memories.map((m) => `- ${m}`).join("\n")}`
      : "";
  if (memories.length > 0) {
    await emit("memory.recall", `召回 ${memories.length} 条相关记忆`, { memories });
  }

  const plan = (await recordStep("plan", async () => {
    const res = await gateway.generateObject({
      tier: "cheap",
      purpose: "decompose-question",
      taskId,
      system:
        "你是研究规划器。把课题拆解成 2–4 个彼此独立、覆盖不同侧面的子问题,便于并行检索。子问题应具体、可检索。",
      prompt: `课题:${question}${memoryBlock}\n\n给出拆解理由与子问题列表。`,
      schema: subQuestionPlanSchema,
    });
    await emit("model.call", `plan via ${res.provider}/${res.model}`, {
      provider: res.provider,
      model: res.model,
      costCny: res.costCny,
    });
    await emit("agent.plan", res.object.rationale.slice(0, 200), res.object);
    return { output: res.object };
  })) as SubQuestionPlan;

  await emit("agent.fanout", `fan-out ${plan.subQuestions.length} 个子问题`, {
    subQuestions: plan.subQuestions,
  });

  // ---- fan-out:并行多源检索 ----
  const sourcePool: SearchHit[] = [];
  const addSource = (hit: Omit<SearchHit, "id">): number => {
    const existing = sourcePool.find((s) => s.url === hit.url && s.snippet === hit.snippet);
    if (existing) return existing.id;
    const id = sourcePool.length;
    sourcePool.push({ ...hit, id });
    return id;
  };

  await recordStep("fanout", async () => {
    await Promise.all(
      plan.subQuestions.map(async (subQ, i) => {
        const result = await tools.invoke(
          "web_search",
          { query: subQ, topK: PER_SUBQUERY_TOPK },
          { taskId },
        );
        const hits =
          result.ok && Array.isArray(result.output) ? (result.output as SearchHit[]) : [];
        for (const h of hits) addSource({ title: h.title, url: h.url, snippet: h.snippet });
        await emit("agent.subquery", `子问题 ${i + 1}:命中 ${hits.length} 源`, {
          subQuestion: subQ,
          hits: hits.length,
        });
      }),
    );
    return { output: { subQuestions: plan.subQuestions.length, sources: sourcePool.length } };
  });

  const numberedSources = sourcePool
    .map((s) => `[${s.id}] ${s.title} (${s.url}): ${s.snippet}`)
    .join("\n");

  // ---- synthesize:跨子问题综合(带引用)----
  const synthesis = (await recordStep("synthesize", async () => {
    const res = await gateway.generateObject({
      tier: "strong",
      purpose: "synthesize-report",
      taskId,
      system:
        "你是严谨的研究综合器。综合所有来源回答原课题,每条论断必须用 citations 标注来源编号,不得引用不存在的编号,不得编造来源外的事实。",
      prompt: `原课题:${question}\n\n已拆解的子问题:\n${plan.subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n可用来源:\n${numberedSources || "(无来源)"}\n\n输出覆盖各子问题的带引用论断与总摘要。`,
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

  // ---- verify:独立模型红黄绿 ----
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
    subQuestions: plan.subQuestions,
    synthesis,
    verdicts: verdicts.verdicts,
    sources: sourcePool,
    steps: stepIndex,
  };
}
