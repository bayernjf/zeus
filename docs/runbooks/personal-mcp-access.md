# 接入手册：让你的个人 Agent 助手通过 MCP 使用 Zeus

> 适用：把 **Zeus 个人数据域（Personal Realm）** 作为一个只读数据源，接入你已在用的 Agent 助手（Claude Desktop、Cursor、或任何支持 stdio MCP 的客户端）。
> 这是 [design-personal-agent-host.md](../design-personal-agent-host.md) P0 落地，本机、离线、零配置即可用。

## 0. 先认清你面对的是什么

- 这个入口是 **stdio MCP 服务器**，实现是 `src/realm/mcp-stdio.ts`（构建产物 `dist/realm/mcp-stdio.js`）。
- 它暴露的是**你启动时授权的一个或多个本地目录（个人 Realm）**，只做读取：`realm.search`、`realm.read`（外加一个在本入口会被拒的 `realm.write`，见 §7）；另经内核只读装配暴露 `zeus.skills` / `zeus.plan` / `zeus.status` 三个内核算数工具（`zeus.plan` 只是本地技能识别，plan-only，绝不执行，见 §8）。
- 它**不是** zeus 的编排/对话面：不能通过它派发任务、执行动作、或访问企业域。编排走 HTTP 门面（`POST /api/intents`，见 §8）。
- **安全模型**：根目录只在启动时由命令行参数或 `ZEUS_REALM_ROOTS` 授权，连接为**只读**；协议里**没有**「连接任意路径」的方法——客户端无法把扫描器指向宿主没授权的目录。stdout 只跑 JSON-RPC，诊断信息走 stderr。

## 1. 两种形态，先选一种

| 形态 | 传输 | 何时用 | 状态 |
| --- | --- | --- | --- |
| **stdio（本机）** | 标准输入输出，助手以子进程拉起 | 助手和数据在同一台机器；零部署、离线 | **本手册，现已可用** |
| **Streamable HTTP（远程）** | 公网 HTTPS，Bearer/OAuth | 云端助手或手机跨网访问 | 随门面真机部署（PRD E10.2，尚未上线） |

## 2. 准备

```bash
cd /path/to/zeus
npm install
npm run build          # 产出 dist/realm/mcp-stdio.js
```

准备一个数据目录（你的个人 Realm），里面放文本类文件（Markdown / txt 等白名单类型）。例如：

```bash
mkdir -p ~/Documents/zeus-realm/notes
printf '招聘沟通要点：下周三回访。\n' > ~/Documents/zeus-realm/notes/jobs.md
```

> RealmId 由目录的绝对路径派生（确定性、幂等），你不用手填；接入后用 `resources/list` 即可发现，见 §5。

## 3. Claude Desktop 配置（可直接抄）

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS），把**绝对路径**替换成你机器上的真实路径：

```json
{
  "mcpServers": {
    "zeus-realm": {
      "command": "node",
      "args": [
        "/Users/you/000mycodes/zeus/dist/realm/mcp-stdio.js",
        "/Users/you/Documents/zeus-realm"
      ]
    }
  }
}
```

多个目录就在 `args` 里继续追加，或用环境变量（逗号分隔，**不要用冒号**，会把 Windows 盘符切碎）：

```json
{
  "mcpServers": {
    "zeus-realm": {
      "command": "node",
      "args": ["/Users/you/000mycodes/zeus/dist/realm/mcp-stdio.js"],
      "env": { "ZEUS_REALM_ROOTS": "/Users/you/Documents/zeus-realm,/Users/you/notes" }
    }
  }
}
```

保存后重启 Claude Desktop；在工具/MCP 面板应能看到 `zeus-realm` 及其 `realm.search` / `realm.read` 工具。

也可以用 npm 脚本快速自测（不接助手）：

```bash
npm run mcp:realm -- ~/Documents/zeus-realm
# 进程会以 stdio MCP 等待 JSON-RPC；正常现象是没有普通输出、连接信息在 stderr。
```

## 4. Cursor 配置

编辑 `~/.cursor/mcp.json`（或在 Cursor 设置的 MCP 面板里添加），结构与上面相同：

```json
{
  "mcpServers": {
    "zeus-realm": {
      "command": "node",
      "args": [
        "/Users/you/000mycodes/zeus/dist/realm/mcp-stdio.js",
        "/Users/you/Documents/zeus-realm"
      ]
    }
  }
}
```

## 5. 助手如何拿到数据（调用顺序）

1. `initialize` → 返回 `serverInfo.name = "zeus-realm"`、协议版本 `2025-03-26`。
2. `resources/list` → 得到形如 `zeus-realm://realm-xxxxxxxx/manifest` 的资源，URI 里的 `realm-xxxxxxxx` 就是 **realmId**（多个目录各一条）。
3. `tools/call` `realm.search`：`{ "realmId": "realm-xxxx", "text": "招聘" }`，返回命中项的元数据与片段。
4. `tools/call` `realm.read`：`{ "realmId": "realm-xxxx", "itemId": "notes/jobs.md" }`，返回全文（`itemId` 是相对根目录的 POSIX 路径）。

## 6. 本机实测验收表（`dist/realm/mcp-stdio.js` 真进程打出来的）

用一个临时 Realm 子进程真跑 stdio JSON-RPC，结果如下（探针脚本可复现，见下）：

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | `initialize` 返回 `serverInfo.name=zeus-realm`、`version=0.1.0` | PASS |
| 2 | 协商协议版本 `2025-03-26` | PASS |
| 3 | `tools/list` 含 `realm.search` / `realm.read` / `realm.write` | PASS |
| 4 | `resources/list` 暴露 manifest，可发现 realmId | PASS |
| 5 | 启动时只读连接目录，stderr 报 `connected <realmId> (N items)` | PASS |
| 6 | `realm.search` 命中文本文件并返回 snippet | PASS |
| 7 | `realm.read` 返回文件全文 | PASS |
| 8 | 只读 stdio 宿主上 `realm.write` 被拒：`-32004 write refused: realm-read-only` | PASS |
| 9 | 读取未授权（未连接）的 realm 被拒：`realm not connected: <id>` | PASS |
| 10 | `tools/list` 另含 `zeus.skills` / `zeus.plan` / `zeus.status` | PASS |
| 11 | `zeus.status` 返回 `realms`（realmId/type/readOnly）、`agents`、`pendingOversight`、`watches`，不含绝对路径 | PASS |
| 12 | `zeus.skills` 返回技能目录数组（可按 `id` 取单个；未注册时为空数组而非报错） | PASS |
| 13 | `zeus.plan` 返回结构化结果：`ok` / `chosenBy=local-ranker` / `candidates`，无匹配时 `reason=no-candidates`（本地 ranker，零出域） | PASS |

> 验收脚本即 `scripts/verify-personal-mcp.mjs`（`npm run verify:personal-mcp`，上表 13 项全绿）。

## 7. 环境变量清单（stdio 侧只有这些）

| 变量 | 作用 |
| --- | --- |
| `ZEUS_REALM_ROOTS` | 逗号分隔的授权目录列表（与命令行参数取并集、去重）；冒号分隔不可用 |
| `ZEUS_STATE_FILE` | 显式设置时内核状态落该文件；**默认不设置 = 内存态、零副作用**。不挂 decision backend，`zeus.plan` 只走本地 ranker |

诊断信息只输出到 stderr（连接成功/失败、handler 错误），stdout 严格只输出 JSON-RPC 响应。

## 8. 目前「没有」的能力（接入方问起来先答这些）

- **没有写入 / 没有执行**：stdio 宿主只读连接，`realm.write` 一律返回 `realm-read-only`；不能派发意图、不能调用其他 Agent、不可逆动作一律不通。`zeus.plan` 只是把指令对本地技能目录做匹配并给出结构化候选，**plan-only**——不派发、不执行；执行仍走签名票据 + HTTP 门面。
- **不能连任意目录**：没有运行期连接新路径的方法；换目录要重启并在启动时授权。
- **不读企业域**：本入口只接个人 Realm（`personal`）；企业域、跨域授权走 HTTP 门面与 `decideRealmAccess`。
- **没有远程/多设备**：远程 Streamable HTTP MCP、入站 A2A、跨设备同步要等门面真机部署（设计稿 §6 P2）。
- **没有对话人格**：这是工具面，不是聊天助手；对话/常驻入口是设计稿 §6 的 P1 宿主壳。

## 9. 与 Tier0 其他 MCP 一起接入（同一台机器）

这些产品同样提供标准 stdio MCP，可在同一个 `mcpServers` 里并列配置（路径以各仓库实际为准）：

| 服务器 | 包 / 入口 | 能力 | 门控 |
| --- | --- | --- | --- |
| `agent-world` | `@agent-world/mcp-server`，stdio 默认 | 世界/沙箱工具 | 见 agent-world `docs/runbooks/mcp-client-access.md` |
| `job-agent` | `@jobagent/mcp`，bin `jobagent-mcp` | 求职搜索（画像类需 key） | `MCP_API_KEY`；无 key 仅 `search_jobs` |
| `agent-dev` | CLI `mcp` 子命令 | 开发 Agent（桥本机 daemon） | Bearer；只读/增量 |

> 编排原则：个人助手**只面对 zeus 一扇门**做需要授权/聚合的事；这些 stdio 工具可被助手直接调，也可由 zeus 经 MCP 连接器统一纳管。详见 [design-personal-agent-host.md](../design-personal-agent-host.md) §4。
