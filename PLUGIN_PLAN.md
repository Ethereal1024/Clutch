# 插件系统构筑计划（PLUGIN_PLAN.md）

本文件是组件**安装层**的决定与现况：哪些不变量不许违反、哪几个决定已经冻结、还剩哪些缺口。
契约本体（声明、wire 协议、三种存在形态）在 `COMPONENTS.md`，面板长什么样见 §零之六，
`ssh-workspace` 那一支的设计记录与验收判据在 `SSH_WORKSPACE_PLAN.md`。

## 零、不变量（任何阶段不得违反）

| # | 不变量 | 依据 |
| --- | --- | --- |
| I1 | **发布归模块**：每个模块自己发 `clutch-component.json`，宿主只存 URL 来源 | `market/entries.json`（人维护的那一栏）→ `ui/market.snapshot.json`（生成物）→ tag `market` 的 `index.json`；读它的是 `readIndex()` / `marketEntries()`（`ui/components.js`） |
| I2 | **宿主零字节**：宿主发行包不含 `components/` | `shippedArtifact()`（`ui/components.js`） |
| I3 | **声明说词、宿主释义**：能力词汇（access / gate / mode）归宿主 | `agent/tools/gates.py:1-20`（导入期 `_check_vocabulary` 断言） |
| I4 | **不自建分发服务器**：分发 = 各模块 Release，索引 = 静态 JSON，安装 = 目标机 supervisor | §六 |
| I5 | **不可撤销的动作不得在界面上伪装成可撤销** | 安装确认说 "a removal DELETES bytes…neither act is a rollback"、卸载确认说 "This cannot be undone from here"（逐版卸载同一句并点名那一版），三处都在 `ui/js/components-panel.js`。**停用是协议里唯一不要求确认的写入**：它一个字节都不删，**按钮标签本身就是撤销路径**（零之四.2） |

## 零之二、现况：P0–P5 / C1–C9 已交付

| 阶段 | 交付 | 提交 |
| --- | --- | --- |
| P0 版本语义 | 安装版本 = `<自报版本>+<摘要16>`（`installVersion()`）；没有版本可说的 spec 仍只发摘要前缀 | `42e6ee6` |
| P1 只读可见 | 通道 + 设置弹窗第二个标签 + 市场/已装两份清单；读失败时 `held` 是 `null` 而不是空数组 | `2c473f6`（含 `0b7229e`） |
| P2 单向下发 | 每行安装 + 二次确认 + 进度 + 宿主裁定回显；幂等由宿主的 `current()` 门保证 | `8d11845` |
| P3a/P3b 反向动词 | `GET …/versions`、`DELETE …/<name>[?version=]` + 每行卸载；先停后删、非我启动的 daemon 拒绝 | `90140ea` / `11f6ce4` |
| P3c 停用/启用 | 登记表 `registry.json` 的组件级 `disabled` + 两条开关路由；停用行仍列出、仍可卸载 | `9f53b9c` / `1df203d` |
| P3d 版本明细 | 已装行上的 "…" 披露每一版（版本、摘要、`resolved`），逐版点名卸载；`prune` 拍板不做 | `cdc1625` |
| 零之四.4 目标机自取 | 空 body + `artifact_url` 成了默认形状；同一道 `accept` 门量取到的字节 | `0899dc8` / `abab8cb` |
| P4 工具集 | **未动工**（`interface: "data"`），见 §三 | — |
| P5 静态索引 | **已落地（最小形态）**，私有源未做，见 §三 | 见 §三 |
| C1 别的机器上的进程 | `runs_on: "other"` 在这台机器上是**拒绝**而不是悄悄本地代跑 | `7cb224e` |
| C2 客户端自己的组件域 | `ui/plugin-host.js` + `ui/plugin-child.js`，根 `~/.clutch/client`，登记表 + 摘要门 + 停用位 | `75414ee` |
| C3 反向转发端口表 | `tunnel-core` 的 `channels`：一行 = 首选端口 + 本地监听 + 记住远侧端口；没有模型特例 | `52c8950` |
| C4 声明推送端点 | `agent/tools/channel.py`：端口/令牌/整集声明，内存、fail-closed | `90f8bab` |
| C5 客户端 `/call` 监听 | `ui/plugin-server.js`：Bearer 门、并发上限、只认 `/call` | `219694e` |
| C6 声明推给会话 | `ui/plugin-link.js`：认领时装、整集推、失败重试、非 loopback 拒绝、丢跳清端口 | `69d2279` |
| C7 目的地由声明推出 | `ui/components.js#destinationOf` 是**唯一**说这话的地方：`plugin` + `runs_on: "other"` → 这台客户端；`cli`/`daemon` + `runs_on: "self"` → 会话命令跑的那台；别的配对 = 自相矛盾，只说那句话且不装。页面因此不点名机器，也不显示"目标机" | `b9af086` |
| C8 一个真的客户端插件 | `clutch-websearch/plugin/`：`web_search` / `web_fetch` 的 JS 移植，只用 `http/https/dns/zlib`，没有 `node_modules` | `8522543` |
| C9 别的机器上的文件系统 | `clutch-ssh-workspace/`：`plugin` + `runs_on: other` + `subject: foreign-fs`；真机 e2e 与分发见 `SSH_WORKSPACE_PLAN.md` | `4749a4b` 等 |

C7 明确留着的那一块：降级会话（隧道断了、只剩 ssh 执行桥）里往远侧装一个 daemon——桥是执行
通道不是 supervisor，装不了，页面就说这一句，**绝不改写到本机**
（`ui/js/backend-lifecycle.js#tryDegradeToSshTools`）。

C1–C6 只落在桌面壳：手机宿主不装 `ui/plugin-*.js`，也就不推声明
（`scripts/sync-android-host.sh` 的 `UI_NODE` 不动）。这不是省事——手机目前没有"这台客户端的
插件"这个概念，塞进去只会得到没人调用的死代码。哪天要装，代价是那一组名字 + 一个
`announcePlugins` 的对应物，不是协议。

## 零之三、施工中得到的事实（编号被代码引用，勿重编）

1. **组件端点长在 supervisor 上，不在 session API 上**（最关键的一条）：`GET /api/components`
   与 `POST /api/components/install` 属于 supervisor 进程（本机 `127.0.0.1:8890`，远端 =
   隧道的 `tunnelStatus().url`），而窗口的 session base 是另一个端口、另一个进程，对组件一无所知。
   照 session base 写页面会"看起来正确"——每台机器都显示"没有装任何组件"。所以页面写入的 base
   一律取 supervisor（`ui/components-view.js`），**送到哪台机器**由声明决定（C7）：会话那台的
   **地址**才来自窗口的会话种类（`hostCore.backendKind`）。
2. **supervisor 会空闲退出**（**已补唤醒**，`31d5ec6`，落点 §八 G1）：本机那个按
   `--idle-timeout 25` 起，于是"本机安装"在 supervisor 没在跑时会直接失败，而当初没有任何东西
   会为这次安装把它叫起来。
3. **Android 当初只做了表面齐平**（**已修掉**，`f9238b4`，落点 §八 G2）：`ui/bridge-shim.js`
   暴露了 `clutchComponents`，但 `android/host/android-host.js` 没有 handler，于是每次调用都
   结束于 `no such bridge method: clutchComponents.list`。现在两端建的是**同一个**
   `ui/components-view.js`（共享实现，不是副本）。一条看不见的前提：`scripts/sync-android-host.sh`
   的 `UI_NODE` 手写清单必须包含它，漏掉不会报"少个功能"，而是宿主 require 不到、桥还没 bind
   就死（所以有了 `tests/android-assets.test.js`）。
4. **本机已装版本还是旧形状**：`install()` 落地时会清掉同组件其它版本，下一次安装自然换成带版本
   的目录名，**不需要迁移脚本**。
5. **"谁在跑"只能靠散目录里的记录去数**：daemon 的记录名是**工作区根路径的哈希**
   （`rendezvous._record_path`），从名字复原不出工作区，所以只有一条路可问——列该组件自己的记录
   目录（`_record_dir()`）。这也意味着一个**已经删掉记录**的活进程查不出来：记录是宿主唯一的名册，
   页面上的"有没有在跑"与实际进程之间存在这个窗口。（顺带：今天表里只有 `clutch-workspace` 是
   daemon，其余是 `cli`——一次性进程没有常驻 daemon，"先停后删"对它们恒为真。）
6. **拒绝必须发生在动手之前**：`remove()` 把"有没有在跑"作为调用方的 `stop` 回调接进来，并且
   **只在确实有东西可删时**才调用它——否则一次注定被拒的删除（比如版本号写错）会先把 daemon
   杀掉再报错。同理，宿主对"名字不合法/版本没装"的判断在 `stop` 之前。活体与单测都钉住这一条：
   被拒之后目录还在、进程还在。
7. **停用位住在目标机的表里，而且必须比"检出"更早说话**：`disabled` 的意思是"这台机器不驱动
   它"，所以它属于**持有组件的那台机器**（登记表 `registry.json`，与安装记录同一张表）。VS Code
   把同一个位记在**客户端**，因为它的客户端自己握着已装清单；Clutch **没有客户端侧清单**
   （零之四.3），照抄会让第二个客户端看到假的"在驱动"。落点之外还有**顺序**：拦截必须在解析
   **之后**、交付**之前**（`rendezvous.unavailable_reason()`，`agent/tools/rendezvous.py`），
   否则开发机上"停用了"却因为仓库旁的检出在场而照样把工具递给模型。`reindex()` 是唯一的例外：
   重建**忘掉** `disabled`（磁盘上没有这个形状），重建后要重新停。
8. **一个只有活体才看得见的一次性 Bug**（`9f53b9c` 修掉）：supervisor 的两条路由把**反的极性**
   传给了 `components.set_disabled`，于是 `/disable` 实际上在"重新驱动"。它藏得住是因为参数名
   原来叫 `state`——两个方向读起来都对——而单测只钉了组件层。现在参数一律叫 `disabled`
   （**表里存的那个位**）。教训与零之三.6 同类：**名字和动词是两条独立的信息，极性错位时两边都
   读得通**。
9. **发行清单少了 `runs_on`，插件在市场上"看得见、装不了"**（**已修**，C9 分发时才暴露）：
   `parseManifest()` 从**发行清单**取 `runs_on`，打包版客户端手上没有 checkout，漏写就按 `"self"`
   兜底，于是 `interface: "plugin"` 的组件被页面拒绝安装。生成清单的脚本与 `COMPONENTS.md` 的
   示例形状两边都补上了，`clutch-ssh-workspace/scripts/release-manifest.py` 把插件的缺省当**硬
   错误**。教训：**"声明说词"（I3）的前提是发行侧也把那个词重复一遍**，少一遍不是默认值。

## 零之四、已冻结的五个决定

1. **命令式，不共享状态**：页面只**发命令**（安装 / 卸载 / 停用 / 启用），**单一写者 = 持有那个
   目录的机器上的 supervisor**。这个页面始终是某台机器的客户端，从不是第二个登记处——两份状态
   就没有"以谁为准"的问题。
2. **`disabled` 是每台机器各自的**：同一组件在 A 机停用、在 B 机照跑，两边互不知道；问谁就以谁
   为准。停用不是删除：字节不动、行还在、仍可卸载，而且**不要求确认**（I5 只约束撤不回来的动作）。
3. **手机端不镜像远端的表**：页面**没有任何远端清单缓存**，每问一次就发一次请求
   （`hostInventory()` / `hostVersions()`，同在 `ui/components.js`）。清单是机器的判断，客户端存
   一份就成了"第二份真相"，而且会把"读不到"画成"没有"。
4. **字节默认由目标机自己取，客户端的 `upload()` 只是兜底**：安装请求**两种形状**，一条端点
   一个 header——body 有字节（`upload()`，**只有这台客户端独有的字节**才这样送：检出、预编译
   产物），或 body 为空而 manifest 带 `artifact_url`（`fetchInstall()`，**默认**），目标机自己去取
   （`components.receive()` → `download()`）。只走 http(s)（`file:` 与本地路径一律拒绝——那是这台
   机器自己的盘）、30 秒读超时、64 MiB 封顶、流进 scratch 再过同一道门：门量的是**取到的字节 vs
   请求声明的 `digest`**，所以 URL 不比 body 更松。客户端这边 `artifactFor()` 不再下载 release
   （`publishedArtifact()` 交出去的是位置 + 钉死的摘要），只有几百字节的 `declaration` 还从客户端
   过一趟。
5. **注册表位置 / G1 / G2 / G4 一律"按照 VS Code 的逻辑来"**：G1 = 由目标机自己的二进制按需起
   服务（`cli/src/tunnels/code_server.rs:322-350`）、G2 = 目标端注册同一个通道
   （`src/vs/server/node/serverServices.ts:403-409`）、G4 = 版本一致性是模块仓库自己的事。

## 零之五、客户端插件（`interface: "plugin"`）：四条冻结的界线

有些主体根本不该过隧道——搜索、剪贴板、客户端自己机器上的东西。字节在这边、密钥在这边、出口在
这边，只有一句"我声明了什么工具"需要过去（契约在 `COMPONENTS.md` 第三节）。

1. **两个域、两个根、各一个写者**：目标机的域在 `~/.clutch/components`（写者 = 那台机器的
   supervisor），客户端的域在 `~/.clutch/client`（写者 = **这个客户端**，`ui/plugin-host.js`）。
   一个组件的字节只住在其中一边；`runs_on` 说的就是它住哪边——`other` 的声明到了目标机只剩一个
   **拒绝**（C1），绝不会在那里跑出一份副本。
2. **通道是一句声明，不是一次部署**：客户端把 `{port, token, components}` 推给一个**正在运行**
   的会话进程（`POST /api/channel`），会话照这张表把调用拨回客户端的 `/call`。表是内存、整集、
   重启即空；没有"改一条"，因为两张表对不上时"以谁为准"没有答案。
3. **只推给远端的会话**：本地会话里客户端和会话是同一台机器，客户端插件在那儿就是普通的本地
   组件，这个通道只会重复组件页已有的东西（`ui/main.js#announcePlugins` 只对 tunnel 窗口出手）。
   认领（`api:base`）是**唯一**的推送时刻——也是路径被安装的时刻：远端 loopback 端口只为真的
   可能被调用的会话占用，不为"连上了"占用。
4. **令牌是栅栏，不是沙箱**：`/call` 认 `Authorization: Bearer <token>`，令牌只在推给本机会话
   的那一个请求里出现，所以推送只发往 loopback 的 http base（`ui/plugin-link.js#session()` 拒绝
   一切别的地址）。它买的是"**只有我推过的那个会话能问我**"；fork 买的是"可杀 + 不阻塞主进程"。
   **都不买隔离**：插件以应用权限跑在用户自己的机器上（"插件沙箱"仍是独立非目标），所以这两个
   端口（客户端的 `/call`、远侧 sshd 分配的那个）**绝不是** supervisor 的 8890，也绝不是模型
   代理那个带 key 的端口——一行反向转发的目的地只能是它自己的那一行。

## 零之六、插件面板的不变量（`PLUGIN_UI_PLAN.md` 的结论，文件已删）

**面板恒为单机，一个组件一条记录。** 一次会话只有一个后端：页面问的是哪一台，由
`ui/components-view.js#target()` 一处决定，`list()` 拿这一个 base 去问，交回的就是**这一台机器**
的名册——**没有任何一条代码路径把两台机器的名册并起来**，所以同一个组件不可能被这个面板同时看见
两份。

- **一张清单，一个组件一行**：`plugModel()` 按 name 把 `held` 与 `market` 合成一条记录，先市场
  顺序、再只有机器持有的那些；"未装 / 已装 / 已装 · 可更新 / 已停用 / 本机有、市场不认识 /
  市场有、本机没有"是同一行的状态，两侧独有的信息都进这一行的 chips，**没有信息丢失**。
- **机器身份只住页头**（"作用于 <名字> · <base>"）：行内**不加**"哪台机器"这一列，也不默认挂
  远端角标。`runs_on: other` 真到"同一名字在目标机与客户端各有一份"的那天，答案仍是 VS Code
  那一条——**一行 + 一枚角标**，不新开板块。
- **纯渲染期**：过滤（五个 chip + 一个名字框，默认 `All`）、合并、`…` 菜单都不碰通道
  （`window.clutchComponents` 六个动词不变），也不引入"可更新 / 可回滚"这类新语义——`Updates`
  只是"市场报的版本与所持版本不同"这一条事实的说法，§一 的"没有回滚"原样成立。菜单化只能挪
  **入口**，**I5 的确认句子一句都不许删**。
- **测试契约**：`tests/components-panel.test.js` 按 `.plug-row` / `.plug-name` 定位
  （`rowOf()` / `rowNamed()` / `stateOf()`；`.plug-row` 按整词匹配，因为行还会带 `.stopped` /
  `.busy`）——**这两个类名不许改**，其余类名可以随布局动。行的事实由行末尾**恰一个** sr-only
  节点承载，行里每个控件（含菜单项）用 `aria-describedby` 指向它；`.active` / `.open` / `.busy`
  表达的状态必须同时有 `aria-pressed` / `aria-expanded` / `aria-busy`；`drawnText()` 仍要求
  行里除了名字与一句话什么都不画（sr-only 不算"画出来"）。
- **发布前**：UI 文本保持英文、**不要往 `ui/` 的注释里写 `§`**（v0.1.30 第一次打 tag 就栽在
  这），改完跑 `.venv/bin/python -m tests.ui_fonts_check`；改过 `ui/` 还要跑
  `scripts/sync-android-host.sh` 与 `node tests/android-assets.test.js`。

## 一、目标与非目标

**目标**：设置弹窗第二个标签"插件"；市场清单 + 已装清单（版本**人类可读**）；一键装到当前选定的
机器，带进度与宿主裁定；可卸载 / 停用 / 启用；"工具集"（工具声明 + 模式名 + 提示词）成为可安装
包，`chat` / `work` 降级为内建工具集。

**没有回滚这个功能**：安装覆盖写、卸载删字节，两个方向都撤不回来；回到旧版的路就是**再装一次**
别的那一版（`install()` 落地时会清掉同组件其它版本）。界面因此不画"回滚"，也不需要假装手里有
一份能回到过去的副本（I5）。

**非目标**：账号体系、付费、下载统计、评分评论；中心化发布 API（与 I1 冲突）；组件间依赖求解
（第一版只做"缺谁就说缺谁"）；插件沙箱隔离（插件仍以宿主权限运行，独立议题）。

## 二、四个断点（全部已交付，留作对照）

渲染层无通道 → `clutchComponents` 在 preload 与 bridge-shim 里同名同参；只有读没有反动词 →
卸载 / 停用 / 版本明细都已两头补齐（`prune` 拍板不做）；安装版本是裸摘要前缀 → P0 的
`<版本>+<摘要16>`；纯声明包递不进去 → 空 body 如今是合法请求（零之四.4）。

## 三、剩余阶段

### P4 工具集（`interface: "data"`）

- **不是一行常量**：`catalog.py` 在声明层就拒绝未知 interface，`rendezvous.render_launch()` 只为
  daemon/cli 产出 argv，`facts.py` 规定只有 cli 组件能发布宿主事实。所以 `data` 需要一条
  "无进程"通路：声明可读即可驱，不解析 launch、不启动进程。
- 契约形状（草案）：`{schema:1, name, interface:"data", version, tools:[…声明…], mode:"<名>",
  prompt:"PROMPT.md"}`。
- **动态模式集**：`catalog.MODES` 是常量元组（`agent/tools/catalog.py`），要变成"内建 + 组件
  声明"；`registry.py` 的过滤、`agent/config.py` 的 `mode`、`agent/api/run.py:29-31` 的模式白名单
  随之放宽。
- **提示词**：`agent/core/context.py` 现在追加固定文件 `agent/prompts/mode_*.md`；工具集自带片段。
  可复用 `agent/tools/prompt.py` 的占位符机制（`$config.<field>` / `$backends` / 宿主事实）。
- **降级**：工具集引用了未安装组件提供的工具时，该工具不出现（`registry` 既有逐条过滤），并
  说明"缺谁"——先例是 `prompt.components_unavailable()`。`chat` / `work` 保留为内建工具集，不删。

### P5 静态索引与私有源（索引已落地，私有源未做）

- **索引（已做）**：一份静态 `index.json`，固定地址
  `https://github.com/Ethereal1024/Clutch/releases/download/market/index.json`（tag `market`，
  资产名固定），**所有客户端、所有版本读同一份**。人维护的只有 `market/entries.json`（一行一个
  模块：`id` / `name` / `manifest` / `version` / `summary` / `tags` / `homepage` / `license`）；
  `python3 scripts/market_index.py --write` 取回每行钉住的那份清单、量 `manifest_sha256`、抄出
  `interface` 与 `runs_on`，生成随发行版打包的 `ui/market.snapshot.json`（没有时间戳：市场没变
  则逐字节相同）。`--check` 是 CI 门（快照必须等于今天的 entries）；`.github/workflows/market.yml`
  过门之后把同一份字节发到 tag `market`。客户端读的顺序是活的索引 → `~/.clutch/market/index.json`
  → 随包快照，`origin` / `note` / `unreachable` 如实说明读自哪一层。**权威仍是各模块的
  manifest**：索引只说"去哪读、读到的该是哪一份"，`declaration.sha256` 照样由清单自己钉。
- **加一个模块 = 一行 PR**：`market/entries.json` 多一行 + `--write` + PR。宿主代码不改，也不用
  等宿主发行——这是这次替换的全部目的（旧形状是每个客户端版本自带一份来源清单）。
- **私有源（未做）**：`readManifest()` / `marketEntries()` 的 `fetch(url, {signal})` **不带任何
  header**，要支持 token 必须改；零之四.4 之后**字节是目标机去取**（`components.download()`，
  同样不带 header），所以 token 不光要给客户端，还得递到每一台要装的机器上——私有源至今是
  "没做"，不是"快有了"。撤销是签名过的静态列表（可选）。

## 四、验证

测试清单就是 `tests/` 目录本身（`README.md` 的测试一节不再抄第二份）。写在三条写入上的纪律：
**每条写入都要有"被拒之后什么都没变"的断言**（P3a 的零之三.6、P3c 的幂等）——这三条路径动的
都是别人的机器。端到端手测用一次性 supervisor（`CLUTCH_COMPONENTS_DIR=/tmp/… --port 8899`）：
装 → 再装（必须是 `current`）→ 停用 → 启用 → 单版卸载 → 全部卸载，本机 8890 全程不动。

## 五、风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 不可撤销的远端写入 | 装到别人的机器上，删是删掉字节、没有副本 | 二次确认把"这不是回滚"说在明处（I5）；宿主只删**自己启动**的进程，其它一律拒绝并报 pid。**P3c 把风险分了两档**：三条写入里只有停用是撤得回来的，它因此是唯一不问的 |
| 版本语义断层 | 新旧两种"版本"形状并存 | P0 先统一；宿主落地自带清理，无需迁移脚本 |
| 越权 | 工具集想让宿主执行它定义的行为 | 守 I3：只能引用宿主词汇，导入期断言会大声报错 |
| 动态模式爆炸半径 | P4 改的是"模型看得到哪些工具" | 模式仍由宿主裁定（`registry.py` 的过滤保留），`chat` 语义不因插件变松 |
| 生态空转 | 有页面没插件 | **已满足并超出**：`market/entries.json` 五行全在，第 5 个 `clutch-ssh-workspace` 的 `v0.1.0` 已按同一套 tag→CI→release 流程发出，市场读得到 `runs_on: other` 的声明 |

## 六、为什么不需要自建服务器

- 分发：sha256 钉死（`pinnedAsset()`）⇒ 托管方不可信也安全——而且钉子是在**取字节的那台机器**
  上兑现的（`accept()` `agent/tools/components.py` 量它取到的字节）；asset 相对 source
  （`assetLocation()`）⇒ 换托管零成本。
- 发现：索引是数据文件——一份 `index.json` 所有客户端共读，第 5 个模块 = `market/entries.json`
  多一行 + 一个 PR，宿主零代码改动、也不用发新版。
- 安装：`POST /api/components/install` 长在**目标机**的 supervisor 上，没有账号、配额、每机器
  注册表。只有"账号 / 付费 / 统计 / 集中发布"才逼出服务器，而每一项都与 I1 / I2 冲突。

## 七、待拍板

1. ~~P1 是否单独交付~~ → **已决**：P1 单独一个只读提交（画不出安装按钮就不涉及 I5），P2 同批
   紧跟（`8d11845`）。
2. **旧记录**：是否强制重装以统一版本形状（`install()` 会清掉旧版本目录，代价只是一次上传），
   或让两种形状长期并存。**仍未拍板。**
3. ~~索引仓库（P5）是否建~~ → **已决并已实施**：不另建仓库、不新增托管——索引发在本仓库固定的
   `market` tag 上，人维护的是 `market/entries.json`。索引只存 URL 与摘要（不含任何组件字节），
   "哪一版是当前版"从"各模块的 `releases/latest`"改成"这一行写了哪个版本"。检索/分类仍是页面上
   的本地动作，私有源见 §三 P5。
4. ~~`DELETE` 不带版本号是什么意思~~ → **已决（P3a）**：整个组件一起拿掉，返回 `removed:[…]`
   说明删掉了哪几版；本来就没装 → `absent`，**不是错误**（要求已经成立）；`?version=` 指向没装
   的版本 → 拒绝。
5. ~~停用怎么表示~~ → **已决（P3c）**：**都不选**——状态既不落进组件目录，也不在客户端，而是进
   **持有组件那台机器的登记表**（`registry.json` 的组件级 `disabled`）。理由见零之四.2 与 P3c。
6. ~~"目标机自取字节"什么时候做~~ → **已决并已做**（零之四.4）。安装端点认两种形状，页面按
   "字节在哪"选一条（`file.path ? upload : fetchInstall`）。索引**不必两边都读到**：URL 是客户端
   从**索引那一行点名的清单**里解出来的（`entryManifest` + `assetLocation`），跟着 manifest 递给
   目标机——目标机只认 URL，不认索引。**已知边界**：显式传入的**磁盘上的**索引（`{index: <路径>}`）
   解出来的工件位置也是本地路径，而宿主只取 http(s)（`download()` 拒绝 `file:`），这种索引给出的
   安装今天装不上（索引本身照读；`upload()` 兜底覆盖的是检出与预编译产物，不是磁盘目录）。

## 八、待办（明确留着的缺口）

| # | 缺口 | 想修的话落在哪 |
| --- | --- | --- |
| G1 | ~~本机 supervisor 没在跑时，安装没有"先把它叫起来"这一步~~ → **已交付**：`ensureSupervisor` 注入 `ui/components-view.js`，`install()` 在**第一次需要目标机自己回答之前**唤醒，`wake` 是一段进度。三条界线：**读不叫机器**、**在自己就会拒的请求上不叫**、**只叫本机** | 落地 `31d5ec6`；守 `tests/components-view.test.js`、`tests/server-bootstrap.test.js` |
| G2 | ~~Android 宿主没有 `clutchComponents` handler~~ → **已交付**：`android-host.js` 建**同一个** `ui/components-view.js`，六个动词与桌面端逐字对齐，`supervisorBase: () => null` 保留"这台机器没有 supervisor"那句话 | 落地 `f9238b4`（含 `UI_NODE`）；守 `tests/bridge-server.test.js` 第 9 节、`tests/android-assets.test.js` |
| G3 | 宿主缺反动词（当初是卸载/停用/回滚三件） | **卸载**与**停用/启用**都已两头补齐；**回滚不是功能**（§一），回到旧版就是再装一次 |
| G4 | `clutch-workspace/pyproject.toml` 0.2.0 与其 `component.json` 0.1.0 不一致 | 模块仓库自身：**声明就是版本**，宿主不该猜 |
| G5 | 纯声明包（`interface:"data"`）目前 400 | P4 |
