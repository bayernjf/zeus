# Zeus

> 以用户数据目录为底座、多 Agent 高效协作的操作系统：对个人，是记忆的避风港与可传承的藏宝图；对企业，是即插即用、伴随成长的「虚拟部门」。完整定位见 [docs/product-portrait.md](docs/product-portrait.md)。

本仓库当前是 Zeus 的**纯 TypeScript 内核库 + 薄传输面**：封臣注册、任务派发、监督、个人数据域四块核心能力以零运行时依赖的库形态落地；另附只读 Realm MCP stdio 脚手架与 HTTP H1（Fastify）薄传输层——Fastify 依赖锁在 `src/http`，内核本身保持零传输依赖。

## 内核模块

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| **a2a** | `src/a2a/` | 标准 A2A 协议类型 + `x-zeus-*` 封臣扩展（Agent Card、Task 生命周期含 file/URI part 与 history 透传、SSE 事件、fealty 契约、战报） |
| **registry（A1）** | `src/registry/registry.ts` | 封臣注册中心：卡片拉取注册、fealty 校验（无 fealty 即外客，拒绝入册）、健康探针、吊销、`listAll()` 全量视图、`asVassalLookup()` 实时目录 |
| **roster（R0）** | `src/registry/roster.ts` | 封神榜名册投影器：注册中心状态 → 不可变、JSON 可序列化的 internal/public 双快照；只重塑与裁剪，不造字段 |
| **dispatch（A2）** | `src/dispatch/` | 派发器：JSON-RPC + SSE 客户端（send / sendSubscribe / cancel）、数据二极管与按 `dataPolicy` 脱敏、派发前吊销阻断（不发请求不发 token）、审计 sink 与吊销审计桥 |
| **oversight（A4）** | `src/oversight/` | 监督台：收集 `input-required` 升级请求，驾驶员 approve / reject；reject 联动取消封臣侧任务，全程审计 |
| **realm（D1 P0）** | `src/realm/` | 只读 personal 数据域：`FsRealmStore` 的 connect / manifest / search / read，确定性 realmId、connect 快照检索、`contentDigest` 基线、路径穿越与 symlink 双检防护；附只读 MCP stdio 脚手架（`mcp.ts` / `mcp-stdio.ts`） |
| **http（H1 传输面）** | `src/http/` | Fastify 薄适配层（非内核、全仓库唯一 fastify 依赖处）：`/healthz`、`/api/roster/public`（实时投影 + 签名名册快照，离线可验）、`/api/roster`（bearer 治理视图）；`serve.ts` 为进程入口，经 `zeus/http` 子路径导出 |

内核统一公共出口在 `src/index.ts`（不含 http 传输面），构建产物见下文。

## 快速开始

```bash
npm install
npm run build      # tsc 出 dist/（.js + .d.ts + sourcemap）
npm test           # vitest，98 项
npm run typecheck  # tsc --noEmit
npm start          # 启动 HTTP H1（需先 build；env 见 .env.example，生产部署见 docs/deployment.md）
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

HTTP H1 薄传输面（库用法，Fastify 依赖仅在 `zeus/http` 子路径）：

```ts
import { VassalRegistry, Ed25519MemorySigner } from 'zeus';
import { createHttpServer } from 'zeus/http';

const app = await createHttpServer({
  registry: new VassalRegistry(),
  signer: new Ed25519MemorySigner('zeus-rsk-dev'),
  internalToken: process.env.ZEUS_INTERNAL_TOKEN, // 不配置则 /api/roster 不挂载
});
await app.listen({ host: '127.0.0.1', port: 8787 });
// GET /healthz；GET /api/roster/public（签名快照）；GET /api/roster（bearer 治理视图）
```

## 当前边界

- **库 + 只读薄传输**：HTTP H1 仅三个只读端点（无写端点），`serve.ts` 启动时 registry 为空（封臣注册属未来启动编排）；internal 名册视图 H1 不封签（含 revoked 行，靠 bearer 保护，封签留签名链 v1.1）。内核状态（封臣含已吊销、监督台队列、意图幂等表）在配置 `ZEUS_STATE_FILE` 时启动恢复、SIGINT/SIGTERM 原子落盘（E5.3），未配置则纯内存；Realm 连接态与运行指标不持久化。
- **Realm 对外唯一传输为 MCP**（契约 v0.2），不做独立 HTTP API；只读 stdio 脚手架已落地（resources 映射 manifest/search/read、宿主预连接、绝对路径不出进程），正式 P1（鉴权、streamable HTTP、官方 SDK 兼容性复核）的触发条件仍是 read-realm 封臣出现。
- 服务端 HTTP 栈为 Fastify + 长驻进程（[docs/design-http-transport.md](docs/design-http-transport.md)），**H1 已落地**（healthz / public 签名名册 / bearer internal）；H2 驾驶员 API 待任务与升级状态持久化，H3（SSE server / 多副本 / 静态快照分发）按需立项。
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
- [docs/deployment.md](docs/deployment.md) — 部署手册 v0.1：Docker（多阶段/非 root/tini/健康检查/状态卷）、RSK 密钥生成与生产守卫、systemd 备选、上线检查清单
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做项与触发条件的单一事实源

## 协作约定

见 [AGENTS.md](AGENTS.md)（任务追踪与文档分层、设计哲学、提交规范）与 [git-commit-message.md](git-commit-message.md)。进度统一登记在 handoff.md，设计文档只写设计、不重复记进度。
