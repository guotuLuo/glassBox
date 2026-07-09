# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);版本号在 M1 公开上线后启用 SemVer。

## [Unreleased] — M0 骨架

### Added

- monorepo 骨架:pnpm workspaces + Turborepo,TS strict(NodeNext),Biome,Conventional Commits(2026-07-08)
- 耐久任务队列 schema:`tasks`(租约/投递计数/死信标志/幂等键唯一/检查点,承 EMAgent 0001/0003/0004/0005 字段设计)+ `task_events`(bigint identity 全序);迁移含 `CREATE EXTENSION vector`(2026-07-08)
- 本地开发库:`docker-compose.dev.yml`(pgvector/pgvector:pg16,宿主机 55432)(2026-07-08)
- 最小闭环(M0 灵魂):web 提交 → api 事务入队 → worker `FOR UPDATE SKIP LOCKED` 认领 → 事件表 + `pg_notify` → api SSE(Last-Event-ID 续传 + 心跳兜底)→ web 实时时间线(2026-07-09)
- `@glassbox/contracts`:任务状态机 / 事件 DTO / 请求响应契约,Zod 单一 schema 源,浏览器端复用校验 SSE 帧(2026-07-09)
- web 控制台:Next 16 + Tailwind v4 + shadcn/ui(radix-nova),提交表单 + 实时事件流 + 状态徽章(2026-07-09)
- ADR-000(全栈 TS)/ ADR-001(PG 当队列)/ ADR-002(tsx 运行时 + 显式 DI)(2026-07-09)
- 工作台 UI v0.5(Codex Desktop 风格):暗色 shell、侧边栏最近任务(`GET /api/tasks`)、事件时间线(图标轨道 + 步进耗时 + payload 展开)、历史任务点开即回放、底部输入条(2026-07-09)

### 语义边界

- 队列:执行 at-least-once,任务终态 exactly-once;心跳续租/过期重投递/死信投递在 M1 激活并配混沌测试
- M0 已知边界:`failed` 即终态、worker 单并发、CORS 宽松、无认证配额
