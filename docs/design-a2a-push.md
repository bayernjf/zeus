# A2A push notification 接收侧（E4.11）

状态：现行（2026-10-14 裁定后实施）。方案裁定记录见 handoff Active work 232/233（判退 `--detach` 取回路；A2A push 接收端 / 产品入口指向运行中内核二选一，2026-10-14 用户裁定走 **A2A push 接收端**，PRD 原样）。

## 目的

PRD E4.11（P1，原 ⬜）：`tasks/send` 可携带 `pushNotificationConfig`；Zeus 提供 bearer 保护的回调接收端点，按 `taskId` + 状态幂等，回调写进同一条审计链并落进意图表/E6.1 队列；SSE 与轮询路径行为不变；未配置接收密钥时端点不挂载（与 `internalToken` 同一约定）。

登记依据（2026-10-13 实测）：`src/a2a/types.ts:33` 只有能力位 `capabilities.pushNotifications`，全库对 `pushNotificationConfig`/回调端点零命中；`npm run daily` 分支超时默认 60s，长任务超时后一次性入口拿不到结果。

## 语义

- **接收侧**：执行 Agent 在长任务完成后，把终态 `Task` 快照 POST 回 Zeus 的回调端点。Zeus 不轮询、不常驻订阅该分支时，靠 push 收结果。
- **出站**：派发时若请求显式选择 push，`tasks/send` 消息携带 `pushNotificationConfig`（接收地址 + 可选 token）。
- **选择是显式的**：`FanOutRequest.pushNotification: true` 才武装该意图的全部分支；缺省 = 现行 `sendSubscribe` 流式路径，SSE 与轮询行为不变。
- **分类复用流式路径**：push 落定的终态 Task 走与流式结算完全相同的分类（`input-required` → `onTaskInput` 进 E6.1 队列；`failed` → 分支失败；其余 → ok），聚合/意图表/AUDIT 沿用现有装配，不另开一条决策路径。
- **幂等**：按 `taskId` 幂等（首个落定为准）。同 taskId 的后续回调返回 `idempotent: true`，不二次落表、不重复升级。
- **未知 taskId**：bearer 已验仍不认识的 taskId 是异常（不是传输噪声），审计 `push-notification-refused` 后返回 404。
- **fail-closed**：请求要求 push 但未配置接收地址 → 意图被拒（`push-unconfigured`），不静默降级成流式。
- **超时/取消**：分支超时覆盖 push 等待；超时后按 ack taskId 背景 cancel（plain `tasks/send` 的 ack 即 taskId，比流式超时“无 taskId 可取消”更可取消）。

## 接线

| 层 | 位置 | 改动 |
|---|---|---|
| 类型 | `src/a2a/types.ts` | `PushNotificationConfig { url; token? }`；Task 消息携带 `pushNotificationConfig` |
| 出站客户端 | `src/dispatch/client.ts` | `SendTaskInput.pushNotification?` → 消息根字段 `pushNotificationConfig`；armed 分支走 `tasks/send`（无订阅） |
| 派发器 | `src/dispatch/dispatcher.ts` | `DispatchRequest.pushNotification?`；armed 时 `sendTask` 而非 `sendTaskSubscribe` |
| 编排器 | `src/core/orchestrator/orchestrator.ts` | `pushReceiver?` 选项；`receivePushNotification(task)` 公开方法；`pushWaiters`（taskId→resolve）+ `pushProcessed`（幂等） |
| HTTP | `src/http/server.ts` | `POST /api/a2a/push-notifications`，`requireBearer`，`internalToken` 未配不挂载，`deps.orchestrator` 缺失不挂载 |
| 装配 | `src/state/boot.ts` + `serve.ts` | `ZEUS_A2A_PUSH_URL` → `pushReceiver`（token 同 `ZEUS_INTERNAL_TOKEN`） |
| 审计 | `src/dispatch/dispatcher.ts` | 新决策 `push-notification-received` / `push-notification-refused` |

## 审计决策

- `push-notification-received`：每次被接受的 push（含幂等重放，detail 标 `idempotent`），带 runId/vassal/skill/realm/taskId/state。
- `push-notification-refused`：bearer 已验但 taskId 无等待分支（未知 task）。

## 非目标（V1 不做）

- 出站 push 客户端（Zeus 主动向对端投递结果）——那是“发送侧”，本条是接收侧。
- 跨重启恢复：push 等待在内存；重启后未落定分支的处置归属 design-long-running 分类（V2 接线）。
- 对端未实现 push 时的行为：分支走现有超时→取消路径，与今天一致。
