# 设计稿：沙箱与代码执行隔离（tech map S16）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文按执行边界把"谁的代码在哪跑"分成四级，定义隔离需求分级纯函数；容器/microVM 是真机阶段的后置分期。
- 演进：v0.1（2026-10-09）首版——现状盘点（外部 Agent 天然主机隔离、本地 stdio MCP 子进程是最大缺口、内置纯函数无需运行时隔离）+ 四级隔离模型 + `classifyIsolation`/隔离清单校验草案 + 分期。
- 关联：tech map S16（容器/microVM 隔离、资源配额）；design-realm.md（Realm 目录授权面，沙箱文件系统可见性以此为界）；design-external-trust.md（tier 决定可触达面）；design-guardrails.md（S8 管内容，本设计管执行体）；design-execution-delegation.md（execute 授权）；design-backpressure.md（并发配额，本设计的资源配额与之同构）；design-cost-governance.md（S9 wall-time 上限可复用为执行超时）；`src/mcp/stdio-client.ts`（node:child_process spawn 本地 MCP，**核心缺口**）、`src/mcp/connectors.ts`、`src/util/outbound-dns.ts`（出站守卫，注意不覆盖子进程自身网络）。
- 本文是执行隔离的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

Zeus 内核本身是纯 TS 库，不执行 Agent 的模型代码；但"代码在哪跑、以什么权限跑"有四个不同边界，隔离现状不一：

| 执行体 | 运行位置 | 现状隔离 | 缺口 |
| --- | --- | --- | --- |
| 外部执行 Agent（A2A over HTTP） | **对方主机/进程** | 天然进程+主机隔离；内核侧有 tier、凭据不下发、DNS 重绑定守卫、dataPolicy | 内核管不到对方内部（也不该管）；协议声明约束 |
| **本地 MCP server（stdio）** | **内核 spawn 的同机子进程**（`stdio-client.ts`，node:child_process，每 client 一进程） | 仅有进程边界；**以运行内核的同一用户权限运行**；cwd/env 未按最小面收窄；无 CPU/内存/时长配额；子进程自建网络不经内核 fetch，**DNS 守卫不覆盖** | **最大隔离缺口**：一个本地连接器可读用户整个账户、可耗尽资源、可绕过出站守卫联网 |
| 远程 MCP server（HTTP） | 对方主机 | 同外部 Agent（网络边界） | 同外部 Agent |
| 内置技能/内核纯函数 | 内核进程内 | 无可执行外部代码；TypeScript 类型 + 1430 测试约束；MCP 消息处理是 dependency-free 纯处理（mcp.ts 注释明示零 IO） | 未来若允许**用户提供的可执行插件代码**进进程，需要 worker/vm 级隔离（当前不存在该能力） |

**缺口归纳**：

1. **stdio 子进程无最小权限面**：文件系统可见范围没有绑定到该连接器被授权的 Realm；环境变量可能携带内核侧敏感变量；没有资源配额与执行超时（失控连接器拖垮整机）。
2. **子进程网络面不可见、不可控**：内核的出站安全（DNS 守卫、凭据策略）作用于内核自己发出的请求；spawn 出的子进程直接发网络，内核看不到。
3. **无隔离需求声明**：连接器注册时不声明"我需要文件系统哪些路径、要不要网络、要多少资源"，内核无法在启动前判定该连接器能否被当前授权面容纳。
4. **无强隔离升级路径**：从子进程到容器/microVM 的判定标准与降级策略未定义。

## 2. 目标与边界

**目标**：为每个执行体在**启动前**确定性地得出隔离要求（文件系统面、网络面、资源配额、生命周期），并让本地 stdio 连接器在**不满足最小隔离条件时 fail-closed 拒绝启动**；为后续容器/microVM 强隔离预留同一形状的清单接口。原则：**授权面决定可见面**——连接器能碰到的文件/网络不超过它被授予的 Realm 与能力；隔离是注册/启动闸，不是运行时补丁。

**边界（明确不做）**：

- V1/V2 不实现容器/microVM（Docker/Firecracker 等）：仓库外重依赖、与用户自托管环境耦合，列为 V3+ 且按连接器信任档可选；默认隔离用 OS 原生进程手段。
- 不试图隔离远程执行体：远程 Agent/MCP 在对方主机，内核只通过协议、tier、凭据与数据策略约束，不假装能沙箱别人的机器。
- 不做内核内第三方代码的安全解释器：当前没有"加载用户 JS 插件进进程"的能力；若未来要做，单独设计（worker/进程外），不在本文用 vm 凑隔离。
- 不突破数据主权：隔离层不采集、不外发子进程内容；配额与审计只记元数据（进程、资源量、路径授权面）。

## 3. 隔离分级设计

### 3.1 隔离级（isolation level）

| 级别 | 适用执行体 | 最低措施 |
| --- | --- | --- |
| **L-none** | 内置纯函数/零 IO 消息处理 | 无需运行时隔离（类型+测试） |
| **L-process** | 可信来源（tier-0/注册签名可信）的本地 stdio MCP | 独立子进程（已有）+ 最小 cwd/env + 资源配额 + 超时 + 声明的 fs/net 面 |
| **L-process-restricted** | 一般信任（tier-1/2）本地 stdio MCP | L-process 全部 + 文件系统只挂授权 Realm（只读/只写按 tag）+ 默认禁网，需联网显式声明且经出站代理（使 DNS 守卫可覆盖） |
| **L-container** | 低信任（tier-3）或声明需要广泛 fs/网的本地执行体 | OS 容器/microVM（V3+），独立文件系统视图、网络命名空间、硬配额；不可用时**拒绝注册**而非降级到 L-process |
| **L-remote** | 外部 Agent / 远程 MCP | 协议约束（tier、凭据、dataPolicy、DNS），无本机隔离措施 |

### 3.2 隔离清单（IsolationManifest）

连接器/技能在注册时声明（与技能 spec、fealty 声明同处管理）：

```
fs:      { read: [realmId/path...], write: [realmId/path...] }   // 必须是已授权 Realm 的子集
network: 'off' | 'proxy' | 'direct'   // 默认 off；proxy 经内核出站代理（覆盖 DNS 守卫）；direct 仅 L-container
resources: { cpuShares?, memoryMb?, maxWallSeconds?, maxProcesses? }
exec:    { command, args(固定形参), env(白名单) }                  // 不继承内核全部 env
```

**启动前判定（fail-closed）**：fs 面超出授权 Realm → 拒绝；network=direct/proxy 但信任档不允许 → 拒绝；resources 缺省且无全局缺省 → 拒绝或按保守缺省（实施时定，不凭空拍配额数字，标定挂真实负载）；command 不在注册声明中 → 拒绝（防命令注入式拉起）。

### 3.3 与既有闸的关系

- 隔离闸在**注册/启动**；execute 授权闸（delegation）在**每次写动作**；护栏（S8）在**内容**；三者不互相替代。
- 资源配额与 backpressure 的并发 Semaphore、S9 的 wall-time 预算共用度量口径，但执行点不同（一个限并发、一个限钱、一个限单进程资源）。
- 子进程生命周期纳入 KernelSnapshot 语义：崩溃/重启后连接器的重连与 S13 恢复分类一致（不可信子进程崩溃不自动重连 N 次，计入失败恢复链）。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/mcp/isolation.ts（纯函数，零 IO）
export type IsolationLevel = 'L-none' | 'L-process' | 'L-process-restricted' | 'L-container' | 'L-remote';
export type IsolationManifest = {
  fs: { read: string[]; write: string[] };
  network: 'off' | 'proxy' | 'direct';
  resources: { cpuShares?: number; memoryMb?: number; maxWallSeconds?: number; maxProcesses?: number };
  exec: { command: string; args: string[]; envAllowList: string[] };
};

// 依据信任档 + 传输形态 + 声明，确定所需隔离级
export function classifyIsolation(input: {
  transport: 'stdio' | 'http';
  tier: TrustTier;
  manifest: IsolationManifest;
}): IsolationLevel;

// 启动前校验：声明面是否被授权面容纳；不满足返回拒绝原因（fail-closed）
export function validateIsolation(input: {
  level: IsolationLevel;
  manifest: IsolationManifest;
  authorizedRealms: string[];
  containerRuntimeAvailable: boolean;
}): { ok: true } | { ok: false; reasons: string[] };
```

- 接线点（V2，设计级）：连接器注册流程收 manifest 并过 validateIsolation；`stdio-client.ts` spawn 参数按 manifest 收窄 cwd/env、加超时与资源参数（平台能力探测，不支持的隔离手段在该平台 fail-closed 或拒绝该级连接器）；network=proxy 时子进程经本地出站代理（复用 outbound-dns 守卫）。
- 审计新值：`connector-isolation-denied` / `connector-spawned-isolated` / `connector-quota-killed` 入 AUDIT_DECISIONS。

## 5. 分期

- **V1（纯函数分级与校验）**：isolation.ts 两函数 + 测试（四级判定正反例、fs 超授权即拒、direct network 仅 L-container、要求 L-container 而无容器运行时即拒、L-remote 不受本机措施约束）+ 审计值登记；不改 spawn。
- **V2（stdio 最小隔离）**：manifest 进连接器注册；spawn 收窄 cwd/env 白名单、执行超时、可移植的资源上限（按 macOS/Linux 能力分级实现，Windows 缺能力时明确降级语义并文档化）；默认 network=off；proxy 出站代理若工作量大则拆 V2.1。
- **V3（强隔离运行时）**：容器/microVM 后端（L-container），随真机/自托管交付阶段触发，在此之前低信任本地连接器一律拒绝注册。
- **V4（可选）**：进程外用户插件运行时（若产品引入第三方本地技能），复用 L-container 路径。

**验收（V1 实施时）**：每个拒绝条件正反例；"隔离级不足时永不降级放行"独立不变量（要求 L-container 不可用 → 拒绝而非 L-process）；manifest fs 面必须是授权 Realm 子集；全量与冒烟不回归（V1 零运行时行为变化）。
