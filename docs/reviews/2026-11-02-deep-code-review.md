# Zeus 深度只读代码评审（2026-11-02）

评审范围：仓库 `/Users/jiangfeng/000mycodes/zeus`，HEAD = `0c8b059`（Merge PR #179）。
评审性质：只读；未修改任何源码、配置或测试，未执行任何 git 写操作。唯一写入物为本报告。
评审人视角：外部安全与质量评审，所有结论附证据（文件:行 或 实测命令输出）。

---

## 1. 仓库定位与规模概览

Zeus 是一个多 Agent 编排与决策运行时：并行派发意图给外部 A2A 执行 Agent，按确定性规则聚合立场，无法收敛时升级人工裁决，全程落可离线验证的审计与签名名册。

| 维度 | 实测 |
| --- | --- |
| 源码 | `src/` 221 个 .ts，约 46,460 行；31 个顶层模块 |
| 测试 | `tests/` + 仓内 `*.test.ts` 共 217 个测试文件、2,519 个用例（实测全绿） |
| 技术栈 | TypeScript（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）、Fastify 5、undici、node:sqlite（Node 22+）、Vitest 3 |
| 依赖 | 生产依赖仅 fastify / undici / @model-hub/model-kit（file: 兄弟仓）；`npm audit --omit=dev` 0 漏洞 |
| HTTP 面 | server.ts 实测注册 132 条路由，与 README 声明一致 |
| CI | .github/workflows/ci.yml：build → typecheck → test → smoke:core → lint → npm audit → secret scan，另有 +2 年时钟偏移门；Node 22/24 双矩阵 |

架构分层清晰：`core/`（纯领域逻辑：orchestrator、decision-service、grading、audit、persistence）→ `http/`（传输映射层）→ `state/`、`dataDomain/`、`backup/`（持久化与数据域）→ `dispatch/`、`mcp/`、`a2a/`（协议面）。设计文档 60+ 份与代码互相引用，且近期修复（如 PR #178 diary 错误映射）同步更新了文档与测试。

## 2. 结论摘要

**P0：0 条 · P1：2 条 · P2：1 条 · P3：7 条**

总体判断：这是一个安全纪律显著高于平均水平的仓库——bearer 常数时间比较、出站 DNS 重绑定守卫、审计链开库即验签（fail-closed）、内核状态原子写 + fsync + 0600、迁移幂等且失败不落记录、Ed25519 名册签验链完整。验证门真实有效（实测全绿，非形同虚设）。

最关键的三条：

1. **【P1】SQLite 库文件权限与代码注释承诺不符**：`schema.ts:146` 声称 "the DB file is opened 0600"，实测 `openSqlite` 不做任何 chmod，umask 022 下建库为 0644——`decision_webhooks.secret`（HMAC 密钥）对同机其他本地用户可读。
2. **【P1】加权聚合的 weight 由执行 Agent 自报且无界**：`aggregate.ts:17` 直接采信 executor 返回的 `data.weight`，恶意/被攻破的 executor 自报 `1e9` 或负权重即可强制收敛到自己立场，击穿 "规则不收敛就升级、不臆断" 的核心承诺。
3. **【P2】2026-09 之后新增的出局面未接入 DNS 重绑定守卫**：`hub-embedder.ts`、`agent-world/client.ts`、`webhook.ts`、`exporter.ts`、`evals/judge.ts` 仍用裸 `fetch`，其中两个面携带 Bearer 凭证，端点主机被重绑定时凭证会落到私网地址。

## 3. 验证门实际执行结果

在本机（macOS，Node v22.23.4）实际执行，记录真实退出码：

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run typecheck`（tsc --noEmit） | 0 | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes 全量通过 |
| `npm run lint`（eslint .） | 0 | 0 错误 0 警告 |
| `npm test`（vitest run） | 0 | **Test Files 217 passed (217)，Tests 2519 passed (2519)**，67.6s |
| `npm run build`（tsc + client tsc） | 0 | 无警告输出 |
| `npm run lint:audit`（npm audit --omit=dev） | 0 | found 0 vulnerabilities |
| `npm run lint:secrets` | 0 | secret scan: clean (569 files scanned) |

门禁真实性评估：

- **typecheck 真实**：include 覆盖 src/tests/scripts/evals，strict 全家桶开启（tsconfig.json:6-12）。
- **lint 偏弱但非空转**：eslint.config.js 使用 typescript-eslint recommended，显式关闭 `no-unused-vars` 与 `no-explicit-any`（注释说明由 tsc 接管）；未启用 type-checked 规则（如 no-floating-promises）。作为门禁有效但覆盖面偏薄（见 P3-4）。
- **测试真实**：206 个 tests/ 文件 + 仓内组件测试，无 `.only`，skip 均为 `skipIf(win32)` 平台条件跳过（5 处，均为符号链接相关用例）；vitest.config.ts 对超时上升有实测依据的注释。
- **CI 含两个亮点**：+2 年时钟偏移门（vitest.clock-skew.config.ts）专门抓"偷读真实墙钟"的回归；secret scan 对 origin/main 差集执行。
- 环境注意：`engines: node>=22` 且 .npmrc 开 engine-strict；本机默认 shell 的 node 为 v20.20.2（该环境下 npm install 会直接失败），评审通过 nvm 解析 .nvmrc=22 的 Node 22.23.4 完成。属设计好的 fail-fast，不构成缺陷。

## 4. 逐条发现

### P1-1 SQLite 文件权限与注释承诺不符（密钥明文落盘 0644）

- **位置**：`src/core/persistence/sqlite-db.ts:15-23`（openSqlite 无 chmod）；承诺出处 `src/core/persistence/schema.ts:146`（"stored like the rest of the local secrets: plaintext on the operator's own disk (the DB file is opened 0600)"）
- **证据**：openSqlite 全文仅 `mkdirSync(dirname, {recursive:true})` + `new DatabaseSync(location)`，无任何 chmod；全仓 grep 确认无其他位置对 DB 文件补 chmod。实测（Node 22.23.4，umask 022）：`new DatabaseSync('/tmp/zeus-probe.db')` 产出 `-rw-r--r--`（0644），WAL/SHM 同默认。
- **影响**：`ZEUS_DB_FILE` 持久化模式下，`decision_webhooks.secret`（决策事件推送的 HMAC 签名密钥）及全部决策/组织记录对同机任意本地用户可读；schema 注释给其他面（runtime-state 0600+fsync、audit 0600、evals 0600、backup 0700/0600）建立的安全预期在这里不成立，属于文档化控制未实现。利用前提是需要同机本地访问，故不定 P0。
- **修复建议**：openSqlite 打开后立即 `chmodSync(location, 0o600)`（并处理 WAL/SHM），父目录 `mkdirSync(..., {mode:0o700})`；在 persistence.test.ts 增加文件权限断言用例；同步修正 schema.ts 注释或使其为真。

### P1-2 加权聚合采信 executor 自报 weight 且无界

- **位置**：`src/core/orchestrator/aggregate.ts:17`（`typeof data.weight === 'number' ? { weight: data.weight }`，无有限性/符号/上界校验）、`aggregate.ts:86-94`（聚合直接累加）
- **证据**：`extractStance` 从执行 Agent 返回 Task 的 data part 读取 weight；设计文档 `docs/design-fan-out.md:117,130` 只写 "按 weight（缺省 1）累加"，未规定来源与边界；测试 `tests/orchestrator-primitives.test.ts:106-132` 仅覆盖正权重正常路径，无对抗用例。
- **影响**：`weighted` 规则下，任一参与派发的 executor 自报 `weight: 1e9` 即可独占结论；负权重使 totalWeight 失真（如 [100, -99] → 总权 1 → 占比 100 倍 ≥ 阈值）；`Infinity`/`NaN` 虽恰好 fail-closed（NaN 比较全 false），但有限大数与负数完全可用。这直接违反产品核心承诺 "无法收敛时结论为空并升级，不臆断"（README §1.2）——对抗性 executor 能强制"收敛"。
- **修复建议**：首选——weight 改为名册侧配置（operator 信任的权重），忽略 executor 自报值；次选——clamp 到有限非负区间（如 0 < w ≤ 100）并在 reason 中记录被裁剪的事实；为负权重/巨大权重/NaN 增加聚合测试。

### P2-1 新增出局面未接入 DNS 重绑定守卫

- **位置**：`src/memory/hub-embedder.ts:71,137`（携带 `authorization: Bearer <apiKey>`）、`src/core/org/adapters/agent-world/client.ts:99,227`（携带 service token Bearer）、`src/core/decision-service/webhook.ts:103,142`（POST 决策事件）、`src/observability/exporter.ts:311`、`src/evals/judge.ts:82`
- **证据**：上述面均 `fetchImpl = ... ?? fetch`（裸全局 fetch）；而 `registry/registry.ts:104`、`dispatch/client.ts:94`、`mcp/client.ts:55` 已默认 `guardedFetch`（`src/util/outbound-dns.ts`，connect 期钉住已过检地址 + 每跳重检）。`docs/review-mvp-2026-09.md:585` 记录了 2026-09 的收口范围恰好只有那三个面，后续新增面未跟进。
- **影响**：这些端点虽为 operator 配置，但 hub-embedder 与 agent-world 携带 Bearer 凭证——配置的主机名一旦发生 DNS 重绑定/记录变更（或被引导指向内网），凭证与决策事件载荷会 POST 到私网地址，正是 outbound 守卫设计要防的场景；守卫覆盖不完整形成隐性信任假设。
- **修复建议**：五个面统一默认 `guardedFetch`（内网对端走既有 `ZEUS_OUTBOUND_ALLOW_HOSTS` 放行）；加一条架构约束测试（如扫描 src/ 禁止新增裸 fetch 默认参数），防止再次漂移。

### P3-1 入站 A2A 调用方名称可伪造进入审计与记忆

- **位置**：`src/http/server.ts:673`（`callerName = card.name`）、`server.ts:748`（写入 fan-out `params.a2aCaller`）
- **影响**：tier-1（形状信任）调用方的 name 未经验证即落入审计行与下游记忆；持 bearer 的调用者可冒名污染问责链。因路由本身有 bearer 门槛，威胁场景限于 token 共享/泄露后的归因混淆。
- **修复建议**：tier-1 时 callerName 标注未验证（如 `unverified:<name>`），或审计 detail 显式记录 "name not roster-anchored"。

### P3-2 同名 active executor 重注册静默覆盖

- **位置**：`src/registry/registry.ts:190-196`
- **影响**：revoked 条目有显式保护（A-02 注释），但同名 active 条目被 `entries.set` 直接覆盖，taskUrl/token 一并替换；operator 误操作无告警。
- **修复建议**：同名 active 重注册返回 409 或要求显式 `?force=true`。

### P3-3 supervisor UI 将主 bearer 存入 localStorage

- **位置**：`web/supervisor/index.html:2477`（`localStorage.setItem(LS_KEY, JSON.stringify(state.conn))`）
- **影响**：128 条 bearer 路由的主凭证持久于 localStorage；页面 XSS 防线（esc() 使用一致，抽查无裸注入点）一旦被突破即凭证失窃。UI 已明示 "连接配置 localStorage"，属知情的本地优先取舍。
- **修复建议**：可选项——改 sessionStorage 或增加"仅本次会话记住"开关。

### P3-4 lint 规则面偏薄

- **位置**：`eslint.config.js:13-22`
- **影响**：仅 typescript-eslint recommended（非 type-checked），`no-floating-promises`、`no-misused-promises` 等异步陷阱规则未启用；无 import/安全类插件。当前代码 void+catch 纪律良好，但门禁挡不住未来回归。
- **修复建议**：评估启用 `recommendedTypeChecked` 子集或至少 `no-floating-promises`。

### P3-5 `.env.example` 漏记 2 个在用变量

- **证据**：全仓 `process.env.ZEUS_*` 实测 35 个变量；`.env.example`（含注释行）覆盖 59 项，仅 `ZEUS_CLOCK_SKEW_DAYS`、`ZEUS_EVAL_BUDGET_MS` 未出现（均为测试/评测旋钮）。
- **修复建议**：补两行注释式条目。

### P3-6 README 路由分类口径不精确

- **证据**：README §1.4 "132 条路由（4 条公开、128 条 bearer）"；实测 server.ts 注册 132 条，其中公开 GET 为 4 条常驻（healthz、roster/public、roster/keys、audit/summary）+ 3 条条件挂载公开 GET（/mcp、/api/mcp、/.well-known/agent-card.json），另有 4 条 memory-service-token 面与 1 条自校验 POST /api/mcp。
- **修复建议**：措辞改为 "4 条常驻公开 + 3 条条件挂载公开，其余 bearer/服务 token"。

### P3-7 handoff 体系体积失控

- **证据**：`handoff.md` 396KB、`handoff-archive.md` 737KB、`handoff-archive-2.md` 166KB，均提交在仓库根；AGENTS.md 自述 "handoff = 索引 + 状态 + 待办"。
- **影响**：clone 体积、可读性与 merge 冲突面；与自定文档分层约定张力。
- **修复建议**：归档切片 + 在 .gitignore 层面对历史归档做长期策略（如移至独立仓或 release 附件）。

## 5. 已验证为健壮的方面（抽样记录，供后续评审复用）

- **认证**：bearer 全部 `timingSafeEqual`（server.ts:3718）；401 带 RFC 6750 challenge；4 条常驻公开路由仅暴露聚合计数，审计原文不出公开面（server.ts:446-483）。
- **路径穿越/符号链接**：dataDomain store 双重防护——`assertSafeItemId` 拒绝 `..`/空段（store.ts:482），realpath 回检父目录符号链接（store.ts:218-222），写路径 tmp+rename 且 0600（store.ts:345,511）。
- **SSRF**：注册面 cardUrl 与 taskUrl 均先过 `assertOutboundUrlAllowed`（registry.ts:117,177）；guardedFetch 在 connect 期钉住过检地址、每跳重检（outbound-dns.ts:140-158），混合解析结果整域名 fail-closed。
- **授权凭证**：operator write grant 全链路（签发 TTL 上限 24h、验签、nonce 单次消费、账本持久化防崩溃重放）`dataDomain/grant.ts:199-243`；nonce 账本满窗淘汰仍落盘的设计注释（grant.ts:150-154）显示对崩溃窗口有正确推理。
- **审计链**：JSONL 决策审计开库即全量验签，失败拒绝打开（jsonl-chain-store.ts:44-53）；签名链 Ed25519，seal maxAge/attestation TTL/keyId 绑定/issuer 绑定逐项校验（core/signing.ts:368-509）。
- **Backup**：AES-256-GCM + scrypt(N=2^17)，kdfParams 随信封记录且有 2^20 上限与 2 的幂校验（cipher.ts:51-72）；错误区分 BackupFormatError/BackupDecryptError。
- **失败模式**：聚合不可收敛 → conclusion=null 升级（aggregate.ts:49-54）；judge 后端失败 → judged:false + 错误记录（judge.ts:101-112）；webhook 推送 fail-soft 不阻塞决策路径（webhook.ts:113-115）；org 无执行器 → 503 fail-closed（serve.ts:431-434）。
- **错误边界**：未分类异常统一 RFC 9457 500，不回显内部消息（server.ts:3437-3465）；DomainError 消息只含用户输入级细节。
- **XSS**：supervisor 面板 esc() 使用一致（抽查 10+ 处 innerHTML 注入点全部转义）。
- **机密卫生**：.env 与 *.pem 均被 gitignore 且未入历史（git ls-files 确认）；lint:secrets 通过；内核状态落盘前剥离 connector token（runtime-state.ts:210-215 注释 + 0600）。
- **并发治理**：Semaphore 队列有界、构造期拒绝非法 queueLimit（semaphore.ts:80-82）；分支预算/熔断/成本闸门齐备（orchestrator.ts:458-466）。
- **迁移**：baseline 全 IF NOT EXISTS + 增量幂等 + 成功才记录（schema.ts:246-265）。

## 6. 修复优先级建议

1. **立即（P1-1）**：给 openSqlite 补 chmod 0600 + 父目录 0700 + 权限断言测试。改动约 10 行，消除"文档化控制未实现"的密钥暴露。
2. **尽快（P1-2）**：确定 weight 的信任来源（建议名册配置），在 extractStance/aggregate 加边界校验与对抗测试。这是聚合正确性的根基。
3. **本迭代（P2-1）**：五个出局面统一 guardedFetch + 防漂移测试；同时把"所有出站走守卫"写进 AGENTS.md 约定。
4. **排期（P3）**：P3-1/P3-2 属小改动可随手带上；P3-4 lint 加 type-checked 规则需评估存量噪音；P3-7 handoff 治理建议与 owner 确认归档策略后执行。

---

*评审方法说明：静态阅读（重点面逐行：http/server.ts 3833 行全文抽样 + 全部安全敏感模块通读）+ 动态验证（四项门禁实跑、文件权限实证、env 变量差集实测、路由计数实测）。未确认项已标注；无推测性结论。*
