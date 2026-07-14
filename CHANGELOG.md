# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);版本号在 M1 公开上线后启用 SemVer。

## [Unreleased] — M5 评测与治理(进行中)

### Added

- 确定性 RAG 召回评测 CLI(eval:rag):摄取语料 → hit@3/@5 + MRR(三路检索)→ 入库 → hit@5 低于阈值退出码 1(2026-07-13)
- CI 评测门禁:新增 eval-gate job(pg service 容器 + migrate + eval:rag),混合检索 hit@5 回归即卡合并(2026-07-13)
- 公开 /evals 页:确定性召回门禁(分数 + 跨版本 sparkline 曲线)+ 研究忠实度(核实器红黄绿聚合 + 按研究任务分布),无需登录(2026-07-13)
- API GET /api/evals:召回历史 + 忠实度聚合(2026-07-13)
- ADR-007(评测门禁 + 公开 /evals)(2026-07-13)

- 提示注入防御(EMAgent sanitizer 移植):检索片段入上下文前密钥脱敏(回写来源,存库/展示也不泄密)+ 注入启发式扫描(中英,security.flag 事件)+ untrusted 包装;实测摄取含注入+假密钥文档→脱敏+标记,模型未被劫持(2026-07-13)
- 限流 + 配额:提交任务守卫,每 IP 每分钟滑动窗口限流(超限 429)+ 每 owner 每日配额(按 tasks 表统计);实测 5×201→429、不同 IP 独立(2026-07-13)
- 安全测试:sanitizer(脱敏/中英注入/组合)+ 滑动窗口限流,8 纯逻辑用例;ADR-008(2026-07-13)

- 审批门 + park/resume(人在环路):parkForApproval(running→waiting_approval,存检查点、释放租约,扛重启)/ resolveApproval(approve 回 queued 从检查点恢复、reject 终态);ParkedError 让位;approval 演示 agent(草拟→park→精确恢复,草拟不重做);审批台 API(GET/POST /api/approvals)+ 工作台审批面板;实测 park→批准→精确恢复(草拟恰好一次)、reject→failed、park 扛重启,3 集成用例;闭合 ADR-008「最后一米」;ADR-009(2026-07-14)

### 待办(M5 剩余)

- LLM judge 夜跑(端到端质量打分)、登录接入(better-auth,owner 从 IP 换真实用户 + 审批人 RBAC)、风险工具自动接审批门、负载测试

## [Unreleased] — M4 旗舰体验(进行中)

### Added

- **联网研究(自建抓取管线)**:中转 web_search 只做 URL 发现,GlassBox 自己抓网页正文(fetch + SSRF 防护 + readability 抽正文)→ 分块相关片段 → 引用绑定 → 独立核实;worker 把「联网网页 + 私有知识库」合并成一个 web_search 工具(总纲 §0 多源),抓取过程 web.fetch 事件在玻璃盒可见;OUTBOUND_PROXY 让开发机 Node fetch 走代理抓外网(生产直连)。端到端验证:「天空为什么是蓝色」→ 抓 NASA/NOAA 真实网页 → 带引用报告 + 红黄绿(ADR-006)(2026-07-10)
- Cursor 风格前端重构:冷调分层深色 + 蓝色强调、渐变 logo、精致侧边栏/时间线/悬浮输入框(2026-07-10)

- fan-out 深度研究 agent:plan 拆 2–4 子问题 → 并行多源检索 → 跨子问题综合(带引用)→ 独立模型红黄绿核实;每个子问题事件流独立可见(2026-07-10)
- 长期记忆(memories 表 + core/memory):owner 隔离、写入去重、召回相关性下限、按 owner 容量上限(最久未用淘汰),声明式/程序性双记忆,复用 M3 嵌入 + HNSW(2026-07-10)
- 记忆闭环:研究完成沉淀绿标结论,后续相关课题在 plan 步召回(memory.recall 事件可见)(2026-07-10)
- 报告分享页(`/report/[id]`):公开只读,子问题 + 论断红黄绿 + 引用锚点跳转来源 + 摘要 + 复制分享链接(2026-07-10)
- ADR-005(fan-out + 长期记忆)(2026-07-10)

### 测试

- 深度研究 fan-out(脚本网关,确定性):拆解、并行检索、步骤入库、memory.recall/fanout/subquery 事件
- 长期记忆:owner 隔离、写入去重、召回下限、容量淘汰
- 端到端(真 GPT 中转):研究"耐久队列不丢任务"→ 4 子问题/5 源/19 论断全绿 → 沉淀 3 记忆;后续课题召回 3 条;报告页公开渲染

### 诚实边界

- fan-out 为进程内并行,非耐久子任务(parent/child park/resume);schema parent_task_id 已预留
- 记忆召回质量受本地词法嵌入限制,floor 随 embedder 调(MEMORY_RECALL_FLOOR);换 bge-m3 后更准
- 无认证,owner 暂用 createdBy/anonymous,M5 接登录后换真实隔离

## [Unreleased] — M3 RAG 召回(进行中)

### Added

- RAG 库表:documents / document_chunks(vector(1024) + bigram_doc)/ rag_eval_runs;HNSW cosine 索引 + GIN FTS 表达式索引(2026-07-10)
- 摄取管线:滑窗分块(句边界对齐)→ 嵌入 → 落库;嵌入 provider 抽象(本地 bigram 词法桩默认 + openai-compat/bge-m3 真路径,维度 1024 对齐、切换免迁移)(2026-07-10)
- 中文 FTS:CJK 字符 bigram 分词,同一套 token 喂 FTS 与本地嵌入(2026-07-10)
- 混合检索:向量近邻 + FTS,RRF 融合,每候选带分路 rank/score 诊断(2026-07-10)
- 召回 playground(`/playground`):查询→候选表格,向量/FTS/融合分并排,分路命中可视(2026-07-10)
- RAG 评测:hit-rate@3/@5 + MRR,vector/fts/hybrid 三路对比,跑分入库形成可追踪基线(2026-07-10)
- API:POST /api/rag/ingest、GET /api/rag/search、GET /api/rag/stats;演示语料 seed 脚本(2026-07-10)
- ADR-004(混合检索 + 本地词法嵌入)(2026-07-10)

### 测试

- RAG 集成测试(testcontainers)×5:摄取、向量/FTS/混合检索、RRF 单调、两路>单路
- RAG 评测测试 ×2:三路指标计算、混合不低于单路、跑分入库
- 端到端:seed 6 文档,playground 查"worker 崩溃恢复"→ lease/checkpoint 经 RRF 居首

### 诚实边界

- 本地嵌入是词法桩(bigram),语义召回弱;向量列质量待 SiliconFlow bge-m3 key,融合/FTS/诊断/评测与嵌入无关
- rerank(交叉编码)暂缺,接口位已留,key 到位或需要时补

## [Unreleased] — M2 编排与工具(进行中)

### Added

- trace 三表(task_steps / model_calls / tool_calls,承 EMAgent 0001):每步、每次模型/工具调用可回放、可计费——玻璃盒本体(2026-07-10)
- 模型网关自建:分层路由(cheap/strong/verify)、每供应商重试+熔断+failover、每次调用落 model_calls、每日预算硬顶;AI SDK 仅做 I/O(2026-07-10)
- 结构化输出:提示词注入 JSON Schema + 防御性提取 + 一次修复重试,不依赖供应商 structured output(2026-07-10)
- 工具注册表:Zod 入参契约 + 风险等级 + 统一执行入口;SSRF 防护(DNS 解析后拒私网/环回/云元数据地址)(2026-07-10)
- 自适应研究 agent:plan→decide→act→observe→synthesize→verify,loop guard;句级引用绑定 + 独立型号红黄绿核实(2026-07-10)
- ADR-003(模型网关 + 供应商现实:本地检验 + GPT 中转,chat 端点而非伪 responses)(2026-07-10)

### 测试

- 网关重试/熔断/failover/预算 + 防御性 JSON + 结构化修复重试(stub adapter,免费)、SSRF(含真实 DNS);core 全套 17 passing
- 真 GPT 中转端到端冒烟通过:agent 7 步跑通、4 次模型调用记账、成本 ¥0.04

### 诚实边界

- 中转为逆向转售(无 SLA、过第三方):不放敏感内容、路线图不依赖、熔断敏感;其 /responses 是伪实现,用 chat 端点
- web_search 为确定性内存语料桩(公司 unifiedsearch 不可用、博查 key 未配),M3 接真实检索
- "验证器 ≠ 综合供应商"暂用不同型号近似,真跨供应商多样性待国产 key

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
