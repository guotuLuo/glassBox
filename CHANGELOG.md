# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);版本号在 M1 公开上线后启用 SemVer。

## [Unreleased] — M1 耐久运行时(进行中)

### Added

- 租约心跳续租(仅持有者可续)、过期重投递 reaper(线性退避,首次重投递不等待)、投递耗尽进死信(`dead_letter` 标志 + 事件);全部状态迁移留事件,多 reaper 并发安全(2026-07-09)
- 终态 exactly-once 守卫:`completeTask/failTask` 以 (id, lease_owner, running) 为条件,僵尸 worker 迟到写入变 no-op(2026-07-09)
- Vitest + testcontainers 集成测试 ×6:认领/租约、心跳归属、过期重投递+僵尸终态拒绝、死信、幂等键并发竞争、检查点归属与随行(2026-07-09)
- **SIGKILL 混沌测试**:真实 worker 子进程执行中途连杀两刀,断言全部任务收敛 succeeded、终态事件每任务恰好一条、重投递有界、检查点把 step 重放压到每次重投递至多一步(2026-07-09)
- 检查点续跑:hello agent 每步落检查点(仅租约持有者可写),重投递后从断点继续(2026-07-09)
- worker 时间参数环境变量化(租约/心跳/reaper/步进),混沌测试用短租约压测(2026-07-09)
- GitHub Actions CI:lint + typecheck + web 构建 + 测试(2026-07-09)

### 待办(M1 剩余)

- park/resume(waiting_* 三态)、LISTEN 唤醒与并发槽位(p-limit)、trace 表(model_calls/tool_calls/steps)、控制台死信/重投递视图、pino 结构化日志

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
