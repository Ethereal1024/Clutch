# Clutch 恢复备忘（给后续补救 agent）

> **用途**：用户关闭本会话后重启，若应用因代码 bug 打不开 / 异常，由新 agent 依据本文件快速诊断与修复。
> **先做**：读完本文件 → `git status` 确认工作区 → 按 §5 跑验证 → 按 §6 症状表定位。
> **工作区根**：`/home/fanshu/Workplace/Clutch/clutch`（下文所有相对路径基于此）。

---

## 1. 当前状态（截至本备忘写入时）

- 阶段 5「远程 supervisor 会话模型」已实施 + 收尾修复（degrade 双 bug + isTunnelLike 过时语义），**全套测试通过**（命令见 §5）。
- 阶段 6「多 API 档案（profiles）」已实施 + 真机实测：`settings.json` 为 `{"profiles": {name: {provider, base_url, model, api_key, reasoning_effort}}, "active": name}`，旧 flat 格式自动迁移为 `default`；`deepseek` 与 `zhipu-53`（glm-5.3，`reasoning_effort` 透传实测 low 档）双档案共存；实测脚本 `scripts/e2e-profiles-test.py`（需 `E2E_ZHIPU_KEY`）。
- **阶段 7「字节寻址懒加载」已实施**（3 个 commit：`873e926` 阶段5-6、`90616dc` 字节寻址+空回复防护、`73f6980` SSH 远程字节读取）：
  - `CompactionEvent.tail_start` 语义从「durable 事件序号」改为「**相对事件区起点的字节偏移**」；整套 `DurableIndex`/`index_file` 索引表**已删除**（`agent/core/lazy.py`）。
  - 打开只读「头部 + 保留尾部 + 尾部反向扫描」（`_tail_scan` 找最后一个 compaction + `[memories]` 标记），不再全文件建索引。
  - SSH 远程：`read_range` 走 `tail -c +A | head -c B | base64` 字节范围读取（1.3MB 中文 .clc 打开只传 ~19%）。
  - **空回复防护**：LLM 输出空 content 不再直接 `completed('')`，喂回 `prompts/empty_response.md` 重试（loop_test 13c）。
- ⚠️ **旧 .clc（seq 语义 tail_start）打开行为见 §9**——不崩溃，但懒加载可能失效（全量物化），属预期。
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
- 会话子进程安全网：supervisor 挂 → 子进程自杀（watchdog）；无心跳 30s → 回收；零会话 → 空闲自退。

## 3. 关键文件与职责

| 文件 | 职责 | 关键点 |
|---|---|---|
| `ui/main.js` | Electron 主进程 | `windowBackends` Map（webContentsId → `{kind: local\|tunnel, sessionId, url, stop}`）；`ensureWindowBackend` 决策：CLUTCH_API_URL 直连 → 隧道会话（`supervisorSessionStart(ts.url, REMOTE_LLM_BASE)` + `restartRemoteServer` 重试一次）→ **失败必须回退本地 `startLocalSession()`，绝不能 return null 把窗口指向 8890**；`api:base` IPC；心跳失败重领 + `backend:base-changed`；`tunnel:disconnect` 清 tunnel backends |
| `ui/server-bootstrap.js` | supervisor 会话 HTTP（本地+隧道共用） | 导出 `startLocalSession` / `supervisorSessionStart` / `supervisorSessionStop` / `startSupervisorHeartbeat`。**`apiTarget` 已删除**（direct 逻辑在 main.js）；`supervisorProbe` 判 "up/foreign/down" |
| `ui/ssh-tunnel.js` | ssh2 隧道 | `stopServerCmd`（pkill `agent-supervisor` 及旧 `agent-server`/`agent.server`，防 bind 冲突）；`probeSupervisorShape`；`openSessionForward(remotePort)` → 本地随机端口；`restartRemoteServer`；`establishForwardAndHealth` **拒绝 legacy 8890**（返回 `{"ok":true}` 的非 supervisor）并提示重启 |
| `ui/app.js` | 渲染进程 | `switchBackendResolved`（URL 一律由主进程 `api:base` 解析，渲染层**不猜端口**）；`reapplyDegradeIfNeeded` + `localStorage("clutch_degrade",{bridge})`（degrade 状态持久化重放）；`reconciledBackendUrl` stale 分支**只认 `clutch_ssh_connected` flag**（`isTunnelLike` 已删，本地会话也是随机端口无法用 URL 形状区分） |
| `ui/preload.js` | IPC 桥 | `baseUrl()` + `onBaseChanged(cb)`（`backend:base-changed`） |
| `agent/core/lazy.py` | 字节寻址懒加载 | **无索引表**：`tail_start` 是相对事件区起点的字节偏移；`_tail_scan` 尾部反向扫描（compaction + `[memories]`，只读新增区间，上限 8MB）；`_parse_with_offsets` 按**原始 bytes** 切分计数（多字节内容不漂移）；`_LAZY_MIN_BYTES`（默认 256KB）为懒加载阈值——**调成极大值 = 全部走全量 EventLog，是"字节代码打开异常"的逃生开关** |
| `agent/project.py` | 项目打开 | `open_project_lazy`：`_event_region_start`（bytes）找事件区起点；无 compaction / 小文件回退全量 `EventLog`；`_read_file` 全量加载按**每行真实字节**累计偏移（transients 也占字节） |
| `agent/events.py` | 事件 + EventLog | `tail_start` 字节语义；`EventLog` 维护每 durable 事件的相对字节偏移（append 用 `_line_bytes` 序列化字节，加载用文件行字节）；`tail_from`/`tail_start_index`/`events_before`/`compact_min_tail` 全字节化 |
| `agent/tools/workspace.py` | 工作区 I/O | `read_range` 抽象返回 **bytes**：本地 fd seek；远程 `tail -c +A \| head -c B \| base64`（base64 保证任意切分无损往返）；`size()` 抽象（本地 getsize / 远程 `wc -c`） |
| `agent/server.py` | 会话 HTTP | `/api/history` 改字节游标（`before=<offset>&limit=<bytes>`）；open 行 `{offset, event}`；`older` 为字节数；打开失败 emit `{"error": "cannot open project: ..."}`（UI 显示，不崩溃） |
| `agent/supervisor.py` | supervisor 本体 | `--port 0` 会话子进程、stdout 解析端口、stale-reap、idle-exit、watchdog |
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
uv run python -m agent.supervisor_test          # 生命周期 + 内核 flock 409 + base_url/frozen 用例
node ui/server-bootstrap.test.js                # 双"窗口"会话隔离 + 空闲自退 + 重拉
uv run python -m agent.server_test              # agent API 全量
node ui/ssh-tunnel.test.js                      # 隧道逻辑
node scripts/latch-regression-test.js           # UI latch
node scripts/mermaid-logic-test.js              # UI mermaid
cd ui && node --check main.js app.js preload.js server-bootstrap.js ssh-tunnel.js
```

字节寻址相关（阶段 7，改过 lazy/project/events/workspace/compaction 后必跑）：

```bash
uv run python -m agent.lazy_check              # 字节语义懒加载：tail scan、分页 offset、stale 钳制、tail_start_index 与全量精确一致
uv run python -m agent.loop_test               # 含压缩守卫 + 空回复重试（13c）
uv run python -m agent.selfcheck               # 含 lazy derive == full derive、transients 不占字节偏移
uv run python scripts/remote-read-verify.py    # 模拟 SSH：base64 往返 + 中文内容 + 非行首切分，offset 字节级精确 + 传输只占 19%
```

⚠️ `server-bootstrap.test.js` 会在 **8899** 起真 supervisor，失败会残留 → `ss -tlnp | grep 8899` 找到 pid 杀掉再跑。
⚠️ 本机 8890 若被用户 dev.sh 的旧共享 agent-server 占住（测试时会看到），**不要动它**（那是用户的开发服务器）；测试用了 8899 隔离。

## 6. 常见故障症状 → 修复路径

| 症状 | 诊断 | 修复 |
|---|---|---|
| UI 白屏/闪退 | terminal 输出 / `~/.clutch/tunnel.log`；`node --check` 各 js | electron 二进制缺失：`ui/node_modules/electron/path.txt` 带尾随换行 → `node -e "require('fs').writeFileSync('node_modules/electron/path.txt','electron')"`；再不行 `cd ui && npm install` |
| 启动报 8890 "foreign" | `curl 127.0.0.1:8890/api/health` 返回 `{"ok":true}` 而非 `{"status":"ok"}` | 旧共享 agent-server 占端口 → `pkill -f agent.server` 或设 `CLUTCH_API_URL` 直连 |
| "Cannot reach backend" | 主进程日志；`curl 127.0.0.1:8890/api/health`；主进程 `api:base` 返回的 URL 是否可 `fetch /api/health` | 确认 supervisor 活着；检查 `ensureWindowBackend` 是否误把 8890 当业务 URL（应返回会话随机端口）；会话泄漏则 `pkill -f "agent.server"` |
| degrade 模式（无 Python 主机）不工作 | 是否设了 ssh 模式：`curl <会话URL>/api/backend` 状态 | 检查 `localStorage("clutch_degrade")` 标记与 `reapplyDegradeIfNeeded`；**退出 degrade 的路径必须先 removeItem 标记再 switchBackendResolved**（否则复活） |
| 远程连不上 | `~/.clutch/tunnel.log`；远端 8890 形状 | `establishForwardAndHealth` 拒绝 legacy 时按提示重启远端；确认远端 8890 是 supervisor |
| 客户端突然断连（进行中 run 中断 / SSE 事件流断） | UI console + `~/.clutch/tunnel.log` 是否同步断；SSE 侧 `BrokenPipeError` 已有兜底（server.py `_sse`） | 多为外部中断（网络波动 / 渲染进程重启 / 隧道断开）：服务端 run 照常推进（gate/cancel 兜底，不会卡死），UI 重连 SSE 自动 replay DURABLE 事件恢复历史；隧道模式查 tunnel.log；频繁断连排查本地代理/网络，与后端代码无关时**记录为环境性断连**，不留毒 |
| 会话进程泄漏 | `ps aux \| grep agent.server` | supervisor 空闲自退 + 双向 watchdog 兜底；手动 `pkill -f agent.server` |
| **字节更新后项目打不开 / 打开后历史异常** | UI 显示 `cannot open project: ...`（server 端 `open_project_lazy` 异常）；或项目打开但事件缺失/游标错乱 | 先按 **§9** 排查；最坏情况临时把 `agent/core/lazy.py` 的 `_LAZY_MIN_BYTES` 调成极大值（如 `2**60`）强制全量 EventLog 打开（懒加载失效但功能正确），确认是全量路径 bug 还是 lazy 路径 bug |
| 打开后卡进度 / 进度条不动 | `curl <会话URL>/api/project/open` 直接看返回流 | 远程大文件：`_tail_scan` 上限 8MB + 无 `[memories]` 时会扫较多尾部，属预期；本地无此问题；确认不是 `/api/history` 循环（UI 游标） |

## 7. 修复时不要破坏的约定

1. **supervisor 永不代理流量**——只管理会话生命周期；窗口直连会话端口。
2. **一窗一会话**——`windowBackends` 是 per-webContents 的；切换必须先 `releaseWindowBackend` 再领新会话。
3. **渲染层不猜端口**——所有 URL 经主进程 `api:base`；会话重建后主进程发 `backend:base-changed`。
4. **会话子进程必须带 `--port 0`**（随机端口）让 OS 分配，禁止固定业务端口。
5. **远端会话必须带 `--base-url http://127.0.0.1:8892/v1`**（REMOTE_LLM_BASE），与 `LLM_PROXY_REMOTE_PORT` 保持一致；本地会话不带。
6. 改完任何文件 → 跑 §5 全部测试 → 全绿才算完成。
7. **`settings.json` 是 profiles 格式**：`{"profiles": {name: {provider, base_url, model, api_key}}, "active": name}`；旧 flat 格式自动迁移为 `default` 档案。所有读写方走同一套迁移（`agent/config.py` `normalize_settings`/`active_profile`、`agent/server.py` `_settings`/`_settings_get`/启动 resolve、`ui/llm-proxy.js` `readSettingsFile`、`ui/main.js` `settings:save` IPC）。POST 语义：`{profile_name?, provider, base_url, model, api_key?}` 保存+激活、`{activate: name}` 纯切换、`{delete: name}` 删除；**GET 永不回显 api_key**（只有 `has_api_key`）。
8. **`.clc` 字节寻址约定（阶段 7，别改回去）**：
   - `CompactionEvent.tail_start` 是**相对事件区起点（第一个 durable 行 = task 行首）的字节偏移**，不是事件序号。所有 log 内部（`tail_from`/`tail_start_index`/`events_before`/`materialize_range`/`older_bytes`）统一字节语义。
   - 偏移基准一致性：**每一行都占字节**（transients 也占）——`_read_file` 加载和 `_parse_with_offsets` 都按文件真实行字节累计；运行中 append 用 `_line_bytes`（序列化字节，新 .clc 无 transients 所以一致）。
   - **解析必须按原始 bytes 切分**（`split(b"\n")` + `len(seg)`），不要用 str 的 `len(line)`（多字节内容会漂移）。
   - `_make_reader` 远程分支用 `workspace.size()` + `read_range()`（base64 无损），**不要**退回 `workspace.read()` 整文件拉取。
   - `_LAZY_MIN_BYTES` 是懒加载阈值（默认 256KB）；`_TAIL_SCAN_MAX` 8MB 是尾部扫描上限——这两个是"打开行为"的调节阀，调试时优先看它们。

## 8. 仍需真机验证（本环境无法自动化）

1. 真实 SSH 端到端（两台机器：连远端 → 远端 supervisor 拉起 → 会话 → 跨机 .clc 409 → 心跳自愈 → 隧道断回本地）
2. degrade 真机（连无 Python 的主机，文件浏览器走 SSH 桥）
3. deb 打包安装（`bash scripts/release.sh` → `sudo dpkg -i` → 首窗拉起 + 退出自清理）
4. Electron 真实运行（`cd ui && npm start`，含 `CLUTCH_API_URL` 直连分支）
5. LLM 反代全链路（远端会话 → 8892 反向隧道 → 客户端 LLM）
6. 真实 SSH 远程懒打开大 .clc（远端 10MB+ 中文文件，确认只传尾部 + 进度条正常）

## 9. 字节更新后「无法正常打开」预防与恢复（重点）

**背景**：`tail_start` 语义从事件序号改为相对字节偏移（commit `90616dc`），整套索引表删除。本节的目的是：**升级后任何 .clc 打开异常，都能快速判定是"预期兼容行为"还是"真 bug"，并给出逃生通道**。

### 9.1 旧 .clc（升级前写的，tail_start 是事件序号）打开行为——预期，不是 bug

| 旧值情形 | 新代码行为 | 影响 |
|---|---|---|
| tail_start 超出文件事件区字节范围 | `_materialize_open` 钳制到事件区起点 → **全量物化** | 懒加载失效（打开慢、内存多），**功能正确** |
| tail_start 落在合法字节范围但偏前 | 从该处物化 tail | 物化更多事件，懒加载部分失效，**功能正确** |
| 文件无 compaction | 走全量 `EventLog` 路径 | 正常 |

⇒ **旧文件不会打不开，最多是"全量加载"**。用户感知是打开变慢/进度条走到 100%，属可接受降级；首次重开后运行中压缩会写回字节 tail_start，下次打开恢复正常懒加载。

### 9.2 打开异常的排查顺序（UI 报 `cannot open project: ...` 时）

1. **先看错误文案**：server 端 `open_project_lazy` 的异常会 emit `{"error": "cannot open project: <msg>"}`。用 `curl <会话URL>/api/project/open -d '{"path": "<clc路径>"}'` 直接看返回流拿到完整异常。
2. **手动复现拿 traceback**：
   ```bash
   uv run python -c "from agent.project import open_project_lazy; p=open_project_lazy('<路径>/x.clc'); print(len(p.log.events()), 'events')"
   ```
3. **判定是否 lazy 路径专属**：临时把 `agent/core/lazy.py` 的 `_LAZY_MIN_BYTES` 改成 `2**60`（强制全量 EventLog）重试。若全量能打开 → bug 在 lazy 路径（`_tail_scan`/`_materialize_open`/`_parse_with_offsets`），按 §5 跑 lazy_check 定位；若全量也打不开 → **文件损坏**（见 9.3）。
4. **检查是不是已知场景**：
   - 超长单行（task 行 > 64KB）→ 头部读取截断 → 事件区起点找不到 → 走"无事件"分支（项目打开但历史空）。这是设计边界，可接受（正常 task 远小于 64KB）。
   - 文件尾部损坏（截断/乱码）→ `_tail_scan` 逐行容错（json 失败跳过）→ 通常仍能打开。
   - 文件是 0 字节 / 只有 header → 正常走空项目分支。

### 9.3 文件损坏恢复

- 打开失败且全量也失败 → 备份原文件后逐行检查：`head -c <size> file.clc | tail -c 500` 看尾部是否被截断；损坏行可手工删除（JSON 行可独立删）。
- 恢复工具思路：`uv run python -c` 逐行 `json.loads` 过滤出可解析行 → 重建 .clc（header 4 行 + 有效事件行）。**不要**用旧版代码"修复"（seq/字节语义不同，只会写回错误值）。
- 项目锁：打开失败会自动释放锁（`open_project_lazy` 的 finally），无需手动清锁文件。

### 9.4 升级预防清单

- [ ] 升级前备份项目目录（含所有 `.clc`）与 `~/.clutch/settings.json`（settings 有 profiles 迁移，别用旧版覆盖新版文件）。
- [ ] 升级后先开**一个**旧项目验证：能打开 → 事件显示正常 → 发一条消息触发一次压缩 → 重开确认懒加载恢复（tail_start 写回字节）。
- [ ] 确认 `/api/history` 翻页（顶部 "load earlier records (KB)"）正常——UI 游标是字节，旧页面缓存（localStorage）无历史游标，首次翻页即按新协议。
- [ ] 若用 SSH 远程打开：确认远端是新版 bundle（`agent-supervisor`，含阶段 7）；旧远端 + 新本地混合可能协议不一致（`/api/history` 字节 vs seq），统一版本再测。
- [ ] 真机验证项见 §8 第 6 条。
