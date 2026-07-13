"use client";

import { Loader2, ShieldCheck, Target } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { type EvalsSummary, getEvals } from "@/lib/api";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** 无依赖内联 SVG 折线(CSP 安全) */
function Sparkline({ values, max = 1 }: { values: number[]; max?: number }) {
  if (values.length === 0) return null;
  const w = 320;
  const h = 60;
  const pad = 4;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const yOf = (v: number) => h - pad - (Math.min(v, max) / max) * (h - pad * 2);
  const points = values.map((v, i) => ({ x: pad + i * step, y: yOf(v) }));
  const pts = points.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} className="text-primary" aria-hidden>
      <title>score trend</title>
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {points.map((p) => (
        <circle key={`${p.x},${p.y}`} cx={p.x} cy={p.y} r="2.5" fill="currentColor" />
      ))}
    </svg>
  );
}

export function EvalsPage() {
  const [data, setData] = useState<EvalsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEvals()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-blue-600 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20">
          G
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">评测 · /evals</h1>
          <p className="text-[13px] text-muted-foreground">
            公开评测:确定性召回门禁(卡 CI)+ 真实研究的忠实度(核实器红黄绿)
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-border/70 px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          ← 工作台
        </Link>
      </header>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 加载评测…
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-5">
          {/* 召回门禁 */}
          <section className="rounded-xl border border-border/70 bg-card/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
              <Target className="size-4 text-primary" />
              确定性召回评测(CI 门禁)
              <Badge variant="outline" className="ml-auto text-[10px]">
                本地 bigram 嵌入 · 完全可复现
              </Badge>
            </div>
            {data.recall.latest ? (
              <>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { k: "hit@3", v: data.recall.latest.hitRateAt3 },
                    { k: "hit@5", v: data.recall.latest.hitRateAt5 },
                    { k: "MRR", v: data.recall.latest.mrr },
                  ].map((m) => (
                    <div key={m.k} className="rounded-lg bg-muted/40 px-3 py-2.5 text-center">
                      <div className="font-mono text-2xl font-semibold tabular-nums">
                        {m.v.toFixed(2)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{m.k}</div>
                    </div>
                  ))}
                </div>
                {data.recall.history.length > 1 && (
                  <div className="mt-3">
                    <Sparkline values={data.recall.history.map((h) => h.hitRateAt5)} />
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      hit@5 跨 {data.recall.history.length} 次评测(混合检索,{" "}
                      {data.recall.latest.cases} 题标注集)
                    </div>
                  </div>
                )}
                <p className="mt-3 text-[11.5px] leading-5 text-muted-foreground">
                  CI 每次跑此评测,混合检索 hit@5 低于阈值即卡合并——回答"你怎么知道它变好了"。
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">暂无评测记录(运行 eval:rag 生成)。</p>
            )}
          </section>

          {/* 忠实度 */}
          <section className="rounded-xl border border-border/70 bg-card/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
              <ShieldCheck className="size-4 text-emerald-400" />
              研究忠实度(核实器裁定)
              <Badge variant="outline" className="ml-auto text-[10px]">
                {data.faithfulness.totalClaims} 条论断 · {data.faithfulness.runs.length} 次研究
              </Badge>
            </div>
            {data.faithfulness.totalClaims > 0 ? (
              <>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-semibold text-emerald-400 tabular-nums">
                    {pct(data.faithfulness.greenRatio)}
                  </span>
                  <span className="text-[13px] text-muted-foreground">论断由来源充分支撑(绿)</span>
                </div>
                <div className="mb-3 flex h-2.5 overflow-hidden rounded-full">
                  <div
                    className="bg-emerald-400"
                    style={{ width: pct(data.faithfulness.green / data.faithfulness.totalClaims) }}
                  />
                  <div
                    className="bg-amber-400"
                    style={{ width: pct(data.faithfulness.yellow / data.faithfulness.totalClaims) }}
                  />
                  <div
                    className="bg-red-400"
                    style={{ width: pct(data.faithfulness.red / data.faithfulness.totalClaims) }}
                  />
                </div>
                <div className="mb-3 flex gap-4 text-[11px] text-muted-foreground">
                  <span>🟢 {data.faithfulness.green} 充分</span>
                  <span>🟡 {data.faithfulness.yellow} 部分</span>
                  <span>🔴 {data.faithfulness.red} 存疑</span>
                </div>
                <ul className="flex flex-col divide-y divide-border/60">
                  {data.faithfulness.runs
                    .slice()
                    .reverse()
                    .slice(0, 8)
                    .map((r) => (
                      <li key={r.taskId} className="flex items-center gap-3 py-2">
                        <Link
                          href={`/report/${r.taskId}`}
                          className="min-w-0 flex-1 truncate text-[13px] hover:text-primary"
                        >
                          {r.question || "(无题)"}
                        </Link>
                        <div className="flex w-24 shrink-0 gap-px overflow-hidden rounded-full">
                          <span className="h-1.5 bg-emerald-400" style={{ flexGrow: r.green }} />
                          <span className="h-1.5 bg-amber-400" style={{ flexGrow: r.yellow }} />
                          <span className="h-1.5 bg-red-400" style={{ flexGrow: r.red }} />
                        </div>
                        <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {pct(r.greenRatio)}
                        </span>
                      </li>
                    ))}
                </ul>
                <p className="mt-3 text-[11.5px] leading-5 text-muted-foreground">
                  忠实度测"论断是否被检索来源支撑",不是"答案对不对"。绿比偏低通常是来源质量问题,
                  不是推理错——这正是"敢被审计":抓到的页面撑不住,就诚实标红。
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无研究任务(去工作台跑一个深度研究)。
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
