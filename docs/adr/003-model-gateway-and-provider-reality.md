# ADR-003:模型网关自建 + 供应商现实(本地检验 + GPT 中转)

- **状态**:已采纳(M2;供应商组合随 key 到位演进)
- **日期**:2026-07-10

## 背景

总纲 §4 定:AI SDK 只做模型 I/O,重试/熔断/failover/成本核算自建;分层路由(cheap decide、strong 综合、verify 用不同型号)。M2 落地时的供应商现实(用户 2026-07-10 决策):部署与国产主力 key 暂缓,开发走「本地检验 + GPT 中转」。可用的只有用户自购的 packyapi 中转(gpt-5.5 / 5.4 / 5.4-mini)。

## 决策

1. **网关自建**(`packages/core/model/gateway.ts`):每供应商重试(线性退避)→ 连续失败达阈值熔断(冷却后半开)→ failover 到下一供应商;每次调用(含失败)落 `model_calls`(token/成本/延迟/状态);每日成本达硬顶抛 `BudgetExceededError`(总纲 §8 钱包护栏)。AI SDK 仅在适配器层被调用,网关逻辑用 stub adapter 纯逻辑测试,免费可 CI。
2. **结构化输出不依赖供应商能力**:提示词注入 JSON Schema + 防御性提取(剥围栏、截首尾括号)+ 一次修复重试。中转/国产模型通吃,不绑 OpenAI structured outputs。
3. **端点用 chat completions,不用 responses**:实测 packyapi 的 `/v1/responses` 是逆向 Codex 的伪实现(注入 Codex 系统提示词、结构非标准,AI SDK 解析失败);同 key 的 `/v1/chat/completions` 完全正常。适配器默认 `api:"chat"`,`responses` 仅留给真正实现该 API 的供应商。
4. **分层供应商从环境组装**(`model/env.ts`):当前三层都指向中转的不同型号(cheap=5.4-mini、strong=5.5、verify=5.4);`DEEPSEEK_API_KEY` 一旦配置自动插到各层最前成为主力,无需改代码。

## 后果

- 端到端已验证:研究 agent 真实跑通 plan→decide→act→observe→synthesize→verify,4 次模型调用全部记账,成本 ¥0.04 可查。
- **诚实边界**:① 中转是逆向转售,无 SLA、随时可能失效、请求过第三方——故不放敏感内容、路线图不依赖它、熔断阈值设敏感;② "验证器 ≠ 综合供应商"当前用不同型号近似,真正的跨供应商多样性等国产 key;③ 价目表是粗估(中转计费不透明),用于护栏与可视,不作账单依据。
- key 到位后切换成本≈0:改 `.env` 即可,网关/agent 代码不动。
