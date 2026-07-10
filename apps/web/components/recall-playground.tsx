"use client";

import { Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type RagCandidate, ragSearch, ragStats } from "@/lib/api";
import { cn } from "@/lib/utils";

const PRESETS = [
  "怎么用数据库表实现任务队列不互相阻塞",
  "worker 崩溃了任务怎么恢复",
  "报告怎么做反幻觉核实 红黄绿",
  "向量检索和全文检索怎么融合",
];

function ScoreCell({
  rank,
  score,
  tint,
}: {
  rank: number | null;
  score: number | null;
  tint: string;
}) {
  if (rank === null) return <span className="text-xs text-muted-foreground/40">—</span>;
  return (
    <div className="flex flex-col items-end">
      <span className={cn("font-mono text-xs font-medium", tint)}>#{rank}</span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {score !== null ? score.toFixed(4) : ""}
      </span>
    </div>
  );
}

export function RecallPlayground() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [embedder, setEmbedder] = useState<string>("");
  const [candidates, setCandidates] = useState<RagCandidate[] | null>(null);
  const [stats, setStats] = useState<{ documents: number; chunks: number } | null>(null);

  useEffect(() => {
    void ragStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await ragSearch(trimmed, 8);
      setCandidates(res.candidates);
      setEmbedder(res.embedder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
          G
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">召回 Playground</h1>
          <p className="text-sm text-muted-foreground">
            混合检索诊断:向量近邻 + 全文检索(bigram)→ RRF 融合,分路排名/分数并排可见
          </p>
        </div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← 工作台
        </Link>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {stats && (
          <Badge variant="outline">
            语料 {stats.documents} 文档 / {stats.chunks} 块
          </Badge>
        )}
        {embedder && <Badge variant="outline">embedder: {embedder}</Badge>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
        className="flex gap-2"
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入检索问题,看两路召回如何融合"
          disabled={loading}
        />
        <Button type="submit" disabled={loading || !query.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          检索
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setQuery(p);
              void run(p);
            }}
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
          >
            {p}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      {candidates && (
        <div className="mt-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">融合</th>
                <th className="px-3 py-2 text-left font-medium">片段</th>
                <th className="px-3 py-2 text-right font-medium">向量</th>
                <th className="px-3 py-2 text-right font-medium">FTS</th>
                <th className="px-3 py-2 text-right font-medium">RRF 分</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    无命中
                  </td>
                </tr>
              )}
              {candidates.map((c) => (
                <tr key={c.chunkId} className="border-t align-top">
                  <td className="px-3 py-2.5">
                    <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 font-mono text-xs font-semibold text-primary">
                      {c.finalRank}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="text-xs font-medium">{c.documentTitle}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {c.source}
                      </span>
                    </div>
                    <p className="max-w-md text-xs leading-5 text-muted-foreground">
                      {c.content.length > 120 ? `${c.content.slice(0, 120)}…` : c.content}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ScoreCell rank={c.vectorRank} score={c.vectorScore} tint="text-blue-400" />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ScoreCell rank={c.ftsRank} score={c.ftsScore} tint="text-emerald-400" />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    {c.fusedScore.toFixed(5)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {candidates && (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          <span className="text-blue-400">蓝</span> = 向量近邻命中排名(cosine),
          <span className="text-emerald-400"> 绿</span> = 全文检索命中排名(ts_rank); 某一路为 —
          表示该路未召回此片段。融合分 = Σ 1/(60+rank),两路都命中的片段天然靠前。
          本地嵌入为词法桩(bigram),接入真实语义 embedder 后向量列质量提升,融合逻辑不变。
        </p>
      )}
    </main>
  );
}
