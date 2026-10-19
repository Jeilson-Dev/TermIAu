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
/// one and draws only inside it. Only `statusBar` exists for now.
export type RegionName = "statusBar" | "sidebar" | "tab" | "preferences";

export type RegionContribution = {
  region: RegionName;
  /// Unique within the plugin; the plugin asks for its slot by this id.
  id: string;
  /// Which end of the footer. Default `right`.
  alignment?: "left" | "right";
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
  };
  /// Native executables, by name → path in the package. Only a plugin signed by a
  /// publisher TermIAu trusts can install with them.
  binaries?: Record<string, string>;
  /// Where the binaries run, e.g. `darwin-arm64`.
  platforms?: string[];
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
  /// Writes into the panel's shell as if typed (no Enter unless `text` has `\r`).
  write(text: string): void;
  /// False once the panel was closed or its shell exited.
  isAlive(): boolean;
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
  readonly regions: {
    /// The element of the footer slot declared in the manifest with this id.
    statusBar(id: string): HTMLElement;
  };
  readonly terminal: {
    /// The panel with the keyboard now, if any.
    focusedPanel(): Panel | undefined;
    /// Fires on every key the user types into any panel.
    onUserInput(handler: () => void): Disposable;
  };
  readonly process: {
    /// Starts one of the plugin's declared binaries. Only verified plugins have
    /// them; the app checks the signature again before each start.
    spawn(binary: string): Promise<PluginProcess>;
  };
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
  };
  /// Disposed on deactivation, after `deactivate()`.
  readonly subscriptions: Disposable[];
}

export type PluginModule = {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
};
