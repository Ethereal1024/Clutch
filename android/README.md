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
# ./gradlew --no-daemon :app:assembleDebug -PAPP_VERSION=<版本> → 拷出 APK
```

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

## 隧道连上后卡在 "Starting tunnel…"（报告：0.1.46 连远端永远转，不落地也不报错）

**报告**：连远端时进度停在 "Starting tunnel…"，界面不报错也不超时——既没有失败提示，
也永远等不到连上那一刻。

**根因**：不是 0.1.46 引入的（`git log v0.1.45..v0.1.46 -- ui/tunnel-connect.js` 为空），
是这个阶段里**唯一一处没有时钟的等待**。反向端口转发走 `ssh2` 的
`client.forwardIn(bindAddr, bindPort, cb)`（`ui/node_modules/ssh2/lib/client.js:1333`）：
它的回调只在**对端的 global request 答复**到达时才被调用——ssh2 自己不设超时，而断线时
的清理（keepalive 大约 45s）会把 `state` 清掉，却**不会 reject 那个还在飞的 promise**。
"对端不回话"于是既没有回调也没有拒绝：`forward` 阶段（`ui/tunnel-connect.js:231` 的
`progress("forward")`，标签就是 UI 上那句 "Starting tunnel…"）永远停在那儿。这一阶段里
其它每个 await 都是有界的（健康探测 `CONNECT_TIMEOUT_MS = 15000`、supervisor 探测 3s、
 exec 预算 60s），所以一个没有边界的等待足以让整条连接死在那里。

**修法**：`bindReverseForward(client, port, timeoutMs)` 把一次 bind 变成"两个 ssh2 不给
的出口，先到者胜"——`REVERSE_FORWARD_BIND_TIMEOUT_MS = 4000` 的钟，以及 client 自己的
讣告（`once("close"|"error")`）。两者都只活到 settle 那一刻（`settled` 闸 + 移除监听器），
所以 6 次阶梯重试不漏监听器、迟到的回调只是个 no-op；`forwardIn` 在已经死掉的 socket 上
会**抛**而不是回调，这一抛也收进同一个 settle 里。文案分两句，"对端说不"与"没人会说话"
不是一件事：`the connection closed before the far side answered the reverse-forward
request` / `the far side did not answer the reverse-forward request within 4000ms`。4s 不是
慢链路的限速——sshd 一旦试过 bind 就会回话，所以这个钟量的正是"答复本来就不会来了"。

**验证**：`tests/tunnel-reconnect.test.js` 在既有的"没落地的 bind 什么都不留"之后加了两问：
一个**永远不回答**的假 client（`bindTimeoutMs: 40`）必须在有界时间内放弃（实测 81ms；日志
里出现 `did not answer the reverse-forward request within 40ms`；零残留监听器）；一个
**已经 close** 的 client 必须立刻 settle（实测 61ms，而钟是 5000ms）。

**回归证明**：把这两个出口临时删掉，`timeout 25 node tests/tunnel-reconnect.test.js` 正好
停在 `and nothing is remembered from a bind that never landed` 之后再也不动——就是把报告里
那个"一直转"复现了一遍。

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
`android:roundIcon`。

**待验（真机）**：装到手机上，抽屉里出现红方图标；圆形与方形两种遮罩下标记本体都不被裁
（65.6% 这条留白就是为它准备的）。

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
   env 或 `~/.clutch/settings.json` 的 `source_mirror`），于是 `github.com` 不可达时索引
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
  恒拒绝、`version` 与桌面 `fileHash().slice(0,16)` 逐字节相等。
- 其余 16 个既有 JS 套件全绿（含 settings-mirror/bridge-shim/
  server-bootstrap——M1 对 `ui/` 的三处共享层改动不破坏桌面）。

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
   与方形两种遮罩下标记本体都不被裁——`aapt2 dump badging` 的
   `application: … icon='res/mipmap-anydpi-v26/ic_launcher.xml'` 是后台判据，肉眼
   这一条才是判据（见「启动器图标」一节）。

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
  node "$f" || echo "FAILED: $f"          # 20 个套件应全绿
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
