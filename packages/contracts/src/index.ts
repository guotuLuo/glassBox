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

/** M0 已知事件类型;消费方必须容忍未知值(后续阶段会增) */
export const KNOWN_TASK_EVENT_TYPES = [
  "task.queued",
  "task.claimed",
  "hello.step",
  "task.succeeded",
  "task.failed",
] as const;

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

/** 提交任务请求(M0 仅 hello agent;未知 agentName 由 worker 显式失败,不在网关拦) */
export const createTaskRequestSchema = z.object({
  agentName: z.string().min(1).max(64).default("hello"),
  input: helloInputSchema,
  idempotencyKey: z.string().min(8).max(128).optional(),
});
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
