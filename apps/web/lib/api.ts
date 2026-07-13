import {
  type CreateTaskResponse,
  createTaskResponseSchema,
  type TaskDto,
  taskDtoSchema,
  taskListSchema,
} from "@glassbox/contracts";

/** M0 直连 api(CORS 放行);上线后由 Caddy 统一域名路由 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

export type AgentKind = "hello" | "research";

export async function createTask(text: string, agent: AgentKind): Promise<CreateTaskResponse> {
  const body =
    agent === "research"
      ? { agentName: "research", input: { question: text } }
      : { agentName: "hello", input: { message: text } };
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

// ---------------- RAG 召回 playground ----------------

export interface RagCandidate {
  chunkId: number;
  documentTitle: string;
  source: string;
  content: string;
  vectorRank: number | null;
  vectorScore: number | null;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  finalRank: number;
}

export interface RagSearchResponse {
  query: string;
  embedder: string;
  candidates: RagCandidate[];
}

export async function ragSearch(q: string, k = 8): Promise<RagSearchResponse> {
  const res = await fetch(`${API_BASE}/api/rag/search?q=${encodeURIComponent(q)}&k=${k}`);
  if (!res.ok) throw new Error(`检索失败:HTTP ${res.status}`);
  return (await res.json()) as RagSearchResponse;
}

export async function ragStats(): Promise<{ documents: number; chunks: number }> {
  const res = await fetch(`${API_BASE}/api/rag/stats`);
  if (!res.ok) throw new Error(`统计失败:HTTP ${res.status}`);
  return (await res.json()) as { documents: number; chunks: number };
}

// ---------------- 公开评测 ----------------

export interface EvalsSummary {
  recall: {
    latest: { hitRateAt3: number; hitRateAt5: number; mrr: number; cases: number } | null;
    history: Array<{
      id: number;
      label: string;
      hitRateAt3: number;
      hitRateAt5: number;
      mrr: number;
      cases: number;
      createdAt: string;
    }>;
  };
  faithfulness: {
    totalClaims: number;
    green: number;
    yellow: number;
    red: number;
    greenRatio: number;
    runs: Array<{
      taskId: string;
      question: string;
      createdAt: string;
      green: number;
      yellow: number;
      red: number;
      greenRatio: number;
    }>;
  };
}

export async function getEvals(): Promise<EvalsSummary> {
  const res = await fetch(`${API_BASE}/api/evals`);
  if (!res.ok) throw new Error(`评测加载失败:HTTP ${res.status}`);
  return (await res.json()) as EvalsSummary;
}

// ---------------- 研究报告(分享页) ----------------

export interface ResearchReportData {
  question: string;
  subQuestions?: string[];
  synthesis: { claims: Array<{ text: string; citations: number[] }>; summary: string };
  verdicts: Array<{ claimIndex: number; rating: "green" | "yellow" | "red"; rationale: string }>;
  sources: Array<{ id: number; title: string; url: string; snippet: string }>;
}

export interface ReportResponse {
  id: string;
  status: TaskDto["status"];
  question: string;
  createdAt: string;
  report: ResearchReportData | null;
}

export async function getReport(taskId: string): Promise<ReportResponse> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`报告加载失败:HTTP ${res.status}`);
  const task = taskDtoSchema.parse(await res.json());
  const result = task.result as ResearchReportData | null;
  const request = task.request as { question?: string } | null;
  return {
    id: task.id,
    status: task.status,
    question: request?.question ?? result?.question ?? "",
    createdAt: task.createdAt,
    report: result?.synthesis ? result : null,
  };
}
