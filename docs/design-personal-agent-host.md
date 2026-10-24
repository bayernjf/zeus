# 设计稿：Personal Agent 宿主层（Personal Agent Host）

> 状态：**设计稿 v0.2（2026-10-25，修正 atlas 归属）**。本文回答「要不要做 Personal Agent、怎么做、与 Tier0 八个产品是什么关系」，是宿主层的单一事实源；内核能力的「怎么做」仍以各 `design-*.md` 为准。
> 性质：**产品判断 + 架构分层文档**。它不新增内核原语，只规定「内核之外、用户身边」那一层的形状与落地顺序。
> 关联：[design-agentic-integration.md](design-agentic-integration.md)（系统互联立场：Agent 是编排层、确定性原语是骨）、[design-self-host-loop.md](design-self-host-loop.md)（常驻 watch + 有界委托，内核已有，宿主不重做）、[design-inbound-a2a.md](design-inbound-a2a.md)（zeus 被外部 agent 反向派任务）、[design-realm.md](design-realm.md)（个人数据域）、[mcp-integration.md](mcp-integration.md)（MCP 三通道）、[prd.md](prd.md)（E1–E10）。

## 0. 一句话结论

**要做 Personal Agent，但不新建产品、不重写内核：zeus 的 personal realm 已经是 Personal Agent 的大脑（决策、记忆、数据主权、备份恢复、常驻委托、监督审计都在），缺的是它刻意留给「宿主层」的那一层——个人用户身边的对话入口、被通用 Agent 助手一键接入的标准门面、常驻运行与通知、跨设备。** 本轮应交付的是这层宿主的最小闭环（让 zeus 现在就能被 Claude Desktop / Cursor 等个人 Agent 助手以标准 MCP 接入），而不是再做一个聊天机器人。

## 1. 背景与问题

### 1.1 外部：Personal Agent 已是 2026 年的独立品类

- **常驻、关窗后仍在干活**是该品类的默认形态：OpenAI Dots（2026-09-29）、Meta Muse（2026-09-09）把「常驻、独立执行环境」做成标配（已在 [design-self-host-loop.md](design-self-host-loop.md) §8 引用）；以「人」而非任务组织、持续记忆的 Today AI 获得约 2 亿美元融资（来源：36 氪 / 今日头条报道，见 §10）。
- **协议层已收敛为两个、且互补**：MCP（Anthropic，2024 末）解决「一个 agent 纵向连接工具/数据」；A2A（Google，2025-04 开源）解决「agent 之间横向发现/委派/回结果」。IBM 的 ACP 已于 2025-09 并入 A2A，行业基本只剩「MCP 连工具、A2A 连 agent」两条；官方社区建议把 A2A Agent 建模为带 AgentCard 的 MCP resource（见 §10）。
- **个人数据归属与记忆是最热的本地优先方向**：Moryn（personal, multi-agent, multi-device, user-owned, auditable context store + handoff）、M3 Memory、Memento、open-memex、monomind、OpenJarvis（Stanford 系，MCP+A2A）等都在做「数据留在本机、用户所有、跨设备可审计、可被任意 MCP 客户端复用」的记忆/上下文层。

### 1.2 内部：内核已高度成型，宿主层是空的

逐仓核查源码后，zeus 的个人形态（PRD E1–E10）**库内基本完成**：

- **决策与编排**：单意图 fan-out、DAG、多方案聚合/冲突/LLM judge、回放、可观测（E1，全 ✅）。
- **成长**：Skill 声明/注册/安装/加固/传授、自然语言意图识别（本地规则默认零出域、plan-only fail-closed）（E2，全 ✅）。
- **数据主权**：「给一个目录即插即用」、search/read、签名一次性写授权、备份恢复、个人/企业双域（E3，大部分 ✅；E3.8 检索升级 ⬜）。
- **协作**：A2A vassal 协议、参考执行体、已对线上 pr-helper 真机联调 PASS（E4，✅；E4.9 生产 RSK 托管属仓库外动作）。
- **门面/名册**：公开 + 内部双投影、签名验签、bayjf 公开名册页（E5，✅）。
- **常驻委托**：watch 触发器 + 有界委托契约（DelegationContract），「条件成立替我办一次、越限回人」六步全完成（[design-self-host-loop.md](design-self-host-loop.md)）。
- **个人情感层**：加密备份清单、恢复协议、日记、记忆整理与遗忘权（E8，✅；传承 E8.4 为 P3 ⬜）。
- **入站面**：`GET /.well-known/agent-card.json` + 入站 `tasks/send`（落 H2 意图面，bearer/fealty 验签）、`POST /mcp`（Realm HTTP MCP）、`src/realm/mcp-stdio.ts`（个人 Realm 的 stdio MCP，只读）。

**关键缺口（zeus 文档里自己点名的边界）**：[design-self-host-loop.md](design-self-host-loop.md) §2 明确「**不做常驻人格、对话入口、通知渠道（那是宿主层，不是内核）**」；PRD §2.2 也把产品边界画在内核。换言之——**大脑齐了，身体和「别人怎么叫它」的门面没做**。这正是 Personal Agent 该补的位置，也解释了为什么不应另起炉灶。

## 2. 核心判断：需要做吗？做什么？

### 2.1 需要做，但定位是「宿主层」不是「第二个内核」

- **不需要**：再做一个独立 Personal Agent 产品、自建对话大模型、自研一套私有协议、或把矩阵产品各自改造成聊天助手。这会重复 zeus 已有的记忆/编排/授权/审计，且违反 [design-agentic-integration.md](design-agentic-integration.md) §2A「zeus 是编排底座，能力来自被接入的软件」的立场。
- **需要**：在 zeus 内核外补一层**薄宿主**，承担四件内核刻意不做的事（见 §3）。判断标准与 self-host-loop 一致：**只放「没有可执行原语就不进内核」的壳，可执行的授权、边界、审计一律复用内核。**

### 2.2 两种交付形态都要，且分先后

| 形态 | 谁是「脸」 | 现在可达性 | 优先级 |
| --- | --- | --- | --- |
| **A. 内嵌：zeus 被通用 Agent 助手当工具/MCP 接入** | 用户已有的 Claude Desktop / Cursor / ChatGPT 桌面 / 手机助手 | 本机 stdio 已可接（只读），但**没有 bin、没有一键配置、没有手册**，等于「有插座没贴标签」 | **P0（本轮做最小闭环）** |
| **B. 自有：zeus 提供自己的个人对话/常驻入口** | zeus 自带的轻量宿主（CLI chat / 桌面 / 通知） | 只有一次性 `daily` 与只读 `tui` 面板，无对话入口、无常驻壳 | P1（本地）/ P2（远程、多设备） |

形态 A 能立刻让用户用「他已经习惯的那个助手」调用 zeus 的数据与（未来）编排，是最短路径；形态 B 是长期完整的「自己的个人助理」。两者共用同一内核、同一批授权与审计，不允许出现两套安全边界。

## 3. 宿主层架构（四个职责，内核不做、宿主来做）

```
                    ┌─────────────────────────────────────────────┐
   用户已有的助手    │  形态 A：通用 Agent 助手（Claude/Cursor/…）     │
   （MCP host）      │   经 stdio MCP（本机）/ Streamable HTTP（远程）│
                    └───────────────┬─────────────────────────────┘
   zeus 自带的脸    ┌───────────────┴─────────────────────────────┐
   （形态 B，P1+）   │  个人宿主壳：对话入口 · 常驻进程 · 通知渠道     │
                    └───────────────┬─────────────────────────────┘
                                     │ 只进三条通道（MCP / Skill / A2A）
                    ┌────────────────▼─────────────────────────────┐
                    │  ZEUS 内核（personal realm，已落地）             │
                    │  决策编排 · 记忆 · 数据主权 · 备份恢复 · 监督     │
                    │  watch 常驻委托 · 签名授权 · 审计回放            │
                    └───────┬───────────────┬───────────────┬───────┘
                            │ MCP（工具）    │ A2A（vassal）  │ MCP（本机）
              ┌─────────────▼────┐  ┌───────▼────────┐  ┌────▼──────────┐
              │ atlas / commerce │  │ loom（远程下属）│  │ agent-world / │
              │ 等（人类/平台面） │  │                │  │ job-agent /   │
              └──────────────────┘  └────────────────┘  │ agent-dev     │
                                                          └───────────────┘
```

宿主层只有四个职责，**全部不碰确定性闸门**：

1. **门面（Face）**：把内核能力用标准协议暴露给「用户已有的助手」——本机 stdio MCP（零配置、离线）、远程 Streamable HTTP MCP（部署后跨网）、入站 A2A（被别的 agent 编排）。
2. **对话入口（Chat shell）**：可选的自然人话面（P1 起做本地 CLI chat；不做新模型，调用户配置的决策后端）。
3. **常驻与通知（Daemon + Notify）**：把内核已有的 `watch` 用一个宿主进程跑起来（内核不持定时器，由宿主驱动 tick）；触发结果/升级经用户选择的渠道（系统通知、邮件、IM）送达。内核只产出结论，通知是壳。
4. **多设备/恢复（Sync + Recover）**：基于已有的 Vault 备份恢复协议，让数据目录在设备间可同步、可恢复（个人域不依赖任何云端账号；远程只是可选的传输）。

> 形状对照：Moryn 做的「user-owned、auditable context store + handoff、multi-device」在 zeus 里对应 Realm + Vault + 记忆审计；OpenJarvis 的本地 MCP+A2A 对应 zeus 已有的 stdio/HTTP 面。zeus 比它们多的是**确定性闸门与可回放的多 agent 决策**，少的只是上面这层壳。

## 4. 与 Tier0 八个产品的接入拓扑（唯一编排者：zeus）

遵守 [design-agentic-integration.md](design-agentic-integration.md) §4「新产品不从头做，按形态选现成插座」：

| 产品 | 现状协议（已核查） | 在 Personal Agent 里的角色 | 宿主层动作 |
| --- | --- | --- | --- |
| **zeus** | HTTP MCP `/mcp`（Bearer）、入站 A2A + 公开 agent-card、stdio Realm MCP（只读）、MCP 客户端 | **编排者 / 个人助理大脑** | 本轮：暴露 stdio 入口、一键配置、手册；远程随部署 |
| **agent-world** | stdio（默认）+ Streamable HTTP MCP（OAuth 2.1，默认绑 127.0.0.1:3100）；可消费外部 MCP | 世界/沙箱**工具**，由 zeus 或个人助手经 MCP 调用 | 已就绪，写入手册即可 |
| **job-agent** | stdio MCP（仅本机，v0 明确不做远程 HTTP/SSE；MCP_API_KEY 门控） | 求职**工具**，本机 stdio 接 zeus/个人助手 | 补落地页发现层（本轮）；远程是 v0 非目标，不擅改 |
| **agent-dev** | stdio MCP（CLI 子命令，桥本机 daemon，Bearer） | 开发**工具**，本机 stdio 接入 | 已就绪，写入手册 |
| **loom** | A2A（card/rpc，tasks 鉴权用 zeus 专用 key）+ MCP（默认关，仅 plan 只读） | zeus 的**远程下属（vassal）**，由 zeus 编排，不直接对个人助手开放 | 保持；开 MCP/公网需产品侧决策 + 部署 |
| **atlas** | **A2A 执行 Agent 面（W2 已接入 zeus，vassal，域 `ops-orchestration`，ADR T32，router 已挂 `api/main.py:522`）+ MCP 只读 stdio 面（`python -m atlas.mcp`，7 个只读工具，ADR T33）+ 平台 REST**；内部另有 Harness/Graph/Loop 编排内核 | **运营域执行 Agent（嵌套编排者）**：zeus 委派运营类任务，atlas 在自己域内自治 | 已接入，无需「加面」；重点是厘清嵌套边界（见 `bayjf/docs/tier0/zeus-vs-atlas-关系厘清.md`） |
| **commerce-os** | Bearer REST `/api/v1` | 电商业务后端（平台面） | 保持 REST；需要时由 zeus 以连接器方式包一层，不重写 |
| **ops-console** | Cookie 登录的人类 SSR 工作台；服务端 Bearer 调 zeus/commerce | 运营**人类工作台**（代码注释明确不直接给 agent） | 保持人类面 |

**三条纪律**：
1. 个人助手只面对 **zeus 一扇门**（PRD 目标 4）；矩阵产品以工具（MCP）或下属（A2A）身份归属，星型编排、可吊销、名册可验（bayjf 签名 roster）。
2. 不为「凑齐 MCP」而给人类/平台面硬加协议层——commerce-os/ops-console 的正确归属是「人用的系统」，agent 要用它们，应经 zeus 连接器（MCP 包 REST）或保持 GUI 兜底，而不是重写业务内核（[design-agentic-integration.md](design-agentic-integration.md) §6A.2）。
3. **嵌套编排边界**：atlas 是已接入的运营域执行 Agent（W2），它在自己域内可用 Harness/Graph/Loop 自治，但**跨域的决策、授权、冲突、审计一律收敛回 zeus**，不形成第二个顶层门。

## 5. 能力发现层（让 AI 找得到、信得过）

- **落地页 `llms.txt`**：除 `job-agent-landing` 外的 8 个落地页（含 tier0）均提供 `llms.txt` / `llms-en.txt` 机器可读介绍；`zeus-landing/llms.txt` 已内引 MCP/A2A。本轮补齐 `job-agent-landing` 两个文件（纯静态、无架构争议）。
- **信任名册**：bayjf 消费 zeus `/api/roster/public` 的封签快照、构建期客户端验签（RFC 7638 指纹）产出 `/roster`——这是「外部 agent 凭什么信任某个产品身份」的根，不开第二套身份体系（[design-inbound-a2a.md](design-inbound-a2a.md) §4）。
- **Agent Card**：zeus 与 loom 提供 `/.well-known/agent-card.json`（A2A 发现）；其余以 MCP 入口被发现，不强行造卡片。

## 6. 分阶段路线图（含「本轮可落地 / 需决策 / 需外部输入」）

### P0 — 本机零配置接入闭环（本轮实施，纯增量、零运行时依赖、不放开任何写/出域）

- **P0-1** zeus 暴露标准个人 MCP 入口：`package.json` 增加 `npm run mcp:realm` 脚本（`node dist/realm/mcp-stdio.js`）。全仓 `package.json` 无 `bin` 先例（`private`、`files:["dist"]`），本轮**不引入 `bin`**，客户端配置直接用 `node <绝对路径>/dist/realm/mcp-stdio.js <root>`；是否补一个 `bin` 命令列入 P1-2 配置生成器一并定。维持其**只读 personal Realm** 安全模型不变（启动期授权目录、无 MCP 方法可连任意路径）。
- **P0-2** 新增接入手册 `docs/runbooks/personal-mcp-access.md`：可直接抄的 Claude Desktop / Cursor `mcpServers` 配置、stdio 与（未来）HTTP 两种形态、环境变量、**本机实测验收表**、明确列出「目前没有写/没有编排/不能连任意目录」。
- **P0-3** 补齐 `job-agent-landing/public/llms.txt` 与 `llms-en.txt`（与同构落地页同口径）。
- 验收：本机用标准 MCP initialize + tools/list + tools/call 走通只读 search/read；落地页两文件可被构建输出并可访问。

### P1 — 本地自有宿主（小步、可独立验收，需按下条单独立项）

- **P1-1** 给 stdio MCP 增加**只读的计划/状态/名册工具**（如 `zeus.plan`、`zeus.status`、`zeus.skills`），让个人助手能「向 zeus 提问并拿到 plan-only 结果」，但**不**经此通道放执行（execute 仍走签名票据 + H2 面）。新增工具必须是只读、可声明权限、过测试。
- **P1-2** 配置生成器 `zeus mcp-config`：按当前目录/环境打印可粘贴的 `mcpServers` JSON（消除手抄路径）。
- **P1-3** 本地轻量对话壳（CLI chat，复用意图识别 plan-only + 决策后端，不新增模型），把 `daily` 一次性入口升级为可连续对话但默认 plan-only。
- **P1-4** 宿主守护：一个 `zeus daemon`（用户主动启动）周期驱动 `watch` tick，并把升级项送系统通知（内核 watch 已就绪，缺的是壳；不在内核加定时器）。

### P2 — 远程、多设备、完整个人助理（多数依赖外部输入，须你拍板）

- **P2-1** zeus 门面真机部署（PRD E10.2，当前 ⬜）：公网域名/TLS、远程 Streamable HTTP MCP（Bearer/OAuth）、入站 A2A，使云端个人助手跨网可达。**依赖：服务器、域名/TLS、密钥托管、现网观察期。**
- **P2-2** 生产 RSK 托管 + 根公钥指纹带外公告（E4.9，仓库外动作），闭环 bayjf 公开名册的信任链。
- **P2-3** 多设备：基于 Vault 的加密同步/恢复（可走用户自带存储，不绑定账号）；通知渠道（邮件/IM）。
- **P2-4** 跨设备记忆/上下文 handoff（对齐 Moryn），数据归属仍在用户、设备间可审计。

### P3 — 长期/非目标，默认不做

- 传承 dead-man switch + 密钥托管（E8.4，P3，法律框架 deferred #2/#3）。
- 给 commerce-os / ops-console 加 MCP/A2A 协议面（保持人类/平台面）。
- atlas 已在 W2 接入（A2A + 只读 MCP）；其 MCP 进一步加 HTTP/写能力（atlas docs/117、D49）属 atlas 自身选型，落地时须与 zeus 授权/审计对齐，不由本方案代决。
- 打开 loom 的 MCP 远程开关（产品默认有意关闭，须 loom 侧决策与公网 `public_base_url`）。
- 给 job-agent / agent-dev 加远程 HTTP（其 v0 明确为非目标）。
- 自造模型、自造私有协议、让模型自行决定发起不可逆动作。

## 7. 安全边界（宿主层不移动任何闸门）

- **只读优先**：P0 经 stdio 暴露的是只读 personal Realm（search/read）；写入、执行、对外发送一律不进个人 MCP 通道。
- **自由在左、确定在右**：宿主只负责把自然语言交给内核、把结论讲成人话；权限、不可逆动作、钱、状态机、provenance/审计仍由内核确定性闸门与签名票据把关（[design-agentic-integration.md](design-agentic-integration.md) §3.2 钉死清单）。
- **启动期授权目录**：stdio MCP 不提供「连任意路径」的方法，根目录只在启动时由 argv/env 授权（沿用 `mcp-stdio.ts` 现有安全模型）。
- **默认零出域**：本地规则意图识别 `backend:null`；要模型/远程才显式 opt-in（PRD E2.6）。
- **个人域与企业域不互通**：宿主不新增任何跨域路径，沿用 `decideRealmAccess`。

## 8. 明确不做（以及为什么不是偷懒）

- **不新建独立 Personal Agent 产品**：会重复 zeus 已完成的内核并制造第二套安全边界。
- **不在内核加对话人格/定时器/通知通道**：这些是宿主职责，self-host-loop 已把它们排除在内核之外。
- **不为凑协议给所有产品加 MCP/A2A**：人类/平台面保持 REST/GUI，需要时经 zeus 连接器包一层。
- **P0 不放任何写/执行能力**：没有完整授权与审计闭环前，个人 MCP 只读。
- **不把云端部署当成本轮任务**：它依赖域名/TLS/密钥托管等仓库外输入，需你显式授权。

## 9. 本轮（P0）落地清单

| # | 仓库 | 改动 | 类型 |
| --- | --- | --- | --- |
| P0-1 | zeus | `package.json` 增加 `mcp:realm` 脚本（不加 bin，沿用全仓无 bin 惯例），暴露只读个人 Realm stdio MCP | 配置/入口 |
| P0-2 | zeus | `docs/runbooks/personal-mcp-access.md` 接入手册 + 本机实测验收 | 文档 |
| P0-3 | job-agent-landing | `public/llms.txt` + `public/llms-en.txt` 发现层补齐 | 静态发现 |

P1 及以后均按本文 §6 单独立项，不在本轮扩范围。

## 10. 外部参考（可查证）

- MCP×A2A 互操作综述（A2A 2025-04 Google 开源）：https://arxiv.org/pdf/2506.01804v1
- A2A 官方社区·与 MCP 的关系（「MCP 连工具、A2A 连 agent，把 Agent 建模为带 AgentCard 的 MCP resource」）：https://agent2agent.info/specification/mcp-integration/
- MCP vs A2A 对比（IBM ACP 2025-09 并入 A2A）：https://os.moda/blog/mcp-vs-a2a-protocol-guide 、https://www.svix.com/resources/faq/a2a-vs-mcp/ 、https://businessmcp.com/guides/mcp-vs-a2a
- 自托管个人 agent 栈三要素（MCP Server Adapter + Agent Orchestrator + 本地向量库）：https://dev.to/tamizuddin/from-rest-to-mcp-building-a-self-hosted-ai-agent-stack-that-achieves-rapid-context-forking-2llm
- 本地优先个人上下文/记忆：Moryn 设计稿（personal, multi-agent, multi-device, user-owned, auditable）：http://raw.githubusercontent.com/Richardyu114/Moryn/HEAD/docs/moryn-design.md ；M3 Memory：https://pypi.org/project/m3-memory/2026.7.25.0/ ；Memento：https://pypi.org/project/memento-mcp/0.4.0/ ；open-memex：https://www.npmjs.com/package/open-memex
- OpenJarvis（Stanford 系本地优先，MCP+A2A）：https://qiita.com/kai_kou/items/2479387d9b2cbf7bb040
- 以「人」为中心的 Personal AI（Today AI 融资）：https://m.toutiao.com/group/7700189955104768554/
- 常驻个人助理品类（OpenAI Dots / Meta Muse，内部 design-self-host-loop §8 已引用）。

## 11. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.2 | 2026-10-25 | **修正 atlas 归属**：v0.1 误记 atlas「无协议面、不建议加」；实地核查确认其已有 A2A 执行 Agent 面（W2 接入 zeus，vassal，域 ops-orchestration，ADR T32）与 MCP 只读 stdio 面（7 工具，ADR T33），关系为「嵌套编排」（atlas 域内自治、跨域收敛回 zeus）。同步改 §4 表格、纪律（两条→三条）、P3；专项证据见 `bayjf/docs/tier0/zeus-vs-atlas-关系厘清.md`。 |
| v0.1 | 2026-10-25 | 首版：基于 8 个 Tier0 仓库源码核查与外部调研，确定「不新建内核、补 zeus 宿主层」判断；给出四层宿主职责、Tier0 接入拓扑、P0–P3 路线图；本轮落地 P0 三项。 |
