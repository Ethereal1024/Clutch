clutch —— 从零手写的编程智能体
================================

Git 仓库：<你的 GitHub 仓库地址>

一句话
------
clutch 是一个自主编程智能体：给它一句话任务，它通过与大模型交互，自主读写文件、
执行命令、运行自测，直到验证门证明任务完成。全部核心从零手写，未使用任何 agent
框架（无 LangChain / AutoGen / Agents SDK 等），模型走 DeepSeek 的 OpenAI 兼容
tool-calling 接口。

如何运行
--------
前后端已解耦：后端是纯 API 服务，前端是独立的 Electron 程序（或任意静态托管），
两者通过 HTTP 通信。跨设备走 **SSH 隧道**（对齐 VSCode Remote）：客户端连到远端
后端，后端无需暴露端口、无需外网、无需 API key——客户端自己充当 LLM 反代。

**本机模式**
1. 安装依赖：pip install uv && uv sync  （前端另需：cd ui && npm install）
2. 设置密钥：export CLUTCH_API_KEY=你的key
3. 启动后端：uv run python -m agent.server   （绑定 127.0.0.1:8890）
4. 启动前端：cd ui && npm start   （或用 npm run dev 同时起前后端）
   - 注意：本机 electron 包为无 postinstall 的重打包版，首次运行会惰性下载二进制
     （走 ~/.npmrc 代理）；若因某种原因每次都触发 "Downloading Electron binary..."，
     是 path.txt 带了尾随换行——npm install 后 ui/ 的 postinstall 已自动修剪，
     可手动执行 node -e "require('fs').writeFileSync('node_modules/electron/path.txt','electron')"
5. 在欢迎界面用**文件浏览器**新建/打开项目（.clc 文件）后开始对话

**跨设备（两台机器）**
1. 远端：什么都不用装——客户端连接后会自动安装并启动服务器
2. 本机：cd ui && npm start，在「⚙ 设置」→ SSH 填入 host/user/port（可选填密码，
   或留空用本机 ~/.ssh 密钥 / ssh-agent）点 Connect
   —— 程序化 ssh2 隧道：密码在 App 内输入，无需终端；也可用密钥免密
   —— **自动安装**（对齐 VSCode Remote）：按远端环境自适应——
      远端有 python3 → 客户端按其 os/架构/libc/python 版本**下载对应 wheel 打包上传**
      （`PYTHONPATH` 直跑，**远端永不运行 pip/venv、无需外网**，跨平台亦然）；
      无 python3 且同架构 → 自包含二进制（PyInstaller 现构建）；
      其余极端环境 → 客户端 LLM 引导安装（模型在远端执行命令，装 python3/pip 并启动）
   —— 启动命令固定带 --base-url http://127.0.0.1:8892/v1（LLM 走客户端反代）
   —— 每次连接会追加写入 ~/.clutch/tunnel.log（含 host/user/port/明文密码与 ssh2
      协议跟踪，用于复现连接失败；开发期功能，发布前删除）
3. 欢迎界面的文件浏览器浏览的是**远端服务器**的文件系统

**直连局域网（可选，不推荐）**：--host 0.0.0.0 直接暴露 HTTP，无鉴权，仅可信
局域网内使用；此时后端需自行连接 LLM（设 CLUTCH_API_KEY 或 --base-url）。

桌面版（Linux deb）
------------------
打包定位：自包含的 Linux 发行版桌面应用。deb 内含 Electron GUI + 打包好的后端
二进制（PyInstaller onefile），安装后从应用菜单/命令行启动即用，目标机器**不需要
python/pip/网络**。

安装：
  sudo dpkg -i clutch-ui_<ver>_amd64.deb     # 或 apt install ./clutch-ui_<ver>_amd64.deb
  # 启动：应用菜单「Clutch」，或命令行 clutch
  # 后端由应用自动拉起（127.0.0.1:8890），退出应用时自动停止

行为细节：
  · 启动时自动探测 127.0.0.1:8890 是否已有健康后端：有则复用（如手动起的
    `uv run python -m agent.server`），没有则拉起 deb 内置的 agent-server
  · 设 CLUTCH_API_URL=http://host:port 指向自定义/远程后端时，应用不再管理本地
    后端（SSH 连接也走这条路径）
  · deb 内后端绑定构建机的 OS/架构/glibc 族（本机打包 = 本机即用；跨平台远端由
    SSH 自适应安装器处理）

构建 deb：
  一键：bash scripts/release.sh            # 图标 → 后端二进制 → deb
  单步：.venv/bin/python scripts/make-icon.py          # ui/build/icon.png + .svg
        bash scripts/build-server-bundle.sh <ver> dist/agent-server
        cd ui && npm run dist              # predist 自动校验 transport_defaults 一致性
  · 默认从 npmmirror 拉取 electron / electron-builder 工具（CN 网络友好），可用
    ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 覆盖
  · CI：推送 vX.Y.Z tag 自动构建 deb 并附加到 GitHub Release（见
    .github/workflows/release.yml）

独立评测工具（可选）：uv run python -m eval.harness，见 eval/

特色功能
--------
· 事件流驱动架构：会话日志、界面、回放都从唯一事件流派生（借鉴 Claude Code / OpenHands）
· 项目即文件（类似 PSD）：一个对话 = 一个 .clc 文件，工作目录 = 文件所在目录，
  打开项目即恢复整个对话；无集中会话管理，去中心化
· 验证门终止：任务可显式附带验证命令（如测试套件），模型说"完成了"不算数，
  必须通过该命令才判定成功；不提供则自然终止（对齐 Anthropic「给 agent 一个
  验证自己工作的方法」原则）
· 错误即数据：工具失败会喂回给模型，让它读错自纠、迭代修复
· 工作目录 + 权限确认（对齐 opencode）：agent 在项目目录里干活、产物直接落在那；
  危险操作（如 rm -rf、写项目目录外）会弹出确认框，由你决定放行或拒绝
· Skills：系统提示里列目录，模型按需用 load_skill 拉取领域知识（如 web-design），
  保持基础提示精简
· 独立评测工具：eval/ 内置落地页 / 修 bug / 重构 三个场景，harness 可重复跑
  （评测工具与产品解耦，产品不依赖它）
· 产品化界面：独立 Electron 前端（与后端解耦，可经 SSH 隧道跨设备运行，客户端自带
  LLM 反代让远端无需外网）+ 欢迎界面（服务器文件浏览器新建/打开项目）+ 任务输入 +
  运行/停止 + 实时流式输出（文本/思考流式渲染）+ 项目文件树预览

核心模块（题目必写 5 项一一对应）
--------------------------------
  agent/core/context.py     对话历史与上下文管理（事件日志派生 + 窗口/字符预算）
  agent/tools/              工具的定义与本地执行（read/write/list/run，poka-yoke）
  agent/core/parse.py       模型输出的解析（参数 JSON，错误即数据）
  agent/core/terminate.py   循环终止条件（验证门 + 轮数预算 + Doom-loop 检测）
  agent/core/errors.py      错误处理（归一化 + 分层回填）

测试
----
  uv run python -m agent.selfcheck     核心逻辑自检
  uv run python -m agent.loop_test     循环路径测试（假模型驱动，零成本）
  uv run python -m agent.server_test   HTTP+SSE 端到端测试
  uv run python -m eval.harness        跑全部评测场景并记录结果

其它说明
--------
· 演示视频展示了 agent 为 clutch 自己做一个产品介绍页的全过程
· 真实开发过程见 git 提交历史（逐步 commit，保留完整轨迹）
· 安全：工作目录内运行 + 命令超时 + 输出截断 + 路径逃逸防护 + 密钥仅环境变量
