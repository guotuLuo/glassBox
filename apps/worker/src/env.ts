import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** 从仓库根加载 .env(与 api 同款小工具;两 app 的 Nest 组装胶水刻意各自独立) */
export function loadEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: [path.resolve(here, "../../../.env")], quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is required`);
  return value;
}
