# Zeus

一个**多 Agent 编排运行时**：把一个结构化任务并行派发给多个已注册的外部 Agent，收集它们带依据的返回结果，按确定性规则聚合为一个**可追溯、可复核、可人工裁决**的决策；用户的本地数据目录是这套运行时的数据底座，数据主权与可恢复性优先。完整产品定位见 [docs/product-portrait.md](docs/product-portrait.md)。

## 这个仓库是什么

当前形态是 **TypeScript 运行时核心库 + 薄 HTTP 传输层**：

- **库**（`src/`，除 `src/http/` 外零运行时依赖）：Agent 注册与派发、并发派发/汇聚、规则聚合、冲突检测与升级、模型无关的决策后端与对抗复核、离线决策回放、完整 DAG、并发治理（信号量 + 有界队列）、数据域访问与跨域授权、记忆存储与叙事日志、组织结构与问责、上岗资格校验、审计与持久化恢复。
- **唯一生产依赖是 Fastify，且被限制在 `src/http/`**：H1 只读端点（健康检查、签名目录快照）+ H2 操作面（发起任务、回查决策、人工裁决、指标、盘点）+ H3 服务端 SSE。核心代码里 grep 不到 fastify。
- **数据接入**：数据域（本地目录）通过 MCP 对外暴露，只读工具 `search` / `read` + resources，宿主预连接的白名单即边界；另有零 SDK 的 MCP 客户端做外部系统连接器。
- **可恢复性**：备份清单（只存引用与逐条指纹）+ AES-256-GCM 加密内容包，可原地校验漂移、可跨位置恢复；运行时状态文件（含注册表、升级队列、意图结果、组织编制、授权台账）也在覆盖范围内。零依赖 CLI（`build` / `check` / `backup` / `restore`），调度交给外部 cron/systemd，核心不内置定时器。

## 术语

本仓库统一使用下面的术语，不使用叙事化别名。

| 术语 | 含义 | 代码原语 |
| --- | --- | --- |
| 执行 Agent（worker agent） | 已注册、可被派发任务的外部 Agent，经标准 A2A 协议交互 | `VassalEntry`、`VassalRegistry` |
| 注册握手（registration attestation） | Agent 卡片上的归属与数据策略声明，缺失或不合法即拒绝注册 | `x-zeus-fealty`、`Fealty` |
| 目录快照（roster） | 注册表状态的不可变、可 JSON 序列化投影，分 internal / public 两版，均带签名 | `projectInternalRoster` / `projectPublicRoster`、`sealSnapshot` |
| 并行派发（fan-out） | 一个任务同时下发给多个执行 Agent，多路事件流合并回一条 | `Orchestrator.fanOut`、`Dispatcher` |
| 结果立场（position） | 单个 Agent 在任务终态后回传的结构化意见：立场 + 依据 + 权重 | `Position = { vassal, stance, weight?, rationale? }` |
| 规则聚合（rule-based aggregation） | 一致 / 多数 / 加权三种确定性策略把多个立场合为一个决策 | `aggregate`、`AggregationRule` |
| 冲突升级（conflict escalation） | 规则无法收敛或 Agent 索要缺失输入时，把事项交入人工处理队列 | `OversightDesk`、`ingestConflict` |
| 人工裁决（operator decision） | 人给出立场后回写聚合结果并重算整体状态；也可补参重派 | `applyConflictResolution`、`resumeBranch` |
| 模型仲裁 / 对抗复核 | 规则不收敛时按置信度闸门调用决策后端裁决；规则有结论后可再做一次对抗式复核 | `arbitrateSplit`、`judgeDecision` |
| 决策回放（deterministic replay） | 从持久化事实重建一次决策的完整过程（参与方、输入、立场、聚合、裁决、人工裁决） | `replay.ts`、`GET /api/intents/:id/replay` |
| 数据域（data domain） | 一个可连接的本地目录，分 `personal` 与 `enterprise` 两型；连接即建立检索索引 | `FsRealmStore` |
| 租户范围（tenant scope） | 企业域的三级隔离：`org / department / member`；层级是结构性边界，任何凭证都不能放宽 | `TenantScope` |
| 跨域授权（cross-domain grant） | 个人域→企业域的唯一放行通道：由运行时核心签名、绑定本域、带过期、nonce 一次性 | `DomainGrant`、`issueDriverWriteGrant` |
| 单向隔离（data diode） | 企业域内容可进入决策，反向路径不存在；执行侧只看到任务范围内的输入 | 派发侧脱敏、`decideRealmAccess` |
| 能力目录（skill catalogue） | 显式规格的技能登记：多版本共存、检索、组队解析、安装/卸载/权限收窄即时生效 | `SkillRegistry` |
| 能力认证（capability attestation） | 一个 Agent 被授予"某技能提供者"身份需通过逐项评估，出勤不计入能力 | `MentorshipLedger` |
| 组织结构与问责（org and accountability） | 部门、单一负责人、成员归属；任一任务可追到执行 Agent → 部门负责人 → 人工裁决者 | `OrgRegistry`、`traceAccountability` |
| 上岗校验（onboarding gate） | 四道门：编制在册 + Agent 未吊销 + 数据域授权 + 能力认证；每次现算不缓存 | `src/onboarding/` |
| 备份清单 / 加密包（backup manifest / bundle） | 清单只存引用与指纹；加密包含正文，可跨位置恢复 | `src/vault/` |
| 记忆存储（memory store） | 只追加的事件日志 + 由纯函数派生的事实层；矛盾默认标记为争议并进入人工队列 | `MemoryStore`、`consolidate` |
| 叙事日志（narrative log） | 把记忆事件按天组织成可读记录，内容只呈现不臆造，每条锚定事件 ID | `src/diary/` |
| 审计日志（audit log） | JSONL 落盘、按字节上限自轮转、可按 runId / Agent / 决策类型回读 | `jsonlAuditSink`、`GET /api/audit` |
| 状态快照（state snapshot） | 运行时状态原子落盘（tmp + rename）与启动恢复；文件权限固定 0600 | `KernelSnapshot`、`bootKernel` |

## 模块与职责

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| 协议层 | `src/a2a/` | 标准 A2A 类型（Agent Card、任务生命周期、SSE 事件、file/URI part 与 history 透传）+ `x-zeus-*` 扩展 |
| 执行 Agent 注册表 | `src/registry/registry.ts` | 拉取卡片注册、归属校验（缺字段即拒收并点名缺哪个字段）、健康探针、吊销、全量视图、实时查找；出站凭证存取与四视图脱敏 |
| 目录快照投影 | `src/registry/roster.ts` | 注册表 → 不可变 internal / public 双投影，只重塑与裁剪不造字段；`active` / `revoked` 两态 attestation |
| 派发器 | `src/dispatch/` | JSON-RPC + SSE 客户端（`send` / `sendSubscribe` / `cancel`）、按数据策略脱敏、派发前吊销阻断（不发请求也不发凭证）、审计 sink 与吊销审计桥 |
| 人工处理队列 | `src/oversight/` | 收集缺参升级与冲突升级，支持 approve / reject / resolve；reject 联动取消对端任务；裁决立场回交编排器；可持久化 |
| 编排引擎 | `src/orchestrator/` | 并行派发与汇聚、多流合并、确定性规则聚合、冲突检测与升级、对抗复核、按任务 ID 幂等重放、取消传播、并发上限与有界队列、决议回写、补参重派、离线决策回放、完整 DAG、并发指标 |
| 能力目录 | `src/skills/` | 显式规格校验（版本 / 封闭权限词汇 / 依赖须已注册且无环）、多版本共存与弃用标记、检索与组队解析（歧义不静默选边）、安装/卸载/权限收窄、能力认证台账；派发路径读取目录裁决可用提供者 |
| 决策后端 | `src/decision/` | 模型无关端口 + 适配器 + 降级；规则不收敛时的置信闸门仲裁 |
| 数据域 | `src/realm/` | `FsRealmStore` 的 connect / manifest / search / read / write、确定性 realmId、内容摘要基线、路径穿越与符号链接双检、原子写；两型均可连接且类型如实存储；企业域写需签名且一次性的授权凭证，只读连接即使持凭证仍拒写；三级租户范围与跨域授权判定；只读 MCP 服务端（resources + tools）与 stdio 宿主 |
| 外部系统连接器 | `src/mcp/` | 零 SDK 的 streamable-HTTP JSON-RPC 客户端（握手 + tools/resources/prompts 发现，兼容 JSON 与 SSE 帧）；连接器声明（封闭权限词汇）/ 连接（失败即拒并审计）/ 吊销，最小权限精确裁剪发现结果，且只有经握手发现并被声明裁剪后保留的工具才可调用 |
| 状态与装配 | `src/state/` | 状态快照原子落盘与恢复（注册表含已吊销、升级队列、任务结果与原始请求、组织编制、授权台账、凭证 nonce 账本）；一次性装配运行时；优雅退出落盘 |
| HTTP 传输层 | `src/http/` | 全仓库唯一 fastify 依赖处。H1 只读：`/healthz`、`/api/roster/public`（离线可验签）、`/api/roster`（bearer，同样签名）；H2 操作面（bearer，未配 token 时整组不挂载）：任务发起 / 回查 / 取消 / 决策回放 / 进度 SSE、人工处理队列（approve / reject / resolve / 补参重派 / 按类型分流）、并发指标、执行 Agent 注册与吊销、能力目录与认证、组织结构与问责链、记忆与遗忘权、连接器、决策后端实际配置、审计回读、运行时盘点（只报计数与路径）、数据域治理面（挂载、租户级、跨域授权签发/吊销、不读内容的访问探针）；`serve.ts` 为进程入口 |
| 备份与恢复 | `src/vault/` | 清单来源可为数据域或逐一点名的文件白名单；出图只存引用与逐条指纹（正文零泄漏）；AES-256-GCM 加解密且密钥与图分离；原地校验与漂移检测；加密全包与跨位恢复；零依赖 CLI，退出码 0/1/2/3 |
| 记忆层 | `src/memory/` | 只追加事件日志 + 纯函数派生事实、观察去重累积来源、矛盾默认争议并确定性进入人工队列、置信度按可靠度加权；BM25 + 向量混合检索（派生索引可随时重建、不持久化）；两时点漂移对账；遗忘权与撤回（墓碑随快照持久化） |
| 叙事日志 | `src/diary/` | 事件按日历天分桶、确定性排序、每行锚定事件 ID；经数据域写路径落盘（幂等）并可稳定 JSON 导出 |
| 组织结构 | `src/org/` | 部门单负责人、成员唯一、不可变；结构可视；任一任务结果追到执行 Agent → 部门负责人 → 人工裁决者，无编制则标记未分配 |
| 上岗校验 | `src/onboarding/` | 不新增原语、只负责拒绝的组合层：四道门每次现算不缓存，因此签字后吊销 Agent 或撤出编制会自动失去资格；首日简报只从已有事实装配并把答不上来的逐条列为缺口；首个任务过门后真走一次并行派发 |

库的统一公共出口在 `src/index.ts`（不含 HTTP 传输面）。

## 快速开始

```bash
npm install
npm run build      # tsc 输出 dist/（.js + .d.ts + sourcemap）
npm test           # vitest：692 项 / 72 个测试文件（以此命令的输出为准）
npm run typecheck  # tsc --noEmit
npm start          # 启动 HTTP 服务（H1 只读 + H2 操作面 + H3 SSE；需先 build）
```

环境变量见 `.env.example`；部署（Docker 多阶段非 root 镜像、签名密钥、状态卷、优雅退出、备份调度示例）见 **[docs/deployment.md](docs/deployment.md)**。签名密钥生成：

```bash
node scripts/gen-rsk-key.mjs rsk-private.pem   # 零依赖跨平台；NODE_ENV=production 无密钥时拒绝启动
```

数据域最小用法（自包含、无需网络）：

```ts
import { FsRealmStore } from 'zeus';

const store = new FsRealmStore();
const manifest = await store.connect('/path/to/your/dir', 'personal'); // 必须先连接
const hits = await store.search(manifest.realmId, { text: 'keyword' }); // 检索走连接快照
if (hits[0]) {
  const item = await store.read(manifest.realmId, hits[0].itemId);     // 读取实时落盘，绝对路径不外泄
  console.log(item.content);
}
```

数据域 MCP 服务（stdio，零新增依赖；换行分隔的 JSON-RPC）：

```bash
npm run build
node dist/realm/mcp-stdio.js /path/to/your/dir   # 启动时预连接并授权；协议不暴露 connect / root
```

备份与恢复 CLI（需先 build；密钥经 `ZEUS_VAULT_PASSPHRASE` 或 `--key-file` 提供）：

```bash
export ZEUS_VAULT_PASSPHRASE='your-passphrase'
npm run vault -- build   --root /path/to/dir --out backups/map.json   # 出清单（只存引用与指纹）
npm run vault -- check   --map backups/map.json                       # 原地漂移校验（只读；退出码 2=漂移，3=目录不可达）
npm run vault -- backup  --root /path/to/dir --out-dir backups        # 加密全包（清单 + 内容包）
npm run vault -- restore --map backups/x.map.json --bundle backups/x.bundle.json --target /restore/dir
```

备份调度不在运行时核心内：用 cron 或 systemd timer 周期调用 `backup` / `check`（示例见 [docs/deployment.md](docs/deployment.md) §7）。

## 用库起一个带鉴权的服务

```ts
import { VassalRegistry, Ed25519MemorySigner, Orchestrator, OversightDesk, ConcurrencyMetrics } from 'zeus';
import { createHttpServer } from 'zeus/http';

const registry = new VassalRegistry();
const oversight = new OversightDesk();
const metrics = new ConcurrencyMetrics();
// 完整装配见 src/state/boot.ts 的 bootKernel()，生产进程入口已装配齐全
const orchestrator = new Orchestrator(lookup, dispatcher, { metrics, onConflict: conflictsToDesk(oversight) });

const app = await createHttpServer({
  registry,
  signer: new Ed25519MemorySigner('zeus-rsk-dev'),
  internalToken: process.env.ZEUS_INTERNAL_TOKEN, // 不配则 /api/roster 与整个 H2 不挂载
  orchestrator,        // 传入即挂载任务端点
  oversight,           // 传入即挂载人工处理队列端点
  metrics,             // 传入即挂载 /api/metrics
  orgRegistry,         // 传入即挂载 /api/org/*
  skillRegistry, mentorshipLedger, // 传入即挂载 /api/skills*、/api/mentorships*
  connectorRegistry,   // 传入即挂载 /api/connectors*
  decisionStatus,      // 传入即挂载 /api/decision
  auditFile,           // 传入即挂载 /api/audit
  kernelStats,         // 传入即挂载 /api/state
  memoryStore, realmStore, // 传入即挂载 /api/memory/* 与 /api/diary*
});
await app.listen({ host: '127.0.0.1', port: 8787 });
```

## 操作面示例（`npm start` 后）

```bash
TOKEN=secret
# 发起一个任务：并行派发给提供该技能的全部在册 Agent，返回聚合决策
curl -s -X POST localhost:8787/api/intents -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skill":"review-pr","realm":"enterprise","params":{"pr":42}}'
# -> { "intentId": "intent-…", "status": "completed | partial | failed | needs-driver", "decision": {...} }

curl -s localhost:8787/api/intents/intent-xxx -H "Authorization: Bearer $TOKEN"                       # 回查决策
curl -s localhost:8787/api/intents/intent-xxx/replay -H "Authorization: Bearer $TOKEN"                # 决策过程回放（?format=text 可读版）
curl -s -X POST localhost:8787/api/intents/intent-xxx/cancel -H "Authorization: Bearer $TOKEN"        # 取消全部非终态分支
curl -s localhost:8787/api/intents/intent-xxx/events -H "Authorization: Bearer $TOKEN"                # SSE 进度

curl -s 'localhost:8787/api/escalations?status=pending' -H "Authorization: Bearer $TOKEN"             # 待人工处理队列
curl -s 'localhost:8787/api/escalations?status=pending&kind=memory-dispute' -H "Authorization: Bearer $TOKEN"  # 按类型分流：缺参 / 冲突 / 记忆争议
curl -s -X POST localhost:8787/api/escalations/esc-xxx/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stance":"approve","note":"人工裁决理由"}'                                                      # 裁决并回写聚合结果
curl -s localhost:8787/api/metrics -H "Authorization: Bearer $TOKEN"                                  # 并发指标
curl -s localhost:8787/api/state -H "Authorization: Bearer $TOKEN"                                    # 运行时盘点（只有计数与路径，不含快照内容）
curl -s 'localhost:8787/api/audit?runId=run-xxx&limit=50' -H "Authorization: Bearer $TOKEN"          # 审计回读
curl -s localhost:8787/api/decision -H "Authorization: Bearer $TOKEN"                                 # 进程实际使用的决策后端与复核闸门

# 执行 Agent 上线与吊销（连接层不可达返回 502 并在 detail 中点名 URL）
curl -s -X POST localhost:8787/api/vassals -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"cardUrl":"https://agent.example/api/a2a/agent-card"}'
curl -s -X DELETE localhost:8787/api/vassals/pr-helper -H "Authorization: Bearer $TOKEN"

# 能力目录：检索、注册显式规格、按所需技能解析组队；卸载与权限收窄即时影响自动派发
curl -s 'localhost:8787/api/skills?domain=code' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/skills -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"code-review","name":"Code review","description":"review a PR","version":"1.0.0","permissions":["realm"],"providedBy":["pr-helper"]}'
curl -s -X POST localhost:8787/api/skills/team -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"skills":["code-review"]}'
curl -s -X POST localhost:8787/api/skills/code-review/uninstall -H "Authorization: Bearer $TOKEN" -d '{}'
curl -s -X POST localhost:8787/api/skills/code-review/harden \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"permissions":["realm:read"],"constraints":{"maxRuntimeMs":5000}}'

# 能力认证：逐项评估通过后才把该 Agent 登记为技能提供者
curl -s -X POST localhost:8787/api/mentorships -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skillId":"code-review","mentorId":"pr-helper","learnerId":"agent-dev"}'
curl -s -X POST localhost:8787/api/mentorships/mentor-xxxx/assess \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"checks":[{"criterion":"risk triage","required":true,"passed":true,"score":0.9}]}'

# 组织结构与问责链（部门 id 前缀 dept:；纯中文名无 ASCII 可提取时落为 dept:<sha256 前 8 位>，显示名原样保留，后续操作请使用响应里的 id）
curl -s localhost:8787/api/org/chart -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/org/departments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"研发部","mission":"交付"}'
curl -s -X POST localhost:8787/api/org/departments/dept:qa/members \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-1","role":"lead","title":"研发主管"}'
curl -s -X POST localhost:8787/api/org/departments/dept:qa/lead \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agentId":"agent-2"}'
curl -s -X DELETE localhost:8787/api/org/departments/dept:qa/members/agent-1 -H "Authorization: Bearer $TOKEN"
curl -s localhost:8787/api/org/accountability/intent-xxx -H "Authorization: Bearer $TOKEN"

# 上岗校验与首日简报：台账、开档、豁免、签字、撤回、简报、首个任务
curl -s localhost:8787/api/org/departments/dept:qa/commissions -H "Authorization: Bearer $TOKEN"
curl -s localhost:8787/api/org/departments/dept:qa/briefing/agent-1 -H "Authorization: Bearer $TOKEN"

# 记忆与遗忘权
curl -s 'localhost:8787/api/memory/recall?realmId=realm-xxx&q=关键词&limit=5' -H "Authorization: Bearer $TOKEN"
curl -s "localhost:8787/api/memory/facts?realmId=realm-xxx" -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/memory/retract -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"realmId":"realm-xxx","factIds":["abcd1234"],"reason":"用户要求删除","requestedBy":"operator"}'
curl -s localhost:8787/api/memory/integrity -H "Authorization: Bearer $TOKEN"

# 叙事日志
curl -s 'localhost:8787/api/diary?date=2026-09-24' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/diary/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"date":"2026-09-24"}'

# 外部系统连接器：声明 → 握手（按权限边界裁剪工具）→ 调用 → 吊销
curl -s -X POST localhost:8787/api/connectors -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"kb","name":"Knowledge Base","endpoint":"http://127.0.0.1:9000/mcp","permissions":["mcp:search"],"token":"upstream-secret"}'
curl -s -X POST localhost:8787/api/connectors/kb/connect -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/connectors/kb/tools/search/call \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"arguments":{"query":"x"}}'
curl -s -X DELETE localhost:8787/api/connectors/kb -H "Authorization: Bearer $TOKEN"
# 所有连接器响应只报 hasToken，绝不回显上游凭证

# 数据域治理面：挂载、跨域授权签发/吊销、不读内容的访问探针
curl -s localhost:8787/api/domains -H "Authorization: Bearer $TOKEN"
```

端到端闭环（发起 → 并行派发 → 冲突进入人工队列 → 裁决回写）在 `tests/http-h2.test.ts` 中用模拟执行 Agent 完整跑通。

## 当前状态与边界

> 状态以 [handoff.md](handoff.md) 为准；MVP 判定的单一事实源是 [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md)。

- **MVP 判定：产品核心完全可用 = ✅**（评审 v0.10 判定、v0.12 在真进程 / 真 socket / 自建容器上逐条复跑复核）。判定依据的边界也已写明：对线上执行 Agent 的那次标准协议验收是一次真实执行，非本评审复现；仓库外仍差的事是真实环境联调与密钥托管，不是代码缺口。
- **已验证到什么程度**：692 项测试 / 72 个测试文件，`tsc --noEmit` 与 build 各自 exit 0；GitHub Actions Node 20.x / 22.x 双矩阵每次推送均绿；Docker 镜像实构实跑（健康检查、状态文件与审计文件 0600、SIGTERM 保存、重启恢复）；带出站凭证的执行 Agent 协作经真实 socket 验证（凭证不外泄、吊销即刻断流、重启后凭证仍在）。
- **协议验收**：对生产环境的执行 Agent 跑通过一次纯标准 A2A 客户端验收（卡片发现 + 任务受理）。
- **仍待外部条件**：与 loom 的真机联调、决策后端的真实 endpoint/key 核对、签名密钥的实际托管与公钥发布（deferred #7）、MCP 暴露侧的主体身份判定（deferred #18，等真实读取方出现）。
- **明确不存在的能力**：**入站 A2A 面**（外部 Agent 尚不能把任务派给 Zeus：无对外 Agent Card、无 `tasks/*` 路由），已登记 deferred #19；数据域边界的显式变更操作（下线 / 改租户）无可执行路径（#17）；部分启动参数校验口径不一致，待人工裁定（#20）。
- **数据主权的实现方式**：数据域内容对外的唯一传输是 MCP，HTTP 侧只到治理元数据与授权记录为止；`GET /api/state` 只报计数与路径，不服用含凭证与记忆明文的状态快照；上游凭证在任何响应中只以 `hasToken` 呈现。
- **已知风险**：`ubuntu-latest` 将于 2026-10-19 自动迁移构建机镜像（#16，到期前决定钉版或迁移后复验）。

## 标识符说明

源码与环境变量里保留了一批项目早期命名（`vassal`、`fealty`、`roster`、`realm`、`vault`、`kernel`、`driver`、`commission`、`mentorship`、`diary`、`noul`）。它们是接口的一部分，含义、出现面与"为什么不能顺手改名"逐条记在 [docs/terminology.md](docs/terminology.md) 的「历史标识符的含义」与「破坏性面」两节。一句话：**这些名字不代表任何第三方系统或集成**（例如 `src/vault/` 与 HashiCorp Vault 无关），本文档一律使用上文的工程术语，不使用这些历史名做叙述词。

## 文档

- [handoff.md](handoff.md) — **接手必读**：当前状态、活跃任务、最近变更、完整文档清单
- [docs/README.md](docs/README.md) — 文档地图（按场景导航）
- [docs/terminology.md](docs/terminology.md) — 术语对照：内部标识符 ↔ 工程原语 ↔ 业界标准用语，含同名易混分级
- [docs/product-portrait.md](docs/product-portrait.md) — 产品定位与设计哲学
- [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 执行 Agent 协议：A2A 超集、注册握手、结果回传、升级与治理、六项验收
- [docs/design-realm.md](docs/design-realm.md) — 数据域接口契约（connect / search / read / write、三级租户与跨域授权、签名且一次性的写授权凭证）
- [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — 目录快照投影与公开发布改造
- [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — 目录签名链（Ed25519 + JCS、条目 attestation、快照签名、TTL、八条验收）
- [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型与端点规划（薄传输层约束）
- [docs/deployment.md](docs/deployment.md) — 部署手册：Docker、签名密钥与生产守卫、systemd 备选、备份 CLI 与 cron 示例、上线检查清单
- [docs/design-fan-out.md](docs/design-fan-out.md) — 并发编排契约：并行派发与汇聚、合并流、幂等、取消、规则聚合、冲突升级、边界
- [docs/design-decision-backend.md](docs/design-decision-backend.md) — 模型无关决策后端（适配器、置信闸门、降级到人工）
- [docs/design-vault.md](docs/design-vault.md) — 备份与恢复协议（清单来源含文件白名单、只存引用、密钥分离、原地漂移校验、跨位恢复）
- [docs/design-diary.md](docs/design-diary.md) — 叙事日志（事件按天分桶、不臆造内容、锚定事件 ID）
- [docs/design-org.md](docs/design-org.md) — 组织结构与问责（部门单负责人、结构可视、责任链）
- [docs/design-onboarding.md](docs/design-onboarding.md) — 上岗校验与首日简报（四道门现算不缓存）
- [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) — 项目级评审（功能性 / 完整度 / 可上线；**现行判定：产品核心完全可用 MVP ✅**）
- [docs/capacity-baseline.md](docs/capacity-baseline.md) — 本机容量基线（多场景，含并发闸门档）
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做项与各自的触发条件（单一事实源）

## 协作约定

见 [AGENTS.md](AGENTS.md)（任务追踪与文档分层、设计哲学、提交规范）与 [git-commit-message.md](git-commit-message.md)。进度统一登记在 `handoff.md`，设计文档只写设计、不重复记进度。
