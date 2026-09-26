# Zeus 术语对照（叙事隐喻 ↔ 工程原语 ↔ 行业标准用语）

> 现行 **v0.3**（2026-09-25）。用途：对外文档（评审、PRD、演示、接口文档）与内部交流之间的术语翻译约定；避免读者把项目的叙事化命名误读为行业标准术语。
> v0.3 变化：**对外口径由用户收紧为"只要专业用语，不要比喻"**——不再允许"专业词 + 隐喻括注"，README 已按此重写（并顺带修掉三处过期事实）。
> v0.2 变化：映射表 16 → 31 行（补 意图 / 驾驶员 / 拍板 / 监督台 / 数据二极管 / 记忆与遗忘权 / 日记 / 编制 / 上岗签字 / 封神榜 / 内核 / 决策回放 / 连接器，每行锚点均经 grep 核到 `file:line`）；新增**冲突风险分级**（A 业界本名 / B 自创隐喻 / C 同名异义），其中 `vault`·`kernel`·`driver`·`realm`·`commission` 属 C 类，对外必须改写。

## 背景与约定

Zeus 的项目文档与代码大量使用**叙事化隐喻**（封臣/效忠/战报/藏宝图等）。这是设计哲学明确允许的命名层——「叙事化概念必须与真实可执行的工程原语同构」（见 docs/product-portrait.md 设计哲学第 2 条），即每个隐喻词都严格对应一个可运行的代码实体，内部全局一致。

- **内部**（handoff / 设计文档 / 代码注释 / 代码标识符与环境变量名）：保留既有命名，不加额外说明。
- **对外**（README、对外接口文档、演示、给非项目读者的一切正文）：**一律用专业术语，正文不出现隐喻词，也不写"隐喻 ↔ 专业词"的括注**。原 v0.1/v0.2 约定是"专业词为主 + 隐喻加注"，**2026-09-25 由用户收紧为"只要专业用语，不要比喻"**——加注仍会把读者的注意力带回隐喻，等于没换。
  - 唯一允许的例外：README 末尾一节独立的**「命名说明」**，声明源码标识符是内部命名且不代表任何第三方系统（`src/vault/` 与 HashiCorp Vault 无关），并把读者指向本对照表。这是**给读代码的人看的免责声明，不是行文里的比喻**。
  - 改口径时**顺手核实状态句**：README 从隐喻改专业词的同一批改动里，也修掉了三处已过期事实（MVP 判定仍写 ❌、测试数写 431、E4.8 写"没人跑过验收"）。措辞迁移是把文档重新对一遍代码的契机，别只换词。
- 代码注释已有"叙事 + 专业"双写的先例（如 `src/orchestrator/types.ts` 中 `Position` 的注释直接使用专业描述），新写注释沿用此惯例。

## 核心映射表

| 项目隐喻 | 专业/标准用语 | 代码/设计落点 |
| --- | --- | --- |
| 封臣（vassal） | 子代理 / 执行者 / worker / A2A agent | `VassalEntry`（`src/registry/registry.ts`：可派发执行者，经 A2A 标准交互注册、状态 active/revoked、带出站凭证） |
| 封臣响应（vassal response） | 执行者的立场回传 / 子代理意见 | `Position = { vassal, stance, weight?, rationale? }`（`src/orchestrator/types.ts`：从任务终态产物提取的决策立场） |
| 立场（stance） | 决策立场 / 证据意见 | `Position.stance`，聚合规则的输入单位 |
| 效忠（fealty） | 注册握手 / 凭证契约 | `x-zeus-fealty` 头 + `AgentCard` 校验（`src/registry/registry.ts`、`src/a2a/types.ts`、docs/design-vassal-protocol.md） |
| 名册 / 封神榜（roster） | 可派发执行者目录 | `src/registry/roster.ts`（internal/public 双快照、签名封签） |
| 扇出（fan-out） | 并行任务派发 / 扇出路由 | `src/dispatch/`（Dispatcher：JSON-RPC + SSE 客户端） |
| 聚合规则 | 共识聚合（一致 / 多数 / 加权投票） | `AggregationRule`（`src/orchestrator/types.ts`） |
| 仲裁（arbitrate） | 模型裁决（置信闸门） | `arbitrateSplit`（`src/decision/arbitrate.ts`） |
| 对抗复核（judge） | 对抗性复核 / adversarial review | `judgeDecision`（`src/orchestrator/judge.ts`，E1.3） |
| 战报（report-back） | 任务产物回传 | A2A `Artifact`/`Task` 终态（docs/design-vassal-protocol.md） |
| 升级（escalation） | 升级人工驾驶 / needs-driver | `src/oversight/`（OversightDesk：task-input / intent-conflict 升级队列） |
| 上岗门 | 上岗资格校验（seat/account/authorization/mentorship） | `src/onboarding/`（E9.1/E9.2，现算不缓存） |
| 数据域（realm） | 数据边界 / 数据域（personal / enterprise） | `src/realm/`（目录即数据库、数据二极管） |
| 藏宝图（vault） | 备份与恢复协议（引用 + 指纹 + 加密备份包） | `src/vault/`（E8.1/E8.2/E3.7） |
| 立国三纲 | 能力接入三原语：MCP / Skill / A2A | docs/design-agentic-integration.md §2A |
| 决策后端（decision backend） | 模型无关决策端口 | `DecisionBackend`（noul/choice/score，`src/decision/types.ts`） |
| 意图（intent） | 一次编排请求 / 目标 | `FanOutRequest.intentId`（`src/orchestrator/types.ts:58-60`） |
| 驾驶员（driver） | **人工在环的操作者**（human-in-the-loop operator），非"设备驱动" | `FanOutStatus = 'completed' \| 'partial' \| 'failed' \| 'needs-driver'`（`src/orchestrator/types.ts:19`）、`DriverResolution`（`:91`）、bearer 保护的 H2 面 |
| 拍板 | 人工裁决回写 | `applyConflictResolution` + `POST /api/escalations/:id/resolve`（E6.2） |
| 监督台 | 升级队列 / HITL 控制台 | `OversightDesk`（`src/oversight/oversight.ts`） |
| 数据二极管 | **data diode——业界本名，不是隐喻，可直说** | `src/index.ts:8`、`src/realm/tenant.ts:6`、README 的 dispatch 行 |
| 记忆（事件 / 事实） | 带 provenance 的事件存储 + 断言事实 | `src/memory/`（`retraction` / `retractFacts` / `forgetSubject`） |
| 遗忘权 | 数据主体删除权（erasure） | `MemoryStore.forgetSubject` + `POST /api/memory/forget-subject` |
| 日记 | 把事件流写成可读叙事的日志 | `src/diary/`（`build` / `from-memory` / `markdown` / `persist`） |
| 编制 / 岗位 / 单一负责人 | 组织结构与问责映射（accountability） | `src/org/`（`OrgRole`、`lead` / `leadId` / `leadMember`） |
| 上岗签字（commission） | 上岗授权的签署 / 豁免 / 撤回 | 审计枚举 `commission-granted\|waived\|withdrawn\|refused`（`src/dispatch/dispatcher.ts:25-28`）+ `src/onboarding/` |
| 封神榜 | 对外发布的**已签名**公开名册 | `projectPublicRoster` + `sealSnapshot`（`src/registry/roster.ts`） |
| 内核（kernel） | **运行时 / 编排引擎**，勿直译成 OS kernel | `bootKernel`（`src/state/boot.ts`） |
| 决策回放 | 确定性重放（deterministic replay） | `src/orchestrator/replay.ts` + `GET /api/intents/:id/replay` |
| 连接器 | MCP 客户端接入点 | `src/mcp/connectors.ts`（`ConnectorRegistry.callTool`） |

## 哪些词该清除：比喻还是客观事实

判定标准**不是**"词源是不是比喻"——按那个标准 `Agent`（代理人）、`kernel`、`plugin`、`driver`、fan-out、栈、总线、宿主、连接器 全得删，而它们正是行业标准用语，删掉只会让文档**更不专业**。真正的判据是一条：**读者要不要做一次映射，以及那次映射会不会暗示一个并不存在的机制。**

| 档 | 判据 | 本项目里的词 | 处理 |
|---|---|---|---|
| **① 客观事实档** | 词就在指那个东西本身，是通用行政/技术词汇，读者无需映射 | **编制**（人员编制）、**岗位**、**上岗**、**名册**（名录）、**导师 / 带教**（行业词）、**日记**（系统确实按天写出 `diary/YYYY-MM-DD.md`）、**移交 / 传承**、**外客**（guest） | **保留**。把它们当隐喻清除，是用黑话替换常识词 |
| **② 行业死隐喻档** | 词源是比喻，但业界按字面使用，不会误导 | **内核**、**插件**、**连接器**、**扇出**、**监督台**、**数据底座**、**驱动** | **保留为术语**；只有当它**不精确**或**与既有术语同名易混**时才改（"内核"改说"运行时核心"是因为 `kernel` 会被读成操作系统内核——这是**精确性修正**，不是去隐喻） |
| **③ 会暗示假机制的真隐喻** | 读者会真去做映射，而映射不成立：系统里没有封建隶属、没有效忠义务、没有战场、没有船与港、没有脊柱、没有宝藏 | **封臣**、**效忠**、**宣誓**、**战报**、**藏宝图**、**宝藏**、**封神榜 / 封神**、**驾驶员 / 驾驶**、**拍板**、**避风港 / 港湾**、**审计脊 / 同脊**、**立国三纲 / 三纲**、**交回** | **换成专业用语**，且不写"专业词（隐喻）"括注——加注仍会把读者带回隐喻 |

两条附带约束：

- **不得为了"去隐喻"改错语义**。本仓库的实际反例：`越界` 曾被并入替换表 → `越权`。两者不同——路径穿越越的是**目录边界**，越权是**权限边界**，混用会把安全语义说错。**任何词进替换表前先问：替换后那句话还成立吗？**
- **精确性与去隐喻是两件事，理由要写对**："名册→目录快照""内核→运行时核心"属前者（原词低估或含混了对象是什么），不是后者。

## 冲突风险分级（对外表述前先查这一列）

与"该不该清除"正交的另一根轴：**读者会不会把它误认成别的东西**。

| 级别 | 判据 | 本项目里的词 |
|---|---|---|
| **A 类：业界本名** | 行业标准里就这么叫，直说加分 | data diode、MCP / Skill / A2A、idempotency、SSE、agent card、judge（LLM-as-judge）、replay、fealty→握手/凭证契约（协议层）、vault 语义下的 digest / manifest |
| **B 类：项目自创称谓** | 读者看得出是比喻，但**查不到标准定义** | 封臣 / 效忠 / 战报 / 藏宝图 / 立国三纲 / 封神榜（= 上表**③ 档**）→ 对外不用；**注意：名册 / 编制 / 日记 / 上岗不在此档**，它们是通用词，按① 档保留 |
| **C 类：与既有术语同名异义（最危险）** | 对外读者会**先想到另一个东西**，误读成本项目集成了它或实现了它 | **`vault`**（会读成 HashiCorp Vault）、**`kernel`**（OS 内核）、**`driver`**（设备驱动 / 测试驱动，而这里是"驾驶员=人工在环"）、**`realm`**（认证域 Kerberos/LDAP；方向相近但含义不同）、**`commission`**（英文先想"委托 / 佣金"） |

**B/C 类的对外处理（v0.3 口径）**：对外正文只用专业用语，**不写"专业词（隐喻）"式括注**；需要解释某个既有名字时，用下面两节的"含义 + 出现面"来解释，而不是换一个比喻。

## 历史标识符的含义（读代码、配置、数据文件时需要）

对外文档不再使用这些词，但它们**存在于代码、环境变量、协议字段与已落盘的数据里**，逐个说明它做什么：

| 标识符 | 它是什么 | 出现面 |
|---|---|---|
| `vassal` / `VassalEntry` / `VassalRegistry` | 已注册、可被派发任务的外部执行 Agent 及其注册表（A2A 卡片发现、active/revoked 状态、出站凭证） | 代码、状态文件键 `registry`、HTTP 路径 `/api/vassals`、环境变量 `ZEUS_VASSAL_SEEDS`、审计事件 `vassal-revoked` |
| `fealty` / `x-zeus-fealty` | 注册握手声明：归属、数据域、数据策略、结果回传与升级策略；缺失即拒绝注册 | **线上协议字段**（卡片 HTTP 头）、`Fealty` 类型 |
| `roster` | 注册表状态的不可变签名投影（`entries` + 条目 attestation + 快照签名） | 代码、HTTP `/api/roster`、`/api/roster/public`、对外发布物 |
| `realm` | 一个可连接的本地数据目录（`personal` / `enterprise`），带确定性 ID 与内容摘要 | 代码、状态文件键 `realms`、HTTP `/api/domains*`、环境变量 `ZEUS_REALM_ROOTS` / `ZEUS_REALM_ENTERPRISE`、审计事件 `realm-write` |
| `vault` | 备份与恢复协议：只存引用与指纹的清单 + AES-256-GCM 加密内容包。**与 HashiCorp Vault 无关** | 代码目录 `src/vault/`、CLI `npm run vault`、环境变量 `ZEUS_VAULT_PASSPHRASE` |
| `kernel` / `bootKernel` | 运行时核心的装配入口：把注册表、派发器、人工队列、编排器、指标、组织一次接起来 | 代码、状态文件 `ZEUS_STATE_FILE` |
| `driver` / `needs-driver` / `DriverResolution` | **人工在环**：需要操作者判断的状态，与操作者给出的裁决结果 | 状态枚举、HTTP 响应字段、审计事件 `driver-grant-issued` |
| `commission` | 上岗授权档案：开档、签字、豁免、撤回及其台账 | 代码、状态文件键 `commissions`、审计事件 `commission-granted\|waived\|withdrawn\|refused`、HTTP `/api/org/departments/:id/commissions*` |
| `mentorship` / `MentorshipLedger` | 能力认证流程：逐项评估通过后，一个 Agent 才被登记为某技能的提供者 | 代码、状态文件键 `mentorships`、HTTP `/api/mentorships*` |
| `diary` | 把记忆事件按天组织成可读记录（只呈现不臆造，每行锚定事件 ID） | 代码目录 `src/diary/`、HTTP `/api/diary*`、落盘文件 `diary/YYYY-MM-DD.md` |
| `noul` | 决策后端端口的**是非判断**方法：返回概率 + 置信度 + 是否模型标定，与 `choice`（多选一）/ `score`（分档评分）并列 | `DecisionBackend.noul`（`src/decision/types.ts:12`，`NoulResult`）。**不是本项目造的比喻**——沿用所对接决策模型（Jev）的请求字段名 |

## 破坏性面（改这些名字要付的代价）

上面这些名字**不是纯措辞**，改名不等于重命名变量。若要把标识符也换成专业词，代价分四档，逐档需单独批准：

| 档 | 对象 | 后果 |
|---|---|---|
| 1 纯内部标识符 | 类名 / 函数名 / 目录名（如 `VassalRegistry`、`src/vault/`） | 只影响代码内；`src` + `tests` 约 **4,000+ 处**引用，需一次全量回归（基线 692 项 / 72 文件、CI 双矩阵） |
| 2 已落盘的数据格式 | 状态文件 JSON 键（`registry` / `realms` / `commissions` / `mentorships` / `domainGrants` / `writeGrantNonces`）、审计 JSONL 的 `decision` 取值、备份清单与加密包、**签名名册的载荷**（JCS 规范化后逐字节参与验签） | 旧文件与旧备份必须仍可读；改签名载荷会让**历史名册与已发凭证全部需重签或加兼容分支** |
| 3 配置与环境 | 24 个 `ZEUS_*` 变量里的 `ZEUS_VASSAL_SEEDS`、`ZEUS_REALM_ROOTS`、`ZEUS_REALM_ENTERPRISE`、`ZEUS_VAULT_PASSPHRASE`、`ZEUS_RSK_KEY*` | 破坏现有 `.env`、systemd `EnvironmentFile`、`docker run --env-file` 与部署手册 |
| 4 线上协议与路由 | 卡片头 `x-zeus-fealty`、HTTP 路径 `/api/vassals`、响应字段 `Position.vassal` 等 | **对端已部署**：生产上的 pr-helper 按这个头声明归属，改字段需两侧同步迁移并留兼容期 |

**当前口径（2026-09-25 用户定）**：文档与注释措辞换专业术语；标识符、协议字段、环境变量与数据格式**不动**，需要时由本节解释含义。将来若要动第 2–4 档，按**契约变更**立项（含迁移与兼容读取），不作为文档批次的顺带项。

## 对外一句话示例

内部写法：

> 意图（结构化）→ fanOut → 封臣响应 → 规则聚合 → 结论

对外专业写法：

> 结构化意图经驱动接口进入编排器，按技能路由将任务并行扇出给多个注册执行器（A2A 子代理）；各执行器回传带依据与权重的决策立场，规则引擎按一致 / 多数 / 加权策略聚合出决策结论；结论不成立时进入升级链（置信闸门、对抗复核或人工驾驶接管）。

## 维护约定

- 本表只收录**已在代码/设计中存在的映射**；新增叙事命名时，落地代码前先在 `docs/design-*.md` 里写明其工程原语对应物（设计哲学第 2 条的执行要求）。
- 术语含义以代码为准；本表与代码不一致时，改本表，不改代码。
- **锚点是可核验声明**：每行的 `file:line` 与符号名在改动本表时都要重跑一遍确认存在（`grep -rn "<符号>" src | head`）。引用行号前先量，不要抄上一版——本仓库已有过"数字被逐份继承"的先例。已知假阳性：该检查会把反引号里的**非代码词**也算成符号（如 systemd 的 `EnvironmentFile`），报 `MISSING` 时先判断它是不是代码标识符。
- 复校一条命令（表内符号是否仍在 `src/` 里）：`grep -oE '`[A-Z][A-Za-z]+`' docs/terminology.md | tr -d '`' | sort -u | while read s; do grep -rq "class $s\|interface $s\|type $s\|const $s\|function $s" src/ || echo "MISSING $s"; done`
