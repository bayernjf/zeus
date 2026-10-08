# Zeus ↔ loom 联调运行手册（出站 A2A 真机验证）

- 状态：现行（2026-10-08）
- 关联：`docs/pre-launch-checklist.md` 行 A3（Zeus↔loom 真机联调）、里程碑 M3
- 脚本：`scripts/acceptance-loom-interop.mjs`（npm script `acceptance:loom`）

## 目标与验收口径

A3 行的判据是「用 loom 的 endpoint / agent-card 跑通一次双向 A2A」。本轮把**库内件**补齐：一个可复跑、输出可粘贴为证据的联调脚本（对齐 A1 先例 `acceptance-real-fanout.mjs` 的模式），加上 loom 契约断言。**脚本入库不等于 A3 销项**——销项仍需 loom 实例在跑时实际执行一次并 exit 0（见「边界」）。

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
| Zeus 实例 | 本机 dev 实例（`npm run build && npm start`，`KERNEL_URL=http://127.0.0.1:8799`），`data/internal-token` 就绪 |
| loom 实例 | loom 后端（uvicorn `backend/app`，`LOOM_URL=http://127.0.0.1:8000`），Agent Key 就绪，`public_base_url` 指向可访问基址（Q280 起 compose 转发该 env） |
| 凭证 | `ZEUS_INTERNAL_TOKEN`（Zeus 内部 bearer）、`AGENT_TOKEN`（loom Agent Key）——脚本永不打印 |

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
| `SKILL` | `Plan content generation` | 目标 loom 技能名 |
| `REALM` | `personal` | 意图域类型（loom 卡片未声明 `dataRealms` 时 personal 即可） |
| `PARAMS` | 最小 plan 参数 | 技能的具名参数（JSON），不传则用默认问题形 |

CLI：`--revoke-test`（跑完吊销 loom 注册）、`--sse-test`（额外直接对 loom `tasks/sendSubscribe` 探 SSE 流）、`--timeout <ms>`。

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

## 边界（不夸大）

- **销项口径**：脚本 exit 0 + 步骤 7 的 `x-zeus-report` 回传才算 A3 真机联调通过；当前缺的是 **loom 测试实例在跑**（本机 8000 无监听，起 loom 属 loom 仓库操作，不在本手册范围内）。
- **plan-only**：断言"内容回传"，不断言立场（loom 是执行型）；不触发 loom 链上写操作、不产生 token 消耗。
- **双向**：本脚本覆盖 Zeus→loom 方向（出站 A2A）。loom→Zeus 方向（loom 反向派任务）由 Zeus 入站 A2A 面（`design-inbound-a2a.md`，deferred #19 已销）承接，任一真实上游出现即闭合。

## 变更记录

- 2026-10-08：v0.1 建立（脚本 `acceptance-loom-interop.mjs` + 契约测试 `tests/acceptance-loom-interop.test.ts` + npm script `acceptance:loom`；checklist A3 行由「待外部条件」更新为「库内件已就绪」）。
