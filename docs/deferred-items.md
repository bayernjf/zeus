# Deferred Items

缓做/低优事项登记表。每条挂起项必须带**触发条件**；触发条件满足后移回 `handoff.md` Active work 并标注重启日期。

## 架构决策待定（非缓做，但需先拍板）

（#1 封臣协议形态已拍板：A2A 超集，2026-09-21，见 [design-vassal-protocol.md](design-vassal-protocol.md)——已销项）

## 缓做项

### #2 藏宝图加密与托管方案
- 纯本地密钥 vs 可恢复托管的取舍；密钥丢失 = 宝藏永久丢失。
- **触发条件**：Realm 数据层与备份机制进入实施阶段。

### #3 传承（Inheritance）
- 继承协议、密钥托管（dead-man's switch）、法律框架。
- **触发条件**：藏宝图备份的情感闭环得到验证；产品进入 P3。

### #4 企业版计费模型
- 按「部门/编制」还是按席位计费。
- **触发条件**：企业 Realm 多租户进入实施，且有首批意向企业用户。

### #5 外部 Agent 信任分级与沙箱
- 第三方 Agent 接入的信任分级、权限沙箱边界。
- **触发条件**：A2A 协作层需要接入第一个本矩阵之外的外部 Agent。

### #6 个人/企业双数据域授权粒度
- 同一员工同时持有两个 Realm 时的数据二极管授权界面与审计呈现。
- **触发条件**：企业版与个人版需要在同一用户处共存（首个双重身份用户）。

### #7 fealty 签名链
- Agent Card / fealty 的发布与吊销是否需要签名链，防止伪造名册条目。
- **触发条件**：bayjf 名册对外公开前。
- **进展（2026-09-21）**：设计已定稿 v0.1，见 [design-fealty-signing.md](design-fealty-signing.md)（v1 Zeus 单签：Ed25519 + RFC 8785，条目 attestation + 快照 seal，TTL 硬过期；v2 封臣自签交叉背书）。**v1 纯函数已库内实现**（`src/registry/signing.ts`：JCS 子集 canonicalJson、digestCard、createAttestation、sealSnapshot、verifySignedSnapshot、Ed25519 内存 signer/verifier；`tests/signing.test.ts` 19 项，设计稿 §8.1 八条验收全部覆盖通过）。本条**仍未销项**：剩余 R1（HTTP 发布端点产出签名快照、RSK 密钥部署侧注入）与 R2（bayjf 构建期验签展示）接线，以及生产密钥存放方案（设计稿 §9.2 开放问题）。

### #8 战报成本口径
- `x-zeus-report.cost` 的单位与结算口径，跨封臣可比性。
- **触发条件**：企业版计费立项时（联动 #4）。

### #9 封臣背压降级顺序
- 封臣饱和时 Zeus 任务队列向其他封臣/队列分流的降级顺序。
- **触发条件**：≥3 个封臣在线后压测。

### #10 Realm 检索后端升级（倒排 / 向量）
- P0 检索为纯文件系统扫描（design-realm.md §6.2），后端接口可替换；倒排索引或向量检索的立项条件。
- **触发条件**：单 Realm 文件数 > 2 万，或 P50 检索 > 500ms，或语义检索成为明确需求（且本地 embedding 可行、数据不出域）。
