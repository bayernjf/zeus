# 产品入口显式规格登记通道（E2.7 / --spec）

> 状态：**现行 v0.1**（2026-10-14，Active work 234：src+tests+scripts+docs 批；零新路由；基线 1950/168 → 1962/169，冒烟 49 → 50 步；全量 exit 0、typecheck/build exit 0、doc-consistency 18/18）

## 背景

上一批（v0.83 / Active work 233）把 `SkillSpec.aliases` 做成了机制：本地规则按整句子串命中，权重 4，高于任何词形重叠。但当时入口侧没有登记显式规格的途径 —— `npm run daily` 只认 `--skill` / `--agent` / `--params` 等旋钮，而 Agent Card 的协议面不带 `aliases` 字段。实测结果：中文一句话在纯本地路径下仍然 `no-candidates`，必须 `--skill` 点名或 `--model`（后者出域）。

这一条就是补上入口侧的登记通道，让一个只有目录、没有外部执行体、不配决策后端的用户也能靠一条命令走完「中文指令 → 本地规则命中 → 扇出 → 落盘」的全链路。

## 设计

### 入口参数

`npm run daily -- --spec FILE`（可重复）

- `FILE` 是 JSON 文件的路径，内容是一个 SkillSpec 对象，或一个由它们组成的数组。
- 登记发生在 `bootKernel()` 之后、Realm 选取与任何派发之前。拒绝即 `UsageError` → `exit 2`，目录零写出，符合"配置错误什么都没派发"的语义。
- 同一 id+version 已在目录中则跳过而非报错，否则带着状态文件重跑会被自己的幂等性挡住。

### 共享白名单

字段复制从 `src/http/server.ts` 的内联写法抽成 `src/skills/spec-input.ts` 的一条清单：

```ts
export function skillSpecInputFrom(payload: Record<string, unknown>): SkillSpecInput
```

HTTP 面（`POST /api/skills`）与入口面共用。两份清单会各自漂移，而漂移的那一份会成为活的契约 —— 所以只能留一份。

白名单字段：`id`、`name`、`description`、`version`、`domain`、`tags`、`aliases`、`inputs`、`outputs`、`permissions`、`dependencies`、`providedBy`、`status`。未知键一律丢弃。

### 错误分类

| 错误 | 退出码 | 说明 |
| --- | --- | --- |
| 文件不可读 | 2 | `--spec file is not readable: … (ENOENT …)` |
| JSON 非法 | 2 | `--spec … is not valid JSON: …` |
| 非对象 / 数组元素非对象 | 2 | `--spec … must hold a skill spec object, or an array of them` |
| 校验器拒绝 | 2 | `--spec … was rejected: version must be major.minor.patch …`（消息原样带出，点名第几个字段） |
| 同 id+version 已存在 | 0（跳过） | 静默跳过，不写审计、不改目录 |

`UsageError` 被导出，让退出码映射与测试都能按错误身份判定而不是猜文本。

## 验收

### 单元测试

`tests/skill-spec-registration.test.ts` 10 例：

- 白名单保留声明字段、丢弃未知键（包括 `registeredAt`、`kernelStateStore`、`constructor.prototype` 等注入尝试）
- 校验器拒绝的错误消息原样带出
- 接受单个对象与数组两种形态
- 文件不可读 / JSON 非法 / 非对象各有名目的 `UsageError`
- 重复登记跳过，目录里仍只有一条记录

### 入口对照例

`tests/daily-entry.test.ts` 新增两例：

1. **无 `--spec`**：同一句中文、同一 Agent → `exit 1`，stdout 含 `no-candidates`，目录零写出。
2. **有 `--spec`**：同一句中文、同一 Agent、环境里没有任何后端键 → `exit 0`，stdout 含 `**Intent** \`research\` — chosen by local rules`，落盘页同断言。证明零出域不是声明，是测出来的。

### 出货件冒烟

`smoke:core` 第 50 步：起参考执行体 → `node dist/daily/cli.js --root <空目录> --agent <card> --spec <别名规格> "帮我把这份材料归纳要点"` → 读数 `exit=0 pages=2 rules=true`。`pages=2` 同时证明上一批的记录名修复生效（两次运行各留一页）。

### 缺陷植入

把 `registerSkillSpecs` 改成空操作 → 入口两例即红（`2 failed / 49`），复原后 49/49 绿、`cli.ts` sha256 一致。

## 台账

- PRD v0.83 → **v0.84**（E2.7 正文补入口通道与其限制、篇首状态行、§7 一行）
- feature-inventory v0.86 → **v0.87**（入口旋钮 9 → 10、CLI 表行、批述）
- README（`--spec` 旋钮行 + 中文路径陈述改口 + 四处活读数）
- handoff Active work **234** + 索引行（PRD v0.84 / inventory v0.87）+ Recent changes + 五处活基线（1950/168 → 1962/169、冒烟 49 → 50）
- docs/README index 行 v0.86 → v0.87
- pre-launch-checklist 两处基线
- `server.ts` 因 import 与白名单两处改动致行号漂移，**7 处锚点逐条量行重钉**（mcp-integration 78→79、deferred-items/feature-inventory 395→396 ×2、handoff 708→709 & 1245→1246、design-self-host-loop/verify-self-host-pilot 3212→3199 ×2）
