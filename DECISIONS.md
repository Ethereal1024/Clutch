# 决策记录（DECISIONS.md）

这份文档只装**已经拍板的事**：每一条 = 一个编号 + 一句定调 + 依据 + 落点（代码与文档的
准确位置）+ 还欠什么。未拍板的单独放在第九节，不混进来，也不写成"倾向于"。

**编号不复用、不删除。** 一条决定被推翻时留原文，在下面补一行"→ 由 Dn 取代"，因为计划
文档（`PLUGIN_PLAN.md`、`SSH_WORKSPACE_PLAN.md`）退役之后，这里就是唯一还活着的地方；
代码注释引用编号即可（`PLUGIN_PLAN 七.2` → `D1`）。

总则（贯穿全部条目）：**不留兼容层、不留兜底补丁、不留回滚。** 形状不对就换掉，语义不对就
改语义，中间态只允许存在于分支上，不随发行版出厂。

---

## D1 旧记录 = 强制替换，只有一种版本形状

**定调**：`42e6ee6`（2026-10-01，"an install records the component's own version"）之前的
安装，`version` 被写成 `digest.slice(0,16)`（例如 `5f900739e6a35f43`），目录名与
`component.json` 的 `version` 都是这个裸摘要。这样的记录**一律强制重装**成
`<version>+<digest16>`（`0.1.0+5f900739e6a35f43`），不迁移、不并存、不保留回滚入口。

**依据（为什么这不是"新增机制"）**

- 版本门本来就是"版本 + 摘要"双比：`agent/tools/components.py:521-536` 的 `current()`。
  旧记录的 `version` 是裸摘要，永远不等于客户端声明的版本，所以**任何一次 pass 或点击都会
  重装**——"强制"是既有语义，不是新分支。
- 重装落 `<root>/<name>/<version>+<digest16>`，随后 `_prune(name, keep)`
  （`components.py:964-982`）删掉其它版本目录**并删掉它们的表行**（`ignore_errors` 删不掉
  目录时也不会留下可解析的孤儿）。
- 两种形状并存不是"只是不好看"：`_resolve_records`（`components.py:422`）按版本字符串取
  `max()`，而 `"5f900739e6a35f43" > "0.1.0+…"`（`'5' > '0'`），并存的机器会把**旧目录**
  解析成要运行的那一版。所以单形状是正确性要求。
- 代码里没有任何迁移脚本或兼容分支要删（组件路径上搜 `legacy|compat|migrat` 无命中），
  这条决定在宿主侧的成本是 **0 行**。

**对用户透明**：面板上这一行已经是 `Update`（`ui/js/components-panel.js:360-365`
`plugItemUpdate()` 对本形状返回 true），`Updates` 计数在版本号没动之前就把它算进去；
tooltip 点名"这是旧记录、重装后叫 `<version>+<digest16>`、旧目录被删而不是保留"
（`:519-534`、`:1216-1222`）。**没有撤回入口**，也不需要——见 D6 的三次写。

**记录属于谁**：属于装它的那台机器。session 域在
`~/.clutch/components/<name>/<version>`（Windows `%LOCALAPPDATA%\clutch\components`，
`components.py:148-164`）+ 同目录 `registry.json` 一行；客户端域在 `~/.clutch/client`
（`ui/plugin-host.js:96-105`）。不是账号记录，不是市场记录，也不在仓库里。

**谁触发**：远端 session 机在隧道连上时自动跑一次
（`ui/tunnel-connect.js:714` → `ui/tunnel-bootstrap.js:548` `installComponents()`，不等待、
失败只记日志）；本机（桌面端自己作为 session）**没有自动 pass**，只有面板点击。

**现状审计（2026-10-21 本机）**：`~/.clutch/components/registry.json` 四条全为新形状
（memory `0.1.0+48b5200320dc1a3b`、skills `0.1.1+e269d8a65973e309`、websearch
`0.1.0+75ffbfe0171b8f5a`、workspace `0.1.0+e517d3d2e588b130`，目录 mtime 10-12），
`~/.clutch/client` 不存在。旧记录只可能存在于"2026-10-01 之后没再连过"的机器上，且连一次
就被自动 pass 修掉。

**实现**：`cec6376`（3 文件 +80）：`plugHeldLegacy()`（`components-panel.js:375-378`）、
`plugItemUpdate`/`plugItemMeta`/安装按钮 title 的旧记录分支、`tests/components-panel.test.js`
3b、`tests/components.test.js` 6b（植入一枚 0.1.55 形状的记录，断言 pass 重装、`current` 排除它、
裸摘要目录消失、记录重新命名版本）。

**欠账**：`components-panel.js:1557` 的确认句对旧记录仍说 "installing rewrites that same
version"——这句话不真（换的是形状，且旧目录会被删），要按 `plugHeldLegacy` 分支改写并加断言；
`PLUGIN_PLAN.md:253-254` 仍写"仍未拍板"，要改成"已决 + 强制点在哪 + 代价"。

---

## D2 组件 ≠ 工具：分层，而不是把包当成工具

**定调**：**组件是包**（分发与生命周期的单位：`name` / `version` / 摘要 / place / 启停 /
市场行）；**工具是包提供的能力**（模型可调用的东西：可填参数 + 模板语句）。组件的定义比工具
宽得多：一个包可以带 0 个工具，以后还会出现**前端主题**这类与工具毫无关系的组件。两者必须
分层，代码里不许用"这个包是哪种东西"的枚举来表达"包里有什么"。

**现状漏洞（这一条要删的东西）**

| 位置 | 现在把包写成了什么 |
| --- | --- |
| `COMPONENTS.md:3` | "宿主零内置工具：一切工具都来自组件"——组件的定义句就是"工具提供者" |
| `agent/tools/catalog.py:3-6` | "A component is a standalone program that publishes an interface" |
| `agent/tools/components.py:143-145` | `REQUIRED_FIELDS = (name, version, interface)`；`INTERFACES = (daemon, cli)` |
| `components.py:878` | 安装门：interface 不在两个值里 → 拒绝（无程序的包装不上） |
| `agent/tools/catalog.py:609-610` | 缺 `interface` **静默当 daemon**：把"没有进程"读成"有进程" |
| `scripts/market_index.py:202-205` | 市场生成器只认三值 → 主题类组件连上架都不行 |
| `ui/components.js:1077-1105` | `interface` → place 的映射：把"放哪"绑在"怎么跑"上 |
| `agent/tools/answers.py:138-156` | `_drivable` 要 `rendezvous.available()`（能 launch）才可见 |

好消息是**分发层已经是贡献无关的**：`inventory()`（`components.py:486-508`）只读 name /
version / interface / digest / disabled，`_prune` 也不关心包里是什么。所以分层缺的是**上层
定义句 + 三个门**，不是新机制。运行时也已半支持零工具包：`catalog.py:613` 是
`data.get("tools", []) or []`。

**落点**：`COMPONENTS.md` §二/§三 重写成"包 / 能力 / 传输"三层；`components.py` 两个门、
`catalog.py` 的默认值与定义句、`market_index.py` 的校验、`ui/components.js` 的 place 推导；
place 改为由"贡献的种类 → 谁消费"推导（模型消费 → session 机；主题给本 app 渲染 → client
域），`interface` 不再是 place 的来源。`PLUGIN_PLAN.md:28,188` 的 P4 措辞随之改写。

---

## D3 工具调用有且仅有一种形式：可填参数 + 模板语句

**定调**：模型调用工具的过程只有一条路——

```
render(模板, 模型参数 ∪ 宿主事实) → 交给执行器 → 信封
```

**不存在第二种调用形式**。daemon 也走这条路：它需要"服务"时，用的是**同一种模板语句**去申请
（一条声明了怎么取 `{port}` 的语句），而不是"interface=daemon"这个特殊身份。

**已经统一的那一半**：`agent/tools/inst.py:115-175` 的 `inst.render()`——`command` 模板 +
模型参数（`shq` 引号）+ 宿主值（`vars`，遮蔽同名参数）+ `defaults` + 可选组 `[--flag {x}]` +
`{*}`（全部参数当 JSON）。daemon 的整条 `curl` 语句走的正是它。模板词由
`rendezvous.render_launch()`（`rendezvous.py:132-190`）渲染，事实由
`rendezvous.Service.vars()`（`:196-206`）提供。

**代码层被显式分开的地方（要删的）**

| 位置 | 现在写死的东西 |
| --- | --- |
| `catalog.py:366-372` | **只有 `cli` 能发布宿主事实**，daemon 被明确拒绝 |
| `catalog.py:339-357` | plugin 不得有 `launch`（"how its process starts is the client's business"） |
| `catalog.py:397-404` | plugin 的工具**不得有 `command`**——于是有了第二种调用形式 |
| `agent/tools/registry.py:328` + `:495-513` | 布线带 `remote = interface == "plugin"`，调用处 `if tool.remote: channel.call(tool, args)` |

**统一后的四个词**

- **事实**：`{py} {dir} {name} {script}`（本机）、`{port} {token} {pid}`（服务）、`$skills`
  （发布）。今天由四种机制分别回答（`launch` argv、发现记录、`vars`、`facts`）——这才是分叉
  的真正来源，要收敛成一张"事实由谁回答"的声明。
- **服务**：一个**带生命周期的事实提供者**，申请它本身就是一条模板语句；宿主按
  （组件, 工作区）缓存、空闲回收。daemon 从此不是一种 interface，而是"我有一条需要服务的语句"。
- **执行器**：也是一条事实（本机 shell / 客户端通道）。`registry._invoke` 里 `if tool.remote`
  那一段随之消失。
- **模板**：模型看不到 `interface`，只看到参数 schema + 说明。

**顺带一个事实**：客户端通道今天已经是这个形状——`ui/plugin-host.js:305-340` 每次调用 fork
子进程，把 `CLUTCH_EXEC_BRIDGE`（地址）+ 命令字节限额交给它，`/call` 认 `Bearer`
（`COMPONENTS.md:319`）。那和 daemon 的 `{port}/{token}` 是同一套东西，只是没这么叫。

### D3 补注：`interface` 不是工具层的需求，是 `launch` 的两个含义挤在一个字段里

**工具层已经不区分了**：语句这条路上一个 `interface` 都没有。`_exec_statement`
（`registry.py:532-556`）只做三件事——`statement.prepare` → `Statement.line`
（`inst.render` + 前缀，就写在 `agent/tools/statement.py`）→ `runner.run`。模型看到的也只有参数
schema 与说明（`registry._wire`）。唯一残留是 `tool.remote`（plugin 那条分支），D3 已定要删。所以
"协议还要分 daemon / script"是**宿主装配阶段**的欠账，不是工具层的要求。

它之所以还留在协议里，是因为 `launch` **一个字段干两件事**：

- daemon 的 `launch.argv = ["{py}","-m","clutch_workspace.daemon"]` 是"**怎么把服务起起来**"；
- cli 的 `launch.argv = ["{py}","{script}"]` 是"**每条语句的前缀**"。

同一字段两个含义，只有 `interface` 能解码它——这才是枚举真正的负载。而它编码的其实只有
两个自由度：

1. **执行地点**（`runs_on`）：谁的机器渲染并执行这条语句；
2. **进程是否留下并发布事实**：起一次就走，还是常驻并给出 `{port} {token} {pid}`。

`interface` 是这两者的压缩写法（`daemon` = self + 常驻；`cli` = app host + 一次性；
`plugin` = client + 本机无语句），所以它是**冗余**的，删掉不丢信息。删法是让 `launch` 自己
说清它是哪一种，其余全部**推导**：

| 声明 | 宿主推出什么 |
| --- | --- |
| `launch` 会发布事实（`{port}/{token}/{pid}`） | 起它、按（组件, 工作区）缓存、写发现记录、判活看 pid + version + digest、空闲回收；语句**不加**前缀 |
| `launch` 不发布事实 | 每次调用渲染 `launch` 当前缀，即起即灭；无发现记录、无缓存 |
| `runs_on: client` | 执行器是客户端通道；本机没有语句可跑 |
| 工具没有 `command` | 由宿主自己实现（今天的 `host`），不是"另一种组件" |

**唯一不可约的差别是服务的所有权，不是"种类"**：谁起、谁收、多个工作区各一份、怎么确认
端口里那一个就是这一版（pid + version + digest）、空闲多久释放。工具层看不见它，但宿主必须
知道——声明要交代的只是"这条语句的 `{port}` 由谁给"，主语是**语句/事实**，不是包的类型。
具体写法见 **落地②**：一块 `service` 的**有无**就是全部声明，语句本身由各工具自己的 `command`
承担，回收策略是宿主策略，不进清单。

`facts.py:93` 的"只有 CLI 能发布宿主事实"同理不是类型规则，而是"事实不属于任何工作区，
服务属于某一个工作区"；按上表推导后它自动成立（无工作区的语句命不中服务缓存），不需要写成
`interface` 判断。

**现状判定**：工具层已经透明，协议层不透明是欠账。这笔欠账已经咬过一次——P4 想加"纯宿主
实现的能力"时，唯一出路是发明第四个枚举值 `interface: "data"`；按上表推导，那不过是
`host` 工具（无 `command`、无 `launch`）。它随 D3 的四步一起还，不做独立重构。

**安全边界（必须写进契约）**：客户端只执行**自己声明过的模板**（模板随客户端推上来的声明走，
宿主只能填参数与事实，不能自带语句）。这是把今天"客户端只跑自己声明的工具"换一种实现，
不是放宽。

**规模与顺序**：主战场 `catalog.py` 931 行、`rendezvous.py` 885、`registry.py` 643、
`channel.py` 364、`inst.py` 216；外围 `ui/components.js`、`ui/plugin-host.js`、五个组件的
`component.json`、`scripts/market_index.py`、`COMPONENTS.md` §二/§三/§六、
`SSH_WORKSPACE_PLAN.md` 的 C9 系列。四步落地（每步都能跑，不发布兼容层）：①事实提供者抽象，
`cli` 先走新路；②daemon 的服务从 `rendezvous` 内部搬进声明，删 `interface == daemon` 分支；
③`/call` 从 `{tool, args}` 改成 `{command, args}`（模板来自客户端自己的声明），删
`tool.remote`；④删 `interface` / `INTERFACES` / `runs_on`，安装门与 place 改成"贡献 + 执行器"
推导，五个组件各出一个 manifest commit。

### D3 落地②：服务写进声明（`catalog.Service`）

**声明说的是"谁给出 `{port}`"，不是"这是什么包"**：清单里有一块 `service`（哪怕写的是
`{}`）= 这个进程起一次就留下，并发布语句要用的 `{port} {token} {pid}`；没有这一块 = 一次
调用一个进程，`launch` 只能当语句前缀。宿主只看**有无**，不读种类词。

**三个坐标和数据布局落在一处**：`discovery_env` / `app_dir` / `prefix` 收进
`catalog.Service`，发现记录的目录与文件名也随它——`Service.directory()`（`discovery_env`
可重指，否则 `%LOCALAPPDATA%/<app_dir>` 或 `~/.<app_dir>`）与 `Service.record(root)`
（`<prefix><sha256(normcase(root))[:32]>.json`）。这两件以前是 `rendezvous` 的私有函数，
现在由声明自己回答；`rendezvous` 只拿 `catalog.Service` 去读写记录，摘要算法因此只有一处。

**宿主先行，旧的拼法照旧读**：这三个键原先是清单顶层字段，`_LEGACY_SERVICE_KEYS` +
`_service_of` 仍从顶层读入并折成同一块（`_refine` 里也把旧拼法当成同一个声明点名的
`service`）。理由是不对称的：新宿主读**旧**清单必须原样驱动，而旧宿主读**新**清单会丢掉
发现坐标。所以清单迁移搭 0.1.57 那次组件重打包的车，不抢先——`clutch-workspace/component.json`
停留在顶层三键，等那次重打包（并把它自己的 gitlink 一起推）。

**临时的一致性检查**（双向、fatal，随④一起删）：声明了 `service` 的必须真是"留下的进程"
（`interface == daemon`），是 daemon 的必须声明 `service`——否则"这句话没有主语"。它存在的
唯一原因是枚举还在：`service ⟺ interface == daemon` 是同一件事的两种说法，等 `interface`
被删（④）它自然消失。

**`statement.prepare` 只剩一个分叉**：`mod.service is None` → `_artifact()`（`launch` 前缀 +
`command`），否则 `rendezvous.service(...)` → 一条 `vars` 为活动记录、执行器为工作区的
`Statement`。`prepare_cli()` 明确拒绝带 `service` 的声明：服务的事实属于某一个工作区，而
CLI 那种语句不属于任何工作区。`launch_prefix()` 对带服务的声明返回空串——服务语句不加前缀。

**进度**：①（`statement.py` 缝、`rendezvous` 收回到进程生命周期）、②（本节）与③（`/call`
统一、删 `tool.remote`）已落地，④（删 `interface` / `INTERFACES`、place 推导、市场 schema）未做。

### D3 落地③：语句是客户端的声明，`/call` 只送这句话

**协议只剩一条语句**：`POST /call` 的 body 是 `{component, command, args}`，`command` 是客户端
推上来的声明里**逐字**的那条模板。宿主不再保存 plugin 的模板、也不再发工具名——发一个名字等于
第二次编码"要跑什么"，而客户端自己的声明已经是答案。`/call` 要 `component` 只是因为一个客户端
可以装多个组件，得说清这句话属于谁。

**`tool.remote` 删除**：布线只回答"实现是不是一条语句"（`Tool.inst` 是不是 `None`），执行器由
`runs_on` 决定，`registry._invoke` 里 `if tool.remote` 那一段随之消失。宿主侧的语句形状因此只有
一个分叉：`Statement.runner` 是 `Client()`（`statement.Client`，一个标记）就把模板**原样**交给
`channel.call(component, command, args, timeout)`，`ChannelError` 变成 `ERROR:` 信封；否则在本机
渲染（`Statement.line`）再交给 transport 并 `inst.unwrap`。`Statement.module` 记下"这句话是谁声明
的"：失败句用它点名，客户端语句用它当收件人。

**客户端是渲染者**（`ui/plugin-host.js#renderArgv`）：模板 → argv 词，然后 fork。规则只有一张表：

| 写法 | 变成 |
| --- | --- |
| 空白分词 | 词与词；不做 shell 引号，因为根本没有 shell |
| `{name}` | 一个不透明词：模型参数原样（空格、换行都留着） |
| `{*}` | 全部参数当一个词：JSON，键在每一层都排序（镜像 `inst.jarg` 的 `sort_keys=True`） |
| `{dir}` | 客户端**唯一**的事实词：组件安装目录；它遮蔽同名模型参数 |
| `[ … ]` | 组内任一占位符缺失则整组丢掉 |
| `[[` / `]]` | 字面量 `[` / `]` |

组外的缺参、坏 `{`、未闭合 `[`、孤立 `]`、嵌套组、渲染成一个词都没有——全是错误，带句子。
只有 `{dir}` 是事实，别的一律是模型参数：`{name}` 永远不能是事实，因为 `clutch-memory` 就有一个
参数叫 `name`。渲染完还要校验 `argv[0]` 等于这条语句所属工具的名字——ABI 是 `run(argv)`，
`argv[0]` 就是工具名，错位了不执行。

**插件 ABI**：entry 导出 `run(argv)`，`argv[0]` = 工具名，`argv[1]` = 参数的 JSON 字符串；工具命令
写 `"<tool> {*}"`。`ui/plugin-child.js` 拒绝"entry 没有导出 `run(argv)`"，**不做兼容**（D1）。

**安全边界照旧**（D3 补注）：宿主不带语句，只能填参数与事实；客户端只跑自己 `component.json` 里
声明过的那条模板，逐字比对，没有第二条路。

**undo 的门没有变成"按种类开门"**：`Statement.local`（`not isinstance(runner, Client)`）回答的是
"这次写是不是落在这台机器上"，`_invoke` 用它门控 `snapshot`（`tool.snapshot and ready.local`）——
客户端写的文件，这台机器既读不到旧内容也恢复不了，所以不该留快照。

**`component_diagnostics` 的 plugin 检查翻面**：从"plugin 的工具不得有 `command`"改成"必须有"——
没有 `command` 就没有可执行的语句，声明不完整（这是 fatal，不是兜底）。

**不发布兼容层**：旧客户端只认 `{tool, args}`，它会被新宿主的话问倒，这是故意的。两个插件
（`clutch-websearch`、`clutch-ssh-workspace`）的清单与入口在这次提交里一起改（各自子模块里一次
提交），但**父仓库的 gitlink 没有动**，两条理由：市场索引读的是 release manifest，不是 gitlink；
而 gitlink 必须指向上游**存在**的提交——这两个子模块提交还没推。把它们升到带 `command` 的版本
是 0.1.57 重打包的事：推子模块、切 v0.1.1 发布、bump gitlink、更新 `market/entries.json`。
在那之前，父仓库这一版自己跑得通（测试读工作树），而市场里发的仍是 0.1.0 的旧插件。

### D3 落地④：删掉种类词，"谁跑这句话"由声明贡献了什么推出

**删掉的是一整层词汇**：`catalog.Component.interface` / `runs_on`、`INTERFACES` 词表、
`components.REQUIRED_FIELDS` 里的 `interface`、登记表与 `inventory()` 里的 `interface`、客户端
`parseManifest` 与 `ui/plugin-host.js` 的 `INTERFACE`、`plugin-server.declarations` 送出去的
`interface` / `runs_on`。**没有任何东西替代它们**：声明本身已经说了。

**推导只有三步**（`catalog.Component.runs_here` / `client_side` / `component_diagnostics`，
客户端同形的 `destinationOf`）：

| 声明里有 | 结论 |
| --- | --- |
| `service`（哪怕写的是 `{}`） | 进程**留下**，在这台机器上（daemon） |
| 只有 `launch` | 一调用一个进程，也在这台机器上（cli） |
| 两者都没有，点名了 `entry` | 这里**没有进程**，所以这句话是**客户端**的 |

`service` + `launch` 并存是**正常**的：留下也是被 `launch` 拉起来的。矛盾只剩两种，各有
一句人话，都 fatal：**`entry` 与任一"在这里跑"并存**（一份声明同时说两个落点），**三者都没有**
（没有任何东西能跑这句话）。安装门（`components.install`）与 `component_diagnostics` 说的是
同一句话——一份装下去也没有东西可驱动的声明，在字节落地之前就被拒。

**为什么删**：`interface` 把"进程在谁的机器上"和"语句怎么执行"挤进一个词（补注），而
`runs_on` 只是把同一个事实抄第二遍。第二份真相会漂移，`plugin` + `runs_on: "self"` 那种
"能看见、装不了"就是漂移的症状——现在这个症状在语法上不存在了。

**旧字怎么办**（都不做迁移，D1）：

- **宿主读旧清单**：`interface` / `runs_on` 读完当没看见，落点只看三个贡献词；随包的五份
  清单这次**一个字都没改**，所以旧宿主读它们仍然读得通（清单迁移搭 0.1.57 重打包的车）。
- **`_LEGACY_SERVICE_KEYS` 保留**：发现坐标的旧拼法（顶层 `discovery_env`/`app_dir`/`prefix`）
  仍然折进 `service`——那是 0.1.57 之前发布的清单的事实，不是种类词。**客户端不折**：它只问
  `service` / `launch` / `entry` 有没有出现，没有就别猜。
- **`scripts/market_index.py` 照旧抄 `interface` / `runs_on`**：索引 `schema: 2` 里那两个词是
  **显示副本**，不是判据，`ui/market.snapshot.json` 只能在 0.1.57 重打包（各模块发行清单改口）
  之后重生成——离线环境里不许跑 `--check`，会红得没有意义。
- **测试里的旧字样是故意的**：`tests/bridge-server.test.js`、`tests/market.test.js`、
  `tests/net-fetch.test.js` 用的是 v0.1.56 的真实字节（证明客户端不看这两个词）；宿主响应、
  清单与库存的 fixture 里则一个都不留。

**客户端那个问题的形状也一起变了**：`destinationOf` 回答 `{place, read, error}`，因为
"够不着"（今天拨不过去）和"没读到"（声明还没取回来）是两件事——`read: false` + `error: ""`
是市场行的常态，`place: null` + `error: ""` 是"不知道"，两者都不是拒绝。市场列表因此
**一次读都不多**：行上没有声明，落脚点在 `specFor` / `componentSpecs` 取回声明之后才知道
（`tests/market.test.js` 钉的就是"打开页面是一次读"）。

**守它的测试**：`tests/catalog_test.py`（三种贡献、两条矛盾、legacy 折法）、
`tests/components_api_test.py`（安装门）、`tests/channel_test.py` / `tests/rendezvous_test.py`
（推送与"这台机器上没有"）、`tests/components.test.js` / `tests/components-view.test.js`
（两个落点、三个词的回答、未读行）、`tests/plugin-host.test.js`（三条拒绝句）、
`tests/client-plugin-websearch.test.js`（装 → 推 → `/call` → 删，真 fork）。

---

## D4 说明与指令属于技能层，组件声明里没有 prompt

**定调**：组件不声明"拼进系统提示词的正文"（`prompt` 字段）。**怎么用、怎么配合**是**技能**
的职责：模型按需加载技能文件（`load_skill`），宿主不在启动时把包里的散文接到系统提示词上。

**依据**：现在这一层是实打实的代码——`COMPONENTS.md:207-220`（`prompt` 字段的定义句）、
`agent/tools/prompt.py:28-140`（`prompt_section` / `_fragment` / `_prose`）、
`catalog.py:641`（`Component.prompt`）、`registry.py:73,615-616` 导出、`loop.py:203` 每轮拼接。
实际只有三个包用到，共 30 行：`clutch-workspace/PROMPT.md`（15）、`clutch-memory/PROMPT.md`
（13）、`clutch-skills/PROMPT.md`（2）。

**删掉之后那些字去哪（不需要新机制）**

1. 工具 `description` 已经过事实替换（`registry.py:198-231` 对 `description` 与参数 schema 都跑
   `_resolve`），所以 `clutch-skills/PROMPT.md` 那 2 行（一个 `$skills` 块）直接进
   `load_skill` 的 description——动态目录不依赖 `prompt`。
2. 跨工具的工作流正文（workspace 的"先列目录再读"、memory 的"写在哪"）是指令，落成技能文件。
3. 宿主自己的 `agent/prompts/`、`host.json` 不动。

**删除清单**：`Component.prompt` 与其解析、`prompt.py` 的 `prompt_section/_fragment/_prose`
（保留 `components_unavailable`、`module_blocked_reason`）、`loop.py:203`、`registry` 两处导出、
`COMPONENTS.md` 对应段落、三个 `PROMPT.md`、相关测试。

**副作用是变干净**："组件缺席时提示词不许描述调不到的工具"（`COMPONENTS.md:212`）从此天然
成立——宿主不再拼任何组件文字；`answers.py:138` 的"工具与提示词片段共用一把尺"改成只服务工具。

---

## D5 分发只有一条路：中心化静态列表，不做私有源与口令

**定调**：`market/entries.json` 是唯一来源，`scripts/market_index.py --write` 生成
`ui/market.snapshot.json` 并发布到固定 tag `market` 的 `index.json`（`INDEX_SCHEMA = 2`），
所有客户端、所有版本读同一份；客户端读取顺序 活索引 → `~/.clutch/market/index.json` → 随包
快照，`origin` 如实说明读自哪一层。加一个模块 = 一行 PR。

**不做**：私有来源、私有源 token/口令——属于**过度设计**。`artifact_headers`、给
`readManifest()` / `marketEntries()` / `components.download()` 加 header、"签名过的撤销列表"
这一整块设计作废；字节由目标机自取之后也永远不需要 header。

**落点（文档里要删干净）**：`PLUGIN_PLAN.md:29`（表格行里的"私有源未做"）、`:203`（标题）、
`:217-219`（token 要递到每台机器的实现提示）、`:258`（"私有源见 §三 P5"）；
`:220` 的"撤销是签名过的静态列表（可选）"同属过度设计，一并删。

---

## D6 三种写入：两次不可撤回，一次可撤回

**定调**：组件的写入只有三种，界面按"能不能撤回"区别对待，不许含糊。

| 写入 | 能否撤回 | 界面纪律 |
| --- | --- | --- |
| Install / Update（含 D1 的旧记录重装） | 不可 | 没有撤回入口；写之前必须说清（旧版本目录会被删，不保留） |
| Remove | 不可 | 没有撤回入口；确认框明说"这里不留副本" |
| Disable / Enable | **可以**（撤销就是再按一次） | 因此**不问**，只说明它不删字节 |

**依据**：`components-panel.js:1546-1567`（install 的确认句）、`:1340-1392`（remove 的两条
确认句）、`:1009-1030`（switch：不删字节，所以没有确认）；`components.py:868-870`（`disabled`
是组件级的，跨版本保留，重装不会把用户停掉的组件又开起来）。

**推论**：**"不可撤回"不等于"界面别放撤回按钮"**——本来就没有撤回按钮，义务是**事前说真话**。
所以 D1 的那句错话（`components-panel.js:1557`）是这一条的直接欠账，而不是文案瑕疵。

---

## D7 文档纪律：计划文档是过渡，结论落在这里

**定调**：`PLUGIN_PLAN.md` / `SSH_WORKSPACE_PLAN.md` 只在"还没做完"期间存在；做完的结论
写进**这份文档**与 `COMPONENTS.md`（契约）与代码注释（为什么这样写），计划文档随后删除。
`COMPONENTS.md` 仍是组件与宿主之间的契约，`DECISIONS.md` 不重复契约内容，只记"为什么这样定"。

**约束**：代码注释引用 `Dn` 而不是计划文档的章节号；计划文档退役时 `Dn` 不变。

---

## 锚点对照（计划文档 → 本文件）

| 旧锚点 | 现在 |
| --- | --- |
| `PLUGIN_PLAN.md` §七 2（旧记录待拍板） | **D1**（已决，代码在 `cec6376`） |
| `PLUGIN_PLAN.md` §三 P4（工具集） | **D2 / D3 / D4**（措辞要删"提示词"，见 D4） |
| `PLUGIN_PLAN.md` §三 P5（私有源未做） | **D5**（不做） |
| `PLUGIN_PLAN.md` 八 G5（纯声明包 400） | **D2**（门本身要被删掉，不是修 bug） |
| `PLUGIN_PLAN.md` 零之六（面板不变量） | **D6**（可撤回性决定要不要问） |
| `SSH_WORKSPACE_PLAN.md` C9 系列（客户端插件域） | **D3**（统一会重写 `/call` 与声明） |

---

## 未决（不要当成已决去实现）

1. **技能文件归属**：(a) 宿主发现各包的 `*/skills/*.md`，`load_skill` 只是工具（推荐）；
   (b) 仍投稿到 `clutch-skills` 一个组件（需要跨组件写协议，更像过度设计）。定形之前不动
   D4 的落地。
2. **`clutch-workspace/pyproject.toml` 0.2.0 vs 其 `component.json` 0.1.0**：修它需要在子模块
   里单独提交并弄脏 superproject 的 gitlink，待授权。

**已决、移出本表**：服务语句的形状（原 1）＝ 落地②：清单里 `service` 的**有无**就是全部声明，
语句由各工具自己的 `command` 承担，回收策略归宿主。D3 与 C9 的先后（原 3）＝ 接受重写（落地
③）：`/call` 与两个插件的清单已经改成新形状，C9 的真机 e2e 跑的是新协议，不回退。

