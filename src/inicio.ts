/// The order in which the app starts up, without DOM or Tauri — so it can be tested, like
/// `uso.ts`. `main.ts` does each step; only the sequence lives here, which
/// already broke once: resuming the radio before the fonts left the app with
/// no tabs (a loading stream holds the page's `load`, and with it
/// `document.fonts.ready`).
export type Passos = {
  /// Measuring the cell before the font loads gives the wrong width across the whole grid.
  fontes(): Promise<unknown>;
  /// The window, menu and socket events.
  ligar(): Promise<void>;
  /// The menu, the pinned tab and the previous session's tabs.
  abrirAbas(): Promise<void>;
  /// What needs the tabs up.
  depois(): void;
  /// Closed playing, opens playing. Last: it is the step that can hold the page.
  retomarRadio(): void;
};

export async function iniciar(p: Passos): Promise<void> {
  await p.fontes();
  await p.ligar();
  await p.abrirAbas();
  p.depois();
  p.retomarRadio();
}
