# 上线前 Checklist（Pre-launch Checklist）

- 关联：项目级评审单一事实源 [review-mvp-2026-09.md](review-mvp-2026-09.md)；deferred 项清单 [deferred-items.md](deferred-items.md)；部署面 [deployment.md](deployment.md)；容量基线 [capacity-baseline.md](capacity-baseline.md)。
- **判定（2026-09-27 v0.19 复核）**：
  - **产品核心「完全可用」MVP：✅ 达成**（库内核 + 制品就绪，三条接入通道执行点在位且装配到真进程路径，全量 786 测试 / 83 文件绿且 `npm test` 退出码 0、typecheck/build 过、核心链路冒烟 35/35；P0 26/26 为逐行机械计数，签名链五条对照与部署镜像实构实跑均用出货件亲手复跑——**镜像因出货件 v0.18 后动过（`src/http/rsk.ts`/`serve.ts`/`server.ts`）而重新实构实跑**，另加一次独立边界探针 6/6）。
  - **可交付真实用户 MVP：❌ 未达成**。差的是**真实环境里的执行动作**（真实封臣注册与扇出、密钥托管选型与公告、跨实例联调、模型裁决 key 核对），无法在仓库内闭环。此前唯一的**库内可做**前置项（§F-8 核心链路真进程冒烟固化为资产，deferred #25）已于 2026-09-27 销项。
- 本文按"是否阻塞上线"分层。每条尽量给命令 / 出口标准 / 当前证据分级（实测 / 记录 / 待做）。
- 设计约束红线（来自 product-portrait，任何上线动作不得违反）：数据主权在用户（给目录即用、正文不出域、备份恢复一等能力）；每个概念必须可执行；能力接入只有 MCP / Skill / A2A 三条通道，无私有旁路；个人域与企业域单向隔离、跨域读写需显式签名一次性授权。

## A. 上线硬阻塞（任一未过不可交付真实用户）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| A1 | 真实封臣注册 + 真机扇出验收（E4.8 / M3） | 起实例 → 注册一个真实封臣（pr-helper 或 loom）→ 跑一次真机扇出，且 `branch-*` 事件与决策进 audit 脊 | 两段：① 标准客户端 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<本机代理> BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（exit 0）；② **注册 + 扇出 + 落账现在是一条命令**：`KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… CARD_URL=… AGENT_TOKEN=… SKILL=research npm run acceptance:fanout`（14 步，加 `--revoke-test` 共 16 步，末尾打印可粘贴的证据块；退出码 0/1/2 = 全过 / 某步失败 / 配置或用法错） | **两段命令都齐了**：② 于 2026-09-27 入库，并已在**本机真进程 + 桩 Agent** 上实跑 14/14 与 16/16（含"凭证确实送达对端"与"结论落进记忆 events 0→1、facts 0→1"的读数）。① v0.11 已 PASS 一次（**记录级证据**，本轮未复跑）。**对真实 Agent 的 ② 仍未跑**：需要该 Agent 的 card URL 与凭证，且代理要配在 Zeus 进程的环境里（拉卡片与派发都由 Zeus 发起） |
| A2 | 生产 RSK 密钥托管 / 轮换 / 公钥发布（deferred #7 / E4.9 R2 / E5.4 bayjf R2） | 密钥落在受控位置（KMS/文件）、按 §5.4 手册有轮换次序；bayjf 名册对外公开前公钥已发布且指纹已带外公告；`NODE_ENV=production` 无钥拒启已验证 | `scripts/gen-rsk-key.mjs`（已就绪）+ `GET /api/roster/keys`（已就绪）；剩下：选托管方案、把 `jwkThumbprint` 带外公告、bayjf 侧展示 | **发布通道与运行手册已在库内**（2026-09-27，design-fealty-signing v0.2 §5.1/§5.4）；**托管选型待拍板 + 公告与 R2 展示是真实动作** |
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
3. `npm test` exit 0（当前 **786 测试 / 83 文件**；核心链路冒烟 35 步；量法就是这条命令的最后一行，别从文档抄数。**退出码要直取**：`npm test; echo $?`，管道之后的 `$?` 属于 `tail` 而不是 vitest。本机 load 数百时它会涨到 75–452s 并可能报超时红——带负载口径重跑一次再判红）
4. 三条接入通道执行点 grep 复核（见 review-mvp §B）：`boot.ts` tokenFor 接线、`orchestrator.ts` activeProviders 三态闸门、`mcp.ts` REALM_NOT_CONNECTED 白名单、onConflict→监督台闭环、持久化/签名链执行点均在位。**v0.17 追加两条"核对装配而不是核对注册"**：`serve.ts:147` 把 `dagRunner` 注入 HTTP 依赖（否则 DAG 路由在真进程里恒 503）、`boot.ts:593→408→orchestrator.ts:169` 让 `ZEUS_MAX_CONCURRENT_PER_VASSAL` 真的到达 `selectTargets`
5. 离线验签往返：`npm run verify:roster` 对一份真封出来的名册须 **exit 0**，且同一份字节在 `--now` 越过 `maxAgeSeconds` 后须 **exit 1**（这一对是"校验器既不是恒真也不是恒假"的判别，缺一不跑）。报告另有 `seal fingerprint` 两行（`jwk=` / `spki=`）——**带外固定要比的就是这一行与公告值是否逐字符相同**，不必另算哈希）
6. `docker` 真机构冒烟（B1）
7. 时钟偏置回归：`vitest` clock-skew 作业绿（deferred #24 闸门）
8. **核心链路真进程冒烟**：`npm run smoke:core`（`scripts/smoke-core.mjs`，deferred **#25** 已销项）。它起真进程 + 真 socket 走完「挂目录 → 带凭证注册 → 扇出 → 内核自己读域 → 审计落盘 → 名册离线可验（含一条 maxAge 反证）→ 发布的根公钥就是那个签名钥，且**只拿端点返回的字节就能出货验签器验过**（把 PEM 换成 JWK 串须退 2），**且同一串指纹在出钥、发布、验签三处一致**（keygen 打印 → 端点 `jwkThumbprint` → 验签报告 `seal fingerprint` 行）→ 吊销断流 → SIGTERM 落盘 → 重启恢复」，35 步全绿才退 0；只用回环、自造密钥与令牌、不读任何真实部署的 secret，并已接进 CI（build/test 之后一步）。它第一次跑就把派发打到了没有凭证的对端——正是这条链路上"库内测试看不见、真进程才看得见"的那类缺口

## 一句话

**内核与制品已到"可演示 MVP"；上线只差真实环境里的跑起来、联起来、签出去（A1–A5 + B 系列），以及把本次新提交推到云端 CI 并确认绿（E1）。"每次上线都要靠人手工演一遍"这件事已经消掉：核心链路的真进程冒烟是仓库资产（deferred #25 已销项，§F-8）。阈值标定（C 系列）不阻塞核心 MVP，但建议在首次真实多 Agent 负载前完成一次压测。**
