# 数据留存期声明（T-C1-03）

> 状态：草案（留存数字待 owner 确认）
> 关联：`docs/backup-restore.md`（备份/恢复 runbook）、`docs/audit-report.md`（审计链验签口径）、
> `docs/design-intent-retention.md`（意图记录的封顶设计稿，**不是**本声明的对象）。

## 1. 范围

本声明覆盖 zeus 两类「会随时间线性增长」的持久化数据：

| 数据 | 载体 | 性质 |
| --- | --- | --- |
| 签名审计链 | `ZEUS_DECISION_AUDIT_FILE`（默认 `audit.jsonl`） | append-only，删一条即断链 |
| 备份快照 | `./data/backups/snapshot-*` | 可滚动删除 |

业务表（决策/审批/组织/部门/岗位/任务等）的删除权属 **T-C1-02（数据主体导出/删除，DSAR）**，
不在本声明范围。

## 2. 签名审计链：全量保留，不删除

审计链不是「日志」，是「不可篡改」这一产品承诺的载体，因此它的留存口径和普通日志不同：

- 每条记录 `seq` 连续、`prevHash` 链接前一条，服务每次打开时全量验签；
  删除或篡改任意一条 → `VERIFY_FAILED`（`seq discontinuity` / `hash mismatch`），
  进程 fail-closed 拒绝继续写入。
- 所以**不存在「按天 / 按期删除审计 JSONL」**的合法做法：删旧条目等于亲手打断验签链。

留存口径（建议）：

- **在线全量保留**（现状即如此：`src/app/audit/jsonl-chain-store.ts` 只 `appendFileSync`，
  无任何 truncate / rotate / prune）。
- 若未来磁盘增长成为约束，正确做法是**分段归档**——把已封口的旧链段整体移入
  append-only 冷存（归档段同样可验签），而不是按天删除。该机制当前未实现，
  触发条件另行决策（见 `docs/design-intent-retention.md` §5 的同类触发思路）。

## 3. 备份快照：保留 N 份，滚动删除

- 现状：`scripts/backup.mjs --keep N`，默认 **7 份**；每日一轮；超出保留份数的最老快照
  在备份末尾自动删除（`pruneSnapshots()`，oldest-first）。
- 建议口径：**保留 30 份**（≈ 30 天滚动），在「loom 备份 7 天」与「更久可回滚」之间取平衡。
  **数字待 owner 确认。**

## 4. 超期删除在哪一步执行

| 数据 | 删除执行点 | 触发方式 |
| --- | --- | --- |
| 审计链 | 无（append-only，不删除） | — |
| 备份快照 | `scripts/backup.mjs` 末尾 `pruneSnapshots()` | 每次备份自动，oldest-first |

## 5. 误删如何发现

- **审计链**：服务每次打开时验签；`VERIFY_FAILED at seq N — seq discontinuity / hash mismatch`
  即证明被删/被改。可独立用公钥复核（见 `docs/audit-report.md`，仅用公钥即可验）。
- **备份快照**：`scripts/restore.mjs` 恢复前跑 `PRAGMA integrity_check`，损坏/缺失 fail-closed、
  不覆盖；定期恢复演练（`docs/backup-restore.md` §5）。备份命令每次输出 `copied:` / `missing:`
  两个清单，缺项即暴露不完整备份。

## 6. 待 owner 确认的数字

| 项 | 建议值 | 现状 | 备注 |
| --- | --- | --- | --- |
| 签名审计链 | 全量保留（不删除） | 全量保留（不删除） | append-only 验签的硬约束 |
| 备份快照 | 30 份 | 7 份 | 可改，改 `--keep` 即可生效 |
