# ADR-001:PostgreSQL 一库三用,DB 即队列(不引入 Redis / Kafka)

- **状态**:已采纳
- **日期**:2026-07(项目启动即定案;M0 步骤 4/5 落地第一切片)

## 背景

部署目标是 4c8G 单机。任务队列、向量检索(pgvector)、trace/事件存储三类负载都需要持久化;每多一个有状态组件,内存、备份、故障面都翻倍。EMAgent 已用「PG + FOR UPDATE SKIP LOCKED + 时限租约」模式通过混沌测试(多进程 SIGKILL 下任务终态唯一)。

## 决策

PostgreSQL 16 承担队列、向量、trace 三种角色。队列核心语义:

```sql
UPDATE tasks SET status='running', lease_owner=$1,
       lease_expires_at = now() + make_interval(secs => $2),
       delivery_attempts = delivery_attempts + 1
WHERE id = (
  SELECT id FROM tasks
  WHERE status='queued' AND available_at <= now()
  ORDER BY available_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

配套:`(status, available_at)` 认领索引、幂等键唯一约束、事件表 + `pg_notify` 门铃(事件表为真相,NOTIFY 只负责"叫醒")。

## 备选与否决理由

- **Redis(BullMQ)**:多一个组件与一份持久化语义(RDB/AOF);8G 内存下挤占 PG;队列状态与业务数据跨存储,失去"任务+事件同事务"的原子性。
- **Kafka**:单机作品集用 Kafka 属于简历噪音;运维成本与场景完全不匹配。
- **pg-boss / graphile-worker**:成熟的 PG 队列库,但核心 loop 手造是本项目的学习本体与差异化;先读它们的设计,面试能答"为什么不用 + 它哪里设计得好"。

## 后果

- 单组件运维:一份备份、一套监控;任务状态变更与事件写入天然同事务。
- 语义上限诚实声明:执行 at-least-once、任务终态 exactly-once;吞吐上限远低于专用 MQ(本场景 QPS 个位数,足够)。
- 风险:PG 单点 —— 靠每晚 pg_dump + 每月恢复演练兜底(总纲 §8)。
