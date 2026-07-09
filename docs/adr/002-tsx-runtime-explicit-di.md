# ADR-002:tsx 直跑 TS 源码 + NestJS 显式注入 token(不依赖装饰器元数据)

- **状态**:已采纳(M2 若 DI 图显著变大则复审)
- **日期**:2026-07-09(M0 步骤 5 实施中定案)

## 背景

Monorepo 内部包采用「源码直出」:`exports` 直指 `src/index.ts`,消费方就地转译,没有构建编排。api/worker 用 NestJS,而 Nest 的按类型构造注入依赖 `emitDecoratorMetadata`(`design:paramtypes`)——**esbuild 系工具(tsx)不支持生成装饰器元数据**,这是 tsc/SWC 独有能力。四条路线冲突求解:

1. `nest build`(tsc)→ 元数据可用,但 tsc 不会编译 node_modules 里链接的 TS 源码包 → 内部包必须预构建(tsup/dual format)→ 引入构建编排、d.cts/d.mts 类型矩阵、dev 双 watch 链;
2. SWC builder → 同样不跟进 workspace TS 源依赖;
3. 全部预构建 + CJS 化 → 与 `verbatimModuleSyntax`/ESM 源码风格冲突,配置面爆炸;
4. tsx 直跑 + 放弃元数据 → 注入点全部显式 `@Inject(token)`。

## 决策

选路线 4:开发与生产统一用 **tsx 运行 TS 源码**;Nest 一切构造注入显式写 `@Inject(TOKEN)`(token 用 `Symbol` 或类本身);不启用 `emitDecoratorMetadata`,也不用 class-validator/class-transformer(校验已由 Zod 承担,本就是总纲 §4 决策)。tsconfig 仅开 `experimentalDecorators`(esbuild 0.21+ 完整支持含参数装饰器的 legacy 装饰器语法,Biome 需开 `unsafeParameterDecoratorsEnabled`)。

## 后果

- **收益**:零构建编排——包源码直出、apps 直跑,`turbo dev` 三进程即全栈;生产容器同一心智(`CMD ["tsx","src/main.ts"]`);改 contracts 不触发级联 rebuild。
- **代价**:每个构造参数多写一个 `@Inject(...)`;失去"按类型自动解析"的 Nest 魔法。M0–M2 DI 图很小(每 app 3–5 个 provider),代价可忽略;若后期模块膨胀到显式 token 成为负担,再评估 SWC + 预构建切换,届时本 ADR 升级。
- **教学价值**:被迫理解 Nest DI 的真实机制(decorator metadata 只是把类型名写进 Reflect 元数据,显式 token 是它的去魔法形态)。
