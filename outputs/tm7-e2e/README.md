# T-M7-02 real end-to-end evidence

Date: 2026-10-24 (Asia/Shanghai). Zeus on `http://127.0.0.1:8791` (SQLite `/tmp/zeus-e2e2.db`,
`taskExecutor=agent-world`, `actionStore=sqlite`). Agent-world on `http://127.0.0.1:3027`,
`WORKER=fake` (model calls fabricated; graph engine genuinely runs), branch `dev`.
Local webhook receiver on `127.0.0.1:3029/cs-notify` (`webhook-receiver.mjs`).

## Three real agent-world runs (verified on agent-world `/api/runs/:id/timeline`)

| Workflow | Zeus task | Template | agent-world runId | Final | Checkpoint | Artifacts |
|---|---|---|---|---|---|---|
| content | task-mvlgzr1t-0qdv4 | tpl-xiaohongshu | `a6f5c0e5-9294-4dac-ad02-cf1a2b291983` | done | D0 (auto) | 8 (text+image) |
| listing | task-mvlgzr28-1zcy3 | tpl-review-publish | `0161d333-6de4-4328-bde4-d7017b13f438` | done | D3 (human-jdbwu→approved→resume) | 5 |
| after-sales | task-mvlgzr2o-26o89 | tpl-customer-service | `2e24c1ed-2818-4c59-9c1a-5b429a8fda5e` | done | D2 (humanR-67oid→approved→resume) | 5 |

## Checkpoint / resume ledger

- listing decision `dec_mvlh043p_1`: grade **D3**, impact=external, reversibility=irreversible,
  idempotencyKey `task-mvlgzr28-1zcy3:human`, approved by ops-lead → task resumed → done.
- after-sales decision `dec_mvlh04if_2`: grade **D2**, impact=org, reversibility=hard,
  idempotencyKey `task-mvlgzr2o-26o89:human`, approved by ops-lead → task resumed → done.
- Both tasks transitioned `pending→dispatched→running→awaiting_decision→running→done`
  (see `task-*.json` transitions arrays).

## Fail-closed evidence

- Position "No-Tool Grunt" (`pos:org:tm7-e2e-org:ng`) granted **no** agent-world tools and no
  credential refs. Its task `task-mvlgzr36-3trb1` settled as `failed / failedKind=tool_denied`
  (zero agent-world channel calls; see `task-task-mvlgzr36-3trb1.json`).

## Notify / webhook

- `webhook.log` records two real POSTs from agent-world: the listing review card ("送审通知")
  and the after-sales completion card ("通知用户 / 工单处理完成").

## Files

- `task-task-*.json` — full OrgTask records (result, progress stages, transition ledger).
- `decisions.json` — the D2/D3 checkpoint records.
- `webhook.log` — recorded notify POSTs.
- `zeus-server.log` — boot line showing `taskExecutor:agent-world`, `baseUrl:http://127.0.0.1:3027/`.

## T-M7-04 judgment: NOT TRIGGERED

Question: can agent-world not carry any of the three cross-system multi-step approval flows,
such that zeus needs an external atlas-style multi-hop approval engine?

Reasoning:
- content (`tpl-xiaohongshu`) is fully automatic — no human node at all, single-system.
- listing (`tpl-review-publish`) pauses at exactly one `human` node and resumes via
  `POST /api/runs/:id/resume {action:approve}` — native single-node halt/resume.
- after-sales (`tpl-customer-service`) branches to `autoReply` or one `humanReview` node,
  then a notify webhook (outbound notification, not an approval) — again a single
  native checkpoint.
- In every workflow there is at most ONE human checkpoint per run, native to agent-world.
  zeus only surfaces it as a D2/D3 ledger decision and forwards the approve; no chained,
  cross-system, two-phase, or multi-hop (maxDecisionHops > 1) approval is exercised or
  required by these three templates.

Conclusion: no flow exceeds agent-world's native halt/resume. No atlas adapter is built
under T-M7-02. T-M7-04 remains "not triggered" for the current three-template scope;
re-open only when a workflow introduces a second external approval hop across systems.
