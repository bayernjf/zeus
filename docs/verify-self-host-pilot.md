# 自托管试点验收规程（v0.1，2026-10-05）

- 状态：**验收规程 v0.1（2026-10-05）**。P0 段今天可跑；P1/P2 段是**预先写好的判据**，能力未落地，跑不了——每条都附"现在就能跑的证伪探针"。
- 定位：回答"zeus 能不能被一个真实用户当作自己的 Agent 底座长期跑起来"。这不是设计稿，设计在 [design-self-host-loop.md](design-self-host-loop.md)；本文件只有**命令、退出判据、证据位置**三样。
- 单一事实源：试点结论记在这里并同步 handoff 销项；PRD 与设计稿只索引本文件。

## 0. 一句话

P0 = **一个人、一个目录、一条日常技能、意图由人发起、execute 走一次性票据**——这一段的所有能力都已落地，可以立刻开跑。P1 加"无人在场时的合法意图来源"（`watch`），P2 加"有界的自主授权"（委托契约）。**P1/P2 的判据先写出来，是为了让它们可验收，不是为了现在通过。**

## 1. 为什么只有 P0 能跑（出处）

内核**不内置定时器**，这是明文设计而不是遗漏（`src/vault/cli.ts:6-8 #scheduler`：备份的调度刻意留在内核外，交给外部 cron/systemd 调 CLI）。全仓计时器调用共 **5 处**（2026-10-05 现测，`grep -rnE "setTimeout|setInterval" src/`）：SSE 保活 `src/http/server.ts:2329 #keepalive`、编排分支超时 `src/orchestrator/orchestrator.ts:710-716 #setTimeout`、派发受理超时 `src/dispatch/client.ts:93 #setTimeout`、决策后端调用超时 `src/decision/shared.ts:42 #setTimeout`、终端监督台轮询 `src/tui/cli.ts:95 #setInterval`。**这五处全都是给一次已经在进行的调用设上限，或界面自刷新；没有一处"到点自己发起意图"。**

同时，写侧一直被刻意压住：`execute` 必须携带一次性执行票据，闸门在派发路径上现算并核销（`src/orchestrator/orchestrator.ts:665-682 #verifyAndConsumeExecutionDelegation`，票据形状 `src/delegation/execution-delegation.ts:10-32 #ExecutionDelegation`，已花 nonce 持久化 `src/state/kernel-state.ts:124 #executionDelegationNonces`）。

**所以试点当前的正确形态就是"人发起 + 一次性票据"**——这不是缩水版，这恰好是能诚实交付的版本。

## 2. 阶段划分

| 阶段 | 需要什么 | 落地状态 | 本文件段落 |
| --- | --- | --- | --- |
| P0 人在环自托管 | 已落地的内核 + HTTP 面 + 执行票据 | ✅ 可跑 | §3 |
| P1 无人到点 | `watch`（设计稿 §2.1，未实现） | ❌ 未实现 | §4 |
| P2 有界自主 | `DelegationContract`（设计稿 §2.2，未实现） | ❌ 未实现 | §5 |

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

- **退出判据**：`realms[]` 至少一条，字段只有 `realmId / type / tenant? / readOnly / itemCount / contentDigest`（代码级 `src/http/server.ts:1645-1660 #contentDigest`——这个视图**不返回根目录字符串**）。
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
  它把"注册真 Agent → 驱动一次扇出 → 离线验名册"三段连起来；对端卡片声明的 `dataRealms` 与 `REALM` 不匹配会被拒（这是 fealty 边界，不是脚本故障）；`--revoke-test` 会真的 `DELETE` 那个条目并断言它立刻从公开名册消失，**且不会自动恢复**——要恢复得自己再调 `POST /api/vassals/:name/reinstate`（`src/http/server.ts:368 #reinstate`）。共用部署上不要带它。

### P0-5 让一次冲突真的走人工裁决

不必制造冲突也能验管道：`GET /api/escalations` 列出队列，若为空则**这一步的判据改为"队列为空且不是因为队列没挂载"**——`ZEUS_AUDIT_FILE` 未配置时 `GET /api/audit` 整组不挂载，属于配置缺陷，不是"没有升级"。

```sh
curl -fsS -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/escalations | jq '.[] | {id, kind}'
curl -fsS -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" http://127.0.0.1:8787/api/escalations/<id>/approve | jq
```

- **退出判据**：approve 后 `GET /api/intents/<id>/replay` 里出现人工裁决行（`src/http/server.ts:641-647 #approve` 把裁决回交编排器）。
- **证据位置**：`GET /api/audit?decision=<裁决类决策名>`（`decision` 只接受登记过的枚举，传别的会 400 并列出全集 `src/http/server.ts:1605-1611 #AUDIT_DECISIONS`）。

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
  3. **同一票据重放第二次被拒**（nonce 一次性，核销点 `src/delegation/execution-delegation.ts:269 #replayed`）；
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
  3. **P0-6 已花掉的票据重放仍被拒**——已花 nonce 跨重启有效（导出 `src/state/kernel-state.ts:124 #executionDelegationNonces`、回灌 `src/state/kernel-state.ts:142-144 #executionDelegationNonces`）；
  4. `vault check` 退出码 **0**（无漂移）；把目录里任一被收录文件改一个字节再跑，退出码必须是 **2**（漂移档位 `src/vault/cli.ts:206-210 #drift`，四档定义 `src/vault/cli.ts:44 #VAULT_EXIT`），根目录整个不可达则是 **3**。这一步的正向对照就是"改一个字节"——不红就说明 check 是空转。四个子命令的标志形状以 `src/vault/cli.ts:10-23 #restore` 的用法块为准。
- **备份调度在内核外**：cron/systemd 调 `npm run vault -- ...` 即可（`src/vault/cli.ts:6-8 #scheduler`）。试点期至少要跑一次**异地恢复**：`vault restore` 到另一个位置，然后 `vault check` 指过去。

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

## 4. P1：无人到点（`watch`，未实现——判据先立）

前置能力：`watch` 原语（设计 [design-self-host-loop.md](design-self-host-loop.md) §2.1）。**现在跑不了。**

**现在就能跑的证伪探针（预期失败，且必须失败）**：

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:8787/api/watches
```

- **退出判据**：返回 **404**。代码级同证：全仓 `grep -rn "'/api/watch" src/` 命中 **0**（2026-10-05 测得）。这条探针的价值是"当它不再返回 404 时，P1 才算开工"，也是 P1 的落地闸门——先让它变红（404→201），再谈下面的验收。

`watch` 落地后的判据（逐条要有对应测试，不接受"看起来对"）：

| # | 判据 | 反证（必须能把它做红） |
| --- | --- | --- |
| 1 | 注册一条 watch 到点真的命中谓词并发起一条意图，意图在 `GET /api/audit` 里可辨认出来源是 watch | 把 `expiresAt` 设成过去 → 必须**不发起** |
| 2 | `budget.fires` 耗尽后自动 `enabled=false` 并审计 `watch-auto-disabled` | 预算设 1、连发两次命中 → 第二次必须被拒且有审计 |
| 3 | 谓词源只能取 `metrics` / `realm` / `connector` 三类，其他字符串在**注册时**就 400 | 注册 `source.kind:'shell'` → 必须 400 而非静默忽略 |
| 4 | 评估失败（连接器不可达）不触发意图，按阈值自动禁用 | 拔掉数据源再等到点 → 意图数不变，且审计有 `watch-eval-unavailable` |
| 5 | watch 进内核快照，重启后 `lastFiredAt`/`budget.used` 不重置 | 重启后 `GET` 回来的计数必须等于重启前 |
| 6 | `mode:'execute'` 的 watch 无票据时**到点即失败并升级**，不是静默跳过 | 建一条 execute 型 watch 且不给 `delegationId` → 必须落到升级台 |

## 5. P2：有界自主（`DelegationContract`，未实现——判据先立）

前置能力：委托契约（设计稿 §2.2）。**现在跑不了。**

**证伪探针**：`curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ZEUS_INTERNAL_TOKEN" -d '{}' http://127.0.0.1:8787/api/delegation-contracts` → 预期 **404**；代码级同证：全仓 `grep -rn "DelegationContract" src/` 命中 **0**（2026-10-05 测得）。

落地后的判据：

| # | 判据 | 反证 |
| --- | --- | --- |
| 1 | 第 `maxChildTickets+1` 张子票据被拒，并审计 `delegation-limit-exceeded` | 上限设 2，发 3 次 → 第三次必须红 |
| 2 | `windowEndsAt` 之后新子票据一律被拒 | 窗口设 1 秒，等到点再发 → 必须红 |
| 3 | 撤销一份契约后，其下所有未消费票据立即不可用 | 撤销前后各发一次同一票据 → 后者必须红 |
| 4 | 超限不静默：走既有升级台等待人工放行（`src/state/boot.ts:46-51 #conflictsToDesk`、`src/http/server.ts:641-647 #approve`） | 制造超限 → `GET /api/escalations` 必须能看到那条 |
| 5 | 子票据的 `used` 计数持久化，重启不重置 | 重启后打到上限 → 必须仍然拒 |

## 6. 现在明确不要做的事（写下来防止顺手做掉）

- 不引入表达式语言或规则 DSL——谓词形状由结构限定（设计稿的非目标清单同此）。
- 不引入第四个能力接入通道；`watch` 的数据源必须落进 MCP / Skill / A2A 之一（设计约束 3）。
- 不在试点期把 P1/P2 的实现和"企业多租户"混做——后者是 #41 待决项，形状未定。
- 不为了让 §3 好看而造流量：试点数据必须来自真实使用，否则 §3 的成功定义全部失真。

## 7. 试点结论文档化要求（销项口径）

跑完后在本文件追加一节「实测记录」，至少写清：实际跑天数、意图条数（`GET /api/audit` 回读口径）、execute 次数与票据是否一一对应、重启与恢复各跑过几次、哪几条判据当时不成立、用户原话描述的"能/不能"。然后 handoff 记销项日期。

## 演进日志

- **v0.1（2026-10-05）**：首版。P0 八步全部锚到已落地命令/端点（含每步的反向对照）；P1/P2 只立判据并各附一条现在就应失败的探针，作为能力开工闸门；§1 用 `src/vault/cli.ts:6-8 #scheduler` 的原文把"没有调度器"从推测改成明文设计。
