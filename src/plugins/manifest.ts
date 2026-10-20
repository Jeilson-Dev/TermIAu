/// The manifest rules that don't need the DOM or Tauri, so they can be tested.
/// Rust already validated the shape (see plugins.rs); this side checks what the
/// webview owns: the regions and the settings.

import type { Language, Localized, Manifest, RegionContribution, RegionName, SettingContribution, SettingValue } from "./api";

/// What `plugins_list` returns, one per folder.
export type InstalledPlugin = {
  id: string;
  enabled: boolean;
  manifest?: Manifest;
  error?: string;
  /// The publisher that signed it, checked by the app against the files on disk.
  verified?: string;
};

/// The activation errors, shared with the Plugins tab. The differ is a same-origin
/// iframe, so it reads this key and hears its `storage` event.
export const ACTIVATION_ERRORS_KEY = "termiau:plugins:activationErrors";

/// A file inside an installed plugin, served by Rust (see plugins.rs). The query
/// busts WebKit's cache, so an updated plugin is read again under the same name.
export const pluginFileUrl = (id: string, file: string, version = "") =>
  `termiau-plugin://localhost/${id}/${file}${version ? `?v=${encodeURIComponent(version)}` : ""}`;

/// Compares dotted versions number by number (`1.10.0` > `1.9.2`). Whatever isn't a
/// number counts as 0: a catalog is checked for updates, not for semver.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const SUPPORTED_REGIONS: readonly RegionName[] = ["statusBar", "panelHeader"];

export function localize(text: Localized, language: Language): string {
  if (typeof text === "string") return text;
  return (language === "pt" ? text.pt : undefined) ?? text.en;
}

/// The problems with a manifest's regions, as messages. Empty means it can load.
export function regionProblems(m: Manifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of m.contributes?.regions ?? []) {
    if (!SUPPORTED_REGIONS.includes(r.region)) problems.push(`region "${r.region}" is not supported yet`);
    if (!r.id) problems.push("a region without an id");
    else if (seen.has(`${r.region}:${r.id}`)) problems.push(`region "${r.region}:${r.id}" declared twice`);
    seen.add(`${r.region}:${r.id}`);
  }
  return problems;
}

/// The problems with a manifest's settings, as messages. Empty means it can load.
export function settingProblems(m: Manifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of m.contributes?.configuration ?? []) {
    if (!s.key) problems.push("a setting without a key");
    else if (seen.has(s.key)) problems.push(`setting "${s.key}" declared twice`);
    seen.add(s.key);
    if (s.type === "enum") {
      if (!s.options?.length) problems.push(`setting "${s.key}" has no options`);
      else if (!s.options.some((o) => o.value === s.default)) problems.push(`setting "${s.key}": the default isn't an option`);
    } else if (s.type === "boolean") {
      if (typeof (s.default as unknown) !== "boolean") problems.push(`setting "${s.key}": the default isn't true or false`);
    } else if (s.type === "number") {
      if (!Number.isFinite(s.default) || s.default !== clampSetting(s, s.default))
        problems.push(`setting "${s.key}": the default isn't a number within min and max`);
    } else {
      const other = s as unknown as { key: string; type: string };
      problems.push(`setting "${other.key}": type "${other.type}" is not supported`);
    }
  }
  return problems;
}

/// Where a setting's value lives in localStorage: the main window (the plugin) and
/// the Preferences (a same-origin iframe, which writes it) share it, and the
/// `storage` event tells one when the other changed it.
export const settingStorageKey = (plugin: string, key: string) => `termiau:plugin:${plugin}:setting:${key}`;

/// The stored value, if it is still valid for the setting; otherwise the default. A
/// plugin update can drop an option, and the user's old pick must not survive it.
export function settingValue(s: SettingContribution, stored: string | null): SettingValue {
  if (stored === null) return s.default;
  try {
    const v: unknown = JSON.parse(stored);
    if (s.type === "boolean") return typeof v === "boolean" ? v : s.default;
    if (s.type === "number") return typeof v === "number" && Number.isFinite(v) ? clampSetting(s, v) : s.default;
    return typeof v === "string" && s.options.some((o) => o.value === v) ? v : s.default;
  } catch {
    return s.default;
  }
}

/// A number setting's value, whole and within its `min` and `max`.
export function clampSetting(s: { min?: number; max?: number }, v: number): number {
  return Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, Math.round(v)));
}

/// The order to activate the enabled plugins in — each after its dependencies — and,
/// for the ones that can't run, why: a dependency that isn't installed, is off, or
/// can't run itself, or a cycle. `names` turns an id into what the user reads.
export function activationOrder(
  plugins: InstalledPlugin[],
  texts: { missing(dep: string): string; off(dep: string): string; broken(dep: string): string; cycle: string },
): { order: InstalledPlugin[]; blocked: Record<string, string> } {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const name = (id: string) => byId.get(id)?.manifest?.name ?? id;
  const order: InstalledPlugin[] = [];
  const blocked: Record<string, string> = {};
  const state = new Map<string, "visiting" | "done">();

  /// True when `id` can run (and is then in `order`).
  function visit(id: string): boolean {
    const p = byId.get(id)!;
    if (state.get(id) === "done") return !(id in blocked);
    if (state.get(id) === "visiting") {
      blocked[id] = texts.cycle;
      return false;
    }
    state.set(id, "visiting");
    for (const dep of p.manifest?.dependencies ?? []) {
      const d = byId.get(dep);
      const why = !d || !d.manifest ? texts.missing(name(dep)) : !d.enabled ? texts.off(name(dep)) : !visit(dep) ? texts.broken(name(dep)) : "";
      if (why && !(id in blocked)) blocked[id] = why;
    }
    state.set(id, "done");
    if (id in blocked) return false;
    order.push(p);
    return true;
  }

  for (const p of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p.enabled && p.manifest) visit(p.id);
  }
  return { order, blocked };
}

export type StatusBarEntry = { plugin: string; region: RegionContribution };

/// Footer order: higher priority first; ties by plugin id, so it is stable across
/// reloads.
export function sortStatusBar(entries: StatusBarEntry[]): StatusBarEntry[] {
  return [...entries].sort(
    (a, b) =>
      (b.region.priority ?? 0) - (a.region.priority ?? 0) ||
      a.plugin.localeCompare(b.plugin) ||
      a.region.id.localeCompare(b.region.id),
  );
}

const KEY_SYMBOLS: Record<string, string> = {
  cmdorctrl: "⌘",
  commandorcontrol: "⌘",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
  ctrl: "⌃",
  control: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  enter: "↩",
  return: "↩",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  escape: "⎋",
  backspace: "⌫",
  tab: "⇥",
  space: "Space",
};

/// The way the shortcut help writes a shortcut: `CmdOrCtrl+Shift+P` → `⌘⇧P`.
/// Modifiers in the order the help's own rows use (⌃⌘F, ⌘⌥←, ⌘⇧T), the key last.
export function displayKeybinding(accelerator: string): string {
  const order = ["⌃", "⌘", "⌥", "⇧"];
  const parts = accelerator.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const symbol = KEY_SYMBOLS[p.toLowerCase()];
    if (symbol && order.includes(symbol)) mods.push(symbol);
    else key = symbol ?? (p.length === 1 ? p.toUpperCase() : p);
  }
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.join("") + key;
}
