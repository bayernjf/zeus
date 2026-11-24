# Z-07 矩阵真实 run 逐条验收（2026-11-24）

> 口径：本地自用，不要求生产部署；只认真实 run，plan-only 不计业务完成；未接必须显式写「未接」，不得用「协议通了」推定「业务通了」。

## 结论

Z-07 的完成判据是「列出矩阵产品 × 执行臂矩阵；每条至少一个真实 run 或明确『未接』」。本表按产品逐条给出结论：

- **真实组织执行臂**：`agent-world`、`agent-dev` 两条，均有 Zeus 组织任务真实 run。
- **真实 A2A 执行但未接 Zeus 组织臂**：`atlas` 有真实 HTTP A2A 图 run，但没有 `system:"atlas"` 组织执行臂。
- **明确未接业务执行**：`pr-helper`、`loom` 只有 plan-only 的真机协议联调，不计业务完成；`job-agent` 只有 stdio MCP，没有 A2A/组织执行臂。
- **非执行产品**：`bayjf` 是展示站/公开名册配套，不参与执行臂验收。

因此 Z-07 可收口：矩阵每条要么有真实 run，要么明确「未接」；没有把 plan-only 冒充 done。

## 矩阵总表

| 产品 | 矩阵定位 | Zeus 组织执行臂 | 真实 run / 协议证据 | Z-07 判定 | 诚实边界 |
|---|---|---|---|---|---|
| `agent-world` | 内容/工作流执行 | ✅ `workflow` 或 `system:"agent-world"` | Z-02 内容岗 run `144cbd02-4ef5-45f2-b034-a1cb37d44dee`，graph `f2b91605-ea73-4459-8c16-41591e2bf5f7`，8/8 节点 done，2078ms；证据 `outputs/z02-org-dogfood/05-tasks-final.json`、`07-agent-world-run-timeline.json`、`08-agent-world-artifacts.json` | **✅ 真实 run** | 本机 `127.0.0.1:8899`；当时 `/api/health` 为 `ok:false`（`jwtSecret=missing`）；text/image 用本地 fake provider，真实的是调度/状态机/D2 审批/执行臂 |
| `agent-dev` | 代码 Feature Task 执行 | ✅ `system:"agent-dev"` | F1.3 真实闭环：`f13-acceptance-0003` 经 `AgentDevOrgTaskExecutor` 返回 complete；run `6625249d-3530-4a0d-9618-6b168895d257`，status completed / attempts 1 / agentId codex；实现提交 `19d5e87f23262a1ec992129a4f90d3b4922f91eb`，`apps/web/src/main.tsx` 1 file changed | **✅ 真实 run（历史记录）** | 记录在 `handoff.md` 的 2026-11-17 M5 F1.3 段；agent-dev 后并入 agent-ops，本机原 `.agent-dev/agent-dev.sqlite` 已不在当前路径，本轮未重跑该臂 |
| `atlas` | 编排/图执行平台 | ❌ 无 `system:"atlas"` 组织臂 | 真实 HTTP A2A `run-graph`：3 个 Bot 各完成 1 个图任务，runId `a2a-2f26bf48d97742cb8d1b6f0a0c31de29`、`a2a-2ad8136e1ca14213970741e750496bca`、`a2a-01de6c8de9d343a09ebf9732f13563c4`，trace 含 `trigger-1`/`tool-1` 真执行；证据 `../atlas/outputs/a02-a2a-real-run/evidence.json` | **✅ 真实 A2A 图 run；组织臂未接** | 是 Atlas 自有 A2A 面的真实 run，不是 Zeus 组织任务派发；未把 A2A 协议通过写成 Zeus 组织执行闭环 |
| `pr-helper` | PR 审查/合并技能 | ❌ 无组织执行臂；仅 A2A 调用 | A1 对线上 `pr-helper-ten.vercel.app` 真机扇出 15/15 exit 0：注册 201、名册 active、`PARAMS='{"owner":"jiangfeng","repo":"zeus"}'` 扇出、分支 `ok=1/1` 且有内容、审计 `dispatched` ×2、吊销断流；证据 `docs/pre-launch-checklist.md` A1 行、`docs/design-executor-protocol.md` §7 | **⬜ 明确未接业务执行（plan-only）** | `deployment-health-plan` 只产 plan；`execute` 需 Zeus 代理的 GitHub 凭据，未做不可逆写；不计业务完成 |
| `loom` | 内容产线执行 | ❌ 无组织执行臂；仅 A2A 调用 | A3 隔离真机栈 18/18 PASS exit 0：卡片契约、SSE、注册 201→名册 active、`generate-content` 扇出 completed、分支 `ok=1/1`、审计、吊销+reinstate；证据 `docs/pre-launch-checklist.md` A3 行、`docs/design-executor-protocol.md` §7A | **⬜ 明确未接业务执行（plan-only）** | loom 三个 skill 均为 plan-only，不触链、不花 token、不改 Gate；W2 生产栈未验收 |
| `job-agent` | 求职工具 | ❌ 无组织执行臂 | 仅 stdio MCP：`@jobagent/mcp` / `jobagent-mcp`，v0 明确不做远程 HTTP/SSE；证据 `handoff.md` 2026-10-25 协议面全量核查、`docs/product-portrait.md` §7.1 W3 | **⬜ 明确未接 A2A** | 不是 A2A 服务；不能按「MCP 可用」推定「矩阵可调度」 |
| `bayjf` | 展示站/公开名册配套 | ❌ 非执行产品 | 公开名册验签展示；A5 R2 四件套实测通过（2026-10-15） | **N/A（非执行臂）** | 展示站不参与执行臂矩阵 |

## 组织执行臂矩阵

`src/core/org/execution/router.ts` 当前只接受三类组织任务载荷：

| 执行臂 | 路由条件 | 真实 run | 状态 |
|---|---|---|---|
| 内置模板 | `payload.templateRef` | Z-02 的 goal 模板分解链路已跑；模板本身不独立产生外部 run | ✅ 内置臂在用工，未单列产品 run |
| `agent-world` | `payload.workflow` 或 `payload.system === "agent-world"` | Z-02 `144cbd02-…` | ✅ 真实 run |
| `agent-dev` | `payload.system === "agent-dev"` | F1.3 `6625249d-…` | ✅ 真实 run（历史记录） |

其余矩阵产品都没有 `system` 路由分支或 ToolInvoker 前缀；调用它们只能走通用 A2A/协议面，不是 Zeus 组织执行臂。

## 复现与复核入口

```bash
# agent-world 真实 run 证据（本仓）
sed -n '400,490p' outputs/z02-org-dogfood/05-tasks-final.json
cat outputs/z02-org-dogfood/10-summary.md
cat outputs/z02-org-dogfood/07-agent-world-run-timeline.json

# agent-dev 历史真实 run 记录（本仓 handoff）
rg -n "6625249d-3530-4a0d-9618-6b168895d257|f13-acceptance-0003" handoff.md

# atlas A2A 真实图 run（跨仓）
python3 -c "import json;d=json.load(open('../atlas/outputs/a02-a2a-real-run/evidence.json'));print(d['ok'],[(r['bot'],r['taskStatus'],r['runId']) for r in d['runs']])"

# pr-helper / loom 协议证据（本仓）
rg -n "A1|A3" docs/pre-launch-checklist.md
sed -n '/^## 7\./,/^## 8\./p' docs/design-executor-protocol.md
```

## 边界（不夸大）

1. 本项是**矩阵验收台账**，不是 W2 生产栈验收；atlas/loom 的真实 PG、密钥、审计、网关 TLS 仍未做。
2. `agent-world` 的 Z-02 run 是本机替身环境，`/api/health` 曾报 `jwtSecret=missing`，text/image 为 fake provider；证明的是调度/状态机/审批/执行臂闭环，不是线上内容质量。
3. `agent-dev` 真实 run 是 2026-11-17 的历史记录；仓库并入 agent-ops 后本轮没有重跑，不能声称「当前代码态复跑通过」。
4. `atlas` 是 A2A 真实图 run，不等于 Zeus 组织任务可通过 `system:"atlas"` 调度；后者明确未接。
5. `pr-helper`、`loom` 是 plan-only 真机协议联调，明确不计业务执行完成；后续要接 execute/业务 run 需要凭据代理或生产栈。
6. `job-agent` 只有 stdio MCP，未接 A2A；如要进矩阵需单独立项，不在本轮假装接通。
