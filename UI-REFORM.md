# Clutch UI 专业化改造计划

> 目标：让 Clutch 的操作逻辑向专业工具（Photoshop / VS Code）靠拢。
> 参考来源：PhotoCraft（storytold/photocraft）前端架构。
> 基线：当前 HEAD，`ui/` 目录结构稳定。

---

## 0. 不变量

| # | 规则 |
|---|---|
| U1 | 所有改动只改 `ui/` 目录，不碰 `agent/`、`tests/`、Android、SSH 层 |
| U2 | 现有 element ID 和 CSS class 不改名（除非某条改动明确迁移它） |
| U3 | mobile.css 覆盖规则必须同步更新，桌面和手机保持各自可用 |
| U4 | 每步可独立 revert，前后步互不依赖（步骤是串行的，但不捆绑） |
| U5 | 不新增 npm 依赖，不新增构建步骤 |

---

## 1. 现状结构（改造基线）

```
header#topbar
  brand | project-label | readonly-badge | status | spacer | open-btn | new-btn | settings-btn

main
  section#left
    div#taskbar
      textarea#task-input
      div.actions
        div.run-actions
          button#run-btn | button#mode-btn | button#trust-btn
        span#workspace-path
    div.stream-wrap
      div#stream  ← 对话/输出流
      button#jump-bottom

  aside#right
    section#shell-project  ← 手机用，桌面 display:none
    div.panel-head "workspace"
    div#tree  ← 文件树
```

---

## 2. 改造清单（五条，优先级排序）

### R1 · Options Bar（工具选项栏）

**目标**：把 Run / mode / trust 控件从 `#taskbar` 里抽出来，放进一条横贯全宽的选项栏，放在 `</header>` 和 `<main>` 之间。任务输入框因此变干净，控件有了固定的"命令区"位置。

**改动文件：**

#### `ui/index.html`
- 在 `</header>` 之后、`<main>` 之前插入：
  ```html
  <div id="options-bar">
    <div class="opt-run">
      <!-- 以下节点从 #taskbar 的 div.actions 整体移过来 -->
      <button id="run-btn" …>▶ Run</button>
      <button id="mode-btn" …>work</button>
      <button id="trust-btn" …>🛡 Trust</button>
    </div>
    <span id="workspace-path" class="muted opt-path" …></span>
  </div>
  ```
- 删除 `#taskbar` 内的 `<div class="actions">…</div>`（整块）。
- `#taskbar` 只保留 `<textarea id="task-input">`，外层 `padding` 不变。

#### `ui/style.css`
- 新增 `#options-bar` 规则，紧接在 `#topbar` 块之后（约 line 237）：
  ```css
  #options-bar {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: 0 var(--s4);
    height: var(--ctl-h);           /* 32px，与 topbar 控件同高 */
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
  }
  .opt-run { display: flex; align-items: center; gap: var(--s2); }
  .opt-path {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-align: right; font-size: var(--fs-sm);
  }
  ```
- 删除旧的 `.actions`、`.run-actions` 规则（约 line 570–581）。
- 把 `#taskbar` 的 `padding` 改成 `var(--s4) var(--s4) var(--s3)` （底部稍微收一点，原来底部有 `.actions` 的上边距）。

#### `ui/src/renderer/els.ts`
- 无需改动。`run`、`mode`、`trust`、`workspace` 都是按 ID 查找的，ID 不变。

#### `ui/mobile.css`
- 检查 `.actions`、`.run-actions` 是否有手机专用覆盖规则，若有则迁移到 `#options-bar`、`.opt-run`。

---

### R2 · Status Bar（底部状态栏）

**目标**：在窗口底部放一条永驻状态条，显示：后端连接地址、当前模型名、活跃项目路径。把现在散落在 `#topbar` 里的 `#status` badge 和 `#workspace-path` 信息补全。

**改动文件：**

#### `ui/index.html`
- 在 `</main>` 之后、`<script>` 之前插入：
  ```html
  <footer id="statusbar" class="statusbar">
    <span id="sb-status" class="sb-item sb-status idle">idle</span>
    <span class="sb-sep">|</span>
    <span id="sb-backend" class="sb-item muted" title="backend session URL">—</span>
    <span class="sb-sep">|</span>
    <span id="sb-model" class="sb-item muted" title="active LLM model">—</span>
    <span class="spacer"></span>
    <span id="sb-project" class="sb-item muted sb-project" title="active project file">—</span>
  </footer>
  ```
- 注：`#status` badge 留在 `#topbar` 不动（移除它是独立决定，本步只新增 footer）。

#### `ui/style.css`
- 在文件末尾（`/* touch */` 块之前）新增：
  ```css
  /* ---- status bar ---- */
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0;
    height: 22px;
    padding: 0 var(--s3);
    border-top: 1px solid var(--border);
    background: var(--bg);
    font-size: var(--fs-xs);     /* 11px */
    color: var(--muted);
    flex-shrink: 0;
    user-select: none;
  }
  .sb-item { padding: 0 var(--s2); line-height: 1; }
  .sb-sep  { color: var(--border); }
  .sb-status { font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .sb-status.running { color: var(--accent); }
  .sb-status.idle    { color: var(--muted); }
  .sb-project { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ```
- `body` 的 `flex-direction` 须为 `column`（已是）；`<main>` 的 `flex: 1` 保持不变。

#### `ui/src/renderer/boot.ts` 顶部
- 新增 `import "./status-bar";`（放在最后一批 import 之前）。

#### 新文件 `ui/src/renderer/status-bar.ts`
- 职责：监听三个信号并更新 footer：
  1. `state.apiBase` 变化 → 更新 `#sb-backend`（读 `DEFAULT_BASE`，只显示 host:port）。
  2. `setStatus()` 调用 → 同步 `#sb-status` 的文本和 class（`idle`/`running`/`error`）。
  3. `setProjectInfo()` 调用 → 更新 `#sb-project`。
  4. localStorage `clutch_llm_active` 变化 → 更新 `#sb-model`（读活跃 profile 的 `model` 字段）。
- 实现方式：`document.addEventListener("clutch:status", …)` + 在 `setStatus()` 里 dispatchEvent（或直接改 `stream-view.ts`），或在 boot 末尾 poll 一次再挂 observer。
- 推荐：在 `stream-view.ts` 的 `setStatus(s)` 里补一行 `document.dispatchEvent(new CustomEvent("clutch:status", {detail: s}));`；在 `project.ts` 的 `setProjectInfo()` 里补 `document.dispatchEvent(new CustomEvent("clutch:project-changed", {detail: info}));`。

#### `ui/mobile.css`
- 窄屏下隐藏 statusbar：
  ```css
  .statusbar { display: none; }
  ```

---

### R3 · Project Tab System（项目标签页）

**目标**：同时打开多个 `.clc` 项目，以标签页形式并排，标签可关闭、可 Ctrl+Tab 切换，右键菜单（关闭、关闭其他）。每个标签是独立的 session（独立 `apiBase`、stream、workspace tree）。

这是改动最大的一步，分三个小步落地：

#### R3-a：HTML + CSS（纯视觉，无逻辑）

**`ui/index.html`**
- 在 `#options-bar` 和 `<main>` 之间插入：
  ```html
  <div id="tab-bar" class="tab-bar hidden" role="tablist" aria-label="open projects">
    <!-- tabs injected by tab-bar.ts -->
    <button id="tab-new-btn" class="tab-new" title="open another project" aria-label="open another project">＋</button>
  </div>
  ```
- `hidden` 类：标签数为 0 时不占空间（即 welcome 界面时不显示）。

**`ui/style.css`**（在 `#options-bar` 块之后）
```css
/* ---- project tab bar ---- */
.tab-bar {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: 32px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  flex-shrink: 0;
}
.tab-bar::-webkit-scrollbar { display: none; }
.tab-bar.hidden { display: none; }

.doc-tab {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: 0 var(--row-gutter);
  min-width: 80px;
  max-width: 200px;
  height: 100%;
  border: none;
  border-right: 1px solid var(--border);
  border-bottom: 2px solid transparent;
  background: var(--bg);
  color: var(--muted);
  font-size: var(--fs-sm);
  font-family: var(--font-display);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  user-select: none;
}
.doc-tab:hover { background: var(--bg2); color: var(--text); }
.doc-tab.active {
  background: var(--bg2);
  color: var(--text);
  border-bottom-color: var(--accent);
}
.doc-tab-label { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.doc-tab-dirty { color: var(--accent); font-size: 10px; flex-shrink: 0; }  /* • */
.doc-tab-close {
  flex-shrink: 0;
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 2px;
  font-size: 11px;
  color: var(--muted);
  opacity: 0;
  transition: opacity 0.1s;
}
.doc-tab:hover .doc-tab-close,
.doc-tab.active .doc-tab-close { opacity: 1; }
.doc-tab-close:hover { background: rgba(255,255,255,0.1); color: var(--text); }

.tab-new {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 100%;
  border: none; border-right: 1px solid var(--border);
  background: none; color: var(--muted);
  font-size: 16px; cursor: pointer; flex-shrink: 0;
}
.tab-new:hover { color: var(--text); background: var(--bg2); }
```

#### R3-b：状态模型

**`ui/src/renderer/state.ts`**
- 在 `state` 对象中追加：
  ```ts
  // ---- tab-bar.ts ----
  tabs: [] as Array<{ id: string; path: string; name: string; apiBase: string | null; dirty: boolean }>,
  activeTabId: null as string | null,
  ```

#### R3-c：逻辑模块

**新文件 `ui/src/renderer/tab-bar.ts`**

职责与接口：
```ts
// 创建或激活一个 tab（openProject 末尾调用）
export function tabOpen(path: string, name: string, apiBase: string | null): string
// 把 apiBase 写进 tab（session 解析完成后调用）
export function tabSetBase(id: string, apiBase: string): void
// 关闭 tab（触发确认 → clearStream → 切回上一个 tab）
export function tabClose(id: string): void
// 切换到 tab（更新 state.activeTabId → 重播 stream）
export function tabActivate(id: string): void
// 重绘 DOM（state.tabs 变化后调用）
export function renderTabBar(): void
```

关键规则：
- 每个 `.clc` 路径唯一对应一个 tab ID（用路径 hash 或递增数字）。
- 同一路径再次 `openProject` → `tabActivate(existing)` 而非新建。
- 关闭最后一个 tab → 显示 welcome，`currentProject = ""`。
- Ctrl+Tab / Ctrl+Shift+Tab 循环切换（在 `task-input.ts` 或 `boot.ts` 里加 keydown 监听）。

**`ui/src/renderer/project.ts`** 修改点（2处）：
1. `setProjectInfo()` 末尾：`tabOpen(info.project, info.name, state.apiBase);`
2. `openProject()` 开头：判断 `state.tabs.find(t => t.path === path)` 若存在则 `tabActivate` + `return`，不重复打开。

**`ui/src/renderer/boot.ts`**：
- 追加 `import "./tab-bar";`。

---

### R4 · Right Dock Panel Groups（右侧面板组）

**目标**：把 `#right` 从单一文件树升级为可折叠的面板组系统。初始两组：「Files」（工作区文件树）和「Tools」（插件/组件管理）。每组有独立标签条，可折叠成纯标签条，高度可拖动调整，状态持久化。

#### R4-a：HTML 结构

**`ui/index.html`**，将 `<aside id="right">` 整块替换为：
```html
<aside id="right">
  <!-- phone shell section: unchanged -->
  <section id="shell-project" class="shell-project" aria-label="project">…</section>

  <!-- dock group: Files -->
  <div class="dock-group" data-group="files">
    <div class="dock-group-tabs" role="tablist">
      <button class="dock-tab active" data-tab="workspace" role="tab"
        aria-selected="true" aria-controls="dock-pane-workspace">Files</button>
      <!-- future: <button class="dock-tab" data-tab="search">Search</button> -->
      <div class="dock-group-actions">
        <label class="hidden-toggle" title="show hidden files">
          <input type="checkbox" id="tree-hidden-toggle" /> ·
        </label>
        <button class="dock-group-collapse" title="collapse panel" aria-label="collapse">▾</button>
      </div>
    </div>
    <div id="dock-pane-workspace" class="dock-pane" role="tabpanel">
      <div id="tree" class="scroll"></div>
    </div>
  </div>

  <!-- dock group: Tools -->
  <div class="dock-group dock-group-collapsed" data-group="tools">
    <div class="dock-group-tabs" role="tablist">
      <button class="dock-tab active" data-tab="plugins" role="tab"
        aria-selected="true" aria-controls="dock-pane-plugins">Tools</button>
      <div class="dock-group-actions">
        <button class="dock-group-collapse" title="expand panel" aria-label="expand">▸</button>
      </div>
    </div>
    <div id="dock-pane-plugins" class="dock-pane hidden" role="tabpanel">
      <!-- future: plugins/components panel content migrated here -->
      <p class="muted" style="padding:12px;font-size:12px;">Plugins panel (coming soon)</p>
    </div>
  </div>
</aside>
```

注意：`#tree` ID 保持不变（`workspace-panel.ts` 读它），`#tree-hidden-toggle` ID 保持不变。

#### R4-b：CSS

**`ui/style.css`** 中替换原 `#right` 块（约 line 1268–1299）：

```css
#right {
  width: 300px;
  min-width: 200px;
  max-width: 480px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  overflow: hidden;
}

/* dock group: collapsible unit */
.dock-group {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
  min-height: 0;
  flex: 1;               /* last expanded group fills remaining space */
}
.dock-group + .dock-group { flex: 0 0 auto; }  /* non-filler groups take their default */
.dock-group-collapsed { flex: 0 0 auto; }

/* tab strip */
.dock-group-tabs {
  display: flex;
  align-items: stretch;
  height: 28px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.dock-tab {
  padding: 0 var(--row-gutter);
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font-size: var(--fs-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  flex-shrink: 0;
}
.dock-tab:hover { color: var(--text); }
.dock-tab.active { color: var(--text); border-bottom-color: var(--accent); }

.dock-group-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--s1);
  padding: 0 var(--s2);
}
.dock-group-collapse {
  background: none; border: none; color: var(--muted);
  cursor: pointer; font-size: 11px; padding: 2px 4px;
  line-height: 1;
}
.dock-group-collapse:hover { color: var(--text); }

/* panel body */
.dock-pane {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}
.dock-pane.hidden { display: none; }
.dock-group-collapsed .dock-pane { display: none !important; }
.dock-group-collapsed .dock-group-tabs { border-bottom: none; }
```

删除旧的 `.panel-head` 规则（它被 `.dock-group-tabs` 替代）——但先确认 `.panel-head` 只用于 `#right`，若有其他地方使用则保留并改名。

#### R4-c：逻辑模块

**新文件 `ui/src/renderer/dock-panel.ts`**

职责：
- 给每个 `.dock-group-collapse` 按钮绑 click，toggle `.dock-group-collapsed`。
- 给每个 `.dock-tab` 绑 click，切换同组 `.dock-pane` 的显示。
- 拖动组边界调整高度（可推迟到后续，先用 CSS flex 分配）。
- 持久化：`localStorage.setItem("clutch_dock_layout", JSON.stringify(state))`。
- 恢复：页面加载时读 localStorage，恢复 collapsed/active-tab。

**`ui/src/renderer/workspace-panel.ts`** 修改：
- `paintShellPanel()` 和 `setShellPanel()` 逻辑不变（手机 drawer 仍用 `#right` 整体）。
- `#tree` 仍由 `refreshTree()` 填写，无需改动。

**`ui/src/renderer/boot.ts`**：追加 `import "./dock-panel";`。

#### R4-d：手机兼容

**`ui/mobile.css`**：
- `.dock-group-tabs` 高度可适当放大到 32px。
- `.dock-group-actions .hidden-toggle` 保留，但把 label 文字隐藏（只保留 checkbox 的点击区域）。

---

### R5 · Workspace Layout Persistence（布局持久化）

**目标**：把散落在各模块里的 `localStorage` 操作统一成一个 `WorkspaceLayout` 对象，启动时一次性恢复，变化时 debounce 保存。

**新文件 `ui/src/renderer/workspace-layout.ts`**

```ts
export interface WorkspaceLayout {
  dockGroups: Array<{
    id: string;        // "files" | "tools"
    collapsed: boolean;
    activeTab: string; // tab data-tab 值
    height: number;    // px，0 = flex 自动
  }>;
  rightPanelWidth: number;  // #right 宽度，px
  optionsBarVisible: boolean;
}

const KEY = "clutch_workspace_layout";
const DEFAULTS: WorkspaceLayout = {
  dockGroups: [
    { id: "files", collapsed: false, activeTab: "workspace", height: 0 },
    { id: "tools", collapsed: true,  activeTab: "plugins",   height: 0 },
  ],
  rightPanelWidth: 300,
  optionsBarVisible: true,
};

export function loadLayout(): WorkspaceLayout { … }
export function saveLayout(layout: Partial<WorkspaceLayout>): void { … }  // debounced 500ms
export function resetLayout(): void { localStorage.removeItem(KEY); }
```

**被调用方：**
- `dock-panel.ts`：collapse/expand/tab-switch 时 `saveLayout({dockGroups: …})`。
- `tab-bar.ts`：tab 顺序变化时保存（tab 本身不存在 layout 里，它由 state.tabs 管理）。
- `boot.ts`：首次加载时 `loadLayout()` 再分发给各模块。

---

## 3. 执行步骤（串行，每步可单独审查）

| 步骤 | 内容 | 主要改动文件 | 预计工作量 |
|------|------|------------|--------|
| **Step 1** | R1：Options Bar | `index.html`、`style.css`、`mobile.css` | 小 |
| **Step 2** | R2：Status Bar | `index.html`、`style.css`、新 `status-bar.ts`、`stream-view.ts`、`project.ts`、`boot.ts` | 小-中 |
| **Step 3** | R3-a：Tab Bar HTML+CSS | `index.html`、`style.css` | 小 |
| **Step 4** | R3-b+c：Tab Bar 逻辑 | 新 `tab-bar.ts`、`state.ts`、`project.ts`、`boot.ts` | 中 |
| **Step 5** | R4-a+b：Dock Groups HTML+CSS | `index.html`、`style.css` | 小-中 |
| **Step 6** | R4-c+d：Dock Groups 逻辑 | 新 `dock-panel.ts`、`workspace-panel.ts`、`boot.ts`、`mobile.css` | 中 |
| **Step 7** | R5：Layout Persistence | 新 `workspace-layout.ts`，联结 dock-panel + tab-bar | 小 |

每步完成后运行：
```bash
cd ui && npm run typecheck   # 保证 TS 无报错
```
并手动验证：桌面布局正常、手机面板开合正常、现有功能（open/create/settings/ssh）不退步。

---

## 4. 关键约束备忘

- `#tree`、`#tree-hidden-toggle`、`#task-input`、`#run-btn`、`#mode-btn`、`#trust-btn`、`#workspace-path` 这些 ID 在多个 `.ts` 文件里硬编码，改名必须全局替换。
- `.panel-head` class 目前只用于 `#right`，可以安全替换成 `.dock-group-tabs`。
- `mobile.css` 里的 `#right` 变成 drawer 的逻辑依赖 `drawer-open` class，不依赖内部结构，R4 的 HTML 重构对手机逻辑透明。
- Settings modal 的 `.modal-tabs`/`.modal-tab`/`.modal-pane` 是已有的"标签切换"模板，R3 的 doc-tab 和 R4 的 dock-tab 不复用这套（尺寸和语义不同），但遵循同样的 `role="tablist"` + `aria-selected` ARIA 模式。
- `setStatus()` 目前在 `stream-view.ts`，R2 要在里面加一行 `dispatchEvent`，注意不要引入循环 import（`status-bar.ts` 只监听 document event，不 import stream-view）。
