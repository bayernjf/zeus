# 上线前 Checklist（Pre-launch Checklist）

- 关联：项目级评审单一事实源 [review-mvp-2026-09.md](review-mvp-2026-09.md)；deferred 项清单 [deferred-items.md](deferred-items.md)；部署面 [deployment.md](deployment.md)；容量基线 [capacity-baseline.md](capacity-baseline.md)。
- **判定（2026-09-27 v0.17 复核）**：
  - **产品核心「完全可用」MVP：✅ 达成**（库内核 + 制品就绪，三条接入通道执行点在位且装配到真进程路径，全量 737 测试 / 77 文件绿、typecheck/build 过；P0 26/26 为逐行机械计数，签名链与离线验签四条正负对照用出货命令行复跑过）。
  - **可交付真实用户 MVP：❌ 未达成**。差的是**真实环境里的执行动作**（真实封臣注册与扇出、密钥托管发布、跨实例联调、模型裁决 key 核对），无法在仓库内闭环；另加一条**库内可做**的前置项见 §F-7（deferred #25）。
- 本文按"是否阻塞上线"分层。每条尽量给命令 / 出口标准 / 当前证据分级（实测 / 记录 / 待做）。
- 设计约束红线（来自 product-portrait，任何上线动作不得违反）：数据主权在用户（给目录即用、正文不出域、备份恢复一等能力）；每个概念必须可执行；能力接入只有 MCP / Skill / A2A 三条通道，无私有旁路；个人域与企业域单向隔离、跨域读写需显式签名一次性授权。

## A. 上线硬阻塞（任一未过不可交付真实用户）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| A1 | 真实封臣注册 + 真机扇出验收（E4.8 / M3） | 起实例 → 注册一个真实封臣（pr-helper 或 loom）→ 跑一次真机扇出，且 `branch-*` 事件与决策进 audit 脊 | `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<本机代理> BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（exit 0）；再走一次 `POST /api/vassals` 注册 + `POST /api/intents` 扇出 | v0.11 已 PASS 一次（**记录级证据**，本轮 2026-09-27 未复跑）；上线前需重跑一次固化为发布证据 |
| A2 | 生产 RSK 密钥托管 / 轮换 / 公钥发布（deferred #7 / E4.9 R2 / E5.4 bayjf R2） | 密钥落在受控位置（KMS/文件）、有轮换策略；bayjf 名册对外公开前公钥已发布；`NODE_ENV=production` 无钥拒启已验证 | `scripts/gen-rsk-key.mjs`（已就绪）；选托管方案 + 发布公钥 | 工具/接线/拒启已就绪；**托管与发布待拍板 + 真实动作** |
| A3 | Zeus↔loom 真机联调 | 用 loom 的 endpoint / agent-card 跑通一次双向 A2A | 需用户侧提供 loom endpoint / card | 待外部条件 |
| A4 | Jev endpoint / key 真机核对 | 启用 S2 仲裁 / E1.3 judge 时，真实 endpoint 连通、key 有效、fallback 行为符合预期 | 配 `ZEUS_DECISION_*` / `ZEUS_JUDGE_*` 后实跑 | 仅当启用模型裁决；代码 fallback 已标注 |
| A5 | 数据域边界签名发布 | bayjf 名册在对公开前，R2（公钥发布）完成，且 `verifySignedSnapshot` 在另一端验过 | 见 A2 的发布动作 | 与 A2 同源 |

## B. 部署与运营就绪（上线前必须，属真实环境动作）

| # | 项 | 出口标准 | 命令 / 动作 | 当前状态 |
|---|---|---|---|---|
| B1 | `docker build/run` 真机构冒烟 | 镜像构建过、容器 healthy、`/data` 两文件 0600、SIGTERM 保存、重启 `restored … intents=` | `docker build -t zeus .` + deployment.md §4.3 起容器 + `curl /api/state` | v0.11 已 PASS；本次零 docker 改动，上线前复跑确认 |
| B2 | 反代 / TLS / 进程管理 | systemd 或 k8s 起停、反代终止 TLS、健康检查接 `HEALTHCHECK` | deployment.md 已备；真实托管待做 | 文档就绪，真实托管待做 |
| B3 | 审计/状态文件权限与挂载卷 | 生产卷 `/data` 权限 0600、目录自动创建、轮转后重新收紧 | 已 `mkdirSync(...,0o700)` + `appendFileSync(...,0o600)`（audit.ts:81-82） | 代码就绪；确认生产卷权限 |
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
| E1 | push dev → 云端 CI 首绿（每次推送后双矩阵绿才算销项） | `git ls-remote origin refs/heads/dev`；`git rev-list --left-right --count origin/dev...HEAD` | **2026-09-27 实测 `0 0`：此前批次已推送**；本轮之后（含 `6f86369`）仍需再推一次并确认云端绿，**云端结果本轮未验证**（`gh` 访问被权限层拦） |
| E2 | 镜像发布到 registry | 若用容器部署 | 待做 |

## F. 每次上线前必跑的验证门（回归护栏）

1. `npm run typecheck` exit 0
2. `npm run build` exit 0，`dist/` 完整（**必须在测试之前**：`tests/verify-roster.test.ts` 与 §F-5 的离线验签都跑编译产物）
3. `npm test` exit 0（当前 **737 测试 / 77 文件**；量法就是这条命令的最后一行，别从文档抄数）
4. 三条接入通道执行点 grep 复核（见 review-mvp §B）：`boot.ts` tokenFor 接线、`orchestrator.ts` activeProviders 三态闸门、`mcp.ts` REALM_NOT_CONNECTED 白名单、onConflict→监督台闭环、持久化/签名链执行点均在位。**v0.17 追加两条"核对装配而不是核对注册"**：`serve.ts:147` 把 `dagRunner` 注入 HTTP 依赖（否则 DAG 路由在真进程里恒 503）、`boot.ts:593→408→orchestrator.ts:169` 让 `ZEUS_MAX_CONCURRENT_PER_VASSAL` 真的到达 `selectTargets`
5. 离线验签往返：`npm run verify:roster` 对一份真封出来的名册须 **exit 0**，且同一份字节在 `--now` 越过 `maxAgeSeconds` 后须 **exit 1**（这一对是"校验器既不是恒真也不是恒假"的判别，缺一不跑）
6. `docker` 真机构冒烟（B1）
7. 时钟偏置回归：`vitest` clock-skew 作业绿（deferred #24 闸门）
8. **核心链路真进程冒烟**（§F 里目前唯一没有命令的一项，见 deferred **#25**）：起真进程 + 真 socket 走完「挂目录 → 带凭证注册 → 扇出 → 聚合 → 审计落盘 → 名册离线可验 → 吊销断流 → 重启恢复」。历史上每次都是评审临时手写、跑完即弃，**上线前应先把它固化成 `scripts/smoke-core.mjs`**

## 一句话

**内核与制品已到"可演示 MVP"；上线只差真实环境里的跑起来、联起来、签出去（A1–A5 + B 系列），以及把本次新提交推到云端 CI 并确认绿（E1）。此外还有一件**库内可做**的事挡在"每次上线都要靠人手工演一遍"和"一条命令就能重跑验收"之间：把核心链路的真进程冒烟固化成脚本（deferred #25，§F-8）。阈值标定（C 系列）不阻塞核心 MVP，但建议在首次真实多 Agent 负载前完成一次压测。**
