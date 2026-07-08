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

/** M0 最小事件载荷;步骤 5 的 hello task 事件流用,后续阶段增量扩展 */
export const taskEventSchema = z.object({
  taskId: z.uuid(),
  eventType: z.string().min(1),
  message: z.string().optional(),
  payload: z.unknown().optional(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;
