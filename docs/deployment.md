# Zeus 部署手册（v0.1）

长驻 Node 进程形态：Fastify HTTP 面（`dist/http/serve.js`）装配内核（registry / oversight / dispatcher / orchestrator），启动时从状态文件恢复、优雅退出时落盘。本文覆盖 Docker（推荐）与裸机 systemd 两种形态。

> 当前边界（H1）：进程启动时 registry 为空，**尚无注册写端点**（封臣注册属后续启动编排）；本手册解决"进程可重复、可观测、可恢复地跑起来"，不解决封臣从哪注册。Realm 不挂 HTTP。

## 1. 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 仅 `status/version/ts`，不含封臣与 Realm 信息 |
| `GET /api/roster/public` | 无 | 实时名册投影 + Ed25519 封签（离线可验，1h seal / 24h attestation TTL） |
| `GET /api/roster` | bearer（`ZEUS_INTERNAL_TOKEN`） | 内部全量视图；未配 token 时该路由不挂载（404） |

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZEUS_HOST` | `127.0.0.1` | 监听地址；**容器内必须 `0.0.0.0`** |
| `ZEUS_PORT` | `8787` | 监听端口 |
| `ZEUS_INTERNAL_TOKEN` | 未设置 | 内部名册 bearer；不设则内部路由不挂载 |
| `ZEUS_STATE_FILE` | 未设置 | 内核状态 JSON 路径；不设则纯内存（重启全丢） |
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
docker stop zeus                         # tini 转发 SIGTERM → drain → state saved
docker start zeus                        # 启动日志应见 restored N vassals ...
```

`docker stop` 的 SIGTERM 直接送达 PID 1 的 node 进程，先保存内核状态再退出；下次启动从 `/data/kernel-state.json` 恢复（registry 含已吊销封臣、监督台队列、意图幂等表）。

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
- [ ] `ZEUS_STATE_FILE` 指向持久卷，`docker stop`/重启后日志出现 restored
- [ ] 端口默认只绑 loopback，TLS 在反向代理终止
- [ ] `/healthz` 与 `/api/roster/public` 封签经独立通道验签通过
- [ ] 真机验收 #6（标准 A2A 客户端打封臣）与 Zeus↔loom 联调已过（见 handoff Active work）
