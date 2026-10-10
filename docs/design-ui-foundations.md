# Zeus UI 基础规范：Design Token 与 i18n

> 状态：**现行（基础契约，2026-09-30，v0.2，2026-10-10 补 §8 实施进展）**。本文只规定 UI 基础变量与文案资源的工程契约，不构成 Web UI 立项；页面范围、交互方案与开工条件仍以 [design-ui.md](design-ui.md) 与 [deferred-items.md](deferred-items.md) #34 为准。
>
> 适用对象：方案 D（TUI）与方案 A/B/C（Web）。TUI 只消费终端可表达的 token 子集；Web v1 启动时必须先实现本规范，再开发页面。

## 1. 目标与约束

目标不是提前做视觉稿，而是建立一套可生成、可检查、可复用的界面基础契约，避免后续页面各自硬编码颜色、间距、字号和文案。

- **单一事实源**：token 与文案资源各只有一份机器可读源文件，CSS、TS、TUI 主题和测试快照均由它生成或引用。
- **三层 token**：primitive token 只存原始值，semantic token 表达用途，component token 表达组件级决策；页面不得直接使用 primitive token 或裸值。
- **内核零改动**：token 与 i18n 只属于客户端，不新增 HTTP 端点、不要求内核返回展示文案。
- **审计等价**：API 状态码、intent/escalation/vassal/runId 等标识符在任何语言下保持原值，界面只负责展示标签。
- **先窄后宽**：第一版只覆盖 #34 规定的监控、裁决、授权吊销三类页面；不为未开工的组织、技能、备份管理页预置组件 token。

## 2. Token 分层

### 2.1 Primitive token

Primitive token 使用无业务含义的刻度名，只允许被 semantic token 引用。

```text
zeus.color.neutral.0
zeus.color.blue.500
zeus.space.4
zeus.radius.md
zeus.font.size.14
```

建议初始刻度：

| 类别 | 刻度 | 说明 |
|---|---|---|
| color | `50,100,200,…,900` | 中性色与各功能色统一按明度编号 |
| space | `0,1,2,3,4,5,6,8,10,12,16,20,24,32,40,48,64` | 4px 基准，允许少量半刻度用于 1px 边框 |
| radius | `none,sm,md,lg,full` | 监督台界面优先中性、低装饰 |
| fontSize | `12,13,14,16,18,20,24,30` | 以 px 记录源值，Web 输出 rem |
| fontWeight | `regular,medium,semibold` | 不引入展示型字重 |
| lineHeight | `tight,snug,normal,relaxed` | 与字号解耦 |
| motion | `0,fast,normal,slow` | 只表示持续时间，缓动单独定义 |
| zIndex | `base,dropdown,overlay,toast` | 禁止页面自定义魔法数字 |

### 2.2 Semantic token

Semantic token 表达界面用途，是页面和组件的主要依赖。

```text
zeus.color.text.default
zeus.color.text.muted
zeus.color.surface.default
zeus.color.surface.subtle
zeus.color.border.default
zeus.color.status.running
zeus.color.status.needs-driver
zeus.color.status.completed
zeus.color.status.failed
zeus.color.action.primary.default
zeus.space.page.padding
zeus.space.panel.gap
```

状态语义必须直接对应内核/API 状态，不另造视觉状态名：

| API / 内核状态 | semantic token | 用途 |
|---|---|---|
| `running` / `in-progress` | `color.status.running` | 进行中分支、实时指示 |
| `completed` | `color.status.completed` | 成功完成 |
| `partial` | `color.status.partial` | 部分完成 |
| `failed` | `color.status.failed` | 失败、拒绝、吊销 |
| `needs-driver` | `color.status.needs-driver` | 需要操作者裁决 |
| `input-required` | `color.status.input-required` | 缺参等待补参 |
| `revoked` | `color.status.revoked` | 名册吊销 |

### 2.3 Component token

Component token 只在某组件确实需要独立视觉决策时创建，名称包含组件名，不写具体颜色值。

```text
zeus.button.primary.height
zeus.button.danger.background
zeus.card.surface.background
zeus.card.header.padding
zeus.escalation.banner.border
zeus.timeline.branch.gap
```

新增规则：

- 同一视觉决策在两个组件中重复出现时，先提升为 semantic token，不复制 component token。
- component token 可以引用 semantic token，不能直接引用 primitive color；布局尺寸可引用 primitive space。
- 一次性页面样式不进入 token 源文件。

## 3. 主题、终端与可访问性

### 3.1 主题

Web v1 支持 `light`、`dark` 两个主题，通过同一组 semantic token 换值实现。第一版不支持用户自定义品牌色。

- 默认主题：`system`，跟随 `prefers-color-scheme`，并允许显式覆盖为 `light` 或 `dark`。
- 功能色必须同时提供明度对比方案，不允许只靠红绿表达成功/失败；状态必须配合文本或图标。
- 正文与背景的对比度目标：正文 ≥ 4.5:1，大号文本与主要图标 ≥ 3:1。
- 焦点态使用 `zeus.color.focus.ring`，不得移除 outline 后不提供替代焦点样式。

### 3.2 TUI 子集

TUI 使用 semantic token 的终端映射，不承担完整主题能力：

- 颜色映射为 ANSI/终端主题语义（default、muted、success、warning、danger、accent），不假设固定 RGB。
- 间距映射为字符行/列，不使用 Web 的 px/rem token。
- 动效只保留 spinner 与必要刷新指示，避免高频全屏重绘。
- 状态文本仍使用 i18n key；状态枚举保持英文原值。

### 3.3 响应式与布局

方案 A 第一版以桌面宽屏监督台为主，但 token 必须提前定义边界，避免页面写死宽度。

```text
zeus.breakpoint.sm = 640
zeus.breakpoint.md = 768
zeus.breakpoint.lg = 1024
zeus.breakpoint.xl = 1280
zeus.layout.supervision.max-width = 1440
zeus.layout.panel.min-width = 320
```

窄屏下允许分支列表与决策面板纵向堆叠；不要求在手机端完成所有裁决操作。

## 4. Token 源文件与生成物

建议 Web v1 使用以下结构。实际选型可替换，但分层与校验要求不变：

```text
ui/tokens/tokens.jsonc          # 单一事实源：primitive + semantic + component
ui/tokens/themes/light.jsonc    # light 主题映射
ui/tokens/themes/dark.jsonc     # dark 主题映射
ui/tokens/tui.json              # TUI 子集映射
ui/src/generated/tokens.css     # 生成：CSS custom properties
ui/src/generated/tokens.ts      # 生成：TS 类型安全引用
```

格式约定：

- CSS 变量输出为 `--zeus-color-status-needs-driver` 这类 kebab-case。
- TS 导出使用扁平 key 或类型安全对象，不允许组件声明 `as string` 绕过 key 校验。
- token 文件内保存作者意图与可选描述；生成物不手改。
- 新增 token 必须在 PR 中说明使用组件；无消费者的 token 不合并。

### 4.1 禁止事项

- 页面/CSS 中出现裸色值（`#fff`、`rgb(...)`、具名色）或一次性间距（`padding: 13px`）。
- 按页面复制一套同名变量，例如 `homepage-primary`、`escalation-red`。
- 在 TS 中用条件表达式拼接业务状态到颜色名，例如 `colors[status]` 绕过 token 白名单。
- 用字体、阴影、圆角表达内核不存在的状态。

## 5. i18n 资源模型

### 5.1 语言与回退

- v1 语言：`zh-CN` 为默认语言，`en` 为第二语言。
- 回退链：当前语言完整 key → `en` → `zh-CN`；构建时如仍缺 key 则失败。
- 语言代码使用 BCP 47；不使用 `cn`、`english` 等非标准值。
- TUI 与 Web 共用消息语义，但可分别提供终端长度受限的 `short` 文案。

### 5.2 Key 命名

资源按功能域分层，key 使用稳定的产品语义，不嵌入具体译文：

```text
intent.status.completed
intent.status.needsDriver
escalation.action.approve
escalation.action.reject
roster.status.revoked
audit.action.intent.cancel
common.action.cancel
common.state.loading
common.error.network
```

命名规则：

- 域：`intent`、`escalation`、`roster`、`audit`、`memory`、`common`。
- 动作：`approve`、`reject`、`resolve`、`cancel`、`revoke`，与 API 动作词保持一致。
- 不在 key 中使用版本号、页面序号或开发者姓名。
- API 枚举值保持 `needs-driver`、`input-required` 原值；展示层映射到 `intent.status.needsDriver`。

### 5.3 参数、复数与格式

资源值使用 ICU MessageFormat：

```json
{
  "intent.progress.partial": "{completed, number} / {total, number} {total, plural, one {branch} other {branches}} completed",
  "intent.elapsed": "Elapsed {duration}",
  "audit.entry.dispatched": "Dispatched to {vassal} at {time, time, short}"
}
```

- 数字、日期、时间、相对时间与列表全部走 `Intl.*` 格式化，不手拼字符串。
- 时间默认显示运行时本地时区；审计详情保留 ISO 8601 与 runId/eventId。
- 译文中可以调整参数顺序，组件不得按字符串位置拼接。
- 富文本只允许有限标签（`<code>`、`<strong>`），不允许资源文件注入 HTML。

### 5.4 不翻译内容

以下内容必须保持机器值原样：

- API 路径、HTTP 方法、环境变量、配置键、token key、日志字段。
- `intentId`、`runId`、`eventId`、`vassal`、`skill`、`realmId`、keyId、commit SHA。
- 审计动作的机器名称与权限词法（如 `mcp:tool-name`）。
- API 返回的错误码；错误码可以有解释文案，但错误码本身不替换。

## 6. 建议资源文件结构

```text
ui/i18n/locales/zh-CN.json
ui/i18n/locales/en.json
ui/i18n/supported-locales.json
ui/src/generated/i18n.ts        # key 类型、消息绑定（如框架需要）
tui/i18n/locales/zh-CN.json
tui/i18n/locales/en.json
```

Web 与 TUI 如共享完全相同的消息 key，可先使用同一目录；当终端需要短文案时再显式拆分，不通过自动截断代替资源设计。

## 7. 校验与验收

Web v1 第一个页面前必须接入以下检查：

1. **token 完整性**：所有 semantic token 在 light/dark 两主题都有值；component token 引用存在；无悬空 key。
2. **无裸值**：样式文件禁止硬编码颜色、字体、间距、z-index；白名单只允许 `0`、`1px` 边框等明确例外。
3. **对比度**：CI 对文本/背景、状态色/背景组合做对比度断言；新增 token 必须过阈值。
4. **i18n 完整性**：`zh-CN` 与 `en` key 集合一致，无空字符串，ICU 参数集合一致。
5. **无硬编码文案**：组件源码不直接写面向用户的中英文句子；测试用 TestID 或 i18n key，不依赖具体译文断言。
6. **状态枚举映射**：每个 API 状态都有且只有一个 semantic status token 与一个 i18n key；未知状态必须显示原值并走降级样式。
7. **生成物一致**：检查生成的 CSS/TS 与 token 源文件一致，生成物漂移时 CI 失败。
8. **审计回读**：UI 发出的 approve/reject/resolve/cancel/revoke 仍以 API 动作为准，`GET /api/audit` 中不出现界面私有动作。

建议测试：

- token schema snapshot：锁定 key 清单，防止无意改名。
- theme matrix：对每个 `color.text.*` × 可能背景输出对比度结果。
- locale parity：比较两套 JSON 的 key 与 ICU 参数。
- DOM smoke：切换 `zh-CN/en/light/dark` 后关键按钮仍可定位，状态枚举不被翻译。

## 8. 实施顺序

本规范不提前触发 Web UI 开发。真正实施时按以下顺序：

1. 建 token schema 与最小 token 集：颜色、状态、间距、字体、焦点、z-index。
2. 生成 CSS/TS，接入裸值与主题完整性检查。
3. 建 `zh-CN`/`en` 资源与 key/ICU 参数一致性检查。
4. 实现方案 A 的第一个只读扇出视图，先验证 token 分层是否够用。
5. 实现 escalation 裁决操作，并补审计等价测试。
6. 实现名册吊销与公开验签状态展示；不提前迁移组织、技能、记忆等管理面。

如果先实施方案 D，则只实现 TUI 子集与 i18n key，不创建 Web 工程；TUI 验证后，token 名称与消息 key 应原样复用到 Web v1。

## 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v0.1 | 2026-09-30 | 初版：三层 design token、light/dark 与 TUI 子集、i18n key/ICU/资源完整性、无裸值与审计等价验收 |

## 8. 实施进展

- **2026-10-10 · 方案 A Web 监督台 v1.5 首批落地（Active work 191）**：§3 主题（light/dark CSS 变量 + 持久化 + 跟随系统偏好）、§5 i18n（`RES` 资源表 zh-CN/en 各 371 键，域前缀命名、`{param}` 参数、状态枚举原值不变仅展示映射且未知值回退原值、`data-i18n`/`data-i18n-ph` 静态标记 + `t()` 动态渲染）、§7 统一确认对话框（`confirmDialog()` Promise 化替换全部 11 处 `window.confirm`）在 `web/supervisor/index.html` 落地；契约闸门 `tests/web-supervisor-i18n.test.ts`（键集/参数奇偶、markup 引用全解析、无 `window.confirm`、脚本区零硬编码 CJK）。单文件零构建形态下 token/文案与页面同文件驻留（`:root` 变量块 + `RES` 表即本文件的单一事实源），多页面出现时再抽共享文件，契约不变。
