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
1. 安装依赖：pip install uv && uv sync
2. 设置密钥：export DEEPSEEK_API_KEY=你的key   （密钥仅经环境变量，不入库）
3. 启动产品界面：uv run python -m agent.server
   然后用浏览器打开 http://127.0.0.1:8890 （或运行 Electron 壳：ui/main.js）
4. 命令行模式：uv run python -m agent "任务描述" --verify "python3 file.py --test"
5. 跑内建演示：界面里点场景下拉「s2 landing」，再点 Run

特色功能
--------
· 事件流驱动架构：会话日志、界面、回放都从唯一事件流派生（借鉴 Claude Code / OpenHands）
· 验证门终止：模型说"完成了"不算数，必须通过确定性自测命令才判定成功
· 错误即数据：工具失败会喂回给模型，让它读错自纠、迭代修复
· 沙盒隔离：所有命令在临时目录内执行，路径校验防逃逸、超时防挂死
· Skills：按任务关键词动态注入领域知识（如 web-design），保持基础提示精简
· 多场景评测套件：scenarios/ 内置落地页 / 修 bug / 重构 三个场景，harness 可重复跑
· 产品化界面：任务输入 + 运行/停止 + 实时事件流 + 沙盒文件树预览 + 会话回放

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
  uv run python -m scenarios.harness   跑全部演示场景并记录结果

其它说明
--------
· 演示视频展示了 agent 为 clutch 自己做一个产品介绍页的全过程
· 真实开发过程见 git 提交历史（逐步 commit，保留完整轨迹）
· 安全：沙盒隔离 + 命令超时 + 输出截断 + 密钥仅环境变量
