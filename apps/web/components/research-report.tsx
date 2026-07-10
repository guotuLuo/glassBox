"use client";

import { Check, CircleAlert, Link2, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { getReport, type ReportResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

const RATING_STYLE: Record<"green" | "yellow" | "red", string> = {
  green: "border-emerald-500/40 bg-emerald-500/[0.07]",
  yellow: "border-amber-500/40 bg-amber-500/[0.07]",
  red: "border-red-500/40 bg-red-500/[0.07]",
};
const RATING_BADGE: Record<"green" | "yellow" | "red", { cls: string; label: string }> = {
  green: { cls: "bg-emerald-500/15 text-emerald-400", label: "证据充分" },
  yellow: { cls: "bg-amber-500/15 text-amber-400", label: "部分支持" },
  red: { cls: "bg-red-500/15 text-red-400", label: "存疑" },
};

export function ResearchReport({ taskId }: { taskId: string }) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getReport(taskId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [taskId]);

  if (error) {
    return <div className="mx-auto max-w-3xl px-4 py-20 text-center text-destructive">{error}</div>;
  }
  if (!data) {
    return (
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 py-20 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 加载报告…
      </div>
    );
  }

  const tally = (r: "green" | "yellow" | "red") =>
    data.report?.verdicts.filter((v) => v.rating === r).length ?? 0;

  const copyLink = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <header className="mb-6">
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Link href="/" className="flex items-center gap-1.5 hover:text-foreground">
            <span className="flex size-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
              G
            </span>
            GlassBox
          </Link>
          <span>·</span>
          <span>可验证研究报告</span>
          <button
            type="button"
            onClick={copyLink}
            className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 transition-colors hover:bg-accent"
          >
            <Link2 className="size-3" />
            {copied ? "已复制" : "分享链接"}
          </button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.question}</h1>
        {data.report && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            {(["green", "yellow", "red"] as const).map((r) => (
              <span key={r} className={cn("rounded-full px-2 py-0.5", RATING_BADGE[r].cls)}>
                {RATING_BADGE[r].label} {tally(r)}
              </span>
            ))}
            <span className="text-muted-foreground">每条论断由独立模型核实,可点开溯源</span>
          </div>
        )}
      </header>

      {!data.report && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          {data.status === "succeeded"
            ? "该任务没有可展示的研究报告(可能是 hello 任务)。"
            : `报告尚未就绪(当前状态:${data.status})。`}
        </div>
      )}

      {data.report && (
        <>
          {data.report.subQuestions && data.report.subQuestions.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                拆解的子问题(fan-out)
              </h2>
              <ol className="flex flex-col gap-1">
                {data.report.subQuestions.map((q, i) => (
                  <li key={q} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="font-mono text-xs text-primary">{i + 1}.</span>
                    {q}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="mb-8 flex flex-col gap-3">
            {data.report.synthesis.claims.map((claim, i) => {
              const verdict = data.report?.verdicts.find((v) => v.claimIndex === i);
              const rating = verdict?.rating ?? "yellow";
              const Icon = rating === "green" ? Check : rating === "red" ? X : CircleAlert;
              return (
                <article
                  key={claim.text}
                  className={cn("rounded-lg border px-4 py-3", RATING_STYLE[rating])}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                        RATING_BADGE[rating].cls,
                      )}
                    >
                      <Icon className="size-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] leading-6">
                        {claim.text}
                        {claim.citations.map((c) => (
                          <a
                            key={c}
                            href={`#src-${c}`}
                            className="ml-0.5 align-super font-mono text-[10px] text-primary hover:underline"
                          >
                            [{c}]
                          </a>
                        ))}
                      </p>
                      {verdict?.rationale && (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          核查:{verdict.rationale}
                        </p>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>

          <section className="mb-8 rounded-lg border bg-muted/20 px-4 py-3">
            <h2 className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              摘要
            </h2>
            <p className="text-sm leading-6">{data.report.synthesis.summary}</p>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              来源
            </h2>
            <ol className="flex flex-col gap-2">
              {data.report.sources.map((s) => (
                <li
                  key={s.id}
                  id={`src-${s.id}`}
                  className="scroll-mt-4 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-primary">[{s.id}]</span>
                    <span className="font-medium">{s.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{s.url}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{s.snippet}</p>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      <footer className="mt-10 border-t pt-4 text-center text-xs text-muted-foreground">
        <Badge variant="outline">GlassBox · 每句话可溯源</Badge>
      </footer>
    </main>
  );
}
