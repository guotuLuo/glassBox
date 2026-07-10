"use client";

import {
  type TaskDto,
  type TaskEventDto,
  type TaskStatus,
  taskEventDtoSchema,
} from "@glassbox/contracts";
import {
  AlertTriangle,
  Check,
  Cpu,
  FileText,
  History,
  Inbox,
  ListTree,
  Loader2,
  type LucideIcon,
  Plus,
  RotateCcw,
  Search,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type AgentKind, createTask, listTasks, taskEventsUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "cancelled"]);
const TERMINAL_EVENTS = new Set(["task.succeeded", "task.failed"]);

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_child: "等待子任务",
  waiting_input: "等待输入",
  succeeded: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  queued: "bg-muted-foreground",
  running: "bg-blue-400 animate-pulse",
  waiting_approval: "bg-amber-400",
  waiting_child: "bg-amber-400",
  waiting_input: "bg-amber-400",
  succeeded: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-muted-foreground",
};

const EVENT_META: Record<string, { icon: LucideIcon; cls: string }> = {
  "task.queued": { icon: Inbox, cls: "border-border text-muted-foreground" },
  "task.claimed": { icon: Cpu, cls: "border-blue-500/40 text-blue-400" },
  "task.requeued": { icon: RotateCcw, cls: "border-amber-500/40 text-amber-400" },
  "task.dead_lettered": { icon: AlertTriangle, cls: "border-red-500/40 text-red-400" },
  "hello.step": { icon: Sparkles, cls: "border-amber-500/40 text-amber-400" },
  "agent.plan": { icon: ListTree, cls: "border-violet-500/40 text-violet-400" },
  "agent.decide": { icon: Cpu, cls: "border-blue-500/40 text-blue-400" },
  "agent.act": { icon: Sparkles, cls: "border-amber-500/40 text-amber-400" },
  "agent.observe": { icon: Search, cls: "border-cyan-500/40 text-cyan-400" },
  "agent.synthesize": { icon: FileText, cls: "border-emerald-500/40 text-emerald-400" },
  "agent.verify": { icon: ShieldCheck, cls: "border-emerald-500/40 text-emerald-400" },
  "model.call": { icon: Cpu, cls: "border-violet-500/40 text-violet-400" },
  "tool.call": { icon: Search, cls: "border-cyan-500/40 text-cyan-400" },
  "task.succeeded": { icon: Check, cls: "border-emerald-500/40 text-emerald-400" },
  "task.failed": { icon: X, cls: "border-red-500/40 text-red-400" },
};

const RATING_STYLE: Record<"green" | "yellow" | "red", string> = {
  green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  yellow: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  red: "border-red-500/40 bg-red-500/10 text-red-300",
};
const RATING_DOT: Record<"green" | "yellow" | "red", string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-red-400",
};

interface ResearchReport {
  claims: Array<{ text: string; citations: number[] }>;
  summary: string;
  verdicts: Array<{ claimIndex: number; rating: "green" | "yellow" | "red"; rationale: string }>;
}

/** 从终态事件的 payload 里抽出研究报告(synthesize + verify 两个事件) */
function reportFromEvents(events: TaskEventDto[]): ResearchReport | null {
  const done = events.find((e) => e.eventType === "task.succeeded");
  const result = (done?.payload as { result?: unknown } | null)?.result as
    | {
        synthesis?: { claims?: unknown; summary?: unknown };
        verdicts?: unknown;
      }
    | undefined;
  if (!result?.synthesis || !Array.isArray(result.synthesis.claims)) return null;
  return {
    claims: result.synthesis.claims as ResearchReport["claims"],
    summary: String(result.synthesis.summary ?? ""),
    verdicts: Array.isArray(result.verdicts) ? (result.verdicts as ResearchReport["verdicts"]) : [],
  };
}

function statusFromEvents(events: TaskEventDto[], fallback: TaskStatus): TaskStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i]?.eventType) {
      case "task.succeeded":
        return "succeeded";
      case "task.failed":
        return "failed";
      case "task.claimed":
      case "hello.step":
        return "running";
      case "task.queued":
        return "queued";
      default:
    }
  }
  return fallback;
}

function excerpt(request: unknown): string {
  if (request && typeof request === "object") {
    const r = request as { message?: unknown; question?: unknown };
    const text = typeof r.question === "string" ? r.question : r.message;
    if (typeof text === "string" && text.trim()) return text;
  }
  return "(无输入)";
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("zh-CN", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function greetingOf(events: TaskEventDto[]): string | null {
  const done = events.find((e) => e.eventType === "task.succeeded");
  if (!done || typeof done.payload !== "object" || done.payload === null) return null;
  const result = (done.payload as { result?: { greeting?: unknown } }).result;
  return typeof result?.greeting === "string" ? result.greeting : null;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge
      variant={status === "failed" ? "destructive" : "secondary"}
      className={cn(
        status === "running" && "bg-blue-500/15 text-blue-400",
        status === "succeeded" && "bg-emerald-500/15 text-emerald-400",
      )}
    >
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function AgentWorkspace() {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [replay, setReplay] = useState(false);
  const [events, setEvents] = useState<TaskEventDto[]>([]);
  const [message, setMessage] = useState("");
  const [agent, setAgent] = useState<AgentKind>("research");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const active = tasks.find((t) => t.id === activeId) ?? null;
  const status: TaskStatus = active ? statusFromEvents(events, active.status) : "queued";
  const greeting = greetingOf(events);
  const failedEvent = events.find((e) => e.eventType === "task.failed");
  const report = reportFromEvents(events);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await listTasks(20));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  // 事件流:事件表回放 + 门铃增量;浏览器断线自动带 Last-Event-ID 续传
  useEffect(() => {
    if (!activeId) return;
    setEvents([]);
    const es = new EventSource(taskEventsUrl(activeId));
    const onEvent = (raw: MessageEvent<string>) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.data);
      } catch {
        return;
      }
      const parsed = taskEventDtoSchema.safeParse(json);
      if (!parsed.success || parsed.data.taskId !== activeId) return;
      setEvents((prev) =>
        prev.some((e) => e.id === parsed.data.id) ? prev : [...prev, parsed.data],
      );
      if (TERMINAL_EVENTS.has(parsed.data.eventType)) {
        es.close();
        void refreshTasks();
      }
    };
    es.addEventListener("task_event", onEvent);
    return () => {
      es.removeEventListener("task_event", onEvent);
      es.close();
    };
  }, [activeId, refreshTasks]);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = message.trim();
      if (!trimmed || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const { task } = await createTask(trimmed, agent);
        setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
        setReplay(false);
        setActiveId(task.id);
        setMessage("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [message, submitting, agent],
  );

  const selectTask = useCallback((task: TaskDto) => {
    setReplay(TERMINAL_STATUSES.has(task.status));
    setActiveId(task.id);
  }, []);

  const newTask = useCallback(() => {
    setActiveId(null);
    setEvents([]);
    setReplay(false);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* 侧边栏 */}
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
            G
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight">GlassBox</div>
            <div className="truncate text-[10px] text-muted-foreground">可验证的深度研究引擎</div>
          </div>
          <Badge variant="outline" className="text-[10px]">
            M0
          </Badge>
        </div>
        <div className="px-3 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={newTask}
          >
            <Plus className="size-3.5" />
            新任务
          </Button>
        </div>
        <div className="px-4 pt-2 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          最近任务
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <ul className="flex flex-col gap-0.5">
            {tasks.length === 0 && (
              <li className="px-2.5 py-6 text-center text-xs text-muted-foreground">还没有任务</li>
            )}
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => selectTask(task)}
                  className={cn(
                    "w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent",
                    activeId === task.id && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[task.status])}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{excerpt(task.request)}</span>
                  </div>
                  <div className="mt-0.5 flex justify-between pl-3.5 text-[10px] text-muted-foreground">
                    <span>{STATUS_LABEL[task.status]}</span>
                    <span className="font-mono">
                      {new Date(task.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <div className="border-t px-4 py-3 text-[10px] text-muted-foreground">
          事件源:PG LISTEN/NOTIFY → SSE
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
          {active ? (
            <>
              <span className="truncate font-mono text-xs text-muted-foreground">{active.id}</span>
              {replay && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <History className="size-3" />
                  回放
                </Badge>
              )}
              <div className="flex-1" />
              <StatusBadge status={status} />
            </>
          ) : (
            <>
              <span className="text-sm font-medium">工作台</span>
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">
                提交 → 入队 → SKIP LOCKED 认领 → 事件回流
              </span>
            </>
          )}
        </header>

        <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!active && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">
                G
              </div>
              <div className="text-sm font-medium">把一句话交给 agent</div>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                每一步都写进事件表,实时流到这里;历史任务随时点开回放—— 这是"玻璃盒"的第一块地基。M0
                阶段由 hello agent 演示链路。
              </p>
            </div>
          )}

          {active && (
            <ol className="mx-auto max-w-2xl">
              {events.length === 0 && (
                <li className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  等待事件流…
                </li>
              )}
              {events.map((event, i) => {
                const meta = EVENT_META[event.eventType] ?? {
                  icon: Sparkles,
                  cls: "border-border text-muted-foreground",
                };
                const Icon = meta.icon;
                const prev = events[i - 1];
                const delta = prev
                  ? new Date(event.createdAt).getTime() - new Date(prev.createdAt).getTime()
                  : null;
                return (
                  <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {i < events.length - 1 && (
                      <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />
                    )}
                    <span
                      className={cn(
                        "z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background",
                        meta.cls,
                      )}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-xs font-medium">{event.eventType}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {formatClock(event.createdAt)}
                        </span>
                        {delta !== null && (
                          <span className="font-mono text-[10px] text-muted-foreground/60">
                            +{delta}ms
                          </span>
                        )}
                      </div>
                      {event.message && (
                        <p className="mt-0.5 text-sm text-muted-foreground">{event.message}</p>
                      )}
                      {event.payload !== null && event.payload !== undefined && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-muted-foreground/70 select-none">
                            payload
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-4">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}

              {greeting && (
                <li className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-300">
                  {greeting}
                </li>
              )}
              {report && (
                <li className="mt-6">
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FileText className="size-3.5" />
                    引用级报告
                    <span className="ml-auto flex items-center gap-3 font-normal">
                      {(["green", "yellow", "red"] as const).map((r) => {
                        const n = report.verdicts.filter((v) => v.rating === r).length;
                        return (
                          <span key={r} className="flex items-center gap-1">
                            <span className={cn("size-2 rounded-full", RATING_DOT[r])} />
                            {n}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {report.claims.map((claim, i) => {
                      const verdict = report.verdicts.find((v) => v.claimIndex === i);
                      const rating = verdict?.rating ?? "yellow";
                      return (
                        <li
                          key={claim.text}
                          className={cn("rounded-md border px-3 py-2.5", RATING_STYLE[rating])}
                        >
                          <div className="flex items-start gap-2">
                            <span
                              className={cn(
                                "mt-1.5 size-2 shrink-0 rounded-full",
                                RATING_DOT[rating],
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-foreground">
                                {claim.text}
                                <sup className="ml-1 font-mono text-[10px] text-muted-foreground">
                                  [{claim.citations.join(",")}]
                                </sup>
                              </p>
                              {verdict?.rationale && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {verdict.rationale}
                                </p>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 rounded-md border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
                    {report.summary}
                  </p>
                </li>
              )}
              {failedEvent && (
                <li className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {failedEvent.message ?? "任务失败"}
                </li>
              )}
            </ol>
          )}
        </div>

        <div className="shrink-0 border-t bg-background p-3">
          <div className="mx-auto max-w-2xl">
            <div className="mb-2 flex gap-1">
              {(
                [
                  { k: "research", label: "深度研究", desc: "拆解→检索→综合→核实" },
                  { k: "hello", label: "hello", desc: "链路自检" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => setAgent(opt.k)}
                  title={opt.desc}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    agent === opt.k
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="flex gap-2">
              <Input
                ref={inputRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  agent === "research"
                    ? "提一个研究问题,例如「为什么用 SKIP LOCKED 做队列」"
                    : '把一句话交给 hello agent,例如"你是谁"'
                }
                maxLength={agent === "research" ? 1000 : 500}
                disabled={submitting}
              />
              <Button type="submit" size="icon" disabled={submitting || !message.trim()}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SendHorizontal className="size-4" />
                )}
              </Button>
            </form>
            {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
