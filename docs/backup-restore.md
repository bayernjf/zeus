# 备份与恢复 Runbook（T-M6-02）

> 配套脚本：`scripts/backup.mjs`、`scripts/restore.mjs`、`scripts/check-file-perms.mjs`。
> 原则：备份必须可恢复才算数；恢复失败 **fail-closed**，绝不静默起空库。

## 1. 备份范围

- 决策/组织持久化 SQLite：`ZEUS_DB_FILE`（七表：decision_policy/records/approvals + organizations/departments/positions/org_tasks）。
- 签名审计 JSONL：`ZEUS_DECISION_AUDIT_FILE`，未显式指定时按 `decision-audit.jsonl` → `audit.jsonl` 的顺序自动探测（服务侧发布的默认名是 `audit.jsonl`）。
- 数据库同目录下**不可重建**的四个文件：`rsk-ed25519.pem`（审计链签名私钥）、`kernel-state.json`、`daily-state.json`、`internal-token`。

四个状态文件的缺失后果必须说清：**私钥丢失**意味着快照里的历史审计再也无法验签，所以私钥不在快照内时备份**直接失败**（守卫生效），只有明确声明"本部署还没生成密钥"时才能用 `--allow-missing-key` 放行；审计文件缺失退化为显式警告，不静默跳过。

## 2. 备份操作

每日一次（建议低峰），保留期可配（默认 7 份；留存期声明建议 30 份，
见 `docs/data-retention.md`）：

```bash
node scripts/backup.mjs \
  --db "$ZEUS_DB_FILE" \
  --state-dir "$(dirname "$ZEUS_DB_FILE")" \
  --dir ./data/backups --keep 7
```

不传 `--audit` 时脚本自动探测审计文件；要指定就加 `--audit "$ZEUS_DECISION_AUDIT_FILE"`。

- SQLite 用 `VACUUM INTO` 产出一致性快照，无需停服。
- 每条命令都会打印 `copied:` 与 `missing:` 两个清单——**备份是否完整要看这两行，不要只看"备份成功"**。
- 产物固定 **0600**（`scripts/check-file-perms.mjs` 核查）。
- 超过保留期的旧快照自动删除。
- 备份目录应与数据卷分离（异盘/异地），避免单点。**快照里含签名私钥，等同于密钥保管级别**。

## 3. 恢复操作（前置）

- [ ] 确认目标进程已停止（避免恢复时被写入）。
- [ ] 选定快照：`./data/backups/snapshot-YYYYMMDDHHMMSS`。
- [ ] 确认快照完整：含 `zeus.db`，且 `PRAGMA integrity_check` 通过（脚本自动执行）。

## 4. 恢复步骤

```bash
node scripts/restore.mjs \
  --snapshot ./data/backups/snapshot-YYYYMMDDHHMMSS \
  --target-db "$ZEUS_DB_FILE" \
  --target-audit "$ZEUS_DECISION_AUDIT_FILE" \
  --target-state-dir "$(dirname "$ZEUS_DB_FILE")" \
  --force
```

- 恢复前先校验完整性；损坏/缺失 → 退出非零，不覆盖、不起空库。
- 恢复出的文件固定 0600。
- 状态文件（私钥/内核状态/日状态/内部令牌）一并恢复：快照里有的都写回。
  **目标位置已存在的状态文件默认跳过**（旧状态覆盖新状态是静默回退）；确实要用快照版本
  时加 `--force`，被替换的旧文件会保留为 `.pre-restore-YYYYMMDDHHMMSS`。

## 5. 恢复后验证（必须跑通）

- [ ] 权限核查：`node scripts/check-file-perms.mjs "$ZEUS_DB_FILE" "$ZEUS_DECISION_AUDIT_FILE"`。
- [ ] 启动进程，`GET /healthz` 200。
- [ ] 数据核对：决策记录、审批、组织、部门、岗位、任务与快照一致；审计链可续验（重启不报 chain 校验失败）。
- [ ] 跑一次 smoke：`npm run smoke:core`（构建后）。

## 6. 失败处理

| 情况 | 处理 |
|---|---|
| 备份 db 缺失 | 不恢复，换更早快照；排查备份任务为何失败 |
| integrity_check 非 ok | 弃用该快照，fail-closed；记录损坏原因 |
| 恢复后审计链无法验证 | 确认签名 key（ZEUS_RSK_KEY_FILE）与快照时一致；key 不匹配则审计链无法续，按 key 恢复流程处理 |
| 目标已存在且未加 --force | 脚本拒绝覆盖；确认后显式加 --force |
| 备份报 `rsk-ed25519.pem` 缺失 | 该快照无法验签历史审计。找回私钥后重跑；确认本部署从未生成密钥时才用 `--allow-missing-key` |
| 备份报 `audit(...)` 缺失 | 显式指定的审计路径不存在：修路径，不要改成默认探测来掩盖 |
| 备份报 `no audit trail found` | 快照不含任何决策历史：确认服务确实写过审计，或数据目录选错了 |

## 7. 安全要求

- 私钥、db、审计、备份文件一律 0600，owner 可读；group/other 无任何权限。
- db/备份/私钥文件不入镜像（`.dockerignore` 已排除 data、*.db、*.pem、backups）。
- 密钥不得入库、不得进文档；备份束如含明文敏感数据，按 0600 与异盘存放。
