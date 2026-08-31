# Clutch 恢复备忘（给后续补救 agent）

> **用途**：用户关闭本会话后重启，若应用因代码 bug 打不开 / 异常，由新 agent 依据本文件快速诊断与修复。
> **先做**：读完本文件 → `git status` 确认工作区 → 按 §5 跑验证 → 按 §6 症状表定位。
> **工作区根**：`/home/fanshu/Workplace/Clutch/clutch`（下文所有相对路径基于此）。

---

## 1. 当前状态（截至本备忘写入时）

- 阶段 5「远程 supervisor 会话模型」已实施 + 收尾修复（degrade 双 bug + isTunnelLike 过时语义），**全套测试通过**（命令见 §5）。
- 阶段 6 多 API 档案（profiles）已回退为**扁平设置**：`settings.json` 为 `{"base_url", "model", "api_key", "reasoning_effort"}`；旧 `{profiles, active}` 形状读取时坍缩为 active 档案（`config.flatten_settings`）。UI 设置弹窗只存/改这四项。
- **阶段 7「字节寻址懒加载」已实施**（commit `873e926`/`90616dc`/`73f6980` 及后续窗口化改造）：
  - 事件区 = 头部 `---` 分隔符之后的所有行；**窗口 = `[cpr_start, file_end)`**，`cpr_start` 是「最新一条 compaction 行的相对字节偏移」，持久化在头部定宽行 `cpr_start=NNNNNNNNNN` 里。整套 `DurableIndex`/`index_file` 索引表与 `_tail_scan` 尾部扫描**已删除**。
  - 打开**只读「头部 + 窗口」**：一次范围读即完成物化（O(1)），task 与更早历史一律留在磁盘，由 UI 上翻分页 `/api/history` 按字节区间纯磁盘读取。
  - SSH 远程：`read_range` 走 `tail -c +A | head -c B | base64` 字节范围读取（1.3MB 中文 .clc 打开只传 ~19%）。
  - **空回复防护**：LLM 输出空 content 不再直接 `completed('')`，喂回 `prompts/empty_response.md` 重试（loop_test 13c）。
  - **运行时不做任何迁移**：`.clc` 无 `cpr_start` 行就按 0（全量窗口）打开；旧文件用 `scripts/convert-clc-to-cpr.py` 一次性转换（写入各文件最后一次 compaction 边界 + 重建/修正 memory 索引行）。
- 阶段 5 之前的阶段 1-4 均已完成（.clc 跨窗口写锁、每窗口独立会话、supervisor 架构）。

## 2. 架构速查（必须知道，别按旧架构理解）

```
一台机器 = 一个 supervisor（agent/supervisor.py，固定 127.0.0.1:8890）
    └─ spawn/回收 每个 UI 窗口一个"会话子进程"（agent/server.py --port 0，随机端口）
        └─ 窗口直连自己的会话（HTTP+SSE），supervisor 不代理流量，只管理生命周期
```

- supervisor 启动参数：`--port 8890 --idle-timeout 8`，**永远不带 --base-url**（base-url 按会话在 session/start 时传）。
- session API（本地/远端同一套，见 `ui/server-bootstrap.js`）：
  - `GET /api/health` → `{"status":"ok"}`（supervisor 形状判据）
  - `POST /api/session/start` body `{base_url?}` → `{session_id, port}`（port 是子进程随机端口）
  - `POST /api/session/stop` `{session_id}`；`POST /api/session/heartbeat` `{session_id}`
- 远端 = **同一个 supervisor 程序**（bundle: `agent-supervisor`；pylibs: `python3 -m agent.supervisor`），经 SSH 隧道转发到远端 8890 控制通道；每窗口独立会话 + 独立转发（`openSessionForward`）。
- 远端会话带 `--base-url http://127.0.0.1:8892/v1`（LLM 走客户端反代）——**必须**与 `ui/ssh-tunnel.js` 的 `LLM_PROXY_REMOTE_PORT = 8892` 一致（main.js 里 `REMOTE_LLM_BASE` 同值）。本地会话不带 base-url（用环境 `CLUTCH_API_KEY`）。
- 会话子进程安全网：**纯心跳机制**（无 watchdog）：客户端心跳 8s/次；supervisor 无心跳 10s → 回收会话；零会话 → 8s 空闲自退。supervisor 正常退出（SIGTERM/idle）会 `shutdown_all` 杀掉子进程。

## 3. 关键文件与职责

| 文件 | 职责 | 关键点 |
|---|---|---|
| `ui/main.js` | Electron 主进程 | `windowBackends` Map（webContentsId → `{kind: local\|tunnel, sessionId, url, stop}`）；`ensureWindowBackend` 决策：隧道会话（`supervisorSessionStart(ts.url, REMOTE_LLM_BASE)` + `restartRemoteServer` 重试一次）→ 失败回退本地 `startLocalSession()`，绝不能 return null 把窗口指向 8890。**应用只用 supervisor，已移除 CLUTCH_API_URL 直连共享 agent-server 的旧模式**；`api:base` IPC；心跳失败重领 + `backend:base-changed`；`tunnel:disconnect` 清 tunnel backends |
| `ui/server-bootstrap.js` | supervisor 会话 HTTP（本地+隧道共用） | 导出 `startLocalSession` / `supervisorSessionStart` / `supervisorSessionStop` / `startSupervisorHeartbeat`。**`apiTarget` 已删除**（direct 逻辑在 main.js）；`supervisorProbe` 判 "up/foreign/down" |
| `ui/ssh-tunnel.js` | ssh2 隧道 | `stopServerCmd`（pkill `agent-supervisor` 及旧 `agent-server`/`agent.server`，防 bind 冲突）；`probeSupervisorShape`；`openSessionForward(remotePort)` → 本地随机端口；`restartRemoteServer`；`establishForwardAndHealth` **拒绝 legacy 8890**（返回 `{"ok":true}` 的非 supervisor）并提示重启 |
| `ui/app.js` | 渲染进程 | `switchBackendResolved`（URL 一律由主进程 `api:base` 解析，渲染层**不猜端口**）；`reapplyDegradeIfNeeded` + `localStorage("clutch_degrade",{bridge})`（degrade 状态持久化重放）；`reconciledBackendUrl` stale 分支**只认 `clutch_ssh_connected` flag**（`isTunnelLike` 已删，本地会话也是随机端口无法用 URL 形状区分） |
| `ui/preload.js` | IPC 桥 | `baseUrl()` + `onBaseChanged(cb)`（`backend:base-changed`） |
| `agent/core/lazy.py` | 窗口懒加载 | **无索引表、无 tail scan**：窗口 = `[cpr_start, file_end)`（`cpr_start` 来自头部定宽行，O(1) 读取）；`_parse_with_offsets` 按**原始 bytes** 切分计数（多字节内容不漂移）；`read_page` 纯磁盘分页；`note_bytes_written` 让记忆写入计入 log 字节账，保证事件偏移与 cpr_start 精确 |
| `agent/project.py` | 项目打开 | `open_project_lazy`：读头部拿 `cpr_start` + `_event_region_start`（bytes）找事件区起点；无 `cpr_start` 行 → 0（全量窗口）；**运行时零迁移**；`_last_compaction_rel` 共享给迁移脚本 |
| `agent/events.py` | 事件定义 | `LazyEventLog` 维护常驻事件的相对字节偏移（append 用 `_line_bytes`）；`CompactionEvent` 只带 summary，窗口边界全在头部 `cpr_start` |
| `scripts/convert-clc-to-cpr.py` | **迁移脚本（全部迁移逻辑）** | 扫描 `*.clc`：把 `cpr_start` 写成最后一次 compaction 行的相对偏移（无压缩写 0）、重建/修正定宽 `memory_index=` 行、事件区字节原样保留、原子 tmp+swap、幂等。旧文件不跑它则每次全量打开 |
| `agent/tools/workspace.py` | 工作区 I/O | `read_range` 抽象返回 **bytes**：本地 fd seek；远程 `tail -c +A \| head -c B \| base64`（base64 保证任意切分无损往返）；`size()` 抽象（本地 getsize / 远程 `wc -c`） |
| `agent/server.py` | 会话 HTTP | `/api/history` 字节游标（`before=<offset>&limit=<bytes>`，下限可到 0）；open 流与 SSE replay 均为 `{offset, event}`；`older` 为字节数（= `cpr_start`）；打开失败 emit `{"error": "cannot open project: ..."}`（UI 显示，不崩溃） |
| `agent/supervisor.py` | supervisor 本体 | `--port 0` 会话子进程、stdout 解析端口、心跳 stale-reap（10s）、idle-exit |
| `scripts/build-server-bundle.sh` | PyInstaller 打包 | 产出 `agent-server` **和** `agent-supervisor`（onefile） |
| `ui/electron-builder.yml` | deb 打包 | `agent-supervisor` 在 extraResources（与 agent-server 并列） |

## 4. 环境与端口

- Python：`uv run python`（仓库有 .venv 时也可 `.venv/bin/python`）；Node：系统 node（`ui/node_modules` 已装）。
- 端口：`8890` supervisor（机器级唯一）、`8899` 测试用（`CLUTCH_SUPERVISOR_PORT` 覆盖）、`8892` 远端 LLM 反代、exec bridge 随机。
- 日志：`~/.clutch/tunnel.log`（SSH 隧道跟踪，含密码，勿外发）；远端 `/tmp/clutch-server.log`。
- 启动 UI：`cd ui && npm start`；手动起 supervisor：`uv run python -m agent.supervisor --port 8890 --idle-timeout 8`。

## 5. 验证（全套测试 + 语法，应全绿）

```bash
cd /home/fanshu/Workplace/Clutch/clutch
uv run python -m tests.supervisor_test       # 生命周期 + 内核 flock 409 + base_url/frozen 用例
node tests/server-bootstrap.test.js          # 双"窗口"会话隔离 + 空闲自退 + 重拉
uv run python -m tests.server_test           # agent API 全量
node tests/ssh-tunnel.test.js                # 隧道逻辑
node tests/latch-regression-test.js          # UI latch
node tests/mermaid-logic-test.js             # UI mermaid
node tests/llm-proxy.test.js                # LLM 反代上游 URL 拼接
cd ui && node --check main.js app.js preload.js server-bootstrap.js ssh-tunnel.js
```

字节寻址相关（阶段 7，改过 lazy/project/events/workspace/compaction 后必跑）：

```bash
uv run python -m tests.lazy_check              # 窗口懒加载：仅窗口物化、分页 offset、stale 钳制、lazy derive == full derive
uv run python -m tests.loop_test               # 含压缩守卫 + 空回复重试（13c）
uv run python -m tests.selfcheck               # 含 lazy derive == full derive、transients 不占字节偏移
uv run python -m tests.transport_test          # 传输层 + 远程工作区往返检查（exec 桥）
```

⚠️ `tests/server-bootstrap.test.js` 会在 **8899** 起真 supervisor，失败会残留 → `ss -tlnp | grep 8899` 找到 pid 杀掉再跑。
⚠️ 本机 8890 若被旧共享 agent-server 占住（`python -m agent.server`），应用会报 "port 8890 held by a non-supervisor"——**直接 pkill 掉它再开**（应用只用 supervisor，无直连模式）；测试用 8899 隔离。

## 6. 常见故障症状 → 修复路径

| 症状 | 诊断 | 修复 |
|---|---|---|
| UI 白屏/闪退 | terminal 输出 / `~/.clutch/tunnel.log`；`node --check` 各 js | electron 二进制缺失：`ui/node_modules/electron/path.txt` 带尾随换行 → `node -e "require('fs').writeFileSync('node_modules/electron/path.txt','electron')"`；再不行 `cd ui && npm install` |
| 启动报 8890 "foreign" | `curl 127.0.0.1:8890/api/health` 返回 `{"ok":true}` 而非 `{"status":"ok"}` | 旧共享 agent-server 占端口 → `pkill -f agent.server` 再开（应用只用 supervisor） |
| "Cannot reach backend" | 主进程日志；`curl 127.0.0.1:8890/api/health`；主进程 `api:base` 返回的 URL 是否可 `fetch /api/health` | 确认 supervisor 活着；检查 `ensureWindowBackend` 是否误把 8890 当业务 URL（应返回会话随机端口）；会话泄漏则 `pkill -f "agent.server"` |
| degrade 模式（无 Python 主机）不工作 | 是否设了 ssh 模式：`curl <会话URL>/api/backend` 状态 | 检查 `localStorage("clutch_degrade")` 标记与 `reapplyDegradeIfNeeded`；**退出 degrade 的路径必须先 removeItem 标记再 switchBackendResolved**（否则复活） |
| 远程连不上 | `~/.clutch/tunnel.log`；远端 8890 形状 | `establishForwardAndHealth` 拒绝 legacy 时按提示重启远端；确认远端 8890 是 supervisor |
| 客户端突然断连（进行中 run 中断 / SSE 事件流断） | UI console + `~/.clutch/tunnel.log` 是否同步断；SSE 侧 `BrokenPipeError` 已有兜底（server.py `_sse`） | 多为外部中断（网络波动 / 渲染进程重启 / 隧道断开）：服务端 run 照常推进（gate/cancel 兜底，不会卡死），UI 重连 SSE 自动 replay DURABLE 事件恢复历史；隧道模式查 tunnel.log；频繁断连排查本地代理/网络，与后端代码无关时**记录为环境性断连**，不留毒 |
| 会话进程泄漏 | `ps aux \| grep agent.server` | supervisor 心跳回收（无心跳 10s 回收 + 8s 空闲自退）兜底；`pkill -f agent.server` |
| **打开后历史异常 / 乱序** | UI 显示事件乱序/缺失 | 打开只物化窗口 `[cpr_start, file_end)`；更早历史（含原始 task）靠上翻分页。若看到"相邻 task 倒序"或缺失：确认文件已用迁移脚本转换（有 `cpr_start=` 行）；`curl <会话URL>/api/history?before=<cpr_start>` 直接看返回流定位 |
| 打开后卡进度 / 进度条不动 | `curl <会话URL>/api/project/open` 直接看返回流 | 未转换的旧大文件 = 全量窗口（`cpr_start` 0），物化全部事件属预期 → 跑 `uv run python scripts/convert-clc-to-cpr.py .` 转换；已转换文件打开只是窗口大小（窗口自上次压缩起积累，超 500KB 会触发压缩） |

## 7. 修复时不要破坏的约定

1. **supervisor 永不代理流量**——只管理会话生命周期；窗口直连会话端口。
2. **一窗一会话**——`windowBackends` 是 per-webContents 的；切换必须先 `releaseWindowBackend` 再领新会话。
3. **渲染层不猜端口**——所有 URL 经主进程 `api:base`；会话重建后主进程发 `backend:base-changed`。
4. **会话子进程必须带 `--port 0`**（随机端口）让 OS 分配，禁止固定业务端口。
5. **远端会话必须带 `--base-url http://127.0.0.1:8892/v1`**（REMOTE_LLM_BASE），与 `LLM_PROXY_REMOTE_PORT` 保持一致；本地会话不带。
6. 改完任何文件 → 跑 §5 全部测试 → 全绿才算完成。
7. **`settings.json` 是扁平格式**：`{"base_url", "model", "api_key", "reasoning_effort"}`。所有读写方一致（`agent/config.py` `flatten_settings`、`agent/server.py` `_settings_get`/`_settings_post`/启动 resolve、`ui/llm-proxy.js` `readSettingsFile`、`ui/main.js` `settings:save` IPC）。POST 语义：`{base_url?, model?, api_key?, reasoning_effort?}`（空值清空对应键，全空报"nothing to save"）；**GET 永不回显 api_key**（只有 `has_api_key`）。旧 `{profiles, active}` 形状读取时坍缩为 active 档案。
8. **`.clc` 窗口寻址约定（阶段 7，别改回去）**：
   - **窗口 = `[cpr_start, file_end)`**：`cpr_start` 是「最新一条 compaction 行」相对事件区起点的字节偏移，持久化在头部定宽行 `cpr_start=NNNNNNNNNN`（10 位）。打开只物化窗口；原始 task 与更早历史（`[0, cpr_start)`）留在磁盘，靠 UI 上翻分页。
   - 偏移基准一致性：**每一行都占字节**——`_parse_with_offsets` 与运行中 append（`_line_bytes`）都按文件真实字节累计；记忆行由 `MemoryStore.save` 经 `log.note_bytes_written` 计入 log 字节账，保证偏移不漂移。
   - **解析必须按原始 bytes 切分**（`split(b"\n")` + `len(seg)`），不要用 str 的 `len(line)`（多字节内容会漂移）。
   - `_make_reader` 远程分支用 `workspace.size()` + `read_range()`（base64 无损），**不要**退回 `workspace.read()` 整文件拉取。
   - **运行时零迁移**：无 `cpr_start` 行的文件按 0（全量窗口）打开；旧文件用 `scripts/convert-clc-to-cpr.py` 转换（写最后一次 compaction 边界 + 重建 memory 索引，幂等）。

- [ ] 升级预防清单见 §9.4；旧文件已全部转换为 cpr_start 格式（`scripts/convert-clc-to-cpr.py`），历史迁移工具（seq→字节、`verify-clc-byte`、`remote-read-verify`）已删除（验证职责由 `tests.lazy_check` / `tests.server_test` 承担）。
- ⚠️ **历史 bug（已被 cpr_start 头部取代）**：`_tail_scan` 尾部倒扫曾在多区间扩展时把更早区间的 compaction 误当最后一个 → 打开物化数千事件、UI 慢（clutch 4243 个）。窗口化改造后边界直接来自头部 `cpr_start`，无尾部扫描，此问题不再存在。
- ⚠️ **历史 bug（已修）**：全量加载曾用 `log.append(ev)` 把解析出的每个事件**重新写回文件** → 无压缩 .clc 每次打开翻倍膨胀。若发现某 .clc 行数异常翻倍，从备份恢复或手工去重即可。
- ⚠️ **历史 bug（已被窗口化取代）**：`_tail_start` 曾只在打开时赋值、运行中不更新 → `should_compact()` 恒真 → 每轮全量重压缩。现在边界是 `_cpr_start`，压缩后由 `set_cpr_start` 立即滑动，回归断言在 `lazy_check` 第 4-5 节（压缩后 should_compact 为 False / 新增一轮不重触发）。

## 8. 仍需真机验证（本环境无法自动化）

1. 真实 SSH 端到端（两台机器：连远端 → 远端 supervisor 拉起 → 会话 → 跨机 .clc 409 → 心跳自愈 → 隧道断回本地）
2. degrade 真机（连无 Python 的主机，文件浏览器走 SSH 桥）
3. deb 打包安装（`bash scripts/release.sh` → `sudo dpkg -i` → 首窗拉起 + 退出自清理）
4. Electron 真实运行（`cd ui && npm start`，supervisor 会话路径）
5. LLM 反代全链路（远端会话 → 8892 反向隧道 → 客户端 LLM）
6. 真实 SSH 远程懒打开大 .clc（远端 10MB+ 中文文件，确认只传尾部 + 进度条正常）

## 9. 窗口化后「无法正常打开」预防与恢复（重点）

**背景**：打开只物化窗口 `[cpr_start, file_end)`（`cpr_start` 来自头部定宽行），运行时零迁移。本节的目的是：**任何 .clc 打开异常，都能快速判定是"预期兼容行为"还是"真 bug"，并给出逃生通道**。

### 9.1 未转换旧文件（无 `cpr_start` 行）打开行为——预期，不是 bug

| 文件情形 | 代码行为 | 影响 |
|---|---|---|
| 无 `cpr_start=` 行（旧文件，未跑迁移脚本） | `cpr_rel = 0` → **全量窗口** | 懒加载失效（打开慢、内存多），**功能正确** |
| `cpr_start` 越界/损坏 | 钳制到 0 → **全量窗口** | 懒加载失效（打开慢），**功能正确** |
| 文件从未压缩 | `cpr_start` 0 → 全量窗口 | 正常（整个事件区就是窗口） |

⇒ **旧文件不会打不开，最多是"全量加载"**。要恢复懒加载，跑迁移脚本：`uv run python scripts/convert-clc-to-cpr.py <目录或文件>`（把每个文件最后一次 compaction 边界写入 `cpr_start`，重建/修正 `memory_index=` 行；幂等，可重复跑）。转换前建议先备份 `.clc`。

### 9.2 打开异常的排查顺序（UI 报 `cannot open project: ...` 时）

1. **先看错误文案**：server 端 `open_project_lazy` 的异常会 emit `{"error": "cannot open project: <msg>"}`。用 `curl <会话URL>/api/project/open -d '{"path": "<clc路径>"}'` 直接看返回流拿到完整异常。
2. **手动复现拿 traceback**：
   ```bash
   uv run python -c "from agent.project import open_project_lazy; p=open_project_lazy('<路径>/x.clc', read_only=True); print(len(p.log.items()), 'events')"
   ```
3. **检查是不是已知场景**：
   - 超长单行（首行 > 64KB）→ 头部读取截断 → 事件区起点找不到 → 走"无事件"分支（项目打开但历史空）。这是设计边界，可接受（正常首行远小于 64KB）。
   - 文件尾部损坏（截断/乱码）→ `_parse_with_offsets` 逐行容错（json 失败跳过）→ 通常仍能打开。
   - 文件是 0 字节 / 只有 header → 正常走空项目分支。
   - 打开后历史"乱序/缺失" → 见 §6「打开后历史异常 / 乱序」行：先确认文件已转换（有 `cpr_start=` 行）；`curl <会话URL>/api/history?before=<cpr_start>` 直接看分页返回流定位。

### 9.3 文件损坏恢复

- 打开失败 → 备份原文件后逐行检查：`head -c <size> file.clc | tail -c 500` 看尾部是否被截断；损坏行可手工删除（JSON 行可独立删）。
- 恢复工具思路：`uv run python -c` 逐行 `json.loads` 过滤出可解析行 → 重建 .clc（header + 有效事件行），再跑迁移脚本补 `cpr_start`/`memory_index`。
- 项目锁：打开失败会自动释放锁（`open_project_lazy` 的 finally），无需手动清锁文件。

### 9.4 升级预防清单

- [ ] 升级前备份项目目录（含所有 `.clc`）与 `~/.clutch/settings.json`。
- [ ] 升级后跑 `uv run python scripts/convert-clc-to-cpr.py .` 把旧 `.clc` 全部转为 cpr_start 格式（可重复、幂等）。
- [ ] 打开一个转换后的项目验证：能打开 → 窗口（压缩摘要 + 近期）正常 → 顶部 "load earlier records (KB)" 上翻分页正常（含最早 task）。
- [ ] 若用 SSH 远程打开：确认远端是新版 bundle（`agent-supervisor`，含窗口化改造）；旧远端 + 新本地混合可能协议不一致（`/api/history` 字节 vs seq），统一版本再测。
- [ ] 真机验证项见 §8 第 6 条。
