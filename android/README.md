# Clutch Android（M1–M3：引擎打通 + SSH 供给线 + CI 打包/前台服务/窄屏）

WebView 渲染层（`ui/` 原样）+ nodejs-mobile 宿主（`ui/` 纯 Node 子集原样）+
一个最小 Kotlin 壳。手机没有 pip/bash、没有 Chromium 网络栈，所以它与桌面端共用
宿主 JS，另换三样东西：引擎（nodejs-mobile 的 `libnode.so`）、后端供给（CI 预构建的
pylibs tar）、以及一层只负责起引擎与端 WebView 的 Kotlin 壳。

```
android/host/                  宿主 JS（仓库源码，随包分发）
  index.js                     nodejs-mobile 入口：main() → 装配 + 桥
  android-host.js              装配：provider 注册 + host-core + 桥 handlers
  bridge-server.js             loopback HTTP 桥：POST /api/<ns>/<m> + GET /events (SSE)
  artifact-provider-android.js N3：CI 预构建 pylibs tar 下载器（M2 已接线，经 server-bundle 的 artifact provider seam 注册）
app/src/main/
  AndroidManifest.xml          壳的声明：activity/service/权限 + 启动器图标
  res/                         启动器图标与字符串（图标由 scripts/make-icon.py 生成，勿手改）
  java/io/clutch/mobile/       Kotlin 壳（仅壳：引擎启动 + WebView + 返回键/外链）
  cpp/native-lib.cpp           唯一 C++：setenv(HOME/TMPDIR) → node::Start（pthread）
  jniLibs/<abi>/libnode.so     nodejs-mobile v18.20.4（脚本下载，不入库）
```

## 构建（M3 起一个入口：`scripts/build-android-apk.sh`）

```bash
# 本机（需 JDK 17 + Android SDK 34/NDK 26.3.11579264；libnode zip 已缓存秒过）
scripts/build-android-apk.sh <pylibs-index-url> <版本> clutch-android.apk
# 脚本内部 = 盖章(pylibs-index-url.txt) → fetch-android-libnode → sync →
# 版本戳(assets/ui/version.js ← <版本>) → ./gradlew --no-daemon :app:assembleDebug
# -PAPP_VERSION=<版本> → 拷出 APK
```

设置里的 **About** 页读的就是那份 `assets/ui/version.js`：构建脚本用**传给 gradle 的同一个
`<版本>`** 重写它（所以手机上看到的号 = `dumpsys package` 里的 `versionName`，包括 tag 构建
与 debug 构建 id）。源码树里该文件与 `VERSION`、`ui/package.json`/`package-lock.json`
是同一个号，由 `tests/about-version-test.js` 钉住——页面没有别的途径知道自己的版本（WebView
没有连到 Kotlin 壳的通道），所以这个戳是唯一的真相。

产物是 **debug 签名 APK**，但签名密钥是**项目自己的**（`android/keystore/clutch.jks`，
`android/app/build.gradle` 的 `signingConfigs.clutch` 同时用在 debug 与 release 上）：
debug 口味保住 WebView 可 `chrome://inspect` 调试，固定证书则保证**新版本能覆盖安装
旧版本**。构建脚本在拷出 APK 后用 `apksigner` 把签名者证书指纹与
`android/keystore/cert-sha256.txt` 对一遍，键不对就直接失败——不让"装不上"留到手机上才发现。

> 历史包袱：v0.1.23 及更早的 Release APK 是 runner 的自动 debug keystore 签的，**每次
> 构建的证书都不同**（实测 v0.1.21 = `6985f0fe…`、v0.1.22 = `7f924a79…`）。如果手机上
> 现装的是这类包，它那把私钥已经随 runner 消失，**只能卸载重装一次**（应用数据会丢）；
> 之后所有版本都同键，覆盖安装即可。若手机上装的是本机构建的包（本机 keystore 指纹
> `07e0784c…7a1a`，本项目的 `clutch.jks` 就是同一把密钥材料），则**无需卸载**，直接覆盖。

密钥口令写在 `android/gradle.properties`（`SIGNING_STORE_*`/`SIGNING_KEY_*`，可用
`-P` 覆盖）：这是个不发布到应用商店的侧载项目，这把钥匙的职责是"升级连续性"，不是
防住一个已经拿到源码的人。

仓库已提交 gradle wrapper 四件套（`android/gradlew*`、`android/gradle/wrapper/*`，
Gradle 8.7，AGP 8.5.2 的最低版本），所以 `cd android && ./gradlew :app:assembleDebug`
不再需要自备 Gradle；Android Studio 路线照旧。

## M3：CI 出 APK + 前台服务 + 窄屏（代码+CI+脚本完成，真机验收待设备）

1. **打包脚本**：`scripts/build-android-apk.sh <index-url> <version> <out.apk>`——
   盖章（N3 的 `pylibs-index-url.txt`，sync 时打进 nodejs-project）→ libnode →
   assets → `assembleDebug -PAPP_VERSION=…`。CI 只做薄壳。
2. **双 workflow**：`release.yml` 的 `android-apk` job（打 `v*` tag 触发，
   `needs: pylibs-index`——needs 到的是整个 job，含"tar+索引附到 Release"那步，
   所以盖章 URL 在 APK 开构时已可用；产物 `clutch-android-<tag>.apk` 附到同一
   Release）+ `.github/workflows/android-debug.yml`（手动触发，可选输入
   `pylibs_index_url`，默认最新 Release 的索引；产物只进 workflow artifact，
   不碰 Release——快迭代用，不污染供给线）。
3. **N5 前台服务**：新增 `TunnelService`（`foregroundServiceType="dataSync"`，
   manifest 同时声明 `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_DATA_SYNC`/
   `POST_NOTIFICATIONS`）——targetSdk 34 会冻结后台进程，隧道/引擎必须有前台
   才能活过 Activity 销毁。通知渠道 `tunnel`、`IMPORTANCE_MIN`（静默常驻）、
   `START_STICKY`（被杀拉起 → `NodeEngine.ensureStarted` 幂等重启引擎）。
   MainActivity `onCreate` 即 `startForegroundService`，API 33+ 请求通知权限
   （拒绝只影响通知可见性，不影响服务）。
4. **N7 窄屏**：`ui/mobile.css`（≤640px 生效；桌面因 media 属性天然 no-op）——
   顶栏换行、`#right` 工作区面板从 320px 侧栏改为 40vh 底部堆叠、弹窗限宽、
   欢迎卡自适应。只动宽度/内边距/排布，不动配色字体。
5. **冷启动竞态修复（顺带修）**：`android-host.js` 的 `start()` 绑定前先
   unlink 陈旧 `bridge.port`（壳以 150ms 轮询该文件；资产重拷的数秒窗口里，
   上一世进程留下的标记会把 WebView 指到死端口，且 EADDRINUSE 漂移可能换端口）。
   回归：`tests/bridge-server.test.js` 种假标记 + 占满 21 端口重试带 → 期望
   启动失败且**不留任何标记**。
6. `build.gradle` 钉 `ndkVersion '26.3.11579264'`（与 CI sdkmanager 安装项逐字
   对齐），`versionName` 走 `-PAPP_VERSION`。

**验证**：全 20 JS 套件 + `tests.selfcheck` 全绿（含新竞态回归）；manifest/
strings/drawable 过 XML 良构检查；两个 workflow 过 YAML 解析；脚本过 `bash -n`；
sync 复跑验证盖章文件与 mobile.css 两条新拷贝路径（有则拷、无则跳）。
Kotlin 与 Gradle 本机无 SDK 编译不了，正确性靠 CI 首跑验证（见下）。

**待验**（CI/真机）：release tag 流水线首跑出 APK；真机上前台服务在回桌面/
锁屏后保活、通知出现、重进 App 自动重连。

## M4：熄屏后的重连（引擎侧补线 + 唤醒锁 + 电池白名单）

**报告**："自动重连要等我把 App 切回前台才发生"——熄屏时也一样。

**根因**：重连的**策略**活在渲染层（`ui/js/conn-lost.js`：`connLostArm` 对
`document.hidden` 直接不布防，隐藏页的定时器本来也已经停了），重连的**能力**活在
引擎（前台服务保活的那半个进程）。隧道一断，唯一会拨号的那半边正被系统冻结。

**修法（JS 侧）**：把同一套拨号阶梯搬进引擎，做成两端共享模块
`ui/tunnel-ladder.js`（**不加任何新桥动词**）：

- 布防只认"用户自己发起且**成功**的 connect"；`disconnect` 与"没有窗口了"的
  `releaseSession` 撤防——没有开机自动拨号（保住 `backend-lifecycle.js` 的
  "nothing here dials it behind their back"）。
- 阶梯就是页面自己的退避表（`CONN_LOST_BACKOFF_MS`：1s 逐级加倍到 128s 封顶，一次
  一个尝试，永不放弃）；断线通知（`tunnel.onTunnelEnd`）到达后先释放已死的转发、
  再布防、最后才广播 `tunnel:ended`。
- 凭据用引擎**已经持有**的那份（`ssh_secrets`），**永不弹窗**：密码主机凭据没了就
  撤防、交回页面的对话框（否则等于把认证失败按退避表循环打，会被 fail2ban 拉黑）；
  用密钥/agent 连上的主机（那次 connect 本来就不需要凭据）照原样重拨。
- 重连成功回调宿主自己的 `ensureWindowBackend`（心跳优先的重认领），远端会话跨跳存活。
- 跳已经活着 ⇒ 撤防，绝不重置一条正在工作的隧道。
- **两条阶梯会撞车，败者不许拆胜者**：页面可见时页面自己也拨号（`conn-lost.js`），首拨
  与引擎阶梯同在 ~1s 落地。后到的那次 `connect` 按 `connectTunnel` 既有规则重置先到的
  那条（`state.sshClient` 在握手前就已装上，所以在飞的那次看起来和死掉的一样），先到者
  于是失败——它的失败路径只允许"仍然持有这条线"的那次拨号执行拆线（客户端身份判定，
  与 `tunnelGone` 同一条规则），否则败者会把刚刚赢下、正在握手的隧道一起拆掉、白丢
  一级退避。（`ui/tunnel-connect.js` 的 catch。）

**修法（Kotlin 侧）**：前台服务只保**进程**，不保**处理器**。熄屏后 CPU 挂起，引擎里
那个本该拨号的 `setTimeout` 要等手机因别的事醒来才会跑——这正是用户看到的症状。

1. 引擎把"用户此刻想不想要隧道"写成 `$HOME/tunnel.state`（`up`/`down`），由阶梯**自己
   的状态变化**驱动（`onState`：阶梯内部的两次主动放弃不经过任何调用点，所以观察者
   必须挂在阶梯上而不是调用点上）。启动时先删掉上一世进程留下的标记。
2. `TunnelService` 每 2s 读这个标记：`up` 时持 `PARTIAL_WAKE_LOCK` + `WifiLock`
   （Q+ 用 `WIFI_MODE_FULL_LOW_LATENCY`，之前用 `WIFI_MODE_FULL_HIGH_PERF`），
   `down` 时立即释放，`onDestroy` 一律释放。
3. `MainActivity.onResume` 在"标记为 up 且尚未豁免"时**每安装一次**问一次电池优化
   豁免——Doze 里平台会挂起网络并**忽略唤醒锁**，豁免才是让上面两把锁在口袋里真正
   有意义的那一步；后台启动 Activity 从 API 29 起被禁，所以这个问题只能由 Activity
   问。新增权限：`WAKE_LOCK`、`ACCESS_WIFI_STATE`、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`。

**验证**：`tests/tunnel-ladder-test.js` 新增"观察者"一节（布防/撤防各通知一次、重挂
同一主机不重复通知、凭据消失与"跳已活"两次内部放弃也要通知、观察者抛异常不破坏阶梯）
以及两端 wiring 的源码断言（含标记文件写法与开机清理）；`tests/tunnel-concurrent-dial-test.js`
用假 ssh2 钉住上面那条"败者不拆胜者"的规则（含两组对照：单拨失败仍然自己收尾、
旧行为下该套件会红）；全 JS 套件 + 离线 `./gradlew --offline :app:assembleDebug` 编译
通过，`scripts/sync-android-host.sh` 重新同步后 APK 的 `assets/nodejs-project/ui/` 里确实
带上了 `tunnel-ladder.js`（此前 assets 是旧拷贝，装的 APK 不含这半条命）。

**待验（真机）**：连接成功后锁屏 5–10 分钟，让远端 sshd/网络断掉，手机不碰屏幕，隧道应
在 ≤128s 内自己回来（`adb logcat -s clutch` 看 `[ladder] attempt`）；
`adb shell dumpsys power | grep clutch:tunnel` 应只在有隧道意图时看到这把锁。
未豁免电池优化时长 Doze 下仍要等到下次唤醒——**这一条来自设计而非实测**（本 checkout
无网络，developer.android.com 不可达，Doze/唤醒锁语义未能核对）。

## M4b：信任倒计时也会被冻住（permission 的同类问题）

**报告**："permission 也存在相同的问题，它在后台是会被冻结的，这导致自动通过的倒计时
会暂停"——开 Trust 后把 App 切到后台，Allow 按钮上那个 10 秒的自动通过不再倒数，
run 停在提示上。

**根因**：与 M4 是同一个平台行为（N5 的 `TunnelService` 一节：targetSdk 34 冻结后台
WebView 及其定时器）。信任模式的倒计时（"Allow 按钮自己按下去"）此前只活在渲染层
（`ui/js/permissions.js` 的 `setTimeout` 链），页面一冻秒数就停在原处；而
`PermissionGate.require` 按设计**没有超时**——一个冻结但连接还在的页面仍算 attached
（`ui/js/sse-stream.js` 的 `sseSuspend` 就是这条先例），于是 run 永远在等一个屏幕上
早已到点的答复，会话因此不被回收、`.clc` 的写锁也不释放。

**修法**：倒计时的**权威**搬到远端闸门（`agent/core/permission.py`）。`PermissionGate`
新增 `trust` 探针与 `TRUST_COUNTDOWN_S`：等待循环每次轮询都重读探针——开着就从进入
等待（或布防）那一刻起算，到点执行 `resolve(request_id, True)`，也就是**与 Allow 按钮
同一条判决**（因此它同样放行 escape，不像 `auto_allow`/非交互模式那样在 escape 上失败
闭合，并把路径记进工作区）；探针读到关闭就清空 deadline，于是**中途布防从布防起算、
中途撤防立即取消**，和点按钮一模一样。页面只剩**显示**用的倒计时：`trustDeadline` 改成
墙钟、`trustTick` 每次重算 `Date.now()`，解冻时 `trustResumeTick`（`visibilitychange`/
`pageshow`/`focus`）立即补算——过期的提示随手关掉，而不是重放它最后几秒。布防状态由
`POST /api/permission/trust` 镜像到 `RunState.trust_armed`（`agent/api/events.py`
`_permission_trust`），闸门以 `trust=lambda: self.state.trust_armed` 读到它；每次 SSE
`onopen` 重推一次，因为被替换/重认领的会话默认是撤防的。

**验证**：`tests/trust_countdown_test.py`（远端权威：布防即自行放行且确实等了倒计时、
撤防照常等用户、中途撤防取消、中途布防从布防起算、信任放行 escape 并把路径记进工作区、
没有探针时仍是原来的死等、两侧 10s 常量对齐、端点真的点亮**正在跑的那个** run 的闸门，
坏 body 是 400 而不是静默布防）+ `tests/trust-countdown-test.js`（页面侧：墙钟分母、
隐藏页不误答、解冻立即补答、布防/撤防各推一次、重连重推、`/api/permission/trust` 路径）。
全 JS 套件与 Python 套件（`trust_countdown_test`/`gate_detach_test`/`ask_replay_test`/
`server_test`/`selfcheck`）全绿。

**作用域**：布防是**这个窗口的会话**上的模式，不是单次 run 的开关——开着时本窗口发起的
每个 run 的提示都会自动通过（含它之后换开的别的项目），撤防立即恢复成等用户。**没有第二个
窗口能共享这个会话**，所以不存在"别的窗口的提示被顺手放行"这件事：

- `ui/host-core.js` 按 `webContents.id` 各自 claim 一个 session（`windowBackends`；
  `releaseAllBackends` 的注释：*"the machine may still serve other windows — their sessions
  keep running on it"*），`claimWindowBackend` 对没有 claim 的窗口一律 `session/start`；
- `agent/supervisor.py` 的回收契约逐字是"与窗口"（`_stale`：*"The heartbeat contract is
  with the WINDOW"*，每个会话 `spawn(uuid4()[:12], beat_required=True)`），会话按**它的**
  窗口的心跳被回收；
- `ui/js/sse-stream.js` 开头就是 *"One EventSource per window"*；
- 同一个 `.clc` 还有写锁挡着：`agent/project/__init__.py` `_acquire_lock` 撞锁即
  `ProjectOpenConflict`，`ui/js/project.js` 只给"只读打开"这一条出路（*"Read-only mode
  cannot run tasks"*），而只读项目起不了 run（`agent/api/run.py`）——第二个窗口连提示都
  生不出来。

服务端的 `broadcaster.count(project)` 之所以按**流**计数而不是"恰好一个窗口"，是因为窗口
自己的重连/boot 会短暂并存两条流（未带 `?project=` 的 unfiltered 流），而服务端本来就不知道
有几方在看它（`agent/api/events.py` 的 `_sse` 不设订阅上限，那里的 "another window" 指的是
"另一条客户端流"）。唯一能让一个会话被两个客户端共享的路径，是绕过 host 直接拿会话 URL 再
开一个客户端（隧道把会话端口转发到 127.0.0.1 上），或以后真做一个"共享/旁观同一会话"的
功能——都不是当前产品提供的流程；真到那时，`trust_armed` 才会需要改成按客户端持有。

## 隧道连上后卡在 "Starting tunnel…"（报告：0.1.47 连远端永远转，不落地也不报错）

**报告**：连远端时进度停在 "Starting tunnel…"，界面不报错也不超时——既没有失败提示，
也永远等不到连上那一刻。0.1.47 已经给这一步加了 4 秒的钟（上一版这一节写的就是那个钟），
报告照旧，所以**钟不是答案**。

**根因（一个"承重"的结构变化，不是时序）**：把注释剥掉只比这一个文件，
`git diff v0.1.33 HEAD -- ui/tunnel-connect.js` 里唯一承重的一处是 `b04b124`（v0.1.35）：
反向端口转发（`-R`）从"在同一个位置发出、发出即忘"变成"**被 await，而且它失败就等于这次
connect 失败**"。v0.1.33 里这条 `-R` 也在同一位置发出（本地转发之后、健康检查之前），但
结果没人等——它既拖不慢 connect，也压不垮 connect。v0.1.35 之后，**对端对一句 global
request 的态度成了这条连接的判决条件之一**。

**为什么表现是"永远转"**：`ssh2` 的 `client.forwardIn()` 只在**对端答复
`SSH_MSG_GLOBAL_REQUEST`** 时才回调（`ui/node_modules/ssh2/lib/client.js:1333`，回调由
reply handler 触发，别处不触发）。中间盒、非 OpenSSH 的 sshd、被卡住的 request 通道都足以
让答复永远不来；keepalive（15s×3）最后会把 client 拆掉，却**不会 reject 一个已经在飞的
promise**。而失败是有出口的：`ui/js/conn-flow.js` 的 `handleSshConnect` 把失败词写进同一个
状态/why 元素（`setFsConnectError`），**失败的连接会显示错误**。所以"停在 Starting tunnel…
且没有错误、也没有超时"只有一种解释：那个 await 从未 settle（`ui/tunnel-connect.js` 的
`progress("forward")` 打的正是这句标签）。同一阶段里其它每个 await 都是有界的（健康探测
`CONNECT_TIMEOUT_MS = 15000`、supervisor 探测 3s、exec 预算），于是结构很干净——连接
的判决依赖于远端"回不回话"，而远端可以合法地永远不回。

**修法（拆掉依赖，不是又一个超时）**：模型通路不再参与 connect 的判决。

1. **沉默 ≠ 说"不"**。`bindReverseForward` 的失败结果带上 `silent`：4 秒的钟到点、或 client
   自己死掉，都记 `silent: true`（"答复本来就不会来了"）；对端的拒绝（`Address already in
   use`）不带这个标记。阶梯在 `silent` 上**立刻停**——同一个问题问同一个不会说话的对端，
   只是再花一个钟；`installReverseForward` 也不再跟着问 port 0（那还是同一个问题，只是换个
   数字）。一次沉默的全部代价从"6 次 + port 0"变成一个 4 秒的钟。
2. **反向转发装在 connect 旁边，不装在它前面**。新增 `startModelPath(client)` /
   `awaitModelPath()` 与 `state.modelPath`（`null` / `"installing"` / `"listening"` /
   `"unavailable"`）：`establishForwardAndHealth` 用 `startModelPath(client)` 取代了原来那句
   `await installReverseForward(client)` 和它后面的 `failConnect`。这一层的门回到 v0.1.33 的
   那几道——本地转发、`waitForServer`（15s）、`probeSupervisorShape`（3s）。装不上就按
   15s→60s 退避重试（unref，且只对它自己那一代 client 有效；换 hop 时 `stopTunnel` 连钟一起
   清掉），所有提问者 join**同一个** in-flight promise，不产生第二个钟。
3. **真正需要"通路已就绪"的那一刻是会话被 spawn 的时候**。`ui/host-core.js` 在
   `supervisorSessionStart` 之前 `await deps.awaitModelPath()`（新依赖，默认 no-op，所以
   假依赖的测试不受影响），不是 `listening` 就照常起会话、但在日志里写明。这样
   `remoteLlmBase()`（远端会话的 `--base-url`）**永远不会指着一个没人服务的端口**——这正是
   那条测试一直钉的性质——而 connect 再也不被对端的一句话吊住。

**验证**：`tests/tunnel-reverse-port-test.js` 新增第 4 步，用同一根假线路搭一台**永远不回答**
反向转发请求的远端（`FakeClient.silent`）：connect 必须照常 `ok:true`（实测 **3ms**）、只问一次
`8892`、`tunnelStatus().modelPath` **不是** `listening`（实测 `installing`），而
`awaitModelPath()` 在 4 秒的钟上落成 `"unavailable"`（实测 4000ms）且不记住任何端口。
`tests/tunnel-reconnect.test.js` 6c 里那个"永远不回答"的用例改成钉"**只问一次**、不再问
port 0"，第 7 节新增源码断言：connect 里不再有 `await installReverseForward(client)`、host-core
的 claim 在 `supervisorSessionStart` 之前 `await modelPathState()`、repair 钟有 `unref` 且随
`stopTunnel` 归零。（该 runner 现在也把 `HOME` 指到 scratch 目录，不再往开发者真的
`~/.clutch/tunnel.log` 里写测试噪声——那份日志是现场证据。）

**回归证明**（探针 + 一次临时改动量出来的，两条都记实测）：同一个探针
`/tmp/park-probe.js`（`NODE_PATH=/tmp/stub/node_modules` 里的 ssh2 桩，对端永不回调）对着
**v0.1.46 的 `ui/tunnel-connect.js`**（`TUNNEL_MODULE=/tmp/old46-tunnel-connect.js`）跑到 8 秒，
`installReverseForward` **还在飞**——`after 8006ms -> STILL PENDING`，`forwards` 里只有一次
`8892`。那份文件里**根本没有钟**：`forwardIn` 不回调就没人推进阶梯，第一次尝试永远挂着，
这就是报告里那个"一直转"。同一个探针对着**现在这个文件**跑，4008ms 落成 `settled: false`，
而且只问了 `[8892]` 一次（不再跟着问 port 0）。那道门本身也量过：把 `startModelPath(client)`
临时换回 `await installReverseForward(client)`（失败即 connect 失败），第 4 步那台"永远不回答"
的远端就不再 `ok:true`，而是 `ok:false`、connect 在 4002ms 上失败——判决重新挂回"对端回不回话"，
这正是要拆掉的那条依赖（改动已还原，`grep -rn "TEMP REGRESSION PROBE" ui/` 无残留）。
真线上还有一次 A/B（真 sshd 跑在 127.0.0.1:2222，本地 8892 被占，于是走完整个"拒绝"阶梯）：
不装门时 connect **255ms** 落地，而模型通路 7459ms 才到 `listening`；把
`await installReverseForward(client)` 和它的 `failConnect` 装回同一份文件，同一根线上的 connect
变成 **7747ms**——同一个 7.5 秒的阶梯，一次是背景里的重试，一次是在屏幕上。

## 远端 pylibs 树被"合并安装"写坏：手机端报 "no backend"（报告："移动端连不上，报错 no backend"；"清后台好几次也连不上"）

**报告**：手机（Android）连 `124.220.181.209` 反复失败，界面停在 "Not connected — no backend"；
手机上清后台、重连多次无效。同一台远端上，桌面端 0.1.37 连它是卡在 "Starting tunnel…"（上一节）。

**根因（三层，都在远端）**：

1. **pylibs 安装是"覆盖"，不是"替换"**。`ui/tunnel-bootstrap.js:303-311` 的 pylibs 分支把 tar 上传后直接
   `python3 -c "import tarfile;tarfile.open('${dir}/pylibs.tar.gz').extractall('${dir}')"` —— 解压到**正在使用的**
   `site-packages` 上，不删旧树、不落 `.new` 再原子换名（对照同一文件 `:280-302` 的 bundle 分支：
   `.new` + `chmod +x` + `mv -f`，以及 `:267-270` 那句"the NAS refuses to truncate an executing binary in
   place: stop first"）。**tar 里没有的文件不会被删**：每装一次，上一代留下的 dist-info、旧 `.so`、旧子包
   全部留在原地。
   现场证据（`ls ~/.clutch-server/site-packages`）：pydantic `2.13.5 / 2.14.0 / 2.14.1` 与
   pydantic_core `2.46.5 / 2.50.0 / 2.50.1` **三代元数据同时在**（20 个 dist-info），
   而 `pydantic_core/` 下只有一个扩展模块文件名 `_pydantic_core.cpython-310-x86_64-linux-gnu.so`
   —— 三代里只有一个能占住它，其余全是残骸。
2. **"合并"会致命，是因为 tar 里 pydantic 的版本没有锁**。`scripts/build-pylibs-tar.sh` 只用
   `pip download openai==<客户端 venv 的版本> httpx2==<客户端 venv 的版本>`，传递依赖（pydantic 系）
   由**构建那天**的索引决定，所以不同发布带的 tar 装着不同的 pydantic 对。各 tag 的
   `pylibs-index.json` 里 `linux-x86_64-glibc-py3.10` 的工件版本就是这个漂移的指纹：
   v0.1.33 `5ecaf238f273085b`、v0.1.35-37 `11c0310476572913`、v0.1.38-39 `b68fe68323d96a63`、
   v0.1.40 `b3d9088ef19deb63`、v0.1.41 `e9c082e617d8b647`、v0.1.42-45 `edebdaf6c1133c52`、
   v0.1.46-48 `02af0e74dfd222d7`。两代 tar 叠在同一棵树上，叠出的就可能是一对**互不兼容**的
   pydantic / pydantic_core。现场 `PYTHONPATH=site-packages python3 -c "import pydantic"` 直接：
   `SystemError: The installed pydantic-core version (2.50.1) is incompatible with the current pydantic version, which requires 2.46.5.`
   （该机 `VERSION` 里的 `5ecaf238f273085b` 正是 v0.1.33 那代的工件哈希，即最后一次**完整**安装是
   0.1.33 一代的 tar；三代元数据说明此后还有别的 tar 解压过，只是没走到写 `VERSION` 那一步。）
3. **会话因此起不来，客户端只能看到 "no backend"**。会话子进程是 `python3 -m agent.server`，
   `agent/server.py:43` → `openai` → `pydantic` 导入即崩（`/tmp/clutch-server.log` 有完整栈）；
   监督进程的 `/api/session/start` 于是回 `500 {"error":"session start failed"}`。手机端
   `startLocalSession: null` + `supervisorBase: () => null`（`android/host/android-host.js`，N4：手机上
   不跑本地后端），claim 失败就是"窗口没有后端" → "Not connected — no backend"。**远端本身的 sshd、
   隧道、反向转发都是好的**：本次修好后现场实测 `/api/session/start` → **200**
   `{"session_id":"15dc3eb4681b","port":41137}`，该会话 `/api/health` → `{"ok":true,"in_flight":false}`。

**为什么重连修不好它：安装门槛是"标记相等"**。`ui/tunnel-bootstrap.js:240` 的
`installed = probe.installedVersion === version` 比的是 `~/.clutch-server/VERSION` 里的**工件内容哈希**，
而"树是坏的"并不改变这个哈希——坏树永远算"已安装"，重连既不重装也不检查。用户"清后台好几次也没用"
就是这一条：客户端侧能做的都做了，服务端那棵树没有任何人去看，也没有任何一条路径会去看。

**现场始末（0.1.48 那次会话留下的痕迹，供下一次修复时对照）**：`~/Clutch/ui-upgrade.clc` 的最后一轮
（10-15 10:12–10:26 UTC）里，卡在同一句 SystemError 上的会话先被读出"2.50.1 的 `.so` + 2.13.5 的
`pydantic/`"，随后 10:26:37 的最后一条命令**故意**把 2.50.1 的 `.so` 覆盖回 `site-packages`
（把 2.46.5 的备份到 `/tmp`），做"远端坏掉时客户端怎么报"的实验；会话在 10:26:38 就断了，
于是实验现场一直留在机器上。也就是说：**最后的坏对是那次实验留下的，而它复现的混合物本身来自第 1、2 条**。

**顺带记录：8892 被占时，0.1.43 及更早的客户端是硬失败**。现场 `127.0.0.1:8892` 被手机那条 ssh
会话自己的反向转发占着（`sshd: ubuntu@notty`，16 分钟没人用），同一时刻桌面 0.1.37 的四次重连每次都在
6 次 `Unable to bind to 127.0.0.1:8892`（`REQUEST_FAILURE`）后判死，并写下
`[health] FAIL: the far side could not be given a listener on 8892 (the model path is dead)`
（`~/.clutch/tunnel.log`）。0.1.44 的 `e6340ea` 已经会向对端要一个自选端口（port 0）——本次实测
`forwardIn('127.0.0.1', 8892)` 被授予、`forwardIn('127.0.0.1', 0)` 被授予 `32909`（两者随后都
`unforwardIn` 释放）——但**装着的那个 0.1.37 没有这条回退**，所以它在"8892 被占"这个形状上仍然必失败。

**修法（已实施，0.1.49；前三条是缺陷本身，第四条是让第 1、2 条不再复发的锁）**：

1. **pylibs 安装改成"替换"语义**（`ui/tunnel-bootstrap.js` 的 `pylibsInstallCmd(dir)`）。tar 先解到**同一文件
   系统**上的 `${dir}/pylibs.stage`，然后 `test -d ${stage}/site-packages -a -d ${stage}/agent` ——
   **两棵树都到场才动手**，只带了一棵的 tar 一颗都不装。换名沿用"旧的先让位"：`site-packages`、`agent`
   逐个 `rm -rf X.old && (mv X X.old 2>/dev/null || true) && mv ${stage}/X X && rm -rf X.old`；两个 `mv`
   之间断掉，留下的是可恢复的 `X.old`，不是一个空洞。最后 `rm -f` 掉上传的 tar。整条链的尾巴是
   `` ; rc=$?; rm -rf ${stage}; test $rc -eq 0 ``：失败时也清掉半解压的 stage（手机上那是几十 MB，本来要
   躺到下一次尝试自己的 `rm -rf`），同时**保留非零退出码**。`installServer` 就读这个退出码：非零即
   `{ok:false, error:"the remote could not unpack the wheels (exit N…). Nothing was replaced — the far
   side's tree is the one it had."}` 直接返回——**不写 `VERSION`/`STRATEGY`、不起 supervisor**。写 `VERSION`
   的那行只在真的换完之后才走到，所以"这个标记说装好了"第一次成为事实，而不只是意图。
2. **门槛补一条"树能自证"的检查**（同文件的 `TREE_PROBE_CMD`，插在 `PROBE_CMD` 的 `__ART__` 与 `__NET__`
   之间；`parseProbe` 收成 `probe.pylibsTree`）。探针是一次 `PYTHONPATH=site-packages python3 -c`，只回答一个
   词：`NONE`（`VERSION` 描述的树不在）、`DUP:<name,…>`（同名 dist-info 有多代——第 1 条的现场形状）、
   `IMPORT:SystemError|ImportError|Other`（轮子都在、一起 import 就崩）、`OK`、`NOPY`（没有 python3 可问）。
   判决函数 `pylibsTreeSound(verdict)`：只有 `OK` 算健全；`""`/`NOPY`/`UNKNOWN` **不是对树不利的判断**
   （没有 python3 的远端本来就被拒绝装 pylibs，所以这个默认不会放过任何健康树），其余一律重装。门槛因此是
   `installed = (probe.installedVersion === version) && (strategy !== "pylibs" || pylibsTreeSound(probe.pylibsTree))`
   ——"坏树永远已安装"到此为止；命中时 `[bootstrap]` 日志自带
   `; the VERSION file matches but its tree does not (<verdict>) — installing over it`。
   探针程序里唯一的 `__` 就是分隔符本身，所以 `except` 按**名字**分别捕获，不反射 `type(exc).__name__`
   （那会把分隔符打进程序；测试断言程序与输出都不含 `__`）。
3. **反向转发在 teardown 时显式归还**（`ui/tunnel-lifecycle.js` 的 `releaseModelPath(client)`，在 `stopTunnel`
   里、清 `modelPath` 那几项**之前**调用）。守卫是"这条 hop 确实拿到过 listener"：
   `state.modelPathClient === client && state.modelPath === "listening" && state.llmProxyRemotePort`，然后
   `client.unforwardIn("127.0.0.1", port)`。**只归还自己被授予的那个编号**（`tunnel-core` 的 `remoteLlmPort()`
   故意跨 hop 记住端口，所以 teardown 不清 `llmProxyRemotePort`；去 cancel 一个自己从没被授予的端口，是在对
   别人的 listener 发话）。尽力而为：不 await、不影响 teardown 的结论；socket 已经不在了时 ssh2 抛
   `Not connected` → 日志 `[disconnect] reverse forward release skipped`。
4. **wheel 集按客户端 venv 钉死**（`scripts/build-pylibs-tar.sh` 的 `PINS`）。除既有的 `openai`/`httpx2`，
   新增从同一个 venv 读出的 `pydantic`/`pydantic_core`：`pip download` 与 `pip install --no-index` 两边都吃
   `"${PINS[@]}"`。这样 tar 的内容是**锁的函数**，而不是"哪天构建"的函数——每代 tar 各自自洽，于是第 1 条那类
   "两代叠出互不兼容的一对"在源头不再产生。可用性不是猜的：`pydantic_core` 在发布矩阵的每一条腿
   （`manylinux2014`/`musllinux_1_1` × `x86_64`/`aarch64` × `cp310`–`cp313`）都有 wheel，`pydantic` 则是
   pure-python wheel。

**验证与回归（全绿）**：

- `tests/pylibs-install-merge-test.js`（新增）：真 bash + 真 tar + 真 python3。钉住"命令不含
  `extractall('<dir>')`、解包目标必须是 `pylibs.stage`、`test -d … -a -d …` 夹在两个 `mv` 之间、`rm -f` 在最后、
  尾部确有 `rc=$?; rm -rf …pylibs.stage; test $rc -eq 0`"；连续装 A→B 之后 `pkg_a-1.1.0.dist-info` /
  `pkg_core-1.0.0.dist-info` 各只剩一代，A 独有文件（`pkg_a/only_in_a.py`、`agent/old_only.py`）消失，agent 树
  被整体替换，不留 `.old`/stage；缺 `agent/` 的 tar 与坏 tar 都**非零退出**、live 树 sha256 **逐字节不变**、
  stage 被清掉。同文件用真 `TREE_PROBE_CMD`（HOME 指向 scratch）产出 `NONE`/`OK`/`DUP:pydantic_core`/
  `IMPORT:SystemError`，PATH 置空 → `NOPY`，并断言 `PROBE_CMD` 内含它、与其余段落解析互不干扰。
- `tests/tunnel-reconnect.test.js` 新增三节：5b（`pylibsTree` 缺失/`""`/`NOPY`/`OK` → 不装；`DUP:`/
  `IMPORT:SystemError`/`NONE` → 装，且日志含 `the VERSION file matches but its tree does not (<verdict>)`）、
  5c（上传成功但解包失败 → `ok:false`、`VERSION` 未变、supervisor 未起）、6d（假 client 记顺序：`unforward:`
  在 `end` **之前**、端口仍被记住；`modelPath` 不属于本条 hop 时**不** cancel；`unforwardIn` 抛
  `Not connected` 时 teardown 仍走完）。
- `tests/tunnel-quiet-forward-test.js`（真协议；`tests/fake-sshd.js` 现记录 `cancel-tcpip-forward:<port>`）：
  被授予 8892 的那条 teardown 时**恰发一条** `cancel-tcpip-forward:8892`；对端自选端口的那条 cancel 的**是
  它自己的**编号、**没有**碰 8892；安静退出的那条**一条都不发**。
- `node tests/android-pylibs-path-test.js`（两次真构建）：新增断言 tar 里 `openai`/`httpx2`/`pydantic`/
  `pydantic_core` 各只有一代，且版本分别等于客户端 venv 自己的版本；两次构建 sha256 仍然相同（`VERSION` 门槛与
  `~/.clutch/bundles` 缓存的前提不变）。

**仍未做（不在本次范围）**：真机端到端（桌面与手机两端都要人工操作）；对端 sshd 的 `ClientAliveInterval 60` /
`ClientAliveCountMax 3`（系统级改动，待确认）——没有它，对端 sshd 默认 `ClientAliveInterval 0`，半死会话仍能占到
TCP keepalive（默认 2 小时）；以及"替别人收回 8892"在协议上做不到：一条连接只能 cancel 自己被授予的 forward，
所以第 3 条归还的只是**自己**那一条。

## 启动器图标（报告："移动端目前还没有图标"）

**报告**：APK 装到手机上，桌面/应用抽屉里是系统默认的 Android 小人，不是那枚红 ▣。

**根因**：`AndroidManifest.xml` 的 `<application>` 从头到尾没有 `android:icon`，`res/` 下也
只有通知小图标 `drawable/ic_stat_clutch.xml`、`values/strings.xml` 和网络配置——没有任何
`mipmap/`。平台于是画它自己的占位图。**没有任何东西会因此报错**：构建、`apksigner` 指纹
校验、安装、CI 全绿，`aapt2 dump badging` 只把这件事印成一行
`application: label='Clutch' icon=''`（0.1.44 实测）。

**修法**：图标从桌面端同一枚品牌标记生成，来源只有一个——`scripts/make-icon.py`（纯标准
库）现在同时喂 `ui/build/icon.{png,svg,ico}` 与 `app/src/main/res/`，两边不可能漂移。标记
本身没变：红 `#EF4444`（`RED`）的 ▣ 画在 `#0F0F10`（`BG`）的方块上，视口 512，几何常量
`RING_OUTER=168`/`RING_INNER=104`/`CENTER_HALF=72`。`render()` 这次改成形状/透明度感知
（`inside_tile()` 是个圆角矩形 SDF，`radius<=0` 就是不透明整块），桌面三件套在这个重构后
仍逐字节不变（`git diff --stat -- ui/build/` 为空）。

1. **API 26+：自适应图标**（`res/mipmap-anydpi-v26/ic_launcher.xml`）。108dp 画布，前景
   `res/drawable/ic_launcher_foreground.xml` 是 512 视口里的一条 `<group>`：缩放
   `adaptive_mark_scale()` = `72/108 × ANDROID_MARK_SCALE(0.84)` = **0.56**，平移
   `512*(1-0.56)/2 = 112.64`——先把标记按"遮罩保留的 72dp"而不是"108dp 画布"来摆
   （`adaptive_scale()`），再按报告的遮罩留白收进去（`ANDROID_MARK_SCALE`）。标记现在宽
   39.7dp = 72dp 可见框的 **55.1%**（收进去之前是 65.6%），外接圆半径 28.1dp（原 33.4dp），
   离遮罩自己的 36dp 圆**还有 7.9dp 空隙**（原 2.6dp，也就是报告的"红块四角顶着圆角边"）。
   背景是 `res/values/colors.xml` 的 `@color/ic_launcher_background` = `BG`（启动器把它画在前景
   后面，再套自己的遮罩）。路径由 `mark_path_data()` 生成：外框顺时针、挖孔逆时针、内核
   再顺时针——nonzero 填充下这才算"一个洞"，而不是三块叠上去的色。桌面三件套仍按
   `mark_scale = 1.0` 渲染，几何不变。
2. **API 24–25：位图**（`res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`，
   48/72/96/144/192，即 `LAUNCHER_DENSITIES`）。这两个版本没有自适应图标，形状得自己画：
   圆角方块（圆角半径 `TILE_CORNER=0.22` 边长），方块之外透明。缩像素时 RGB 只对真正被
   覆盖的样本取平均（预乘），所以圆角弧上不会晕出一圈黑边。这里**不缩标记**（缩它没有
   意义：不遮罩就没有边缘可顶），只缩自适应前景那一份。
3. **不加 `roundIcon`，也不出 `mipmap-*-round`**：API 26+ 的启动器会给自适应图标套它
   自己的遮罩，一套圆图只服务 API 25，纯粹是多一份要同步的东西。检查里断言
   `android:roundIcon` 必须缺席。

**验证**：`tests/android_icon_check.py`（`python3 -m tests.android_icon_check`）。**纯标准
库**，不 import `tests.testsupport`——两个 Android CI job 都不装 Python 包。它管：manifest
的声明（`android:icon == @mipmap/ic_launcher`、无 `roundIcon`）；`res/**/*.xml` 每个都良构
且 `@color`/`@drawable`/`@mipmap` 引用都能解析；自适应图标确实是 `<adaptive-icon>`、背景是
`BG`、前景是 108dp 的 `<vector>`、`<group>` 的缩放/平移等于生成器算出的那两个数、唯一那条
`<path>` 等于 `mark_path_data()` 且填 `RED`；**标记的留白**：它用 `gen.adaptive_mark_scale()`
现场重算，断言外接圆 ≤ 33dp keyline 且离 36dp 遮罩 ≥ 6dp（失败信息直接写"was 33.4dp"/
"was 2.6dp"，也就是报告的旧几何）；五张位图是正确尺寸的 8 位 RGBA（圆角透明、中心 `RED`、
边上 `BG`、过半不透明、且没有比 `BG` 更暗的像素——晕边闸），并且**红带宽度**等于
`2*RING_OUTER*ANDROID_MARK_SCALE/512*边长`（±2px），既有 `red_extent()` 逐行量；最后把
桌面三件套 + 5 张位图 + 3 个 XML 与"当场重渲染"的结果逐字节比对，并单独断言**桌面**图标
仍是满幅 336px 的红（缩标记只发生在 Android 那一份）。

先本地后 CI：本机构建的 APK 过 `aapt2 dump badging`，那一行从 `icon=''` 变成
`icon='res/mipmap-anydpi-v26/ic_launcher.xml'`，五张位图登记为
`application-icon-160/240/320/480/640`；`res/` 整目录过 `aapt2 compile`。两个 workflow
（`release.yml` 的 `android-apk`、`android-debug.yml`）都在 checkout 之后跑这条检查。

**回归**：六种改法全被拒——manifest 丢掉 `android:icon`；`colors.xml` 被手工改成
`#FF000000`；位图翻一个字节；删掉 `mipmap-hdpi`；XML 注释里出现 `--`（这个真撞上过一次：
第一版 `colors.xml` 的注释里写了 `--bg`，`aapt2 compile` 报
`values/colors.xml:0: error: xml parser error: not well-formed (invalid token)`）；加回
`android:roundIcon`。**留白这条也单测过**：在进程内把 `gen.ANDROID_MARK_SCALE` 改成 1.0
（旧几何）后重跑，keyline/空隙/红带宽度三处检查当场变红。

**待验（真机）**：装到手机上，抽屉里出现红方图标；圆形与方形两种遮罩下标记本体都不被裁，
四角与圆角遮罩边之间看得见那圈留白（55.1% 这条留白就是为它准备的）。

## 源镜像在手机上够不着（报告："下载/上传服务器还得走 VPN——国内镜像没生效"）

**报告**：APK 里"国内镜像"这个开关看不出有任何作用：组件市场下载、给远端装 pylibs 仍然要
翻出去。

**根因**：镜像**在手机上根本没有入口**。它读的是 `CLUTCH_SOURCE_MIRROR` env 或
`~/.clutch/settings.json` 的 `source_mirror`（`ui/net-fetch.js` 的 `mirrorPrefix()`）——
而手机上的 HOME 是 App 自己的 filesDir（N2 在 Node 起来之前设好）：没有 shell 可 export，
也没有文件管理器能写进去。`writeSettingsMirror()` 之前更是**没有** `source_mirror` 这一支，
UI 里也没有这个字段。也就是说"写进 ~/.clutch/settings.json"这句话在手机上是一句谁也做不到
的事。文档 §12.3 当时的定案是（**不默认镜像、不自动回退**），这里只能拒绝塞一个第三方
加速器进去；那条定案已被 `PLUGIN_UI_PLAN.md` §十四 翻转——随包带一份**可回退镜像表**
（`ui/components.mirrors.json`，三条前缀，用户自己的条目排在前面），但它**只**在"看起来
是网络原因"的失败上重试（超时、`ECONNRESET`、网关/超时状态码），404、digest 不符、
schema 错**一次都不重试**，manifest 读取也不自动回退。手机侧因此多出三条 IPC
（`android/host/android-host.js` 的 `components:mirrors` / `components:mirror-add` /
`components:mirror-remove`，与桌面 `ui/main.js` 同名同形），插件页多出 Mirrors 一节。
字段仍然是那条"整条线都走镜像"的开关，两者互不替代：设了 `source_mirror` 就走它、
镜像表不再被读（页面上那句 `every source is read through …` 说的就是这个）。这一节讲的
仍是**把开关修成真的能用**。手机侧唯一的 github 取数就是 pylibs 的索引与 tar
（`android/host/artifact-provider-android.js`），所以这条线上"没生效"最刺眼。

**修法**：三处，一个开关。

1. **入口**：插件页顶端一个 `Source mirror` 字段（`ui/index.html` 的 `.plug-mirror`，放在
   `#settings-pane-plugins` 里、在"目标机器"那一大块**上面**——它是**客户端**设置：决定
   这台机器到哪里去读字节，与远端装了什么无关）。它明确是"**保存**"这个动作
   （`#mirror-save`，不是敲一个键就落盘），并有一条 `role="status"` 的判词行：非 http(s)
   的值当场被拒（`"…" is not http(s): a mirror is the prefix a source URL is read under,
   so it has to be a URL too — nothing was written`），成功则印出当前取值并重申"每个
   digest 仍然对 release 自己的 pin 校验"。保存顺序是**先宿主、后本窗口**（`localStorage`
   的 `clutch_source_mirror` 只负责让下次打开时字段是满的）：宿主写失败、抛错、或根本没有
   这个通道时，本窗口绝不留下一个"并不生效的镜像"；保存成功后清掉上一轮 verdict 并
   `plugRead({ force: true })` 重读市场——字节从哪来刚变了，刚才失败的源可能就活了。
   尾斜杠归一化（`https://m/` 与 `https://m` 是同一个镜像）在字段侧完成。
2. **落盘**：`ui/settings-mirror.js` 的 `writeSettingsMirror()` 补上 `source_mirror` 这一支，
   规则与旁边几个旋钮一字不差——有值就写、`""` 清空、`undefined` 保留，并且与文件里既有的
   键**合并**（`ssh_secrets` 和别的未知键都活着）。这是手机上唯一的落点，也是
   `mirrorPrefix()` 唯一能读到镜像的地方。
3. **看得见**：`android/host/artifact-provider-android.js` 的 `fetchUrl()` 每次前缀变化就往
   隧道日志写一行（`[artifact] source mirror <prefix> — fetching <mirrored url>` /
   `[artifact] no source mirror set: fetching <url> (github.com) directly`，一次前缀只写一行，
   不给 30MB 的 tar 的每一块都写一行）——手机上唯一能亲眼看到的判据就是这行日志；tar 取数
   失败也把**实际请求的 URL** 写进去（`[artifact] tar fetch failed: <url> :: <原因>`），
   "它到底在问哪个域名"一句话就有答案。插件列表里原来那句"请手写
   `~/.clutch/settings.json`"也改成指向上面这个框。

**验证**：`tests/components-panel.test.js` 第 37 节（真页面 + 迷你 DOM）：字段从本窗口那
份副本回填、没有就是"no mirror"、非 http(s) 的值**一个字节都没写**且判词是红的、正常保存
按"宿主 → 本窗口 → 重读市场"的顺序发生（`settingsSaves` 恰好一次、`source_mirror` 是归一化
后的前缀、`marketCalls` 与 `listCalls` 各 +1）、空值 = 回到 github.com、宿主拒绝/通道抛错/
通道缺席三种失败都不在本窗口留副本，最后还钉住样式表：`.plug-mirror` 是 `flex: none`
（会滚走的字段不是判词行指向的那个门）、输入框把宽度让给 Save、`.plug-mirror-note.error`
才是失败色。镜像表自己另有单测（`tests/mirrors.test.js`：用户条目在前、去重、只有看起来
像网络问题的失败才回退、`forced()` 压过全表）；`tests/components-panel.test.js` 第 38 节
钉住这一节在桌面与手机上的读取和两个写入（`mirrors()` / `addMirror()` / `removeMirror()`
三条通道，随包条目没有 Remove，设了 `source_mirror` 时字段与按钮一起变灰）。
`tests/settings-mirror.test.js` 第 6 节：`{source_mirror}` 这种"只带一个键"的保存写在
`~/.clutch/settings.json` 里、与 `ssh_secrets`/`custom` 合并、不再提它时保留、`""` 清空。
`tests/android-provider-test.js` 第 10b 节：**env 完全不设**，只把 `source_mirror` 写进沙箱
的 settings 文件，索引与 tar 仍然整条走镜像（origin 一次都没被访问）——这正是报告描述
的那条路径；`source_mirror: ""` 则是关掉它的那把开关。`tests/net-fetch.test.js` 既有几问
继续钉住 env 优先、非 http(s) 被丢弃、`{profiles, active}` 折叠。
**回归证明**：把 `writeSettingsMirror` 里 `source_mirror` 那一支删掉重跑，
`tests/settings-mirror.test.js` 第 6 节当场变红（`actual: undefined`）。

**待验（真机）**：手机上填一个镜像并保存 → `adb logcat -s clutch | grep '\[artifact\]'`
出现 `source mirror https://… — fetching https://…/https://github.com/…`；清空后再连一次，
同一行变成 `no source mirror set: fetching … (github.com) directly`。此时在**不能**直连
github.com 的网络里，组件市场与远端 pylibs 安装都应能走通。

## 系统栏不是 App 的底色，两指还会放大整个界面（同一次真机反馈里的两条）

**报告**：

1. 状态栏和导航栏是浅色/发白的，和 App 的 `#0F0F10` 底色对不上——看着像"屏幕底下还有一层别的东西"，不是 App 的一部分。
2. 界面上很容易误触两指，一放大整屏就糊住，而且**不会自己回去**：布局没有重排，顶栏和输入框被推到屏幕外。

**根因**：两条都是壳的默认值，代码里一行都没写过。

- 主题：manifest 指向平台的 `@android:style/Theme.Material.Light.NoActionBar`。Light Material 继承 `Theme.Light`，其 `windowBackground` 是 `@color/background_material_light`（`material_grey_50`，约 `#FAFAFA`），`statusBarColor` 是 `?attr/colorPrimaryDark`（浅色 Material 下就是灰），而 `navigationBarColor` 是 `@color/navigation_bar_default` = `#00808080`——**alpha 是 0x00，即完全透明**：那条近白的窗口底色从导航栏里透出来，正是用户看到的白。`res/values/` 此前**没有 themes.xml**，三个值一个都没被改过。
- 缩放：`WebSettings.supportZoom` **默认 true**，`MainActivity` 只设了 `javaScriptEnabled` / `domStorageEnabled`，`ui/index.html` 的 viewport 也没写上上限。WebView 于是内建了双指与双击放大，放大的是**视觉视口**（不触发重排），所以表现是"糊上去且卡住"，而不是"响应式变大"。

**修法**：一层管一条，四处在代码里。

1. 新增 `app/src/main/res/values/themes.xml`：`Theme.Clutch`，父主题是**深色**的 `@android:style/Theme.Material.NoActionBar`（深色父主题的 `windowLightStatusBar` / `windowLightNavigationBar` 本来就是 false，栏上图标识天然是浅色，不必赌），`windowBackground` / `colorBackground` / `statusBarColor` / `navigationBarColor` / `navigationBarDividerColor` 全部指向同一个 `#FF0F0F10`（`clutch_bg`），`windowDrawsSystemBarBackgrounds` = true。**没有**建 `values-v27` / `values-v28`：配置目录里的 style 是**整袋替换**而不是合并，建了就得分身重写全部 item；两个新属性（API 27/28）在旧平台上不认识的属性 ID 会在 inflate 时被忽略。
2. `AndroidManifest.xml` 的 `<application android:theme>` 换成 `@style/Theme.Clutch`。顺带的正效应：`offerBatteryExemption()` 那个 `AlertDialog` 继承 Activity 主题，现在是深底浅字，和 App 同一张皮（此前是浅灰底的系统对话框，看着像另一个应用）。
3. `MainActivity`：`webView.setBackgroundColor(getColor(R.color.clutch_bg))`——`setContentView` 到页面首帧之间那块平台白底就没了；`showEngineError()` 的内联页补上 `background:#0F0F10;color:#F2F2F4`（此前是一张白底网页，看着像"崩到浏览器里了"）。
4. 缩放：`webView.settings.apply { setSupportZoom(false); builtInZoomControls = false; displayZoomControls = false }`；`ui/mobile.css` 的 ≤640px 块给 `html, body` 加 `touch-action: pan-x pan-y`（第二道；**`manipulation` 不能用来干这个**，按规范它恰恰是"允许 pinch"的那个值）；`ui/index.html` 的 viewport 补 `maximum-scale=1.0, user-scalable=no`——这条只当意图记录：Chrome/WebView 出于无障碍会忽略它，真正的闸门是 `setSupportZoom(false)`。

**为什么不会弄坏 App 自己的双指**：图表查看器不靠原生缩放。`ui/js/diagram-viewer.js` 用 pointer events 自己做 pinch（`pointerdown` 里 `setPointerCapture`，两个 pointer 时算 `dvZoom`，`dvApply()` 只改 `transform`），`.dv-stage` 本来就有 `touch-action: none`。`setSupportZoom` 只关视觉视口的原生缩放，pointer 事件一条不少。

**回归**：`tests/ui_css_check`（含 `android/.../assets/ui` 的逐字节副本）、`tests/ui_fonts_check`、`tests/android_icon_check` 全绿。`clutch_bg` **没有**写进 `values/colors.xml`——那个文件由 `scripts/make-icon.py` 生成、被逐字节钉死，往里加一条图标闸门就会红。产物侧证据：`aapt2 dump resources` 里 `style/Theme.Clutch` 是 8 条 item、父主题 `0x0103022e`，清单的 `android:theme` 指到 `0x7f0a0005`；`dexdump -d classes3.dex` 里在 `const/4 v2, #int 0` 之后连着 `setSupportZoom` / `setBuiltInZoomControls` / `setDisplayZoomControls`，即三个都传 false。**覆盖不了的一条**：系统的无障碍"强制启用缩放"/放大手势是用户设置，App 无法覆盖，开着它时仍会放大。

**待验（真机）**：状态栏、导航栏、App 底色三处同色，栏上图标识是浅色（不出现深图标压在近黑栏上）；旋转屏幕、弹出软键盘时系统栏区域不闪白；聊天区/顶栏两指乱蹭不再放大，双击也不放大；图表查看器里捏合、双击 1:1、拖动照旧。

## process 块在手机上是"蹦"出来的，"load earlier records"点下去像没反应（同一次真机反馈里的两条）

**报告**：

1. 一轮回答结束后那块 `process · N steps` 折叠区，在手机上是**瞬间展开/收起**的，一点过渡都没有（桌面上看着是滑开的）。
2. 点 "load earlier records"，**点完当下像什么都没发生**：要等好一会儿才看到内容插进来，中间没有任何进度或加载提示。

**根因**：两条都出在 `ui/` 里，一条是动画属性选错了引擎，一条是把"等待"放进了没有反馈的地方。

- 折叠：`ui/js/stream-text.js` 的 `foldAnim()` 把 `grid-template-rows` 从 `Npx` 动画到 `Mpx`。**grid 轨道可插值是从 Chromium 107 才开始的**（`mdn/browser-compat-data` 的 `css/properties/grid-template-rows.json`，`animation.support.chrome.version_added = "107"`，`chrome_android` 镜像桌面）。桌面端 Electron/Chromium 够新，所以本机怎么试都是滑开的；而**手机上这个页面跑在系统 WebView 里**，WebView 的版本属于设备、不属于 App——短于 107 的引擎里这个属性**不是可动画属性**，Web Animations 不会报错，只是整段时长都停在起始值（`0px`）上，然后一帧落到全高。报告里的"瞬间展开"就是这个。
- 翻页：一页是**一个** `/api/history` 请求，预算是一兆字节**且**整轮（服务端从磁盘读，并把起点回退到开这一轮的那条 task 行，`agent/core/lazy.py aligned_start`），回复之后那次 prepend 又是**一趟同步**跑完的。也就是说"从点到看见"中间没有任何可显示的状态，原来的 `paging = true` 只是不给第二次点，读者看不见它。

**修法**：两条都改在"看得见的那个东西"上。

1. 折叠的位移改成盒子的 `height`（px），那一格 grid 轨道在移动期间用内联 `1fr` **保持撑开**（`ui/style.css` 的 `.fold` / `.fold.open` 仍是 0fr/1fr 的**静止态**，夹住内容的仍是 `.fold-inner { overflow: hidden }`）。`height` 在所有这个页面会跑的引擎里都可插值，而且是同一个数：同一批像素、同一个节奏（`foldMoveMs()` 量的还是内容高度）、同一条曲线。轨道必须保持 `1fr`——留 0fr 会在收起时把内层夹成 0，盒子就是在**空转**里缩小。收尾（`onfinish`）和 `prefers-reduced-motion` 分支都把 `style.height` 与 `style.gridTemplateRows` 一起清掉，让样式表接管。
2. 等待放进**刚被按下的那个控件**：`#older-pill` 里多了一个 `.older-spinner`（10px 环，`--border` 底 + `--accent` 缺口，静止时不占位、不跑钟），`.older-pill.busy` 把边框与文字换成 accent、`cursor: progress`，标签在三个状态间走同一句话（`paintOlderLabel()`，读数来自 `olderBusy`）：`load earlier records (3.0 MB)` → `loading 3.0 MB…` → `rendering earlier records…`。`aria-busy="true"` 给读屏。`setOlderBusy("fetch")` 是**同步**写在第一个 `await` 之前的，所以按下的那一帧就有环；回复到了之后先 `setOlderBusy("render")` 再 `await nextPaint()`（两次 rAF）——否则标签变完就立刻被那趟同步 prepend 冻住，等于没变。`finally` 里清空，失败也回到 offer。附带两点：`olderSizeLabel()` 一律向上取整到整 KB、大于等于 1 KB 才写成一位小数的 MB，**永不写 0**；重连流中途来的 `history` 帧（`js/stream-events.js` 的 `setOlderPill`）只会重写同一句话，不会把环顶掉。

**为什么不是进度条**：这条等待里没有可量的进度——请求是一次性的，服务端一次把整页读出来，没有分片也没有逐条回调。画一条按时间猜的条会说谎；环是"正在进行、不知道还要多久"的诚实物，也和 App 里其它在等的地方（`.open-progress` 的条只用于**有**分片数量的启动阶段）分工一致。大页的那种几十毫秒的**渲染**停顿另有第二句话（`rendering earlier records…`），因为那一趟跑在主线程上，条也会一起停住，能动的只有已经画出去的字。

**回归**：`node tests/older-pill-test.js`（新，18 条）拿**真的** `loadOlder` 对着 stub 的 pill/pane 和一个手动 resolve 的 promise 跑，钉的都是**顺序**：按下的那一帧就 busy（请求还没发出去）、第二次点不发第二个请求、中途 `history` 帧不夺走等待、回复后先出"rendering"再 prepend、prepend 只发生一次且插进去就是渲染出来的那一行、`older = 0` 时 pill 隐藏、失败回到 offer 且只报一行。`node tests/fold-motion-test.js` 同步改了：keyframes 只带 `height`/`opacity`（**没有** `gridTemplateRows`）、移动中 `fold.style.height === "0px"` 而 `gridTemplateRows === "1fr"`、`onfinish` 与 reduced-motion 两条路都清掉内联样式；像素节奏那条断言改成读 `height`。`tests/ui_css_check` 里 `foldMoveMs` → `duration: ms` 的形状与样式表 token 的钉子都还在。改动后跑了全量：`tests/*.js` 55 个套件（只有需要 `CLUTCH_E2E_*` 的 `remote-bootstrap-e2e.js` 按设计跳过）＋ `tests/*.py` 25 个全绿，`scripts/sync-android-host.sh` 重铺了 `assets/{ui,nodejs-project}`，逐字节副本检查跟着绿。

**待验（真机）**：展开/收起 `process` 块有过渡（约 200–420ms，随内容高度走），中途反点点能从中途接上而不是重放；系统开了"移除动画"时直接落位。点 "load earlier records"：**同一帧**看到环与 `loading N…`；大页时先出现 `rendering earlier records…` 再插进来；一直点不会发出第二个请求；到历史尽头 pill 消失；网络失败时回到 offer 且下面有一行 `Failed to load earlier records: …`（这两种视觉在本机**没法**验：这台机器上 Electron 缺 `libatk-1.0.so.0`、没有 chromium 也没有 xvfb，只能靠上面的顺序测试与代码推理，真机是验收口）。

## M2：pylibs 供给线（代码+CI+测试完成，真远端验收待设备环节）

完整 SSH 路径的最后一块拼图：手机上**没有** pip/bash，pylibs tar 改为 CI 预构建、
Release 索引下载。四处改动：

1. **策略门**：`ui/server-bundle.js` 新增 `hasLocalBundle()`（注册了 artifact
   provider 即 false），`ui/ssh-tunnel.js` 的 `chooseStrategy` 的 bundle 分支加此门。
   原因：nodejs-mobile 的 `process.platform` 是 `linux`、手机是 aarch64——不修的话，
   手机连 linux-aarch64 远端会命中"同平台=bundle"并在 provider 硬拒绝处死掉，永远
   走不到 pylibs。
2. **下载器**：`android/host/artifact-provider-android.js`——索引 URL 解析顺序
   `CLUTCH_PYLIBS_INDEX_URL` env → 同目录盖章文件 `pylibs-index-url.txt`（release CI
   用 APK 自己的 tag 写入）→ releases/latest（dev 兜底）。索引必须与 APK 同 commit：
   tar 内嵌 agent/ 源码，漂移会有协议错配风险。下载后本地复算 sha256，远端 VERSION
   门（=tar 哈希前 16 hex）原样复用。**供给 seam 是两问**：`resolvePyLibsVersion(target)`
   只回答"这一版发的是哪个制品"——读几 KB 索引，零字节下载，VERSION 门问的是它；
   `ensurePyLibsTar(target)` 才给字节，只在真安装时调用（`ui/tunnel-bootstrap.js`
   的 `install:fetch` 阶段）。两者缺一，`setArtifactProvider` 直接拒绝。索引条目还会
   自校验 `version === sha256[0:16]`：条目自相矛盾时在下载任何字节之前就被拒。
   **镜像同样作用于这条供给线**：索引与 tar 的取数 URL 都过一遍与组件来源同一处的接缝
   （`ui/net-fetch.js` 的 `mirrorPrefix()`/`mirrored()`，前缀取 `CLUTCH_SOURCE_MIRROR`
   env 或 `~/.clutch/settings.json` 的 `source_mirror`；手机上的入口是插件页顶端那个
   `Source mirror` 字段，见「源镜像在手机上够不着」一节），于是 `github.com` 不可达时索引
   与 tar 一起改从 `<镜像>/<原始绝对 URL>` 取。**改的只是取数的那一跳**：索引缓存仍以
   原始 indexUrl 为键、缓存里存的 `url` 字段与错误文案也仍是原始 URL——盖章 tag 必须继续
   和磁盘上那份对上，镜像今天有明天没有都不该让缓存失效，也不该让别的 release 的索引被
   认领。手机上的 node 18 没有 Chromium 那层栈，代理仍不通（只有直连或镜像）。
3. **CI**：`.github/workflows/release.yml` 增 `pylibs-matrix`（py3.10–3.13 ×
   x86_64/aarch64 × glibc/musl = 16 格，`pip download --platform` 纯下载，无需
   submodules/QEMU）+ `pylibs-index`（聚合校验：文件名哈希==内容哈希，生成
   `pylibs-index.json` 附到 Release）。
4. **确定性修复**：`scripts/build-pylibs-tar.sh` 原会把本机 venv 编译的 `.pyc`
   （cp310，远端 python3.12 根本不加载）连同仓库 `agent/__pycache__` 一起打进 tar，
   且 pyc 内嵌安装时刻 mtime → **两次构建字节不同**，缓存/VERSION 门全失效。已改
   `--no-compile` + 打包前清 `*.pyc`/`__pycache__`（远端首 import 自行编译）。

**验证**（`node tests/android-pylibs-path-test.js`，全绿）：同一目标两次真实构建
sha256 逐字节相同；CI 命名 tar 过假索引服务器 → 真 provider → 真 `ensurePyLibsTar`
seam，落盘沙箱 `~/.clutch/bundles`，`version === fileHash(tar).slice(0,16)`；二次调用
tar 零下载（索引 JSON 每次重读是设计行为）；缺键干净拒绝；篡改下载过不了 sha256 门。
`tests/android-provider-test.js` 第 3 节钉住门不再搬字节：只有索引、没有 tar 时
VERSION 门照过，`tarFetches` 仍为 0；第 4 节钉住索引撒谎（自洽条目 / 自相矛盾条目）
在下载前被拒。
`tests/remote-strategy-test.js` 补 N4：注册 provider 后同平台远端也走 pylibs、无
python3 仍 null、`setArtifactProvider(null)` 还原桌面行为。

**待验**（需设备/真远端）：手机对全新 x86_64 与 aarch64 远端各一键连接成功，远端
`~/.clutch-server/VERSION` == tar 哈希。

## M1 验收对照

| 验收项 | 状态 |
|---|---|
| Node 启动 + `ssh2` 可用 | **Linux 已验**：staging 出的 `nodejs-project/index.js` 按手机目录布局直接启动，写就绪标记 `bridge.port`，SSE 出帧（真实入口 + 真实依赖树，仅换引擎本体） |
| WebView 加载 ui/ + bridge-shim | 代码交付；真机待验 |
| `clutchApi.baseUrl()` 走通（对手动装好后端的远端） | 全链路 Linux 已验（`tests/bridge-server.test.js`：shim→桥→android-host→host-core→(伪)隧道→会话认领→SSE 回推）；真机 ssh2 握手待验 |
| 引擎 JNI（libnode） | C++ 已对照钉版头文件做语法检查；编译+真机待验 |

## Linux 已验证（`node tests/…`，全绿）

- `tests/bridge-server.test.js` — M1 引擎回路端到端：真 shim + 真桥 + 真
  android-host/host-core/settings-mirror，伪隧道/伪 supervisor。覆盖
  baseUrl 认领、settings 镜像 0600/自愈、tunnel.connect/progress(SSE)、
  心跳死→自愈重认领→base-changed 推送、disconnect 释放会话、错误→reject、
  单一 EventSource、`bridge.port` 就绪标记契约。
- `tests/android-provider-test.js` — N3：下载→自算 sha256→落盘桌面同缓存、
  二次命中不重下、清单篡改→拒收且零残留、索引缺键→拒绝、`ensureBundle`
  恒拒绝、`version` 与桌面 `fileHash().slice(0,16)` 逐字节相等；第 10 节起
  镜像整条作用于索引+tar、**只写在 settings 文件里（env 一概不设）也算数**。
- 其余 16 个既有 JS 套件全绿（含 settings-mirror/bridge-shim/
  server-bootstrap——M1 对 `ui/` 的三处共享层改动不破坏桌面；`tunnel-reconnect`
  的 bind 超时/对端死亡两问、`components-panel` 的镜像字段一节、
  `settings-mirror` 第 6 节见各自报告一节）。

## 真机待验清单（下一台 Android 设备/CI device farm）

1. libnode 引擎启动：`adb logcat -s clutch` 见引擎输出；`filesDir/bridge.port` 生成。
2. WebView 首屏：`appassets.androidplatform.net/ui/` 加载、localStorage 持久、
   `?bridge=` 注入生效（shim 连上 `/events`）。
3. 对一台已手动装好后端的远端完成一次完整对话（SSE 流式、权限弹窗、返回键/外链）。
4. 软键盘 `adjustResize`、Activity 重建（旋转）后桥自动重连（shim `retry: 2000`）。
5. N5（M3）：首启弹通知权限；回桌面/锁屏数分钟后回来隧道仍活（前台服务保活）；
   `adb shell dumpsys activity services io.clutch.mobile` 见 `TunnelService`
   处于 foreground；下拉通知栏有静默常驻通知。
6. N7（M3）：窄屏下顶栏两行不溢出、工作区面板在流区下方可滚动、弹窗不出屏。
7. M4：连上远端后熄屏 5–10 分钟，远端 `kill` 掉 sshd（或断网），**不碰手机**，隧道
   应自己重连（`adb logcat -s clutch | grep ladder`）；首启弹一次电池优化豁免对话框
   （拒绝后不再弹）；`adb shell dumpsys power | grep clutch:tunnel` 只在有隧道意图时
   有这把锁，断开后消失。
8. 启动器图标：抽屉/桌面出现红 ▣（不是系统默认小人）；系统若允许选图标形状，圆形
   与方形两种遮罩下标记本体都不被裁，红块四角与圆角遮罩边之间看得见那圈留白——
   `aapt2 dump badging` 的 `application: … icon='res/mipmap-anydpi-v26/ic_launcher.xml'`
   是后台判据，肉眼这一条才是判据（见「启动器图标」一节）。
9. 源镜像（报告"国内镜像没生效"）：插件页顶端填一个镜像 → Save → 判词行印出当前前缀；
   `adb logcat -s clutch | grep '\[artifact\]'` 见 `source mirror … — fetching …`；
   清空后再保存并连一次，同一行变回 `no source mirror set: … (github.com) directly`。
   在**不能**直连 github.com 的网络里，组件市场与远端 pylibs 安装都应能走通（见
   「源镜像在手机上够不着」一节）。
10. 隧道不落地（报告"0.1.47 卡在 Starting tunnel…"）：连一台**对反向转发请求不回话**的远端
    （中间盒 / 非 OpenSSH sshd / 卡住的 request 通道），进度条必须**照常走到连上**——模型的
    通路不是 connect 的判决条件；`~/.clutch/tunnel.log` 里此时应出现
    `reverse forward unanswered (…did not answer the reverse-forward request within 4000ms…);
    not asking for a port of its own`，随后是 `model path unavailable …; asking again in
    15000ms`，并且 `tunnel:status` 的 `modelPath` 不是 `listening`；起会话时同一份日志里有
    `the far side's model path is unavailable; starting the session anyway`（见上一节报告）。
    对端确实**拒绝**（`Address already in use`）时才是另一条路：阶梯重试 6 次、再请对端自选
    端口。
11. 坏掉的 pylibs 树不再"假装修好了"（报告"移动端连不上，报错 no backend"）：在一台
    `~/.clutch-server/VERSION` 与本次发布**相同**、但树里叠了两代 `pydantic*-dist-info`（或
    `PYTHONPATH=~/.clutch-server/site-packages python3 -c "import pydantic, pydantic_core"`
    直接 SystemError）的远端上点连接，必须**看到一次重装并连上**，而不是停在
    "Not connected — no backend"：`~/.clutch/tunnel.log` 里先有
    `[bootstrap] … the VERSION file matches but its tree does not (DUP:pydantic_core) — installing
    over it`，随后重装完成；连上后远端 `ls ~/.clutch-server/site-packages | grep dist-info` 里
    `pydantic*` 各只剩一代，`~/.clutch-server/{VERSION,STRATEGY}` 已更新。反向的一半同样可验：
    tar 传坏（上传成功、解包失败）时界面报的是 `the remote could not unpack the wheels (exit N…).
    Nothing was replaced …`，且**远端 `VERSION` 没变**（`ssh` 上机复核）——这是"失败不再留下半棵树
    的证据"，也是下一次连接会重试的前提。
12. teardown 归还反向转发：断开后停一两秒，在远端 `ss -ltnp | grep 127.0.0.1` 里，那条会话（以及
    它自己那条 `sshd: ubuntu@notty`）留下的监听不该还在；客户端 `~/.clutch/tunnel.log` 的断开处有
    `[disconnect] releasing the far side's reverse forward on 127.0.0.1:<port>`。手机端走的常是
    "请对端自选端口"那条路（8892 被别人占着），那就该看到 `<port>` 是自选的那个、而不是 8892
    ——**只归还自己被授予的编号**是这条的判据（见上一节）。
13. 系统栏同色（报告"状态栏/导航栏不是 App 的底色"）：状态栏、导航栏、App 底色三处同色，
    栏上图标识是浅色；旋转屏幕与弹出软键盘时系统栏区域不闪白（见「系统栏不是 App 的底色」一节）。
14. 缩放锁（报告"两指误触就放大"）：聊天区、顶栏两指蹭与双击都不放大，界面不会停在"糊住且
    不回弹"的状态；图表查看器里捏合、双击 1:1、拖动**照旧**（同一节）。
15. 折叠有过渡（报告"process 在手机上是瞬间展开"）：展开/收起 `process · N steps` 是滑开而不是
    "蹦"出来，时长随内容高度在 200–420ms 之间；移开手指后立刻反点，能从当前高度接上、不重放整段；
    系统"移除动画"打开时直接落位（即**不再**是瞬间，而是"无动画但有终态"）。见「process 块在手机上
    是"蹦"出来的」一节。
16. 翻页有反馈（报告"load earlier records 点下去像没反应"）：点下**同一帧**看到环与 `loading N…`；
    一页较大时先出现 `rendering earlier records…` 再插入；中途再点不产生第二个请求；到历史尽头
    pill 消失；失败时回到 `load earlier records (…)` 并在下面有一行 `Failed to load earlier
    records: …`（同一节）。
17. 设置页的版本号（报告"设置里看不到软件版本"）：设置弹窗第三个标签 **About** 里的号码是人眼
    能读的一行等宽大字，且**等于这个包自己的** `versionName`——
    `adb shell dumpsys package io.clutch.mobile | grep versionName` 与屏上那一行逐字相同（不是
    `dev build`，也不是源码树里可能更新的号）；下面两行分别是 `Android <N> · Android WebView ·
    Chromium <M>` 与后端地址（未连接时是 `not connected`，连上后是那条会话的地址）。切换标签时
    弹窗高度随之变化但仍是滑过去、不是跳过去；About 页可以反复进出，号码不会变成空行。

## 与初版方案的偏差（均已定案）

- `app/libs/nodejs-mobile.aar` → 改为按 ABI 的 `libnode.so` + 自有 JNI 壳
  （`cpp/native-lib.cpp`）。少一层 aar 打包，钉版与升级走同一个校验脚本；
  兜底不变（桥以 loopback HTTP 为界，最坏换 sshj 只动一个模块）。
- 前台服务 `TunnelService`（N5 完整形态）原计划归 M3，已随 M3 落地（见上）。
- npm 的 allowScripts 策略会跳过 `ssh2` 的 `install.js`（可选原生
  cpu-features）——Android 上本就要纯 JS 路径，这是期望行为，不是缺陷。

## 从本机到真机：验证与安装手册

### 第 0 步 · 本机验证（无需设备/SDK，全部可复跑）

```bash
uv pip install pip                        # 一次性：uv venv 默认无 pip，构建 tar 需要
for f in tests/*.test.js tests/*-test.js; do
  case "$f" in *e2e*) continue;; esac
  node "$f" || echo "FAILED: $f"          # 56 个套件应全绿（*e2e* 需 CLUTCH_E2E_*，跳过）
done
uv run python -m tests.selfcheck          # python 侧

node tests/android-pylibs-path-test.js    # M2 供给线专项：两次真构建 sha256 相同、
                                          # 假索引→真 provider→缓存命中/篡改拒绝（联网，约 1 分钟）
node tests/remote-strategy-test.js        # N4：provider 注册后同平台远端也走 pylibs
```

更强的本机验证（可选）：`node tests/remote-bootstrap-e2e.js` 用 PC 对一台真远端
走完整 probe→安装→健康门。手机跑的是**同一批宿主 JS**（sync 脚本原样复制），
这条绿了，手机端剩余风险就只剩 nodejs-mobile 引擎与 ssh2 握手本身。

### 第 1 步 · 出一个 APK

**首选——CI 代劳（本机无需任何 SDK）**：

- **正式路线**：推 `v*` tag → `release.yml` 的 `pylibs-matrix`/`pylibs-index`/
  `android-apk` 三个 job 串行 → Release 页直接下载 `clutch-android-<tag>.apk`
  （索引已自动盖章，就是本 tag 的 pylibs-index.json）。
- **快迭代路线**：Actions 页手动跑 **android-debug**（可选 `pylibs_index_url`
  输入，比如第 2 步 B 路线的局域网索引；留空 = 最新 Release 的索引）→ 下载
  artifact `clutch-android-debug-apk`。

**本机路线**（需 JDK 17 + Android SDK）：

```bash
scripts/build-android-apk.sh "<pylibs-index-url>" dev clutch-android.apk
```

三种路线产物一致（debug 签名，覆盖安装需先卸载——签名互不相同）。

### 第 2 步 · 给手机一个 pylibs 索引（仅本机/局域网构建需要；CI 路线已自动盖章）

手机装后端时要从索引下载 CI 预构建 tar。两条路二选一：

**A. GitHub Release 路线（最接近最终形态）**：仓库推到 GitHub → 打 `v*` tag →
release workflow 的 `pylibs-matrix` + `pylibs-index` 两个 job 产出 16 格 tar +
`pylibs-index.json` → 把
`https://<owner>/<repo>/releases/download/<tag>/pylibs-index.json`
写进 `android/host/pylibs-index-url.txt` → 重跑 sync 或 `build-android-apk.sh`
（该文件在 sync 时被打进包，provider 启动时读它）。**Release 的 android-apk
job 已把这条路线整个自动化**——此处仅供本机自建 APK 时手工对齐。

**B. 局域网快路（迭代最快，不依赖 CI）**——在 PC 上现构建、现供出，命名逐字对齐 CI：

```bash
.venv/bin/python -m pip --version || uv pip install pip   # 前置
ssh <远端> python3 --version                               # 先确认远端 pyver，例如 3.12
mkdir -p /tmp/pylibs-srv && cd /tmp/pylibs-srv
bash <仓库>/scripts/build-pylibs-tar.sh k t.tar.gz Linux x86_64 glibc 3.12
H=$(sha256sum t.tar.gz | cut -d' ' -f1)
mv t.tar.gz "agent-pylibs-linux-x86_64-glibc-py3.12-${H:0:16}.tar.gz"
printf '{"linux-x86_64-glibc-py3.12":{"file":"agent-pylibs-linux-x86_64-glibc-py3.12-%s.tar.gz","sha256":"%s","version":"%s"}}\n' \
  "${H:0:16}" "$H" "${H:0:16}" > pylibs-index.json
python3 -m http.server 8000        # 供出；aarch64 远端同法换 arch 再建一条
```

然后 `echo "http://<PC局域网IP>:8000/pylibs-index.json" > android/host/pylibs-index-url.txt`
→ sync → 重新出 APK。手机与 PC 同一 Wi-Fi 即可。构建脚本用 `pip download
--platform` 纯下载，x86 的 PC 也能直接构建 aarch64 的 tar，无需 QEMU。

### 第 3 步 · 真机验收（M1+M2 判据）

1. **冷启动**：App 打开出现 Clutch 界面 = node 引擎起来了、桥握手成功
   （`adb logcat` 可看 NodeEngine/node 日志；界面前端走 `bridge.port` 就绪标记）。
2. **准备远端**：全新 Linux——x86_64 用任意云主机/局域网机器/sshd 容器；
   aarch64 用树莓派、ARM 盒子或 ARM 云实例。要求：sshd 能被手机访问、有 python3。
3. **连接**：App 里填 SSH 主机/用户/密钥 → 一键连接。观察进度：
   probe → 下载 tar（第 2 步的索引）→ SFTP 上传 → 远端解压 → 前向/反向转发 → 健康门。
4. **远端核对（M2 的硬判据）**：
   ```bash
   ssh <远端> cat ~/.clutch-server/VERSION        # 16 hex
   ssh <远端> ls ~/.clutch-server                 # agent/ site-packages/ STRATEGY=pylibs
   ```
   VERSION 应 == 所装 tar 的 sha256 前 16 位（索引里 `version` 字段的值）。
5. **完整对话**：设置里配 LLM key（请求走远端 `127.0.0.1:8892` 反向转发回手机上的
   llm-proxy；该端口被占用时由远端自选一个端口，见 `ui/tunnel-connect.js`），
   发一轮消息确认 SSE 流式与权限确认弹窗正常。
6. **M2 达标线**：x86_64 与 aarch64 各一台全新远端一键连接成功，且 VERSION==tar 哈希。
