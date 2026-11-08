# 审计报告导出

`scripts/audit-report.mjs` 把决策审计 JSONL 变成一份**可被第三方独立复核**的报告。

## 为什么需要

审计链一直是内部能力：服务能验签，但客户、审计师或监管方拿到 `audit.jsonl` 无从下手。
导出报告补的是这一段——把"我们验过了"变成"你可以自己验"。

## 用法

```bash
npm run build            # 脚本读 dist/，与服务器跑的是同一份代码

# 默认在 ./data 下探测 audit.jsonl → decision-audit.jsonl 与 rsk-ed25519.pem
node scripts/audit-report.mjs

# 显式指定
node scripts/audit-report.mjs \
  --audit data/audit.jsonl \
  --key data/rsk-ed25519.pem \
  --out audit-reports
```

产物：`audit-report-<UTC时间戳>.json` 与 `.md`，权限 `0600`（报告含 decisionId 与 actor）。

| 参数 | 说明 |
|---|---|
| `--state-dir` | 相对路径的基准目录，默认 `.` |
| `--audit` | 审计 JSONL；缺省按候选列表探测 |
| `--key` | 签名公钥或私钥 PEM；缺省探测 `data/rsk-ed25519.pem` |
| `--key-id` | 覆盖 keyId，默认取第一条条目的 keyId（密钥轮换后旧链仍可验） |
| `--out` | 输出目录，默认 `audit-reports` |
| `--json-only` | 不写 Markdown |

`--key` 接受**公钥**：验签不解密也不签名，审计方只拿公钥即可复现。

## 报告内容

- 结论（`VERIFY_OK` / `VERIFY_FAILED`）与条目数
- 链头、链尾哈希
- 公钥 SPKI DER 的 SHA-256 指纹，便于人工比对
- 逐条 `seq / at / kind / decisionId / actor / hash / signature`
- 复核命令：同一条命令、同一份文件、同一把公钥

## 退出码即结论

| 场景 | 退出码 | 输出 |
|---|---|---|
| 链完好 | 0 | `VERIFY_OK — N entries, seq 0..N-1, last entry <ts>` |
| 条目被改 | 1 | `VERIFY_FAILED at seq N — hash mismatch` |
| 条目被删 | 1 | `VERIFY_FAILED at seq N — seq discontinuity` |
| 文件为空 | 1 | `no entries -- <path> is empty` |
| 缺少密钥 | 1 | `signing key not found` / `does not exist` |
| 密钥不是 PEM | 1 | `does not look like a PEM key` |

失败时仍会写出报告（`--json-only` 除外），但**不会**留下 `VERIFY_OK` 字样，也不会 exit 0。

## 报告的边界

哈希链证明的是**记录自签署以来未被篡改**，不证明**记录的内容真实发生过**。
两者不能混为一谈：一份链完整的报告，只能说明"这份日志没有被事后修改"。
对外交付时应照原文表述，不要写成"证明该决策真实存在"。

另外，链完整性依赖私钥未泄露。私钥与快照必须分开保管（见 `docs/backup-restore.md`）。
