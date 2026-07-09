import type { DbHandle } from "@glassbox/db";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { DB } from "./db.provider.js";

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly dbh: DbHandle) {}

  @Get("healthz")
  async health(): Promise<{ status: "ok" }> {
    try {
      await this.dbh.pool.query("select 1");
    } catch {
      throw new ServiceUnavailableException({ status: "degraded", db: "down" });
    }
    return { status: "ok" };
  }
}
