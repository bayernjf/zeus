# 上线前 Checklist（Pre-launch Checklist）

- 关联：项目级评审单一事实源 [review-mvp-2026-09.md](review-mvp-2026-09.md)；deferred 项清单 [deferred-items.md](deferred-items.md)；部署面 [deployment.md](deployment.md)；容量基线 [capacity-baseline.md](capacity-baseline.md)。
- **判定（评审 v0.25 下的判；下面两行的计数是活基线，每批现测更新，量法见 §F-3）**：
  - **产品核心「完全可用」MVP：✅ 达成**（库内核 + 制品就绪，三条接入通道执行点在位且装配到真进程路径，全量 1320 总量 / 120 文件（macOS 本机现测全绿；Windows 本机上一口径 1078 绿 / 26 环境性失败，那次读数对应总量 1104，Active work 118 之后的批次未在 Windows 复跑；CI Linux/macOS 口径全绿）且 `npm test` 退出码 0、typecheck/build 过、核心链路冒烟 42 步（macOS 2026-10-06 现测；Windows 本机上一口径 31/36 为 36 步时代读数，5 步为 0600 chmod ×2 + SIGTERM 连锁 ×3 环境家族）；P0 26/26 为逐行机械计数（PRD 需求行 55，增量即 E2.6 意图识别），签名链**七条**对照与边界矩阵均用出货件亲手复跑；三个真进程验收脚本（execute-delegation 9/9、intent-recognize 7/7、tui-recognize 7/7）于 2026-10-03 Windows 本机复跑全绿（tui-recognize 抓出并修掉一条脚本可移植性缺陷，见 review v0.23 §H）。**镜像层标注**：最后一次实构实跑是 HEAD `6179688`（`zeus:review-6179688`）；评审 v0.21 与 v0.23 时出货件又动过（`src/http/serve.ts` 及意图/委派/TUI 面），**本机重拍因到 registry 的网络路径不通而未完成**（`load metadata for node:22-slim` 超时、本地零镜像缓存；本机代理 7897 可达 Docker Hub 而 Docker Desktop 未配代理），该项的落点是 CI 的 `image build + smoke` job（对已推送 HEAD 为绿）。
  - **可交付真实用户 MVP：❌ 未达成**。差的是**真实环境里的执行动作**：密钥托管落地与公钥公告（A2）、模型裁决 key 核对（A4）、bayjf 侧验签展示（A5），以及真实生产环境（B 系列），均无法在仓库内闭环。**A1「真实执行 Agent 注册 + 真机扇出」已于 2026-09-29 对线上 pr-helper 实跑通过并销项，不再计入**（15/15，exit 0，见 A1 行）。**A3「Zeus↔loom 真机联调」已于 2026-10-08 对隔离真机栈实跑通过并销项，不再计入**（18/18，exit 0，见 A3 行）。此前唯一的**库内可做**前置项（§F-8 核心链路真进程冒烟固化为资产，deferred #25）已于 2026-09-27 销项。
- 本文按"是否阻塞上线"分层。每条尽量给命令 / 出口标准 / 当前证据分级（实测 / 记录 / 待做）。
- 设计约束红线（来自 product-portrait，任何上线动作不得违反）：数据主权在用户（给目录即用、正文不出域、备份恢复一等能力）；每个概念必须可执行；能力接入只有 MCP / Skill / A2A 三条通道，无私有旁路；个人域与企业域单向隔离、跨域读写需显式签名一次性授权。

## A. 上线硬阻塞（任一未过不可交付真实用户）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| A1 | 真实执行 Agent 注册 + 真机扇出验收（E4.8 / M3） | 起实例 → 注册一个真实执行 Agent（pr-helper 或 loom）→ 跑一次真机扇出，且 `branch-*` 事件与决策进 audit 日志 | 两段：① 标准客户端 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<本机代理> BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（exit 0）；② **注册 + 扇出 + 落账现在是一条命令**：`KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… CARD_URL=… [TASK_URL=…] [AGENT_TOKEN=…] [SKILL=…] [REALM=personal\|enterprise] [PARAMS='{"k":"v"}'] [EXPECT_STANCE=0\|1] npm run acceptance:fanout`（步数随判据变：`EXPECT_STANCE=1` 投票型 15 步、`0` 执行型 13 步，加 `--revoke-test` 各 +2，末尾打印可粘贴的证据块；退出码 0/1/2 = 全过 / 某步失败 / 配置或用法错；`REALM` 于 2026-09-27 为应对"只服务企业域的 Agent"新增，`TASK_URL` 同日新增为**显式覆盖**——内核现已优先读卡片自己声明的 `url`，本旋钮仅作卡片声明不可用/声明有误时的兜底；**`PARAMS` 与 `EXPECT_STANCE` 于 2026-09-29 新增**，前者把技能自己的参数原样透传（执行型 Agent 各自校验参数，问题式默认只适合问答型 Agent），后者选择断言哪一组判据——见 A1 行） | **① 已从"记录级"升格为"本轮实测"**：2026-09-27 走本机系统代理对线上 `pr-helper-ten.vercel.app` 复跑 → **exit 0**（卡发现 5 技能、`tasks/send` 被接受、task 停在 `input-required`）。**② 首次对真实 Agent 跑通注册与扇出，14/16**：注册 201（card fetched、fealty validated）、名册 active、审计日志 `dispatched` ×2 + `vassal-revoked`、名册离线验签 VERIFIED、吊销断流通过。两条失败**均非接线缺陷**，但当时对第一条的结论判错：一是任务停在 `input-required`（pr-helper 默认 plan 模式、execute 需 Zeus 代理的 GitHub 凭据）故无立场、无记忆 claim——当时判为"需用户侧给凭据"，**实为判据缺陷**（见下 ③）；二是真实卡声明 `dataRealms=["enterprise"]`，需 `REALM=enterprise` + `ZEUS_REALM_ENTERPRISE` 挂企业域（初次按 personal 跑被数据主权边界正确拒绝并写审计 `refused-realm-policy`，故给 runner 加 `REALM` 旋钮）。过程中暴露一条真缺陷：内核 `defaultTaskUrl` 按约定改写端点、**不读卡片自己声明的 `url`**，而 pr-helper 的 JSON-RPC 面就在卡片路径上 → 用 runner 的 `TASK_URL` 绕开后分支 `ok=1/1`。**该缺陷已于 2026-09-27 修复并销项 deferred #29**：`register()` 端点解析改为 **显式覆盖 > 卡片声明 `url` > 约定兜底**（卡片 `url` 为空/非 http(s)/不可解析时判为未声明并回落约定；既有快照 `importState` 保留存下的 `taskUrl`，不随升级翻转），`TASK_URL` 与 `POST /api/vassals` 的 `taskUrl` 覆盖保留为一等显式覆盖。**③ 2026-09-29 对线上 pr-helper 复跑，15/15 exit 0，A1 销项**：先前"卡在仓库外凭据"的结论**被证伪**——根因是 **runner 的判据写错了对象**：原判据 `positions≥1`（"回了一个立场"）是给**投票型** Agent 的，而 pr-helper 是**执行型**（跑具名技能并回报内容，不投票），故 `positions=0` 是正确结果而非故障。修法是让判据可选（`EXPECT_STANCE=0/1`）：`0` 时断言"分支成功且带回内容（artifact 且 parts≥1）"并对立场聚合与记忆 claim 打印显式 `SKIP`（附原因，不做空过），`1` 时仍断言立场与 claim；同时修掉 runner 发错参数的真缺陷（原发 `{subject,predicate,prompt}`，而 `deployment-health` 要 `owner`/`repo`，pr-helper 曾回 `input-required "Missing required parameters: owner, repo"`，现由 `PARAMS` 原样透传）。本轮实测证据：`CARD_URL=…/api/a2a/agent-card`（**不传 `TASK_URL`**，由内核读卡片声明的 `url` 解析出 `taskUrl=…/api/a2a/agent-card`，即 deferred #29 修复在真机上的再确认）→ 注册 201、名册 active、`PARAMS='{"owner":"jiangfeng","repo":"zeus"}'` 扇出 → 分支 `ok=1/1`、`withContent=1`、`x-zeus-report.summary="deployment-health-plan: plan generated for jiangfeng/zeus."` 原样回传、`decision={"rule":"majority","positions":[],"conclusion":null,"reason":"no vassal returned a stance; nothing to aggregate"}`（执行型 Agent 下聚合器如实报告"无可聚合"，非空过）、审计日志 `dispatched` ×2（末条带 `taskId` 与 `state=completed`）、名册离线验签 VERIFIED、吊销断流通过、SIGTERM 后 `orchestrator.intents` 两条落盘（completed 那条含分支与 decision）。**范围界定（不夸大）**：pr-helper 在 plan 模式作答（其卡片 notes 明示 execute 需 Zeus 代理的 GitHub 凭据、不可逆技能一律上报操作者），故本项证明的是**真机扇出闭环 + 执行型 Agent 内容回传**，**不含**对 GitHub 的不可逆写操作——后者需凭据代理机制（**已登记为 deferred #33**），不在 A1 出口标准内。**A1 出口标准（"起实例 → 注册真实执行 Agent → 跑一次真机扇出，且 `branch-*` 事件与决策进 audit 日志"）已满足，销项**（桩 Agent 上的 14/14 与 16/16 仍作接线自证保留） |
| A2 | 生产 RSK 密钥托管 / 轮换 / 公钥发布（deferred #7 / E4.9 R2 / E5.4 bayjf R2） | 密钥落在受控位置（KMS/文件）、按 §5.4 手册有轮换次序；bayjf 名册对外公开前公钥已发布且指纹已带外公告；`NODE_ENV=production` 无钥拒启已验证 | `scripts/gen-rsk-key.mjs`（已就绪）+ `GET /api/roster/keys`（已就绪）；剩下：选托管方案、把 `jwkThumbprint` 带外公告、bayjf 侧展示 | **发布通道与运行手册已在库内**（2026-09-27，design-fealty-signing v0.2 §5.1/§5.4）；**托管选型已确定（2026-09-27）= secret 挂载 + 私钥文件 0600**（落地口径见 [deployment.md](deployment.md) §3「本项目选型」；B1 已在镜像内实测过该路径，含"`docker cp` 保留宿主 uid → 必须走挂载"这条教训）；**剩余全是仓库外动作**：把私钥放进真实部署的 secret 后端、`jwkThumbprint` 带外公告、bayjf 侧验签展示 |
| A3 | Zeus↔loom 真机联调 | 用 loom 的 endpoint / agent-card 跑通一次双向 A2A | 需 loom 测试实例在跑（本机 8000）+ Agent Key | **已销项（2026-10-08）**：隔离真机栈（一次性 PG16+Redis+loom backend，`LOOM_PUBLIC_BASE_URL` 生效）+ Zeus dev 实例（挂企业域 + 审计文件）实跑 `npm run acceptance:loom`（`REALM=enterprise --sse-test --revoke-test`）**18/18 PASS exit 0**：卡片契约 7 步、SSE 流、注册 201→名册 active→凭证不回显→`generate-content` 扇出 completed→分支 `ok=1/1` 内容回传（`x-zeus-report` 原文 `plan generated for tenant=…`）→审计 dispatched=2 terminal=2→吊销+reinstate 往返；真机确认三件契约事实：loom 执行端认 skill id（非卡片展示名）、需 `REALM=enterprise`（卡声明 enterprise 域）、审计终态在 dispatch 条目 `state` 内。详见 [design-loom-interop.md](design-loom-interop.md) v0.2 |
| A4 | Jev endpoint / key 真机核对 | 启用 S2 仲裁 / E1.3 judge 时，真实 endpoint 连通、key 有效、fallback 行为符合预期 | 配 `ZEUS_DECISION_*` / `ZEUS_JUDGE_*` 后实跑 | 仅当启用模型裁决；代码 fallback 已标注 |
| A5 | 数据域边界签名发布 | bayjf 名册在对公开前，R2（公钥发布 + 客户端验签展示）完成，且 `verifySignedSnapshot` 在另一端验过 | 库内侧已就绪：`GET /api/roster/keys` 发布、`npm run verify:roster` 完整验链；待做的是外部消费方接上它 | 与 A2 同源；**剩余的是 bayjf 侧展示（R2），不是再写一份验证逻辑** |

## B. 部署与运营就绪（上线前必须，属真实环境动作）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| B1 | `docker build/run` 真机构冒烟 | 镜像构建过、容器 healthy、`/data` 两文件 0600、SIGTERM 保存、重启 `restored … intents=` | `docker build -t zeus .` + deployment.md §4.3 起容器 + `curl /api/state` | **分两半记，别合并读**：① **构建侧已在 CI 覆盖**——`image build + smoke` job（`docker build` + 镜像内 `gen-rsk-key.mjs` + `require('./dist/index.js')`）对本批 HEAD `22de402` 绿（run 37048803811）；② **容器级四项**（healthy、`/data` 0600、SIGTERM 落盘、重启恢复）对 `22de402` **仍无证据**，最后一次实跑 = HEAD `6179688` PASS（评审 v0.21 本机重拍受阻：直连 Docker Hub 超时、零镜像缓存；诊断见 §F-6，修法 = 给 Docker Desktop 配代理）（`zeus:review-6179688`：healthy、私钥以 `-v <file>:/secrets/rsk-private.pem:ro` 挂载后 `kid` 取自 env、`GET /api/roster/keys` 发布的 `spkiPem` 经出货 CLI 验本容器名册 VERIFIED（`jwk`/`spki` 指纹与 keygen 三处同串）、容器内 `/data/audit.jsonl` 与 `/data/kernel-state.json` 均 `600 node:node`、SIGTERM 落 `kernel-state.json` mode 0600/456B、重启 `restored … (vassals=0, escalations=0, intents=0)`）。此前 v0.18 那轮（`zeus:review-v018`）结论同形，但出货件其后又被改过，故本轮不继承、重拍。**审计文件 0600 首次在镜像内补测是 2026-09-27**（`docker run` 设 `ZEUS_AUDIT_FILE=/data/audit.jsonl` + 私钥挂载：容器内 `stat` 得 `600 node:node`，`ls -la /data` 中创建者即 uid 1000 的 `node`，启动日志报 `audit log: /data/audit.jsonl (64MiB x 5 kept)`；空文件即建，因为 `jsonlAuditSink` 在构造时 `ensureAuditFile`）。另撞出两条守卫：钥文件不可读 → EACCES 拒启；完全不配 → 生产无钥拒启（**`docker cp` 会把宿主 uid 带进去，`USER node` 读不到——秘钥必须走挂载**） |
| B2 | 反代 / TLS / 进程管理 | systemd 或 k8s 起停、反代终止 TLS、健康检查接 `HEALTHCHECK` | deployment.md 已备；真实托管待做 | 文档就绪，真实托管待做 |
| B3 | 审计/状态文件权限与挂载卷 | 生产卷 `/data` 权限 0600、目录自动创建、轮转后重新收紧 | 已 `mkdirSync(...,0o700)` + `appendFileSync(...,0o600)`（audit.ts:81-82）；容器内复核见 B1 的 2026-09-27 补测 | 容器内实测通过（审计文件 `600 node:node`，同 B1，另有冒烟"governance decisions are persisted 0600"一步在宿主进程覆盖）；**剩余的是真实生产卷宿主侧权限**，属部署动作 |
| B4 | 启动装配 env 全量核对 | `.env.example` 里 **34 个 `ZEUS_*`**（2026-10-08 现测：33 个 src 直接读取 + 1 个动态 env 名 CLI 变量 `ZEUS_VAULT_PASSPHRASE`）都读得到、无静默忽略（除明确降级项） | **双向一致性已入库为 doc-consistency 第 18 例断言**（代码读取 ↔ 部署模板，漂移即红，双向缺陷植入验证）；deployment.md §2 已补 10 行；`.env` 解析方已写清（C-1/C-3/C-4 已修） | 库内前置已机械化常驻；上线前只剩部署实例按 deployment.md §2 逐行核对 |

## C. 阈值与容量标定（触发条件：≥3 真实 Agent 压测；不阻塞核心 MVP，但建议上线前至少一次）

| # | 项 | 出口标准 | 当前状态 |
|---|---|---|---|
| C1 | #9 背压分流阈值 | `w_r`/`w_l`/`LATENCY_NORMALIZER`/`maxConcurrentPerVassal` 经真机标定；`cap(v)` 按 skill/vassal 覆盖（可选） | 默认值进库、机制可闭环（736 测试中 7 例验证）；**阈值未标定**，挂 deferred #9 触发条件 |
| C2 | #10 Realm 检索后端升级 | 单 Realm >2 万文件或 P50>500ms 才立项（倒排/向量） | 触发条件未到，不阻塞 |
| C3 | capacity-baseline 真机复核 | mock 回环数字 → 真机数字（舒适扇出 / 在途上限） | 口径仍 mock；随 C1/C2 |

## D. 非阻塞但建议上线窗口前决定（影响对外可信度 / 后续能力，非核心阻塞）

| # | 项 | 说明 | 当前状态 |
|---|---|---|---|
| D1 | #18 MCP 暴露侧 actor 判定 | 影响"Zeus 作为执行 Agent 入他人网格"的对外可信度；与 `tools` 白名单同落点 | **机制已落地（2026-10-07，Active work 144），deferred #18 已销项（2026-10-08）**：streamable HTTP（GET/POST /mcp）+ `x-zeus-realm-actor` 会话级 actor 仅可收窄宿主白名单（§6.5 裁定 ①）；真实读取方（E3.4 首个 read-realm 执行 Agent）仍未出现，OAuth subject 形态降级为真实读取方出现时的复核项 |
| D2 | #19 入站 A2A 面 | 外部 Agent 调不进 Zeus；核心 MVP 是出站协作，此项不阻塞核心 | **机制已落地（2026-10-07，Active work 144），deferred #19 已销项（2026-10-08）**：`/.well-known/agent-card.json` 公开卡片 + `tasks/send` 落 H2 意图面（fealty 形状闸 fail-closed、realm 缺省 personal、AUDIT_DECISIONS 延伸）；剩真实上游调用者 + 在册名册验签信任锚（loom 反向派任务 / 公开执行 Agent 调用 / 多 Zeus 协作任一出现即闭合，降级为最终验证语义） |
| D3 | #5 外部 Agent 信任分级与沙箱 | 增强，可后置 | deferred |
| D4 | #3 传承 / #4 计费 / #21 标识符改名 | 产品演进，非上线阻塞 | deferred / 待决定 |
| D5 | #30 连接器权限词法绑不住工具名 | 声明串要先过 `^[a-z][a-z-]*(:[a-z][a-z-]*)?$`，实测 `mcp:search_docs`、`mcp:Search`、`mcp:search.x`、`mcp:` 四条全判 invalid——这类工具只能退裸 `mcp`＝放行握手发现到的全部工具 | **已修复（2026-09-30，deferred #30 销项）**：`mcp:<工具名>` 按上游握手清单的原样字符串匹配（下划线/点/大写合法、精确大小写），声明了而上游没有的名字在连接时产生 `boundary-unmatched` 审计。**剩下的都是实对面**：2026-10-01 已对真实 stdio 上游跑过 `connect`（Zeus 自有 `dist/realm/mcp-stdio.js` 与第三方 work-learn server 各一次，见 mcp-integration §2），**远程 HTTP MCP（需凭证）还没连过** |
| D6 | #31 MCP 面静默丢掉未声明的查询参数 | 实测 `search?tags=important` 返回**未过滤**结果且不报错，存储层"不支持标签检索"的拒绝路径在这条通道上永远走不到——静默降级，与已销项的 #20（env 写错静默退默认）同形 | **已修复（2026-09-30，deferred #31 销项）**：未声明的查询参数按名拒绝为 `-32602`，`tags` 下传到存储层显式抛 `UnsupportedQueryError`（"tag search is not supported in P0"）——集成方看到的是一条拒绝，不是未过滤的全量命中。**剩下的不是本项待办**：标签检索真正立项（倒排/向量后端）走 design-realm §6.2 的阈值条件 |
| D7 | #41 企业形态：隔离实例 vs 同实例多租户 | 决定认证面、状态文件粒度与运维模型。现状实测（2026-10-05）：该 H2 面 **78 条路由里 75 条共用同一个 bearer**，即今天的实际隔离档位就是"一实例一租户"——选隔离实例不改代码，选同实例多租户要先重做鉴权并把状态/审计/备份清单按租户分片 | **已裁定（2026-10-08）：A 隔离实例**——deferred #41 已销项，裁定稿 v0.2 方向已固化；认证面不动、状态卷每实例独立、备份粒度=实例；B（per-tenant principal 重构）降级为触发候选路径；实例编排层与 E10.2 真机部署合并推进 |

## E. 发布动作（需授权）

| # | 项 | 命令 / 动作 | 当前状态 |
|---|---|---|---|
| E1 | push dev → 云端 CI 首绿（每次推送后双矩阵绿才算销项） | `git ls-remote origin refs/heads/dev`；`git rev-list --count origin/dev..HEAD` | **2026-10-02 现测：已推、云端绿**——经用户授权推送 `b61043d..22de402`（5 个 commit），`origin/dev..HEAD` = 0，`git ls-remote origin refs/heads/dev` = `22de4023…`；CI run **37048803811** **4/4 job success**（`image build + smoke`、Node 22.x、Node 24.x、clock-skew 独立 job）。**口径不变：这条是活读数，写死的同步状态几分钟内就过期**——每次上线前复跑上述命令并重新确认 CI |
| E2 | 镜像发布到 registry | 若用容器部署 | 待做 |

## F. 每次上线前必跑的验证门（回归护栏）

1. `npm run typecheck` exit 0
2. `npm run build` exit 0，`dist/` 完整（**必须在测试之前**：`tests/verify-roster.test.ts` 与 §F-5 的离线验签都跑编译产物）
3. `npm test` exit 0（当前 **1320 总量 / 120 文件**（macOS 全绿，Active work 158 之后）；Windows 本机上一口径 1078 绿 / 26 环境性失败（总量 1104 时，其后各批未在 Windows 复跑）——目录 fsync EPERM、chmod 0600 断言、symlink EPERM 三族，CI Linux/macOS 口径全绿；核心链路冒烟 42 步（macOS 2026-10-06 现测），Windows 本机上一口径 31/36（5 步为 0600 chmod ×2 + SIGTERM 连锁 ×3 环境家族）；量法就是这条命令的最后一行，别从文档抄数。**退出码要直取**：`npm test; echo $?`，管道之后的 `$?` 属于 `tail` 而不是 vitest。本机 load 数百时它会涨到 75–452s 并可能报超时红——带负载口径重跑一次再判红）
4. 三条接入通道执行点 grep 复核（见 review-mvp §B）：`boot.ts` tokenFor 接线、`orchestrator.ts` activeProviders 三态闸门、`mcp.ts` REALM_NOT_CONNECTED 白名单、onConflict→监督台闭环、持久化/签名链执行点均在位。**v0.17 追加两条"核对装配而不是核对注册"**：`serve.ts` 把 `dagRunner` 注入 HTTP 依赖（否则 DAG 路由在真进程里恒 503）、`ZEUS_MAX_CONCURRENT_PER_VASSAL` 真的到达 `selectTargets`。**行号每轮都会漂，引用前先定位**（v0.21 现测：`serve.ts:155`、`boot.ts:687` 的 `concurrencyBootOptions` → `boot.ts:673` → `orchestrator.ts:230`）
5. 离线验签往返：`npm run verify:roster` 对一份真封出来的名册须 **exit 0**，且同一份字节在 `--now` 越过 `maxAgeSeconds` 后须 **exit 1**（这一对是"校验器既不是恒真也不是恒假"的判别，缺一不跑）。报告另有 `seal fingerprint` 两行（`jwk=` / `spki=`）——**带外固定要比的就是这一行与公告值是否逐字符相同**，不必另算哈希）
6. `docker` 真机构冒烟（B1）。**v0.21 记账**：本机直连 Docker Hub 超时（`load metadata for node:22-slim` 失败）且本地零镜像缓存，故本机跑不了这一步；诊断出的是环境配置问题（本机 `127.0.0.1:7897` 代理可达 Docker Hub，而 Docker Desktop 未配代理），修法是给 Docker Desktop 配代理。**CI 的 `image build + smoke` job 覆盖到"构建 + 镜像内两项冒烟"**（`docker build`、镜像内 `gen-rsk-key.mjs`、`require('./dist/index.js')`），对本批 HEAD `22de402` 绿；**容器级四项（healthy / `/data` 0600 / SIGTERM 落盘 / 重启恢复）不在该 job 覆盖内**
7. 时钟偏置回归：`vitest` clock-skew 作业绿（deferred #24 闸门）
8. **核心链路真进程冒烟**：`npm run smoke:core`（`scripts/smoke-core.mjs`，deferred **#25** 已销项）。它起真进程 + 真 socket 走完「挂目录 → 带凭证注册 → 扇出 → 内核自己读域 → 审计落盘 → 名册离线可验（含一条 maxAge 反证）→ 发布的根公钥就是那个签名钥，且**只拿端点返回的字节就能出货验签器验过**（把 PEM 换成 JWK 串须退 2），**且同一串指纹在出钥、发布、验签三处一致**（keygen 打印 → 端点 `jwkThumbprint` → 验签报告 `seal fingerprint` 行）→ **DAG 操作者入口已装配**（未知意图须回 runner 自己的 404 `unknown dag`；只有 `dagRunner` 未注入时才会 503，故这一步分辨的是"装配"不是"路由在位"）→ 吊销断流 → SIGTERM 落盘 → 重启恢复」，36 步全绿才退 0；只用回环、自造密钥与令牌、不读任何真实部署的 secret，并已接进 CI（build/test 之后一步）。它第一次跑就把派发打到了没有凭证的对端——正是这条链路上"库内测试看不见、真进程才看得见"的那类缺口
9. **运行时可靠性实测**：`npm run verify:reliability`（`scripts/verify-runtime-reliability.mjs`，审计 §13）。它起出货件跑四格——有界并发闸的真配置行为、`escalations` 跨 SIGTERM 重启、SSE 断流重连与取消时序、台账与 RSS 增长斜率，每格自带正控（无上限的对照必须 0 拒绝、不配状态文件的对照必须丢项），所以它报"过"而不是报"没坏"。**当前为按需跑，未进 CI**：接线前先在 CI 负载下量墙钟，别照本机数决定。

## G. 上线冲刺（需你提供什么 / 我做什么）

把 A1–A5 与 §B 收敛成可执行排期。**「需你提供」= 只能由你或你的环境给出的输入与授权；「我做什么」= 拿到输入后我能在仓库或本机完成的动作。** 一行两侧都不为空才叫未销项——所以这张表能一眼看出哪些格子在等外部条件、哪些只是等我动手。

| # | 需你提供 | 我做什么（拿到输入后） | 阻塞谁 |
|---|---|---|---|
| A1 | ~~pr-helper 的 execute 凭据（GitHub token，经 Zeus 进程代理）或指定一个不需凭据的真技能；以及允许挂企业域（`ZEUS_REALM_ENTERPRISE`）~~ **无需——已销项 2026-09-29** | 已完成：判据由投票型改为执行型（`EXPECT_STANCE=0`，断言"带回内容"而非"回了立场"）+ 修掉发错参数的缺陷（`PARAMS` 透传 `owner`/`repo`）后，对线上 pr-helper 复跑 **15/15 exit 0**，全程未用到任何凭据 | ~~A1 销项~~ **已销项** |
| A2 | 真实部署的 secret 后端（或主机 + 部署目录）；带外公告渠道 | 选型已确定（secret 挂载 + 0600，见 deployment §3）；拿到环境后按 §5.4 七步做首轮发钥与切流自检（`kid` 与新指纹逐字符相符）；公告文本我来拟 | A2 / A5 |
| A3 | loom 的 endpoint / agent-card 及凭证 | 跑一次双向 A2A 真机联调，结果与人话结论写回 A3 行 | A3 |
| A4 | Jev 的真实 endpoint 与 key；或明确「上线窗口不启用模型裁决」 | 启用则配 `ZEUS_DECISION_*` / `ZEUS_JUDGE_*` 实跑并核对连通、key 有效、fallback 行为；不启用则把 A4 标为非目标并写明影响面（rules-only 降级的实际表现） | A4（仅启用时） |
| A5 | bayjf 侧（R2）由谁改、何时改 | 库内侧已闭环（发布端点 + `npm run verify:roster` 完整验链）；我交付接口契约与验签调用示例，展示本身由 bayjf 侧落地（**给契约，不代写第二份验签逻辑**） | A5 |
| B1 / B3 | 真实生产卷的宿主路径与权限策略 | 容器内路径已在 B1 实测（审计与状态文件 0600、`node:node`）；拿到真实卷后复核宿主侧权限与挂载差异并记账 | B1 / B3 |
| B2 | 反代 / TLS / 进程管理的真实托管形态（systemd、k8s 或反代产品） | 按 deployment.md 出对应的起停单元、TLS 终止与 `HEALTHCHECK` 配置 | B2 |
| B4 | 上线前那一刻的 `ZEUS_*` 读取面确认 | 按 deployment.md §2 逐行核对 24 个变量，把「读到但未用」与「静默降级」的逐条列出 | B4 |
| E1 | 每次 push 的授权 | 现测 `git rev-list --count origin/dev..HEAD` 后推送，并盯云端 CI 双矩阵绿（**口径：状态只能现测，不写死**） | E1 |

**能立刻推进的**：~~A1 与 A2 的库内件都已入库，差的只是真实凭据与真实部署环境——你的凭据一到，A1 就是一条命令的事。~~ **A1 已于 2026-09-29 销项**：判据修正后对线上 pr-helper 实跑 **15/15 exit 0**，且**全程未用到任何凭据**——先前"差凭据"的判断已证伪，差的是判据（详见 §A A1 行）。A2 的库内件已入库，差的只是真实部署环境与带外公告渠道。其余每行都需要外部输入，没有「我自己先做着」的余地。

**明确非本次冲刺范围**：C1–C3 阈值标定（需 ≥3 真实 Agent 压测，不阻塞核心 MVP）、D1–D4 非阻塞增强、E2 镜像发 registry（仅当部署形态是拉到 registry 才有意义）。

## 一句话

**内核与制品已到"可演示 MVP"；真实执行 Agent 注册与真机扇出（A1）已于 2026-09-29 对线上 pr-helper 跑通并销项，上线只差真实环境里的密钥托管与公告、联起来、签出去（A2–A5 + B 系列）；本批提交已推到云端 CI 且双矩阵绿（E1，run 36466707666）。"每次上线都要靠人手工演一遍"这件事已经消掉：核心链路的真进程冒烟是仓库资产（deferred #25 已销项，§F-8）。阈值标定（C 系列）不阻塞核心 MVP，但建议在首次真实多 Agent 负载前完成一次压测。**
