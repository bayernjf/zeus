# Zeus

一个**多 Agent 编排与决策运行时**：把一个意图并行派发给多个已注册的外部执行 Agent，收集它们带依据的结果，按确定性规则聚合为一个**可追溯、可复核、可人工裁决**的决策，并把整个过程落成可离线验证的记录。用户的本地数据目录是这套运行时的数据底座——数据主权与可恢复性优先于功能数量。

完整定位与设计哲学见 [docs/product-portrait.md](docs/product-portrait.md)，需求拆解与优先级见 [docs/prd.md](docs/prd.md)，当前状态与待办见 [handoff.md](handoff.md)。

---

## 1. 产品

### 1.1 解决的问题

单个 Agent 的回答不可审计，多个 Agent 的回答互相矛盾。Zeus 把"多方给结论"做成一条可复盘的链路：并行派发、多路事件流合并且来源可辨、立场按确定性规则聚合、规则收敛不了就进人工处理队列而不是静默选边、操作者裁决回写后重算整体状态，事后还能从持久化事实离线重建那次决策的参与方·输入·立场·聚合·裁决。

### 1.2 能力一览

| 能力 | 说明 |
| --- | --- |
| 并行派发与汇聚 | 一个意图同时下发给提供该技能的多个执行 Agent；分支失败、超时、取消都如实计入最终状态 |
| 确定性规则聚合 | 一致 / 多数 / 加权三种策略；无法收敛时结论为空并升级，不臆断 |
| 人工裁决与补参重派 | 缺参、冲突、记忆争议进入队列；批准可附带参数只重派那一条分支 |
| 决策回放 | 从持久化事实重建决策时间线，JSON 与可读文本两种输出 |
| 并发与成本治理 | 在途分支上界 + 有界队列、意图级步数预算、连续失败熔断、成本闸门与其读数面 |
| 数据域与跨域授权 | 本地目录即数据域（个人 / 企业两型）；企业域写需签名且一次性的授权凭证 |
| 能力目录与认证 | 技能显式规格注册、多版本共存、权限只可收窄；被认定为"某技能提供者"需逐项评估通过 |
| 组织与问责 | 部门、单一负责人、成员归属；任一任务可追到执行 Agent → 部门负责人 → 裁决操作者 |
| 记忆与叙事日志 | 只追加事件日志 + 纯函数派生事实；矛盾默认标记争议；按天组织成可读记录 |
| 备份与恢复 | 清单只存引用与逐条指纹，加密内容包可原地校验漂移、可跨位置恢复；运行时状态文件同样在覆盖范围内 |
| 对外可验证 | 目录快照签名发布，第三方只持公钥即可离线验签；根公钥指纹由带外固定 |

### 1.3 边界（先说清楚，避免误期望）

- **Zeus 不执行任务，也不内置模型循环。** 执行体是你注册进来的外部 A2A Agent（跨进程、跨组织、跨厂商）。名册为空时产品入口以 `exit 2` 明说没有可派发的对象；想立刻看到闭环，用随仓库出货的参考执行体 `npm run agent:example`（只依据任务输入作答：不读文件、零出站、不调模型）。
- **默认零出域。** 正文只在你的机器与你显式登记的 Agent 之间流动；只有显式 `--model` 才咨询配置里的决策后端。
- **能力接入只有三条通道：MCP（连接外部系统）、Skill（能力与权限声明）、A2A（跨 Agent 协作）。** 不允许私有旁路。
- **个人数据域与企业数据域不互通。** 企业域内容可进入决策，反向路径不存在；企业域的运行记录不落进个人目录。
- **核心不内置调度器。** 备份与检查的周期交给 cron / systemd，运行时里没有自建定时器。

### 1.4 三个使用者面与两条协议面

| 面 | 入口 | 用途 |
| --- | --- | --- |
| 产品入口 | `npm run daily` | 一句话走完「指令 → 意图 → 派发 → 决策与依据 → 待裁决项」，并把这一页 markdown 写回你自己的目录 |
| 终端监督台 | `npm run tui` | 监视、裁决、名册治理、意图识别、连接器驱动，复用既有 bearer HTTP 面 |
| Web 监督台 | `web/supervisor/index.html` | 多视图工作台：监控 / 名册 / 裁决 / 技能目录 / 审计 / 数据域与授权 / 组织 / 连接器 |
| 操作者 HTTP API | `npm start` | 98 条路由（4 条公开、94 条 bearer）；三个使用者面与 curl 走同一组端点、进同一条审计日志 |
| 协议面 | `/.well-known/agent-card.json`、`/mcp` | 入站 A2A（外部 Agent 派单进来）与数据域 MCP（外部宿主读你的目录） |

端点逐条清单与操作者可驱动面见 [docs/feature-inventory.md](docs/feature-inventory.md)。

---

## 2. 启动方法

### 2.1 前置

要求 **Node.js ≥ 22**（`package.json` 的 `engines` 声明，`.npmrc` 开了 `engine-strict`，越界时装依赖会**直接失败**而不是警告；版本钉在 `.nvmrc`）。CI 与 Docker 基线同为 22 与 24。

```bash
npm install
npm run build      # tsc 输出 dist/（.js + .d.ts + sourcemap）；下面所有 npm 脚本都跑出货件，需先 build
```

### 2.2 路径 A：一条命令走通闭环（无常驻进程）

```bash
# 终端 1：起参考执行体，它打印一个可复制的 card url
npm run agent:example

# 终端 2：给一个目录和一句话，把上面打印的 url 贴进 --agent
npm run daily -- "summarize the note" \
  --root /path/to/your/dir \
  --agent http://127.0.0.1:<端口>/api/a2a/agent-card
```

不挂常驻进程、不占端口、不需要 bearer。同一目录再跑一次，页面会带上「上一次」那一行——读回你自己目录里的上一页，不进出站载荷。

| 旋钮 | 作用 |
| --- | --- |
| `--root DIR` | 挂载的目录，可重复；上一次运行挂过的域默认重新挂载 |
| `--agent CARD` 或 `CARD｜TOKEN` | 派发前注册一个执行 Agent，可与 `ZEUS_VASSAL_SEEDS` 合并 |
| `--spec FILE` | 派发前登记显式技能规格（JSON 对象或数组，字段与 `POST /api/skills` 同一条白名单）；这是入口侧唯一能声明 `aliases` 的途径 |
| `--skill ID` / `--params JSON` | 跳过识别直接派发；技能参数 |
| `--realm personal` 或 `enterprise` | 意图操作的数据域；企业域记录只写企业域 |
| `--model` | 本次允许咨询配置里的决策后端（默认零出域） |
| `--state FILE` 或 `none` | 内核状态文件；`none` 保持纯内存，既不加载也不保存 |

退出码：`0` 报告已产出并入库（含以分裂收场、等你裁决的运行）· `1` 无可派发对象、无 Agent 交付、或写回失败 · `2` 配置或用法错误，什么都没派发。完整旋钮见 `npm run daily -- --help`。

非英文指令要命中技能，靠的是技能登记时显式声明的别名（`--skill` 之外的默认识别路径，本地规则、零出域）。执行 Agent 卡片自报的技能没有别名字段，所以要走这条路径需用 `--spec` 登记一次规格；不登记则仍需 `--skill` 点名。

### 2.3 路径 B：常驻服务与两个监督台

```bash
ZEUS_INTERNAL_TOKEN="$(openssl rand -hex 24)" \
ZEUS_STATE_FILE=./data/kernel-state.json \
ZEUS_AUDIT_FILE=./data/audit.jsonl \
ZEUS_REALM_ROOTS=/path/to/your/dir \
npm start
```

`ZEUS_INTERNAL_TOKEN` 不配则整个操作面不挂载；`NODE_ENV=production` 下没有签名密钥会拒绝启动（生成：`node scripts/gen-rsk-key.mjs rsk.pem`）。全部环境变量见 `.env.example`，逐项语义见 [docs/deployment.md](docs/deployment.md)。

```bash
# Web 监督台：跨源消费需服务端配 Origin 白名单，默认关闭时行为不变
ZEUS_CORS_ORIGINS=http://127.0.0.1:5173 node dist/http/serve.js   # 终端 1
python -m http.server 5173 --directory web                        # 终端 2
# 打开 http://127.0.0.1:5173/supervisor/index.html，在「连接」页填 API 地址与 bearer 令牌

# 终端监督台
ZEUS_INTERNAL_TOKEN="$(cat data/internal-token)" npm run tui
```

监督台命令：`r` 刷新 · `a<n>` / `x<n>` 批准或拒绝升级 · `s<n>.<m>` 裁决 · `r<n> {json}` 补参并只重派该分支 · `d<n>` 吊销 · `b<n>` 恢复已吊销的执行 Agent · `g<n>` / `k<n>` 跨域授权签发与吊销 · `i <文本>` / `im <文本>` 意图识别（前者本地规则、零出域，后者显式咨询决策后端；识别结果恒为 plan-only）· `m<n>` / `mx<n>` / `mt<n> <工具> {json}` 连接器握手 / 吊销 / 调工具。每个写动作都是一次 plain API 调用、先 `y/N` 确认，与 curl 进同一条审计日志。

两个面的连接配置只存本机（浏览器 localStorage / 进程环境），不写进内核状态文件；页面上每个读数都能从 HTTP 端点取到，UI 不新增内核端点。

### 2.4 路径 C：Docker 与作为库嵌入

```bash
docker build -t zeus:0.1.0 .
docker run --rm -p 8787:8787 -v zeus-data:/data \
  -e ZEUS_INTERNAL_TOKEN=… -e ZEUS_RSK_KEY_FILE=/data/rsk.pem zeus:0.1.0
```

多阶段构建、非 root 运行、健康检查、`/data` 内状态与审计文件权限 0600、SIGTERM 走保存链。完整部署手册（含 systemd 备选与备份 cron 示例）在 [docs/deployment.md](docs/deployment.md)。

作为库嵌入时，一次装配（编排器、注册表、人工队列、指标）由 `bootKernel()` 负责，生产进程入口 `src/http/serve.ts` 已按环境变量装配齐全；自定义装配只需把组件传给 `createHttpServer()`——**传入哪个组件就挂载哪组端点**：

```ts
import { bootKernel } from 'zeus';
import { createHttpServer } from 'zeus/http';

const kernel = await bootKernel({
  vassalSeeds: ['https://agent.example/api/a2a/agent-card'],
  realmRoots: ['/data/notes'],
});
const app = await createHttpServer({
  registry: kernel.registry,
  orchestrator: kernel.orchestrator,   // 传入即挂载任务端点
  oversight: kernel.oversight,         // 传入即挂载人工处理队列端点
  metrics: kernel.metrics,             // 传入即挂载 /api/metrics
  internalToken: process.env.ZEUS_INTERNAL_TOKEN,
});
await app.listen({ host: '127.0.0.1', port: 8787 });
```

数据域可以脱离编排单独用（自包含、无需网络）：`connect` 建索引 → `search` 走连接快照 → `read` 实时落盘，绝对路径不外泄。

### 2.5 数据保全与对外验签

```bash
export ZEUS_VAULT_PASSPHRASE='…'
npm run vault -- build   --root /path/to/dir --out backups/map.json   # 出清单：只存引用与逐条指纹
npm run vault -- check   --map backups/map.json                       # 原地漂移校验（只读；退出码 2=漂移，3=目录不可达）
npm run vault -- backup  --root /path/to/dir --out-dir backups        # 加密内容包
npm run vault -- restore --map backups/x.map.json --bundle backups/x.bundle.json --target /restore/dir
```

第三方只持公钥即可判一份已发布名册的真伪——但**先与带外公告的指纹逐字符比对**再用，因为发钥的那个进程说不出"这把钥属于谁"：

```bash
npm run verify:roster -- --url http://127.0.0.1:8787/api/roster/public --key rsk.pem
# 退出码 0=验签通过 / 1=被拒（附原因：版本不认识、摘要不绑定、签名不符、过期…）/ 2=参数或 I/O 错
```

数据域经 MCP 对外暴露时有两条传输形态：stdio（宿主预连接并授权，协议不暴露 connect）与 streamable HTTP（`GET /mcp` 只出元信息、`POST /mcp` 需 bearer，会话级身份只能收窄宿主白名单）。对接细节见 [docs/mcp-integration.md](docs/mcp-integration.md)。

### 2.6 验证你的安装

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest：2496 项 / 214 个测试文件（以你本机这条命令的输出为准）
npm run smoke:core   # 核心链路真机冒烟：真进程 + 真 socket 跑完 50 步（只用回环与自造密钥）
npm run evals        # 离线质量回归：31 例 / 十族指标，--baseline 相对钉住的基线出退化 diff（blocked 退化 exit 1）
```

这些可重跑的资产本身就是质量的读数：**已验证到什么程度**：2496 项测试 / 214 个测试文件，外加一条可重跑的核心链路真机冒烟（`npm run smoke:core`：挂目录 → 带凭证注册 → 扇出 → 内核自读域 → 审计落盘 → 名册离线验签 → 发布的根公钥就是签名那把（同一指纹在出钥·发布·验签三处同串）→ 重启恢复名册·记忆·数据域 → 契约操作面签发/读/撤销 → watch 触发恰一次真派发 → 记忆召回装配进分支上下文 → 技能声明输入装配（explicit / unavailable）→ Day-1 双进程入口探针与出货进程成本账户读数、中文一句话经 `--spec` 声明的别名在本地规则下命中、撤销契约断流，50 步）。

---

## 3. 架构概览

### 3.1 分层

```
使用者面    产品入口 daily · 终端监督台 TUI · Web 监督台 · 操作者 HTTP API
                 └──── 三面共用同一组 bearer 端点；写动作一律先确认，再进同一条审计日志 ────┘
运行时核心  src/  纯 TypeScript 库（除 src/http/ 外零运行时依赖）
                 编排 · 规则聚合 · 治理闸门 · 数据域 · 记忆 · 组织 · 能力目录 · 审计 · 状态
传输层      src/http/  全仓库唯一 Fastify 依赖处：只做路由、鉴权与投影，不含决策逻辑
协议面      A2A 客户端（派发）+ 入站 A2A 服务端（被派单）· MCP 服务端（数据域）+ MCP 客户端（连接器）
存储        用户目录（数据域正文）· 内核状态快照 0600 · 审计 JSONL · 备份清单与加密内容包
```

库的统一公共出口是 `src/index.ts`（不含 HTTP 传输面）。

### 3.2 一次派发的路径

1. 意图进来（`npm run daily` / `POST /api/intents` / 入站 A2A `tasks/send`），按技能解析候选执行 Agent，能力目录裁决哪些提供者可用。
2. 治理闸门在派发**之前**：并发上界与队列、步数预算与熔断、成本准入、执行授权票据（execute 模式）——拒绝即终止出站，并写进审计。
3. 并行出站：每个分支一次 A2A 任务，出站前按数据策略脱敏、检查该 Agent 是否已被吊销（吊销即断流，不发请求也不发凭证）。
4. 多路事件流合并回一条视图，事件保持来源可辨；分支超时或失败如实计入分支结果，不被重标成别的原因。
5. 立场按确定性规则聚合；收敛则出结论，不收敛则 `needs-driver` 并进人工队列；可选再经决策后端做一次置信闸门内的仲裁或对抗复核。
6. 操作者批准 / 拒绝 / 裁决；批准可带参数只重派那一条分支；拒绝联动取消对端任务。
7. 结果与决策进状态快照与审计链；记忆层按事件追加、纯函数派生事实，矛盾进队列。

### 3.3 模块

| 层 | 路径 | 职责 |
| --- | --- | --- |
| 协议类型 | `src/a2a/` | 标准 A2A 类型（卡片、任务生命周期、SSE 事件、file/URI part 透传）与 `x-zeus-*` 扩展；随仓库出货的参考执行体也在此 |
| 执行 Agent 目录 | `src/registry/` | 卡片拉取注册、归属声明校验（缺字段即拒收并点名缺哪个）、健康探针、吊销与恢复、出站凭证存取与四视图脱敏；目录快照 → internal / public 双投影并签名 |
| 派发 | `src/dispatch/` | JSON-RPC + SSE 客户端、按数据策略脱敏、派发前吊销阻断、审计 sink 与治理审计桥 |
| 编排 | `src/core/orchestrator/` | 并行派发与汇聚、多流合并、规则聚合、冲突检测与升级、幂等重放、取消传播、并发上限与有界队列、终止守卫、成本账本、补参重派、离线决策回放、DAG 与规划扇出、进度事件 |
| 人工处理 | `src/oversight/` | 升级队列与 approve / reject / resolve、介入分级、裁决回写并重算状态 |
| 能力目录 | `src/skills/` | 显式规格校验（版本 / 封闭权限词汇 / 依赖无环 / 别名声明）、多版本共存、检索与组队解析（歧义不静默选边）、装卸与权限收窄、能力认证台账 |
| 决策后端 | `src/decision/` | 模型无关端口 + 规则 / 外部决策模型 / OpenAI 兼容适配器 + 降级；只在被显式咨询时出域 |
| 数据域 | `src/realm/` | 连接即建检索索引、确定性 realmId、内容摘要基线、路径穿越与符号链接双检、原子写；三级租户范围与跨域授权判定、签名且一次性的企业写授权凭证；只读 MCP 服务端与 stdio 宿主 |
| 外部系统连接器 | `src/mcp/` | 零 SDK 的 streamable-HTTP JSON-RPC 客户端；连接器声明 / 握手 / 吊销，最小权限精确裁剪——只有经握手发现且被声明保留的工具才可调用；子进程连接器的环境收窄 |
| 记忆与叙事 | `src/memory/`、`src/diary/` | 只追加事件日志 + 纯函数派生事实、观察去重、矛盾默认争议、置信度按可靠度加权、混合检索、遗忘权与撤回；事件按日历天分桶成可读记录 |
| 组织与自动触发 | `src/org/`、`src/onboarding/`、`src/watch/` | 部门与问责链；上岗四道门每次现算不缓存（签字后吊销 Agent 或撤出编制即自动失格）；watch 由调用方驱动计时，命中即派生意图 |
| 护栏与观测 | `src/guardrails/`、`src/observability/`、`src/reflection/` | 内容风险判定与来源标注；trace 树、并发指标与指标史、日志结构化与凭证打码；失败归因 |
| 状态与装配 | `src/state/`、`src/http/serve.ts` | 快照原子落盘与启动恢复、跨进程文件锁、优雅退出；按环境变量装配生产进程 |
| 备份与恢复 | `src/vault/` | 清单来源可为数据域或文件白名单、只存引用与指纹、密钥与图分离的 AES-256-GCM 包、原地漂移校验、跨位置恢复；零依赖 CLI |

### 3.4 持久化、审计与信任链

- **状态**：单一 JSON 快照（名册含已吊销、待决队列、意图结果与原始请求、组织编制、授权台账、nonce 账本），tmp + rename 原子写、权限 0600、启动即恢复；意图记录默认保留并可出窗归档，同一意图键重放零出站。
- **审计**：JSONL 落盘、按字节上限自轮转、可按运行 ID / 执行 Agent / 决策类型回读；治理动作（注册、吊销、恢复、授权、裁决）与派发决策进同一条链。审计写失败只计数、不改变派发结果，并由 `GET /api/state` 报降级——磁盘错误不会被冒充成执行 Agent 的失败。
- **信任链**：目录快照由 Ed25519 根钥封签（规范化载荷 + 条目 attestation + 新鲜度绑定），`GET /api/roster/keys` 发布公钥与指纹，任何持有公钥的一方都能离线验；信任的锚点是**带外公告的指纹**，不是发布它的那个进程。
- **数据主权的实现方式**：数据域内容对外的唯一传输是 MCP，HTTP 侧只到治理元数据与授权记录为止；`GET /api/state` 只报计数与路径，不服用含凭证与记忆明文的状态快照；上游凭证在任何响应中只以 `hasToken` 呈现。

### 3.5 术语（高频十条）

| 术语 | 含义 |
| --- | --- |
| 执行 Agent | 已注册、可被派发任务的外部 Agent，经标准 A2A 协议交互 |
| 归属声明 | 卡片上的 `x-zeus-fealty`：服务哪些数据域、数据策略、回传与升级口径；不合法即拒绝注册 |
| 并行派发（fan-out） | 一个意图同时下发给多个执行 Agent，多路事件流合并回一条 |
| 立场与规则聚合 | 分支回传的结构化意见（立场 + 依据 + 权重）按一致 / 多数 / 加权合为一个决策 |
| 冲突升级 / 人工裁决 | 规则无法收敛或 Agent 索要缺失输入时进队列；操作者给出立场后回写重算 |
| 数据域 | 一个可连接的本地目录，分 `personal` / `enterprise`；连接即建立检索索引 |
| 单向隔离 | 企业域内容可进入决策，反向路径不存在；跨域读写需签名且一次性的授权凭证 |
| 能力目录 | 技能的显式规格：多版本共存、权限只可收窄、卸载与收窄即时影响自动派发 |
| 决策回放 | 从持久化事实重建一次决策的参与方·输入·立场·聚合·裁决 |
| 操作者 | 人类角色：监督、介入、给出最终裁决——不是被替代的手工执行者 |

代码、环境变量与 HTTP 路径里保留了一批早期命名（`vassal` / `fealty` / `roster` / `realm` / `kernel` / `driver` / `commission` / `mentorship` / `noul`）。它们是接口的一部分，含义与"为什么不能顺手改名"逐条记在 [docs/terminology.md](docs/terminology.md)；**这些名字不代表任何第三方系统或集成**（例如 `src/vault/` 与 HashiCorp Vault 无关），本文档不使用它们做叙述词。

### 3.6 现行判定与仍缺的外部条件

- **产品核心完全可用的 MVP = ✅**；**可上线交付真实用户 = ❌**。判定的单一事实源是 [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md)，理由清单与差距全部在仓库外（真实部署、密钥实际托管与公钥指纹带外公告、需要 ≥3 个真实执行 Agent 在线才能标定的治理阈值）。
- 逐条待办与触发条件见 [docs/deferred-items.md](docs/deferred-items.md)；能力与操作面的现行清单见 [docs/feature-inventory.md](docs/feature-inventory.md)。

---

## 4. 文档

| 想做什么 | 去哪份 |
| --- | --- |
| 接手项目：当前状态、活跃待办、最近变更 | [handoff.md](handoff.md) |
| 按场景导航全部文档 | [docs/README.md](docs/README.md) |
| 需求拆解、优先级与验收标准 | [docs/prd.md](docs/prd.md) |
| 产品定位与设计哲学 | [docs/product-portrait.md](docs/product-portrait.md) |
| 现行能力清单与操作面（路由 / 端点 / 三面可读） | [docs/feature-inventory.md](docs/feature-inventory.md) |
| MVP 判定与可上线判定的单一事实源 | [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) |
| 部署、密钥、备份调度、上线检查清单 | [docs/deployment.md](docs/deployment.md)、[docs/pre-launch-checklist.md](docs/pre-launch-checklist.md) |
| 对接 MCP（数据域服务端与连接器客户端） | [docs/mcp-integration.md](docs/mcp-integration.md) |
| 执行 Agent 协议（卡片、握手、回传、升级、验收） | [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) |
| 数据域契约（connect / search / read / write、租户、跨域授权） | [docs/design-realm.md](docs/design-realm.md) |
| 并发编排契约（派发与汇聚、合并流、幂等、取消、聚合、升级） | [docs/design-fan-out.md](docs/design-fan-out.md) |
| 目录签名链与公钥发布、人工轮换手册 | [docs/design-fealty-signing.md](docs/design-fealty-signing.md) |
| 备份与恢复协议 | [docs/design-vault.md](docs/design-vault.md) |
| 模型无关决策后端 | [docs/design-decision-backend.md](docs/design-decision-backend.md) |
| HTTP 传输层选型与端点规划 | [docs/design-http-transport.md](docs/design-http-transport.md) |
| 组织结构与问责、上岗校验与首日简报、叙事日志 | [docs/design-org.md](docs/design-org.md)、[docs/design-onboarding.md](docs/design-onboarding.md)、[docs/design-diary.md](docs/design-diary.md) |
| 本机容量基线 | [docs/capacity-baseline.md](docs/capacity-baseline.md) |
| 缓做项与各自的触发条件 | [docs/deferred-items.md](docs/deferred-items.md) |
| 术语对照与历史标识符 | [docs/terminology.md](docs/terminology.md) |

子系统设计的完整清单（规划 / 流式 / 恢复 / 沙箱 / 护栏 / 观测 / 评测 / 上下文工程 / 监督 / 记忆整理 / 背压 / 自托管闭环 等）在 `docs/design-*.md`，一个主题一份，索引见 [docs/README.md](docs/README.md)。

## 5. 协作约定

见 [AGENTS.md](AGENTS.md)（文档分层、设计约束、写作语言、提交规范）与 [git-commit-message.md](git-commit-message.md)。一句话：**handoff = 状态 + 待办 + 索引，docs = 方案 + 设计 + 明细**；实施进度统一记在 `handoff.md`，设计文档只写设计、不重复记进度。
