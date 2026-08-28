# SSH 兜底服务器：退化层设计计划

> 本文件是**新会话的单一入口**：动机、技术契约、继承式架构、实施顺序、边界情况全部在此。
> 新会话开始：读本文件 → `git log --oneline` 看最近提交 → 从 §5 的 P1 开始。

---

## 0. 现状代码地图（改动手册）

仓库根：`/home/fanshu/Workplace/Clutch/clutch`。HEAD 提交（P3 完成）。

### Python 后端（`agent/`，本地 server 默认 8890）

| 文件 | 角色 | 关键符号 |
|------|------|---------|
| `base.py` | **（新）** 服务器基类 | `Broadcaster`、`RunState`（`backend_mode/bridge_url/remote_root` + `build_workspace`）、`BaseServer`（`build_llm/build_tools/build_workspace(abstract)/start_task`） |
| `server.py` | HTTP+SSE 服务器 | `HttpAgentServer(BaseServer)`、`Handler`（经 `self.server.app`）、`ClutchServer`、`build()` 工厂、`_run/_sse/_fs_list/_fs_list_remote/_workspace_tree/_walk/_walk_remote/_backend` |
| `loop.py` | agent 循环 | `Agent`、`_emit`、`run`、`_execute_tool` |
| `tools/workspace.py` | 工作区抽象 | `Workspace` ABC（root/protect/is_protected/visible_entries/resolve/run/read/write/list/append_line）+ `LocalWorkspace` + `RemoteWorkspace`（tool→sh：cat/heredoc/ls）+ `shq` |
| `tools/filesystem.py` | 文件工具 | `read_file/write_file/list_dir/_unified_diff`（经 `workspace.read/write/list`） |
| `tools/shell.py` | 命令工具 | `run_command`（path-guard + blocked + `workspace.run` + _syntax_check） |
| `tools/registry.py` | 工具注册 | `Tool`、`build_default_tools`、`ToolRegistry.execute` |
| `project.py` | .clc 文件 | `open_project/read_header/_read_file/_rewrite_durable/create_project`（可传 workspace → 远端读写/追加/压缩） |
| `events.py` | 事件/日志 | `Event` 基类+10 子类、`EventLog.append`（可选 `writer(path,line)` → 远端追加） |
| `llm/client.py` | LLM | `LlmClient` ABC（`stream` 协议）+ `DeepSeekLlmClient`、`LlmError` |
| `core/terminate.py` | 终止/验证 | `Terminator.verify`→`run_verify`（`workspace.run`） |
| `core/permission.py` | 权限 | `PermissionEvaluator/Gate/Rule` |
| `core/context.py` | 上下文派生 | `_to_messages`（只读 block 事件，不依赖 delta） |
| `config.py` | 配置 | `Config`（含 `command_timeout/truncate/blocked_prefixes`） |
| `tools/transport.py` | 传输层 | `CommandResult`/`TransportError`（`timeout` 标志）/`Transport` ABC/`LocalTransport`/`SshTransport`（urllib→exec bridge） |
| `tools/transport_test.py` | 传输自检 | inline mock bridge 走通 heredoc/ls/cd/timeout（无需 ssh2） |

### Node / Electron（`ui/`）

| 文件 | 角色 | 关键符号 |
|------|------|---------|
| `ssh-tunnel.js` | ssh2 隧道 | `remoteExec(command, timeoutMs)`、`connectTunnel`（顺带起 exec bridge）、`stopTunnel`、`uploadFile/uploadFileViaExec/checkExec`、`getSftp`、`tunnelStatus`（含 `execBridge`）、`onTunnelEnd` |
| `exec-bridge.js` | **（新）** | `startExecBridge`/`stopExecBridge`；`POST /exec {command,timeout}` → `{code,stdout,stderr}`；无隧道 503 |
| `main.js` | Electron 主进程 | ipcMain handle（tunnel:connect/assist/status/disconnect/ended） |
| `preload.js` | 渲染桥 | `clutchTunnel`（connect/assist/status/disconnect/onEnd/onProgress） |
| `app.js` | 渲染器 | `DEFAULT_BASE(8890)`、`API_BASE`、`switchBackend/refreshPicker`、`connectSSE`、`reconciledBackendUrl`、`handleSshConnect`、`setFsConnecting/Error`、`updateConnProgress`、`loadDir/openFsBrowser` |
| `dev.sh` | 本地起服 | `.venv/bin/python -m agent.server`（8890） |
| `exec-bridge.js` | **（新）** | 本地 HTTP，暴露 `remoteExec` 给 Python |

### 测试 / eval
- `agent/selfcheck.py`、`agent/loop_test.py`、`agent/server_test.py`（用 `build(config,broadcaster,state)` 起服）。
- `eval/harness.py`：**直接**构造 `Workspace()/LlmClient/Agent/ToolRegistry(build_default_tools)`（P3 要吸收进 `BaseServer`）。

---

## 1. 动机

### 1.1 问题：极端环境无法 bootstrap

当前架构要求远端运行完整 Python `agent.server`（bundle / pylibs / LLM 引导安装）。对
`Linux/mips/musl、无 python3、无 SFTP 子系统、无 base64` 的嵌入式设备（OpenWrt 类路由器），
bootstrap 全链路失败：

- bundle：PyInstaller 只能编构建机架构（x86_64），出不了 MIPS；
- pylibs：需要目标上有 python3，该设备没有；
- assist：需要 staging 上传源码（走 SFTP → `exit-status 127`；exec+base64 → `base64: not found`），
  且即便成功，也要在 MIPS/musl 上从零装 python，基本无望。

日志证据（`~/.clutch/tunnel.log`，dev-only 含明文密码，分享时打码）：`probe os=Linux arch=mips
libc=musl py=none` → `needsAssist` → `stageSource` 每文件先 `subsystem: sftp`(127) 再
`echo | base64 -d`(127) → 通道风暴打垮设备 sshd → `Unable to exec`。

### 1.2 第一性原理

agent 对环境的全部影响能力 = **4 个工具**（`read_file`/`write_file`/`list_dir`/`run_command`），
全部等价于 **sh 命令 + 文件读写**。因此**只要远端能执行 sh（任何 sshd 都满足），agent 就能实际
影响该环境**。远端跑 Python server 并非必要——它只是把状态（.clc）、工具、LLM 调用搬到远端
的一种设计。

### 1.3 决策（已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| 降级触发 | **自动降级**：bootstrap 失败/硬拒绝 → 自动切 SSH-tools | 用户无感知；主流主机仍走 server 模型 |
| .clc 位置 | **远端 .clc** | 保留"代码旁"语义、可版本化、选择器流程零改动；代价是每 durable 事件一次 SSH 追加 |
| 服务器位置 | **本地 server + SSH transport** | 客户端本就有 LLM 与 agent 循环；远端只需 sh |
| 架构形式 | **继承式抽象**：Transport/Workspace、BaseServer、LlmClient 三层基类 | 稳定统一 LLM 访问与工具接口 |

### 1.4 与主流 server 模型的关系
- **主流主机**（有 python/SFTP）：维持现有 server 模型。
- **极端主机**：退化层（本地 server + SSH 工具）。LAN 整体开销约 5–10%。
- 二者共享 `BaseServer` 契约与工具接口，LLM 无感。

---

## 2. 总体架构

```
本地 server (Python, 8890)               Node / Electron                    远端
┌────────────────────────────┐    ┌─────────────────────────────┐
│ BaseServer (HttpAgentServer)│    │ ssh2 隧道 (ssh-tunnel.js)    │
│  ├─ build_llm()  LlmClient │    │  ├─ remoteExec()            │
│  ├─ build_tools() Registry │    │  └─ exec bridge (动态端口)   │
│  ├─ build_workspace()      │───▶│        POST /exec           │──exec──▶ 远端 sh
│  │    LocalWorkspace  ─────┤    │                             │
│  │    RemoteWorkspace ─────┼───▶│  (SshTransport 经 HTTP 调用) │
│  └─ start_task() Agent     │    │                             │
│  .clc / 事件日志 (读写经 ws) │    └─────────────────────────────┘
└────────────────────────────┘
```

关键点：
- **LLM 无感**：工具 schema 与执行入口（`ToolRegistry.execute`）不变。
- **工具无 `if remote` 分支**：本地/远端差异收敛到 `Workspace` 子类。
- **远端零要求**：只需能跑 sh 的 sshd。

---

## 3. 技术细节

### 3.1 exec bridge（Node，新文件 `ui/exec-bridge.js`）

仿 `ui/llm-proxy.js` 的 `startLlmProxy/stopLlmProxy` 模式：

```js
// 导出
async function startExecBridge() -> number   // 返回已监听端口
function stopExecBridge()
```

- 本地 HTTP server，绑 `127.0.0.1`，端口用现有 `freePort()` 动态分配（避免冲突）。
- 端点：
  ```
  POST /exec  body {command:string, timeout?:number}   // timeout 毫秒，默认 60000
  200 → {code:number, stdout:string, stderr:string}
  503 → {error:"no active tunnel"}    // 隧道未连接时
  500 → {error:string}                // remoteExec 抛错
  ```
- 内部直接调 `ssh-tunnel.js` 的 `remoteExec(command, timeout)`。
- 接线：`connectTunnel` 里与 `startLlmProxy()` 一起启动；`stopTunnel` 里 `stopExecBridge()`。
- 暴露给渲染器：`tunnelStatus()` 返回对象增加 `execBridge: "http://127.0.0.1:<port>"`（无隧道时 null）。
  `main.js` 的 `tunnel:status` IPC 与 `preload.js` 的 `clutchTunnel.status` 自动带出。
- **隧道断开后桥必须立刻拒绝 exec**（agent 运行中不应挂在一个死桥上）。

### 3.2 SshTransport（Python，新 `agent/tools/transport.py`）

```python
class CommandResult(NamedTuple):
    code: int; stdout: str; stderr: str

class TransportError(RuntimeError): ...

class Transport(ABC):
    @abstractmethod
    def run(self, command: str, timeout: float) -> CommandResult: ...

class LocalTransport(Transport):
    # subprocess.run(command, shell=True, cwd=root, capture_output=True, text=True, timeout=...)
    # 现 shell.run_command 的 subprocess 部分迁入；root 在构造时传入

class SshTransport(Transport):
    def __init__(self, bridge_url: str): ...
    def run(self, command, timeout) -> CommandResult:
        # urllib.request POST bridge_url+"/exec", json.dumps({command, timeout*1000})
        # 请求超时 = timeout + 5s 缓冲；非 200 → TransportError；解析 {code,stdout,stderr}
        # stdout/stderr 用 errors="replace" 解码，防怪 locale
```

**只用 stdlib `urllib.request`**，不引入 requests 依赖。Python 侧 Transport 只暴露 `run`（
read/write/list 由 `RemoteWorkspace` 转译为 sh 后经 `run` 执行，见 3.3）。

### 3.3 RemoteWorkspace 的 tool→sh 映射

```python
# agent/tools/workspace.py（改造为基类 + 子类）
class Workspace(ABC):
    def __init__(self, root: str, transport: Transport, protected: set[str] = frozenset()): ...
    def resolve(self, rel: str) -> str:          # 基类：normpath + 逃逸防护（ValueError）
    def is_protected(self, path: str) -> bool: ...   # 基类：归一化字符串比对
    def protect(self, path: str) -> None: ...
    def visible_entries(self, path: str) -> list[str]: ...  # 基类：visible_entries = list 过滤 protected
    def run(self, command, timeout) -> CommandResult: ...   # 委托 self.transport.run

    @abstractmethod
    def read(self, path: str) -> str: ...        # 缺文件 → raise FileNotFoundError
    @abstractmethod
    def write(self, path: str, content: str) -> None: ...
    @abstractmethod
    def list(self, path: str) -> list[str]: ...  # 缺目录 → raise NotADirectoryError

class LocalWorkspace(Workspace):   # read=Path.read_text(errors=replace); write=write_text; list=iterdir
class RemoteWorkspace(Workspace):  # tool→sh 转译
```

`RemoteWorkspace` 内各方法（`shq()` 单引号转义路径：`'` → `'\''`）：

| 方法 | sh 命令（经 `self.transport.run`） |
|------|------|
| `run(command, timeout)` | `cd '<root>' && <command>`（LocalWorkspace.run 用 subprocess cwd=root，语义一致） |
| `read(path)` | `cat '<abs>'`；`code!=0` → `FileNotFoundError(path)`；stdout 即内容 |
| `write(path, content)` | 先 `cat '<abs>'`（`code==0` 取旧内容，否则视为新文件）；再单条 heredoc：`cat > '<abs>' <<'<uniq>'\n<body>\n<uniq>`；`code!=0` → 抛错 |
| `list(path)` | `ls -1AF '<abs>'`；`code!=0` → `NotADirectoryError(path)`；解析行尾 `/` 为目录（`name/`），剥 `*`/`@` |

要点：
- **cwd 语义**：远端每条 exec 都是新 shell，`run_command` 必须 `cd '<root>' &&`；read/write/list
  全用绝对路径，不依赖 cwd。
- **缺文件/缺目录语义**：不额外 `test -f`（省一次 exec），直接用 `cat`/`ls` 的退出码判定，
  工具层把 `FileNotFoundError`/`NotADirectoryError` 格式化为现有报错文案。
- **write heredoc 细节**（与 Node `uploadFileViaExec` 同思路）：
  - 定界符唯一：`CLUTCH_EOF_<time_ns()>`（Python）或 `<Date.now().toString(36)>`（Node）。
  - 引号定界符 `<<'<uniq>'` 下内容全字面（`$`/反引号/引号都安全），不依赖 base64。
  - **尾部换行**：content 若以 `\n` 结尾，先剥掉一个，让 heredoc 自带的换行补回 → 逐字节一致
    （实测含 `$VAR`/反引号/单双引号/tab 的文件 round-trip 一致；无尾换行的文本会多一个 `\n`，
    对源码无害，注释说明）。
  - 文本无需分块（heredoc 走 shell stdin，不走 argv，无 ARG_MAX 问题）；若有 null 字节
    （不应出现在 write_file 的模型文本里）则回退 base64 分块。
- **binary read**：`cat` 输出按 `errors="replace"` 解码，与本地 `read_text(errors="replace")` 一致。

### 3.4 工具层改道（P1 核心）

工具签名不变（`(workspace, config, **args)`），内部环境访问全走 workspace：

| 工具 | 现在 | 改后 |
|------|------|------|
| `filesystem.read_file` | resolve/is_protected/`p.is_file()`/`p.read_text`/`p.stat` | resolve/is_protected/`workspace.read`（捕获 FileNotFoundError）+ `config.truncate` |
| `filesystem.write_file` | resolve/is_protected/读旧/`p.parent.mkdir`/`p.write_text`/diff | resolve/is_protected/`workspace.read`(旧, 可缺)/`workspace.write`/diff；`mkdir -p` 由 write 实现保证 |
| `filesystem.list_dir` | resolve/`p.is_dir`/`workspace.visible_entries` | resolve/`workspace.list`（缺目录 → 报错文案不变） |
| `shell.run_command` | path-guard 分词 + blocked + subprocess | path-guard/blocked 保留（字符串级，本地远端通用）；执行改 `workspace.run(command, config.command_timeout)`；`_syntax_check` 改 `workspace.read` |

- `_unified_diff`、`config.truncate`、摘要生成等 transport 无关逻辑**留在工具层不动**。
- LocalWorkspace 必须与现状**逐字节等价**（diff/截断/路径防护输出不变）——P1 验收即所有测试全绿。

### 3.5 远端 .clc

- **EventLog.append**（events.py:158）加可选 writer：
  ```python
  EventLog(path, writer=None)
  # writer: Callable[[str, str], None]  # (path, line) 追加一行
  # 默认 None → open(path,"a")（本地现状）
  # 远端 → workspace.append_line(path, line)，实现为单条引号 heredoc：
  #   cat >> '<clc>' <<'<uniq>'\n<json 行>\n<uniq>
  ```
  不用 `echo`（JSON 含单引号会炸）；不用 base64（极端设备没有）。
- **project.py** 的 IO 全部经传入的 workspace：
  - `open_project(path, on_progress=None, workspace=None)`：workspace 提供时用 `workspace.read`
    拉回再解析；`_read_file` 的进度按拉取字节算。
  - `read_header` 同理（workspace 提供时）。
  - `_rewrite_durable`（压缩重写）：workspace 提供时 → `workspace.write('<clc>.tmp', 压缩内容)`
    + `transport.run("mv -f '<clc>.tmp' '<clc>'")`（原子替换语义不变）。
- **顺序注意**：`_open_stream_start` 现在先 `read_header`/`open_project` 再 `set_project`。
  远端模式需要先用 `/api/backend` 里的 bridge 构造 `RemoteWorkspace(project.workdir, ...)`
  **再**传给 open_project —— 调整该函数：先算 workspace（`BaseServer.build_workspace`），
  再打开 .clc。
- 保护语义：`workspace.protect(远端 .clc 路径)` 字符串归一化比对，read/write/run_command 的
  guard 都走 `is_protected`，照常生效。

### 3.6 `/api/backend` + RunState

```python
# RunState 新增字段（锁内读写）
backend_mode: str = "local"          # "local" | "ssh"
bridge_url: str | None = None
remote_root: str | None = None       # 初始浏览根（远端 home）

# 新端点（Handler.do_POST）
POST /api/backend {mode:"ssh", bridge:"http://127.0.0.1:<p>", workspace:"/root"} → {status:"ok"}
POST /api/backend {mode:"local"} → {status:"ok"}
```

- `BaseServer.build_workspace(project)`：
  ```python
  if state.backend_mode == "ssh" and state.bridge_url:
      return RemoteWorkspace(str(project.workdir), SshTransport(state.bridge_url))
  return LocalWorkspace(str(project.workdir))
  ```
- `_fs_list`：ssh 模式下走 `transport.run("ls ...")`/`RemoteWorkspace.list` 列出远端（起点为
  `state.remote_root`）；否则现状。
- `_workspace_tree`：ssh 模式用 `RemoteWorkspace.list` 实现懒加载（expanded/lookahead 逻辑复用
  `_walk`，只是叶子换成 transport 的 list）。**列为 P2 延伸**：MVP 可先只显示根的一层 ls。
- 断开隧道 → renderer 发 `{mode:"local"}` 复位（随现有 `onEnd`/`switchBackend(DEFAULT_BASE)` 一起）。

### 3.7 其他 transport 化（审计项落地）

- `run_verify`（core/terminate.py:64）：裸 `subprocess cwd=workspace.root` →
  `workspace.run(command, config.command_timeout)`（verify_command 为空时本就 pass-through，无影响）。
- `_syntax_check`（shell.py:111）：`path.read_text` → `workspace.read`。
- `_fs_list`/`_workspace_tree`：见 3.6。

### 3.8 性能与健壮性

| 关注点 | 数值/行为 |
|--------|----------|
| 工具调用开销 | 本地 3–10ms；SSH LAN 5–30ms；WAN +50–100ms。被 LLM 秒级延迟淹没，整体 +5–10% |
| `.clc` 追加 | 每 durable 事件一次 SSH 往返（LAN ~10ms；WAN 每任务 +4–12s）。逐条写最稳；不批量（避免崩溃丢缓冲） |
| LLM 少一跳 | 远端模型经反向转发绕回客户端；本地模型直连，更快 |
| 隧道中断 | 运行中 `.clc` 追加失败会报错（本地 .clc 无此故障模式）。退化层可接受；可选缓冲追加缓解 |
| 大文件写 | heredoc 单命令走 shell stdin，无 argv 上限；无需分块 |
| 超时 | `config.command_timeout`(30s) → bridge timeout；SSH exec 超时杀通道，远端已 fork 的后台进程可能残留（与本地 subprocess 超时行为类似，可接受） |

---

## 4. 基于继承关系的架构调整

### 4.1 A 层：`Transport` + `Workspace`（退化层主梁）

见 §3.2/§3.3 的类图。要点：工具无 `if remote` 分支；tool→sh 集中在 `RemoteWorkspace`；
path-guard/blocked/truncate/diff 留在工具层。

### 4.2 B 层：服务器基类 `BaseServer`（统一 LLM 访问 + 工具接口 + run 编排）✅

```python
# agent/base.py（已实现）
class BaseServer(ABC):
    def __init__(self, config: Config, broadcaster: Broadcaster, state: RunState): ...
    def build_llm(self) -> LlmClient: ...        # DeepSeekLlmClient；无 key 抛 RuntimeError
    def build_tools(self) -> ToolRegistry: ...
    @abstractmethod
    def build_workspace(self, project: Project) -> Workspace: ...
    def start_task(self, task, project, on_ask, cancel=None, config=None) -> Agent | None: ...
        # build_workspace + protect + build_llm（在 state.start 之前，坏 key 不粘 busy）
        # + state.start（busy → None）+ gate + Agent(...)，返回 Agent 由调用方运行
```

- `Broadcaster`/`RunState` 也移入 `base.py`（避免 base↔server 循环导入）。
- **线程编排留在 server 侧**：`Handler._run` 调 `start_task` 后起 worker 线程（finally
  `state.finish`）并组 JSON 响应；`start_task` 本身同步返回 Agent —— 这样 harness 也能
  同步 `agent.run(task)`，一个方法服务两个调用方。
- `build()` 工厂（server.py）→ 构造 `HttpAgentServer` 挂到 `ClutchServer.app`；
  `Handler._cfg/_state/_broadcaster` 经 `self.server.app` 取；`server_test.py` 的
  `build(config,...)` 调用不变。
- **吸收 eval/harness**：`eval/harness.py` 新增 `HarnessServer(BaseServer)`，`build_workspace`
  返回 `LocalWorkspace(str(project.workdir))`；场景在临时目录 seed 后用
  `Project(path=root/"harness.clc")` + `start_task(task, project, on_ask=None)` 装配，
  同步 `agent.run(task)`，事件从 `project.log` 取。无参→临时目录语义改为 harness 侧
  `tempfile.TemporaryDirectory()` + 显式根（`LocalWorkspace` 仍保留无参回退）。

### 4.3 C 层：`LlmClient` ABC ✅

```python
# agent/llm/client.py（已实现）
class LlmClient(ABC):
    @abstractmethod
    def stream(self, messages, tools=None) -> Iterator[dict]:
        """事件协议: reasoning/text/tool_call_start/tool_call_delta/finish"""
class DeepSeekLlmClient(LlmClient):   # 现实现；_classify/重试保留
```

`loop.py` 与 `BaseServer` 只依赖 `stream()`，协议用 ABC + docstring 固化。

### 4.4 全项目继承审计

| 位置 | 现状 | 建议 | 价值 |
|------|------|------|------|
| `events.py` | `Event` 基类 + 10 子类 | 已是继承，不动 | — |
| **tools 执行** | 自由函数 + 未来 `if remote` | 走 `Workspace` 基类方法（4.1） | 高 |
| **`run_verify`** (core/terminate.py:64) | 裸 `subprocess cwd=workspace.root` | 走 `workspace.run()` | 高 |
| **`_fs_list` / `_workspace_tree`** | 直接 Path/iterdir | 走 `RemoteWorkspace.list`/transport | 中 |
| **`LlmClient`** | 单一实现 | 提 ABC + 事件协议（4.3） | 中 |
| **服务器壳** | `Handler/ClutchServer/RunState` 平铺 | 提 `BaseServer`（4.2） | 中 |
| `_syntax_check` (shell.py) | 读本地文件 | 走 `workspace.read`（随 4.1） | 中 |
| `Tool`/`Project`/`Config`/`Terminator`/`Permission` | 单实现、声明式 | **不做抽象**（YAGNI） | — |
| Node 侧 (ssh-tunnel/assist/proxy) | 过程式模块 | 可提 `Tunnel` 类，工作量大、非 Python | 低/可选 |

### 4.5 与自动降级流程的整合

1. 连接 → bootstrap 尝试 → **硬拒绝/失败**（installServer 已加 `ok:false` 分支，返回清晰错误）。
2. 渲染器收到 `{ok:false, ...}`（非 needsAssist）→ 触发降级：
   `window.clutchTunnel.status()` 取 `execBridge` URL。
3. `POST /api/backend {mode:"ssh", bridge, workspace:"<远端 home>"}`（DEFAULT_BASE=8890）。
4. `switchBackend(DEFAULT_BASE)` + `refreshPicker()`：选择器改走本地 server 的
   `_fs_list`（内部经 transport `ls`）浏览远端，选远端 `.clc`。
5. `BaseServer.start_task` 用 `RemoteWorkspace` 跑 agent；工具/验证/.clc 全走桥。
6. 断开 → `POST /api/backend {mode:"local"}` 复位（随 `onEnd`/connSelect 一起）。

---

## 5. 实施顺序（每阶段一次提交，可回退）

| 阶段 | 内容 | 验收命令 | 状态 |
|------|------|---------|------|
| **P1 — A 层纯重构** | `transport.py`（Transport/LocalTransport）+ `Workspace` 基类/`LocalWorkspace` + 工具改道；本地行为逐字节不变 | `uv run python -m agent.selfcheck && uv run python -m agent.loop_test && uv run python -m agent.server_test && node --check ui/app.js ui/ssh-tunnel.js` | ✅ `2525e99` |
| **P2 — 退化层集成** | `ui/exec-bridge.js` + `SshTransport` + `RemoteWorkspace`(tool→sh) + `/api/backend` + 远端 .clc（EventLog writer/project.py）+ `run_verify`/`_syntax_check`/`_fs_list` transport 化 | 用 mock bridge 或真实无 python 主机走通：浏览远端、打开远端 .clc、跑一个任务 | ✅ `c59e744` |
| **P3 — B/C 层重构** | `agent/base.py`（BaseServer/HttpAgentServer）+ `LlmClient` ABC + 吸收 `eval/harness.py`；纯重构 | 同上测试全绿；eval 结果与重构前一致 | ✅ 见 P3 提交 |
| **P4 — 自动降级接线** | `main.js/preload.js` 暴露 `execBridge`；app.js 失败→降级→复位 | 主流主机行为不变；极端主机自动降级可走通 | ⬜ |

P1 子步骤：
1. `agent/tools/transport.py`：`CommandResult`/`TransportError`/`Transport` ABC/`LocalTransport`。
2. `workspace.py`：`Workspace` ABC + `LocalWorkspace`（`read/write/list/run/visible_entries`，
   Path 实现）；保留 `Workspace()` 无参→临时目录语义（harness 依赖）。
3. `filesystem.py`/`shell.py` 改走 workspace 方法；`_syntax_check`/`run_verify` 改走
   `workspace.read/run`。
4. 全量测试 + `eval/harness.py` 冒烟。

P2 子步骤：
1. `ui/exec-bridge.js`（start/stop/`/exec`）+ 接线 `connectTunnel/stopTunnel` + `tunnelStatus.execBridge`。
2. `agent/tools/transport.py`：`SshTransport`（urllib）。
3. `workspace.py`：`RemoteWorkspace`（tool→sh + heredoc）。
4. `server.py`：`/api/backend` + RunState 字段 + `_fs_list` transport 分支。
5. `project.py`/`events.py`：EventLog writer + open_project workspace 参数 + 远端压缩。
6. `core/terminate.py` run_verify、`_fs_list`、`_workspace_tree` transport 化。

P3 子步骤：`agent/base.py` + `server.py` 改造 + `llm/client.py` ABC + `eval/harness.py` 吸收。

P4 子步骤：`main.js/preload.js`（execBridge）+ `app.js`（降级/复位流程）。

---

## 6. 验证要点

- P1：本地 transport 与原 subprocess 输出逐字节一致（diff/截断/路径防护文案不变）。
- P2：heredoc 追加 round-trip（单引号/`$`/反引号内容逐字节一致）；远端 .clc 打开/追加/压缩；
  `run_verify` 经桥；picker/tree 经桥；隧道断开后桥返回 503。
- P3：`eval/harness.py` 改用 `BaseServer` 后与现 eval 一致；`server_test` 的 `build()` 调用不变。
- P4：`CLUTCH_TUNNEL_FORCE` 或 mock bridge 模拟 bootstrap 失败 → 自动降级 → 复位。

---

## 7. 边界情况与注意事项

1. **cwd 语义**：远端 exec 每次都是新 shell，`run_command` 必须 `cd '<root>' &&`；read/write/list
   用绝对路径。LocalWorkspace 用 `subprocess cwd=root` 对齐。
2. **符号链接**：`ls -1AF` 对 symlink 显示 `@`，无法判断目标是目录；本地 `list_dir` 会跟随
   symlink 判 `/`。轻微不一致，可接受（或在 RemoteWorkspace.list 里对 `@` 项再发一次
   `test -d`——默认不做，省 exec）。
3. **输出截断**：`config.truncate` 客户端做，大输出经桥返回后在客户端截断，桥响应大小受
   `output_limit` 天然约束。
4. **安全边界不弱于本地**：path-guard 分词、protected 检查、blocked_prefixes 全部保留（字符串级，
   本地/远端通用）。但远端执行与本地同样有 `rm -rf .` 这类语义缺口（guard 只拒逃逸+受保护文件），
   非本层新增风险。
5. **隧道断开**：桥 503，agent 的 `.clc` 追加或工具调用会报错——运行终止，可接受。
6. **二进制 read**：`cat` + `errors="replace"`，与本地一致；write_file 的模型文本不应含 null 字节，
   若出现回退 base64。
7. **并发**：单 run（RunState.busy），`.clc` 追加只在 agent 线程，无并发写。
8. **exec bridge 端口**：动态 `freePort()`，经 `tunnelStatus.execBridge` 暴露；不用固定端口。
9. **LLM 反向转发**：退化层远端不调 LLM，`startLlmProxy`/反向 forward 对该模式非必需（留着无害）。
10. **`Workspace()` 无参语义**：eval/harness 依赖"无参→临时目录"，P1 必须保留（LocalWorkspace
    无根时回退 `tempfile.mkdtemp`）。

---

## 8. 仓库现状与新会话入口

- git root：`/home/fanshu/Workplace/Clutch/clutch`；HEAD（P3 完成）。
- 回滚分支：`pre-refactor-rollback` @ `6e52ca7`。
- 测试：`uv run python -m agent.selfcheck` / `agent.loop_test` / `agent.server_test`；
  `uv run ruff check .` / `uv run ruff format --check .`；`node --check ui/*.js`；`bash -n ui/dev.sh`。
- 隧道日志：`~/.clutch/tunnel.log`（dev-only，含明文密码，分享/提交前必须打码）。
- 本地后端：`npm run dev`（dev.sh）起 `.venv/bin/python -m agent.server` @ 8890；dev.sh 会先清理
  8890 上的陈旧进程。
- **新会话入口**：读本文件 → `git log --oneline -20` → 从 §5 的**下一个未完成阶段**开始。每阶段一次提交，可用
  `git diff` 复核，异常回退到 `pre-refactor-rollback`。
