import { helloInputSchema, researchInputSchema } from "@glassbox/contracts";
import {
  appendEvent,
  createModelGateway,
  createRagSearchTool,
  createSearchTool,
  type EmbeddingProvider,
  embeddingFromEnv,
  MemoryStore,
  type ModelGateway,
  runDeepResearch,
  saveCheckpoint,
  sleep,
  ToolRegistry,
  tiersFromEnv,
} from "@glassbox/core";
import { type DbHandle, documentChunks, type TaskRow } from "@glassbox/db";
import { sql } from "drizzle-orm";
import { intEnv } from "./env.js";

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

/** 语料库有内容就用 RAG 检索,否则回落到内置桩语料(保证 agent 永远有据可查) */
async function buildSearchTool(dbh: DbHandle) {
  const [row] = await dbh.db.select({ n: sql<number>`count(*)::int` }).from(documentChunks);
  return (row?.n ?? 0) > 0 ? createRagSearchTool(dbh.db, embedder) : createSearchTool();
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
  const tools = new ToolRegistry().register(await buildSearchTool(dbh));
  const emit = async (eventType: string, message: string, payload?: unknown) => {
    await appendEvent(dbh.db, { taskId: task.id, eventType, message, payload });
  };

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
