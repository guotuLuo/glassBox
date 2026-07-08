# GlassBox

可验证的深度研究/知识引擎 — agent 作品集项目(12 个月计划,2026-07 启动)。

**开工前必读 `PROJECT_PLAN.md`(项目总纲,唯一启动依据;含全部背景、决策理由、路线图与 M0 清单)。**

## 硬约束(已敲定,勿重开论证;理由见总纲 §11 决策记录)

- 全 TS monorepo:Next.js 15 + NestJS 11 + Drizzle + PostgreSQL 16(pgvector);pnpm + Turborepo;Zod 为唯一 schema 源。
- PG 一库三用(队列/向量/trace),不引入 Redis/Kafka;核心 agent loop 手造,不用 LangGraph/Mastra。
- 模型走个人 API key(DeepSeek/SiliconFlow/智谱个人版),严禁公司网关凭证。
- 部署:用户自有 4c8G 服务器,Docker Compose + Caddy;镜像在 CI 构建,不在服务器上构建。
- 参考源码:EMAgent(`C:\Users\Administrator\Desktop\EMAgent`)——移植模式映射见总纲 §6,可直接读其源码。

## 工作方式

- 中文交流;**教学导向**:关键设计先讲清取舍再写码(用户在借此掌握 agent 工程素养)。
- 前端专业现代(shadcn/ui),不手搓 HTML;不默认 Python。
- 每阶段:设计 → 实现 → 跑验收清单 → 写 ADR(`docs/adr/`)→ 更新 CHANGELOG。
- 诚实工程:局限与语义边界(如 at-least-once)写进文档;声明必须有测试或数据背书。
