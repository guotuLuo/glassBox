import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle, taskSteps, tasks } from "@glassbox/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDeepResearch } from "../src/agent/deep-research.js";
import type { GenerateInput, ModelGateway } from "../src/model/gateway.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createSearchTool } from "../src/tools/search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../db/migrations");

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  handle = createDb(container.getConnectionUri());
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
}, 180_000);

afterAll(async () => {
  await handle?.pool.end();
  await container?.stop();
});

/** 脚本化网关:按 purpose 返回确定结构化输出,免真实模型、可复现(EMAgent 脚本 bench 思想) */
function scriptedGateway(): ModelGateway {
  const objectFor = (input: GenerateInput): unknown => {
    if (input.purpose === "decompose-question") {
      return { rationale: "拆成两个侧面", subQuestions: ["SKIP LOCKED 是什么", "租约怎么重投递"] };
    }
    if (input.purpose === "synthesize-report") {
      return {
        claims: [
          { text: "SKIP LOCKED 让消费者跳过锁定行", citations: [0] },
          { text: "租约过期由 reaper 重投递", citations: [1] },
        ],
        summary: "两者共同支撑可靠队列",
      };
    }
    return {
      verdicts: [
        { claimIndex: 0, rating: "green", rationale: "来源支持" },
        { claimIndex: 1, rating: "green", rationale: "来源支持" },
      ],
    };
  };
  return {
    async generateText() {
      throw new Error("not used");
    },
    async generateObject<T>(input: GenerateInput & { schema: { parse(v: unknown): T } }) {
      const object = input.schema.parse(objectFor(input));
      return {
        object,
        text: "",
        provider: "scripted",
        model: "scripted",
        costCny: 0,
        latencyMs: 1,
      };
    },
    async todaySpendCny() {
      return 0;
    },
  };
}

describe("深度研究 agent:fan-out", () => {
  it("拆子问题 → 并行检索 → 跨子问题综合 → 核实,步骤入库", async () => {
    const [task] = await handle.db
      .insert(tasks)
      .values({ agentName: "research", request: {} })
      .returning();
    const tools = new ToolRegistry().register(createSearchTool());
    const events: string[] = [];
    const result = await runDeepResearch(
      {
        db: handle.db,
        gateway: scriptedGateway(),
        tools,
        emit: async (type) => {
          events.push(type);
        },
        recalledMemories: ["既往结论:PG 可当队列"],
      },
      task?.id ?? "",
      "为什么用 PostgreSQL 做耐久任务队列?",
    );

    expect(result.subQuestions).toHaveLength(2);
    expect(result.synthesis.claims).toHaveLength(2);
    expect(result.verdicts.every((v) => v.rating === "green")).toBe(true);
    expect(result.sources.length).toBeGreaterThan(0);

    // fan-out 与记忆召回在事件流可见
    expect(events).toContain("memory.recall");
    expect(events).toContain("agent.fanout");
    expect(events.filter((e) => e === "agent.subquery")).toHaveLength(2);

    // 步骤落 task_steps
    const steps = await handle.db
      .select({ name: taskSteps.name })
      .from(taskSteps)
      .where(eq(taskSteps.taskId, task?.id ?? ""));
    const names = steps.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["plan", "fanout", "synthesize", "verify"]));
  });
});
