# E9.1 / E9.2 上岗：Commission 门与首日简报

> 状态：**现行 v0.1（2026-09-25 落地）**。产品定位依据见 [product-portrait.md](product-portrait.md) §4.3（企业列：多租户 + 编制 + 上岗即用）；编制本体见 [design-org.md](design-org.md)；边界判定见 [design-realm.md](design-realm.md) §7；执行 Agent oath 见 [design-vassal-protocol.md](design-vassal-protocol.md)；技能传授（E2.5）目前只有 PRD 条目 + `src/skills/mentor.ts`，无独立设计稿。

## 0. 一句话

**上岗不是一张表格，是四道必须现在成立的证据**：这个 Agent 有编制位置、有执行 Agent身份、被允许读它要读的域、并且真的通过了考核——所以"已批准"这个状态**永远不缓存**，每次要用都重新查。

## 1. 为什么单独一层

E9.1/E9.2 不新增任何原语：编制在 `src/org`、身份在 `src/registry`、能不能碰某个数据域在 `src/realm/authorization`、会不会一项技能在 `src/skills/mentor`。新增的只是**把这些拼成一个可拒绝的判定**，因此住在新目录 `src/onboarding/`，只依赖它们的公共面。

一层"组合"如果自己存事实，就会变成第二事实源。所以 `CommissionRecord` 里只存**决定**（谁开的档、谁签的字、谁豁免了什么、为什么），四道门的结论一律现算。

## 2. 四道门（顺序即语义）

| 门 | 证据来自 | 拒绝条件 |
| --- | --- | --- |
| seat 编制位置 | `OrgRegistry`（E9.3） | Agent 不在该部门名册上；部门不存在 |
| account 执行 Agent身份 | `VassalRegistry.asVassalLookup().statusOf` | 查无此执行 Agent（**有编制没卡片的 Agent 不能派活**），或已吊销 |
| authorization 数据域 | `decideRealmAccess`（E3.6 + E6.4） | 该 Agent 的租户级读不到那个 realm（个人侧主体须 `DomainGrant`） |
| mentorship 能力 | `MentorshipLedger`（E2.5，status=certified） | 岗位要求的技能没有**通过考核**的记录 |

三条刻意的严格化：

1. **出勤 ≠ 能力**：`assess` 判 failed 的带教不算证据（E2.5 的规则被原样继承，不在此重定义）。
2. **没有要求 ≠ 已通过**：`requiredSkills` 为空时必须由操作者**显式豁免并写理由**，否则这道门是拒的。空要求自动放行是最容易蒙混过关的门。
3. **豁免不能覆盖已声明的要求**：一旦岗位写了技能要求，waiver 无效——否则一个偷懒的 waive 调用就把门清空了。

另外，开档时就校验：部门/ realm 必须存在、个人 realm 不能带租户、**座位的租户不得比 realm 自身更宽**（`acme/eng` 的部门里放一个 `acme` 级的座位等于让它看得见兄弟部门）。

## 3. 决定与失效（不缓存的代价换来的是什么）

- `commission()` 只在四道门**当场**全绿时写入 `commissioned`；否则写一条 `commission-refused` 审计并抛 `CommissionError{kind:'gate', blockedOn}`。
- `assertCommissioned()`（首日任务前必过）重算四道门 + 检查签字仍在：
  - 之后吊销执行 Agent → 资格自动失效；
  - 之后把该 Agent 挪出名册 → 失效；
  - `withdraw`（撤回上岗）→ 失效，且再次上岗是一次**新的显式签字**（`withdrawn` 被清除，审计留两条记录）。
- 代价是每次判定要读名册/realm/台账（都是进程内 Map，无 IO），换来的是"没有哪份缓存需要有人记得去更新"。

## 4. 首日简报（E9.1 的验收对象）

`composeBriefing()` 只用已有事实装配岗位上下文，**不生成任何未经支撑的内容**：

| 段 | 来源 |
| --- | --- |
| seat / mission / title | 部门与名册（E9.3） |
| chain 结果责任 | 部门 lead + §6 责任链口径 |
| competencies（已认证 / 还缺） | `MentorshipLedger` certified 记录 |
| business（岗位技能、同部门同事、谁能教） | `SkillRegistry` + 名册 + `findBySkill` |
| culture（组织惯例） | **本部门 realm 的记忆召回**（`searchRecall`，同域读；跨域会直接抛错） |
| boundaries | `decideRealmAccess` 读/写两个方向 + realm 的租户/只读/条目数 |
| gaps | 内核答不上来的东西，逐条列明 |

两个刻意保留的"难看"事实：

- `culture.totalFacts` 与命中数分开报：**"组织没写过惯例"和"写了但跟这个岗位无关"是两件事**，混成一条会让新人以为公司没有文化。
- `boundaries.canWrite` 只表示**域边界**允许写；企业域还要 E3.5 的一次性 `DriverWriteGrant`。这一点单列成 `writeNeedsGrant`，避免简报读起来像"你可以写"。

简报带一个 `digest`：对内容（去掉时间戳）做稳定序列化后 sha256。同一份组织状态必须给同一个指纹——首日任务因此可以证明"当时是照哪一版简报派的活"。

## 5. 首日任务（E9.2 的链路收口）

`POST /api/org/departments/:id/first-task` 真的走一次 `orchestrator.fanOut`：

- 目标限定为该座位上的 Agent（`vassals: [agentId]`）；
- `realm` 取该 realm **当前真实类型**，不是请求里写的；
- `params.onboarding` 带 `commissionId` / `briefingDigest` / `openGaps` 数量，于是回放与审计都能看见这次派发背后的门；
- 门没过就 409 `commission_gate` + `blockedOn`，不派发。

链路因此是**跑通的**而不是画出来的：账号（`POST /api/vassals`）→ 授权（E6.4 判定）→ Mentor（E2.5 认证）→ 上岗（签字）→ 首日任务（真实派发，走派发二极管与结果回传回写）。

## 6. 运维面

- `GET /api/org/departments/:id/commissions`：台账 + 每份的实时 verdict（`stage` / `blockedOn` / 四门理由）。
- `POST …/commissions`（开档）、`…/waive`、`…/commission`（签字）、`…/withdraw`。
- `GET …/briefing/:agentId`：E9.1 的产物；**响应不含任何绝对路径**。
- `GET /api/audit?decision=commission-refused|commission-granted|commission-waived|commission-withdrawn`。
- `GET /api/state`：`commissions` / `commissioned` 两个计数（后者只数"已签字且未撤回"）。
- 上岗记录进 `KernelSnapshot`（`commissions` 段），重启不丢签字，也不"顺手补一个签字"。

## 7. 安全红线（测试逐条断言）

1. 未签字的座位不能派首日任务；撤回后同样不能。
2. 签字之后：吊销执行 Agent / 移出名册 / 撤回签字，任一发生即令资格失效（**不靠记得改状态**）。
3. 空 `requiredSkills` 且无豁免 → 拒；豁免不能覆盖已声明要求。
4. 出勤不等于能力：`failed` 的带教记录不是证据。
5. 简报与所有响应都不含绝对路径（Realm 不变量 3）。
6. `canWrite` 只声明域边界；企业写入仍需 `DriverWriteGrant`（`writeNeedsGrant` 单列）。
7. 座位租户不得比其 realm 更宽。
8. 每道门都做过缺陷植入：门常真 → 2 例红；只信记录不重算 → 3 例红；能力门常过 → 2 例红。

## 8. 非目标 / 边界

- 不做"部门级默认权限模板"：现在每个座位显式带 realm（和租户）。批量模板要回答"模板改了以后已上岗的怎么办"，属新契约（未登记，因为还没人要）。
- 不做自动带教（让 Mentor Agent 自己决定教什么）：E2.5 的台账要求可验证的考核，自动出题会把门变成走过场；等真机执行 Agent形态明确再说。
- 不做 UI：本节列的是 HTTP 面，界面随产品面。
- 不做跨部门汇报线/兼职（承 design-org §8：v1 单部门单 lead）。
- 首日任务不做结果评价（那是结果回传 E4.4 与记忆层可靠度回写的事，见 [design-memory-consolidation.md](design-memory-consolidation.md)）。

## 9. 验收清单

- [x] E9.1：无人工介入可得岗位上下文（`GET …/briefing/:agentId`，缺什么进 `gaps`）。
- [x] E9.2：账号→授权→Mentor→首日任务全链路可在真实进程里跑通（冒烟记录见 handoff Active work 44）。
- [x] 四道门各自的拒绝理由可读（`blockedOn` + reason），且失效可被证明。
- [x] 上岗记录随快照恢复。
- [ ] 真机：由真实执行 Agent当 Mentor 完成一次带教并通过考核（需 ≥1 个真实执行 Agent在线，与 E4.8 同一批）。

## 10. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-25 | 初稿即落地：四道门（编制/执行 Agent/数据域/能力）现算不缓存、显式豁免、首日任务真派发、简报 `gaps`/`totalFacts`/`writeNeedsGrant`/稳定 digest、审计与盘点、快照持久化。顺带修一个只在真实进程里暴露的洞：**fealty 缺字段（如无 `dataRealms`）的卡片能注册成功、到派发时才抛 TypeError**，现由名册在边界拒收并点名缺哪个字段 |
