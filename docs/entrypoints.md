# Zeus 入口分工（Z-03）

> 状态：现行，2026-11-23。决策：**日常默认从 `npm run daily` 进**；其余入口全部保留，只按场景标注，不删除、不合并。
> 本文只定「默认从哪进、什么时候用哪个面」，不改变任何入口的能力与行为。

## 1. 一句话

单条日常指令用 `npm run daily`；要看、要批、要治理时进操作者面（TUI / Web / HTTP）；要自动跑、要接外部系统时用 daemon / MCP / A2A；验证与开发用 scripts。所有入口继续可用，daily 是默认，不是唯一。

## 2. 入口矩阵

| 定位 | 入口 | 面向 | 什么时候用 | 边界 |
| --- | --- | --- | --- | --- |
| **日常默认** | `npm run daily -- "…"` | 使用者本人 | 一句话：指令 → 意图 → 派发 → 决策与依据 → 待裁决项，并把这一页写回目录 | 一次性前台进程；退出码 0 报告已产出、1 无可派发/无交付、2 配置或用法错误；缺省 plan-only，`--model` 才把正文交给决策后端 |
| 操作者·交互 | `npm run chat` | 操作者 | 多轮对话式识别与派发计划，复用同一已装配 runtime | 前台 REPL；同样 plan-only、默认零出域；不写回记录；`/exit` 或 EOF 结束 |
| 操作者·监视与裁决 | `npm run tui` | 操作者 | 监视在途意图、裁决、名册治理、意图识别、连接器驱动 | 纯 HTTP JSON 轮询面板，复用 bearer 面；写动作有确认门 |
| 操作者·工作台 | `npm start` 后打开 Web 监督台 | 操作者 | 多视图：监控 / 名册 / 裁决 / 技能目录 / 审计 / 数据域与授权 / 组织 / 连接器 | 同一组 bearer 端点、同一条审计日志；不新增旁路状态 |
| 操作者/自动化·API | `npm start` → `http://127.0.0.1:<port>/api/*` | 脚本、curl、集成方 | 自动化调用、批量操作、外部系统对接 | 150 条路由（5 公开 + 145 bearer）；公开面仅健康/名册快照/指标等；写操作照常进审计与决策链 |
| 自动化·常驻 watch | `npm run daemon` | 自动化 | 常驻 watch tick，真实 fired 时系统通知；适合后台盯数据域变化 | `scripts/run-watch-tick.mjs --watch --notify`；只接受 loopback runtime，token 必填；不是产品入口的替代品 |
| 协议·A2A 入站 | Agent Card `/.well-known/agent-card.json` + `tasks/send` | 外部 Agent / 上游系统 | 外部 Agent 向 Zeus 派单、接收 push 回调 | 入站机制已实现；缺真实上游调用者与在册名册信任锚，不作为本机自用阻塞 |
| 协议·MCP | `npm run mcp:dataDomain`（stdio）与 `/api/mcp` | 外部 MCP 宿主 / 集成方 | 宿主读取数据域目录；内核只读工具 `memory.recall` / `traces.query` | stdio 进程与 HTTP 内核共用数据域 id；写权限走既有授权，不绕过操作者面 |
| 开发/验证 | `npm test`、`npm run build`、`npm run smoke:core`、`npm run verify:*`、`npm run agent:example` | 维护者 | 回归、真机冒烟、协议/入口验收、参考执行体演示 | 参考执行体只依据任务输入作答、零出站、不读任务范围外文件；验证脚本不替代产品入口 |

## 3. 选择规则

1. **只有一句话要办** → `npm run daily`。需要连续追问、比较多种派发计划时改用 `npm run chat`，但它不写回，落库仍走 daily 或操作者面。
2. **需要看状态、批裁决、改名册、查审计** → TUI 或 Web 监督台；两者读写同一组 HTTP 端点，选顺手的，不产生两套状态。
3. **要被脚本/外部系统调用** → 直接走 `npm start` 的 bearer API；需要长期盯变化再叠 `npm run daemon`。
4. **对方是另一个 Agent/宿主** → 用 A2A 或 MCP 协议面，不要让人工入口承担机器协议。
5. **改代码或验收** → scripts；`agent:example` 只用于空目录首跑与演示，不是生产执行体。

## 4. 保留承诺

- daily 成为默认入口，**不等于** TUI、Web、HTTP、chat、daemon、MCP、A2A 降级或待删；它们各有明确场景，全部继续维护。
- 任何入口都不绕过决策分级、审计链、名册验签与数据域授权；新增入口必须先说明它复用哪条既有链路。
- 入口数量不再扩张：新需求优先在既有面上加命令/视图，而不是再造一个顶层入口。

## 5. 证据与相关文档

- `README.md` §1.4：三使用者面与两协议面总表（本文件为场景分工的权威补充）。
- `docs/feature-inventory.md` §2.1：150 条路由实测口径（5 公开 + 145 bearer）。
- `docs/prd.md` §2.2：产品入口与 A2A 边界。
- `handoff.md`：入口相关变更与验证记录。
