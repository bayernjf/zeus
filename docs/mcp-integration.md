# Zeus MCP 集成说明（v0.2）

> 状态：**现行（v0.2，2026-10-04）**。面向"要把别的系统接进 Zeus，或把 Zeus 接进别的系统"的读者。设计理由（为什么 Realm 只有 MCP 一条对外通道）见 [design-realm.md](design-realm.md) §6.1；实施进度见 [handoff.md](../handoff.md)。本文只写契约与用法。**v0.2 相对 v0.1（2026-09-28）的改动**：§2 补回 stdio transport 说明、2026-10-01 两次真机实连记录与 work-learn 的 21 工具最小权限分组样板（这三块在 v0.1 之后的一次整文件写入中被挤出正文，登记为审计 **B-39**，本轮按配方合并并升版）；§0 的客户端传输一行随之改为 HTTP / stdio 二选一（`src/mcp/connectors.ts:48-48 #command`）；篇首的取证声明按实际的两批捕获如实写明；**全文 37 处 `file:line` 锚点逐条对照代码复钉（其中 19 处原本指向无关实现、另约 7 处偏移数行），并统一改写成带校验词的可机检形状 `path:起-止 #校验词`，由 `tests/doc-consistency.test.ts` 断言**（登记与销项见审计 B-41）。
>
> **本文不含未取证的说法。** 标 **实测** 的条目来自**两批**真进程捕获：**§1 服务端面**出自 2026-09-28（`dist/realm/mcp-stdio.js`，HEAD `44b100b`，Node 22.23.1 与 20.20.2 各跑一遍，归一化 `realmId` / 时间戳 / `contentDigest` 后两份输出逐字节相同）；**§2 客户端面**出自 2026-10-01（真实 stdio 上游 `dist/realm/mcp-stdio.js` 与第三方 work-learn stdio server 各完成一次实连，见该节两条记录）。标 **代码级** 的只读了实现，没有跑；标 **未验证** 的明确待验。复跑方法见 §4。
>
> **锚点口径（读行号之前先看这句）**：文中的每条代码锚点都写成 `` `src/path.ts:起-止 #校验词` `` 的形状——**校验词必须出现在被引区间之内**，这条形状由 `tests/doc-consistency.test.ts` 断言（当前 47 条逐条命中代码）。有了它，代码移动后闸门会直接报"校验词不在被引区间内"，而不是让读者跳到一段无关实现里自己发现。本文锚点本轮（v0.2）已逐条复钉：原 37 处引用里 **19 处指向无关实现**、另约 7 处偏移数行，全部重找；复钉过程另外判出并改正一条**错的契约陈述**（见 §2.2）。**另外七份"现行事实源"文档同口径**（feature-inventory、terminology、design-naming-migration、design-backpressure、verify-jev-backend，加 2026-10-05 自托管批次新增的 design-self-host-loop 与 verify-self-host-pilot，共八份；全库现测 **150 条**带校验词）：三份台账与 PRD 仍是旧形状——全库 **360 条可解析引用**由"必须落到真实行区间"的断言守着，另有 **144 条只写了文件名的引用**（仓库里有三个 `registry.ts`，归属要靠人判）只被计数、不被判定。登记与口径见审计 B-41、B-42。

## 0. 先分清三件事

MCP 在 Zeus 里同时出现在两个方向，且**不是**第三个（跨 Agent 协作）的方向：

| 方向 | 是什么 | 传输 | 本文位置 |
|---|---|---|---|
| **Zeus 作 MCP 服务端** | 把用户自己的目录（数据域 Realm）以**只读**资源 + 两个只读工具暴露给宿主 | **stdio**，换行分隔 JSON-RPC 2.0 | §1 |
| **Zeus 作 MCP 客户端** | 连接器（connector）：接入外部系统已实现的 MCP 服务，发现能力并按声明裁剪 | streamable **HTTP**（`POST`，接受 JSON 或 SSE 帧）**或本地 stdio**（拉起子进程，换行分隔 JSON-RPC）；二选一，见 §2 | §2 |
| 外部执行 Agent 接 Zeus 干活 | 任务派发与结果回传 | **A2A**（不是 MCP） | [design-vassal-protocol.md](design-vassal-protocol.md) |

术语提醒：本文的 **Realm / 数据域** 指"一个用户目录即一个数据边界"，与 Kerberos / LDAP 的 security realm 无关（见 [terminology.md](terminology.md) 的 C 类同名异义）。对外沟通建议直说"Zeus 的数据域 MCP 服务"。

**文件正文不经 HTTP 面暴露**（代码级依据：`src/http/server.ts:77-77 #content` 的面定义——"Realm **content** 只走 MCP stdio"；带 `realm` 字样的路由只有治理动作 `/api/realms/:id/disconnect`、`/api/realms/:id/retarget-tenant`、`/api/realm/write-grants`，加上不读正文的挂载视图 `/api/domains`——后者逐字段是 `realmId / type / tenant / readOnly / itemCount / contentDigest`，既无正文也无绝对根路径，`src/http/server.ts:2004-1983 #`）。正文只经 §1 的 stdio 通道出入，这是"数据主权在用户"这条设计约束的执行点之一。

---

## 1. Zeus 作为 MCP 服务端：数据域只读面

### 1.1 启动与授权：三条入口，一条规则

```bash
npm run build                                                   # 先产出 dist/
node dist/realm/mcp-stdio.js /path/to/notes                     # 入口 A：argv，可给多个
ZEUS_REALM_ROOTS=/path/to/notes,/path/to/code \
  node dist/realm/mcp-stdio.js                                  # 入口 B：环境变量，argv 留空
# 入口 C：streamable HTTP（2026-10-07 落地，Active work 144）——服务端装配后自动挂载：
#   GET  /mcp   公开元信息（protocolVersion/capabilities/serverInfo，零 realm 数据）
#   POST /mcp  需 Bearer（未配 ZEUS_INTERNAL_TOKEN 则整组不挂载），JSON-RPC 喂同一个 createRealmMcpHandler
#   header x-zeus-realm-actor：宿主声明的调用方身份，仅可收窄到宿主白名单子集，缺省 anonymous
```

规则只有一条：**授权集合只能在启动时定死，协议本身没有 connect。** stdio 入口 = 宿主启动进程时给的根目录，运行时无法增删（`src/realm/mcp-stdio.ts:11-11 #connect`、`src/realm/mcp-stdio.ts:92-92 #collectRoots`）；HTTP 入口 = 内核启动时的 Realm 连接列表（`src/http/serve.ts` 从 `kernel.realmStore.connections()` 装配），同样运行时不可增删。

两条入口的关系（实测）：

| 送法 | 结果 |
|---|---|
| 只给 `ZEUS_REALM_ROOTS="A,B"`，argv 空 | 连上 2 个域，`resources/list` 返回 4 条资源（每域 manifest + search 两条） |
| argv `[A, B, A, --flag]` + 同名变量 `ZEUS_REALM_ROOTS=A` | **仍然只有 2 个域**：argv 与 env 合并后按集合去重，`--` 前缀的参数被过滤掉，不会被当成根目录 |
| argv 里一个不可达目录 `/no/such/dir` | 进程**退出码 1**、stderr 报 `connect failed … ENOENT`、**stdout 零条 JSON-RPC**——不存在"半启动的服务"，授权失败就不开门 |

分隔符口径**只有一个**：`ZEUS_REALM_ROOTS` 按逗号切分，与运行时核心读同名变量的写法一致。**不要**用冒号——Windows 的 `C:\Users\…` 会被切成两个假根目录（这条踩坑记在 `src/realm/mcp-stdio.ts:98-98 #ZEUS_REALM_ROOTS`，此前评审 C-3 抓到过"同一变量两套语法"）。

宿主侧配置的形状各家不同，语义相同（`command` + `args`，或 `command` + `env`）：

```json
{
  "mcpServers": {
    "zeus-realm": {
      "command": "node",
      "args": ["/absolute/path/to/zeus/dist/realm/mcp-stdio.js", "/Users/me/notes"]
    }
  }
}
```

`realmId` 由根目录 realpath 派生（`realm-` + sha256(realpath) 前 16 位，`src/realm/store.ts:128-128 #sha256Hex`），**同一目录重启后 id 不变**；启动时 stderr 会打印每个域的 `realmId`、条目数与根路径——那是操作员看到它的唯一位置（stderr 不进协议，客户端拿不到，需要 `realmId` 就从 `resources/list` 的 URI 里读，实测 §1.4）。

### 1.2 握手与版本协商

服务端声明支持三个协议版本，**新在前**（`src/realm/mcp.ts:29-29 #SUPPORTED_PROTOCOL_VERSIONS`）：`2025-06-18`、`2025-03-26`、`2024-11-05`。

协商规则（实测）：客户端送的版本在表内 → 原样回该版本；不在表内 → 回服务端最新的那个。

```
initialize {protocolVersion:"2024-11-05"}  ->  "2024-11-05"
initialize {protocolVersion:"1999-01-01"}  ->  "2025-06-18"
```

`initialize` 的完整响应（实测原文）：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"resources":{"listChanged":false,"subscribe":false},"tools":{"listChanged":false}},"serverInfo":{"name":"zeus-realm","version":"0.1.0"}}}
```

注意 `capabilities` 里**没有 `prompts`**：本面不实现 prompts，任何未实现的方法一律 `-32601`（实测 `prompts/list` → `method not found`）。`subscribe:false` / `listChanged:false` 是同一件事的两面——**内容变了协议不会通知你**，域内文件被改过只能重新读（语义见 §1.6）。

### 1.3 方法清单（实测）

| 方法 | 状态 | 说明 |
|---|---|---|
| `initialize` | ✅ | 见 §1.2 |
| `ping` | ✅ | 返回 `{}`；字符串 id 也照原样回（实测 `id:"str-id"` → `id:"str-id"`） |
| `resources/templates/list` | ✅ | 返回下面 3 条 URI 模板 |
| `resources/list` | ✅ | 每个已连接域 2 条（manifest、search） |
| `resources/read` | ✅ | 三种 URI，见 §1.4 |
| `tools/list` | ✅ | 两个只读工具，见 §1.5 |
| `tools/call` | ✅ | 同上 |
| 其他一切（`prompts/list`、`completion/complete`、`notifications/*` 之外的自定义方法…） | ❌ `-32601` | |

**通知（无 `id`）不产生响应**——实测：同一进程发 13 条请求 + 1 条 `notifications/initialized`，stdout 上正好 13 行。客户端不要把"没回复"当超时。

### 1.4 资源 URI 参考

`resources/templates/list` 的返回（实测原文，就是这三条）：

```json
{"resourceTemplates":[
  {"name":"Realm manifest","uriTemplate":"zeus-realm://{realmId}/manifest","mimeType":"application/json"},
  {"name":"Search realm items","uriTemplate":"zeus-realm://{realmId}/search?text={text}&since={since}&limit={limit}&tags={tags}","mimeType":"application/json"},
  {"name":"Read one realm item","uriTemplate":"zeus-realm://{realmId}/item?path={path}","mimeType":"text/plain"}]}
```

`resources/read` 三种形态的实测响应（截断示意，字段与错误码原样）：

```json
// zeus-realm://<realmId>/manifest
{"contents":[{"uri":"…","mimeType":"application/json","text":
  "{\"realmId\":\"<realmId>\",\"type\":\"personal\",\"createdAt\":\"<ts>\",\"contentDigest\":\"<64 hex>\",\"itemCount\":2,\"skipped\":[{\"itemId\":\".hidden.md\",\"reason\":\"hidden file skipped\"},{\"itemId\":\"blob.bin\",\"reason\":\"unsupported extension '.bin'\"}],\"backup\":{\"strategy\":\"none\"}}"}]}

// zeus-realm://<realmId>/search?text=needle&limit=2
{"contents":[{"…","text":"[{\"itemId\":\"design.md\",\"tags\":[],\"snippet\":\"zeus needle beta two\",\"modifiedAt\":\"<ts>\"},{\"itemId\":\"standup.md\",…}]"}]}

// zeus-realm://<realmId>/item?path=design.md
{"contents":[{"uri":"…","mimeType":"text/plain","text":"# design\nzeus needle beta two\nthird line\n"}]}
```

要点：
- **清单里没有 `root` 字段**。绝对路径在序列化前被剥掉（`src/realm/mcp.ts:374-374 #publicManifest`，序列化点 `src/realm/mcp.ts:324-324 #publicManifest`），实测 13/13 响应里根目录字符串零命中。客户端能拿到的定位符只有 `realmId` + 根相对 `itemId`。
- `contentDigest` 是**连接时快照**的内容摘要；目录被改过它不会自己变（见 §1.6）。
- `skipped[]` 是"为什么你的某个文件不在结果里"的官方答案，逐条带原因（§1.7）。
- URI 的 scheme 不是 `zeus-realm://` → `-32602`；hostname 不是已连接域 → `-32002`；pathname 不是 manifest/search/item → `-32602 unknown realm resource`。都实测过。
- **`?tags=` 显式报错，不再静默**（2026-09-30 修复，deferred **#31** 销项）：`search?tags=important` 现在下传到存储层，由 P0 文件系统后端抛 `UnsupportedQueryError` → JSON-RPC `-32602`（"tag search is not supported in P0"），客户端会**看见这条限制**而不是拿到未过滤的全量命中。同理，**任何资源模板未声明的查询参数名**（如 `?bogus=1`）都按名拒绝为 `-32602 unsupported search parameter: bogus`；`tools/call` 的 `realm.search` 同口径（`tags` 为非空逗号分隔串、未知 `arguments` 键拒绝）。支持的 search 参数只有 `text` / `since` / `limit` / `tags`（`tags` 显式不支持）。标签检索立项阈值见 design-realm §6.2。

### 1.5 工具参考

`tools/list` 的返回就是两个工具（实测原文含完整 `inputSchema`，此处摘要）：

| 工具 | 入参 | 必填 | 返回 |
|---|---|---|---|
| `realm.search` | `realmId`、`text`、`since`（ISO 时间串）、`limit`（正数） | `realmId` | `content:[{type:"text",text:"<RealmHit 数组的 JSON 字符串>"}]` |
| `realm.read` | `realmId`、`itemId`（根相对 POSIX 路径） | `realmId`、`itemId` | `content:[{type:"text",text:"<文件正文>"}]` |

- **返回值是"文本里塞 JSON"**，不是结构化 result（`src/realm/mcp.ts:220-220 #JSON.stringify`）：`realm.search` 的 `text` 需要客户端再 `JSON.parse` 一次。这是 MCP 工具结果的通用形状，别指望宿主帮你渲染。
- `realm.read` 的正文按原样返回，包括换行；层级目录用 POSIX 分隔（实测 `itemId:"sub/dir/deep.md"` 可读）。
- 检索语义（`src/realm/store.ts:195-195 #sort`）：`text` 按空白切词后**全部命中**（AND）、大小写不敏感的子串匹配；命中按 `modifiedAt` **倒序**。`snippet` 是**包含任一检索词的第一行**（`trim` 后超过 200 字符则截断加 `…`；没给 `text` 时取第一行非空内容；一行都没匹配上则是空串）——它是给"挑一条去读"用的定位提示，不是富文本，代码级 `src/realm/store.ts:521-521 #snippetFor`。
- **没有写工具**（实测 `realm.write` → `-32602 unknown tool: realm.write`）。P0 的写能力只存在于库内端口 `Realm.write`，不经这条通道暴露（剩余半边登记在 [deferred-items.md](deferred-items.md) #14/#18 的口径里）。

### 1.6 快照语义 vs 实时语义：一句话版

**检索走连接时快照，读取走磁盘实时。** 这不是实现巧合，是刻意的（连接时扫描入内存 `src/realm/store.ts:144-144 #scan`、检索只读那份内存 `src/realm/store.ts:186-186 #stored.items`、读取每次落磁盘 `src/realm/store.ts:223-223 #readFile`）。实测五条：

| 连接之后再往目录里改/加，然后… | 结果 |
|---|---|
| 改写已索引文件的正文，再 `realm.search` 旧内容 | **仍命中旧内容**（快照） |
| `realm.search` 改上去的新串 | **零命中**（快照里没有） |
| `realm.read` 那个被改过的文件 | **返回新正文**（落盘实时） |
| `realm.read` 一个连接后才创建的文件 | **可读，返回正文** |
| 连接后再读 `manifest` | `itemCount` 仍是连接时的数字 |

对集成的含义：想让检索看见新东西，**重启宿主进程**（没有 reindex 方法）；只想读当前字节，用 `realm.read`。这也是"恢复协议必须返回当前字节"的设计要求（[design-realm.md](design-realm.md) §5）。

### 1.7 哪些文件进得来（扫描规则）

连接时递归扫描根目录，规则如下（常量表 `src/realm/store.ts:62-62 #TEXT_EXTENSIONS`、递归 `src/realm/store.ts:405-405 #EXCLUDED_DIR_NAMES`）。下表五行里有四行的 reason 在本轮实测的 `manifest.skipped` 里原样出现过（扩展名、隐藏文件、超限、符号链接）；`node_modules` / `.git` 与"点开头目录整棵剪掉且不进 skipped"是代码级（`src/realm/store.ts:408-408 #startsWith`）：

| 情况 | 处理 | 出现位置 |
|---|---|---|
| 扩展名不在文本白名单（`.md .markdown .txt .org .rst .json .jsonl .csv .yaml .yml .toml .xml .html .css .ts .js .mjs .cjs .py .go .java .rs .c .h .cpp .sh .sql .log`） | 跳过，reason `unsupported extension '.bin'` | `manifest.skipped` |
| 以 `.` 开头的文件 | 跳过，reason `hidden file skipped`；以 `.` 开头的**目录**连同子树静默略过（不进 skipped） | `manifest.skipped` |
| 目录名 `node_modules` / `.git` | 整个略过（不进 skipped） | — |
| > 1 MiB（1048576 字节） | 跳过，reason `size <N> exceeds 1048576 bytes` | `manifest.skipped` |
| 符号链接 | 跳过，reason `symlink skipped (P0 does not follow links)` | `manifest.skipped` |

`read` 侧还有一套**独立**的闸（每次读都过）：itemId 必须根相对且无穿越段、不得是符号链接、不得是目录、不得 >1 MiB、扩展名必须在白名单内、realpath 必须仍在根内（`src/realm/store.ts:203-203 #isInsideRoot`）。实测的两个成对例子——`link.md` 在 `skipped` 里写"symlink skipped"，直接去读它则报 `-32003 symlink reads are refused in P0: link.md`；`huge.md` 因超限不进快照，直接读则 `-32003 item exceeds 1048576-byte limit: huge.md`。

**边界是目录，不是文件名。** 落在根内的 `.md` 一律可读、可检索，无论内容是什么（实测：根内一个内容敏感的 `outside-target.md` 正常返回正文）。不想暴露的东西请放在授权目录之外，或放成符号链接 / 非白名单扩展名。

### 1.8 错误码与处置

服务端可能回的全部码（码表 `src/realm/mcp.ts:39-39 #REALM_NOT_CONNECTED`、出口 `src/realm/mcp.ts:387-387 #mapError`）。标 ✅ 的是本轮实测出现过原文：

| code | 含义 | 什么时候出现 / 客户端该怎么办 |
|---|---|---|
| `-32700` parse error ✅ | 这一行不是合法 JSON | id 恒为 `null`（无法回填）。检查你是否按"换行分隔"发送 |
| `-32600` invalid request ✅ | 缺 `method` | 请求形状错了。注意：**`jsonrpc` 字段不被校验**，缺了也照处理（实测） |
| `-32601` method not found ✅ | 方法未实现 | 含 `prompts/*`、`completion/*`。按"服务端不支持"处理即可 |
| `-32602` invalid params ✅ | URI scheme 不对 / 未知 realm 资源 / `limit` 非正数 / `since` 不是合法日期 / `arguments` 不是对象 / 工具名未知 / 缺 `itemId` | 参数级错误，逐条改。`since=not-a-date` → `invalid since date: not-a-date`；`limit=0` → `limit must be a positive integer, got: 0` |
| `-32002` realm not connected ✅ | URI 的 hostname 或 `realmId` 不在宿主授权集合内 | **这就是越界的标准信号**。不是重试，是改授权（重启宿主） |
| `-32003` invalid itemId ✅ | 路径穿越、目标不存在、符号链接、目录、超限、扩展名不支持 | 消息里只带根相对 itemId，不带绝对路径 |
| `-32000` realm error | 存储层其他错误的兜底 | 本轮未触发（未实测） |

- `limit` 超过 200 或省略时**不报错**：省略取默认 50，超了静默截到 200（代码级：`src/realm/store.ts:69-69 #DEFAULT_LIMIT`、夹取 `src/realm/store.ts:182-182 #MAX_LIMIT`；实测只证明了 `limit:1000000000` 不返回错误）。
- 所有诊断走 **stderr**，stdout 只有 JSON-RPC。把 stderr 混进协议流是集成侧的经典事故。

### 1.9 这条通道不提供的东西（请照此设防）

| 没有什么 | 后果与替代 |
|---|---|
| 没有 `connect` / `disconnect` / `reindex` | 授权集合与检索快照都在启动时定死；要改就重启宿主进程 |
| 鉴权取决于传输形态 | **stdio：没有鉴权**——对端就是你启动它的那个宿主，能写这条管道 = 拥有宿主授权的全部读取权，不要把它接进多租户进程。**HTTP：Bearer 鉴权**——`POST /mcp` 过 `requireBearer`，未配 token 整组不挂载。主体（actor）判定已落地（deferred #18，2026-10-07）：`x-zeus-realm-actor` header 声明的会话级 actor **仅可收窄**宿主白名单，缺省 anonymous |
| 没有写工具 | 想改用户目录请走库内 `Realm.write`（含企业域签名凭证），不是这条通道 |
| 只有 personal 域（stdio） | stdio 宿主把类型写死为 `personal` 且 `readOnly:true`（`src/realm/mcp-stdio.ts:35-35 #personal`）。**HTTP 面例外**：realmIds 来自内核启动连接列表（可含 enterprise），企业域读取路径的隔离执行点 = 同一份 realmId 白名单（§6.5 裁定 ④）∩ actor 收窄 |
| 没有服务端→客户端推送 | `subscribe:false` / `listChanged:false`，改了不通知（§1.2） |

---

## 2. Zeus 作为 MCP 客户端：连接器（connector）

外部系统实现了 MCP（streamable HTTP 或本地 stdio）？Zeus 侧用连接器接入，四个动作：**声明 → 握手（发现 + 裁剪）→ 调用 → 吊销**。全部在 bearer 保护的 H2 面上（长驻服务 `dist/http/serve.js` 总是装配该面；只用库时要显式注入 `connectorRegistry`）。

```bash
TOKEN=…    # ZEUS_INTERNAL_TOKEN
# 1) 声明：权限边界写在声明里，凭证只在这一次进得去
curl -s -X POST localhost:8787/api/connectors -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"kb","name":"Knowledge Base","endpoint":"http://127.0.0.1:9000/mcp","permissions":["mcp:search"],"token":"upstream-secret"}'
# 2) 握手：跑 initialize + notifications/initialized，再列 tools/resources/prompts
curl -s -X POST localhost:8787/api/connectors/kb/connect -H "Authorization: Bearer $TOKEN"
# 3) 调用：只能调"握手发现过、且未被声明边界裁掉"的工具
curl -s -X POST localhost:8787/api/connectors/kb/tools/search/call -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"arguments":{"query":"x"}}'
# 4) 吊销：立刻从活跃集合消失，之后的调用一律被拒
curl -s -X DELETE localhost:8787/api/connectors/kb -H "Authorization: Bearer $TOKEN"
```

连接器支持两种 transport，二选一：

- **http**（默认）：`endpoint` 为 streamable-HTTP URL，可选 `token`（出站 Bearer）。
- **stdio**：`command` + 可选 `args` / `env`，Zeus 拉起本地子进程，走换行分隔 JSON-RPC。用于本地优先、没有 HTTP 面的 MCP server（如 work-learn 的 stdio server、Zeus 自己的 `dist/realm/mcp-stdio.js`）。声明与调用时 `endpoint` 与 `command` 互斥；`env` 的值（可能含凭证）不回显，HTTP 面只返回 `envKeys`。

stdio 声明示例（经 HTTP 面）：

```bash
curl -s -X POST localhost:8787/api/connectors -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"local-notes","name":"Local Notes","command":"node","args":["dist/realm/mcp-stdio.js","/abs/notes"],"permissions":["mcp:realm.search"]}'
```

**实测（2026-10-01，Node 22.23.1）**：以真实 `dist/realm/mcp-stdio.js`（指向临时目录）为上游，经 `ConnectorRegistry` stdio transport 完成真机握手与调用——`connect` 后工具清单裁剪为声明内的 `realm.search`（`realm.read` 被边界排除），`realm.search` 对真实文件返回命中，未声明的 `realm.read` 调用被拒（`does not expose tool 'realm.read'`）。握手与单次调用各自起独立子进程、完成即关闭，Zeus 不保持到连接器的长连（与 HTTP transport 同语义）。

**第三方真实 MCP 实连（2026-10-01，work-learn，Node 20.20.2 + tsx）**：首个非 Zeus 自有的上游——本机 `packages/mcp-server/src/server.ts`（stdio，临时 `WORK_LEARN_DB_PATH`，无 token 本地 SQLite 形态）。裸 `mcp` 声明握手发现其全部 **21 个工具**、0 resources、0 prompts；最小权限声明 `['mcp:search_corpus','mcp:get_review_items']` 连接后工具清单**精确裁剪为这两个**，`get_review_items` 真实返回 `[]`，未声明的 `save_material` 调用被边界拒绝。再以 `['mcp:create_session','mcp:save_material','mcp:search_corpus']` 声明跑通**跨独立子进程的写后读端到端**：`create_session` → `save_material` 写入一条材料 → `search_corpus {query:'stdio transport'}` 真实命中该条（持久化经本地 SQLite，不依赖进程存活）。前置条件是 work-learn 的 `better-sqlite3` 原生模块已按 Node 20 ABI 安装（prebuild-install），server 需用 Node 20 启动。

### 2.1 权限词汇是封闭的，而且比工具名严格

`permissions` 走 Skill 的同一套校验（`src/mcp/connectors.ts:41-41 #validatePermissionClaims` → `src/skills/validate-spec.ts:18-18 #PERMISSION_RE` 与 `src/skills/validate-spec.ts:27-27 #MCP_TOOL_NAME_RE`，判定函数在 `src/skills/validate-spec.ts:35-35 #permissionClaimIssue`）：

- 允许的前缀只有五个：`realm` / `execute` / `network` / `credential` / `mcp`。其他一律在**声明那一刻**被拒（库内 `validatePermissionClaims` 已实测；经 HTTP 面表现为 400，`src/http/server.ts:2803-2790 #`），消息形如 `unknown permission scope 'bogus'; allowed: realm, execute, network, credential, mcp`。
- 工具级边界的写法是 `mcp:<工具名>`；**裸 `mcp` 等于全部放行**（判定在 `src/mcp/connectors.ts:286-286 #withinDeclaredBoundary`：`claim === \`mcp:${name}\` || claim === 'mcp'`）。
- **非 `mcp` 作用域**（realm/execute/network/credential）仍走封闭词法 `^[a-z][a-z-]*(:[a-z][a-z-]*)?$`；**`mcp:<工具名>` 则引用上游握手清单里的原样字符串**（deferred **#30** 已修复，2026-09-30）：`mcp:search`、`mcp:search_docs`、`mcp:Search`、`mcp:notion.search`、`mcp:A1.b-2_c` 均合法，允许字母/数字/`.`/`_`/`:`/`-`；仅 `mcp:`（空名）、带空白或控制字符被判 invalid。名字与上游 `tools/list` **精确匹配、大小写敏感**。
- **上游改名会静默失权**：声明了但握手清单里没有的 `mcp:<工具名>` 不会报错（声明可能早于连接），连接时会产生一条 `boundary-unmatched` 连接器审计事件（`granted tools not discovered upstream: …`），据此发现改名/下线；该工具不会出现在裁剪后的能力清单里，调用即拒。

### 2.2 裁剪发生在哪一层

- 握手回来的能力清单，**三类（tools / resources / prompts）都按声明裁剪**：`src/mcp/connectors.ts:291-291 #narrowCapabilities`，连接时在 `src/mcp/connectors.ts:150-150 #narrowCapabilities` 应用、状态恢复导入时再收一次（`src/mcp/connectors.ts:258-258 #narrowCapabilities`）；断言在 `tests/mcp-connectors.test.ts:261-261 #bounds`（三类同边界）与 `tests/mcp-connectors.test.ts:288-288 #narrows`（导入后重收）。因此"声明里没有的 resource 就看不见"**这句现在是成立的**——但 2026-09-28 写下这行时**不成立**（当时只有 tools 被裁），是 A-09 在 2026-10-01 把三类统一到同一条边界；本文那一版留下的过期陈述在本轮合并 B-39 的逐锚点复读中被改掉（登记为审计 B-41）。
- 调用侧的闸在两处：不在裁剪后清单里的工具名直接拒（`src/mcp/connectors.ts:197-197 #expose`，测试锚点 `tests/mcp-connectors.test.ts:176-176 #refuses`）。上游没 advertised 的东西调不到，被边界裁掉的东西也调不到。
- 上游不可达 / 握手失败 = **502 `bad_gateway`**，并写一条 `refused` 审计（错误分类 `src/http/server.ts:2807-2786 #`、审计落点 `src/mcp/connectors.ts:130-130 #refused`）；未知 id → 404（`src/http/server.ts:1837-1816 #`）；重复声明或已吊销 → 409；参数不合法 → 400。

### 2.3 凭证的可见性

`token` 只在 `POST /api/connectors` 那一瞬间进入，**任何响应（含 list / get / connect / revoke）都只报 `hasToken: true|false`，绝不回显**（脱敏在 `src/http/server.ts:1830-1809 #`；断言在 `tests/http-connectors.test.ts`）。审计记录同样只有 `{at, connectorId, action, detail}` 四个字段，没有 token 位（代码级：`src/mcp/connectors.ts:14-14 #ConnectorAuditEntry`）。

### 2.4 客户端侧的协议版本

Zeus 的 MCP 客户端在 `initialize` 里固定送 `2025-03-26`（`src/mcp/client.ts:12-12 #PROTOCOL_VERSION`），不做多版本协商；响应接受两种帧（单一 JSON body 或 `text/event-stream` 的 `data:` 帧，实测覆盖在 `tests/mcp-connectors.test.ts:86-86 #accepts`）。服务端未实现的能力（tools/resources/prompts 任一类）列表失败即视为空清单，不阻断握手（`src/mcp/client.ts:119-119 #safeList`）。

### 2.5 最小权限分组样板：work-learn 的 21 个工具

上游工具名一律按 `tools/list` 的原样字符串写进 `mcp:<工具名>`（下划线、精确大小写）。21 个工具按读写性质分四档，声明时只取当前任务需要的那一档；裸 `mcp`（全部 21 个）只用于首次发现，不作为运行态边界。

| 档位 | 工具 | 性质 |
|---|---|---|
| **read（只读，可安全常驻）** | `search_corpus`、`get_review_items`、`generate_practice`、`get_practice_history`、`get_user_patterns`、`get_reuse_summary`、`list_expressions`、`suggest_reuse`、`suggest_reuse_candidates` | 查询/出题/建议，不改数据。`suggest_*` 只返回候选、不自动落库 |
| **review-write（复习闭环写）** | `mark_mastered`、`snooze_review`、`record_practice` | 改动复习调度与练习记录，只影响本人语料的状态，不新建正文 |
| **ingest（采集写）** | `create_session`、`save_material`、`save_question_translation`、`record_reuse` | 新建会话/材料/提问/复用事件。`save_*` 是正文入口，按需短时授予 |
| **admin（管理与模型生成，影响面最大）** | `configure_reuse_nudges`（改全局提醒设置）、`cluster_intents` / `merge_intents` / `split_intent`（意图台账重组，合并/拆分删除源意图）、`generate_adaptive_practice`（可选 LLM 出口，配置了 `WORK_LEARN_LLM_*` 时正文会出本机） | 配置变更、台账结构性写、可能触发出站模型调用 |

声明示例（只给「查语料 + 取复习项」的只读宿主）：

```json
{"id":"worklearn-read","name":"Work Learn Read","command":"node",
 "args":["/abs/path/work-learn/packages/mcp-server/src/server.ts"],
 "env":{"WORK_LEARN_DB_PATH":"/abs/path/work-learn.db"},
 "permissions":["mcp:search_corpus","mcp:get_review_items","mcp:generate_practice"]}
```

要点：① `generate_practice` 不调模型（纯本地从已存材料生成），归 read；`generate_adaptive_practice` 在配置 LLM 时会把正文送外部，归 admin，二者不要混授；② 采集链路 `create_session → save_*` 是写操作，仅在确有「AI 对话整理入库」场景时授予；③ 意图重组三工具会删除/合并意图，属不可逆结构性写，默认不授。

---

## 3. 未验证与待办（诚实边界）

| 事项 | 现状 | 什么条件下补 |
|---|---|---|
| **官方 MCP SDK 客户端实连（stdio 与 HTTP 面）** | **未验证**。本文证据 = 手工 JSON-RPC 逐条发送（stdio 实测原文见 §1；HTTP 面 2026-10-07 新增，`tests/http-realm-mcp.test.ts` 11 例覆盖协商/鉴权/actor 收窄/白名单越界/坏 JSON，但未用 `@modelcontextprotocol/sdk` 客户端连过任一形态） | 出现真实读取方（P1 正式启动）或任何一次"某家宿主连不上"的报告；届时按 §4 复跑并逐家记配置形状 |
| 具体宿主的配置样例 | 只给了语义中立的 `command` + `args` 形状，**没有**针对任何一家宿主的实测配置 | 同上一条 |
| `limit` 截断到 200、`text` 切词 AND 语义 | 代码级（`src/realm/store.ts:182-182 #MAX_LIMIT`）；实测只覆盖了"超限不报错"和单/双关键词命中 | 需要给外部读者保证分页行为时补一次 201 文件的实测 |
| 企业域 Realm 经 MCP 暴露 | **HTTP 面已暴露**（2026-10-07，Active work 144）：realmIds 来自内核启动连接列表，actor 收窄 + 共用白名单即隔离执行点；stdio 面仍写死 personal + readOnly。**真实读取方仍未出现** | P1 正式启动 / 首个 read-realm 执行 Agent（deferred #18 触发条件语义不变） |
| 连接器权限词法绑不住"名字不合词法"的工具 | **已修复（2026-09-30，deferred #30）**：`mcp:<工具名>` 改为引用上游握手清单的原样字符串（下划线/点/大写均合法、精确大小写匹配），非 mcp 作用域保持封闭词法；声明了但上游清单没有的工具在连接时产生 `boundary-unmatched` 审计事件，防上游改名静默失权。**真实上游 connect（2026-10-01）**：先对**真实** `dist/realm/mcp-stdio.js`（非自造夹具）完成握手/裁剪/调用/边界拒绝实测；同日对**第三方** work-learn stdio server 完成实连——21 工具全发现、最小权限精确裁剪、跨子进程写后读命中（见 §2）。仍未做：work-learn 的**远程 HTTP MCP**（`POST /api/mcp`，需 Supabase/JWT/PAT 凭证）实连；对非 Zeus 自有的其他 HTTP MCP 服务也尚未实连 | 远程 MCP 有可用凭证时复跑，记录 Bearer 认证与无状态 streamable-HTTP 形状 |
| 未声明的查询参数被静默丢掉（`?tags=`） | **已修复（2026-09-30，deferred #31 销项）**：`tags` 下传到存储层显式 `-32602`（P0 不支持标签检索），任何未声明参数名按名拒绝；resource URI 与 `tools/call` 两通道同口径，17 例 MCP 测试覆盖 | 标签检索真正立项的阈值仍在 design-realm §6.2（单 Realm >2 万文件或 P50>500ms） |

## 4. 复跑这份取证

不需要任何客户端库，一条 shell 管道即可拿到原文（已实测可用；`2>/dev/null` 之后 stdout 只有 JSON-RPC）：

```bash
npm run build
mkdir -p /tmp/zeus-docdemo && printf '# note\nzeus doc\n' > /tmp/zeus-docdemo/note.md
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/realm/mcp-stdio.js /tmp/zeus-docdemo 2>/dev/null | jq -c .
```

期待值：两行输出（id 1、id 2），`notifications/initialized` **不产生响应**；stderr 上是一条 `connected realm-<16 hex> (1 items) from …`。负向只要把 `id 2` 换成 `'{"jsonrpc":"2.0","id":2,"method":"prompts/list"}'` 就能看到 `-32601`，换成 `'…{"uri":"zeus-realm://realm-deadbeef/manifest"}'` 就能看到 `-32002`。

库里已有的快测锚点：`tests/realm-mcp.test.ts`（协议面，含 tools 与负向）与 `tests/mcp-connectors.test.ts`（连接器：边界裁剪、不可达拒连、吊销即断、SSE 帧、导出导入）。
