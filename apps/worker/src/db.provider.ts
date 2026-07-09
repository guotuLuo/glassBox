import { createDb, type DbHandle } from "@glassbox/db";
import type { Provider } from "@nestjs/common";
import { requireEnv } from "./env.js";

export const DB = Symbol("DB_HANDLE");

export const dbProvider: Provider = {
  provide: DB,
  useFactory: (): DbHandle => createDb(requireEnv("DATABASE_URL")),
};
