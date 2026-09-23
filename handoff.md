# Handoff

State of Zeus as of 2026-09-22.

> Zeus 处于「核心内核成型 + 产品化缺口收窄」阶段：A1 注册中心、A2 派发器、A4 监督台、**E1 并发决策内核（fan-out/幂等/cancel/合并/规则聚合/冲突升级/S2 后端仲裁）**、D1 Realm P0、fealty 签名链 v1 纯函数、HTTP H1（Fastify）+ **H2 驾驶员 API（意图扇出/回查/取消、升级队列拍板决议回写、指标）**、**Vault 藏宝图与恢复协议（E8.1/E8.2：原地校验 + 加密备份包跨位恢复）**已落地（纯 TS 库 + vitest，**310 项测试绿 / 42 个测试文件，typecheck/build 过**）。**2026-09-22 MVP 评审后三批次库内落地**：六切片（E2.2 Skill 注册中心、模型无关决策后端、E6.2 决议闭环、E1.7 指标、S3 DAG、E5.3 落盘）、T1–T4 产品化收口（E5.3 启动装配、Docker 部署形态 + docs/deployment.md、生产 RSK 守卫与密钥脚本、S2 critic 接 E1.3 仲裁）、**T5 H2 驾驶员 API（把内核能力首次暴露成人可调用的服务）**；评审硬阻塞（部署形态、生产 RSK、Skill 注册、决议回写、持久化）已库内销项，真机验收/联调/push 在仓库外。当前在 `dev`（领先 `origin/dev` 一批 commit 未 push，push 需授权）。本文件记录项目当前状态、活跃任务与文档索引。

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
- **MVP 评审后六切片批次（2026-09-22，纯库内闭环，全量 166 绿 / 22 文件）**：
  - **E2.2 Skill 注册中心**（`src/skills/`，commit f46eff9，10 测试）：SkillRegistry id+version 唯一键、多版本共存、get 默认最新 active（显式版本可查 deprecated 供审计）、deprecate 标记不删、findByDomain/Tag、registerFromCard 把卡片 skills 登记为 catalogue 版本、resolveTeam 多技能组队（missing/ambiguous/complete，多候选标 ambiguous 绝不静默随机选）。
  - **模型无关决策后端**（`src/decision/`，commit 81dc347，9 测试）：严格按 design-decision-backend v0.2——窄端口 DecisionBackend（noul/choice/score，Result 含 calibrated）、prepareState 数据主权守卫（enterprise 默认拒、stateKeys 白名单、redact）、createJevBackend（POST /decide，多 envelope 容忍，输入计费/超时 1500ms）、createLlmBackend（OpenAI 兼容 /chat/completions + json_object，calibrated:false）、arbitrateSplit（阈值/未校准不采纳/降级 needs-driver）。**诚实限制：Jev 真实 endpoint 路径与响应 envelope 无 key 未真机验证，代码注释标注待核对，全用注入 fetch mock 测试。**
  - **E6.2 决议反馈闭环**（commit c2c4b35，6 测试）：Escalation 分 kind（task-input/intent-conflict）；OversightDesk.ingestConflict/decideConflict（按 intentId 幂等、立场校验、intent-conflict 的 reject 不误取消单任务）；conflictsToDesk 装配助手；纯函数 applyConflictResolution 回写聚合（清冲突/重算状态/记 driverResolution）；Orchestrator.resolveIntent + resumeBranch（E6.3 补参重派骨架：单分支带合并参数重派、整意图重算）。
  - **E1.7 库内并发指标**（`src/orchestrator/metrics.ts`，commit e54b4ea，5 测试）：ConcurrencyMetrics 在途数/并发峰值/队列深度/完成失败超时计数/各封臣延迟 min·max·avg·p50·p95/失败率，Orchestrator 可选注入（无 metrics 时 no-op），resumeBranch 也计数；队列深度在当前无界 Promise.all 下恒 0（背压归 deferred #9）；无 HTTP 端点（随 H2）。
  - **S3 完整 DAG 编排**（`src/orchestrator/dag.ts` + `dag-runner.ts`，commit b9134e5，6 测试）：纯图函数 validateDag（环/重复 id/未知依赖校验）/topologicalLayers/criticalPath；DagRunner 按拓扑波次执行、同波并行、每节点复用一次 Orchestrator fan-out（聚合/冲突/取消/指标不重写）、上游未完成则下游 skipped 而独立分支继续、needs-driver 冒泡、resolveParams 把上游产物下传；进程内存态，不绕过 Dispatcher，监督台仍经 onConflict 注入。
  - **E5.3 内核状态持久化最小版**（`src/state/kernel-state.ts`，commit 79bac99，6 测试）：VassalRegistry/OversightDesk/Orchestrator 各加 exportState/importState；FileKernelStateStore 单 JSON 原子写（tmp+rename）+ 版本/结构校验；collectKernelState/applyKernelState 一键快照/恢复。重启保留：封臣（含已吊销）、升级队列（重建 task/conflict 幂等索引）、意图结果+原始请求（fanOut 幂等重放零出站、resumeBranch 可用）。**未做：Realm 连接状态未纳入、文件存储未接入进程启动装配/H2、Dispatcher 无状态无需持久化、metrics 运行态不持久化。**
  - **测试稳定性修复**：acceptance-script 子进程套件超时 5s→20s（commit 37c65bd）；orchestrator 并行 fan-out 的墙钟断言（<28ms）在高负载 CI 抖动，改为以"两分支同 tick 窗口启动"确定性证明并行（commit 4b615e6）。连跑两次全量 166/166 稳定。
- **MVP 评审后 T1–T4 产品化收口批次（2026-09-22，纯库内闭环，全量 187 绿 / 25 文件，详见 Active work 15）**：
  - **T1 E5.3 启动装配**（commit fdb2663，4 测试）：`src/state/boot.ts` `bootKernel()` 一次装配四组件（onConflict 桥接监督台、dispatchAudit JSONL），`ZEUS_STATE_FILE` 启动恢复 + SIGINT/SIGTERM 原子落盘。
  - **T3 生产 RSK 硬化**（commit 4d99f43，9 测试）：`src/http/rsk.ts` 支持内联 PEM / `ZEUS_RSK_KEY_FILE`，production 无密钥拒启；`scripts/gen-rsk-key.mjs` 零依赖跨平台密钥生成。
  - **T2 部署形态**（commit 34ad658，真机 docker 验证）：多阶段 Dockerfile（node:22-slim/非 root/健康检查/状态卷）、.dockerignore、.env.example、docs/deployment.md。
  - **T4 S2 critic 仲裁**（commit d0ecc85，8 测试）：`src/orchestrator/arbitration.ts` 规则无解时经决策后端闸门仲裁，fanOut/resumeBranch 双路径，未过闸仍升级驾驶员。

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
   - 26 项新测试（primitives 13 + orchestrator 13），全量 124 绿、typecheck/build 过，已从 src/index.ts 导出。~~下一步候选：S3 完整 DAG、S2 裁决、E2 Skill 注册中心~~ → 均已在 Active work 13 六切片批次落地（S3 DAG、决策后端、E2.2）。

12. **决策后端抽象层（Decision Backend，2026-09-22，纯设计）** ✅ `docs/design-decision-backend.md` v0.2：
   - **调研核实**（联网多源交叉，含 LangChain 官方博客/Cloudflare/36氪）：Jev = TypeSafe AI "System One" 决策模型——不生成文本，输入 state + 类型化问题，输出 Choice/Score/Noul（带概率 + 置信度，RLCD 校准）；输入 $0.042/M token、输出免费、延迟 70–500ms；**角色判定：可接入外部决策能力，非驱动模型、非封臣模型**。
   - **设计（模型无关，v0.2）**：内核新增可替换"决策后端"抽象端口 `DecisionBackend`（noul/choice/score 三方法），**与具体模型解耦**——两类实现家族：① 专用决策模型（Jev 首个实现，System 1 快层）；② 传统 LLM（prompt + 结构化输出适配，System 2 慢层，置信度 `calibrated:false` 约定）。`DecisionBackendKind`/`model` 入审计。四接线位——① E1.3 规则无解时仲裁（高置信采纳、低置信仍 needs-driver）；② 监督台 triage（升级噪音过滤，建议非裁决）；③ 派发 guardrail（Noul 校验，默认关闭逐 skill 开启）；④ S14 异构调度评分（只给语义不给策略）。多后端可并存（快/慢层），resolveBackend 选择维度随 S14。
   - **硬线**：内核不 import 外部 SDK；纯函数规则是底座、无后端 = 现状；state 最小化 + enterprise 域默认不出域 + 每次调用审计（DecisionTrace 含 backend/model，沿 runId 回放）；本地/开源后端可经同一端口接入（APUS 复现候选）。
   - 同步：tech-exploration-map 升 v0.3（S14 ✅、D 节销项）。**下一步候选**：把端口落成工程切片（src/decision/types.ts + decision-model.ts(Jev) + llm.ts + 降级测试，双 kind 验收）。

13. **MVP 评审后六切片批次（2026-09-22，纯库内可闭环，全部 ✅，详见 Current state 末条）**：
   - ✅ **E2.2 Skill 注册中心**（src/skills，f46eff9，10 测试）；顺带满足 E2.4 多技能组队/歧义不静默选边。
   - ✅ **决策后端工程切片**（src/decision，81dc347，9 测试）：design-decision-backend v0.2 落地，模型无关端口 + Jev/LLM 双适配器 + 降级；真机 envelope 待 key 核对（限制已在代码注释与评审报告标注）。
   - ✅ **E6.2 冲突决议反馈闭环**（c2c4b35，6 测试）：冲突入监督台→decideConflict→回写聚合；E6.3 补参重派骨架 resumeBranch 落地（自动装配随 H2，E6.3 仍 🚧）。
   - ✅ **E1.7 库内并发指标**（e54b4ea，5 测试）：在途/峰值/队列深度/延迟分位/失败率；HTTP 端点随 H2（E1.7 PRD 状态 🚧）。
   - ✅ **S3 完整 DAG 编排**（b9134e5，6 测试）：拓扑分层/关键路径/部分失败跳过/上游产物下传。
   - ✅ **E5.3 持久化最小版**（79bac99，6 测试）：registry/升级队列/意图幂等表原子落盘恢复；**Realm 连接态与启动装配/H2 接线未做（E5.3 仍 🚧）**。
   - ✅ 测试去抖两处（37c65bd / 4b615e6）；全量 166 绿 / 22 文件，typecheck/build 过，连跑两次稳定。
   - **评审结论更新**：硬阻塞 E2.2/E6.2 销项，E5.3/E1.7 大幅缓解；**产品级可上线 MVP 仍未达成**——剩余硬阻塞=部署形态、生产 RSK 密钥；软阻塞=真机验收/联调、push+CI 首绿（需授权）；外加 E5.3 启动接线、E10.4 容量压测。见 review-mvp-2026-09.md 顶部 v0.2 销项批注。
   - **下一步候选（库内仍可闭环）**：① E5.3 启动装配接线（进程启动 load→恢复、退出/变更时 save，长驻形态前置）；② H2 驾驶员 API（把 metrics/持久化/决议/重派接到 HTTP，design-http-transport 已规划）；③ S2 critic 把决策后端接到 E1.3 规则无解仲裁；④ 部署形态（Dockerfile + env 装配，硬阻塞 #1）。真机/压测/push 类需部署或授权，不在库内闭环范围。

14. **项目级 MVP 复评 + 可推进任务清单（2026-09-22，独立实跑复评）** ✅ 评审完成（结论与证据见 review-mvp-2026-09.md v0.2 之上；待办升格为 Active work 15）：
   - 独立实跑证据（非转述）：HEAD `6011619`（dev 领先 origin/dev **9 commit** 未 push，工作树干净）；vitest **166/166 绿（22 文件）**；typecheck ✅、build ✅（dist/ 完整含 .d.ts）；**新增进程级 HTTP 冒烟**（补 review §7 限制①，原仅 inject 测试）：真实进程下 `/healthz` 200、`/api/roster/public` 返回 Ed25519 seal（keyId `zeus-rsk-dev`）、internal 无 token 401 / 带 token 200、serve log 复现「ZEUS_RSK_KEY not set → 临时内存钥」告警；冒烟后端口已清理。
   - 判定（与 review-mvp-2026-09.md v0.2 一致）：**库内内核级 MVP ✅ 达成**（M1 全部 + M2 核心，闭环库内可走通）；**产品级可上线 MVP ❌ 未达成**——硬阻塞：部署形态（无 Dockerfile/服务管理）、生产 RSK（env PEM 已支持但无生产强制与轮换，serve.js 无钥仍降级临时钥）；软阻塞：真机验收 #6 / Zeus↔loom 联调、push+CI 首绿（需授权）、E5.3 启动接线、E10.4 容量压测。

15. **可一口气推进（库内闭环、无需部署/授权；T1–T4 一批 ✅ 2026-09-22 全部完成，T5 第二批）**：
   - [x] **T1 E5.3 启动装配接线** ✅ 2026-09-22（commit fdb2663）：新增 `src/state/boot.ts` `bootKernel()`——一次装配 registry/oversight/dispatcher/orchestrator（onConflict 已桥接监督台），`ZEUS_STATE_FILE` 存在时启动 load/applyKernelState 恢复、SIGINT/SIGTERM drain 时原子 save，无 stateFile 保持纯内存现状；serve.js 接入并打印恢复计数（vassals/escalations/intents）。4 项 boot 测试（tests/kernel-boot.test.ts），全量 170 绿；真实进程冒烟：首启落盘→SIGTERM saved→二启 restored→退出再 saved。
   - [x] **T2 部署形态** ✅ 2026-09-22：`Dockerfile`（多阶段 node:22-slim，builder 编译 / runner 仅生产依赖，非 root uid 1000，node fetch 健康检查，/data 卷，node 作 PID 1 直接收 SIGTERM 优雅落盘）+ `.dockerignore` + `.env.example` + `docs/deployment.md`（Docker/compose/systemd、env 表、RSK 密钥与轮换、卷权限、上线检查清单）；密钥脚本改为零依赖跨平台 `scripts/gen-rsk-key.mjs`（替代 sh，容器内可跑）。**真机 docker build/run 全链路验证**：容器内生成密钥、production 无 key exit 1、挂密钥卷启动 healthz/public(seal keyId)/internal 401/健康检查 exit 0、`docker stop` SIGTERM 落盘到卷、重启 restored。
   - [x] **T3 生产 RSK 硬化** ✅ 2026-09-22（commit 4d99f43）：新增 `src/http/rsk.ts` `loadRskSigner()`——解析顺序 ZEUS_RSK_KEY（内联 PEM）→ ZEUS_RSK_KEY_FILE（secret 挂载）→ 都无则 `NODE_ENV=production` 抛 RskConfigError 拒启（exit 1）、其余环境降级临时钥并告警；显式校验 Ed25519（RSA/坏 PEM 均拒）。新增 `scripts/gen-rsk-key.sh`（openssl Ed25519 密钥对，私钥 0600/公钥 0644，拒绝覆盖；**T2 中已替换为零依赖跨平台 `scripts/gen-rsk-key.mjs`**）。9 项测试（tests/rsk-loader.test.ts），全量 179 绿；进程冒烟：production 无 key exit 1、key 文件启动 seal.keyId 正确且无临时钥告警、脚本公钥离线验签 true、SIGTERM 正常落盘。
   - [x] **T4 S2 critic 接 E1.3 仲裁** ✅ 2026-09-22（commit d0ecc85）：新增纯函数 `src/orchestrator/arbitration.ts` `arbitrateConflict()`——规则无解（needs-driver）时按 arbitrateSplit 同款闸门请决策后端仲裁一次：calibrated 且置信 ≥0.8 则回写 conclusion/margin、清冲突、状态重算为 completed/partial，原始 positions 保留可审计；低置信/未校准 LLM 未显式放行/后端故障一律保持 needs-driver 并记录 `backendArbitration`（含 error/confidence/backend/model/decidedAt）。Orchestrator options 增 decisionBackend/arbitrationThreshold/allowUncalibratedArbitration/arbitrationMaxWaitMs，fanOut 与 resumeBranch 同路径接线，onConflict 仅仲裁后仍 needs-driver 才触发；无 backend = 现状不变。8 项测试（tests/orchestrator-arbitration.test.ts），全量 187 绿。**边界：进程装配（serve.ts 配 Jev/LLM key 启用后端）未做，需部署期 env/密钥配置；库能力已就绪。**
   - [x] **T5 H2 驾驶员 API** ✅ 2026-09-22（本批，纯库内闭环，全量 199 绿 / 26 文件）：`src/http/server.ts` 在 H1 之上新增 bearer 保护的内部驾驶员面（未配 `ZEUS_INTERNAL_TOKEN` 整组不挂载，与 internal roster 同一安全默认）——`POST /api/intents`（fanOut，body 校验 skill/realm/vassals/aggregation/timeout）、`GET /api/intents/:id`、`POST /api/intents/:id/cancel`、`GET /api/escalations`（可按 status 过滤）、`POST /api/escalations/:id/approve|reject`（task-input）、`POST /api/escalations/:id/resolve`（intent-conflict：decideConflict + Orchestrator.resolveIntent 把拍板立场回写聚合决策，打通 E6.2 HTTP 闭环）、`GET /api/metrics`（ConcurrencyMetrics 快照）。错误映射 unknown→404 / 已决议·状态不符→409 / 非法入参·非法立场→400。`bootKernel` 增配 ConcurrencyMetrics 并随 orchestrator 装配、经 KernelBoot 返回（metrics 不持久化）；`serve.ts` 把 orchestrator/oversight/metrics 传入 createHttpServer。**修复一个被端到端测试暴露的内核缺口**：原 fanOut 仅在客户端显式传 intentId 时才把意图存入幂等表，服务端生成 id 的意图（H2 POST 常态）无法 GET 回查/resolve——改为所有 fanOut 一律按最终 intentId 落表（重放仍只由 request.intentId 触发，"不传 id 每次新派单"语义不变，幂等测试照绿）。12 项端到端测试 tests/http-h2.test.ts（鉴权矩阵、happy path、冲突→升级→拍板→回写全链路、幂等、cancel、metrics、404/400/409、task-input approve）+ 真实进程冒烟（healthz/401/200/400/metrics/escalations）。README 模块表与 H2 用法、PRD E5.5/E1.7/E5.3/E6.3 同步。**仍未做**：H3 服务端 SSE 合并流、resumeBranch 的"approve 一键补参重派"HTTP 端点（E6.3 剩尾）、serve 起空 registry 的封臣启动注册编排。
   - **批次收尾（2026-09-22）**：T1–T4 全部库内落地（fdb2663 / 4d99f43 / 34ad658(+docs 8bc7efd) / d0ecc85），全量 **187 绿 / 25 文件**，typecheck/build 过，Docker 真机全链路验证。**评审两条硬阻塞（部署形态、生产 RSK）已库内销项**；产品级 MVP 剩余关口全部在仓库外：真机验收 #6、Zeus↔loom 联调、push+CI 首绿（需授权）、E10.4 压测基线；T5（H2 驾驶员 API）为下一批库内候选。
   - **需用户参与（本机不可闭环）**：真机验收 #6（pr-helper 部署 Vercel）、Zeus↔loom 联调（loom 起测试环境）、push dev→CI 首绿（需授权）、E10.4 容量压测（T2 之后本机基线）。

16. **A 批次：四个 MVP 缺口一口气收口（2026-09-22 ✅ 全部完成，全量 217 绿 / 31 文件，tsc 过）**：
   - [x] **A1 G1 封臣上线入口** ✅ commit a315ff1：`POST /api/vassals`（拉 card + fealty/版本校验注册，卡片不可达 502、坏卡片/无 fealty 400）、`DELETE /api/vassals/:name`（吊销，未知/已吊销 404）；`bootKernel` 增 `vassalSeeds`，`ZEUS_VASSAL_SEEDS` 启动自动注册，已在快照中的 cardUrl 跳过不重拉。7 项测试 tests/http-vassals.test.ts。
   - [x] **A2 G4 Realm 连接持久化** ✅ commit 47de505：KernelSnapshot 增可选 `realms: RealmConnection[]`（root/realmId/type/readOnly，向后兼容）；RealmStore 接口与 FsRealmStore 增 `connections()`；`bootKernel` 装配 FsRealmStore，重启 reconnect 快照域并连接 `ZEUS_REALM_ROOTS`，持久化 root 不可达 fail-loud 拒启。2 项测试 tests/kernel-realm-state.test.ts。
   - [x] **A3 G6 E6.3 一键补参重派** ✅ commit b4c32e6：`POST /api/escalations/:id/approve-resume` 携带 params，approve 后经新增 `Orchestrator.findIntentForBranchRun`（按分支 runId 匹配）定位意图、自动 resumeBranch 重派重算。4 项测试 tests/http-approve-resume.test.ts。
   - [x] **A4 G5 H3 服务端 SSE** ✅ commit e9002e3：新增 `src/orchestrator/progress.ts`（ProgressEvent + ProgressHub），编排器在分支 start/end 与意图完成时发事件；`GET /api/intents/:id/events` 输出 SSE（15s keepalive、已完成意图回放单事件后关闭、无 hub 未知意图 404、hijack 后 flushHeaders 保证即时响应）。5 项测试 tests/progress-hub.test.ts + tests/http-sse.test.ts（含真机端口实时流）。
   - **评审更新**：见 review-mvp-2026-09.md v0.3 与 PRD v0.6（E5.3/E5.5/E6.3 升 ✅）。**产品级可上线 MVP 仍判定未达成，但库内已无任务可闭环**——剩余关口全在仓库外/需授权：E4.8 真机验收、Zeus↔loom 联调、push+CI 首绿（需授权）、E10.4 容量压测、Jev 真实 endpoint/key 核对。

17. **E2.1 Skill 显式规格与注册（2026-09-22 ✅ 完成，全量 229 绿 / 33 文件，tsc 过）**：
   - SkillSpec 独立于 Agent Card：id/name/`version`（major.minor.patch 数值）/inputs/outputs 对象 schema/permissions（**封闭 scope 词汇** realm·execute·network·credential·mcp，`scope` 或 `scope:action`）/dependencies。
   - 新增 `src/skills/validate-spec.ts`（纯函数 `validateSkillSpecShape`，一次收集全部问题抛 SkillValidationError）；`SkillRegistry.register` 强制形状校验 + 依赖须为已注册 skill（拒前向引用）、拒自依赖、id 级依赖图 DFS 拒绝依赖环。
   - SkillRegistry 接入 `bootKernel`：构造后经 VassalRegistry 新增的 `onRegister` 钩子，封臣注册时自动 `registerFromCard` 导入卡片技能；SkillRegistry 增 export/importState，KernelSnapshot 增可选 `skills`，重启恢复目录。
   - 测试：10 项 tests/skills-validation.test.ts（形状/版本/权限 scope/自依赖/未知依赖/环）+ 2 项 tests/kernel-skills-state.test.ts（装配 + 快照恢复）；validateSkillSpecShape/SkillValidationError 已从 src/index.ts 导出。PRD v0.7，E2.1 升 ✅。

18. **记忆整理协议 P0 落地（2026-09-22 ✅ 完成，全量 240 绿 / 34 文件，tsc 过，commit 37a7759）**：
   - 新增 `src/memory`：`types.ts`（MemoryEvent/FactRecord/ConsolidationResult）、`consolidate.ts`（纯确定性整理）、`memory-store.ts`（事件日志 + 事实存储，按 realm 分区）。
   - **追加与修改分离**：Agent 只能 append 事件；事实无公开写入口，只经 `consolidateRealm()` 产出；每条 fact 必带 provenance（eventId 列表）。
   - 同 subject/predicate/object 的观察去重为一个 fact，provenance 累积、version 递增；矛盾 object 默认双方 `disputed` 并确定性生成 escalation，**不静默覆盖**；仅当新观察严格更晚且作者可靠度严格更高才把旧 fact 标 `superseded`。
   - 置信度按 Agent 历史可靠度（`reliability` 注入，未知默认 0.5）加权自报值；同源重复不增强，独立作者印证 +0.05/人。
   - 跨 realm read/append 拒绝并审计（MemoryBoundaryError）；`replay(realmId, runId)` 离线回放事件与 provenance 命中的事实；exportState/fromState 验证事实源可重建。design §8 八条验收逐条覆盖，11 项 tests/memory-consolidation.test.ts；PRD v0.8。
   - **P1 待做**：Fact Store 持久化（接入 KernelSnapshot）、任务收束自动触发整理、escalations 真正进 OversightDesk、可靠度从事后结果自动回写；P2：本地 embedding 混合检索、retracted/遗忘权。

19. **记忆 P1：持久化 + 自动触发（2026-09-22 ✅ 完成，全量 243 绿 / 35 文件，tsc 过，commit 66120d7）**：
   - KernelSnapshot 增可选 `memory: MemoryState`（events + 按 realm facts），bootKernel 装配 MemoryStore 并经 collect/apply/FileStore 全链路持久化，重启事件、事实、replay 完整恢复。
   - FanOutRequest/Result 增可选 `realmId`，intent-finished 事件带 runId/realmId；意图到达终态时 boot 自动 `consolidateRealm`，可靠度从 ConcurrencyMetrics perVassal failureRate 派生（1−failureRate，无记录 0.5）。
   - 新增 EscalationKind `memory-dispute`（factId/conflictingFacts 字段）与 `OversightDesk.ingestMemoryDispute`（以整理器确定性 escalation id 幂等）；自动整理出的矛盾直接进监督台。
   - `POST /api/intents` 透传 body.realmId，真实服务上自动触发可用。3 项 tests/kernel-memory-p1.test.ts（快照往返、完成即整理、矛盾升级 + 重复整理不产生重复行）；PRD v0.9。
   - **剩余**：P2 本地 embedding 混合检索、retracted/遗忘权、漂移对账。

20. **三件批次：可靠度纠错回写 + E2.3 + E7（2026-09-22 ✅ 全部完成，全量 260 绿 / 37 文件，tsc 过）**：
   - **可靠度纠错回写**（commit a2f3678）：OversightDesk 新增 onDecided 钩子（approve/reject/decideConflict 三路均触发）；boot 中 memory-dispute 被拍板后，对败诉事实的作者 `recordCorrections`；`reliabilityScore = max(0, base − 0.15×纠错数)`，corrections 随 MemoryState 持久化。
   - **E2.3 Skill 生命周期**（commit b654c3c）：install（即 active，deprecated 不可装）/ uninstall（立即出 resolveTeam 与默认查询，可重装）/ harden（权限只收窄：bare scope→scope:action，越权授予拒绝；约束 merge 叠加，随 spec 落快照）。8 项 tests/skills-lifecycle.test.ts；validatePermissionClaims 抽出复用。
   - **E7 MCP 连接器**（commit f1a082a）：`src/mcp`——McpClient 零 SDK 走 streamable-HTTP JSON-RPC（兼容 JSON/SSE 帧）、initialize 握手 + tools/resources/prompts 发现；ConnectorRegistry declare（封闭词汇边界、重复拒）/ connect（失败 refused+审计）/ revoke（即时移出活动集）；最小权限 `mcp:<tool>` 精确放行；bootKernel 装配，KernelSnapshot 增 `connectors` 段（声明持久化、连接不自动重建立）。8 项 tests/mcp-connectors.test.ts。
   - PRD v0.10，E2.3/E7 升 ✅。

21. **记忆 P2：混合检索 + 遗忘权（2026-09-22 ✅ 完成，全量 271 绿 / 38 文件，tsc 过）**：
   - 新增 `src/memory/recall.ts`：`RecallIndex` 混合检索——BM25 词法（k1=1.2/b=0.75，按本批最佳分归一）+ 向量余弦，`alpha` 可调（默认 0.5）；中文按 Han 单字+相邻 bigram 分词。
   - 索引为**不持久化派生物**：`buildRecall`/`sync(facts)` 随时从 Fact Store 整体重建；仅 `active`/`disputed` 入索引，`consolidateRealm` 后自动 refresh 已物化的索引。
   - `Embedder` 端口 + 默认 `LocalHashingEmbedder`（FNV-1a signed hashing 词袋，纯本地无网络，仅离线安全底座；真实同域模型可注入）。
   - 遗忘权：`retractFacts`（事实即刻 retracted + 索引即时摘除 + tombstone，幂等）/ `forgetSubject`（主体身份匹配下全部事实抹除）；`RetractionRecord` tombstone 随 MemoryState 持久化，Event Log append-only 保留供治理回放。
   - 11 项 tests/memory-recall-p2.test.ts；设计文档 v0.2（§6.1/6.2 契约）、PRD v0.11。
   - **P2 后续**：~~漂移对账~~ ✅ 见 Active work 22；真实同域 embedding 模型接入仍以 deferred #10 为触发条件。

22. **记忆 P2 漂移对账（2026-09-22 ✅ 完成，全量 280 绿 / 39 文件，tsc 过）**：
   - 新增 `src/memory/reconcile.ts`：`reconcileMemoryStates(prev, curr)` 两时点快照纯 diff——事件追加/移除数、事实 added/removed/changed（逐字段 subject/predicate/object/status/confidence/version/provenance 的 before→after）、correction/tombstone 增量、`hasDrift` 总判定，按 realm。
   - `verifyMemoryState(state)` 横切不变量：bad-fact-id（内容篡改致 id 不可重算）、unresolved/provenance-realm-mismatch、retracted↔tombstone 配对、duplicate/fact-realm-mismatch；空 violation 方可安全重建派生索引。`MemoryStore.verifyIntegrity()` 便捷入口。
   - 导出 `factId` 供重算复用。9 项 tests/memory-reconcile.test.ts；设计文档 v0.3 §6.3、PRD v0.12。**记忆 P2 三项（混合检索 / 遗忘权 / 漂移对账）全部完成。**

23. **E2.5 Mentor 传授（2026-09-22 ✅ 完成，全量 290 绿 / 41 文件，tsc 过）**：
   - 新增 `src/skills/mentor.ts` `MentorshipLedger`：commission（mentor 须为该技能在册 active 提供者，非提供者/未知技能/自教均拒）→ teach（记录传授单元）→ assess（胜任力检查：required 硬门全过 + 加权分 ≥ 阈值 0.8，可自定义）→ 认证才登记新提供者；dismiss 作废；终态后拒绝再改。
   - SkillRegistry 增 `isProvider` 与 `grantProvider`（仅 active spec 可授予，按 agent 幂等）；认证后学习者进 resolveTeam，评估失败不动提供者集合——学习结果可验证。
   - KernelSnapshot 增 `mentorships` 段，台账随 bootKernel 装配持久化重启恢复（collect/apply/FileStore 全链路）。
   - 9 项 tests/mentor-transfer.test.ts + 1 项 tests/kernel-mentor-state.test.ts；PRD v0.13，E2.5 升 ✅。

24. **封臣接入波次表（2026-09-23 ✅ 完成，纯文档）**：
   - product-portrait §7.1 新增波次表：W1 pr-helper（首封臣打磨协议）→ W2 loom/atlas（复用已有 A2A、超集守护）→ W3 agent-world/job-agent/agent-dev（全矩阵收口）；bayjf 为验签封神榜配套（非封臣）。
   - 明确跨波门槛（前波出口达成才推广）、能力域以 Agent Card 为准不预设职责、仓库外关口须点工/授权。product-portrait 升 v0.5。

25. **Agent 时代系统互联与确定性边界（2026-09-23 ✅ 落文档，纯设计探讨）**：
   - 新增 docs/design-agentic-integration.md：核心结论——Agent 是新编排/集成层而非替代 REST，形态为"智能层（协商/非确定）+ 原语层（契约/确定）"两层。
   - 划边界四轴（可逆性/确定性需求/可验证性/爆炸半径），边界本体是"结构化意图→确定性闸门"收口；钉死清单（权限/不可逆动作/钱与规则/状态机/审计回放/注入检查）与可交给 Agent 的"理解表达"层。
   - 记录软肋：闸门校验太弱漏错误、太重退回写死，功夫在"最小但充分"；近中期取 Agent 做面/确定性做骨。docs/README.md 与 handoff Project documents 已索引。
   - **v0.2 增补**：§6A 行业现状——软件"对 AI 原生可操作"的五种主流实践（Function Calling/MCP/Agent Loop/Computer Use/护栏）与 API-first、能力即工具、确定性执行三条原则，作为外部现状对照内部立场。
   - **v0.3 增补**：§6A.2 三层成熟度——L1 连接（能连）/ L2 工具设计（好用：粒度/schema/错误/组合）/ L3 护栏（安全），明确"做了 MCP ≠ 好用"；传统软件四步重构路径，只重构能力暴露层、保留确定性内核。
   - **v0.4 增补**：§2A 明确 Zeus 定位 = AI 原生多 Agent 团队运行时；团队侧能力、目标软件 L1–L3 前提，及"编排内核不替代执行 / 仓库外关口须授权"两条边界。
   - **同步 PRD**：架构立场已索引进 docs/prd.md v0.14（演进日志加行，不复制全文，PRD 仍回答做什么/为什么、设计全文在本文档）。

26. **Vault 藏宝图与恢复协议（2026-09-23 ✅ 完成，纯库内闭环，全量 310 绿 / 42 文件，tsc/build 过）**：
   - 新增 `docs/design-vault.md` v0.1 与 `src/vault/`（types/cipher/inventory/map/restore/bundle）。
   - **出图只存引用**：buildVault 经 inventory 端口（inventoryFromRealm 适配 Realm）枚举条目，marks 只存 itemId + sha256 指纹 + bytes/modifiedAt，**正文零泄漏**（有断言）；整体 contentDigest 复用 Realm digestManifest。
   - **加密密钥分离**：seal/open 走 AES-256-GCM，scrypt 口令派生（N=16384）或 raw 32-byte key（kdf:none）；信封不含密钥，错误口令与 ciphertext/iv/tag/salt 篡改均解密失败。
   - **L0 原地恢复**：restoreDryRun 重连 root、逐 mark 现盘校验，报 ok/changed/missing/unexpected 与 contentDigestMatch、recoverable；root 不可达 fail-loud 并建议 bundle。
   - **L1 跨位恢复**：packFull 产出 manifest-only/full 两档（full 带 AES-GCM 加密内容包，图挂 bundleRef）；restoreFromBundle 校验包 digest 与图一致后经 `FsRestoreSink`（mkdir/writeFile/utimes，拒绝路径穿越）写盘，再重连复验。
   - Realm 底座增只读 `entries(realmId)` 枚举（connect 快照）。E8.1/E8.2 升 ✅、E3.7 升 🚧（库内原语已备，未接 CLI/调度）；PRD 升 v0.15。20 项 tests/vault.test.ts。
   - **非目标**：自动/异地/云备份、KMS 托管、法律继承框架、vault 进 KernelSnapshot（design-vault §9）。

## Project documents

📚 **文档地图（按场景怎么读）**：[docs/README.md](docs/README.md)。以下为完整清单的单一事实源：

* [docs/tech-exploration-map.md](docs/tech-exploration-map.md) — Agent 技术探索地图 v0.2：A 组五条优先（已裁决）、B/C 议题登记、S14 Jev 已落设计（快决策层） ★
* [docs/design-memory-consolidation.md](docs/design-memory-consolidation.md) — 记忆整理协议 v0.1：记忆分层、Event/Fact 结构、整理流水线、置信度聚合、八条验收 ★
* [docs/design-supervision.md](docs/design-supervision.md) — Supervisor/Subagent 控制模型 v0.1：临时控制关系、契约结构、编排跨度、信任校准与失败/责任 ★
* [docs/design-fan-out.md](docs/design-fan-out.md) — 并发决策内核 v0.1（PRD E1）：fan-out/join、intentId 幂等、cancel 传播、多流合并、规则聚合、冲突升级、边界 ★
* [docs/design-decision-backend.md](docs/design-decision-backend.md) — 决策后端抽象层 v0.2（模型无关）：DecisionBackend 端口（noul/choice/score）、两类实现家族（专用决策模型 Jev / 传统 LLM 适配）、四接线位、选择与降级、数据主权硬线 ★
* [docs/design-agentic-integration.md](docs/design-agentic-integration.md) — Agent 时代系统互联与确定性边界 v0.4：§2A Zeus 定位（AI 原生多 Agent 团队运行时）、两层架构、划边界四轴、确定性闸门、MCP·A2A·Skill 插座、§6A 五种主流实践、§6A.2 三层成熟度与四步重构、闸门软肋 ★
* [docs/design-vault.md](docs/design-vault.md) — Vault 藏宝图与恢复协议 v0.1（E8.1/E8.2）：图只存引用 + 逐 item 指纹（**正文零泄漏**）、AES-256-GCM 密钥分离、L0 原地校验恢复、L1 加密备份包跨位恢复（FsRestoreSink）、digest 漂移检测 ★
* [docs/research-decision-layer-industry.md](docs/research-decision-layer-industry.md) — 决策层行业现状调研 v0.1（2026-09）：LLM-as-judge 主流 + 四条分化路线（专用决策模型/程序化裁决/混合路由/多模型分职）、对 design-decision-backend v0.2 的印证、来源清单
* [docs/review-mvp-2026-09.md](docs/review-mvp-2026-09.md) — 项目级评审 v0.1（2026-09-22）：功能性/完整度/可上线三维度、P0 覆盖统计（13✅/11🚧/2⬜）、MVP 判定（库内内核级达成、产品级未达成）、硬/软阻塞项、达到可上线 MVP 的最小路径 ★
* [docs/prd.md](docs/prd.md) — 产品需求文档 现行 v0.15：9 个 Epic、需求拆解（优先级/状态/验收标准）、里程碑与成功指标；v0.15 落 Vault 藏宝图（E8.1/E8.2 ✅、E3.7 🚧），v0.14 索引架构立场 design-agentic-integration ★
* [docs/product-portrait.md](docs/product-portrait.md) — 产品画像活文档：定位、设计哲学（目录底座/藏宝图/MCP·Skill·A2A）、个人与企业双态画像、分层架构、封臣式产品矩阵、路线图；文末演进日志 ★
* [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议设计（A2A 超集 v0.1）：fealty 契约 / intake / report-back / escalation / 治理 / 星型拓扑 / pr-helper 六项验收清单 ★
* [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.1（D1）：目录即数据库、connect/search/read/write、数据二极管执行点、藏宝图依赖 ★
* [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造 v0.1：单一事实源在封臣、字段映射、内外双视图裁剪、签名链公开闸门、R0–R2 阶段 ★
* [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — fealty 签名链设计 v0.1（deferred #7）：威胁模型、Zeus 单签 v1/封臣自签 v2、Ed25519+JCS、两层签名信封、RSK 密钥与轮换、吊销四层失效、v1 八条验收 ★
* [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型 v0.1：网络面划分、Fastify+长驻 Node 裁决、薄传输层单向依赖、H1–H3 端点规划与验收 ★
* [docs/deployment.md](docs/deployment.md) — 部署手册 v0.1：多阶段 Dockerfile（node:22-slim/非 root/健康检查/状态卷）、RSK 密钥生成与生产守卫、Docker compose 与 systemd、卷权限、上线检查清单 ★
* 代码：`src/index.ts`（公共 API 聚合入口，构建产物 `dist/`）、`src/registry/registry.ts`（A1 封臣注册中心：卡片拉取注册/fealty 校验含版本协商/健康探针/吊销/listAll 全量视图/asVassalLookup 实时目录/export·importState 快照）、`src/registry/roster.ts`（名册投影器：internal/public RosterSnapshot）、`src/registry/signing.ts`（fealty 签名链 v1 纯函数：JCS 规范化、attestation/seal、Ed25519 内存签名器）、`src/util/crypto.ts`（sha256Hex 公共哈希）、`src/a2a/types.ts`（A2A 协议类型：Task/Artifact/Part 含 FilePart/事件/AgentCard/Fealty）与 `src/a2a/parts.ts`（isFilePart/artifactFileUris）、`src/skills/`（E2.2 Skill 注册中心：SkillRegistry 多版本/废弃/按名域标签检索/registerFromCard/resolveTeam 组队）、`src/decision/`（模型无关决策后端：DecisionBackend 窄端口、Jev 与 OpenAI 兼容 LLM 适配器、prepareState 数据主权守卫、arbitrateSplit 降级）、`src/http/`（Fastify 薄传输层：`server.ts` H1 三端点 + 签名接线与 **H2 驾驶员 API**（intents/escalations/metrics，bearer 保护）、`serve.ts` 进程入口（bootKernel 装配含 metrics + 优雅退出落盘）、`rsk.ts` RSK 加载与 production 守卫；全仓库唯一 import fastify 处，`./http` 子路径导出）、`src/dispatch/`（A2A 派发器：JSON-RPC + SSE 客户端、数据二极管与脱敏、吊销阻断、sla.ackSeconds 受理计时、审计 sink + 吊销审计桥）、`src/oversight/`（A4 监督台：task-input/intent-conflict 两类升级队列 + approve/reject/decideConflict + 快照导出导入）、`src/orchestrator/`（E1 并发内核：Orchestrator fan-out/幂等/cancel/resolveIntent/resumeBranch、merge/aggregate/conflict/resolution 纯函数、`arbitration.ts` S2 后端仲裁、metrics.ts E1.7 指标、dag.ts/dag-runner.ts S3 DAG 编排）、`src/state/`（E5.3：`kernel-state.ts` FileKernelStateStore 原子落盘 + collect/applyKernelState、`boot.ts` 进程启动装配/恢复/退出保存）、`src/realm/`（D1 Realm P0：FsRealmStore 只读 personal 数据域、扫描检索、contentDigest、路径穿越防护；`mcp.ts`/`mcp-stdio.ts` 只读 MCP stdio 脚手架）、`src/vault/`（E8.1/E8.2 Vault：buildVault 出图只存引用 + 逐 item 指纹、cipher AES-256-GCM seal/open 密钥分离、restore 原地校验与漂移检测、bundle 加密内容包 + FsRestoreSink 跨位恢复）、`scripts/acceptance-standard-a2a.mjs`（验收 #6 纯标准客户端）、`scripts/gen-rsk-key.mjs`（RSK Ed25519 密钥生成，零依赖跨平台）、`Dockerfile`/`.dockerignore`/`.env.example`（容器部署，见 docs/deployment.md）、`.github/workflows/ci.yml`（CI）、`tests/`（**310 项，42 个测试文件**，含 `tests/vault.test.ts` 藏宝图 20 项、`tests/http-h2.test.ts` H2 端到端 12 项）
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
| 2026-09-22 | **项目级评审**（review-mvp-2026-09.md v0.1）：实跑验证 124/124 测试绿（1 例并行抖动）、typecheck/build 过；P0 26 条=13✅/11🚧/2⬜（缺口：E2.2 Skill 注册中心、E6.2 决议反馈）；判定**库内内核级 MVP 达成、产品级可上线 MVP 未达成**（阻塞：无部署形态/状态全内存/E2.2/E6.2/生产 RSK 密钥/真机闭环/E1.7 可观测/未 push）；给出 7 步最小上线路径 |
| 2026-09-22 | **MVP 评审后六切片批次（全库内闭环，166 绿/22 文件，typecheck/build 过）**：E2.2 Skill 注册中心（f46eff9，10 测试）、模型无关决策后端 src/decision 含 Jev/LLM 适配器（81dc347，9 测试，真机 envelope 待 key 核对）、E6.2 冲突决议回写闭环 + E6.3 重派骨架（c2c4b35，6 测试）、E1.7 库内并发指标（e54b4ea，5 测试）、S3 完整 DAG 编排（b9134e5，6 测试）、E5.3 内核状态原子落盘恢复（79bac99，6 测试）；测试去抖两处（37c65bd acceptance 超时、4b615e6 并行墙钟断言）。PRD 升 v0.4，评审报告加 v0.2 销项批注：硬阻塞 E2.2/E6.2 销项、E5.3/E1.7 大幅缓解，产品级 MVP 仍未达成（部署形态/生产密钥/真机/push 仍阻塞） |
| 2026-09-22 | **T1–T4 产品化收口批次（187 绿/25 文件）**：T1 E5.3 启动装配 bootKernel + 优雅退出落盘（fdb2663，4 测试，进程冒烟落盘/恢复实证）；T3 生产 RSK 硬化（4d99f43，9 测试）：rsk.ts 内联/文件密钥、production 无钥拒启、gen-rsk-key 脚本（T2 改为零依赖 .mjs）；T2 部署形态（34ad658，真机 docker build/run 验证 SIGTERM 卷落盘与重启恢复）：多阶段 Dockerfile/.dockerignore/.env.example/docs/deployment.md；T4 S2 critic 接 E1.3（d0ecc85，8 测试）：orchestrator/arbitration.ts 后端闸门仲裁，fanOut/resumeBranch 双路径，未过闸仍升级驾驶员。评审两条硬阻塞库内销项，剩余关口（真机 #6/loom 联调/push 授权/E10.4 压测）均在仓库外 |
| 2026-09-22 | **T5 H2 驾驶员 API（199 绿/26 文件）**：src/http/server.ts 新增 bearer 内部驾驶员面——POST /api/intents 扇出、GET /api/intents/:id、POST .../cancel、GET/POST /api/escalations（list/approve/reject/resolve 决议回写）、GET /api/metrics，未配 token 整组不挂载；bootKernel 装配 ConcurrencyMetrics，serve.ts 接线；新增 tests/http-h2.test.ts 12 项端到端（发起→扇出→冲突升级→拍板→回写全链路 + 鉴权矩阵 + 4xx）+ 真实进程冒烟。修复服务端生成 intentId 不落表导致无法回查/决议的内核缺口（fanOut 一律按最终 id 落表，重放语义不变）。README 模块表/H2 用法、PRD v0.5（E5.5🚧/E1.7✅/E5.3/E6.3）同步。**意义：内核能力第一次暴露成人可经 HTTP 驾驶的服务，是库 MVP 跨向产品 MVP 的关键一跃；H3 SSE、E6.3 一键重派 HTTP、封臣启动注册仍在后。** |
| 2026-09-23 | **Vault 藏宝图与恢复协议（310 绿/42 文件）**：新增 src/vault + design-vault v0.1——buildVault 出图只存引用 + 逐 item sha256 指纹（正文零泄漏）、AES-256-GCM seal/open（scrypt/raw key，密钥分离，错误口令与四类篡改拒绝）、L0 restoreDryRun 原地重连校验与 changed/missing/unexpected 漂移检测、L1 packFull 加密内容包 + restoreFromBundle 经 FsRestoreSink 跨位写盘恢复并复验；Realm 增只读 entries() 枚举。E8.1/E8.2 ✅、E3.7 🚧，PRD v0.15。**意义：数据主权底座兑现为"按图真能恢复宝藏"的生命线。** |
