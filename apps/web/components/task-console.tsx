"use client";

import {
  type TaskDto,
  type TaskEventDto,
  type TaskStatus,
  taskEventDtoSchema,
} from "@glassbox/contracts";
import { Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createTask, taskEventsUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

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

const EVENT_DOT: Record<string, string> = {
  "task.queued": "bg-muted-foreground",
  "task.claimed": "bg-blue-500",
  "hello.step": "bg-amber-500",
  "task.succeeded": "bg-emerald-500",
  "task.failed": "bg-red-500",
};

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

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hms = d.toLocaleTimeString("zh-CN", { hour12: false });
  return `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge
      variant={status === "failed" ? "destructive" : "secondary"}
      className={cn(
        status === "running" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
        status === "succeeded" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function TaskConsole() {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDto | null>(null);
  const [events, setEvents] = useState<TaskEventDto[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const status: TaskStatus = task ? statusFromEvents(events, task.status) : "queued";
  const terminal = TERMINAL_EVENTS.has(events.at(-1)?.eventType ?? "");
  const succeededEvent = events.find((e) => e.eventType === "task.succeeded");
  const failedEvent = events.find((e) => e.eventType === "task.failed");
  const greeting =
    succeededEvent &&
    typeof succeededEvent.payload === "object" &&
    succeededEvent.payload !== null &&
    "result" in succeededEvent.payload &&
    typeof (succeededEvent.payload as { result?: { greeting?: unknown } }).result?.greeting ===
      "string"
      ? ((succeededEvent.payload as { result: { greeting: string } }).result.greeting ?? null)
      : null;

  // SSE 生命周期:浏览器 EventSource 自带断线重连,并自动携带 Last-Event-ID 续传
  useEffect(() => {
    if (!task) return;
    const es = new EventSource(taskEventsUrl(task.id));
    const onEvent = (raw: MessageEvent<string>) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.data);
      } catch {
        return;
      }
      const parsed = taskEventDtoSchema.safeParse(json);
      if (!parsed.success) return;
      setReconnecting(false);
      setEvents((prev) =>
        prev.some((e) => e.id === parsed.data.id) ? prev : [...prev, parsed.data],
      );
      if (TERMINAL_EVENTS.has(parsed.data.eventType)) es.close();
    };
    es.addEventListener("task_event", onEvent);
    es.onopen = () => setReconnecting(false);
    es.onerror = () => setReconnecting(true);
    return () => {
      es.removeEventListener("task_event", onEvent);
      es.close();
    };
  }, [task]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = message.trim();
      if (!trimmed || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const { task: created } = await createTask(trimmed);
        setEvents([]);
        setTask(created);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [message, submitting],
  );

  const reset = useCallback(() => {
    setTask(null);
    setEvents([]);
    setMessage("");
    setError(null);
    setReconnecting(false);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>提交一个 hello 任务</CardTitle>
          <CardDescription>
            走完整链路:API 入库排队 → worker 认领执行 → 事件实时回流到这里
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="输入一句话,比如你的名字"
              maxLength={500}
              disabled={submitting}
            />
            <Button type="submit" disabled={submitting || !message.trim()}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              提交
            </Button>
          </form>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {task && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>任务事件流</CardTitle>
              <div className="flex items-center gap-2">
                {reconnecting && !terminal && (
                  <span className="text-xs text-muted-foreground">连接中断,重连中…</span>
                )}
                <StatusBadge status={status} />
              </div>
            </div>
            <CardDescription className="font-mono text-xs">{task.id}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ScrollArea className="h-64 rounded-md border">
              <ul className="p-3">
                {events.length === 0 && (
                  <li className="py-6 text-center text-sm text-muted-foreground">
                    <Loader2 className="mr-1 inline size-3.5 animate-spin" />
                    等待第一条事件…
                  </li>
                )}
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-baseline gap-3 border-b py-2 last:border-b-0"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {formatTime(event.createdAt)}
                    </span>
                    <span
                      className={cn(
                        "mt-1 size-2 shrink-0 self-center rounded-full",
                        EVENT_DOT[event.eventType] ?? "bg-muted-foreground",
                      )}
                    />
                    <span className="shrink-0 font-mono text-xs font-medium">
                      {event.eventType}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {event.message}
                    </span>
                  </li>
                ))}
                <div ref={bottomRef} />
              </ul>
            </ScrollArea>

            {greeting && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                {greeting}
              </div>
            )}
            {failedEvent && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {failedEvent.message ?? "任务失败"}
              </div>
            )}
            {terminal && (
              <Button variant="outline" size="sm" onClick={reset} className="self-start">
                <RotateCcw className="size-3.5" />
                再来一个
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
