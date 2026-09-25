# Zeus

> 以用户数据目录为底座、多 Agent 高效协作的操作系统：对个人，是记忆的避风港与可传承的藏宝图；对企业，是即插即用、伴随成长的「虚拟部门」。完整定位见 [docs/product-portrait.md](docs/product-portrait.md)。

本仓库当前是 Zeus 的**纯 TypeScript 内核库 + 薄传输面**：封臣注册、任务派发、监督、个人数据域、多 Agent 并发决策内核以零运行时依赖的库形态落地；另附只读 Realm MCP stdio 脚手架与 HTTP 薄传输层（Fastify）——H1 只读名册 + H2 驾驶员 API（发起意图、看决策、拍板、指标）。Fastify 依赖锁在 `src/http`，内核本身保持零传输依赖。另已落地 **Vault 藏宝图**：为连接的目录出一张只存引用的加密地图，按图能原地校验或从加密备份包恢复（E8.1/E8.2），并提供零依赖 CLI 执行器（build/check/backup/restore，E3.7；调度由外部 cron/systemd 触发，内核不内置定时器）。另落地 **Diary 日记**（E8.3：把记忆按天叙事、经 Realm 落盘/导出，GET /api/diary 读、POST generate 落盘）与 **Org 虚拟部门编制**（E9.3：部门/岗位/主管可视，任务结果追到执行 Agent、部门 lead 与拍板驾驶员；OrgRegistry 随 boot 持久化重启不丢，编制 chart/建编/安置、日记 read/generate 已上 H2 HTTP）。

## 内核模块

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| **a2a** | `src/a2a/` | 标准 A2A 协议类型 + `x-zeus-*` 封臣扩展（Agent Card、Task 生命周期含 file/URI part 与 history 透传、SSE 事件、fealty 契约、战报） |
| **registry（A1）** | `src/registry/registry.ts` | 封臣注册中心：卡片拉取注册、fealty 校验（无 fealty 即外客，拒绝入册；**oath 字段缺失或不合法也拒收并点名缺哪个字段**——`dataRealms`/`dataPolicy`/`reportBack`/`escalationPolicy` 是每次派发都要读的，过去能注册成功、到派发时才以 TypeError 崩）、健康探针、吊销、`listAll()` 全量视图、`asVassalLookup()` 实时目录 |
| **roster（R0）** | `src/registry/roster.ts` | 封神榜名册投影器：注册中心状态 → 不可变、JSON 可序列化的 internal/public 双快照；只重塑与裁剪，不造字段 |
| **dispatch（A2）** | `src/dispatch/` | 派发器：JSON-RPC + SSE 客户端（send / sendSubscribe / cancel）、数据二极管与按 `dataPolicy` 脱敏、派发前吊销阻断（不发请求不发 token）、审计 sink 与吊销审计桥 |
| **oversight（A4）** | `src/oversight/` | 监督台：收集 `input-required` 任务升级与意图级冲突升级（`ingestConflict`），驾驶员 approve / reject / `decideConflict`；reject 联动取消封臣侧任务，冲突拍板立场回交编排器，全程审计、可持久化 |
| **orchestrator（E1）** | `src/orchestrator/` | 并发决策内核：一意图 `fanOut` 多封臣并行、多流合并、确定性规则聚合（unanimous/majority/weighted）、冲突检测与升级、**LLM-as-judge 对抗复核**（`judge.ts`：规则有结论后独立复核，过门分歧转 judge-review 冲突回驾驶员闭环）、intentId 幂等重放、`cancelIntent` 传播、**并发上限与有界队列（`semaphore.ts`：`maxConcurrentBranches` 进程内在途分支上界 + FIFO 等待 + `branchQueueLimit` 溢出即拒，不配=无界）**、`resolveIntent` 决议回写（E6.2）、`resumeBranch` 补参重派（E6.3）、离线决策回放（`replay.ts` E1.6）、完整 DAG（`dag*.ts`）、并发指标（`metrics.ts`） |
| **skills（E2）** | `src/skills/` | Skill 一等模块：`validate-spec.ts` 显式规格校验（版本号/权限封闭词汇/依赖须已注册且无环）、`SkillRegistry` 登记·多版本共存·deprecate 标记·按名·域·标签检索·`registerFromCard`·`resolveTeam` 组队（歧义不静默选边）·`install/uninstall/harden`（E2.3，加固只能收窄）、`mentor.ts` MentorshipLedger 带教台账（E2.5，胜任力认证才授予提供者）；随 KernelSnapshot 持久化；H2 暴露 `/api/skills*`、`/api/mentorships*` |
| **decision（S2）** | `src/decision/` | 模型无关决策后端：端口 + Jev/LLM 适配器 + 降级；规则无法收敛时先做一次带置信度闸门的后端仲裁（`orchestrator/arbitration.ts`），规则有结论后可再做一次对抗复核（`orchestrator/judge.ts`，默认关） |
| **realm（D1）** | `src/realm/` | 数据域：`FsRealmStore` 的 connect / manifest / search / read / **write（E3.5）**，确定性 realmId、connect 快照检索、`contentDigest` 基线、路径穿越与 symlink 双检防护、原子写（tmp+rename）；**personal 与 enterprise 两型均可 connect，类型如实存储**，企业域写须 `grant.ts` 校验通过（形状/绑定本域/未过期）的驾驶员凭证、只读连接即使持凭证仍拒写；企业域→个人域不存在跨 realm 读写路径，二极制的执行点在 Dispatcher / decision prepareState / MemoryStore；MCP `tools/write` 暴露与凭证签发仍 P1；附只读 MCP stdio 脚手架（`mcp.ts` / `mcp-stdio.ts`）；**E3.6 企业域三级租户**（`tenant = org[/department[/member]]`，个人域不是租户；层级是**结构性**边界——org 可下探部门、部门不能上望或旁视，没有任何凭证能放宽它）与 **E6.4 双域授权**（`DomainGrant` 只管个人域↔企业域这一条边：个人→企业需显式签发、nonce 一次性、随快照持久化，企业→个人**永远拒**；`decideRealmAccess` 是唯一判定函数；`resolveRealmSource` 让**内核自己进 Realm 取数**并核对"声明的域 vs 内容真实的域"，放行与拒绝都进审计脊） |
| **mcp（E7 连接器）** | `src/mcp/` | 立国三纲之"连接世界"：`client.ts` 零 SDK 的 streamable-HTTP JSON-RPC 客户端（initialize 握手 + tools/resources/prompts 发现，兼容 JSON 与 SSE 帧）；`connectors.ts` ConnectorRegistry 声明（封闭权限词汇、重复拒）/ connect（失败即 refused + 审计）/ revoke（即时移出活动集），最小权限按 `mcp:<tool>` 精确裁剪发现结果；声明随 KernelSnapshot 持久化（连接不自动重建）；**H2 暴露 `/api/connectors*`，响应一律脱敏 token 只报 `hasToken`** |
| **state（E5.3）** | `src/state/` | 内核持久化：`kernel-state.ts` 把封臣表（含已吊销）、升级队列、意图结果+原始请求、**Org 编制**原子落盘（tmp+rename）并恢复；`boot.ts` 一次性装配 registry/dispatcher/oversight/orchestrator/metrics/orgRegistry，配置 `ZEUS_STATE_FILE` 时启动恢复、优雅退出落盘（metrics 仅运行时不持久化） |
| **http（H1+H2 传输面）** | `src/http/` | Fastify 薄适配层（非内核、全仓库唯一 fastify 依赖处）：H1 只读 `/healthz`、`/api/roster/public`（实时投影 + 签名名册快照，离线可验）、`/api/roster`（bearer 治理视图，同样封签）；H2 驾驶员 API（bearer）`POST /api/intents`、`GET /api/intents/:id`、`GET /api/intents/:id/replay`（E1.6 决策回放，JSON 或 `?format=text`）、`POST /api/intents/:id/cancel`、`GET /api/intents/:id/events`（H3 SSE）、`GET/POST /api/escalations`（approve/reject/resolve/approve-resume）、`GET /api/metrics`、**Skills**（`/api/skills*` 检索·注册·生命周期·组队，`/api/mentorships*` 带教）、**Org**（`GET /api/org/chart`、建编/安置、`GET /api/org/accountability/:intentId` 责任链）、**Memory**（`/api/memory/*` 检索·事实·事件·遗忘权·完整性）、**Connectors**（`/api/connectors*` 声明/连接/吊销，**响应脱敏只报 `hasToken`**）、**Decision**（`GET /api/decision` 进程实际用的决策后端与 judge 闸门）、**Audit**（`GET /api/audit` 审计回读）、**Diary**（`GET /api/diary`、`POST /api/diary/generate`）；`serve.ts` 为进程入口，经 `zeus/http` 子路径导出 |
| **vault（E8.1/E8.2/E3.7 + deferred #13）** | `src/vault/` | 藏宝图与恢复协议：`MapSource` 两态——Realm，或**逐一点名的文件白名单**（`kernel.json` 不在任何 Realm 里，v2 起可备份可恢复）；buildVault 出图只存引用 + 逐 item 指纹（**正文零泄漏**）、AES-256-GCM seal/open（scrypt/raw key，密钥分离）、L0 经 `LiveSource` 端口原地校验与漂移检测（scope 随图走）、packFull 加密内容包 + restoreFromBundle 经 FsRestoreSink 跨位恢复；`cli.ts` 为零依赖执行器（build/check/backup/restore，退出码 0/1/2/3） |
| **memory（E8 记忆层）** | `src/memory/` | 记忆整理协议：append-only 事件日志，事实只经纯函数 `consolidate` 产出（无公开写入口）、观察去重累积 provenance、矛盾默认 disputed 并确定性升级进监督台、置信度按可靠度加权；`recall.ts` BM25+向量混合检索（派生索引不持久化，随时可重建）、`reconcile.ts` 两时点漂移对账与横切不变量校验、遗忘权 `retractFacts`/`forgetSubject`（tombstone 随快照持久化）；随 KernelSnapshot 持久化；H2 暴露 `/api/memory/*` |
| **diary（E8.3）** | `src/diary/` | 记忆叙事化日记：buildDiary 把记忆事件按日历天分桶、确定性排序、内容只呈现不臆造、每行锚 eventId；buildDiariesFromState 按 realm 分组构建；persistDiary 经 Realm.write 落 `diary/YYYY-MM-DD.md`（幂等），exportDiary 稳定 JSON；H2 暴露 `GET /api/diary`、`POST /api/diary/generate` |
| **org（E9.3）** | `src/org/` | 虚拟部门编制与结果责任：部门单 lead/成员唯一/不可变，org chart 编制可视，traceAccountability 把任务结果追到执行 Agent、部门 lead、拍板驾驶员（无编制标 unassigned）；OrgRegistry 有状态持有编制、随 KernelSnapshot 持久化重启恢复；H2 暴露 `GET /api/org/chart`、建编/安置/换 lead/撤岗端点、`GET /api/org/accountability/:intentId` 责任链 |
| **onboarding（E9.1/E9.2）** | `src/onboarding/` | 上岗组合层（不新增原语，只负责拒绝）：**四道门现算不缓存**——seat（部门名册）/ account（在册未吊销封臣）/ authorization（realm 边界判定）/ mentorship（认证通过，出勤不算能力），记录只存"谁开档、谁签字、谁豁免了什么"，因此**签字后吊销封臣或撤出名册会自动失去资格**；`composeBriefing` 从已有事实装配首日岗位上下文（职责/责任链/已认证与还缺技能/谁能教/组织惯例=本部门记忆召回/读写边界两向），**答不上来的逐条进 `gaps`**，内容取稳定 digest 供任务溯源；`first-task` 过门后真走一次 fanOut。H2：`/api/org/departments/:id/commissions*`、`…/briefing/:agentId`、`…/first-task`（设计见 [design-onboarding](docs/design-onboarding.md)） |

内核统一公共出口在 `src/index.ts`（不含 http 传输面），构建产物见下文。

## 快速开始

```bash
npm install
npm run build      # tsc 出 dist/（.js + .d.ts + sourcemap）
npm test           # vitest，431 项
npm run typecheck  # tsc --noEmit
npm start          # 启动 HTTP 服务（H1 名册 + H2 驾驶员 API；需先 build；env 见 .env.example，生产部署见 docs/deployment.md）
```

部署（Docker / systemd、RSK 签名密钥、状态卷与优雅退出）见 **[docs/deployment.md](docs/deployment.md)**。生产 RSK 密钥生成：

```bash
node scripts/gen-rsk-key.mjs rsk-private.pem   # 零依赖跨平台；NODE_ENV=production 无密钥拒启
```

最小用法（Realm，自包含、无需网络）：

```ts
import { FsRealmStore } from 'zeus';

const store = new FsRealmStore();
const manifest = await store.connect('/path/to/your/dir', 'personal'); // 先连接后使用
const hits = await store.search(manifest.realmId, { text: '藏宝图' }); // 检索走 connect 快照
if (hits[0]) {
  const item = await store.read(manifest.realmId, hits[0].itemId);      // read 实时读盘，路径不外泄
  console.log(item.content);
}
```

只读 MCP stdio 脚手架（P1 预览，零新依赖；经 stdin/stdout 收发换行分隔的 JSON-RPC）：

```bash
npm run build
node dist/realm/mcp-stdio.js /path/to/your/dir   # 目录在启动时预连接授权，协议不暴露 connect/root
```

Vault 备份与恢复 CLI（E3.7，需先 build；密钥经 `ZEUS_VAULT_PASSPHRASE` 或 `--key-file` 提供）：

```bash
export ZEUS_VAULT_PASSPHRASE='your-passphrase'
npm run vault -- build  --root /path/to/dir --out backups/map.json   # 出加密图（只存指纹）
npm run vault -- check  --map backups/map.json                       # 原地漂移校验（只读；exit 2=漂移 3=root 不可达）
npm run vault -- backup --root /path/to/dir --out-dir backups        # 加密全包（map + bundle）
npm run vault -- restore --map backups/x.map.json --bundle backups/x.bundle.json --target /restore/dir
```

调度不在内核内：用 cron/systemd timer 周期调用 `backup`/`check`（示例见 [docs/deployment.md](docs/deployment.md) §7）。

HTTP 薄传输面（库用法，Fastify 依赖仅在 `zeus/http` 子路径）。H1 只读端点无需 token；H2 驾驶员 API（写意图、拍板、指标）与 internal 名册仅在传入 `internalToken` 时挂载，统一 bearer 保护：

```ts
import { VassalRegistry, Ed25519MemorySigner, Orchestrator, OversightDesk, ConcurrencyMetrics } from 'zeus';
import { createHttpServer } from 'zeus/http';

const registry = new VassalRegistry();
const oversight = new OversightDesk();
const metrics = new ConcurrencyMetrics();
// lookup/dispatcher 装配见 src/state/boot.ts 的 bootKernel()（生产进程入口已装配齐全）
const orchestrator = new Orchestrator(lookup, dispatcher, { metrics, onConflict: conflictsToDesk(oversight) });

const app = await createHttpServer({
  registry,
  signer: new Ed25519MemorySigner('zeus-rsk-dev'),
  internalToken: process.env.ZEUS_INTERNAL_TOKEN, // 不配则 /api/roster 与整个 H2 不挂载
  orchestrator, // 传入即挂载意图端点
  oversight,    // 传入即挂载升级队列端点
  metrics,      // 传入即挂载 /api/metrics
  orgRegistry,  // 传入即挂载 /api/org/* 编制与责任链端点
  skillRegistry, mentorshipLedger, // 传入即挂载 /api/skills*、/api/mentorships*
  connectorRegistry, // 传入即挂载 /api/connectors*
  decisionStatus,    // 传入即挂载 /api/decision（进程解析到的决策后端与闸门）
  auditFile,         // 传入即挂载 /api/audit（读回 JSONL 审计尾）
  kernelStats,       // 传入即挂载 /api/state（内核盘点：计数与路径，非快照内容）
  memoryStore, realmStore, // 传入即挂载 /api/memory/* 与 /api/diary*
});
await app.listen({ host: '127.0.0.1', port: 8787 });
```

H2 驾驶员 API（`npm start` 后，用 `ZEUS_INTERNAL_TOKEN` 起服务）：

```bash
TOKEN=secret
# 发起一个意图：扇出到提供该 skill 的全部活跃封臣，返回聚合决策
curl -s -X POST localhost:8787/api/intents -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skill":"review-pr","realm":"enterprise","params":{"pr":42}}'
# -> { "intentId": "intent-…", "status": "completed" | "partial" | "needs-driver", "decision": {...}, ... }

# 回查某个意图的决策
curl -s localhost:8787/api/intents/intent-xxx -H "Authorization: Bearer $TOKEN"

# 回放这单决策怎么来的：参与方/输入/立场/聚合/仲裁/复核/驾驶员决议（E1.6）
curl -s localhost:8787/api/intents/intent-xxx/replay -H "Authorization: Bearer $TOKEN"
curl -s 'localhost:8787/api/intents/intent-xxx/replay?format=text' -H "Authorization: Bearer $TOKEN"

# 规则无法收敛（分歧）时，冲突进监督台
curl -s 'localhost:8787/api/escalations?status=pending' -H "Authorization: Bearer $TOKEN"
# 驾驶员拍板：接受某个立场，决议回写聚合决策（E6.2）
curl -s -X POST localhost:8787/api/escalations/esc-xxx/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stance":"approve","note":"人工裁决理由"}'

# 取消意图的全部非终态分支；查看并发指标
curl -s -X POST localhost:8787/api/intents/intent-xxx/cancel -H "Authorization: Bearer $TOKEN"
curl -s localhost:8787/api/metrics -H "Authorization: Bearer $TOKEN"

# 查看虚拟部门编制；建部门、安置成员（lead/member）、换 lead、撤岗
# 部门 id = dept:<名字的小写 ASCII slug>；名字无 ASCII 可提取时（如纯中文）落为 dept:<sha256 前 8 位>，
# 中文名照样可建可管，显示名原样保留
curl -s localhost:8787/api/org/chart -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/org/departments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"研发部","mission":"交付"}'
# -> { "departmentId": "dept:f706f416", "name": "研发部", ... }   （用响应里的 id 继续操作）
curl -s -X POST localhost:8787/api/org/departments/dept:qa/members \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-1","role":"lead","title":"研发主管"}'
curl -s -X POST localhost:8787/api/org/departments/dept:qa/lead \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agentId":"agent-2"}'
curl -s -X DELETE localhost:8787/api/org/departments/dept:qa/members/agent-1 \
  -H "Authorization: Bearer $TOKEN"

# 读某日日记；生成日记并经 Realm.write 落 diary/YYYY-MM-DD.md
curl -s 'localhost:8787/api/diary?date=2026-09-24' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/diary/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"date":"2026-09-24"}'

# 这一单谁负责：执行 Agent → 部门 lead → 拍板驾驶员（E9.3）
curl -s localhost:8787/api/org/accountability/intent-xxx -H "Authorization: Bearer $TOKEN"

# 技能目录：检索/读单个/列版本、注册显式规格（E2.1）、按所需技能组队（E2.4）
curl -s 'localhost:8787/api/skills?domain=code' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/skills -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"code-review","name":"Code review","description":"review a PR","version":"1.0.0","permissions":["realm"],"providedBy":["pr-helper"]}'
curl -s -X POST localhost:8787/api/skills/team -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"skills":["code-review"]}'

# 生命周期（E2.3）：装/卸即时生效于组队解析；加固只能收窄已授予的权限
curl -s -X POST localhost:8787/api/skills/code-review/uninstall -H "Authorization: Bearer $TOKEN" -d '{}'
curl -s -X POST localhost:8787/api/skills/code-review/harden \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"permissions":["realm:read"],"constraints":{"maxRuntimeMs":5000}}'

# 带教（E2.5）：立项→授课→胜任力评估，认证通过才把学习者登记为提供者
curl -s -X POST localhost:8787/api/mentorships -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skillId":"code-review","mentorId":"pr-helper","learnerId":"agent-dev"}'
curl -s -X POST localhost:8787/api/mentorships/mentor-xxxx/assess \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"checks":[{"criterion":"risk triage","required":true,"passed":true,"score":0.9}]}'

# 记忆面（E8）：混合检索、事实/事件读取、遗忘权（retract/forget-subject）、完整性校验
curl -s 'localhost:8787/api/memory/recall?realmId=realm-xxx&q=上线&limit=5' -H "Authorization: Bearer $TOKEN"
curl -s "localhost:8787/api/memory/facts?realmId=realm-xxx" -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/memory/retract -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"realmId":"realm-xxx","factIds":["abcd1234"],"reason":"用户要求删除","requestedBy":"driver"}'
curl -s localhost:8787/api/memory/integrity -H "Authorization: Bearer $TOKEN"

# 决策内核到底在用什么：进程解析到的后端/judge 闸门（此前只有一行 stderr）
curl -s localhost:8787/api/decision -H "Authorization: Bearer $TOKEN"

# MCP 连接器（E7）：声明 → 握手（真跑，按权限边界裁剪工具）→ 吊销
curl -s -X POST localhost:8787/api/connectors -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"kb","name":"Knowledge Base","endpoint":"http://127.0.0.1:9000/mcp","permissions":["mcp:search"],"token":"upstream-secret"}'
curl -s -X POST localhost:8787/api/connectors/kb/connect -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE localhost:8787/api/connectors/kb -H "Authorization: Bearer $TOKEN"
# 注意：所有响应只报 hasToken，绝不回显上游 token

# 审计回读（E4.7，需 ZEUS_AUDIT_FILE）：按 runId / 封臣 / 决策类型过滤，读尾部
curl -s 'localhost:8787/api/audit?runId=run-xxx&limit=50' -H "Authorization: Bearer $TOKEN"
curl -s 'localhost:8787/api/audit?decision=vassal-revoked' -H "Authorization: Bearer $TOKEN"

# 升级队列按类分流：缺参、意图冲突、记忆争议要的回答完全不同
curl -s 'localhost:8787/api/escalations?status=pending&kind=memory-dispute' -H "Authorization: Bearer $TOKEN"

# 内核盘点：现在装了多少、重启会不会丢（只有计数与路径，绝不含快照内容本身）
curl -s localhost:8787/api/state -H "Authorization: Bearer $TOKEN"
```

> H2 操作面已具备完整封臣上线入口（`POST /api/vassals` 或 `ZEUS_VASSAL_SEEDS` 启动自动注册）；**封臣侧 pr-helper 早已部署在生产**（`https://pr-helper-ten.vercel.app`），缺的是对线上执行一次验收与一次真机扇出（见 handoff Active work 40）。端到端闭环用 mock 封臣在 `tests/http-h2.test.ts` 中完整跑通（发起→扇出→冲突升级→拍板→决议回写）。

## 当前边界

- **MVP 判定（单一事实源在 [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) §F）**：个人数据底座侧已达标（目录即数据库、藏宝图可恢复含内核状态文件、签名且一次性的企业写凭证、审计与重启恢复）；**"多 Agent 协作"侧仍判 ❌——缺的是库内执行点而非仓库外环境**：MCP 侧只有只读 resources（无 tools、无鉴权），技能注册中心不参与派发，封臣出站凭证尚未接线。
- **库 + 薄传输**：HTTP 传输层不含业务逻辑——H1 三只只读端点 + H2 驾驶员 API（发起/回查/取消意图、列/拍升级、指标、封臣注册/吊销），写端点与 internal 名册统一 bearer 保护，未配 `ZEUS_INTERNAL_TOKEN` 时整组不挂载。封臣可经 `POST /api/vassals` 注册或经 `ZEUS_VASSAL_SEEDS` 启动自动注册；internal 名册自签名链 v1.1 起同样发封签信封（`active|revoked` 两态 attestation，含吊销行，离线可验），响应 `Cache-Control: no-store`。内核状态（封臣含已吊销、监督台队列、意图结果+原始请求、Realm 连接、记忆、Mentor 台账、MCP 连接器声明、**Org 编制**）在配置 `ZEUS_STATE_FILE` 时启动恢复、SIGINT/SIGTERM 原子落盘（E5.3），未配置则纯内存；运行指标不持久化。
- **Realm 内容对外唯一传输为 MCP**（契约 v0.5），不做独立 HTTP **内容** API；只读 stdio 脚手架已落地（resources 映射 manifest/search/read、宿主预连接、绝对路径不出进程），正式 P1（鉴权、streamable HTTP、官方 SDK 兼容性复核）的触发条件仍是 read-realm 封臣出现。**边界精确化（v0.28，design-realm §6.4）**：bearer 驾驶员面可暴露 Realm 的**治理元数据与授权记录**（`GET /api/domains`、签发/吊销、不读内容的访问探针），并可用 `realmSource` 让**内核代取**内容送进派发链路——后者不向客户端返回内容，因此不构成第二个 Realm 传输面；这条区分之前写作"HTTP 不挂任何 Realm 路由"，措辞与新代码互相打脸，已更正。
- 服务端 HTTP 栈为 Fastify + 长驻进程（[docs/design-http-transport.md](docs/design-http-transport.md)）：**H1 已落地**（healthz / public 签名名册 / bearer internal 签名名册），**H2 驾驶员 API 已落地**（意图扇出/回查/取消/决策回放、升级队列 approve/reject/resolve/approve-resume 决议回写与按 kind 分流、并发指标、Skills 目录与生命周期·带教台账、Org 编制·换 lead·撤岗与责任链、Memory 检索与遗忘权·按 run 回放、Diary 日记、**MCP 连接器声明与握手（响应脱敏，绝不回显上游 token）**、**决策后端实际配置**、**审计 JSONL 回读**、**内核盘点 `GET /api/state`（只报计数与路径）**、**Realm 治理面 `/api/domains*`（挂载与租户级、跨域授权签发/吊销、不读内容的访问探针）**），**H3 服务端 SSE 已落地**（`GET /api/intents/:id/events`）；端到端测试见 `tests/http-h2.test.ts`、`tests/http-sse.test.ts`、`tests/http-org*.test.ts`、`tests/http-skills.test.ts`、`tests/http-memory.test.ts`、`tests/http-replay.test.ts`、`tests/http-diary.test.ts`、`tests/http-connectors.test.ts`、`tests/http-audit.test.ts`、`tests/http-state.test.ts`、`tests/http-domains.test.ts`。多副本与静态快照分发按需立项。
- pr-helper 验收 #6（标准 A2A 客户端守护测试）：**pr-helper 本身早已部署在生产且每天使用**，这条卡的是"没人对线上跑过一次验收"，不是待部署——`BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（默认 skill `deployment-health`，只读）。Zeus↔loom 真机联调仍待 loom 测试环境。现状与待办以 [handoff.md](handoff.md) 为准。

## 文档

- [handoff.md](handoff.md) — **交接必读**：当前状态、活跃任务、最近变更、文档完整清单
- [docs/README.md](docs/README.md) — 文档地图（按场景导航）
- [docs/product-portrait.md](docs/product-portrait.md) — 产品画像与设计哲学（目录底座 / 藏宝图 / MCP·Skill·A2A 立国三纲）
- [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议：A2A 超集、fealty / 战报 / 升级 / 治理、pr-helper 六项验收
- [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.5（connect/search/read/write、企业域三级租户与双域授权 §7、签名且一次性的企业写凭证 §7.7）
- [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造（R0–R2、签名链公开闸门）
- [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — 名册签名链 v1（Ed25519+JCS、条目 attestation + 快照 seal、TTL 硬过期、八条验收）
- [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型与 H1–H3 端点规划（Fastify + 长驻 Node、薄传输层）
- [docs/deployment.md](docs/deployment.md) — 部署手册：Docker（多阶段/非 root/健康检查/状态卷）、RSK 密钥生成与生产守卫、systemd 备选、Vault 备份恢复 CLI 与 cron 示例、上线检查清单
- [docs/design-fan-out.md](docs/design-fan-out.md) — 并发决策内核契约：fan-out/join、合并流、幂等、cancel、规则聚合、冲突升级、边界
- [docs/design-decision-backend.md](docs/design-decision-backend.md) — 模型无关决策后端（Jev/LLM 适配器、置信度闸门、降级到人工）
- [docs/design-vault.md](docs/design-vault.md) — Vault 藏宝图与恢复协议 v0.2（`MapSource`：Realm 或**文件白名单**，故内核状态文件也可备份；图只存引用、AES-GCM 密钥分离、`LiveSource` 原地校验 + 加密备份包跨位恢复、漂移检测）
- [docs/design-diary.md](docs/design-diary.md) — Diary 记忆叙事化日记（事件按天分桶、内容不臆造、锚 eventId、经 Realm 落盘/导出）
- [docs/design-org.md](docs/design-org.md) — 虚拟部门编制与结果责任（部门单 lead/成员唯一、编制可视、责任链追到 Agent/部门 lead/驾驶员）
- [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) — 项目级 MVP 评审 v0.9（功能性/完整度/可上线 + 三纲可达性；**当前判定：产品核心完全可用 MVP ❌，两条支柱缺库内执行点**）
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做项与触发条件的单一事实源

## 协作约定

见 [AGENTS.md](AGENTS.md)（任务追踪与文档分层、设计哲学、提交规范）与 [git-commit-message.md](git-commit-message.md)。进度统一登记在 handoff.md，设计文档只写设计、不重复记进度。
