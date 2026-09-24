# Zeus 项目级评审：功能性 / 完整度 / 可上线（MVP 判定）

> 状态：**现行（评审报告 v0.4，2026-09-24）**。评审对象：Zeus 仓库 `dev` 分支（评审起点 HEAD `a7e4ce9`，与 `origin/dev` 同步；本批新增提交后将领先云端、待授权 push）。
> 评审方法：PRD 逐条核对（代码 + 测试证据）、全量验证实跑（vitest / tsc / build）、容量压测实跑（四场景）、部署/运行入口与制品面检查（Dockerfile / serve.ts / RSK 工具）。
> **结论一句话（v0.4）**：**库内"内核 + 可部署制品"级 MVP 已达成——v0.1 所列 5 个硬阻塞在代码/制品侧均已有对应实现；产品级"可上线 MVP"仍未达成，但剩余关口已全部是仓库外验收动作（真机 docker build/run、真机封臣部署与 loom 联调、RSK 实际托管/公钥发布、Jev key、push 后云端 CI），库内已无 P0 功能缺口。**

> **【2026-09-22 六切片批次后 · 销项更新 v0.2】** 下列为评审 v0.1 之后的库内进展（全量 **166 测试绿 / 22 文件**，typecheck/build 过；以下为现状，原 §1–§7 快照保留不改）：
> - 硬阻塞 **#3 E2.2 Skill 注册中心 → ✅ 销项**：`src/skills/`（多版本共存、deprecate 标记、按名/域/标签检索、registerFromCard、resolveTeam 多技能组队且歧义不静默选边，10 测试）。E2.4 组队解析一并 ✅。
> - 硬阻塞 **#4 E6.2 决议反馈闭环 → ✅ 销项**：冲突经 onConflict 入监督台（幂等）、decideConflict 校验立场、applyConflictResolution 纯函数回写聚合决策并重算状态（6 测试）。E6.3 补参重派**骨架**（resumeBranch）已落地，"approve 一键自动重派"的装配/HTTP 闭环随 H2（E6.3 仍 🚧）。
> - 硬阻塞 **#2 E5.3 持久化 → 🚧 大幅缓解但未全销**：`src/state/kernel-state.ts` 把封臣注册表（含已吊销）、升级队列（重建幂等索引）、编排意图结果+原始请求原子落盘（tmp+rename）并可恢复，重启后幂等重放与 resumeBranch 可用（6 测试）。**未做**：Realm 连接状态未纳入快照、文件存储未接入进程启动装配/H2——长驻服务"重启自动恢复"仍需接线。
> - 软阻塞 **#8 E1.7 可观测 → 🚧 库内已落地**：`ConcurrencyMetrics`（在途数/并发峰值/队列深度/完成失败超时/各封臣延迟 p50·p95/失败率，5 测试）；HTTP 指标端点随 H2。
> - 非阻塞增强：**完整 DAG（S3）→ ✅**（`src/orchestrator/dag*.ts`，拓扑分层/关键路径/部分失败跳过，6 测试）；**决策后端工程切片 → ✅**（`src/decision/`，模型无关端口 + Jev/LLM 适配器 + 降级，9 测试；Jev 真实 endpoint/envelope 待有 key 真机核对）。
> - **仍未销项（故产品级可上线 MVP 判定不变：仍未达成）**：硬阻塞 #1 部署形态、#5 生产 RSK 密钥；软阻塞 #6 E4.8 真机验收、#7 真机联调、#9 push + 云端 CI 首绿（需授权）；以及 E5.3 的启动装配接线与 Realm 持久化、E10.4 容量压测。

> **【2026-09-22 A 批次（G1/G4/G5/G6）后 · 销项更新 v0.3】** 评审 v0.2 之后的库内进展（全量 **217 测试绿 / 31 文件**，tsc 过；以下为现状，原 §1–§7 快照保留不改）：
> - **G1 封臣上线入口（致命缺口）→ ✅ 销项**：`POST /api/vassals`（拉 card + fealty 校验注册，卡片不可达 502）、`DELETE /api/vassals/:name`（吊销，未知/已吊销 404）；`ZEUS_VASSAL_SEEDS` 支持启动 seed，已在状态快照中的 URL 跳过不重复拉取。长驻服务不再以空 registry 启动。
> - **G4 Realm 连接持久化 → ✅ 销项**：KernelSnapshot 增 `realms`（连接参数 root/realmId/type/readOnly，向后兼容可选字段）；`bootKernel` 装配 FsRealmStore，重启自动 reconnect 重建检索索引；`ZEUS_REALM_ROOTS` 支持启动连接；已持久化 root 不可达时 fail-loud 拒启，不静默丢域。
> - **G6 E6.3 一键补参重派 → ✅ 销项**：`POST /api/escalations/:id/approve-resume` 携带 params，approve 后经新增 `Orchestrator.findIntentForBranchRun` 定位意图并自动 `resumeBranch` 重派、重算整意图。
> - **G5 H3 服务端 SSE → ✅ 销项**：编排器发出 branch-started/branch-ended/intent-finished 进度事件到新增 `ProgressHub`；`GET /api/intents/:id/events` 输出 SSE（15s keepalive ping、已完成意图回放单事件后关闭、无 hub 时未知意图 404）；hijack 后 `flushHeaders` 保证客户端即时收到响应头。
> - **产品级可上线 MVP 判定仍为：未达成**。剩余关口全部在仓库外或需授权，库内已无法继续闭环：E4.8 真机验收（pr-helper 部署）、Zeus↔loom 真机联调、push dev→云端 CI 首绿（需授权）、E10.4 容量压测基线、Jev 真实 endpoint/key 核对。

## v0.4 现行评审（2026-09-24，以此节结论为准）

> 原 §1–§8 为 2026-09-22 v0.1 首次评审快照（结论已被后续批次超越），原样保留于文末；v0.2/v0.3 为当时批注。**当前功能性 / 完整度 / 可上线性结论以本节为准。**

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-24） | 说明 |
|---|---|---|
| 全量测试 | **436/436 绿（52 文件）** | `npx vitest run` exit 0（v0.1 为 124/16，v0.3 为 217/31） |
| typecheck | ✅ `tsc --noEmit` exit 0 | |
| build | ✅ `tsc -p tsconfig.build.json` exit 0，dist 完整 | |
| 容量压测 | ✅ 四场景全过 | A 扇出宽度 / B 并发意图 / **C H2 门面全链路** / **D 高并发取消传播**；数据见 `docs/capacity-baseline.md` v0.2 |
| 运行入口 | `npm start`（dist/http/serve.js） | env 装配见下；H1 + internal + H2 驱动 API |
| 部署制品 | **Dockerfile（多阶段/非 root/healthcheck/volume/SIGTERM）+ `docs/deployment.md` + `scripts/gen-rsk-key.mjs`** | 静态核查与接线核查通过；**本批未执行 `docker build/run`，真机镜像验证仍属仓库外关口** |
| 持久化接线 | `ZEUS_STATE_FILE`：启动恢复 + SIGINT/SIGTERM 优雅保存；`ZEUS_VASSAL_SEEDS` / `ZEUS_REALM_ROOTS` 启动装配 | serve.ts 实证 |
| 生产密钥 | `ZEUS_RSK_KEY` / `ZEUS_RSK_KEY_FILE`；**NODE_ENV=production 无钥拒启**；gen-rsk-key 零依赖生成 Ed25519（私钥 0600、拒覆盖） | 密钥实际托管/轮换/公钥发布在仓库外 |

### B. 自 v0.3 以来的库内增量（2026-09-22 → 09-24，据 handoff）

- 记忆体系 P0/P1/P2、Vault（打包/便携恢复/错图拒绝，见 L1 测试）；
- E1.6 离线决策回放器、E1.3 独立 judge 对抗评审、boot 决策后端 env 装配（Jev 优先 / OpenAI 兼容 fallback / 无 key 降级 rules-only）；
- E3.5 Realm 写路径（驾驶员授权门，库内）、E10.4 容量基线（本批扩为四场景）；
- E8.3 Diary（叙事日志）、E9.3 Org（部门/编制/问责），及 Diary/Org 的持久化与 HTTP 暴露；
- **签名链 v1.1（本批）**：internal 名册快照与 public 同样封签——attestation 扩 `active|revoked` 两态，revoked 行获**永久吊销 attestation（无硬过期，新鲜度由 seal maxAge 绑定）**，验签要求状态精确匹配（防提升/掩盖吊销），缺 source / 状态矛盾 fail-loud；H1 `GET /api/roster` 改发封签信封（`Cache-Control: no-store`）；
- 部署制品面（Dockerfile / deployment.md / gen-rsk-key）在库内就绪（具体落地批次见 git 历史）。
- 测试规模 217（v0.3）→ **436（v0.4）**。

### C. 功能性现状：PRD 剩余项全部卡在仓库外 / 触发条件未到

内核（fan-out/join、幂等、取消、规则聚合、冲突检测、完整 DAG）、Skill 注册中心与组队、Realm（读 + 授权写 + digest + 穿越防护）、封臣联邦（注册/fealty/派发/战报/升级/二极管/吊销/审计）、HTTP 门面（public/internal 双投影 + 双份封签 + H2 驱动 API + H3 SSE）、监督台（升级/拍板回写/补参重派）、决策后端（模型无关 + Jev/LLM + 降级 + judge + replay）、可观测、持久化、记忆/Vault/Diary/Org 均在库内落地并有测试。

逐条核对 PRD 剩余 🚧/⬜，**无一项能在库内继续闭环**，分五类：

| 类别 | 剩余项（PRD 编号） | 关口 / 触发条件 |
|---|---|---|
| 真机 / 部署 | E4.8、E10.2、Zeus↔loom 联调、协议第 6 项守护测试、Docker 镜像实构实跑 | 需真实环境与封臣部署 |
| 密钥 / 发布 | E4.9 生产 RSK 的 R2（托管/轮换/公钥发布）、E5.4 bayjf R2 | deferred #7（bayjf 公开前） |
| 连接 / 企业域 | E3.4 stdio MCP、E3.5 enterprise connect + MCP write、E3.6 多租户、E6.4 双域授权 | 随 read-realm 封臣 / enterprise connect |
| 触发型容量/安全 | E1.5、E4.10 背压与有界队列；E3.8 检索升级；E9.4 外部 Agent 沙箱 | deferred #9（≥3 真封臣）/ #10（单 Realm >2 万文件或 P50>500ms）/ #5 |
| P2/P3 与外部凭证 | E9.1/E9.2 Mentor/上岗（真机验收）、E8.4 传承（#3，P3）、Jev 真实 endpoint/key | 真机 / 外部凭证 |

### D. 完整度（里程碑重判）

| 里程碑 | v0.1 判定 | v0.4 判定 |
|---|---|---|
| **M1 内核基座** | ✅ 达成 | ✅ 达成 |
| **M2 并发决策内核** | 🚧 核心达成、缺 E2.2/E10.4 | ✅ **达成**（E2.2 已补、E10.4 四场景基线已出；完整 DAG、模型无关决策、judge、replay 超出原 M2 范围） |
| **M3 真机闭环** | ⬜ 未启动 | 🚧 **制品就绪、真机未验**：部署/持久化/密钥/优雅关闭在库内齐备，但从未 `docker build/run`、无真机封臣、无真机联调 |

### E. 可上线性：v0.1 五硬阻塞现状重判

| v0.1 硬阻塞 | 库内/制品侧（v0.4） | 仓库外残留 |
|---|---|---|
| 1 无部署形态 | ✅ Dockerfile（多阶段、node:22-slim、非 root、生产依赖、/data 卷、HEALTHCHECK、SIGTERM 优雅保存）+ deployment.md + env 装配 | 真机 `docker build/run` 冒烟、托管/反代/TLS |
| 2 状态全在内存（E5.3） | ✅ kernel-state（registry/升级队列/意图/请求，tmp+rename 原子落盘）+ 启动恢复 + Realm/Diary/Org 持久化 + SIGTERM 保存 | 真机备份策略与卷挂载验证 |
| 3 E2.2 Skill 注册中心 | ✅ `src/skills/`（多版本/弃用/检索/组队，歧义不静默） | — |
| 4 E6.2 决议反馈闭环 | ✅ 冲突入监督台、拍板回写重算、approve-resume 一键补参重派 | — |
| 5 签名链生产密钥（E4.9） | 🚧 **工具/接线就绪**：gen-rsk-key、env 注入、production 无钥拒启、双份封签（v1.1 含 internal） | R2：密钥实际托管/轮换、公钥对 bayjf 发布（#7） |

**上线前剩余关口（均为仓库外动作，库内无法替代）**：① `docker build/run` 真机冒烟；② 部署 pr-helper 等真机封臣并跑协议第 6 项纯客户端守护测试；③ Zeus↔loom 真机联调；④ RSK 实际生成托管与公钥发布；⑤ push 本批 commit → 云端 CI 首绿（需授权）；⑥ 若启用模型裁决，配置并真机核对 Jev endpoint/key；⑦ deferred #9 触发后做背压真机标定。

### F. MVP 判定（v0.4）

- **库内内核级 MVP（可演示 + 制品就绪）**：✅ **达成**。M1/M2 全绿，436 测试、tsc/build 过、四场景容量基线、生产级 Dockerfile 与部署文档齐备；单意图多 Agent 并发 → 聚合 → 冲突升级 → 拍板/重派 → 持久化/恢复 → 封签发布在库内可完整走通。
- **产品级可上线 MVP（交付真实用户）**：❌ **未达成，但阻塞性质已变**：v0.1 时是"缺 P0 功能（E2.2/E6.2/持久化/部署/密钥）"，v0.4 时这些在**代码与制品侧全部有了对应实现**；剩余的是**只能在真实环境由人执行的验收与发布动作**（真机部署/联调、密钥托管发布、凭证、CI）。**库内已无 P0 功能缺口可继续闭环。**
- **一句话（v0.4 升级）**：Zeus 的"内核"达到了 MVP，Zeus 的"可部署制品"也已在库内齐备；Zeus 的"上线"只差在真实环境里把它**跑起来、联起来、签出去**——这三步无法在仓库内完成。

### G. v0.4 评审限制（如实标注）

- 未执行 `docker build/run`：Dockerfile 与 serve.ts 为静态/接线核查，镜像能否一次构建成功未实证。
- 容量数字为 mock 回环（口径与限制见 capacity-baseline v0.2 §8），非真机性能。
- Jev 决策后端无真实 endpoint/key，未真机核对（代码注释与 fallback 已标注）。
- 未跑 `npm audit`；真机封臣行为无法在本机验证。

---

## 1. 验证基线（v0.1 原始快照，2026-09-22；现行基线见上方 v0.4-A）

| 项 | 结果 | 说明 |
|---|---|---|
| 全量测试 | **124/124 绿（16 文件）** | 首轮并行出现 1 例超时（acceptance-script「无 BASE_URL 退出 1」，5s 窗口不足）；单独重跑 3/3 过，第二轮全量 124/124 过。**判定为并行负载抖动，非功能缺陷**（脚本手动复现 exit 1 + [FAIL] 正确） |
| typecheck | ✅ `tsc --noEmit` exit 0 | |
| build | ✅ `tsc -p tsconfig.build.json` exit 0，dist/ 完整（含 .d.ts/.map） | |
| 运行入口 | `npm start`（node dist/http/serve.js）可用 | 仅 H1 三端点（healthz / roster public 签名快照 / internal bearer） |
| 部署产物 | **无** Dockerfile / launchd / systemd / Procfile / 编排脚本 | 仅 `scripts/acceptance-standard-a2a.mjs`（验收脚本，非部署） |
| 推送状态 | dev 领先 origin/dev 8 commit，未 push | 需用户授权 |

## 2. 功能性评审（PRD v0.3 逐条核对）

### P0 需求覆盖总览：26 条 → 13 ✅ / 11 🚧 / 2 ⬜

| Epic | P0 项 | ✅ | 🚧 | ⬜ | 核心结论 |
|---|---|---|---|---|---|
| E1 并发决策内核 | 1.1–1.6（6 条） | 1 | 5 | 0 | **核心闭环成立**：fan-out/join、合并流、幂等、cancel 传播、规则聚合、冲突检测+onConflict 全部库内落地（26 项测试）；缺项均为"增强形态"（完整 DAG、LLM 裁决、决议反馈、背压） |
| E2 Skill 技能体系 | 2.1/2.2/2.4（3 条） | 0 | 2 | 1 | **最弱 Epic**：仅 Agent Card 携带 skills 字段 + findBySkill 选人；独立 Skill 规格、注册中心（E2.2 ⬜）、多技能组合全缺 |
| E3 Realm 数据域 | 3.1–3.3（3 条） | 3 | 0 | 0 | 数据主权底座完整（connect/manifest/search/read + digest + 穿越防护） |
| E4 封臣联邦 | 4.1–4.8（8 条） | 7 | 1 | 0 | 协议闭环最扎实：注册/fealty/派发/战报/升级/二极管/吊销/审计全绿；仅 E4.8 真机执行待部署 |
| E5 HTTP 门面 | 5.1/5.2（2 条） | 2 | 0 | 0 | public/internal 双投影 + 签名快照 + 鉴权齐备 |
| E6 监督台 | 6.1/6.2（2 条） | 1 | 0 | 1 | 升级队列 approve/reject 已落地；**冲突决议反馈到聚合（E6.2）未做**——冲突已能进监督台，但拍板结果不回写决策 |
| E10 平台工程 | 10.1/10.3（2 条） | 2 | 0 | 0 | CI 矩阵 + 库公共入口 + 构建产物齐备 |

**P1/P2 快照**：E1.7 可观测 ⬜、E2.3 安装/加固 ⬜、E3.4 MCP 正式暴露 🚧(stdio)、E3.5 write ⬜、E4.9 签名链生产 ⚠️（纯函数+H1 已接，**生产 RSK 密钥与 R1/R2 接线未做**）、E5.3 持久化 ⬜、E5.5 H2 ⬜、E8 情感层全部 ⬜、E9 企业层全部 ⬜。

### 与设计文档一致性抽查

- design-fan-out §7 边界（不做 DAG/持久化/硬 abort/SSE/LLM 裁决/背压）与 PRD 状态一致 ✅
- design-vassal-protocol §7 六项验收：1–5 库内达成，**第 6 项（纯标准客户端真机）待部署** 🚧
- design-http-transport §5 H1 验收全部通过（含"内核 grep 不到 fastify"硬约束）✅
- design-decision-backend v0.2（模型无关决策层）：**纯设计，src/decision/ 不存在**——不构成 MVP 阻塞（它是增强，非 P0 路径）
- handoff「124 绿」记录与本机实跑一致 ✅（抖动除外）

## 3. 完整度评审（里程碑视角）

| 里程碑 | 出口标准 | 状态 | 判定 |
|---|---|---|---|
| **M1 内核基座** | E3.1–3.3、E4.1–4.7、E5.1–5.2、E6.1、E10.1/10.3 | **全部库内落地**，测试验证通过 | ✅ **达成** |
| **M2 并发决策内核** | E1.1–1.6、E2.1/2.2/2.4、E10.4 | E1 核心落地、E2.1/2.4 部分、**E2.2 ⬜**、E10.4 容量基线未做 | 🚧 **核心达成，两项缺口** |
| **M3 真机闭环** | E4.8、E10.2、Zeus↔loom 联调、E5.3 | **全部未做**：无部署编排、无真机、无持久化 | ⬜ **未启动** |

## 4. 可上线性评审（上线阻塞项，按严重度）

### 🔴 硬阻塞（缺任一即不可上线）

1. **无部署形态**：无 Dockerfile / 服务管理 / 编排；`npm start` 仅裸进程。连"跑起来"都没有标准姿势。
2. **状态全为实例内存**（E5.3）：registry / 在途任务 / 升级队列 / 幂等表重启即失。重启 = 治理闭环空洞（吊销目录、升级队列丢失），违反 design-http-transport §2.2 对长驻形态的论证前提。
3. **E2.2 Skill 注册中心缺失**：PRD 明示 P0，产品核心叙事（"按技能组队"）的登记面缺失；目前组队只能靠 findBySkill 全选 + 显式名单。
4. **E6.2 决议反馈闭环缺失**：冲突能升级、驾驶员能 approve/reject，但**决议不回写聚合、无补参重派**——决策闭环断在最后一环。
5. **签名链生产密钥未落地**（E4.9）：public 名册封签目前用临时内存钥（serve.ts stderr 告警）；对外可信发布（bayjf 封神榜）前置缺失。

### 🟡 软阻塞（上线前建议，容忍度低）

6. **E4.8 真机验收未执行**：协议第 6 项守护测试（纯标准 A2A 客户端真机调用封臣）从未真机跑过——超集协议"不是闭墙"的承诺无真机证据。
7. **Zeus↔loom / pr-helper 真机联调未做**：所有测试基于 mock/fixture，无一次真实 HTTP 双向。
8. **E1.7 可观测缺失**：无在途任务数/延迟/失败率指标，上线后无法回答"系统健康吗"。
9. **dev 领先 8 commit 未 push**：CI（GitHub Actions）从未真实触发过——本地按 CI 序列跑过，但云端无一次绿。

### 🟢 非阻塞（增强项，可后置）

- 决策后端抽象层（Jev/LLM）——设计已定，工程切片可后置；
- E8 情感层 / E9 企业层 / E7 MCP 连接器——P1/P2，明确不在 MVP；
- 完整 DAG / LLM 裁决 / 背压 / SSE 服务端——PRD 已列为后续。

## 5. MVP 判定

**定义**（按 PRD 里程碑语义 + product-portrait 核心定位"一意图扇出多 Agent 并行、聚合为可追溯决策"）：

- **库内内核级 MVP（可演示）**：✅ **已达成**——M1 全部 + M2 核心（E1.1–1.6 落地、冲突经 onConflict 进监督台、124 测试绿、typecheck/build 过）。单意图多 Agent 并发 + 聚合 + 冲突升级 + 拍板（approve/reject）在库内可完整走通。
- **产品级可上线 MVP（可交付真实用户）**：❌ **未达成**——M3 真机闭环整条缺失（部署/真机/持久化）+ 两个 P0 缺口（E2.2、E6.2）+ 签名链生产密钥 + 可观测。当前产物是一个**测试充分、设计严谨的内核库**，不是可运行服务。

**一句话**：Zeus 的"内核"达到了 MVP，Zeus 的"产品"没有。

## 6. 达到可上线 MVP 的最小路径（建议排序）

| 序 | 工作 | 解锁 |
|---|---|---|
| 1 | **E2.2 Skill 注册中心**（登记/检索/版本化，库内 + 测试） | 补齐 P0 唯一 ⬜ |
| 2 | **E6.2 决议反馈闭环**（approve 决议回写聚合、补参重派骨架） | 决策闭环最后一环 |
| 3 | **E5.3 持久化最小版**（registry + 在途 + 升级队列 + 幂等表 JSON/文件落地） | 重启不丢，治理闭环无空洞 |
| 4 | **部署形态**（Dockerfile + env 装配 + 健康检查接线） | "能跑起来"的标准姿势 |
| 5 | **E4.8/E10.2 真机闭环**（部署 pr-helper → 真机跑验收 #6 → loom 联调） | 超集协议真机证据 |
| 6 | **E4.9 生产 RSK 密钥方案**（KMS/文件 + 轮换） | public 名册可信发布 |
| 7 | **push dev → CI 首绿**（需用户授权） | 云端回归防线生效 |

完成 1–4 后即为"可部署的 MVP 内核"；完成 5–6 后为"可信可上线的 MVP"。

## 7. 评审证据与限制

- 证据：PRD v0.3 全文逐条、product-portrait v0.4、handoff 2026-09-22 全文、10 份 design-*.md、src/ 25 个 TS 文件（约 2700 行）、tests/ 16 文件 5320 行、package.json、实跑验证输出。
- 限制：① 未运行 HTTP 进程级端到端冒烟（仅靠 7 项 inject 测试证据）；② 未执行压测（E10.4 本身未做）；③ 未审查依赖漏洞（npm audit 未跑）；④ 真机行为（封臣部署）无法在本机验证。以上均如实标注，不掩盖。

## 8. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首次项目级评审：功能性/完整度/可上线三维度 + MVP 判定（内核级达成、产品级未达成）+ 阻塞项与最小路径 |
| v0.2 | 2026-09-22 | 六切片批次后销项批注：E2.2/E6.2 硬阻塞销项、E5.3/E1.7 大幅缓解（库内落地、装配/HTTP 待接线）、S3 DAG 与决策后端落地；产品级 MVP 判定不变（部署形态/生产密钥/真机/push 仍阻塞）；基线升至 166 测试 / 22 文件 |
| v0.3 | 2026-09-22 | A 批次（G1/G4/G5/G6）销项批注：封臣上线入口、Realm 连接持久化与 boot 恢复、approve-resume 补参重派、H3 服务端 SSE；基线升至 217 测试 / 31 文件；产品级 MVP 仍未达成 |
| v0.4 | 2026-09-24 | 刷新为现行评审（436 测试 / 52 文件，tsc/build 过，容量四场景）：库内增量含记忆/Vault/replay/judge/E3.5/Diary/Org、签名链 v1.1 internal 封签、容量场景 C/D；核查到 Dockerfile + deployment.md + RSK 密钥工具 + 持久化/优雅关闭接线，v0.1 五硬阻塞在代码/制品侧均已有对应物；**重判：M1/M2 达成、M3 制品就绪真机未验，库内已无 P0 功能缺口，产品级上线仅剩仓库外真机/凭证/发布动作** |
