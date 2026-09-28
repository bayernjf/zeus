# 上线前 Checklist（Pre-launch Checklist）

- 关联：项目级评审单一事实源 [review-mvp-2026-09.md](review-mvp-2026-09.md)；deferred 项清单 [deferred-items.md](deferred-items.md)；部署面 [deployment.md](deployment.md)；容量基线 [capacity-baseline.md](capacity-baseline.md)。
- **判定（评审 v0.19 下的判；下面两行的计数是活基线，每批现测更新，量法见 §F-3）**：
  - **产品核心「完全可用」MVP：✅ 达成**（库内核 + 制品就绪，三条接入通道执行点在位且装配到真进程路径，全量 790 测试 / 83 文件绿且 `npm test` 退出码 0、typecheck/build 过、核心链路冒烟 36/36（v0.19 复核时为 35/35，其后 Active work 69 增"DAG 驾驶员入口已装配"一步）；P0 26/26 为逐行机械计数，签名链五条对照与部署镜像实构实跑均用出货件亲手复跑——**镜像因出货件 v0.18 后动过（`src/http/rsk.ts`/`serve.ts`/`server.ts`）而重新实构实跑**，另加一次独立边界探针 6/6）。
  - **可交付真实用户 MVP：❌ 未达成**。差的是**真实环境里的执行动作**（真实封臣注册与扇出、密钥托管选型与公告、跨实例联调、模型裁决 key 核对），无法在仓库内闭环。此前唯一的**库内可做**前置项（§F-8 核心链路真进程冒烟固化为资产，deferred #25）已于 2026-09-27 销项。
- 本文按"是否阻塞上线"分层。每条尽量给命令 / 出口标准 / 当前证据分级（实测 / 记录 / 待做）。
- 设计约束红线（来自 product-portrait，任何上线动作不得违反）：数据主权在用户（给目录即用、正文不出域、备份恢复一等能力）；每个概念必须可执行；能力接入只有 MCP / Skill / A2A 三条通道，无私有旁路；个人域与企业域单向隔离、跨域读写需显式签名一次性授权。

## A. 上线硬阻塞（任一未过不可交付真实用户）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| A1 | 真实封臣注册 + 真机扇出验收（E4.8 / M3） | 起实例 → 注册一个真实封臣（pr-helper 或 loom）→ 跑一次真机扇出，且 `branch-*` 事件与决策进 audit 脊 | 两段：① 标准客户端 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<本机代理> BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（exit 0）；② **注册 + 扇出 + 落账现在是一条命令**：`KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… CARD_URL=… [TASK_URL=…] [AGENT_TOKEN=…] [SKILL=…] [REALM=personal\|enterprise] npm run acceptance:fanout`（14 步，加 `--revoke-test` 共 16 步，末尾打印可粘贴的证据块；退出码 0/1/2 = 全过 / 某步失败 / 配置或用法错；`REALM` 于 2026-09-27 为应对"只服务企业域的 Agent"新增，`TASK_URL` 同日新增为**显式覆盖**——内核现已优先读卡片自己声明的 `url`，本旋钮仅作卡片声明不可用/声明有误时的兜底） | **① 已从"记录级"升格为"本轮实测"**：2026-09-27 走本机系统代理对线上 `pr-helper-ten.vercel.app` 复跑 → **exit 0**（卡发现 5 技能、`tasks/send` 被接受、task 停在 `input-required`）。**② 首次对真实 Agent 跑通注册与扇出，14/16**：注册 201（card fetched、fealty validated）、名册 active、审计脊 `dispatched` ×2 + `vassal-revoked`、名册离线验签 VERIFIED、吊销断流通过。两条失败**均非接线缺陷**：一是任务停在 `input-required`（pr-helper 默认 plan 模式、execute 需 Zeus 代理的 GitHub 凭据）故无立场、无记忆 claim——**属治理边界，需用户侧给凭据或换不需凭据的技能**；二是真实卡声明 `dataRealms=["enterprise"]`，需 `REALM=enterprise` + `ZEUS_REALM_ENTERPRISE` 挂企业域（初次按 personal 跑被数据主权边界正确拒绝并写审计 `refused-realm-policy`，故给 runner 加 `REALM` 旋钮）。过程中暴露一条真缺陷：内核 `defaultTaskUrl` 按约定改写端点、**不读卡片自己声明的 `url`**，而 pr-helper 的 JSON-RPC 面就在卡片路径上 → 用 runner 的 `TASK_URL` 绕开后分支 `ok=1/1`。**该缺陷已于 2026-09-27 修复并销项 deferred #29**：`register()` 端点解析改为 **显式覆盖 > 卡片声明 `url` > 约定兜底**（卡片 `url` 为空/非 http(s)/不可解析时判为未声明并回落约定；既有快照 `importState` 保留存下的 `taskUrl`，不随升级翻转），`TASK_URL` 与 `POST /api/vassals` 的 `taskUrl` 覆盖保留为一等显式覆盖。**A1 仍未销项**：差"真实 Agent 回一个结论"这一格，卡在仓库外凭据（另有桩 Agent 上的 14/14 与 16/16 作为接线自证） |
| A2 | 生产 RSK 密钥托管 / 轮换 / 公钥发布（deferred #7 / E4.9 R2 / E5.4 bayjf R2） | 密钥落在受控位置（KMS/文件）、按 §5.4 手册有轮换次序；bayjf 名册对外公开前公钥已发布且指纹已带外公告；`NODE_ENV=production` 无钥拒启已验证 | `scripts/gen-rsk-key.mjs`（已就绪）+ `GET /api/roster/keys`（已就绪）；剩下：选托管方案、把 `jwkThumbprint` 带外公告、bayjf 侧展示 | **发布通道与运行手册已在库内**（2026-09-27，design-fealty-signing v0.2 §5.1/§5.4）；**托管选型已拍板（2026-09-27）= secret 挂载 + 私钥文件 0600**（落地口径见 [deployment.md](deployment.md) §3「本项目选型」；B1 已在镜像内实测过该路径，含"`docker cp` 保留宿主 uid → 必须走挂载"这条教训）；**剩余全是仓库外动作**：把私钥放进真实部署的 secret 后端、`jwkThumbprint` 带外公告、bayjf 侧验签展示 |
| A3 | Zeus↔loom 真机联调 | 用 loom 的 endpoint / agent-card 跑通一次双向 A2A | 需用户侧提供 loom endpoint / card | 待外部条件 |
| A4 | Jev endpoint / key 真机核对 | 启用 S2 仲裁 / E1.3 judge 时，真实 endpoint 连通、key 有效、fallback 行为符合预期 | 配 `ZEUS_DECISION_*` / `ZEUS_JUDGE_*` 后实跑 | 仅当启用模型裁决；代码 fallback 已标注 |
| A5 | 数据域边界签名发布 | bayjf 名册在对公开前，R2（公钥发布 + 客户端验签展示）完成，且 `verifySignedSnapshot` 在另一端验过 | 库内侧已就绪：`GET /api/roster/keys` 发布、`npm run verify:roster` 完整验链；待做的是外部消费方接上它 | 与 A2 同源；**剩余的是 bayjf 侧展示（R2），不是再写一份验证逻辑** |

## B. 部署与运营就绪（上线前必须，属真实环境动作）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| B1 | `docker build/run` 真机构冒烟 | 镜像构建过、容器 healthy、`/data` 两文件 0600、SIGTERM 保存、重启 `restored … intents=` | `docker build -t zeus .` + deployment.md §4.3 起容器 + `curl /api/state` | **v0.18 本轮实构实跑 PASS**（`zeus:review-v018`：healthy、私钥以 `-v <file>:/run/secrets/rsk.pem:ro` 挂载后 `kid` 取自 env、`GET /api/roster/keys` 发布的字节经出货 CLI 验本容器名册 VERIFIED、SIGTERM 落 `kernel-state.json` mode 0600/456B、重启 `restored … (vassals=0, escalations=0, intents=0)`）。**审计文件 0600 已于 2026-09-27 在镜像内补测**（`docker run` 设 `ZEUS_AUDIT_FILE=/data/audit.jsonl` + 私钥挂载：容器内 `stat` 得 `600 node:node`，`ls -la /data` 中创建者即 uid 1000 的 `node`，启动日志报 `audit log: /data/audit.jsonl (64MiB x 5 kept)`；空文件即建，因为 `jsonlAuditSink` 在构造时 `ensureAuditFile`）。另撞出两条守卫：钥文件不可读 → EACCES 拒启；完全不配 → 生产无钥拒启（**`docker cp` 会把宿主 uid 带进去，`USER node` 读不到——秘钥必须走挂载**） |
| B2 | 反代 / TLS / 进程管理 | systemd 或 k8s 起停、反代终止 TLS、健康检查接 `HEALTHCHECK` | deployment.md 已备；真实托管待做 | 文档就绪，真实托管待做 |
| B3 | 审计/状态文件权限与挂载卷 | 生产卷 `/data` 权限 0600、目录自动创建、轮转后重新收紧 | 已 `mkdirSync(...,0o700)` + `appendFileSync(...,0o600)`（audit.ts:81-82）；容器内复核见 B1 的 2026-09-27 补测 | 容器内实测通过（审计文件 `600 node:node`，同 B1，另有冒烟"governance decisions are persisted 0600"一步在宿主进程覆盖）；**剩余的是真实生产卷宿主侧权限**，属部署动作 |
| B4 | 启动装配 env 全量核对 | 24 个 `ZEUS_*` 都读得到、无静默忽略（除明确降级项） | deployment.md §2 已补 10 行；`.env` 解析方已写清（C-1/C-3/C-4 已修） | 文档就绪；上线前按 deployment.md §2 逐行核对 |

## C. 阈值与容量标定（触发条件：≥3 真实 Agent 压测；不阻塞核心 MVP，但建议上线前至少一次）

| # | 项 | 出口标准 | 当前状态 |
|---|---|---|---|
| C1 | #9 背压分流阈值 | `w_r`/`w_l`/`LATENCY_NORMALIZER`/`maxConcurrentPerVassal` 经真机标定；`cap(v)` 按 skill/vassal 覆盖（可选） | 默认值进库、机制可闭环（736 测试中 7 例验证）；**阈值未标定**，挂 deferred #9 触发条件 |
| C2 | #10 Realm 检索后端升级 | 单 Realm >2 万文件或 P50>500ms 才立项（倒排/向量） | 触发条件未到，不阻塞 |
| C3 | capacity-baseline 真机复核 | mock 回环数字 → 真机数字（舒适扇出 / 在途上限） | 口径仍 mock；随 C1/C2 |

## D. 非阻塞但建议上线窗口前拍板（影响对外可信度 / 后续能力，非核心阻塞）

| # | 项 | 说明 | 当前状态 |
|---|---|---|---|
| D1 | #18 MCP 暴露侧 actor 判定 | 影响"Zeus 作为封臣入他人网格"的对外可信度；与 `tools` 白名单同落点 | 等 E3.4 真实封臣 |
| D2 | #19 入站 A2A 面 | 外部 Agent 调不进 Zeus（无 `/.well-known/agent-card.json`、`tasks/*` 路由）；核心 MVP 是出站协作，此项不阻塞核心 | 登记待做；影响"Zeus 被他人网格调用" |
| D3 | #5 外部 Agent 信任分级与沙箱 | 增强，可后置 | deferred |
| D4 | #3 传承 / #4 计费 / #21 标识符改名 | 产品演进，非上线阻塞 | deferred / 待拍板 |

## E. 发布动作（需授权）

| # | 项 | 命令 / 动作 | 当前状态 |
|---|---|---|---|
| E1 | push dev → 云端 CI 首绿（每次推送后双矩阵绿才算销项） | `git ls-remote origin refs/heads/dev`；`git rev-list --count origin/dev..HEAD` | **口径：这条只能现测，写死的同步状态几分钟内就过期**（今天已实测到两次"文档说已同步、现测领先 N 个"）。2026-09-27 评审 v0.18 之后现测：本地领先数个 commit 未推（评审取证对象 `8b53c8e` 当时与 `origin/dev` 相同；**这里故意不写死数字——写下它的那一刻它就已经过期**）。**云端 CI 结果未验证**（`gh` 被权限层拦），不从"本地全绿"推断云端绿 |
| E2 | 镜像发布到 registry | 若用容器部署 | 待做 |

## F. 每次上线前必跑的验证门（回归护栏）

1. `npm run typecheck` exit 0
2. `npm run build` exit 0，`dist/` 完整（**必须在测试之前**：`tests/verify-roster.test.ts` 与 §F-5 的离线验签都跑编译产物）
3. `npm test` exit 0（当前 **790 测试 / 83 文件**；核心链路冒烟 36 步；量法就是这条命令的最后一行，别从文档抄数。**退出码要直取**：`npm test; echo $?`，管道之后的 `$?` 属于 `tail` 而不是 vitest。本机 load 数百时它会涨到 75–452s 并可能报超时红——带负载口径重跑一次再判红）
4. 三条接入通道执行点 grep 复核（见 review-mvp §B）：`boot.ts` tokenFor 接线、`orchestrator.ts` activeProviders 三态闸门、`mcp.ts` REALM_NOT_CONNECTED 白名单、onConflict→监督台闭环、持久化/签名链执行点均在位。**v0.17 追加两条"核对装配而不是核对注册"**：`serve.ts:147` 把 `dagRunner` 注入 HTTP 依赖（否则 DAG 路由在真进程里恒 503）、`boot.ts:593→408→orchestrator.ts:169` 让 `ZEUS_MAX_CONCURRENT_PER_VASSAL` 真的到达 `selectTargets`
5. 离线验签往返：`npm run verify:roster` 对一份真封出来的名册须 **exit 0**，且同一份字节在 `--now` 越过 `maxAgeSeconds` 后须 **exit 1**（这一对是"校验器既不是恒真也不是恒假"的判别，缺一不跑）。报告另有 `seal fingerprint` 两行（`jwk=` / `spki=`）——**带外固定要比的就是这一行与公告值是否逐字符相同**，不必另算哈希）
6. `docker` 真机构冒烟（B1）
7. 时钟偏置回归：`vitest` clock-skew 作业绿（deferred #24 闸门）
8. **核心链路真进程冒烟**：`npm run smoke:core`（`scripts/smoke-core.mjs`，deferred **#25** 已销项）。它起真进程 + 真 socket 走完「挂目录 → 带凭证注册 → 扇出 → 内核自己读域 → 审计落盘 → 名册离线可验（含一条 maxAge 反证）→ 发布的根公钥就是那个签名钥，且**只拿端点返回的字节就能出货验签器验过**（把 PEM 换成 JWK 串须退 2），**且同一串指纹在出钥、发布、验签三处一致**（keygen 打印 → 端点 `jwkThumbprint` → 验签报告 `seal fingerprint` 行）→ **DAG 驾驶员入口已装配**（未知意图须回 runner 自己的 404 `unknown dag`；只有 `dagRunner` 未注入时才会 503，故这一步分辨的是"装配"不是"路由在位"）→ 吊销断流 → SIGTERM 落盘 → 重启恢复」，36 步全绿才退 0；只用回环、自造密钥与令牌、不读任何真实部署的 secret，并已接进 CI（build/test 之后一步）。它第一次跑就把派发打到了没有凭证的对端——正是这条链路上"库内测试看不见、真进程才看得见"的那类缺口

## G. 上线冲刺（需你提供什么 / 我做什么）

把 A1–A5 与 §B 收敛成可执行排期。**「需你提供」= 只能由你或你的环境给出的输入与授权；「我做什么」= 拿到输入后我能在仓库或本机完成的动作。** 一行两侧都不为空才叫未销项——所以这张表能一眼看出哪些格子在等外部条件、哪些只是等我动手。

| # | 需你提供 | 我做什么（拿到输入后） | 阻塞谁 |
|---|---|---|---|
| A1 | pr-helper 的 execute 凭据（GitHub token，经 Zeus 进程代理）或指定一个不需凭据的真技能；以及允许挂企业域（`ZEUS_REALM_ENTERPRISE`） | 用已入库的 `npm run acceptance:fanout`（`REALM=enterprise TASK_URL=<卡片路径> SKILL=<换过的技能>`）复跑，把 `positions=0` 与 `events 0→0` 两格转绿并留证据 | A1 销项 |
| A2 | 真实部署的 secret 后端（或主机 + 部署目录）；带外公告渠道 | 选型已拍板（secret 挂载 + 0600，见 deployment §3）；拿到环境后按 §5.4 七步做首轮发钥与切流自检（`kid` 与新指纹逐字符相符）；公告文本我来拟 | A2 / A5 |
| A3 | loom 的 endpoint / agent-card 及凭证 | 跑一次双向 A2A 真机联调，结果与人话结论写回 A3 行 | A3 |
| A4 | Jev 的真实 endpoint 与 key；或明确「上线窗口不启用模型裁决」 | 启用则配 `ZEUS_DECISION_*` / `ZEUS_JUDGE_*` 实跑并核对连通、key 有效、fallback 行为；不启用则把 A4 标为非目标并写明影响面（rules-only 降级的实际表现） | A4（仅启用时） |
| A5 | bayjf 侧（R2）由谁改、何时改 | 库内侧已闭环（发布端点 + `npm run verify:roster` 完整验链）；我交付接口契约与验签调用示例，展示本身由 bayjf 侧落地（**给契约，不代写第二份验签逻辑**） | A5 |
| B1 / B3 | 真实生产卷的宿主路径与权限策略 | 容器内路径已在 B1 实测（审计与状态文件 0600、`node:node`）；拿到真实卷后复核宿主侧权限与挂载差异并记账 | B1 / B3 |
| B2 | 反代 / TLS / 进程管理的真实托管形态（systemd、k8s 或反代产品） | 按 deployment.md 出对应的起停单元、TLS 终止与 `HEALTHCHECK` 配置 | B2 |
| B4 | 上线前那一刻的 `ZEUS_*` 读取面确认 | 按 deployment.md §2 逐行核对 24 个变量，把「读到但未用」与「静默降级」的逐条列出 | B4 |
| E1 | 每次 push 的授权 | 现测 `git rev-list --count origin/dev..HEAD` 后推送，并盯云端 CI 双矩阵绿（**口径：状态只能现测，不写死**） | E1 |

**能立刻推进的**：A1 与 A2 的库内件都已入库，差的只是真实凭据与真实部署环境——你的凭据一到，A1 就是一条命令的事。其余每行都需要外部输入，没有「我自己先做着」的余地。

**明确非本次冲刺范围**：C1–C3 阈值标定（需 ≥3 真实 Agent 压测，不阻塞核心 MVP）、D1–D4 非阻塞增强、E2 镜像发 registry（仅当部署形态是拉到 registry 才有意义）。

## 一句话

**内核与制品已到"可演示 MVP"；上线只差真实环境里的跑起来、联起来、签出去（A1–A5 + B 系列），以及把本次新提交推到云端 CI 并确认绿（E1）。"每次上线都要靠人手工演一遍"这件事已经消掉：核心链路的真进程冒烟是仓库资产（deferred #25 已销项，§F-8）。阈值标定（C 系列）不阻塞核心 MVP，但建议在首次真实多 Agent 负载前完成一次压测。**
