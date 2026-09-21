# Agent Instructions

Zeus 项目的 AI 协作规范。写任何代码或文档前先读本节。

## 任务追踪与文档分层

**任务追踪与待办的主入口是 `handoff.md`**（状态、进度、待办、文档索引都在这里）；**方案/设计/规格的全文放 `docs/` 的独立文档**，handoff 只索引、不复制全文。

- 活跃待办 → `handoff.md`「Active work」区
- 缓做/低优项 → `docs/deferred-items.md`（每条带触发条件；handoff 只给索引）
- 产品定位/画像 → `docs/product-portrait.md`（可迭代活文档，演进日志在文末）
- 方案/设计/规格 → `docs/design-*.md`，一个主题一份（单一事实源）
- 触发条件满足 → 从 deferred-items 移回 handoff 待办区并标注重启日期

**新增文档后**：在 `handoff.md`「Project documents」区补一行索引（`docs/README.md` 文档地图同步）。

一句话：handoff = 索引 + 状态 + 待办，docs = 方案 + 设计 + 明细。接手先读 handoff，再按索引跳转。

## 文档状态约定

- **现行**：当前事实，以此为准；改动直接更新。
- **历史**：决策过程记录，结论已体现在现行文档；改结论改现行文档。
- **归档**：冻结内容，只读参考，不追加。
- **实施进度**：统一记在 handoff.md，设计文档只写设计，不重复记进度。

## 设计哲学不可违反（见 docs/product-portrait.md）

1. 用户是底座，产品是插件：给目录即用，数据主权在用户，备份是第一公民。
2. 藏宝图即恢复协议：叙事化概念必须与真实可执行的工程原语同构。
3. 立国三纲：一切能力接入必须能落到 MCP（连接）、Skill（技能）、A2A（协作）。
4. 个人数据域与企业数据域边界清晰，未经授权不互通。

## Commit 规范

- 英文 `<type>(<scope>): <subject>`，如 `docs: add product portrait v0.1`
- 原子提交：一次只做一件事；docs/config/test/feature 分组提交
- 不 push（除非用户明确说）
- 作者保持用户身份，不加 AI co-author

git commit message 详细规范，看 [git-commit-message.md](./git-commit-message.md)
