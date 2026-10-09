# 设计稿：Agent 测试策略——契约测试、录制重放、mock 与混沌注入（tech map S17）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文把现有手写夹具沉淀为标准录制/重放格式，并把故障注入做成确定性纯函数包装器。
- 演进：v0.1（2026-10-09）首版——现状盘点（注入缝与脚本化夹具已广泛存在、缺录制重放标准格式与混沌注入器）+ 测试金字塔 + Recording 格式与 `withChaos` 纯函数草案 + 分期。
- 关联：tech map S17（契约测试、录制重放、mock LLM、混沌测试；契约测试已有实践）；design-vassal-protocol.md / design-http-transport.md（A2A 契约是兼容性测试对象）；design-evals.md（S7，录制重放为 eval 供给世界夹具）；design-long-running.md（S13，崩溃/断连恢复测试需要混沌注入）；design-backpressure.md（慢响应/饱和场景）；design-observability.md（S6，录制帧可同时生成 trace 期望）；`src/dispatch/client.ts`（SSE 消费，故障注入主战场）、`src/mcp/stdio-client.ts`（spawnImpl 注入缝先例）、`scripts/smoke-core.mjs`、`scripts/acceptance-*.mjs`、`tests/boot-oversight-audit.test.ts`（vassalFetch 脚本化夹具先例）。
- 本文是 Agent 测试策略的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 设施 | 现状 | 形状 |
| --- | --- | --- |
| 端口注入缝 | DispatchPort（dispatch/cancel）可替换；stdio client 有 spawnImpl 注入缝；boot 接受 fetchImpl | 测试用 makeDispatcher / mock fetch 直接驱动内核 |
| 脚本化 Agent | 测试内手写 vassalFetch：脚本化 agent-card + SSE 帧序列（working→final）、可控制挂起 gate（deferred） | 每个测试文件各写一份，**无统一格式、不可跨文件复用** |
| 真实进程冒烟 | smoke-core 45 步：编译产物 + 临时目录 + 脚本 Agent，验证真实装配 | 黄金路径，故障场景覆盖靠各单测 |
| 协议契约测试 | a2a-parts、http-delegation-contracts、acceptance-standard-a2a / loom-interop | 校验协议形状与互操作 |
| 决策重放 | decision-replay 可回放单次决策输入输出 | 面向追溯，不是通用录制重放 |
| 故障场景 | 散见于 backpressure/diversion/watch 测试（gate 挂起、失败分支） | 手写、覆盖不系统 |

**缺口**：

1. **无录制→重放标准格式**。脚本化 Agent 是手写的，无法把一次真机/冒烟中与 Agent 的真实往来（agent-card、请求、SSE 帧、时序）录下来、脱敏、沉淀成可重放夹具；真机暴露的 bug 无法低成本变成回归用例。
2. **无标准化 mock LLM**。DecisionBackend 有模型无关抽象，但测试侧没有统一的"脚本化决策后端"（固定 Choice/Score、延迟、错误、价格），各测各的。
3. **混沌注入不成体系**。延迟、连接重置、半开 SSE（连上不发帧/发到一半断）、重复帧、畸形 JSON、乱序帧、慢响应触发饱和/背压——这些多 Agent 系统最容易出问题的场景，没有统一的确定性注入器；S13 崩溃恢复、S6 调用链、S15 流式都依赖这类故障夹具。
4. **契约演进无兼容门禁**。A2A/fealty/协议字段改动后，"旧 Agent 的响应新版内核还能不能读、旧内核对新 Agent 会不会误拒"没有成集的兼容性用例（字段可选化、未知字段忽略、版本协商）。

## 2. 目标与边界

**目标**：建立三层测试供给——

1. **Recording 标准格式**：一次 Agent 往来的确定性录制（卡片、请求/响应、SSE 帧、时序标记），可脱敏后提交为夹具，可一键转成脚本化 DispatchPort/fetch，供单测、smoke、S7 eval 共用。
2. **确定性混沌注入器**：纯函数式端口包装器，按脚本对任意 DispatchPort 注入延迟/错误/断流/重复/畸形/乱序，断言内核在故障下的行为（恢复、超时、升级、熔断、审计）。
3. **契约兼容矩阵**：协议契约的版本化用例集，字段增删/未知字段/版本协商的正反例。

**边界（明确不做）**：

- 录制默认不包含敏感正文：录制器只在显式开启的自托管环境运行，落盘前过 S8 护栏的凭据/PII 打码；不做云端录制收集（数据主权）。
- 不追求录制的**时间精确回放**（不做"按真实墙钟间隔逐毫秒重放"作为默认）：时序用脚本化标记（before/after/await-gate）表达确定性顺序，真实延迟分布回放是可选增强。
- 不模拟 Agent 的智能：mock 只回放/生成**协议层**内容，不内嵌 LLM 替身去"假装会思考"；决策质量归 S7 eval 与真实后端。
- 不替代真机验收：acceptance-real-fanout 等真机 harness 仍是上线前关口，录制重放覆盖回归与边界，不宣称等价真机。

## 3. 测试金字塔（本设计落点）

| 层 | 工具/格式 | 覆盖 |
| --- | --- | --- |
| 纯函数单测（已有，主体） | vitest + 直接调纯函数 | 判定链、聚合、评分、预算、分类器——全部设计稿 V1 产物的主测试层 |
| 装配/契约测试（已有+增强） | 注入 DispatchPort/fetchImpl + **Recording 重放** + **混沌注入** | 内核与 Agent 边界：正常协议、故障协议、兼容矩阵 |
| 真实进程冒烟（已有） | smoke-core 编译产物 + 临时目录 | 装配正确性（证明"真的接上了"） |
| 真机验收（已有，手动关口） | acceptance-* + 真机 Agent | 上线前互操作；真机录制回流为 Recording |
| 质量回归（S7） | eval runner 消费 Recording/混沌世界 | 决策质量漂移、双侧错误率 |

## 4. 落地接口草案（设计级，未落码）

```ts
// src/testing/recording.ts（纯函数 + 类型；零网络依赖）
export type RecordedFrame =
  | { dir: 'in' | 'out'; kind: 'agent-card'; at: string; body: unknown }
  | { dir: 'out'; kind: 'request'; at: string; runId: string; body: unknown }
  | { dir: 'in'; kind: 'sse'; at: string; runId: string; data: unknown }
  | { dir: 'in'; kind: 'error'; at: string; runId?: string; error: string };
export type Recording = {
  version: 1;
  agent: { name: string; card: unknown };
  frames: RecordedFrame[];
  redacted: boolean;
};
// 录制 → 脚本化 fetch（与 boot fetchImpl 同形状）；时序由 gate 标记控制，不按墙钟
export function recordingToFetch(rec: Recording, gates?: RecordingGates): typeof fetch;
// 脱敏：复用 S8 信号，落盘前去凭据/PII（纯函数）
export function redactRecording(rec: Recording): Recording;

// src/testing/chaos.ts（纯函数包装器：包一个正常 port，按脚本制造故障）
export type ChaosScript =
  | { effect: 'delay'; ms: number; match?: (req: unknown) => boolean }
  | { effect: 'fail'; error: string; times?: number }
  | { effect: 'drop-connection'; afterFrames?: number }   // 半开流：发 N 帧后断
  | { effect: 'never-respond' }                           // 挂死（超时路径）
  | { effect: 'duplicate-frame'; frameIndex: number }
  | { effect: 'malformed-frame'; frameIndex: number; body: string }
  | { effect: 'reorder'; first: number; second: number };
export function withChaos(inner: DispatchPort, script: ChaosScript[]): DispatchPort;
```

- mock 决策后端（V2）：实现 DecisionBackend 接口的脚本后端（固定返回、可配延迟/错误/cost），与 decision-model/llm 同端口，供 S9 成本、S4 熔断、S7 eval 使用。
- 契约兼容矩阵（V2）：以协议类型为基线生成/手工维护"最小合法卡片""缺可选字段""含未知扩展字段""旧版本号""fealty 缺省"等用例，断言内核的接受/拒绝策略与 design-vassal-protocol 的版本规则一致。
- 录制器（V3，仓库内脚本）：在自托管测试模式下挂 fetchImpl/DispatchPort 旁路录制，产出 Recording JSON，经 redactRecording 后入 `tests/fixtures/recordings/`。

## 5. 分期

- **V1（混沌注入器 + Recording 类型/转换纯函数）**：chaos.ts（七类脚本各有确定性测试：包装后正常 port 行为可断言、故障可复现、脚本可组合）+ recording.ts 类型/redact/recordingToFetch（用现有手写 vassalFetch 场景反向验证转换等价）；不改 src 运行时代码。
- **V2（迁移与标准化）**：把 boot-oversight-audit、diversion、watch 等手写夹具迁到 Recording/withChaos；补脚本化 DecisionBackend；建协议兼容矩阵首版（agent-card/fealty/A2A task 三组）。
- **V3（录制器 + 回流）**：自托管测试模式录制脚本 + 脱敏落盘；真机验收发现的问题录成回归夹具；Recording 作为 S7 eval 世界的标准输入。
- **V4（可选）**：时序分布回放、混沌场景库（按 S13/S6/S15 测试需求沉淀成套故障剧本）。

**验收（V1 实施时）**：每类 chaos 效果有正反例且可重复（同脚本同结果）；redactRecording 对凭据/PII 样例必打码；recordingToFetch 产出的 fetch 能驱动既有 boot 扇出测试通过；全量与冒烟不回归（V1 只新增测试设施，零运行时行为变化）。
