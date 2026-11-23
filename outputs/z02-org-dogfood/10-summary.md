# Z-02 本机单人三岗位组织 dogfood 证据（2026-11-23）

## 结论

Z-02 已在本机独立 Zeus 实例（`127.0.0.1:8897`，独立 SQLite）上跑通一次真实组织执行：

- 组织 `org:z02-bayjf`，3 个部门、3 个岗位（运营 / 开发 / 内容），agent 均已绑定。
- 周期性调度器在 2026-11-23T02:13:38Z（排定 02:13Z 的下一 tick）实际展开 5 个周任务。
- 运营岗完成「采集周报数据 → 汇总周报 → 人工复核周报」全链（D2 checkpoint 经人工批准后 done）。
- 内容岗通过 agent-world 执行臂完成一次真实 run（`runId 144cbd02-4ef5-45f2-b034-a1cb37d44dee`，8 个节点全部 done），生成内容草稿任务 done。
- 开发岗承担内容审核复核任务（`task-mwsn2d4k-excg0`），产生 D2 决策 `dec_mwsn2fsj_2`，人工批准后 done。
- 三岗位均有实际 assignedAgentId 与任务结算记录，Z-02「三个岗位都实际参与」成立。

## 初始失败与根因

调度器首次展开的 `task-mwsmtcso-52wnj`（生成内容草稿）失败：

```
agent-world POST /api/runs failed (422)
```

根因：内容图模板 `tpl-xiaohongshu` 的两个 imageGen 节点（「AI 配图」banner-eg56h、「AI 场景图」scene-krxgq）模型槽为空，且 agent-world 账号没有图片模型。`defaultModelForModality` 只从 `modelOrder` 中挑选「provider enabled 且 models 认领」的条目，早期只 PUT providers、未同步 `modelOrder`，因此 422 未解。

修复：向本地 agent-world 账号写入 `z02-fake-text`（model `fake`，text）与 `z02-fake-image`（model `z02-fake-image`，image）两个 fake provider，并把二者写入 `modelOrder`、设 `defaultModel=fake`。随后手动 run 8/8 done，证明执行链本身可用。

## 补跑与替代

- 失败任务不可再次 claim（`claim` 只接受 pending），因此新建补跑任务：
  - `task-mwsn1314-cavdi`「生成内容草稿（补跑）」→ agent-world `runId 144cbd02…`、`graphId f2b91605…`、`graphName zeus-content-z02-r2`，done，耗时 2078ms。
  - `task-mwsn2d4k-excg0`「人工审核内容（开发岗复核）」依赖上述补跑任务，由开发岗 `agent:z02-dev` 执行 → awaiting_decision（`dec_mwsn2fsj_2`）→ 人工 approve → done。
- 首次失败的 `task-mwsmtcso-52wnj` 与其依赖的 `task-mwsmtcsp-6jv1f` 保留为失败/阻塞历史证据，不删除、不改写。

## 模型口径说明（重要）

本次 agent-world run 的 textGen 与 imageGen 均使用本地 `fake` provider：文本为合成占位，图片为 69 字节占位 PNG。真实的是组织调度、任务状态机、D2 决策链、agent-world HTTP 执行臂、图实例化与 run 生命周期；不是真实内容质量，也未调用真实 Ark 文本模型完成全链（此前用真实 Ark 时「笔记排版」节点曾 HTTP 400，说明真实文本模型可用但模板参数/长度仍需调）。

## 其他运行事实

- agent-world `/api/health` 返回 `ok:false`，原因是 `checks.jwtSecret="missing"`；本地单机登录与执行不受影响，但属于部署级配置缺口。
- Zeus 服务日志确认 `taskExecutor:"routed"`、`arms:["agent-world","template"]`、`org-scheduler assembled intervalMs 60000 UTC execution worker`。
- 调度器只在排定分钟之后的下一 tick 创建 occurrence；02:13Z 的任务实际在 02:13:38Z 落库，02:15:38Z 人工复核任务被投递。
- 内容岗执行臂耗时 2 秒；fake 模型使本证据可重复，但内容产物不可用于业务发布。

## 证据文件

- `01-organizations.json` / `02-departments.json` / `03-positions.json`：组织、部门、岗位与绑定 agent。
- `04-goals.json`：两个周 goal 与排班（02:13Z，周一）。
- `05-tasks-final.json`：全部 7 个任务的完整状态、依赖、决策与结算。
- `06-decisions.json`：两条 D2 决策（人工复核周报、开发岗复核内容）。
- `07-agent-world-run-timeline.json`：补跑 run 的 8 节点时间线。
- `08-agent-world-artifacts.json`：该 run 的产物清单（含 fake 占位图与文本 artifact）。
- `09-agent-world-settings.json`：脱敏后的模型 provider / modelOrder 配置（无密钥）。
