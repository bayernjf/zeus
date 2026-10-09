# 设计稿：工具/Skill 发现与组合（tech map S11）

- 状态：**现行 v0.3（2026-10-09）**：设计稿 + **V1/V2 已落码**——V1（Active work 168）`src/orchestrator/discovery.ts` 纯函数 `selectCandidates`/`recoverChain`（选择次序：点名钉选 > 自动选靶饱和过滤 > tier-1 只读收窄 fail-closed > 能力面 execute/plan；恢复四步序：重试→换将→降级→升级，高利害跳过重试、熔断跳过自动路径）+ 审计 5 值 `tool-selected`/`tool-failed`/`chain-retried`/`chain-switched`/`chain-degraded` 登记 + TUI token；**V2（2026-10-09）已落码**：`fanOutNew` 选靶段无条件调 `selectCandidates` 构造统一候选面（喂实时 `inFlightByVassalNow`/`maxConcurrentPerVassal`，内部路径给 tier-0/只读/能力安全默认），新增 `onCandidatesSelected` hook 并在 boot 落 `tool-selected` 审计（该审计值首次真正 emit；`tool-failed`/`chain-*` 三值仍待 recoverChain 运行时接线）；V3（接工具链）待分期。
- 演进：v0.1（2026-10-09）设计探索先行（技能族/工具族合一候选面 + 选择次序 + 恢复四步序 + 接口草案）；v0.2（2026-10-09，Active work 168）V1 落码（`src/orchestrator/discovery.ts` + `tests/orchestrator-discovery.test.ts` 16 例 + 审计/TUI 接线，基线 1379/125 → 1410/126、冒烟 45/45、doc-consistency 18/18）；v0.3（2026-10-09）V2 落码（候选面接实况选靶 + hook + tool-selected 审计实发，新增 orchestrator-diversion 2 例 / boot-oversight-audit 1 例，冒烟 audit 窗口 limit 5→50，A 档三批合批收尾基线 1410/126 → 1430/128、冒烟 45/45、doc-consistency 18/18）。**事实更正**：`selectTargets`（diversion.ts）的实况接线于 2026-09-27 已完成，早期 v0.1/v0.2 稿中"未落码"表述滞后，本版更正。
- 关联：tech map S11（自动选工具、工具链拼装、工具失败恢复）；S3 DAG 编排（design-supervision §4）；S4 终止与收敛（design-supervision §7.1）；design-backpressure.md（分流候选集 selectTargets，**2026-09-27 已接线**）；design-external-trust.md（E9.4 V2 只读 tag）；design-context-engineering.md（S1 V2 技能声明输入装配）；`src/skills/registry.ts`（SkillRegistry / resolveTeam / activeProviders）；`src/realm/mcp.ts` 与 `src/http/server.ts`（MCP 工具白名单）。
- 本文是发现与组合策略的单一事实源；handoff 与 PRD 只索引，不复制全文。

## 1. 背景与现状

**已有能力盘点（2026-10-09）**：

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 技能注册与检索 | 多版本 / 废弃标记 / 按名域标签检索 / `registerFromCard`（A2A 卡） | `src/skills/registry.ts` |
| 组队解析 | `resolveTeam(requiredSkillIds)`——多 provider 时歧义处理（见 §3.2） | `src/skills/registry.ts:269` |
| 信任分级 | `activeProviders` 三态；E9.4 V2 tier-1 能力面收窄为只读技能白名单（fail-closed 403） | `src/skills/registry.ts:310`、`src/trust/tier.ts` |
| 背压分流 | `selectTargets` 分流候选集（per-vassal 饱和独立可配，显式点名旁路）——**2026-09-27 已接线落码** | design-backpressure §4 |
| MCP 工具 | 工具经握手发现；调用方只能**收窄**宿主白名单（`realmIds` 从 boot 连接列表装配，跨域拒） | `src/realm/mcp.ts`、`src/http/server.ts` |
| 终止守卫 | 意图级步数预算 256 + 连续失败熔断 8 | `src/orchestrator/termination.ts` |

**缺口**：发现与组合**没有单一入口**——技能与工具分属两族，选哪个执行 Agent、拼哪条工具链、失败后按什么次序恢复，散布在 registry / governor / backpressure / supervision 各处，无统一编排原语。`selectTargets`（"选谁"的分流）已于 2026-09-27 接线，但它只消费**显式/自动候选**、不构造统一候选面，也不登记选择审计；"拼什么工具链、失败怎么换"的 recoverChain 运行时接线仍无（V1 纯函数已落、未接运行时）。

## 2. 目标与边界

**目标**：定义一条确定性**发现→选择→组合→恢复**链：给定意图，从已注册技能（执行 Agent 族）与已连接工具（连接器族）中选出可派发集合，按序拼装工具链，失败时按固定次序恢复。与 S1 V2 的输入装配、S3 的 DAG 编排、S4 的守卫正交衔接。

**边界（明确不做）**：
- 不做自动规划（多步 planner / replan）：tech map S12 单列。
- 不改变既有语义：`resolveTeam`、`activeProviders`、MCP 白名单、`selectTargets` 语义照旧，本设计只把它们串成链并补缺。
- 不做工具调用本身（`connector` 源已接线、`callTool` 已落地）：本设计管"选与拼"，不管"调"。

## 3. 发现链设计

### 3.1 候选面（两族合一）

| 族 | 候选来源 | 约束 | 产出 |
| --- | --- | --- | --- |
| 技能族 | `SkillRegistry`（按意图识别出的 skillId → `providersFor(id)`） | tier-1 调用方只读白名单（E9.4 V2，fail-closed）；技能 inputs 声明参与装配（S1 V2） | 可派发执行 Agent 列表 |
| 工具族 | 已连接连接器经 MCP 握手发现的 tools | 只能收窄宿主白名单（`realmIds` 来自 boot 连接列表）；未声明工具不可读（connector 源先例） | 可调用工具列表 |

候选合并为统一的可派发原语视图（设计级类型：`DispatchCandidate = { provider, tool?, skillId, mode }`），供选择器消费。

### 3.2 选择规则（确定次序）

1. **显式点名优先**：`request.vassals` 或 `resolveTeam` 歧义时操作者点名 > 自动选靶（延续"歧义不静默选边"先例——`resolveTeam` 报歧义，不自动挑一个）。
2. **自动选靶**：复用 `selectTargets` 分流语义（per-vassal 饱和独立可配、全局闸门之上、显式点名旁路背压）。
3. **信任面**：tier-1 只读收窄先于一切选择（E9.4 V2 白名单判定，零出站 fail-closed）。
4. **能力面**：委托契约 capability（execute）覆盖才可执行模式派发；否则 plan-only。

### 3.3 工具链拼装

- 意图 → 技能序列：单技能直派或 DAG 编排（S3，拓扑分层/关键路径/上游失败跳过下游）。
- 每步的**工具面**：该步声明的连接器边界内的工具（未声明工具不可读，跨域拒绝）；工具参数参与 S1 V2 输入装配（显式补全 / unavailable 不臆造）。
- 工具链顺序由技能序列决定，不引入独立规划器。

### 3.4 失败恢复（固定次序）

复用 design-supervision §6.1 的既定次序，落到工具链语境：

`重试（幂等前提下）→ 换将（同技能其他 provider，受背压分流约束）→ 降级（缩减目标范围，如跳过非关键工具步）→ 升级（监督台，L1 异步介入，见 design-hil）`

- 高利害操作跳过重试直接升级（与 supervision 一致）。
- 熔断/预算兜底：任何恢复路径派生都计入 S4 步数预算；连续失败达阈值自动选靶路径拒绝派生（显式点名旁路）。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/orchestrator/discovery.ts（纯函数，零内核状态）
type DispatchCandidate = { provider: string; skillId: string; tool?: string; mode: 'execute' | 'plan' };
type ChainStep = { skillId: string; candidates: DispatchCandidate[]; required: boolean };
type ChainPlan = { steps: ChainStep[]; policy: 'sequential' | 'dag' };

function selectCandidates(
  skillId: string,
  ctx: { tier: number; named?: string[]; perVassalSaturation: Map<string, number> },
): DispatchCandidate[]; // 3.2 次序：点名 > 自动选靶 > 信任/能力面过滤

function recoverChain(step: ChainStep, failure: ChainFailure): 'retry' | 'switch' | 'degrade' | 'escalate';
// 固定次序，幂等/高利害/熔断条件在纯函数内判定
```

- 审计标注（设计级）：`tool-selected` / `tool-failed` / `chain-retried` / `chain-switched` / `chain-degraded` 入 `AUDIT_DECISIONS`（实施时定措辞），与既有 `branch-*` / `inbound-task-*` 同脊。
- 与 design-hil 的衔接：`recoverChain` 输出 `escalate` 即挂 L1 升级队列（不阻塞其他意图）。

## 5. 分期

- **V1（选择器纯函数）**：`selectCandidates` + `recoverChain` + 测试（点名优先 / tier-1 收窄 / 背压饱和 / 恢复次序正反例）+ 审计标注；不接真进程。**✅ 已落地（2026-10-09，Active work 168）**。
- **V2（候选面接实况选靶）**：`fanOutNew` 无条件调 `selectCandidates` 构造统一候选面并消费 `selectTargets` 的实时饱和数据（inFlight/cap），选择结果经 `onCandidatesSelected` hook 落 `tool-selected` 审计。**✅ 已落地（2026-10-09）**。注：`selectTargets` 本体 2026-09-27 已接线，V2 补的是候选面构造与选择审计实发。
- **V3（接工具链 / recoverChain 运行时）**：ChainPlan 与 DAG（S3）拼接，工具面装配进 S1 V2 输入装配；`recoverChain` 接失败分支运行时（届时 `tool-failed`/`chain-retried`/`chain-switched`/`chain-degraded` 四审计值由登记转实发）。

**验收（V1 实施时）**：每条规则至少一正一反例；`resolveTeam` 歧义不静默选边、tier-1 零出站、熔断兜底三件不回归；全量与冒烟不回归（V1 纯函数 + 测试，无运行时行为变化）。
