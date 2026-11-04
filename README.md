# dsh-mcp-status

DeepSeek Harness Web GUI 的 **MCP 服务器面板**：在侧边栏里看清「有哪些 MCP 服务器、各自连上没有、配置是什么」，并原地开关和重连。

An MCP server panel for the DeepSeek Harness Web GUI: it lists every `@deepseek-ai/dsh-mcp-client` row with its live connection state and tool count, shows the row's configuration, and switches or reconnects it without leaving the panel.

## 它回答的三个问题

| 问题 | 来源（宿主侧事实，不是猜测） |
| --- | --- |
| 有哪些 MCP 服务器？ | 遍历 `ctx.loader.entries()` 里所有 `@deepseek-ai/dsh-mcp-client` 行：profile 补丁、home 补丁、插件包插入的行都算，**与宿主实际在跑的东西一致** |
| 连上了没有？ | loader fiber 的 state（已停用 / 加载失败 / 启动中 / 运行中）**加上**工具注册表里 `mcp__<server>__*` 的条数。连不上时 `mcp-client` 不抛错（`failOnStartupError` 默认 false），fiber 照样 active、工具一个没有——这一条正是「已连接」与「假装已连接」的分界 |
| 为什么没连上？ | 「测试连接」用宿主同一份配置真做一次 JSON-RPC 握手（stdio 起进程 / http 打请求），把 `ECONNREFUSED`、`HTTP 401`、超时原文贴回行内 |

## 两个座位

- **侧边栏行**：`sidebar.panellist`，id `mcp`，order 40；
- **中央面板**：`main` keyed 槽，key 也是 `mcp`。

面板打开时每 4 秒刷新一次快照（只在页面可见时），数据来自宿主四条同源路由：

| 路由 | 作用 |
| --- | --- |
| `GET /api/dsh-mcp-status/servers` | 快照：每行的状态、工具数、传输与地址、来源补丁文件、超时与重连策略 |
| `POST /api/dsh-mcp-status/toggle` | `{ id, enabled }`：改补丁行 → 等热重载 → 返回新状态（超时后主动重排一次） |
| `POST /api/dsh-mcp-status/retry` | `{ id }`：重新挂载这一行（= 重新连接） |
| `POST /api/dsh-mcp-status/test` | `{ id }`：真握手，返回协议版本 / serverInfo / 工具数 / 失败原因 |

写操作要求同源证明，且所有路由都只接受回环来源。

## 开关是怎么落地的（为什么不破坏补丁文件）

开关只改**补丁文件里那一行**的 `disabled`：按缩进找到 `- id: <行 id>` 后的块，插入或删除一行
`disabled: true`，其余字节原样保留（注释、`!!js` 表达式、其它行都不动），原子写（临时文件 + rename，
保留原权限位）。写完后 DSH 的补丁监听会热重载这一行——**重载即重新连接**；8 秒内没连上就主动
`hmr.reconcileProfile([id])` 再排一次。实测：禁用→启用一轮后补丁文件与操作前逐字节相同。

不在可编辑补丁文件里的行（由插件包插入，例如 `drawio`）显示「内置」，开关不可用——面板不碰
自己管不着的东西。

## 显示约定

- 样式只用 `--dsw-alias-*` 主题令牌，跟随宿主明暗主题；文案走 `ctx.locale`（zh / en）。
- 状态色：绿=已连接；红=未连接/加载失败；黄（呼吸）=启动中；灰=已停用。
- 行的展开区给出传输、命令/地址、env/header **名字**（不显示值）、重连策略、调用超时、来源补丁
  文件、条目 id，以及失败原因。

## 兼容与依赖

- 需要宿主组合了 `webServer`（Web GUI）与 `@deepseek-ai/dsh-mcp-client`（MCP 客户端）；两者都是 DSH 自带包。
- 本包**不依赖**任何第三方运行时包：宿主半体只用 Node 内置模块，探测模块自己实现 MCP 握手。
- 官方 `@deepseek-ai/*` 包一个都没有 import，因此 `package.json` 里没有 `dependencies` / `peerDependencies`。

## 安装

三种装法，任选其一：

1. 本地目录（开发用）：`dsh plugin --profile <profile> add link:<本目录>`；
2. 从 GitHub：`dsh plugin --profile <profile> add github:SonettoGu14/dsh-mcp-status`；
3. 在 Harness 里用插件管理器的 `install_bundle` 指向本目录或本仓库。

安装后在侧边栏点「MCP 服务器」即可。卸载：`dsh plugin --profile <profile> remove dsh-mcp-status`。

## 开发

```bash
node lib/probe.test.mjs   # 5 个用例：stdio/http 成功、命令不存在、超时、HTTP 401
```

## 已知边界

- 停用/启用会改写**当前 profile 的补丁文件**里那一行的 `disabled`；如果该行由其它工具生成（例如同步 MCP 配置的第三方工具），那个工具下次整表重写时可能覆盖本次开关的结果。
- 面板只读配置、不做新增/编辑；新增与编辑仍在「设置 → 插件 → MCP 服务器配置」。

## License

MIT
