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

## 设计约束不可违反（见 docs/product-portrait.md）

1. **数据主权在用户**：给一个本地目录即可使用；用户的正文不出用户机器，备份与恢复是一等能力，不是附加特性。
2. **每个概念必须可执行**：文档里的任何抽象都要对应一个可运行的工程原语（可调用、可验证、可恢复），否则不写进文档与代码。
3. **能力接入只有三条通道**：MCP（连接外部系统）、Skill（能力与权限声明）、A2A（跨 Agent 协作）。任何新能力必须落到这三条通道之一，不允许私有旁路。
4. **个人数据域与企业数据域不互通**：默认单向隔离，跨域读写需要显式、签名、一次性的授权，且企业域数据不得回流到个人域。

## 写作语言：只用专业术语

**文档、注释、提交信息、对外回答一律使用行业术语，不使用叙事隐喻，也不写"专业词（隐喻）"式括注**（2026-09-25 用户定的口径）。需要解释一个既有名字时，**解释它做什么**，不要给它换一个比喻。

- 术语以 [docs/terminology.md](docs/terminology.md) 为准：该文件给出**专业定义 + 代码原语**，并解释历史标识符的含义。
- 代码标识符、环境变量与线上协议字段（如 `vassal` / `fealty` / `vault` / `realm` / `ZEUS_VASSAL_SEEDS` / `x-zeus-fealty`）是**接口的一部分**：不在文档措辞改造时顺手改名；要改需单独批准（代价见 terminology 的"破坏性面"一节）。
- 新写代码优先用专业命名；只有在替换既有对外契约时才沿用历史名，并在 terminology 登记含义。

## Commit 规范

- 英文 `<type>(<scope>): <subject>`，如 `docs: add product portrait v0.1`
- 原子提交：一次只做一件事；docs/config/test/feature 分组提交
- 不 push（除非用户明确说）
- 作者保持用户身份，不加 AI co-author

git commit message 详细规范，看 [git-commit-message.md](./git-commit-message.md)
