> 状态：**现行 v0.1**（2026-10-17 建立：面向 Agent 浏览器 E2E 的核心功能验证手册；命令与读数以仓库 README §2、package.json scripts 与本机实测为准——全量 2035 测试 / 176 文件（Active work 250 批后现行口径）、冒烟 50/50、eval 31 例 / 56 checks、doc-consistency 18/18）

# Zeus 浏览器 E2E 功能验证手册

用途：让 Agent 用浏览器对 Zeus 做端到端功能验证。每条验证 = **操作 → 预期 → 判定**，判定通过才记通过；失败按 §5 诊断表排查。

## 0. 前置与基线

- 环境：Node.js ≥ 22（package.json `engines` 强制，.npmrc `engine-strict`）。
- 构建：`npm install && npm run build`（所有验证脚本跑 dist/ 出货件，必须先 build）。
- 基线读数（2026-10-17 Active work 250 批后本机实测）：`npm test` 2035 项 / 176 文件 / 0 失败；`npm run smoke:core` 50/50；`npm run evals` 31 例 / 56 checks；doc-consistency 18/18；typecheck/build/lint exit 0。

## 1. 会话启动（固定流程）

终端 A — 内核常驻服务（8787，需 bearer 的操作面随之挂载）：

```bash
ZEUS_INTERNAL_TOKEN="$(openssl rand -hex 24)" \
ZEUS_STATE_FILE=./data/kernel-state.json \
ZEUS_AUDIT_FILE=./data/audit.jsonl \
ZEUS_REALM_ROOTS=/path/to/your/dir \
ZEUS_CORS_ORIGINS=http://127.0.0.1:5173 \
npm start
```

终端 B — 参考执行体（打印一个可复制的 card url，端口以脚本输出为准）：

```bash
npm run agent:example
```

终端 C — Web 监督台静态页：

```bash
python -m http.server 5173 --directory web
```

浏览器 → 打开 `http://127.0.0.1:5173/supervisor/index.html` → 「连接」视图：

| 操作 | 预期 | 判定 |
|---|---|---|
| `cBase` 填 `http://127.0.0.1:8787`，`cToken` 填启动时的 token，点「保存并测试」 | 状态徽标由「未连接」变「已连接」；无 CORS 报错 | 徽标与 toast 通过；cBase/cToken 只存浏览器 localStorage，不写内核状态文件 |

## 2. 核心功能验证

### 2.1 一句话闭环（产品入口）

```bash
npm run daily -- "summarize the note" --root /path/to/your/dir --agent http://127.0.0.1:<端口>/api/a2a/agent-card
```

| 操作 | 预期 | 判定 |
|---|---|---|
| 终端跑上面命令 | exit 0；目标目录出现一页 markdown（写回用户自己的目录） | exit 0 且文件存在 |
| 同一目录再跑一次 | 页面带「上一次」那一行（读回自己目录，不进出站载荷） | 第二页出现 previous 行 |
| 浏览器「监控」视图 | 该意图出现，状态 running → settled | 意图行存在且终态 settled |
| 浏览器「审计」视图 | 对应 decision 行出现（refused/injected/settled 等） | 同一条审计可读回 |

### 2.2 数据主权（本地目录即用）

| 操作 | 预期 | 判定 |
|---|---|---|
| `npm run vault -- build --root /path/to/dir --out backups/map.json` | 出清单：只存引用与逐条指纹，不存正文 | 文件生成 |
| `npm run vault -- check --map backups/map.json` | 原地漂移校验只读 | exit 0=无漂移；2=漂移，3=目录不可达 |
| `npm run vault -- backup` 后 `restore --target /restore/dir` | 加密内容包可恢复 | 恢复目录内容可读回 |

### 2.3 签名信任链

| 操作 | 预期 | 判定 |
|---|---|---|
| 浏览器访问公开端点 `http://127.0.0.1:8787/api/roster/keys`（无需 token） | 返回 `kid` + `spkiPem` | 200 且字段齐全 |
| 取名册快照后 `npm run verify:roster -- --file <快照> --key <spkiPem>` | `VERIFIED` | 输出 VERIFIED；篡改载荷 / 陌生钥 / 把 `--now` 推过 maxAge 均拒绝（exit 1） |

### 2.4 监督与治理（Web 监督台重点）

| 操作 | 预期 | 判定 |
|---|---|---|
| 发一个需要裁决的意图（如 execute 模式缺执行委托、或 task-input 升级） | 「裁决」视图徽标 escBadge 计数 +1，队列出现该升级 | 计数与条目出现 |
| 批准或拒绝该升级 | 队列清空；意图以对应终态落定 | 写动作在「审计」视图出现同一行 |

### 2.5 记忆与上下文

| 操作 | 预期 | 判定 |
|---|---|---|
| 完成一个意图后打开「记忆」视图 | facts / recall 出现条目 | `/api/memory/facts` 非空 |
| 再发同类意图 | 出站载荷带 `contextAppendix`/`memory-recall` 来源标记 | 冒烟步 15 等价验证可复现 |

### 2.6 可靠恢复

| 操作 | 预期 | 判定 |
|---|---|---|
| 意图运行中 `kill -TERM <serve pid>` | 内核状态落盘 `kernel-state.json` 0600 | 文件存在且权限 0600 |
| 重启 `npm start` | 名册 / 记忆 / 治理状态恢复 | 日志 `kernel-state-restored`；`/api/roster/keys` 验签仍过；派发照常 |

## 3. Web 监督台九视图核对表（浏览器 E2E 主体）

| 视图 | 操作 | 预期 | 判定 |
|---|---|---|---|
| 监控 monitor | 发一个意图后刷新 | 意图/分支行出现，终态 settled | 行存在且状态正确 |
| 裁决 oversight | 造一个升级 | escBadge 计数 +1 | 批准/拒绝后清空且进审计 |
| 授权 grants | 签发跨域授权 | 授权列表出现条目 | `/api/domains/grants` 读回；吊销后消失 |
| 组织 org | 挂载企业域后查看 | 组织树出现 | `/api/org/chart` 有数据 |
| 目录 catalog | `POST /api/skills` 注册技能 | 技能卡片含 inputs 声明 | 卡片可见 |
| 记忆 memory | 完成意图后查看 | facts/recall 条目 | `/api/memory/facts` 非空 |
| 名册 roster | 注册执行 Agent 后查看 | agent 行 status=active | 快照为签名信封 |
| 审计 audit | 任一写动作后查看 | 对应 decision 行 | `/api/audit` 读回 |
| 连接 connect | 填 cBase/cToken 保存 | 状态徽标已连接 | localStorage 只存本机 |

## 4. 质量回归（验证即证据）

```bash
npm test          # 2035 项 / 176 文件 / 0 失败（含 doc-consistency 18/18 闸门）
npm run smoke:core  # 核心链路真机冒烟 50/50
npm run evals     # 31 例 / 56 checks，十族全绿
npm run typecheck && npm run lint && npm run build   # 各自 exit 0
```

## 5. 失败诊断表

| 现象 | 检查 |
|---|---|
| Web 连接失败 / CORS 报错 | `ZEUS_CORS_ORIGINS` 是否含 `http://127.0.0.1:5173`；cToken 是否与启动时一致 |
| 冒烟或 daily 出现旧行为 | 重跑 `npm run build`（旧 dist 致冒烟步全红是已知坑） |
| 意图无交付（exit 1） | 查「审计」视图 decision；参考执行体是否在跑；`--agent` 是否贴 card url |
| 审计文件权限不符 | 检查数据目录（`ZEUS_AUDIT_FILE` 所在）挂载权限，预期 0600 |
| 验签失败 | 确认 `--key` 用的是 `/api/roster/keys` 返回的 `spkiPem`；快照未过期 |

## 6. 范围与诚实边界

- 本手册验证库内可测项；**可上线 ❌ 的剩余理由全部在仓库外**（E10.2 真机部署与标准客户端验收、RSK 托管与带外公钥公告、bayjf R2 公开、#9 阈值调参），不在本手册覆盖范围。
- 数字口径以本机实测为准；Windows 本机存在环境性失败家族（fsync EPERM / chmod 0600 / symlink EPERM），macOS/Linux/CI 口径为准。
