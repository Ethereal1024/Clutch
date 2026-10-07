# 组件规范（COMPONENTS.md）

Clutch 宿主**零内置工具**：`run_command` 之外的一切工具都来自**组件**（component）——
一个独立发布的工件（本仓库的四个子模块 `clutch-workspace` / `clutch-memory` /
`clutch-websearch` / `clutch-skills`——子模块只是**开发检出**，宿主发行版一份组件字节
都不带，见第一节末；也可以是任何第三方的同类物）。宿主不为任何组件保留第二份实现，
也不内置任何组件的声明；它只做两件事：**发现**声明、把声明接进循环。

`run_command` 是唯一的例外，而且它同样是**被声明**的：宿主为自己写的唯一一条工具
声明（`agent/tools/host.py`），见第十一节。

这份文档是组件与宿主之间的契约，模型面向的 schema、安装协议与界面呈现都从这里读。
代码对应关系：发现与合并在 `agent/tools/catalog.py`，声明 → 工具在
`agent/tools/registry.py`，寻址与启动在 `agent/tools/rendezvous.py`，安装落地在
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
| 已装登记表 | `<components 根>/registry.json` | 这台机器**持有**什么的唯一名册：每 `(name, version)` 一条，带 `interface` / `digest` / `location` / `disabled`。表里有就是有——目录躺在根下而表里没有登记的，不算这台机器的组件；`disabled` 只住在这里（磁盘上没有它的形状，见第八节末） |
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
  "interface": "cli",                 // 怎么被调用（第三节）
  "version": "0.3.1",                 // 这份发行版自报的版本
  "declaration": { "asset": "component.json", "sha256": "<64 hex>" },
  "artifacts": {                      // 平台标签 -> 工件；键 "any" 兜底
    "linux-x86_64": { "asset": "clutch-skills.tar",        "sha256": "<64 hex>" },
    "darwin-arm64": { "asset": "clutch-skills-darwin.tar", "sha256": "<64 hex>" },
    "any":          { "asset": "clutch-skills.tar",        "sha256": "<64 hex>" }
  }
}
```

- **资产相对清单**：`asset` 是清单**旁边**的名字（文件名或相对路径），清单自己的
  地址给出基准——模块因此不必知道自己的绝对 URL，一份清单放进本地目录同样能用
  （测试与镜像都靠这条）。
- **摘要即信任**：`sha256` 必须是 64 位十六进制；缺失或形状不对的条目**整条拒绝**，
  不猜、也不"尽力而为"。字节由**要运行它的那台机器**自己取回、自己量（第八节
  「字节怎么到」），先验字节再落地；量的是目标机，不是转手的客户端。
- **平台查找先精确后兜底**：按客户端的平台标签（`linux-x86_64` / `darwin-arm64` /
  `windows-x86_64`）取键，取不到用 `any`。今天的四个模块都只发一个平台无关的
  **tar**（`clutch-skills` 的 tar 里是代码 + `skills/`——技能库随组件自己的发行版走，
  宿主不留第二份），将来要发 PyInstaller onefile 也不必改协议。
- **声明是位置而不是内容**：`declaration` 说的是**一份文件在哪**（资产 + 摘要），不是
  声明本身——清单因此只有几百字节，只有真要递给某台宿主时才把那几 KB 取回来（取回
  后同样验摘要）。
- **一个模块一条 URL**：客户端读的是**来源清单**——随宿主发行版打包的
  `ui/components.sources.json`（`{"schema": 1, "sources": ["https://…/clutch-component.json", …]}`），
  以及可选的用户清单 `~/.clutch/components.sources.json`（**用户清单先读，先命名一个
  组件的那个说了算**，用户因此能覆盖某个模块、或在宿主不认识的地方挂上自己的发行版）。
  这就是加第五个模块的全部代价：多一条 URL，宿主代码一行不用改。
- **自带清单可以整体走镜像**：自带清单里是四条 `github.com` URL，而"某些网络下
  `github.com` 根本不可达"是实测（能通的往往只有 `api.github.com`）。所以在一个来源
  **变成 URL 的那一处**（`ui/components.js` 的 `sources()`）应用一次前缀：
  `<镜像>/<原始绝对 URL>`，路径原样保留——因为清单里其余地址都是它的**兄弟**（见上文
  "声明是位置而不是内容"），于是**声明**与**目标机自取工件**的那条 URL 一起跟着走。
  前缀取 `CLUTCH_SOURCE_MIRROR` 环境变量，其次取 `~/.clutch/settings.json` 的
  `source_mirror`（桌面 GUI 继承不到环境变量，控件留待后续轮，手上先能手改）：

  ```jsonc
  // ~/.clutch/settings.json
  { "source_mirror": "https://ghfast.top" }   // 或 CLUTCH_SOURCE_MIRROR=https://ghfast.top
  ```

  非 http(s) 的前缀**丢弃**而不是照用（照用会把 http 来源改写成不是 URL 的东西，
  报出来却是"网络失败"）。用户自己写的清单与调用方显式传入的清单**原样照用**：写的人
  已经写清了要从哪读，一个局域网索引不该被送去公网加速器。镜像只搬字节、不为字节背书：
  摘要仍按 release 自己的 pin 校验，镜像换了字节就是那一条被拒。
- **代理用的是运行时的栈**：桌面端读远程清单/工件走 Electron 的 `net.fetch`（Chromium
  默认 session 的栈，机器的系统代理配置据此生效），而不是 node 的全局 `fetch`——后者
  不认 `HTTPS_PROXY` 之类的名字，于是"读一个源"会一直挂到自己的超时，界面上只看到源
  "什么都没答"。这个选择只在 `ui/net-fetch.js` 一处，超时的 `AbortSignal` 原样透传；
  宿主端点（`hostJSON`/`postInstall`）**不**经过它——那是 SSH 隧道两端的 127.0.0.1，
  走代理等于绕回本机。手机上的 node 18 没有这层栈，只有直连或镜像（`android/README.md`）。

## 二、组件级字段

```jsonc
{
  "name": "clutch-hello",            // 必填，唯一身份：安装目录名、检出目录名、表键，一个字符串
  "version": "0.1.0",                // 必填；安装版可携带内容摘要（0.2.0+<hex>）
  "interface": "cli",                // 必填："daemon" | "cli"（怎么被调用，见下节）
  "runs_on": "self",                 // 进程跑在谁的机器上："self"（默认）| "other"（预留）
  "subject": "workspace-fs",         // 服务谁的资源（见下），决定语句能否为某工作区运行
  "launch": {                        // 宿主如何**启动**一个进程（工件的形状，不是接口）
    "argv": ["{py}", "{script}"],    // argv 词模板；{py} 解释器、{dir} 组件目录、{name} 组件名、{script} 入口文件
    "entry": "tool.py",              // 入口文件（相对组件目录，填进 {script}）
    "binary": "",                    // 安装版内自带的可执行文件名，存在则取代整个模板（PyInstaller onefile 用）
    "importable": false              // true = 以 `-m 包名` 驱动，组件目录须进 PYTHONPATH
  },
  "discovery_env": "",               // daemon 专用：重指发现目录的环境变量名
  "app_dir": "",                     // daemon 专用：发现记录所在目录（%LOCALAPPDATA% / ~/. 下）
  "prefix": "",                      // daemon 专用：发现记录文件名前缀
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
系统——该机器上必须有工作区根才能为它服务）、`foreign-fs`（别的机器的文件系统，
预留）、`project-file`（.clc 项目文件）、`network`（网络）、`skill-library`（技能库）。

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

## 三、两种接口

**daemon**：每个工作区一个常驻进程，loopback HTTP。宿主按发现记录（`app_dir` 下
`<prefix><digest>.json`，`discovery_env` 可重指）找到它，没有就按 `launch` 拉起。
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

**cli**：一次调用一个进程。宿主按 `launch` 渲染出**前缀**（检出 = `{py} {script}`；
安装版若有 `binary` 或与组件同名的可执行文件，前缀就是它本身），组件的 `command`
只是可执行文件之后的旗标——同一份声明同时驱动检出与安装版：

```
"command": "--envelope save --title {title} --content {content}"
```

## 四、工具级字段

```jsonc
{
  "name": "read_file",               // 工具名（模型可见的唯一名）
  "description": "……",               // 必须是字符串；模型面向，可携带宿主事实占位符（第五节）
  "parameters": {                    // JSON Schema（properties + required）
    "properties": { "path": { "type": "string" } },
    "required": ["path"]
  },
  "command": "…",                    // 语句模板（第三节）；没有 command 的声明不会成为工具（宿主自己那条除外，第十一节）
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

**schema 占位符**（声明是数据，宿主接线时把只有自己知道的事实填进去）：

- `$config.<字段>` —— 配置字段值。整值引用保持原类型（`"defaults": {"max_chars":
  "$config.read_max_chars"}` 接线后是整数）；句中引用拼成文字。
- `$skills` —— 本机技能名列表，**由声明 `facts` 的组件发布**（见下）；整值引用成为
  enum，句中引用拼成逗号列表。
- `$backends` —— 本机已配置的搜索后端链（未配置的服务不存在，无名字）。

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

- **只有 `cli` 组件可以发布**。daemon 的语句是说给"某个工作区的那个服务"的，而宿主
  事实不属于任何工作区；这样的声明在 `catalog.component_diagnostics` 里是 fatal。
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
一份只带安装事实的薄 manifest（name/version/interface/digest/artifact）会骑在检出
声明之上——interface 换成安装版的，工具与 launch 原样保留；第三方组件没有前置声明，
就整体进入。

**不可用的组件不提供工具，也没有替身**：`registry.build_tools` 对缺席组件贡献零
schema（提示词片段同理，`registry._drivable` 是同一道筛选），客户端用
`unavailable_reason()` 向用户解释（声明 `ui.status: true` 的才解释，其余安静缺席）。**停用**
走的是同一道门、同一条解释路径：字节能读、声明完整，只是这台机器决定不驱动它（第八节末）。

## 八、安装、卸载与停用/启用的 wire 协议

组件属于**要运行它的那台机器**。客户端让那台机器的 supervisor 把工件装上（字节怎么到
见下「字节怎么到」），也让那台机器把组件交出来、说停不停——**同一个门，三个方向**：

```
POST   /api/components/install
  X-Clutch-Component: <base64(UTF-8 JSON)>   声明 + 安装事实（发布态可带 `artifact_url`）
  body: <工件字节流>  |  空 body + manifest 的 `artifact_url`（目标机自己取）
GET    /api/components                        该机器已装清单（name/version/interface/digest/disabled）
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
  + 内容摘要**（`0.1.0+<hex16>`，宿主 `_VERSION_RE` 一直认这个形状，见第 81 行）。摘要
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
  来源清单里读到 `declaration` 的位置，取回后验摘要）+ 安装事实覆盖。检出态是同一件
  事的本地形态：直接读仓库旁的 `component.json`。发布包因此**不含任何一个组件的字节**
  ——声明随 manifest 走，一个 tar（或 onefile）+ 旁边一份 `component.json` 即完整组件；
  往哪台机器装、装哪个版本，由来源清单和模块自己的 release 决定（第一节末）。
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

已知边界（PLUGIN_PLAN.md §七 6）：来源清单点名**磁盘**上的清单时，工件也解析成本地
路径，而宿主只取 http(s)——磁盘镜像的安装今天会失败（清单照样读得懂）。`upload()`
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
  `tests/tools_inst_test.py`（每个工具的命令契约）。

## 十、第三方组件示例

代码在 `~/work/hello`，声明放进 `~/.clutch/components/catalog.d/hello.json`：

```json
{
  "name": "clutch-hello",
  "interface": "cli",
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
