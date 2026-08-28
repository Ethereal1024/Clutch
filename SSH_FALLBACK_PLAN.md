# SSH 兜底服务器：退化层设计计划

## 1. 动机

### 1.1 问题：极端环境无法 bootstrap

当前架构要求远端运行一个完整的 Python `agent.server`（bundle / pylibs / LLM 引导安装）。对
`Linux/mips/musl、无 python3、无 SFTP 子系统、无 base64` 的嵌入式设备（OpenWrt 类路由器），
bootstrap 全链路失败：

- bundle：PyInstaller 只能编构建机架构（x86_64），出不了 MIPS；
- pylibs：需要目标上有 python3，该设备没有；
- assist：需要 staging 上传源码（走 SFTP → `exit-status 127`；exec+base64 → `base64: not found`），
  且即便成功，也要在 MIPS/musl 上从零装 python，基本无望。

日志证据（`~/.clutch/tunnel.log`）：`probe os=Linux arch=mips libc=musl py=none` →
`needsAssist` → `stageSource` 每个文件先 `subsystem: sftp`(127) 再 `echo | base64 -d`(127) →
通道风暴把设备 sshd 打垮 → `Unable to exec`。

### 1.2 第一性原理

agent 对环境的全部影响能力 = **4 个工具**（`read_file` / `write_file` / `list_dir` /
`run_command`），它们全部等价于 **sh 命令 + 文件读写**：

| 工具 | 等价能力 |
|------|---------|
| `run_command` | 一条 shell 命令 |
| `read_file` / `write_file` | `cat` / heredoc 写入 |
| `list_dir` | `ls` |

因此：**只要远端能执行 sh（任何 sshd 都满足），agent 就能实际影响该环境。** 远端跑一个
Python server 并非必要——它只是把状态（.clc）、工具、LLM 调用搬到远端的一种设计。

### 1.3 决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 降级触发 | **自动降级**：bootstrap 失败/硬拒绝 → 自动切 SSH-tools 模式 | 用户无感知；主流主机仍走 server 模型 |
| .clc 位置 | **远端 .clc**（代码旁、可版本化、选择器流程零改动） | 保留核心语义；代价是每次追加一次 SSH 往返（见 3.5） |
| 服务器位置 | **本地 server + SSH transport** | 客户端本就持有 LLM 与 agent 循环；远端只需 sh |
| 架构形式 | **继承式抽象**：Transport/Workspace、BaseServer、LlmClient 三层基类 | 稳定统一 LLM 访问与工具接口（见第 4 章） |

### 1.4 与主流 server 模型的关系

- **主流主机**（有 python/SFTP）：维持现有 server 模型（状态就地、低延迟、富 API）。
- **极端主机**（无法 bootstrap）：走退化层（本地 server + SSH 工具）。LAN 上整体开销约 5–10%
  （每次工具调用多几十 ms，被 LLM 秒级延迟淹没）。
- 二者共享同一套 `BaseServer` 契约与工具接口，LLM 无感。

---

## 2. 总体架构

```
本地 server (Python, 8890)               Node / Electron                    远端
┌────────────────────────────┐    ┌─────────────────────────────┐
│ BaseServer (HttpAgentServer)│    │ ssh2 隧道 (ssh-tunnel.js)    │
│  ├─ build_llm()  LlmClient │    │  ├─ remoteExec()            │
│  ├─ build_tools() Registry │    │  └─ exec bridge (8894)      │
│  ├─ build_workspace()      │───▶│        POST /exec           │──exec──▶ 远端 sh
│  │    LocalWorkspace  ─────┤    │                             │
│  │    RemoteWorkspace ─────┼───▶│  (SshTransport 经 HTTP 调用) │
│  └─ start_task() Agent     │    │                             │
│  .clc / 事件日志 (读写经 ws) │    └─────────────────────────────┘
└────────────────────────────┘
```

关键点：
- **LLM 无感**：工具 schema 与执行入口（`ToolRegistry.execute`）完全不变。
- **工具无 `if remote` 分支**：本地/远端差异收敛到 `Workspace` 子类（第 4 章 A 层）。
- **远端零要求**：只需一个能跑 sh 的 sshd。

---

## 3. 技术细节

### 3.1 exec bridge（Node，新文件 `ui/exec-bridge.js`）

本地 HTTP 服务器 `127.0.0.1:8894`，把隧道已有的 `remoteExec`（`ui/ssh-tunnel.js`）暴露给本地
Python server：

```
POST /exec {command, timeout} → {code, stdout, stderr}
```

- 随隧道启停；无连接/无隧道时返回错误（HTTP 503 + 原因）。
- 只绑 `127.0.0.1`，与现有 `/api/fs/list` 的"no auth"一致。
- 超时透传 `remoteExec` 的 `timeoutMs`。

### 3.2 tool→sh 映射（集中在 `RemoteWorkspace` 方法内）

| 工具 | 本地（现状） | 远端 sh 映射 |
|------|-------------|-------------|
| `run_command` | subprocess `cwd=root` | `cd '<root>' && <cmd>` |
| `read_file` | `open()` | `cat '<abs>'` + 客户端截断 |
| `write_file` | 读旧→写→diff | 先 `cat '<abs>'` 取旧内容算 diff，再 heredoc `cat > '<abs>' <<'<uniq>'...` |
| `list_dir` | `os.listdir` | `ls -1AF '<abs>'` 解析（`/` 后缀判目录） |

辅助：
- `shq()`：单引号转义远端路径/命令（`'` → `'\''`）。
- heredoc 用唯一定界符（`CLUTCH_EOF_<timestamp>`），引号定界符下内容全字面（含 `$`/反引号/引号），
  不依赖 base64。
- python 语法预检（`shell.py._syntax_check`）：经 `workspace.read` 取回内容后客户端 `compile()`。
- 超时透传 `config.command_timeout`。
- 二进制文件仍走 base64 分块（`uploadFileViaExec` 既有逻辑）。

### 3.3 远端 .clc

- `project.py` 的 IO 全部经 `workspace.read/write`：
  - `open_project` / `_read_file`：`cat '<clc>'` 拉回 → 客户端解析；进度按拉取字节算。
  - `read_header`：同一次 `cat` 取头部。
  - 压缩重写（`_rewrite_durable`）：heredoc 上传到 `<clc>.tmp` → `mv`（两次 exec，原子替换语义不变）。
- `events.py` `EventLog.append`：每条 durable 事件一次**引号 heredoc 追加**：
  ```
  cat >> '<clc>' <<'<uniq>'
  <json 行>
  <uniq>
  ```
  （不用 `echo`——JSON 内容含单引号会炸；不用 base64——极端设备没有。）
- 保护语义：`workspace.protect(远端 .clc 路径)` 字符串归一化比对，照常生效。

### 3.4 `/api/backend`（本地 server 新增）

```
POST /api/backend {mode:"ssh", bridge:"http://127.0.0.1:8894", workspace:"/root"} → {status:"ok"}
POST /api/backend {mode:"local"} → {status:"ok"}
```

- 存 `RunState`；`BaseServer.build_workspace(project)` 据此返回 `RemoteWorkspace` 或 `LocalWorkspace`。
- 断开隧道 → renderer 发 `{mode:"local"}` 复位。

### 3.5 性能与健壮性

| 关注点 | 数值/行为 |
|--------|----------|
| 工具调用开销 | 本地 3–10ms；SSH LAN 5–30ms；WAN +50–100ms。被 LLM 秒级延迟淹没，整体 +5–10% |
| `.clc` 追加 | 每 durable 事件一次 SSH 往返（LAN ~10ms；WAN 每任务 +4–12s）。逐条写最稳；不批量（避免崩溃丢缓冲） |
| LLM 少一跳 | 远端模型经反向转发绕回客户端；本地模型直连，更快 |
| 隧道中断 | 运行中 `.clc` 追加失败会报错（本地 .clc 无此故障模式）。退化层可接受；可选缓冲追加缓解 |
| 大文件写 | heredoc 单命令；超大文件分块（复用 `uploadFileViaExec` 的分块模式） |

---

## 4. 基于继承关系的架构调整

### 4.1 A 层：环境抽象 `Transport` + `Workspace`（退化层主梁）

```python
# agent/tools/transport.py (新)
class CommandResult(NamedTuple):
    code: int; stdout: str; stderr: str

class Transport(ABC):
    @abstractmethod
    def run(self, command: str, timeout: float) -> CommandResult: ...
    def upload(self, local_path: str, remote_path: str) -> None: ...   # 默认 SFTP/exec 兜底

class LocalTransport(Transport):      # subprocess.run(cwd=...)，现 shell.run_command 逻辑迁入
class SshTransport(Transport):        # HTTP POST → exec bridge；upload 复用 uploadFileViaExec

# agent/tools/workspace.py（改造）
class Workspace(ABC):                 # 统一环境访问
    def __init__(self, root, transport: Transport, protected=set()): ...
    def resolve(self, rel) -> str: ...        # 基类：Path/字符串 normpath + 逃逸防护
    def is_protected(self, path) -> bool: ...
    def protect(self, path) -> None: ...
    def run(self, command, timeout) -> CommandResult: ...   # 委托 self.transport.run
    @abstractmethod
    def read(self, path) -> str: ...
    @abstractmethod
    def write(self, path, content) -> None: ...
    @abstractmethod
    def list(self, path) -> list[str]: ...

class LocalWorkspace(Workspace):      # Path 实现（现 filesystem.py 逻辑迁入）
class RemoteWorkspace(Workspace):     # tool→sh 转译（3.2 映射表）
```

**工具改道**：`filesystem.py` / `shell.py` 的工具全部改走 `workspace.read/write/list/run`，
不再出现 `if remote` 分支；diff/截断/摘要等 transport 无关逻辑保留在工具层。`_syntax_check`
走 `workspace.read`。

### 4.2 B 层：服务器基类 `BaseServer`（统一 LLM 访问 + 工具接口 + run 编排）

```python
# agent/base.py (新)
class BaseServer(ABC):
    def __init__(self, config, broadcaster, state): ...
    def build_llm(self) -> LlmClient: ...                      # 统一 LLM 构造
    def build_tools(self) -> ToolRegistry: ...                 # 统一工具注册
    @abstractmethod
    def build_workspace(self, project) -> Workspace: ...       # transport-aware
    def start_task(self, task, project, on_ask, cancel) -> Agent | None: ...  # run 编排

# agent/server.py（改造）
class HttpAgentServer(BaseServer):
    # do_GET/do_POST/SSE/路由等 HTTP 协议细节留在本层；业务经 self.server 调 build_*/start_task
```

吸收点：
- 现 `Handler._run` 里散落的 `LlmClient` 构造、`ToolRegistry(build_default_tools)`、
  `Workspace(str(project.workdir))`、`Agent(...)` + gate + 线程编排 → 收进 `BaseServer.start_task`。
- 现 `build()` 工厂 → `HttpAgentServer` 构造。
- **eval/loop_test 吸收**：`eval/harness.py` 直接构造 `Workspace()/LlmClient/Agent/ToolRegistry`
  → 改为经 `BaseServer` 的 `build_llm/build_tools/build_workspace/start_task`，与 HTTP server 共享
  同一契约（保证工具接口、LLM 访问在 eval 与运行时完全一致）。

### 4.3 C 层：LLM 访问基类 `LlmClient` ABC

```python
# agent/llm/client.py（改造）
class LlmClient(ABC):
    @abstractmethod
    def stream(self, messages, tools=None) -> Iterator[dict]: ...
    # 事件协议契约: reasoning/text/tool_call_start/tool_call_delta/finish
class DeepSeekLlmClient(LlmClient):   # 现 openai 实现
```

稳定"llm 访问"契约；`_classify`/重试逻辑保留在实现类。

### 4.4 全项目继承审计

| 位置 | 现状 | 建议 | 价值 |
|------|------|------|------|
| `events.py` | `Event` 基类 + 10 子类 | 已是继承，不动 | — |
| **tools 执行** | 自由函数 + 未来 `if remote` | 走 `Workspace` 基类方法（4.1） | 高 |
| **`run_verify`** (core/terminate.py:64) | 裸 `subprocess cwd=workspace.root` | 改走 `workspace.run()` | 高 |
| **`_fs_list` / `_workspace_tree`** (server.py) | 直接 Path/iterdir | 走 `workspace.list` / transport（picker/树 transport 化） | 中 |
| **`LlmClient`** | 单一实现 | 提 ABC + 事件协议（4.3） | 中 |
| **服务器壳** | `Handler/ClutchServer/RunState` 平铺 | 提 `BaseServer`（4.2） | 中 |
| `_syntax_check` (shell.py) | 读本地文件 | 走 `workspace.read`（随 4.1 自动解决） | 中 |
| `Tool` / `Project` / `Config` / `Terminator` / `Permission` | 单实现、声明式 | **不做抽象**（YAGNI） | — |
| Node 侧 (ssh-tunnel/assist/proxy) | 过程式模块 | 可提 `Tunnel` 类，工作量大、非 Python | 低/可选 |

### 4.5 与自动降级流程的整合

1. 连接 → bootstrap 尝试 → **硬拒绝/失败**（installServer 已加 `ok:false` 分支）。
2. Electron 起 exec bridge(8894)。
3. renderer `POST /api/backend {mode:"ssh", bridge, workspace}`（workspace=远端 home）。
4. picker 走 `workspace.list`（桥 `ls`）浏览远端，选远端 `.clc`。
5. `BaseServer.start_task` 用 `RemoteWorkspace` 跑 agent；工具/验证/.clc 全走桥。
6. 断开 → `POST /api/backend {mode:"local"}` 回 `LocalWorkspace`。

---

## 5. 实施顺序

| 阶段 | 内容 | 验收 |
|------|------|------|
| **P1 — A 层纯重构** | `Transport`/`Workspace` 继承 + 工具改道（本地行为不变） | `loop_test` / `server_test` / `selfcheck` 全绿 |
| **P2 — 退化层集成** | exec bridge + `/api/backend` + `RemoteWorkspace`(tool→sh) + 远端 .clc + `run_verify`/`_fs_list`/`_workspace_tree` transport 化 | 连无 python 主机能走通：浏览、打开远端 .clc、跑任务 |
| **P3 — B/C 层重构** | `BaseServer` + `LlmClient` ABC + 吸收 eval/loop_test | 测试全绿（纯重构，行为不变） |
| **P4 — 自动降级接线** | bootstrap 失败 → 自动降级 + 断开复位 | 主流主机行为不变；极端主机自动降级 |

每阶段提交一次，保持可回退（`pre-refactor-rollback` 分支策略沿用）。

## 6. 验证要点

- P1：本地 transport 与原 subprocess 输出逐字节一致（含 diff/截断/路径防护）。
- P2：heredoc 追加 round-trip（含单引号/`$`/反引号内容）；远端 .clc 打开/追加/压缩；`run_verify`
  经桥；picker/tree 经桥。
- P3：`eval/harness.py` 改用 `BaseServer` 后结果与现 eval 一致。
- P4：模拟 bootstrap 失败（`CLUTCH_TUNNEL_FORCE` 或 mock bridge）触发自动降级。
