# 组件规范（COMPONENTS.md）

Clutch 宿主**零内置工具**：`run_command` 之外的一切工具都来自**组件**（component）——
一个独立发布的工件（本仓库的五个子模块 `clutch-workspace` / `clutch-memory` /
`clutch-websearch` / `clutch-skills` / `clutch-ssh-workspace`——子模块只是**开发检出**，宿主
发行版一份组件字节都不带，见第一节末；也可以是任何第三方的同类物）。最后一个子模块服务
**别台机器**的文件系统，见 `subject` 表末的 `foreign-fs` 与 `SSH_WORKSPACE_PLAN.md`。宿主
不为任何组件保留第二份实现，也不内置任何组件的声明；它只做两件事：**发现**声明、把声明接进
循环。

`run_command` 是唯一的例外，而且它同样是**被声明**的：宿主为自己写的唯一一条工具
声明（`agent/tools/host.py`），见第十一节。

这份文档是组件与宿主之间的契约，模型面向的 schema、安装协议与界面呈现都从这里读。
代码对应关系：发现与合并在 `agent/tools/catalog.py`，声明 → 工具在
`agent/tools/registry.py`，**一句话的渲染**（事实 + 模板 → 命令行，`Statement`）在
`agent/tools/statement.py`，寻址与进程生命周期在 `agent/tools/rendezvous.py`，安装落地在
`agent/tools/components.py`，发送端在 `ui/components.js`。

核心定调一句话：**声明随组件走**——组件是什么、怎么被调用、在界面里长什么样，全部
由组件自己随包携带的 `component.json` 说了算（对应编辑器插件的 package.json +
contributes 模型）。宿主管的只有策略（权限词汇、undo 记录、门与模式）和传输（语句
怎么变成一条命令、输出怎么变成信封）。

## 一、manifest 位置与三种存在形态

同一份 `component.json` 形状出现在三个地方：

| 形态 | 位置 | 说明 |
| --- | --- | --- |
| dev 检出 | 仓库根旁的兄弟目录 `<name>/component.json` | 开发路径：改了就生效，重启宿主即可，无需安装 |
| 已安装工件 | `<components 根>/<name>/<version>/component.json` | 安装层落地的记录：工件自带声明 + 安装事实（version/digest）合并而成 |
| 已装登记表 | `<components 根>/registry.json` | 这台机器**持有**什么的唯一名册：每 `(name, version)` 一条，带 `digest` / `location` / `disabled`。表里有就是有——目录躺在根下而表里没有登记的，不算这台机器的组件；`disabled` 只住在这里（磁盘上没有它的形状，见第八节末） |
| 用户注册 | `~/.clutch/components/catalog.d/*.json` | 圈外逃生门：代码在别处（任意目录、本地构建的二进制），一份 JSON 即注册 |

目录可分别用环境变量重指：安装根 `CLUTCH_COMPONENTS_DIR`，注册目录
`CLUTCH_COMPONENTS_CATALOG`（测试与特殊布局用）。

### 发行侧：`clutch-component.json`

上面三种形态都落在**一台机器上**。跨机器的那一层是模块**自己发布的发行清单**
`clutch-component.json`——放在模块自己的 release 资产里，宿主发行版一份都不带。
它把"这个组件长什么样"说成一句客户端能读懂的话：

```jsonc
{
  "schema": 1,                        // 必填；不是 1 即整条被拒
  "name": "clutch-skills",            // 必填：组件身份
  "version": "0.3.1",                 // 这份发行版自报的版本
  "declaration": { "asset": "component.json", "sha256": "<64 hex>" },
  "artifacts": {                      // 平台标签 -> 工件；键 "any" 兜底
    "linux-x86_64": { "asset": "clutch-skills.tar",        "sha256": "<64 hex>" },
    "darwin-arm64": { "asset": "clutch-skills-darwin.tar", "sha256": "<64 hex>" },
    "any":          { "asset": "clutch-skills.tar",        "sha256": "<64 hex>" }
  }
}
```

- **形状只写在声明里，发行清单不转述**：客户端先按 `declaration` 取回那份 `component.json`
  （验摘要），再问它"这条语句在哪台机器上"（第三节）——发行清单里没有 `interface` /
  `runs_on` 这两个词的位置，也不靠它们决定装到哪台机器。**0.1.56 及更早的发行清单仍然写着
  它们**：读进来、当作没看见，落点只看声明里有没有 `service` / `launch` / `entry`。
  `clutch-ssh-workspace/scripts/release-manifest.py` 里那条 `runs_on` 硬错误是旧发布工具的
  遗留，随 0.1.57 那次重打包一起改（D3 落地④）。

- **资产相对清单**：`asset` 是清单**旁边**的名字（文件名或相对路径），清单自己的
  地址给出基准——模块因此不必知道自己的绝对 URL，一份清单放进本地目录同样能用
  （测试与镜像都靠这条）。
- **摘要即信任**：`sha256` 必须是 64 位十六进制；缺失或形状不对的条目**整条拒绝**，
  不猜、也不"尽力而为"。字节由**要运行它的那台机器**自己取回、自己量（第八节
  「字节怎么到」），先验字节再落地；量的是目标机，不是转手的客户端。
- **没有进程在这里的发行版装到客户端，不是目标机**（声明里既无 `service` 也无 `launch`、
  只点名 `entry`）：同一份清单、同一道摘要门，只是"要运行它的那台机器"变成了**用户
  正坐着的那台**——`~/.clutch/client/components`
  （`ui/plugin-host.js`，`CLUTCH_CLIENT_COMPONENTS_DIR` 可重指；目录、tar/zip、单文件三种
  工件形状与第八节同一套判断）。字节因此一次都不过隧道，过隧道的只有那句声明（第三节
  plugin）。**页面上两个域都通**（C7）：客户端域直呼 `ui/plugin-host.js`，会话域仍走那台
  机器的 supervisor；而"去哪一个是声明说的，不是页面上选的"——`destinationOf`（第三节
  「一台机器，一个答案」）。
- **平台查找先精确后兜底**：按客户端的平台标签（`linux-x86_64` / `darwin-arm64` /
  `windows-x86_64`）取键，取不到用 `any`。今天每个模块都只发一个平台无关的
  **tar**（`clutch-skills` 的 tar 里是代码 + `skills/`——技能库随组件自己的发行版走，
  宿主不留第二份），将来要发 PyInstaller onefile 也不必改协议。
- **声明是位置而不是内容**：`declaration` 说的是**一份文件在哪**（资产 + 摘要），不是
  声明本身——清单因此只有几百字节，只有真要递给某台宿主时才把那几 KB 取回来（取回
  后同样验摘要）。
- **一份市场索引，所有客户端读同一份**：页面读的是**索引文档**，不是一份随版本打包的
  清单——一个固定地址
  `https://github.com/Ethereal1024/Clutch/releases/download/market/index.json`（`schema: 2`），
  装过的每一版客户端、每一台机器都读它。文档一行一个模块：`id`（`owner/name`）、`name`、
  `manifest`（该模块 release 里那份 `clutch-component.json` 的**钉死版本**地址
  `/download/v<version>/…`，永不 `releases/latest`）、`version`、`summary`、`tags`、
  `homepage`、`license`，以及生成出来的 `manifest_sha256`、`interface`、`runs_on`——后两个是
  **给旧客户端看的显示副本**，不是判据：声明已经不这样说，索引照抄各模块发行清单里的旧字，
  0.1.57 重打包之前不删（D3 落地④）。一行是
  **指针**：字节仍由各模块自己的 release 发，索引只说"去哪读、读到的该是哪一份"。两道钉子
  都在，且都不在索引这边松口：先按行的 `manifest_sha256` 验清单，再由清单自己的
  `declaration.sha256` 验工件。
- **索引是生成物，人只维护一栏**：`market/entries.json` 里是 5 行"人该决定的东西"（地址、
  版本、一句话简介、标签、主页、许可），`python3 scripts/market_index.py --write` 逐行取回
  被钉住的那份清单、量摘要、抄出 `interface` / `runs_on`（同上：显示副本），写成
`ui/market.snapshot.json`。
  市场没变时输出**逐字节相同**（文档里没有时间戳），所以"变了没有"就是一次 diff。CI 在这些
  文件被推上来时重跑 `--check`（快照必须等于今天 entries 生成的东西：推了一行却没重生成就
  红），再把这份快照发成固定 tag `market` 的 `index.json`
  （`.github/workflows/market.yml`）——**发索引就是替换这一个资产**。
- **读的顺序，三层都答不上来才没有市场**：活的索引 → `~/.clutch/market/index.json`（这台
  机器上一次好读的副本）→ `ui/market.snapshot.json`（随发行版打包）。读自哪一层由 `origin`
  （`remote` / `cache` / `snapshot` / 调用方显式传入的 `given`）说明，`note` 说清为什么没
  读到上一层，够不着时 `unreachable` 为真。
- **加一个模块 = 一行 JSON 的 PR**：在 `market/entries.json` 里加一行，跑一次 `--write`，
  提 PR。宿主代码一行不改，**也不用等下一次宿主发行**——已经装着的客户端下一次读索引就看见。
  随发行版打包的清单与 `~/.clutch/components.sources.json` 那条用户清单都已退场（页面上
  "自定义来源"的入口一并删掉）：一个模块可不可以被装上，不再取决于"用户装的是哪一版客户端"。
- **每一次读都可以整体走镜像**：索引与各模块清单都在 `github.com` 上，而"某些网络下
  `github.com` 根本不可达"是实测（能通的往往只有 `api.github.com`）。所以在一个地址
  **变成 URL 的那一处**（`ui/components.js` 的 `mirrored()`：`readIndex` 与 `entryManifest`
  都过它）应用一次前缀：
  `<镜像>/<原始绝对 URL>`，路径原样保留——因为清单里其余地址都是它的**兄弟**（见上文
  "声明是位置而不是内容"），于是**声明**与**目标机自取工件**的那条 URL 一起跟着走。
  前缀取 `CLUTCH_SOURCE_MIRROR` 环境变量，其次取 `~/.clutch/settings.json` 的
  `source_mirror`。GUI 继承不到环境变量，所以这个键有**一个门槛上的入口**：设置里
  插件页顶端那个 `Source mirror` 字段（`#mirror-input` + Save，`ui/js/components-panel.js`），
  保存时经 `clutchSettings.save` 写进上面那个文件并重读市场——手机上 HOME 是 App 自己的
  filesDir，那个字段是唯一能够到它的地方：

  ```jsonc
  // ~/.clutch/settings.json
  { "source_mirror": "https://ghfast.top" }   // 或 CLUTCH_SOURCE_MIRROR=https://ghfast.top
  ```

  非 http(s) 的前缀**丢弃**而不是照用（照用会把 http 来源改写成不是 URL 的东西，
  报出来却是"网络失败"）；字段这一层更早一步就拒绝它，并且一个字节都不写。显式传入的
  索引（`{index: <url|path>}`，测试与局域网市场用它）**原样照用**：写的人已经写清了要从
  哪读，一个本地索引不该被送去公网加速器。镜像只搬字节、不为字节背书：
  摘要仍按索引行与 release 自己的 pin 校验，镜像换了字节就是那一条被拒。
- **自带清单，另外一份"够不着才用"的回退镜像列表**：上面那个前缀是**整体改道**——一设就
  作用于每一次读（清单与工件一起）。列表不同，它是**逐条回退**：只在某一条取数以
  "网络上够不着"的方式失败时才轮番上阵，别的地方一概不动。自带三条前缀随发行版打包在
  `ui/components.mirrors.json`（`{"schema": 1, "mirrors": ["https://gh-proxy.com/", …]}`；
  三条都实测过，并用 release 自己的 `clutch-memory.tar.gz` 对过 sha256），用户可写
  `~/.clutch/components.mirrors.json` 追加条目，**用户条目在前、自带条目在后**——自带的
  是本列表的一部分，只读不可删（能让 UI 清空的回退等于没有回退）。策略都在 `ui/mirrors.js`：

  * **只有"够不着"才重试**：`looksLikeNetwork` 认的是连接层的措辞与状态码（超时、
    `connection reset/refused`、`remote end closed`、`bad gateway`、`503/504/522…` 这类
    网关/超时码）。一条 404、读不懂的 schema、对不上 pin 的字节、release 没发布的平台，
    都是**回答**——镜像服务的是同一条路径，再问一次拿到的还是同一个回答，于是**不重试**。
  * **镜像仍然只搬字节、不为字节背书**：前缀只贴在 URL 上，字节到达**要运行它的那台机器**
    之后照样按 release 自己的 `sha256` 校验（和上面同一个钉子）。
  * **`source_mirror` 一设，逐个回退就无事可做**：那一位已经把每一次读整体改道了，于是
    回退列表此时**不参与**（插件页会写明是哪个旋钮在生效，而不是给一张会被忽略的表）。
  * 回退发生在**目标机**：`artifact_url` 是那台机器自取工件的地址，重试就是按顺序换前缀再
    递一次；本机只负责组装 `<前缀>/<原始 URL>`，工件一次都没经过本机。
  * **有意不动**：**市场/清单**的读取仍然没有自动回退——那是"要显示什么"，不是
    "要运行什么"。清单读不到就照原样报出来；要把整条供给线（清单在内）都改道，仍然只有
    `source_mirror` 那一个旋钮。
- **一次读有三种结局，只有一种重问**：索引与清单的读取把失败分成"回答"（非 2xx、
  读不懂的 JSON——再问一次拿到的还是同一个回答）、"自己放弃"（这台机器的 30 s 预算耗尽，
  `CLUTCH_MANIFEST_TIMEOUT_MS` 可改，测试拿它把预算压到 1 s）与"够不着"（请求根本没换来
  响应，例如连接被重置）。只有第三种会
  重问，最多三次、退避从 500 ms 起翻倍。给出的话是一句人能用的，例如
  `the source could not be reached (ECONNRESET, asked 3 times)`：node 的 fetch 只会说一句
  `fetch failed`，它同时代表重置、DNS 失败与被拒的连接（Electron 那边也只有 `net::ERR_…`），
  等于什么都没说。插件页据此分清两件事——够不着是"这台机器的网络"，于是给一条提示：指向顶端的
  `Source mirror` 字段（也就是那条 `source_mirror`，它把每一次读——清单在内——整体改道），并点名
  Mirrors 一节（**清单读取本身不回退**，而**工件那次取数**会自动从那一节列出的镜像里轮着试）；
  404 是"来源回答了，答案是 404"，不该把人送去改设置文件。失败的那次市场读只算新鲜 30 s
  （好读仍是 5 分钟），所以重开一次页面就是再问一次，而答上来的来源照旧留在列表里。
- **代理用的是运行时的栈**：桌面端读远程清单/工件走 Electron 的 `net.fetch`（Chromium
  默认 session 的栈，机器的系统代理配置据此生效），而不是 node 的全局 `fetch`——后者不认
  `HTTPS_PROXY` 之类的名字，"读一个源"会一直挂到自己的超时，界面上只看到源"什么都没答"。
  这个选择只在 `ui/net-fetch.js` 一处，超时用的 `AbortSignal` 原样透传；宿主端点
  （`hostJSON` / `postInstall`）**不**经过它——那是 SSH 隧道两端的 127.0.0.1，走代理等于
  绕回本机。手机上的 node 18 没有这层栈，只有直连或镜像（`android/README.md`）。

## 二、组件级字段

```jsonc
{
  "name": "clutch-hello",            // 必填，唯一身份：安装目录名、检出目录名、表键，一个字符串
  "version": "0.1.0",                // 必填；安装版可携带内容摘要（0.2.0+<hex>）
  "entry": "",                       // 没有进程在这台机器上时必填：入口模块（相对组件目录），一份导出 run(argv) 的 CommonJS 文件——声明里出现它，这句话就是**客户端**的
  "subject": "workspace-fs",         // 服务谁的资源（见下），决定语句能否为某工作区运行
  "launch": {                        // 宿主如何**启动**一个进程（工件的形状，不是接口）
    "argv": ["{py}", "{script}"],    // argv 词模板；{py} 解释器、{dir} 组件目录、{name} 组件名、{script} 入口文件
    "entry": "tool.py",              // 入口文件（相对组件目录，填进 {script}）
    "binary": "",                    // 安装版内自带的可执行文件名，存在则取代整个模板（PyInstaller onefile 用）
    "importable": false              // true = 以 `-m 包名` 驱动，组件目录须进 PYTHONPATH
  },
  "service": {                       // 这一块 = 这个进程**留下**并发布语句要用的事实（第三节）；没有它，`launch` 只是每条语句的前缀
    "discovery_env": "",             // 重指发现目录的环境变量名
    "app_dir": "",                   // 发现记录所在目录（%LOCALAPPDATA% / ~/. 下）
    "prefix": ""                     // 发现记录文件名前缀（名字里带工作区根的摘要，所以一个目录放全部）
  },
  "requires": ["python"],            // 宿主设施清单："python" | "posix-shell" | "curl"；缺席会点名解释，而不是静默消失
  "vars": { "base": "host.port_url" }, // 语句占位符 -> 宿主事实（见第五节）
  "facts": { "skills": "--facts list" }, // 本组件**发布**的宿主事实（第五节）：token 是宿主的，回答的形状也是
  "ui": { "label": "...", "status": true }, // 用户怎么称呼它；status=true 时缺席要在界面解释
  "directory": "",                   // 代码目录的显式指向（catalog.d 注册用；检出/安装版不需要）
  "prompt": "PROMPT.md",             // 模型面向的提示词片段（组件目录内的文件，见下）
  "tools": [ /* 工具声明，见第四节 */ ]
}
```

`subject` 词汇（宿主定义，组件从中选）：`workspace-fs`（服务工作区所在机器的文件
系统——该机器上必须有工作区根才能为它服务）、`foreign-fs`（别的机器的文件系统——工作区根
**不在**这台机器上，今天由 `clutch-ssh-workspace` 经客户端插件域、走 ssh 隧道服务它，
见 `SSH_WORKSPACE_PLAN.md`）、`project-file`（.clc 项目文件）、`network`（网络）、
`skill-library`（技能库）。

`prompt` 是组件**自己的话**：一段 markdown 片段（相对组件目录，像 `launch.entry`），
宿主读出来后接在系统提示词的通用部分之后——**只在这个组件可驱动时**才接
（`registry.prompt_section`）。宿主自己的流程文字因此不写任何组件的工具名：组件缺席、
改名或被第三方替换时，那段话随它的工具一起消失，提示词不会描述一个模型调不到的工具。
片段与工具描述一样经过宿主事实替换（第五节），且**不加 `prompt` 就什么都不说**——
工具自己的 `description` 已经说明了它怎么用。片段花掉的每个事实都必须**当下有值**：
花了一个答不上来的事实（含"答得上来但是空"）的片段**整段不接**，因为靠同一个条件
提供的那批工具也已经不在了——提示词不许承诺模型调不到的东西（第五节）。

`launch` 不是对组件形态的限制：onefile、脚本、包、任何语言的可执行文件都可以，只要
它接受调用契约（daemon：`--workspace <根> --idle <秒>`，围栏时另有 `--protect <glob>`；
cli：`--envelope` 信封输出）。argv 词逐一交给 Popen，**没有 shell**——引号属于语句层。

`service` 的**存在**（哪怕写的是 `{}`）就是那句话："这个进程起一次就留下，并且发布语句
要用的 `{port} {token} {pid}`"。没有这一块，`launch` 就只能当每条语句的前缀用——那是一次
调用一个进程。宿主不读种类词来分辨这两件事（D3）：它读的是声明**贡献了什么**，三个字段
就是全部答案（第三节）。三个字段都只是**坐标**：记录本身是
`{"version":1,"workspace":…,"port":…,"token":…,"pid":…,"started":…}`（第三节），文件名是
`<prefix><sha256(normcase(工作区根))[:32]>.json`。这三个键写在清单顶层是同一份声明的**旧
拼法**：0.1.57 之前发布的清单仍然被这样读入、折进 `service`，所以旧组件不必先改清单才能
被新宿主驱动；反过来不成立——旧宿主读新清单会丢掉发现坐标，因此清单迁移搭 0.1.57 那次
组件重打包的车，不抢先。

## 三、三种形态：谁跑这条语句，声明自己说

**留下（daemon）：声明里有 `service`**。每个工作区一个常驻进程，loopback HTTP。宿主按发现记
录（`service` 的 `app_dir` 下 `<prefix><digest>.json`，`discovery_env` 可重指）找到它，没有就
按 `launch` 拉起。
组件的 `command` 是**整条**语句（loopback 调用即接口），典型形状：

```
curl -sS --noproxy 127.0.0.1 -H 'Content-Type: application/json' -H 'X-Clutch-Token: {token}' --data-binary {*} http://127.0.0.1:{port}/read_file
```

宿主只提供**事实**：`{port}` `{token}` `{pid}`，都是从组件的发现记录里读出来的。至于
"HTTP 头"、"状态码"、"`curl -w`"——那是**语句自己的措辞**，宿主不认识这些词。宿主值经
`shq` 单引号包裹（永远如此），所以 `-H 'X-Clutch-Token: {token}'` 是惯用写法：值被包成
`'tok'`，正好嵌在外层单引号之间，拼成 `'X-Clutch-Token: 'tok''`，shell 里就是一个词。
响应一侧对称：宿主只认组件打印的信封（`{"content","error","diff"}`）与退出码，**从不**
解析 HTTP 状态码——拒绝也要由组件自己写成信封（daemon 的 403 正文就是
`{"content":"bad or missing token","error":true,"diff":""}`）。

发现记录本身也是冻结契约：`{"version":1,"workspace":…,"port":…,"token":…,"pid":…,
"started":…}`，宿主只读 `version/port/token/pid`。**就绪**的定义是"出现了一条 pid
与之前不同的**新**记录"——没有健康探测这一步（组件不必实现任何动词）。进程纪律两条：
宿主只对自己拉起的子进程发 SIGTERM，捡到的 daemon 不归它管（留给它自己的 idle 计时器）；
daemon 退出时按 pid 匹配才删记录，所以被顶替的 daemon 删不掉继任者的记录。

**一调用一个进程（cli）：有 `launch`，没有 `service`**。宿主按 `launch` 渲染出**前缀**
（检出 = `{py} {script}`；安装版若有 `binary` 或与组件同名的可执行文件，前缀就是它本身），
组件的 `command` 只是可执行文件之后的旗标——同一份声明同时驱动检出与安装版：

```
"command": "--envelope save --title {title} --content {content}"
```

**客户端（plugin）：两者都没有，声明点名 `entry`**。前面两种都跑在**持有组件的那台机器**
上，这一种跑在**调用它的那个客户端**上。它解决的是前两种解决不了的那类主体：
搜索、剪贴板、客户端自己机器上的东西——**字节在这边、密钥在这边、出口在这边**，只有一
句"我声明了什么工具"需要过隧道。

所以它没有 `service`、也没有 `launch`：工具集来自组件目录里那份 `component.json` 的 `tools`，
每条工具带一句**自己的** `command`——那就是这条语句，宿主不改写、不填事实，只把模型的参数原样
附在它后面（见第五节"语句在哪台机器上渲染"）。声明里多一个 `entry`（相对组件目录，像
`launch.entry` 一样是路径、不是语句），指向那份 CommonJS 模块，它导出一个 `run(argv)`：

```js
// entry 指向的文件；argv 是这条语句渲染出来的词：
//   argv[0] = 工具名（= 工具名，错位了不执行）
//   argv[1] = 模型参数的 JSON 字符串
module.exports.run = async (argv) => {
  const [tool, raw] = [argv[0], argv[1] || "{}"];
  const args = JSON.parse(raw);
  // 回答：一段字符串，或 {content, error?}——形状与信封同源，只是语言不同
  return { content: "…" };
};
```

工具的 `command` 因此只写一种形状：`"<tool> {*}"`。这一句既是"哪个工具"，也是"怎么把参数
变成一个词"——`{*}` 渲染成键排序过的 JSON，客户端拆都不拆就交给 entry。

一个真的例子：`clutch-websearch/plugin`（子模块里，`web_search`/`web_fetch` 的 JS 移植，
只用 `http/https/dns/zlib`，组件目录没有 `node_modules`）。它的 `README.md` 逐条写下与
Python 版**故意不同**的那几处（块级换行、不做 TLS 指纹、coverage 为 `null` 时给一句话而不
是崩、内部的 `positions` 不过线）以及它读的每一个 `CLUTCH_*` 名字。守它的是三层：子模块的
`tests/plugin-test.js`（解析器、围栏、覆盖率 guard，无网络）、父仓
`tests/client-plugin-websearch.test.js`（装 → 推 → `/call` → 删，真 fork），以及
`tests/channel_test.py` 把那**随包发出去的** `component.json` 钉在 `channel._plugin_of` 上
——声明的形状因此不是测试里编的。

**一台机器，一个答案（C7）**：落脚点只有一个，规则写在 `ui/components.js#destinationOf` 里，
页面上没有任何旋钮参与——声明里有 `service`（哪怕写的是 `{}`）或 `launch`，这条语句就在
**会话命令跑的那台机器**上；两者都没有、只点名 `entry`，它就是**这台客户端**的。
`service` 与 `launch` 并存不是矛盾：常驻进程也是被 `launch` 拉起来的（上面 daemon 那一节）。
矛盾只有两种，两种都不装、不猜、只说那句话，于是也没有"第三个选项"可给：

- **既没有进程也没有 `entry`**：没有任何东西能跑这条语句，声明不完整；
- **`entry` 与 `service`/`launch` 并存**：一份声明同时说"在那边跑"和"在这边跑"，两个答案
  不是一个答案。

自动装（`ensureComponents`）同用这一条：不是会话那台的声明，它一个字节都不碰。

**"够不着"与"没读到"是两件事**：前者是那个落脚点今天拨不过去（会话那台没有 supervisor URL、
这台壳没有客户端插件域），控制项因此关掉；后者是那个落脚点自己的清单没回来（宿主仍然要裁定，
装也许还是对的），控制项照旧可用，行上只说"未知"并把原因写出来。`destinationOf` 的回答因此
是三个词 `{place, read, error}`：`read: false` + `error: ""` 就是"声明还没读"（市场行的
常态，不能因此说"我不能装"）；`place: null` + `error: ""` 是"不知道"，也不是拒绝。把这两种
情形合成一种，就会在"清单读失败"时对着一个活得好好的宿主说"我不能装"。

客户端怎么把它接上会话，是**声明 + 反向通道**，不是把字节送过去：

```
客户端  ──① POST /api/channel──▶  [会话里的 agent.server]
        { port, token, components:[{name, version, entry:"index.js", tools}] }
        ◀── ②（只是记忆：这张表活在这个会话进程里，重启即空）

[会话里的 agent.server] ──③ POST http://127.0.0.1:<port>/call──▶  客户端的监听（带令牌）
        { component, command, args }   ◀── ④ { content, error? }
```

`command` 是客户端**自己推上来的**那条工具语句，逐字回送：宿主不渲染它，也不知道它的第二个词
是什么；客户端拿它和自己装的那份 `component.json` 逐字比对（不是自己声明的语句，一句都不跑）。
工具名不出现在这条请求里——有了语句，"要跑什么"就已经说清楚了。

要点，每一条都对应一处 fail-closed：

- **通道是"在这台机器上没有"的另一种说法**。一句只在客户端上跑的声明（没有 `service`、没有
  `launch`，只有 `entry`）若没有通道，`rendezvous.unavailable_reason` 说的是"this host has no
  channel to that client"，**绝不**本地代跑（声明不是提示，是断言）。声明的字节因此永远不进这台机器——进不来，也
  没有地方可跑。
- **推送是整集**：一次 `POST` 就是这张表的全部，`DELETE` 是"我没有插件"（于是拒绝变成一
  句关于状态的话，而不是一次拨到空处的等待）。没有"改一个"的动词，因为两张表对不上时
  "以谁为准"没有答案。
- **推送里没有字节，但有那句话**：`name` / `version` / `entry` / `tools`，没有 `digest`、
  `launch`、`location`。`entry` 是一个路径、不是语句（像 `launch.entry`），说清"客户端拿哪个
  文件跑这句话"；字节在哪台机器上是那台机器的私事
  （PLUGIN_PLAN.md 零之四.1 的同一条界线）。`tools` 里带 `command` 不是泄露：那句话本来就是
  客户端自己声明、自己执行的，宿主只是把它送回来——**宿主不能自带语句**，这才是边界。
- **转发是先决条件**：端口是远侧 sshd 分配的一个 loopback 端口，一行反向转发把它送回客
  户端的监听。转发没落地就不推——让会话去拨一个没人应答的端口，比"没有通道"更假。
- **令牌是栅栏**：`/call` 要 `Authorization: Bearer <token>`，令牌只在推给本机会话的那
  一个请求里出现，所以推送只发往 loopback 的 http base（`ui/plugin-link.js#session()` 拒
  绝一切不是 `127.0.0.1` / `localhost` / `::1` 的地址）。它是"只有我推过的那个会话能问
  我"，不是沙箱：插件以应用权限跑在自己机器上（见 PLUGIN_PLAN.md 零之五）。
- **只推给远端的会话**：本地会话里客户端和会话是同一台机器，客户端插件在那儿就是普通
  的本地组件，这个通道只会重复组件页已有的东西（`ui/main.js#announcePlugins`）。隧道断了
  也一样：`ui/plugin-link.js#snapshot()` 在 `state.client` 为空时把 `subject: foreign-fs` 的
  声明从整集里拿掉（`hopLost()`），于是"记住的 base + 刚死的 hop"不会留下一个拨不通的声明。
- **执行桥也是一份环境，不是设施词**：需要在**远侧**跑命令的插件（`clutch-ssh-workspace`
  是第一个）从 fork env 里读 `CLUTCH_EXEC_BRIDGE`（`http://127.0.0.1:<port>`，隧道不在时
  是空串）以及 `CLUTCH_EXEC_MAX_COMMAND_BYTES` / `CLUTCH_EXEC_CHUNK_BYTES`（宿主没意见
  就不写）。地址是**没有令牌的 loopback**，拿到它等于拿到远侧任意 shell——插件本来就是
  应用权限的受信代码，这不是新增授权，但安装文案必须写明。`catalog.FACILITIES` 因此没有
  多出一个词：桥是客户端**提供**给插件的环境，不是宿主必须先备好的设施。

## 四、工具级字段

```jsonc
{
  "name": "read_file",               // 工具名（模型可见的唯一名）
  "description": "……",               // 必须是字符串；模型面向，可携带宿主事实占位符（第五节）
  "parameters": {                    // JSON Schema（properties + required）
    "properties": { "path": { "type": "string" } },
    "required": ["path"]
  },
  "command": "…",                    // 语句模板（第三节）；没有 command 的声明不会成为工具（宿主自己那条除外，第十一节），plugin 的工具没有它则整份声明 fatal
  "defaults": { "max_chars": "$config.read_max_chars" }, // 语句载荷默认值，垫在模型参数之下
  "access": "read",                  // 宿主策略词汇："read" | "sweep" | "write" | "command" | ""（不受限）
  "snapshot": false,                 // true = 该语句覆写 path，宿主为界面保留 per-file undo
  "modes": ["work", "chat"],         // 出现在哪些模式
  "gate": "",                        // 宿主侧条件："project"（项目记忆库已开）| "skills"（技能可用）；关着就不提供
  "ui": { /* 呈现块，第六节 */ }
}
```

`access` 是**宿主定义的词汇**，声明只能从中选、不能发明：权限引擎
（`permission.GUARDED_ARG`）读这个字符串和它点名的受 guard 参数（`path` /
`command`）来判定一次调用能碰什么——组件后来才装上，也自动落进同一套策略。这张
词汇表（以及 `gate` 的条件表）本身也是宿主可配置的：`~/.clutch/host.json` 逐词覆盖
内置表，第十二节。

## 五、语句模板与宿主事实

**语句占位符**（`inst.render`，fail-closed）：

- `{参数名}` —— 模型参数，POSIX 单词引号包裹；
- `{*}` —— 全部参数合成一个引号包裹的 JSON 对象（daemon 的请求体即它）；
- 宿主值：daemon 语句可用 `{port}` `{token}` `{pid}`——**只是发现记录里的事实**，
  协议词汇由语句自己写（见第三节的 `-H 'X-Clutch-Token: {token}'` 惯用法）；
  cli 语句可用组件 `vars` 点名的宿主事实，已发布的只有 `host.port_url`（.clc 内容
  服务）——技能库的根是组件自己的事，宿主不再有一条通往它的线；
- `[ --flag {x} ]` —— 可选组：组内占位符填不上时整组（连旗标）消失，绝不留半截旗标。

宿主值遮蔽同名模型参数，模型参数劫持不了宿主占位符；正因如此，`vars` 的键与某个工具的
参数同名的声明**在接线时被拒绝**（`catalog.component_diagnostics` 报一条 fatal），而不是
静默吞掉模型给的值。

**语句在哪台机器上渲染，由声明贡献了什么决定**（`statement.Statement.run`）：

- **有进程在这里**（`service` 或 `launch`）—— 宿主渲染上面那张表，得到一条**命令行**，交给
  transport（shell / 服务的 loopback 调用）。
- **没有进程、只有 `entry`** —— 宿主**不渲染**：模板逐字走 `/call` 送到客户端，客户端渲染成
  **argv 词**再 fork（`ui/plugin-host.js#renderArgv`）。语法是同一张表，落点不同：没有 shell，
  所以没有引号那一层。

客户端那份渲染器的规则，一条不多：

| 写法 | 变成 |
| --- | --- |
| 空白分词 | 词与词 |
| `{参数名}` | 一个不透明词：值原样（空格、换行都留着） |
| `{*}` | 一个词：`JSON.stringify`，键在每一层都排序（与 `inst.jarg` 的 `sort_keys=True` 同形） |
| `{dir}` | 客户端唯一的事实词：组件安装目录；它遮蔽同名模型参数 |
| `[ … ]` | 组内任一占位符缺失则整组丢掉 |
| `[[` / `]]` | 字面量 `[` / `]` |

组外的缺参、坏 `{`、未闭合 `[`、孤立 `]`、嵌套组、渲染成一个词都没有——全是错误，各带一句
话。**只有 `{dir}` 是事实**：`{name}` 永远读模型参数，因为 `clutch-memory` 就有一个参数叫
`name`——事实词表越长，撞名的可能性越大，所以它只有一项。渲染完还要求 `argv[0]` 等于这条语句
所属工具的名字（ABI：`run(argv)`，`argv[0]` 是工具名）；错位不是"尽力执行"，是拒绝。

**schema 占位符**（声明是数据，宿主接线时把只有自己知道的事实填进去）：

- `$config.<字段>` —— 配置字段值。整值引用保持原类型（`"defaults": {"max_chars":
  "$config.read_max_chars"}` 接线后是整数）；句中引用拼成文字。
- `$skills` —— 本机技能名列表，**由声明 `facts` 的组件发布**（见下）；整值引用成为
  enum，句中引用拼成逗号列表。
- `$backends` —— 本机已配置的搜索后端链（未配置的服务不存在，无名字）。这份链本身
  是宿主的表（第十二节），**尚未**像 `$skills` 那样由组件发布：挑哪个后端已经是
  `host.json` 里的事，但"有哪些后端可挑"这份词汇仍由宿主持有——这是本规范唯一一条
  己方词汇还没交还给组件的余量。

接线后 schema 里不应残留任何 `$` 占位符。

**已发布的事实**（`facts`：组件 → 宿主）：

`vars` 是组件向宿主**要**的东西；`facts` 是组件向宿主**给**的东西——只有它自己的代码
算得出来的宿主事实。宿主只为宿主知道的事保留值，其余一概去问。目前词汇表只有一个
token：`skills`（技能库目录表）——它正是宿主过去自己扫 `*/SKILL.md` 的那份工作，而
那份库是 `clutch-skills` 的 `subject`，不是宿主的：库的位置、库的内容、往库里装一个
技能（`clutch-skills install`，见它自己的 README）都是组件自己的事，所以这条声明里
也**没有** `--root`——宿主没有一条通往库根的线，那个根只有组件自己知道。

声明说的是"要问这个事实，就打这条语句"：

```jsonc
"facts": { "skills": "--no-server --facts list" }
```

语句和工具语句同源同渲染（`inst.render`，可用同一批 `vars` 宿主事实与可选组），因为
它同样是一条命令行——只是没人调用它，所以没有模型参数。

**回答的形状是宿主的，从来不是组件自己的 wire 格式**：stdout 上一个 JSON 数组，每项
`{"name", "description"}`（`name` 是模型要挑的字符串，`description` 是提示词里写在它
旁边的那行）。组件自己的 `--json list` 载荷（`{"root","skills":[…]}`）是它与自己调用
者的契约，宿主**不读**——问了什么形状，就只认什么形状。

四条纪律：

- **只有一调用一个进程的组件可以发布**（有 `launch`、没有 `service`）。留下（`service`）的语句
  是说给"某个工作区的那个服务"的，而宿主事实不属于任何工作区；客户端自己的语句在那边跑，而
  事实是在这里答的。这两种声明在 `catalog.component_diagnostics` 里都是 fatal。
- **一个 token 只许一个发布者**。两个组件都声明 `skills` 时谁也答不上来，宿主点名这
  两个名字（`A and B both publish it`）而不是替模型挑一个库——挑一个就是两份真相。
- **答不出来就 fail-closed，但绝不静默**：事实读作"无值"，需要它的 `gate` 关掉、花掉
  它的提示词片段整段不接（那批工具同样不在了），同时把**组件自己的理由**说一次
  （`registry._report`，一个进程一次）。库读不出来是用户必须看见的事，不是"空目录表"。
  答得上来但是 **0 项**同样是"无值"，而不是"空 enum"。

进程纪律：一个进程内只问一次（`facts._asked` 按**渲染后**的命令行缓存——目录、库根
这些塑造了这条线的宿主值都在线里，所以两个根不会共用一份答案）。

片段里怎么花掉它：句中的 token 读作名字列表（`", ".join`，空则 `none`），而**整行恰好
是 `$skills`** 的那一行展开成每条一行 `- name: description`——与组件自己的目录表
（`clutch-skills` 的 `catalog_section`）逐字节同形：组件写表头，每一行是宿主写的。

## 六、UI 协议

宿主渲染的不是自己设计的工具事件，所以"事件长什么样"是声明的一部分；渲染层
（`ui/app.js` 与 `ui/js/*`，按 `ui/index.html` 的脚本顺序加载）里没有任何工具名，
每个工具事件都携带它的 `ui` 块（回放同构渲染，后装的组件无需改界面就能被渲染），
把它画出来的是 `ui/js/tool-render.js`。键全部可选，缺省即素净外观——内置缺省表，其上可被这台机器的
`host.json` 覆盖（第十二节），启动时经 `GET /api/host` 递给渲染器，调用自己的
`ui` 块仍然最优先：

| 键 | 取值 | 默认 |
| --- | --- | --- |
| `group` | 任意不透明值；同值调用合并进一个密集块（每调用一行、结果折进行内）；`null` = 各自成行成块 | `null` |
| `chip` | `"name"` 行首带工具名 / `"none"` 不带 | `"name"` |
| `summary` | 行的一行标签；`{参数名}` `{lines}`（结果行数）`{name}` 可用；`""` 无标签 | `""` |
| `preview` | 调用流式进行时那行显示什么：`"args"` 原始参数 JSON / `"content"` 参数自带文本 / `"command"` 解包后的命令（配 `mark`，`"$ "`）/ `"none"`；`content` 下 `keys` 按序点名参数，前缀 `-` `+` `✎` 是印在值前的记号 | `"args"` |
| `header` | 结果自成一块时的标题（占位符同 summary）；`""` 退回 summary，再退回 `result`；失败的调用永远读 `result ⚠` | `""` |
| `form` | 结果是什么形状：`"block"` 标题加正文 / `"row"` 单行可折叠 | `"block"` |
| `body` | 正文怎么渲染：`"text"` / `"code"` / `"diff"` / `"none"` | `"text"` |
| `highlight` | 代码正文的装饰：`"path"` 按调用的 `path` 参数高亮 | `""` |
| `chrome` | 附加装饰：`"accent"` 标题变强调色块 | `""` |
| `collapse` | `"always"` 起始折叠 / `"long"` 超长折叠 / `"never"` 全展开 | `"never"` |
| `mutates` | 调用可能改变文件树；声明可自报，宿主也会推导（覆写 path 的语句、宿主自己的命令） | 宿主推导 |

另有一个声明管不着的键：`undo`（宿主是否握有这次调用的 undo 记录）。

## 七、发现与合并

宿主**没有基线目录**：没有任何注册时，它只能聊天。三个来源按低到高：

1. **dev 检出**——`modules.repo_root()` 的每个带可用 `component.json` 的兄弟目录
   （按目录名排序，合并确定）；
2. **已安装工件**——安装根里每个能解析出的 manifest（即 `components.inventory()`）；
3. **catalog.d**——用户注册目录里的 `*.json`（按文件名排序），最后的发言权。

同名组件按**字段级 refine** 合并：后来者**没点名的字段照旧、点名的字段覆盖**。所以
一份只带安装事实的薄 manifest（name/version/digest/artifact）会骑在检出声明之上——
安装事实覆盖安装事实，工具、`launch`、`service`、`entry` 原样保留；第三方组件没有前置声明，
就整体进入。

**不可用的组件不提供工具，也没有替身**：`registry.build_tools` 对缺席组件贡献零
schema（提示词片段同理，`registry._drivable` 是同一道筛选），客户端用
`unavailable_reason()` 向用户解释（声明 `ui.status: true` 的才解释，其余安静缺席）。**停用**
走的是同一道门、同一条解释路径：字节能读、声明完整，只是这台机器决定不驱动它（第八节末）。

**谁在场还取决于根在哪台机器**：`build_tools(config, memories, workspace)` 收下工作区，按声明的
`subject` 与"根是不是本机"筛一遍（`registry._serves_this_workspace`）。方向是**不对称**的，故意的：

- `foreign-fs` 的组件要求根**不在**本机。本地根上它被**丢掉**，不是"留着再拒绝"——它的工具与
  本机真正能用的那些同名，留着就等于让后折叠的客户端声明盖掉一个能用的 `read_file`。
- `workspace-fs` 的组件即使在 ssh 根上也**保留**：它的拒绝（"this root is another machine's"）
  正是插件没装时该说的那句话，比"工具静默不在"有用得多。插件在场时同名工具因为折叠在后而获胜，
  这条顺序由 `tests/channel_test.py` 钉住，不许退化成巧合。
- 没有工作区（还没跑过任何任务、只看 schema 的调用方）就是没有机器可判，每个组件都出场。

两个谓词在 `rendezvous.serves_workspace_fs()` / `serves_foreign_fs()` 里互为镜像，逐次调用的那句
话在 `prompt.module_blocked_reason`，与这里用的是同一条事实。

## 八、安装、卸载与停用/启用的 wire 协议

组件属于**要运行它的那台机器**。客户端让那台机器的 supervisor 把工件装上（字节怎么到
见下「字节怎么到」），也让那台机器把组件交出来、说停不停——**同一个门，三个方向**：

```
POST   /api/components/install
  X-Clutch-Component: <base64(UTF-8 JSON)>   声明 + 安装事实（发布态可带 `artifact_url`）
  body: <工件字节流>  |  空 body + manifest 的 `artifact_url`（目标机自己取）
GET    /api/components                        该机器已装清单（name/version/digest/disabled）
GET    /api/components/versions?name=<name>    这一个组件的每一版，新→旧，resolved 标出会跑的那一版
DELETE /api/components/<name>[?version=]       让这个组件（或它的某一版）离开这台机器
POST   /api/components/<name>/disable          停用：这台机器不再驱动它（字节一律不动）
POST   /api/components/<name>/enable           启用：重新驱动
```

`versions` 的**顺序也是宿主的决定**（就是 `resolve()` 的选择依据），客户端照抄不重排：哪一版
会赢是宿主的知识，页面重排等于发表第二意见。`DELETE` 的回答有三种形状，都是**答案**：

- `{"status":"removed","removed":[…]}`——删掉了这几版，删了哪几版由宿主报出来；
- `{"status":"absent"}`——本来就没有，**不是错误**（要求已经成立，报错等于凭空造一个问题）；
- 400 带宿主原文——名字不合法、`?version=` 指向没装的版本、或**有不是本次进程启动的 daemon
  正在跑它**。

四条规则，缺一条都不算实现对：

1. **`absent` 是答案，`?version=` 没装是拒绝**。两者都"没删到东西"，但一个是请求已经为真，
   一个是请求本身说错了对象——后者一删就要 400，且**不许**顺手删掉别的版本。
2. **拒绝必须落在动手之前**。`remove()` 把"有没有在跑"作为调用方的 `stop` 回调接进来，且
   **只在确实有东西可删时**才调用它；名字/版本的判断同样在 `stop` 之前。否则一次注定被拒的
   删除会先把 daemon 杀掉再报错（见 PLUGIN_PLAN.md 零之三.6）。
3. **先停后删，且只停自己启动的**。本进程启动的 daemon 先停再删（属主规则与 `release` 一致）；
   收养的句柄（`proc is None`）或只在磁盘上有活记录的一律拒绝，并把 **pid 写进句子**——
   "磁盘上读到的 pid 不是开枪许可"。已知边界：一个**记录被删掉**的活 daemon 查不出来，
   记录是宿主唯一的名册（PLUGIN_PLAN.md 零之三.5）。
4. **停用不是删除，删不掉的东西不用二次确认**。`disabled` 与"在不在"正交：`inventory()` 照
   列出（多带 `disabled:true`）、`DELETE` 照能删，没有任何一条路径因为停用去动一个字节；重复
   停用/启用是幂等的。反向也成立——它撤得回来，所以它是协议里唯一**不要求**用户确认的写入
   （PLUGIN_PLAN.md I5 只约束撤不回来的动作）。

头的值必须是 base64——HTTP 头是 ByteString（每个码点 ≤ 0xFF），而声明按设计就是
组件自己的语言（中文照写），裸 JSON 过不去。解码在宿主端只有一处：
`components.manifest_from_header`。

要点：

- **版本门是内容**：manifest 携带工件 sha256（`digest`），而**安装版本号 = 组件自报版本
  + 内容摘要**（`0.1.0+<hex16>`，宿主 `_VERSION_RE` 一直认这个形状）。摘要
  前缀本身仍是合法版本——一个手里只有字节、说不出版本的客户端就发那个（`installVersion()`
  的兜底）。同版本不同字节 = 重建过 = 必须重装；同版本同摘要 = 什么都不传。
- **宿主先验字节**：落地前先对收到的字节算摘要，不符即拒绝（错误即数据，400）。
- **工件两种形状**（按后缀识别）：`.tar.gz` / `.tgz` / `.tar` / `.zip` 解包进组件
  目录（成员点名组件根之外的东西 → 整体拒绝）；其余当单个可执行文件，以组件名落地
  并加 +x。
- **原子落地**：先写进同级 `<version>.installing`，完成后整体改名；同组件其它版本
  全部清掉——一台机器只跑一个版本，装层决不让解析器挑到旧版。
- **声明合并（宿主端兜底）**：解包后若工件自带 `component.json`，安装记录 = 工件
  自带声明 + 请求 manifest（后者点名的字段覆盖）。所以**薄 header 也能落地一个完整
  组件**；自带声明若点名了**别的**组件，安装被拒——字节不是请求所说的那个组件。
- 客户端发送（`ui/components.js`）：manifest = **组件发行版自己发布的那份声明**（从
  索引那一行读到 `manifest` 的位置，取回后按行的 `manifest_sha256` 验摘要）+ 安装事实
  覆盖。检出态是同一件事的本地形态：直接读仓库旁的 `component.json`。发布包因此
  **不含任何一个组件的字节**
  ——声明随 manifest 走，一个 tar（或 onefile）+ 旁边一份 `component.json` 即完整组件；
  装哪个版本由索引那一行的 `version` 和模块自己的 release 决定（第一节末：两者不一致就拒，
  所以发一个 release 不等于"装得上"）；装到**哪台机器**由组件自己的
  声明决定（第三节「一台机器，一个答案」），不是页面上的一项选择。
  发布态递过去的是**URL + 摘要**（`fetchInstall()`）；只有手里真有字节文件的检出态/
  预构建产物才退回 `upload()`（字节进请求体）。

### 字节怎么到（谁下载、谁测量）

安装请求里的工件字节有两种形状，宿主只认这一对：

- **目标机自取（发布态，默认）**：客户端把工件的 URL 写进 manifest 的 `artifact_url`
  （连同 `digest`），请求体留空；**要运行它的那台机器**自己把字节抓回来
  （`components.download()`：只认 http(s)，`file:` 与本地路径拒绝，30 s 读超时、
  64 MiB 上限，流进 scratch 而不是内存放着）。下载方 = 测量方 = 运行方，链路上没有
  第二台机器代量。
- **`upload()` 兜底（检出态/预构建产物）**：本地文件没有可取的 URL，客户端把字节放进
  请求体（`Content-Length` > 0），宿主照收。

两种形状落进**同一道 `accept()` 门**：落地前先对最终字节算摘要，与 manifest 的
`digest` 不符即 400（错误即数据），没有"URL 来的就信"这条捷径。客户端手里**不留工件
副本**——经过这台客户端的只有几百字节的声明；字节要么在目标机的 scratch 里被量过，
要么压根没经过它。

**够不着时的回退（第八节上文的镜像列表）**：一次取数失败得像是"网络上够不着"时，客户端把
`artifact_url` 换成 `<前缀>/<原始 URL>` 再递一次，顺序是用户列表在前、自带列表在后
（`ui/mirrors.js`）。**下载方、测量方、运行方都没变**：字节仍由目标机取、由目标机按 manifest 的
`digest` 量，所以一个前缀换来的只是**到同一份被钉住的字节的另一条路**，换不来信任。失败里属于
"回答"的（404、摘要不符、schema 读不懂）不试下一个：镜像服务的是同一条路径，答案还是那一个。

已知边界（PLUGIN_PLAN.md §七 6）：`{index: <路径>}` 点名**磁盘**上的索引时，工件也解析成本地
路径，而宿主只取 http(s)——磁盘索引给出的安装今天会失败（清单照样读得懂）。`upload()`
兜底的是检出/预构建产物，不是镜像目录。

### 停用（disabled）：唯一不动字节的写入

停用是"这台机器留着它、但不驱动它"。这个状态**只在一个地方落脚**：持有组件的那台机器的
登记表 `<components 根>/registry.json`（第一节），既不落进组件目录，也不是客户端的某个键。
理由与登记表同源——它是"有什么"的唯一名册（表里有就是有，一个没有表项的目录不是组件），
"这台机器现在驱动什么"跟着名册走，于是只有一个答案者，不需要两边对账。

唯一的反例是 `reindex()`：它**忘掉 `disabled`**。重建的语义是"重新相信磁盘"，而磁盘上没有
这个形状，所以重建之后一切重新驱动——要停，重建之后再说一次。

它抑制的东西只有一样：**工具**。字节能读（`rendezvous.resolve()` 照旧解析出这一版）、
清单照列（`GET /api/components` 的那条记录多带 `disabled:true`，所以"没装"和"不驱动"
分得开）、`versions()` 照报每一版、`DELETE` 照能删。拦截点只有一个，而且**故意晚于解析、
早于交付**：在 `rendezvous.unavailable_reason()` 里先问 `components.disabled()` 再谈别的，
于是 **dev 检出也递不上替身**——否则会出现最难看的组合：页面写着已停用，工具却还在，
因为真正跑的是检出那一份（PLUGIN_PLAN.md 零之三.7）。与安装的关系是正交的：装新版本时
组件的 `disabled` 位**跟着过去**（换版本不会偷偷把机器重新驱动起来），而停用本身幂等，
重复一次不产生第二次效果。

回答三种形状，和 `DELETE` 一样都是**答案**：

- `{"status":"disabled"|"enabled","name":…,"disabled":true|false}`——位出去了，也**报回来**
  （回显的是表里现在存的值，不是客户端要求的值）；
- `{"status":"absent","name":…}`——这台机器根本没有它，**不是错误**："确保它在这台机器上
  停着"在没有它的机器上已经为真；
- 400 带宿主原文——名字不合法或试图穿越路径，与安装/卸载同一道门（`_check_name`）。

**与 VS Code 的一处有意的偏离**：VS Code 把"停没停"记在**客户端**
（`extensionsIdentifiers/disabled` / `…enabled`，写进 `IStorageService` 的
`StorageScope.PROFILE` + `StorageTarget.MACHINE`，`extensionManagement.ts:645-646`），
因为它的客户端自己握着已装清单。Clutch **没有客户端侧的已装清单**（页面每次都问机器，
PLUGIN_PLAN.md 零之四.3），位只能住在机器上；反过来说，住在机器上正是这份清单要求的：
第二个客户端连上来时，看到的是这台机器真实在驱动什么，而不是"我没停过，所以它在跑"。

页面侧（`ui/js/components-panel.js`）：持有但停用的行，在版本号之后多一个 `stopped` 标记
和一句 "held on this machine, but not driven"，动作变成**开关 + 卸载**。开关出去的是**状态**
（`{"disabled":false}` 即"重新驱动"，动词由位决定：`ui/components.js` 的 `hostSetDisabled`
按位选 `/disable` 与 `/enable`），**不弹确认**——它删不掉任何东西，而**标签本身就是 undo**；
`absent` 渲染成"这台机器没持有它，没有可开关的东西"，不渲染成错误。

### 客户端插件不在这一节

`/api/channel`（第三节的 plugin）**不**长在 supervisor 上，也**不**落盘：它属于一个正在
运行的会话进程（`agent/server.py`），"谁持有"那个问题的答案是"持有它的那个客户端推给了
谁"。理由是同一条界线反过来用——这一节的每条写入都关于一台机器的**目录**，而插件一个
字节都不进这台机器的目录。所以推送在会话进程重启后自然消失（客户端会重推，`api:base`
就是那个时刻），而 `PUT`/`PATCH` 这类"改一条"的动词在这里是 501：没有单条可改，只有整集。

## 九、开发工作流

- **改声明**：编辑子模块里的 `component.json`，重启宿主即生效（检出自注册，无需
  安装）。schema 描述、UI 块、语句模板的改动走这条路径。
- **改实现**：宿主不 import 组件代码；接口（HTTP 表面 / stdout 契约）不变，两边
  各自迭代。组件有自己的测试套件（`cd clutch-<x> && python3 -m pytest`）。
- **造工件**：宿主侧只留 dev 用的一条路——`scripts/build-component-tar.sh` 把检出目录
  打成 tar（成员在 tar 顶层，排除 VCS/venv/缓存，`component.json` 在内），客户端按源码
  指纹缓存在 `~/.clutch/artifacts`。**发行工件由模块自己的 CI 出**：workflow 在模块
  仓库里，推 tag → 打 tar → 连同 `component.json` 和生成的 `clutch-component.json`
  一起发到它自己的 release。宿主发行版**不放置任何组件**：`<resources>` 下没有
  `components/` 目录，打包步骤也不拷——宿主 release 里组件字节数为零（第一节末）。
- **测试**：宿主侧 `tests/catalog_test.py`（发现/合并/UI 协议/占位符）、
  `tests/components_api_test.py`（安装协议）、`tests/rendezvous_test.py`（寻址）、
  `tests/tools_inst_test.py`（每个工具的命令契约）；客户端 `tests/mirrors.test.js`
  （镜像列表的规则、顺序、回退与"够不着"分类器）、`tests/components.test.js`
  （索引读取、行的字段与取数重试）、`tests/market.test.js`（索引文档本身：行是钉死版本的
  指针、与 `market/entries.json` 逐字段一致、三层回退链与降级话术）、
  `tests/net-fetch.test.js`（那一道前缀门本身，索引与清单都过它）。

## 十、第三方组件示例

代码在 `~/work/hello`，声明放进 `~/.clutch/components/catalog.d/hello.json`：

```json
{
  "name": "clutch-hello",
  "subject": "network",
  "directory": "/home/me/work/hello",
  "launch": { "argv": ["{py}", "{script}"], "entry": "tool.py" },
  "requires": ["python"],
  "ui": { "label": "hello", "status": true },
  "tools": [
    {
      "name": "say_hello",
      "description": "say hello to someone",
      "parameters": {
        "properties": { "who": { "type": "string" } },
        "required": ["who"]
      },
      "command": "--envelope {who}",
      "ui": { "summary": "hello {who}", "group": "greet" }
    }
  ]
}
```

重启宿主后 `say_hello` 即在工具表里，权限策略、界面渲染与内建组件完全同路。若组件
能打包成单文件可执行（或 tar），走 `POST /api/components/install`（第八节）安装，
连 catalog.d 都不用——安装本身就是注册。

## 十一、宿主自己的工具（唯一的引导例外）

宿主只为自己声明**一个**工具：`run_command`。它是一个**被声明的例外**，不是一笔
无人记账的欠款：

- **为什么不能是组件**：组件要能被调用，得先有一条命令把它装上；若"执行一条命令"
  的能力本身也来自组件，宿主在什么都没有时装不上任何东西。`run_command` 就是在
  "什么都还没装"时宿主仍然拥有的那个面（`registry.build_tools` 的 `_bootstrap`）。
- **它怎么被声明**：`agent/tools/host.py` 里的一份数据，字段与第四节完全相同（名字、
  描述、schema、`access`、`ui`），由**同一个解析器**（`catalog.tool_of`）读入、
  由**同一套诊断**（`catalog.tool_diagnostics`）校验——宿主自己的声明也受词汇表
  约束，写错一个词是宿主 bug，当场报错而不是悄悄变形。描述取自宿主自己的提示词文件
  （`agent/prompts/tools/run_command.md`，chat 模式读 `_chat` 版）。
- **它多出的一样东西**：实现。组件的语句**就是**它的实现；宿主的这一条由宿主代码
  兑现（`shell.run_command`），而"这次调用能不能跑"仍然全在宿主这边（`access:
  "command"` → 权限引擎、chat 只读分类、逃逸与 .clc 保护、超时、截断、Stop）。
- **组件不能占用这个名字**：`run_command` 属于 `catalog.HOST_TOOL_NAMES`——宿主
  无论装了什么都会提供它，所以组件声明同名工具会被**拒绝**（`component_diagnostics`
  报一条 fatal，整个组件不贡献任何东西），否则"模型看到的 `run_command` 是谁的"就
  取决于安装顺序了。宿主声明与词汇表在导入时互校（`registry._check_vocabulary`）。

除此之外宿主没有任何内置工具：不装组件时它只有这一个工具（`COMPONENTS.md` 开头那句
"零内置工具"的准确含义就是"零内置**组件的**工具"）。

## 十二、宿主自己的文档（host.json）

第四节的 `access` 词汇、`gate` 条件，第六节的 `ui` 缺省，以及 `$backends` 背后的
后端链——这些"协议的协议"曾经只是宿主源码里的 Python 常量：不改宿主源码就教不会
宿主一个新词。它们现在是**缺省值**，一台机器一份的宿主文档可以在其上覆盖：

```
~/.clutch/host.json        # 或 CLUTCH_HOST_CONFIG 指名的文件；空值 = 明确没有文档
```

```jsonc
{
  "access":   { "read": { "guard": "guard_read", "arg": "file" } },
  "gates":    { "cachedir": "project" },
  "ui":       { "chip": "none" },
  "backends": [ { "name": "tavily", "field": "tavily_api_key" } ]
}
```

文档**缺席是常态**：文件不存在宿主静默用内置表，一个字也不说。它刻意不在仓库里——
这些是"这台机器上这个宿主"的表，写文档的价值正在于文档是用户自己的。

三条规则：

- **点名即覆盖，逐词生效**：文档没点名的节就是内置表，一字不动；点了名的节逐词
  合并——词内只点名字段就只覆盖那个字段（`{"read": {"arg": "file"}}` 改名一个参数，
  其余的词照旧）；一个词写成 `null`，这个词就不存在了。`backends` 是**链**——有序、
  没有可合并的键——点名即整条替换，顺序照文档写的。
- **文档只能选，不能带代码来**：`guard` 与 `gates` 的值必须是宿主**已有**的实现名
  （`guard_read|guard_grep|guard_write`；`project|skills`）。指向宿主没有的实现的词
  **不会被创建**，也不会拖累内置词——拼错一个 guard 拆不掉工作区的围栏，这是
  fail-closed 的另一半：缺省永远站在被拒词的身后。
- **读不出来的，说一次**：每条不可读的记载入 `said()` 并打一行 `[host] host.json: …`
  日志；整个文档读不出来（不是 JSON、不是对象）则整份忽略、内置表照旧、说一次。
  `ui` 例外——它是**数据**不是实现，`null` 也是值（`group` 的本义），什么键都照收，
  渲染器忽略自己不认识的键。

四张表的落点：`access` 与 `gates` 在导入时合并进 `catalog.ACCESS_WORDS` /
`GATE_WORDS`（`registry` 随即把每个词绑到它的实现上，`permission.GUARDED_ARG` 读的
就是这张合并后的表）；`ui` 合并进 `catalog.DEFAULTS`，并经 `GET /api/host` 在启动时
递给渲染器——`ui/js/tool-render.js` 里的常量因此只是"宿主没有这个端点、或取不来"时的后备
（优先级：**调用自己的 `ui` 块 > 宿主表 > 常量**）；`backends` 合并成
`catalog._BACKENDS`，`field` 必须是 `Config` 的真字段（`""` = 无需配置即可用），
一个没有任何字段能打开它的名字不是这台机器的后端。
