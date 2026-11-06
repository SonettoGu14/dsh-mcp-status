# dsh-mcp-status

DeepSeek Harness Web GUI 的 **MCP 服务器面板**：在侧边栏里看清「有哪些 MCP 服务器、各自连上没有、配置是什么」，并原地开关和重连。

An MCP server panel for the DeepSeek Harness Web GUI: it lists every `@deepseek-ai/dsh-mcp-client` row with its live connection state and tool count, shows the row's configuration, and switches or reconnects it without leaving the panel.

## 它回答的三个问题

| 问题 | 来源（宿主侧事实，不是猜测） |
| --- | --- |
| 有哪些 MCP 服务器？ | 遍历 `ctx.loader.entries()` 里所有 `@deepseek-ai/dsh-mcp-client` 行：profile 补丁、home 补丁、插件包插入的行都算，**与宿主实际在跑的东西一致** |
| 连上了没有？ | 三份证据：loader fiber 的 state（已停用 / 加载失败 / 启动中 / 运行中）、工具注册表里 `mcp__<server>__*` 的条数、以及 streamable-http 行每次刷新时的 TCP 端口探活。连不上时 `mcp-client` 不抛错（`failOnStartupError` 默认 false），fiber 照样 active——而**工具条数只证明「曾经连上过」**：服务器后来死掉时工具不会注销，所以端口探活和最近一次「测试连接」的结论会推翻那个绿点 |
| 为什么没连上？ | 「测试连接」用宿主同一份配置真做一次 JSON-RPC 握手（stdio 起进程 / http 打请求），把 `ECONNREFUSED`、`HTTP 401`、超时原文贴回行内 |

## 两个座位

- **侧边栏行**：`sidebar.panellist`，id `mcp`，order 40；
- **中央面板**：`main` keyed 槽，key 也是 `mcp`。

宿主维护一份状态缓存：后台每 `refreshMs`（默认 10 s）刷新，喂给 system prompt 与调用闸门；面板拉取时**当场重采**（探活有 2 s 缓存，其余全是内存读取），所以面板的新鲜度与以前一样。数据来自四条同源路由：

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

## 状态判定表（每条结论都带依据）

状态由 `lib/status.js` 的 `resolveStatus()` 纯函数推导，优先级从上到下：

| 顺序 | 条件 | 状态 | reason |
| --- | --- | --- | --- |
| 1 | 行被停用 | 已停用 | `disabled`（用户选择，不是故障） |
| 2 | loader fiber 失败 | 加载失败 | `fiber-failed` |
| 3 | fiber 未就绪 | 启动中 | `pending` |
| 4 | 最近一次测试失败，且端口不通或结论在 `probeAssertMs` 内 | 不可达 | `probe-failed` |
| 5 | streamable-http 端口拒绝连接 / 超时 | 不可达 | `tcp-refused` |
| 6 | 最近一次测试成功 | 已连接 | `connected` |
| 7 | 工具表读不到 | 已连接 | `unknown-tools`（不下结论） |
| 8 | 有工具 / 没有工具 | 已连接 / 未连接 | `connected` / `no-tools` |

第 8 条的 `no-tools`（界面显示「未连接」）刻意与 `unreachable` 分开：工具数为 0 可能只是这行挂在
per-agent 作用域、全局注册表看不见，把它当断线会误报也会误拦。

每行 DTO 带 `reason` 与 `evidence`（fiber / tools / tcp / probe 四个信号，带各自时间戳），
展开区把依据压成一行——「凭什么绿/红」不再靠猜。

## 模型可见性与调用闸门

同一份状态还喂给另外两个消费方（照 opencode 的做法：状态是一个层的事，不是界面的私有判断）：

- **system prompt 摘要**：有服务器不可用时，注册一个 section，最多 6 行，形如
  `- unityMCP (http://127.0.0.1:8080/mcp): unreachable — connect ECONNREFUSED, checked 8s ago.`
  全部恢复后 section 会被注销——健康时 prompt 里不多一个空行。
- **调用闸门**（`ctx.tools.guard`）：`mcp__<server>__*` 的调用在派发前被判为不可用就拒绝，返回可读原因
  （含「去 MCP 面板重试」）。只有**证据够新**才会拦：快照超过 `2 × refreshMs` 视为过期，`pending`、
  `no-tools`、`disabled` 一律放行——`idle` 不等于断线。

两个消费方都能关：`promptHealth: false` / `guardUnreachable: false`（见下）。

## 配置（写在本插件的 patch 行里）

```yaml
- id: mcp-status
  name: dsh-mcp-status
  config:
    refreshMs: 10000        # 后台状态刷新周期（≥ 2000）
    startupWaitMs: 8000     # 开关/重试后等待连接就绪的上限
    probeAssertMs: 60000    # 测试失败后，结论压过实时探活的窗口
    probeTimeoutMs: 15000   # 「测试连接」整次超时
    promptHealth: true      # 是否把不可用写进 system prompt
    guardUnreachable: true  # 是否拦截发往不可用服务器的工具调用
```

## 显示约定

- 样式只用 `--dsw-alias-*` 主题令牌，跟随宿主明暗主题；文案走 `ctx.locale`（zh / en）。
- 状态色：绿=已连接；红=未连接/不可达/加载失败；黄（呼吸）=启动中；灰=已停用。
- 「不可达」= 端口连不上，或最近一次测试失败：徽标立即变红，展开区给出原因；若工具还挂在注册表里，会单独说明那是上一次连接的残留。
- 行的展开区给出传输、命令/地址、env/header **名字**（不显示值）、重连策略、调用超时、来源补丁
  文件、条目 id、判定与依据，以及失败原因。

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
npm test                  # = node test/status.test.mjs && node lib/probe.test.mjs
node test/status.test.mjs # 状态判定、guard、prompt 摘要、配置归一化
node lib/probe.test.mjs   # 5 个用例：stdio/http 成功、命令不存在、超时、HTTP 401
```

## 已知边界

- 停用/启用会改写**当前 profile 的补丁文件**里那一行的 `disabled`；如果该行由其它工具生成（例如同步 MCP 配置的第三方工具），那个工具下次整表重写时可能覆盖本次开关的结果。
- 面板只读配置、不做新增/编辑；新增与编辑仍在「设置 → 插件 → MCP 服务器配置」。
- **stdio 行没有端口可探**：它们的存活只能靠工具数 + 用户点过「测试连接」的结论；`no-tools` 不会被当成断线。
- **闸门可能误拦**：只有「快照新鲜 + 端口确实拒绝连接 / 刚测过失败」才拒绝，窗口过期一律放行；不放心就
  `guardUnreachable: false`，退回纯看板行为。
- **状态是推导的，不是客户端自报的**：DSH 的 `dsh-mcp-client` 目前不暴露连接状态，所以这里只能组合
  fiber / 工具注册表 / TCP / 测试结论四份证据。真要让状态像 opencode 那样由客户端层拥有，需要上游提供接口。

## License

MIT
