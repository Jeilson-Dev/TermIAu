/// The order in which the app starts up, without DOM or Tauri — so it can be tested, like
/// `usage.ts`. `main.ts` does each step; only the sequence lives here, which
/// already broke once: resuming the radio before the fonts left the app with
/// no tabs (a loading stream holds the page's `load`, and with it
/// `document.fonts.ready`). The radio is a plugin now, and any plugin may do
/// the same — so plugins come last.
export type Steps = {
  /// Measuring the cell before the font loads gives the wrong width across the whole grid.
  fonts(): Promise<unknown>;
  /// The window, menu and socket events.
  connect(): Promise<void>;
  /// The menu, the pinned tab and the previous session's tabs.
  openTabs(): Promise<void>;
  /// What needs the tabs up.
  after(): void;
  /// The plugins' `onStartupFinished` (see src/plugins/host.ts). Last: a plugin is
  /// the step that can hold the page (the radio resuming a stream, for one).
  activatePlugins(): void;
};

export async function start(p: Steps): Promise<void> {
  await p.fonts();
  await p.connect();
  await p.openTabs();
  p.after();
  p.activatePlugins();
}
