# SSH_WORKSPACE_PLAN.md（`ssh-workspace`：别的机器的文件系统）

状态：**已实施**。主体在 `clutch-ssh-workspace/`（它的 README 是规格现文），C9.1–C9.4 落地，
C9.5 只走第一阶段（不起远侧 daemon，因此组件内部没有那道围栏）。本文件是设计记录与拍板依据，
每一拍都带验收，第六节是怎么跑。

临时措施 `scripts/ws-stopgap` **仍在**：C9.1 要重打包才生效，而那条判据（§六 最后一条的真机
端到端）还没跑过，所以它按 §2.4 自己写的条件退场。

## 一、缺口：一句话与三重断点

一句话：在 ssh 工作区里 `run_command` 能用，`read_file` / `grep` / `write_file` /
`edit_file` 不能用。原因不是这四个工具没实现，而是**为它们服务的那个组件只肯服务自己这台
机器**，而真正服务别人这台机器的组件从来没人写——那条降级路径没有被删掉，而是被**搬出去**变成
一个独立组件，位置一直空着。三处证据现在都已闭合：

1. **没有体** → `clutch-ssh-workspace/` 就是那个体（`interface: plugin` + `runs_on: other`）；
   `catalog.FOREIGN_FS`（第五个 subject 词）与 `COMPONENTS.md` 的 `foreign-fs` 段落是它的位置。
2. **体够不到执行通道** → C9.1 把执行桥地址写进插件的 fork env。
3. **表面没有"按机器选"的规则** → C9.4 的两条对称规则：`workspace-fs` 要求根在本机、
   `foreign-fs` 要求根不在本机，同名工具不再靠顺序定胜负。

## 二、今天的临时措施（已执行，可删）

### 2.1 为什么"修好当前会话"只能修一半

门（`prompt.module_blocked_reason`）、工具表（`registry.build_tools`）、守护进程的发现与启动
（`rendezvous.service` / `_record_dir` / `_start`）全都跑在**宿主进程**里，而宿主是打包后的冻结
构建（`ui/electron-builder.yml` 只发 `agent-server.exe` 与 `agent-supervisor.exe`），远侧只有
sshd 和这份检出。所以任何宿主侧改法都要**重打包**才生效——在会话内部改仓库代码，改的是"下次
运行这份代码"的行为。

### 2.2 组件本身是好的，缺的只是调用方

`clutch-workspace` 在**这台机器**（工作区根所在机器）上装着，也在这份检出里，而它的 CLI 是
每工作区 daemon 的瘦客户端（`clutch_workspace/client.py` 首段：daemon IS the CLI execution
engine，没有 in-process fallback）。所以下面这条已经是可用的执行器，读写都走 daemon：

    scripts/ws-stopgap read_file --path agent/tools/prompt.py --offset 100 --limit 20
    scripts/ws-stopgap --json grep --pattern FOREIGN_FS --include *.py
    scripts/ws-stopgap write_file --path notes.md --content -   # stdin，绕开命令长度上限
    scripts/ws-stopgap edit_file --path X --old-string A --new-string B

它包装的是 `PYTHONPATH=clutch-workspace python3 -m clutch_workspace --json <tool> …`，实测覆盖
四个工具：`read_file` 带行号与续读提示、`grep` 的行号命中、`write_file` 与 `edit_file` 的
unified diff。一个值得记住的坑：`python3 -m clutch_workspace.cli` **不是**入口（`cli.py` 没有
`__main__` 保护，`-m` 会静默退出 0，看起来像"成功但没有输出"）；入口是
`python3 -m clutch_workspace`。

### 2.3 它是什么、不是什么

- 是：同一个执行器、同一批工具名、同一套参数、同一份 `{content, error, diff}` 输出；与宿主
  将要发的语句是同一个协议（`curl` 到 daemon），差别只在调用方是这条命令而不是宿主。
- 不是：不是产品的一部分，没有宿主代码调用它；也**没有 `--protect` 围栏**（CLI 没有这个开关，
  围栏是宿主 spawn daemon 时下发的策略），所以它写文件时只有那台机器自己的权限。
- 模型看到的不是名为 `read_file` 的工具，而是通过 `run_command` 发出的一条命令。

### 2.4 删除条件

`ssh-workspace` 落地、并且当前窗口在 ssh 会话里能**直接**调用 `read_file` 之后：一条提交删掉
`scripts/ws-stopgap` 与本节，本文件改为指向 `COMPONENTS.md` 的 `foreign-fs` 段落。

## 三、组件形态（实施前先冻结的部分）

    {
      "name": "clutch-ssh-workspace",   // 名字见 §五 Q1
      "version": "0.1.0",
      "interface": "plugin",
      "runs_on": "other",
      "subject": "foreign-fs",
      "entry": "index.js",
      "ui": { "label": "workspace files (over ssh)" },
      "tools": ["read_file", "grep", "write_file", "edit_file"]   // 声明里是完整 schema
    }

- `plugin` 强制 `runs_on: other`：`catalog.component_diagnostics` 把 `interface: plugin` 配
  `runs_on: self` 判成致命诊断（同一处还禁止声明 `launch`）——这是唯一一种"宿主看不见实现"的
  接口，说"它在这里跑"就是一句没有实现支撑的话。
- 落点因此不用选：`ui/components.js#destinationOf` 对 `plugin` + `other` 给出 `PLACE_CLIENT`，
  装进客户端域（`%LOCALAPPDATA%/clutch/client` 或 `~/.clutch/client`），`ui/components-view.js`
  一个字都不用改。
- ABI：`exports.call = async (tool, args) => string | {content, error?}`（`ui/plugin-child.js`
  首段），一次调用 fork 一个子进程；工具清单来自声明的 `tools`，不是运行时导出。
- 工具名沿用 `read_file` / `grep` / `write_file` / `edit_file`，不加 `ssh_` 前缀：模型对这四个
  名字的用法已经写在系统提示词里，改名等于在提示词里写两套。

## 四、执行计划（C9 系列，每一拍自带验收）

### C9.1 把执行桥接给插件（唯一一处宿主侧改动）

- fork env 里加一项 `CLUTCH_EXEC_BRIDGE`，值取 `tunnelStatus().execBridge`
  （`ui/tunnel-lifecycle.js` 已经在算这个地址）：没有隧道时是空串，插件据此知道"此刻没有桥"，
  而不是去猜或者超时（`ui/plugin-host.js`）。
- 授权要如实写：桥是**没有令牌的 loopback**（`ui/exec-bridge.js` 只有 `POST /exec`），拿到这个
  地址就等于拿到远侧任意 shell。插件本来就是用户亲手装的受信代码（`ui/plugin-child.js` 首段：
  this is NOT a privilege fence，the child has the app uid），所以这不是新增授权，但必须写进声明
  与安装文案，别让装它的人以为它只是个读文件的工具。
- 同一处还给预算：`createPluginHost({ execLimits })` 把 `CLUTCH_EXEC_MAX_COMMAND_BYTES` /
  `CLUTCH_EXEC_CHUNK_BYTES` 写进 fork env（只在是正的有限数时才写），数值来自
  `ui/transport_defaults.json`，也就是会话自己的 exec 路径已经在用的那份（C9.3）；宿主什么都不
  说时插件回落到 4000 / 2000。
- 验收：`tests/plugin-host.test.js` 断言子进程 env 带着桥地址；无隧道时该值为空串且 `call()`
  仍按原样失败（不是挂住）。

### C9.2 第一根柱子：`read_file`

- `index.js` 只做四件事：把 `(tool, args)` 翻成远侧一条 `sh -c` 行；经 `POST /exec` 发出去；
  解析 `{code, stdout, stderr}`；回 `{content, error}`。
- 远侧那一行用**组件自己的 CLI**（`python3 -m clutch_workspace --json <tool> …`），所以这一拍
  不重写任何文件系统逻辑：行号、续读提示、diff、`(no matches)`、退出码全部由组件自己保证——
  文件系统那半永远在远侧，客户端只做参数翻译。
- 每次调用做一次远侧定位（可以和命令合并成一条 `sh -c`）：`<root>/clutch-workspace` 检出优先，
  否则 `~/.clutch/components/clutch-workspace/*/`；解释器默认 `python3`，可用
  `CLUTCH_SSH_PYTHON` 覆盖。定位失败就说这一句，不要退回本机。
- 验收：`tests/ssh-workspace.test.js` 用一个假桥（本地 http 服务记录收到的命令行并回放 fixture）
  断言四个工具传过去的 argv 形状、`--json` 信封的透传，以及错误映射（远侧 66 / 74 → `error: true`
  的句子）。无 ssh、无网络、无真 fork。

### C9.3 大载荷：stdin 与分块

- 桥只收一条命令字符串，**没有 stdin 通道**；命令长度上限在 `agent/tools/workspace.py` 的
  `_EXEC_MAX_COMMAND_BYTES`（`agent/transport_defaults.json` 里是 6000 字节，实测约 6.5 KB 开始
  报 command too long）。
- **不用 heredoc**（落地时的修正）：`<<EOF` 会在正文尾部补一个换行，于是"写进去的字节"与"模型
  给的字节"不再逐字相等，而这套工具的全部价值就在这里。改成：正文在客户端 base64，远侧一条命令
  里 `base64 -d` 到 `"$HOME/.clutch-ssh-workspace"/p-<token>.payload`，再用 `--content -` 读它，
  同一条命令删掉它。
- 超过一屏的正文按 `RemoteWorkspace.write` 的既有做法分块：`mkdir -p … && : > p-<tok>.b64`，
  若干次 `printf %s <base64 片段> >> …`，`base64 -d`，最后 `--content -`。分块阈值沿用
  `_EXEC_CHUNK_BYTES`（同一份 defaults，经 `CLUTCH_EXEC_MAX_COMMAND_BYTES` /
  `CLUTCH_EXEC_CHUNK_BYTES` 下发，见 C9.1），不要在插件里另立一个数。
- `edit_file` 是两个载荷，而两个 stdin 旗标会读同一条流两次，所以按"谁装得下"依次退化：两个都
  内联 → `--old-string -` → `--new-string -` → 都装不下就说一句诚实的拒绝，不猜。
- 验收：64 KB 文件写读回环字节相等；一个切在 UTF-8 多字节中间的 `--limit` 读不产生乱码（对照
  `tests/rendezvous_test.py` 钉住的字节对齐规矩）。

### C9.4 表面：谁在场由"根在哪台机器"决定（已按 (b) 落地，见 Q2）

当时是两个选项：(a) 同名替换，靠 `catalog.table()` 的"命名即覆盖"折叠，代价是一个名字挂两个体、
且本地会话必须不推这份声明；(b) 两个名字 + 一条按 subject 的对称规则。**落地是 (b)，而且两半都
做了，不只靠折叠顺序**：

- 宿主侧：`rendezvous.serves_foreign_fs()` 出现，`prompt.module_blocked_reason()` 因此成为对称的
  两句，`TODO(ssh-workspace)` 退场。`registry.build_tools(config, memories, workspace)` 收下工作区，
  `_serves_this_workspace()` 按"声明的 subject 要求哪台机器"筛：本地根**不含** `foreign-fs` 的工具
  （留着会让后折叠的插件盖掉本机能用的 `read_file`），ssh 根**保留** `workspace-fs` 的名字——那
  正是"插件没装"时该说的拒绝，插件在场时同名工具靠折叠在后获胜。
- 客户端侧：`ui/plugin-link.js snapshot()` 在 `state.client` 为空时丢掉 `foreign-fs` 的声明
  （`start()` 置上、`stop()` / `hopLost()` 清掉）；`ui/main.js announcePlugins` 本来就只在
  `backendKind(winId) === "tunnel"` 时动作，这一层是"记住的 base 遇上刚断的 hop"的兜底。
- 钉住它的测试：`tests/channel_test.py` 的 `check_the_machine_a_component_serves()`、
  `tests/plugin-link.test.js` 第 11 节（隧道活着才推，`hopLost()` 立刻收回而本地插件仍在）。

### C9.5 围栏：`--protect` 跟不跟过去

- 今天远侧 daemon 的围栏是宿主在 spawn 时下发的（`rendezvous.py` 首段：the fence IS spawn-time
  policy），而 CLI 的懒启动**不带**围栏。插件若在远侧自己起 daemon，就得自己带 `--protect`，
  可围栏表只有宿主会算（`rendezvous.fence_globs`）。
- C9 第一阶段：不起 daemon，走 CLI（无围栏）。宿主侧的 `guard_read` / `guard_write` 仍在，缺的是
  "组件内部那道围栏"，与 `scripts/ws-stopgap` 一样，写清楚即可。
- 要围栏时的两条路（二选一，见 Q3）：把 `/call` 的 body 从 `{component, tool, args}` 扩成
  `{component, tool, args, fence}`（契约在 `agent/tools/channel.py`，这是唯一一处会动契约的改动，
  要单独一拍板）；或者把"起 daemon"留在宿主侧——把 `rendezvous.service` 改成经 `workspace.run`
  在远侧发现/启动 daemon。后者不碰 `/call`，但要重打包，而且和插件的职责重叠，本轮不推荐先做。
- **落地**：走的是第一阶段，插件 README 有一节把"远侧没有 fence"写在明处，这一拍没有代码改动。

## 五、已拍板（四条）

- **Q1 名字**：目录 `clutch-ssh-workspace/`，声明名 `clutch-ssh-workspace`。`workspace-fs` 那个体
  仍叫 `clutch-workspace`，两个名字各自服务一台机器——这是 Q2 (b) 的必然结果，不是笔误。
- **Q2 表面规则**：两个名字 + 一条按 subject 的对称规则（(b)）。`prompt.module_blocked_reason`
  的两句都按"根在哪台机器"判；`registry.build_tools(config, memories, workspace)` 再按同一事实
  筛一遍；客户端只在隧道活着时推这份声明。这条巧合由 `tests/channel_test.py` 钉住。
- **Q3 daemon 在哪起**：第一阶段都不起，走 CLI（一次调用一个子进程）。远侧没有 daemon，于是没有
  组件内部的围栏——`--protect` 不跟过去，这条缺口与 `ws-stopgap` 一样由 README 写明。
- **Q4 桥要不要成为一个设施词**：不加。`catalog.FACILITIES` 仍是三个词；插件在调用时自己报
  "no exec bridge"（`clutch-ssh-workspace/index.js` 的 `NO_BRIDGE`），宿主侧的
  `rendezvous.unavailable_reason` 不需要认识它。

## 六、验证（每一拍的跑法）

- 宿主侧 Python：`.venv/bin/python -m tests.catalog_test`、`.venv/bin/python -m tests.channel_test`、
  `.venv/bin/python -m tests.rendezvous_test`（这一套钉着本地 daemon 的字节对齐，C9.5 的 S1 路线
  只要动 `service()` 就会碰到它）。
- 客户端 Node：`node tests/plugin-host.test.js`、`node tests/plugin-link.test.js`、
  `node tests/plugin-server.test.js`、`node tests/client-plugin-websearch.test.js`、
  `node tests/components.test.js`。一次只跑一个，不要把所有 test 文件串成一条命令。
- 新增：`node tests/ssh-workspace.test.js`（假桥 + argv 断言）与 `node tests/ssh-workspace-e2e.js`
  （真组件：把 `python -m clutch_workspace --json` 当作远侧，锚的安装器与 `/call` 都是真的，只有
  ssh 那一跳被本地 `POST /exec` 替换）。后者不进 `tests/*test*.js` 清单：要 python 解释器和
  `clutch-workspace` checkout，与 `tests/remote-bootstrap-e2e.js` 同一个理由；没有这两样时它自己
  打印 skip 并退出 0。
- **真机端到端**（临时措施退场的判据）：装上插件 → 建隧道 → 会话里 `read_file VERSION` 的结果
  必须与远侧组件自己的答案逐字相同（`python -m clutch_workspace --json read_file --path VERSION`
  的 `content`）；同一模式的 `grep` 命中数相同；`write_file` 的 diff 相同。
  **不要拿 `scripts/ws-stopgap` 当参照**：那是一个会 print 的 CLI，它给 stdout 补了一个文件本来
  没有的换行（`VERSION` 盘上就没有结尾换行），而且 diff 在 envelope 的另一个字段里，stdout
  根本看不到。用它做参照会"发现"两个并不存在的 bug（2026-10-20 由 `tests/ssh-workspace-e2e.js`
  纠正）。

## 七、风险

- **重打包**：C9.1 改的是 `ui/plugin-host.js`，冻结宿主不重打包就不生效（与 2.1 同一个理由）。
  这是整个计划唯一无法在远侧验证的一步。
- **一次调用一个子进程**：没有跨调用的缓存可用，于是每次调用都会多一次远侧定位（`sh -c` 里几次
  stat/ls）。这是 ABI 选的（可杀、不阻塞窗口），代价写在这里，不要靠全局状态绕。
- **桥等于远侧任意 shell**：与"插件是受信代码"一致，但必须让装它的人知道。
- **工作区根换机器**：探测与记录都以根为键，换根等于换目录，不需要迁移逻辑。
- **插件没装**：会话里的 `read_file` 仍然是被拒绝的那一句（`prompt.module_blocked_reason`），
  这比"悄悄用一个可能过时的本机实现"要好，保持它。

## 八、明确不做的事

- 不改 `ui/components-view.js` 的 `bridged()`：降级会话里装不了 daemon 是 C7 明确留着的缺口，
  与本组件无关（它装在客户端）。
- 不复活宿主侧的 `read_file` / `grep` 实现：`f4060bf` 删掉它们是对的，`tests/rendezvous_test.py`
  钉住的字节对齐是组件的责任。
- 不动 `clutch-websearch` 子模块（用户的工作区里还有未提交改动）。
- 不在本计划里给 `ssh-workspace` 加 `list_dir` / `stat` 之类的新工具：先把四个老名字接上。
