import { countRecentTasksByOwner, SlidingWindowLimiter } from "@glassbox/core";
import type { DbHandle } from "@glassbox/db";
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { DB } from "./db.provider.js";

const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 10);
const DAILY_QUOTA = Number(process.env.DAILY_TASK_QUOTA ?? 50);

/**
 * 提交任务的限流 + 配额守卫(生产化四件套,总纲 §3.7):
 *  - 限流:每 IP 每分钟 RATE_LIMIT_PER_MIN 次(进程内滑动窗口,防高频刷);
 *  - 配额:每 owner 每日 DAILY_TASK_QUOTA 个任务(按 tasks 表统计,持久)。
 * 超限返回 429。owner 暂用 IP(无认证);M5 接登录后换真实用户。
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly limiter = new SlidingWindowLimiter(RATE_LIMIT, 60_000);

  constructor(@Inject(DB) private readonly dbh: DbHandle) {
    setInterval(() => this.limiter.sweep(), 60_000).unref();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = clientIp(req);

    if (!this.limiter.take(ip)) {
      throw new HttpException(
        { message: `rate limit exceeded (${RATE_LIMIT}/min)`, retryAfterMs: 60_000 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const used = await countRecentTasksByOwner(this.dbh.db, ip, 24);
    if (used >= DAILY_QUOTA) {
      throw new HttpException(
        { message: `daily quota exhausted (${used}/${DAILY_QUOTA})`, quota: DAILY_QUOTA },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/** 取客户端 IP(信任 Caddy 的 X-Forwarded-For 首段;退回 socket) */
export function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
  return (first ?? req.ip ?? req.socket.remoteAddress ?? "unknown").trim();
}
