# 上线 env 逐行核对表（B2 / B3 / B4）

- 用途：上线前对**真实部署实例**逐行核对 `.env.example` 里的每一个变量，避免「起得来但跑不通」或「设了但没人读」。
- 来源：`.env.example`（65 行变量）+ [pre-launch-checklist.md](pre-launch-checklist.md) 的 B2/B3/B4 条目；口径与 [deployment.md](deployment.md) §2 一致。
- 用法：每行在「实际值确认栏」填**脱敏后的实际值**（只写前 6 位/是否为空/是否来自 secret，不抄密钥）并打勾；`条件必需` 指"对应能力启用时必须给"，未启用时可空。
- 生成日期：2026-11-06。变量有任何增删，先跑 `npm test` 的 doc-consistency/config-surface 断言，再更新本表。

## 1. 核心进程与 HTTP 面

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_HOST` | 可选（默认 `127.0.0.1`） | 仅监听回环；容器内必须设 `0.0.0.0`，否则宿主机/反代连不上 | ☐ 已核对：________ |
| `ZEUS_PORT` | 可选（默认 `8787`） | 用默认端口；与反代 upstream 不符时 502 | ☐ 已核对：________ |
| `ZEUS_PUBLIC_URL` | 反代部署必需 | agent-card / A2A 对外地址按 bind 默认推导，外部客户端拿到错误 endpoint | ☐ 已核对：________ |
| `ZEUS_INTERNAL_TOKEN` | 挂内部面时必需 | `/api/roster`、`/api/audit`、`/api/state` 等 bearer 面**完全不挂载**（公开名册仍服务） | ☐ 已核对：________ |
| `ZEUS_CORS_ORIGINS` | 浏览器客户端时必需 | 不发 CORS 头，浏览器 supervisor 跨域被拒（CLI/curl 不受影响） | ☐ 已核对：________ |
| `ZEUS_SSE_MAX_STREAMS` | 可选 | 无上限，异常客户端可长期占用 SSE 槽位 | ☐ 已核对：________ |
| `ZEUS_SSE_ATTACH_GRACE_MS` | 可选（默认 30000） | 用默认 30s 首事件宽限；调错会让未知 intent 长期挂住 socket | ☐ 已核对：________ |

## 2. 持久化与恢复

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_STATE_FILE` | 生产必需 | 全内存运行，重启丢失名册、升级队列与 intent 幂等表 | ☐ 已核对：________ |
| `ZEUS_DB_FILE` | 生产必需（用决策/组织持久化时） | 决策、审批、组织与任务只存内存，重启即丢 | ☐ 已核对：________ |
| `ZEUS_INTENT_RETENTION` | 可选（默认 `retain`） | 用 `retain`；`archive`/`evict` 的幂等承诺不同，改前先读 design-intent-retention | ☐ 已核对：________ |
| `ZEUS_INTENT_RETENTION_MAX_ENTRIES` | 可选（默认 10000） | 用默认出窗条数；过小会提前归档仍被引用的记录 | ☐ 已核对：________ |
| `ZEUS_INTENT_RETENTION_WINDOW_MS` | 可选（默认 30 天） | 用默认窗口 | ☐ 已核对：________ |
| `NODE_ENV` | 生产必需设 `production` | 缺失按 development：RSK 退化为临时内存钥只告警一次，重启后名册验签失效 | ☐ 已核对：________ |

## 3. 审计与观测

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_AUDIT_FILE` | 生产必需 | 审计只进 stderr；`GET /api/audit` 不挂载，trace export 无法重建 | ☐ 已核对：________ |
| `ZEUS_AUDIT_MAX_BYTES` | 可选（默认 64MiB） | 用默认轮转阈值；填 `0/off` 需同时接外部 logrotate，否则撑满卷 | ☐ 已核对：________ |
| `ZEUS_AUDIT_KEEP` | 可选（默认 5） | 用默认保留代数；总占用 = maxBytes × (keep + 1) | ☐ 已核对：________ |
| `ZEUS_DECISION_AUDIT_FILE` | 生产建议 | 决策封签链只存内存，重启丢失且无法验旧链；开启时必须配持久 `ZEUS_RSK_KEY*` | ☐ 已核对：________ |
| `ZEUS_TRACE_EXPORT_FILE` | 可选 | 不导出 trace 树；开启时同时需要 `ZEUS_AUDIT_FILE` | ☐ 已核对：________ |
| `ZEUS_METRICS_HISTORY_FILE` | 可选 | `GET /api/metrics/history` 不挂载，无跨重启趋势 | ☐ 已核对：________ |
| `ZEUS_OTLP_ENDPOINT` | 可选 | 不构造 OTLP exporter、不外拨 | ☐ 已核对：________ |
| `ZEUS_OTLP_HEADERS` | 可选 | collector 需鉴权时请求被拒；格式错的条目会跳过并告警 | ☐ 已核对：________ |
| `ZEUS_DECISION_TRACE_FILE` | 可选 | 无 per-call 决策台账（tokens/成本/延迟） | ☐ 已核对：________ |

## 4. 决策后端与 judge

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_JEV_ENABLED` | 可选（未设置 = 配了即启用） | 未设置保持既有行为；设为 `0/false/no/off` 时即使凭据已配也退回 rules-only。**关闭时必须在 checklist A4 行标注** | ☐ 已核对：________ |
| `ZEUS_DECISION_BASE_URL` + `ZEUS_DECISION_API_KEY` | 条件必需（启用 Jev 时） | 缺任一 → 不构造 Jev 后端，S2 仲裁/judge 落到 rules-only（设计内降级） | ☐ 已核对：________ |
| `ZEUS_DECISION_MODEL` | 可选（默认 `jev-latest`） | 用适配器默认模型；模型名错会表现为决策调用 4xx | ☐ 已核对：________ |
| `ZEUS_DECISION_WEBHOOK_URL` + `ZEUS_DECISION_WEBHOOK_SECRET` | 可选 | 缺 secret 时 fail-closed 不推送；消费方需轮询决策状态 | ☐ 已核对：________ |
| `ZEUS_JUDGE_ENABLED` | 可选（默认关） | judge 不参与裁决；只设它而无后端时仍保持关闭（启动告警） | ☐ 已核对：________ |
| `ZEUS_JUDGE_THRESHOLD` | 可选 | 用内置阈值；非数字值会**拒启**（不是静默忽略） | ☐ 已核对：________ |
| `ZEUS_JUDGE_ALLOW_UNCALIBRATED` | 可选（默认关） | 仅校准后 judge 采信；开启即放弃该防线，只用于实验环境 | ☐ 已核对：________ |
| `MODEL_HUB_URL` + `MODEL_HUB_TOKEN` | 条件必需（W7-3 后唯一 hub 后端） | 缺任一 → hub 不装配，退回 env 决策后端；两者都没有则 rules-only | ☐ 已核对：________ |
| `MODEL_HUB_CACHE_PATH` | 可选（默认 `./data/model-cache.json`） | 用默认缓存路径；只读卷会让缓存写失败（fail-soft） | ☐ 已核对：________ |
| `ZEUS_LLM_BASE_URL` + `ZEUS_LLM_API_KEY` + `ZEUS_LLM_MODEL` | 遗留（不建议生产启用） | **代码仍会读取并在 Jev 缺席时生效**，与模板「已 deseatGranted」表述不一致：上线前必须确认是否允许裁决数据出境，否则保持三项全空 | ☐ 已核对：________ |

## 5. 并发、限流与成本

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_MAX_CONCURRENT_BRANCHES` | 生产建议 | 无上限扇出，共享下游 Agent 可能被打满；非数字拒启 | ☐ 已核对：________ |
| `ZEUS_BRANCH_QUEUE_LIMIT` | 可选 | 溢出分支无限等待（`0` = 不排队，直接失败） | ☐ 已核对：________ |
| `ZEUS_MAX_CONCURRENT_PER_EXECUTOR` | 可选 | 不启用背压分流；须小于全局上限，否则无空闲候选可切 | ☐ 已核对：________ |
| `ZEUS_COST_WINDOW_MS` | 可选 | 成本窗口维度不限 | ☐ 已核对：________ |
| `ZEUS_COST_MAX_WINDOW_COST` | 可选 | 单窗口成本闸门关闭，超支扇出不会被拒 | ☐ 已核对：________ |
| `ZEUS_COST_MAX_RATE_PER_WINDOW` | 可选 | 速率熔断关闭 | ☐ 已核对：________ |

## 6. 域、外部集成与记忆面

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_EXECUTOR_SEEDS` | 可选（首次引导） | 启动不自动注册执行 Agent；可改用 `POST /api/executors` | ☐ 已核对：________ |
| `ZEUS_OUTBOUND_ALLOW_HOSTS` | 内网 peer 时必需 | 出站守卫拒绝私网目标（RFC1918/ULA 等），联调表现为不可达 | ☐ 已核对：________ |
| `ZEUS_DATA_DOMAIN_ROOTS` | 可选 | 不连接个人域；首连后可留空，状态文件会重连 | ☐ 已核对：________ |
| `ZEUS_DATA_DOMAIN_ENTERPRISE` | 企业域时必需 | 不挂企业域；条目缺 tenant 或非法会**直接拒启**（防止无边界域） | ☐ 已核对：________ |
| `ZEUS_AGENT_WORLD_BASE_URL` | 条件必需（用 org 执行） | 组织任务返回 `503 ORG_EXECUTOR_UNCONFIGURED`，不伪造执行 | ☐ 已核对：________ |
| `ZEUS_A2A_PUSH_URL` | 可选 | push 回调端点不挂载，出站仍走 SSE | ☐ 已核对：________ |
| `ZEUS_MEMORY_EMBEDDING` | 可选 | 默认开启 hub embedding；设 `off` 固定本地 hash、正文不出域 | ☐ 已核对：________ |
| `ZEUS_MEMORY_SERVICE_TOKENS` | 跨 Agent 记忆面必需 | 面完全不挂载（fail-closed）；格式 `namespace:token,namespace2:token2` | ☐ 已核对：________ |

## 7. 凭证与密钥

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_RSK_KEY` / `ZEUS_RSK_KEY_FILE` | 生产必需其一 | `NODE_ENV=production` 无钥**拒绝启动**；容器内**必须走挂载**（`docker cp` 会带宿主 uid，`USER node` 读不到） | ☐ 已核对：________ |
| `ZEUS_RSK_KEY_ID` | 生产必需显式设置 | 默认 `zeus-rsk-dev`；验签方按 keyId 找公钥，生产沿用开发值会造成轮换/公告对不上 | ☐ 已核对：________ |
| `ZEUS_SECRET_FILE` | 条件必需（本地 secret 后端） | 只能读进程环境；文件缺失时对应 credential ref 解析失败 | ☐ 已核对：________ |
| `ZEUS_SECRET_AGENT_WORLD_LOGIN` | 条件必需（agent-world 登录） | `agent-world:login` 解析失败，相关岗位执行被拒（fail-closed） | ☐ 已核对：________ |

## 8. CLI / 离线工具（serve 进程不读）

| 变量 | 必需性 | 缺失后果 | 实际值确认栏 |
|---|---|---|---|
| `ZEUS_BASE_URL` | TUI 必需（默认 `http://127.0.0.1:8787`） | TUI 连错实例；不影响 serve | ☐ 已核对：________ |
| `ZEUS_TUI_INTERVAL_MS` | 可选（默认 3000） | 用默认刷新间隔（`0` = 仅手动刷新） | ☐ 已核对：________ |
| `ZEUS_BACKUP_PASSPHRASE` | 备份/恢复时必需 | 无法构建或恢复加密备份包；**只能放在调度器环境，不得进 `.env` 或镜像** | ☐ 已核对：________ |
| `ZEUS_EVAL_JUDGE_ENABLED` | 评测可选 | 开放题评测不启用 LLM judge，降级为 observe | ☐ 已核对：________ |
| `ZEUS_EVAL_JUDGE_ALIAS` | 可选（默认 `choice`） | 用默认 alias；hub 未分配该 alias 时 judge 失败但 fail-soft | ☐ 已核对：________ |
| `ZEUS_EVAL_JUDGE_TIMEOUT_MS` | 可选 | 用脚本默认超时；调小会让慢模型恒判失败 | ☐ 已核对：________ |
| `ZEUS_EVAL_BUDGET_MS` | 可选（默认 300000） | 单次评测墙钟预算；超时 exit 2 | ☐ 已核对：________ |
| `ZEUS_EVAL_RUNS_FILE` | 可选 | `GET /api/v1/eval-runs` 不挂载，评测结果不持久 | ☐ 已核对：________ |
| `ZEUS_CLOCK_SKEW_DAYS` | 仅 CI | 本地/CI 时钟偏移演练用，生产不设 | ☐ 已核对：________ |

## 9. B2 / B3 部署动作核对（非 env 行）

| 项 | 出口标准 | 实际值确认栏 |
|---|---|---|
| B2 反代 / TLS | 反代终止 TLS；upstream 指向 `ZEUS_HOST:ZEUS_PORT`；SSE 路径关闭缓冲（`proxy_buffering off` / `X-Accel-Buffering: no`）；HSTS 与证书链按域名策略 | ☐ 已核对：________ |
| B2 进程管理 | systemd 或 k8s 起停、异常自动重启；`EnvironmentFile`/Secret 注入与本文变量一致 | ☐ 已核对：________ |
| B2 健康检查 | `GET /healthz` 返回 200（只证存活，不证名册真实性） | ☐ 已核对：________ |
| B3 生产卷权限 | `/data` 目录 0700、`runtime-state.json` / 审计文件 0600、属主与容器 `node`(uid 1000) 匹配；轮转后仍 0600 | ☐ 已核对：________ |
| B3 挂载差异 | 宿主路径与容器内路径一致；密钥/状态卷不落镜像层；`docker cp` 不被用于密钥 | ☐ 已核对：________ |
| B4 结论 | 「读到但未用」与「静默降级」逐条列出并归档；本表 65 行全部打勾 | ☐ 已完成：________ |

## 10. 签字

- 核对人：________　核对时间：________（CST）
- 部署实例：________　`GET /healthz` version：________
- 未通过项与处置：________________________________________
