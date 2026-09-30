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

## 零之二、进度（随施工更新）

| 阶段 | 状态 | 提交 | 实际交付 |
| --- | --- | --- | --- |
| P0 版本语义 | **已完成** | `42e6ee6` | 安装版本 = `<自报版本>+<摘要16>`；`ui/components.js:installVersion` |
| P1 只读可见 | **已完成** | `2c473f6`（含 `0b7229e` 的修正） | 通道 + 设置弹窗第二个标签 + 市场/已装两份清单 |
| P2 单向下发 | **已完成** | `8d11845` | 每行安装按钮 + 二次确认 + 进度 + 宿主裁定回显 + 装完重读清单 |
| P3 反向动词 | **宿主侧已完成**（P3a） | `90140ea` | `versions()` / `remove()` + `GET …/versions`、`DELETE …/<name>`；先停后删、非我启动的 daemon 拒绝；页面暂无按钮 |
| P4 工具集 | 未动工 | — | — |
| P5 静态索引 | 未动工 | — | — |

P2 的端到端实测（不是单测）：起一个**一次性** supervisor
（`CLUTCH_COMPONENTS_DIR=/tmp/… --port 8899`，空目录），用真的 `createComponentsView`
装 `clutch-workspace` → `status:"installed"`、版本 `0.1.0+31bc2b7c5f799e5b`、`GET
/api/components` 从空变一条、字节落到磁盘；**再装一次** → `status:"current"`，阶段序列
`artifact -> current`（没有 upload）。本机 8890 上的 supervisor 全程未动。

P3a 的端到端实测同上（另一个临时根）：`GET /api/components/versions?name=handmade` 报出
一条 `resolved:true`；`DELETE …?version=9.9.9` → 400 宿主原文；`DELETE …/handmade` →
`{"status":"removed","removed":["1.0.0"]}` 且目录消失；再来一次 → `{"status":"absent"}`；
`DELETE …/..%2F..%2Fetc` → 400 `bad component name`。8890 未动。

## 零之三、本轮新发现（P1/P2/P3 施工中得到）

1. **组件端点长在 supervisor 上，不在 session API 上**（最关键的一条）：
   `GET /api/components`（`agent/supervisor.py:233`）与 `POST /api/components/install`
   （`:292`）属于 supervisor 进程（本机 `127.0.0.1:8890`，远端 = 隧道的
   `tunnelStatus().url`）。**窗口的 session base 是另一个端口、另一个进程，对组件一无所知**。
   照 session base 去写这个页面会"看起来正确"——每个机器都显示"没有装任何组件"。所以：
   * 页面写入的 base 一律取 supervisor（`ui/components-view.js:45 target()`）；
   * "装到哪台机器"由**窗口的会话种类**决定（`ui/main.js:55` 把
     `hostCore.backendKind(wc.id)` 传进去）：会话在隧道对端 → 装对端；其余（包括隧道在线
     但窗口回退到本地会话的情形）→ 装本机；没有窗口也没有隧道 → 本机。
2. **supervisor 会空闲退出**：本机那个是 `--idle-timeout 25` 起的（见其命令行），空闲即退出，
   由 app 按需重启。于是"本机安装"在 supervisor 没在跑时会直接失败——页面能报出宿主的话，
   **但没有任何东西会为这次安装把它叫起来**（`ui/server-bootstrap.js` 全文没有 components）。
   这是 P2 未补上的已知缺口，留在"待办"里。
3. **Android 只做了表面齐平**：`ui/bridge-shim.js` 现在暴露 `clutchComponents`（手机端与桌面
   端 API 同名），但 `android/host/android-host.js` 没有任何 handler，所以手机上调用会以
   `no such bridge method: clutchComponents.list` 结束，标签页把它当一条错误画出来。
   真要在手机上用，得在 Android 宿主里实现同一组调用。
4. **本机已装版本还是旧形状**：实测 8890 上四条记录是 `59b12509b19c6759`、
   `c66bb70851a8e165`…，而当前检出算出来的 `clutch-workspace` 是
   `0.1.0+31bc2b7c5f799e5b`。两个事实：旧记录确实停留在裸摘要年代（`install()` 会清掉同组件
   其它版本，所以下次安装自然换名，不需要迁移脚本）；且模块检出在这之后**变过**
   （`82e974a` 那次 release 修复），所以现在点一次安装是**真的会写入新字节**，不是空跑。
5. **"谁在跑"只能靠散目录里的记录去数**：daemon 的记录名是**工作区根路径的哈希**
   （`rendezvous._record_path`），从名字复原不出工作区，所以"这个组件现在有没有进程在跑"
   只有一条路可问——列该组件自己的记录目录（`_record_dir()`，本轮从 `_record_path()` 里
   析出）。这也意味着一个**已经删掉记录**的活进程查不出来：记录是宿主唯一的名册，页面上
   的"有没有在跑"和实际进程之间存在这个窗口，P3b 做界面时必须知道。
   （顺带：今天表里只有 `clutch-workspace` 是 daemon，其余三个是 `cli`——一次性进程没有
   常驻 daemon，"先停后删"对它们恒为真。）
6. **拒绝必须发生在动手之前**：`remove()` 把"有没有在跑"作为调用方的 `stop` 回调接进来，
   并且**只在确实有东西可删时**才调用它——否则一次注定被拒的删除（比如版本号写错）
   会先把 daemon 杀掉再报错。同理，宿主对"名字不合法/版本没装"的判断在 `stop` 之前。
   活体与单测都钉住了这一条：被拒之后目录还在、进程还在。

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
  P0['P0 版本语义<br/>安装版本可读 ✅'] --> P1['P1 只读可见<br/>通道 + 标签页 ✅']
  P1 --> P2['P2 单向下发<br/>装到选定机器 ✅']
  P1 --> P3['P3 反向动词<br/>宿主端点先行']
  P2 --> P3
  P3 --> P4['P4 工具集<br/>interface data']
  P4 --> P5['P5 可选<br/>静态索引 / 私有源']
```

### P0 版本语义：一次安装的版本必须可读（**已完成**，`42e6ee6`）

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

### P1 只读可见（通道 + 标签页）（**已完成**，`2c473f6`）

- `ui/preload.js` 新增 `clutchComponents { list, market, install, onProgress }`；`ui/main.js`
  加 `components:*` handler，内部复用 `ui/components.js` 已有导出（`componentSpecs` :339、
  `hostInventory` :413）、新增的 `ui/components-view.js` 承载目标机/市场缓存/安装裁定。
- `ui/js/settings.js`（408 行、**无标签结构**）加标签；`ui/style.css` / `ui/mobile.css`
  **没有 tab 样式**，需新增；overlay 套件（`customSelect` / `notice` / `askConfirm` /
  `closeModal`）直接复用。渲染层是 **19 个经典脚本**，`ui/index.html` 的顺序就是契约
  （`tests/ui-load-order-test.js` 守）。
- 页面必须显示**来源错误**（`manifests()` `:155` 的 `errors` 是 data，不是异常）：否则用户
  看到空市场却不知道是网络问题。
- 本阶段**不画安装按钮**（I5）。
- 验收：开发态显示 4 个检出组件 + 4 条来源失败原因（`componentSpecs()` :340 "a
  contributor's edit beats a release"，本机不会真空）；连隧道后显示对端的 4 条已装记录。
  实测：19 个脚本装序通过；本机 8890 返回 4 条已装记录；4 条远端来源在本机全部失败（见第
  四节的网络约束），页面逐条画出原因而不是空市场。
- 一处修正（`0b7229e`）：读失败时 `held` 不能留成"空数组"——那会被画成"没有装任何组件"，
  与"读不到"混为一谈。失败一律 `held = null`。

### P2 单向下发（安装）（**已完成**，`8d11845`）

- 目标机语义**不复用** `#conn-select`：那个选择器描述的是"这个窗口连到哪台机器的会话"，而
  组件要送到**supervisor**（见零之三.1）。现在由窗口的会话种类推导（`backendKind`），页面
  只显示结果。
- 新增 `components:install`（走 `upload()` `:426`）与 `components:progress`；`askConfirm`
  二次确认，文案明说"**这个页面不能撤销它**"（I5）；市场行自带一行常驻警告，不只藏在弹窗里。
- 幂等来自宿主：`components.accept()` 的 `current()` 门 → `"current"`，重连不重传；客户端
  还先查一次清单，同版本同摘要**连上传都不发生**。
- 被拒时页面显示宿主给的 `error` **原文**，不转述。
- 本机手动安装入口已给（按钮在），**但缺口还在**：supervisor 没在跑时没有任何东西为这次
  安装把它叫起来（零之三.2）。
- 验收（单测）：`node tests/components-panel.test.js`（37 条）覆盖目标机规则、死按钮、确认
  文案、拒绝、`installed`/`current`/宿主原文、重读清单；实测见零之二。

### P3 反向动词（宿主侧先行）

**拆成 P3a（宿主侧，已完成，`90140ea`）与 P3b（页面上的反动词，未动工）。**

P3a 交付：

- `GET /api/components/versions?name=` → `{name, versions:[{name,version,interface,digest,path,
  resolved}]}`，**新→旧**排序（就是 `resolve()` 的选择依据），`resolved:true` 标出宿主真会启
  动的那一个；名字不合法 → 400（而不是空清单——空清单读起来像"没装"）。
- `DELETE /api/components/<name>[?version=]` → `{status:"removed", removed:[…]}` /
  `{status:"absent"}`；拒绝（名字不合法、`?version=` 没装、有非我启动的 daemon 在跑）→ 400
  带宿主原文。
- `components.versions()` / `components.remove()`；`_check_name()` / `_check_version()` 从
  `install()` 的内联判断提出来（名字就是路径片段，越权门与拼写规则是同一条规则）。
- **"先停后删"落地**：`remove()` 收一个调用方的 `stop` 回调（`rendezvous.stop_for_removal`），
  **只在确实有东西可删时调用**，返回拒绝句子就抛 `ValueError`；本进程启动的 daemon 先停
  （属主规则与 `release`/`_stop` 一致），**别人启动的**（`proc is None` 的收养句柄、或只在
  磁盘上有活记录）一律拒绝，并把 pid 写进句子——"磁盘上读到的 pid 不是开枪许可"。
- `rendezvous.live_daemons()` + `_record_dir()`（见零之三.5/6 的两条发现）。

**没做的（下一批，需要拍板）**：`disable`/`enable`、`prune`、页面上的反动词。`disable` 不是
加一个端点的事：宿主"停用了某组件"要影响 `inventory()`（清单里怎么报）与 `resolve()`（工具还
出不出、dev 检出要不要跟着失效），是一条会动到 registry 的改动，得先定语义。`prune` 目前意义
不大——`install()` 自己已经在清（`_prune`），一个组件目录正常只有一版。

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
node tests/components-panel.test.js               # 插件标签页：目标机、确认、裁定、重读（DOM 假件）
node tests/components-view.test.js                # 主进程插件后端：目标机/清单/市场缓存/安装裁定
node tests/ui-load-order-test.js                  # ui/index.html 的 19 个脚本装序
node tests/bridge-shim.test.js                    # 桌面端与手机端暴露同一组名字
node tests/components.test.js                      # 客户端 + 宿主端到端（自带 supervisor）
PYTHONPATH=. python3 tests/components_api_test.py  # 宿主侧安装/解析/门
PYTHONPATH=. python3 tests/rendezvous_test.py
PYTHONPATH=. python3 tests/tools_inst_test.py
```

手动活体检查（会真的写字节，务必指到一次性 supervisor 上）：

```bash
CLUTCH_COMPONENTS_DIR=/tmp/x PYTHONPATH=. python3 -m agent.supervisor --port 8899 --idle-timeout 900 &
curl -s http://127.0.0.1:8899/api/components          # 空
# 用 createComponentsView 指向 8899 装一次，再装一次（第二次必须是 current）
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

1. ~~**P1 是否单独交付**~~ → **已决**：P1 单独一个只读提交（画不出安装按钮就不涉及 I5），
   P2 同批紧跟（`8d11845`）。只读页面单独上线对用户价值低，但拆开让"什么时候开始能写"
   在历史里一目了然。
2. **旧记录**：是否强制重装以统一版本形状（`install()` 会清掉旧版本目录，所以代价只是一次
   上传），或让两种形状长期并存。
3. **索引仓库（P5）**：模块数 ≤4 时先不建。
4. ~~**`DELETE` 不带版本号是什么意思**~~ → **已决（P3a）**：整个组件一起拿掉（"卸载这个
   组件"就是这个意思），返回 `removed:[…]` 说明删掉了哪几版；本来就没装 → `absent`，**不是
   错误**（要求已经成立）。`?version=` 指向没装的版本 → 拒绝。
5. **停用（`disable`）怎么表示、表示成什么**：待拍板。两个方向——(a) 组件目录下一个标记文件
   （`<root>/<name>/.disabled`），(b) 把版本目录改名。选 (a) 还是 (b) 之前要先定**语义**：
   停用后 `inventory()` 报什么（仍列出 + `disabled:true`，还是干脆不列）、`resolve()` 要不要
   返回 None（工具就不出现）、以及一个 dev 检出在场时停用**是否也压得住检出回退**（不压住会
   出现"停用了但工具还在，因为跑的是检出"这种最坏组合）。这一条会动 registry，先定再写。

## 八、待办（本轮明确留着的缺口）

| # | 缺口 | 影响 | 想修的话落在哪 |
| --- | --- | --- | --- |
| G1 | 本机 supervisor 没在跑时，安装没有"先把它叫起来"这一步 | 本机第一次安装会以"supervisor 没回应"失败，用户得先让 app 启动它 | `ui/server-bootstrap.js`（现在全文无 components）或 `ui/components-view.js` 的 `install()` 前段 |
| G2 | Android 宿主没有 `clutchComponents` handler | 手机上插件标签页每条读取都是一行错误 | `android/host/android-host.js:78-107` 一带补同组调用 |
| G3 | 宿主没有反动词（卸载/停用/回滚） | 装上是单向的，页面只能靠文案诚实（I5） | **宿主侧已补（P3a `90140ea`）**：`versions()`/`remove()` + 两条端点；页面仍没有按钮（I5 目前因此成立），按钮在 P3b |
| G4 | `clutch-workspace/pyproject.toml` 0.2.0 与其 `component.json` 0.1.0 不一致 | 界面显示 0.1.0，包元数据说 0.2.0 | 模块仓库自身 |
| G5 | 纯声明包（`interface:"data"`）目前 400 | 工具集还递不进去 | P4 |
