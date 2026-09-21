# Handoff

State of Zeus as of 2026-09-21.

> Zeus 目前处于「立项 / 产品定义」阶段，尚无代码。本文件记录项目当前状态、活跃任务与文档索引。

## Current state

- 已完成上层方向定位与产品画像 v0.1（2026-09-21）。
- 项目骨架文档已按 agent-world 惯例建立：AGENTS.md / handoff.md / docs/。
- 已 `git init` 并完成首次 docs 提交；尚未选型技术栈。

## Active work

1. ★ 拍板「封臣协议」形态：直接复用 A2A 标准超集，还是自定义最小协议（见 deferred #1）。
2. 起草 `docs/design-vassal-protocol.md`：Agent Card + 任务受理 + 战报回流 + 升级人类。
3. 拿 pr-helper 作为第一个封臣，验证协议可行性。

## Project documents

📚 **文档地图（按场景怎么读）**：[docs/README.md](docs/README.md)。以下为完整清单的单一事实源：

* [docs/product-portrait.md](docs/product-portrait.md) — 产品画像活文档：定位、设计哲学（目录底座/藏宝图/MCP·Skill·A2A）、个人与企业双态画像、分层架构、封臣式产品矩阵、路线图；文末演进日志 ★
* [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（开放问题与挂起项 + 触发条件的单一事实源）
* [AGENTS.md](AGENTS.md) — AI 协作规范与文档分层约定
* [git-commit-message.md](git-commit-message.md) — commit message 规范

## Recent changes

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 产品画像 v0.1 初稿；按 agent-world 惯例建立项目文档骨架 |
