/// A ordem em que o app sobe, sem DOM nem Tauri — para ter teste, como o
/// `uso.ts`. Quem faz cada passo é o `main.ts`; aqui fica só a sequência, que
/// já quebrou uma vez: a rádio retomada antes das fontes deixava o app sem
/// nenhuma aba (um stream carregando segura o `load` da página, e com ele o
/// `document.fonts.ready`).
export type Passos = {
  /// Medir a célula antes da fonte carregar dá largura errada em toda a grade.
  fontes(): Promise<unknown>;
  /// Os eventos da janela, do menu e do socket.
  ligar(): Promise<void>;
  /// O menu, a aba presa e as abas da sessão anterior.
  abrirAbas(): Promise<void>;
  /// O que precisa das abas de pé.
  depois(): void;
  /// Fechou tocando, abre tocando. Por último: é o passo que pode segurar a página.
  retomarRadio(): void;
};

export async function iniciar(p: Passos): Promise<void> {
  await p.fontes();
  await p.ligar();
  await p.abrirAbas();
  p.depois();
  p.retomarRadio();
}
