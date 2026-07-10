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
  Link2,
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
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-border/60 bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3.5">
          <div className="flex size-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-primary to-blue-600 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20">
            G
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight">GlassBox</div>
            <div className="truncate text-[10.5px] text-muted-foreground">可验证的深度研究引擎</div>
          </div>
        </div>
        <div className="px-3 pb-1">
          <button
            type="button"
            onClick={newTask}
            className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-sm font-medium text-foreground/90 shadow-sm transition-all hover:border-primary/40 hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4 text-primary" />
            新任务
          </button>
        </div>
        <div className="px-4 pt-4 pb-1.5 font-medium text-[10px] text-muted-foreground/80 uppercase tracking-[0.08em]">
          最近任务
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <ul className="flex flex-col gap-0.5">
            {tasks.length === 0 && (
              <li className="px-2.5 py-6 text-center text-xs text-muted-foreground/70">
                还没有任务
              </li>
            )}
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => selectTask(task)}
                  className={cn(
                    "group relative w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                    activeId === task.id
                      ? "bg-accent/80 text-foreground"
                      : "text-foreground/80 hover:bg-accent/50",
                  )}
                >
                  {activeId === task.id && (
                    <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-primary" />
                  )}
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full ring-2 ring-transparent",
                        STATUS_DOT[task.status],
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {excerpt(task.request)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between pl-3.5 text-[10px] text-muted-foreground/70">
                    <span>{STATUS_LABEL[task.status]}</span>
                    <span className="font-mono tabular-nums">
                      {new Date(task.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <Link
          href="/playground"
          className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Search className="size-3.5" />
          召回 Playground
        </Link>
        <div className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2.5 text-[10px] text-muted-foreground/70">
          <span className="size-1.5 rounded-full bg-emerald-400/80" />
          事件源:PG LISTEN/NOTIFY → SSE
        </div>
      </aside>

      {/* 主区 */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* 顶部氛围光 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-primary/[0.06] to-transparent" />
        <header className="relative flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-4 backdrop-blur-sm">
          {active ? (
            <>
              <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                {active.id}
              </span>
              {replay && (
                <Badge variant="outline" className="gap-1 border-border/70 text-[10px]">
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
              <span className="hidden font-mono text-[11px] text-muted-foreground/70 sm:inline">
                提交 → 入队 → SKIP LOCKED 认领 → 事件回流
              </span>
            </>
          )}
        </header>

        <div ref={timelineRef} className="relative min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {!active && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-blue-600 text-xl font-bold text-primary-foreground shadow-xl shadow-primary/25">
                G
              </div>
              <div className="text-base font-semibold tracking-tight">把一句话交给 agent</div>
              <p className="max-w-md text-[13px] leading-6 text-muted-foreground">
                每一步都写进事件表,实时流到这里;历史任务随时点开回放——
                这是"玻璃盒"的地基:整个思考过程可看、可回放、每句话可溯源。
              </p>
              <div className="mt-1 flex flex-wrap justify-center gap-2 text-[11px] text-muted-foreground/70">
                {["拆解课题", "并行检索", "跨源综合", "独立核实"].map((t, i) => (
                  <span key={t} className="flex items-center gap-2">
                    {i > 0 && <span className="text-muted-foreground/40">→</span>}
                    <span className="rounded-md border border-border/60 bg-card/40 px-2 py-1">
                      {t}
                    </span>
                  </span>
                ))}
              </div>
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
                      <span className="absolute top-7 bottom-0 left-[13.5px] w-px bg-border/70" />
                    )}
                    <span
                      className={cn(
                        "z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card/80 backdrop-blur-sm",
                        meta.cls,
                      )}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-xs font-medium text-foreground/90">
                          {event.eventType}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                          {formatClock(event.createdAt)}
                        </span>
                        {delta !== null && (
                          <span className="rounded bg-muted/50 px-1 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                            +{delta}ms
                          </span>
                        )}
                      </div>
                      {event.message && (
                        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                          {event.message}
                        </p>
                      )}
                      {event.payload !== null && event.payload !== undefined && (
                        <details className="mt-1 group">
                          <summary className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground/60 transition-colors select-none hover:text-muted-foreground">
                            <span className="transition-transform group-open:rotate-90">▸</span>
                            payload
                          </summary>
                          <pre className="mt-1 overflow-x-auto rounded-lg border border-border/60 bg-black/20 p-2.5 font-mono text-[11px] leading-4.5 text-muted-foreground">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}

              {greeting && (
                <li className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] px-4 py-3 text-sm font-medium text-emerald-300">
                  {greeting}
                </li>
              )}
              {report && (
                <li className="mt-7 rounded-xl border border-border/70 bg-card/50 p-4">
                  <div className="mb-3.5 flex items-center gap-2 text-[13px] font-semibold">
                    <FileText className="size-4 text-primary" />
                    引用级报告
                    {active && (
                      <Link
                        href={`/report/${active.id}`}
                        className="flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
                      >
                        <Link2 className="size-3" />
                        分享页
                      </Link>
                    )}
                    <span className="ml-auto flex items-center gap-2.5 text-xs font-normal">
                      {(["green", "yellow", "red"] as const).map((r) => {
                        const n = report.verdicts.filter((v) => v.rating === r).length;
                        return (
                          <span key={r} className="flex items-center gap-1 tabular-nums">
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
                          className={cn(
                            "rounded-lg border-l-2 bg-card/60 py-2.5 pr-3 pl-3 transition-colors",
                            rating === "green" && "border-l-emerald-400/70",
                            rating === "yellow" && "border-l-amber-400/70",
                            rating === "red" && "border-l-red-400/70",
                          )}
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              className={cn(
                                "mt-1 size-2 shrink-0 rounded-full",
                                RATING_DOT[rating],
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-[13.5px] leading-6 text-foreground/95">
                                {claim.text}
                                <sup className="ml-1 font-mono text-[10px] text-primary/80">
                                  [{claim.citations.join(",")}]
                                </sup>
                              </p>
                              {verdict?.rationale && (
                                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                                  {verdict.rationale}
                                </p>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 rounded-lg bg-muted/40 px-3.5 py-3 text-[13px] leading-6 text-muted-foreground">
                    {report.summary}
                  </p>
                </li>
              )}
              {failedEvent && (
                <li className="mt-4 rounded-lg border border-destructive/25 bg-destructive/[0.08] px-4 py-3 text-sm text-destructive">
                  {failedEvent.message ?? "任务失败"}
                </li>
              )}
            </ol>
          )}
        </div>

        <div className="relative shrink-0 px-4 pt-2 pb-4">
          <div className="mx-auto max-w-2xl">
            <form
              onSubmit={submit}
              className="rounded-2xl border border-border/70 bg-card/70 p-2 shadow-lg shadow-black/20 backdrop-blur-sm transition-colors focus-within:border-primary/45"
            >
              <div className="mb-2 flex items-center gap-1 px-1">
                <div className="flex rounded-lg bg-muted/60 p-0.5">
                  {(
                    [
                      { k: "research", label: "深度研究" },
                      { k: "hello", label: "hello" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.k}
                      type="button"
                      onClick={() => setAgent(opt.k)}
                      className={cn(
                        "rounded-[7px] px-2.5 py-1 text-[11.5px] font-medium transition-all",
                        agent === opt.k
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="ml-1 text-[10.5px] text-muted-foreground/70">
                  {agent === "research" ? "拆解 → 检索 → 综合 → 核实" : "链路自检 · 不调模型"}
                </span>
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit(e as unknown as React.FormEvent);
                    }
                  }}
                  rows={1}
                  placeholder={
                    agent === "research"
                      ? "提一个研究问题,例如「为什么用 SKIP LOCKED 做队列」"
                      : '把一句话交给 hello agent,例如"你是谁"'
                  }
                  maxLength={agent === "research" ? 1000 : 500}
                  disabled={submitting}
                  className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={submitting || !message.trim()}
                  className="size-9 shrink-0 rounded-xl"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <SendHorizontal className="size-4" />
                  )}
                </Button>
              </div>
            </form>
            {error && <p className="mt-1.5 px-1 text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
