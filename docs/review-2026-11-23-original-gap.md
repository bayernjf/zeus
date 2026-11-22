# Zeus 立项 vs 当前差距与待办（2026-11-23，本地自用口径）

> 性质：一次性审计 + 待办台账，不是契约、不是排期承诺，也不替代 `docs/prd.md`、`docs/feature-inventory.md`、`docs/product-portrait.md`。
> 口径：只算「本机单人自用」真正影响使用的差距。生产多副本、公网多租户、SLA、正式运营体系不算硬缺口，只列为后置项。
> 2026-11-23 追加口径：对外开放、上线、生产相关任务一律不作为阻塞项；P0/P1/P2 只按本机自用跑通与效益排序，外部投递/公网接入只作可行性观察。
> 2026-11-23 追加约束：现有功能全部保留，只做追加式迭代；不删除、不替换、不回退当前已有能力。当前组织执行 runtime、agent-world/agent-dev 执行臂，以及 daily/TUI/Web/HTTP/MCP/chat CLI/daemon 全部在保留范围内；“对齐”只补缺口，不做破坏性重构。
> 事实源：当前能力以 `docs/feature-inventory.md` v1.14（2026-11-17）为主，当前待办以 `handoff.md` 顶部为主；原立项以 `docs/product-portrait.md` v0.10（2026-10-01）为主。两者有明显时差，引用时已标注。
> 结论时点：2026-11-23。测试数字引用 2026-11-22 的 BayJF 本地 MVP 证据，本轮未重跑全量测试。

## 0. 一句话结论

- **核心主张没有偏**：Zeus 仍然是「用户只面对一个决策/执行入口」，仍然保留 D0–D3 决策分级、可审计决策链、个人数据主权与备份、企业按需组建 Agent 团队这些底层主张。
- **边界偏了**：立项时写的是「高并发、多 Agent 协同决策的平台」，当前实际已经扩成「AI 原生的多 Agent 团队运行时」——除了决策，还做组织目标、任务、排班、模板执行、agent-world/agent-dev 执行臂。
- **本地自用下最大的缺口不是高并发**，而是：真实组织 dogfood、真实长会话 memory compaction/writeback、A2A 本地/内网上游调用者与名册信任锚、单入口定位（不删入口），以及 PRD/product-portrait 的口径滞后。
- 一句话：**Zeus 的内核比立项时更完整，但产品叙事还停在「决策平台」，没有跟上「组织执行 runtime」的实际形态。**
- 本轮不是回退到纯决策平台：当前组织目标/任务/排班/模板执行、agent-world/agent-dev 执行臂，以及 daily/TUI/Web/HTTP/MCP/chat CLI/daemon 全部保留；对齐只统一叙事、定主入口、补缺口。

## 1. 原立项（v0.4 / v0.10）

| 维度 | 原立项主张 | 说明 |
|---|---|---|
| 定位 | 高并发、多 Agent 协同决策的平台 | v0.4（2026-09-22）、v0.10（2026-10-01）一致 |
| 核心机制 | 一个意图扇出到多个 Agent，汇总成可追溯的决策 | D0–D3 分级、决策审计、责任链 |
| 个人侧 | 个人数据主权、备份、恢复、跨代移交 | 本地目录即数据库；备份/恢复是一等能力 |
| 企业侧 | 企业可按需组建 Agent 团队 | 组织、岗位、SOP、任务执行 |
| 入口 | 用户只面对 Zeus 一个入口 | 矩阵产品不应直接暴露给用户 |
| 通道 | MCP / Skill / A2A 三通道 | 外部工具、技能、跨 Agent 协作 |
| 边界 | 个人域与企业域不互通 | 数据二极管、权限与信任分级 |
| 矩阵 | 通过 Executor Protocol 接入矩阵产品 | 把 agent-world 等作为执行臂 |

## 2. 当前实际（v1.14，2026-11-17）

`docs/feature-inventory.md` v1.14 的自我描述已经变成 **「AI 原生的多 Agent 团队运行时」**，不再只是「决策平台」。当前至少包含：

- **M1 决策服务**：D0 自动 / D1 异步审批 / D2 同步审批 / D3 人工阻断；策略版本、幂等、SLA 超时、审计链、回放、webhook 订阅。
- **M2 组织 v1**：Organization / Department / Position / OrgTask 四模型；组织/部门/岗位/任务 CRUD；任务派发状态机；D 级权限闸；阈值与快照。
- **M5 组织执行**：org goal、task、scheduling、template executor；`weekly-report.collect/summarize/human-review`、`content-review.draft` 两类模板；`RoutingOrgTaskExecutor` 按 `templateRef` / `system=agent-dev` / `workflow` 选臂。
- **执行臂**：`agent-world` 适配器（content / listing / after-sales 三类 workflow；D2/D3 停等批准后 resume）；`agent-dev` 适配器（真实 worktree/commit diff + evidence/last-commit）。
- **个人侧**：DataDomain、备份/恢复、日记、Org、Onboarding、Mentorship。
- **持久化与运维**：SQLite 决策/组织表、备份/恢复脚本、坏库/坏迁移 fail-closed、Prometheus 抓取面、trace/指标史、eval runs。
- **入口与操作面**：`npm run daily`、TUI、Web 监督台、HTTP API、MCP、chat CLI + daemon；对外只读门户。
- **测试基线**：v1.14 记录 2710 tests / 241 files；BayJF 本地 MVP 证据（2026-11-22）记录 2715 tests + `smoke:core` 50/50。

### 2.1 当前硬边界

- `content-review.draft` 仍要求 `ZEUS_AGENT_WORLD_BASE_URL` 与岗位 `agent-world:run-graph/get-run` 授权；没有外部臂时 503 fail-closed，不假装执行。
- 生产多副本、7×24 高可用、公网多租户未做；本地自用不要求。
- 个人域与企业域的数据二极管是设计约束，不是「已经把所有跨域路径都验完」；真实组织数据仍需 dogfood。
- A2A 入站机制已实现，但本地/内网上游调用者与在册名册验签信任锚仍缺。

## 3. 立项 vs 当前逐项对照

| 维度 | 原立项 | 当前实际 | 判定 |
|---|---|---|---|
| 产品定位 | 高并发多 Agent 协同**决策**平台 | AI 原生多 Agent 团队**运行时**（决策 + 组织 + 执行） | **边界扩张，叙事未同步** |
| 决策内核 | 多 Agent 提案、汇总、可追溯 | M1 决策服务 D0–D3、策略、幂等、SLA、审计链、回放、webhook | ✅ 保留并加强 |
| 个人数据主权 | 本地目录即数据库、备份/恢复一等 | DataDomain + 备份/恢复 + 日记 + 个人域 | ✅ 主体完成 |
| 跨代移交 | 个人数据可移交/继承 | E8.4 仍是 ⬜，属后期功能 | ❌ 未完成 |
| 企业 Agent 团队 | 按需组建、岗位/SOP/任务 | M2 组织 v1、M5 目标/任务/排班/模板执行、agent-world/agent-dev | ✅ 主体完成，缺真实组织 dogfood |
| 用户只面对 Zeus | 一个入口，矩阵产品不直接暴露 | 矩阵产品语义上在 Zeus 后面，但物理入口有 daily/TUI/Web/HTTP/MCP/chat CLI/daemon | 🟡 语义成立，形态未收敛 |
| 三通道 | MCP / Skill / A2A | MCP 读写面、Skill 目录、A2A 入站机制均已有 | 🟡 主体在，A2A 信任锚/真实调用者缺 |
| 高并发 | 高并发平台 | 有容量基线/微基准/门禁；生产多副本未做 | 🟡 本地自用不算硬缺口 |
| 矩阵 | Executor Protocol 接入矩阵产品 | agent-world、agent-dev 两条真实执行臂；其余矩阵产品按 A2A/协议接入 | 🟡 有骨架，真实跨产品 run 仍需逐条验收 |
| 文档一致性 | product-portrait 是立项叙事 | v0.10 落后于 v1.14；PRD A2A 口径与实现冲突；路由数自相矛盾 | ❌ 需要收口 |

## 4. 已完成 / 部分 / 未完成

### 4.1 已完成

- 决策服务 M1：D0–D3、策略版本、幂等、SLA、审计链、回放、webhook。
- 组织 v1 M2：四模型、派发、D 级权限、阈值、快照。
- 组织执行 M5：目标、任务、每日/每周排班、模板执行、依赖序、幂等 replay。
- 两条真实执行臂：agent-world、agent-dev。
- 持久化与备份 M6：决策/组织表、备份/恢复、坏库 fail-closed。
- 个人侧：DataDomain、备份、日记、Org、Onboarding、Mentorship。
- MCP 读写面、Skill 目录、A2A 入站机制、名册签名/验签。
- 观测与质量：Prometheus、trace、指标史、eval runs、LLM-as-judge。
- 测试：2715 tests + `smoke:core` 50/50（BayJF 2026-11-22 证据）；PRD P0 26/26 ✅。

### 4.2 部分完成

- **A2A 入站**：server 与 agent card 已实现，缺本地/内网上游调用者 + 在册名册验签信任锚。
- **MCP**：E3.4 只差「首次出现读 Agent 时复核 OAuth subject」这一外部条件。
- **Personal MCP η**：机制已完成；`handoff.md` 顶部原列 open，本文落盘时已按 Active work 276 / 414 的批次记录改为 `[x]`（T8 CLI chat + T9 daemon，5da90b8/082afaf/525d252/944ee6c 在 dev），不再重复开发。
- **入口**：daily/TUI/Web/HTTP/MCP/chat CLI/daemon 都能用，但没有收敛成「用户只感知一个入口」的产品形态。
- **矩阵**：有 agent-world/agent-dev 两条真实臂；其余矩阵产品的真实 run 仍需逐条验收，不能按「协议已通」推定「业务已通」。
- **真实组织 dogfood**：有 `e2e:m7` 可重复闭环（fake worker 仅替换模型调用），但真实组织数据/真实任务仍未跑。

### 4.3 未完成

- E8.4 跨代移交 / 继承（死手开关 + 密钥托管）。
- E3.8 搜索后端：inverted/vector 仍未做。
- E4.10 背压：需要 ≥3 个执行 Agent 真实负载验证。
- E4.9 生产 RSK 托管 + 带外指纹公告（仓库外动作）。
- E10.2 真实部署 pr-helper + Zeus facade（外部真实部署）。
- compaction/writeback 真实长会话数据；当前只有机制，没有真实长会话证据。
- 真实组织数据 / 真实任务 dogfood。
- 生产多副本、7×24、公网多租户、SLA（本地自用非目标）。

## 5. 关键矛盾与文档漂移

### 5.1 PRD 与入站 A2A 的硬矛盾

- `docs/prd.md` §2.2 第 27 行仍写：**「Zeus v1 不做 A2A server（发起方永远是 Zeus/操作者）」**。
- `docs/design-inbound-a2a.md` v0.2（2026-10-07）写：Zeus 发布自己的 agent card 并接收入站 `tasks/send`，落到 H2 意图面；机制已于 2026-10-07 落地。
- `docs/feature-inventory.md` 已把入站 A2A 面标 ✅。
- 结论：**「不做 A2A server」是滞后/冲突表述**；当前真实缺口不是 server，而是「本地/内网上游调用者 + 在册名册验签信任锚」；公网 A2A 不作为阻塞。
- **Z-01 收口（2026-11-23）**：`docs/prd.md` §2.2 已改为「入站机制已实现，缺真实调用者/信任锚」，旧表述以括注保留可追溯；feature-inventory §2.1 口径统一为 150 条（5 公开＋145 bearer），由 doc-consistency 实测钉住。
- `docs/design-a2a-push.md` 的 `POST /api/a2a/push-notifications` 是**出站长任务结果回调接收侧**，不是入站 A2A server；两者不要混为一谈。

### 5.2 product-portrait 落后

- `docs/product-portrait.md` v0.10（2026-10-01）仍以「高并发、多 Agent 协同决策的平台」为主叙事。
- **Z-01 收口（2026-11-23）**：portrait 升 v0.11，一句话定位改为「决策 + 组织执行 runtime」，演进日志留痕；不缩回纯决策平台。
- `docs/feature-inventory.md` v1.14（2026-11-17）已经是「AI 原生的多 Agent 团队运行时」。
- v0.10 没有覆盖 M5 的 org goal/task/scheduling/template executor、agent-world/agent-dev 执行臂、M6 持久化与备份、M7 操作面。产品叙事落后约一个半月。

### 5.3 路由数自相矛盾

- `feature-inventory.md` v1.14 头部写 **150 条路由（5 公开 + 145 bearer）**。
- 同一文件 §2.1 标题仍写 **134 条（4 公开 + 130 bearer）**。
- 这是同一文档内的硬漂移。引用路由数前必须回源核对；不要用 150 或 134 直接对外。

### 5.4 Personal MCP η 的台账滞后

- `handoff.md` 原顶部 line 11 列 `[ ] Personal MCP η：CLI chat + daemon（T8/T9）`。
- `handoff.md` Active work 276（2026-10-27）明确写「η T8/T9 经核对早已落码（5da90b8/082afaf/525d252/944ee6c 在 dev），Active 274 尾『待办保留』为台账滞后，本条销记」。
- `handoff.md` 2026-10-25 变更表也写「T8/T9 已完成」。
- 结论：**机制已完成**；本文落盘时已把顶部该行改为 `[x]`，不要再把 η 当新建任务。

## 6. 待办（P0 / P1 / P2）

> P0 = 不做就无法把 Zeus 当「本地自用组织执行 runtime」真正用起来；P1 = 明显影响可靠性/体验，但不阻塞跑通；P2 = 后期或外部条件。所有 P0/P1/P2 均为追加式，不删现有入口/组织执行能力。

### P0

| ID | 待办 | 为什么要做 | 完成判据 |
|---|---|---|---|
| Z-01 | **产品口径收口（不删现有能力）** | 当前 PRD 说「不做 A2A server」、portrait 说「决策平台」、feature-inventory 说「runtime」；不拍板会导致下一批继续按旧叙事做 | 三处统一：product-portrait 升版为「决策 + 组织执行 runtime」；PRD §2.2 的 A2A server 表述改为「入站机制已实现，缺真实调用者/信任锚」；feature-inventory 路由数 150/134 只保留一个口径；保留现有组织执行 runtime、执行臂与全部入口，不缩回纯决策平台。改动前由 owner 拍板定位 |
| Z-02 | **真实组织 dogfood** | 现有 `e2e:m7` 是 fake worker 可重复闭环；真实组织数据/真实任务没有跑过，无法证明 M5 的模板执行在真实业务里可用 | 选一个真实组织（2–3 个岗位），真实 goal → 排班 → `weekly-report` 模板 → agent-world/agent-dev 执行 → D2 人工审批 → 产出；证据落 `outputs/` 或 `docs/`，列出每一步真实输入、产出、失败点 |
| Z-03 | **单入口定位（现有入口全保留）** | 原立项承诺「用户只面对 Zeus 一个入口」；当前 daily/TUI/Web/HTTP/MCP/chat CLI/daemon 并存，用户需要自己选；要解决的是「默认从哪进」，不是删面 | 选定一个主入口（建议 `npm run daily` 或 chat CLI + daemon），其余面全部保留并明确标为 operator/dev/自动化面；不删除、不合并掉任何现有入口；文档写清「日常从哪进、什么时候用哪个面」 |

### P1

| ID | 待办 | 为什么要做 | 完成判据 |
|---|---|---|---|
| Z-04 | **compaction/writeback 真实长会话** | 机制已有，但没有真实长会话数据；本地自用若长期跑，记忆不写回会越用越薄 | 用真实长会话（≥ 一周/ ≥ 20 轮）跑 compaction + writeback；验证事实不丢、旧事实可追溯、写回不污染决策；证据落库 |
| Z-05 | **A2A 本地/内网上游 + 名册信任锚** | 入站 server 已实现，但没有真实调用者与在册名册验签，等于只有门没有访客 | 一个本地/内网上游 Agent 调用 `tasks/send`；名册验签命中/失配两路都有测试；缺信任锚时 fail-closed 有证据；公网 A2A 不作为阻塞 |
| Z-06 | **MCP E3.4 OAuth subject 复核（外部条件，本地不出现读 Agent 即不阻塞）** | 当前 E3.4 只剩「首次出现读 Agent 时复核 OAuth subject」这一外部条件；本地自用没有读 Agent 时可直接后置 | 首次出现读 Agent 时完成 subject 复核；拒绝/放行两路有测试；E3.4 标 ✅ |
| Z-07 | **矩阵真实 run 逐条验收** | agent-world/agent-dev 只是两条臂；其他矩阵产品的 A2A/协议接入不能按「通了」推定「业务通了」 | 列出矩阵产品 × 执行臂矩阵；每条至少一个真实 run 或明确「未接」；不把 plan-only 当完成 |

### P2

| ID | 待办 | 说明 |
|---|---|---|
| Z-08 | E8.4 跨代移交 / 继承 | 后期功能；死手开关 + 密钥托管，本地自用不急 |
| Z-09 | E3.8 搜索后端 inverted/vector | 当前数据量下可用；量大后再做 |
| Z-10 | E4.10 背压 ≥3 执行 Agent 负载 | 真实规模触发；本地自用可后置 |
| Z-11 | E4.9 生产 RSK 托管 + 带外公告 | 仓库外动作；本地自用不需要 |
| Z-12 | E10.2 真实部署 pr-helper + Zeus facade | 外部真实部署；本地自用不需要 |
| Z-13 | 生产多副本 / 7×24 / 公网多租户 / SLA | 本地自用非目标；不要为「像生产」先做 |

## 7. 建议顺序

1. **先做 Z-01**。口径不收，Z-02/Z-03 会反复被「我们是决策平台还是 runtime」打断。
2. **再做 Z-02 + Z-03**。真实组织跑一遍，才知道入口、模板、审批、执行臂哪里真的卡。
3. **Z-04 跟着真实使用走**。没有真实长会话，不要凭空调 compaction 参数。
4. **Z-05 / Z-06 是外部条件**。等真实上游/读 Agent 出现再做，不提前造访客。
5. **Z-07 按矩阵优先级排**，不要一次全接。
6. **Z-08 以后再说**；本地自用不需要跨代移交。

## 8. 证据索引

- 原立项：`docs/product-portrait.md` v0.10（2026-10-01）
- 当前能力：`docs/feature-inventory.md` v1.14（2026-11-17）
- 需求状态：`docs/prd.md` §2.2、E3.4/E3.8/E4.9/E4.10/E8.4/E10.2
- A2A：`docs/design-inbound-a2a.md` v0.2、`docs/design-a2a-push.md`
- 当前待办：`handoff.md` 顶部
- 本地 MVP 证据：`/Users/jiangfeng/000mycodes/bayjf/docs/tier0/evidence/2026-11-22-local-mvp.md`
- 本轮未重跑测试；2715 + 50/50 是 BayJF 2026-11-22 证据，2710/241 是 feature-inventory v1.14 基线。
