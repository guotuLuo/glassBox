import { type DbHandle, ragEvalRuns } from "@glassbox/db";
import { Controller, Get, Inject } from "@nestjs/common";
import { desc, sql } from "drizzle-orm";
import { DB } from "./db.provider.js";

/**
 * 公开评测数据(总纲 §3.4 差异化:公开评测页 + CI 门禁)。
 * 两条线:① 确定性 RAG 召回(CI 卡分的护栏,可复现);
 *        ② 真实研究任务的忠实度(核实器红黄绿聚合,会随来源质量波动)。
 */
@Controller("api/evals")
export class EvalsController {
  constructor(@Inject(DB) private readonly dbh: DbHandle) {}

  @Get()
  async summary() {
    const recall = await this.dbh.db
      .select()
      .from(ragEvalRuns)
      .orderBy(desc(ragEvalRuns.id))
      .limit(20);

    // 每个研究任务的忠实度(红黄绿计数),按时间正序 → 忠实度曲线
    const perRun = await this.dbh.db.execute(sql`
      select t.id, t.request->>'question' as question, t.created_at as "createdAt",
        count(*) filter (where v->>'rating'='green')  as green,
        count(*) filter (where v->>'rating'='yellow') as yellow,
        count(*) filter (where v->>'rating'='red')    as red
      from tasks t, jsonb_array_elements(t.result->'verdicts') v
      where t.agent_name='research' and t.status='succeeded' and t.result ? 'verdicts'
      group by t.id, t.request, t.created_at
      order by t.created_at
    `);

    const faithfulnessRuns = (perRun.rows as Array<Record<string, unknown>>).map((r) => {
      const green = Number(r.green ?? 0);
      const yellow = Number(r.yellow ?? 0);
      const red = Number(r.red ?? 0);
      const total = green + yellow + red;
      return {
        taskId: String(r.id),
        question: (r.question as string | null) ?? "",
        createdAt: new Date(r.createdAt as string).toISOString(),
        green,
        yellow,
        red,
        greenRatio: total > 0 ? green / total : 0,
      };
    });

    const agg = faithfulnessRuns.reduce(
      (a, r) => ({ green: a.green + r.green, yellow: a.yellow + r.yellow, red: a.red + r.red }),
      { green: 0, yellow: 0, red: 0 },
    );
    const total = agg.green + agg.yellow + agg.red;

    return {
      recall: {
        latest: recall[0] ?? null,
        history: recall
          .slice()
          .reverse()
          .map((r) => ({
            id: r.id,
            label: r.label,
            hitRateAt3: r.hitRateAt3,
            hitRateAt5: r.hitRateAt5,
            mrr: r.mrr,
            cases: r.cases,
            createdAt: r.createdAt.toISOString(),
          })),
      },
      faithfulness: {
        totalClaims: total,
        green: agg.green,
        yellow: agg.yellow,
        red: agg.red,
        greenRatio: total > 0 ? agg.green / total : 0,
        runs: faithfulnessRuns,
      },
    };
  }
}
