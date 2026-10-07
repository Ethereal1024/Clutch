# 插件系统构筑计划（PLUGIN_PLAN.md）

本文件是组件**安装层**从"只在隧道路径上自动跑"扩成"可看见、可选择、可卸下、可装工具集"
的施工计划。契约本体在 `COMPONENTS.md`（声明、wire 协议、三种存在形态），本文件只写
**怎么一步步做到**，以及每一步的验收。

## 零、不变量（任何阶段不得违反）

| # | 不变量 | 现状依据 |
| --- | --- | --- |
| I1 | **发布归模块**：每个模块自己发 `clutch-component.json`，宿主只存 URL 来源 | `ui/components.sources.json`（4 行）、`components.sources()`（`ui/components.js`） |
| I2 | **宿主零字节**：宿主发行包不含 `components/` | `shippedArtifact()`（`ui/components.js`） |
| I3 | **声明说词、宿主释义**：能力词汇（access / gate / mode）归宿主 | `agent/tools/gates.py:1-20`（导入期 `_check_vocabulary` 断言） |
| I4 | **不自建分发服务器**：分发=各模块 Release，索引=静态 JSON，安装=目标机 supervisor | 见本文件第六节 |
| I5 | **不可撤销的动作不得在界面上伪装成可撤销** | P3b 之前靠"缺席"成立（没有卸载端点就不画卸载按钮）；P3b 给了按钮，从此靠**文案**成立：安装确认说"a removal DELETES bytes…neither act is a rollback"（`plugInstall()`），卸载确认说"This cannot be undone from here"（`plugRemove()` 与逐版的 `plugRemoveVersion()`），市场常驻警告说"neither is a rollback"——三处都在 `ui/js/components-panel.js`。P3c 补上第三条写入后，同一条界线依然清楚：**停用开关是协议里唯一不要求确认的写入**——它一个字节都不删，**按钮标签本身就是撤销路径**（§一、§零之四.2）。P3d 的逐版卸载同样先问、同一句"This cannot be undone from here"，且问题点名那一版 |

## 零之二、进度（随施工更新）

| 阶段 | 状态 | 提交 | 实际交付 |
| --- | --- | --- | --- |
| P0 版本语义 | **已完成** | `42e6ee6` | 安装版本 = `<自报版本>+<摘要16>`；`ui/components.js:installVersion` |
| P1 只读可见 | **已完成** | `2c473f6`（含 `0b7229e` 的修正） | 通道 + 设置弹窗第二个标签 + 市场/已装两份清单 |
| P2 单向下发 | **已完成** | `8d11845` | 每行安装按钮 + 二次确认 + 进度 + 宿主裁定回显 + 装完重读清单 |
| P3a 反向动词（宿主侧） | **已完成** | `90140ea` | `versions()` / `remove()` + `GET …/versions`、`DELETE …/<name>`；先停后删、非我启动的 daemon 拒绝 |
| P3b 反向动词（页面） | **已完成** | `11f6ce4` | 每行卸载按钮 + 二次确认 + 宿主裁定回显（`removed`/`absent`/拒绝原文）+ 装完/卸完重读清单；I5 改由文案承担 |
| P3c 停用/启用 | **已完成** | `9f53b9c`（宿主）+ `1df203d`（页面） | 登记表 `<components 根>/registry.json` 承载组件级 `disabled` 位；`POST /api/components/<name>/disable`、`…/enable`；`GET /api/components` 多带 `disabled`；页面每行一个开关（**不确认**，标签即撤销），停用行仍列出、仍可卸载 |
| P3d 版本明细 | **已完成** | `cdc1625` | 已装行上的一个"…"披露该机持有的每一版（版本、摘要、是否 `resolved`），逐版点名卸载 |
| 零之四.4 目标机自取字节 | **已完成** | `0899dc8`（宿主）+ `abab8cb`（页面） | 安装请求两种形状：body 有字节 = `upload()` 兜底（客户端独有的字节），空 body + `artifact_url` = 目标机自取（默认）；同一道 `accept` 门按 `digest` 量**取到的**字节；客户端不再下载 release，只带走几百字节的声明 |
| P4 工具集 | 未动工 | — | `interface: "data"`，见 §三 |
| P5 静态索引 | 未动工 | — | 可选，见 §三 |

每阶段的端到端实测就写在该阶段的「验收」里，跑法是第四节那几条命令，这里不复述。

## 零之三、本轮新发现（P1/P2/P3 施工中得到；P3c 的两条是 7、8）

1. **组件端点长在 supervisor 上，不在 session API 上**（最关键的一条）：`GET /api/components`
   与 `POST /api/components/install` 属于 supervisor 进程（本机 `127.0.0.1:8890`，远端 =
   隧道的 `tunnelStatus().url`），而**窗口的 session base 是另一个端口、另一个进程，对组件
   一无所知**。照 session base 去写这个页面会"看起来正确"——每台机器都显示"没有装任何组件"。
   所以页面写入的 base 一律取 supervisor（`ui/components-view.js` 的 `target()`），而"装到哪台
   机器"由**窗口的会话种类**（`hostCore.backendKind`）决定：会话在隧道对端 → 装对端；其余
   （包括隧道在线但窗口回退到本地会话的情形）→ 装本机；没有窗口也没有隧道 → 本机。
2. **supervisor 会空闲退出**（**已补上唤醒**，`31d5ec6`，落点是第八节 G1）：本机那个是
   `--idle-timeout 25` 起的，空闲即退出，由 app 按需重启——于是"本机安装"在 supervisor 没在跑
   时会直接失败，而当初**没有任何东西会为这次安装把它叫起来**（`ui/server-bootstrap.js` 全文
   没有 components）。补法是"写入自己把那台机器叫起来"：导出本来就幂等、探测在前的
   `ensureSupervisor`，桌面 shell 注入 `ui/components-view.js`，唤醒点放在 `install()` 里、
   **第一次需要目标机自己回答之前**，进度多一个 `wake` 段；起不来则交出一句页面画得出来的话，
   而不是"没回应"这条死路。三条界线：**读不叫机器**（`list()` 照旧诚实地说"没回应"）、
   **在自己就会拒的请求上不叫机器**（绝不为了一个注定被拒的请求去起一台机器）、**只叫本机**。
   手机端不传这个 dep（N4），行为与从前逐字相同。
3. **Android 当初只做了表面齐平**（**已修掉**，`f9238b4`，落点是第八节 G2）：`ui/bridge-shim.js`
   暴露了 `clutchComponents`（两端 API 同名），但 `android/host/android-host.js` 没有任何
   handler，于是手机上每次调用都结束于 `no such bridge method: clutchComponents.list`。补法是
   建**同一个** `ui/components-view.js`（共享实现，不是副本）：`supervisorBase: () => null`
   保持 N4，`windowKind` 取 `hostCore.backendKind`——"装到哪台机器"因此与桌面端同一条规则。
   一条**看不见的**前提：`scripts/sync-android-host.sh` 的 `UI_NODE` 手写清单必须包含它，
   漏掉不会报"少个功能"，而是宿主 require 不到、桥还没 bind 就死（所以有了
   `tests/android-assets.test.js`）。
4. **本机已装版本还是旧形状**：实测的旧记录仍停在裸摘要年代。`install()` 落地时会清掉同组件
   其它版本，所以下一次安装自然换成带版本的目录名，**不需要迁移脚本**（P0 的迁移结论）。
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
   （`rendezvous.unavailable_reason()`，`agent/tools/rendezvous.py`），否则开发机上
   "停用了"却因为仓库旁的检出在场而照样把工具递给模型——最坏组合是"页面说停了，工具还在"。
   `reindex()` 是唯一的例外：重建**忘掉 `disabled`**（磁盘上没有这个形状），重建后要重新停。
8. **一个只有活体才看得见的一次性 Bug（`9f53b9c` 修掉）**：supervisor 的两条路由把**反的
   极性**传给了 `components.set_disabled`，于是 `/disable` 实际上在"重新驱动"。它藏得住是因为
   参数名原来叫 `state`——两个方向读起来都对——而单测只钉了组件层（`set_disabled` 本身没错）。
   现在参数一律叫 `disabled`（**表里存的那个位**），每条路由传自己那个词的**含义**。教训与
   零之三.6 同类：**名字和动词是两条独立的信息，极性错位的时候两边都读得通**。

## 零之四、已冻结的五个决定（本轮拍板，施工据此）

1. **命令式，不共享状态**：页面只**发命令**（安装 / 卸载 / 停用 / 启用），**单一写者 = 持有
   那个目录的机器上的 supervisor**。所以这个页面始终是某台机器的客户端，从不是第二个登记处
   ——两份状态就没有"以谁为准"的问题。
2. **`disabled` 是每台机器各自的**：同一组件在 A 机停用、在 B 机照跑，两边互不知道；问谁就以
   谁为准。停用不是删除：字节不动、行还在、仍可卸载，而且**不要求确认**（I5 只约束撤不回来
   的动作，它的标签本身就是撤销路径）。
3. **手机端不镜像远端的表**：页面**没有任何远端清单缓存**，每问一次就发一次请求
   （`hostInventory()` / `hostVersions()`，同在 `ui/components.js`）。清单是机器的判断
   （哪一版会赢、哪一版被停），客户端存一份就成了"第二份真相"，而且会把"读不到"画成"没有"。
4. **字节默认由目标机自己取，手机端的 `upload()` 只是兜底**（**已实现**，宿主 `0899dc8` /
   页面 `abab8cb`）：安装请求**两种形状**，一条端点一个 header——body 有字节（`upload()`，
   **只有这台客户端独有的字节**才这样送：检出、预编译产物），或 body 为空而 manifest 带
   `artifact_url`（`fetchInstall()`，**默认**），目标机自己去取（`components.receive()` →
   `download()`）。只走 http(s)（`file:` 与本地路径一律拒绝——那是这台机器自己的盘）、30 秒读
   超时、64 MiB 封顶、流进 scratch 再过同一道门：门量的是**取到的字节 vs 请求声明的
   `digest`**，所以 URL 不比 body 更松。客户端这边 `artifactFor()` 不再下载 release
   （`publishedArtifact()`，交出去的是位置 + 钉死的摘要），只有几百字节的 `declaration` 还从
   客户端过一趟（宿主要读组件形状）。
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

## 二、当初要修掉的四个断点

1. **渲染层无通道** → 已交付：`clutchComponents` 在 preload 与 bridge-shim 里同名同参（今天
   六个动词 + 一个 `onProgress`）。
2. **只有读、没有反动词** → 已交付：卸载（`90140ea` + `11f6ce4`）、停用/启用（`9f53b9c` +
   `1df203d`）、版本明细（`cdc1625`）；**`prune` 拍板不做**。
3. **安装版本是裸摘要前缀** → 已交付 `<声明版本>+<摘要16>`（P0）。
4. **纯声明包递不进去** → 空 body 如今**是合法请求**（零之四.4：它意味着"字节在
   `artifact_url` 那里"）；`interface: "data"` **并入 P4**。

## 三、阶段

```mermaid
flowchart LR
  P0['P0 版本语义<br/>安装版本可读 ✅'] --> P1['P1 只读可见<br/>通道 + 标签页 ✅']
  P1 --> P2['P2 单向下发<br/>装到选定机器 ✅']
  P1 --> P3['P3 反向动词<br/>卸载已通 ✅']
  P2 --> P3
  P3 --> P3c['P3c 停用/启用<br/>留着但不驱动 ✅']
  P3c --> P3d['P3d 版本明细<br/>每版点名 ✅']
  P3d --> P4['P4 工具集<br/>interface data']
  P4 --> P5['P5 可选<br/>静态索引 / 私有源']
```

### P0 版本语义：一次安装的版本必须可读（**已完成**，`42e6ee6`）

安装版本 = 组件**自报版本** + 内容摘要，即 `0.1.0+<digest16>`（`ui/components.js` 的
`installVersion()`，两个分支都用它）。宿主正则早就认这个形状，所以这不是新协议，只是把客户端
原来写的裸摘要前缀补全。**没有版本可说的 spec**（裸 `{name, interface}`，测试里就是这个形态）
仍只发摘要前缀：身份就是它拥有的全部，编一个版本反而是无法兑现的声明。旧机器**不需要迁移
脚本**——`install()` 落地时清掉同组件其它版本，下一次安装自然换成带版本的目录名。
验收：`tests/components.test.js` + `tests/components_api_test.py`。

### P1 只读可见（通道 + 标签页）（**已完成**，`2c473f6`）

`clutchComponents { list, market, install, onProgress }` 落进 `ui/preload.js` 与 `ui/main.js`
的 `components:*` handler；新增的 `ui/components-view.js` 从这里开始承载"目标机是谁 / 市场缓存
/ 安装裁定"三件事。设置弹窗加了第二个标签（`ui/style.css` 此前没有 tab 样式；渲染层是 19 个
经典脚本，装序是契约，`tests/ui-load-order-test.js` 守）。两条纪律：页面必须画出**来源错误**
（`errors` 是 data 不是异常，否则用户在空市场前不知道是网络问题）；读失败时 `held` 一律
`null` 而不是空数组——"读不到"与"没装"绝不能混为一谈（`0b7229e`）。本阶段**不画安装按钮**（I5）。

### P2 单向下发（安装）（**已完成**，`8d11845`）

目标机**不复用** `#conn-select`：那个选择器说的是"这个窗口连到哪台机器的会话"，而组件要送到
**supervisor**（零之三.1）；现在由窗口的会话种类推导（`backendKind`），页面只显示结果。新增
`components:install` 与 `components:progress`，`askConfirm` 明说"**这个页面不能撤销它**"（I5），
市场行自带一行常驻警告，不只藏在弹窗里。幂等来自宿主：`accept()` 的 `current()` 门答
`"current"`，重连不重传；客户端还先查一次清单，同版本同摘要**连上传都不发生**。被拒时页面显示
宿主 `error` 的**原文**，不转述。

### P3 反向动词（宿主 `90140ea` + `9f53b9c`、页面 `11f6ce4` + `1df203d`，三段全通）

**P3a（宿主侧）**：

- `GET /api/components/versions?name=` → 每版一条 `{version, interface, digest, path,
  resolved}`，**新→旧**排序（就是 `resolve()` 的选择依据），`resolved:true` 标出宿主真会启动
  的那一个；名字不合法 → 400（而不是空清单——空清单读起来像"没装"）。
- `DELETE /api/components/<name>[?version=]` → `{status:"removed", removed:[…]}` /
  `{status:"absent"}`；名字不合法、`?version=` 没装、有非我启动的 daemon 在跑 → 400 带宿主原文。
- **"先停后删"**：`remove()` 收一个调用方的 `stop` 回调（`rendezvous.stop_for_removal`），
  **只在确实有东西可删时**才调用——否则一次注定被拒的删除会先把 daemon 杀掉再报错（零之三.6）。
  本进程启动的 daemon 先停（属主规则与 `release` 一致），**别人启动的**一律拒绝并把 pid 写进
  句子——"磁盘上读到的 pid 不是开枪许可"。

**P3b（页面）**：

- 通道只加两个动词：`hostVersions(base,name)` 与 `hostRemove(base,name,version)`，两者共用新的
  `hostJSON(url,{method,timeoutMs})`——宿主的 `{"error":…}` 直接变成抛出的句子（"谁在跑它"这类
  拒答，页面**必须能原文引用**，裸状态码只会让它自己猜）。
- `ui/components-view.js` 的 `versions()` / `remove()` 先解目标机，解不出来是**答案**不是异常；
  失败装在结果里（`{ok:false,error}`），所以"这台机器一版都没有"与"这台机器问不到"绝不会画成
  同一幅空图。
- 页面：每条已装行一个 Remove 控件，**没有 supervisor URL 时它是死的**（哪台机器会掉字节是最
  不能猜的事），**任何写入在飞时它也是死的**——`busy` 带上 `verb`，两个方向共用"一次只准一个
  写入"。删除前先问，问题点名版本与机器，并说最难的那句：**这里撤不回来，本页不留副本，要拿
  回来只能再装一次**。裁定原样回显宿主的三种形状（`removed <name> <versions> from <where>` /
  `<name> was not installed on <where> — there was nothing to remove` / 拒绝原文）。
  **I5 从此靠文案成立**，不再靠缺席。

### P3c 第三条写入：留着，但不驱动（**已完成**，宿主 `9f53b9c` / 页面 `1df203d`）

**这一段先拍板语义、再写代码**（零之四.1/2/3）：`disabled` 是**每台机器各自**的事实，住在
**持有组件那台机器的登记表**里，客户端不留副本——所以它不是"加一个端点"，而是一条新的写入
路径，落点、顺序、界面三处都得跟着定。

- **落点是登记表**：`<components 根>/registry.json` 每条记录多一个组件级 `disabled`，与安装
  事实同一张表、同一个写者（`_TABLE_LOCK`），于是"这台机器驱动什么"只有一个答案者。它**不落
  进组件目录**：登记表是"有什么"的唯一名册——表里有就是有，一个没有表项的目录不是组件
  （`reindex()` 是唯一的重建入口）。
- **两条路由**：`POST /api/components/<name>/disable` / `…/enable` →
  `{"status":"disabled"|"enabled","name":…,"disabled":bool}`；这台机器根本没有它 →
  `{"status":"absent"}`（**答案**，不是错误：要求已经成立）；名字不合法/穿越 → 400 宿主原文；
  只发一个开关而不点名（`/api/components/disable`）→ 404（不是"叫空名字的组件"）。
- **`disabled` 只抑制工具**：字节一个不动、清单照列（多带 `disabled:true`）、`versions()` 照报、
  `DELETE` 照能删、重复切换幂等。拦截点故意在**解析之后、交付之前**
  （`rendezvous.unavailable_reason()`），于是 **dev 检出也递不上替身**（零之三.7）。装新版本时
  这个位**跟着组件过去**，换版本不会偷偷把机器重新驱动起来。
- **`reindex()` 忘掉这个位**（磁盘上没有这个形状）：重建的语义是"重新相信磁盘"，所以重建之后
  要重新停一次——这是这台机器上唯一会"自己恢复驱动"的路径，写在文档里而不是藏起来。
- 页面出去的**是状态、不是动词**：`hostSetDisabled(base,name,disabled)` 按位选 `/disable` 与
  `/enable`，preload 与 bridge-shim 同名同参（`tests/bridge-shim.test.js` 钉住这条平价）。
  持有但停用的行，在版本号之后多一个 `stopped` 标记 + 一句 "held on this machine, but not
  driven"，动作变成**开关 + 卸载**；开关**不弹确认**——它一个字节都不删、**标签本身就是撤销
  路径**（I5）；三种死法都要说得出原因（没有目标机的 supervisor URL、这个 shell 没有这个动词、
  另一个写入正在飞）。
- 一个只在活体里露头的 Bug 随这条一起修掉（零之三.8）：supervisor 两条路由曾把**反的极性**
  传给 `components.set_disabled`，`/disable` 实际在"重新驱动"；参数名改叫 `disabled` 之后消失。

### P3d 版本明细：每一版都点名（**已完成**，`cdc1625`）

已装行上的一个"…"披露目标机持有的每一版（版本、摘要、是否 `resolved` 都在里面），每一版自带
一个点名卸载；它的三条死法与别的写入同源（没有目标机 URL、没有那个动词、另一个写入在飞）。

**`prune` 拍板不做**：`install()` 落地时已经清掉同组件其它版本（`_prune(name, keep=target)`），
再给一个"手动清理旧版"的接口只是把同一件事说两遍——想回到某一版就再装一次（§一）。

### P4 工具集（`interface: "data"`）

- **不是一行常量**：`catalog.py` 在声明层就拒绝未知 interface（`interface not in
  (DAEMON, CLI)` → 拒绝），`rendezvous.render_launch()` 只为 daemon/cli 产出 argv，
  `facts.py` 规定只有 cli 组件能发布宿主事实。所以 `data` 需要一条"无进程"通路：
  声明可读即可驱，不解析 launch、不启动进程。
- 契约形状（草案）：`{schema:1, name, interface:"data", version, tools:[…声明…], mode:"<名>",
  prompt:"PROMPT.md"}`。
- **动态模式集**：`catalog.MODES` 是常量元组（`agent/tools/catalog.py`），要变成"内建 +
  组件声明"；`registry.py` 的过滤、`agent/config.py` 的 `mode`、`agent/api/run.py:29-31`
  的模式白名单随之放宽。
- **提示词**：`agent/core/context.py` 现在追加固定文件 `agent/prompts/mode_*.md`；工具集自带
  片段。可复用 `agent/tools/prompt.py` 的占位符机制（`$config.<field>` / `$backends` /
  宿主事实，整行 `$skills` 展开成块）。
- **降级**：工具集引用了未安装组件提供的工具时，该工具不出现（`registry` 既有逐条过滤），
  并说明"缺谁"——先例是 `prompt.components_unavailable()` `:102`。
- 保留 `chat` / `work` 为内建工具集，不删。

### P5 可选：静态索引与私有源

- **索引**：market 仓库里的静态 `index.json`（搜索/分类/精选），页面读它做展示，**权威仍是
  各模块的 manifest**；零服务器。
- **私有源**：`downloadPinned()` 与 `readManifest()`（`ui/components.js`）的 `fetch(url, {signal})`
  **不带任何 header**，要支持 token 必须改；来源项从字符串扩成对象时保持 `readSourceList()`
  的 `schema: 1` 兼容。零之四.4 之后**字节是目标机去取**（`download()`
  `agent/tools/components.py:710`，同样不带任何 header），所以 token 不光要给客户端，还得递到
  每一台要装的机器上——私有源至今是"没做"，不是"快有了"。
- **撤销**：签名过的静态撤销列表（可选）。

## 四、验证

```bash
node tests/components-panel.test.js               # 插件标签页：目标机、确认、裁定、重读、开关（DOM 假件）
node tests/components-view.test.js                # 主进程插件后端：目标机/清单/市场缓存/安装/卸载/停用切换
node tests/server-bootstrap.test.js               # 机器 supervisor + 每窗口会话；收尾用真的 spawn 证一次 G1 的唤醒（空闲退出后再起）
node tests/ui-load-order-test.js                  # ui/index.html 的 19 个脚本装序
node tests/bridge-shim.test.js                    # 桌面端与手机端暴露同一组名字
node tests/bridge-server.test.js                  # 手机宿主端到端（桥 + 真实 android-host + 假隧道/假 supervisor），第 9 节 = 插件通道
node tests/android-assets.test.js                 # 手机资源子集覆盖宿主解析到的每一个模块（含传递 require）
node tests/components.test.js                      # 客户端 + 宿主端到端（自带 supervisor）
PYTHONPATH=. python3 tests/components_api_test.py  # 宿主侧安装/解析/门/两条开关路由
PYTHONPATH=. python3 tests/rendezvous_test.py      # 寻址 + 停用位（`_disabled_probe`）
PYTHONPATH=. python3 tests/tools_inst_test.py
```

三条写入各由谁钉住：宿主侧是 `tests/components_api_test.py`（安装/解析/门 + 两条开关路由 +
裸开关 404）与 `tests/rendezvous_test.py` 的 `_disabled_probe()`（宿主自己的句子、清单仍列出它、
**检出顶不上来**、启用后回到原样）；页面侧是 `components-panel`、`components-view` 与
`components.test.js`（对着真 supervisor）。一条纪律写在所有写入上：**每条写入都要有"被拒之后
什么都没变"的断言**（P3a 的零之三.6、P3c 的幂等）——这三条路径动的都是别人的机器。

手动活体检查（会真的写字节，务必指到一次性 supervisor 上）：

```bash
CLUTCH_COMPONENTS_DIR=/tmp/x PYTHONPATH=. python3 -m agent.supervisor --port 8899 --idle-timeout 900 &
curl -s http://127.0.0.1:8899/api/components          # 空
# 用 createComponentsView 指向 8899 装一次，再装一次（第二次必须是 current）
```

本机网络约束（硬条件）：`github.com` 的 HTTPS 不通（curl 28），`api.github.com` 可达。所以
任何"从 Release 下载"的用法都必须有**本地目录 source** 的对照（`isRemote()` 为假时直接读
文件），发布物只能用 `api.github.com` 的资产接口验证。镜像（`ui/net-fetch.js` 那一个门）绕开
的正是这条约束，它的契约写在 `COMPONENTS.md` 第八节，不在本文件。

## 五、风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 不可撤销的远端写入 | 装到别人的机器上，删是删掉字节、没有副本 | P3 已补反动词（`90140ea` + `11f6ce4`）：二次确认把"这不是回滚"说在明处（I5）；宿主只删**自己启动**的进程，其它一律拒绝并报 pid。**P3c 把风险分了两档**：三条写入里只有停用是撤得回来的，它因此是唯一不问的（I5 不是"全部都要问"，而是"不许把不可逆的说成可逆"） |
| 版本语义断层 | 新旧两种"版本"形状并存 | P0 先统一；宿主落地自带清理，无需迁移脚本 |
| 越权 | 工具集想让宿主执行它定义的行为 | 守 I3：只能引用宿主词汇，导入期断言会大声报错 |
| 动态模式爆炸半径 | P4 改的是"模型看得到哪些工具" | 模式仍由宿主裁定（`registry.py` 的过滤保留），`chat` 语义不因插件变松 |
| 生态空转 | 有页面没插件 | 先跑通 4 个自家模块 + 一个工具集样本，再谈索引 |

## 六、为什么不需要自建服务器

- 分发：sha256 钉死（`pinnedAsset()` `ui/components.js`）⇒ 托管方不可信也安全——而且钉子
  是在**取字节的那台机器**上兑现的（`accept()` `agent/tools/components.py:770` 量它取到的
  字节）；asset 相对 source（`assetLocation()` `ui/components.js`）⇒ 换托管零成本。
- 发现：来源列表是数据文件（`readSourceList()` `ui/components.js`），第 5 个模块 = 多一行 URL，宿主零代码改动。
- 安装：`POST /api/components/install` 长在**目标机**的 supervisor 上，没有账号、配额、
  每机器注册表。
- 只有"账号 / 付费 / 统计 / 集中发布"才逼出服务器，而每一项都与 I1 / I2 冲突，需单独决策。

## 七、待拍板

1. ~~**P1 是否单独交付**~~ → **已决**：P1 单独一个只读提交（画不出安装按钮就不涉及 I5），
   P2 同批紧跟（`8d11845`）。
2. **旧记录**：是否强制重装以统一版本形状（`install()` 会清掉旧版本目录，所以代价只是一次
   上传），或让两种形状长期并存。
3. **索引仓库（P5）**：模块数 ≤4 时先不建。
4. ~~**`DELETE` 不带版本号是什么意思**~~ → **已决（P3a）**：整个组件一起拿掉（"卸载这个
   组件"就是这个意思），返回 `removed:[…]` 说明删掉了哪几版；本来就没装 → `absent`，**不是
   错误**（要求已经成立）。`?version=` 指向没装的版本 → 拒绝。
5. ~~**停用（`disable`）怎么表示、表示成什么**~~ → **已决（P3c）**：**都不选**。状态既不
   落进组件目录，也不在客户端，而是进**持有组件那台机器的登记表**（`registry.json` 的组件级
   `disabled`）。语义与理由见 §零之四.2 与 P3c。
6. ~~**"目标机自取字节"什么时候做**~~ → **已决并已做**（§零之四.4）。安装端点认两种形状
   （body 有字节 / 空 body + `artifact_url`），页面按"字节在哪"选一条（`file.path ? upload :
   fetchInstall`）。来源清单**不必两边都读到**：URL 是客户端从清单里解出来的
   （`assetLocation`），跟着 manifest 递给目标机——目标机只认 URL，不认清单。已知边界：来源
   清单点名**磁盘上的**清单时，解出来的工件位置也是本地路径，而宿主只取 http(s)（`download()`
   拒绝 `file:`），这种来源今天装不上（清单本身照读；`upload()` 兜底覆盖的是检出与预编译
   产物，不是镜像目录）。

## 八、待办（本轮明确留着的缺口）

| # | 缺口 | 影响 | 想修的话落在哪 |
| --- | --- | --- | --- |
| G1 | ~~本机 supervisor 没在跑时，安装没有"先把它叫起来"这一步~~ → **已交付**：`ensureSupervisor` 注入 `ui/components-view.js`，本机安装先唤醒、再问；`wake` 是一段进度 | 本机第一次安装会以"supervisor 没回应"失败，用户得先让 app 启动它 | 落地：`31d5ec6`（`ui/server-bootstrap.js` 导出、`ui/main.js` 注入、`ui/components-view.js` 唤醒、`ui/js/components-panel.js` 的 `wake` 文案）；守：`tests/components-view.test.js` 第 11 节、`tests/server-bootstrap.test.js` 收尾 |
| G2 | ~~Android 宿主没有 `clutchComponents` handler~~ → **已交付**：`android/host/android-host.js` 建同一个 `ui/components-view.js`，六个动词 + `components:progress` | 手机上插件标签页每条读取都是一行错误 | 落地：`f9238b4`（`android/host/android-host.js`、`scripts/sync-android-host.sh` 的 `UI_NODE` 补 `components-view.js`）；守：`tests/bridge-server.test.js` 第 9 节、`tests/android-assets.test.js` |
| G3 | 宿主缺反动词（当初是卸载/停用/回滚三件） | 装上是单向的，页面只能靠文案诚实（I5） | **卸载已两头补齐**：宿主 `90140ea`、页面 `11f6ce4`；**停用/启用已补齐**：宿主 `9f53b9c`、页面 `1df203d`。**回滚不是功能**（§一）：回到旧版就是再装一次，页面不画它 |
| G4 | `clutch-workspace/pyproject.toml` 0.2.0 与其 `component.json` 0.1.0 不一致 | 界面显示 0.1.0，包元数据说 0.2.0 | 模块仓库自身（结论见下） |
| G5 | 纯声明包（`interface:"data"`）目前 400 | 工具集还递不进去 | P4 |

G1 / G2 / G4 的答案是同一条：**按照 VS Code 的逻辑来**（零之四.5）。

- **G1 — 让目标机自己的二进制按需把服务起起来**。VS Code 这边，远端 server 由 `code` CLI 的
  tunnel 在需要时启动（`cli/src/tunnels/code_server.rs:322-350`：装扩展本身就是启动参数的一部分），
  所以"动手之前先保证那台机器的服务在跑"是**那台机器的二进制的责任**，不是页面的。Clutch 的
  对应物是 `ui/server-bootstrap.js` 的 `ensureSupervisor`：桌面 shell 把它注入
  `ui/components-view.js`，`install()` 在**第一次需要目标机自己回答之前**唤醒它。三条界线：
  **读不唤醒**、**在自己就会拒的请求上不唤醒**、**只唤醒本机**（隧道对端自己起自己的）。手机端
  不传这个 dep——它没有本机 supervisor（N4），行为与从前逐字相同。
- **G2 — 目标端注册同一个通道**。VS Code 的 server 端把同一组扩展管理命令注册进 RPC 通道
  （`src/vs/server/node/serverServices.ts:403-409`），客户端因此不需要为"远端"再写一套协议。
  Clutch 的桌面端已经是这个形状（`clutchComponents` 在 preload 与 bridge-shim 里同名同参）；缺的
  **Android 宿主**已补上：`android-host.js` 实例化的是**同一个** `ui/components-view.js`（不是
  副本），六个动词与桌面端逐字对齐，唯一差别是 bridge 路由不带窗口 id（这台机器只有一个窗口，
  N5）；`supervisorBase: () => null` 保留 N4，"没有会话"于是说成 `this build has no supervisor
  URL for the local machine`——一句页面能画的话，而不是一个缺方法。另加
  `tests/android-assets.test.js`：`UI_NODE` 是手写清单，漏一个名字不是"少个功能"而是**宿主
  require 不到、桥还没 bind 就死**（一次真实事故的回声），所以 `useUI()` 的每个名字与它们的
  传递 `require` 都被这一条钉住。
- **G4 — 版本一致性是模块仓库自己的事**。宿主不该猜哪个版本号对——猜错就是把一个发行版本号写进
  安装事实。做法与 VS Code 对扩展 `package.json` 的态度一致：**声明就是版本**，改在模块仓库，
  宿主照读（I1）。
