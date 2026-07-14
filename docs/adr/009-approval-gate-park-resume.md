# ADR-009:审批门 + park/resume(人在环路,精确恢复)

- **状态**:已采纳(M5;补齐 M1 park 语义、闭合 ADR-008 "最后一米")
- **日期**:2026-07-14

## 背景

ADR-008 做了注入防御,但明说"基于内容触发的写动作真正拦住要靠审批门"是最后一米。同时总纲差异化 #2(park 后精确恢复)、JD 高频词(人在环路/审批)都指向同一机制。M1 的 `waiting_approval` 状态与 checkpoint 字段早已预留,本 ADR 把 park/resume 接线。

## 决策

**park/resume 建在耐久队列层**(复用 M1 的租约守卫 + 检查点):
- `parkForApproval`:running(本 worker 持有)→ `waiting_approval`,存检查点、释放租约。park 后任务**不在队列、无租约、非终态**——纯数据库态,扛 worker 重启(park 语义)。reaper 只碰 running,不会回收它。守卫:仅当前持有者可 park。
- `resolveApproval`:approve → 回 `queued`(availableAt=now),把 `decision: approved` 写进检查点,让 worker 重新认领并从检查点续跑;reject → 终态 failed。守卫:仅 waiting_approval 可决议(防重复/竞态)。
- worker 侧 `ParkedError` 让位信号:handler park 后抛出,execute() 捕获即返回,不写终态。
- 演示 agent(`approval`):草拟(写检查点)→ park 等审批 → 审批通过后精确恢复,直接执行写动作,**草拟不重做**。
- API 审批台:`GET /api/approvals`(待处理)+ `POST /api/approvals/:id`(批准/拒绝);UI 在工作台显示审批面板(批准/拒绝按钮),批准后新事件经既有 SSE 流入。

## 后果

- 端到端验证(真实 HTTP + 队列 + worker):提交 → `waiting_approval`(进审批台)→ 批准 → 事件序列 `草拟 → approval.requested → approval.approved → 重认领 → approval.resumed → succeeded`,`草拟` 恰好一次(精确恢复)。测试:park→approve→精确恢复、reject→failed、park 扛重启,3 个集成用例(testcontainers)。
- 闭合了注入防御的"最后一米":高风险/写动作可 park 等人工放行(演示 agent 先示范机制,后续把 ToolRegistry 的 high 风险工具接到这条门上)。
- 补齐差异化 #2 与 JD 词"人在环路"。
- **诚实边界**:① 目前是**演示 agent** 手动 park;把 ToolRegistry 风险等级自动接到审批门(high 风险工具执行前必 park)是下一步接线;② 无认证,谁都能审批,接登录 + RBAC 后限批准人;③ waiting_child/waiting_input 两种 park 态(fan-out 子任务、追问)尚未接线,机制同构可复用。
