/// The plugin API: what a TermIAu plugin sees. It plays the part of VS Code's
/// `vscode.d.ts` — a plugin imports only types from here; the values come in
/// `activate(ctx)`.
///
/// A plugin is a folder (installed from a `.termiau` package) with a `termiau.json`
/// manifest and an ES module. The manifest declares what it contributes: the
/// regions of the window it draws in, and its commands (with menu item and
/// shortcut). The module draws and does the work.

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

/// A terminal panel, as a plugin sees it.
export interface Panel {
  /// The panel's number: stable while it is open, and the one Claude's events carry.
  readonly id: number;
  /// Writes into the panel's shell as if typed (no Enter unless `text` has `\r`).
  write(text: string): void;
  /// False once the panel was closed or its shell exited.
  isAlive(): boolean;
  /// A short message on the panel's header bar, gone after a few seconds.
  notify(text: string): void;
  /// The red pulsing border that says the panel needs attention. Any plugin
  /// asking for it turns it on.
  setAlert(on: boolean): void;
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

/// What Claude Code tells the app about a panel, raw. Only the Claude Code plugin
/// (`termiau.claude`, signed by TermIAu) gets it; other plugins use that plugin's API.
export interface ClaudeChannel {
  /// Each hook event (`hook_event_name`, `session_id`…), as Claude Code sends it.
  onEvent(handler: (panel: number, event: Record<string, unknown>) => void): Disposable;
  /// Each status line update: Claude Code's statusLine JSON (`context_window`,
  /// `rate_limits`, `model`, `effort`…).
  onStatus(handler: (panel: number, status: Record<string, unknown>) => void): Disposable;
  /// The session the app tracks in the panel, if Claude is running there.
  session(panel: number): { state: "idle" | "working" | "waiting"; session?: string; folder?: string } | undefined;
  /// Types a command into the panel's Claude and presses Enter. While it is working,
  /// shows `busy` on the panel's bar instead.
  send(panel: number, command: string, busy: string): void;
  readonly hooks: {
    state(): Promise<"no-claude" | "missing" | "outdated" | "installed">;
    install(): Promise<void>;
  };
}

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
    /// Fires on every key the user types into any panel.
    onUserInput(handler: () => void): Disposable;
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
  /// Claude Code's raw events. Only for `termiau.claude`; undefined for the rest.
  readonly claude?: ClaudeChannel;
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
  };
  /// Disposed on deactivation, after `deactivate()`.
  readonly subscriptions: Disposable[];
}

export type PluginModule = {
  /// What it returns is its API, for the plugins that depend on it.
  activate(ctx: PluginContext): unknown;
  deactivate?(): void | Promise<void>;
};
