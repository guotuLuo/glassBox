# ADR-000:全栈 TypeScript(不用 Java / Go / Python)

- **状态**:已采纳
- **日期**:2026-07(项目启动即定案)

## 背景

GlassBox 是单人 12 个月的作品集项目,评价权重在**产品完成度**与 **agent 工程深度**,不在语言本身。开发者本职为 Java 后端(由工作背书),此前已有 TS 全栈实战(AStockAgent)与 Python agent runtime 深度项目(EMAgent,含混沌测试验证的耐久队列)。

## 决策

前端、API、worker、共享契约与评测全部使用 TypeScript:Next.js 15+ / NestJS 11 / Drizzle / Zod,pnpm + Turborepo monorepo。

## 备选与否决理由

- **Java**:本职已背书,重复证明无增量;前后端割裂拖慢单人产品迭代。
- **Go**:强于基建叙事,但产品层生态(AI SDK / MCP SDK / UI)向 TS 收敛;保留为将来冲后端向岗位时"用 Go 重写队列+planner 核心"的 2–3 周支线。
- **Python**:EMAgent 已证明过;产品化(SSR 前端、类型共享)不如 TS 顺。

## 后果

- 一门语言贯穿全栈,类型与 schema(Zod)可从 DB 一路共享到浏览器——M0 已兑现:浏览器用同一份 contracts 校验 SSE 帧。
- 面试叙事三角互证:Java 靠本职、Python 靠 EMAgent、TS 靠本项目完成度;runtime 概念(租约、SKIP LOCKED、检查点)语言中立,须能双语讲解。
- 代价:大陆 agent 岗 JD 主流写 Python/Java,TS 不是关键词——靠"产品完成度 + 模式已在 Python 验证过"补位。
