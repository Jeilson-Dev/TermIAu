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

export const SUPPORTED_REGIONS: readonly RegionName[] = ["statusBar"];

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
    return typeof v === "string" && s.options.some((o) => o.value === v) ? v : s.default;
  } catch {
    return s.default;
  }
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
