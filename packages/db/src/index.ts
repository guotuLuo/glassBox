import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];

export type TaskRow = typeof schema.tasks.$inferSelect;
export type NewTaskRow = typeof schema.tasks.$inferInsert;
export type TaskEventRow = typeof schema.taskEvents.$inferSelect;
export type TaskStepRow = typeof schema.taskSteps.$inferSelect;
export type ModelCallRow = typeof schema.modelCalls.$inferSelect;
export type ToolCallRow = typeof schema.toolCalls.$inferSelect;
