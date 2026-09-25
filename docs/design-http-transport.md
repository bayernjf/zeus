# HTTP 传输层选型设计（Zeus 服务端面）

> 状态：**现行（设计稿 v0.1，2026-09-21，选型已拍板）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计。
> 边界：本文只覆盖 **Zeus 自己对外提供的 HTTP 服务端面**。Zeus 作为 A2A **客户端**调封臣（`src/dispatch/client.ts`，JSON-RPC + SSE）已实现，不在此列；Realm 对外传输已另案拍板为**唯一 MCP、不做 HTTP API**（[design-realm.md](design-realm.md) §6.1），本文不覆盖、不冲突。

## 0. 一句话

Zeus 服务端 HTTP 面用 **Fastify 跑长驻 Node 进程**做一层**薄适配**：只负责 HTTP ↔ 内核 API 的翻译，框架依赖锁在传输层，内核（registry/dispatch/oversight/realm/roster）保持零传输依赖；v1 只上健康检查与签名名册只读端点，驾驶员 API 与 SSE 服务端随后续切片。

## 1. 先划清：Zeus 到底有哪些网络面

| 网络面 | 方向 | 形态 | 现状/决策 |
| --- | --- | --- | --- |
| Zeus → 封臣 | 出站 | A2A JSON-RPC + SSE 客户端 | **已实现**（`src/dispatch/client.ts`），与服务端选型无关 |
| Realm → 外部 Agent/封臣 | 对外 | **MCP server（唯一）** | 已拍板（design-realm §6.1），P1 包壳，**不挂 HTTP 路由** |
| 名册 public 快照 → bayjf | 对外（只读） | HTTP 只读端点 / 静态产物 | R1（roster §8），**本选型的首要服务端用途** |
| 名册 internal / 治理视图 | 对内 | 同进程库调用为主，远程只读为辅 | design-realm §6.1：内部组件同进程不经网络 |
| 驾驶员面（派发/监督台/健康/审计） | 对内 | HTTP API（未来 UI） | H2，随持久化与 UI 切片 |
| 封臣 → Zeus 回调（push notification） | 入站 | A2A push | v1 不做（探针与战报均 Zeus 主动拉/随任务流回） |
| Zeus 自身作为 A2A server | 对外 | A2A 服务端 | **v1 不做**：星型拓扑中发起方永远是 Zeus/驾驶员（vassal-protocol §5），Zeus 是编排者不是执行者 |

结论：服务端 HTTP 面很窄——**v1 只有健康检查 + 名册只读**，驾驶员面是后续增量；不存在「Zeus 实现一套 A2A server」的需求。

## 2. 选型裁决：Fastify + 长驻 Node 进程

### 2.1 决定

- **框架：Fastify（v4+，ESM）**，作为 Zeus 唯一的服务端 HTTP 运行时依赖。
- **形态：长驻 Node 进程**（个人版绑 `127.0.0.1`；企业版容器化、置于网关后、不直接发布宿主端口——与 loom Q145 受控试点部署形态一致）。
- **不选 serverless / Vercel 作为 v1 形态**。

### 2.2 理由

1. **状态模型匹配**：registry、dispatcher 在途任务、oversight 升级队列当前都是**实例内存状态**（handoff 已记载）。serverless 冷启动与实例间内存不共享会让治理闭环（实时吊销目录、升级队列）出现空洞；持久化落地前，长驻单进程是语义最直的形态。
2. **成熟度与 TS 体验**：Fastify 插件生态、JSON Schema 校验、SSE、鉴权插件成熟稳定；类型体验一等。Hono 更轻、跨运行时好，但其优势区在 edge/serverless，与第 1 点的长驻结论不匹配；Express 中间件回调风格与 TS 体验均老旧。
3. **薄传输层契合内核现状**：内核已是可同进程调用的纯库（`src/index.ts` 公共面）。HTTP handler 只做参数解析、鉴权、调用内核、序列化，**零业务逻辑**——逻辑留在可单测、传输无关的内核里。
4. **依赖隔离干净**：Fastify 只被传输层目录引用，内核任何文件不得 `import fastify`；将来换框架（或补 serverless 只读快照分发）只重写适配层。

### 2.3 关键取舍

- **public 名册是不可变签名快照**（见 [design-fealty-signing.md](design-fealty-signing.md)）：它本质是静态产物。H1 先用 Fastify 端点提供；若后续要走 CDN/对象存储/SSG 直拉文件，可**额外**产出静态 JSON，不动内核——这是端点的补充而非替代，列为开放问题。
- **Zeus 服务端 v1 不提供 SSE**：Zeus 是 SSE 的消费方（出站）。驾驶员面需要实时战报时，H2 先用轮询/同进程事件；SSE server 待任务持久化阶段再开（无持久化时进程重启即丢流，做了也是假的）。
- **鉴权 v1 最小化**：internal 端点单 bearer token（env 注入，与 loom Q88 一 Agent 一 Key 的简单形态同构）；public 端点无鉴权，但**只可能返回签名后的 public 快照**（revoked/端点/探针 detail 在投影层已裁掉）。多用户/RBAC 随企业版切片，不提前建设。

## 3. 目标结构（依赖方向单向）

```
驾驶员 UI / bayjf SSG / 运维
        │  HTTP（Fastify 薄适配）
   src/http/        ← 唯一允许 import fastify 的目录；handler 无业务逻辑
        │  同进程调用
   src 内核          ← registry / dispatch / oversight / realm / roster
                     零传输依赖，可独立 build/单测（src/index.ts）
        │  MCP（Realm 唯一对外数据面，stdio 壳 → P1 streamable HTTP）
      Realm / MCP 连接器
        │  A2A JSON-RPC + SSE（出站客户端）
      封臣：pr-helper / loom / …
```

硬约束：

1. `src/http/` 之外不得出现 fastify / Node http server 代码。
2. `src/http/` 不得绕过内核直接读 registry/realm 内部数据结构；只用 `src/index.ts` 公共面。
3. **HTTP 服务不挂任何 Realm *内容* 路由**（design-realm §6.1）；Realm 条目内容只经 MCP。E6.4 起的精确边界见 design-realm §6.4：bearer 驾驶员面可暴露 Realm 的**治理元数据与授权记录**（`/api/domains*`），并可用 `realmSource` 让**内核代取**内容送进派发链路——后者不向客户端返回内容，因此不构成第二个 Realm 传输面。
4. 传输层不持有业务状态：状态归内核实例，server 只是宿主。

## 4. 端点规划

| 阶段 | 端点 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| H1 | `GET /healthz` | 无 | 存活探针，返回版本与时间，不含任何封臣/Realm 信息 |
| H1 | `GET /api/roster/public` | 无 | 返回 `SignedRosterSnapshot`（public 投影 + 签名信封，fealty-signing §4）；缓存头配合 TTL |
| H1 | `GET /api/roster` | bearer（internal） | internal 快照（含 revoked/端点/探针明细），仅供治理面 |
| H2 | 驾驶员 API（dispatch / escalations approve·reject / registry 只读）——**实际交付面远大于此规划**：另含决策回放、按 kind 分流的升级队列、并发指标、Skills 与带教、Org 编制与责任链、Memory 与遗忘权、Diary、MCP 连接器、决策后端配置、审计回读、内核盘点、**Realm 治理面 `/api/domains*`** | bearer | 逐项验收标准与路由清单见 PRD E5.5 与 README"库 + 薄传输"节，本表只留**当年规划口径**不再逐条扩写（原口径：随持久化与 UI 切片逐项设计，不在本文展开） |
| H3（可选） | SSE 战报流、静态快照产物分发 | — | 待持久化 / CDN 需求明确 |

v1 不设任何写端点（注册是 Zeus 主动拉 card、吊销是治理动作经内核/未来驾驶员面，不经匿名 HTTP 写口）。

## 5. 阶段与验收

- **H0（本文，2026-09-21）**：选型拍板；**不装依赖、不写路由**，内核保持纯库。
- **H1（随 roster R1：HTTP 层就绪）**：
  1. 安装 fastify（传输层唯一运行时依赖）；新增 `src/http/server.ts` 与装配入口；
  2. 三个 H1 端点上线；内核零改动、40+ 既有测试全绿；
  3. 验收：无鉴权取 internal → 401；public 响应可按 fealty-signing §8.1 离线验签且不含 revoked/内部端点；篡改快照验签失败；`/healthz` 不泄露内部信息；内核目录 grep 不到 fastify import。
- **H2**：驾驶员 API 切片（前置：任务/升级状态持久化方案）。
- **H3**：SSE server / 多副本 / serverless 或静态快照分发，按需立项。

## 6. 开放问题（不阻塞 H1）

1. public 快照是否同时产出静态 JSON 文件供 bayjf 直拉/CDN 缓存（与端点并存）——R1 结合 bayjf SSG 频率定。
2. 个人版本机部署形态（launchd/后台进程/桌面 App 内嵌）与端口约定——个人版部署切片定。
3. internal bearer 的发放与轮换、向企业版多身份/RBAC 的演进路径——随企业版认证切片（联动 deferred #6 双数据域授权粒度）。
4. H1 进程的优雅停机（在途 SSE 派发任务如何 drain）——H1 装定时处理。

## 7. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：划清网络面；裁决 Fastify + 长驻 Node、不选 serverless；薄传输层与单向依赖约束；Realm 不挂 HTTP；H1 三端点与验收；H2/H3 阶段 |
