# 会议（Meeting）设计：主张图上的多轮决策

> 状态：**现行（v0.1，2026-11-15）**。S1 已落库：`src/meeting/`（领域模型、协议状态机、本地 JSON store、CLI），10 条单测，zeus 全量 2587 通过。S2–S5 为待迭代阶段。本地单人自用，不做多租户与公网暴露。

## 0. 一句话

会议是**有界轮次的多 Agent 提案与交叉质疑**，人类在收敛点做唯一决策，全过程以**主张图**留痕——记录"哪条主张被谁用什么证据否掉"，而不是聊天流水。

## 1. 目标与非目标

**目标**
1. 一个入口里让多个 Agent 各出方案，并互相挑战，而不是各说各话。
2. 人类的决策、当时的依据、被否掉的方案，事后可完整回放。
3. 个人画像与产品背景作为 context 分层注入每个 Agent 实例。
4. 本机跑通、单人自用，边际收益优先于工程完备性。

**非目标**
多人协作、权限体系、公网服务、IM/语音集成、实时流式字幕。

## 2. 核心不变量（违反即实现错误）

1. **决策权唯一**：只有 `human` 能 `decide`，Agent 不得自我批准。
2. **无证据不反驳**：`challenge` 的每条 claim 必须带 evidence。
3. **反驳须具名**：必须指向已存在的 claim id，禁止泛泛否定。
4. **轮次有界**：`maxRounds ∈ 1..5`，到顶强制 `converging`，交人类。
5. **记录不可变**：决策 append-only；claim id 全局唯一，不可复用。
6. **投影而非全量**：每个 Agent 只看角色需要的上下文切片，防锚定与合唱。
7. **成本有闸**：每轮有 token 预算，会议级累计水位可观测。

## 3. 角色

| 角色 | 职责 | 约束 |
|---|---|---|
| Proposer ×N | 独立出方案 | 第 1 轮互相不可见；至少 1 条 claim |
| Critic ×M | 交叉质疑 | 只针对具名 claim；必须带反例/证据 |
| Registrar | 结构化"主张—证据—分歧点" | 不发表观点，不替人决策 |
| Human | 唯一决策者 | 必须写 rationale |

Registrar 单独设的角色很关键：如果让它出观点，它会悄悄把结论写进摘要里。

## 4. 状态机

```
open → proposing → challenging ⇄ (下一轮) → converging → decided → archived
                                     ↘ abandoned（任意态可退）
```

守卫（对应 `src/meeting/protocol.ts` 的错误码）：

| 规则 | 错误码 |
|---|---|
| 非可发言状态（converging/decided/archived/abandoned） | `invalid-state` |
| 第 1 轮出现 challenge | `invalid-state` |
| round 与当前轮不符 / 本轮无发言就推进 | `invalid-round` |
| propose 无 claim、topic 为空、claim 文本为空 | `claim-required` |
| challenge 的 claim 无证据 | `evidence-required` |
| challenge 未指定反驳目标 | `rebuttal-required` |
| 反驳目标不存在 | `unknown-claim` |
| utterance/claim/decision id 重复，或反驳自己 | `duplicate-id` |
| 决策缺人、缺 rationale | `human-decision-required` |
| 决策选空、或同条既选又否 | `empty-decision` |

## 5. 数据模型

现行实现见 `src/meeting/types.ts`：

- `Meeting{ id, topic, createdAt, status, round, maxRounds, utterances[], decisions[] }`
- `Utterance{ id, speakerId, kind, round, stance, claims[], rebuts[], at }`
- `Claim{ id, text, evidence[] }`，`Evidence{ kind(fact|observation|reference|counterexample), ref, note }`
- `MeetingDecision{ id, by, chosenClaimIds[], rejectedClaimIds[], rationale, at }`
- `ClaimGraph{ nodes[{claim, speakerId, round, rebuttedBy[]}], undecided[] }`

`undecided` 的定义：被反驳过、但没有任何决策引用过的 claim——即"还悬着的问题"。

**存储**：每场会议一个 JSON（`ZEUS_MEETING_DIR`，默认 `./.zeus-meetings`），写入走 tmp + rename 原子替换。单人自用，文件可读可 diff 优于建库。

## 6. Context 分层与投影

| 层 | 内容 | 注入策略 |
|---|---|---|
| L0 画像 | 个人偏好、沟通风格、决策倾向 | 常驻只读，带版本；只进摘要，默认不进原始隐私文本 |
| L1 产品事实 | dataDomain hits | 必须带 `ref` 来源，可回指 |
| L2 会议内发言 | 已有 claim、证据、反驳关系 | 按轮窗口 + 摘要，不无限增长 |
| L3 本轮任务 | 本轮目标、约束、输出格式 | 每轮重建 |

投影规则（防"假辩论"的核心）：
- 第 1 轮提案者之间**互不可见**；
- 第 2 轮质疑者只看 **claim 摘要 + 证据**，不看提案者完整推理；
- Registrar 看全量，但只输出结构，不出结论。

预算：复用 `allocateContextBudget` 与 `context-watermark`，会议级累计水位（`chars/tokens`）作为是否收敛的辅助信号。

## 7. 与现有组件映射（不重造）

| 会议需要 | 复用 |
|---|---|
| 多 Agent 并行出方案 | orchestrator fan-out（`branches[]`） |
| 僵持上交人类 | `needs-operator` + decision backend |
| 个人/产品背景长期存在 | `src/memory`（facts + RecallIndex） |
| 产品事实 | dataDomain hits |
| 审计 | audit decisions（`meeting-*` 事件 + 权重） |
| 成本观测 | context watermark |

## 8. 分期计划

**S1（已完成 2026-11-15）** 领域模型 + 协议状态机 + JSON store + CLI + 单测。
验收：非法流转全部报错；存储往返一致；`show --graph` 能显示反驳关系与悬置项。

**S2（下一步）自动提案**
- Round 1 接 `FanOutRequest`：N 个提案者并行，各自只带 L0/L1/L3；
- 产物解析成 claims 写回 meeting（解析失败 → `failed` 分支，不阻塞会议）；
- 一条命令 `convene` 产出 N 条提案。
验收：离线 fake 场景可测；同一 topic 两次运行 claim 结构稳定；失败分支不污染会议。

**S3 自动交叉质疑**
- Round 2 给每个 challenge 分配具名目标（默认：票数最高或分歧最大的 claim）；
- Critic 只拿 claim 摘要 + 证据要求；
- 收敛规则：本轮无新 claim 且无新反驳 → `converging`；仍分裂 → `needs-operator`。
验收：两轮内收敛或明确分裂；每条反驳都有证据 ref。

**S4 对话框 UI**
- 载体：ops-console 新增一页（先只读回放：时间线 + 主张图 + 决策记录）；
- 再做写入：发起会议、插入你的发言、点决策；
- 导出 Markdown 会议纪要。
验收：一场会议可从头回放到决策；导出纪要含被否方案与理由。

**S5 画像与沉淀**
- 决策写回 memory（decision facts），下次同类议题自动带入；
- 会议指标：轮数、token、反驳数、采纳率、人类改写率。
验收：第二场同类会议能引用上一场结论。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 假辩论（同模型同温度 → 集体附和） | 角色差异化 stance/温度/模型；投影隔离 |
| 成本膨胀（N×R） | 轮次上限 + token 上限 + 提前收敛 |
| 投影实现漂移（说隔离实际全量） | 单一投影函数 + 单测断言"看不到对方 claim 全文" |
| 记录膨胀 | 单文件归档；超阈值压缩历史轮为摘要 |
| 解析失败污染会议 | claim 写入前校验，失败落 `failed` 分支 |

## 10. 开放问题（需 owner 拍板）

1. **同步还是异步**：一次跑完两轮，还是每轮暂停等你插话。
2. **角色数量**：固定 3 提案 + 2 质疑，还是按议题可配。
3. **UI 载体**：ops-console 加页，还是 zeus 自带 web/TUI。
4. 会议中是否允许**临时查 dataDomain**（会引入非确定性，但更接近真开会）。

## 11. 附录：现有 CLI

```bash
cd ~/000mycodes/zeus
npm run meeting -- open --topic "议题" --dir ~/Downloads/zeus-test/meetings
npm run meeting -- say <id> --speaker proposer-a --kind agent --stance propose --claim "c1|主张文本" --dir ...
npm run meeting -- advance <id> --dir ...
npm run meeting -- say <id> --speaker critic-a --stance challenge --rebut c1 \
  --claim "c4|反驳主张" --evidence "c4|counterexample|evals/cases/org-roles.mjs|说明" --dir ...
npm run meeting -- show <id> --graph --dir ...
npm run meeting -- decide <id> --chosen c3 --rejected c1 --rationale "理由" --dir ...
```
