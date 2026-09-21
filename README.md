# Zeus

> 以用户数据目录为底座、多 Agent 高效协作的操作系统：对个人，是记忆的避风港与可传承的藏宝图；对企业，是即插即用、伴随成长的「虚拟部门」。完整定位见 [docs/product-portrait.md](docs/product-portrait.md)。

本仓库当前是 Zeus 的**纯 TypeScript 内核库**：封臣注册、任务派发、监督、个人数据域四块核心能力，以零运行时依赖的库形态落地；HTTP / 部署 / MCP 传输层尚未接入。

## 内核模块

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| **a2a** | `src/a2a/` | 标准 A2A 协议类型 + `x-zeus-*` 封臣扩展（Agent Card、Task 生命周期、SSE 事件、fealty 契约、战报） |
| **registry（A1）** | `src/registry/registry.ts` | 封臣注册中心：卡片拉取注册、fealty 校验（无 fealty 即外客，拒绝入册）、健康探针、吊销、`listAll()` 全量视图、`asVassalLookup()` 实时目录 |
| **roster（R0）** | `src/registry/roster.ts` | 封神榜名册投影器：注册中心状态 → 不可变、JSON 可序列化的 internal/public 双快照；只重塑与裁剪，不造字段 |
| **dispatch（A2）** | `src/dispatch/` | 派发器：JSON-RPC + SSE 客户端（send / sendSubscribe / cancel）、数据二极管与按 `dataPolicy` 脱敏、派发前吊销阻断（不发请求不发 token）、审计 sink 与吊销审计桥 |
| **oversight（A4）** | `src/oversight/` | 监督台：收集 `input-required` 升级请求，驾驶员 approve / reject；reject 联动取消封臣侧任务，全程审计 |
| **realm（D1 P0）** | `src/realm/` | 只读 personal 数据域：`FsRealmStore` 的 connect / manifest / search / read，确定性 realmId、connect 快照检索、`contentDigest` 基线、路径穿越与 symlink 双检防护 |

统一公共出口在 `src/index.ts`，构建产物见下文。

## 快速开始

```bash
npm install
npm run build      # tsc 出 dist/（.js + .d.ts + sourcemap）
npm test           # vitest，40 项
npm run typecheck  # tsc --noEmit
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

## 当前边界

- **纯库阶段**：无 HTTP / 部署层；封臣任务与 Realm 状态均为实例内存。
- **Realm 对外唯一传输为 MCP**（契约 v0.2 已拍板），不做独立 HTTP API；P1 才包 MCP server，正式启动触发条件是 read-realm 封臣出现。
- pr-helper 验收 #6（标准 A2A 客户端守护测试）与 Zeus↔loom 真机联调均**待部署**，现状与待办以 [handoff.md](handoff.md) 为准。

## 文档

- [handoff.md](handoff.md) — **交接必读**：当前状态、活跃任务、最近变更、文档完整清单
- [docs/README.md](docs/README.md) — 文档地图（按场景导航）
- [docs/product-portrait.md](docs/product-portrait.md) — 产品画像与设计哲学（目录底座 / 藏宝图 / MCP·Skill·A2A 立国三纲）
- [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议：A2A 超集、fealty / 战报 / 升级 / 治理、pr-helper 六项验收
- [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.2
- [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造（R0–R2、签名链公开闸门）
- [docs/deferred-items.md](docs/deferred-items.md) — 缓做项与触发条件的单一事实源

## 协作约定

见 [AGENTS.md](AGENTS.md)（任务追踪与文档分层、设计哲学、提交规范）与 [git-commit-message.md](git-commit-message.md)。进度统一登记在 handoff.md，设计文档只写设计、不重复记进度。
