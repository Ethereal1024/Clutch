# 组件规范（COMPONENTS.md）

Clutch 宿主**零内置工具**：`run_command` 之外的一切工具都来自**组件**（component）——
一个独立发布的工件（本仓库的四个子模块 `clutch-workspace` / `clutch-memory` /
`clutch-websearch` / `clutch-skills`，或任何第三方的同类物）。宿主不为任何组件保留
第二份实现，也不内置任何组件的声明；它只做两件事：**发现**声明、把声明接进循环。

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
| 用户注册 | `~/.clutch/components/catalog.d/*.json` | 圈外逃生门：代码在别处（任意目录、本地构建的二进制），一份 JSON 即注册 |

目录可分别用环境变量重指：安装根 `CLUTCH_COMPONENTS_DIR`，注册目录
`CLUTCH_COMPONENTS_CATALOG`（测试与特殊布局用）。

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
工具自己的 `description` 已经说明了它怎么用。

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
  "command": "…",                    // 语句模板（第三节）；没有 command 的声明不会成为工具
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
`command`）来判定一次调用能碰什么——组件后来才装上，也自动落进同一套策略。

## 五、语句模板与宿主事实

**语句占位符**（`inst.render`，fail-closed）：

- `{参数名}` —— 模型参数，POSIX 单词引号包裹；
- `{*}` —— 全部参数合成一个引号包裹的 JSON 对象（daemon 的请求体即它）；
- 宿主值：daemon 语句可用 `{port}` `{token}` `{pid}`——**只是发现记录里的事实**，
  协议词汇由语句自己写（见第三节的 `-H 'X-Clutch-Token: {token}'` 惯用法）；
  cli 语句可用组件 `vars` 点名的宿主事实，已发布的两种：`host.port_url`（.clc 内容
  服务）、`config.skills_dir`（技能库根）；
- `[ --flag {x} ]` —— 可选组：组内占位符填不上时整组（连旗标）消失，绝不留半截旗标。

宿主值遮蔽同名模型参数，模型参数劫持不了宿主占位符。

**schema 占位符**（声明是数据，宿主接线时把只有自己知道的事实填进去）：

- `$config.<字段>` —— 配置字段值。整值引用保持原类型（`"defaults": {"max_chars":
  "$config.read_max_chars"}` 接线后是整数）；句中引用拼成文字。
- `$skills` —— 本机技能名列表；整值引用成为 enum，句中引用拼成逗号列表。
- `$backends` —— 本机已配置的搜索后端链（未配置的服务不存在，无名字）。

接线后 schema 里不应残留任何 `$` 占位符。

## 六、UI 协议

宿主渲染的不是自己设计的工具事件，所以"事件长什么样"是声明的一部分；`ui/app.js`
里没有任何工具名。每个工具事件都携带它的 `ui` 块（回放同构渲染，后装的组件无需改
界面就能被渲染）。键全部可选，缺省即素净外观（`catalog.DEFAULTS`）：

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
`unavailable_reason()` 向用户解释（声明 `ui.status: true` 的才解释，其余安静缺席）。

## 八、安装 wire 协议

组件属于**要运行它的那台机器**。客户端把工件装到那台机器的 supervisor：

```
POST /api/components/install
  X-Clutch-Component: <base64(UTF-8 JSON)>   声明 + 安装事实
  body: <工件字节流>
GET /api/components                            该机器已装清单（name/version/interface/digest）
```

头的值必须是 base64——HTTP 头是 ByteString（每个码点 ≤ 0xFF），而声明按设计就是
组件自己的语言（中文照写），裸 JSON 过不去。解码在宿主端只有一处：
`components.manifest_from_header`。

要点：

- **版本门是内容**：manifest 携带工件 sha256（`digest`），安装版本号即摘要前缀。
  同版本不同字节 = 重建过 = 必须重装；同版本同摘要 = 什么都不传。
- **宿主先验字节**：落地前先对收到的字节算摘要，不符即拒绝（错误即数据，400）。
- **工件两种形状**（按后缀识别）：`.tar.gz` / `.tgz` / `.tar` / `.zip` 解包进组件
  目录（成员点名组件根之外的东西 → 整体拒绝）；其余当单个可执行文件，以组件名落地
  并加 +x。
- **原子落地**：先写进同级 `<version>.installing`，完成后整体改名；同组件其它版本
  全部清掉——一台机器只跑一个版本，装层决不让解析器挑到旧版。
- **声明合并（宿主端兜底）**：解包后若工件自带 `component.json`，安装记录 = 工件
  自带声明 + 请求 manifest（后者点名的字段覆盖）。所以**薄 header 也能落地一个完整
  组件**；自带声明若点名了**别的**组件，安装被拒——字节不是请求所说的那个组件。
- 客户端发送（`ui/components.js`）：manifest = 组件自己的 `component.json`（从
  `resources/components/<name>/component.json` → `dist/components/<name>/` → 检出
  目录依次找）+ 安装事实覆盖。发布包因此**不需要含组件代码**：声明随 manifest 走，
  onefile 工件 + 旁边一份 `component.json` 即完整组件。

## 九、开发工作流

- **改声明**：编辑子模块里的 `component.json`，重启宿主即生效（检出自注册，无需
  安装）。schema 描述、UI 块、语句模板的改动走这条路径。
- **改实现**：宿主不 import 组件代码；接口（HTTP 表面 / stdout 契约）不变，两边
  各自迭代。组件有自己的测试套件（`cd clutch-<x> && python3 -m pytest`）。
- **造工件**：dev tar 由 `scripts/build-component-tar.sh` 生成（成员在 tar 顶层，
  排除 VCS/venv/缓存；`component.json` 在内），客户端按源码指纹缓存在
  `~/.clutch/artifacts`。发布工件是 PyInstaller onefile，旁放同名目录下的
  `component.json`（打包位置：`<resources>/components/<name>/component.json`，
  CI 打包步骤负责放入）。
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
