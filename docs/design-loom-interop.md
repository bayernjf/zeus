# Zeus ↔ loom 联调运行手册（出站 A2A 真机验证）

- 状态：现行（2026-10-08）
- 关联：`docs/pre-launch-checklist.md` 行 A3（Zeus↔loom 真机联调）、里程碑 M3
- 脚本：`scripts/acceptance-loom-interop.mjs`（npm script `acceptance:loom`）

## 目标与验收口径

A3 行的判据是「用 loom 的 endpoint / agent-card 跑通一次双向 A2A」。**已于 2026-10-08 对隔离真机实例实跑销项**：`--sse-test --revoke-test` 全 18 步 PASS、exit 0、`x-zeus-report` 原文回传（见「销项证据」）。

## 对端契约（loom Q150，已核）

- 卡片端点：`GET {LOOM_URL}/.well-known/agent-card.json`、`GET /api/a2a/agent-card`（后者兼容路径）
- 任务端点：`POST {LOOM_URL}/api/a2a/tasks`，JSON-RPC 面：`tasks/send`、`tasks/sendSubscribe`（SSE）、`tasks/get`、`tasks/cancel`
- 卡片字段：`name=loom`、`url={LOOM_PUBLIC_BASE_URL}/api/a2a/tasks`（绝对地址，需 loom 侧 `public_base_url` 配置生效）、`capabilities.streaming=true`、`authentication.schemes=["bearer"]`
- 技能（全 advisory plan-only，不触链、不花 token、不越人工闸）：`Plan content generation` / `Plan compliance cleaning` / `Plan effect feedback backfill`
- 鉴权：loom Agent Key（Q88 复用），Bearer 头
- 审计：tenant=`_platform`；plan 模式只读

## 前置条件

| 项 | 值 |
| --- | --- |
| Zeus 实例 | 本机 dev 实例（`npm run build && npm start`，`KERNEL_URL=http://127.0.0.1:8787`），`data/internal-token` 就绪 |
| loom 实例 | loom 后端（uvicorn `backend/app`，`LOOM_URL=http://127.0.0.1:8000`），Agent Key 就绪，`public_base_url` 指向可访问基址（Q280 起 compose 转发该 env） |
| 凭证 | `ZEUS_INTERNAL_TOKEN`（Zeus 内部 bearer）、`AGENT_TOKEN`（loom Agent Key）——脚本永不打印 |

**域与审计前置（2026-10-08 实跑确认）**：loom 卡片声明 `dataRealms=["enterprise"]`，personal 域派发被数据主权边界正确拒绝（`fealty.dataRealms=enterprise excludes personal`，审计 `refused-realm-policy`）——**需 `REALM=enterprise` 且 Zeus 挂企业域**（`ZEUS_REALM_ENTERPRISE="<root>::<tenant>"`，A1 同款场景）；审计断言依赖 `ZEUS_AUDIT_FILE` 配置（未配则 `/api/audit` 路由不注册、404）。

## 用法

```bash
KERNEL_URL=http://127.0.0.1:8799 \
ZEUS_INTERNAL_TOKEN="$(cat data/internal-token)" \
LOOM_URL=http://127.0.0.1:8000 \
AGENT_TOKEN=<loom Agent Key> \
npm run acceptance:loom
```

参数：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `KERNEL_URL` | 必填 | 目标 Zeus 基址 |
| `ZEUS_INTERNAL_TOKEN` | 必填 | Zeus H2 面 bearer |
| `CARD_URL` / `LOOM_URL` | 必填其一 | 卡片地址；给 `LOOM_URL` 时自动派生 `{LOOM_URL}/.well-known/agent-card.json` |
| `AGENT_TOKEN` | 必填 | loom Agent Key |
| `SKILL` | `generate-content` | **loom 执行端认 skill id**（`generate-content`/`compliance-check`/`effect-backfill`），卡片展示名（"Plan content generation" 等）只是公开标签，传给 `tasks/send` 会得到 `unknown skill` → failed（2026-10-08 真机确认） |
| `REALM` | `personal` | 意图域类型；loom 卡声明 `dataRealms=["enterprise"]`，**必须 `enterprise`**（personal 被数据主权边界拒绝） |
| `PARAMS` | `{"tenant_id":…,"product_id":…}` | 技能的具名参数（JSON）；`generate-content` 必填 `tenant_id`+`product_id`，缺失回 `input-required` |

CLI：`--revoke-test`（跑完吊销 loom 注册）、`--sse-test`（额外直接对 loom `tasks/sendSubscribe` 探 SSE 流）、`--timeout <ms>`。**吊销后再跑需先 `POST /api/vassals/loom/reinstate`**（Zeus 吊销语义：revoked 重注册 409，不自动清除吊销）。

## 断言清单（对应脚本步骤）

1. 内核可达（`/healthz`）
2. loom 卡片可取且为 JSON
3. 卡片契约：name=loom、url 绝对且指向 `/api/a2a/tasks`、streaming=true、bearer 鉴权、三个 plan 技能齐全
4. （`--sse-test`）`tasks/sendSubscribe` 返回 SSE 事件流
5. loom 注册进 Zeus（card fetched、fealty validated）→ 名册 active
6. 三个读视图不回声 loom 凭证
7. 派发 plan 意图 → 终态在超时内、分支回传、artifact 带内容、`x-zeus-report` 为 plan 文本（执行型判据，立场聚合显式 SKIP）
8. 审计含 dispatched + 终态事件
9. （`--revoke-test`）吊销 loom

## 销项证据（2026-10-08 实跑）

隔离真机栈：一次性 PG16（`pgvector/pgvector:pg16`，宿主 5549）+ 一次性 Redis（6380）+ loom backend（uvicorn，8000，`LOOM_PUBLIC_BASE_URL=http://127.0.0.1:8000`，迁移到 head `0052_pool_options`，Agent Key 经 `issue_key` service 直插一次性库）；Zeus dev 实例（8787，`ZEUS_AUDIT_FILE=/tmp/zeus-audit.jsonl`，`ZEUS_REALM_ENTERPRISE="/tmp/zeus-ent::zeus-interop"`）。跑完即删，loom 开发栈（`infra-postgres-1`/`infra-redis-1`）零接触。

`npm run acceptance:loom`（`REALM=enterprise --sse-test --revoke-test`）**18/18 PASS、exit 0**：
- 卡片契约 7 步全过（name=loom、url 绝对指向 `/api/a2a/tasks`、streaming、bearer、三 plan 技能）
- `tasks/sendSubscribe` SSE 事件流（streaming 能力真机确认）
- 注册 201（card fetched、fealty validated、`taskUrl` 由内核读卡片声明 `url` 解析——deferred #29 修复在 loom 上再确认）、名册 active、三视图不回声凭证
- `generate-content` 扇出 → `completed`、分支 `ok=1/1`、`withContent=1`
- **`x-zeus-report` 原文回传**：`{"summary":"generate-content: plan generated for tenant=loom-interop-…","evidence":["parameters validated: product_id, tenant_id","plan-only: no chain mutation…"]}`
- 审计 `dispatched=2 terminal=2`（终态在 dispatch 条目 `state=completed` 内，非独立决策行——2026-10-08 真机确认的审计模型）
- 吊销 `vassal-revoked` 200；重注册被 409 拒（吊销语义正确），`reinstate` 后可再跑

真机暴露并修掉的脚本判据缺陷（均为脚本默认值/解析，非 Zeus/loom 缺陷）：
1. `SKILL` 默认用卡片展示名 → 应为 skill id `generate-content`（`unknown skill` failed）
2. `PARAMS` 默认问题形 → 应为 `{tenant_id, product_id}`（缺参 `input-required`）
3. 审计解析字段 `events` → `entries`，终态匹配 `decision=ended/completed` → 匹配 dispatch 条目内 `state`

## 边界（不夸大）

- **本机真机联调已销项**；「可上线」口径仍以 `docs/review-mvp-2026-09.md` 为准（仓库外动作：真机部署验收 #6、RSK 托管 + 带外公钥公告、bayjf R2 公开等不变）。
- **plan-only**：断言"内容回传"，不断言立场（loom 是执行型）；不触发 loom 链上写操作、不产生 token 消耗。
- **双向**：本脚本覆盖 Zeus→loom 方向（出站 A2A）。loom→Zeus 方向（loom 反向派任务）由 Zeus 入站 A2A 面（`design-inbound-a2a.md`，deferred #19 已销）承接，任一真实上游出现即闭合。

## 变更记录

- 2026-10-08：v0.1 建立（脚本 `acceptance-loom-interop.mjs` + 契约测试 `tests/acceptance-loom-interop.test.ts` + npm script `acceptance:loom`；checklist A3 行由「待外部条件」更新为「库内件已就绪」）。
- 2026-10-08：**v0.2——A3 真机联调实跑销项**：隔离真机栈 18/18 PASS exit 0，`x-zeus-report` 原文回传；补域/审计前置、skill id 口径、销项证据与边界。
