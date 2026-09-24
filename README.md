# Zeus

> 以用户数据目录为底座、多 Agent 高效协作的操作系统：对个人，是记忆的避风港与可传承的藏宝图；对企业，是即插即用、伴随成长的「虚拟部门」。完整定位见 [docs/product-portrait.md](docs/product-portrait.md)。

本仓库当前是 Zeus 的**纯 TypeScript 内核库 + 薄传输面**：封臣注册、任务派发、监督、个人数据域、多 Agent 并发决策内核以零运行时依赖的库形态落地；另附只读 Realm MCP stdio 脚手架与 HTTP 薄传输层（Fastify）——H1 只读名册 + H2 驾驶员 API（发起意图、看决策、拍板、指标）。Fastify 依赖锁在 `src/http`，内核本身保持零传输依赖。另已落地 **Vault 藏宝图**：为连接的目录出一张只存引用的加密地图，按图能原地校验或从加密备份包恢复（E8.1/E8.2），并提供零依赖 CLI 执行器（build/check/backup/restore，E3.7；调度由外部 cron/systemd 触发，内核不内置定时器）。另落地 **Diary 日记**（E8.3：把记忆按天叙事、经 Realm 落盘/导出，GET /api/diary 读、POST generate 落盘）与 **Org 虚拟部门编制**（E9.3：部门/岗位/主管可视，任务结果追到执行 Agent、部门 lead 与拍板驾驶员；OrgRegistry 随 boot 持久化重启不丢，编制 chart/建编/安置、日记 read/generate 已上 H2 HTTP）。

## 内核模块

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| **a2a** | `src/a2a/` | 标准 A2A 协议类型 + `x-zeus-*` 封臣扩展（Agent Card、Task 生命周期含 file/URI part 与 history 透传、SSE 事件、fealty 契约、战报） |
| **registry（A1）** | `src/registry/registry.ts` | 封臣注册中心：卡片拉取注册、fealty 校验（无 fealty 即外客，拒绝入册）、健康探针、吊销、`listAll()` 全量视图、`asVassalLookup()` 实时目录 |
| **roster（R0）** | `src/registry/roster.ts` | 封神榜名册投影器：注册中心状态 → 不可变、JSON 可序列化的 internal/public 双快照；只重塑与裁剪，不造字段 |
| **dispatch（A2）** | `src/dispatch/` | 派发器：JSON-RPC + SSE 客户端（send / sendSubscribe / cancel）、数据二极管与按 `dataPolicy` 脱敏、派发前吊销阻断（不发请求不发 token）、审计 sink 与吊销审计桥 |
| **oversight（A4）** | `src/oversight/` | 监督台：收集 `input-required` 任务升级与意图级冲突升级（`ingestConflict`），驾驶员 approve / reject / `decideConflict`；reject 联动取消封臣侧任务，冲突拍板立场回交编排器，全程审计、可持久化 |
| **orchestrator（E1）** | `src/orchestrator/` | 并发决策内核：一意图 `fanOut` 多封臣并行、多流合并、确定性规则聚合（unanimous/majority/weighted）、冲突检测与升级、**LLM-as-judge 对抗复核**（`judge.ts`：规则有结论后独立复核，过门分歧转 judge-review 冲突回驾驶员闭环）、intentId 幂等重放、`cancelIntent` 传播、`resolveIntent` 决议回写（E6.2）、`resumeBranch` 补参重派（E6.3）、离线决策回放（`replay.ts` E1.6）、完整 DAG（`dag*.ts`）、并发指标（`metrics.ts`） |
| **skills（E2）** | `src/skills/` | Skill 注册中心：技能登记/多版本共存/deprecate 标记、按名·域·标签检索、`registerFromCard`、`resolveTeam` 多技能组队（歧义不静默选边） |
| **decision（S2）** | `src/decision/` | 模型无关决策后端：端口 + Jev/LLM 适配器 + 降级；规则无法收敛时先做一次带置信度闸门的后端仲裁（`orchestrator/arbitration.ts`），规则有结论后可再做一次对抗复核（`orchestrator/judge.ts`，默认关） |
| **realm（D1）** | `src/realm/` | personal 数据域：`FsRealmStore` 的 connect / manifest / search / read / **write（E3.5）**，确定性 realmId、connect 快照检索、`contentDigest` 基线、路径穿越与 symlink 双检防护、原子写；企业域写授权凭证门 `grant.ts`（enterprise connect/MCP 仍 P1）；附只读 MCP stdio 脚手架（`mcp.ts` / `mcp-stdio.ts`） |
| **state（E5.3）** | `src/state/` | 内核持久化：`kernel-state.ts` 把封臣表（含已吊销）、升级队列、意图结果+原始请求、**Org 编制**原子落盘（tmp+rename）并恢复；`boot.ts` 一次性装配 registry/dispatcher/oversight/orchestrator/metrics/orgRegistry，配置 `ZEUS_STATE_FILE` 时启动恢复、优雅退出落盘（metrics 仅运行时不持久化） |
| **http（H1+H2 传输面）** | `src/http/` | Fastify 薄适配层（非内核、全仓库唯一 fastify 依赖处）：H1 只读 `/healthz`、`/api/roster/public`（实时投影 + 签名名册快照，离线可验）、`/api/roster`（bearer 治理视图）；H2 驾驶员 API（bearer）`POST /api/intents`、`GET /api/intents/:id`、`POST /api/intents/:id/cancel`、`GET/POST /api/escalations`（approve/reject/resolve）、`GET /api/metrics`、**Org**（`GET /api/org/chart`、建编/安置）、**Diary**（`GET /api/diary`、`POST /api/diary/generate`）；`serve.ts` 为进程入口，经 `zeus/http` 子路径导出 |
| **vault（E8.1/E8.2/E3.7）** | `src/vault/` | 藏宝图与恢复协议：buildVault 出图只存引用 + 逐 item 指纹（**正文零泄漏**）、AES-256-GCM seal/open（scrypt/raw key，密钥分离）、restoreDryRun 原地校验与漂移检测、packFull 加密内容包 + restoreFromBundle 经 FsRestoreSink 跨位恢复；`cli.ts` 为零依赖执行器（build/check/backup/restore，退出码 0/1/2/3） |
| **diary（E8.3）** | `src/diary/` | 记忆叙事化日记：buildDiary 把记忆事件按日历天分桶、确定性排序、内容只呈现不臆造、每行锚 eventId；buildDiariesFromState 按 realm 分组构建；persistDiary 经 Realm.write 落 `diary/YYYY-MM-DD.md`（幂等），exportDiary 稳定 JSON；H2 暴露 `GET /api/diary`、`POST /api/diary/generate` |
| **org（E9.3）** | `src/org/` | 虚拟部门编制与结果责任：部门单 lead/成员唯一/不可变，org chart 编制可视，traceAccountability 把任务结果追到执行 Agent、部门 lead、拍板驾驶员（无编制标 unassigned）；OrgRegistry 有状态持有编制、随 KernelSnapshot 持久化重启恢复；H2 暴露 `GET /api/org/chart`、建编/安置端点 |

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
  orgRegistry,  // 传入即挂载 /api/org/* 编制端点
  memoryStore, realmStore, // 传入即挂载 /api/diary 读取与生成端点
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

# 规则无法收敛（分歧）时，冲突进监督台
curl -s 'localhost:8787/api/escalations?status=pending' -H "Authorization: Bearer $TOKEN"
# 驾驶员拍板：接受某个立场，决议回写聚合决策（E6.2）
curl -s -X POST localhost:8787/api/escalations/esc-xxx/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stance":"approve","note":"人工裁决理由"}'

# 取消意图的全部非终态分支；查看并发指标
curl -s -X POST localhost:8787/api/intents/intent-xxx/cancel -H "Authorization: Bearer $TOKEN"
curl -s localhost:8787/api/metrics -H "Authorization: Bearer $TOKEN"

# 查看虚拟部门编制；建部门、安置成员（lead/member）
curl -s localhost:8787/api/org/chart -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/org/departments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"研发部","mission":"交付"}'
curl -s -X POST localhost:8787/api/org/departments/dept-yan-fa-bu/members \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-1","role":"lead","title":"研发主管"}'

# 读某日日记；生成日记并经 Realm.write 落 diary/YYYY-MM-DD.md
curl -s 'localhost:8787/api/diary?date=2026-09-24' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/api/diary/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"date":"2026-09-24"}'
```

> H2 操作面已具备完整封臣上线入口（`POST /api/vassals` 或 `ZEUS_VASSAL_SEEDS` 启动自动注册）；真机扇出到封臣仍待部署与联调（见 handoff）。端到端闭环用 mock 封臣在 `tests/http-h2.test.ts` 中完整跑通（发起→扇出→冲突升级→拍板→决议回写）。

## 当前边界

- **库 + 薄传输**：HTTP 传输层不含业务逻辑——H1 三只只读端点 + H2 驾驶员 API（发起/回查/取消意图、列/拍升级、指标、封臣注册/吊销），写端点与 internal 名册统一 bearer 保护，未配 `ZEUS_INTERNAL_TOKEN` 时整组不挂载。封臣可经 `POST /api/vassals` 注册或经 `ZEUS_VASSAL_SEEDS` 启动自动注册；internal 名册视图不封签（含 revoked 行，靠 bearer 保护，封签留签名链 v1.1）。内核状态（封臣含已吊销、监督台队列、意图结果+原始请求、Realm 连接、记忆、Mentor 台账、MCP 连接器声明、**Org 编制**）在配置 `ZEUS_STATE_FILE` 时启动恢复、SIGINT/SIGTERM 原子落盘（E5.3），未配置则纯内存；运行指标不持久化。
- **Realm 对外唯一传输为 MCP**（契约 v0.2），不做独立 HTTP API；只读 stdio 脚手架已落地（resources 映射 manifest/search/read、宿主预连接、绝对路径不出进程），正式 P1（鉴权、streamable HTTP、官方 SDK 兼容性复核）的触发条件仍是 read-realm 封臣出现。
- 服务端 HTTP 栈为 Fastify + 长驻进程（[docs/design-http-transport.md](docs/design-http-transport.md)）：**H1 已落地**（healthz / public 签名名册 / bearer internal），**H2 驾驶员 API 已落地**（意图扇出/回查/取消、升级队列 approve/reject/resolve 决议回写、并发指标、Org 编制、Diary 日记，端到端测试见 `tests/http-h2.test.ts`、`tests/http-org.test.ts`、`tests/http-diary.test.ts`）；H3（SSE server / 多副本 / 静态快照分发）按需立项。
- pr-helper 验收 #6（标准 A2A 客户端守护测试）与 Zeus↔loom 真机联调均**待部署**，现状与待办以 [handoff.md](handoff.md) 为准。

## 文档

- [handoff.md](handoff.md) — **交接必读**：当前状态、活跃任务、最近变更、文档完整清单
- [docs/README.md](docs/README.md) — 文档地图（按场景导航）
- [docs/product-portrait.md](docs/product-portrait.md) — 产品画像与设计哲学（目录底座 / 藏宝图 / MCP·Skill·A2A 立国三纲）
- [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议：A2A 超集、fealty / 战报 / 升级 / 治理、pr-helper 六项验收
- [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.2
- [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造（R0–R2、签名链公开闸门）
- [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — 名册签名链 v1（Ed25519+JCS、条目 attestation + 快照 seal、TTL 硬过期、八条验收）
- [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型与 H1–H3 端点规划（Fastify + 长驻 Node、薄传输层）
- [docs/deployment.md](docs/deployment.md) — 部署手册：Docker（多阶段/非 root/健康检查/状态卷）、RSK 密钥生成与生产守卫、systemd 备选、Vault 备份恢复 CLI 与 cron 示例、上线检查清单
- [docs/design-fan-out.md](docs/design-fan-out.md) — 并发决策内核契约：fan-out/join、合并流、幂等、cancel、规则聚合、冲突升级、边界
- [docs/design-decision-backend.md](docs/design-decision-backend.md) — 模型无关决策后端（Jev/LLM 适配器、置信度闸门、降级到人工）
- [docs/design-vault.md](docs/design-vault.md) — Vault 藏宝图与恢复协议（图只存引用、AES-GCM 密钥分离、原地校验 + 加密备份包跨位恢复、漂移检测）
- [docs/design-diary.md](docs/design-diary.md) — Diary 记忆叙事化日记（事件按天分桶、内容不臆造、锚 eventId、经 Realm 落盘/导出）
- [docs/design-org.md](docs/design-org.md) — 虚拟部门编制与结果责任（部门单 lead/成员唯一、编制可视、责任链追到 Agent/部门 lead/驾驶员）
- [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) — 项目级 MVP 评审（功能性/完整度/可上线、阻塞项与最小路径）
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做项与触发条件的单一事实源

## 协作约定

见 [AGENTS.md](AGENTS.md)（任务追踪与文档分层、设计哲学、提交规范）与 [git-commit-message.md](git-commit-message.md)。进度统一登记在 handoff.md，设计文档只写设计、不重复记进度。
