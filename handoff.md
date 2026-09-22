# Handoff

State of Zeus as of 2026-09-21.

> Zeus 处于「核心内核起步 + 技术方向展开」阶段：A1 注册中心、A2 派发器、A4 监督台、**E1 并发决策内核第一批（fan-out/幂等/cancel 传播/合并/规则聚合/冲突升级）**已落地（纯 TS 库 + vitest，**124 项测试绿**）；派发侧治理闭环、名册投影器 R0、D1 Realm P0、Realm MCP stdio 脚手架、fealty 签名链 v1 纯函数、HTTP H1（Fastify）、协议缺口补齐已落地；CI 就位。**2026-09-22 新增三份技术设计**：记忆整理协议、Supervisor/Subagent 控制模型、Agent 技术探索地图（A 组 S1–S5 裁决优先）。此前工作经 PR #1/#2 合入 `origin/main`；当前在 `dev`（领先 `origin/dev` 7，push 需授权）。本文件记录项目当前状态、活跃任务与文档索引。

## Current state

- 已完成上层方向定位与产品画像 v0.1（2026-09-21）。
- 项目骨架文档已按 agent-world 惯例建立：AGENTS.md / handoff.md / docs/。
- 已 `git init` 并推 GitHub private；HTTP 技术栈已选型（Fastify + 长驻 Node，薄传输层，H1 随 roster R1 装依赖，见 docs/design-http-transport.md）；内核仍为纯 TS 库。
- 封臣治理闭环打通：registry 实时目录（asVassalLookup）→ dispatcher 派发前吊销阻断 → 审计桥统一记录（2026-09-21）。
- bayjf 封神榜设计 v0.1 完成，R0 名册投影器（internal/public 双快照）落地（2026-09-21）。
- Realm 两个 P0 前开放问题已拍板（v0.2：对外唯一传输 MCP、P0 文件系统扫描）；Realm P0 库内实现落地（2026-09-21）。
- 库公共入口与构建链落地（2026-09-21）：`src/index.ts` 聚合六模块公共面，`npm run build` 出 `dist/`（含 .d.ts），package.json 声明 main/types/exports。
- Realm 只读 MCP stdio 脚手架落地（2026-09-21）：零新依赖，resources 映射 manifest/search/read，宿主预连接授权目录、协议不暴露 connect，绝对路径不出进程；12 项协议测试 + 真实子进程 stdio 冒烟通过。**非正式 P1 启动**（触发条件仍是 read-realm 封臣出现）。
- fealty 签名链 v1 纯函数落地（2026-09-21）：`src/registry/signing.ts`（JCS 子集规范化、card/fealty digest、条目 attestation、快照 seal、离线 verify，node:crypto Ed25519 内存 signer/verifier），设计稿 §8.1 八条验收全部有测试；deferred #7 仍未销项（待 R1 HTTP 接线与 R2 bayjf 验签、生产密钥存放）。
- 对外前置制品齐备（2026-09-21）：loom 契约兼容性测试（照抄 loom 真实 card/SSE fixture，6 项）、验收 #6 纯标准 A2A 客户端脚本（scripts/，mock 自测 3 项，真机执行待部署）、GitHub Actions CI（Node 20/22，本地按 CI 序列实跑全绿，push 后触发）。
- **HTTP H1 传输层落地（2026-09-21，commit 3190a11）**：`src/http/`（Fastify 5，全仓库唯一允许 import fastify 的目录，内核零传输依赖）。`server.ts` 导出 `createHttpServer(deps)`（不 listen，测试用 inject）/ `startServer`（默认绑 127.0.0.1）；三端点：`GET /healthz`（仅 status/version/ts，无封臣与 Realm 信息）、`GET /api/roster/public`（实时 `listAll()`→public 投影→`sealSnapshot` 封签，离线可验，`Cache-Control` 对齐 seal TTL，revoked/cardUrl/taskUrl/healthDetail 不进投影条目）、`GET /api/roster`（bearer 常量时间比对，未配 internalToken 则路由不挂载→404，internal 视图不封签）。`serve.ts` 为进程入口（env 装配：ZEUS_HOST/PORT/INTERNAL_TOKEN/RSK_KEY_ID/RSK_KEY，无 PEM 时用临时内存钥并 stderr 告警）；package.json 增 `./http` 子路径导出与 `npm start`。7 项 inject 端到端测试（离线验签、条目/provenance/签名三类篡改拒绝、过期、鉴权矩阵、空名册）。
- **协议缺口补齐（2026-09-21，commit 9dcf2c4 / a6c6a69）**：① dispatcher 新增 `sla-ack-breached` 审计决策——首个 SSE 流事件为受理信号，晚于 `fealty.sla.ackSeconds` 即审计（注入式单调时钟，违约不阻断任务，无 SLA 声明不计时）；② Artifact.parts 增加标准 A2A `FilePart`（URI 引用形态，Zeus 只透传呈现给驾驶员、不自动拉取，bytes 内联保留类型但 v1 不产出），新增 `src/a2a/parts.ts`（isFilePart/artifactFileUris）并从内核出口导出；③ Task 增加宽松可选 `history`（原样透传不解析，loom 不发 / pr-helper 发）。
- **Windows 测试可移植性（2026-09-21，commit 82671cc）**：Realm 夹具在无 symlink 权限（Windows 非管理员 / 未开开发者模式，symlinkSync 抛 EPERM）时降级，symlink 专属断言条件化，其余用例恢复；安全边界在 CI 与有权限平台仍完整覆盖。全量 **98 项绿、typecheck/build 通过**（14 个测试文件）。

## New inputs / 待确认

- ~~**Jev 模型（2026-09-22 负责人提及）**~~ ✅ 已核实并落设计（见 Active work 12）：Jev = TypeSafe AI 首个公开 "System One" 决策模型（2026-09-15，创始人 Diogo Almeida 为前 OpenAI 研究员）；不吃文本，输入 state + 类型化问题，输出 Choice/Score/Noul 带概率与置信度；输入 $0.042/M token、输出免费、延迟 70–500ms；已上 Cloudflare AI 目录。**角色判定：可接入的外部能力（决策模型 API），非驱动模型、非封臣模型**；落点 = 快决策层 DecisionBackend，Jev 为首个实现，见 [docs/design-decision-backend.md](docs/design-decision-backend.md)。技术地图 S14 落此层。

## Active work

1. ~~拍板封臣协议形态~~ ✅ 2026-09-21 已定：A2A 超集（deferred #1 销项）。
2. ~~起草 design-vassal-protocol.md~~ ✅ 2026-09-21 完成 v0.1。
3. pr-helper 封臣验收（design-vassal-protocol.md §7，共 6 项）：#1 Agent Card + fealty ✅、#2 tasks/sendSubscribe 全流程 ✅（JSON-RPC + SSE，14 项单测）、#3 战报三字段 ✅、#4 escalation ✅（merge-pr / production-rollback execute 模式升级）、#5 Zeus 派发侧 ✅ 2026-09-21（脱敏/数据二极管早有；本轮补齐吊销强制力：registry `asVassalLookup()` 实时目录、dispatcher 派发前阻断已吊销封臣且不发请求不发 token、`revokeAuditBridge` 把 vassal-revoked 治理事件并入审计；端到端治理闭环测试 tests/governance-flow.test.ts）。**#6 守护脚本已备**（`scripts/acceptance-standard-a2a.mjs`：纯标准 A2A 客户端，不读/不发任何 x-zeus-*，text part 调 tasks/send；`tests/acceptance-script.test.ts` 3 项 mock 自测），**真机执行待 pr-helper 部署**：`BASE_URL=https://<host> node scripts/acceptance-standard-a2a.mjs`。已知限制：任务存储为实例内存（跨调用尽力而为）、execute 模式待凭据委派。
4. ~~bayjf 名册改造方案~~ ✅ 2026-09-21：docs/design-bayjf-roster.md v0.1（单一事实源在封臣、内外双视图裁剪、签名链为公开闸门、R0–R2 阶段）；R0 投影器已落地（`src/registry/roster.ts`：listAll → internal/public 两份 RosterSnapshot，3 项测试）。后续 R1 待 HTTP 层、R2 为 bayjf 仓库改造（公开前须销项 deferred #7 签名链）。
5. ~~Realm 契约开放问题拍板 + P0 实现~~ ✅ 2026-09-21：传输层拍板**对外唯一 MCP server**（P0 库内先行、P1 第一件事包 MCP，不做独立 HTTP API），检索拍板**P0 文件系统扫描 + 可替换 SearchBackend**（升级阈值登记 deferred #10）；契约升 v0.2。P0 已落地 `src/realm/`（FsRealmStore：connect/manifest/search/read，只读 personal，8 项测试）：确定性 realmId（realpath 派生）、connect 幂等、contentDigest 基线、文本白名单/隐藏与依赖目录剪枝/1MiB 上限/symlink 拒绝、read 路径穿越防护（路径段 + realpath 双检）。**已知边界**：search 基于 connect 快照（重连刷新），read 实时读盘（保证恢复协议正确）；Realm 状态为实例内存；无传输层（仅 MCP stdio 脚手架）；enterprise/write/tags 检索为 P1。下一步：P1 MCP server 正式暴露（read-realm 封臣出现时启动）；只读 stdio 脚手架已先行落地（见 Active work 8）。
6. ~~loom 封臣接入~~ ✅ 2026-09-21 负责人裁决四项全按草案；loom 侧第一阶段 plan 模式已落地（Q150：`backend/app/core/a2a/` card·skills·rpc·router，12 单测 + 10 集成测试全绿，commit 0ba84d3/6404b99 在 loom dev 分支）。边界：任务进程内存、未真机联调。**Zeus 侧契约兼容性测试已备**（`tests/loom-contract.test.ts` 6 项：fixture 照抄 card.py/skills.py/rpc.py/router.py，覆盖注册、sendSubscribe 全链路与战报四字段、缺参 input-required 中性升级、tasks/send 同步、-32002 取消拒绝、Q88 401）。下一步：Zeus↔loom 真机联调（待 loom 起测试环境）。
7. ~~A4 监督台最小版 + registry 全量视图~~ ✅ 2026-09-21：`src/oversight/`（OversightDesk：收集 input-required 升级请求、approve/reject、reject 联动 cancel、按 taskId 幂等、全程审计，8 项单测）；registry 新增 `listAll()`（含已吊销封臣，带 active/revoked 状态，供监督台视角）。全量 24 项测试绿、tsc 干净。边界：纯库类，尚无 HTTP 层；approve 仅记录决议，补参重派仍由调用方执行。
8. **库形态收尾与对外前置批次（2026-09-21 起，纯库内可闭环，不依赖部署）**：
   - ~~公共 API 入口 + 构建产物链~~ ✅ 2026-09-21：`src/index.ts` 聚合导出六模块公共面（a2a/registry/roster/dispatch/oversight/realm，23 个运行时导出）；`tsconfig.build.json` 出 `dist/`（.js + .d.ts + sourcemap，dist 已 gitignore）；package.json 补 main/types/exports/files 与 `build` 脚本。产物冒烟通过，40 项测试绿、tsc 干净。
   - ~~补写 README.md 仓库入口文档~~ ✅ 2026-09-21：根目录 README（定位、六模块说明、build/test/typecheck 命令与 Realm 最小示例、当前边界、文档导航、协作约定）。
   - ~~deferred #7 fealty 签名链设计草案~~ ✅ 2026-09-21：`docs/design-fealty-signing.md` v0.1（威胁模型 T1–T4；裁决 v1 Zeus 单签背书、v2 封臣自签交叉背书；Ed25519 + RFC 8785 JCS；条目 attestation + 快照 seal 两层信封；RSK 密钥归属/轮换；吊销四层失效含 TTL 硬过期；发布管线与接口草案；v1 八条验收）。**注意：设计完成 ≠ deferred #7 销项**，销项标准是 v1 随 R1/R2 实现并通过八条验收；触发条件「bayjf 公开前」不变。
   - ~~HTTP 技术栈选型设计~~ ✅ 2026-09-21：`docs/design-http-transport.md` v0.1 拍板 Fastify + 长驻 Node（不选 serverless），薄传输层 src/http 单向依赖内核、Realm 不挂 HTTP；H1 三端点（healthz/roster public 签名快照/roster internal 鉴权）随 roster R1 装依赖，H2 驾驶员 API 待持久化。
   - ~~Realm P1 MCP stdio 壳 + store→MCP resource 映射~~ ✅ 2026-09-21：`src/realm/mcp.ts`（零依赖 JSON-RPC 处理器：initialize 版本协商、resources/list·templates/list·read，只读不声明 tools；URI `zeus-realm://{realmId}/manifest|search|item`）+ `src/realm/mcp-stdio.ts`（进程入口，argv/env 预连接授权目录、只读 connect、stderr 日志/stdout 纯协议）。**路径不外泄**：connect 不经协议暴露、manifest 剥 root、错误消息只含相对 itemId；12 项测试（tests/realm-mcp.test.ts）+ build 后真实子进程冒烟全过，全量 52 项绿。边界：未引官方 SDK，protocolVersion/模板兼容性待正式 P1 用标准 client 复核；不做鉴权/HTTP（stdio only），正式启动仍待 read-realm 封臣出现。
   - ~~契约⇄代码一致性审计~~ ✅ 2026-09-21（对照 loom `backend/app/core/a2a/` 与 pr-helper `api/a2a/` 真实实现逐条核对）。**已修漂移 3 处**：① §4.5 fealty.version 版本协商原未实现（registry 只查字段存在）→ 新增 `SUPPORTED_FEALTY_VERSIONS=['1']`，不支持版本拒绝注册；② `AgentCard` 类型缺标准字段 `defaultInputModes`/`defaultOutputModes`/`provider`（§3.1 要求、两个封臣实发）→ 补可选字段；③ §4.3 战报示例含 `confidence` 但 `ZeusReport` 类型与 loom/pr-helper 三处实现均无（验收 #3 不含它）→ 示例对齐并注明非 v1 契约。**核对一致**：roster 字段映射与双视图裁剪、SSE 帧（`data:{jsonrpc,id,result:event|task}`）、出站 sendSubscribe 请求形态与 data.skill/runId 透传、战报四字段、defaultTaskUrl 三条路径、Realm resources/root 剥离/只读、HTTP H0 零依赖。**有意缺口（登记）**：~~Task.history（消费端宽松兼容）、file/URI artifact part、ackSeconds 强制计时~~ 三项已于 2026-09-21 下午批次补齐（见 Active work 9）；仍不修：backpressure（deferred #9）。
   - ~~测试覆盖矩阵补缺（第一批）~~ ✅ 2026-09-21：registry 补版本协商拒绝、完整标准 card 形态 2 项（9→11）；新增 tests/digest.test.ts 4 项（digestManifest 顺序无关、路径/内容敏感、Buffer/string 一致、sha256 已知向量）。全量 52→58 项绿、tsc 干净。oversight cancel 失败保持 pending、数据二极管、脱敏、吊销阻断、public 裁剪等不变量经核对已有测试覆盖。
   - ~~Zeus↔loom 契约兼容性测试~~ ✅ 2026-09-21：`tests/loom-contract.test.ts` 6 项（mock HTTP，fixture 照抄 loom 真实实现；真机端到端仍待 loom 环境）。
   - ~~验收 #6 标准客户端真机脚本~~ ✅ 2026-09-21：`scripts/acceptance-standard-a2a.mjs`（零依赖、纯标准 A2A、不认 x-zeus-*）+ `tests/acceptance-script.test.ts` 3 项 mock 自测；真机执行待 pr-helper 部署。
   - ~~签名链 v1 纯函数~~ ✅ 2026-09-21：`src/registry/signing.ts` + `src/util/crypto.ts`（sha256Hex 提升为公共 util，realm/digest re-export 保持兼容）+ `tests/signing.test.ts` 19 项（JCS 子集向量 + §8.1 八条验收）；零运行时依赖（Ed25519 用 node:crypto）。R1/R2 接线与生产密钥存放未做，deferred #7 不销项。
   - ~~CI workflow~~ ✅ 2026-09-21：`.github/workflows/ci.yml`（Node 20/22 矩阵，npm ci → typecheck → test → build，零 secret）；本地按 CI 序列实跑全绿（86 项）。**GitHub 触发待授权 push**（AGENTS.md：未明确授权不 push）。

9. **HTTP H1 + 协议缺口批次（2026-09-21，纯库内闭环，不依赖部署）**：
   - ~~A1-A2 Fastify HTTP H1 三端点~~ ✅ commit 3190a11：见 Current state「HTTP H1 传输层落地」。硬约束已验证——`src/http` 之外 grep 不到 fastify；http 只用内核公共面；不挂 Realm 路由；传输层不持业务状态；进程冒烟（healthz / public 空名册封签 / internal 401↔200 / 临时钥告警 / 默认 loopback）通过。
   - ~~A3 签名链接线~~ ✅ 同 commit：public 端点每次实时投影并 `sealSnapshot`（seal maxAge 1h、attestation TTL 24h），sources 取 listAll 原始条目的 card/cardUrl；端到端离线验签 + 三类篡改（条目 / provenance cardUrl / seal.sig）拒绝 + 过期拒绝测试齐备。
   - ~~B1 ackSeconds 受理计时~~ ✅ commit 9dcf2c4：`sla-ack-breached` 审计（及时 / 超时 / 无声明三态测试）。
   - ~~B2 file/URI artifact part~~ ✅ commit a6c6a69：FilePart 类型 + `src/a2a/parts.ts` + SSE/最终快照透传测试。
   - ~~B3 Task.history 宽松兼容~~ ✅ 同 a6c6a69：可选宽松 history 原样透传 + 测试。
   - ~~C 全量验证 + 文档~~ ✅ commit 82671cc（Windows symlink 容错）与本次 docs：98 项绿、typecheck/build 过。
   - **本批有意缺口（后续版本，勿当遗漏）**：
     1. **internal roster 快照不封签**：v1 验签要求每条目都有 active attestation，而 internal 含 revoked 行；封 internal 需把 attestation 状态扩为 active|revoked（签名链 v1.1）。H1 的 internal 靠 bearer 保护。
     2. **public 信封 attestation provenance 含 cardUrl**：这是 design-fealty-signing §4.2 / §8.1-6 的硬性要求（防同名替换，篡改 cardUrl 须验签失败）；「public 不含内部端点」约束在 roster 投影条目层满足（entries 无 cardUrl/taskUrl/healthDetail，taskUrl/healthDetail 全信封都不出现）。若未来公开页要求完全无 URL，v1.1 评估改用 cardUrl digest 锚定。
     3. **RSK 生产密钥存放未做**：serve.ts 仅支持 env PEM 或临时内存钥（deferred #7 销项前置）。
     4. **H1 无写端点、无 SSE server、无静态 JSON 产物分发**（design-http-transport §6，H2/H3）；serve.ts 启动时空 registry（封臣注册属未来启动编排）。
     5. **file URI Zeus 不自动拉取**（SSRF / 本地文件边界），只呈现给驾驶员。

10. **Agent 技术方向展开（2026-09-22，纯设计，不依赖部署）**：
   - ~~记忆整理协议~~ ✅ docs/design-memory-consolidation.md v0.1（记忆分层、Event/Fact 结构、"事件可追加/事实经 Consolidator"、置信度按可靠度聚合、八条验收）。
   - ~~supervisor/subagent 理解整理~~ ✅ docs/design-supervision.md v0.1（临时控制关系、WorkOrder/Handback 契约、fan-out/DAG/分层、跨度粒度、信任校准、失败四步序、责任归属）。
   - ~~技术探索地图~~ ✅ docs/tech-exploration-map.md v0.1。**A 组 S1–S5 已裁决优先**：上下文工程、裁决/Critic、DAG 编排、终止收敛、幂等；B（S6–S10）、C（S11–S17）全部登记待触发；Jev 模型待确认（初判 S14 候选）。
   - **下一步（待点工）**：把 A 组某条落成工程切片——建议 S3 fan-out/DAG + S5 幂等（并发内核底座），或先做 S1 上下文工程。

11. ~~M2 并发决策内核第一批（E1，2026-09-22，纯库内闭环）~~ ✅：`docs/design-fan-out.md` v0.1 + `src/orchestrator/`。
   - ✅ E1.1 一层 fan-out/join：`Orchestrator` 按技能/显式名单并行派 N 个封臣（复用 Dispatcher 治理），`Promise.allSettled`、部分失败/单路超时、failed/partial/needs-driver/completed 状态判定；
   - ✅ E1.5 幂等与取消：intentId 重放零出站、`cancelIntent` 传播到全部非终态分支、父子 runId 全链贯穿（背压/并发上限仍 deferred #9）；
   - ✅ E1.2 多流合并：`mergeBranches` 带来源 vassal/taskId/runId；
   - 🚧 E1.3 规则聚合（unanimous/majority/weighted，分裂不臆断）；🚧 E1.4 冲突检测 + needs-driver 经 onConflict 回调进监督台（LLM critic/完整 DAG/进行中硬 abort/服务端 SSE 未做，见设计稿 §7）；
   - 26 项新测试（primitives 13 + orchestrator 13），全量 124 绿、typecheck/build 过，已从 `src/index.ts` 导出。**下一步候选**：S3 完整 DAG、S2 裁决（需模型）、E2 Skill 注册中心（F7）。

12. **决策后端抽象层（Decision Backend，2026-09-22，纯设计）** ✅ `docs/design-decision-backend.md` v0.2：
   - **调研核实**（联网多源交叉，含 LangChain 官方博客/Cloudflare/36氪）：Jev = TypeSafe AI "System One" 决策模型——不生成文本，输入 state + 类型化问题，输出 Choice/Score/Noul（带概率 + 置信度，RLCD 校准）；输入 $0.042/M token、输出免费、延迟 70–500ms；**角色判定：可接入外部决策能力，非驱动模型、非封臣模型**。
   - **设计（模型无关，v0.2）**：内核新增可替换"决策后端"抽象端口 `DecisionBackend`（noul/choice/score 三方法），**与具体模型解耦**——两类实现家族：① 专用决策模型（Jev 首个实现，System 1 快层）；② 传统 LLM（prompt + 结构化输出适配，System 2 慢层，置信度 `calibrated:false` 约定）。`DecisionBackendKind`/`model` 入审计。四接线位——① E1.3 规则无解时仲裁（高置信采纳、低置信仍 needs-driver）；② 监督台 triage（升级噪音过滤，建议非裁决）；③ 派发 guardrail（Noul 校验，默认关闭逐 skill 开启）；④ S14 异构调度评分（只给语义不给策略）。多后端可并存（快/慢层），resolveBackend 选择维度随 S14。
   - **硬线**：内核不 import 外部 SDK；纯函数规则是底座、无后端 = 现状；state 最小化 + enterprise 域默认不出域 + 每次调用审计（DecisionTrace 含 backend/model，沿 runId 回放）；本地/开源后端可经同一端口接入（APUS 复现候选）。
   - 同步：tech-exploration-map 升 v0.3（S14 ✅、D 节销项）。**下一步候选**：把端口落成工程切片（src/decision/types.ts + decision-model.ts(Jev) + llm.ts + 降级测试，双 kind 验收）。

## Project documents

📚 **文档地图（按场景怎么读）**：[docs/README.md](docs/README.md)。以下为完整清单的单一事实源：

* [docs/tech-exploration-map.md](docs/tech-exploration-map.md) — Agent 技术探索地图 v0.2：A 组五条优先（已裁决）、B/C 议题登记、S14 Jev 已落设计（快决策层） ★
* [docs/design-memory-consolidation.md](docs/design-memory-consolidation.md) — 记忆整理协议 v0.1：记忆分层、Event/Fact 结构、整理流水线、置信度聚合、八条验收 ★
* [docs/design-supervision.md](docs/design-supervision.md) — Supervisor/Subagent 控制模型 v0.1：临时控制关系、契约结构、编排跨度、信任校准与失败/责任 ★
* [docs/design-fan-out.md](docs/design-fan-out.md) — 并发决策内核 v0.1（PRD E1）：fan-out/join、intentId 幂等、cancel 传播、多流合并、规则聚合、冲突升级、边界 ★
* [docs/design-decision-backend.md](docs/design-decision-backend.md) — 决策后端抽象层 v0.2（模型无关）：DecisionBackend 端口（noul/choice/score）、两类实现家族（专用决策模型 Jev / 传统 LLM 适配）、四接线位、选择与降级、数据主权硬线 ★
* [docs/research-decision-layer-industry.md](docs/research-decision-layer-industry.md) — 决策层行业现状调研 v0.1（2026-09）：LLM-as-judge 主流 + 四条分化路线（专用决策模型/程序化裁决/混合路由/多模型分职）、对 design-decision-backend v0.2 的印证、来源清单
* [docs/prd.md](docs/prd.md) — 产品需求文档 v0.1：9 个 Epic、~40 条需求（优先级/状态/验收标准）、里程碑与成功指标 ★
* [docs/product-portrait.md](docs/product-portrait.md) — 产品画像活文档：定位、设计哲学（目录底座/藏宝图/MCP·Skill·A2A）、个人与企业双态画像、分层架构、封臣式产品矩阵、路线图；文末演进日志 ★
* [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议设计（A2A 超集 v0.1）：fealty 契约 / intake / report-back / escalation / 治理 / 星型拓扑 / pr-helper 六项验收清单 ★
* [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.1（D1）：目录即数据库、connect/search/read/write、数据二极管执行点、藏宝图依赖 ★
* [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造 v0.1：单一事实源在封臣、字段映射、内外双视图裁剪、签名链公开闸门、R0–R2 阶段 ★
* [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — fealty 签名链设计 v0.1（deferred #7）：威胁模型、Zeus 单签 v1/封臣自签 v2、Ed25519+JCS、两层签名信封、RSK 密钥与轮换、吊销四层失效、v1 八条验收 ★
* [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型 v0.1：网络面划分、Fastify+长驻 Node 裁决、薄传输层单向依赖、H1–H3 端点规划与验收 ★
* 代码：`src/index.ts`（公共 API 聚合入口，构建产物 `dist/`）、`src/registry/registry.ts`（A1 封臣注册中心：卡片拉取注册/fealty 校验含版本协商/健康探针/吊销/listAll 全量视图/asVassalLookup 实时目录）、`src/registry/roster.ts`（名册投影器：internal/public RosterSnapshot）、`src/registry/signing.ts`（fealty 签名链 v1 纯函数：JCS 规范化、attestation/seal、Ed25519 内存签名器）、`src/util/crypto.ts`（sha256Hex 公共哈希）、`src/a2a/types.ts`（A2A 协议类型：Task/Artifact/Part 含 FilePart/事件/AgentCard/Fealty）与 `src/a2a/parts.ts`（isFilePart/artifactFileUris）、`src/http/`（Fastify H1 薄传输层：`server.ts` 三端点 + 签名接线、`serve.ts` 进程入口；全仓库唯一 import fastify 处，`./http` 子路径导出）、`src/dispatch/`（A2A 派发器：JSON-RPC + SSE 客户端、数据二极管与脱敏、吊销阻断、sla.ackSeconds 受理计时、审计 sink + 吊销审计桥）、`src/oversight/`（A4 监督台：升级请求队列 + approve/reject）、`src/orchestrator/`（E1 并发内核：Orchestrator fan-out/幂等/cancel、merge/aggregate/conflict 纯函数）、`src/realm/`（D1 Realm P0：FsRealmStore 只读 personal 数据域、扫描检索、contentDigest、路径穿越防护；`mcp.ts`/`mcp-stdio.ts` 只读 MCP stdio 脚手架）、`scripts/acceptance-standard-a2a.mjs`（验收 #6 纯标准客户端）、`.github/workflows/ci.yml`（CI）、`tests/`（124 项，16 个测试文件）
* [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（开放问题与挂起项 + 触发条件的单一事实源）
* [AGENTS.md](AGENTS.md) — AI 协作规范与文档分层约定
* [git-commit-message.md](git-commit-message.md) — commit message 规范

## Recent changes

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 产品画像 v0.1 初稿；按 agent-world 惯例建立项目文档骨架 |
| 2026-09-21 | 封臣协议拍板为 A2A 超集；design-vassal-protocol.md v0.1 完成（fealty/intake/report-back/escalation/治理/星型拓扑/pr-helper 验收清单） |
| 2026-09-21 | Zeus 代码动工：A1 注册中心 + A2 派发器（15 项单测）；D1 Realm 接口契约 v0.1 定稿；loom 封臣草案已交 loom 侧待裁决 |
| 2026-09-21 | loom 第二封臣裁决并落地第一阶段（loom Q150，plan 模式三 skills + JSON-RPC/SSE + Q88 Key + 审计，22 项测试绿）；Zeus 仓库推 GitHub private |
| 2026-09-21 | A4 监督台最小版落地（OversightDesk：input-required 升级队列、approve/reject、reject 联动 cancel、审计）；registry 补 listAll 全量视图；zeus 全量 24 项测试绿 |
| 2026-09-21 | pr-helper 验收 #5 销项：registry 实时目录 asVassalLookup + onRevoke 钩子，dispatcher 派发前阻断已吊销封臣（不发请求/不发 token），revokeAuditBridge 治理事件入审计；端到端治理闭环测试；全量 29 项测试绿（commit c1a0b27） |
| 2026-09-21 | bayjf 封神榜设计 v0.1（design-bayjf-roster.md）；R0 名册投影器落地（internal/public 双快照，确定性排序，JSON 可序列化）；全量 32 项测试绿（commit dadbe7b） |
| 2026-09-21 | Realm 开放问题拍板（契约 v0.2：对外唯一 MCP 传输、P0 扫描检索 + 可替换后端，升级阈值入 deferred #10；commit f2223f8） |
| 2026-09-21 | Realm P0 落地（src/realm/：只读 personal 数据域，connect/manifest/search/read，确定性 realmId 与幂等 connect、扫描纪律、read 路径穿越双检、快照检索/实时读分离；8 项测试，全量 40 项绿，commit 3bd6d51） |
| 2026-09-21 | 库公共入口与构建链：src/index.ts 聚合六模块公共面（23 个运行时导出）、tsconfig.build.json 出 dist（.js/.d.ts/sourcemap）、package.json main/types/exports/files + build 脚本；产物冒烟通过，40 项测试绿、tsc 干净 |
| 2026-09-21 | 补写根目录 README.md（仓库入口：定位、六模块、快速开始与 Realm 示例、当前边界、文档导航） |
| 2026-09-21 | fealty 签名链设计草案 v0.1（design-fealty-signing.md）：v1 Zeus 单签（Ed25519+JCS，条目 attestation+快照 seal，TTL 硬过期）、v2 封臣自签超集；deferred #7 设计完成，实现随 R1/R2 销项 |
| 2026-09-21 | HTTP 传输层选型拍板（design-http-transport.md）：Fastify+长驻 Node、薄适配层、Realm 不挂 HTTP；H1 三端点随 roster R1，H2 驾驶员 API 待持久化；H0 不装依赖 |
| 2026-09-21 | Realm 只读 MCP stdio 脚手架（src/realm/mcp.ts + mcp-stdio.ts）：零新依赖，resources 映射 manifest/search/read，宿主预连接、协议不暴露 connect、root 不出进程；12 项协议测试 + 真实子进程冒烟，全量 52 项绿、tsc 干净；非正式 P1 启动 |
| 2026-09-21 | 契约⇄代码一致性审计（对照 loom/pr-helper 真实实现）：修 3 处漂移——fealty.version 版本协商落地（不支持版本拒绝注册）、AgentCard 补 defaultInputModes/defaultOutputModes/provider 标准字段、战报示例去 confidence；补缺测试 6 项，全量 58 项绿 |
| 2026-09-21 | Zeus↔loom 契约兼容性测试（tests/loom-contract.test.ts，6 项，fixture 照抄 loom card/skills/rpc/router）；验收 #6 纯标准 A2A 客户端脚本（scripts/，3 项 mock 自测，真机待部署），全量 67 项绿 |
| 2026-09-21 | fealty 签名链 v1 纯函数（src/registry/signing.ts：JCS 子集 + Ed25519 两层信封 + 离线验签/过期/轮换，19 项测试覆盖设计稿八条验收；sha256Hex 提升 src/util/crypto.ts），全量 86 项绿、tsc/build 干净（commit 021bc20） |
| 2026-09-21 | GitHub Actions CI 落地（.github/workflows/ci.yml，Node 20/22：npm ci/typecheck/test/build，零 secret）；本地按 CI 序列实跑全绿，push 后触发（commit fc522b7，未 push） |
| 2026-09-21 | HTTP H1 传输层（src/http，Fastify 5）：healthz / public 实时投影+seal 签名快照（离线可验、Cache-Control 对齐 TTL）/ internal bearer（未配 token 不挂载）；./http 导出 + npm start + serve.ts env 装配；7 项 inject 测试，内核零 fastify（commit 3190a11） |
| 2026-09-21 | sla.ackSeconds 受理计时：首个 SSE 事件为受理信号，超时审计 sla-ack-breached、不阻断任务，注入式单调时钟，及时/超时/无声明三态测试（commit 9dcf2c4） |
| 2026-09-21 | A2A 协议缺口：Artifact 增 FilePart（URI 引用，Zeus 不抓取）+ src/a2a/parts.ts；Task 增宽松 history 透传；2 项测试（commit a6c6a69） |
| 2026-09-21 | Realm 测试 Windows 容错（无 symlink 权限时夹具降级、专属断言条件化）；全量 98 项绿、typecheck/build 过（commit 82671cc）。此前工作已经 PR #1/#2 合入 origin/main，本批 4 commit 在 dev 待 push |
| 2026-09-22 | M2 并发决策内核第一批（design-fan-out.md + src/orchestrator/）：fan-out/join、intentId 幂等、cancel 传播、多流合并、规则聚合、冲突升级监督台；E1.2 库内完成，E1.1/1.3/1.4/1.5/1.6 部分落地；26 项新测试，全量 124 绿、typecheck/build 过 |
| 2026-09-22 | Jev 模型核实并落设计（design-decision-backend.md v0.1）：调研定案 Jev = TypeSafe System One 决策模型（可接入外部能力，非驱动/非封臣）；快决策层 DecisionBackend 端口（noul/choice/score）+ Jev 首个实现 + 四接线位 + 数据主权硬线；tech-exploration-map 升 v0.2（S14 ✅、D 节销项） |
| 2026-09-22 | 决策后端抽象层升级为**模型无关**（design-decision-backend.md v0.2）：DecisionBackendKind=decision-model/llm；Jev 为专用决策模型家族首个实现（快层），传统 LLM 经 prompt+结构化输出适配同端口接入（慢层，置信度校准约定）；新增选择与降级（多后端并存）；tech-exploration-map 升 v0.3 |
| 2026-09-22 | 决策层行业现状调研入库（research-decision-layer-industry.md v0.1）：LLM-as-judge 主流 + 四条分化路线（专用决策模型 Jev / 程序化裁决 PAJAMA / 混合路由 / 多模型分职）+ 对决策后端设计 v0.2 的印证；18 条来源清单 |
