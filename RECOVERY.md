# Clutch 恢复备忘（给后续补救 agent）

> **用途**：用户关闭本会话后重启，若应用因代码 bug 打不开 / 异常，由新 agent 依据本文件快速诊断与修复。
> **先做**：读完本文件 → `git status` 确认工作区 → 按 §5 跑验证 → 按 §6 症状表定位。
> **工作区根**：`/home/fanshu/Workplace/Clutch/clutch`（下文所有相对路径基于此）。

---

## 1. 当前状态（截至本备忘写入时）

- 阶段 5「远程 supervisor 会话模型」已实施 + 收尾修复（degrade 双 bug + isTunnelLike 过时语义），**六套测试全部通过**（命令见 §5）。
- 阶段 6「多 API 档案（profiles）」已实施 + 真机实测通过：`settings.json` 升级为 `{"profiles": {name: {provider, base_url, model, api_key}}, "active": name}`，旧 flat 格式自动迁移为 `default` 档案；`deepseek`（default）与 `zhipu-53`（glm-5.3）双档案共存，保存/切换/删除经 `/api/settings` + UI 设置弹窗（档案下拉），一键切换不互相覆盖；真实 glm-5.3 经 `/api/run` 端到端跑通（`reasoning_content` 自动流入 UI，无需 thinking 参数；GLM-5.3 思考默认 max 档，建议档案内后续可加 `reasoning_effort` 透传）。实测脚本 `scripts/e2e-profiles-test.py`（需 `E2E_ZHIPU_KEY` 环境变量，自动备份/恢复 settings.json）。
- ⚠️ **所有改动尚未 git commit**（阶段 5 ~14 文件 + 阶段 6 ~8 文件）。**若本会话后文件丢失，先查 git stash / 备份**；正常关闭不会丢文件（都在磁盘上）。
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
| `agent/supervisor.py` | supervisor 本体 | `--port 0` 会话子进程、stdout 解析端口、stale-reap、idle-exit、watchdog |
| `scripts/build-server-bundle.sh` | PyInstaller 打包 | 产出 `agent-server` **和** `agent-supervisor`（onefile） |
| `ui/electron-builder.yml` | deb 打包 | `agent-supervisor` 在 extraResources（与 agent-server 并列） |

## 4. 环境与端口

- Python：`uv run python`（仓库有 .venv 时也可 `.venv/bin/python`）；Node：系统 node（`ui/node_modules` 已装）。
- 端口：`8890` supervisor（机器级唯一）、`8899` 测试用（`CLUTCH_SUPERVISOR_PORT` 覆盖）、`8892` 远端 LLM 反代、exec bridge 随机。
- 日志：`~/.clutch/tunnel.log`（SSH 隧道跟踪，含密码，勿外发）；远端 `/tmp/clutch-server.log`。
- 启动 UI：`cd ui && npm start`；手动起 supervisor：`uv run python -m agent.supervisor --port 8890 --idle-timeout 8`。

## 5. 验证（六套测试 + 语法，应全绿）

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

## 7. 修复时不要破坏的约定

1. **supervisor 永不代理流量**——只管理会话生命周期；窗口直连会话端口。
2. **一窗一会话**——`windowBackends` 是 per-webContents 的；切换必须先 `releaseWindowBackend` 再领新会话。
3. **渲染层不猜端口**——所有 URL 经主进程 `api:base`；会话重建后主进程发 `backend:base-changed`。
4. **会话子进程必须带 `--port 0`**（随机端口）让 OS 分配，禁止固定业务端口。
5. **远端会话必须带 `--base-url http://127.0.0.1:8892/v1`**（REMOTE_LLM_BASE），与 `LLM_PROXY_REMOTE_PORT` 保持一致；本地会话不带。
6. 改完任何文件 → 跑 §5 全部测试 → 全绿才算完成。
7. **`settings.json` 是 profiles 格式**：`{"profiles": {name: {provider, base_url, model, api_key}}, "active": name}`；旧 flat 格式自动迁移为 `default` 档案。所有读写方走同一套迁移（`agent/config.py` `normalize_settings`/`active_profile`、`agent/server.py` `_settings`/`_settings_get`/启动 resolve、`ui/llm-proxy.js` `readSettingsFile`、`ui/main.js` `settings:save` IPC）。POST 语义：`{profile_name?, provider, base_url, model, api_key?}` 保存+激活、`{activate: name}` 纯切换、`{delete: name}` 删除；**GET 永不回显 api_key**（只有 `has_api_key`）。

## 8. 仍需真机验证（本环境无法自动化）

1. 真实 SSH 端到端（两台机器：连远端 → 远端 supervisor 拉起 → 会话 → 跨机 .clc 409 → 心跳自愈 → 隧道断回本地）
2. degrade 真机（连无 Python 的主机，文件浏览器走 SSH 桥）
3. deb 打包安装（`bash scripts/release.sh` → `sudo dpkg -i` → 首窗拉起 + 退出自清理）
4. Electron 真实运行（`cd ui && npm start`，含 `CLUTCH_API_URL` 直连分支）
5. LLM 反代全链路（远端会话 → 8892 反向隧道 → 客户端 LLM）
