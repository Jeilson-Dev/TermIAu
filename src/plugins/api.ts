/// The plugin API: what a TermIAu plugin sees. It plays the part of VS Code's
/// `vscode.d.ts` — a plugin imports only types from here; the values come in
/// `activate(ctx)`.
///
/// A plugin is a folder (installed from a `.termiau` package) with a `termiau.json`
/// manifest and an ES module. The manifest declares what it contributes: the
/// regions of the window it draws in, and its commands (with menu item and
/// shortcut). The module draws and does the work.

import type { Terminal } from "@xterm/xterm";

export type Language = "en" | "pt";

/// Text in the manifest: one string for every language, or one per language. `en`
/// is the fallback.
export type Localized = string | { en: string; pt?: string };

export interface Disposable {
  dispose(): void;
}

/// The window's independent areas, like VS Code's status bar, side bar, editor
/// tabs and settings. Each one is owned by the host: a plugin declares a slot in
/// one and draws only inside it. `statusBar` (the footer) and `panelHeader` (the bar
/// on top of each terminal panel, one slot per panel) exist so far.
export type RegionName = "statusBar" | "panelHeader" | "sidebar" | "tab" | "preferences";

export type RegionContribution = {
  region: RegionName;
  /// Unique within the plugin; the plugin asks for its slot by this id.
  id: string;
  /// Where in the footer: `start` is the left corner, before the task pills; `left`
  /// right after them; `right` against the right end (the default). The panel
  /// header ignores it.
  alignment?: "start" | "left" | "right";
  /// Higher comes first (further left). Default 0.
  priority?: number;
};

export type CommandContribution = {
  /// Unique within the plugin, no `:`.
  id: string;
  title: Localized;
  /// A Tauri accelerator, e.g. `CmdOrCtrl+Shift+P`. The native menu owns it.
  keybinding?: string;
  /// The menu bar submenu the command goes in. Without it, the command is only
  /// reachable from the plugin's own UI.
  menu?: Localized;
};

/// A setting the plugin declares, like VS Code's `contributes.configuration`. The
/// Plugins tab draws the field; the plugin reads the value with `ctx.settings`.
export type SettingContribution = {
  /// Unique within the plugin.
  key: string;
  title: Localized;
  description?: Localized;
} & (
  | {
      /// One of a fixed list, drawn as a select.
      type: "enum";
      options: { value: string; label: Localized }[];
      default: string;
    }
  | {
      /// On or off, drawn as a checkbox.
      type: "boolean";
      default: boolean;
    }
  | {
      /// A whole number, drawn as a number field.
      type: "number";
      default: number;
      min?: number;
      max?: number;
    }
);

export type SettingValue = string | boolean | number;

export type Manifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  /// Who made it, for the Plugins tab and the marketplace.
  author?: string;
  engines?: { termiau?: string };
  /// The ES module, relative to the plugin's folder.
  main: string;
  /// A stylesheet loaded with the plugin and removed with it.
  style?: string;
  /// A square image (SVG or PNG), relative to the plugin's folder: the Plugins tab
  /// shows it, and so will the marketplace. Without one, the default plugin icon.
  icon?: string;
  /// `onStartupFinished`: after the tabs are open. It is the only event so far, and
  /// a plugin without it is activated at the same moment.
  activationEvents?: string[];
  contributes?: {
    regions?: RegionContribution[];
    commands?: CommandContribution[];
    configuration?: SettingContribution[];
  };
  /// Native executables, by name → path in the package. Only a plugin signed by a
  /// publisher TermIAu trusts can install with them.
  binaries?: Record<string, string>;
  /// Where the binaries run, e.g. `darwin-arm64`.
  platforms?: string[];
  /// Plugins this one needs, by id. They are activated before it, their API reaches
  /// it through `ctx.plugins.api`, and the marketplace installs them with it. If one
  /// is missing or off, this plugin doesn't load.
  dependencies?: string[];
};

/// The shared dialog shell: dark backdrop, a box in the middle, a header with the title
/// and ✕, esc and a click outside close it. The plugin fills `body`.
export interface Dialog extends Disposable {
  readonly box: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

/// Key/value storage scoped to the plugin. Survives restarts; lives in the
/// webview's localStorage under `termiau:plugin:<id>:`.
export interface PluginStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/// What a panel is doing, as a plugin sees it, for the app's signals: `working` is the
/// quiet dot on its tab; `waiting` (it needs you) is the orange outline, the tab's
/// ring, the Dock badge and a stop for ⌘⇧A. The app draws them, and blinks them
/// unless the user turned blinking off.
export type PanelStatus = "working" | "waiting";

/// A terminal panel, as a plugin sees it.
export interface Panel {
  /// The panel's number: stable while it is open, and the one the hook's events carry.
  readonly id: number;
  /// The terminal's title (the shell or the program in front of it sets it).
  readonly title: string;
  /// The panel's xterm.js terminal, to read its buffer and decorate lines.
  readonly xterm: Terminal;
  /// Writes into the panel's shell as if typed (no Enter unless `text` has `\r`).
  write(text: string): void;
  /// Hands text over the way ⌘V does: wrapped in bracketed paste when the program
  /// asked for it, so several lines arrive as one block.
  paste(text: string): void;
  /// False once the panel was closed or its shell exited.
  isAlive(): boolean;
  /// The folder of the process in front of the shell.
  cwd(): Promise<string | null>;
  /// Whether a program other than the shell is in front.
  isBusy(): Promise<boolean>;
  /// Gives the panel the keyboard (and brings its tab to the front).
  focus(): void;
  /// A short message on the panel's header bar, gone after a few seconds.
  notify(text: string): void;
  /// The red pulsing border that says the panel needs attention. Any plugin
  /// asking for it turns it on.
  setAlert(on: boolean): void;
  /// This plugin's status for the panel; `undefined` clears it. The strongest of all
  /// plugins' is the one shown.
  setStatus(status: PanelStatus | undefined): void;
  /// This plugin's layer over the panel's terminal, created on the first call. It
  /// starts hidden; the plugin shows it (`hidden = false`) and draws in it.
  layer(): HTMLElement;
  /// Who gets the panel's keyboard while this plugin's layer is on screen: an element
  /// of the layer, or `undefined` to give it back to the terminal. A text field set
  /// here also gets the paths dropped on the panel.
  setKeyboard(target: HTMLElement | undefined): void;
  /// What this plugin wants back when the panel reopens with the app (or with ⌘⇧T):
  /// a string, kept with the panel in the saved tabs. `undefined` forgets it.
  setSaved(value: string | undefined): void;
}

/// Draws a plugin's slot in one panel's header. Runs for every panel, the open ones
/// and each one opened later; what it returns is disposed when the panel closes or
/// the plugin is turned off.
export type PanelHeaderRender = (panel: Panel, el: HTMLElement) => Disposable | void;

/// An item of the app's dropdown menu (`ctx.ui.menu`).
export type MenuItem = {
  label: string;
  /// Dimmed, at the right end.
  hint?: string;
  /// The current choice, marked.
  chosen?: boolean;
  onSelect(): void;
};

/// The app's socket (`TERMIAU_SOCK`, with `TERMIAU_PANEL` saying which panel), as
/// one plugin hears it. Whatever runs in a panel — the plugin's hook, say — writes
/// `{"panel":…,"plugin":"<this plugin's id>","message":…}` on one line; with
/// `"wait":true` the connection stays open for the plugin's answer.
export interface PluginSocket {
  /// Each message addressed to this plugin, as it was sent. One waiting for an
  /// answer comes with `replyId`.
  onMessage(handler: (panel: number, message: unknown, replyId?: string) => void): Disposable;
  /// Writes the answer to the sender waiting under `replyId`; rejects when it is gone.
  reply(replyId: string, answer: string): Promise<void>;
  /// Lets the sender waiting under `replyId` go without an answer.
  drop(replyId: string): void;
}

/// One end of the diff tab's line to the plugins: the diff tab calls `name` with
/// `args` and gets back what the handler returns.
export type DifferService = (args: Record<string, unknown>) => unknown;

/// One of the plugin's native binaries, running (see `binaries` in the manifest).
/// Speaks newline-delimited JSON: `send` writes one line to its stdin, each line it
/// prints on stdout arrives in `onMessage`, parsed.
export interface PluginProcess extends Disposable {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): Disposable;
  onExit(handler: (code: number | null) => void): Disposable;
  kill(): void;
}

export interface PluginContext {
  readonly manifest: Manifest;
  readonly language: Language;
  /// Goes to the app's log (the process stderr), prefixed with the plugin's id.
  log(message: string): void;
  readonly storage: PluginStorage;
  /// The values of the settings declared in the manifest (`contributes.configuration`),
  /// which the user changes in the Plugins tab.
  readonly settings: {
    /// The value set, or the declared default.
    get(key: string): SettingValue;
    /// Fires with the setting's key when the user changes it.
    onChange(handler: (key: string) => void): Disposable;
  };
  readonly regions: {
    /// The element of the footer slot declared in the manifest with this id.
    statusBar(id: string): HTMLElement;
    /// Draws the `panelHeader` slot declared with this id, in every panel.
    panelHeader(id: string, render: PanelHeaderRender): Disposable;
  };
  readonly terminal: {
    /// The panel with the keyboard now, if any.
    focusedPanel(): Panel | undefined;
    /// The open panel with this number.
    panel(id: number): Panel | undefined;
    /// The open panels.
    panels(): Panel[];
    /// Fires on every key the user types into any panel, with what it sent. Not the
    /// terminal's own answers to the program (focus in/out, cursor reports).
    onUserInput(handler: (panel: Panel, data: string) => void): Disposable;
    /// A panel got the keyboard.
    onFocus(handler: (panel: Panel) => void): Disposable;
    /// A panel was opened; the ones already open are reported at once.
    onOpened(handler: (panel: Panel) => void): Disposable;
    onClosed(handler: (id: number) => void): Disposable;
    /// A panel came back with the saved tabs, with what the plugin saved in it
    /// (`Panel.setSaved`). The ones restored before the plugin started arrive at once.
    onRestored(handler: (panel: Panel, saved: string) => void): Disposable;
  };
  readonly process: {
    /// Starts one of the plugin's declared binaries. Only verified plugins have
    /// them; the app checks the signature again before each start.
    spawn(binary: string): Promise<PluginProcess>;
  };
  readonly plugins: {
    /// What a plugin in this one's `dependencies` returned from `activate`.
    api<T>(id: string): T;
  };
  readonly socket: PluginSocket;
  readonly commands: {
    /// Runs when the command's menu item or shortcut fires.
    register(id: string, handler: () => void): Disposable;
  };
  readonly ui: {
    /// A footer button: the click doesn't take the keyboard from the terminal.
    button(className: string, iconHtml: string, title: string): HTMLButtonElement;
    dialog(options: { title: string; className?: string }): Dialog;
    /// Scrolls `text` inside `box` when it doesn't fit, now and then. Call it when
    /// the text changes.
    marquee(box: HTMLElement, text: HTMLElement): void;
    /// Gives the keyboard back to the focused terminal panel.
    restoreFocus(): void;
    /// The app's dropdown, beside `anchor`. Clicking the same anchor again closes it.
    menu(anchor: HTMLElement, items: MenuItem[]): void;
    /// The app's question box. True for the confirm button; without `cancel` it is a notice.
    ask(question: { title: string; text: string; confirm: string; cancel?: string }): Promise<boolean>;
    /// ⌘- or ⌃-click on a link: opens it in the browser. A plain click does nothing.
    openLink(event: MouseEvent, url: string): void;
    /// ⌘-click on a `<code>` that is a path (`file.ts:12`): opens it in the panel's
    /// viewer. Returns whether the click was that.
    openReference(panel: Panel, event: MouseEvent): boolean;
    /// The key is one of TermIAu's shortcuts, which a plugin's field must let through.
    isShortcut(event: KeyboardEvent): boolean;
  };
  /// The line to the diff tab (the differ): services it calls, and what it is told.
  readonly differ: {
    /// Answers the diff tab's calls to `name`.
    serve(name: string, handler: DifferService): Disposable;
    /// Tells the diff tab `topic`'s current value; it is kept and re-sent when the
    /// diff tab (re)loads.
    publish(topic: string, value: unknown): void;
    /// Loads `main`, a module in the plugin's package, into the diff tab's page: its
    /// `activate()` returns a `DifferExtension` (src/differ/lib/extensions.ts) — tools
    /// for a passage and boxes under the lines. It renders with the page's React.
    extend(main: string): Disposable;
  };
  /// Disposed on deactivation, after `deactivate()`.
  readonly subscriptions: Disposable[];
}

export type PluginModule = {
  /// What it returns is its API, for the plugins that depend on it.
  activate(ctx: PluginContext): unknown;
  deactivate?(): void | Promise<void>;
};
