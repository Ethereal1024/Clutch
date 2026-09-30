# 插件系统构筑计划（PLUGIN_PLAN.md）

本文件是组件**安装层**从"只在隧道路径上自动跑"扩成"可看见、可选择、可卸下、可装工具集"
的施工计划。契约本体在 `COMPONENTS.md`（声明、wire 协议、三种存在形态），本文件只写
**怎么一步步做到**，以及每一步的验收。

## 零、不变量（任何阶段不得违反）

| # | 不变量 | 现状依据 |
| --- | --- | --- |
| I1 | **发布归模块**：每个模块自己发 `clutch-component.json`，宿主只存 URL 来源 | `ui/components.sources.json`（4 行）、`components.sources()` `ui/components.js:94` |
| I2 | **宿主零字节**：宿主发行包不含 `components/` | `shippedArtifact()` `ui/components.js:174` |
| I3 | **声明说词、宿主释义**：能力词汇（access / gate / mode）归宿主 | `agent/tools/gates.py:1-20`（导入期 `_check_vocabulary` 断言） |
| I4 | **不自建分发服务器**：分发=各模块 Release，索引=静态 JSON，安装=目标机 supervisor | 见本文件第六节 |
| I5 | **不可撤销的动作不得在界面上伪装成可撤销** | 卸载端点不存在之前，页面不画卸载按钮 |

## 一、目标与非目标

**目标**：设置弹窗第二个标签"插件"；市场清单 + 已装清单（版本**人类可读**）；一键安装到
当前选定的机器（本机 / 隧道对端），带进度与宿主裁定；可卸载 / 停用 / 回滚；"工具集"
（工具声明 + 模式名 + 提示词）成为可安装包，`chat` / `work` 降级为内建工具集。

**非目标**：账号体系、付费、下载统计、评分评论；中心化发布 API（与 I1 冲突）；组件间依赖
求解（第一版只做"缺谁就说缺谁"）；插件沙箱隔离（插件仍以宿主权限运行，独立议题）。

## 二、要修掉的四个断点

| # | 断点 | 证据 | 目标形态 |
| --- | --- | --- | --- |
| 1 | 渲染层无通道 | `ui/preload.js:5,14,20`；`ui/main.js:128-163`（五个 handler，无组件面） | 新增 `clutchComponents` IPC |
| 2 | 只有读 + 一个无反动词的写 | `agent/supervisor.py:233,292`；`agent/` 内 `uninstall` 零命中 | 卸载/停用/启用/prune/版本列表 |
| 3 | 安装版本是裸摘要前缀 | `ui/components.js:373,386`（`version: digest.slice(0,16)`） | `<声明版本>+<摘要16>`（宿主 `_VERSION_RE` 已认这个形状） |
| 4 | 纯声明包递不进去 | `agent/supervisor.py:257-259` 空 body → 400；`INTERFACES = ("daemon","cli")` `agent/tools/components.py:78` | `interface: "data"`（**并入 P4**，理由见下） |

## 三、阶段

```mermaid
flowchart LR
  P0['P0 版本语义<br/>安装版本可读'] --> P1['P1 只读可见<br/>通道 + 标签页']
  P1 --> P2['P2 单向下发<br/>装到选定机器']
  P1 --> P3['P3 反向动词<br/>宿主端点先行']
  P2 --> P3
  P3 --> P4['P4 工具集<br/>interface data']
  P4 --> P5['P5 可选<br/>静态索引 / 私有源']
```

### P0 版本语义：一次安装的版本必须可读（**本轮已动工**）

问题：客户端把 `version` 写成 `digest.slice(0, 16)`（`ui/components.js:373,386`），于是宿主
清单里只有 `5f900739e6a35f43` 这样的十六进制——**能列出组件，说不出它是哪个发行版**，升级
与回滚也就无从问起。

改法：安装版本 = 组件**自报版本** + 内容摘要，即 `0.1.0+<digest16>`。这不是新协议：宿主
正则早就认这个形状（`agent/tools/components.py:74-75`："The version may carry a content
digest (`0.2.0+<hex>`)"），`COMPONENTS.md` 第 79 行同样写着"安装版可携带内容摘要"。

- 落点：`ui/components.js` 的 `installVersion()`，两个分支（检出工件、发布工件）都用它。
- **没有版本可说的 spec**（裸 `{name, interface}`，测试里就是这个形态）仍只发摘要前缀：
  身份就是它拥有的全部，编一个版本反而是无法兑现的声明。
- 迁移：宿主 `install()` 落地时会清掉同组件其它版本（`COMPONENTS.md` 第 310 行"原子落地"），
  所以旧机器下一次安装会自然换成带版本的目录名，**不需要**任何额外迁移步骤。
- 验收：`node tests/components.test.js` 全绿，并新增"落地目录名 = 自报版本 + 摘要16"、
  "宿主清单把该版本回报给客户端"两条断言；`tests/components_api_test.py` 补一条宿主侧
  用例（复合版本是合法路径名）。

### P1 只读可见（通道 + 标签页）

- `ui/preload.js` 新增 `clutchComponents { list, market, onProgress }`；`ui/main.js` 加
  `components:*` handler，内部复用 `ui/components.js` 已有导出（`componentSpecs` :339、
  `hostInventory` :391）。
- `ui/js/settings.js`（408 行、**无标签结构**）加标签；`ui/style.css` / `ui/mobile.css`
  **没有 tab 样式**，需新增；overlay 套件（`customSelect` / `notice` / `askConfirm` /
  `closeModal`）直接复用。
- 页面必须显示**来源错误**（`manifests()` `:155` 的 `errors` 是 data，不是异常）：否则用户
  看到空市场却不知道是网络问题。
- 本阶段**不画安装按钮**（I5）。
- 验收：开发态显示 4 个检出组件 + 4 条来源失败原因（`componentSpecs()` :340 "a
  contributor's edit beats a release"，本机不会真空）；连隧道后显示对端的 4 条已装记录。

### P2 单向下发（安装）

- 目标机语义复用 `ui/js/conn-store.js` 的 `#conn-select` / `#conn-status`。
- 新增 `components:install`（走 `upload()` `:404`）与 `components:progress`；`askConfirm`
  二次确认（装到远端**不可撤销**）。
- 幂等来自宿主：`components.accept()` 的 `current()` 门 → `"current"`，重连不重传。
- 顺带补上已知缺口：本机手动安装入口（`ui/server-bootstrap.js` 全文无 components，自动
  pass 以后再说，先给人类一个按钮）。
- 验收：远端安装后 `GET /api/components` 变化；重复安装返回 `current`；被拒时页面显示宿主
  给的 `error` 原文。

### P3 反向动词（宿主侧先行）

- 新端点：`DELETE /api/components/<name>[?version=]`、`POST /api/components/{disable,enable}`、
  `POST /api/components/prune`、`GET /api/components/versions?name=`。
- `agent/tools/components.py` 新增 `remove()` / `versions()`；把内部 `_prune()` `:422` 变成
  有端点的操作。裁定模型不变：**卸载也返回 verdict 与理由**。
- 风险：删掉正在运行组件的 daemon（pid/record 握手在 `agent/tools/rendezvous.py`）→ 必须
  "先停后删"，对被别人启动的 daemon 按既有 fence 规则拒绝。

### P4 工具集（`interface: "data"`）

- **不是一行常量**：`catalog.py:553` 在声明层就拒绝未知 interface（`interface not in
  (DAEMON, CLI)` → 拒绝），`rendezvous.render_launch()` 只为 daemon/cli 产出 argv，
  `facts.py:93` 规定只有 cli 组件能发布宿主事实。所以 `data` 需要一条"无进程"通路：
  声明可读即可驱，不解析 launch、不启动进程。
- 契约形状（草案）：`{schema:1, name, interface:"data", version, tools:[…声明…], mode:"<名>",
  prompt:"PROMPT.md"}`。
- **动态模式集**：`catalog.MODES` 是常量元组（`agent/tools/catalog.py:212`），要变成"内建 +
  组件声明"；`registry.py:263` 的过滤、`config.py:97` 的 `mode`、`agent/api/run.py:29-31`
  的模式白名单随之放宽。
- **提示词**：`agent/core/context.py` 现在追加固定文件 `agent/prompts/mode_*.md`；工具集自带
  片段。可复用 `agent/tools/prompt.py:53` 的占位符机制（`$config.<field>` / `$backends` /
  宿主事实，整行 `$skills` 展开成块）。
- **降级**：工具集引用了未安装组件提供的工具时，该工具不出现（`registry` 既有逐条过滤），
  并说明"缺谁"——先例是 `prompt.components_unavailable()` `:102`。
- 保留 `chat` / `work` 为内建工具集，不删。

### P5 可选：静态索引与私有源

- **索引**：market 仓库里的静态 `index.json`（搜索/分类/精选），页面读它做展示，**权威仍是
  各模块的 manifest**；零服务器。
- **私有源**：`downloadPinned()` `:270` 与 `readManifest()` `:137` 的 `fetch(url, {signal})`
  **不带任何 header**，要支持 token 必须改；来源项从字符串扩成对象时保持 `readSourceList()`
  `:78` 的 `schema: 1` 兼容。
- **撤销**：签名过的静态撤销列表（可选）。

## 四、验证

```bash
node tests/components.test.js                      # 客户端 + 宿主端到端（自带 supervisor）
PYTHONPATH=. python3 tests/components_api_test.py  # 宿主侧安装/解析/门
PYTHONPATH=. python3 tests/rendezvous_test.py
PYTHONPATH=. python3 tests/tools_inst_test.py
```

本机网络约束（硬条件）：`github.com` 的 HTTPS 不通（curl 28），`api.github.com` 可达。所以
任何"从 Release 下载"的用法都必须有**本地目录 source** 的对照（`isRemote()` `:105` 为假时
直接读文件），发布物只能用 `api.github.com` 的资产接口验证。

## 五、风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 不可撤销的远端写入 | 装到别人的机器上，今天没有卸载 | P2 二次确认；P3 尽快补反动词 |
| 版本语义断层 | 新旧两种"版本"形状并存 | P0 先统一；宿主落地自带清理，无需迁移脚本 |
| 越权 | 工具集想让宿主执行它定义的行为 | 守 I3：只能引用宿主词汇，导入期断言会大声报错 |
| 动态模式爆炸半径 | P4 改的是"模型看得到哪些工具" | 模式仍由宿主裁定（`registry.py:263` 的过滤保留），`chat` 语义不因插件变松 |
| 生态空转 | 有页面没插件 | 先跑通 4 个自家模块 + 一个工具集样本，再谈索引 |

## 六、为什么不需要自建服务器

- 分发：sha256 钉死（`pinnedAsset()` `ui/components.js:296`）⇒ 托管方不可信也安全；asset
  相对 source（`assetLocation()` `:112`）⇒ 换托管零成本。
- 发现：来源列表是数据文件（`:78`），第 5 个模块 = 多一行 URL，宿主零代码改动。
- 安装：`POST /api/components/install` 长在**目标机**的 supervisor 上，没有账号、配额、
  每机器注册表。
- 只有"账号 / 付费 / 统计 / 集中发布"才逼出服务器，而每一项都与 I1 / I2 冲突，需单独决策。

## 七、待拍板

1. **P1 是否单独交付**：建议 P1+P2 合并（只读页面对用户价值低，安装端点已存在，风险由确认
   框兜住）。
2. **旧记录**：是否强制重装以统一版本形状（`install()` 会清掉旧版本目录，所以代价只是一次
   上传），或让两种形状长期并存。
3. **索引仓库（P5）**：模块数 ≤4 时先不建。
