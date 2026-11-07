// the page's one DOM shorthand
//
// `$` is the read the whole renderer makes: give it a selector, get the element
// or null. It lives in a module of its own — beside state.ts, not inside app.ts —
// because nearly every module calls it at LOAD time to find its own elements, and
// a module graph is initialized depth-first: an import cycle through app.ts would
// evaluate those calls before app.ts had run the line that defines `$`, which is
// exactly the "app.js happened to be loaded first" assumption the old page order
// encoded. A leaf module cannot be part of a cycle.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

export const $ = (s) => document.querySelector(s);
