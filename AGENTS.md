# AGENTS.md

给在这个仓库里干活的人（或 agent）看的操作手册。**先读这份，再读 README**——README 讲用户怎么用，这里讲改代码时哪些东西不能碰、碰了要付什么代价。

## 这是什么

`dsh-mcp-status` 是 DeepSeek Harness（下称 DSH）Web GUI 的插件包，三件事：

1. 在侧边栏列出当前 profile 里每一条 `@deepseek-ai/dsh-mcp-client` 行：连接状态、工具数、传输、命令/地址、来源补丁文件。
2. 能给某一行**开关**（改写补丁文件里那一行的 `disabled:`）和**重试**（真的重新挂载这一行）。
3. 把同一份状态喂给另外两个消费方：system prompt 里的「不可用的 MCP 服务器」摘要，以及工具调用闸门（不可用时拒绝 `mcp__<server>__*`）。

只用 Node 内置模块，零第三方依赖。宿主半体（`index.js`）跑在 DSH 主进程里，浏览器半体（`client.js`）通过 `window.__ModuleLoader__.load` 注册成侧边栏面板。

## 快速上手

```bash
npm test                                   # 状态判定 + 探针，零依赖纯 node
node test/status.test.mjs                  # 只跑状态/闸门/摘要
node lib/probe.test.mjs                    # 只跑探针（起假 stdio/http 服务器）
```

装进本机的某个 profile 调试（`<本目录>` 用这个仓库的绝对路径）：

```bash
dsh plugin --profile <profile> add link:<本目录>     # 开发用，源码热链接
dsh plugin --profile <profile> add dsh-mcp-status    # 装了 npm 包之后
```

装完 entry id 是 `include:mcp-status`（`plugin_manager list_plugins` 或 loader 条目里能看到）。**改完代码要让它生效**：仅改 `client.js` 刷新浏览器即可；改 `index.js` / `lib/*` 需要让宿主重新 import（`plugin_manager set_plugin` 关再开，或重启 DSH——见「补丁文件与热重载」）。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半体：采集快照、四个 HTTP 路由、system prompt 摘要、`ctx.tools.guard`、开关/重试动作、补丁文件行级编辑。 |
| `client.js` | 浏览器半体：`sidebar.panellist` 一行（含状态点）+ 收起态 `sidebar.toggle.badge` + `main` 面板（key 同 id），React 组件、CSS、中英文文案。 |
| `lib/status.js` | **纯函数层**：`DEFAULT_CONFIG`、`normalizeConfig`、`resolveStatus`、`decideGuard`、`buildHealthText`、`serverNameFromTool`、`sectionOrder`。不 import 任何宿主 API。 |
| `lib/probe.js` | 自带 MCP JSON-RPC 探针（stdio 换行分帧 / streamable-http + SSE），`probeServer(config, { timeoutMs })`。 |
| `test/status.test.mjs` | 状态判定、闸门、摘要、配置归一化的断言（无框架，自带 `check/eq`）。 |
| `lib/probe.test.mjs` | 探针用例，靠 `test/fixtures/echo-stdio.mjs` 和内置 http server。 |
| `locale/{zh,en}.json` | 客户端文案；**所有用户可见文字都必须走这里**。 |
| `cordis.patch.yml` | 安装时插入的插件行，id 固定为 `mcp-status`。 |
| `README.md` | 用户文档：状态表、配置、安装、已知边界。改行为要同步改它。 |

## 架构不变量

违反下面任何一条，都会以「面板显示与真相对不上」的形式爆炸——这是这个项目最主要的 bug 类型。

**A1. 只有一处状态判定。** `lib/status.js#resolveStatus` 是唯一决定 `state/reason` 的地方（`summarizeServers` 只把已有判定聚合成侧栏角标，不重新推导状态）。面板只负责渲染 DTO，prompt 摘要和闸门只读同一份快照。**不要**在 `client.js` 里根据工具数、颜色、按钮状态再推一遍，也不要在 `index.js` 的路由里临时改判定。

**A2. 宿主状态优先。** `dsh-mcp-client` 自己维护连接状态机（`connectionStatusOf(fiber)`：`connecting / connected / reconnecting(attempt,maxAttempts) / failed(reason) / closed / waiting-credentials`），它是「到底连上没有」的唯一权威。我们的 TCP 探活、`/test` 握手结果只是旁证；**探针成功绝不能把宿主已经放弃的连接说成已连接**（v0.2.0 的假绿 bug 就是这么来的，`test/status.test.mjs` 里有专门的回归用例 `gave-up beats a successful probe`）。

**A3. `idle` ≠ 断线。** 工具数为 0 可能只是这行挂在 per-agent 作用域、全局注册表看不见。`idle`（界面「未连接」）不拦工具调用、不进 prompt 摘要；`unreachable`/`failed`/`reconnecting` 才拦。

**A4. 闸门是「有证据才拦」。** `decideGuard` 只在 ①状态属于 `unreachable|failed|reconnecting`、②快照年龄 ≤ `2 × refreshMs` 时返回拒绝原因；`pending`/`connecting`/`no-tools`/`disabled` 一律放行。guard 同步、只否决、不重试、不改状态。

**A5. 状态是派生的，不是可靠的持久真值。** 每次 `/servers` 都强制重采，`checkedAt` 因此永远是「刚刚」——它**不能**用来表示新鲜度，面板副标题用的是「上次状态变化 Ns 前」（客户端按 `id:state:reason` 签名自己记）。

**A6. 开关只改那一行的一个键。** 补丁文件可能同时被 cc-switch 之类的第三方工具整表重写。所以：先 `findRowBlock` 定位行，只增删该行块内的 `disabled:` 行，`writeAtomic` 原子写（同目录临时文件 + rename，保留权限位），写前必须校验块仍在预期位置。**禁止**解析成 YAML 再整体序列化写回，那会毁掉别人的格式与注释。

**A7. 重试 = 真重挂，不是等 HMR。** `hmr.reconcileProfile([id])` 只重启「源文件真的变了 / import 失败」的条目，配置没变时什么都不做（v0.2.0 的重试因此空转 16 s）。正确做法是 `entry.fiber.dispose()` → 清 `entry.options.disabled` → `entry.init()`。三件事缺一不可，理由见「宿主契约」。

**A8. 零依赖。** 运行时不 import 任何第三方包，也不 import `@deepseek-ai/*`（宿主包在 profile 里解析，版本随 DSH 变）。新增依赖要先说清收益，否则 PR 会被拒。

**A9. 只读配置，不显示值。** env / headers 只展示名字，值永远不出宿主进程、不进 DTO、不进日志。

## 状态模型

`resolveStatus(input)` 输入（全部是可观测值，函数本身不碰 I/O）：

```js
{ disabled, fiberState, connection, toolCount, reachable, reachableAt,
  reachDetail, probe, now, probeAssertMs }
```

优先级（自上而下，命中即返回）：

| 顺序 | 条件 | state / reason |
| --- | --- | --- |
| 1 | 行被停用 | `disabled` / `disabled` |
| 2 | fiber 失败 / 未就绪 | `failed` / `fiber-failed`；`pending` / `pending` |
| 3 | 宿主 `connecting` | `pending` / `client-connecting` |
| 4 | 宿主 `reconnecting` | `reconnecting` / `client-reconnecting`（evidence.detail = `n/max`） |
| 5 | 宿主 `failed` | `failed` / `gave-up` 或 `client-failed` |
| 6 | 宿主 `closed` / `waiting-credentials` | `failed` / `client-closed` / `waiting-credentials` |
| 7 | 宿主 `connected` + 旁证否定（新失败 probe / TCP 拒绝） | `unreachable` / `probe-failed` / `tcp-refused` |
| 8 | 宿主 `connected` + 0 工具 | `idle` / `no-tools` |
| 9 | 宿主 `connected` | `connected` / `connected` |
| 10 | 拿不到宿主状态 | 退回纯观测推导（`probe` → TCP → 工具表） |

`evidence[]` 每项形如 `{ signal, value, at, detail? }`，`signal ∈ fiber|client|tools|tcp|probe`。新增信号时同步改 `client.js` 的 `describeEvidence` / `evidenceValue` 和 locale 的 `evidence.*`。

## 路由契约

前缀 `/api/dsh-mcp-status`。全部只接受回环来源；写操作还要求同源（`Origin` 与 `Host` 对得上），否则 403。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/servers` | — | `{ ok, servers: DTO[], patchFiles[], checkedAt }`（整个快照展开），且强制重采一次 |
| GET | `/summary` | — | `{ ok, worst, counts, attention[], names[], more, signature, checkedAt }`；侧栏角标每 5 s 轮询，**只读缓存不强制重采** |
| POST | `/toggle` | `{ id, enabled }` | `{ ok, state, settled, server }` |
| POST | `/retry` | `{ id }` | `{ ok, state, settled, attempts, restarted, server }`；行在补丁文件里被停用时返回 400 + 中文原因 |
| POST | `/test` | `{ id }` | `{ ok, toolsCount, serverInfo, protocolVersion }` 或 `{ ok: false, error }` |

DTO 关键字段：`id`、`entryPath`、`serverName`、`state`、`reason`、`evidence[]`、`disabled`、`fiberState`、`connection`、`toolCount`、`reachable`、`reachDetail`、`checkedAt`、`probe`、`source`、`patchFile`、`target`、`transport`。**新增字段要同时更新 README 的状态表与 `client.js` 的渲染**，否则面板会出现「有数据没人用」。

## 宿主契约（这些没有对外文档，都是读 asar 读出来的，升级 DSH 时要重新确认）

- loader 条目（`ctx.get('loader').entries()`）：`entry.options.id`、`entry.disabled`、`entry.fiber`（`state`: 2 ACTIVE / 3 FAILED / 4 disposed）、`entry.moduleNamespace`（插件模块的命名空间，用来取 `connectionStatusOf`）、`entry.init()`、`entry.refresh()`。
- `entry.refresh()` 在 `this.fiber` 存在时直接 return，**不能**当重挂用；`entry.init()` 会重新 import + `registry.plugin(...)`，且不因 `disabled` 跳过。
- **loader 会把「不是它自己卸载的」fiber 对应的条目标成 `options.disabled = true`**（防止立刻自动重挂）。所以 `restartEntry` 在 `dispose()` 之后、`init()` 之前必须显式清掉这个标记，否则那一行会永久显示「已停用」。
- `hmr.reconcileProfile(ids)` 只重启源文件真的变了的条目；`ids` 只用于诊断。它适合当「源码热重载」，不适合当「重连按钮」。
- `dsh-mcp-client` 放弃重连的条件是连续 `maxAttempts`（默认 10）次失败，之后状态变 `failed(reason: gave-up)` 并**注销工具**；它自己给出的自救提示就是「reload the plugin or restart the Host」——这正是 A7 的来源。
- 本 profile 没有 `dsh-mcp-manager`（`ctx.mcpManager` 的 `restart/probe/list`）可用：MCP 行是补丁文件里各自独立的 insert 条目，别指望 manager 存在。

## 补丁文件与热重载

- 候选补丁文件由 `candidatePatchFiles(ctx)` 按层给出（`DSH_HOME` 或 `~/.dsh` 下的 profile 补丁，后应用的层优先）。
- 行级读写：`findRowBlock(lines, id)` → 改 `disabledIndex` → `writeAtomic`。写失败要抛出可读错误，不要静默降级。
- 改完补丁文件后宿主会尝试应用该层；`plugin_manager` 的返回可能带 `application: "overridden"`（更高优先级层覆盖）或 `"restart-required"` + `restartReason: "package-moved"`——后者意味着**当前进程不会重新 import 插件模块**，必须重启 DSH 才能看到新版代码的行为。遇到它别硬试，直接告诉用户要重启。

## 客户端约定

- 半体通过 `window.__ModuleLoader__.load({ id, factory })` 注册，`factory` 返回 `{ name, inject: ['slots', 'locale'], apply }`；面板注册到 `sidebar.panellist` 与 `main`（两者用同一个 id），收起态角标注册到 `sidebar.toggle.badge`（该槽是 single/root，只在 `!wide` 时渲染，props 为空）。
- 文案：中英文都写在 `locale/*.json` 的 `dsh-mcp-status` 命名空间下；组件里用 `t('key')`，不要写字面量中文/英文。新增 key 要两边都加。
- 样式：只用 `--dsw-alias-*` 主题令牌，跟随宿主明暗；不要引入 CSS 框架、不要写死颜色。
- **面板会卸载，侧栏不会**：面板切到会话/别的插件时整棵树被卸载，而 `sidebar.panellist` 那一行一直在。
  所以给侧栏行（图标、`sidebar.toggle.badge`）用的 CSS 必须由 `apply()` 挂到 `document.head`，
  不能只写在面板组件返回的 `<style>` 里——否则离开面板后点还在 DOM 里，却没有尺寸和颜色，等于消失。
- 组件只消费 DTO，不计算状态（A1）。按钮的可用性、徽标颜色、hint 文案都由 `state`/`reason`/`connection` 决定。
- 长时间操作（toggle/retry/test）用 `busy` 状态驱动按钮文案，失败要在卡片里显示原因，不要只 `console.error`。

## 测试约定

- 不引入测试框架：`node --test` 也不用，保持 `node xxx.mjs` 直接可跑、退出码正确。
- `lib/status.js` 的每个分支都要有断言；新状态/新 reason 必须配回归用例，并说明它防的是什么 bug（现有用例的注释就是范例）。
- 探针用例涉及 I/O，用 fixture 起真进程 / 真 http server，不要 mock 成 `JSON.parse` 小把戏。
- 提交前：`npm test` 全绿 + `node --check index.js && node --check client.js && node --check lib/status.js`。

## 本地验证 recipe

```bash
# 1. 插件 API（端口 = 当前 DSH web server 端口，看 lsof 或 GUI URL）
curl -s http://127.0.0.1:<port>/api/dsh-mcp-status/servers | python3 -m json.tool | head -60

# 2. 重试某一行，观察耗时/attempts/restarted 与工具数是否回来
curl -s -X POST http://127.0.0.1:<port>/api/dsh-mcp-status/retry \
  -H 'content-type: application/json' -d '{"id":"mcp-unityMCP"}'

# 3. 让新代码生效
#    plugin_manager set_plugin target=include:mcp-status enabled=false → true
#    若返回 restart-required → 必须重启 DSH
```

面板侧：侧边栏「MCP 服务器」→ 顶栏应显示「N MCP」或「N MCP · 状态变化 Ns 前」，每行有状态点、工具数、测试/配置/开关；展开行能看到「连接状态」「判定」「依据」。侧栏那一行的图标右上角另有一个 6 px 状态点（有坏行才出现），收起侧栏后顶部的展开按钮上有同色小点。

## 发布

打一个 tag，GitHub Actions 用 OIDC（npm Trusted Publishing）发布；本机不留、也不需要可直发的 npm token：

```bash
npm run release patch                # 也会用在 minor / major / 0.4.0
npm run release patch -- --dry-run   # 只检查、只打印将执行的命令
```

链路：`scripts/release.mjs`（工作区干净 → 在 main 上 → 与 origin 同步 → `npm run check` → `npm version` 提交并打 `v<ver>` tag → `git push origin main --follow-tags`）→ `.github/workflows/publish.yml`（校验 tag 与 package.json 一致 → `npm publish --access public` → `gh release create --generate-notes`）。

- npm 侧一次性配置在 `https://www.npmjs.com/package/dsh-mcp-status/access` → Trusted Publisher：`SonettoGu14` / `dsh-mcp-status` / `publish.yml`，并勾 **Allow npm publish**。**连接建好不可编辑**，换 workflow 文件名等于删掉重建；页面显示 "Pending validation" 时，发布一次即完成校验。
- workflow 的 `permissions` 必须是 `id-token: write`（OIDC）+ `contents: write`（Release），npm CLI 要 `>= 11.5.1`（所以有 `npm install -g npm@^11.5.1`），**不要**给 `setup-node` 设 `registry-url`（会生成带空 `NODE_AUTH_TOKEN` 的 `.npmrc`），workflow 另外 `rm -f .npmrc` 兜底。
- 版本号发布后不可复用：重复 publish 会 403。CI 失败先确认版本是不是已经上去了，再决定改版本还是重跑；`npm view` 有 1~3 分钟延迟，别急着改代码。
- 兜底本机直发：`npm run release patch -- --local-publish`，依赖 `~/.npmrc` 里一把勾了 Bypass 2FA 的 granular token。不是默认路径（这类 token 正在被逐步废弃）。
- 国内网络 push 可能断在 "HTTP2 framing layer"：`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1` 加 `https_proxy/http_proxy/all_proxy`（7897）可过；脚本内部起的 `git fetch` 也吃这些环境变量。
- 首次/新包名会先进 staged 审核（registry 上临时出现 `0.0.0-stage`），几分钟后自动切 `latest`；用 `curl https://registry.npmjs.org/-/package/dsh-mcp-status/dist-tags` 确认。
- `package.json#files` 是白名单：新增运行时文件（如 `lib/*.js`、locale、图标）必须显式加进去，否则发布包里没有。
- 收录信息：awesome-dsh-plugin 列表条目为 `data/plugins/SonettoGu14__dsh-mcp-status.yml`（category `ui`），发新版本后可按需同步描述。

## 不要做

- ❌ 在 `client.js` 里重新推导状态、或直接读工具表猜连接性。
- ❌ 用探活/握手成功覆盖宿主的 `failed`/`reconnecting`。
- ❌ 把 `disabled`/`no-tools`/`pending` 当成断线去拦工具调用。
- ❌ 整体解析-重写补丁文件，或改动其它行、其它插件的配置。
- ❌ 在重试里调用 `hmr.reconcileProfile` 当主路径（它不重挂），或 dispose 后忘记清 `options.disabled`。
- ❌ 显示 env/header 的值，或把 DTO 写进日志。
- ❌ 引入第三方依赖、CSS 框架、测试框架。
- ❌ 改行为不改 README/AGENTS（状态表、路由表、已知边界三处最常漂移）。

## 已知边界（也是常见的用户提问）

- **stdio 行没有端口可探**：存活只能靠宿主连接状态 + 工具数；`no-tools` 不算断线也不显示为已连接。
- **拿不到宿主状态时**（老版本 DSH、条目还没 import）退回观测推导，此时「重连中」无法区分，只能看到「不可达 / 未连接」。
- **重试会短暂摘掉这一行的工具**：dispose + init 是冷启动，重连成功前 `mcp__<server>__*` 不在工具表里。
- **开关可能被第三方覆盖**：若该行由同步 MCP 配置的工具生成，它下次整表重写会覆盖本次开关结果。
- **面板窗口内不刷新宿主的工具表**：工具数是按快照采的，点完重试要等下一次采集（或路由自身的强制重采）才更新。
