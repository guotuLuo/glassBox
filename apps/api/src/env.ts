import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** 从仓库根加载 .env(turbo 的 cwd 是包目录,显式定位根;容器里由编排注入,缺文件是安静的) */
export function loadEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: [path.resolve(here, "../../../.env")], quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is required`);
  return value;
}
