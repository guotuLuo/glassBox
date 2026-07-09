import { type TaskDto, type TaskEventDto, taskStatusSchema } from "@glassbox/contracts";
import type { TaskEventRow, TaskRow } from "@glassbox/db";

export function toTaskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    agentName: row.agentName,
    status: taskStatusSchema.parse(row.status),
    request: row.request,
    result: row.result ?? null,
    error: row.error,
    deliveryAttempts: row.deliveryAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toTaskEventDto(row: TaskEventRow): TaskEventDto {
  return {
    id: row.id,
    taskId: row.taskId,
    eventType: row.eventType,
    message: row.message,
    payload: row.payload ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
