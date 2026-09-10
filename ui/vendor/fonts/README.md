# ui/vendor/fonts — UI 的跨平台字体与图标资源

Electron 渲染层用 `file://` 装载（`ui/main.js` 的 `win.loadFile`），所以这里的每个
`@font-face` 都必须用相对 URL（写成 `/vendor/fonts/x.woff2` 会解析成
`file:///vendor/...`，字体静默变成 `error` 状态，整个 UI 退回系统字体 —— 每个平台
一套，就是"同一份 UI 三平台三种长相"的根因）。本目录的三套字体是 UI 唯一的字形
来源；`tests/ui_fonts_check.py` 把这些约定全部钉死。

| 文件 | 家族 | 作用 | 许可 |
| --- | --- | --- | --- |
| `archivo-var.woff2` | Archivo (variable) | 正文/标题（`--font-display`） | SIL OFL 1.1 |
| `jetbrains-mono-400.woff2` | JetBrains Mono | 代码/等宽（`--font-mono`） | SIL OFL 1.1 |
| `clutch-icons.woff2` | Clutch Icons | 16 个界面图标的 Symbola 子集 | 见 `clutch-icons.LICENSE.txt` |
| `clutch-icons.LICENSE.txt` | — | Symbola 归属与"任意用途免费"条款 | — |
| `clutch-icons.manifest.txt` | — | 字体 sha256 + 内置码位，供测试比对 | — |

## 为什么图标要自带字体

界面图标是**文本节点里的字符**（▣ ▦ ＋ ⚙ ▶ ▸ ▾ ↓ → ✓ ↶ ✎ ⚠ ⟦ ⟧ ■），不是
SVG：它们在按钮标签、diff 行、流式输出和 mermaid 图表标签里。Archivo /
JetBrains Mono 都是约 230 字形的拉丁子集，这些符号一个都没有 → 过去由各平台
自己的符号字体绘制：Windows 是 Segoe UI Symbol、macOS 是 Apple Symbols、
Linux 是 fontconfig 挑的某个字体，于是同一个按钮三平台三种大小和形状。

`clutch-icons.woff2` 把这些码位烤进一个 2.9 KB 的字体并让应用自带。
它排在 `--font-display` / `--font-mono` **最前面**，但只会影响这 16 个码位：
字体 cmap 里只有这 16 个（连 ASCII `+` / 标点 / 字母都没有），CSS 里还用
`unicode-range` 把范围再写一遍（浏览器对范围外的字符根本不会考虑这个 face）。
所以它不可能顶掉任何正文字符，也让 mermaid 标签里的图标和其他文字一样一致。

## 网上现成资源的调研

### 1. 符号字体（最终采用）

用 fontTools 逐个读 cmap（`getBestCmap()`），统计对上述 16 个码位的原生覆盖：

| 现成字体 | 原生覆盖 | 许可 | 结论 |
| --- | --- | --- | --- |
| **Symbola 2.60**（George Douros，Debian `fonts-symbola`） | 15/16（缺 `U+FF0B`）+ ASCII `+` 重映射补上 | "free for any use; may be opened, edited, modified, regenerated, packaged and redistributed" | **采用** |
| DejaVu Sans | 15/16（缺的是**同一个** `U+FF0B`，同样要靠重映射） | Bitstream Vera（自由，但有改名/再分发条款） | 并列第二，落选理由见下 |
| Noto Sans Symbols 2 | 9/16 | SIL OFL 1.1 | 落选：缺 7 个图标 |
| Noto Sans Symbols | 3/16 | SIL OFL 1.1 | 落选：缺 13 个图标 |
| Archivo / JetBrains Mono | 1/16 | SIL OFL 1.1 | 落选（正文本体，本来就不含符号） |

Symbola 与 DejaVu Sans 的覆盖是并列的（差的都是 `U+FF0B` 全角加号，两者的 ASCII
`+` 都在），选 Symbola 是两点权衡：许可为零附加条件（DejaVu 的 Bitstream Vera
许可虽然自由，但带改名与"不得单独出售"条款，闭源商业打包的合规成本更高）；且
Symbola 是**只做符号**的字体，这 16 个轮廓就是它的主业，而 DejaVu Sans 本身就是
三大平台系统里常见的正文族（Linux 上常常就是 fontconfig 的默认 sans）——用系统
自带的正文族当内置图标字体，"图标终于来自内置字体"这件事在观感上无法自证。

Symbola 没有 `U+FF0B`（全角加号），构建脚本把它的 ASCII `+` 轮廓重映射到
`U+FF0B`；标记里继续写 `＋`，而 ASCII `+` 仍然由 Archivo / JetBrains Mono 绘制
（它们确实有这个字形）。源包固定版本 + sha256（见 `scripts/build-icon-font.py`，
Debian 包 `fonts-symbola 2.60-1.1`，同一版本任意镜像均可），下载后校验不通过就
直接报错，不会悄悄烤进别的字体。

### 2. SVG 图标集（有现成资源，但没有采用）

调研过的现成图标集与许可（逐一核对仓库 LICENSE / GitHub license API）：Lucide
（ISC，LICENSE 文件明写 ISC，API 归类为 "Other"）、Tabler Icons（MIT）、
Phosphor（MIT）、Bootstrap Icons（MIT）、Material Symbols（Apache-2.0）。它们
都是成熟可商用的资源，但没有采用：

- UI 的图标出现在**文本流里**（mermaid 标签文本、diff 的 `✓`、按钮 `▶`）。
  SVG 组件或图标字体组件都没法塞进 mermaid 生成的 `<text>` 标签；只有"字体"
  这一种形式能让图标和图内文字共用一套字形。
- 把 SVG 转成字体需要额外的构建链（fantasticon / svgicons2svgfont / fontforge）
  和一套新的码位约定，换来的 16 个图标形状并不比 Symbola 更贴这个 UI。
- Font Awesome 的许可是自定义的 "Font Awesome Free License"（图标 CC BY 4.0、
  字体 SIL OFL 1.1、代码 MIT 三套条款叠加，GitHub API 也归为 "Other"），比
  MIT/ISC 复杂得多，不做这种未经确认的 vendoring。

### 3. 专用"图表字体"

没有这种东西：mermaid 不分发字体，只在主题里给一个 `fontFamily` 默认值 ——
本仓库 vendor 的 `ui/vendor/mermaid.min.js` 里硬编码的是裸 `"Arial"`
（在 bundle 里出现 2 次）。裸 `Arial` 在每个平台由不同 face 解析（Linux 是
Liberation Sans、Windows 才是真 Arial），图表标题因此和界面其余部分一样漂移。

修法是不复制字体栈，而是把 UI 的栈交给 mermaid：`ui/app.js` 的 `renderMermaid`
读取 `--font-display`（`cssValue()` 先剥掉 CSS 里的 `/* 注释 */` 并压平空白 ——
mermaid 会把拿到的字符串原样写进 `<style>` 和内联样式），作为
`themeVariables.fontFamily` 传入；取不到时退回 `sans-serif` 而不是空串。
实测渲染出的 SVG 里第一个标签的 `font-family` 就是
`"Clutch Icons", Archivo, "PingFang SC", …`。SVG 自带的
`--mermaid-font-family:"trebuchet ms",verdana,arial,sans-serif` 只是上游
样式表的残留，已被 themeVariables 覆盖。

## 16 个内置码位

| 码位 | 字符 | 用途 |
| --- | --- | --- |
| `U+25B8` | ▸ | 流式/树形折叠箭头右 |
| `U+2193` | ↓ | 滚动到底 / older 胶囊箭头 |
| `U+2713` | ✓ | 勾选（diff / 选中） |
| `U+FF0B` | ＋ | 新建（重映射自 ASCII `+` 轮廓） |
| `U+2192` | → | 行内箭头 |
| `U+25BE` | ▾ | 树形折叠箭头下 |
| `U+25B6` | ▶ | 运行按钮 |
| `U+21B6` | ↶ | 回退 / 撤销 |
| `U+25A0` | ■ | 停止按钮 |
| `U+26A0` | ⚠ | 警告 |
| `U+27E6` | ⟦ | 工具参数括号开 |
| `U+27E7` | ⟧ | 工具参数括号闭 |
| `U+25A3` | ▣ | Clutch logo |
| `U+270E` | ✎ | 编辑标记 |
| `U+25A6` | ▦ | 打开按钮 |
| `U+2699` | ⚙ | 设置按钮 |

代码里新增一个符号字符时：把它加进 `scripts/build-icon-font.py` 的 `ICONS`，
重新构建，否则该字符会被 OS 的符号字体绘制（也就是又漂移了）。测试会直接点名
"哪个字符、U+ 多少、被哪些文件用到"。

## 重建与校验

```bash
# 重新生成子集（依赖临时注入，不污染 venv）：字体 + LICENSE + manifest 一起更新
uv run --with fonttools --with brotli python3 scripts/build-icon-font.py

# 字体接线：相对 URL、preload、var(--font-*) 定义、16 个字符全部被内置 face 覆盖、
# manifest sha256、unicode-range == 字体码位、mermaid 标签字体
uv run python -m tests.ui_fonts_check

# mermaid 主题逻辑镜像（含图表字体为 UI 栈、注释已压平、缺失时退回 sans-serif）
node tests/mermaid-logic-test.js

# 打包核对：3 个 woff2 + license + manifest 必须在 App 资源集里；本 README 和
# dev.sh / package-lock.json 必须不在（ui/electron-builder.yml 的 files 取反）
node ui/verify-build-config.js
```

重建是确定性的（`head.modified` 被钉在 `SOURCE_DATE_EPOCH`）：同一份源字体重复
构建得到同样的字节，manifest 里的 sha256 才不会每次变。改了字体但没改
manifest / `unicode-range` / builder 里的 `ICONS`，上面第一条测试会失败。

CI 上：`.github/workflows/release.yml` 的 deb 作业在打包之前跑
`tests.ui_fonts_check`（`node ui/verify-build-config.js` 本来就在跑），dmg 作业
`needs: deb`，所以字体接线或打包资源集一旦回归，tag 推送就直接失败而不是又发一个
"三平台三套字体"的版本出去。
