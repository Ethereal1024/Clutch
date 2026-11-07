// the page's non-module globals — everything the renderer reaches that is not
// an import
//
// ui/index.html loads five vendored libraries (marked, DOMPurify, highlight.js,
// mermaid, MathJax) as classic <script>s before the bundle: they publish plain
// globals and nothing about them is ours to import, so they are declared here
// once. They are `any` on purpose — the ratchet (strict:false, see
// tsconfig.renderer.json) has not reached them, and a half-typed shim would be a
// second rule set for the same call sites.
//
// The window.clutch* namespaces are the host bridge: ui/preload.js under
// Electron, bridge-shim.ts (bundled below every other module) in a plain browser
// or the Android WebView. They are optional because a page with no bridge at all
// is a page that degrades instead of throwing.

declare const marked: any;
declare const hljs: any;
declare const mermaid: any;
declare const MathJax: any;
declare const DOMPurify: any;

// Fields the renderer hangs on nodes and errors it owns. They are not DOM API
// and not Error API, they are ours: a fold wrapper remembers the pieces it was
// built from (`_fold`/`_head`/`_body`/`_label`), a streamed <pre> remembers the
// text it already painted (`_content`/`_drawn`), and a thrown request error
// carries what the server said (`status`/`code`/`owner`/`project`, see
// apiFetch in app.ts). Declared once here instead of cast at every read.
interface Error {
  code?: any;
  status?: number;
  owner?: any;
  project?: any;
}

interface HTMLElement {
  _fold?: any;
  _head?: any;
  _body?: any;
  _label?: any;
  _touched?: any;
  _taskText?: any;
  _content?: any;
  _drawn?: number;
}

interface HTMLOptionElement {
  mark?: string;
}

interface Window {
  clutchApi?: any;
  clutchSettings?: any;
  clutchTunnel?: any;
  clutchComponents?: any;
  clutchRun?: any;
  clutchLocks?: any;
  clutchUpdate?: any;
  clutchShell?: any;
  clutch?: any;
  // ui/version.js: the release stamp, rewritten after the bundle is built and
  // read only when the About pane paints
  CLUTCH_VERSION?: string;
  // set by an embedding shell (the Android WebView) to point bridge-shim.ts at
  // the host's loopback bridge
  CLUTCH_BRIDGE_BASE?: string;
}
