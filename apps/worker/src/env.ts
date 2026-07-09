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

/** 整数环境变量(混沌测试用短租约/快节奏覆盖默认值) */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
