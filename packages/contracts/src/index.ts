import { z } from "zod";

/**
 * Zod 单一 schema 源:工具契约 / 结构化输出 / API DTO / 事件全部从这里出(总纲 §4)。
 * 本包保持平台中立(浏览器可用),不引入 Node API。
 */

/** 任务生命周期状态,承 EMAgent runner 语义:三种 park 态均可扛重启(总纲 §6) */
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_child",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** PG NOTIFY 频道名(api 侧 LISTEN,core 侧 pg_notify) */
export const TASK_EVENTS_CHANNEL = "task_events";

/** NOTIFY 载荷只带指针(事件表才是真相;8KB 载荷上限也不允许塞正文) */
export const taskEventNotificationSchema = z.object({
  taskId: z.uuid(),
  eventId: z.number().int().positive(),
});
export type TaskEventNotification = z.infer<typeof taskEventNotificationSchema>;

/** 已知事件类型;消费方必须容忍未知值(逐阶段增) */
export const KNOWN_TASK_EVENT_TYPES = [
  "task.queued",
  "task.claimed",
  "task.requeued",
  "task.dead_lettered",
  "hello.step",
  "agent.plan",
  "agent.decide",
  "agent.act",
  "agent.observe",
  "agent.fanout",
  "agent.subquery",
  "agent.synthesize",
  "agent.verify",
  "memory.recall",
  "memory.write",
  "web.fetch",
  "model.call",
  "tool.call",
  "task.succeeded",
  "task.failed",
] as const;

/** plan 步:把课题拆成 2–4 个子问题(fan-out) */
export const subQuestionPlanSchema = z.object({
  rationale: z.string().max(1000),
  subQuestions: z.array(z.string().min(1).max(300)).min(1).max(4),
});
export type SubQuestionPlan = z.infer<typeof subQuestionPlanSchema>;

// ---------------- agent 循环契约(M2:planner 的结构化输出) ----------------

/** 研究 agent 的输入 */
export const researchInputSchema = z.object({
  question: z.string().min(1).max(1000),
});
export type ResearchInput = z.infer<typeof researchInputSchema>;

/** decide 步:planner 看观察结果后决定下一步动作 */
export const agentDecisionSchema = z.object({
  reasoning: z.string().max(2000),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("use_tool"),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
    }),
    z.object({ kind: z.literal("finish"), reason: z.string().max(500) }),
  ]),
});
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

/** synthesize 步:综合出的带引用报告 */
export const agentSynthesisSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        citations: z.array(z.number().int().nonnegative()),
      }),
    )
    .min(1),
  summary: z.string().min(1),
});
export type AgentSynthesis = z.infer<typeof agentSynthesisSchema>;

/** verify 步:另一个模型对每条论断的核实裁定(红/黄/绿) */
export const claimVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      claimIndex: z.number().int().nonnegative(),
      rating: z.enum(["green", "yellow", "red"]),
      rationale: z.string().max(1000),
    }),
  ),
});
export type ClaimVerdict = z.infer<typeof claimVerdictSchema>;

/** 事件 DTO:SSE data 帧与回放接口的统一载荷 */
export const taskEventDtoSchema = z.object({
  id: z.number().int(),
  taskId: z.uuid(),
  eventType: z.string().min(1),
  message: z.string().nullable(),
  payload: z.unknown().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type TaskEventDto = z.infer<typeof taskEventDtoSchema>;

/** hello agent 的输入契约(worker 执行前二次校验,不信任落库内容) */
export const helloInputSchema = z.object({
  message: z.string().min(1).max(500),
});
export type HelloInput = z.infer<typeof helloInputSchema>;

/**
 * 提交任务请求:按 agentName 判别输入契约。
 * 未知 agentName 由 worker 显式失败(不在网关拦,保持队列语义单一)。
 */
export const createTaskRequestSchema = z.discriminatedUnion("agentName", [
  z.object({
    agentName: z.literal("hello"),
    input: helloInputSchema,
    idempotencyKey: z.string().min(8).max(128).optional(),
  }),
  z.object({
    agentName: z.literal("research"),
    input: researchInputSchema,
    idempotencyKey: z.string().min(8).max(128).optional(),
  }),
]);
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/** 任务 DTO:API 出口形状(时间一律 ISO 字符串) */
export const taskDtoSchema = z.object({
  id: z.uuid(),
  agentName: z.string(),
  status: taskStatusSchema,
  request: z.unknown(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  deliveryAttempts: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TaskDto = z.infer<typeof taskDtoSchema>;

/** 任务列表(工作台侧边栏) */
export const taskListSchema = z.array(taskDtoSchema);

/** 提交任务响应;deduplicated=true 表示幂等键命中既有任务 */
export const createTaskResponseSchema = z.object({
  task: taskDtoSchema,
  deduplicated: z.boolean(),
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;
