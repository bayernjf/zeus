# Zeus 部署手册（v0.1）

长驻 Node 进程形态：Fastify HTTP 面（`dist/http/serve.js`）装配内核（registry / oversight / dispatcher / orchestrator），启动时从状态文件恢复、优雅退出时落盘。本文覆盖 Docker（推荐）与裸机 systemd 两种形态。

> 当前边界：执行 Agent 可经 `POST /api/vassals`（H2 内部面，bearer 保护）注册，或经 `ZEUS_VASSAL_SEEDS` 启动自动注册；Realm 不挂 HTTP。

## 1. 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 仅 `status/version/ts`，不含执行 Agent 与 Realm 信息 |
| `GET /api/roster/public` | 无 | 实时名册投影 + Ed25519 封签（离线可验，1h seal / 24h attestation TTL） |
| `GET /api/roster` | bearer（`ZEUS_INTERNAL_TOKEN`） | 内部全量视图；未配 token 时该路由不挂载（404） |

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZEUS_HOST` | `127.0.0.1` | 监听地址；**容器内必须 `0.0.0.0`** |
| `ZEUS_PORT` | `8787` | 监听端口 |
| `ZEUS_VASSAL_SEEDS` | 未设置 | G1：启动时自动注册的执行 Agent Agent Card URL，**逗号分隔**；状态快照里已有的 URL 跳过不重复拉取。**某个 seed 拉不到或卡片没发誓 fealty → 整个进程拒启**（一行 `[zeus-http] refused to start: vassal seed failed for <url>: …`），不会静默少一个执行 Agent |
| `ZEUS_INTERNAL_TOKEN` | 未设置 | 内部名册 bearer；不设则内部路由不挂载 |
| `ZEUS_STATE_FILE` | 未设置 | 内核状态 JSON 路径；不设则纯内存（重启全丢）。**写出固定 0600**（内含连接器 bearer token 与记忆事实，且以 uid 1000 落卷） |
| `ZEUS_AUDIT_FILE` | 未设置 | E4.7 派发+治理审计 JSONL 落盘路径；不设则只写 stderr、`GET /api/audit` 不挂载 |
| `ZEUS_AUDIT_MAX_BYTES` | `67108864`（64MiB） | 活动审计文件的轮转阈值；`0`/`off`/`unlimited` = 不轮转（**需自行接 logrotate，否则迟早写满盘**） |
| `ZEUS_AUDIT_KEEP` | `5` | 轮转后保留的旧代数（`<file>.1` … `<file>.<keep>`）；磁盘总上界 = `maxBytes × (keep+1)` |
| `ZEUS_MAX_CONCURRENT_BRANCHES` | 未设置（=无界） | E1.5 进程内在途分支上界（跨意图；一个进程一个 orchestrator）。设了就限流，溢出分支按 `branchQueueLimit` 排队或被拒；**值非法直接拒启**（被悄悄忽略的上限看起来像保护存在） |
| `ZEUS_BRANCH_QUEUE_LIMIT` | 未设置（=等待无限） | 允许排队等槽的分支数；`0` = 不排队，槽满即拒（泄压优先于排队） |
| `ZEUS_REALM_ROOTS` | 未设置 | G4：启动时连接的个人域根目录，逗号分隔；连接参数写进状态文件，重启自动重连 |
| `ZEUS_REALM_ENTERPRISE` | 未设置 | E3.6：企业域挂载，每项 `"<root>::<tenant>"`（tenant 为 `org[/department[/member]]`，如 `/srv/acme-eng::acme/eng`）。**缺 tenant 或写法非法直接拒启**——一个没有边界的企业域等于对整个名册可见；`::` 是因为 Windows 盘符已占用单冒号 |
| `ZEUS_DECISION_BASE_URL` + `ZEUS_DECISION_API_KEY` | 未设置 | S2 critic 仲裁的决策后端（Jev 优先）。**两项同时给出才启用**，缺任一即 `backend: null`、内核退回 rules-only（这是设计好的降级，不是错误） |
| `ZEUS_DECISION_MODEL` | 适配器默认 | 决策模型名，只在上面两项齐时生效 |
| `ZEUS_LLM_BASE_URL` + `ZEUS_LLM_API_KEY` + `ZEUS_LLM_MODEL` | 未设置 | 通用 OpenAI 兼容后端，**三项齐才启用**，优先级低于 `ZEUS_DECISION_*`。这是把裁决发给外部模型的通道——注意数据出境口径 |
| `ZEUS_JUDGE_ENABLED` | 未设置（关） | E1.3 对抗式 judge。**必须有决策后端才生效**：只设它而后端不齐时保持关闭（后端状态看 `GET /api/decision` 或启动日志那一行） |
| `ZEUS_JUDGE_THRESHOLD` | 内置阈值 | judge 采信阈值。⚠️ **非数字值被静默忽略并退回默认阈值**——这与 `ZEUS_MAX_CONCURRENT_BRANCHES` 的"非法值拒启"不一致，已记进评审（review v0.9 §C-8），尚未统一 |
| `ZEUS_JUDGE_ALLOW_UNCALIBRATED` | 未设置（关） | 允许未校准 judge 参与裁决；开启即放弃"先校准再采信"这条防线，只用于实验环境 |
| `ZEUS_RSK_KEY` | 未设置 | RSK 私钥 PEM 全文（Ed25519，PKCS#8） |
| `ZEUS_RSK_KEY_FILE` | 未设置 | RSK 私钥 PEM 文件路径（secret 挂载推荐）；与 `ZEUS_RSK_KEY` 同时存在时内联优先 |
| `ZEUS_RSK_KEY_ID` | `zeus-rsk-dev` | 封签 keyId（验签方按 keyId 找公钥） |
| `NODE_ENV` | 未设置 | `production` 时无 RSK 密钥**拒绝启动**；其他环境降级临时内存钥并 stderr 告警 |

模板见仓库根 `.env.example`。

## 3. RSK 名册签名密钥

公开发布的 `/api/roster/public` 快照由 RSK（Roster Signing Key，Ed25519）封签，消费方（bayjf / 第三方）离线验签。

**生成密钥对**（零依赖，跨平台；容器内同样可用）：

```sh
node scripts/gen-rsk-key.mjs rsk-private.pem
# 产物：rsk-private.pem（私钥，0600，绝不入库）+ rsk-private.public.pem（公钥，0644，分发给验签方）
```

**发布后自检（上线检查清单的一项）**：拿公钥验一次对外名册，确认"离线可验"这条承诺在**这个部署**上成立，而不只是在单测里成立。

```sh
npm run verify:roster -- --url http://127.0.0.1:8787/api/roster/public --key rsk-private.public.pem
```

退出码 0 = 通过；1 = 被拒（stderr 给具体原因：载荷版本不认识 / 摘要不绑定 / 签名不符 / 超出 maxAge / 某条目缺背书）；2 = 参数或 I/O 问题。它走的是**库里同一套验签实现**（`dist/registry/signing.js`），所以先 `npm run build`；这也意味着它同时能挡住"脚本自己实现了一遍规范化、结果两边不一致"那种假通过。

**传入方式**：

- 容器 / systemd 推荐挂载文件 + `ZEUS_RSK_KEY_FILE`（不必把多行 PEM 塞进环境）；
- 或直接 `ZEUS_RSK_KEY="$(cat rsk-private.pem)"`。

**生产守卫**：`NODE_ENV=production` 且两种方式都未提供时，进程启动即失败（exit 1，`RskConfigError`）——避免"重启后所有封签因临时钥而失效"。

**轮换**（v1 单签语义，详见 design-fealty-signing.md §RSK）：换钥即换新 `ZEUS_RSK_KEY_ID`；轮换窗口内验签方需同时持有新旧公钥（按封签内 keyId 选择）。旧私钥停用后旧快照在 attestation TTL（24h）内仍可用旧公钥验。

## 4. Docker（推荐）

镜像为多阶段构建：builder 装全量依赖编译 TypeScript；runner 基于 `node:22-slim`（与 CI Node 22 一致），仅含生产依赖（fastify）与 `dist/`，非 root（uid 1000），健康检查用 node 内置 `fetch`（无额外系统包），状态目录 `/data` 声明为卷。服务不 fork 子进程，node 作为 PID 1 直接接收 SIGTERM 并执行优雅退出（如需僵尸进程收割可加 `--init`）。

### 4.1 构建

```sh
docker build -t zeus:0.1.0 .
```

### 4.2 生成密钥（用镜像内 node，密钥直接落到宿主机目录）

```sh
mkdir -p secrets data
docker run --rm -v "$PWD/secrets:/out" --user "$(id -u):$(id -g)" \
  zeus:0.1.0 node scripts/gen-rsk-key.mjs /out/rsk-private.pem
```

### 4.3 运行

```sh
docker run -d --name zeus \
  -p 127.0.0.1:8787:8787 \
  --env-file .env \
  -v "$PWD/secrets/rsk-private.pem:/secrets/rsk-private.pem:ro" \
  -v "$PWD/data:/data" \
  zeus:0.1.0
```

镜像内已固定 `NODE_ENV=production`、`ZEUS_HOST=0.0.0.0`、`ZEUS_PORT=8787`、`ZEUS_STATE_FILE=/data/kernel-state.json`，因此 `.env` 至少需要：

```dotenv
ZEUS_RSK_KEY_FILE=/secrets/rsk-private.pem
ZEUS_RSK_KEY_ID=zeus-rsk-2026-09
ZEUS_INTERNAL_TOKEN=<长随机串>
```

只对本机暴露时端口绑 `127.0.0.1`；前置反向代理（TLS 终止）再对外。

**卷与密钥文件权限**：容器内进程以非 root 用户 `node`（uid/gid 1000）运行。Linux 宿主机上需让挂载内容对 1000 可读写：

```sh
mkdir -p data secrets
chown -R 1000:1000 data
chmod 600 secrets/rsk-private.pem && chown 1000:1000 secrets/rsk-private.pem
```

（Docker Desktop on macOS/Windows 的文件共享会映射宿主权限，也可在 `docker run` 加 `--user "$(id -u):$(id -g)"`。）

### 4.4 验证与优雅退出

```sh
docker logs -f zeus                      # 启动应见 listening，无 ephemeral 告警
curl -s http://127.0.0.1:8787/healthz
docker inspect --format '{{.State.Health.Status}}' zeus   # healthy
docker stop zeus                         # SIGTERM 直达 PID 1 的 node → drain → state saved
docker start zeus                        # 启动日志应见 restored N vassals ...
```

`docker stop` 的 SIGTERM 直接送达 PID 1 的 node 进程，先保存内核状态再退出；下次启动从 `/data/kernel-state.json` 恢复（registry 含已吊销执行 Agent、监督台队列、意图幂等表）。

### 4.5 docker compose（可选）

```yaml
services:
  zeus:
    image: zeus:0.1.0
    ports: ["127.0.0.1:8787:8787"]
    env_file: .env
    volumes:
      - ./secrets/rsk-private.pem:/secrets/rsk-private.pem:ro
      - ./data:/data
    restart: unless-stopped
    # init: true  # 可选：未来若引入子进程，启用 tini 做 PID 1 信号/僵尸处理
```

## 5. 裸机 systemd（备选）

```ini
# /etc/systemd/system/zeus.service
[Unit]
Description=Zeus HTTP kernel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/zeus
EnvironmentFile=/opt/zeus/.env
ExecStart=/usr/bin/node dist/http/serve.js
Restart=on-failure
User=zeus
# SIGTERM 后内核状态保存很快；留足 drain 时间
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

裸机默认绑 `127.0.0.1`，对外经 nginx/caddy 反代并终止 TLS。部署步骤：`npm ci && npm run build`，配好 `.env`（含 `ZEUS_RSK_KEY_FILE` 与 `NODE_ENV=production`），`systemctl enable --now zeus`，`journalctl -u zeus -f` 看日志。

## 6. 上线前检查清单

- [ ] RSK 私钥经文件挂载提供，`ZEUS_RSK_KEY_ID` 带日期/版本；公钥已交付验签方
- [ ] `NODE_ENV=production`，启动日志无 ephemeral 告警
- [ ] `ZEUS_INTERNAL_TOKEN` 为长随机串（或明确不挂载内部路由）
- [ ] `ZEUS_STATE_FILE` 指向持久卷，`docker stop`/重启后日志出现 restored；**状态文件权限为 0600**（内含连接器 token 与记忆事实明文）：`ls -l /data/kernel-state.json`
- [ ] `ZEUS_AUDIT_FILE` 已配置（否则审计只活在 stderr 里，重启即丢）；若把 `ZEUS_AUDIT_MAX_BYTES` 设成不轮转，确认已接外部 logrotate
- [ ] **E3.6 边界自查**：每个企业域挂载都带 tenant；`GET /api/state` 里 `enterpriseRealms == tenantScopedRealms`（不等 = 有企业域没标边界，它只对操作者可达，但迟早被人当成"已经隔离了"）
- [ ] **E6.4 授权自查**：`GET /api/domains` 的 `grants` 逐条读过——无 `expiresAt` 的长期授权必须是有意的；再用 `GET /api/domains/access` 抽查两类必答组合：企业主体读个人域（**必拒**）、未授权的个人侧主体读企业域（必拒）；`GET /api/audit?decision=domain-refused` 看有没有人正在撞边界
- [ ] 端口默认只绑 loopback，TLS 在反向代理终止
- [ ] `/healthz` 与 `/api/roster/public` 封签经独立通道验签通过（`npm run verify:roster -- --url <host>/api/roster/public --key <公钥>`；只看 HTTP 200 不算过——200 只说明服务活着，不说明名册是真的）
- [ ] 真机验收 #6（标准 A2A 客户端打执行 Agent）与 Zeus↔loom 联调已过（见 handoff Active work）
- [ ] Vault 备份已配置外部调度（cron/systemd timer），并完成一次 restore 演练（见 §7）

## 7. 备份与恢复（Vault CLI，E3.7）

备份清单与恢复协议经零依赖 CLI 执行（`dist/vault/cli.js`，或 `npm run vault -- ...`）。**内核不内置定时器**：备份动作由用户或系统调度器（cron/systemd timer）触发，这是 design-vault.md 的明确边界（自动/云端备份为非目标）。

密钥（二选一，绝不作为位置参数出现在进程列表里）：

- 口令：环境变量 `ZEUS_VAULT_PASSPHRASE`（scrypt 派生；可用 `--passphrase-env` 改变量名）
- raw key：`--key-file` 指向 32 字节原始密钥或 64 位 hex 文本

| 子命令 | 作用 | 产物 |
|---|---|---|
| `build --root <dir> --out <map.json>` | L0 出图：逐 item 指纹，正文零泄漏，密封落盘 | 加密 map（manifest-only） |
| `check --map <map.json> [--json]` | L0 原地校验：重连 root 现盘对账，只读不改 | ok/changed/missing/unexpected 报告 |
| `backup --root <dir> --out-dir <dir> [--name s]` | L1 全包：加密 map + 加密内容包（map 挂 bundleRef 绑定） | `<name>.map.json` + `<name>.bundle.json` |
| `restore --map <m> --bundle <b> --target <dir>` | L1 跨位恢复：校验包与图 digest 一致后写盘并复验 | 恢复报告 |

退出码（供调度器判断）：`0` 健康/可恢复 · `1` 用法/密钥/解密/IO 错误 · `2` 漂移（changed/missing/unexpected/digest 不符）· `3` root 不可达。

每日备份 + 漂移校验（cron 示例，口令经受限权限的 env 文件注入）：

```cron
# /etc/cron.d/zeus-vault：每日 03:17 全包备份，03:30 原地校验
17 3 * * * zeus set -a; . /opt/zeus/.vault-env; set +a; cd /opt/zeus && node dist/vault/cli.js backup --root /data/realm --out-dir /var/backups/zeus
30 3 * * * zeus set -a; . /opt/zeus/.vault-env; set +a; cd /opt/zeus && node dist/vault/cli.js check --map /var/backups/zeus/latest.map.json || logger -t zeus-vault "drift detected"
```

恢复演练（灾备流程）：

```bash
# 1. 用最近一次全包恢复到新位置（包与图 digest 不符会被拒绝）
node dist/vault/cli.js restore --map backups/vault-xxxx.map.json \
  --bundle backups/vault-xxxx.bundle.json --target /data/realm-restored
# 2. 退出码 0 且报告 recoverable: true 后，再切换挂载
```

备份**内核状态文件**（`ZEUS_STATE_FILE` 指的那个文件：容器内是 `/data/kernel-state.json`，内容是名册、记忆事实、连接器声明含 token、部门编制、授权台账）走文件白名单——它在每个已连接 Realm 之外：

```bash
# 宿主机上（把 $STATE_DIR 换成 ZEUS_STATE_FILE 所在目录，文件名以 basename 为准）
STATE_DIR=$(dirname "$ZEUS_STATE_FILE"); STATE_NAME=$(basename "$ZEUS_STATE_FILE")
node dist/vault/cli.js backup \
  --files-root "$STATE_DIR" --files "$STATE_NAME" \
  --out-dir backups --name state
node dist/vault/cli.js check --map backups/state.map.json   # 文件没了 → 退出码 2（漂移，可用包恢复）
node dist/vault/cli.js restore --map backups/state.map.json \
  --bundle backups/state.bundle.json --target /恢复目录
```

容器内同理，只是路径换成 `/data/kernel-state.json`（`docker exec` 进去跑，或把 `/data` 卷挂出来再跑）。

白名单**逐个点名**、绝不目录遍历：指向整个数据目录会把无界增长的 `audit.jsonl` 与 `.tmp` 一起卷进备份。点名的文件缺失/是软链/是二进制 → 出图即拒（静默漏掉你要的那个文件比没有备份更坏）。**所以别把文件名写死在脚本里猜**——照上面用 `basename "$ZEUS_STATE_FILE"`，它由 `ZEUS_STATE_FILE` 决定，`.env.example` 与镜像里默认都是 `kernel-state.json`。

注意：map 内 root 为绝对 realpath（仅密封态保存，打开后重连用）；内容包与 map 均为 AES-256-GCM 加密，错误口令或任何篡改都解密失败。**密钥丢失 = 数据永久丢失，无托管后门**（见 design-vault.md §9 非目标）。
