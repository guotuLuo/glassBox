import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 容器启动 + 迁移较慢;串行跑,租约/时间语义的用例互不干扰
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    env: {
      // 大陆网络拉 ryuk 清理镜像不稳;afterAll 里显式 stop() 兜底
      TESTCONTAINERS_RYUK_DISABLED: "true",
    },
  },
});
