import type { RagEvalCase } from "./rag-eval.js";

/** 演示语料:GlassBox 自身的工程知识,playground/eval/研究 agent 共用 */
export const DEMO_CORPUS = [
  {
    title: "SKIP LOCKED 与 PostgreSQL 队列",
    source: "kb://skip-locked",
    text: "FOR UPDATE SKIP LOCKED 让并发消费者跳过已经被其他事务锁定的行,因此多个 worker 可以同时从同一张 tasks 表领取不同任务而互不阻塞。这使得一张 PostgreSQL 表可以被安全地当作工作队列,免去引入 Redis 或 Kafka。认领时用一条 UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) 原子地把任务标记为 running。",
  },
  {
    title: "租约、心跳与过期重投递",
    source: "kb://lease",
    text: "基于租约的任务分发通过 lease_expires_at 字段判定 worker 是否失联。worker 执行期间按租约周期的三分之一发送心跳续租;一旦进程崩溃,租约到期后由 reaper 把任务重新投递回队列。配合每任务的投递上限,超过次数的任务进入死信队列,避免无限重试。这套机制保证执行 at-least-once、任务终态 exactly-once。",
  },
  {
    title: "检查点与精确恢复",
    source: "kb://checkpoint",
    text: "任务在关键步骤后写检查点(checkpoint)到数据库,只有当前租约持有者能写。任务被重投递给新 worker 时,检查点随行返回,新持有者从断点继续执行而不是从头再来。这把崩溃恢复时的步骤重放压缩到每次重投递至多一步,是 park 与精确恢复语义的基础。",
  },
  {
    title: "句级引用绑定与独立核实",
    source: "kb://citation",
    text: "研究报告里每一条论断都绑定到具体的检索片段(citation),再由一个与综合阶段不同的模型做怀疑式核实,按证据充分程度给出绿/黄/红标注。绿表示来源充分支持,黄表示部分支持或引用不当,红表示来源不支持或疑似编造。这比在报告末尾贴几个链接更可审计,是反幻觉的核心手段。",
  },
  {
    title: "混合检索与 RRF 融合",
    source: "kb://hybrid-rag",
    text: "混合检索同时跑向量近邻(pgvector 的 cosine 距离)和全文检索(FTS 的 ts_rank),各自取 top-N,再用 Reciprocal Rank Fusion 融合:每个候选的分数是各路 1/(k+rank) 之和。RRF 对分数尺度不敏感,不需要归一化两路分数。中文的 FTS 通过字符 bigram 分词解决 PostgreSQL 不切中文的问题。",
  },
  {
    title: "模型网关:重试熔断与故障转移",
    source: "kb://gateway",
    text: "模型网关在 AI SDK 之上自建可靠性:每个供应商先重试并退避,连续失败达阈值则熔断,冷却后半开,失败则故障转移到下一个供应商。每次调用不论成败都记录到 model_calls 表,含 token、成本、延迟。每日累计成本达到硬顶时直接拒绝新调用,这是钱包护栏。",
  },
] as const;

/** 标注评测集:query → 期望命中的来源 */
export const DEMO_EVAL_CASES: RagEvalCase[] = [
  { query: "怎么用数据库表实现任务队列不互相阻塞", expectedSources: ["kb://skip-locked"] },
  { query: "worker 崩溃了任务怎么恢复", expectedSources: ["kb://lease", "kb://checkpoint"] },
  { query: "SKIP LOCKED 认领任务的 SQL 怎么写", expectedSources: ["kb://skip-locked"] },
  { query: "报告怎么做反幻觉核实 红黄绿", expectedSources: ["kb://citation"] },
  { query: "向量检索和全文检索怎么融合 RRF", expectedSources: ["kb://hybrid-rag"] },
  { query: "模型调用失败了怎么故障转移 熔断", expectedSources: ["kb://gateway"] },
  { query: "每天的模型成本怎么控制预算", expectedSources: ["kb://gateway"] },
  { query: "检查点是怎么做到从断点继续的", expectedSources: ["kb://checkpoint"] },
];
