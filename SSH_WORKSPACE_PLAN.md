# SSH_WORKSPACE_PLAN.md（`ssh-workspace`：别的机器的文件系统）

状态：**未动工**。本文件是下一步的施工计划。临时措施已经落地（`scripts/ws-stopgap`，
见第二节），它的删除条件写在第五节。

## 一、缺口：一句话与三重断点

一句话：在 ssh 工作区里 `run_command` 能用，`read_file` / `grep` / `write_file` /
`edit_file` 不能用。原因不是这四个工具没实现，而是**为它们服务的那个组件只肯服务自己这台
机器**，而真正服务别人这台机器的组件从来没人写。

准确的说法（上一轮曾经说反过一次）：这条降级路径没有被删掉，也没有被"分离"处理，而是被
**搬出去**变成一个独立组件，而那个位置一直是空的。

三重断点，挂在同一份声明上：

1. **没有体**。仓库里既没有 `ssh-workspace/` 目录，也没有它的 `component.json` 或
   `index.js`。`grep -rn ssh-workspace` 全仓只有一处命中：`agent/tools/prompt.py:143`
   的 `TODO(ssh-workspace)`。设计记录散在四处，合起来是一份完整规格：
   - `agent/tools/catalog.py:144` `FOREIGN_FS = "foreign-fs"`，第五个 subject 词，与
     `WORKSPACE_FS` / `NETWORK` / `PROJECT_FILE` / `SKILL_LIB` 并列；
   - `COMPONENTS.md:171-173`：`foreign-fs` = 别的机器的文件系统，**预留**；
   - `agent/tools/rendezvous.py:306-315` `serves_workspace_fs` 的 docstring：a daemon
     serving a foreign filesystem over a channel it owns is a daemon too, and it is
     not this；
   - 同一文件首段：adds an ENTRY to the table, never a branch to a tool。
2. **体够不到执行通道**。`ui/plugin-host.js:569-576` 给 fork 出的子进程只传
   `CLUTCH_PLUGIN_DIR` / `CLUTCH_PLUGIN_ENTRY` / `CLUTCH_PLUGIN_NAME`（外加
   `process.env`）。能到达远侧 shell 的只有 `ui/exec-bridge.js`（`POST /exec` ->
   `remoteExec`，`:29` 取 `ssh-tunnel`），而它的端口只活在主进程：
   `ui/tunnel-core.js:41 execBridgePort`，由 `ui/tunnel-connect.js:94` 起、
   `ui/tunnel-lifecycle.js:141` 以 `execBridge` 之名交给会话子进程。插件看不到它。
3. **表面没有"按机器选"的规则**。`registry.build_tools()`（`agent/tools/registry.py:283-291`）
   把每个可驱动组件声明的工具都追加进来；`ToolRegistry.__init__`（`:342`）用
   `{t.name: t}` 收口，**同名后者胜**；`schemas()`（`:349`）只读这个 dict。而"根不在这台
   机器"的拒绝是**逐次调用**的（`registry.py:477-479`，句子在
   `prompt.module_blocked_reason:143-150`）。于是两份同名工具同时在场时，谁赢由顺序决定，
   而不由"这个组件服务谁的机器"决定。

## 二、今天的临时措施（已执行，可删）

### 2.1 为什么"修好当前会话"只能修一半
门（`prompt.module_blocked_reason`）、工具表（`registry.build_tools`）、守护进程的发现与启动
（`rendezvous.service:478`；记录目录 `_record_dir:633-645` 读本机 `LOCALAPPDATA` / `$HOME`；
`_start:814` 在本机 `Popen`）全都跑在**宿主进程**里，而宿主是打包后的冻结 Windows 构建
（`ui/electron-builder.yml:144-153` 只发 `agent-server.exe` 与 `agent-supervisor.exe`）。
远侧只有 sshd 和这份检出。所以在会话内部改仓库代码，改的是"下次运行这份代码"的行为，改不了
正在跑的那一份：任何宿主侧改法都要重打包才生效。

### 2.2 组件本身是好的，缺的只是调用方
`clutch-workspace` 在**这台机器**（工作区根所在机器）上装着
（`~/.clutch/components/clutch-workspace/0.1.0+e517d3d2e588b130`），也在这份检出里
（`clutch-workspace/`），而它的 CLI 是每工作区 daemon 的瘦客户端
（`clutch_workspace/client.py` 首段：daemon IS the CLI execution engine，没有 in-process
fallback）。所以下面这条已经是可用的执行器，读写都走 daemon：

    PYTHONPATH=clutch-workspace python3 -m clutch_workspace --workspace "$PWD" read_file --path VERSION

实测覆盖四个工具：`read_file` 带行号与续读提示、`grep` 的行号命中、`write_file` 与
`edit_file` 的 unified diff。包装成一条命令：

    scripts/ws-stopgap read_file --path agent/tools/prompt.py --offset 100 --limit 20
    scripts/ws-stopgap --json grep --pattern FOREIGN_FS --include *.py
    scripts/ws-stopgap write_file --path notes.md --content -   # stdin，绕开命令长度上限
    scripts/ws-stopgap edit_file --path X --old-string A --new-string B

一个值得记住的坑：`python3 -m clutch_workspace.cli` **不是**入口（`cli.py` 没有 `__main__`
保护，`-m` 会静默退出 0，看起来像"成功但没有输出"）。入口是 `python3 -m clutch_workspace`
（`clutch_workspace/__main__.py`）。

### 2.3 它是什么、不是什么
- 是：同一个执行器、同一批工具名、同一套参数、同一份 `{content, error, diff}` 输出；与宿主
  将来要发的语句是同一个协议（`curl` 到 daemon），差别只在调用方是这条命令而不是宿主。
- 不是：不是产品的一部分，没有宿主代码调用它；也**没有 `--protect` 围栏**（CLI 没有这个开关，
  围栏是宿主 spawn daemon 时下发的策略，见 `rendezvous.py` 首段），所以它写文件时只有那台机器
  自己的权限。
- 模型看到的不是名为 `read_file` 的工具，而是通过 `run_command` 发出的一条命令：提示词里
  用 read_file 那几句话仍要翻译成它。这就是第二重断点在会话内的形状（调用方缺席）。

### 2.4 删除条件
`ssh-workspace` 落地、并且当前窗口在 ssh 会话里能**直接**调用 `read_file` 之后：一条提交删掉
`scripts/ws-stopgap` 与本节，本文件改为指向 `COMPONENTS.md` 的 `foreign-fs` 段落。

## 三、组件形态（实施前先冻结的部分）

    {
      "name": "ssh-workspace",          // 名字见第五节 Q1
      "version": "0.1.0",
      "interface": "plugin",
      "runs_on": "other",
      "subject": "foreign-fs",
      "entry": "index.js",
      "ui": { "label": "workspace files (over ssh)" },
      "tools": ["read_file", "grep", "write_file", "edit_file"]
    }

- `plugin` 强制 `runs_on: other`：`catalog.component_diagnostics` 把 `interface: plugin`
  配 `runs_on: self` 判成致命诊断（同一处还禁止声明 `launch`）。理由在 `catalog.py:126-133`：
  这是唯一一种"宿主看不见实现"的接口，说"它在这里跑"就是一句没有实现支撑的话。
- 落点因此不用选：`ui/components.js:841-854 destinationOf` 对 `plugin` + `other` 给出
  `PLACE_CLIENT`，装进客户端域（`ui/plugin-host.js` 的根：`%LOCALAPPDATA%/clutch/client`
  或 `~/.clutch/client`）。这正是"服务别人机器的文件系统"的组件应该待的地方，`ui/components-view.js`
  一个字都不用改。
- ABI：`exports.call = async (tool, args) => string | {content, error?}`（`ui/plugin-child.js`
  首段），一次调用 fork 一个子进程；工具清单来自声明的 `tools`，不是运行时导出。
- 工具名沿用 `read_file` / `grep` / `write_file` / `edit_file`，不要加 `ssh_` 前缀：模型对这
  四个名字的用法已经写在系统提示词里，改名等于在提示词里写两套。

## 四、执行计划（C9 系列，每一拍自带验收）

### C9.1 把执行桥接给插件（唯一一处宿主侧改动）
- `ui/plugin-host.js:569-576` 的 fork env 里加一项 `CLUTCH_EXEC_BRIDGE`，值取
  `tunnelStatus().execBridge`（`ui/tunnel-lifecycle.js:141` 已经在算这个地址）：
  没有隧道时是空串，插件据此知道"此刻没有桥"，而不是去猜或者超时。
- 授权要如实写：桥是**没有令牌的 loopback**（`ui/exec-bridge.js` 只有 `POST /exec`），拿到
  这个地址就等于拿到远侧任意 shell。插件本来就是用户亲手装的受信代码
  （`ui/plugin-child.js` 首段：this is NOT a privilege fence，the child has the app uid），
  所以这不是新增授权，但必须写进声明与安装文案，别让装它的人以为它只是个读文件的工具。
- 验收：`tests/plugin-host.test.js` 里断言子进程 env 带着桥地址；无隧道时该值为空串且
  `call()` 仍按原样失败（不是挂住）。

### C9.2 第一根柱子：`read_file`
- `index.js` 只做四件事：把 `(tool, args)` 翻成远侧一条 `sh -c` 行；经 `POST /exec`
  发出去；解析 `{code, stdout, stderr}`；回 `{content, error}`。
- 远侧那一行用**组件自己的 CLI**（`python3 -m clutch_workspace --json <tool> ...`），所以
  这一拍不重写任何文件系统逻辑：行号、续读提示、diff、`(no matches)`、退出码全部由组件自己
  保证，也就顺带回答了"会不会变成第二份实现"——不会，文件系统那半永远在远侧，客户端只做参数
  翻译。
- 每次调用做一次远侧定位（可以和命令合并成一条 `sh -c`）：`<root>/clutch-workspace` 检出优先，
  否则 `~/.clutch/components/clutch-workspace/*/`；解释器默认 `python3`，可用
  `CLUTCH_SSH_PYTHON` 覆盖。定位失败就说这一句，不要退回本机。
- 验收：新增 `tests/ssh-workspace.test.js`，用一个假桥（本地 http 服务记录收到的命令行并回放
  fixture）断言四个工具传过去的 argv 形状、`--json` 信封的透传、以及错误映射（远侧 66 / 74
  -> `error: true` 的句子）。无 ssh、无网络、无真 fork。

### C9.3 大载荷：stdin 与分块
- 桥只收一条命令字符串，**没有 stdin 通道**；命令长度上限在 `agent/tools/workspace.py:481`
  `_EXEC_MAX_COMMAND_BYTES`（`agent/transport_defaults.json` 里是 6000 字节，实测约 6.5 KB
  开始报 command too long）。所以 `write_file` / `edit_file` 的内容走 heredoc：

      python3 -m clutch_workspace write_file --path P --content - <<CLUTCH_EOF
      ...正文...
      CLUTCH_EOF

- 超过一屏的正文按 `RemoteWorkspace.write` 的既有做法分块：`printf %s <base64 片段> >> tmp`
  若干次，`base64 -d tmp > payload`，最后 `--content - < payload`。分块阈值沿用
  `_EXEC_CHUNK_BYTES`（同一份 defaults），不要在插件里另立一个数。
- 验收：64 KB 文件写读回环字节相等；一个切在 UTF-8 多字节中间的 `--limit` 读不产生乱码
  （对照 `tests/rendezvous_test.py` 钉住的字节对齐规矩）。

### C9.4 表面：谁在场由"根在哪台机器"决定（未拍板，见 Q2）
两个选项，二选一：

- **(a) 同名替换**：`catalog.table()` 把客户端推来的声明折叠在最后并按名替换
  （`catalog.py:913-916`）。插件只要也叫 `clutch-workspace`，表里就没有第二份同名声明，
  `build_tools` 也就没有同名对抗——零新规则，靠的是既有的"命名即覆盖"。代价：一个名字挂两个
  体（`interface` 不同），而 `clutch-websearch` 的先例是两个名字（会话 CLI + 客户端
  `clutch-websearch-client`）；并且本地会话必须**不推**这份声明，否则本机能用的 `read_file`
  会被换成一个需要一个不存在的桥的版本。
- **(b) 两个名字 + 一条按 subject 的规则**（推荐）：`ssh-workspace` 独立存在，
  `prompt.module_blocked_reason:143-150` 的那个分支改成对称的两句——`workspace-fs` 的组件要求
  根在本机、`foreign-fs` 的组件要求根不在本机，两条都用 `isinstance(workspace, LocalWorkspace)`
  判，正好兑现 `TODO(ssh-workspace)` 与 `serves_workspace_fs` docstring 里"它就不是这个"那句。
  代价：表面仍会同时出现两份同名工具（`registry.py:283-291,342`），要么把 workspace 传进
  `build_tools` 让筛子按机器挑，要么就让"折叠在最后"让插件赢——后者必须由一条测试钉住，
  否则只是巧合。**本地会话不受影响的办法**：客户端只在隧道活着时推这份声明
  （`ui/plugin-link.js:128 snapshot()` 一处就知道 `state.sshClient`）。

### C9.5 围栏：`--protect` 跟不跟过去
- 今天远侧 daemon 的围栏是宿主在 spawn 时下发的（`rendezvous.py` 首段：the fence IS spawn-time
  policy），而 CLI 的懒启动**不带**围栏。插件若在远侧自己起 daemon，就得自己带 `--protect`，
  可围栏表只有宿主会算（`rendezvous.py:431 fence_globs`）。
- C9 第一阶段：不起 daemon，走 CLI（无围栏）。宿主侧的 `guard_read` / `guard_write` 仍在，
  缺的是"组件内部那道围栏"，与今天的 `scripts/ws-stopgap` 一样，写清楚即可。
- 要围栏时的两条路（二选一，见 Q3）：把 `/call` 的 body 从 `{component, tool, args}`
  扩成 `{component, tool, args, fence}`（契约在 `agent/tools/channel.py:36-40`，这是唯一一处
  会动契约的改动，要单独一拍板）；或者把"起 daemon"留在宿主侧，即 S1——把
  `rendezvous.service` 改成经 `workspace.run` 在远侧发现/启动 daemon（记录是
  `~/.clutch-workspace/d-<sha256(root)[:32]>.json`，语句本来就是 `runner=workspace`）。
  S1 不碰 `/call`，但要重打包，而且和插件的职责重叠，所以本轮不推荐先做。

## 五、待拍板（四条）

- **Q1 名字**。`ssh-workspace` 是四处注释里已经在用的词（`TODO(ssh-workspace)`），但目录约定
  是 `clutch-*`，而"一个能力两个体"的先例用两个名字（`clutch-websearch` +
  `clutch-websearch-client`）。建议：目录 `clutch-ssh-workspace/`，声明名 `clutch-ssh-workspace`；
  若选 Q2 的 (a)，则声明名必须是 `clutch-workspace`。
- **Q2 表面规则**：同名替换 (a) 还是两个名字 + subject 规则 (b)。建议 (b)。
- **Q3 daemon 在哪起**：插件在远侧起（要下发围栏），还是宿主按 S1 经 `workspace.run` 起
  （要重打包）。建议第一阶段都不做，CLI 已经够用。
- **Q4 桥要不要成为一个设施词**。`catalog.FACILITIES` 现在只有 `python` / `posix-shell` /
  `curl`，声明里写别的词会被 `_known(FACILITIES)` 判成致命诊断。要不要加一个
  `exec-bridge`，让 `rendezvous.unavailable_reason` 能替插件说"这台宿主没有到客户端的执行
  通道"？加了就得同时改 `COMPONENTS.md` 的设施表；不加就得让插件在调用时自己报 no bridge。

## 六、验证（每一拍的跑法）

- 宿主侧 Python：`.venv/bin/python -m tests.catalog_test`、`.venv/bin/python -m tests.channel_test`、
  `.venv/bin/python -m tests.rendezvous_test`（这一套钉着本地 daemon 的字节对齐，C9.5 的 S1 路线
  只要动 `service()` 就会碰到它）。
- 客户端 Node：`export PATH="/home/fanshu/.nvm/versions/node/v22.23.1/bin:$PATH"` 之后
  `node tests/plugin-host.test.js`、`node tests/plugin-link.test.js`、
  `node tests/plugin-server.test.js`、`node tests/client-plugin-websearch.test.js`、
  `node tests/components.test.js`。一次只跑一个，不要把所有 test 文件串成一条命令。
- 新增：`node tests/ssh-workspace.test.js`（假桥 + argv 断言）。
- 真机端到端：装上插件 -> 建隧道 -> 会话里 `read_file VERSION` 的结果必须与
  `scripts/ws-stopgap read_file --path VERSION` 逐字相同；同一模式的 `grep` 命中数相同；
  `write_file` 的 diff 相同。这一条是"临时措施退场"的判据。

## 七、风险

- **重打包**：C9.1 改的是 `ui/plugin-host.js`，冻结宿主不重打包就不生效（和 2.1 同一个理由）。
  这是整个计划唯一无法在远侧验证的一步。
- **一次调用一个子进程**：没有跨调用的缓存可用，于是每次调用都会多一次远侧定位（`sh -c`
  里几次 stat/ls）。这是 ABI 选的（可杀、不阻塞窗口），代价写在这里，不要靠全局状态绕。
- **桥等于远侧任意 shell**：与"插件是受信代码"一致，但必须让装它的人知道。
- **工作区根换机器**：探测与记录都以根为键，换根等于换目录，不需要迁移逻辑。
- **插件没装**：会话里的 `read_file` 仍然是被拒绝的那一句（`prompt.module_blocked_reason`），
  这比"悄悄用一个可能过时的本机实现"要好，保持它。

## 八、明确不做的事

- 不改 `ui/components-view.js` 的 `bridged()`：降级会话里装不了 daemon 是 C7 明确留着的缺口，
  与本组件无关（它装在客户端）。
- 不复活宿主侧的 `read_file` / `grep` 实现：`f4060bf` 删掉它们是对的，
  `tests/rendezvous_test.py` 钉住的字节对齐是组件的责任。
- 不动 `clutch-websearch` 子模块（用户的工作区里还有未提交改动）。
- 不在本计划里给 `ssh-workspace` 加 `list_dir` / `stat` 之类的新工具：先把四个老名字接上，
  新增工具是另一拍板。
