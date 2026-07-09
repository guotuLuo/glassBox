import {
  type CreateTaskResponse,
  createTaskResponseSchema,
  type TaskDto,
  taskDtoSchema,
  taskListSchema,
} from "@glassbox/contracts";

/** M0 直连 api(CORS 放行);上线后由 Caddy 统一域名路由 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

export async function createTask(message: string): Promise<CreateTaskResponse> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName: "hello", input: { message } }),
  });
  if (!res.ok) throw new Error(`提交失败:HTTP ${res.status}`);
  // 响应过 contracts 校验:前后端共用同一份 zod schema,漂移在运行时立刻暴露
  return createTaskResponseSchema.parse(await res.json());
}

export async function listTasks(limit = 20): Promise<TaskDto[]> {
  const res = await fetch(`${API_BASE}/api/tasks?limit=${limit}`);
  if (!res.ok) throw new Error(`列表加载失败:HTTP ${res.status}`);
  return taskListSchema.parse(await res.json());
}

export async function getTask(taskId: string): Promise<TaskDto> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`查询失败:HTTP ${res.status}`);
  return taskDtoSchema.parse(await res.json());
}

export function taskEventsUrl(taskId: string): string {
  return `${API_BASE}/api/tasks/${taskId}/events`;
}
