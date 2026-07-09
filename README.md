# GlassBox

**A verifiable deep-research engine — every claim traceable, every agent step replayable.**
可验证的深度研究/知识引擎:输入一个课题,agent 拆解 → 并行多源检索 → 逐条对抗核实 → 产出每句话可溯源的引用级报告;整个思考过程像玻璃盒一样可看、可回放、可评分。

市面 agent 比谁答得快,GlassBox 比谁**敢被审计**。

> 当前阶段:**M0 骨架**——耐久任务队列最小闭环已跑通(提交 → 入队 → worker 认领 → 事件流实时回放)。

## 架构(M0)

```
web (Next 16, :3002) ──POST /api/tasks──▶ api (NestJS, :3001)
        ▲                                   │ 事务:插任务 + 写事件 + pg_notify
        │ SSE(Last-Event-ID 续传)           ▼
        └────── LISTEN task_events ─── PostgreSQL 16 + pgvector (:55432)
                                            ▲ FOR UPDATE SKIP LOCKED + 租约
                                            │
                                     worker (NestJS standalone)
```

- **DB 即队列**:`FOR UPDATE SKIP LOCKED` 认领 + 时限租约 + 幂等键唯一约束(见 [ADR-001](docs/adr/001-postgres-as-queue.md))
- **事件表为真相,NOTIFY 只当门铃**:SSE 从事件表回放,`Last-Event-ID` 断线续传,心跳兜底轮询
- **Zod 单一 schema 源**:同一份 `@glassbox/contracts` 在 API 入参校验、SSE 帧、浏览器端复用

## 本地起步

```bash
corepack enable pnpm && pnpm install
docker compose -f docker-compose.dev.yml up -d   # PG16 + pgvector,宿主机 :55432
cp .env.example .env                              # 按需改 DATABASE_URL
pnpm --filter @glassbox/db migrate                # 建表(含 CREATE EXTENSION vector)
pnpm dev                                          # turbo 并行:api :3001 / worker / web :3002
```

打开 http://localhost:3002,输入一句话提交任务,实时看事件流。

## 语义边界(诚实声明)

队列语义为**执行 at-least-once、任务终态 exactly-once**。M0 已就位租约字段与投递计数,但心跳续租、过期重投递(reaper)、死信在 M1 落地并配混沌测试(SIGKILL 中途杀 worker,任务仍完成且终态唯一)。当前 `failed` 即终态、worker 单并发、CORS 宽松、无认证——均为 M0 已知边界,按路线图收敛。

## 路线图

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | monorepo + 任务闭环骨架 + CI/CD 上线 | 进行中(闭环已通,待 CI 与部署) |
| M1 | 耐久运行时:租约/重投递/死信/检查点 + 混沌测试 + 控制台 | |
| M2 | 编排与工具:Zod 工具注册表、MCP client、模型网关、自适应 planner | |
| M3 | RAG 召回:pgvector+FTS 混合检索 + rerank + 召回 playground | |
| M4 | 旗舰体验:句级引用绑定 + 独立模型核实 + 红黄绿标注报告 | |
| M5 | 评测与治理:确定性 bench CI 门禁 + 公开 /evals + 配额限流 | |
| M6 | 生态:MCP server 暴露 + WASM 沙箱代码解释器 | |

关键取舍记录在 [docs/adr/](docs/adr/)。

## License

[MIT](LICENSE)
