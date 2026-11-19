// one command per user action
//
// VS Code's workbench rule, reduced to what this app needs: a menu item, a
// keyboard shortcut and a button never carry behaviour of their own — they all
// name ONE command, and that command owns both the work and the enablement
// (`when`) test. The previous menu was a switch full of hardcoded actions, which
// is how the same toggle ended up with two listeners (each undoing the other)
// and how "Stop" and "Close Project" shipped permanently disabled.
//
// This module is deliberately dependency-free: registrations live in titlebar.ts
// (the menu's owner), and everything else executes by id.

export type Command = {
  id: string;
  label?: string;
  run: (arg?: any) => any;
  // false = the entry point is disabled (menu item greyed, key ignored)
  enabled?: () => boolean;
  // "mod+o", "mod+shift+t", … — mod is Ctrl on Windows/Linux, Cmd on macOS
  key?: string;
};

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

export function register(def: Command): void {
  registry.set(def.id, def);
}

export function execute(id: string, arg?: any): boolean {
  const cmd = registry.get(id);
  if (!cmd) return false;
  try {
    if (cmd.enabled && !cmd.enabled()) return false;
  } catch (e) {
    return false;
  }
  try {
    const out = cmd.run(arg);
    if (out && typeof out.catch === "function") out.catch((e) => console.warn("[command] " + id, e));
  } catch (e) {
    console.warn("[command] " + id, e);
  }
  return true;
}

export function isEnabled(id: string): boolean {
  const cmd = registry.get(id);
  if (!cmd) return false;
  try {
    return !cmd.enabled || !!cmd.enabled();
  } catch (e) {
    return false;
  }
}

export function has(id: string): boolean {
  return registry.has(id);
}

// Something the enablement test reads changed (a run started, a tab closed…):
// entry points repaint themselves. Registration happens at load, before any
// listener exists, so this is safe to call from module bodies too.
export function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e) {
      /* a broken repaint must not take the others down */
    }
  }
}

export function onChange(cb: () => void): void {
  listeners.add(cb);
}

// ---- keyboard -----------------------------------------------------------------

function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop() || "";
  const needMod = parts.includes("mod") || parts.includes("ctrl");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const mod = e.ctrlKey || e.metaKey;
  if (needMod !== mod) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  return (e.key || "").toLowerCase() === key;
}

let bound = false;
export function bindKeys(): void {
  if (bound) return;
  bound = true;
  document.addEventListener("keydown", (e) => {
    // a composing IME or a text field's own editing key is not a shortcut
    if (e.isComposing) return;
    for (const cmd of registry.values()) {
      if (!cmd.key || !matches(e, cmd.key)) continue;
      if (cmd.enabled && !cmd.enabled()) continue;
      e.preventDefault();
      execute(cmd.id);
      return;
    }
  });
}
