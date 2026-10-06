# 插件面板 UI 改进计划（PLUGIN_UI_PLAN.md）

本文件只谈**插件标签页长什么样**：从"四块并列"（目标机 / 安装状态 / 本机所持 / 市场）
改成"一个入口 + 一张列表 + 一行一个组件"。

边界：**安装层一行代码都不动**。契约仍是 `COMPONENTS.md`，阶段施工仍在 `PLUGIN_PLAN.md`，
五个冻结决定（§零之四，尤其"命令式不共享状态"与"页面没有任何远端清单缓存"）与 I1–I5
逐条继续成立。本文件的每一步都必须在它们之下成立，凡是与它们冲突的想法一律写在第六节"不做的事"。

## 零、这一轮读的源码

取自 `microsoft/vscode` 的 `main` 分支，路径均在
`src/vs/workbench/contrib/extensions/`（外加一处 server 端）。这几个文件是这一版
Extensions 视图的全部形状来源：

| 文件 | 它在 VS Code 里管什么 | 我们对照的是 |
| --- | --- | --- |
| `browser/extensions.contribution.ts` | 视图容器注册（`:115-130`）、搜索框里的"Filter Extensions..."子菜单（`:1066-1078`）与 11 个过滤入口（`:1094-1283`） | 我们的"过滤行"该有哪些项 |
| `browser/extensionsViewlet.ts` | 容器本身：视图注册表（`:99-521`）、搜索框（`:623-672`）、`doSearch()` 把输入翻译成一组 context key 决定谁可见（`:893-922`） | 面板的页头与"谁在什么时候显示" |
| `browser/extensionsViews.ts` | 一个视图 = 一条默认查询（`:1296-1330`）、查询语言（`:1165-1217`）、本地过滤（`:368-416`）、视图的消息框（`:188-209`、`:362`） | 列表、过滤、空/失败态 |
| `browser/extensionsList.ts` | 一行的模板（`:70-159`）与行级状态类（`:185-191`） | 行里放什么 |
| `browser/extensionsActions.ts` | 主按钮的状态机（`InstallAction` `:432-500`）、远端安装（`:732-889`）、"…"菜单（`ManageExtensionAction` `:1338-1417`）、"Install Specific Version..."（`:1580-1652`） | 每行的动作 |
| `browser/extensionsWidgets.ts` | 远端徽章（`:484-518`）、Workspace/Local 指示（`:596-672`） | 目标机身份怎么画 |
| `browser/extensionsViewer.ts` | `ExtensionsList`：单击一行 → 打开详情编辑器（`:52-140`，`openOnSingleClick: true`、`:112-127`） | 列表与详情分离 |
| `common/extensions.ts` | `ExtensionState`（`:48-53`）与 `IExtension` 的字段（`state`/`outdated`/`enablementState`/`runtimeState`） | 一行要表达的状态 |

（远端机器自己管扩展这件事，`PLUGIN_PLAN.md` §零之四.5 引的
`src/vs/server/node/serverServices.ts:403-409` 已经在 G1/G2 里落过地，本文件不重复。）

## 一、VS Code 的七条设计事实

### 1. 只有**一个**入口，没有"板块"

整个扩展界面是**一个视图容器**（`extensions.contribution.ts:115-130`，侧边栏一个图标、
`Ctrl+Shift+X`），容器里注册了二十来个 view，但**它们不是并列展示的**——每个 view 都带
`when:` 条件，由搜索框里的字符串决定谁出现（`extensionsViewlet.ts:893-922` 把输入翻译成
`searchInstalledExtensions` / `searchEnabledExtensions` / `searchOutdatedExtensions`… 一堆
context key，`:99-521` 的每个 view 各自声明条件）。输入框为空时显示"默认视图"（Installed /
Popular / Recommended），有输入时默认视图整批让位给搜索视图。

这就是"简洁"的第一个来源：**用户看到的是"当前这一个问题"的答案**，不是一个机房里所有仪表盘。

### 2. 一个视图 = 一条默认查询，不是一个页面

`DefaultPopularExtensionsView`、`ServerInstalledExtensionsView`、`EnabledExtensionsView`、
`DisabledExtensionsView` 全都只有十来行：override `show()`，把默认查询设成
`@popular` / `@installed` / `@enabled` / `@disabled`（`extensionsViews.ts:1296-1330`）。
筛出哪些扩展、怎么排序，全在同一个 `filterLocal()`（`:368-416`）。

推论：**"分区"是过滤器的一种说法，不是布局**。多一个分区 ≈ 多一条查询，不需要多一块 UI。

### 3. 多台机器 = 标题前缀，不是并列的区

`extensionsViewlet.ts:187-189`：

```ts
const getViewName = (viewTitle: string, server) =>
	servers.length > 1 ? `${server.label} - ${viewTitle}` : viewTitle;
```

需要并列时（本机 + 远端同时有扩展管理），"Installed" 视图**每台服务器一个**，标题里带机器名
（`:197-216`），并且此时不允许隐藏；只有一台服务器时反过来，Enabled/Disabled 视图
`hideByDefault: true`（`:290-321`）——默认折叠，因为它们平时没什么可看的。

远端身份在行上则是**一枚徽章**：`RemoteBadgeWidget`（`extensionsWidgets.ts:484-518`）只在
"这个扩展装在那台远端服务器上、且两端都存在"时才挂上去，tooltip 是
`Extension in {0}`。**没有第二块面板在讲远端。**

### 4. 一行 = 一枚主按钮 + 一个"…"菜单

一行的模板（`extensionsList.ts:70-159`）：图标（+ 三枚可选角标）→ 名字 → 行内状态位
（restart required / install count / rating / sync-ignored / kind）→ 描述一行 → 发布者 →
**动作条**。动作条里塞了十几个 action（`:116-129`），但它们**按状态各自显隐**，任何时刻
一行上真正看得见的是：

* 一个**主按钮**：`Install`（未装）、`Install in {远端}`（装了、可以装到远端，
  `extensionsActions.ts:840-857`）、`Install Locally`（`:859-871`）、`Update`（可更新）、
  `Installing…`（在飞，`:718-730`）；
* 一个 **"…"**（`ManageExtensionAction`，`:1338-1417`），菜单分组固定：
  启用（全局/工作区）→ 禁用 → 更新 → **Install Specific Version…** → **Uninstall**。

要点是 `InstallAction.computeAndUpdateEnablement()`（`:472-500`）：不适用时它
`hidden = true`，**是"不画"，不是"画成灰的"**；只有"这动作现在真能用/真不能用"才用 disabled。

### 5. 状态不是区块，是同一行的标签与类

* `ExtensionState`（`common/extensions.ts:48-53`）：Uninstalled / Installing / Installed /
  Uninstalling——**状态属于那一行**。
* 停用的扩展：整行加 `.disabled` 类变灰（`extensionsList.ts:185-191`），同时可以被
  `@enabled` / `@disabled` 两条查询分别列出；弃用的加 `.deprecated`。
* 结果与失败不进页面主体：`onError` 弹通知（`extensionsViewlet.ts:993-1014`，连
  `ECONNREFUSED` 都给一句"去看看 http.proxy"），安装失败的细节挂在那一行/那个弹出的详情页上。

### 6. 读失败是**视图的消息**，不是空清单

每个视图都有 `messageContainer / messageSeverityIcon / messageBox`（`extensionsViews.ts:188-209`），
查询回来的 `{text, severity}` 画在那里（`:362`），`showEmptyModel()`（`:284-288`）表示
"这条查询本来就没有东西"。两者的区别就是这么表达的——和我们的"读失败是数据"是同一条纪律，
只是它有固定的落点。

### 7. 列表永远不膨胀：详情去编辑器

`extensionsViewer.ts:112-127`：单击一行 → `extensionsWorkbenchService.open(extension)`，在
**编辑器**里开一个扩展详情页（Readme / Features / Changelog 标签）。列表里永远只有
"名字 + 一句描述 + 一行状态 + 两个控件"。

### 小结：VS Code 的简洁 = 五个"一个"

一个入口（搜索框）、一族过滤器（视图）、一行一个对象、一行一个主按钮 + 一个菜单、
一份详情在别处。我们的四块并列，恰好每一对都在"两个"上出错。

## 二、我们今天的形状

`ui/index.html:76-87` 定了容器，`ui/js/components-panel.js` 填它：

```
plug-head   ："target machine" + 名字 + ↻                    （第 1 块）
plug-base   ：一行 supervisor URL
plug-note   ：在飞的写 / 上一次裁定 / 读失败 / "reading…"      （第 2 块）
plug-body
  ├─ plugHeldSection  "On this machine (n)"                  （第 3 块，:153-184）
  └─ plugMarketSection "Market (n of m source(s))"           （第 4 块，:677-712）
```

对照着看，代价是七条，按"用户会真的撞上"排序：

| # | 今天 | 代价 |
| --- | --- | --- |
| 1 | 同一个组件在"所持"与"市场"各占一行（`:162-183` 与 `:685-691`），装没装要靠用户把两行对起来 | 用户要自己拼安装状态；同一事实两处画，两处都可能过期 |
| 2 | 目标是 SSH 主机时，标题仍写 `On this machine`（`:183`） | **这一条就是"远程主机/本地主机"被看成两个板块的根源**：页头说是远端，下面的分区说是"这台机器" |
| 3 | 安装进度、宿主裁定、读失败全塞在 `plug-note` 一行（`:718-741`） | 状态与它描述的那一行没有视觉联系，而且下一次读会把它冲掉 |
| 4 | 每行最多四个按钮：`Versions` / `Disable` / `Remove` / `Install`（`:179`、`:690`） | 窄屏（手机）挤成一排，主次不分：最贵的动作（Remove）和最便宜的动作（Versions）一样显眼 |
| 5 | digest、source URL、"release under it"、路径全铺在行里（`:130-151`、`:295-331`） | 行高是给机器看的，不是给人看的 |
| 6 | 来源读不到时在"市场"节里追加若干 `<p class="plug-source-error">`（`:704-710`） | 报错成了清单的一部分，越长越像"内容" |
| 7 | 没有过滤：4 条以上就只能人眼扫（今天真机 4 条，已是临界） | 装到十条就不可用了 |

另外两处小账：`Market (n of m source(s))` 这个 `n of m` 说的是"来源数"，不是"可装数"；
`sources` 只在构造这句时用过（`ui/components-view.js:104-115`）。

## 二之二、一条不变量：面板恒为单机，一个组件一条记录

这一节把"为什么不可能出现近/远两行"钉在代码上——它是 U-1 的前提，也是 U-2 与 U-8 的尺度。

### 事实（我们的架构）

* **一次会话只有一个后端。** 组件长在 **supervisor** 那台机器上，而页面问的是哪一台，
  由 `ui/components-view.js:49-57` 的 `target(win)` 一处决定：它返回**一个** `{kind, base}`——
  会话在隧道对端就是对端，否则就是本机。`list()`（`:68-82`）拿这一个 base 去
  `hostInventory`，交回的就是**这一台机器**的名册。**没有任何一条代码路径把两台机器的名册并起来。**
* **组件落在哪台机器，由"会话的目标机"决定，不是组件天生的属性。** `clutch-workspace`
  在本机会话里装本机、在隧道会话里装对端——同一个组件、两种机器，但**一次只可能落在其一**，
  因为它永远是"被问的那台机器自己的表"（`agent/tools/rendezvous.py:25-27`：宿主只运行装在
  **它自己**机器上的组件）。
* 所以对一个前后端组合，某组件在这台目标机上**"有或没有"是唯一的一个答案**：不存在
  "同一个组件被这个面板同时看见两份"的场景，也就不需要为同一个组件画两个条目。

### 结论（对本计划的约束）

1. **一张清单，一个组件一行**（U-1 由"可以"升级为"唯一正确"）。
2. **机器身份只住页头**（U-2）：行里每一行都属于页头点名的同一台机器，行内不需要
   "哪台机器"这一列，也不需要默认挂远端角标。
3. 现有测试"定位到某一行"的方式（`tests/components-panel.test.js:97-106`）只认
   `plug-row` / `plug-name`，与机器无关——U0 合并后语义反而更直白。

### VS Code 对照：结论一样，理由不同（一个必须说清的差别）

"某个插件固定装在某侧"这个直觉，在 VS Code 里其实是 `extensionKind`（`ui` / `workspace` /
`web`）：扩展**声明**它想在哪跑，`remote.extensionKind` 还能逐条覆盖。但 VS Code 比我们**更宽松**：
本机与远端扩展宿主在一个窗口里**同时存在**，同一个扩展**可以两边都装**——这正是
`Install in {remote}` / `Install Locally` 两个动作存在的原因（`extensionsActions.ts:840-871`，
`RemoteInstallAction` / `LocalInstallAction`），行状态里因此会出现 "Please reload to enable
this extension in {remote}"（`extensionsActions.ts:2961-2969`）。

**即便这样，VS Code 也从不画两行。** 证据在 `ExtensionsWorkbenchService`：

* `installed` 把**每台服务器**的本机清单首尾相接（可能含重复），`:1395-1405`；
* 但列表读的是 `get local()`（`:1379-1392`）：它 `groupByExtension(...)` 按 identifier 分组，
  每组只 `push(getPrimaryExtension(组))`——**一个 identifier 一行**；
* `getPrimaryExtension()`（`:1902-2004`）是"谁入选"的规则：可用的压过停用的；都可用时由
  `extensionKind` 决定（`ui`→本机那份、`workspace`→远端那份、`web`→web 那份），再退到
  "本机 workspace / 本机 web / 远端 web"，最后 `extensions[0]` 兜底；
* 入选的那一行再把本机/远端说成**行上的事实**：一枚 `RemoteBadgeWidget` 角标
  （`extensionsWidgets.ts:484-518`，只在入选者的 `server === 远端` 时出现）、主按钮的标签、
  一条状态警告——**不是第二个板块**；
* 市场侧同样去重：已装的扩展不再作为"可装"出现（`extensionsViews.ts:320-333`）：`:325`
  把已在本机结果里的 id 从 gallery 查询里滤掉——**这正是 U-1 要的"一行一件事"**。

VS Code 唯一会把同一扩展放到两个标题下的地方，是**多服务器时的"每台服务器一个 Installed
视图"**：`extensionsViews.ts:348` 在视图显式带 `server` 时改用**未去重**的
`installed.filter(e => e.server === 该服务器)`，视图标题由 `extensionsViewlet.ts:187-189`
加上机器名——但那是**两个视图、一次显一个**，不是一张清单里的两行。我们的会话只有一个
目标机，这个分支在我们这里不存在。

### 唯一要留的余地

`runs_on: "other"` 是**预留**（`COMPONENTS.md:83`；`rendezvous.py:19-23`）：将来若出现
"服务另一台机器文件系统"或"被另一个宿主反向调用的客户端组件"，设计意图是**往表里加一条
entry，而不是给工具加一个分支**——每台机器仍渲染自己的那张表，单机视角不变。真到
"同一名字在目标机与客户端各有一份"的那天，答案仍旧是 VS Code 那一条：**一行 + 一枚角标**，
不新开板块。U-8 的角标因此保留为那个未来的位置，今天不默认挂上。

## 三、改进点清单

优先级：**P0 = 用户这次的抱怨本身**；P1 = 让列表在十条以上仍可用；P2 = 打磨。
"动通道？"一列都是 **否**：`ui/components-view.js` 今天给的
`target/list/market/install/versions/remove/setDisabled` 已经足够（`:49/:68/:118/:141/:244/:262/:285`），
下面每一条都只改 `ui/js/components-panel.js` + `ui/style.css`（+ `ui/mobile.css`）。

| # | 优先级 | 改什么 | 依据 |
| --- | --- | --- | --- |
| U-1 | P0 | **一张清单**：`held` 与 `market` 先合成"一个组件一条记录"，再渲染。行状态：`未装` / `已装` / `已装 · 可更新` / `已停用` / `本机有、市场不认识` / `市场有、本机没有` | `extensionsViews.ts:1296-1330`（视图=查询）、`extensions.contribution.ts` 里 Popular/Installed 都是"扩展一行" |
| U-2 | P0 | **命名修正**：所持分区的标题不再写 `On this machine`，而写**目标机名**（`plugTargetName()` `:60-71` 已有的那个名字），页头与列表说的是同一台机器 | `extensionsViewlet.ts:187-189` |
| U-3 | P0 | **主按钮跟状态走**：`Install` / `Reinstall`（已有逻辑 `:364-393`）、`Disable`（已装且在跑）、`Enable`（已停用）；不适用时**换形状或收进菜单，不再画一排灰按钮** | `extensionsActions.ts:472-500`（不适用即 hidden）、`:1424-1432` |
| U-4 | P1 | **过滤行**：`All / Installed / Market / Updates / Stopped` 五个 chip + 一个按名字过滤的输入框；默认 `All` | `extensionsViewlet.ts:893-922`、`extensions.contribution.ts:1189-1283` 的 11 个过滤入口 |
| U-5 | P1 | **"…"菜单**收纳次级动作：`Versions`、`Remove`（整个/单版）、`Reinstall`… 一行只剩主按钮 + `…` | `extensionsList.ts:116-129`、`extensionsActions.ts:1338-1417` |
| U-6 | P1 | **安装状态回到它那一行**：`plugState.busy.name === item.name` 时该行加 `.busy` 并在行内画 `plugStageLine()`（`:399-427`）；`plug-note` 只留全局故障与"读失败" | `InstallingLabelAction`（`:718-730`）、视图消息框（`extensionsViews.ts:188-209`） |
| U-7 | P1 | **停止 = 整行变灰**（`.plug-row.stopped`），`stopped` chip 保留作说明 | `extensionsList.ts:185-191` |
| U-8 | P2 | **目标机身份**：页头压成一行"作用于 <名字> · <base>"；机器只住页头，行内**不**加"哪台机器"列。远端角标留作 `runs_on=other` 出现时的位置（§二之二末），今天不默认挂 | `extensionsViewlet.ts:187-189`（标题前缀）、`extensionsWidgets.ts:484-518` |
| U-9 | P2 | **计数**：过滤 chip 各自带计数（`Installed 3`、`Updates 1`）。Tab 徽章**决定不做**（理由见 §七） | `extensionsViews.ts:179-186`（CountBadge）、`extensionsViewlet.ts:1026-1074`（activity bar 徽章） |
| U-10 | P2 | **次级信息折叠**：digest / source / release-under-it / 路径进 `title=` 与 `Versions` 展开区；市场那段常驻警告（`:697-701`）改成 hover | `extensionsList.ts:88`（描述一行省略）、`:70-159` 行内不放元数据 |
| U-11 | P2 | **来源失败的落点**：一处（列表顶/尾）的 `plug-source-error` 汇总行，而不是散在清单里 | `extensionsViews.ts:362` |
| U-12 | P2 | **空态**：一条查询零结果是"这条过滤没有东西"（可读句），读失败仍是失败句——两句不能长得一样 | `extensionsViews.ts:284-288` vs `:362` |

### 我们**不抄**的三件事（写下来免得日后返工）

1. **查询语言**：VS Code 让用户看见 `@installed` / `@enabled` 这种语法（`:1199-1217`）。
   我们只有六个动词、四个来源，chip 过滤即可；`@` 语法是我们的内部词汇，不进 UI。
2. **每台机器一个视图**：VS Code 多服务器时并列视图是它的一等公民（`:197-216`）。
   我们的页面对应**唯一一台目标机**（§零之四.1），页头点名它，列表不再分机器。
3. **详情编辑器**：我们没有编辑器容器，`Versions` 展开区就是我们的详情位（零之四.3 也要求
   这个展开区是"读回来的机器自己的答案"，不是我们存的一份）。

## 四、施工顺序

每步都独立可发布、独立可回滚；每一步的验收都是**先跑绿现有测试，再加新断言**。

```mermaid
flowchart TD
  U0["U0 合并成一张清单<br/>一行一个组件（P0）"] --> U1["U1 命名修正<br/>标题 = 目标机（P0）"]
  U1 --> U2["U2 主按钮随状态走<br/>不适用就换形状（P0）"]
  U2 --> U3["U3 过滤行<br/>chip + 名字过滤（P1）"]
  U3 --> U4["U4 菜单收敛<br/>主按钮 + ⋯（P1）"]
  U4 --> U5["U5 行内状态与整行灰<br/>busy / stopped（P1）"]
  U5 --> U6["U6 打磨<br/>徽章 / 计数 / 折叠 / 空态（P2）"]
```

### U0 一张清单（P0）

* 新增 `plugModel()`：把 `plugState.held` 与 `plugState.market.entries` 按 name 合成
  `[{name, interface, version, held, entry, state}]`；`state` 由
  `held`/`entry`/`entry.published` 三者的关系推出（今天这段判断散在
  `plugMarketLines()` `:130-151` 与 `plugHeldSection()` `:161-183` 两处，正好合并）。
* `renderPlugins()`（`:714-744`）只画一个列表；`plugSection()`（`:110-125`）保留，
  但退化成"视图标题 + 计数"，不再承担分区语义。
* 语义上**没有任何信息丢失**：市场侧独有的 `interface/origin/version` 与所持侧独有的
  `digest/disabled/path` 都进同一行的 chips。
* 验收：`node tests/components-panel.test.js` 30 条里，"某控制在哪一行"的定位从
  "市场行 / 所持行"变成"同一个组件的那一行"——**改的是定位方式，不是断言的事实**。

### U1 命名修正（P0）

* `plugHeldSection()` 的标题换成目标机名；列表顶部只留一行"这台机器：<名字> · <url>"。
* 顺带修 `Market (n of m source(s))`：改成 `Market · m sources`（`n` 是"能装的条数"，
  应该由 U0 的模型统计出来，而不是来源数）。

### U2 主按钮随状态走（P0）

* `plugInstallButton()`（`:364-393`）与 `plugSwitchButton()`（`:204-230`）合并成
  `plugPrimaryButton(item)`：`未装 → Install`、`已装同版 → Reinstall`、
  `已装且停用 → Enable`、`已装且在跑 → Disable`。
* `plugRemoveButton()`（`:237-255`）与 `plugVersionsButton()`（`:262-288`）收进 `…` 菜单。
* **I5 不变**：`Remove` 仍然先问、问题里仍然点名版本与机器、仍然说"nothing here keeps a copy"
  （`:490-497`、`:528-536`）；`Disable` 仍然不问（`:607-631` 的注释仍然是它的依据）。
  菜单化只改**入口位置**，不改确认文案——测试的 10/13/18/29 号用例继续盯这一条。

### U3 过滤行（P1）

* 新元素 `#plug-filter`（`ui/index.html:86` 之前），`plugState.filter = "all"` +
  `plugState.query = ""`；`plugVisibleRows()` 在渲染期过滤，**不落盘、不发请求**
  （零之四.3：页面不留第二份真相；过滤是"看"的一种，不是"存"的一种）。
* `Updates` 的判定就是 U0 模型里 `已装 · 可更新` 那一条（今天已经在
  `plugMarketLines()` 里算过：`own.split("+")[0] !== offered`）。

### U4 菜单收敛（P1）

* 一个不依赖框架的 `plugMenu(el, items)`：点击在主按钮右侧弹出一个绝对定位的列表，
  失去焦点即关；项就是现有 handler（`plugInstall` / `plugRemove` / `plugSwitch` /
  `plugVersionsToggle`），一个都不新写。
* 手机（`ui/mobile.css:174-182`）上 `…` 菜单要能点：宽度、`title` 与触摸目标同步调。

### U5 行内状态与整行灰（P1）

* `plugState.busy` 命中某行时，行内画 `plugStageLine()`；`plugState.result` 落到对应行的
  行内一行，`plug-note` 只剩"读失败 / 通道缺失 / 全局故障"。
* 整行灰：`.plug-row.stopped`（U-7），`disabled` 的说明句从 `plug-line` 降进 `title=`
  （`:174`），行内只留 `stopped` chip。

### U6 打磨（P2）

* 计数徽章（U-9）、次级信息折叠（U-10）、来源失败汇总（U-11）、空态与失败态的
  两句分家（U-12）、远端角标（U-8）。
* **已落地**：chip 计数（U-9 的前半）、空态与失败态分句（U-12）、`Versions` 展开区的
  缩进样式。**决定不做**：Tab 徽章。**仍未做**：U-10 折叠、U-11 汇总、U-8 远端角标。
  逐条见 §七。

## 五、验收与护栏

* **面板自己的测试**：`node tests/components-panel.test.js`（34 组）是这次改造的
  唯一硬约束。它的 mini-DOM 按 `plug-row` / `plug-name` 定位（`tests/components-panel.test.js:99-125`
  的 `rowOf()` / `rowNamed()` / `stateOf()`），
  所以 U0 起手就要**保住 `.plug-row` 与 `.plug-name` 这两个类名**（行首是名字），
  其余类名可以随布局改。定位方式的变化集中在 `rowOf()` / `ownerName()` / `stateOf()` 三处
  （`.plug-row` 现用正则 `/(^| )plug-row( |$)/` 匹配整词，因为行也会带状态类
  `.stopped` / `.busy`），断言里的**事实**（哪台机器、什么代价、宿主裁定原文）一条都不许放松。
* 新增断言（U1–U2 就要加）：过滤行只改可见性不改数据；`Updates` 只列出"已装且市场版本不同"的；
  `…` 菜单里的 `Remove` 与今天一样先问；`Disable` 依然不问。
* **通道测试不动**：`tests/components-view.test.js`、`tests/components.test.js`、
  `tests/bridge-server.test.js` 第 9 节（手机宿主）应全程保持绿——如果它们红了，
  说明改动越界到了通道。
* **手机资产**：`android/app/src/main/assets/ui/` 是 `ui/` 的拷贝，改完跑
  `scripts/sync-android-host.sh`，再跑 `node tests/android-assets.test.js`。
* **字体验证**（发布前的 deb 前置守卫）：新增的 UI 文本保持英文；**不要往 `ui/` 的注释里写
  `§`**（v0.1.30 第一次打 tag 就栽在这），改完跑 `.venv/bin/python -m tests.ui_fonts_check`。
* **端到端手测**（沿用 P2 的配方）：一次性 supervisor（`CLUTCH_COMPONENTS_DIR=/tmp/… --port 8899`），
  真面板指过去，走一遍 装 → 再装（current）→ 停用 → 启用 → 单版卸载 → 全部卸载；
  本机 8890 全程不动。

## 六、明确不做的事

1. **不给面板加通道 / 端点**：过滤、合并、菜单全是渲染期的事（U-1/U-3/U-4 都不碰
   `window.clutchComponents`）。这条守住了，UI 改造就永远不会动到宿主契约。
2. **不引入"可更新/可回滚"这类新语义**：`Updates` 只是"市场报的版本与所持版本不同"这一条
   事实的说法；§一 的"没有回滚"原样成立。
3. **不把市场常驻警告搬进 `title=` 时削弱它**：`Remove` 的确认框（`:490-497`）与单版确认
   （`:528-536`）是 I5 的落点，菜单化只能挪入口，不能删句子。
4. **不抄 `@` 查询语法、不抄多服务器并列视图、不抄编辑器详情页**（第三节末三条）。
5. **不动 P4/P5/G4**。这次是纯外观工程，与工具集契约无关；U 系列做完之后，P4 的行号锚点
   会漂（`ui/js/components-panel.js` 会大改），届时按 PLUGIN_PLAN §三 P4 的清单重新对一次即可。

## 七、落地记录（U0–U6）

按 §四 的顺序实施，每一步都先跑绿现有测试再加新断言。通道（`ui/components-view.js`）与
安装层（P4/P5/G4、supervisor 端点）**全程未动**：过滤 / 合并 / 菜单 / 状态行都是渲染期的事。

### U0 一张清单

* 新增 `plugModel()`（按 name 把 `plugState.market.entries` 与 `plugState.held` 合成一条记录），
  `plugItemChips()` / `plugItemLines()` 从合并后的记录推出 chips 与说明行。
* 已删 `plugMarketLines()` / `plugHeldSection()` / `plugMarketSection()`。`plugSection()` 退化成
  "视图标题 + 计数"。
* 槽位顺序：先市场顺序，再合并只有机器持有的组件。

### U1 命名修正

* 列表标题 = 目标机名（`plugTargetName`），计数降进 `.plug-meta`（mono、小号、不随标题大写）。

### U2 主按钮随状态走

* `plugPrimaryButton(item)`：`item.entry` 存在 → `Install` / `Reinstall`；否则 `item.held` → `Enable` / `Disable`。
* `plugItemMenuItems(item)`：`entry && held` → 菜单里的 switch；`held` → `Versions` + `Remove`。
* **偏离计划一**：`Reinstall` **永远留主按钮**，不收进菜单。市场的条目本身的用途就是"把它放上这台机器"，
  已装同版时"再装一次"仍是它的主操作；进菜单会变成"要点开菜单才知道还能不能再装"。
* I5 不变：`Remove` 先问、问题里点名版本与机器、说 `nothing here keeps a copy`；`Disable` 不问。

### U3 过滤行

* `ui/index.html` 在 `plug-note` 与 `plug-body` 之间加 `div#plug-filter.plug-filter`；
  `plugState.filter = "all"`、`plugState.query = ""`（不落盘、不发请求）。
* `plugFilterRow()` **只建一次**（重建会把输入框的 caret 抢走），`plugDrawFilter()` 只重画状态类与计数。
* `plugItemShown(item)` = 名字 query 命中 且 `plugItemMatches(item, plugState.filter)`。
* 五个视图 `PLUG_FILTERS`：`all` / `installed` / `market` / `updates` / `stopped`。

### U4 菜单收敛

* `plugMenu(items)` / `plugMoreButton(name, menu)` / `plugCloseMenus()`，范式照 `ui/js/settings.js` 的下拉
  （按钮 `stopPropagation` + document click 收起）。菜单项**常驻 DOM**，只由 `.open` 决定可见——
  所以 `switches()` / `removes()` / `versionBtns()` 的计数断言全部照旧（"一个只在该出现时才被建出来的
  控件，是页面没法被问到、也没法被 `title` 的控件"）。
* 手机（`ui/mobile.css`）：`…` 与菜单项补 7px/12px 的手指目标。

### U5 行内状态与整行灰

* `plugItemState(item)` → `{text, cls, row}`；`plugRow(name, chips, lines, actions, extra, state)`
  在行头之后插 `div.plug-line.plug-state`。
* 写操作的 stage 与宿主裁定画在该组件**自己的行**上；`plug-note` 只剩读失败 / 孤儿写 / `reading…`。
* `plugOrphanLine()` 兜底：当写操作的行不在屏幕上（被卸载掉、被过滤隐藏），把 stage / 裁定落回 note——
  "起了一次写却对它闭口的页面，是丢掉一次删除的页面"。
* 三个 result 工厂（`plugInstallResult` / `plugRemoveResult` / `plugSwitchResult`）都带 `name`，供行内定位。
* **偏离计划二**：保留可见的说明句 `held on this machine, but not driven: its tools are not offered here`，
  **不**降进 `title=`。理由：这是"held ≠ driven"唯一的可见解释；而且要保住测试 17 的事实断言。
* 整行灰：`.plug-row.stopped`（不驱动）与 `.plug-row.busy`（写飞行中，stage 行保持全重）。

### U6 打磨

* **chip 计数（U-9 前半）**：`plugItemMatches(item, filter)` 抽出来给"过滤"与"计数"共用；
  `plugDrawFilter()` 用 `plugModel()` 算**不受名字 query 影响**的计数（chip 的数字是那个视图里有多少，
  不是名字框此刻拼出了多少）；0 不画（空清单下面那句已经解释了空）。
* **空态分句（U-12）**：`plugEmptyText(known, shown)` 把"没读完 / 读失败 / 过滤没命中 / 机器真的是空"
  分成不同句子；`plug-meta` 补 `market unreadable`（与 `inventory unreadable` 对称）。
* **Versions 展开区**：`.plug-versions-box { margin: 6px 0 2px 10px; padding-left: 10px; border-left: 1px solid var(--border) }`
  （嵌套列表，不与 held 行同级），`.plug-versions.open` 亮起（同一个控件的第二态）。

### U-9 的 Tab 徽章：决定不做

插件面板的数据**只在打开标签页时才读**（`settings-tab-plugins` 的点击 → `pluginTabShown()` → `plugRead()`）。
给 tab 画"有可更新"的徽章，就意味着在用户开口之前就去读机器与市场——这与"面板的数据模型是打开时才有的"
这一条直接冲突。计数留在 chip 上，那里是数据已经读过之后的地方。

### 测试与护栏

* `tests/components-panel.test.js`：33 组 → **34 组**（第 34 组是 U6 的 chip 计数；第 33 组孤儿兜底是 U5 加的）。
  定位方式改成正则与 `rowNamed()` / `stateOf()`；断言的事实一条没放松。
* 收尾全绿：`components-panel` / `components-view` / `components` / `bridge-server` 四个 node 测试，
  `.venv/bin/python -m tests.ui_fonts_check`、`scripts/sync-android-host.sh`、`node tests/android-assets.test.js`。

### 仍未做

* U-10 次级信息折叠 → **0.1.33 已做，见 §八 8.2**；U-11 来源失败汇总、U-8 远端角标（等 `runs_on=other` 真的出现再挂）。

## 八、0.1.33：按 VS Code 的实现回改（用户验收意见五条）

v0.1.32 的成品被用户判为"极其不专业"并逐条指出。这一轮**先把 VS Code 源码拉下来**（落盘临时目录
`.vsc-ref/`：`extensionsList.ts` / `extensionsActions.ts` / `extension.css` / `extensionsWidgets.ts` 等，
用完即删），再按**实现**回改，不按"精神"猜。

### 8.1 已安装的行不再有 Install（用户第 1 条）

* 依据：`extensionsActions.ts:472-500` `InstallAction.computeAndUpdateEnablement()` 开头
  `this.enabled = false; this.class = InstallAction.HIDE; this.hidden = true;`，且
  `if (this.extension.state !== ExtensionState.Uninstalled) return;` —— 安装后 Install 是**不画**，
  不是画灰；启用/禁用从来不在列表行里内联，而在 `ManageExtensionAction`（`:1338`，齿轮 + 下拉，
  顺序 Enable(全局/工作区) → Disable → Update → Install Specific Version… → Uninstall）。
  有更新时行的主操作是 `UpdateAction`（`:957`，label `Update` `:971`）。
* 落地：`plugItemLead(item)`（`entry && !held` → install；`held && entry && 有更新` → update；`held` → switch）
  决定行主按钮；`plugInstallButton` 标签改为 **Install / Update / Reinstall**（已装且 release 不同 = Update，
  title 说清被替换的版本不会被留）；次级动作全进 `…` 菜单（`plugItemMenuItems(item, lead)`：
  switch → install 家族 → versions → remove）。比较按**种类**而不是节点身份（早先误写成对象身份比较，
  结果菜单里多出一个 switch，测试 17 当场抓到）。
* **回退"偏离计划一"（§七 U2）**：`Reinstall` 不再永远占主位。理由：用户要的就是 VS Code 的行为——
  已装的行主位是启用/禁用（有更新时 Update），"再装一次"是菜单里的次级动作。

### 8.2 行只留"标题 + 一句话"（用户第 2 条）

* 依据：`extensionsList.ts:70-90` `renderTemplate` = `.icon-container`(36px 图标) + `.details > .header`
  (`span.name`) + `.description.ellipsis` + `.footer`；`media/extension.css`：`.header-container{height:20px}`、
  `.name` 半粗 + nowrap + ellipsis、`.description{color:var(--vscode-descriptionForeground)}`、
  `.ellipsis{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}`。行里没有版本号、没有 digest、没有路径。
* 落地（即 **U-10 次级信息折叠**，§七"仍未做"里那条）：`plugItemChips()` 只留 `stopped`；行内版本 chip /
  interface chip / origin chip / "not offered by this client" 全部撤销；`plugItemDesc(item)` 出一句话；
  digest / 源路径 / offered 版本 / release / interface 全部搬进 `plugItemMeta(item)`，拼成行的 `title=`。
  CSS 补 `.plug-row-desc`（单行 + ellipsis + muted）与 `.plug-row-head .plug-name`（nowrap + ellipsis）。
* 数据前提（已核实）：发布清单 `clutch-component.json` 只有 `schema/name/interface/version/declaration/artifacts`，
  **没有 description**（`ui/components.js:272` 的 `parseManifest` 只按 checkout 的 `declaration` 取 `ui.label`），
  所以行里那句"简介"只能是**按状态推导**的一句，不能凭空造组件简介。

### 8.3 面板不再顶满整屏（用户第 3 条）

* 依据：VS Code 的列表是一个**有底的滚动区**（`extensionsList.ts:29` `EXTENSION_LIST_ELEMENT_HEIGHT = 72`，
  虚拟化列表），不是页面长度的柱。
* 落地：`#settings-modal .modal-box` 改 `display:flex; flex-direction:column; max-height:min(78vh, 720px);
  overflow:hidden`；`h3` / `.modal-tabs` / `.modal-actions` 与 `.plug-head` / `#plug-base` / `.plug-note` /
  `#plug-filter` 全部 `flex:none`；`#settings-pane-plugins:not(.hidden){display:flex;flex-direction:column;
  overflow:hidden}`（**必须 `:not(.hidden)`**：id 选择器会压过 `.modal-pane.hidden{display:none}`）；
  `#plug-body{flex:1 1 auto;min-height:0;overflow-y:auto}`（原 `max-height:44vh` 撤掉）。
  手机：`ui/mobile.css` 删掉 `.plug-body{max-height:none;overflow-y:visible}` 那条（它正是"顶满整屏"的来源），
  并把 `#settings-modal .modal-box` 从"整框滚动"那组选择器里摘出来（它整框不滚，滚的是里面的列表），
  高度上限收到 `calc(100vh - 96px)`：手机上一整块贴边的框读起来像"第二页"，而这个面板是盖在正在读的
  那页上的；上下各留一段遮罩，剩下的高度给列表。

### 8.4 过滤 chip 高亮时白底白字（用户第 4 条）

* 根因：`button:hover:not(:disabled)`（`ui/style.css:266`，具体度 (0,2,1)）与 `.plug-filter-chip:hover:not(:disabled)`
  ((0,3,0)) **压过** `.plug-filter-chip.active` ((0,2,0))；安卓 WebView 里点一下 `:hover` 会滞留，于是激活
  chip 的 `--text` 背景 + 被改回 `--text` 的文字 = 白底白字。
* 修法：`.plug-filter-chip.active, .plug-filter-chip.active:hover:not(:disabled),
  .plug-filter-chip.active:focus-visible` 同具体度且置于其后，把三种状态都写全。
* 同类隐患一并修：`.plug-switch.stopped:hover:not(:disabled)`（hover 会丢 accent）、
  `.modal-tab.active:hover:not(:disabled)`（hover 会把激活 tab 的 accent 下划线刷成灰）。

### 8.5 测试

* `tests/components-panel.test.js` 的断言随重构更新（**不放松事实**）：第 17 组的"版本 chip"改成"名字旁的
  stopped chip"（版本已按 8.2 撤出行）；第 31 组改问行**主按钮是哪一个**（新 helper `p.primary()` 读
  `.plug-row-actions` 的首个子节点），并补两个方向：held 落后 → 主按钮 `Update` 且 title 说清被替换的版本；
  held + entry 无更新 → 主按钮是 switch、菜单里是 `Reinstall`。断言里都写了 VS Code 出处，便于日后有人
  再"简化"前先看依据。
