/// Loads the installed plugins into the main window and gives each one its
/// context. Rust owns the disk and the menu (see src-tauri/src/plugins.rs); this side
/// owns the regions, the commands and the plugins' lifecycle.
///
/// A plugin runs in this webview, with the app's privileges — like a VS Code
/// extension runs with the user's. Installing one is trusting it. What the host does
/// guarantee is that a broken plugin never takes the app down: each step is in a
/// try/catch, and the error goes to the log and to the Plugins tab.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDialog, footerButton, marquee, stopMarquee } from "../ui";
import type {
  ClaudeChannel,
  Dialog,
  Disposable,
  Language,
  Manifest,
  MenuItem,
  Panel,
  PanelHeaderRender,
  PluginContext,
  PluginModule,
  PluginProcess,
  RegionContribution,
} from "./api";
import {
  ACTIVATION_ERRORS_KEY,
  activationOrder,
  displayKeybinding,
  localize,
  pluginFileUrl,
  regionProblems,
  settingProblems,
  settingStorageKey,
  settingValue,
  sortStatusBar,
  type InstalledPlugin,
  type StatusBarEntry,
} from "./manifest";

/// What the core lends the host. Passed in, not imported: the core is `main.ts`, which
/// is the app itself.
export type CoreServices = {
  language: Language;
  /// The panels, as `owner` (a plugin id) sees them: `setAlert` is per owner, so two
  /// plugins don't turn each other's alert off.
  focusedPanel(owner: string): Panel | undefined;
  panel(id: number, owner: string): Panel | undefined;
  /// The open panels that have a header bar (the drawer's terminal has none).
  panelIds(): number[];
  /// Where a panel's `panelHeader` slots go.
  panelHeader(id: number): HTMLElement | undefined;
  onPanelOpened(listener: (id: number) => void): void;
  onPanelClosed(listener: (id: number) => void): void;
  /// Turns off every alert `owner` left on.
  clearAlerts(owner: string): void;
  menu(anchor: HTMLElement, items: MenuItem[]): void;
  claude: ClaudeChannel;
  onUserInput(listener: () => void): Disposable;
  log(message: string): void;
  restoreFocus(): void;
  closeLabel: string;
  /// The shortcut help's "Plugins" group: rows of [keys, what they do].
  setShortcuts(rows: [string, string][]): void;
  /// The app's question dialog: true for the confirm button.
  ask(question: { title: string; text: string; confirm: string; cancel?: string }): Promise<boolean>;
  texts: {
    cancel: string;
    ok: string;
    installTitle: string;
    installText(name: string, version: string, id: string, description: string): string;
    installConfirm: string;
    installedTitle: string;
    installed(name: string): string;
    notInstalledTitle: string;
    notInstalled(file: string, error: string): string;
    dependencyMissing(name: string): string;
    dependencyOff(name: string): string;
    dependencyBroken(name: string): string;
    dependencyCycle: string;
  };
};

/// The plugin that may hear Claude Code directly. Signed by TermIAu too: an unsigned
/// package claiming the id gets nothing.
const CLAUDE_PLUGIN = "termiau.claude";
const CLAUDE_PUBLISHER = "TermIAu";

/// What `plugins_take_opened` returns: a .termiau macOS handed to the app.
type OpenedPackage = { path: string; manifest?: Manifest; error?: string };

/// With the time too: a plugin reinstalled with the same version is still new code.
const fileUrl = (id: string, file: string, version: string) => pluginFileUrl(id, file, `${version}-${Date.now()}`);

type Active = {
  manifest: Manifest;
  module?: PluginModule;
  /// What `activate` returned, for the plugins that depend on this one.
  api?: unknown;
  subscriptions: Disposable[];
  commands: Map<string, () => void>;
  slots: HTMLElement[];
  style?: HTMLLinkElement;
};

export function createPluginHost(core: CoreServices) {
  const statusBar = document.getElementById("status-bar-plugins") as HTMLDivElement;
  const statusBarLeft = document.getElementById("status-bar-left") as HTMLDivElement;
  const statusBarStart = document.getElementById("status-bar-start") as HTMLDivElement;

  /// The plugins' native processes, by the handle Rust gave them. One listener each
  /// for messages and exits, set up in `start`, routes to them.
  const processes = new Map<
    number,
    { onMessage: Set<(m: unknown) => void>; onExit: Set<(code: number | null) => void> }
  >();
  const active = new Map<string, Active>();
  const errors: Record<string, string> = {};
  /// Each installed plugin's name, for the messages about dependencies.
  const names = new Map<string, string>();

  /// Every plugin's `panelHeader` slot, with what it drew in each panel.
  type HeaderSlot = {
    plugin: string;
    region: RegionContribution;
    render: PanelHeaderRender;
    mounted: Map<number, { el: HTMLElement; drawn?: Disposable }>;
  };
  const headerSlots = new Set<HeaderSlot>();

  function mount(slot: HeaderSlot, id: number) {
    const panel = core.panel(id, slot.plugin);
    if (!panel || !core.panelHeader(id) || slot.mounted.has(id)) return;
    const el = document.createElement("div");
    el.className = "panel-header-slot";
    el.dataset.plugin = slot.plugin;
    el.dataset.slot = slot.region.id;
    let drawn: Disposable | undefined;
    try {
      drawn = slot.render(panel, el) || undefined;
    } catch (e) {
      core.log(`plugin ${slot.plugin}: panelHeader ${slot.region.id} failed: ${e}`);
    }
    slot.mounted.set(id, { el, drawn });
    layoutPanelHeader(id);
  }

  function unmount(slot: HeaderSlot, id: number) {
    const m = slot.mounted.get(id);
    if (!m) return;
    slot.mounted.delete(id);
    try {
      m.drawn?.dispose();
    } catch (e) {
      core.log(`plugin ${slot.plugin}: dispose failed: ${e}`);
    }
    m.el.remove();
  }

  /// A panel's slots in priority order, the same rule as the footer's.
  function layoutPanelHeader(id: number) {
    const container = core.panelHeader(id);
    if (!container) return;
    const entries = [...headerSlots]
      .filter((s) => s.mounted.has(id))
      .map((s) => ({ plugin: s.plugin, region: s.region, el: s.mounted.get(id)!.el }));
    container.replaceChildren(...(sortStatusBar(entries) as typeof entries).map((e) => e.el));
  }

  core.onPanelOpened((id) => {
    for (const s of headerSlots) mount(s, id);
  });
  core.onPanelClosed((id) => {
    for (const s of headerSlots) unmount(s, id);
  });
  /// A reload asked for while one is running waits for it, then runs once.
  let running: Promise<void> = Promise.resolve();

  function fail(id: string, message: string) {
    errors[id] = message;
    core.log(`plugin ${id}: ${message}`);
  }

  function publishErrors() {
    try {
      localStorage.setItem(ACTIVATION_ERRORS_KEY, JSON.stringify(errors));
    } catch {
      // Storage full or off: the log still has it.
    }
  }

  function publishShortcuts() {
    const rows: [string, string][] = [];
    for (const a of active.values()) {
      for (const c of a.manifest.contributes?.commands ?? []) {
        if (c.keybinding) rows.push([displayKeybinding(c.keybinding), localize(c.title, core.language)]);
      }
    }
    core.setShortcuts(rows);
  }

  function context(manifest: Manifest, entry: Active, verified?: string): PluginContext {
    const prefix = `termiau:plugin:${manifest.id}:`;
    const slots = new Map<string, HTMLElement>();
    for (const r of manifest.contributes?.regions ?? []) {
      if (r.region !== "statusBar") continue;
      const slot = document.createElement("div");
      slot.className = "status-bar-slot";
      slot.dataset.plugin = manifest.id;
      slot.dataset.slot = r.id;
      slots.set(r.id, slot);
      entry.slots.push(slot);
    }
    return {
      manifest,
      language: core.language,
      log: (m) => core.log(`plugin ${manifest.id}: ${m}`),
      storage: {
        get: (k) => localStorage.getItem(prefix + k),
        set: (k, v) => localStorage.setItem(prefix + k, v),
        remove: (k) => localStorage.removeItem(prefix + k),
      },
      settings: {
        get(key) {
          const s = manifest.contributes?.configuration?.find((c) => c.key === key);
          if (!s) throw new Error(`no setting "${key}" in the manifest`);
          return settingValue(s, localStorage.getItem(settingStorageKey(manifest.id, key)));
        },
        onChange(handler) {
          // The Plugins tab writes from its own document; this one hears the `storage` event.
          const listen = (e: StorageEvent) => {
            const key = manifest.contributes?.configuration?.find((c) => e.key === settingStorageKey(manifest.id, c.key))?.key;
            if (key) handler(key);
          };
          window.addEventListener("storage", listen);
          const d = { dispose: () => window.removeEventListener("storage", listen) };
          entry.subscriptions.push(d);
          return d;
        },
      },
      regions: {
        statusBar(id) {
          const slot = slots.get(id);
          if (!slot) throw new Error(`no statusBar region "${id}" in the manifest`);
          return slot;
        },
        panelHeader(id, render) {
          const region = manifest.contributes?.regions?.find((r) => r.region === "panelHeader" && r.id === id);
          if (!region) throw new Error(`no panelHeader region "${id}" in the manifest`);
          const slot: HeaderSlot = { plugin: manifest.id, region, render, mounted: new Map() };
          headerSlots.add(slot);
          for (const panel of core.panelIds()) mount(slot, panel);
          const d = {
            dispose() {
              headerSlots.delete(slot);
              for (const panel of [...slot.mounted.keys()]) unmount(slot, panel);
            },
          };
          entry.subscriptions.push(d);
          return d;
        },
      },
      terminal: {
        focusedPanel: () => core.focusedPanel(manifest.id),
        panel: (id) => core.panel(id, manifest.id),
        onUserInput(handler) {
          const d = core.onUserInput(handler);
          entry.subscriptions.push(d);
          return d;
        },
      },
      process: {
        async spawn(binary) {
          const handle = await invoke<number>("plugin_process_spawn", { plugin: manifest.id, binary });
          const listeners = { onMessage: new Set<(m: unknown) => void>(), onExit: new Set<(c: number | null) => void>() };
          processes.set(handle, listeners);
          const proc: PluginProcess = {
            send: (message) =>
              void invoke("plugin_process_send", { handle, line: JSON.stringify(message) }).catch((e) =>
                core.log(`plugin ${manifest.id}: send failed: ${e}`),
              ),
            onMessage(fn) {
              listeners.onMessage.add(fn);
              return { dispose: () => void listeners.onMessage.delete(fn) };
            },
            onExit(fn) {
              listeners.onExit.add(fn);
              return { dispose: () => void listeners.onExit.delete(fn) };
            },
            kill: () => {
              processes.delete(handle);
              void invoke("plugin_process_kill", { handle });
            },
            dispose: () => proc.kill(),
          };
          // Deactivating the plugin stops its processes, whatever the plugin forgets.
          entry.subscriptions.push(proc);
          return proc;
        },
      },
      plugins: {
        api<T>(id: string): T {
          if (!manifest.dependencies?.includes(id)) throw new Error(`"${id}" isn't in this plugin's dependencies`);
          const dep = active.get(id);
          if (!dep) throw new Error(`"${id}" isn't active`);
          return dep.api as T;
        },
      },
      claude: manifest.id === CLAUDE_PLUGIN && verified === CLAUDE_PUBLISHER ? core.claude : undefined,
      commands: {
        register(id, handler) {
          entry.commands.set(id, handler);
          return { dispose: () => void entry.commands.delete(id) };
        },
      },
      ui: {
        button: footerButton,
        dialog({ title, className }): Dialog {
          let isOpen = false;
          const d = createDialog(
            title,
            core.closeLabel,
            () => {
              isOpen = false;
              core.restoreFocus();
            },
            className,
          );
          const dialog: Dialog = {
            box: d.box,
            body: d.body,
            get isOpen() {
              return isOpen;
            },
            open() {
              isOpen = true;
              d.open();
            },
            close: () => d.closeDialog(),
            dispose: () => d.dispose(),
          };
          entry.subscriptions.push(dialog);
          return dialog;
        },
        marquee,
        restoreFocus: core.restoreFocus,
        menu: core.menu,
        ask: core.ask,
      },
      subscriptions: entry.subscriptions,
    };
  }

  /// Puts every active plugin's slots in the footer, in priority order.
  function layoutStatusBar() {
    const entries: (StatusBarEntry & { el: HTMLElement })[] = [];
    for (const a of active.values()) {
      for (const el of a.slots) {
        const region = a.manifest.contributes?.regions?.find((r) => r.region === "statusBar" && r.id === el.dataset.slot);
        if (region) entries.push({ plugin: a.manifest.id, region, el });
      }
    }
    const sorted = sortStatusBar(entries) as typeof entries;
    const at = (where: string) => sorted.filter((e) => (e.region.alignment ?? "right") === where).map((e) => e.el);
    statusBarStart.replaceChildren(...at("start"));
    statusBarLeft.replaceChildren(...at("left"));
    statusBar.replaceChildren(...at("right"));
  }

  async function activate(p: InstalledPlugin) {
    const m = p.manifest!;
    const problems = [...regionProblems(m), ...settingProblems(m)];
    if (problems.length) return fail(m.id, problems.join("; "));
    // In order, a dependency was tried just before; if it failed, this one can't run.
    const down = m.dependencies?.find((d) => !active.has(d));
    if (down) return fail(m.id, core.texts.dependencyBroken(names.get(down) ?? down));

    const entry: Active = { manifest: m, subscriptions: [], commands: new Map(), slots: [] };
    if (m.style) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = fileUrl(m.id, m.style, m.version);
      link.dataset.plugin = m.id;
      document.head.appendChild(link);
      entry.style = link;
    }
    try {
      const mod = (await import(/* @vite-ignore */ fileUrl(m.id, m.main, m.version))) as Partial<PluginModule>;
      if (typeof mod.activate !== "function") throw new Error("main exports no activate()");
      entry.module = mod as PluginModule;
      const ctx = context(m, entry, p.verified);
      active.set(m.id, entry);
      // The slots go in before activate, so the plugin can measure what it draws.
      layoutStatusBar();
      entry.api = await entry.module.activate(ctx);
    } catch (e) {
      fail(m.id, `activation failed: ${e instanceof Error ? e.message : String(e)}`);
      await deactivate(m.id);
    }
  }

  async function deactivate(id: string) {
    const a = active.get(id);
    if (!a) return;
    active.delete(id);
    try {
      await a.module?.deactivate?.();
    } catch (e) {
      core.log(`plugin ${id}: deactivate failed: ${e}`);
    }
    for (const s of a.subscriptions.splice(0).reverse()) {
      try {
        s.dispose();
      } catch (e) {
        core.log(`plugin ${id}: dispose failed: ${e}`);
      }
    }
    for (const slot of a.slots) {
      for (const el of slot.querySelectorAll<HTMLElement>("*")) stopMarquee(el);
      slot.remove();
    }
    a.style?.remove();
    core.clearAlerts(id);
  }

  async function reloadNow() {
    // Dependents first: their `deactivate` may still call a dependency's API.
    for (const id of [...active.keys()].reverse()) await deactivate(id);
    for (const k of Object.keys(errors)) delete errors[k];

    let installed: InstalledPlugin[] = [];
    try {
      installed = await invoke<InstalledPlugin[]>("plugins_list");
    } catch (e) {
      core.log(`plugins: couldn't list: ${e}`);
    }
    names.clear();
    for (const p of installed) if (p.manifest) names.set(p.id, p.manifest.name);
    const t = core.texts;
    const { order, blocked } = activationOrder(installed, {
      missing: t.dependencyMissing,
      off: t.dependencyOff,
      broken: t.dependencyBroken,
      cycle: t.dependencyCycle,
    });
    for (const [id, why] of Object.entries(blocked)) fail(id, why);
    for (const p of order) await activate(p);
    layoutStatusBar();
    publishShortcuts();
    publishErrors();
  }

  const reload = () => (running = running.then(reloadNow, reloadNow));

  /// Packages opened from Finder, one question each. Installing goes through Rust,
  /// which then emits `plugins://changed` like the Plugins tab does.
  let asking: Promise<void> = Promise.resolve();

  async function installOpenedNow() {
    const t = core.texts;
    const opened = await invoke<OpenedPackage[]>("plugins_take_opened").catch(() => []);
    for (const p of opened) {
      const file = p.path.split("/").pop() ?? p.path;
      const m = p.manifest;
      if (!m) {
        await core.ask({ title: t.notInstalledTitle, text: t.notInstalled(file, p.error ?? ""), confirm: t.ok });
        continue;
      }
      const yes = await core.ask({
        title: t.installTitle,
        text: t.installText(m.name, m.version, m.id, m.description ?? ""),
        confirm: t.installConfirm,
        cancel: t.cancel,
      });
      if (!yes) continue;
      try {
        await invoke("plugins_install_file", { path: p.path });
        await core.ask({ title: t.installedTitle, text: t.installed(m.name), confirm: t.ok });
      } catch (e) {
        await core.ask({ title: t.notInstalledTitle, text: t.notInstalled(file, String(e)), confirm: t.ok });
      }
    }
  }

  const installOpened = () => (asking = asking.then(installOpenedNow, installOpenedNow));

  return {
    /// Loads the plugins and starts listening to Rust. Called once, after the tabs are
    /// open (`onStartupFinished`).
    async start() {
      await listen<{ handle: number; line: string }>("plugin-process://message", (e) => {
        const p = processes.get(e.payload.handle);
        if (!p) return;
        let message: unknown;
        try {
          message = JSON.parse(e.payload.line);
        } catch {
          return core.log(`plugin process ${e.payload.handle}: not JSON: ${e.payload.line.slice(0, 200)}`);
        }
        for (const fn of p.onMessage) fn(message);
      });
      await listen<{ handle: number; code: number | null }>("plugin-process://exit", (e) => {
        const p = processes.get(e.payload.handle);
        processes.delete(e.payload.handle);
        for (const fn of p?.onExit ?? []) fn(e.payload.code);
      });
      await listen("plugins://changed", () => void reload());
      await listen<{ plugin: string; command: string }>("plugin://command", (e) => {
        const handler = active.get(e.payload.plugin)?.commands.get(e.payload.command);
        if (!handler) return core.log(`plugin ${e.payload.plugin}: no handler for ${e.payload.command}`);
        try {
          handler();
        } catch (err) {
          core.log(`plugin ${e.payload.plugin}: command ${e.payload.command} failed: ${err}`);
        }
      });
      await listen("plugins://opened", () => void installOpened());
      await reload();
      // Opened from Finder before the window was listening (a double click that
      // launched the app).
      void installOpened();
    },
  };
}
