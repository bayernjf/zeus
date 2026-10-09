# 自托管试点验收规程（v0.11，2026-10-08）

- 状态：**验收规程 v0.11（2026-10-08）**。P0-4 另有一条**不起服务进程的等价入口** `npm run daily`（Active work 147：一句话 → 意图 → 扇出 → 决策页写回目录，含四档反向对照与一条分裂正控）；同批 P0-4 的中文指令边界随 Active work 148 收窄——显式 `--model` 时词法零命中不再直接拒，整目录交给模型。P0 段今天可跑；**P1 的 `watch` 已落码、接进 boot，操作者 HTTP 面（Active work 139）与 TUI/Web 专属控件（Active work 140）全部就位**——HTTP：`POST/GET /api/watches`、`GET/DELETE /api/watches/:id`、`POST /api/watch-tick`（调用方驱动，内核不持定时器），生命周期动作（登记/停用/撤销）进审计脊；TUI：`wt` 手动驱动一次 tick、`w<n>` 撤销、deck 新增 watch 台账 section（登记因谓词/意图形状过宽仍走 HTTP 面）；Web：授权视图新增 watch 登记表单 + 台账表格 + 立即评估 + 撤销。P2 的内核链、HTTP 操作者面与 TUI/Web 控件也全部就位（设计稿 §7 六步全部完成）。P1/P2 作为操作者能力三通道（HTTP/TUI/Web）齐整，端到端长期试点待真实使用（§3 成功定义属使用期事项）。**P0 八步已于 2026-10-06 实跑全过**（证据：handoff Active work 138）；P1 的 tick 时六条判据均有对应测试（step 2/3 批次），本文件保留判据作为回归口径。
- 定位：回答"zeus 能不能被一个真实用户当作自己的 Agent 底座长期跑起来"。这不是设计稿，设计在 [design-self-host-loop.md](design-self-host-loop.md)（其 §7 六步实施表逐格记录各原语的真实落地进度）；本文件只有**命令、退出判据、证据位置**三样。
- 单一事实源：试点结论记在这里并同步 handoff 销项；PRD 与设计稿只索引本文件。

## 0. 一句话

P0 = **一个人、一个目录、一条日常技能、意图由人发起、execute 走一次性票据**——这一段的所有能力都已落地，可以立刻开跑。P1 加"无人在场时的合法意图来源"（`watch`），P2 加"有界的自主授权"（委托契约）。**P1 的原语与 HTTP 操作者面已通（TUI/Web 控件未做），P2 全部就位**；判据保留在此，是为了让后续实跑有可核口径。

## 1. 为什么只有 P0 能跑（出处）

内核**不内置定时器**，这是明文设计而不是遗漏（`src/vault/cli.ts:7-7 #scheduler`：备份的调度刻意留在内核外，交给外部 cron/systemd 调 CLI）。全仓计时器调用共 **5 处**（2026-10-05 现测，`grep -rnE "setTimeout|setInterval" src/`）：SSE 保活 `src/http/server.ts:2926-2896 #`、编排分支超时 `src/orchestrator/orchestrator.ts:1147-1147 #setTimeout`、派发受理超时 `src/dispatch/client.ts:103-103 #setTimeout`、决策后端调用超时 `src/decision/shared.ts:42-42 #setTimeout`、终端监督台轮询 `src/tui/cli.ts:95-95 #setInterval`。**这五处全都是给一次已经在进行的调用设上限，或界面自刷新；没有一处"到点自己发起意图"。**

同时，写侧一直被刻意压住：`execute` 必须携带一次性执行票据，闸门在派发路径上现算并核销（`src/orchestrator/orchestrator.ts:3-3 #verifyAndConsumeExecutionDelegation`，票据形状 `src/delegation/execution-delegation.ts:10-10 #ExecutionDelegation`，已花 nonce 持久化 `src/state/kernel-state.ts:148-148 #executionDelegationNonces`）。

**所以试点当前的正确形态就是"人发起 + 一次性票据"**——这不是缩水版，这恰好是能诚实交付的版本。

## 2. 阶段划分

| 阶段 | 需要什么 | 落地状态 | 本文件段落 |
| --- | --- | --- | --- |
| P0 人在环自托管 | 已落地的内核 + HTTP 面 + 执行票据 | ✅ 可跑（已实跑全过，Active work 138） | §3 |
| P1 无人到点 | `watch`（设计稿 §3） | 🟡 原语 + boot + HTTP 操作者面已实现（Active work 139），TUI/Web 专属控件未做 | §4 |
| P2 有界自主 | `DelegationContract`（设计稿 §4） | ✅ 全部就位（内核链 + HTTP 面 + TUI/Web 控件，设计稿六步全完成） | §5 |

企业形态（隔离实例 vs 同实例多租户）是本清单之外的**待决项**，登记在 [deferred-items.md](deferred-items.md) **#41**。本清单三段在两种形态下形状相同，所以不必先决定才能开跑 P0。

## 3. P0：现在就能跑（8 步）

前置：`npm install && npm run build`（Node ≥ 22，`.npmrc` 开了 `engine-strict`）。以下命令都在仓库根目录执行；所有路径均在用户机器上，正文不出域。

### P0-1 起一个属于一个人的进程

```sh
mkdir -p data secrets
node scripts/gen-rsk-key.mjs secrets/rsk-private.pem        # 会打印 jwkThumbprint，抄下来（带外固定用）
export ZEUS_HOST=127.0.0.1 ZEUS_PORT=8787
export ZEUS_INTERNAL_TOKEN="$(openssl rand -hex 32)"
export ZEUS_STATE_FILE=./data/kernel-state.json
export ZEUS_AUDIT_FILE=./data/audit.jsonl
export ZEUS_RSK_KEY_FILE=./secrets/rsk-private.pem ZEUS_RSK_KEY_ID=zeus-rsk-2026-09
export ZEUS_REALM_ROOTS="$HOME/Documents"                   # 一个本地目录就是数据底座
node dist/http/serve.js
```

- **退出判据**：进程不退出、无 `KernelBootError`；`curl -fsS http://127.0.0.1:8787/healthz` 返回 200。
- **证据位置**：stderr 的启动行；`secrets/rsk-private.pem` 权限 0600（`ls -l`）。
- **反向对照（必须跑一次，证明这一步能失败）**：`NODE_ENV=production` 且不给 `ZEUS_RSK_KEY`/`ZEUS_RSK_KEY_FILE` → 进程**拒绝启动**。这一步不报错就说明密钥闸门是装饰。

### P0-2 确认目录已挂载，且挂载视图不泄漏绝对路径

```sh
curl -fsS -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/domains | jq
```

- **退出判据**：`realms[]` 至少一条，字段只有 `realmId / type / tenant? / readOnly / itemCount / contentDigest`（代码级 `src/http/server.ts:2004-1983 #`——这个视图**不返回根目录字符串**）。
- **可执行断言**：把上面 JSON 存盘，`grep -c "$HOME/Documents" <file>` 必须为 **0**。这是"边界是目录，定位符只有 realmId + 根相对 itemId"的操作者侧核对（MCP 侧的实测口径见 [mcp-integration.md](mcp-integration.md) §1.4）。
- **现在跑不了的部分**：无。

### P0-3 接一个真实执行 Agent，并离线验一名册

```sh
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"cardUrl":"https://<你的 Agent>/api/a2a/agent-card"}' http://127.0.0.1:8787/api/vassals
npm run verify:roster -- --url http://127.0.0.1:8787/api/roster/public --key secrets/rsk-private.public.pem
```

- **退出判据**：注册返回 200/201 且 `GET /api/roster`（bearer）里该条目 `status=active`；`verify:roster` 退出码 **0**，报告里打印的 seal 指纹与 P0-1 抄下的 `jwkThumbprint` **逐字符相同**。
- **证据位置**：`verify:roster` 的输出（脚本自己就是"只需公钥即可验签"的实现）。
- **注意**：卡片缺归属字段会被拒收并点名缺哪个字段——被拒不是故障，是握手闸门在工作。

### P0-4 派发一条真实意图（plan 模式），并离线回放

```sh
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"skill":"<技能 id>","realm":"personal","subject":"<一件真实要做的事>"}' \
  http://127.0.0.1:8787/api/intents | jq '.id'
curl -fsS -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/intents/<id> | jq
curl -fsS -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/intents/<id>/replay | jq
```

- **退出判据**：意图进入终态；`replay` 能从持久化事实重建参与方、输入、立场、聚合结果，不需要再打一次网。
- **证据位置**：`GET /api/audit?runId=<id>`。
- **同一命令再发一次**（同 `intentId` 幂等）应命中幂等表而不是重派——这是"可重放"的正向对照。
- **一条命令的等价物**（真机 A1 验收，逐步打印实测到的状态码与计数，可直接当证据贴）：
  ```sh
  KERNEL_URL=http://127.0.0.1:8787 ZEUS_INTERNAL_TOKEN="$ZEUS_INTERNAL_TOKEN" \
  CARD_URL=https://<你的 Agent>/api/a2a/agent-card [AGENT_TOKEN=…] SKILL=<技能 id> \
  npm run acceptance:fanout
  ```
  它把"注册真 Agent → 驱动一次扇出 → 离线验名册"三段连起来；对端卡片声明的 `dataRealms` 与 `REALM` 不匹配会被拒（这是 fealty 边界，不是脚本故障）；`--revoke-test` 会真的 `DELETE` 那个条目并断言它立刻从公开名册消失，**且不会自动恢复**——要恢复得自己再调 `POST /api/vassals/:name/reinstate`（`src/http/server.ts:611-590 #`）。共用部署上不要带它。
- **不起服务进程的等价物**（同一条链路的入口形态，2026-10-08 Active work 147 新增）：不常驻、不占端口、不用 bearer，一句话直接走完「意图 → 扇出 → 决策与依据 → 写回目录」。

  ```sh
  npm run build && npm run daily -- --root <你的目录> \
    --agent https://<你的 Agent>/api/a2a/agent-card "check the deployment health"
  ```

  进程内 `bootKernel` 装配（`src/daily/cli.ts` + 纯渲染 `src/daily/report.ts`）：终端打出的那一页 markdown 与 `Realm.write` 落进 `--root` 的那一页**逐字节相同**（`--record` 定路径，默认 `zeus-daily/<时间戳>-<技能>.md`），结束时 `saveState()` 把这次的意图与升级项落进状态文件。退出码 0/1/2：0 = 页面已产出并落盘（含"分裂等人裁决"这种没结论的结局）；1 = 无可派发内容、无 Agent 送达、或写回失败；2 = 配置/用法错误（什么都没派发）。
  - **一条必须能失败的对照**（2026-10-08 本机真进程实测）：`--skill <没人广告的技能>` → 退出 1、stderr 说明"没有注册 Agent 提供该技能"，而页面仍然落盘（失败证据也是证据）；`--agent http://127.0.0.1:1/…` → 退出 2 并给 `vassal seed failed for <url>`；`--root <不存在的目录>` → 退出 2（`realm root not accessible`）；不带 `--root` 且 env 无挂载 → 退出 2 并给补目录的下一步。**这四档任一被静默吞掉，入口就是在骗人**。
  - **正控**：两个 Agent 立场分裂时，该命令必须给出 `needs-driver` 与一条 `intent-conflict` 升级项，并且那个 escalation id 与 intentId 在状态文件里查得到——否则「等待人工裁决」这一整段就从没被这条命令执行过。
  - **当前的真实边界（不掩饰）**：本地规则那条路仍按字面重合评分（ASCII 词与 CJK 连续段），**中文指令对英文技能目录给不出候选**，入口按 `no-candidates` 退出 1 且不写文件。自 2026-10-08 起，显式 `--model` 且配了决策后端时这条路不再死在这里：词法零命中就把整个目录（按 id 定序、上限 30 条）交给模型选，页面同时写明"排序器没有字面命中、由模型在整目录中选"。**没配后端就仍然零出域**——这条边界一次都没被越过。

### P0-5 让一次冲突真的走人工裁决

不必制造冲突也能验管道：`GET /api/escalations` 列出队列，若为空则**这一步的判据改为"队列为空且不是因为队列没挂载"**——`ZEUS_AUDIT_FILE` 未配置时 `GET /api/audit` 整组不挂载，属于配置缺陷，不是"没有升级"。

```sh
curl -fsS -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/escalations | jq '.[] | {id, kind}'
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/escalations/<id>/approve | jq
```

- **退出判据**：approve 后 `GET /api/intents/<id>/replay` 里出现人工裁决行（`src/http/server.ts:903-881 #` 把裁决回交编排器）。
- **证据位置**：`GET /api/audit?decision=<裁决类决策名>`（`decision` 只接受登记过的枚举，传别的会 400 并列出全集 `src/http/server.ts:1958-1937 #`）。

### P0-6 execute 一次，用真票据

手工链路（判据与脚本一致）：

```sh
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"grantedBy":"<用户标识>","skill":"<技能 id>","capabilities":["<权限声明>"],"ttlSeconds":600}' \
  http://127.0.0.1:8787/api/execution-delegations | jq '.delegation'      # 路由与签发：src/http/server.ts:1841-1875 #issueExecutionDelegation
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"skill":"<技能 id>","realm":"personal","subject":"<要真做的事>","mode":"execute","executionDelegation":<上面那个对象>}' \
  http://127.0.0.1:8787/api/intents | jq '.id'
```

- **退出判据（四条，缺一不算过）**：
  1. 不带票据的 `mode:"execute"` 被拒，且**出站请求数为 0**；
  2. 带票据派发到一次，对端 Agent 真收到请求；
  3. **同一票据重放第二次被拒**（nonce 一次性，核销点 `src/delegation/execution-delegation.ts:269-269 #replayed`）；
  4. 两次拒绝都有审计记录（`decision=execution-delegation-*`）。
- **证据位置**：`npm run verify:execute-delegation` 把这六段（起进程 → 真 socket 注册 → 无票据被拒且零出站 → 真签发 → 带票据派发一次 → 重放被拒 → 拒单入审计）钉成了 PASS/FAIL 步骤，跑它等于把上面四条一次过完；退出码 0 才是过。
- **口径提醒**：票据是**执行准入**，不是凭据代理。执行 Agent 拿用户身份做不可逆操作仍受 deferred **#33** 限制（见 [design-execution-delegation.md](design-execution-delegation.md)）；试点期请把 execute 限制在"可逆动作"内，并把这条写进使用者的预期。

### P0-7 真重启一次，不丢状态

```sh
export ZEUS_VAULT_PASSPHRASE='<只存在于环境里的口令>'          # 或改用 --key-file <32 字节或 64 hex>
npm run vault -- backup  --root "$HOME/Documents" --out-dir data/bundles
#   ↑ 一条命令同时产出 data/bundles/<stem>.map.json（清单图，只含引用与指纹）
#                    和 data/bundles/<stem>.bundle.json（AES-256-GCM 加密全包）
npm run vault -- check   --map data/bundles/<stem>.map.json
kill <serve PID>            # 只杀自己启动的那个进程
node dist/http/serve.js     # 同环境重启
# 跨位置恢复（试点期至少真跑一次）：
npm run vault -- restore --map data/bundles/<stem>.map.json \
                         --bundle data/bundles/<stem>.bundle.json \
                         --target /tmp/zeus-restore-check
```

- **退出判据（四条）**：
  1. 重启后 `GET /api/roster` 里 P0-3 那个 Agent 仍在册（注册表进快照）；
  2. 重启后 P0-2 那个 realm 自动重连（连接关系写进状态文件，`ZEUS_REALM_ROOTS` 只在首次需要）；
  3. **P0-6 已花掉的票据重放仍被拒**——已花 nonce 跨重启有效（导出 `src/state/kernel-state.ts:148-148 #executionDelegationNonces`、回灌 `src/state/kernel-state.ts:169-169 #executionDelegationNonces`）；
  4. `vault check` 退出码 **0**（无漂移）；把目录里任一被收录文件改一个字节再跑，退出码必须是 **2**（漂移档位 `src/vault/cli.ts:208-208 #drift`，四档定义 `src/vault/cli.ts:44-44 #VAULT_EXIT`），根目录整个不可达则是 **3**。这一步的正向对照就是"改一个字节"——不红就说明 check 是空转。四个子命令的标志形状以 `src/vault/cli.ts:16-16 #restore` 的用法块为准。
- **备份调度在内核外**：cron/systemd 调 `npm run vault -- ...` 即可（`src/vault/cli.ts:7-7 #scheduler`）。试点期至少要跑一次**异地恢复**：`vault restore` 到另一个位置，然后 `vault check` 指过去。

### P0-8 人怎么看：两个操作面都开过

```sh
ZEUS_INTERNAL_TOKEN="$ZEUS_INTERNAL_TOKEN" npm run tui -- --interval 3000
# 或：ZEUS_CORS_ORIGINS=http://127.0.0.1:5173 node dist/http/serve.js + python -m http.server 5173 --directory web
```

- **退出判据**：能在监督台上看到 P0-4 那条意图的时间线，并完成一次 `a<n>` 批准或 `s<n>.<m>` 裁决；操作后 `GET /api/audit` 有新行。
- **证据位置**：审计流里的操作者动作；TUI 不落盘令牌（复用既有 bearer 面，不新增内核路由）。

### P0 的成功定义（跑完 8 步之后才算开始）

| 判据 | 怎么核 |
| --- | --- |
| 连续 **14 天**真实使用，每天 ≥1 条真实意图 | 按天回读 `GET /api/audit`（不是构造流量） |
| 正文零出域 | 全程不配 `ZEUS_DECISION_*` / `ZEUS_LLM_*`（此时内核是 rules-only，`GET /api/decision` 可证），并抽查派发侧脱敏后的出站体 |
| 每次 execute 都有票据、都有审计、都没有重放成功 | P0-6 四条判据在整个试点期天天成立 |
| 至少一次真实重启 + 一次真实跨位置恢复 | P0-7 四条 |
| 升级队列被真人处理过，且处理留痕 | P0-5 + `GET /api/escalations` 无长期堆积 |
| 用户说得出"它能替我做什么、不能做什么" | 记在本文件 §7，不记在文档里 |

**任何一条不成立 → 不升级 P1**，先修 P0 的那一条。理由：P1 引入"无人在场的意图来源"，会把 P0 的每个薄弱点从"偶尔发生"变成"每天自动发生"。

## 4. P1：无人到点（`watch`——原语 + boot + HTTP 操作者面已通，TUI/Web 控件未做）

前置能力：`watch` 原语（设计 [design-self-host-loop.md](design-self-host-loop.md) §3）。原语已落码、接进 boot（step 2/3 批次），操作者 HTTP 面于 Active work 139 落地。

**开工闸门探针（已翻转）**：

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:8787/api/watches
```

- **现状**：空体返回 **400**（路由已挂载、校验入参），合法体返回 **201**。代码级同证：`src/http/` 下命中 5 条 watch 路由注册（2026-10-06 测得）。探针的原始形态（预期 404）随 Active work 139 关闭；保留命令作为回归口径——若端点退回 404，说明面被整体拆掉。

tick 时判据（逐条要有对应测试，不接受"看起来对"；均已在 step 2/3 批次落地）：

| # | 判据 | 反证（必须能把它做红） |
| --- | --- | --- |
| 1 | 注册一条 watch 到点真的命中谓词并发起一条意图，意图在 `GET /api/audit` 里可辨认出来源是 watch | 把 `expiresAt` 设成过去 → 必须**不发起** |
| 2 | `budget.fires` 耗尽后自动 `enabled=false` 并审计 `watch-auto-disabled` | 预算设 1、连发两次命中 → 第二次必须被拒且有审计 |
| 3 | 谓词源只能取 `metrics` / `realm` / `connector` 三类，其他字符串在**注册时**就 400 | 注册 `source.kind:'shell'` → 必须 400 而非静默忽略 |
| 4 | 评估失败（连接器不可达）不触发意图，按阈值自动禁用 | 拔掉数据源再等到点 → 意图数不变，且审计有 `watch-eval-unavailable` |
| 5 | watch 进内核快照，重启后 `lastFiredAt`/`budget.used` 不重置 | 重启后 `GET` 回来的计数必须等于重启前 |
| 6 | `mode:'execute'` 的 watch 无票据时**到点即失败并升级**，不是静默跳过 | 建一条 execute 型 watch 且不给 `delegationId` → 必须落到升级台 |

## 5. P2：有界自主（`DelegationContract`——内核侧 + HTTP 操作者面已通，TUI/Web 专属控件与 smoke 未做）

前置能力：委托契约（设计稿 §4）。内核链已在真进程打通：execute 型 watch 在条件成立时从命名契约派生一次性子票据，票据过既有 execute gate 后真派发；无契约 / 无签名者 / 撞任一上限 → 零出站 + desk 一条 `delegation-limit`（证据：`tests/boot-watch-execution.test.ts` 三条真进程用例，设计稿 §7 第 4 步）。第 5 步 HTTP 半已落地（设计稿 §7 第 5 步）：操作者可经 bearer 面自助签发 / 列表 / 读 / 撤销契约（`POST/GET/DELETE /api/delegation-contracts`），desk 上一条 delegation-limit 可用 `POST /api/escalations/:id/approve-contract` 一键签一份**仅覆盖 `execute`** 的新契约并换绑命名 watch（不重放被拒 fire，下一 tick 重新判条件）。证据：`tests/http-delegation-contracts.test.ts` 9 例。**TUI/Web 专属控件与 `smoke:core` 增步仍未做**——当前只能经通用 HTTP 面操作，故端到端试点仍待第 5 步剩余与第 6 步。

**开工闸门探针（已翻转）**：`curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:8787/api/delegation-contracts` → 现预期 **400**（路由已挂载，空体被拒；2026-10-05 测得）。带合法体（`grantedBy` / `skill` / `capabilities:["execute"]` / 正整数 `limits` / 未来的 `windowEndsAt`）同端点返回 **201**——该端点由“未实现 404”翻转为“已挂载、校验入参 400”，即第 5 步 HTTP 半开工闸门已过；代码级同证 `grep -rn "api/delegation-contracts" src/http/` 现命中 5 条路由注册。

落地后的判据：

| # | 判据 | 反证 |
| --- | --- | --- |
| 1 | 第 `maxChildTickets+1` 张子票据被拒，并审计 `delegation-limit-exceeded` | 上限设 2，发 3 次 → 第三次必须红 |
| 2 | `windowEndsAt` 之后新子票据一律被拒 | 窗口设 1 秒，等到点再发 → 必须红 |
| 3 | 撤销一份契约后，其下所有未消费票据立即不可用 | 撤销前后各发一次同一票据 → 后者必须红 |
| 4 | 超限不静默：走既有升级台等待人工放行（`src/oversight/oversight.ts:170-170 #ingestDelegationLimit`、boot 接线 `src/state/boot.ts:975-975 #escalateLimit`） | 制造超限 → `GET /api/escalations` 必须能看到那条；内核侧已由 `tests/boot-watch-execution.test.ts` 证明，HTTP 回读待第 5 步 |
| 5 | 子票据的 `used` 计数持久化，重启不重置 | 重启后打到上限 → 必须仍然拒 |

## 6. 现在明确不要做的事（写下来防止顺手做掉）

- 不引入表达式语言或规则 DSL——谓词形状由结构限定（设计稿的非目标清单同此）。
- 不引入第四个能力接入通道；`watch` 的数据源必须落进 MCP / Skill / A2A 之一（设计约束 3）。
- 不在试点期把 P1/P2 的实现和"企业多租户"混做——后者是 #41 待决项，形状未定。
- 不为了让 §3 好看而造流量：试点数据必须来自真实使用，否则 §3 的成功定义全部失真。

## 7. 试点结论文档化要求（销项口径）

跑完后在本文件追加一节「实测记录」，至少写清：实际跑天数、意图条数（`GET /api/audit` 回读口径）、execute 次数与票据是否一一对应、重启与恢复各跑过几次、哪几条判据当时不成立、用户原话描述的"能/不能"。然后 handoff 记销项日期。

## 演进日志

- **v0.11（2026-10-08）**：P0-4 的中文指令边界收窄（Active work 148）。`recognizeIntent` 原先在排序器零词法命中时就返回 `no-candidates`，**咨询请求还没发出去**——显式 `--model` 也一样，于是中文用户配了后端仍然用不上。现在后端在场且被显式要求时，零命中改为把整个技能目录（按 id 定序、上限 30）作为 options 交给模型；本地规则那条路一字未改，没配后端仍然零出域。规程里那条"真实边界"随之改写。实测：同一条中文指令不带 `--model` 仍 exit 1 / `no-candidates`，带 `--model` 走回环 OpenAI 兼容端点 exit 0 且页面写明"由模型在整目录中选"（`Options: deployment-health | research` 为对端实收）。

- **v0.10（2026-10-08）**：P0-4 增加**不起服务进程的等价物**一条命令（Active work 147，`npm run daily`）：进程内 `bootKernel` 装配，把「一句话 → 意图 → 扇出 → 决策与依据 → 写回用户目录 → 落台账」合成单个入口，判据不变、原 `acceptance:fanout` 一段不动。新增该命令自己的四档反向对照（无人广告的技能 / 卡片不可达 / 目录不存在 / 无挂载）与一条正控（两 Agent 立场分裂必须产出 `needs-driver` 与可在状态文件检出的升级项），并把一条真实边界写进规程而不是留在测试里：`rankCandidates` 的字面重合使**中文指令匹配不到英文技能目录**，入口只让这种失败可读、可自救（打印目录 + `--skill` 出口），未改排序器。

- **v0.9（2026-10-06）**：P1 的 TUI/Web watch 专属控件落地（Active work 140），P1 从“操作者 HTTP 面已通、专属控件未做”改为三通道齐整：TUI 加 `wt`（调用方驱动一次评估 tick）/`w<n>`（撤销）与 watch 台账 section，Web 授权视图加 watch 登记表单/台账/立即评估/撤销；零新内核路由、零私有逻辑，全部消费 Active work 139 的 HTTP 面。判据与探针零改动（tick 六判据仍由 step 2/3 用例与 smoke 42 步守护）。


- **v0.8（2026-10-06）**：P1 的操作者 HTTP 面落地（Active work 139）——五条 watch 路由（`POST`/`GET /api/watches`、`GET`/`DELETE /api/watches/:id`、`POST /api/watch-tick`），watch 生命周期动作进审计脊（三个新决策名），开工探针由 404 翻转为空体 400 / 合法体 201；P1 仅剩 TUI/Web 专属控件。
- **v0.7（2026-10-06）**：P0 八步实跑全过并记录（Active work 138）；跑中修掉两条装配缺陷（serve 未传 oversightAudit → desk 审计默认进脊，三个新决策名入枚举；TUI client 空 body POST 被真 Fastify 400 → 恒发 JSON body）。判据与探针零改动。
- **v0.6（2026-10-06）**：设计稿 §7 第 5 步 TUI/Web 控件收尾（TUI 契约命令 + Web 契约面板），六步全部完成；本规程判据与探针零改动。
- **v0.5（2026-10-06）**：设计稿 §7 第 6 步落地，`npm run smoke:core` 37 → 40 步（serve 真进程契约操作面装配探针、watch 命中恰一次真派发、execute watch 契约派生与撤销断流；watch 由导入 dist 的 runner 子进程驱动）。本规程的判据与探针无一改动——P2 的开工闸门探针（空体 400 / 合法体 201）维持现状。
- **v0.4（2026-10-05）**：设计稿 §7 第 5 步 HTTP 半落地，P2 从“内核侧已通、操作者签发面未做”改为“内核侧 + HTTP 操作者面已通”：契约签发/列表/读/撤销在 `POST/GET/DELETE /api/delegation-contracts`（签发与撤销进审计脊，撤销即刻阻断派生），越限升级项可经 `POST /api/escalations/:id/approve-contract` 一键签一份仅 `execute` 的新契约并换绑 watch，不重放被拒 fire。开工闸门探针由 404 翻转为：空体 400、合法体 201；代码级同证改为 `src/http/` 下命中 5 条路由注册。真进程 HTTP 证据 9 例在 `tests/http-delegation-contracts.test.ts`。TUI/Web 专属控件与第 6 步 smoke 增步仍未做，端到端试点尚不能跑。
- **v0.3（2026-10-05）**：设计稿 §7 第 4 步落地，P2 从"未实现"改为"内核侧已实现、用户面未实现"：execute 型 watch 的契约派生、execute gate、越限零出站 + `delegation-limit` 升级、升级幂等与重启重放均在真进程用例中证明；但契约签发 HTTP/TUI 面（第 5 步）未做，§5 的操作者级验收仍跑不了，开工闸门探针由 404 与路由 grep 双重守住。第 4 条判据的代码同证从冲突升级接线改为委托越限接线。
- **v0.1（2026-10-05）**：首版。P0 八步全部锚到已落地命令/端点（含每步的反向对照）；P1/P2 只立判据并各附一条现在就应失败的探针，作为能力开工闸门；§1 用 `src/vault/cli.ts:7-7 #scheduler` 的原文把"没有调度器"从推测改成明文设计。
