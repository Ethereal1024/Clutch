# 插件系统构筑计划（PLUGIN_PLAN.md）

本文件是组件**安装层**从"只在隧道路径上自动跑"扩成"可看见、可选择、可卸下、可装工具集"
的施工计划。契约本体在 `COMPONENTS.md`（声明、wire 协议、三种存在形态），本文件只写
**怎么一步步做到**，以及每一步的验收。

## 零、不变量（任何阶段不得违反）

| # | 不变量 | 现状依据 |
| --- | --- | --- |
| I1 | **发布归模块**：每个模块自己发 `clutch-component.json`，宿主只存 URL 来源 | `ui/components.sources.json`（4 行）、`components.sources()` `ui/components.js:107` |
| I2 | **宿主零字节**：宿主发行包不含 `components/` | `shippedArtifact()` `ui/components.js:187` |
| I3 | **声明说词、宿主释义**：能力词汇（access / gate / mode）归宿主 | `agent/tools/gates.py:1-20`（导入期 `_check_vocabulary` 断言） |
| I4 | **不自建分发服务器**：分发=各模块 Release，索引=静态 JSON，安装=目标机 supervisor | 见本文件第六节 |
| I5 | **不可撤销的动作不得在界面上伪装成可撤销** | P3b 之前靠"缺席"成立（没有卸载端点就不画卸载按钮）；P3b 给了按钮，从此靠**文案**成立：安装确认说"a removal DELETES bytes…neither act is a rollback"（`ui/js/components-panel.js:435`），卸载确认说"This cannot be undone from here"（`:365`），市场常驻警告说"neither is a rollback"（`:485`）。P3c 补上第三条写入后，同一条界线依然清楚：**停用开关是协议里唯一不要求确认的写入**——它一个字节都不删，**按钮标签本身就是撤销路径**（§一、§零之四.2） |

## 零之二、进度（随施工更新）

| 阶段 | 状态 | 提交 | 实际交付 |
| --- | --- | --- | --- |
| P0 版本语义 | **已完成** | `42e6ee6` | 安装版本 = `<自报版本>+<摘要16>`；`ui/components.js:installVersion` |
| P1 只读可见 | **已完成** | `2c473f6`（含 `0b7229e` 的修正） | 通道 + 设置弹窗第二个标签 + 市场/已装两份清单 |
| P2 单向下发 | **已完成** | `8d11845` | 每行安装按钮 + 二次确认 + 进度 + 宿主裁定回显 + 装完重读清单 |
| P3a 反向动词（宿主侧） | **已完成** | `90140ea` | `versions()` / `remove()` + `GET …/versions`、`DELETE …/<name>`；先停后删、非我启动的 daemon 拒绝 |
| P3b 反向动词（页面） | **已完成** | `11f6ce4` | 每行卸载按钮 + 二次确认 + 宿主裁定回显（`removed`/`absent`/拒绝原文）+ 装完/卸完重读清单；I5 改由文案承担 |
| P3c 停用/启用 | **已完成** | `9f53b9c`（宿主）+ `1df203d`（页面） | 登记表 `<components 根>/registry.json` 承载组件级 `disabled` 位；`POST /api/components/<name>/disable`、`…/enable`；`GET /api/components` 多带 `disabled`；页面每行一个开关（**不确认**，标签即撤销），停用行仍列出、仍可卸载 |
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

P3b 的端到端实测（再一个临时根、另一个端口）：真 `checkoutComponents()` → `artifactFor()` →
`upload()` 装上 `clutch-workspace`（`0.1.0+31bc2b7c5f799e5b`）→ `view.versions()` 读回同一条
`resolved:true` → `view.remove()` 报 `removed:["0.1.0+31bc2b7c5f799e5b"]` 且目录**真的消失**
→ 再 `remove()` → `absent`、清单空 → `view.versions("../../etc")` → `bad component name`。
全程只压到一次性 supervisor（端口独立），8890 / 78979 未动。

P3c 的端到端实测：`node tests/components.test.js` 第 9 节对着一个一次性 supervisor 跑
`hostSetDisabled()`——`{"status":"disabled","name":…,"disabled":true}`、清单**仍然列出**它
（`disabled:true`，版本与摘要一个字不动）、版本目录**还在磁盘上**、`versions()` 仍是那一条 →
再 `enable` → `{"status":"enabled","disabled":false}`；问一个这台机器没有的名字 → `absent`
（**答案**，不是错误）；`../../etc` → 400 宿主原文。宿主侧 `tests/rendezvous_test.py` 的
`_disabled_probe()` 另钉住两件只有单测能钉的事：停用之后 `unavailable_reason()` 报出宿主
自己的句子（`<name> is disabled on this host (its tools are off; the bytes stay)`），而且
**dev 检出也顶不上来**（把 `clutch-workspace` 的工件目录删掉，`resolve()` 照样找得到仓库旁
那份检出，但停用位在它之前说话，工具不出现）。页面侧 17–24 节覆盖开关的三种写法与三条纪律
（见下）。

## 零之三、本轮新发现（P1/P2/P3 施工中得到；P3c 的两条是 7、8）

1. **组件端点长在 supervisor 上，不在 session API 上**（最关键的一条）：
   `GET /api/components`（`agent/supervisor.py:255`）与 `POST /api/components/install`
   （`:360`）属于 supervisor 进程（本机 `127.0.0.1:8890`，远端 = 隧道的
   `tunnelStatus().url`）。**窗口的 session base 是另一个端口、另一个进程，对组件一无所知**。
   照 session base 去写这个页面会"看起来正确"——每个机器都显示"没有装任何组件"。所以：
   * 页面写入的 base 一律取 supervisor（`ui/components-view.js:46 target()`）；
   * "装到哪台机器"由**窗口的会话种类**决定（`ui/main.js:58` 把
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
7. **停用位住在目标机的表里，而且必须比"检出"更早说话**：`disabled` 的意思是"这台机器不驱动
   它"，所以它属于**持有组件的那台机器**（登记表 `registry.json`，与安装记录同一张表）。
   VS Code 把同一个位记在**客户端**（`extensionsIdentifiers/disabled` / `…enabled`，写进
   `IStorageService` 的 `StorageScope.PROFILE` + `StorageTarget.MACHINE`，
   `workbench/services/extensionManagement/common/extensionManagement.ts:645-646`），因为它的
   客户端自己握着已装清单；Clutch **没有客户端侧清单**（零之四.3），照抄会让第二个客户端看到
   假的"在驱动"。落点之外还有**顺序**：拦截必须在解析**之后**、交付**之前**
   （`rendezvous.unavailable_reason()`，`agent/tools/rendezvous.py:255-267`），否则开发机上
   "停用了"却因为仓库旁的检出在场而照样把工具递给模型——最坏组合是"页面说停了，工具还在"。
   `reindex()` 是唯一的例外：重建**忘掉 `disabled`**（磁盘上没有这个形状），重建后要重新停。
8. **一个只有活体才看得见的一次性 Bug（`9f53b9c` 修掉）**：supervisor 的两条路由把**反的
   极性**传给了 `components.set_disabled`，于是 `/disable` 实际上在"重新驱动"。它藏得住是因为
   参数名原来叫 `state`——两个方向读起来都对——而单测只钉了组件层（`set_disabled` 本身没错），
   一直到把两条路由都对着真 supervisor 各跑一次才暴露。现在参数一律叫 `disabled`（**表里存的
   那个位**），每条路由传自己那个词的**含义**：`/disable` → True、`/enable` → False
   （`agent/supervisor.py:362-390`）。教训与零之三.6 同类：**名字和动词是两条独立的信息，
   极性错位的时候两边都读得通**。

## 零之四、已冻结的五个决定（本轮拍板，施工据此）

1. **命令式，不共享状态**：页面只**发命令**（安装 / 卸载 / 停用 / 启用），**单一写者 = 持有
   那个目录的机器上的 supervisor**。所以这个页面始终是某台机器的客户端，从不是第二个登记处
   ——两份状态就没有"以谁为准"的问题。
2. **`disabled` 是每台机器各自的**：同一组件在 A 机停用、在 B 机照跑，两边互不知道；问谁就以
   谁为准。停用不是删除：字节不动、行还在、仍可卸载，而且**不要求确认**（I5 只约束撤不回来
   的动作，它的标签本身就是撤销路径）。
3. **手机端不镜像远端的表**：页面**没有任何远端清单缓存**，每问一次就发一次请求
   （`hostInventory()` `ui/components.js:450` / `hostVersions()` `:459`）。清单是机器的判断
   （哪一版会赢、哪一版被停），客户端存一份就成了"第二份真相"，而且会把"读不到"画成"没有"。
4. **字节默认由目标机自己取，手机端的 `upload()` 只是兜底**（`ui/components.js:490`）：manifest
   带着声明与钉死的摘要，目标机本来就能自己去 source 取（`pinnedAsset()` `:309` /
   `downloadPinned()` `:283`）。**这一条已冻结，实现留作下一批**：现在的写入路径仍是客户端把
   字节送上去（`POST /api/components/install` 空 body → 400，`agent/supervisor.py:288`），
   换成"目标机自取"要动安装端点与页面两侧。
5. **注册表位置 / G1 / G2 / G4 一律"按照 VS Code 的逻辑来"**：结论落在第八节各行——G1 = 由
   目标机自己的二进制按需起服务（VS Code 的 `cli/src/tunnels/code_server.rs:322-350`）、
   G2 = 目标端注册同一个通道（`src/vs/server/node/serverServices.ts:403-409`）、G4 = 版本一致性
   是模块仓库自己的事。

## 一、目标与非目标

**目标**：设置弹窗第二个标签"插件"；市场清单 + 已装清单（版本**人类可读**）；一键安装到
当前选定的机器（本机 / 隧道对端），带进度与宿主裁定；可卸载 / 停用 / 启用；"工具集"
（工具声明 + 模式名 + 提示词）成为可安装包，`chat` / `work` 降级为内建工具集。

**没有回滚这个功能**：安装覆盖写、卸载删字节，两个方向都撤不回来；回到旧版的路就是**再装一次**
别的那一版（宿主 `install()` 落地时会清掉同组件其它版本，所以"回去"就是一次正常安装）。界面
因此不画"回滚"，也不需要假装手里有一份能回到过去的副本（I5）。

**非目标**：账号体系、付费、下载统计、评分评论；中心化发布 API（与 I1 冲突）；组件间依赖
求解（第一版只做"缺谁就说缺谁"）；插件沙箱隔离（插件仍以宿主权限运行，独立议题）。

## 二、当初要修掉的四个断点（每行附今天的现状）

| # | 断点 | 证据 | 目标形态 |
| --- | --- | --- | --- |
| 1 | 渲染层无通道 | `ui/preload.js:25`（`clutchComponents` 全无）；`ui/main.js:173-190`（`components:*` 的 handler 全无） | 新增 `clutchComponents` IPC —— **已交付**（P1 起，P3b/P3c 各加动词，今天是六个 + 一个 `onProgress`） |
| 2 | 只有读 + 一个无反动词的写 | `agent/supervisor.py:255,360`（清单 + 装上）；`agent/` 内 `uninstall` 零命中 | 卸载 / 停用 / 启用 / 版本列表 —— **已交付**（`90140ea`、`9f53b9c`）；**prune 未做**（`install()` 自己就在清，见 P3 末） |
| 3 | 安装版本是裸摘要前缀 | `ui/components.js:386-387`（`version: digest.slice(0,16)`） | `<声明版本>+<摘要16>`（宿主 `_VERSION_RE` 已认这个形状，`agent/tools/components.py:112`） |
| 4 | 纯声明包递不进去 | `agent/supervisor.py:288` 空 body → 400；`INTERFACES = ("daemon","cli")` `agent/tools/components.py:133` | `interface: "data"`（**并入 P4**，理由见下） |

## 三、阶段

```mermaid
flowchart LR
  P0['P0 版本语义<br/>安装版本可读 ✅'] --> P1['P1 只读可见<br/>通道 + 标签页 ✅']
  P1 --> P2['P2 单向下发<br/>装到选定机器 ✅']
  P1 --> P3['P3 反向动词<br/>卸载已通 ✅']
  P2 --> P3
  P3 --> P3c['P3c 停用/启用<br/>留着但不驱动 ✅']
  P3c --> P4['P4 工具集<br/>interface data']
  P4 --> P5['P5 可选<br/>静态索引 / 私有源']
```

### P0 版本语义：一次安装的版本必须可读（**已完成**，`42e6ee6`）

问题：客户端把 `version` 写成 `digest.slice(0, 16)`（`ui/components.js:386-387`），于是宿主
清单里只有 `5f900739e6a35f43` 这样的十六进制——**能列出组件，说不出它是哪个发行版**，升级
与退回也就无从问起。

改法：安装版本 = 组件**自报版本** + 内容摘要，即 `0.1.0+<digest16>`。这不是新协议：宿主
正则早就认这个形状（`agent/tools/components.py:110`："…content digest (`0.2.0+<hex>`),
which is how the client's install gate works"），`COMPONENTS.md` 第 80 行同样写着"安装版可
携带内容摘要"。

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
  加 `components:*` handler，内部复用 `ui/components.js` 已有导出（`componentSpecs` :352、
  `hostInventory` :450）、新增的 `ui/components-view.js` 承载目标机/市场缓存/安装裁定。
- `ui/js/settings.js`（408 行、**无标签结构**）加标签；`ui/style.css` / `ui/mobile.css`
  **没有 tab 样式**，需新增；overlay 套件（`customSelect` / `notice` / `askConfirm` /
  `closeModal`）直接复用。渲染层是 **19 个经典脚本**，`ui/index.html` 的顺序就是契约
  （`tests/ui-load-order-test.js` 守）。
- 页面必须显示**来源错误**（`manifests()` `:168` 的 `errors` 是 data，不是异常）：否则用户
  看到空市场却不知道是网络问题。
- 本阶段**不画安装按钮**（I5）。
- 验收：开发态显示 4 个检出组件 + 4 条来源失败原因（`componentSpecs()` :352 "a
  contributor's edit beats a release"，本机不会真空）；连隧道后显示对端的 4 条已装记录。
  实测：19 个脚本装序通过；本机 8890 返回 4 条已装记录；4 条远端来源在本机全部失败（见第
  四节的网络约束），页面逐条画出原因而不是空市场。
- 一处修正（`0b7229e`）：读失败时 `held` 不能留成"空数组"——那会被画成"没有装任何组件"，
  与"读不到"混为一谈。失败一律 `held = null`。

### P2 单向下发（安装）（**已完成**，`8d11845`）

- 目标机语义**不复用** `#conn-select`：那个选择器描述的是"这个窗口连到哪台机器的会话"，而
  组件要送到**supervisor**（见零之三.1）。现在由窗口的会话种类推导（`backendKind`），页面
  只显示结果。
- 新增 `components:install`（走 `upload()` `:490`）与 `components:progress`；`askConfirm`
  二次确认，文案明说"**这个页面不能撤销它**"（I5）；市场行自带一行常驻警告，不只藏在弹窗里。
- 幂等来自宿主：`components.accept()` 的 `current()` 门 → `"current"`，重连不重传；客户端
  还先查一次清单，同版本同摘要**连上传都不发生**。
- 被拒时页面显示宿主给的 `error` **原文**，不转述。
- 本机手动安装入口已给（按钮在），**但缺口还在**：supervisor 没在跑时没有任何东西为这次
  安装把它叫起来（零之三.2、第八节 G1）。
- 验收（单测）：`node tests/components-panel.test.js` 覆盖目标机规则、死按钮、确认
  文案、拒绝、`installed`/`current`/宿主原文、重读清单；实测见零之二。

### P3 反向动词（**三头已通**：宿主 `90140ea` + `9f53b9c`、页面 `11f6ce4` + `1df203d`）

**拆成 P3a（宿主侧的反动词，`90140ea`）、P3b（页面上的反动词，`11f6ce4`）与 P3c（停用/启用，
两头一起，`9f53b9c` + `1df203d`），三段都已完成。**

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

P3b 交付（`11f6ce4`）：

- 通道只加两个动词：`ui/components.js` 的 `hostVersions(base,name)`（`GET …/versions`）与
  `hostRemove(base,name,version)`（`DELETE …/<name>[?version=]`）；两者共用新的
  `hostJSON(url,{method,timeoutMs})`——宿主的 `{"error":…}` 直接变成抛出的句子（"谁在跑它"
  这类拒绝，页面**必须能原文引用**，一个裸状态码会让它自己猜）。
- `ui/components-view.js` 的 `versions(name,win)` / `remove(name,{version},win)`：先解目标机，
  解不出来是**答案**不是异常；失败装在结果里（`{ok:false,error}`），所以"这台机器一版都没有"
  和"这台机器问不到"绝不会画成同一幅空图。`remove()` 原样带出宿主的三种形状。
- 页面：每条已装行一个 Remove 控件（`ui/js/components-panel.js:168`），**没有 supervisor URL
  时它是死的**（哪台机器会掉字节是最不能猜的事），**任何写入在飞时它也是死的**——`busy` 现在
  带 `verb`，两个方向共用"一次只准一个写入"。
- 删除前先问（`:275`）：问题点名版本与机器，说清"连同这台机器持有的其它版本一起删"，并说最难
  的那句——**这里撤不回来，本页不留副本，要拿回来只能再装一次**。
- 裁定回显（`:262`）：`removed <name> <versions> from <where>` / `<name> was not installed on
  <where> — there was nothing to remove`（`absent` 是答案不是错误）/ 拒绝原文。
- **I5 从"靠缺席"改成"靠文案"**（见不变量表 I5 行）：按钮既然有了，就不能再靠不画它成立。

验收（单测 + 实测）：`node tests/components-panel.test.js` 新增 9–15 节（每行控件与 title、
先问再删且拒绝就什么都不删、成功回显点名删掉的版本、`absent` 画成答案、拒绝原文连 pid 一起
引用且控件复位、两个方向共用"一次一个写入"、目标机没有 supervisor URL 时控件是死的并给出
原因）；`tests/components-view.test.js` 7–8 节（版本读取、宿主顺序与 `resolved`、失败报成原因
而不是"没有版本"、三种卸载裁定、带了版本号就问那一版）；`tests/components.test.js` 9 节对着
真 supervisor 跑 `hostVersions()`/`hostRemove()`（改盘之后再读清单为空、第二次删是 `absent`、
坏名字 400）。实测见零之二末段。

**没做的（下一批，需要拍板）**：`prune`、页面上的"版本明细"视图。`prune` 目前意义
不大——`install()` 自己已经在清（`_prune`），一个组件目录正常只有一版。

### P3c 第三条写入：留着，但不驱动（**已完成**，宿主 `9f53b9c` / 页面 `1df203d`）

**这一段的语义先拍板、再写代码**（零之四.1/2/3）：`disabled` 是**每台机器各自**的事实，住在
**持有组件那台机器的登记表**里，客户端不留副本。所以它不是"加一个端点"，而是一条新的写入
路径，落点、顺序、界面三处都得跟着定。

宿主（`9f53b9c`）：

- **落点是登记表**：`<components 根>/registry.json` 每条记录多一个组件级 `disabled`
  （`agent/tools/components.py:83-86`），与安装事实同一张表、同一个写者（`_TABLE_LOCK`），
  于是"这台机器驱动什么"只有一个答案者。它**不落进组件目录**：登记表是"有什么"的唯一名册
  ——表里有就是有，一个没有表项的目录不是组件（`reindex()` 是唯一的重建入口）。
- **两条路由**：`POST /api/components/<name>/disable` / `…/enable`（`agent/supervisor.py:362-365`）
  → `{"status":"disabled"|"enabled","name":…,"disabled":bool}`；这台机器根本没有它 →
  `{"status":"absent"}`（**答案**，不是错误：要求已经成立）；名字不合法/穿越 → 400 宿主原文；
  只发一个开关而不点名（`/api/components/disable`）→ 404（不是"叫空名字的组件"）。
- **`disabled` 只抑制工具**：字节一个不动、清单照列（多带 `disabled:true`）、`versions()` 照报、
  `DELETE` 照能删、重复停用/启用幂等。拦截点故意在**解析之后、交付之前**
  （`rendezvous.unavailable_reason()`），于是 **dev 检出也递不上替身**（零之三.7）。装新版本时
  这个位**跟着组件过去**，换版本不会偷偷把机器重新驱动起来。
- **`reindex()` 忘掉这个位**（磁盘上没有这个形状）：重建的语义是"重新相信磁盘"，所以重建之后
  要重新停一次——这是这台机器上唯一会"自己恢复驱动"的路径，写在文档里而不是藏起来。

页面（`1df203d`）：

- 客户端出去的**是状态、不是动词**：`ui/components.js` 的 `hostSetDisabled(base,name,disabled)`
  （`:485`）按位选 `/disable` 与 `/enable`；`ui/main.js:186` 的 `components:set-disabled`、
  `ui/preload.js:31` 与 `ui/bridge-shim.js:116` 同名同参（`tests/bridge-shim.test.js` 自动钉住这
  条平价）。`ui/components-view.js:254` 的 `setDisabled()` 先解目标机，失败装在结果里。
- 页面：持有但停用的行，在版本号之后多一个 `stopped` 标记 + 一句 "held on this machine, but not
  driven"，动作变成**开关 + 卸载**（`ui/js/components-panel.js:146-176`）。开关**不弹确认**——
  它一个字节都不删、**标签本身就是撤销路径**（I5）；三种死法都要说得出原因（没有目标机的
  supervisor URL、这个 shell 没有这个动词、另一个写入正在飞，`plugBusyWord` `:178`）。
- 一个只在活体里露头的 Bug 随这条一起修掉（零之三.8）：supervisor 路由曾把**反的极性**传给
  `components.set_disabled`，`/disable` 实际在"重新驱动"；参数名改叫 `disabled` 之后消失。

验收（单测 + 实测）：`node tests/components-panel.test.js` 17–24 节（开关出现在持有它的那一行、
title 说的是机器与"字节不动"、停用行有标记与那句话且**仍可卸载**、开关**不问**、线上走的是
状态、`absent` 画成答案、拒绝引原文、一次只准一个写入、没有目标机 URL / 没有那个动词时不画活
控件）；`tests/components-view.test.js` 9 节（状态出去、宿主的位回来、缺 `disabled` 时的兜底、
`absent`、拒绝原文、目标机解不出来则**从不发请求**）；`tests/components.test.js` 9 节对着真
supervisor 跑 `hostSetDisabled()`（清单仍在、目录仍在、版本仍是那一条）；宿主侧
`tests/rendezvous_test.py` 的 `_disabled_probe()`（句子、清单、检出顶不上来、启用后回到原样）与
`tests/components_api_test.py`（两条路由、`absent`、坏名字 400、裸开关 404）。实测见零之二末段。

**还没做的（下一批）**：`prune`、页面上的"版本明细"视图、零之四.4 的"目标机自取字节"。

### P4 工具集（`interface: "data"`）

- **不是一行常量**：`catalog.py:553` 在声明层就拒绝未知 interface（`interface not in
  (DAEMON, CLI)` → 拒绝），`rendezvous.render_launch()` 只为 daemon/cli 产出 argv，
  `facts.py:100` 规定只有 cli 组件能发布宿主事实。所以 `data` 需要一条"无进程"通路：
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
- **私有源**：`downloadPinned()` `:283` 与 `readManifest()` `:150` 的 `fetch(url, {signal})`
  **不带任何 header**，要支持 token 必须改；来源项从字符串扩成对象时保持 `readSourceList()`
  `:91` 的 `schema: 1` 兼容。
- **撤销**：签名过的静态撤销列表（可选）。

## 四、验证

```bash
node tests/components-panel.test.js               # 插件标签页：目标机、确认、裁定、重读、开关（DOM 假件）
node tests/components-view.test.js                # 主进程插件后端：目标机/清单/市场缓存/安装/卸载/停用切换
node tests/ui-load-order-test.js                  # ui/index.html 的 19 个脚本装序
node tests/bridge-shim.test.js                    # 桌面端与手机端暴露同一组名字
node tests/components.test.js                      # 客户端 + 宿主端到端（自带 supervisor）
PYTHONPATH=. python3 tests/components_api_test.py  # 宿主侧安装/解析/门/两条开关路由
PYTHONPATH=. python3 tests/rendezvous_test.py      # 寻址 + 停用位（`_disabled_probe`）
PYTHONPATH=. python3 tests/tools_inst_test.py
```

三条写入各由谁钉住（P3c 之后）：宿主侧是 `tests/components_api_test.py`（`/disable` 与
`/enable` 两条路由、`absent`、坏名字 400、**裸开关 404**）与 `tests/rendezvous_test.py` 的
`_disabled_probe()`（宿主自己的句子、清单仍列出它、**检出顶不上来**、启用后回到原样）；页面侧是
`components-panel` 17–24 节、`components-view` 9 节、`components.test.js` 9 节（对着真
supervisor）。一条纪律值得写在这里：**每条写入都要有"被拒之后什么都没变"的断言**（P3a 的
零之三.6、P3c 的幂等），因为这三条路径动的都是别人的机器。

手动活体检查（会真的写字节，务必指到一次性 supervisor 上）：

```bash
CLUTCH_COMPONENTS_DIR=/tmp/x PYTHONPATH=. python3 -m agent.supervisor --port 8899 --idle-timeout 900 &
curl -s http://127.0.0.1:8899/api/components          # 空
# 用 createComponentsView 指向 8899 装一次，再装一次（第二次必须是 current）
```

本机网络约束（硬条件）：`github.com` 的 HTTPS 不通（curl 28），`api.github.com` 可达。所以
任何"从 Release 下载"的用法都必须有**本地目录 source** 的对照（`isRemote()` `:118` 为假时
直接读文件），发布物只能用 `api.github.com` 的资产接口验证。

## 五、风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 不可撤销的远端写入 | 装到别人的机器上，删是删掉字节、没有副本 | P3 已补反动词（`90140ea` + `11f6ce4`）：二次确认把"这不是回滚"说在明处（I5）；宿主只删**自己启动**的进程，其它一律拒绝并报 pid。**P3c 把风险分了两档**：三条写入里只有停用是撤得回来的，它因此是唯一不问的（I5 不是"全部都要问"，而是"不许把不可逆的说成可逆"） |
| 版本语义断层 | 新旧两种"版本"形状并存 | P0 先统一；宿主落地自带清理，无需迁移脚本 |
| 越权 | 工具集想让宿主执行它定义的行为 | 守 I3：只能引用宿主词汇，导入期断言会大声报错 |
| 动态模式爆炸半径 | P4 改的是"模型看得到哪些工具" | 模式仍由宿主裁定（`registry.py:263` 的过滤保留），`chat` 语义不因插件变松 |
| 生态空转 | 有页面没插件 | 先跑通 4 个自家模块 + 一个工具集样本，再谈索引 |

## 六、为什么不需要自建服务器

- 分发：sha256 钉死（`pinnedAsset()` `ui/components.js:309`）⇒ 托管方不可信也安全；asset
  相对 source（`assetLocation()` `:125`）⇒ 换托管零成本。
- 发现：来源列表是数据文件（`:91`），第 5 个模块 = 多一行 URL，宿主零代码改动。
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
5. ~~**停用（`disable`）怎么表示、表示成什么**~~ → **已决（P3c）**：**都不选**。两个候选方案
   （组件目录下的标记文件 / 改版本目录名）都被否掉——状态既不落进组件目录，也不在客户端，而是
   进**持有组件那台机器的登记表**（`registry.json` 的组件级 `disabled`）。语义同时定了：清单
   **仍列出**它（多带 `disabled:true`，否则"没装"和"不驱动"分不开）、`resolve()` 照旧解析出
   那一版（字节能读）、工具**不出现**、重复切换幂等、**dev 检出也压得住**（拦截点放在
   `unavailable_reason()`）。完整理由见 §零之四，落点与验收见 P3c。
6. **"目标机自取字节"什么时候做**：已冻结（§零之四.4），实现未开始——现在仍是客户端把字节
   `upload()` 上去。要动安装端点（宿主自取时 body 允许为空）与页面（来源清单得让目标机也能读到
   同一份 URL）。

## 八、待办（本轮明确留着的缺口）

| # | 缺口 | 影响 | 想修的话落在哪 |
| --- | --- | --- | --- |
| G1 | 本机 supervisor 没在跑时，安装没有"先把它叫起来"这一步 | 本机第一次安装会以"supervisor 没回应"失败，用户得先让 app 启动它 | `ui/server-bootstrap.js`（现在全文无 components）或 `ui/components-view.js` 的 `install()` 前段 |
| G2 | Android 宿主没有 `clutchComponents` handler | 手机上插件标签页每条读取都是一行错误 | `android/host/android-host.js:78-107` 一带补同组调用 |
| G3 | 宿主缺反动词（当初是卸载/停用/回滚三件） | 装上是单向的，页面只能靠文案诚实（I5） | **卸载已两头补齐**：宿主 `90140ea`、页面 `11f6ce4`；**停用/启用已补齐**：宿主 `9f53b9c`、页面 `1df203d`。**回滚不是功能**（§一）：回到旧版就是再装一次，页面不画它 |
| G4 | `clutch-workspace/pyproject.toml` 0.2.0 与其 `component.json` 0.1.0 不一致 | 界面显示 0.1.0，包元数据说 0.2.0 | 模块仓库自身（结论见下） |
| G5 | 纯声明包（`interface:"data"`）目前 400 | 工具集还递不进去 | P4 |

G1 / G2 / G4 的答案是同一条：**按照 VS Code 的逻辑来**（零之四.5）。

- **G1 — 让目标机自己的二进制按需把服务起起来**。VS Code 这边，远端 server 由 `code` CLI 的
  tunnel 在需要时启动（`cli/src/tunnels/code_server.rs:322-350`：`bash -c "<server start
  script> --install-extension=…"`——装扩展本身就是启动参数的一部分），所以"动手之前先保证那台
  机器的服务在跑"是**那台机器的二进制的责任**，不是页面的。Clutch 的对应物是
  `ui/server-bootstrap.js`（今天全文没有 components）或 `ui/components-view.js` 的 `install()`
  前段：一次安装应当能**唤醒空闲退出的 supervisor**（本机那个是 `--idle-timeout 25` 起的，
  零之三.2）。
- **G2 — 目标端注册同一个通道**。VS Code 的 server 端把同一组扩展管理命令注册进 RPC 通道
  （`src/vs/server/node/serverServices.ts:403-409`），客户端因此不需要为"远端"再写一套协议。
  Clutch 的桌面端已经是这个形状（`clutchComponents` 在 preload 与 bridge-shim 里同名同参，
  `tests/bridge-shim.test.js` 守）；缺的是 **Android 宿主**——`android/host/android-host.js` 与
  `android/host/bridge-server.js` 里**一个 `clutchComponents` 命名空间都没有**，于是手机上每条
  读取都结束于 `no such bridge method: clutchComponents.list`（零之三.3）。补法照 VS Code：
  同一组名字、同一组参数，落在那台机器的宿主里。
- **G4 — 版本一致性是模块仓库自己的事**。`clutch-workspace/pyproject.toml`（0.2.0）与
  `component.json`（0.1.0）不一致，界面因此显示 0.1.0。宿主不该猜哪个对——猜错就是把一个发行
  版本号写进安装事实。做法与 VS Code 对扩展 `package.json` 的态度一致：**声明就是版本**，
  改在模块仓库，宿主照读（I1）。
