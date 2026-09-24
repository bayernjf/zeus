# 设计：Org 虚拟部门编制与结果责任

- 状态：**现行 v0.1**（2026-09-24）
- 对应 PRD：**E9.3 虚拟部门编制（Team）与结果责任（P2）**
- 关联：[design-supervision.md](design-supervision.md)（控制与责任）、[design-fan-out.md](design-fan-out.md)（意图/分支结果）、[product-portrait.md](product-portrait.md) §4 组织层
- 一句话：**把 Agent 编进有职责、有主管的虚拟部门，让"谁在哪个部门、担什么岗"可视，并让每个任务结果都能追到执行 Agent、部门主管与拍板驾驶员。**

---

## 1. 背景与定位

现有两类"组队"，都不是组织编制：

- `skills` 的 `TeamResolution`：为**某个任务**按技能临时组的执行队，任务结束即散；
- `roster`：封臣名册投影，回答"有哪些封臣"，不回答"谁属于哪个部门、谁对结果负责"。

E9.3 补**组织层**：持久的部门编制 + 责任链。它不改编排，只把已有的 Agent 与任务结果映射到组织结构上。

## 2. 设计原则

1. **编制确定**：`departmentId` 由部门名确定性派生；成员按 `agentId` 在部门内唯一。
2. **一个部门一个 lead**：lead 是该部门结果的责任人。
3. **责任不悬空**：每个执行分支都能映射到节点；Agent 没有编制时显式标 `unassigned`（暴露"野 Agent"，不静默忽略）。
4. **追到 Agent 与驾驶员**：责任链含执行节点、所属部门 lead、以及拍板驾驶员（若有）。
5. **只映射、不臆造**：部门/岗位来自编制数据，责任链来自真实 `FanOutResult`。
6. **不可变**：编制变更经纯函数返回新对象（与 roster 投影风格一致）。

## 3. 数据结构

```ts
export type OrgRole = 'lead' | 'member';

export interface OrgMember {
  agentId: string;
  role: OrgRole;
  title?: string;          // 岗位名，如「高级评审官」
  skills?: string[];
  joinedAt: string;
}

export interface Department {
  format: 'zeus-department';
  version: 1;
  departmentId: string;    // dept:{slug(name)}
  name: string;
  mission: string;         // 部门职责
  lead?: string;           // lead agentId
  members: OrgMember[];
  createdAt: string;
}

export interface AccountabilityNode {
  agentId: string;
  role: OrgRole;
  title?: string;
  departmentId: string;    // 无编制时为 'unassigned'
  departmentName: string;  // 无编制时为 'Unassigned'
}

export interface AccountabilityChain {
  intentId: string;
  skill: string;
  status: string;
  executing: AccountabilityNode[];
  leads: AccountabilityNode[];   // 去重的部门主管
  unassigned: string[];          // 无编制的执行 Agent
  driver?: {                     // 拍板驾驶员（若有 driverResolution）
    escalationId: string;
    stance: string;
    decidedAt: string;
  };
}
```

## 4. 编制原语（纯函数）

- `createDepartment(input, now?)`：校验 name/mission 非空，`departmentId = dept:${slug(name)}`，空成员。
- `assignMember(dept, input, now?)`：编进 Agent（agentId/role/title/skills）：
  - 同 agentId 已在部门 → 抛 `OrgError`；
  - `role:'lead'` 且部门已有 lead → 抛 `OrgError`（一个部门一个 lead）；设置 lead；
  - 返回新 `Department`（不改原对象）。
- `removeMember(dept, agentId)`：移除；移除的是 lead 则清空 lead；未知成员抛错。
- `setLead(dept, agentId)`：把在册成员升/转为 lead（原 lead 转 member），用于换主管。

`slug(name)`：lowercase、非 `[a-z0-9]+` 折叠为单个 `-`、去首尾 `-`；空 slug 抛错。

## 5. 编制可视：orgChart / renderOrgMarkdown

- `buildOrgChart(departments)`：可序列化投影——每部门 id/name/mission/lead、成员（title/role/skills）、人数；确定性排序（部门按 id、成员按 agentId）。
- `renderOrgMarkdown(departments)`：人类可读编制表：

```markdown
# Org chart

## Engineering · dept:engineering
> Mission: build and ship the kernel
- **Lead:** agent-b
- agent-a — Reviewer (code-review) [member]
```

## 6. 结果责任：traceAccountability

`traceAccountability(departments, result)` 是纯函数，从真实 `FanOutResult` 追责任：

1. 为 `result.branches` 每个 vassal 定位其部门节点（一个 Agent 只在一个部门，出现在多个部门 → 取首个并在内部不报错，但测试约束编制不重复安置；无编制 → `unassigned` 节点 + 记入 `unassigned`）；
2. `leads`：执行节点所属部门的 lead（去重，排除已在 executing 的 lead 自身）；
3. `driver`：`result.driverResolution` 存在则取 escalationId/stance/decidedAt；
4. 返回 `AccountabilityChain`（intentId/skill/status 透传）。

这样一个结果可读到：**谁执行 → 谁的部门主管负责 → 哪位驾驶员拍板**。

## 7. 安全红线（测试必须逐条断言）

1. 成员在部门内按 agentId 唯一，重复安置抛 `OrgError`。
2. 一个部门只有一个 lead；第二个 lead 拒绝。
3. 编制变更是不可变的（原对象不被修改）。
4. `traceAccountability` 覆盖全部执行分支；无编制 Agent 进 `unassigned`，不被静默丢弃。
5. 责任链 leads 取部门主管、去重；driver 仅在有 driverResolution 时出现且字段正确。
6. departmentId 对同名稳定、对非法名（空/全符号）报错。
7. removeMember/setLead 语义正确（移 lead 清空 lead；换岗原 lead 转 member）。

## 8. 非目标 / 边界

- 本批不把部门编制接进 `KernelSnapshot`/boot（持久化接入随 E5 批次；Department 已 JSON 可序列化，提供 export/import 便利）。
- 不做跨部门汇报线/矩阵式多头管理（v1 为单部门单 lead）。
- 不做 E9.1 Mentor 带教、E9.2 上岗流程（独立条目）。
- 不做编制的 UI（产出 markdown/结构化投影，界面随产品面）。
- 不替代 skills 任务级组队与 roster 名册。

## 9. 验收清单

- [ ] createDepartment / assignMember / removeMember / setLead 行为与不可变性正确。
- [ ] buildOrgChart 与 renderOrgMarkdown 编制可视、排序确定。
- [ ] traceAccountability：执行/主管/驾驶员三层责任正确，unassigned 显式。
- [ ] slug 与重复/越界情形报错。
- [ ] 全量 `vitest` 绿、`tsc --noEmit` 绿、`npm run build` 过。
- [ ] PRD E9.3 升状态、README 模块表、handoff 与 docs/README 同步。
