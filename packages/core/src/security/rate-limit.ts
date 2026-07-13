import { type Db, tasks } from "@glassbox/db";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * 限流与配额(生产化四件套,总纲 §3.7):
 *  - 限流:进程内滑动窗口(短窗、高频防刷)。单实例语义,多实例各算各的(诚实边界;
 *    ADR-001 无 Redis,重限流可迁到 PG,但短窗高频用内存足够且不压 DB);
 *  - 配额:按 owner 统计近 N 小时的任务数(持久、跨实例一致),防单用户日耗尽预算。
 */

/** 进程内滑动窗口限流器(每 key 独立);clock 可注入以便测试 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 返回 true 表示放行并记一次;false 表示超限拒绝 */
  take(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  /** 周期清理空 key,防内存泄漏 */
  sweep(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, arr] of this.hits) {
      const live = arr.filter((ts) => ts > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}

/** 近 windowHours 小时内某 owner 的任务数(配额判定,持久) */
export async function countRecentTasksByOwner(
  db: Db,
  ownerId: string,
  windowHours: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, ownerId),
        gte(tasks.createdAt, sql`now() - make_interval(hours => ${windowHours})`),
      ),
    );
  return rows[0]?.n ?? 0;
}
