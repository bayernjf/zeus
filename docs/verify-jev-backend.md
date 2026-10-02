# Jev 决策后端真实核对规程（v0.1，2026-10-03）

## 0. 一句话

把 `src/decision/decision-model.ts` 对 TypeSafe Jev 的四个未证实假设，在真实 endpoint 上逐项核对并落结论；核完登记 handoff 销项。

## 1. 为什么要核（出处）

`decision-model.ts:22` 自注：*"the exact response envelope (answers/results key) has not been verified against the live API (no key in this environment); parsing tolerates the documented shapes and must be confirmed on first real call"*。LLM 适配器侧此限制已于 2026-10-03 解除（`npm run verify:decision-backend` 真机跑通 agnes-2.5-flash）；**Jev 侧限制不变**（无 key、endpoint 与 envelope 未核）。

## 2. 四个未证实假设（引用代码现状）

| # | 假设 | 代码位置 |
| --- | --- | --- |
| 1 | `POST {baseUrl}/decide`，Bearer 认证 | `decision-model.ts:60/66` |
| 2 | 响应 envelope 键序：`answers` → `results` → `responses` → 裸 `payload[name]`，容器内取 `[name]` | `extractAnswer` `decision-model.ts:145-160` |
| 3 | 字段名：noul 用 `probability`/`confidence`；choice 用 `choice`/`probabilities`/`confidence`；score 用 `score`/`level`/`distribution`/`confidence`；confidence ∈ [0,1]、score ∈ [0,100] | `ask` 后各方法断言 `decision-model.ts:83-140` |
| 4 | 延迟 70–500ms（Jev 公布口径），默认超时 1500ms 足够；输入 $0.042/M token 输出免费 | `DEFAULT_TIMEOUT_MS` `decision-model.ts:37` |

## 3. 前置（需要用户提供）

- `ZEUS_DECISION_BASE_URL`（Jev 端点基址，不含尾部斜杠；尾斜杠由代码剥离）
- `ZEUS_DECISION_API_KEY`
- 可选 `ZEUS_DECISION_MODEL`（缺省 `jev-latest`）
- Jev 已上 Cloudflare AI 目录；角色判定与设计出处见 [design-decision-backend.md](design-decision-backend.md) §5

## 4. 核对命令（复用现有脚本，无新代码）

```sh
# 配置 trio 后（export 或 .env），脚本内 createJevBackendFromEnv 优先于 LLM：
npm run verify:decision-backend -- --realm personal
# 对照路径（观察闸门行为差异）：
npm run verify:decision-backend -- --realm enterprise
```

脚本行为（`scripts/verify-decision-backend.mjs:103`）：`createJevBackendFromEnv(process.env) ?? createLlmBackendFromEnv(...)`；真实 Orchestrator fan-out → S2 `maybeArbitrate` → 后端。Jev 适配器标 `calibrated: true`，默认闸门应采信；若实测置信度形状与声明不符，按 §5 处置。

## 5. 判定矩阵（拿到实测后逐项填）

| 假设 | 实测通过？ | 不符时的处置 |
| --- | --- | --- |
| 1 路径/认证 | | 改 `createJevBackend`（`decision-model.ts:60`） |
| 2 envelope 键序 | | 改 `extractAnswer` 键序（`decision-model.ts:145`），加回归用例 |
| 3 字段名/取值域 | | 改各方法断言（`decision-model.ts:83-140`）与 `assertRanged` 调用，加回归用例 |
| 4 延迟/超时/计费 | | 超时则上调 `DEFAULT_TIMEOUT_MS`；计费口径不符则改 `inputUsdPerMillion` 默认值并同步设计文档 |

通过标准：四项全部实测符合，且 verify 脚本在真实 Jev 后端上 exit 0、DecisionTrace 含 `backend:'decision-model'` 与实测 `latencyMs`。

## 6. 完成后登记

- handoff：销项"Jev endpoint/key 核对"（Current state「仍未执行」段移除该行）；Active work 记实测数字
- [design-decision-backend.md](design-decision-backend.md)：删 `decision-model.ts:22` 对应限制注记（或改写为已核实口径）
- 本文档状态行更新为已销项

## 7. 边界

- 本规程只是操作手册，不是新可执行代码；脚本已存在（`scripts/verify-decision-backend.mjs`，deferred #37 已纳入类型检查）。
- 无 key 前不可执行；不可用 mock/自造上游替代（deferred #30/#31 同款纪律：用自造上游证明放宽可行，证的只是自己写的假设）。
