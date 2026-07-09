import { createDb, type DbHandle } from "@glassbox/db";
import { Inject, Injectable, type OnApplicationShutdown, type Provider } from "@nestjs/common";
import { requireEnv } from "./env.js";

/** 显式注入 token:运行时走 tsx/esbuild,无装饰器元数据,一律 @Inject(DB)(ADR-002) */
export const DB = Symbol("DB_HANDLE");

export const dbProvider: Provider = {
  provide: DB,
  useFactory: (): DbHandle => createDb(requireEnv("DATABASE_URL")),
};

@Injectable()
export class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}
