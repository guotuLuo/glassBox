# ADR-004:混合检索 + 本地词法嵌入(RAG 召回工程)

- **状态**:已采纳(M3;真实语义 embedder 待 SiliconFlow key)
- **日期**:2026-07-10

## 背景

M3 要交付召回工程:摄取/分块 → pgvector + FTS 混合 → rerank → 召回 playground → RAG 评测(总纲 §7)。两个现实约束:① SiliconFlow(bge-m3 嵌入 / bge-reranker)key 未配,GPT 中转无 embeddings 端点;② PostgreSQL 内置 FTS 不切中文。

## 决策

1. **嵌入 provider 抽象,默认本地词法桩**:`EmbeddingProvider` 接口 + 本地 bigram 哈希嵌入(token 哈希进 1024 维、TF、L2 归一,确定性、离线、CI 免费)+ openai-compat 真路径(SiliconFlow bge-m3,配 `EMBEDDING_*` 即用)。向量维度固定 1024 对齐 bge-m3,切真模型无需迁移。
2. **中文 FTS 用 bigram 分词**:应用层把文本切成「CJK 字符 bigram + ASCII 词」的 token 串存入 `bigram_doc`,建 `to_tsvector('simple', bigram_doc)` 的 GIN 表达式索引。同一套 token 既喂 FTS 又喂本地嵌入,两路检索基底一致。这是解决「PG 不切中文」的经典 bigram 索引法(pg_bigm 思路的应用层版)。
3. **混合融合用 RRF**:向量近邻(HNSW cosine)与 FTS(ts_rank)各取 top-N,`score = Σ 1/(k+rank)` 融合。RRF 对两路分数尺度不敏感,无需归一化。每个候选保留分路 rank/score 作为 playground 诊断。
4. **评测入库形成基线**:`evalRag` 对标注集算 hit-rate@3/@5 + MRR,三种检索器(vector/fts/hybrid)对比;`rag_eval_runs` 存历史,召回率可追踪(总纲 M3 验收 + M5 /evals 数据源)。

## 后果

- 召回工程本体全真且可测:摄取、HNSW 向量检索、中文 FTS、RRF 融合、诊断、评测 —— testcontainers 里 7 个用例覆盖,playground 端到端验证(查询"worker 崩溃恢复"→ lease/checkpoint 两个正确源经 RRF 排到最前)。
- **诚实边界**:本地嵌入是**词法**桩(bigram),语义能力弱 —— 近义/改写召回不如真 embedder;向量列质量待 bge-m3。但融合逻辑、FTS、诊断、评测与嵌入无关,配 key 后仅向量列变好,一个环境变量切换、零迁移零改码。
- **rerank 暂缺**:M3 先交付混合 + 融合;交叉编码 rerank(bge-reranker 或 LLM cross-encoder)在 key 到位或需要时补,接口位已留(retrieve 输出即 rerank 输入)。
