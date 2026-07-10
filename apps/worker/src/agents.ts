import { helloInputSchema, researchInputSchema } from "@glassbox/contracts";
import {
  appendEvent,
  createModelGateway,
  createRagSearchTool,
  createSearchTool,
  createWebResearchTool,
  type EmbeddingProvider,
  embeddingFromEnv,
  MemoryStore,
  type ModelGateway,
  runDeepResearch,
  type SearchHit,
  saveCheckpoint,
  sleep,
  type ToolDefinition,
  ToolRegistry,
  tiersFromEnv,
  webDiscoverFromEnv,
} from "@glassbox/core";
import { type DbHandle, documentChunks, type TaskRow } from "@glassbox/db";
import { sql } from "drizzle-orm";
import { intEnv } from "./env.js";

type EmitFn = (eventType: string, message: string, payload?: unknown) => Promise<void>;

const HELLO_STEPS = 3;
const HELLO_STEP_MS = intEnv("HELLO_STEP_MS", 400);

/**
 * agent 派发:worker 只管租约生命周期,具体 agent 逻辑在此按 agentName 分派。
 * 每个 handler 收到「是否失去租约」的探针,失去即尽快让出(不写终态,守卫兜底)。
 */
export interface AgentContext {
  dbh: DbHandle;
  task: TaskRow;
  isLeaseLost: () => boolean;
  gateway: ModelGateway;
}

export type AgentHandler = (ctx: AgentContext) => Promise<unknown>;

export function buildGateway(dbh: DbHandle): ModelGateway {
  return createModelGateway({ tiers: tiersFromEnv(), db: dbh.db });
}

const embedder: EmbeddingProvider = embeddingFromEnv();

/**
 * 组装研究用的检索工具(总纲 §0「网页 + 私有文档」多源):
 *  - 配了中转 key → 联网研究工具(发现 URL + 自抓正文);
 *  - 语料库有内容 → 私有知识库检索;
 *  - 两者都在则合并去重(一个 web_search 工具对 agent 透明);都没有则回落内置桩。
 */
type SearchTool = ToolDefinition<{ query: string; topK?: number }, SearchHit[]>;

async function buildSearchTool(dbh: DbHandle, emit: EmitFn): Promise<SearchTool> {
  const [row] = await dbh.db.select({ n: sql<number>`count(*)::int` }).from(documentChunks);
  const hasCorpus = (row?.n ?? 0) > 0;
  const webCfg = webDiscoverFromEnv();

  const webTool: SearchTool | null = webCfg
    ? createWebResearchTool(webCfg, {
        onFetch: (url, ok, reason) => {
          void emit("web.fetch", `${ok ? "抓取" : "跳过"} ${url}`, { url, ok, reason });
        },
      })
    : null;
  const kbTool: SearchTool | null = hasCorpus ? createRagSearchTool(dbh.db, embedder) : null;

  if (webTool && kbTool) return mergedSearchTool(webTool, kbTool, emit);
  return webTool ?? kbTool ?? createSearchTool();
}

/** 合并两路检索:网页 + 私有文档,按 url 去重(总纲 §0 多源) */
function mergedSearchTool(web: SearchTool, kb: SearchTool, emit: EmitFn): SearchTool {
  return {
    name: "web_search",
    description: "多源检索:联网网页 + 私有知识库,返回相关来源片段。",
    risk: "low",
    input: web.input,
    async execute(input, ctx): Promise<SearchHit[]> {
      const [webHits, kbHits] = await Promise.all([
        web.execute(input, ctx).catch(() => [] as SearchHit[]),
        kb.execute(input, ctx).catch(() => [] as SearchHit[]),
      ]);
      const seen = new Set<string>();
      const merged: SearchHit[] = [];
      for (const h of [...webHits, ...kbHits]) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        merged.push({ ...h, id: merged.length });
      }
      void emit("agent.observe", `多源:网页 ${webHits.length} + 私有 ${kbHits.length}`, {
        web: webHits.length,
        kb: kbHits.length,
      });
      return merged;
    },
  };
}

const helloHandler: AgentHandler = async ({ dbh, task, isLeaseLost }) => {
  const input = helloInputSchema.parse(task.request);
  const cp = task.checkpoint as { step?: number } | null;
  const startStep = typeof cp?.step === "number" ? cp.step : 0;
  for (let step = startStep + 1; step <= HELLO_STEPS; step++) {
    if (isLeaseLost()) throw new LeaseLostError();
    await sleep(HELLO_STEP_MS);
    await appendEvent(dbh.db, {
      taskId: task.id,
      eventType: "hello.step",
      message: `step ${step}/${HELLO_STEPS}`,
      payload: { step, total: HELLO_STEPS },
    });
    await saveCheckpoint(dbh.db, task.id, task.leaseOwner ?? "", { step });
  }
  return { greeting: `Hello, ${input.message}!`, steps: HELLO_STEPS, resumedFromStep: startStep };
};

const researchHandler: AgentHandler = async ({ dbh, task, gateway }) => {
  const { question } = researchInputSchema.parse(task.request);
  const emit: EmitFn = async (eventType, message, payload) => {
    await appendEvent(dbh.db, { taskId: task.id, eventType, message, payload });
  };
  const tools = new ToolRegistry().register(await buildSearchTool(dbh, emit));

  // owner 隔离:无认证时用 createdBy,回落到 anonymous(M5 接入登录后换真实用户)
  const owner = task.createdBy ?? "anonymous";
  const recallFloor = process.env.MEMORY_RECALL_FLOOR
    ? Number(process.env.MEMORY_RECALL_FLOOR)
    : undefined;
  const memory = new MemoryStore(dbh.db, embedder, recallFloor ? { recallFloor } : {});
  const recalled = await memory.recall(owner, question, 3);

  const result = await runDeepResearch(
    { db: dbh.db, gateway, tools, emit, recalledMemories: recalled.map((m) => m.content) },
    task.id,
    question,
  );

  // 把这次研究的高置信结论写入长期记忆(仅绿标论断,去重由 MemoryStore 兜底)
  const greenClaims = result.synthesis.claims.filter(
    (_, i) => result.verdicts.find((v) => v.claimIndex === i)?.rating === "green",
  );
  let written = 0;
  for (const claim of greenClaims.slice(0, 3)) {
    if (await memory.write(owner, "declarative", claim.text)) written++;
  }
  if (written > 0) {
    await emit("memory.write", `沉淀 ${written} 条结论到长期记忆`, { written });
  }
  return result;
};

export class LeaseLostError extends Error {
  constructor() {
    super("lease lost mid-execution");
    this.name = "LeaseLostError";
  }
}

const HANDLERS: Record<string, AgentHandler> = {
  hello: helloHandler,
  research: researchHandler,
};

export function resolveAgent(name: string): AgentHandler | undefined {
  return HANDLERS[name];
}
