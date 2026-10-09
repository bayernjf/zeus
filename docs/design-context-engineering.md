# 上下文工程（Context Engineering）设计（tech map S1）

## 0. 一句话

给并发决策内核的每个分支（执行 Agent 调用）确定**装配什么上下文**：从调用方显式载荷、技能声明的输入要求、realm 只读内容与记忆检索结果中按优先级装配，受共享裁剪与预算分配约束；长任务提供压缩换入换出的接口设计。与记忆系统（design-memory-consolidation.md）一体两面——记忆是上下文的持久来源之一，上下文是记忆的消费面。

## 1. 缺口与现状

**分支当前拿到什么（现状盘点，2026-10-08）**：

| 输入源 | 现状 | 装配点 |
| --- | --- | --- |
| 调用方显式载荷 | `FanOutRequest.params.message` / `a2aTaskId` / `a2aMetadata` / `a2aCaller`，原样透传 | `orchestrator.fanOutNew` → 分支 task 载荷 |
| realm 只读内容 | `realmHits` 由调用方/内核检索产出，**是否进入出站载荷由 `dataPolicy` 四档判**（E4.5，`none` 档不入载荷） | `dispatcher` 出站边界 |
| 技能声明的输入要求 | `SkillSpec.inputs` 存在但**从不参与装配**——声明的输入形状未用于校验或补全上下文 | 无（缺失） |
| 记忆检索 | 记忆系统有混合检索（BM25+向量、`realmHits` 路径），**但检索结果不装配进分支上下文**——执行 Agent 看不到既往 claim/事实 | 无（缺失） |
| 上下文预算 | 无——分支拿多少上下文无上限、无优先级、无截断 | 无（缺失） |
| 长任务压缩 | 无——长任务不换出、不压缩、上下文不收敛 | 无（缺失） |

**断点**：a2a 元数据透传是唯一的"显式上下文"通道；技能 `inputs` 声明是死字段；记忆只沉淀、不被消费；分支上下文无边界。后果：执行 Agent 的输入要么太少（无记忆、无 realm 只读、无技能输入补全），要么在 `dataPolicy` 非 `none` 档时无界（realmHits 全量进入载荷，S4 预算只防分支数、不防单分支上下文大小）。

**既有原语可复用**：`dataPolicy` 四档（出站内容边界，唯一出口闸）、`SkillRegistry`（技能声明查询）、记忆混合检索与 realm 边界（读路径已有域隔离）、S4 终止守卫（意图级分支数预算，与本设计的上下文预算正交）。

## 2. 设计目标与边界

目标：

- 分支上下文**可判定、有边界、可审计**：每个分支的上下文来源、裁剪与预算消耗可解释。
- 装配**不新增数据面旁路**：任何 realm 内容进入出站载荷仍只经 `dataPolicy` 闸；本设计只决定"装配什么"，不改变"放行什么"。

显式不做（避免下次重新讨论）：

- 不做执行 Agent 侧上下文缓存/私有上下文存储（执行 Agent 是无状态方，上下文随任务一次性交付）。
- 不做 token 计费与费用模型（那是部署/计费面，deferred #4 范围）。
- 不做跨 Agent 共享的"世界状态"（星型拓扑，一切经 Zeus 编排；上下文按分支独立装配）。
- 不改变 `dataPolicy` 语义（出站内容边界是既成契约，本设计在其上方装配）。

## 3. 上下文装配模型

每个分支的上下文 = 按优先级合并的四个源：

1. **调用方显式载荷**（最高优先级）：`params.message` 与 `a2aMetadata` 原样保留——调用方显式交付的内容不得被裁剪（否则破坏调用契约）。
2. **技能声明输入补全**：`SkillSpec.inputs` 声明缺失字段时，从以下源补全；无法补全的字段显式标 `unavailable`（不臆造值）。此步让 `inputs` 字段从"死声明"变为装配约束。
3. **realm 只读内容**（受 `dataPolicy` 闸）：`realmHits` 按现行四档判——`none` 档完全不装配；其他档装配并按档位裁剪（见 §4）。
4. **记忆检索结果**（受 realm 边界与预算约束）：按技能域/意图相关性从记忆系统检索 claim/事实，装配为只读附录。记忆装配**只读**——分支产生的立场回写仍走现行 memory producer（intent-finished → claim），不经本路径。

装配点：`orchestrator.fanOutNew` 分支构造处（与 S4 预算闸同层），装配结果作为只读字段进入分支 task 载荷；审计记录装配清单（源类型、条目数、裁剪/预算事件）。

**数据二极管约束**：源 3/4 的 realm 归属必须与分支目标 realm 一致；跨域内容在装配前丢弃并审计（复用 realm 边界判定，design-realm §6.5）。

## 4. 共享上下文裁剪

裁剪发生在装配时，规则按优先级：

- **去重**：同一 claim/事实只装配一次（按 claim 锚），多源重复取最新。
- **相关度闸**：记忆检索结果按相关度排序，低于阈值的条目不入上下文（阈值默认配置，真实负载后按 deferred #9 口径校准）。
- **敏感面**：凭证、令牌、密钥形态的内容一律不装配（复用脱敏原语，dispatch 侧既有 redact）。

裁剪事件全部记审计（`context-trimmed` 类 decision，含条数与原因），保证"分支拿到了什么"可回放。

## 5. 上下文预算分配

- **单位**：条目/字节混合计量（先以条目数为准，字节数作为观测指标不设硬上限——数值待真实负载后定，同 #9 口径，不凭空拍）。
- **预算面**：per-branch 上限 `maxContextEntriesPerBranch`（默认值结构守卫，校准挂 #9）。
- **优先级分配**：调用方显式载荷 > 技能声明补全 > realm 只读 > 记忆检索。预算耗尽时从低优先级开始截断；截断记审计（`context-budget-exceeded` 类），不得静默。
- **与 S4 的关系**：S4 预算防"分支数"失控，本预算防"单分支上下文大小"失控——两个正交面，S4 的 `IntentBudget` 已落，本面独立实现。

## 6. 长任务压缩换入换出（接口设计，V3）

长任务（超预算预算面或超时风险的分支）提供**上下文交换**接口，不在本次落码范围：

- **换出**：分支挂起时，把当前上下文快照压缩为摘要（经既有记忆 consolidation 路径沉淀），释放执行 Agent 侧上下文；摘要随快照持久化。
- **换入**：resume 分支时，用摘要 + 新记忆检索重建上下文（与 S4 的 resume 预算闸配合）。
- **判定**：何时换出由预算消耗与墙钟共同决定——阈值属性能标定，挂 #9 真实负载。

**依赖**：换出依赖既有 vault/快照持久化；换入依赖记忆检索（V1 装配后即具备）。V3 不做不代表接口不预留——本设计给出契约形状，实施随触发条件。

## 7. 分期

| 期 | 内容 | 触发 |
| --- | --- | --- |
| **V1** | 记忆检索装配进分支上下文（源 4）+ 审计（装配清单、裁剪事件）——记忆从"只沉淀"到"被消费" | ✅ **已落地**（2026-10-09，Active work 165，见 §10） |
| **V2** | 技能 `inputs` 声明参与装配与校验（源 2）+ 共享裁剪规则（§4）落地 | ✅ **已落地**（2026-10-09，Active work 166，见 §11） |
| **V3** | 上下文预算分配（§5）+ 长任务换入换出接口（§6） | **§5 已落地（2026-10-09 A1 批，见演进日志 v0.5）**；§6 换入换出仍挂 #9 真实长任务负载基准，不凭空拍阈值 |
| **边界** | 不改变 `dataPolicy`、不新增数据面旁路、不做执行 Agent 侧缓存 | 全程约束 |

## 8. 关联

- 记忆系统：[design-memory-consolidation.md](design-memory-consolidation.md)（来源与消费一体两面）。
- 数据面：[design-realm.md](design-realm.md) §3.1/§6.5（dataPolicy 与 realm 边界）。
- 终止守卫：[design-supervision.md](design-supervision.md) §7.1（S4，分支数预算，与上下文预算正交）。
- 执行 Agent 协议：[design-vassal-protocol.md](design-vassal-protocol.md)（分支载荷形状）。

## 9. 演进日志

- v0.1（2026-10-08）：设计稿入库（tech map S1 登记为"设计稿已出"，实现待分期触发）。
- v0.2（2026-10-09）：补 V1 实现规格（§10）——记忆装配进分支上下文的可执行工程契约（装配器纯函数签名、装配点与数据流、预算默认值、审计事件表、幂等注记、不变量、测试与验收清单）；deferred #4/#8 触发条件按 #41 隔离实例裁定同步重审（见 deferred-items.md）。
- v0.3（2026-10-09）：**§10 已落码（Active work 165）**——`src/context/assemble.ts` 实现（factId 去重取高分 / 凭证形态敏感面剔除 / 降序截断，事件三值 `context-assembled|context-trimmed|context-budget-exceeded`）+ `DispatchRequest.contextAppendix` 出站并入 + `AUDIT_DECISIONS` +3 + TUI token + boot 接线（memoryStore/contextOptions/onContextAssembled 审计桥）；基线 1352/122 → 1368/124（新测试 16 例、文件 +2）、冒烟 42 → 43；tech map S1 升"V1 已落地"。
- v0.4（2026-10-09）：**§11 V2 已落码（Active work 166）**——`src/context/skill-inputs.ts` 装配器（技能 `inputs` 从死声明变装配约束：显式载荷补全 / 缺失标 `unavailable` 不臆造）+ 共享裁剪完整规则（去重改取最新 updatedAt、新增相关度闸 `minScore` 默认关闭、敏感面保留）+ `DispatchRequest.skillInputs` 出站并入 + boot `skillInputsProvider` 窄端口接线 + 审计 reason 扩 `unavailable|relevance`、`source` 分流措辞；基线 1368/124 → 1379/125（新测试 11 例、文件 +1）、冒烟 43 → 45；tech map S1 行更新、feature-inventory v0.44、review v0.36。
- v0.5（2026-10-09）：**§5 V3 per-branch 预算分配已落码（A1 批）**——新建 `src/context/budget.ts` 纯函数 `allocateContextBudget`（`DEFAULT_BRANCH_CONTEXT_LIMIT=64`；四源优先级：显式载荷永不计数 > skillInputs > realmHits > contextAppendix；预算耗尽从最低优先级源截前缀，每源截断发带 `source` 的 `context-budget-exceeded` 事件）；orchestrator `fanOutNew` 四源装配后统一过预算、**只截出站副本**（内核内记忆/Realm 全量保留），`runTrackedBranch`/`runBranch` 加 `budgetedRealmHits?` 尾参，boot 加 `KernelBootOptions.contextOptions?`；新测试 `tests/context-budget.test.ts` 7 例 + `tests/boot-context-assembly.test.ts` 3 例（文件 +1、测试 +10）。**§6 长任务换入换出明示不落码**——换入换出阈值依赖真实长任务负载，挂 deferred #9 压测基准，不凭空拍数。A 档三批（A1/A2/A3）合批收尾基线 1410/126 → **1430/128**、冒烟 45/45、doc-consistency 18/18。

## 10. V1 实现规格：记忆装配进分支上下文（2026-10-09，**V1 已落地，Active work 165，2026-10-09**）

### 10.1 目标与范围

- V1 只做**源 4（记忆检索）装配**：每个分支拿到按技能/意图相关性检索的既往 claim/事实，作为只读附录进入出站载荷，并全程审计。记忆从"只沉淀"到"被消费"。
- 范围外（留 V2/V3，§7）：技能 `inputs` 声明参与装配与校验（源 2）、共享裁剪完整规则（§4 去重/相关度闸/敏感面的完整形态）、上下文预算分配面（§5）、长任务换入换出（§6）。
- 不改变 `dataPolicy` 语义、不新增数据面旁路、不做执行 Agent 侧缓存——与 §2 全程约束一致。

### 10.2 装配契约（新模块 `src/context/`，纯函数）

```ts
// src/context/assemble.ts —— 零内核状态依赖，全部入参注入
export type ContextAppendixEntry = {
  claimId: string;   // 记忆 claim 锚，去重键
  text: string;      // 呈现文本（factText 输出）
  source: 'memory-recall';
  realmId: string;   // 来源域，装配时已核
  score: number;     // 检索相关度（searchRecall 原值）
};

export type ContextAssemblyEvent =
  | { kind: 'context-assembled'; appendixEntries: number; realmId?: string }
  | { kind: 'context-trimmed'; trimmed: number; reason: 'duplicate' | 'sensitive' }
  | { kind: 'context-budget-exceeded'; kept: number; limit: number };

export function assembleBranchContext(args: {
  memoryHits: RecallHit[];      // 调用方已按目标域检索（域隔离由 searchRecall 签名强制）
  maxEntries: number;           // 附录条目上限（结构守卫；默认 20，校准挂 #9 口径）
}): { appendix: ContextAppendixEntry[]; events: ContextAssemblyEvent[] };
```

装配规则（V1 范围）：

- **按相关度降序截断**：`searchRecall` 已按相关度排序，装配器再验降序并取前 `maxEntries`。
- **去重**：同 `claimId` 只保留一条（score 高者胜出），去重事件记 `context-trimmed (duplicate)`。
- **敏感面**：凭证/令牌/密钥形态文本剔除（复用 dispatch 侧脱敏的形状判据），记 `context-trimmed (sensitive)`。
- **调用方显式载荷不在此函数内**：V1 只装附录；显式载荷原样透传是不变量，在 fan-out 既有测试钉住。

### 10.3 装配点与数据流

- **装配点**：`orchestrator.fanOutNew` 分支构造处（与 S4 预算闸同层，设计稿 §3）。
- **OrchestratorOptions 增可选字段**：
  - `memoryStore?: MemoryStore`（窄端口：只依赖 `searchRecall(readerRealmId, targetRealmId, query, options)` 签名）；
  - `contextOptions?: { maxEntries?: number }`（默认 20，结构守卫非性能标定）。
- **数据流**：fanOutNew 每分支装配前先 `memoryStore.searchRecall(request.realmId, request.realmId, query, { limit: maxEntries })`——query 用技能名 + `params.message` 拼接词法检索；域隔离由 `searchRecall` 的 `readerRealmId !== targetRealmId` 拒绝强制（设计稿 §3 数据二极管，装配器不重复实现，只消费传入 hits）。
- **载荷落点**：装配结果作为只读字段 `contextAppendix` 并入分支 `DispatchRequest`（与 `realmHits`/`realmHitsOrigin` 同层）；`FanOutRequest` 不加该字段（调用方不提供，由内核装配）。出站序列化随现有通道，不需要新传输。
- **boot 接线**：boot 已装配 memoryStore 时透传给 Orchestrator；未装配 → `contextOptions` 视为关闭，**零装配、零审计、派发照常**（与 skillGovernor 可选依赖同款优雅降级）。

### 10.4 幂等与重放

- 装配是**派发时瞬时行为**；幂等命中/重放返回已存结果，不重装配（与 `realmHits` 同款注记："replay may omit them"）。
- 审计事件写入 `AUDIT_DECISIONS` 单一来源（新 decision 值 `context-assembled` / `context-trimmed` / `context-budget-exceeded`）+ TUI 语义 token，"分支拿到了什么"可回放。

### 10.5 不变量（测试钉死）

1. 调用方显式载荷永不被裁剪（fan-out 既有测试回归）。
2. 附录只读：装配器不写回记忆；分支立场回写仍走 memory producer（intent-finished → claim）。
3. 域隔离：`searchRecall` reader≠target 拒绝（既有断言）+ 装配器不二次越域。
4. 预算截断记审计不静默（`context-budget-exceeded` 必现）。
5. 缺 memoryStore 优雅降级：零装配、零审计事件、派发照常。

### 10.6 测试与验收

- **单元**：`tests/context-assemble.test.ts`（纯函数，约 8–10 例：降序截断 / 去重取高分 / 敏感过滤 / 预算事件 / 空 hits / 超限边界）。
- **装配**：`tests/boot-context-assembly.test.ts`（真内核：boot 装配 memoryStore → fanOutNew 真派发 → 出站载荷带 `contextAppendix` 且 claimId 落请求域；缺 memoryStore → 无附录照常派发；多分支各装配）。
- **门禁**：全量 + 真进程冒烟 +1 步（一条意图带附录出站）。
- **文档同步**：PRD E 行状态、feature-inventory v0.43、tech map S1 行升"V1 已落地"（实现后本条改为验收记录：全量 1368 绿 / 124 文件、冒烟 43/43、doc-consistency 18/18）。

### 10.7 分期边界重申

V1 不做：技能 `inputs` 装配与校验（V2）、共享裁剪完整规则（V2）、预算分配面与换入换出（V3，阈值校准挂 #9 同口径）。V1 是**装配的最小闭环**：记忆可进分支、可审计、可回放，不引入任何新的数据面旁路。

## 11. V2 实现规格：技能 inputs 装配与共享裁剪完整规则（2026-10-09，**V2 已落地，Active work 166**）

### 11.1 目标与范围

- V2 做**源 2（技能声明输入补全）**装配 + **共享裁剪完整规则（§4）**落地：
  - 技能 `SkillSpec.inputs` 从"死声明"变为装配约束——声明的输入字段要么由调用方显式载荷补全（最高优先级源，永不被裁剪），要么显式标 `unavailable`（不臆造值）。
  - 裁剪规则升级为 §4 完整形态：去重按 **updatedAt 取最新**（多源重复取最新，替代 V1 的取高分）、新增**相关度闸**（低于阈值不入上下文）、保留敏感面。
- 范围外（留 V3，§7）：上下文预算分配面（§5，per-branch `maxContextEntriesPerBranch` 数值挂 #9）、长任务换入换出（§6）。
- 不改变 `dataPolicy` 语义、不新增数据面旁路、不做执行 Agent 侧缓存——与 §2 全程约束一致。

### 11.2 装配契约（新模块 `src/context/skill-inputs.ts`，纯函数）

```ts
// src/context/skill-inputs.ts —— 零内核状态依赖，全部入参注入
export type SkillInputEntry =
  | { name: string; source: 'explicit'; value: unknown }   // 显式载荷补全
  | { name: string; source: 'unavailable' };               // 无源可补，显式缺席

export function assembleSkillInputs(args: {
  declared: Record<string, unknown>;   // SkillSpec.inputs（键即字段名）
  params: Record<string, unknown>;     // 调用方显式载荷
}): { inputs: SkillInputEntry[]; unavailable: number; events: ContextAssemblyEvent[] };
```

装配规则：

- **存在性判定**：字段在 `params` 中且值非 `undefined` → `explicit`（原样保留，含 `null`——显式交付的内容不重判）；缺失或 `undefined` → `unavailable`（不臆造值）。
- **类型校验不在 V2 范围**：`inputs` 是自由形态 schema 描述符（v0.1 无字段级类型语法），造一个类型系统等于发明机制；存在性是目前唯一的契约。
- **未声明键不动**：装配器只约束技能声明的字段，未声明的显式载荷原样透传（fan-out 既有不变量）。
- **审计**：每个 unavailable 字段记 `context-trimmed (unavailable, source:'skill-inputs')`；explicit 字段零事件（补全即装配成功）。

### 11.3 共享裁剪升级（`assembleBranchContext`）

- **去重取最新**：同 `claimId` 多份命中时保留 **updatedAt 最新**的副本（设计稿 §4"多源重复取最新"；V1 的取高分语义是过渡口径，V2 修正），事件仍记 `context-trimmed (duplicate)`。
- **相关度闸**：新增可选 `minScore`（hybrid score 0..1）——低于阈值的条目不入上下文，记 `context-trimmed (relevance)`。默认 `undefined` = 闸关闭（无真实负载分布，不凭空拍数），阈值校准挂 #9。
- **敏感面**：凭证形态剔除不变（SENSITIVE_TEXT 复用 dispatch 侧脱敏形状）。

### 11.4 装配点与数据流

- **装配点**：`orchestrator.fanOutNew` 分支构造处，与 V1 记忆装配同层——先装记忆附录，再装技能 inputs，事件并入同一次 `onContextAssembled` 审计桥。
- **OrchestratorOptions 增可选字段**：`skillInputsProvider?: (skillId) => Record<string, unknown> | undefined`（窄端口）；`contextOptions` 增 `minScore?: number`。
- **规格来源**：boot 接线 `skillRegistry.get(skillId)?.inputs`。**A2A Agent Card 的技能形状（id/name/description/tags）是协议限制，不携带 inputs**——`registerFromCard` 不透传，技能输入声明只能来自显式 `POST /api/skills`（`register()`）的规格；卡广告技能无规格声明时装配零（与"目录无记录"同款降级）。
- **载荷落点**：装配结果作为只读字段 `skillInputs` 并入分支 `DispatchRequest`（与 `contextAppendix` 同层）；`FanOutRequest` 不加该字段。出站序列化随现有通道。
- **boot 接线**：`skillInputsProvider` 未设 / 提供者抛错 / 目录无 spec → 零装配、零事件、派发照常（与 memoryStore 同款优雅降级）。

### 11.5 审计口径

- `ContextAssemblyEvent['context-trimmed']` 的 reason 联合扩 `unavailable | relevance`，事件增可选 `source?: 'memory' | 'skill-inputs'`（skill-inputs 标记输入缺席；缺省即记忆）。
- `AUDIT_DECISIONS` **不加新值**（decision 仍 `context-trimmed`，reason 在 detail 里），TUI token 不变。
- boot 审计桥 detail 按 source 分流措辞：`skill-inputs` → `N skill input field unavailable`；记忆 → 原 `memory entry trimmed (reason)`。

### 11.6 不变量（测试钉死）

1. 显式载荷原样透传、永不被裁剪（fan-out 既有测试回归 + `assembleSkillInputs` 未声明键不动）。
2. `unavailable` 是显式缺席而非臆造值：出站载荷里字段带 `source:'unavailable'`，绝不带假值。
3. 去重取最新：同 factId 多份命中，updatedAt 新者胜出（不按分数）。
4. 相关度闸默认关闭（`minScore` 缺省零裁剪）；开启后边界值（score === minScore）保留。
5. 缺 provider / 无 spec / 提供者抛错 → 零装配零审计，派发照常。
6. 审计可回放：unavailable 逐字段一条 `context-trimmed`，detail 可区分源。

### 11.7 测试与验收

- **单元**：`tests/context-skill-inputs.test.ts`（5 例：全 explicit / 部分 unavailable / undefined 缺 null 显式 / 空声明 / 未声明键不动）。
- **裁剪升级**：`tests/context-assemble.test.ts` 去重用例改取最新 + 新增相关度闸 3 例（过滤+审计 / 边界值保留 / 默认关闭）。
- **装配**：`tests/boot-context-assembly.test.ts` +3 例（显式注册 spec 带 inputs → 出站带 `skillInputs` explicit / 未供给字段 unavailable + 审计 detail / 卡广告无规格技能 → 零装配）。
- **门禁**：全量 **1379 绿 / 125 文件**、冒烟 **45/45**、doc-consistency **18/18**、typecheck/build/lint 0。
