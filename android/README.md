# Clutch Android（M1–M3：引擎打通 + SSH 供给线 + CI 打包/前台服务/窄屏）

WebView 渲染层（`ui/` 原样）+ nodejs-mobile 宿主（`ui/` 纯 Node 子集原样）+
一个最小 Kotlin 壳。方案与特化点清单见 `docs/android/02-移植方案.md`
（§3 架构、§6 N1–N7、§7 工程结构、§8 里程碑）。

```
android/host/                  宿主 JS（仓库源码，随包分发）
  index.js                     nodejs-mobile 入口：main() → 装配 + 桥
  android-host.js              装配：provider 注册 + host-core + 桥 handlers
  bridge-server.js             loopback HTTP 桥：POST /api/<ns>/<m> + GET /events (SSE)
  artifact-provider-android.js N3：CI 预构建 pylibs tar 下载器（M2 已接线，经 server-bundle 的 artifact provider seam 注册）
app/src/main/
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

## M1 验收对照（方案 §8）

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

## 与方案 §7 的偏差（均已定案）

- `app/libs/nodejs-mobile.aar` → 改为按 ABI 的 `libnode.so` + 自有 JNI 壳
  （`cpp/native-lib.cpp`）。少一层 aar 打包，钉版与升级走同一个校验脚本；
  风险表 §9 的兜底不变（桥以 loopback HTTP 为界，最坏换 sshj 只动一个模块）。
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
5. **完整对话**：设置里配 LLM key（请求走 remote:8892 反向转发回手机上的
   llm-proxy），发一轮消息确认 SSE 流式与权限确认弹窗正常。
6. **M2 达标线**：x86_64 与 aarch64 各一台全新远端一键连接成功，且 VERSION==tar 哈希。
