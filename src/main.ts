import { Terminal, type IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { nossoAtalho, type Atalho } from "./atalhos";
import { iniciar } from "./inicio";
import { T } from "./i18n/terminal";
import { idioma } from "./i18n";
import { configsDe, listaDoPlay, tarefaAntes, tarefasDe, type ConfigLaunch, type Tarefa } from "./run/launch";
import { linhaDeComando, runnerPara, type Plano } from "./run/runners";
import { citar, palavra } from "./run/shell";
import { ESTACOES, type Estacao } from "./estacoes";
import {
  COMANDOS_DO_CLAUDE,
  filtrarComandos,
  lerFalas,
  linhasDePrompt,
  ladoALado,
  linhasDoDiff,
  markdown,
  partesDoSeu,
  provisoriosResolvidos,
  questoesDe,
  respostaDoHook,
  resumoDe,
  textoDaEscolha,
  type Comando,
  type Escolha,
  type ArquivoDiff,
  type Fala,
  type LinhaDiff,
  type Questao,
  escapar,
} from "./conversa";
import {
  acharReferencias,
  ehImagem,
  ehMarkdown,
  ehSvg,
  temRenderizado,
  linhaLogica,
  referenciaInteira,
  type LinhaDaTela,
  type Referencia,
} from "./visor";
import { SEMANA_MIN, SESSAO_MIN, faltaPara, janelaAgora, usoDaStatusLine, type LimitesDaStatusLine, fracaoRestante, limiteDoAutoCompact, nivelDoContexto, nivelDoRitmo, nivelDoUso, type Janela, type LimitesDoContexto, type Nivel, type Uso } from "./uso";
import { loadSettings, onSettings, saveViewMode, type Settings } from "./differ/lib/persist";
import type { ViewMode } from "./differ/types";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// Webview console -> process stderr, otherwise JS errors vanish.
// The HTML `lang` is fixed; the right one is the system's (see src/i18n).
document.documentElement.lang = idioma();

const jlog = (m: string) => invoke("js_log", { msg: m });
window.addEventListener("error", (e) => jlog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => jlog(`REJECT ${e.reason}`));

const janela = getCurrentWindow();
const barra = document.getElementById("tabs") as HTMLDivElement;
const painel = document.getElementById("panes") as HTMLDivElement;

const OPCOES_TERM = {
  // Same as iTerm2: p10k runs on nerdfont-complete and needs its glyphs,
  // which SF Mono/Menlo don't have — without this the prompt turns into boxes.
  fontFamily: '"MesloLGS NF", Menlo, monospace',
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  // Option composes characters, it doesn't become Meta: that is what makes ⌥C give "ç" and ⌥E+E give
  // "é". With Meta on, xterm sent ESC+c to the shell and the letter vanished.
  // What is lost is ⌥+letter as a readline shortcut (⌥F, ⌥B, ⌥.) — but the
  // keys that matter still work: xterm itself sends ESC b / ESC f on
  // ⌥← and ⌥→, and ESC DEL on ⌥⌫, because they are low-code keys and don't go
  // through the composition path.
  macOptionIsMeta: false,
  scrollback: 10_000,
  // OSC 8 links (Claude Code writes its own this way), with the same rule
  // as the ones the addon finds in the text.
  linkHandler: { activate: (e: MouseEvent, uri: string) => abrirLink(e, uri) },
  // Dracula, from the official spec (https://draculatheme.com/spec) and the ANSI palette
  // its terminals use. Without the 16 ANSI colors the theme would be half done: the
  // background would be Dracula and `ls` would keep coming out in xterm's default colors.
  theme: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
} as const;

/// How a split divides the space: "lado" puts panels side by side
/// (vertical border), "abaixo" stacks them (horizontal border).
type Eixo = "lado" | "abaixo";

/// A panel: a terminal and its PTY. It is always a leaf of the tab's tree.
type Folha = {
  tipo: "folha";
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  desligar: UnlistenFn[];
  titulo: string;
  /// Last grid already reported to the kernel — avoids repeated SIGWINCH for the same size.
  ultimo: { rows: number; cols: number };
  pai?: Divisao;
  /// The node keeps pointing to its parents after being torn out, so walking up the tree
  /// doesn't tell a dead panel from a live one. This flag does.
  morta?: boolean;
  /// Present while a Claude Code session is running in this panel.
  claude?: SessaoClaude;
  /// The tree's panels have a bar: title, play, stop, diff.
  barra?: Barra;
  /// The terminal of the app this panel's play button runs.
  gaveta?: Gaveta;
  /// In a drawer terminal: the panel that owns it.
  dono?: Folha;
  /// The app this panel's play button launched, in its drawer.
  execucao?: Execucao;
  /// What you sent to Claude in this panel: it is how the terminal finds
  /// your lines on screen to highlight (see `marcar`).
  prompts?: string[];
  /// The highlight of each prompt found, by the line it is on.
  marcas?: Map<string, IDecoration>;
  /// How the screen was at the last search: what had already gone into scrollback
  /// doesn't change anymore, and needn't be read again (see `marcar`).
  vistas?: { base: number; cols: number; prompts: number };
  esperaMarcas?: ReturnType<typeof setTimeout>;
  /// The conversation in bubbles, over the terminal. It exists after the first time
  /// the panel enters chat mode.
  chat?: Chat;
  /// The file shown in the panel, over the terminal and the chat. It exists
  /// after the first `termiau ver` or ⌘-click on a reference.
  visor?: Visor;
  /// The file explorer, a drawer over the panel. It exists after the first time it opens.
  explorador?: Explorador;
};

type SessaoClaude = {
  /// How the voice calls this panel. It is the folder name, not "panel 2": hearing
  /// "MOBILE needs your permission" says where to go; a number doesn't.
  nome: string;
  estado: "ocioso" | "trabalhando" | "esperando";
  /// The session id, as the hook reports it. It is what `claude --resume` asks for
  /// to resume it when the tab comes back (see `retomar`).
  sessao?: string;
  /// The folder the session was born in: `--resume` only finds it from there.
  pasta?: string;
  /// The JSONL where Claude Code writes the conversation. Chat mode reads from it.
  transcricao?: string;
  /// Why Claude stopped to wait, when the hook said.
  aviso?: string;
  /// What the wait asks for. `permissao`: a yes or no, which the chat answers with
  /// buttons. `terminal`: a menu only the terminal shows (a question's options,
  /// the plan to approve). With nothing, it just waits for the next message —
  /// and the chat field sends that as well as the terminal.
  pede?: "permissao" | "terminal";
  /// A Claude question (`AskUserQuestion`) chat mode can
  /// answer: the hook is waiting for it (see `Pendentes` in lib.rs). The
  /// terminal shows the same question at the same time, and whoever answers first
  /// wins.
  pergunta?: { id: string; questoes: Questao[] };
  /// How much of the context the session has used (0 to 100), from the status line.
  contexto?: number;
  /// The session's model (`display_name`, "Opus 5.5") and effort level
  /// ("high"), also from the status line. A model without effort doesn't send the level.
  modelo?: string;
  esforco?: string;
  /// Auto-compact already sent `/compact` this time. It only re-arms when the
  /// context drops below the limit — otherwise every status line would send another.
  compactou?: boolean;
};

/// The tools whose wait is a menu of options, not a yes or no: the
/// Enter of "Allow" would pick the first option without you having read it.
const PEDEM_TERMINAL = new Set(["AskUserQuestion", "ExitPlanMode"]);

/// The wait resolves without leaving the chat: it is just a missing message, or a
/// question the chat card answers.
const atendivelNoChat = (folha: Folha) =>
  folha.chat?.aberto && (!folha.claude?.pede || folha.claude.pergunta !== undefined);

/// A split: two children and the share that goes to the first. Nesting these nodes
/// gives the layouts iTerm2 makes — splitting an already split panel.
type Divisao = {
  tipo: "divisao";
  eixo: Eixo;
  fracao: number;
  filhos: [No, No];
  el: HTMLDivElement;
  pai?: Divisao;
};

type No = Folha | Divisao;

type Aba = {
  corpo: HTMLDivElement;
  chip: HTMLDivElement;
  rotulo: HTMLSpanElement;
  /// The focused panel's branch, right after the chip's title.
  ramo: Ramo;
  raiz: No;
  /// The panel that gets the keyboard; its title is what the tab shows.
  foco: Folha;
  /// The panel taking the whole tab, with the others hidden for a while.
  /// They stay alive in the tree — restoring brings the layout back as it was.
  maximizada?: Folha;
};

/// The terminal of the app a panel's play button runs: inside the panel, below its
/// terminal, outside the split tree — and hideable. See `criarGaveta`.
type Gaveta = {
  folha: Folha;
  el: HTMLDivElement;
  aberta: boolean;
};

const abas: Aba[] = [];
let ativa: Aba | undefined;
/// A shortcut repeated quickly would fire two concurrent `criarFolha`s, and both
/// would touch the same tree at the same time.
let ocupado = false;

/// The pinned tab: the differ, the branch's diff against the target branch. It lives outside the
/// `abas` array on purpose — it has no PTY, doesn't split, doesn't close and doesn't leave
/// first place. Inside the array, every function that sweeps panels today would
/// have to ask first whether that tab has any; outside it, none needs to know
/// it exists.
type Presa = {
  corpo: HTMLDivElement;
  chip: HTMLDivElement;
  quadro: HTMLIFrameElement;
  /// The differ has mounted and is listening for messages.
  pronta: boolean;
  /// Messages given before that. The first click almost always arrives before the
  /// page exists — it only loads when the tab is opened for the first time.
  fila: unknown[];
  /// There is a repository open in there. The differ itself says so, since it
  /// knows whether opening worked: sending a panel's cwd doesn't guarantee that the
  /// folder is a repository.
  repoAberto: boolean;
};
let presa: Presa | undefined;
/// The root of the repository open in the diff, as the differ reports it. It is how
/// that project's panels light up the diff button: the diff is of a
/// repository, not a panel, and two panels may belong to the same one.
let repoDoDiff: string | null = null;
/// True while the pinned tab is the one on screen. `ativa` keeps
/// pointing to the terminal we came from — that is where we go back.
let noDiff = false;

// ---------- tree ----------

function* folhas(no: No): Generator<Folha> {
  if (no.tipo === "folha") yield no;
  else for (const f of no.filhos) yield* folhas(f);
}

/// Walks up to the root and finds out whose it is. Avoids storing the tab in every
/// leaf, which would create an annoying cycle to set up when creating the first one.
function abaDe(no: No): Aba | undefined {
  // A drawer's terminal isn't in the tree: its tab is the owner's.
  if (no.tipo === "folha" && no.dono) return abaDe(no.dono);
  let raiz = no;
  while (raiz.pai) raiz = raiz.pai;
  return abas.find((a) => a.raiz === raiz);
}

/// The panels on screen: the tree's, and the open drawers. Hidden,
/// a drawer keeps its last size, like a hidden tab (see `ativar`).
function* visiveis(aba: Aba): Generator<Folha> {
  // Maximized, only it is on screen. The hidden ones keep the grid they had,
  // like a hidden tab: no measuring, no SIGWINCH to zero.
  for (const f of aba.maximizada ? [aba.maximizada] : folhas(aba.raiz)) {
    // The drawer before its owner: it is inside the owner's element, and whoever looks for
    // the panel under the pointer (`folhaEm`) has to find it first.
    if (f.gaveta?.aberta) yield f.gaveta.folha;
    yield f;
  }
}

/// Swaps one child for another, keeping the position — it is what preserves the order of
/// the grid tracks, which decides which panel goes on which side.
function trocarFilho(pai: Divisao, velho: No, novo: No) {
  pai.filhos[pai.filhos[0] === velho ? 0 : 1] = novo;
  novo.pai = pai;
}

/// The grid has three tracks: first child, gap, second child. The gap's
/// thickness is style.css's `--vao` — the same measure that keeps the panel cards
/// apart from each other and from the window's edge.
function aplicarFracao(d: Divisao) {
  const tracks = `${d.fracao}fr var(--vao) ${1 - d.fracao}fr`;
  d.el.style.gridTemplate = d.eixo === "lado" ? `1fr / ${tracks}` : `${tracks} / 1fr`;
}

// ---------- measuring ----------

/// Redoes the grid of every visible panel in the tab from its size on screen.
/// Local drawing only: doesn't talk to the kernel.
function medir(aba: Aba) {
  for (const f of visiveis(aba)) {
    f.fit.fit();
    // Splitting, closing and switching tabs move the panel out of place (or off screen), and
    // the browser resets the scroll of whatever goes through that.
    if (f.chat?.aberto) reporRolagem(f.chat);
  }
}

/// Tells the kernel the grids that actually changed, so the TUI redraws correctly.
function sincronizar(aba: Aba) {
  for (const f of visiveis(aba)) {
    if (f.term.rows === f.ultimo.rows && f.term.cols === f.ultimo.cols) continue;
    f.ultimo = { rows: f.term.rows, cols: f.term.cols };
    invoke("pty_resize", { id: f.id, ...f.ultimo }).catch((e) => jlog(`pty_resize: ${e}`));
  }
}

let pendente: ReturnType<typeof setTimeout> | undefined;
/// A single SIGWINCH, when the drag stops. Without this the shell redraws the prompt
/// every frame (~45 times in a drag), which looks like a new shell.
function agendarSync(aba: Aba) {
  clearTimeout(pendente);
  pendente = setTimeout(() => {
    // Re-measure before comparing: what counted during the drag was each
    // frame's layout, and the last one may have caught the window in the middle of an
    // animation. The settled layout is what rules.
    medir(aba);
    sincronizar(aba);
  }, 80);
}

// ---------- foco ----------

function focar(folha: Folha) {
  const aba = abaDe(folha);
  if (!aba) return;
  // Going to a hidden panel (⌘⇧A, one waiting for you) means wanting to see it:
  // the layout comes back first. The maximized panel's drawer is on screen, and stays.
  const dono = folha.dono ?? folha;
  if (aba.maximizada && aba.maximizada !== dono) recolher(aba);
  aba.foco.el.classList.remove("focada");
  aba.foco = folha;
  folha.el.classList.add("focada");
  teclado(folha);
  rotular(aba);
  // Looking at the panel is attending to it: the notice has done its job. In chat mode
  // too, if what is missing is a message; a permission request or a menu
  // stays lit until answered (through the notice's buttons or in the terminal).
  if (folha.claude?.estado === "esperando" && (!folha.chat?.aberto || atendivelNoChat(folha))) {
    folha.claude.estado = "ocioso";
  }
  pintar();
}

function rotular(aba: Aba) {
  aba.rotulo.textContent = aba.foco.titulo;
  aba.chip.title = aba.foco.titulo;
  mostrarRamos(aba);
  if (aba === ativa && !noDiff) janela.setTitle(`${aba.foco.titulo} — TermIAu`).catch(() => {});
}

function ativar(aba: Aba) {
  esconderPresa();
  ativa = aba;
  for (const a of abas) {
    const atual = a === aba;
    a.corpo.hidden = !atual;
    a.chip.classList.toggle("ativa", atual);
  }
  // The tab was hidden (zero size) and may have missed window resizes
  // in the meantime: re-measure now, before giving focus back.
  medir(aba);
  sincronizar(aba);
  // A branch that arrived with the tab hidden measured zero and didn't start scrolling.
  for (const f of visiveis(aba)) if (f.barra) repassear(f.barra.ramo);
  teclado(aba.foco);
  rotular(aba);
  agendarSalvar();
}

// ---------- creation ----------

/// Opens a shell and returns its panel. `inserir` puts the element in its
/// final place BEFORE we measure: off screen the grid would come out zeroed, and it is
/// what goes into the spawn.
///
/// `comBarra`: the tree's panels have their bar (title, play, diff); a
/// drawer's terminal doesn't — the owner's bar controls it.
async function criarFolha(
  cwd: string | null,
  inserir: (el: HTMLDivElement) => void,
  comBarra = true,
): Promise<Folha | undefined> {
  const el = document.createElement("div");
  el.className = "folha";
  const barra = comBarra ? criarBarra() : undefined;
  // The terminal lives in an element of its own: the panel also carries the bar on top and,
  // when play runs something, the drawer below. Inside it, `folha-tela` holds
  // the terminal and the chat; the split viewer sits beside it, not on top.
  const host = elemento("div", "folha-termo");
  const tela = elemento("div", "folha-tela");
  host.append(tela);
  if (barra) el.append(barra.el);
  el.append(host);
  inserir(el);

  const term = new Terminal(OPCOES_TERM);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => abrirLink(e, uri)));
  term.attachCustomKeyEventHandler((e) => {
    // ⇧↩ inserts a newline instead of sending: xterm sends the same `\r` as Enter,
    // so it sends `ESC ↩`, which Claude reads as a new line (and zsh too).
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      if (e.type === "keydown") term.input("\x1b\r");
      return false;
    }
    return !nossoAtalho(e);
  });
  term.open(tela);
  fit.fit();

  let id: number;
  try {
    id = await invoke<number>("pty_spawn", { rows: term.rows, cols: term.cols, cwd });
  } catch (e) {
    el.remove();
    term.dispose();
    jlog(`pty_spawn failed: ${e}`);
    return;
  }

  const folha: Folha = {
    tipo: "folha",
    id,
    term,
    fit,
    el,
    desligar: [],
    titulo: "shell",
    ultimo: { rows: term.rows, cols: term.cols },
    barra,
  };

  // Clicking a panel sends the keyboard to it, no shortcut needed. The drawer
  // sits inside the panel, but a click on it is its own: it has its own focus.
  el.addEventListener("mousedown", (e) => {
    if (folha.gaveta?.el.contains(e.target as Node)) return;
    // With the split viewer, the keyboard stays on the side you clicked.
    if (folha.visor) folha.visor.comTeclado = folha.visor.el.contains(e.target as Node);
    focar(folha);
  });
  ligarBarra(folha);
  ligarLinksDeArquivo(folha);

  // PTY -> screen. Rust sends base64 so as not to break UTF-8 in the middle of a chunk.
  folha.desligar.push(
    await listen<string>(`pty://data/${id}`, (e) => {
      const bin = atob(e.payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // Claude redraws the screen whenever it wants, and the highlight of your prompts
      // has to follow the lines: redo it after each batch of output.
      term.write(bytes, () => agendarMarcas(folha));
    }),
  );
  // The shell ended on its own — ⌃D, `exit`, crash: the panel goes with it.
  folha.desligar.push(
    await listen(`pty://exit/${id}`, () => fecharFolha(folha, { jaMorto: true })),
  );

  // Only now does Rust start pumping: an event emitted before this point
  // would have no one listening and the start of the prompt would be lost.
  await invoke("pty_attach", { id });

  // screen -> PTY. `onData` is user input: dictation goes in through `pty_write`
  // directly and doesn't pass here, so typing is distinguishable from speaking.
  term.onData((data) => {
    cancelarEnvio();
    // Touching the panel is attending to it, as much as clicking it: the
    // "waiting" notice stops blinking on the first key. `focar` only covers whoever
    // arrives at the panel; whoever was already on it types directly.
    if (folha.claude?.estado === "esperando" && !RESPOSTA_DO_TERMINAL.test(data)) {
      folha.claude.estado = "ocioso";
      pintar();
    }
    // Esc alone interrupts Claude, and when interrupted it doesn't send `Stop`.
    if (data === "\x1b" && folha.claude?.estado === "trabalhando") {
      folha.claude.estado = "ocioso";
      pintar();
    }
    invoke("pty_write", { id, data }).catch((e) => jlog(`pty_write: ${e}`));
  });
  // The prompt (p10k, zsh) publishes the directory via OSC; it is the tab's title.
  term.onTitleChange((t) => {
    folha.titulo = t || "shell";
    const aba = abaDe(folha);
    if (aba?.foco === folha) rotular(aba);
    // The bar shows the title, and a `cd` may have changed project.
    desenharBarra(folha);
    agendarProjeto(folha);
  });

  desenharBarra(folha);
  desenharMaximizar(folha);
  agendarProjeto(folha);
  return folha;
}

/// xterm's `onData` doesn't only carry what you type: the terminal itself
/// answers the program through it — focus in or out, cursor position,
/// terminal attributes, the mouse, colors. None of that is you touching the panel.
/// Focus matters most: switching tabs sends an "I left", and without this filter
/// leaving a waiting panel would clear its notice.
const RESPOSTA_DO_TERMINAL = /^\x1b(?:\[[IO]$|\[[?>=]?[\d;]*[Rcnty]$|\[<|\[M|[\]P_])/;

/// How long the ✕ stays armed waiting for the second click. Short on purpose:
/// it is a confirmation, not a mode — past that, the tab goes back to being a tab.
const CONFIRMA_FECHAR = 1000;

/// How to disarm the tab that is armed now, if any. Two tabs in
/// red at the same time would say both are closing, and only one is: arming
/// one disarms the other.
let desarmarFechar: (() => void) | undefined;

/// `em`: the folder the tab opens in, for callers who already know it — a tab
/// coming back (see `reabrir`). Without it, the focused panel's applies.
async function novaAba(em?: string | null): Promise<Aba | undefined> {
  if (ocupado) return;
  ocupado = true;
  try {
    // A new tab opens where the focused panel is, like in other terminals. Rust
    // falls back to HOME on its own if it can't find out (deleted folder, for example).
    const cwd =
      em !== undefined ? em : ativa ? await invoke<string | null>("pty_cwd", { id: ativa.foco.id }) : null;

    const corpo = document.createElement("div");
    corpo.className = "aba";
    painel.appendChild(corpo);
    // Measure in the final place: with the previous tab still visible, the two
    // would split the area and the grid would come out at half height.
    esconderPresa();
    if (ativa) ativa.corpo.hidden = true;

    const folha = await criarFolha(cwd, (el) => corpo.appendChild(el));
    if (!folha) {
      // No shell, no tab: undo and give the screen back to whatever was open.
      corpo.remove();
      if (ativa) ativa.corpo.hidden = false;
      return;
    }

    const chip = document.createElement("div");
    chip.className = "tab";
    // Claude's status dot; stays transparent while there is no session.
    const sinal = document.createElement("span");
    sinal.className = "tab-sinal";
    const rotulo = document.createElement("span");
    rotulo.className = "tab-titulo";
    rotulo.textContent = folha.titulo;
    const ramo = criarRamo("tab-ramo");
    const fechar = document.createElement("span");
    fechar.className = "tab-fechar";
    // The "+" of the new tab, turned: the same stroke and size, where the "✕" glyph came out small.
    fechar.innerHTML = ICONE_FECHAR_ABA;
    chip.append(sinal, rotulo, ramo.el, fechar);
    barra.appendChild(chip);

    const aba: Aba = { corpo, chip, rotulo, ramo, raiz: folha, foco: folha };
    folha.el.classList.add("focada");

    // Closing a tab has no undo: the shell dies with it, and with it whatever was
    // running there. That is why ✕ asks twice — the first click only lights the
    // red ring, the notice that it is THIS tab going away, and the
    // second, within CONFIRMA_FECHAR, is what closes it. Without the second, the ring
    // fades on its own and nothing happened.
    let espera: ReturnType<typeof setTimeout> | undefined;
    const desarmar = () => {
      if (espera === undefined) return;
      clearTimeout(espera);
      espera = undefined;
      chip.classList.remove("armada");
      if (desarmarFechar === desarmar) desarmarFechar = undefined;
    };

    chip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // ✕ closes the whole tab; on the rest of the chip, it only activates.
      if (e.target === fechar) {
        // Second click within the window: that is what they really wanted.
        if (espera !== undefined) {
          desarmar();
          fecharAba(aba);
          return;
        }
        desarmarFechar?.();
        chip.classList.add("armada");
        espera = setTimeout(desarmar, CONFIRMA_FECHAR);
        desarmarFechar = desarmar;
      } else {
        // Clicked the chip, not ✕: changed their mind about closing.
        desarmar();
        ativar(aba);
      }
    });
    // Middle button closes, like in the browser. It is a gesture nobody makes by
    // accident, so this one skips the confirmation.
    chip.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      desarmar();
      fecharAba(aba);
    });

    abas.push(aba);
    ligarArrasto(aba);
    sincronizarBarra();
    ativar(aba);
    return aba;
  } finally {
    ocupado = false;
  }
}

function sincronizarBarra() {
  // With the pinned tab in the bar there are always two chips, so it no longer
  // hides. That was the price of the diff always being one click away.
  barra.hidden = !presa && abas.length < 2;
}

// ---------- reordenar abas ----------

/// How far the pointer must move for the intent to become a drag. Without this
/// slack, a click with a shaky hand would reorder the bar unasked.
const LIMIAR_ARRASTO = 4;

/// Dragging a chip along the bar moves the tab — and the array order is the
/// same one ⌘1..⌘9 and ⌘⇧[ use, so moving here moves it everywhere.
///
/// The chip follows the pointer via `transform`, which doesn't touch the layout: while
/// dragging, the neighbors stay where they were and serve as a ruler. The swap
/// happens as soon as the chip's center passes a neighbor's center, so the
/// bar reorders during the drag, not only on release.
function ligarArrasto(aba: Aba) {
  const chip = aba.chip;

  chip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // ✕ is a button, not a handle: whoever presses there wants to close, not move.
    if ((e.target as HTMLElement).classList.contains("tab-fechar")) return;

    // Point from which the offset is counted. It changes on every swap, because the chip
    // gets a new position in the layout and the `transform` must be discounted
    // from it so the chip doesn't jump on screen.
    let origem = e.clientX;
    let arrastando = false;

    const mover = (ev: PointerEvent) => {
      if (!arrastando) {
        if (Math.abs(ev.clientX - origem) < LIMIAR_ARRASTO || abas.length < 2) return;
        arrastando = true;
        chip.classList.add("arrastando");
      }
      chip.style.transform = `translateX(${ev.clientX - origem}px)`;

      // Only the two neighbors matter: to reach the third you have to pass
      // the second, and by then the swap with it has already happened.
      const i = abas.indexOf(aba);
      const centro = meio(chip);
      let alvo: Aba | undefined;
      if (abas[i - 1] && centro < meio(abas[i - 1].chip)) alvo = abas[i - 1];
      else if (abas[i + 1] && centro > meio(abas[i + 1].chip)) alvo = abas[i + 1];
      if (!alvo) return;

      const antes = chip.getBoundingClientRect().left;
      const j = abas.indexOf(alvo);
      abas[i] = alvo;
      abas[j] = aba;
      barra.insertBefore(chip, j < i ? alvo.chip : alvo.chip.nextSibling);
      // Both measurements carry the same `transform`, so the difference between
      // them is only how much the layout moved — which is what the origin absorbs.
      origem += chip.getBoundingClientRect().left - antes;
      chip.style.transform = `translateX(${ev.clientX - origem}px)`;
    };

    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      chip.classList.remove("arrastando");
      chip.style.transform = "";
      // The bar's order is the order in which the tabs come back.
      agendarSalvar();
    };

    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
    window.addEventListener("pointercancel", soltar, { once: true });
  });
}

/// The chip's horizontal center as it is on screen — with the drag's `transform`
/// included, which is exactly what `getBoundingClientRect` returns.
function meio(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

// ---------- aba presa: o diff ----------

/// The chip's icon. The pinned tab shows no text: it is always in the bar, and
/// a 180px chip reading "Diff" would compete for space with the name of what
/// you are running — which is the information that changes.
const ICONE_DIFF = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

/// Builds the pinned tab. Called before the first terminal tab: that is how its
/// chip ends up as the bar's first child, out of reach of any drag —
/// `ligarArrasto` only reorders what is in the `abas` array, and it isn't there.
///
/// The differ goes in an <iframe>, not mounted here in the document: its CSS is
/// global (it touches `body`, `button`, the scrollbar) and its shortcuts
/// are single keys. In a separate document, none of that reaches the terminal —
/// and Tauri's IPC crosses over because the origin is the same (see ponte.ts).
function criarPresa() {
  const corpo = document.createElement("div");
  corpo.className = "aba";
  corpo.hidden = true;
  const quadro = document.createElement("iframe");
  quadro.className = "quadro";
  quadro.src = "/differ.html";
  // The iframe goes inside a frame, not loose in the tab: the card's rounded
  // corner doesn't clip an iframe's content in WebKit — what clips is a plain
  // element with `overflow:hidden` around it.
  const moldura = elemento("div", "moldura");
  moldura.appendChild(quadro);
  corpo.appendChild(moldura);
  painel.appendChild(corpo);

  const chip = document.createElement("div");
  chip.className = "tab presa";
  chip.title = T.diffDaBranch;
  chip.innerHTML = ICONE_DIFF;
  barra.appendChild(chip);
  chip.addEventListener("mousedown", (e) => {
    if (e.button === 0) abrirPresa();
  });

  presa = { corpo, chip, quadro, pronta: false, fila: [], repoAberto: false };
  habilitarPresa(null);
}

/// Lights up or dims the diff chip. A tab that can only show a blank screen
/// doesn't open: while there is no repository, the chip stays dimmed and clicking
/// it does nothing.
function habilitarPresa(raiz: string | null) {
  if (!presa) return;
  presa.repoAberto = !!raiz;
  repoDoDiff = raiz;
  presa.chip.classList.toggle("desabilitada", !raiz);
  // Lit in the same color as the diff button of the panel the repository came from: the
  // two icons lit at the same time are what links one place to the other.
  presa.chip.classList.toggle("ligado", !!raiz);
  const nome = raiz?.split("/").filter(Boolean).pop();
  presa.chip.title = raiz
    ? T.diffDe(nome ?? T.repositorio)
    : T.nenhumRepositorio;
  // Each panel's diff button says whether that project is the one in there,
  // and what is in there just changed.
  for (const a of abas) for (const f of folhas(a.raiz)) desenharBarra(f);
}

/// The panel is in the repository the diff shows. It compares the two roots, not the
/// folder against the root: a panel inside a submodule is in another
/// repository, even though it is inside this one's folder.
function noRepoDoDiff(b: Barra): boolean {
  return !!repoDoDiff && b.repo === repoDoDiff;
}

/// Talks to the differ page, storing the message if it hasn't loaded yet.
function recado(msg: unknown) {
  if (!presa) return;
  if (presa.pronta) presa.quadro.contentWindow?.postMessage(msg, "*");
  else presa.fila.push(msg);
}

/// Takes the panel's repository to the diff tab and brings it to the front.
async function abrirDiff(folha: Folha) {
  // Forced: this click is what will give it a repository.
  abrirPresa(true);
  const cwd = await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null);
  if (cwd) recado({ termiauRepo: cwd });
}

/// ⌘, — the preferences float over whatever tab is on screen. They are the differ's page
/// on its own (`differ.html?prefs`), in an iframe over the whole window: their CSS is
/// the differ's, and loose in this document it would reach the terminal (see `criarPresa`).
/// The page says when it is drawn (`termiauPrefsPronta`) and closes itself by message
/// (`termiauPrefsFechou`).
let prefsQuadro: HTMLIFrameElement | undefined;

function abrirPreferencias() {
  if (prefsQuadro) return prefsQuadro.contentWindow?.focus();
  const q = document.createElement("iframe");
  q.className = "prefs-quadro";
  q.src = "/differ.html?prefs";
  document.body.append(q);
  prefsQuadro = q;
}

function fecharPreferencias() {
  prefsQuadro?.remove();
  prefsQuadro = undefined;
  // The keyboard goes back where it was — a panel, or the diff tab.
  if (noDiff) presa?.quadro.contentWindow?.focus();
  else if (ativa?.foco) focar(ativa.foco);
}

function abrirPresa(forcar = false) {
  if (!presa || noDiff) return;
  // Dimmed: clicking the chip, ⌘` and the tab cycle pass through here and stop.
  if (!presa.repoAberto && !forcar) return;
  if (ativa) {
    ativa.corpo.hidden = true;
    ativa.chip.classList.remove("ativa");
    // xterm only switches the cursor to the inactive style when focus is taken away; without
    // this the little paw would keep blinking behind the diff.
    ativa.foco.term.blur();
  }
  noDiff = true;
  // The tab only keeps up with the working tree while it is in view:
  // checking the disk every second behind a terminal would be wasted
  // work. This is where we know whether it is in view.
  recado({ termiauVisivel: true });
  presa.corpo.hidden = false;
  presa.chip.classList.add("ativa");
  presa.quadro.focus();
  presa.quadro.contentWindow?.focus();
  janela.setTitle(T.tituloDiff).catch(() => {});
}

/// Takes the pinned tab off screen. The caller is whoever will put a terminal in its place.
function esconderPresa() {
  if (!presa || !noDiff) return;
  noDiff = false;
  recado({ termiauVisivel: false });
  presa.corpo.hidden = true;
  presa.chip.classList.remove("ativa");
}

// ---------- splitting ----------

function criarDivisor(d: Divisao): HTMLDivElement {
  const divisor = document.createElement("div");
  divisor.className = `divisor ${d.eixo}`;

  divisor.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // otherwise the drag becomes text selection in the terminals
    divisor.setPointerCapture(e.pointerId);

    const mover = (ev: PointerEvent) => {
      const r = d.el.getBoundingClientRect();
      const bruta =
        d.eixo === "lado" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      // A panel squeezed to zero has no grid to measure and xterm complains.
      d.fracao = Math.min(0.9, Math.max(0.1, bruta));
      aplicarFracao(d);

      const aba = abaDe(d);
      if (!aba) return;
      medir(aba); // o desenho acompanha o arrasto, quadro a quadro
      agendarSync(aba);
    };
    const soltar = () => {
      divisor.removeEventListener("pointermove", mover);
      divisor.removeEventListener("pointerup", soltar);
      agendarSalvar();
    };
    divisor.addEventListener("pointermove", mover);
    divisor.addEventListener("pointerup", soltar);
  });

  return divisor;
}

async function dividir(eixo: Eixo) {
  if (ocupado || noDiff || !ativa) return;
  ocupado = true;
  const aba = ativa;
  // Splitting changes the layout, and it must be in view for that.
  terminarAnimacao();
  if (aba.maximizada) recolher(aba, false);
  const alvo = aba.foco;
  try {
    const cwd = await invoke<string | null>("pty_cwd", { id: alvo.id });
    const nova = await dividirFolha(aba, alvo, eixo, cwd);
    if (nova) focar(nova);
  } finally {
    ocupado = false;
  }
}

/// Cuts `alvo` in two and returns the new panel, which takes the second place.
/// Doesn't touch focus or `ocupado`: that is the caller's job — ⌘D, or a tab
/// coming back that rebuilds the layout split by split (see `montar`). The tab must
/// be on screen: the new panel is measured in place.
async function dividirFolha(
  aba: Aba,
  alvo: Folha,
  eixo: Eixo,
  cwd: string | null,
  fracao = 0.5,
): Promise<Folha | undefined> {
  // Removing from the document an element containing the focused textarea steals focus
  // without firing `blur`. xterm would keep thinking it has the keyboard: the
  // `.xterm-focus` mark up and a cursor blinking in a panel that no longer gets keys.
  // While focus is still real, we tell it.
  alvo.term.blur();

  // The panel's place in the page is reserved before touching it: building the
  // split moves `alvo.el` into it and the original position would be lost.
  const marca = document.createComment("divisao");
  alvo.el.replaceWith(marca);

  const d: Divisao = {
    tipo: "divisao",
    eixo,
    fracao,
    filhos: [alvo, alvo], // the second is replaced as soon as the shell opens
    el: document.createElement("div"),
    pai: alvo.pai,
  };
  d.el.className = "divisao";
  aplicarFracao(d);
  d.el.append(alvo.el, criarDivisor(d));
  marca.replaceWith(d.el);

  const nova = await criarFolha(cwd, (el) => d.el.appendChild(el));
  if (!nova) {
    // Undo the split and put the panel back — with the keyboard back on it.
    d.el.replaceWith(alvo.el);
    alvo.term.focus();
    return;
  }

  d.filhos = [alvo, nova];
  alvo.pai = d;
  nova.pai = d;
  if (d.pai) trocarFilho(d.pai, alvo, d);
  else aba.raiz = d;
  aba.corpo.classList.add("dividida");
  marcarMaximizada(aba);

  medir(aba);
  sincronizar(aba);
  agendarSalvar();
  return nova;
}

// ---------- fechamento ----------

/// Releases the panel's resources. Doesn't touch the tree — the caller does that.
function destruirFolha(folha: Folha, jaMorto: boolean) {
  folha.morta = true;
  // The drawer lives inside the panel: it goes along, and so does the app running in it.
  if (folha.gaveta) destruirFolha(folha.gaveta.folha, false);
  folha.execucao = undefined;
  clearTimeout(folha.esperaMarcas);
  clearInterval(folha.chat?.pulso);
  clearInterval(folha.visor?.pulso);
  largarPergunta(folha);
  for (const off of folha.desligar) off();
  folha.desligar = [];
  if (!jaMorto) invoke("pty_close", { id: folha.id }).catch((e) => jlog(`pty_close: ${e}`));
  folha.term.dispose();
  folha.el.remove();
}

function fecharFolha(folha: Folha, opts: { jaMorto?: boolean } = {}) {
  if (folha.morta) return; // the shell's exit may arrive after we already closed it
  const aba = abaDe(folha);
  if (!aba) return;
  // The drawer has no parent, but it isn't the last panel either: close only it.
  if (folha.dono) return fecharGaveta(folha.dono, opts.jaMorto ?? false);
  // The tab's last panel: no layout is left, so the tab is what closes.
  if (!folha.pai) return fecharAba(aba);

  const pai = folha.pai;
  const irmao = pai.filhos[pai.filhos[0] === folha ? 1 : 0];
  // The animation walks the tree's splits, and the tree is about to change.
  terminarAnimacao();
  // Closed the maximized one: there is nothing left to keep full screen.
  if (aba.maximizada === folha) aba.maximizada = undefined;
  destruirFolha(folha, opts.jaMorto ?? false);

  // The sibling moves up and alone takes the space that was both's. It leaves the DOM along with
  // the parent, so the place is marked before tearing out the split.
  const marca = document.createComment("promocao");
  pai.el.replaceWith(marca);
  marca.replaceWith(irmao.el);

  irmao.pai = pai.pai;
  if (pai.pai) trocarFilho(pai.pai, pai, irmao);
  else aba.raiz = irmao;
  aba.corpo.classList.toggle("dividida", aba.raiz.tipo === "divisao");
  // A hidden one that closed on its own (an `exit`, the shell crashed) changed the tree
  // under the maximized one: the path to it is different now.
  marcarMaximizada(aba);

  medir(aba);
  sincronizar(aba);
  pintar();
  // Focus was on the panel that died: it falls to the neighbor that took its place.
  if (aba.foco === folha) focar(folhas(irmao).next().value as Folha);
  // It survived, but the promotion moved its element in the DOM and the textarea lost
  // real focus — with no `blur`, xterm didn't even know. Refocus.
  else teclado(aba.foco);
}

function fecharAba(aba: Aba) {
  const i = abas.indexOf(aba);
  if (i < 0) return;

  // Before destroying: this snapshot is what ⌘⇧T brings the tab back from.
  fechadas.push(fotografarAba(aba));
  if (fechadas.length > MAX_FECHADAS) fechadas.shift();

  abas.splice(i, 1);
  for (const f of folhas(aba.raiz)) destruirFolha(f, false);
  aba.corpo.remove();
  aba.chip.remove();

  if (abas.length === 0) {
    // Closing the last tab is quitting, and whoever closed it already said what they wanted: no
    // question. The session is saved empty — the next launch starts clean.
    void sair();
    return;
  }
  sincronizarBarra();
  pintar();
  // Focus goes to the neighbor on the right; if it was the last, to the one on the left.
  if (ativa === aba) ativar(abas[Math.min(i, abas.length - 1)]);
}

// ---------- maximizar ----------

/// Marks in the DOM the path from the root to the maximized panel: it is what CSS uses
/// to hide the rest without removing anything from the tree. Redone on every change to it.
/// With a single panel there is nothing to hide, and the state undoes itself.
function marcarMaximizada(aba: Aba) {
  if (aba.maximizada && (aba.maximizada.morta || aba.raiz.tipo === "folha")) {
    aba.maximizada = undefined;
  }
  for (const el of aba.corpo.querySelectorAll(".caminho")) el.classList.remove("caminho");
  const m = aba.maximizada;
  aba.corpo.classList.toggle("maximizada", !!m);
  if (m) {
    let no: No | undefined = m;
    for (; no; no = no.pai) no.el.classList.add("caminho");
  }
  for (const f of folhas(aba.raiz)) desenharMaximizar(f);
}

/// Shorter than CSS's `--tempo`: that one is for signals lighting up and dimming;
/// this one is the whole layout moving, and it has to feel like a response to the click.
const DURACAO_MAXIMIZAR = 240;
const movimentoReduzido = matchMedia("(prefers-reduced-motion: reduce)");

/// The animation in progress, if any. Finishing means jumping to the last frame: whoever
/// touches the tree (split, close) or toggles again midway doesn't wait.
let animacao: { terminar: () => void } | undefined;

function terminarAnimacao() {
  animacao?.terminar();
}

/// One frame on the way to `m`, from 0 (the usual layout) to 1 (it alone).
/// Each split along the path hands the whole share to `m`'s side and the gap closes.
/// It is the grid that moves, not a `transform`: scaling the terminal would blur the text.
/// xterm's grid doesn't follow — whoever is squeezed gets clipped by the card,
/// and everyone is re-measured only once, at the end.
function quadroMaximizar(m: Folha, t: number) {
  let filho: No = m;
  for (let d = m.pai; d; filho = d, d = d.pai) {
    const alvo = d.filhos[0] === filho ? 1 : 0;
    const f = d.fracao + (alvo - d.fracao) * t;
    const tracks = `${f}fr calc(var(--vao) * ${1 - t}) ${1 - f}fr`;
    d.el.style.gridTemplate = d.eixo === "lado" ? `1fr / ${tracks}` : `${tracks} / 1fr`;
  }
}

function animarMaximizar(m: Folha, de: number, para: number, fim: () => void) {
  terminarAnimacao();
  const inicio = performance.now();
  let raf = 0;
  const esta = {
    terminar() {
      if (animacao !== esta) return;
      animacao = undefined;
      cancelAnimationFrame(raf);
      // The grid goes back to the real fractions; with the panel maximized CSS
      // rules the layout, and they stay stored for when it restores.
      for (let d = m.pai; d; d = d.pai) aplicarFracao(d);
      fim();
    },
  };
  animacao = esta;
  if (movimentoReduzido.matches) return esta.terminar();
  const quadro = (agora: number) => {
    const p = Math.min(1, (agora - inicio) / DURACAO_MAXIMIZAR);
    // Leaves fast and lands slowly, like the rest of the app's animations.
    const e = 1 - Math.pow(1 - p, 3);
    quadroMaximizar(m, de + (para - de) * e);
    if (p < 1) raf = requestAnimationFrame(quadro);
    else esta.terminar();
  };
  raf = requestAnimationFrame(quadro);
}

function maximizar(folha: Folha) {
  const aba = abaDe(folha);
  if (!aba || aba.raiz.tipo === "folha") return;
  terminarAnimacao();
  aba.maximizada = folha;
  for (const f of folhas(aba.raiz)) desenharMaximizar(f);
  focar(folha);
  // The others only vanish at the end: until then they are being squeezed, in view.
  animarMaximizar(folha, 0, 1, () => {
    marcarMaximizada(aba);
    medir(aba);
    sincronizar(aba);
  });
}

/// `animar: false` is for callers about to touch the tree right after (split):
/// the layout must be in place now, not a quarter of a second from now.
function recolher(aba: Aba, animar = true) {
  terminarAnimacao();
  const m = aba.maximizada;
  if (!m) return;
  const voltar = () => {
    // The hidden ones come back with their previous grid; the window may have
    // changed size in the meantime.
    medir(aba);
    sincronizar(aba);
    // The panel leaves full screen without `blur`: refocus the keyboard.
    aba.foco.term.focus();
  };
  aba.maximizada = undefined;
  if (!animar) {
    marcarMaximizada(aba);
    return voltar();
  }
  // The grid is set to the last frame BEFORE CSS releases the other panels:
  // removing the classes with the usual fractions on the grid would flash the whole layout.
  quadroMaximizar(m, 1);
  marcarMaximizada(aba);
  animarMaximizar(m, 1, 0, voltar);
}

function alternarMaximizar(folha: Folha) {
  const aba = abaDe(folha);
  if (!aba) return;
  if (aba.maximizada) recolher(aba);
  else maximizar(folha);
}

// ---------- navigating between panels ----------

/// Nearest panel in the requested direction. On-screen geometry counts, not the
/// tree's shape: it is what makes ⌥→ go to the panel visibly to the right,
/// even if it is in another branch.
function vizinho(folha: Folha, dir: "Left" | "Right" | "Up" | "Down"): Folha | undefined {
  const aba = abaDe(folha);
  if (!aba) return;
  const r = folha.el.getBoundingClientRect();
  const horizontal = dir === "Left" || dir === "Right";
  const sinal = dir === "Left" || dir === "Up" ? -1 : 1;

  // The current panel's center on the other axis. Among several panels at the same
  // distance — one above and three below —, it goes to the one most aligned with it,
  // which is the middle one. From there, the side ones are one step each.
  const centro = (q: DOMRect) => (horizontal ? q.top + q.height / 2 : q.left + q.width / 2);
  const meu = centro(r);

  let melhor: Folha | undefined;
  let menor = Infinity;
  let desvio = Infinity;
  for (const f of visiveis(aba)) {
    if (f === folha) continue;
    const q = f.el.getBoundingClientRect();
    // Progress in the requested direction; negative means it is on the wrong side.
    const passo = sinal * (horizontal ? q.left - r.left : q.top - r.top);
    if (passo <= 0) continue;
    // It must overlap on the other axis, otherwise the panel in the opposite corner would win.
    const cruza = horizontal
      ? q.bottom > r.top && q.top < r.bottom
      : q.right > r.left && q.left < r.right;
    if (!cruza) continue;
    const d = Math.abs(centro(q) - meu);
    // The 2px slack absorbs the grid's rounding: panels in the same row
    // may start half a pixel apart.
    if (passo < menor - 2 || (Math.abs(passo - menor) <= 2 && d < desvio)) {
      menor = passo;
      desvio = d;
      melhor = f;
    }
  }
  return melhor;
}

function irParaAba(delta: number) {
  // The pinned tab joins the ring like any other — it is first in the bar,
  // and ⌘⇧[ on the next tab must land on it. Dimmed, it stays out, unless
  // it is the one on screen: a panel's diff button opens it before the
  // repository loads, and the cycle must be able to leave from there.
  const dentro = presa && (presa.repoAberto || noDiff);
  const anel: (Aba | Presa)[] = dentro ? [presa as Presa, ...abas] : [...abas];
  const i = noDiff ? 0 : ativa ? anel.indexOf(ativa) : -1;
  if (i < 0 || anel.length < 2) return;
  // Circular: from the last to the first, like in iTerm2.
  const alvo = anel[(i + delta + anel.length) % anel.length];
  if (alvo === presa) abrirPresa();
  else ativar(alvo as Aba);
}

// ---------- Claude sessions ----------

/// What arrives from the hooks. `painel` is set by termiau-evento.sh from the
/// shell's environment; the rest comes from Claude Code as is.
type EventoClaude = {
  painel: number;
  hook_event_name: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  /// On `UserPromptSubmit`: what you wrote.
  prompt?: string;
  /// On `Notification`: what Claude wants from you.
  message?: string;
  /// On `Notification`, in the versions that send it: `permission_prompt`,
  /// `idle_prompt`, `elicitation_dialog`...
  notification_type?: string;
  /// On `PermissionRequest`: the tool asking for permission, and with what.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /// On tool events (except `PermissionRequest`): which call.
  tool_use_id?: string;
};

/// What Claude Code's status line sends, through the hook (`termiau-evento.sh
/// status`). Only the fields the app uses.
type StatusDoSocket = {
  painel: number;
  status: {
    context_window?: { used_percentage?: number | null } | null;
    rate_limits?: LimitesDaStatusLine | null;
    model?: { display_name?: string | null } | null;
    effort?: { level?: string | null } | null;
  };
};

/// Context, model and effort go to the session panel's bar; usage,
/// to the footer.
function receberStatus(bruto: StatusDoSocket) {
  const st = bruto.status ?? {};
  const u = usoDaStatusLine(st.rate_limits);
  if (u) receberUso(u);
  const folha = folhaPorPainel(bruto.painel);
  const c = folha?.claude;
  if (!folha || !c) return;
  const usado = st.context_window?.used_percentage;
  const contexto = typeof usado === "number" ? usado : c.contexto;
  const modelo = st.model?.display_name ?? c.modelo;
  // The level really goes away when the new model has no effort.
  const esforco = st.model ? (st.effort?.level ?? undefined) : c.esforco;
  const mudou = c.contexto !== contexto || c.modelo !== modelo || c.esforco !== esforco;
  Object.assign(c, { contexto, modelo, esforco });
  if (mudou) desenharBarra(folha);
  autoCompactar(folha);
}

/// `/compact` on its own, when the context reaches the limit in Preferences.
/// Only with Claude idle: while working, the command would go into the queue; while waiting,
/// it would answer its question. `Stop` calls it again, in case the limit
/// was crossed mid-turn.
function autoCompactar(folha: Folha) {
  const c = folha.claude;
  const limite = limiteDoAutoCompact(limitesDoContexto);
  if (!c || c.contexto === undefined || limite === null) return;
  if (c.contexto < limite) {
    c.compactou = false;
    return;
  }
  if (c.compactou || c.estado !== "ocioso") return;
  c.compactou = true;
  avisar(folha, T.compactandoSozinho(Math.round(c.contexto)));
  compactar(folha);
}

function folhaPorPainel(id: number): Folha | undefined {
  for (const a of abas) for (const f of folhas(a.raiz)) if (f.id === id) return f;
  return undefined;
}

/// Redraws the status signals: a dot on each tab, an outline on the waiting
/// panel, and the Dock badge with how many are waiting — which is what shows with the whole
/// app in the background.
function pintar() {
  let esperando = 0;
  for (const aba of abas) {
    let sinal = "";
    for (const f of folhas(aba.raiz)) {
      const estado = f.claude?.estado;
      f.el.classList.toggle("esperando", estado === "esperando");
      desenharAviso(f);
      if (estado === "esperando") {
        esperando++;
        sinal = "esperando";
      } else if (estado === "trabalhando" && sinal !== "esperando") {
        sinal = "trabalhando";
      }
    }
    aba.chip.dataset.claude = sinal;
    // Opening or closing a panel changes how many folders the tab has.
    mostrarRamos(aba);
  }
  janela.setBadgeCount(esperando || undefined).catch(() => {});
  // Everything that changes the tabs, the panels or the Claude sessions goes through here.
  agendarSalvar();
}

function receber(
  bruto:
    | EventoClaude
    | { painel: number; evento: Omit<EventoClaude, "painel">; espera?: boolean; pergunta_id?: string },
) {
  // The hook wraps Claude's payload with the panel number outside. The
  // earlier one put `painel` inside it — and that may be the one still
  // installed.
  const ev: EventoClaude = "evento" in bruto ? { ...bruto.evento, painel: bruto.painel } : bruto;
  // A Claude question whose hook stayed waiting for the chat's answer, with
  // the number Rust gave it.
  const perguntaId = "pergunta_id" in bruto ? bruto.pergunta_id : undefined;
  const folha = folhaPorPainel(ev.painel);
  if (!folha) {
    // The panel closed before the event arrived: the hook waits for no one.
    if (perguntaId) void invoke("pergunta_largar", { id: perguntaId });
    return;
  }

  // The folder name is what shows on the tab.
  const nome = ev.cwd?.split("/").filter(Boolean).pop() || `painel ${ev.painel}`;
  // The session changes without Claude exiting (a `/clear`, a `/resume`): the last
  // event's always wins. The folder is the one from each session's first event — afterwards
  // Claude may have moved, and `--resume` looks for the session where it was born.
  const antes = folha.claude;
  const sessao = ev.session_id ?? antes?.sessao;
  const pasta = (antes?.sessao === sessao && antes?.pasta) || ev.cwd;
  const transcricao = ev.transcript_path ?? (antes?.sessao === sessao ? antes?.transcricao : undefined);
  // The pending question carries across events until it is answered.
  const pergunta = antes?.sessao === sessao ? antes?.pergunta : undefined;
  // The context too: it only arrives through the status line, and a hook event that
  // forgot it would clear the pill until Claude ran again.
  const contexto = antes?.sessao === sessao ? antes?.contexto : undefined;
  const compactou = antes?.sessao === sessao ? antes?.compactou : undefined;
  // Model and effort carry across a `/clear`: they belong to the running Claude.
  const { modelo, esforco } = antes ?? {};
  folha.claude = { nome, estado: antes?.estado ?? "ocioso", sessao, pasta, transcricao, pergunta, contexto, modelo, esforco, compactou };

  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
      folha.claude.estado = "trabalhando";
      if (ev.prompt) lembrarPrompts(folha, [ev.prompt]);
      // A new prompt: the question that was open was left behind.
      largarPergunta(folha);
      break;
    case "Stop":
      // The turn ended. A wait that arrived earlier (a question, a
      // permission) still stands.
      if (folha.claude.estado === "trabalhando") folha.claude.estado = "ocioso";
      autoCompactar(folha);
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      // The question was answered — in the chat, or in the terminal before it. The hook
      // still waiting exits quietly, and the card goes away. A session only has one
      // open question at a time, so the tool name is enough.
      if (pergunta && ev.tool_name === "AskUserQuestion") {
        largarPergunta(folha);
        if (folha.claude.estado === "esperando") folha.claude.estado = "trabalhando";
        folha.claude.pede = undefined;
        folha.claude.aviso = undefined;
      }
      break;
    case "PermissionRequest": {
      folha.claude.estado = "esperando";
      // A new question in place of another: the previous one won't come back.
      if (perguntaId) largarPergunta(folha);
      const questoes = ev.tool_name === "AskUserQuestion" ? questoesDe(ev.tool_input) : undefined;
      if (perguntaId && questoes) {
        folha.claude.pergunta = { id: perguntaId, questoes };
        folha.claude.pede = "terminal";
        folha.claude.aviso = T.temUmaPergunta;
        break;
      }
      const tool = ev.tool_name ?? T.umaFerramenta;
      const oque = resumoDe(ev.tool_input);
      folha.claude.aviso = T.pedePermissao(tool, oque);
      folha.claude.pede = ev.tool_name && PEDEM_TERMINAL.has(ev.tool_name) ? "terminal" : "permissao";
      break;
    }
    case "Notification":
      folha.claude.estado = "esperando";
      // The permission notification arrives right after `PermissionRequest`, and
      // says less than it: the request and text already there stay.
      if (ev.notification_type === "permission_prompt" || /permission/i.test(ev.message ?? "")) {
        folha.claude.pede = antes?.pede ?? "permissao";
        folha.claude.aviso = (antes?.pede && antes.aviso) || ev.message;
      } else {
        folha.claude.pede = ev.notification_type === "elicitation_dialog" ? "terminal" : undefined;
        folha.claude.aviso = ev.message;
      }
      break;
    case "SessionEnd":
      largarPergunta(folha);
      folha.claude = undefined;
      break;
  }
  pintar();
  // The chat button only exists where there is a conversation to show.
  desenharBarra(folha);
  // The session may have changed under an open chat (`/clear`, `/resume`),
  // and a new prompt is already in the transcript: read now, without waiting for the pulse.
  if (folha.chat?.aberto) void lerChat(folha);
}

/// Gives up on the panel's pending question: its hook exits without an answer, and if
/// it is still open, the terminal is the one that answers.
function largarPergunta(folha: Folha) {
  const id = folha.claude?.pergunta?.id;
  if (!id) return;
  folha.claude!.pergunta = undefined;
  invoke("pergunta_largar", { id }).catch((e) => jlog(`pergunta_largar: ${e}`));
}

/// Jumps to the next panel that is waiting, in any tab. Repeating the
/// shortcut goes through all of them, and doesn't get stuck on the first.
function irParaEsperando() {
  const fila: { aba: Aba; folha: Folha }[] = [];
  for (const aba of abas) {
    for (const f of folhas(aba.raiz)) {
      if (f.claude?.estado === "esperando") fila.push({ aba, folha: f });
    }
  }
  if (!fila.length) return;

  const atual = fila.findIndex((x) => x.folha === ativa?.foco);
  const alvo = fila[(atual + 1) % fila.length];
  if (alvo.aba !== ativa) ativar(alvo.aba);
  focar(alvo.folha);
}

// ---------- your prompts, highlighted in the terminal ----------

/// How many prompts the panel remembers. The oldest have already left the scrollback.
const MAX_PROMPTS = 300;
/// How often the highlight is redone while the screen changes. It is a frequency
/// cap, not a wait for silence: Claude working writes nonstop
/// (the counter, the animation), and waiting for it to go quiet would mean never highlighting.
const MARCAS_MS = 400;
/// How many lines before the start of the screen are still reread: a prompt may
/// have started there and continue inside it.
const MARCA_FOLGA = 16;

function lembrarPrompts(folha: Folha, novos: string[]) {
  const lista = (folha.prompts ??= []);
  for (const p of novos) if (p.trim() && !lista.includes(p)) lista.push(p);
  if (lista.length > MAX_PROMPTS) lista.splice(0, lista.length - MAX_PROMPTS);
  agendarMarcas(folha);
}

function agendarMarcas(folha: Folha) {
  if (!folha.prompts?.length || folha.esperaMarcas !== undefined) return;
  folha.esperaMarcas = setTimeout(() => {
    folha.esperaMarcas = undefined;
    marcar(folha);
  }, MARCAS_MS);
}

/// Puts a highlight on each screen line that is one of your prompts. Searches again
/// each time instead of marking at send time: Claude Code rewrites the
/// whole conversation on a resize, and a mark placed earlier would go away
/// with the old lines.
function marcar(folha: Folha) {
  if (folha.morta || !folha.prompts?.length) return;
  const { term } = folha;
  const buf = term.buffer.active;
  // On the alternate screen (Claude's full-screen mode) xterm draws no
  // decorations at all; there the highlight is up to chat mode.
  if (buf.type !== "normal") return;

  // The scrollback has thousands of lines, and Claude working rewrites the screen
  // several times per second. But what has already gone into scrollback is immutable:
  // as long as it only grows, rereading from where the screen started last time is enough.
  // Shrank (a clear, a resize redraw), changed width or a new prompt
  // arrived: then reread everything.
  const v = folha.vistas;
  const inteira = !v || buf.baseY < v.base || v.cols !== term.cols || v.prompts !== folha.prompts.length;
  const de = inteira ? 0 : Math.max(0, v.base - MARCA_FOLGA);
  folha.vistas = { base: buf.baseY, cols: term.cols, prompts: folha.prompts.length };

  const tela: string[] = [];
  for (let i = de; i < buf.length; i++) tela.push(buf.getLine(i)?.translateToString(true) ?? "");
  const querem = new Map<string, { linha: number; altura: number }>();
  for (const a of linhasDePrompt(tela, folha.prompts)) {
    querem.set(`${a.linha + de}:${a.altura}:${term.cols}`, { linha: a.linha + de, altura: a.altura });
  }

  // The key keeps the line from when the mark was born, and scrolling moves it:
  // the map is rebuilt with the line each mark is on now.
  const antigas = folha.marcas ?? new Map<string, IDecoration>();
  const marcas = (folha.marcas = new Map<string, IDecoration>());
  for (const [chave, d] of antigas) {
    const atual = `${d.marker.line}:${chave.slice(chave.indexOf(":") + 1)}`;
    // Above where the reading started nothing was checked: the mark stays.
    if (!d.isDisposed && d.marker.line < de) marcas.set(atual, d);
    else if (d.isDisposed || !querem.has(atual) || marcas.has(atual)) d.dispose();
    else marcas.set(atual, d);
  }
  for (const [chave, a] of querem) {
    if (marcas.has(chave)) continue;
    const marker = term.registerMarker(a.linha - (buf.baseY + buf.cursorY));
    const d = marker && term.registerDecoration({ marker, x: 0, width: term.cols, height: a.altura });
    if (!d) continue;
    d.onRender((el) => el.classList.add("prompt-marca"));
    marcas.set(chave, d);
  }
}

/// Jumps to your previous or next prompt: in the terminal's scrollback or, in
/// chat mode, between your bubbles.
function irParaMensagem(folha: Folha, delta: number) {
  const chat = folha.chat;
  if (chat?.aberto) {
    const topo = chat.lista.scrollTop;
    const seus = [...chat.lista.querySelectorAll<HTMLElement>(".chat-voce")].map((el) => el.offsetTop - 12);
    const alvo = delta < 0 ? seus.filter((y) => y < topo - 1).pop() : seus.find((y) => y > topo + 1);
    chat.lista.scrollTo({ top: alvo ?? (delta < 0 ? 0 : chat.lista.scrollHeight) });
    return;
  }
  marcar(folha);
  const linhas = [...(folha.marcas?.values() ?? [])].map((d) => d.marker.line).sort((a, b) => a - b);
  const topo = folha.term.buffer.active.viewportY;
  const alvo = delta < 0 ? linhas.filter((l) => l < topo).pop() : linhas.find((l) => l > topo);
  if (alvo !== undefined) folha.term.scrollToLine(alvo);
  else if (delta > 0) folha.term.scrollToBottom();
}

// ---------- chat mode: the conversation in bubbles ----------

/// A panel's Claude conversation, read from the transcript and drawn over
/// the terminal. The terminal stays alive below, with the session running: the chat
/// is another way of seeing the same conversation, and what you write in its field goes
/// to Claude the same way as the keyboard.
type Chat = {
  el: HTMLDivElement;
  lista: HTMLDivElement;
  aviso: HTMLDivElement;
  avisoTexto: HTMLSpanElement;
  /// The Claude question card, and which question is the one drawn:
  /// redrawing on every `pintar` would erase what you already checked.
  pergunta: HTMLDivElement;
  perguntaDe?: string;
  /// The "working…" line between the conversation and the field, and since when.
  pensando: HTMLDivElement;
  pensandoDesde?: number;
  /// Your bubbles already on screen but not yet in the transcript: Claude
  /// only stores the prompt when it receives it, and waiting for it made sending
  /// look stuck. They go away, in order, when the real ones arrive.
  pendentes: { el: HTMLElement; texto: string }[];
  /// The buttons that answer a permission request without leaving the chat.
  permitir: HTMLButtonElement;
  negar: HTMLButtonElement;
  campo: HTMLTextAreaElement;
  /// The `/commands` list, above the field while typing one.
  menu: HTMLDivElement;
  /// The commands from disk (yours, the project's, the plugins') and the ones matching
  /// what is typed, with the selected one.
  comandos: Comando[];
  achados: Comando[];
  escolhido: number;
  /// The sessions to resume, while the `/resume` list is open: then the
  /// menu shows these, and what is typed in the field filters them.
  sessoes?: SessaoSalva[];
  sessoesAchadas: SessaoSalva[];
  /// "Show earlier": the turns left off screen (see `CHAT_JANELA`).
  mais: HTMLButtonElement;
  /// The whole conversation, and from which turn it is drawn.
  falas: Fala[];
  desde: number;
  /// Where the scroll was, to restore it when the browser resets it.
  topo: number;
  noFim: boolean;
  /// Present while the list is being taken to the end (see `reporRolagem`).
  grude?: number;
  /// A notice from the chat itself, in the same strip as "Claude is waiting for you".
  recado?: string;
  aberto: boolean;
  /// The transcript on screen, and up to which byte of it has been read.
  caminho?: string;
  fim: number;
  lendo?: boolean;
  pulso?: ReturnType<typeof setInterval>;
  /// The thumbnails of the images already pasted into Claude's prompt, waiting for Enter.
  anexos: HTMLDivElement;
  /// The fade in or out in progress: toggling midway starts from where it stopped.
  transicao?: Animation;
};

/// How often the open chat checks whether the transcript grew. Claude
/// only writes a turn when it ends, so there is nothing to gain by reading
/// faster — and when closed, the chat reads nothing.
const CHAT_MS = 700;
/// How many turns go on screen at a time. A long session has thousands, and
/// drawing them all makes a huge document the browser redoes entirely on
/// every change of panel width — splitting, maximizing and switching modes
/// got heavy in proportion to the conversation.
const CHAT_JANELA = 80;

/// The strip above the field: Claude stopped to wait for you, or the chat has
/// something to say. With neither, it doesn't exist.
function desenharAviso(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  const pergunta = folha.claude?.pergunta;
  chat.pergunta.hidden = !pergunta;
  if (!pergunta) chat.perguntaDe = undefined;
  else if (chat.perguntaDe !== pergunta.id) desenharPergunta(folha, chat, pergunta);
  // With the card on screen, the strip would only say the same as it.
  const esperando = folha.claude?.estado === "esperando" && !pergunta;
  chat.aviso.hidden = !esperando && !chat.recado;
  chat.avisoTexto.textContent = esperando
    ? (folha.claude?.aviso ?? T.estaEsperando)
    : (chat.recado ?? "");
  chat.avisoTexto.title = chat.avisoTexto.textContent;
  const permissao = esperando && folha.claude?.pede === "permissao";
  chat.permitir.hidden = chat.negar.hidden = !permissao;
  desenharPensando(folha);
}

/// "Working… 12s": Claude received it and hasn't finished the turn yet. It is what
/// the terminal shows with the spinning asterisk; without this, the chat stood still
/// and there was no way to know whether the message had arrived.
function desenharPensando(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  const trabalhando = folha.claude?.estado === "trabalhando";
  chat.pensando.hidden = !trabalhando;
  if (!trabalhando) {
    chat.pensandoDesde = undefined;
    return;
  }
  chat.pensandoDesde ??= Date.now();
  const s = Math.floor((Date.now() - chat.pensandoDesde) / 1000);
  const tempo = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  chat.pensando.textContent = T.trabalhando(tempo);
}

/// The card for a Claude question, in steps: one question at a time, with
/// tabs for all of them on top to go back and forth. In a single-choice question, the
/// click already answers and moves to the next — and, on the last, sends everything —, like
/// in the terminal. Multiple choice, "Other…" and options with a preview need the button.
function desenharPergunta(folha: Folha, chat: Chat, pergunta: { id: string; questoes: Questao[] }) {
  chat.perguntaDe = pergunta.id;
  const { questoes } = pergunta;
  const escolhas: Escolha[] = questoes.map(() => ({ labels: [] }));
  let passo = 0;
  const respondida = (i: number) => textoDaEscolha(escolhas[i]) !== undefined;

  const enviar = () => {
    const resposta = respostaDoHook(questoes, escolhas);
    if (!resposta || folha.claude?.pergunta?.id !== pergunta.id) return;
    folha.claude.pergunta = undefined;
    folha.claude.pede = undefined;
    folha.claude.aviso = undefined;
    folha.claude.estado = "trabalhando";
    invoke("pergunta_responder", { id: pergunta.id, resposta }).catch((e) => {
      // The terminal answered first, or Claude gave up on the question.
      chat.recado = T.jaRespondidaNoTerminal;
      jlog(`pergunta_responder: ${e}`);
      pintar();
    });
    pintar();
    teclado(folha);
  };
  /// Goes to the next unanswered one; with none missing, sends.
  const avancar = () => {
    const falta = questoes.findIndex((_, i) => i > passo && !respondida(i));
    const antes = questoes.findIndex((_, i) => !respondida(i));
    const proxima = falta >= 0 ? falta : antes;
    if (proxima < 0) return enviar();
    passo = proxima;
    desenhar();
  };

  const desenhar = () => {
    const q = questoes[passo];
    const e = escolhas[passo];
    const elementos: HTMLElement[] = [];

    // The tabs: with a single question there is nowhere to go.
    if (questoes.length > 1) {
      const abas = elemento("div", "chat-pergunta-abas");
      for (const [i, outra] of questoes.entries()) {
        const aba = elemento("button", "chat-pergunta-aba");
        aba.textContent = `${respondida(i) ? "✓" : "○"} ${outra.header || T.perguntaN(i + 1)}`;
        aba.setAttribute("aria-current", String(i === passo));
        aba.addEventListener("click", () => {
          passo = i;
          desenhar();
        });
        abas.append(aba);
      }
      elementos.push(abas);
    } else if (q.header) {
      const etiqueta = elemento("span", "chat-pergunta-etiqueta");
      etiqueta.textContent = q.header;
      elementos.push(etiqueta);
    }

    const texto = elemento("div", "chat-pergunta-texto");
    texto.textContent = q.question;
    if (q.multiSelect) {
      const dica = elemento("span", "chat-pergunta-dica");
      dica.textContent = T.marqueQuantasQuiser;
      texto.append(dica);
    }
    const temPrevia = q.options.some((o) => o.preview);
    const direto = !q.multiSelect && !temPrevia;
    const opcoes = elemento("div", "chat-pergunta-opcoes");
    const previa = elemento("pre", "chat-pergunta-previa");
    const escolhida = q.options.find((o) => e.labels.includes(o.label) && o.preview);
    previa.hidden = !escolhida;
    previa.textContent = escolhida?.preview ?? "";
    const outra = elemento("input", "chat-pergunta-outra");
    outra.placeholder = T.escrevaSuaResposta;
    outra.value = e.outra ?? "";
    outra.hidden = e.outra === undefined;

    for (const o of q.options) {
      const b = elemento("button", "chat-opcao");
      b.setAttribute("aria-pressed", String(e.labels.includes(o.label)));
      const rotulo = elemento("span", "chat-opcao-rotulo");
      rotulo.textContent = o.label;
      b.append(rotulo);
      if (o.description) {
        const d = elemento("span", "chat-opcao-descricao");
        d.textContent = o.description;
        b.append(d);
      }
      b.addEventListener("click", () => {
        if (q.multiSelect) {
          e.labels = e.labels.includes(o.label) ? e.labels.filter((l) => l !== o.label) : [...e.labels, o.label];
        } else {
          e.labels = [o.label];
          e.outra = undefined;
        }
        if (direto) return avancar();
        desenhar();
      });
      opcoes.append(b);
    }
    const outraBotao = elemento("button", "chat-opcao");
    outraBotao.textContent = T.outra;
    outraBotao.setAttribute("aria-pressed", String(e.outra !== undefined));
    outraBotao.addEventListener("click", () => {
      // In a single choice, writing your own unchecks the checked one.
      if (!q.multiSelect) e.labels = [];
      e.outra ??= "";
      desenhar();
      chat.pergunta.querySelector<HTMLInputElement>(".chat-pergunta-outra")?.focus();
    });
    opcoes.append(outraBotao);
    outra.addEventListener("input", () => {
      e.outra = outra.value;
      seguir.disabled = !respondida(passo);
    });
    outra.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      if (respondida(passo)) avancar();
    });

    const acoes = elemento("div", "chat-pergunta-acoes");
    const terminal = elemento("button", "chat-pergunta-terminal");
    terminal.textContent = T.verNoTerminal;
    terminal.addEventListener("click", () => alternarChat(folha));
    const voltar = elemento("button", "chat-pergunta-terminal");
    voltar.textContent = T.voltar;
    voltar.addEventListener("click", () => {
      passo--;
      desenhar();
    });
    // On the last unanswered one the button already sends; before it, it moves on.
    const ultima = questoes.every((_, i) => i === passo || respondida(i));
    const seguir = elemento("button", "chat-pergunta-responder");
    seguir.textContent = ultima ? T.responder : T.proxima;
    seguir.disabled = !respondida(passo);
    seguir.addEventListener("click", avancar);
    acoes.append(terminal);
    if (passo > 0) acoes.append(voltar);
    acoes.append(seguir);

    elementos.push(texto, opcoes, outra, previa, acoes);
    chat.pergunta.replaceChildren(...elementos);
  };
  desenhar();
}

/// Answers the permission request in the terminal, through its keyboard: the
/// Enter accepts the top option ("Yes"), esc declines. It is what you would press there.
function responderPermissao(folha: Folha, sim: boolean) {
  const claude = folha.claude;
  if (claude?.estado !== "esperando" || claude.pede !== "permissao") return;
  invoke("pty_write", { id: folha.id, data: sim ? "\r" : "\x1b" }).catch((e) => jlog(`permission: ${e}`));
  // Accepted, Claude keeps working; declined, it stops and waits for you to say
  // what to do instead — and the chat field sends that.
  claude.estado = sim ? "trabalhando" : "ocioso";
  claude.pede = undefined;
  claude.aviso = undefined;
  pintar();
  teclado(folha);
}

/// Puts the chat's scroll back where you left it.
function reporRolagem(chat: Chat) {
  const { lista } = chat;
  if (!chat.noFim) {
    if (lista.scrollTop !== chat.topo) lista.scrollTop = chat.topo;
    return;
  }
  lista.scrollTop = lista.scrollHeight;
  // Once isn't enough to reach the end: off-screen turns have a guessed height
  // (style.css's `content-visibility`), and only get the real one when the
  // scroll reaches them — then the list grows and the end is somewhere else. It insists for
  // a few frames, until the height stops changing.
  if (chat.grude !== undefined) return;
  let quadros = 0;
  let iguais = 0;
  let antes = -1;
  const passo = () => {
    chat.grude = undefined;
    if (!chat.aberto || !chat.noFim) return;
    const altura = lista.scrollHeight;
    lista.scrollTop = altura;
    iguais = altura === antes ? iguais + 1 : 0;
    antes = altura;
    if (++quadros < 30 && iguais < 2) chat.grude = requestAnimationFrame(passo);
  };
  chat.grude = requestAnimationFrame(passo);
}

/// Draws one more batch of older turns, above the ones already on screen,
/// without moving what you are reading.
function mostrarAnteriores(chat: Chat) {
  const ate = chat.desde;
  chat.desde = Math.max(0, ate - CHAT_JANELA);
  const altura = chat.lista.scrollHeight;
  chat.mais.after(...chat.falas.slice(chat.desde, ate).map(desenharFala));
  chat.mais.hidden = chat.desde === 0;
  chat.lista.scrollTop += chat.lista.scrollHeight - altura;
}

/// The thumbnails go away along with the message that took them.
function limparAnexos(chat: Chat) {
  for (const img of chat.anexos.querySelectorAll("img")) URL.revokeObjectURL(img.src);
  chat.anexos.replaceChildren();
  chat.anexos.hidden = true;
}

/// Who gets the panel's keyboard: the chat field, if it is the one on screen.
function teclado(folha: Folha) {
  const v = folha.visor;
  if (folha.explorador?.aberto && !folha.explorador.fixo) folha.explorador.arvore.focus({ preventScroll: true });
  else if (v?.aberto && (arranjoVisor === "sobre" || v.comTeclado)) (v.edicao?.area ?? v.corpo).focus({ preventScroll: true });
  else if (folha.chat?.aberto) folha.chat.campo.focus();
  else folha.term.focus();
}

function criarChat(folha: Folha): Chat {
  const el = elemento("div", "chat");
  const lista = elemento("div", "chat-lista");
  const pergunta = elemento("div", "chat-pergunta");
  pergunta.hidden = true;
  const pensando = elemento("div", "chat-pensando");
  pensando.hidden = true;
  const aviso = elemento("div", "chat-aviso");
  const avisoTexto = elemento("span", "chat-aviso-texto");
  const permitir = elemento("button", "chat-aviso-sim");
  permitir.textContent = T.permitir;
  permitir.addEventListener("click", () => responderPermissao(folha, true));
  const negar = elemento("button", "chat-aviso-nao");
  negar.textContent = T.negar;
  negar.addEventListener("click", () => responderPermissao(folha, false));
  const ver = elemento("button", "chat-aviso-ver");
  ver.textContent = T.verNoTerminal;
  ver.addEventListener("click", () => alternarChat(folha));
  aviso.append(avisoTexto, permitir, negar, ver);
  const mais = elemento("button", "chat-mais");
  mais.textContent = T.mostrarAnteriores;
  mais.hidden = true;
  const campo = elemento("textarea", "chat-campo");
  campo.rows = 1;
  campo.placeholder = T.mensagemParaOClaude;
  const menu = elemento("div", "chat-comandos");
  menu.hidden = true;
  const anexos = elemento("div", "chat-anexos");
  anexos.hidden = true;
  el.append(lista, pensando, pergunta, aviso, menu, anexos, campo);
  // Inside the terminal's element, not beside it: hiding it would remove the measure
  // FitAddon computes the grid from, and Claude would get a SIGWINCH on every
  // mode switch.
  folha.el.querySelector(".folha-tela")?.append(el);

  const crescer = () => {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(campo.scrollHeight, 160)}px`;
  };
  /// Sends the text to Claude. A `/command` goes typed, not pasted: typed
  /// is how Claude Code recognizes it as a command in every case. The
  /// rest goes the paste way, like ⌘V — several lines arrive as
  /// a single block, not as an Enter at each break. Enter goes after, on
  /// its own: together with the paste Claude would take it as one more line of it.
  const enviar = (texto: string) => {
    // `/resume` alone would open the session list in the terminal, where the chat
    // can't see it. The list is built here, and what goes to Claude is
    // `/resume` already with the chosen session.
    if (texto === "/resume") return void abrirSessoes(folha);
    chat.sessoes = undefined;
    limparAnexos(chat);
    campo.value = "";
    crescer();
    desenharComandos(chat);
    const comando = /^\/([\w:.-]+)/.exec(texto);
    // The message goes on screen right away, dimmed until the transcript confirms it. A
    // `/command` doesn't: many don't even become turns, and the bubble would hang there.
    if (!comando) {
      const balao = desenharFala({ quem: "voce", texto });
      balao.classList.add("pendente");
      chat.lista.append(balao);
      chat.pendentes.push({ el: balao, texto });
      chat.noFim = true;
      reporRolagem(chat);
      if (folha.claude) folha.claude.estado = "trabalhando";
    }
    if (comando && !texto.includes("\n")) {
      invoke("pty_write", { id: folha.id, data: texto }).catch((err) => jlog(`chat command: ${err}`));
    } else colar(folha, texto);
    setTimeout(() => {
      invoke("pty_write", { id: folha.id, data: "\r" }).catch((err) => jlog(`chat send: ${err}`));
    }, 80);
    // What the command opens (the model list, the sessions to resume) shows
    // in the terminal, and that is where it is answered. The chat doesn't step aside on its own:
    // it notifies, and the notice's button takes you there.
    const nome = comando?.[1];
    // With an argument the command already says what it wants, and opens no screen.
    const abreTela = texto === `/${nome}` && COMANDOS_DO_CLAUDE.some((c) => c.interativo && c.nome === nome);
    chat.recado = abreTela ? T.abriuTelaNoTerminal(nome ?? "") : undefined;
    pintar();
  };
  const completar = (c: Comando) => {
    campo.value = `/${c.nome} `;
    crescer();
    desenharComandos(chat);
  };

  campo.addEventListener("input", () => {
    crescer();
    // Writing the answer is attending, like the first key in the terminal.
    if (folha.claude?.estado === "esperando" && atendivelNoChat(folha)) {
      folha.claude.estado = "ocioso";
      pintar();
    }
    // Just opened the list: the commands on disk may have changed since the
    // last time (a new skill, another project).
    if (campo.value === "/") void carregarComandos(folha);
    chat.escolhido = 0;
    desenharComandos(chat);
  });
  const retomarSessao = (s: SessaoSalva) => enviar(`/resume ${s.id}`);
  const fecharSessoes = () => {
    chat.sessoes = undefined;
    campo.value = "";
    crescer();
    desenharComandos(chat);
  };
  menu.addEventListener("mousedown", (e) => {
    // The click doesn't take the keyboard away from the field.
    e.preventDefault();
    const item = (e.target as HTMLElement).closest<HTMLElement>(".chat-comando");
    if (!item) return;
    if (chat.sessoes) {
      const s = chat.sessoesAchadas[Number(item.dataset.i)];
      if (s) retomarSessao(s);
      return;
    }
    const c = chat.achados[Number(item.dataset.i)];
    if (c) completar(c);
  });
  campo.addEventListener("keydown", (e) => {
    if (nossoAtalho(e)) return;
    if (chat.sessoes) {
      const n = chat.sessoesAchadas.length;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
        e.preventDefault();
        chat.escolhido = (chat.escolhido + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return desenharComandos(chat);
      }
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        const s = chat.sessoesAchadas[chat.escolhido];
        if (s) retomarSessao(s);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return fecharSessoes();
      }
      return;
    }
    if (!menu.hidden && chat.achados.length) {
      const n = chat.achados.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        chat.escolhido = (chat.escolhido + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return desenharComandos(chat);
      }
      // Tab completes, for those who will write the arguments; Enter sends right away.
      if (e.key === "Tab") {
        e.preventDefault();
        return completar(chat.achados[chat.escolhido]);
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        return enviar(`/${chat.achados[chat.escolhido].nome}`);
      }
      // Esc closes the list; only without it does it interrupt Claude.
      if (e.key === "Escape") {
        e.preventDefault();
        menu.hidden = true;
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // With a permission request open, esc there is the "no": the notice goes along.
      if (folha.claude?.estado === "esperando" && folha.claude.pede === "permissao") {
        return responderPermissao(folha, false);
      }
      invoke("pty_write", { id: folha.id, data: "\x1b" }).catch((err) => jlog(`chat esc: ${err}`));
      // When interrupted, Claude doesn't send `Stop`: "working" goes away here.
      if (folha.claude?.estado === "trabalhando") {
        folha.claude.estado = "ocioso";
        pintar();
      }
      return;
    }
    // Enter in the middle of a composition (accent, IME) confirms the letter, doesn't send.
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    // The marker in the field is only for you to see where the image is: in Claude's
    // prompt it already went in with ⌃V, and sent again it would become text.
    const texto = campo.value.replace(/\[Image #\d+\] ?/g, "").trim();
    if (texto) enviar(texto);
    else if (!chat.anexos.hidden) {
      campo.value = "";
      crescer();
      invoke("pty_write", { id: folha.id, data: "\r" }).catch((err) => jlog(`chat send: ${err}`));
      limparAnexos(chat);
    }
  });
  // Clicking anywhere in the chat is like clicking in the terminal: the keyboard goes
  // to the field, and you can just start typing. Except when the click was for
  // something else — a button, a link, another field — or to select text.
  el.addEventListener("mouseup", (e) => {
    const alvo = e.target as HTMLElement;
    if (alvo.closest("button, a, input, textarea, select, summary")) return;
    if (!(getSelection()?.isCollapsed ?? true)) return;
    campo.focus({ preventScroll: true });
  });
  // A link in the answer opens outside, like the terminal's: inside, it would replace the
  // whole app's page with the link's.
  lista.addEventListener("click", (e) => {
    // ⌘-click on a `path:line` in the answer opens the file in the viewer.
    if (cliqueEmReferencia(folha, e)) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    abrirLink(e, a.href);
  });
  // A pasted image goes to Claude as in the terminal: ⌃V is what makes Claude
  // Code read the clipboard and attach it to the prompt it is building. The
  // field's text goes after, along with Enter.
  campo.addEventListener("paste", (e) => {
    const arquivo = [...(e.clipboardData?.items ?? [])]
      .find((i) => i.kind === "file" && i.type.startsWith("image/"))
      ?.getAsFile();
    if (!arquivo) return;
    e.preventDefault();
    invoke("pty_write", { id: folha.id, data: "\x16" }).catch((err) => jlog(`chat image: ${err}`));
    const img = elemento("img", "chat-anexo");
    img.src = URL.createObjectURL(arquivo);
    img.alt = T.imagemAnexada;
    img.addEventListener("click", () => ampliarImagem(img.src));
    anexos.append(img);
    anexos.hidden = false;
    // The number Claude Code will give it: it counts across the whole session.
    const vistas = chat.falas.flatMap((f) =>
      f.quem === "voce" ? [...f.texto.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1])) : [],
    );
    const n = Math.max(0, ...vistas) + anexos.childElementCount;
    campo.setRangeText(`[Image #${n}] `, campo.selectionStart, campo.selectionEnd, "end");
    crescer();
  });

  const chat: Chat = {
    el,
    lista,
    aviso,
    avisoTexto,
    pergunta,
    pensando,
    pendentes: [],
    permitir,
    negar,
    campo,
    menu,
    comandos: [],
    achados: [],
    escolhido: 0,
    anexos,
    sessoesAchadas: [],
    mais,
    falas: [],
    desde: 0,
    topo: 0,
    noFim: true,
    aberto: false,
    fim: 0,
  };
  mais.addEventListener("click", () => mostrarAnteriores(chat));
  lista.addEventListener(
    "scroll",
    () => {
      // Off screen the list has no height, and what it says about the scroll is zero.
      // And on the way to the end, the positions passed through aren't your choice.
      if (!lista.clientHeight || chat.grude !== undefined) return;
      chat.topo = lista.scrollTop;
      chat.noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 40;
    },
    { passive: true },
  );
  // Scrolled by hand midway: you are in charge.
  lista.addEventListener(
    "wheel",
    () => {
      if (chat.grude === undefined) return;
      cancelAnimationFrame(chat.grude);
      chat.grude = undefined;
    },
    { passive: true },
  );
  return chat;
}

/// The commands and skills on disk, for the `/` list. The folder is the
/// session's: it is from there that Claude Code sees the project's `.claude`.
async function carregarComandos(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  try {
    const doDisco = await invoke<Comando[]>("comandos_listar", { pasta: folha.claude?.pasta ?? null });
    chat.comandos = doDisco;
    desenharComandos(chat);
  } catch (e) {
    jlog(`commands: ${e}`);
  }
}

/// The list shows while the field is just a slash and a name with no space yet;
/// after the space come the arguments, and it gets out of the way.
function desenharComandos(chat: Chat) {
  if (chat.sessoes) return desenharSessoes(chat);
  const digitado = /^\/([\w:.-]*)$/.exec(chat.campo.value);
  chat.achados = digitado ? filtrarComandos([...chat.comandos, ...COMANDOS_DO_CLAUDE], digitado[1]) : [];
  chat.menu.hidden = !chat.achados.length;
  if (chat.menu.hidden) return;
  chat.escolhido = Math.min(chat.escolhido, chat.achados.length - 1);
  chat.menu.replaceChildren(
    ...chat.achados.map((c, i) => {
      const item = elemento("div", "chat-comando");
      item.dataset.i = String(i);
      item.classList.toggle("escolhido", i === chat.escolhido);
      const nome = elemento("span", "chat-comando-nome");
      nome.textContent = `/${c.nome}`;
      const descricao = elemento("span", "chat-comando-descricao");
      descricao.textContent = c.descricao;
      item.append(nome, descricao);
      return item;
    }),
  );
  chat.menu.querySelector(".escolhido")?.scrollIntoView({ block: "nearest" });
}

/// A Claude Code session stored on disk, as `claude_sessions` lists it.
type SessaoSalva = { id: string; title: string; modified: number };

/// "5 min ago", "3 h ago", "2 d ago": enough to find yesterday's conversation.
function haQuanto(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return T.agora;
  if (min < 60) return T.haMin(min);
  if (min < 60 * 24) return T.haHoras(Math.round(min / 60));
  return T.haDias(Math.round(min / (60 * 24)));
}

/// The `/resume` list, inside the chat: the stored sessions of the folder this one
/// was born in, which is where Claude Code looks for them.
async function abrirSessoes(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  chat.campo.value = "";
  chat.campo.style.height = "auto";
  const pasta = folha.claude?.pasta ?? (await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null));
  const todas = pasta ? await invoke<SessaoSalva[]>("claude_sessions", { path: pasta }).catch(() => []) : [];
  // The session we are already in isn't one to resume.
  const outras = todas.filter((s) => s.id !== folha.claude?.sessao);
  if (!outras.length) {
    chat.recado = T.semOutraSessao;
    return desenharAviso(folha);
  }
  chat.recado = undefined;
  desenharAviso(folha);
  chat.sessoes = outras;
  chat.escolhido = 0;
  desenharComandos(chat);
  chat.campo.focus();
}

/// The menu, in place of the commands: the sessions whose title contains what is in the
/// field. With the field empty, all of them.
function desenharSessoes(chat: Chat) {
  const q = chat.campo.value.trim().toLowerCase();
  chat.sessoesAchadas = (chat.sessoes ?? []).filter((s) => s.title.toLowerCase().includes(q));
  chat.escolhido = Math.max(0, Math.min(chat.escolhido, chat.sessoesAchadas.length - 1));
  const cabeca = elemento("div", "chat-comandos-cabeca");
  cabeca.textContent = chat.sessoesAchadas.length
    ? T.retomarSessao
    : T.nenhumaSessaoComTexto;
  chat.menu.hidden = false;
  chat.menu.replaceChildren(
    cabeca,
    ...chat.sessoesAchadas.map((s, i) => {
      const item = elemento("div", "chat-comando chat-sessao");
      item.dataset.i = String(i);
      item.classList.toggle("escolhido", i === chat.escolhido);
      const titulo = elemento("span", "chat-sessao-titulo");
      titulo.textContent = s.title;
      const quando = elemento("span", "chat-sessao-quando");
      quando.textContent = haQuanto(s.modified);
      item.append(titulo, quando);
      return item;
    }),
  );
  chat.menu.querySelector(".escolhido")?.scrollIntoView({ block: "nearest" });
}

function desenharFala(f: Fala): HTMLElement {
  if (f.quem === "ferramenta") {
    const el = elemento("div", "chat-ferramenta");
    const nome = elemento("span", "chat-ferramenta-nome");
    nome.textContent = f.nome;
    const resumo = elemento("span", "chat-ferramenta-resumo");
    resumo.textContent = f.resumo;
    el.append(nome, resumo);
    return el;
  }
  if (f.quem === "diff") {
    const el = elemento("div", "chat-diffs");
    el.append(...f.arquivos.map(desenharDiff));
    return el;
  }
  const el = elemento("div", `chat-fala chat-${f.quem}`);
  // Your text goes as written; only Claude's answer is markdown.
  if (f.quem === "voce") desenharSeu(el, f.texto, f.imagens ?? []);
  else {
    el.innerHTML = markdown(f.texto);
    botoesDeCopiar(el);
  }
  return el;
}

/// A copy button on each code block of rendered markdown — a Claude answer, a .md in
/// the viewer. It copies the block as it is: the command ready to paste. In a frame
/// around the block, not inside it: the block scrolls sideways, and the button would go along.
function botoesDeCopiar(el: HTMLElement) {
  for (const pre of el.querySelectorAll<HTMLPreElement>("pre:not(.mermaid)")) {
    const moldura = elemento("div", "codigo-bloco");
    const b = elemento("button", "copiar-codigo");
    const voltar = () => {
      b.innerHTML = ICONE_COPIAR;
      b.title = T.copiarCodigo;
      b.classList.remove("copiado");
    };
    voltar();
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard
        .writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "")
        .then(() => {
          b.innerHTML = ICONE_COPIADO;
          b.title = T.codigoCopiado;
          b.classList.add("copiado");
          setTimeout(voltar, 1500);
        })
        .catch((err) => jlog(`copy: ${err}`));
    });
    pre.replaceWith(moldura);
    moldura.append(pre, b);
  }
}

/// How many diff lines go on screen. A `Write` of a whole file
/// would have thousands; the rest is in the file.
const DIFF_MAXIMO = 400;

/// Unified or side by side: the same mode as the differ, stored in its
/// preferences. Switching here switches there, and vice versa.
let modoDiff: ViewMode = "unified";

/// The file for each diff on screen, to redraw it when the mode changes.
const arquivoDoDiff = new WeakMap<HTMLElement, ArquivoDiff>();

const ICONE_UNIFICADO = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 6h7M4.5 10h7"/></svg>`;
const ICONE_LADO_A_LADO = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>`;

/// The context pill's limits, from Preferences (⌘,).
let limitesDoContexto: Partial<LimitesDoContexto> = {};

async function ligarLimitesDoContexto() {
  const aplicar = (s: Pick<Settings, "contextoAtencao" | "contextoPerigo" | "autoCompact" | "autoCompactEm">) => {
    limitesDoContexto = {
      atencao: s.contextoAtencao,
      perigo: s.contextoPerigo,
      autoCompact: s.autoCompact,
      autoCompactEm: s.autoCompactEm,
    };
    for (const a of abas)
      for (const f of folhas(a.raiz)) {
        desenharBarra(f);
        autoCompactar(f);
      }
  };
  try {
    aplicar(await loadSettings());
    await onSettings(aplicar);
  } catch (e) {
    jlog(`context limits: ${e}`);
  }
}

async function ligarModoDiff() {
  try {
    trocarModoDiff((await loadSettings()).viewMode);
    await onSettings(({ viewMode }) => trocarModoDiff(viewMode));
  } catch (e) {
    jlog(`diff preferences: ${e}`);
  }
}

/// Redraws the chat's diffs in the new mode. What was open stays open.
function trocarModoDiff(modo: ViewMode) {
  if (modo === modoDiff) return;
  modoDiff = modo;
  for (const el of document.querySelectorAll<HTMLElement>(".chat-diff")) {
    const arquivo = arquivoDoDiff.get(el);
    if (!arquivo) continue;
    const aberto = el.querySelector(".chat-recolhivel-botao") && !el.querySelector(".recolhida");
    const novo = desenharDiff(arquivo);
    if (aberto) novo.querySelector<HTMLButtonElement>(".chat-recolhivel-botao")?.click();
    el.replaceWith(novo);
  }
}

/// What a tool changed in a file, as the terminal shows it: the name, the
/// count, the numbered lines. As a preview like long messages — the
/// first lines, and the rest one click away.
function desenharDiff(arquivo: ArquivoDiff): HTMLElement {
  const { linhas, mais, menos } = linhasDoDiff(arquivo);
  const el = elemento("div", "chat-diff");
  arquivoDoDiff.set(el, arquivo);
  const resumo = elemento("div", "chat-diff-resumo");
  const nome = elemento("span", "chat-diff-arquivo");
  nome.textContent = arquivo.caminho.split("/").pop() ?? arquivo.caminho;
  nome.title = arquivo.caminho;
  const partes = [mais && `+${mais}`, menos && `−${menos}`].filter(Boolean).join(" ");
  const lado = modoDiff === "split";
  // The icon is the one for the mode the click leads to.
  const modo = elemento("button", "chat-diff-modo");
  modo.innerHTML = lado ? ICONE_UNIFICADO : ICONE_LADO_A_LADO;
  modo.title = lado ? T.verUnificado : T.verLadoALado;
  modo.addEventListener("mousedown", (e) => e.preventDefault());
  modo.addEventListener("click", () => {
    const novo: ViewMode = lado ? "unified" : "split";
    trocarModoDiff(novo);
    saveViewMode(novo).catch((e) => jlog(`save diff mode: ${e}`));
  });
  resumo.append(nome, ` ${partes}`, modo);
  // The numbers column is as wide as the largest of them.
  const largura = String(Math.max(0, ...linhas.map((l) => l.numero ?? 0))).length;
  const classe = (l?: LinhaDiff) =>
    !l ? "vazia" : l.tipo === "+" ? "mais" : l.tipo === "-" ? "menos" : l.tipo === "…" ? "pulo" : "";
  const pre = elemento("pre", lado ? "chat-diff-linhas lado-a-lado" : "chat-diff-linhas");
  let total: number;
  if (lado) {
    const pares = ladoALado(linhas);
    total = pares.length;
    const metade = (l?: LinhaDiff) => {
      const c = elemento("div", `chat-diff-linha ${classe(l)}`);
      c.textContent = l ? `${String(l.numero ?? "").padStart(largura)} ${l.texto}` : "";
      return c;
    };
    for (const p of pares.slice(0, DIFF_MAXIMO)) {
      if (p.pulo) {
        const linha = elemento("div", "chat-diff-linha pulo inteira");
        linha.textContent = "⋯";
        pre.append(linha);
      } else pre.append(metade(p.antes), metade(p.depois));
    }
  } else {
    total = linhas.length;
    for (const l of linhas.slice(0, DIFF_MAXIMO)) {
      const linha = elemento("div", `chat-diff-linha ${classe(l)}`);
      linha.textContent =
        l.tipo === "…" ? "⋯" : `${String(l.numero ?? "").padStart(largura)} ${l.tipo} ${l.texto}`;
      pre.append(linha);
    }
  }
  const mostradas = Math.min(total, DIFF_MAXIMO);
  el.append(resumo, emPrevia(pre, mostradas, mostradas > LONGA_LINHAS));
  if (total > DIFF_MAXIMO) {
    const nota = elemento("div", "chat-diff-resumo");
    nota.textContent = T.maisLinhas(total - DIFF_MAXIMO);
    el.append(nota);
  }
  return el;
}

/// From how many lines (or characters, for whoever pastes one huge
/// line) a text starts collapsed. A pasted log took the whole screen and
/// pushed the answer far away.
const LONGA_LINHAS = 10;
const LONGA_CHARS = 900;

/// Your bubble: what you typed, what you pasted (without the `<pasted_content>` tags
/// Claude Code puts around it) and the images, each where the text cites it.
function desenharSeu(el: HTMLElement, texto: string, imagens: string[]) {
  for (const p of partesDoSeu(texto, imagens.length)) {
    if (p.tipo === "imagem") {
      const img = elemento("img", "chat-imagem");
      img.src = imagens[p.indice];
      img.alt = `imagem ${p.indice + 1}`;
      img.addEventListener("click", () => ampliarImagem(img.src));
      el.append(img);
    } else if (p.tipo === "colado") {
      const caixa = elemento("div", "chat-colado");
      const linhas = p.texto.split("\n").length;
      const titulo = elemento("div", "chat-colado-titulo");
      titulo.textContent = T.textoColado(linhas);
      caixa.append(titulo, recolhivel(p.texto));
      el.append(caixa);
    } else el.append(recolhivel(p.texto));
  }
}

/// A text that, when long, starts collapsed to a few lines with a button to
/// open it. Short, it is just the text.
function recolhivel(texto: string): HTMLElement {
  const corpo = elemento("div", "");
  corpo.textContent = texto;
  const linhas = texto.split("\n").length;
  return emPrevia(corpo, linhas, linhas > LONGA_LINHAS || texto.length > LONGA_CHARS);
}

/// The same for any content (an edit's diff): `longo` says whether it
/// starts collapsed with the button, and `linhas` is what the button counts.
function emPrevia(corpo: HTMLElement, linhas: number, longo: boolean): HTMLElement {
  const el = elemento("div", "chat-recolhivel");
  corpo.classList.add("chat-recolhivel-corpo");
  el.append(corpo);
  if (!longo) return el;
  const botao = elemento("button", "chat-recolhivel-botao");
  const rotulo = () => {
    botao.textContent = el.classList.contains("recolhida") ? T.mostrarTudo(linhas) : T.recolher;
  };
  botao.addEventListener("click", () => {
    el.classList.toggle("recolhida");
    rotulo();
    // Collapsed from the middle (the button floats), the start of the text would be up
    // there, off screen: bring it back so you don't lose your place.
    if (el.classList.contains("recolhida")) el.scrollIntoView({ block: "nearest" });
  });
  el.classList.add("recolhida");
  el.append(botao);
  rotulo();
  return el;
}

/// The image at screen size, over everything. Click or esc closes it.
function ampliarImagem(src: string) {
  const fundo = elemento("div", "chat-imagem-ampliada");
  const img = elemento("img", "");
  img.src = src;
  fundo.append(img);
  const fechar = () => {
    fundo.remove();
    removeEventListener("keydown", esc, true);
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    fechar();
  };
  fundo.addEventListener("click", fechar);
  addEventListener("keydown", esc, true);
  document.body.append(fundo);
}

type Trecho = { texto: string; fim: number; do_zero: boolean; cortado: boolean };

/// Reads what the transcript gained and adds it to the end of the conversation.
async function lerChat(folha: Folha) {
  const chat = folha.chat;
  if (!chat || chat.lendo || folha.morta) return;
  // The session ended: the last conversation stays on screen, it just doesn't grow anymore.
  const caminho = folha.claude?.transcricao ?? chat.caminho;
  if (!caminho) return;
  const outra = caminho !== chat.caminho;
  chat.lendo = true;
  try {
    const t = await invoke<Trecho>("transcricao_ler", { caminho, desde: outra ? 0 : chat.fim });
    const falas = lerFalas(t.texto);
    const doZero = outra || t.do_zero;
    if (doZero) {
      chat.lista.replaceChildren(chat.mais);
      chat.pendentes = [];
      if (t.cortado) {
        const nota = elemento("div", "chat-nota");
        nota.textContent = T.comecoNoTerminal;
        chat.lista.prepend(nota);
      }
      chat.falas = [];
      // Of the conversation that already existed, only the end goes on screen.
      chat.desde = Math.max(0, falas.length - CHAT_JANELA);
      chat.mais.hidden = chat.desde === 0;
      chat.noFim = true;
    }
    chat.caminho = caminho;
    chat.fim = t.fim;
    if (!falas.length) return;
    const primeira = Math.max(chat.desde - chat.falas.length, 0);
    chat.falas.push(...falas);
    // Each of your turns that arrives takes the place of its provisional bubble.
    for (const f of falas) {
      if (f.quem !== "voce") continue;
      const n = provisoriosResolvidos(
        chat.pendentes.map((p) => p.texto),
        f.texto,
      );
      for (const p of chat.pendentes.splice(0, n)) p.el.remove();
    }
    chat.lista.append(...falas.slice(primeira).map(desenharFala));
    // Only those already at the end follow it: whoever scrolled up to reread isn't
    // pulled back on every new turn.
    if (chat.aberto) reporRolagem(chat);
    // A resumed conversation brings prompts the hook didn't see go by.
    lembrarPrompts(folha, falas.flatMap((f) => (f.quem === "voce" ? [f.texto] : [])));
  } catch (e) {
    // Claude only creates the file on the first turn: until then, there is nothing to read.
    if (!String(e).includes("No such file")) jlog(`chat: ${e}`);
  } finally {
    chat.lendo = false;
  }
}

/// Switches the panel between the terminal and the conversation in bubbles. It is per panel: with the
/// screen split, one may be in chat and the neighbor in the terminal.
/// ⌘ or ⌃ click opens the link in the browser; a plain click is left for
/// selecting and positioning, like in iTerm.
function abrirLink(e: MouseEvent, url: string) {
  if (!e.metaKey && !e.ctrlKey) return;
  invoke("abrir_link", { url }).catch((err) => jlog(`open link: ${err}`));
}

/// Shorter than maximize's: it is a layer appearing, not the layout moving.
const DURACAO_CHAT = 180;

/// The chat comes in or goes out over the terminal: fades with a slight slide. On the
/// way out it only vanishes at the end, and meanwhile it doesn't hold clicks — the
/// terminal below is already the panel.
function transicionarChat(chat: { el: HTMLElement; aberto: boolean; transicao?: Animation }) {
  const { el, aberto } = chat;
  const meio = chat.transicao?.playState === "running" ? chat.transicao.currentTime : null;
  chat.transicao?.cancel();
  chat.transicao = undefined;
  el.style.pointerEvents = aberto ? "" : "none";
  if (aberto) el.hidden = false;
  if (movimentoReduzido.matches) {
    el.hidden = !aberto;
    return;
  }
  const quadros = [
    { opacity: 0, transform: "translateY(8px)" },
    { opacity: 1, transform: "none" },
  ];
  const t = el.animate(aberto ? quadros : quadros.reverse(), {
    duration: DURACAO_CHAT,
    easing: aberto ? "cubic-bezier(0.2, 0.7, 0.3, 1)" : "ease-in",
  });
  // Turning around midway starts from the mirrored point, without a jump.
  if (typeof meio === "number") t.currentTime = Math.max(0, DURACAO_CHAT - meio);
  chat.transicao = t;
  t.onfinish = () => {
    if (chat.transicao !== t) return;
    chat.transicao = undefined;
    if (!chat.aberto) el.hidden = true;
  };
}

function alternarChat(folha: Folha) {
  if (folha.chat?.aberto) {
    const chat = folha.chat;
    chat.aberto = false;
    transicionarChat(chat);
    chat.recado = undefined;
    chat.sessoes = undefined;
    desenharComandos(chat);
    clearInterval(chat.pulso);
    chat.pulso = undefined;
  } else {
    // With no Claude session in the panel, the button opens one: the chat is the way to
    // start a conversation in that folder, not only to see one that already exists.
    if (!folha.claude) return void abrirClaudeNoChat(folha);
    const chat = (folha.chat ??= criarChat(folha));
    chat.aberto = true;
    transicionarChat(chat);
    void carregarComandos(folha);
    // Escondida, a lista perdeu a rolagem.
    reporRolagem(chat);
    void lerChat(folha);
    chat.pulso = setInterval(() => {
      void lerChat(folha);
      desenharPensando(folha);
    }, CHAT_MS);
  }
  desenharBarra(folha);
  desenharAviso(folha);
  if (abaDe(folha)?.foco === folha) teclado(folha);
}

/// Opens Claude Code in the panel's shell, in the folder it is in, and goes straight
/// into chat mode. The conversation shows up when the `SessionStart` hook says which
/// transcript is its own.
async function abrirClaudeNoChat(folha: Folha) {
  // With another program in front of the shell, `claude` would be typed inside
  // it — in a vim, in a running server.
  if (await invoke<boolean>("pty_ocupado", { id: folha.id }).catch(() => false)) {
    return avisar(folha, T.programaRodando);
  }
  // O clique repetido enquanto a pergunta acima ia e voltava.
  if (folha.morta || folha.claude || folha.chat?.aberto) return;
  await invoke("pty_write", { id: folha.id, data: "claude\r" }).catch((e) => jlog(`open claude: ${e}`));
  // Marked right away: it is what makes the second click close the chat instead of
  // typing `claude` again. The rest arrives with the session's first event.
  folha.claude = { nome: folha.titulo, estado: "ocioso" };
  alternarChat(folha);
}

// ---------- the viewer: a file inside the panel ----------

/// What to show: a file, the line (or range) to mark and, with `ref`, its
/// version at that point in git instead of the one on disk.
type PedidoVer = { caminho: string; linha?: number; ate?: number; ref?: string };

/// What arrives through the socket when someone runs `termiau ver` (see hooks/termiau).
type PedidoDoSocket = {
  painel: number;
  ver: { caminho?: string; linha?: number | null; ate?: number | null; ref?: string | null };
};

/// The file beside the terminal (or the chat), or over it: the terminal
/// stays alive, with Claude running, and the bar button shows and hides the
/// file. How it is arranged in the panel is `arranjoVisor`.
type Visor = {
  el: HTMLDivElement;
  /// The border between the file and the terminal, which can be dragged. Split mode only.
  alca: HTMLDivElement;
  corpo: HTMLDivElement;
  caminho: HTMLSpanElement;
  ref: HTMLSpanElement;
  voltar: HTMLButtonElement;
  avancar: HTMLButtonElement;
  modo: HTMLButtonElement;
  arranjo: HTMLButtonElement;
  /// Reading or editing: the eye and the pencil, side by side, the current one lit.
  modos: HTMLDivElement;
  ler: HTMLButtonElement;
  editar: HTMLButtonElement;
  salvar: HTMLButtonElement;
  fechar: HTMLButtonElement;
  /// Edit mode. Meanwhile nothing redraws the viewer.
  edicao?: Edicao;
  aberto: boolean;
  transicao?: Animation;
  /// In split mode, who has the keyboard: the file or the terminal/chat. It is the
  /// side you clicked last.
  comTeclado: boolean;
  /// Where you left the scroll. It isn't read from `scrollTop` at redraw time:
  /// caught in the middle of a write, the file arrives short (or empty), the scroll
  /// shrinks along, and the next reread would go back to the top.
  rolagem: number;
  /// The scroll events the redraw itself causes aren't you scrolling.
  segurando: number;
  /// The files open in this panel, one tab each, and the one on screen. ‹ and › move
  /// between them too.
  historico: PedidoVer[];
  pos: number;
  /// What each tab not on screen had when it was left — its lines, its scroll, its
  /// edit in progress. The one on screen lives in the fields below.
  estados: Map<PedidoVer, EstadoAba>;
  /// The tab strip, between the header and the body.
  abas: HTMLDivElement;
  /// A .md shown rendered, not as source.
  renderizado: boolean;
  /// The shown file's stamp: changed on disk, the viewer rereads it.
  carimbo?: string;
  linhas?: string[];
  /// A binary image (`ehImagem`), as a data URL. Then there are no `linhas`.
  imagem?: string;
  /// Leaving the edit to a rendered .md: how far down it was, as a fraction — the
  /// rendered page has another height, and pixels wouldn't land on the same place.
  fracao?: number;
  pulso?: ReturnType<typeof setInterval>;
  /// Responses arriving out of order (‹ › pressed quickly) don't draw
  /// over the newest one.
  vez: number;
};

/// A tab that is not on screen, as it was left.
type EstadoAba = {
  linhas?: string[];
  imagem?: string;
  carimbo?: string;
  edicao?: Edicao;
  renderizado: boolean;
  rolagem: number;
};

/// How many tabs the viewer keeps open. Past that, the oldest one without unsaved
/// changes closes.
const VISOR_HISTORICO = 30;
/// How often the open viewer checks whether the file changed on disk.
const VISOR_MS = 1000;

/// How the viewer is arranged in the panel: beside the terminal, above it, or
/// over it, covering it. Applies to all panels, and so does the (viewer's) share.
type Arranjo = "lado" | "abaixo" | "sobre";
const ARRANJOS: Arranjo[] = ["lado", "abaixo", "sobre"];
const ROTULO_ARRANJO: Record<Arranjo, string> = {
  lado: T.arranjoLado,
  abaixo: T.arranjoAbaixo,
  sobre: T.arranjoSobre,
};
const CHAVE_VISOR = "termiau:visor";

let { arranjo: arranjoVisor, fatia: fatiaVisor } = lerPrefVisor();

function lerPrefVisor(): { arranjo: Arranjo; fatia: number } {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE_VISOR) ?? "{}");
    return {
      arranjo: ARRANJOS.includes(salvo.arranjo) ? salvo.arranjo : "lado",
      fatia: typeof salvo.fatia === "number" ? Math.min(0.85, Math.max(0.15, salvo.fatia)) : 0.5,
    };
  } catch {
    return { arranjo: "lado", fatia: 0.5 };
  }
}

function lembrarPrefVisor() {
  try {
    localStorage.setItem(CHAVE_VISOR, JSON.stringify({ arranjo: arranjoVisor, fatia: fatiaVisor }));
  } catch {
    // Just a convenience.
  }
}

function receberVer(bruto: PedidoDoSocket) {
  const folha = folhaPorPainel(bruto.painel);
  const { caminho, linha, ate, ref } = bruto.ver ?? {};
  if (!folha || typeof caminho !== "string" || !caminho.startsWith("/")) return;
  abrirArquivo(folha, {
    caminho,
    linha: typeof linha === "number" && linha > 0 ? linha : undefined,
    ate: typeof ate === "number" && ate > 0 ? ate : undefined,
    ref: typeof ref === "string" && ref ? ref : undefined,
  });
}

/// Shows the file in the panel's viewer, opening it if it was closed. In a
/// drawer terminal, the owner panel shows it.
function abrirArquivo(folha: Folha, pedido: PedidoVer) {
  const dono = folha.dono ?? folha;
  if (dono.morta) return;
  const v = (dono.visor ??= criarVisor(dono));
  // Already open: its tab comes to the front, as it was left. A requested line moves it
  // there — and a .md goes to source, which is where the line exists.
  const i = v.historico.findIndex((p) => p.caminho === pedido.caminho && p.ref === pedido.ref);
  if (i >= 0) {
    const ja = v.historico[i];
    if (pedido.linha) {
      ja.linha = pedido.linha;
      ja.ate = pedido.ate;
    }
    let guardada = true;
    if (i !== v.pos) {
      guardarAba(v);
      guardada = ativarAba(v, i);
    }
    if (pedido.linha && !v.edicao) v.renderizado = false;
    if (!v.aberto) alternarVisor(dono, !!pedido.linha || !guardada);
    else mostrarAba(dono, !!pedido.linha || !guardada);
    return;
  }
  // A new tab, right after the one on screen.
  if (v.historico.length) guardarAba(v);
  v.historico.splice(v.pos + 1, 0, pedido);
  v.pos = Math.min(v.pos + 1, v.historico.length - 1);
  v.linhas = v.imagem = v.carimbo = v.edicao = undefined;
  v.rolagem = 0;
  v.renderizado = temRenderizado(pedido.caminho) && !pedido.linha;
  podarAbas(v);
  if (v.aberto) void carregarVisor(dono, true);
  else alternarVisor(dono, true);
}

/// The tab on screen, kept as it is: lines, scroll, the edit in progress (with its box,
/// out of the page but alive, undo included).
function guardarAba(v: Visor) {
  const p = v.historico[v.pos];
  if (!p) return;
  const ed = v.edicao;
  if (ed) ed.rolagem = [ed.area.scrollLeft, ed.area.scrollTop];
  v.estados.set(p, {
    linhas: v.linhas,
    imagem: v.imagem,
    carimbo: v.carimbo,
    edicao: ed,
    renderizado: v.renderizado,
    rolagem: v.rolagem,
  });
}

/// Puts tab `i` on the viewer's fields, without drawing. False when it had never been
/// shown (there is nothing kept, it has to be read).
function ativarAba(v: Visor, i: number): boolean {
  v.pos = i;
  v.vez++;
  const p = v.historico[i];
  const e = v.estados.get(p);
  v.estados.delete(p);
  v.linhas = e?.linhas;
  v.imagem = e?.imagem;
  v.carimbo = e?.carimbo;
  v.edicao = e?.edicao;
  v.renderizado = e?.renderizado ?? (temRenderizado(p.caminho) && !p.linha);
  v.rolagem = e?.rolagem ?? 0;
  return !!e;
}

/// Draws the tab on screen: an edit in progress goes back as it was; the rest is reread
/// from disk, which may have changed meanwhile.
function mostrarAba(folha: Folha, rolar: boolean) {
  const v = folha.visor;
  const ed = v?.edicao;
  if (!v) return;
  if (!ed) return void carregarVisor(folha, rolar);
  legendaVisor(folha);
  v.corpo.replaceChildren(ed.raiz);
  const [x, y] = ed.rolagem ?? [0, 0];
  ed.area.scrollLeft = x;
  ed.area.scrollTop = y;
  ed.area.dispatchEvent(new Event("scroll"));
  ed.area.focus({ preventScroll: true });
}

function trocarAba(folha: Folha, i: number) {
  const v = folha.visor;
  if (!v || i < 0 || i >= v.historico.length || i === v.pos) return;
  guardarAba(v);
  const guardada = ativarAba(v, i);
  mostrarAba(folha, !guardada);
}

/// Closes a file's tab. With unsaved changes it comes to the front and asks first.
async function fecharArquivo(folha: Folha, i: number) {
  const v = folha.visor;
  if (!v || i < 0 || i >= v.historico.length) return;
  if (i !== v.pos) trocarAba(folha, i);
  if (!(await podeLargarEdicao(folha))) return;
  if (v.edicao) clearTimeout(v.edicao.espera);
  v.edicao = undefined;
  // The last one: the viewer closes, and is born empty the next time.
  if (v.historico.length === 1) {
    if (v.aberto) alternarVisor(folha);
    v.historico = [];
    v.pos = 0;
    v.linhas = v.imagem = v.carimbo = undefined;
    desenharBarra(folha);
    return;
  }
  v.historico.splice(i, 1);
  const guardada = ativarAba(v, Math.min(i, v.historico.length - 1));
  mostrarAba(folha, !guardada);
}

/// Loose, the drawer is a passing thing: a click outside it closes it, like a menu.
/// Pinned it is part of the panel, and stays. The folder button on the bar doesn't count
/// as outside — it closes it by itself, and counting it would reopen it right away.
function vigiarFora(folha: Folha) {
  const ex = folha.explorador;
  if (!ex) return;
  const vigiar = ex.aberto && !ex.fixo;
  if (vigiar && !ex.fora) {
    ex.fora = (e) => {
      const alvo = e.target as Node;
      if (ex.el.contains(alvo) || folha.barra?.explorar.contains(alvo)) return;
      alternarExplorador(folha);
    };
    document.addEventListener("mousedown", ex.fora, true);
  } else if (!vigiar && ex.fora) {
    document.removeEventListener("mousedown", ex.fora, true);
    ex.fora = undefined;
  }
}

/// Past the limit, the oldest tabs without unsaved changes close.
function podarAbas(v: Visor) {
  while (v.historico.length > VISOR_HISTORICO) {
    const j = v.historico.findIndex((p, k) => {
      const ed = v.estados.get(p)?.edicao;
      return k !== v.pos && !(ed && ed.area.value !== ed.salvo);
    });
    if (j < 0) return;
    v.estados.delete(v.historico[j]);
    v.historico.splice(j, 1);
    if (j < v.pos) v.pos--;
  }
}

/// The tabs, the one on screen lit. One with unsaved changes shows a dot in place of ✕
/// (the ✕ comes back under the mouse).
function desenharAbasVisor(v: Visor) {
  v.abas.replaceChildren(
    ...v.historico.map((p, i) => {
      const ed = i === v.pos ? v.edicao : v.estados.get(p)?.edicao;
      const aba = elemento("div", "visor-aba");
      aba.dataset.i = String(i);
      aba.classList.toggle("atual", i === v.pos);
      aba.classList.toggle("suja", !!ed && ed.area.value !== ed.salvo);
      aba.title = p.ref ? `${p.caminho} @ ${p.ref}` : p.caminho;
      const nome = elemento("span", "visor-aba-nome");
      nome.textContent = p.caminho.slice(p.caminho.lastIndexOf("/") + 1);
      aba.append(nome);
      if (p.ref) {
        const ref = elemento("span", "visor-aba-ref");
        ref.textContent = p.ref;
        aba.append(ref);
      }
      const fechar = elemento("span", "visor-aba-fechar");
      fechar.innerHTML = ICONE_FECHAR_ABA;
      fechar.title = T.fecharArquivo;
      aba.append(fechar);
      return aba;
    }),
  );
  v.abas.querySelector(".atual")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- the file explorer ----------

type Entrada = { nome: string; pasta: boolean };

type Explorador = {
  el: HTMLDivElement;
  titulo: HTMLSpanElement;
  arvore: HTMLDivElement;
  aberto: boolean;
  /// The project's folder (the repository's root, or the shell's folder).
  raiz: string;
  /// The folders expanded in the tree, which stay so between openings.
  abertas: Set<string>;
  /// Each folder's listing, read once per opening: reopening shows what changed.
  listas: Map<string, Entrada[]>;
  /// Responses arriving out of order don't draw over the newest tree.
  vez: number;
  /// Pinned: it stops floating and takes the panel's left side, and choosing a file
  /// doesn't close it.
  fixo: boolean;
  alfinete: HTMLButtonElement;
  /// Open and loose, a click anywhere else closes it: the listener for that, while it exists.
  fora?: (e: MouseEvent) => void;
};

/// A drawer from the left, over the terminal, the chat and the viewer — it pushes nothing
/// aside. Choosing a file opens it in the viewer and closes the drawer.
function criarExplorador(folha: Folha): Explorador {
  const el = elemento("div", "explorador");
  const cabeca = elemento("div", "explorador-cabeca");
  const titulo = elemento("span", "explorador-titulo");
  const fechar = elemento("button", "visor-btn visor-btn-icone");
  fechar.innerHTML = ICONE_FECHAR;
  fechar.title = T.fecharExplorador;
  fechar.addEventListener("mousedown", (e) => e.preventDefault());
  fechar.addEventListener("click", () => alternarExplorador(folha));
  const alfinete = elemento("button", "visor-btn visor-btn-icone explorador-alfinete");
  alfinete.innerHTML = ICONE_ALFINETE;
  alfinete.title = T.fixarExplorador;
  alfinete.addEventListener("mousedown", (e) => e.preventDefault());
  alfinete.addEventListener("click", () => fixarExplorador(folha, !ex.fixo));
  cabeca.append(titulo, alfinete, fechar);
  const arvore = elemento("div", "explorador-arvore");
  arvore.tabIndex = 0;
  el.append(cabeca, arvore);
  folha.el.querySelector(".folha-termo")?.append(el);
  const ex: Explorador = {
    el,
    titulo,
    arvore,
    aberto: false,
    raiz: "",
    abertas: new Set(),
    listas: new Map(),
    vez: 0,
    fixo: false,
    alfinete,
  };
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Pinned, esc only gives the keyboard back: the tree stays.
    if (ex.fixo) teclado(folha);
    else alternarExplorador(folha);
  });
  arvore.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".explorador-item");
    const caminho = item?.dataset.caminho;
    if (!item || !caminho) return;
    if (item.dataset.pasta) {
      if (!ex.abertas.delete(caminho)) ex.abertas.add(caminho);
      void desenharExplorador(folha);
      return;
    }
    if (!ex.fixo) alternarExplorador(folha);
    abrirArquivo(folha, { caminho });
    // Pinned, the tree stays on screen: the chosen file is the one that lights up now.
    if (ex.fixo) void desenharExplorador(folha);
  });
  return ex;
}

/// Pinned, the drawer becomes part of the panel: the terminal and the viewer step aside
/// for it (`.explorador-fixo`, padding on the side) instead of being covered.
function fixarExplorador(folha: Folha, fixo: boolean) {
  const ex = folha.explorador;
  if (!ex) return;
  ex.fixo = fixo;
  ex.el.classList.toggle("fixo", fixo);
  ex.alfinete.classList.toggle("ligado", fixo);
  ex.alfinete.title = fixo ? T.soltarExplorador : T.fixarExplorador;
  encaixarExplorador(folha);
}

function encaixarExplorador(folha: Folha) {
  vigiarFora(folha);
  const ex = folha.explorador;
  const termo = folha.el.querySelector(".folha-termo");
  const fixo = !!ex?.fixo && ex.aberto;
  if (!termo || termo.classList.contains("explorador-fixo") === fixo) return;
  termo.classList.toggle("explorador-fixo", fixo);
  // The terminal changed width without the window changing: it is measured again here.
  const aba = abaDe(folha);
  if (aba && aba === ativa && !noDiff) {
    medir(aba);
    agendarSync(aba);
  }
}

function alternarExplorador(folha: Folha) {
  const raiz = folha.barra?.repo ?? folha.barra?.pasta;
  const nova = !folha.explorador;
  const ex = (folha.explorador ??= criarExplorador(folha));
  // Just created, the drawer has never been drawn closed: without a layout first, the
  // browser goes straight to open and there is no slide.
  if (nova) void ex.el.offsetWidth;
  ex.aberto = !ex.aberto && !!raiz;
  ex.el.classList.toggle("aberto", ex.aberto);
  encaixarExplorador(folha);
  if (ex.aberto && raiz) {
    if (ex.raiz !== raiz) {
      ex.raiz = raiz;
      ex.abertas.clear();
    }
    ex.listas.clear();
    ex.titulo.textContent = raiz.slice(raiz.lastIndexOf("/") + 1) || raiz;
    ex.titulo.title = raiz;
    void desenharExplorador(folha);
    ex.arvore.focus({ preventScroll: true });
  } else if (abaDe(folha)?.foco === folha) {
    teclado(folha);
  }
  desenharBarra(folha);
}

/// The little mark before the name, by extension: as in an editor's tree, it is what
/// lets you find the file by eye.
const MARCAS_DO_EXPLORADOR: Record<string, [string, string]> = {
  ts: ["TS", "cyan"],
  tsx: ["TS", "cyan"],
  js: ["JS", "yellow"],
  jsx: ["JS", "yellow"],
  mjs: ["JS", "yellow"],
  json: ["{}", "yellow"],
  html: ["<>", "orange"],
  css: ["#", "purple"],
  md: ["M↓", "cyan"],
  rs: ["RS", "orange"],
  sh: ["$", "green"],
  py: ["PY", "yellow"],
  dart: ["D", "cyan"],
  toml: ["⚙", "comment"],
  yaml: ["⚙", "comment"],
  yml: ["⚙", "comment"],
  png: ["▣", "pink"],
  jpg: ["▣", "pink"],
  jpeg: ["▣", "pink"],
  gif: ["▣", "pink"],
  svg: ["▣", "pink"],
};

async function desenharExplorador(folha: Folha) {
  const ex = folha.explorador;
  if (!ex) return;
  const vez = ++ex.vez;
  const atual = folha.visor?.historico[folha.visor.pos]?.caminho;
  const linhas: HTMLElement[] = [];
  const aviso = (texto: string, nivel: number) => {
    const el = elemento("div", "explorador-aviso");
    el.style.paddingLeft = `${22 + nivel * 12}px`;
    el.textContent = texto;
    linhas.push(el);
  };
  const descer = async (pasta: string, nivel: number) => {
    let itens = ex.listas.get(pasta);
    if (!itens) {
      try {
        itens = await invoke<Entrada[]>("pasta_listar", { caminho: pasta });
      } catch (e) {
        aviso(T.naoDeuParaListar(String(e)), nivel);
        return;
      }
      ex.listas.set(pasta, itens);
    }
    if (!itens.length) aviso(T.pastaVazia, nivel);
    for (const it of itens) {
      const caminho = `${pasta}/${it.nome}`;
      const aberta = it.pasta && ex.abertas.has(caminho);
      const linha = elemento("div", "explorador-item");
      linha.dataset.caminho = caminho;
      if (it.pasta) linha.dataset.pasta = "1";
      linha.style.paddingLeft = `${8 + nivel * 12}px`;
      linha.classList.toggle("aberta", aberta);
      linha.classList.toggle("atual", caminho === atual);
      const marca = elemento("span", "explorador-marca");
      if (it.pasta) marca.textContent = "›";
      else {
        const ext = it.nome.slice(it.nome.lastIndexOf(".") + 1).toLowerCase();
        const [texto, cor] = MARCAS_DO_EXPLORADOR[ext] ?? ["≡", "fg-dim"];
        marca.textContent = texto;
        marca.style.color = `var(--${cor})`;
      }
      const nome = elemento("span", "explorador-nome");
      nome.textContent = it.nome;
      linha.append(marca, nome);
      linhas.push(linha);
      if (aberta) await descer(caminho, nivel + 1);
    }
  };
  await descer(ex.raiz, 0);
  if (vez === ex.vez) ex.arvore.replaceChildren(...linhas);
}

/// Shows or hides the viewer. Hiding and showing again goes back to where you
/// were; `rolar` is for a newly requested file, which opens at the top (or at the line).
function alternarVisor(folha: Folha, rolar = false) {
  const v = folha.visor;
  if (!v?.historico.length) return;
  v.aberto = !v.aberto;
  // When opening split, the keyboard stays where it was: in the chat, in the terminal.
  if (v.aberto) v.comTeclado = false;
  if (arranjoVisor === "sobre") transicionarChat(v);
  else {
    // Split, the terminal changes size along with it: no animation, which would get it
    // measured midway.
    v.transicao?.cancel();
    v.transicao = undefined;
    v.el.style.pointerEvents = "";
    v.el.hidden = !v.aberto;
  }
  arrumarVisor(folha);
  clearInterval(v.pulso);
  v.pulso = undefined;
  if (v.aberto) {
    void carregarVisor(folha, rolar);
    v.pulso = setInterval(() => void conferirVisor(folha), VISOR_MS);
  }
  desenharBarra(folha);
  if (abaDe(folha)?.foco === folha) teclado(folha);
}

/// Puts the viewer in its arrangement's place: shares the terminal's space with it, or
/// leaves it on top. The terminal that changed size is measured again.
function arrumarVisor(folha: Folha) {
  const v = folha.visor;
  const host = v?.el.parentElement;
  if (!v || !host) return;
  const dividido = v.aberto && arranjoVisor !== "sobre";
  const antes = host.className;
  host.classList.toggle("visor-lado", dividido && arranjoVisor === "lado");
  host.classList.toggle("visor-abaixo", dividido && arranjoVisor === "abaixo");
  host.style.setProperty("--visor-fatia", `${(fatiaVisor * 100).toFixed(2)}%`);
  v.arranjo.innerHTML = ICONE_ARRANJO[arranjoVisor];
  v.arranjo.title = T.cliqueParaTrocar(ROTULO_ARRANJO[arranjoVisor]);
  if (host.className === antes) return;
  const aba = abaDe(folha);
  if (aba && aba === ativa && !noDiff) {
    medir(aba);
    agendarSync(aba);
  }
}

/// Dragging the border changes how much of the panel is the file's; double click, half and half.
function ligarAlcaVisor(folha: Folha, v: Visor) {
  const host = () => v.el.parentElement;
  const aplicar = (fatia: number) => {
    fatiaVisor = Math.min(0.85, Math.max(0.15, fatia));
    host()?.style.setProperty("--visor-fatia", `${(fatiaVisor * 100).toFixed(2)}%`);
    const aba = abaDe(folha);
    if (!aba) return;
    medir(aba);
    agendarSync(aba);
  };
  v.alca.addEventListener("pointerdown", (e) => {
    const h = host();
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    v.alca.setPointerCapture(e.pointerId);
    v.alca.classList.add("arrastando");
    const mover = (ev: PointerEvent) => {
      const r = h.getBoundingClientRect();
      aplicar(arranjoVisor === "lado" ? (r.right - ev.clientX) / r.width : (ev.clientY - r.top) / r.height);
    };
    const soltar = () => {
      v.alca.removeEventListener("pointermove", mover);
      v.alca.removeEventListener("pointerup", soltar);
      v.alca.removeEventListener("pointercancel", soltar);
      v.alca.classList.remove("arrastando");
      lembrarPrefVisor();
    };
    v.alca.addEventListener("pointermove", mover);
    v.alca.addEventListener("pointerup", soltar);
    v.alca.addEventListener("pointercancel", soltar);
  });
  v.alca.addEventListener("dblclick", () => {
    aplicar(0.5);
    lembrarPrefVisor();
  });
}

function criarVisor(folha: Folha): Visor {
  const el = elemento("div", "visor");
  el.hidden = true;
  const cabeca = elemento("div", "visor-cabeca");
  const voltar = elemento("button", "visor-btn");
  voltar.textContent = "‹";
  voltar.title = T.arquivoAnterior;
  const avancar = elemento("button", "visor-btn");
  avancar.textContent = "›";
  avancar.title = T.proximoArquivo;
  const caminho = elemento("span", "visor-caminho");
  const ref = elemento("span", "visor-ref");
  const modo = elemento("button", "visor-btn visor-btn-texto");
  const arranjo = elemento("button", "visor-btn visor-btn-icone");
  const ler = elemento("button", "visor-btn visor-btn-icone");
  ler.innerHTML = ICONE_OLHO;
  ler.title = T.lerDica;
  const editar = elemento("button", "visor-btn visor-btn-icone");
  editar.innerHTML = ICONE_LAPIS;
  editar.title = T.editarDica;
  const modos = elemento("div", "visor-modos");
  modos.append(ler, editar);
  const salvar = elemento("button", "visor-btn visor-btn-icone visor-btn-salvar");
  salvar.innerHTML = ICONE_DISQUETE;
  salvar.title = T.salvarDica;
  salvar.hidden = true;
  const editor = elemento("button", "visor-btn visor-btn-texto");
  editor.textContent = T.abrirNoEditor;
  editor.title = T.editorNasPreferencias;
  const fechar = elemento("button", "visor-btn visor-btn-icone");
  fechar.innerHTML = ICONE_FECHAR;
  fechar.title = T.voltarAoTerminal;
  cabeca.append(voltar, avancar, caminho, ref, modo, arranjo, salvar, modos, editor, fechar);
  const abas = elemento("div", "visor-abas");
  const corpo = elemento("div", "visor-corpo");
  corpo.tabIndex = 0;
  el.append(cabeca, abas, corpo);
  const alca = elemento("div", "visor-alca");
  // Inside the terminal's element, beside its screen: split, the viewer
  // takes a share of it; on top, it covers it entirely.
  folha.el.querySelector(".folha-termo")?.append(alca, el);

  const v: Visor = {
    el,
    alca,
    corpo,
    caminho,
    ref,
    voltar,
    avancar,
    modo,
    arranjo,
    modos,
    ler,
    editar,
    salvar,
    fechar,
    aberto: false,
    comTeclado: false,
    rolagem: 0,
    segurando: 0,
    historico: [],
    pos: 0,
    estados: new Map(),
    abas,
    renderizado: false,
    vez: 0,
  };
  ligarAlcaVisor(folha, v);
  corpo.addEventListener("scroll", () => {
    if (!v.segurando) v.rolagem = corpo.scrollTop;
  });
  // The buttons don't take the keyboard from the body: esc keeps closing.
  for (const b of [voltar, avancar, modo, arranjo, ler, editar, salvar, editor, fechar]) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
  }
  arranjo.addEventListener("click", () => {
    arranjoVisor = ARRANJOS[(ARRANJOS.indexOf(arranjoVisor) + 1) % ARRANJOS.length];
    lembrarPrefVisor();
    v.transicao?.cancel();
    v.transicao = undefined;
    arrumarVisor(folha);
    if (abaDe(folha)?.foco === folha) teclado(folha);
  });
  voltar.addEventListener("click", () => trocarAba(folha, v.pos - 1));
  avancar.addEventListener("click", () => trocarAba(folha, v.pos + 1));
  // A click on a tab shows it; on its ✕, or with the middle button, it closes.
  abas.addEventListener("mousedown", (e) => {
    const aba = (e.target as HTMLElement).closest<HTMLElement>(".visor-aba");
    if (!aba || e.button !== 0) return;
    e.preventDefault();
    const i = Number(aba.dataset.i);
    if ((e.target as HTMLElement).closest(".visor-aba-fechar")) void fecharArquivo(folha, i);
    else trocarAba(folha, i);
  });
  abas.addEventListener("auxclick", (e) => {
    const aba = (e.target as HTMLElement).closest<HTMLElement>(".visor-aba");
    if (aba && e.button === 1) void fecharArquivo(folha, Number(aba.dataset.i));
  });
  modo.addEventListener("click", () => {
    v.renderizado = !v.renderizado;
    desenharVisor(folha, true);
  });
  editor.addEventListener("click", () => {
    const p = v.historico[v.pos];
    void (async () => {
      const comando = (await loadSettings().catch(() => undefined))?.editor.trim() || null;
      await invoke("abrir_no_editor", { caminho: p.caminho, linha: p.linha ?? null, comando });
    })().catch((e) => avisar(folha, T.editorErro(String(e))));
  });
  ler.addEventListener("click", () => void sairEdicao(folha));
  editar.addEventListener("click", () => entrarEdicao(folha));
  salvar.addEventListener("click", () => void salvarEdicao(folha));
  fechar.addEventListener("click", () => (v.edicao ? void sairEdicao(folha) : alternarVisor(folha)));
  corpo.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    alternarVisor(folha);
  });
  corpo.addEventListener("click", (e) => {
    if (cliqueEmReferencia(folha, e, pastaDe(v.historico[v.pos].caminho))) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    abrirLink(e, a.href);
  });
  corpo.addEventListener("change", (e) => {
    const caixa = e.target as HTMLInputElement;
    if (!caixa.matches("input.tarefa[data-linha]")) return;
    if (caixa.checked) {
      caixa.classList.add("marcou");
      caixa.addEventListener("animationend", () => caixa.classList.remove("marcou"), { once: true });
    }
    void marcarTarefa(folha, caixa);
  });
  return v;
}

/// A checkbox clicked in a rendered .md: `[ ]` ↔ `[x]` on that line of the file, on
/// disk. The line changes in `v.linhas` before Rust answers, so a second quick click
/// already starts from it.
async function marcarTarefa(folha: Folha, caixa: HTMLInputElement) {
  const v = folha.visor;
  const linhas = v?.linhas;
  const n = Number(caixa.dataset.linha);
  const antes = linhas?.[n];
  if (!v || !linhas || antes === undefined) return;
  const depois = antes.replace(/^(\s*(?:[-*]|\d+[.)])\s+)\[[ xX]\]/, `$1[${caixa.checked ? "x" : " "}]`);
  linhas[n] = depois;
  try {
    v.carimbo = await invoke<string>("arquivo_marcar", { caminho: v.historico[v.pos].caminho, linha: n, antes, depois });
  } catch (e) {
    linhas[n] = antes;
    caixa.checked = !caixa.checked;
    avisar(folha, T.naoDeuParaMarcar(String(e)));
  }
}

const pastaDe = (caminho: string) => caminho.slice(0, caminho.lastIndexOf("/")) || "/";

/// The path as read on the bar: from the panel's folder, or with `~`.
function caminhoCurto(folha: Folha, caminho: string): string {
  const base = folha.barra?.repo ?? folha.barra?.pasta;
  if (base && caminho.startsWith(`${base}/`)) return caminho.slice(base.length + 1);
  const home = caminho.match(/^\/Users\/[^/]+\//)?.[0];
  return home ? `~/${caminho.slice(home.length)}` : caminho;
}

/// The header follows the tab on screen: its path (with the line), its ref, its buttons.
function legendaVisor(folha: Folha) {
  const v = folha.visor;
  const p = v?.historico[v.pos];
  if (!v || !p) return;
  v.caminho.textContent = caminhoCurto(folha, p.caminho) + (p.linha ? `:${p.linha}${p.ate ? `-${p.ate}` : ""}` : "");
  v.caminho.title = p.caminho;
  v.ref.textContent = p.ref ?? "";
  v.ref.hidden = !p.ref;
  botoesVisor(v);
}

async function carregarVisor(folha: Folha, rolar: boolean) {
  const v = folha.visor;
  if (!v || v.edicao) return;
  const p = v.historico[v.pos];
  const vez = ++v.vez;
  legendaVisor(folha);
  try {
    if (ehImagem(p.caminho)) {
      const img = await invoke<{ url: string; carimbo: string }>("arquivo_imagem", { caminho: p.caminho, rf: p.ref ?? null });
      if (vez !== v.vez) return;
      v.linhas = undefined;
      v.imagem = img.url;
      v.carimbo = img.carimbo;
    } else {
      const arq = await invoke<{ linhas: string[]; carimbo: string }>("arquivo_ler", { caminho: p.caminho, rf: p.ref ?? null });
      if (vez !== v.vez) return;
      v.linhas = arq.linhas;
      v.imagem = undefined;
      v.carimbo = arq.carimbo;
    }
  } catch (e) {
    if (vez !== v.vez) return;
    v.linhas = undefined;
    v.imagem = undefined;
    v.carimbo = undefined;
    const erro = elemento("div", "visor-erro");
    erro.textContent = T.naoDeuParaAbrir(String(e));
    v.corpo.replaceChildren(erro);
    v.modo.hidden = true;
    botoesVisor(v);
    return;
  }
  desenharVisor(folha, rolar);
}

/// Claude edited the open file: the viewer follows, without losing the scroll.
async function conferirVisor(folha: Folha) {
  const v = folha.visor;
  if (!v?.aberto || !v.carimbo || v.edicao) return;
  const p = v.historico[v.pos];
  if (p.ref) return;
  const agora = await invoke<string | null>("arquivo_carimbo", { caminho: p.caminho }).catch(() => null);
  if (agora && agora !== v.carimbo && v.historico[v.pos] === p) void carregarVisor(folha, false);
}

function desenharVisor(folha: Folha, rolar: boolean) {
  const v = folha.visor;
  const linhas = v?.linhas;
  if (!v || (!linhas && !v.imagem) || v.edicao) return;
  const p = v.historico[v.pos];
  const md = ehMarkdown(p.caminho);
  v.modo.hidden = !temRenderizado(p.caminho);
  botoesVisor(v);
  v.modo.textContent = v.renderizado ? T.verFonte : T.verRenderizado;
  // The scroll the redraw moves (the content disappears and comes back) isn't yours: only
  // what you do after two frames counts.
  const segurando = ++v.segurando;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (v.segurando === segurando) v.segurando = 0;
    }),
  );
  const topo = rolar ? 0 : v.rolagem;

  if (v.imagem || (linhas && ehSvg(p.caminho) && v.renderizado)) {
    const url = v.imagem ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent((linhas ?? []).join("\n"))}`;
    v.corpo.replaceChildren(imagemDoVisor(url));
    return;
  }
  if (!linhas) return;

  if (md && v.renderizado) {
    const html = elemento("div", "visor-md chat-claude");
    html.innerHTML = markdown(linhas.join("\n"), 0, p.ref ? "ver" : "marcar");
    botoesDeCopiar(html);
    v.corpo.replaceChildren(html);
    void desenharMermaid(v, html);
    if (v.fracao !== undefined) {
      v.corpo.scrollTop = v.fracao * (v.corpo.scrollHeight - v.corpo.clientHeight);
      v.rolagem = v.corpo.scrollTop;
      v.fracao = undefined;
    } else v.corpo.scrollTop = topo;
    if (rolar) v.rolagem = 0;
    return;
  }

  const de = p.linha ?? 0;
  const ate = Math.max(de, p.ate ?? de);
  const codigo = elemento("div", "visor-codigo");
  codigo.style.setProperty("--digitos", String(String(linhas.length).length));
  codigo.innerHTML = linhas
    .map((l, i) => {
      const n = i + 1;
      const marcada = n >= de && n <= ate ? " marcada" : "";
      return `<div class="visor-linha${marcada}"><span class="visor-num">${n}</span><span class="visor-texto">${escapar(l) || " "}</span></div>`;
    })
    .join("");
  v.corpo.replaceChildren(codigo);
  if (rolar && de) {
    const alvo = codigo.children[de - 1] as HTMLElement | undefined;
    // A third below the top: lets you see what comes before the line.
    if (alvo) v.corpo.scrollTop = alvo.offsetTop - v.corpo.clientHeight / 3;
  } else {
    v.corpo.scrollTop = topo;
  }
  if (rolar) v.rolagem = v.corpo.scrollTop;
  void colorirVisor(v, codigo, p.caminho, linhas);
}

/// The edit mode: the file in a text box over its own colored copy. The box's text
/// is transparent — only the caret and the selection show —, and below it a <pre>
/// draws the same lines with the read mode's colors, following the scroll. The numbers
/// go in a margin of their own, outside what is selected.
type Edicao = {
  area: HTMLTextAreaElement;
  cores: HTMLPreElement;
  numeros: HTMLPreElement;
  raiz: HTMLDivElement;
  /// The text as it was last saved: what tells whether there is something to save.
  salvo: string;
  /// The colored HTML of each line, by its text, from the last tokenization: while typing,
  /// the lines that didn't change keep their colors until the next one.
  pintadas: Map<string, string>;
  total: number;
  espera?: ReturnType<typeof setTimeout>;
  /// Where the box was scrolled when its tab was left.
  rolagem?: [number, number];
};

/// The viewer's buttons follow the mode: editing, the source/rendered switch rests, Save
/// shows up (lit only with something to save) and ✕ leaves editing. The tabs too.
function botoesVisor(v: Visor) {
  const ed = v.edicao;
  const p = v.historico[v.pos];
  v.el.classList.toggle("editando", !!ed);
  v.modos.hidden = !!p?.ref || !v.linhas;
  v.ler.classList.toggle("ligado", !ed);
  v.editar.classList.toggle("ligado", !!ed);
  v.salvar.hidden = !ed;
  v.salvar.disabled = !ed || ed.area.value === ed.salvo;
  v.voltar.disabled = v.pos === 0;
  v.avancar.disabled = v.pos === v.historico.length - 1;
  if (ed) v.modo.hidden = true;
  v.fechar.title = ed ? T.sairDaEdicao : T.voltarAoTerminal;
  desenharAbasVisor(v);
}

/// A line's tokens as HTML, with the theme's colors — the same in reading and in editing.
function htmlDosTokens(linha: { content: string; color?: string; fontStyle?: number }[]): string {
  return linha
    .map((t) => {
      const estilo = [t.color ? `color:${t.color}` : "", t.fontStyle === 1 ? "font-style:italic" : ""].filter(Boolean).join(";");
      return estilo ? `<span style="${estilo}">${escapar(t.content)}</span>` : escapar(t.content);
    })
    .join("");
}

/// Edit mode: right in the viewer. Not for a git version, which has nowhere to be saved.
function entrarEdicao(folha: Folha) {
  const v = folha.visor;
  if (!v?.linhas || v.edicao || v.historico[v.pos]?.ref) return;
  const raiz = elemento("div", "visor-editor");
  const margem = elemento("div", "visor-editor-margem");
  const numeros = elemento("pre", "visor-editor-numeros");
  margem.append(numeros);
  const campo = elemento("div", "visor-editor-campo");
  const cores = elemento("pre", "visor-editor-cores");
  const area = elemento("textarea", "visor-edicao");
  area.spellcheck = false;
  area.value = v.linhas.join("\n");
  campo.append(cores, area);
  raiz.append(margem, campo);
  const ed: Edicao = { area, cores, numeros, raiz, salvo: area.value, pintadas: new Map(), total: 0 };
  v.edicao = ed;
  // Tab indents the way the file already does.
  const recuo = v.linhas.some((l) => l.startsWith("\t")) ? "\t" : "  ";
  area.addEventListener("input", () => {
    pintarEdicao(ed);
    botoesVisor(v);
    clearTimeout(ed.espera);
    ed.espera = setTimeout(() => void colorirEdicao(folha, ed), 200);
  });
  area.addEventListener("scroll", () => {
    cores.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
    numeros.style.transform = `translateY(${-area.scrollTop}px)`;
  });
  area.addEventListener("keydown", (e) => {
    const cmd = e.metaKey && !e.altKey && !e.ctrlKey;
    if (cmd && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void salvarEdicao(folha);
    } else if (e.key === "Escape") {
      // Not up to the body, where esc closes the viewer.
      e.preventDefault();
      e.stopPropagation();
      void sairEdicao(folha);
    } else if (e.key === "Tab" && !cmd && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertText", false, recuo);
    } else if (cmd && e.key.toLowerCase() === "z") {
      // The Edit menu has no Undo — it would reach the terminal too —, so ⌘Z is handled here.
      e.preventDefault();
      document.execCommand(e.shiftKey ? "redo" : "undo");
    } else if (cmd && e.key.toLowerCase() === "x") {
      e.preventDefault();
      document.execCommand("cut");
    }
  });
  pintarEdicao(ed);
  // The edit opens where reading was. The source has the same lines, font and padding as
  // the box, so the same scroll; rendered, the same fraction of the way. And the caret
  // goes to the first line on screen: left at the end, where the box puts it, the
  // scroll would jump down there.
  const ler = v.corpo;
  const doCodigo = !v.renderizado;
  const topo = ler.scrollTop;
  const fracao = ler.scrollHeight > ler.clientHeight ? topo / (ler.scrollHeight - ler.clientHeight) : 0;
  ler.replaceChildren(raiz);
  area.scrollTop = doCodigo ? topo : fracao * (area.scrollHeight - area.clientHeight);
  const alturaLinha = parseFloat(getComputedStyle(area).lineHeight) || 18.6;
  const primeira = Math.max(0, Math.floor(area.scrollTop / alturaLinha));
  const linhas = area.value.split("\n");
  const inicio = linhas.slice(0, primeira).reduce((n, l) => n + l.length + 1, 0);
  area.setSelectionRange(inicio, inicio);
  area.focus({ preventScroll: true });
  area.dispatchEvent(new Event("scroll"));
  botoesVisor(v);
  void colorirEdicao(folha, ed);
}

/// Redraws the colored copy and the numbers from the box's text. A changed line goes
/// plain until the next tokenization colors it.
function pintarEdicao(ed: Edicao) {
  const linhas = ed.area.value.split("\n");
  // The trailing space keeps a last empty line: a <pre> drops the final line break.
  ed.cores.innerHTML = `${linhas.map((l) => ed.pintadas.get(l) ?? escapar(l)).join("\n")}\n `;
  if (linhas.length !== ed.total) {
    ed.total = linhas.length;
    ed.numeros.textContent = Array.from({ length: linhas.length }, (_, i) => i + 1).join("\n");
    ed.raiz.style.setProperty("--digitos", String(String(linhas.length).length));
  }
}

async function colorirEdicao(folha: Folha, ed: Edicao) {
  const v = folha.visor;
  if (!v) return;
  const { langFor, tokenizeFresh } = await import("./differ/lib/highlight");
  const lang = langFor(v.historico[v.pos].caminho);
  if (!lang) return;
  const linhas = ed.area.value.split("\n");
  const tokens = await tokenizeFresh(linhas, lang);
  if (!tokens || v.edicao !== ed) return;
  ed.pintadas = new Map(tokens.map((t, i) => [linhas[i], htmlDosTokens(t)]));
  pintarEdicao(ed);
}

async function salvarEdicao(folha: Folha): Promise<boolean> {
  const v = folha.visor;
  const ed = v?.edicao;
  if (!v || !ed) return false;
  const texto = ed.area.value;
  try {
    v.carimbo = await invoke<string>("arquivo_salvar", {
      caminho: v.historico[v.pos].caminho,
      texto,
      desde: v.carimbo ?? "",
    });
  } catch (e) {
    avisar(folha, T.naoDeuParaSalvar(String(e)));
    return false;
  }
  v.linhas = texto.split("\n");
  ed.salvo = texto;
  botoesVisor(v);
  return true;
}

/// Whether the edit on screen can go: nothing unsaved, or the question answered with
/// save (and saved) or discard.
async function podeLargarEdicao(folha: Folha): Promise<boolean> {
  const ed = folha.visor?.edicao;
  if (!ed || ed.area.value === ed.salvo) return true;
  const r = await escolher("visor-sair-edicao", {
    titulo: T.salvarAlteracoesTitulo,
    texto: T.salvarAlteracoesTexto,
    confirmar: T.salvar,
    alternativa: T.descartar,
    cancelar: T.cancelar,
  });
  if (r === "alternativa" || (r === "sim" && (await salvarEdicao(folha)))) return true;
  ed.area.focus();
  return false;
}

/// Back to reading. With unsaved changes it asks first: save, discard or stay.
async function sairEdicao(folha: Folha) {
  const v = folha.visor;
  const ed = v?.edicao;
  if (!v || !ed || !(await podeLargarEdicao(folha))) return;
  clearTimeout(ed.espera);
  // Reading comes back where the edit was (see `entrarEdicao`).
  const a = ed.area;
  if (v.renderizado) v.fracao = a.scrollHeight > a.clientHeight ? a.scrollTop / (a.scrollHeight - a.clientHeight) : 0;
  else v.rolagem = a.scrollTop;
  v.edicao = undefined;
  // What was saved may be older than the disk: rereading also brings the stamp up to date.
  await carregarVisor(folha, false);
  v.corpo.focus({ preventScroll: true });
}

/// An image, fitted to the viewer; a click switches to actual size and back. The
/// checkerboard behind it is what shows a transparent area as transparent.
function imagemDoVisor(url: string): HTMLElement {
  const caixa = elemento("div", "visor-imagem");
  const img = elemento("img", "");
  img.alt = "";
  const tamanho = elemento("div", "visor-imagem-tamanho");
  img.addEventListener("load", () => (tamanho.textContent = `${img.naturalWidth} × ${img.naturalHeight}`));
  img.addEventListener("error", () => (tamanho.textContent = T.imagemIlegivel));
  img.addEventListener("click", () => caixa.classList.toggle("real"));
  img.src = url;
  caixa.append(img, tamanho);
  return caixa;
}

let mermaidPronto: Promise<typeof import("mermaid").default> | null = null;
let mermaidN = 0;

/// The ```mermaid blocks of a rendered .md, as drawings. The import only happens when a
/// file has one: mermaid weighs more than the rest of the viewer. A diagram that
/// doesn't parse stays as code.
async function desenharMermaid(v: Visor, html: HTMLElement) {
  const blocos = [...html.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (!blocos.length) return;
  const vez = v.vez;
  mermaidPronto ??= import("mermaid").then(({ default: m }) => {
    m.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
    return m;
  });
  const mermaid = await mermaidPronto;
  for (const bloco of blocos) {
    try {
      const { svg } = await mermaid.render(`mermaid-${++mermaidN}`, bloco.textContent ?? "");
      if (vez !== v.vez || !bloco.isConnected) return;
      const desenho = elemento("div", "visor-mermaid");
      const area = elemento("div", "visor-mermaid-area");
      area.innerHTML = svg;
      desenho.append(area);
      bloco.replaceWith(desenho);
      const figura = area.querySelector("svg");
      if (figura) zoomDoMermaid(desenho, area, figura);
    } catch (e) {
      jlog(`mermaid: ${e}`);
    }
  }
}

/// Zoom on a diagram: the buttons, a trackpad pinch (WebKit delivers it as
/// `gesturechange`) or ⌘ + scroll, keeping the point under the pointer in place. It
/// starts fitting the width; dragging moves it when it is larger than the box.
function zoomDoMermaid(desenho: HTMLElement, area: HTMLElement, svg: SVGSVGElement) {
  const caixa = svg.viewBox.baseVal;
  const largura = caixa?.width || svg.getBoundingClientRect().width || 1;
  const altura = caixa?.height || svg.getBoundingClientRect().height || 1;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  let escala = 1;
  const pct = elemento("button", "visor-mermaid-pct");
  const aplicar = (nova: number, x = area.clientWidth / 2, y = area.clientHeight / 2) => {
    nova = Math.min(8, Math.max(0.1, nova));
    const px = (area.scrollLeft + x) / escala;
    const py = (area.scrollTop + y) / escala;
    escala = nova;
    svg.style.width = `${largura * escala}px`;
    svg.style.height = `${altura * escala}px`;
    area.scrollLeft = px * escala - x;
    area.scrollTop = py * escala - y;
    pct.textContent = `${Math.round(escala * 100)}%`;
  };
  // 24px: the area's padding, on both sides.
  const ajustada = () => Math.min(1, (area.clientWidth - 24) / largura);
  aplicar(ajustada());

  const menos = elemento("button", "visor-mermaid-botao");
  menos.textContent = "−";
  menos.title = T.zoomMenos;
  menos.addEventListener("click", () => aplicar(escala / 1.25));
  pct.title = T.zoomAjustar;
  pct.addEventListener("click", () => aplicar(ajustada()));
  const mais = elemento("button", "visor-mermaid-botao");
  mais.textContent = "+";
  mais.title = T.zoomMais;
  mais.addEventListener("click", () => aplicar(escala * 1.25));
  const barra = elemento("div", "visor-mermaid-zoom");
  barra.append(menos, pct, mais);
  desenho.append(barra);

  const ponto = (e: { clientX: number; clientY: number }) => {
    const r = area.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  area.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      aplicar(escala * Math.exp(-e.deltaY * 0.01), ...ponto(e));
    },
    { passive: false },
  );
  let antesDoGesto = 1;
  area.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    antesDoGesto = escala;
  });
  area.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    aplicar(antesDoGesto * g.scale, ...ponto(g));
  });

  area.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const esquerda = area.scrollLeft;
    const topo = area.scrollTop;
    area.setPointerCapture(e.pointerId);
    area.classList.add("arrastando");
    const mover = (m: PointerEvent) => {
      area.scrollLeft = esquerda - (m.clientX - x0);
      area.scrollTop = topo - (m.clientY - y0);
    };
    const soltar = () => {
      area.removeEventListener("pointermove", mover);
      area.classList.remove("arrastando");
    };
    area.addEventListener("pointermove", mover);
    area.addEventListener("pointerup", soltar, { once: true });
    area.addEventListener("pointercancel", soltar, { once: true });
  });
}

/// Colors come later, from the same shiki as the differ: the file shows right away, and
/// the import only weighs on the first time the viewer opens.
async function colorirVisor(v: Visor, codigo: HTMLDivElement, caminho: string, linhas: string[]) {
  const vez = v.vez;
  const { langFor, tokenizeFresh } = await import("./differ/lib/highlight");
  const lang = langFor(caminho);
  if (!lang) return;
  const tokens = await tokenizeFresh(linhas, lang);
  if (!tokens || vez !== v.vez || !codigo.isConnected) return;
  const textos = codigo.querySelectorAll<HTMLElement>(".visor-texto");
  tokens.forEach((linha, i) => {
    const alvo = textos[i];
    if (alvo && linha.length) alvo.innerHTML = htmlDosTokens(linha);
  });
}

// ---------- file references: ⌘-click ----------

/// The folder the panel's relative paths start from: the one of the process in
/// front of the shell, which with Claude running is its folder. Kept for a few
/// seconds, because xterm asks on every line the mouse passes over.
const pastas = new WeakMap<Folha, { em: number; pasta: Promise<string | null> }>();
function pastaDoPainel(folha: Folha): Promise<string | null> {
  const guardada = pastas.get(folha);
  if (guardada && Date.now() - guardada.em < 3000) return guardada.pasta;
  const pasta = invoke<string | null>("pty_cwd", { id: folha.id })
    .catch(() => null)
    .then((p) => p ?? folha.claude?.pasta ?? folha.barra?.pasta ?? null);
  pastas.set(folha, { em: Date.now(), pasta });
  return pasta;
}

/// The references that really exist, already with the absolute path.
async function resolver(base: string | null, refs: Referencia[]): Promise<(string | null)[]> {
  if (!base || !refs.length) return refs.map(() => null);
  return invoke<(string | null)[]>("arquivos_existem", { base, candidatos: refs.map((r) => r.arquivo) }).catch(() =>
    refs.map(() => null),
  );
}

/// A `path:line` in the terminal output becomes a link: ⌘-click opens it in the viewer.
/// Only those that exist — the panel's folder says where a relative one starts from.
function ligarLinksDeArquivo(folha: Folha) {
  const term = folha.term;
  term.registerLinkProvider({
    provideLinks(y, devolver) {
      const buf = term.buffer.active;
      const cols = term.cols;
      // A window of lines around it: no path spans more than that.
      const base = Math.max(0, y - 1 - 10);
      const linhas: LinhaDaTela[] = [];
      for (let i = base; i < Math.min(buf.length, y + 10); i++) {
        const l = buf.getLine(i);
        linhas.push({ texto: l?.translateToString(false) ?? "", quebrada: l?.isWrapped ?? false });
      }
      const aqui = y - 1 - base;
      // With and without the continuation guess, upward and downward: joining two
      // lines that weren't one would spoil the whole reference in one of them.
      type Achado = { ref: Referencia; de: { linha: number; col: number }; ate: { linha: number; col: number }; texto: string };
      const achados: Achado[] = [];
      const combinacoes: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];
      for (const [acima, abaixo] of combinacoes) {
        const { texto, pos } = linhaLogica(linhas, aqui, cols, acima, abaixo);
        for (const ref of acharReferencias(texto)) {
          const trecho = pos.slice(ref.inicio, ref.fim);
          if (!trecho.some((p) => p.linha === aqui)) continue;
          const de = trecho[0];
          const ate = trecho[trecho.length - 1];
          if (achados.some((a) => a.de.linha === de.linha && a.de.col === de.col && a.ate.linha === ate.linha && a.ate.col === ate.col)) continue;
          achados.push({ ref, de, ate, texto: texto.slice(ref.inicio, ref.fim) });
        }
      }
      if (!achados.length) return devolver(undefined);
      void (async () => {
        const caminhos = await resolver(await pastaDoPainel(folha), achados.map((a) => a.ref));
        const vivos = achados.flatMap((a, i) => (caminhos[i] ? [{ ...a, caminho: caminhos[i] }] : []));
        const ponto = (p: { linha: number; col: number }) => p.linha * cols + p.col;
        // A piece that exists inside a larger path that also exists
        // (`lib/x.dart` inside `apps/lib/x.dart`): the larger one stays.
        const links = vivos
          .filter((a) => !vivos.some((b) => b !== a && ponto(b.de) <= ponto(a.de) && ponto(b.ate) >= ponto(a.ate) && b.texto.length > a.texto.length))
          .map((a) => ({
            range: { start: { x: a.de.col + 1, y: base + a.de.linha + 1 }, end: { x: a.ate.col + 1, y: base + a.ate.linha + 1 } },
            text: a.texto,
            decorations: { pointerCursor: true, underline: true },
            activate: (e: MouseEvent) => {
              if (!e.metaKey && !e.ctrlKey) return;
              abrirArquivo(folha, { caminho: a.caminho, linha: a.ref.linha, ate: a.ref.ate });
            },
          }));
        devolver(links.length ? links : undefined);
      })();
    },
  });
}

/// ⌘-click on a `<code>` that is just a path (in the chat, in a viewer .md).
/// Returns whether the click was that, so the caller doesn't handle it again.
function cliqueEmReferencia(folha: Folha, e: MouseEvent, base?: string): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  const code = (e.target as HTMLElement).closest("code");
  const ref = code && referenciaInteira(code.textContent ?? "");
  if (!ref) return false;
  e.preventDefault();
  void (async () => {
    const [caminho] = await resolver(base ?? (await pastaDoPainel(folha)), [ref]);
    if (caminho) abrirArquivo(folha, { caminho, linha: ref.linha, ate: ref.ate });
    else avisar(folha.dono ?? folha, T.naoAchei(ref.arquivo));
  })();
  return true;
}

// ---------- auto-send ----------

/// After you stop speaking, the dictation goes on its own.
const ESPERA_ENVIO_MS = 5000;
/// Above this the microphone peak counts as speech: it is what the wave draws and
/// what holds the Enter countdown while you are still speaking.
const LIMIAR_FALA = 0.1;
/// While the last syllable is recent, the strip shows the partial and not the
/// countdown — otherwise the two would fight over the same line every 200 ms.
const PARCIAL_MANDA_MS = 800;

/// The scheduled Enter: the panel that got the dictation and when it goes.
let envio: { folha: Folha; em: number } | undefined;
let pulso: ReturnType<typeof setInterval> | undefined;
let ultimaFala = 0;

function pararPulso() {
  clearInterval(pulso);
  pulso = undefined;
}

/// Who rules the strip: while the last syllable is recent, the partial; from
/// then on, the countdown. Both sides ask the SAME thing — if each one
/// decided on its own, the partial (which arrives even in silence, sometimes empty)
/// and the 200 ms pulse would write over each other and the line would flicker.
function parcialMandaNaFaixa() {
  return !envio || Date.now() - ultimaFala <= PARCIAL_MANDA_MS;
}

/// Closes the strip, or goes back to the partial, depending on whether the microphone is open.
function encerrarContagem() {
  pararPulso();
  if (escutando) mostrarVoz(T.escutando);
  else fecharVoz();
}

function agendarEnvio(folha: Folha) {
  envio = { folha, em: Date.now() + ESPERA_ENVIO_MS };
  if (!pulso) pulso = setInterval(baterEnvio, 200);
}

/// Started speaking again: the Enter waits.
function adiarEnvio() {
  if (envio) envio.em = Date.now() + ESPERA_ENVIO_MS;
}

/// The keyboard has the last word, and cancels for good. Counting again requires speaking
/// again: rescheduling on the microphone's first peak would undo the choice of whoever
/// just decided to type.
function cancelarEnvio() {
  if (!envio) return;
  envio = undefined;
  encerrarContagem();
}

function baterEnvio() {
  if (!envio) return pararPulso();

  // The panel may have closed in the middle of the countdown.
  if (envio.folha.morta) {
    envio = undefined;
    return encerrarContagem();
  }

  const falta = envio.em - Date.now();
  if (falta > 0) {
    if (!parcialMandaNaFaixa()) {
      mostrarVoz(T.enviaEm(Math.ceil(falta / 1000)));
    }
    return;
  }

  const { folha } = envio;
  envio = undefined;
  invoke("pty_write", { id: folha.id, data: "\r" }).catch((e) => jlog(`send: ${e}`));
  encerrarContagem();
}

// ---------- dictation: speaking instead of typing ----------

const voz = document.getElementById("voz") as HTMLDivElement;
const vozOnda = voz.querySelector(".voz-onda") as HTMLSpanElement;
const vozTexto = voz.querySelector(".voz-texto") as HTMLSpanElement;

let escutando = false;
/// Holds off a second ⌘E while the model downloads — it is hundreds of MB.
let preparando = false;

/// An open microphone with nobody speaking is battery and privacy going away, and
/// an Enter waiting for a sentence that won't come anymore. One minute of silence and
/// dictation turns itself off — ⌘E brings it back.
const INATIVIDADE_MS = 60_000;
let vigia: ReturnType<typeof setInterval> | undefined;

/// One instant per little bar: at ~20 levels per second, it is a bit more than a
/// second of history on screen. New ones come in from the right.
const ONDA_BARRAS = 22;
/// Silence doesn't erase the wave: a thin line still says "I'm open".
const ONDA_MINIMA = 0.06;
const onda = new Array<number>(ONDA_BARRAS).fill(0);
const ondaBarras = Array.from({ length: ONDA_BARRAS }, () => {
  const barra = document.createElement("span");
  vozOnda.appendChild(barra);
  return barra;
});

function empurrarOnda(nivel: number) {
  onda.shift();
  onda.push(nivel);
  for (let i = 0; i < ONDA_BARRAS; i++) {
    // The same gain the bar used: normal speech fills the strip without clipping.
    const altura = Math.max(ONDA_MINIMA, Math.min(1, onda[i] * 3.2));
    ondaBarras[i].style.transform = `scaleY(${altura})`;
  }
}

function limparOnda() {
  onda.fill(0);
  for (const barra of ondaBarras) barra.style.transform = `scaleY(${ONDA_MINIMA})`;
}

/// The strip fits one line. Showing the start of a long sentence would hide
/// precisely what you just said, so it cuts from the front.
function mostrarVoz(texto: string) {
  vozTexto.textContent = texto.length > 140 ? `…${texto.slice(-140)}` : texto;
}

/// Silences the strip. Its space stays: what goes away is the content, not the line.
function fecharVoz() {
  // A countdown in progress is the most important thing on screen: an Enter is on
  // its way to a shell, and erasing the notice is worse than it staying one more second.
  if (envio) return;
  vozTexto.textContent = "";
  voz.classList.remove("escutando");
  limparOnda();
}

function pararVigia() {
  clearInterval(vigia);
  vigia = undefined;
}

/// Closes the microphone. It goes out through here and the idle watcher — both turn off
/// through the same door, so neither leaves `escutando` lying.
async function pararEscuta() {
  escutando = false;
  pararVigia();
  voz.classList.remove("escutando");
  limparOnda();
  await invoke("escuta_parar").catch((e) => jlog(`escuta_parar: ${e}`));
}

/// One minute silent and the microphone closes. A countdown in progress delays nothing:
/// it lives 5 s, well within the slack, and the last speech is recent by definition.
async function baterInatividade() {
  if (!escutando) return pararVigia();
  if (Date.now() - ultimaFala < INATIVIDADE_MS) return;
  await pararEscuta();
  // The strip says why it went quiet: unexplained silence looks the same as frozen.
  mostrarVoz(T.escutaDesligada);
  setTimeout(fecharVoz, 5000);
}

async function alternarEscuta() {
  if (preparando) return;
  if (escutando) {
    await pararEscuta();
    fecharVoz();
    return;
  }

  try {
    preparando = true;
    if (!(await invoke<boolean>("escuta_modelo_pronto"))) {
      mostrarVoz(T.baixandoModelo);
      await invoke("escuta_baixar_modelo");
    }
    mostrarVoz(T.escutando);
    await invoke("escuta_comecar");
    escutando = true;
    voz.classList.add("escutando");
    // Reset, `ultimaFala` is 1970: the watcher would kill dictation on the first tick.
    ultimaFala = Date.now();
    if (!vigia) vigia = setInterval(baterInatividade, 1000);
  } catch (e) {
    mostrarVoz(T.naoConseguiEscutar(String(e)));
    setTimeout(fecharVoz, 4000);
  } finally {
    preparando = false;
  }
}

async function ligarEscuta() {
  // Partial: the guess while you speak, re-evaluated every 800 ms.
  await listen<string>("escuta://parcial", (e) => {
    if (parcialMandaNaFaixa()) mostrarVoz(e.payload);
  });

  // Final: the segment closed. It goes to the focused panel NOW, not to the one
  // focused when you started speaking — which is what typing would do.
  await listen<string>("escuta://final", (e) => {
    const texto = e.payload.trim();
    if (!texto || !ativa) return;
    // Space at the end: two consecutive segments would stick into a single word.
    const folha = ativa.foco;
    invoke("pty_write", { id: folha.id, data: `${texto} ` })
      .catch((err) => jlog(`voice pty_write: ${err}`));
    // From here on silence counts as "I'm done": the countdown starts.
    agendarEnvio(folha);
  });

  // The partial stays still while you don't speak; the wave is what shows the
  // microphone is really open.
  await listen<number>("escuta://nivel", (e) => {
    empurrarOnda(e.payload);
    if (e.payload > LIMIAR_FALA) {
      ultimaFala = Date.now();
      adiarEnvio();
    }
  });

  await listen<number>("escuta://progresso", (e) => {
    mostrarVoz(T.baixandoModeloPct(Math.round(e.payload * 100)));
  });

  await listen<string>("escuta://erro", (e) => {
    escutando = false;
    pararVigia();
    voz.classList.remove("escutando");
    limparOnda();
    mostrarVoz(T.erroNaEscuta(String(e.payload)));
    setTimeout(fecharVoz, 4000);
  });

  await listen("menu://escutar", () => alternarEscuta());
}

// ---------- caminhos: arrastar e colar arquivos ----------

/// Several files become several arguments, each protected by `citar`.
/// The space at the end is so the next
/// file (or the rest of the command) doesn't stick to the previous one.
const linhaDe = (caminhos: string[]) => caminhos.map(citar).join(" ") + " ";

/// Hands the text to the panel through xterm's paste path, not through
/// `pty_write` directly: xterm is what wraps it in bracketed paste when the program
/// on the other side asked for it. Without that Claude Code (and vim, and zsh) would get the
/// paste as if each character had been typed.
function colar(folha: Folha, texto: string) {
  if (!texto) return;
  folha.term.paste(texto);
}

/// Which panel is under the pointer. The drag doesn't go through the DOM — Tauri
/// reports it, and the position comes in physical pixels —, so dividing by the screen's
/// scale is up to us. `devicePixelRatio` and not the `scaleFactor` stored at
/// startup: the window may have moved to a monitor with another density in between.
function folhaEm(p: { x: number; y: number }): Folha | undefined {
  if (!ativa) return;
  const alvo = document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio);
  if (!alvo) return;
  for (const f of visiveis(ativa)) if (f.el.contains(alvo)) return f;
}

/// Dragging a file from Finder and dropping it here writes its path on the line,
/// in the panel under the pointer — not the one with the keyboard.
async function ligarArrastar() {
  let marcada: Folha | undefined;
  const marcar = (f?: Folha) => {
    if (marcada === f) return;
    marcada?.el.classList.remove("recebendo");
    marcada = f;
    marcada?.el.classList.add("recebendo");
  };

  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    // With the diff in front there is no panel under the pointer, and the panel with the
    // keyboard is hidden: the path would end up in a terminal nobody sees.
    if (noDiff) return;
    if (payload.type === "leave") return marcar(undefined);
    if (payload.type !== "drop") return marcar(folhaEm(payload.position));

    // Dropping outside a panel (on the tab bar, on the voice strip) still has an
    // obvious destination: the panel with the keyboard.
    const folha = folhaEm(payload.position) ?? ativa?.foco;
    marcar(undefined);
    if (!folha) return;
    // Dropping on a panel also picks it — the path shows up where the cursor
    // is, and that is where the rest of the command will be typed.
    focar(folha);
    colar(folha, linhaDe(payload.paths));
  });
}

/// ⌘⇧V: what is on the clipboard goes in as a path. Plain ⌘V pastes
/// the text Finder left along with it — the file's *name*, with no folder at all,
/// which is no use as an argument. With no file on the clipboard, it pastes the text and that's it: a
/// key that does nothing looks like a broken key.
async function colarCaminho() {
  if (!ativa || noDiff) return;
  const area = await invoke<{ arquivos: string[]; texto: string | null }>("area_colar");
  const folha = ativa.foco;
  if (area.arquivos.length) colar(folha, linhaDe(area.arquivos));
  else if (area.texto) colar(folha, area.texto);
}

// ---------- panel bar: title, play, stop and diff ----------

/// The project a panel is in, as its launch.json describes it.
type Projeto = {
  pasta: string;
  home: string;
  /// The ones play runs: without separators or CodeLens ones (see `listaDoPlay`).
  configs: ConfigLaunch[];
  /// The picker button's list, with group titles among the configurations.
  menu: (ConfigLaunch | string)[];
  tarefas: Tarefa[];
  /// A launch.json that couldn't be read: play explains instead of vanishing.
  erro?: string;
};

/// An app a panel's play button launched. It runs in the panel's drawer, a
/// plain shell where the command is typed: that is how the app inherits PATH and the
/// rest of your .zshrc — which is, almost always, the only place where `flutter`
/// is on PATH.
type Execucao = {
  /// O painel cujo play rodou o app.
  dono: Folha;
  /// The drawer's terminal, where the app runs.
  folha: Folha;
  pasta: string;
  nome: string;
  plano: Plano;
  rodando: boolean;
  parando?: boolean;
};

/// A panel's bar. Each panel has its own: with the screen split into two
/// projects, each one has its own play, its own running app and its own diff.
type Barra = {
  el: HTMLDivElement;
  titulo: HTMLSpanElement;
  /// The Claude session's context: a single pill, the bar filling with what
  /// has been used and the number over it. Clicking compacts the conversation.
  contexto: HTMLButtonElement;
  contextoCheio: HTMLSpanElement;
  contextoNum: HTMLSpanElement;
  /// The session's model and effort, beside the context. Clicking opens the
  /// list to change them.
  modelo: HTMLButtonElement;
  esforco: HTMLButtonElement;
  aviso: HTMLSpanElement;
  acoes: HTMLSpanElement;
  gaveta: HTMLButtonElement;
  parar: HTMLButtonElement;
  grupoPlay: HTMLDivElement;
  play: HTMLButtonElement;
  playIcone: HTMLSpanElement;
  /// The name of the chosen configuration. It lives on the picker button, not on play:
  /// it is the list's label, and clicking it is how you switch configurations.
  nome: HTMLSpanElement;
  escolher: HTMLButtonElement;
  diff: HTMLButtonElement;
  chat: HTMLButtonElement;
  visor: HTMLButtonElement;
  explorar: HTMLButtonElement;
  maximizar: HTMLButtonElement;
  fechar: HTMLButtonElement;
  projeto: Projeto | null;
  /// The root of the git repository this panel's shell is in, or `null` if
  /// it isn't in any. It says whether the diff button has somewhere to
  /// lead, and it is how we know whether the open diff is this panel's.
  repo: string | null;
  /// The shell's folder and its branch. `mostrarRamos` decides whether the branch shows
  /// on the bar: only when the tab's panels aren't all in the
  /// same folder — otherwise the tab chip's already says it all.
  pasta: string | null;
  branch: string | null;
  ramo: Ramo;
  /// `carregarProjeto` responses arriving out of order (several `cd`s
  /// in a row) must not overwrite the newest one.
  pedido: number;
  esperaProjeto?: ReturnType<typeof setTimeout>;
  esperaAviso?: ReturnType<typeof setTimeout>;
};

type Achado = { pasta: string; home: string; launch: string; tasks: string | null };

const traco = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONE_PLAY = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1l-7.9-5.1a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICONE_PARAR = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>`;
const ICONE_REINICIAR = traco("M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3");
const ICONE_ESCOLHER = traco("M4.5 6.5 8 10l3.5-3.5");
/// The tab's ✕: the new tab's "+" (index.html), turned 45°.
const ICONE_FECHAR_ABA = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.75v8.5M1.75 6h8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" transform="rotate(45 6 6)"/></svg>`;
/// A dialog's ✕ (the radio's list, the shortcuts): drawn like the differ's Preferences one —
/// 16px and a 1.5 stroke, in a 24px button —, so every dialog closes with the same ✕.
const ICONE_FECHAR_DIALOGO = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" transform="rotate(45 8 8)"/></svg>`;
/// The panel's ✕: the "+" turned 45°, like the tab's.
const ICONE_FECHAR = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" transform="rotate(45 8 8)"/></svg>`;
const ICONE_MAXIMIZAR = traco("M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9");
const ICONE_RECOLHER = traco("M13.5 2.5 9 7M9 3.5V7h3.5M2.5 13.5 7 9M7 12.5V9H3.5");
const ICONE_CHAT = traco("M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z");
const ICONE_COPIAR = traco("M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.5 10.5V3a1 1 0 0 1 1-1h7.5");
const ICONE_COPIADO = traco("M3 8.5l3.2 3L13 4.5");
const ICONE_OLHO = traco("M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z");
const ICONE_LAPIS = traco("M11 2.5 13.5 5l-8 8-3 .5.5-3 8-8ZM9.5 4 12 6.5");
const ICONE_DISQUETE = traco("M3 2.5h8l2.5 2.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5ZM5 2.5V6h5V2.5M5 13.5v-4h6v4");
const ICONE_ALFINETE = traco("M6 1.5h4M7 1.5v4L4.5 8.5h7L9 5.5v-4M8 8.5v6");
const ICONE_PASTA = traco("M1.5 4.5a1 1 0 0 1 1-1h3.4l1.5 1.6h6.1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z");
const ICONE_ARQUIVO = traco("M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5ZM9.5 1.5V5H13M6 8.5h4M6 11h4");
/// The viewer's arrangement button (see `Arranjo`).
const ICONE_ARRANJO: Record<Arranjo, string> = {
  lado: traco("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM8 2.5v11"),
  abaixo: traco("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2 8h12"),
  sobre: traco("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM5 5.5h6v5H5Z"),
};
const ICONE_GAVETA = traco("M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM2 9.5h12");

function elemento<K extends keyof HTMLElementTagNameMap>(tag: K, classe: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = classe;
  return el;
}

/// A bar button. The click doesn't take the keyboard from the terminal: the hot
/// reload `r`, typed right after, keeps going to the app — and coming back from the
/// diff tab finds the panel with the cursor.
function botaoTarefa(classe: string, html: string): HTMLButtonElement {
  const b = elemento("button", `tarefa-btn ${classe}`);
  b.innerHTML = html;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

function criarBarra(): Barra {
  const el = elemento("div", "painel-barra");
  const titulo = elemento("span", "tarefa-titulo");
  const aviso = elemento("span", "tarefa-aviso");
  const controles = elemento("div", "tarefa-controles");
  const acoes = elemento("span", "tarefa-acoes");
  const gaveta = botaoTarefa("tarefa-gaveta", ICONE_GAVETA);
  const parar = botaoTarefa("tarefa-parar", ICONE_PARAR);
  // Two buttons, not one split: play runs, the dropdown picks. While the
  // configuration's name lived inside play, the whole box looked like a
  // list — and clicking the name, the biggest target and the one that looks most like a
  // dropdown label, ran the app. Now the name belongs to the dropdown, and play is just ▶.
  const playIcone = elemento("span", "tarefa-icone");
  const play = botaoTarefa("tarefa-play", "");
  play.append(playIcone);
  const nome = elemento("span", "tarefa-nome");
  const seta = elemento("span", "tarefa-seta");
  seta.innerHTML = ICONE_ESCOLHER;
  const escolher = botaoTarefa("tarefa-escolher", "");
  escolher.append(nome, seta);
  const grupoPlay = elemento("div", "tarefa-play-grupo");
  grupoPlay.append(play, escolher);
  const diff = botaoTarefa("tarefa-diff", ICONE_DIFF);
  diff.title = T.diffDestePainel;
  const chat = botaoTarefa("tarefa-chat", ICONE_CHAT);
  // Only shows after the first file is opened: before that there is nothing to show.
  const visor = botaoTarefa("tarefa-visor", ICONE_ARQUIVO);
  visor.hidden = true;
  const maximizar = botaoTarefa("tarefa-maximizar", ICONE_MAXIMIZAR);
  // `desenharMaximizar` decides whether it shows, once the leaf has a tab.
  maximizar.hidden = true;
  const fechar = botaoTarefa("tarefa-fechar", ICONE_FECHAR);
  fechar.title = T.fecharPainel;
  // Like maximize: `desenharMaximizar` shows it once the leaf has a tab.
  fechar.hidden = true;
  controles.append(acoes, gaveta, parar, grupoPlay, diff, chat, visor, maximizar, fechar);
  const ramo = criarRamo("tarefa-ramo");
  const contexto = botaoTarefa("tarefa-contexto", "");
  contexto.hidden = true;
  const contextoCheio = elemento("span", "tarefa-contexto-cheio");
  const contextoNum = elemento("span", "tarefa-contexto-num");
  contexto.append(contextoCheio, contextoNum);
  const modelo = botaoTarefa("tarefa-claude-opcao tarefa-modelo", "");
  const esforco = botaoTarefa("tarefa-claude-opcao tarefa-esforco", "");
  modelo.hidden = esforco.hidden = true;
  // On the left, like the drawer it opens.
  const explorar = botaoTarefa("tarefa-explorar", ICONE_PASTA);
  el.append(explorar, titulo, ramo.el, contexto, modelo, esforco, aviso, controles);
  return {
    el,
    titulo,
    contexto,
    contextoCheio,
    contextoNum,
    modelo,
    esforco,
    pasta: null,
    branch: null,
    ramo,
    aviso,
    acoes,
    gaveta,
    parar,
    grupoPlay,
    play,
    playIcone,
    nome,
    escolher,
    diff,
    chat,
    visor,
    explorar,
    maximizar,
    fechar,
    projeto: null,
    repo: null,
    pedido: 0,
  };
}

function ligarBarra(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  b.contexto.addEventListener("click", () => compactar(folha));
  b.explorar.addEventListener("click", () => alternarExplorador(folha));
  b.modelo.addEventListener("click", () => alternarOpcoesDoClaude(folha, "modelo"));
  b.esforco.addEventListener("click", () => alternarOpcoesDoClaude(folha, "esforco"));
  b.play.addEventListener("click", () => {
    const cfg = configEscolhida(b.projeto);
    if (cfg) void executar(folha, cfg);
  });
  b.escolher.addEventListener("click", () => alternarMenu(folha));
  b.gaveta.addEventListener("click", () => alternarGaveta(folha));
  b.parar.addEventListener("click", () => {
    if (folha.execucao?.rodando) void parar(folha.execucao);
  });
  // The diff is of a repository, and the panel knows which one: each has its own
  // directory — with the screen split into three projects, each panel says its own.
  b.diff.addEventListener("click", () => void abrirDiff(folha));
  b.chat.addEventListener("click", () => alternarChat(folha));
  b.visor.addEventListener("click", () => alternarVisor(folha));
  b.maximizar.addEventListener("click", () => alternarMaximizar(folha));
  b.fechar.addEventListener("click", () => fecharFolha(folha));
  // Double-clicking the bar does the same — the big target, like a window's
  // title bar. Not on its buttons: two clicks on play are two plays.
  b.el.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    alternarMaximizar(folha);
  });
}

/// The button only exists with the screen split: with a single panel it already is the whole tab.
function desenharMaximizar(folha: Folha) {
  const b = folha.barra;
  const aba = abaDe(folha);
  if (!b || !aba) return;
  const cheio = aba.maximizada === folha;
  b.maximizar.hidden = aba.raiz.tipo === "folha";
  b.maximizar.classList.toggle("ligado", cheio);
  b.maximizar.innerHTML = cheio ? ICONE_RECOLHER : ICONE_MAXIMIZAR;
  b.maximizar.title = cheio ? T.recolherPainel : T.ocuparAba;
  // Alone in the tab, ⌘W and the tab's ✕ already close it: the bar's ✕ is for a split.
  b.fechar.hidden = aba.raiz.tipo === "folha";
}

function desenharBarra(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  b.titulo.textContent = folha.titulo;
  b.titulo.title = folha.titulo;

  // The context fills as the conversation grows: yellow and red by the
  // limits in Preferences. The pill stays while there is a session, idle or
  // not — it is with Claude idle that you can compact. Before the first
  // status line it exists, just without a number.
  const usado = folha.claude?.contexto;
  b.contexto.hidden = !folha.claude;
  let nivel: Nivel = "";
  if (usado === undefined) {
    b.contextoCheio.style.width = "0%";
    b.contextoNum.textContent = T.contextoVazio;
    b.contexto.title = T.contextoVazioDica;
  } else {
    const pct = Math.round(Math.min(100, Math.max(0, usado)));
    nivel = nivelDoContexto(pct, limitesDoContexto);
    b.contextoCheio.style.width = `${pct}%`;
    b.contextoNum.textContent = T.contexto(pct);
    b.contexto.title = T.contextoDica(pct);
  }
  b.contexto.dataset.nivel = nivel;
  // In the red, the whole panel warns: the pill alone gets lost in the corner of the eye.
  folha.el.classList.toggle("contexto-cheio", nivel === "perigo");

  // The model arrives with the first status line; effort only exists on models
  // that have it.
  const c = folha.claude;
  b.modelo.hidden = !c;
  b.modelo.textContent = c?.modelo ?? T.modeloVazio;
  b.modelo.title = c?.modelo ? T.modeloDica(c.modelo) : T.modeloVazioDica;
  b.esforco.hidden = !c?.esforco;
  const esf = ESFORCOS.find((e) => e.nivel === c?.esforco);
  b.esforco.textContent = T.esforco(esf?.rotulo ?? c?.esforco ?? "");
  b.esforco.title = T.esforcoDica;

  const g = folha.gaveta;
  b.gaveta.hidden = !g;
  b.gaveta.classList.toggle("ligado", g?.aberta === true);
  b.gaveta.title = g?.aberta ? T.esconderGaveta : T.mostrarGaveta;

  const ex = folha.execucao;
  const rodando = ex?.rodando === true;
  b.parar.hidden = !rodando;
  b.parar.title = ex ? T.parar(ex.nome) : "";
  b.acoes.replaceChildren();
  if (ex && rodando) {
    for (const acao of ex.plano.acoes ?? []) {
      const botao = botaoTarefa("tarefa-acao", "");
      botao.textContent = `${acao.icone} ${acao.rotulo}`;
      botao.title = T.acaoDica(acao.rotulo, acao.tecla);
      botao.addEventListener("click", () => {
        invoke("pty_write", { id: ex.folha.id, data: acao.tecla }).catch((e) => jlog(`action: ${e}`));
      });
      b.acoes.append(botao);
    }
  }

  // Outside a repository the diff has nothing to show: the button goes away, as
  // play goes away where there is no launch.json — a dimmed button in every shell is noise.
  // Purple when this repository is the one open in the diff: the same color that
  // lights up on that tab's chip, and the pair of lit icons is what links one to the other.
  const noDiffAgora = noRepoDoDiff(b);
  b.diff.hidden = !b.repo;
  b.diff.classList.toggle("ligado", noDiffAgora);
  b.diff.title = noDiffAgora
    ? T.abertoNoDiff
    : T.diffDestePainel;

  // Always at hand: with a Claude session it switches modes; without one, it opens one
  // in this folder, already in chat.
  const noChat = folha.chat?.aberto === true;
  b.chat.hidden = false;
  b.chat.classList.toggle("ligado", noChat);
  b.chat.title = noChat
    ? T.voltarAoTerminalChat
    : folha.claude
      ? T.verEmModoChat
      : T.abrirClaudeNoChat;

  const explorando = folha.explorador?.aberto === true;
  b.explorar.hidden = !(b.repo ?? b.pasta);
  b.explorar.classList.toggle("ligado", explorando);
  b.explorar.title = explorando ? T.fecharExplorador : T.abrirExplorador;

  const visor = folha.visor;
  b.visor.hidden = !visor?.historico.length;
  b.visor.classList.toggle("ligado", visor?.aberto === true);
  b.visor.title = visor?.aberto ? T.esconderArquivo : T.mostrarArquivo;

  // No launch.json, no play: a dimmed button in every shell would be noise.
  const proj = b.projeto;
  b.grupoPlay.hidden = !proj;
  const cfg = configEscolhida(proj);
  const reiniciar = rodando && ex?.pasta === proj?.pasta && ex?.nome === cfg?.name;
  b.playIcone.innerHTML = reiniciar ? ICONE_REINICIAR : ICONE_PLAY;
  b.play.disabled = !cfg;
  b.play.title =
    proj?.erro ?? (cfg ? (reiniciar ? T.reiniciar(cfg.name) : T.rodar(cfg.name)) : T.semConfiguracoes);

  // With a single configuration there is nothing to pick, but the name is still the
  // only clue to what ▶ will run. So the button stays, without the arrow and without the
  // click: it becomes a label. It only goes away when there is no name to show.
  const varias = (proj?.configs.length ?? 0) > 1;
  b.nome.textContent = cfg?.name ?? "";
  b.escolher.hidden = !cfg;
  b.escolher.disabled = !varias;
  b.escolher.classList.toggle("rotulo", !varias);
  b.escolher.title = varias ? T.escolherConfiguracao : (cfg?.name ?? "");
}

/// Redone when the panel is created and on every new title — a `cd` changes the title, and
/// may have changed project along with it.
function agendarProjeto(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  clearTimeout(b.esperaProjeto);
  b.esperaProjeto = setTimeout(() => void carregarProjeto(folha), 250);
}

async function carregarProjeto(folha: Folha) {
  const b = folha.barra;
  if (!b || folha.morta) return;
  const pedido = ++b.pedido;
  let novo: Projeto | null = null;
  const cwd = await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null);
  const achado = cwd ? await invoke<Achado | null>("launch_ler", { cwd }).catch(() => null) : null;
  // Without a repository the diff button has nowhere to lead, and a `cd` may have
  // taken the panel out of one or put it in another.
  const raiz = cwd
    ? await invoke<string | null>("repo_root", { path: cwd }).catch(() => null)
    : null;
  // Outside a repository it doesn't even ask. With a detached HEAD it also returns null: there
  // is no branch name to show.
  const branch = raiz
    ? await invoke<string | null>("repo_branch", { path: cwd }).catch(() => null)
    : null;
  if (achado) {
    const { pasta, home } = achado;
    let tarefasDoProjeto: Tarefa[] = [];
    try {
      tarefasDoProjeto = achado.tasks ? tarefasDe(achado.tasks) : [];
    } catch (e) {
      jlog(`unreadable tasks.json in ${pasta}: ${e}`);
    }
    try {
      novo = { pasta, home, ...listaDoPlay(configsDe(achado.launch)), tarefas: tarefasDoProjeto };
    } catch (e) {
      novo = { pasta, home, configs: [], menu: [], tarefas: [], erro: T.launchIlegivel(String(e)) };
    }
  }
  if (pedido !== b.pedido || folha.morta) return;
  b.repo = raiz;
  b.projeto = novo;
  b.pasta = cwd;
  b.branch = branch;
  const aba = abaDe(folha);
  if (aba) mostrarRamos(aba);
  desenharBarra(folha);
  // A `cd` changes the folder the panel comes back in.
  agendarSalvar();
}

/// The configuration play runs: the last one chosen in this project, or the first.
function configEscolhida(projeto: Projeto | null): ConfigLaunch | undefined {
  if (!projeto) return;
  let nome: string | null = null;
  try {
    nome = localStorage.getItem(`termiau:config:${projeto.pasta}`);
  } catch {
    // Without storage, the first one stays.
  }
  return projeto.configs.find((c) => c.name === nome) ?? projeto.configs[0];
}

function lembrarConfig(pasta: string, nome: string) {
  try {
    localStorage.setItem(`termiau:config:${pasta}`, nome);
  } catch {
    // Just a convenience.
  }
}

/// The configuration list. A single one for the window, placed beside the button that
/// opened it: inside a panel it would be clipped by the panel's edge.
const menuEl = elemento("div", "tarefa-menu");
/// The gap between the button and the list.
const VAO_MENU = 4;
/// How far the list keeps from the window's edge. Touching it, it looks clipped
/// even when it fits entirely.
const MARGEM_MENU = 24;
let menuDe: Folha | undefined;
/// The button that opened the list: the same panel has three (configurations, model and
/// effort), and clicking another switches the list instead of closing it.
let menuAncora: HTMLElement | undefined;

function montarMenu() {
  menuEl.hidden = true;
  document.body.append(menuEl);
  // Clicking outside closes the list, like any menu. The button that opens it is left
  // out: it toggles on its own.
  document.addEventListener("mousedown", (e) => {
    const alvo = e.target as Element;
    if (!menuEl.hidden && !menuEl.contains(alvo) && !alvo.closest?.(".tarefa-escolher, .tarefa-claude-opcao")) fecharMenu();
  });
}

function fecharMenu() {
  menuEl.hidden = true;
  menuDe = undefined;
  menuAncora = undefined;
}

function alternarMenu(folha: Folha) {
  if (!menuEl.hidden && menuDe === folha && menuAncora === folha.barra?.escolher) return fecharMenu();
  const b = folha.barra;
  const proj = b?.projeto;
  if (!b || !proj?.configs.length) return;
  const atual = configEscolhida(proj);
  menuEl.replaceChildren(
    ...proj.menu.map((cfg) => {
      if (typeof cfg === "string") {
        const grupo = elemento("div", "tarefa-menu-grupo");
        grupo.textContent = cfg;
        return grupo;
      }
      const item = elemento("button", cfg === atual ? "escolhida" : "");
      item.textContent = cfg.name;
      const tipo = elemento("span", "tarefa-menu-tipo");
      tipo.textContent = cfg.type;
      item.append(tipo);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      // Choosing only chooses: play is what runs. The choice applies to the project,
      // so the other panels in it start showing the same one.
      item.addEventListener("click", () => {
        lembrarConfig(proj.pasta, cfg.name);
        fecharMenu();
        for (const a of abas) {
          for (const f of folhas(a.raiz)) if (f.barra?.projeto?.pasta === proj.pasta) desenharBarra(f);
        }
      });
      return item;
    }),
  );
  abrirMenu(folha, b.escolher);
}

/// Shows the already built list beside the button that opened it.
function abrirMenu(folha: Folha, ancora: HTMLElement) {
  // Measures the list at its natural height before deciding where it goes: that height
  // says whether it fits below. All in the same frame, so nothing flickers.
  menuEl.style.maxHeight = "";
  menuEl.style.top = "0px";
  menuEl.style.bottom = "";
  menuEl.hidden = false;
  const altura = menuEl.offsetHeight;

  const r = ancora.getBoundingClientRect();
  menuEl.style.right = `${window.innerWidth - r.right}px`;
  const embaixo = window.innerHeight - r.bottom - VAO_MENU - MARGEM_MENU;
  const emCima = r.top - VAO_MENU - MARGEM_MENU;
  // Opens downward, like every dropdown. It only goes up when it doesn't fit below and
  // there is more room above: a panel in the bottom half of the window has its bar
  // near the edge, and below it the list would be two items tall — or
  // none, which is what happened when the math went negative and the browser
  // threw max-height away. On both sides the height is limited to the space
  // left: a launch.json with dozens of configurations scrolls instead of overflowing.
  if (altura <= embaixo || embaixo >= emCima) {
    menuEl.style.top = `${r.bottom + VAO_MENU}px`;
    menuEl.style.maxHeight = `${Math.max(embaixo, 0)}px`;
  } else {
    menuEl.style.top = "";
    menuEl.style.bottom = `${window.innerHeight - r.top + VAO_MENU}px`;
    menuEl.style.maxHeight = `${Math.max(emCima, 0)}px`;
  }
  menuEl.querySelector(".escolhida")?.scrollIntoView({ block: "nearest" });
  menuDe = folha;
  menuAncora = ancora;
}

/// The models `/model` accepts by alias. "Default" is the account's.
const MODELOS = [
  { apelido: "fable", rotulo: "Fable" },
  { apelido: "opus", rotulo: "Opus" },
  { apelido: "sonnet", rotulo: "Sonnet" },
  { apelido: "haiku", rotulo: "Haiku" },
  { apelido: "default", rotulo: T.padraoDaConta },
];

/// The `/effort` levels. Not every model has all of them: Claude refuses what
/// doesn't exist, and the message shows in the terminal.
const ESFORCOS = [
  { nivel: "low", rotulo: T.esforcoBaixo },
  { nivel: "medium", rotulo: T.esforcoMedio },
  { nivel: "high", rotulo: T.esforcoAlto },
  { nivel: "xhigh", rotulo: T.esforcoExtraAlto },
  { nivel: "max", rotulo: T.esforcoMaximo },
  { nivel: "auto", rotulo: T.esforcoAuto },
];

function alternarOpcoesDoClaude(folha: Folha, qual: "modelo" | "esforco") {
  const b = folha.barra;
  const c = folha.claude;
  if (!b || !c) return;
  const ancora = b[qual];
  if (!menuEl.hidden && menuAncora === ancora) return fecharMenu();
  const opcoes =
    qual === "modelo"
      ? MODELOS.map((m) => ({
          rotulo: m.rotulo,
          dica: m.apelido,
          comando: `/model ${m.apelido}`,
          atual: m.apelido !== "default" && c.modelo?.toLowerCase().startsWith(m.apelido) === true,
        }))
      : ESFORCOS.map((e) => ({ rotulo: e.rotulo, dica: e.nivel, comando: `/effort ${e.nivel}`, atual: e.nivel === c.esforco }));
  menuEl.replaceChildren(
    ...opcoes.map((o) => {
      const item = elemento("button", o.atual ? "escolhida" : "");
      item.textContent = o.rotulo;
      const dica = elemento("span", "tarefa-menu-tipo");
      dica.textContent = o.dica;
      item.append(dica);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        fecharMenu();
        mandarAoClaude(folha, o.comando, T.claudeTrabalhandoTroque);
      });
      return item;
    }),
  );
  abrirMenu(folha, ancora);
}

/// A short message on the bar, beside the title: a play that couldn't run says why.
/// Sends `/compact` to the panel's Claude, as if you typed it — the
/// same path as the chat field. With it working the command would go into the
/// queue, or into the middle of what you are typing: it only compacts when idle.
function compactar(folha: Folha) {
  mandarAoClaude(folha, "/compact", T.claudeTrabalhandoCompacte);
}

/// Types a command into the panel's Claude and presses Enter. `ocupado` is the notice for
/// when it is working.
function mandarAoClaude(folha: Folha, comando: string, ocupado: string) {
  const dono = folha.dono ?? folha;
  if (!dono.claude) return;
  if (dono.claude.estado === "trabalhando") {
    avisar(dono, ocupado);
    return;
  }
  invoke("pty_write", { id: dono.id, data: comando }).catch((e) => jlog(`${comando}: ${e}`));
  setTimeout(() => {
    invoke("pty_write", { id: dono.id, data: "\r" }).catch((e) => jlog(`${comando}: ${e}`));
  }, 80);
}

function avisar(folha: Folha, texto: string) {
  const b = folha.barra;
  if (!b) return;
  b.aviso.textContent = texto;
  b.aviso.title = texto;
  clearTimeout(b.esperaAviso);
  b.esperaAviso = setTimeout(() => {
    b.aviso.textContent = "";
    b.aviso.title = "";
  }, 8000);
}

async function executar(dono: Folha, cfg: ConfigLaunch) {
  fecharMenu();
  const proj = dono.barra?.projeto;
  if (!proj || dono.morta) return;
  lembrarConfig(proj.pasta, cfg.name);
  const runner = runnerPara(cfg.type);
  if (!runner) return avisar(dono, T.tipoNaoSuportado(cfg.name, cfg.type));

  let plano: Plano;
  let linha: string;
  try {
    const ctx = {
      pasta: proj.pasta,
      home: proj.home,
      ehFlutter: (pasta: string) => invoke<boolean>("projeto_flutter", { pasta }),
    };
    plano = await runner.montar(cfg, ctx);
    linha = linhaDeComando(plano, tarefaAntes(cfg, proj.tarefas, ctx));
  } catch (e) {
    return avisar(dono, `${cfg.name}: ${e instanceof Error ? e.message : e}`);
  }

  // Each panel has an app terminal, in its drawer. If it already exists, it is
  // reused — what play ran there before stops first; a command
  // you typed in it yourself, still running, isn't interrupted.
  let folha: Folha | undefined;
  const gaveta = dono.gaveta;
  if (gaveta) {
    folha = gaveta.folha;
    if (dono.execucao?.rodando) await parar(dono.execucao);
    else if (await invoke<boolean>("pty_ocupado", { id: folha.id }).catch(() => false)) {
      return avisar(dono, T.gavetaOcupada);
    }
    // The shell may have changed folders since last time.
    linha = `cd ${palavra(plano.cwd)} && ${linha}`;
  } else {
    folha = await criarGaveta(dono, plano.cwd);
    if (folha && !dono.gaveta?.aberta) avisar(dono, T.rodandoEscondido(cfg.name));
  }
  if (!folha || folha.morta || dono.morta) return;

  const ex: Execucao = { dono, folha, pasta: proj.pasta, nome: cfg.name, plano, rodando: true };
  dono.execucao = ex;
  await invoke("pty_write", { id: folha.id, data: `${linha}\r` }).catch((e) => jlog(`play: ${e}`));
  vigiar(ex);
  desenharBarra(dono);
}

// ---------- drawer: the app terminal ----------

/// Opens as you left it last time; the first time, hidden.
function gavetaAbertaPadrao(): boolean {
  try {
    return localStorage.getItem("termiau:gaveta") === "aberta";
  } catch {
    return false;
  }
}

function lembrarGaveta(aberta: boolean) {
  try {
    localStorage.setItem("termiau:gaveta", aberta ? "aberta" : "fechada");
  } catch {
    // Just a convenience.
  }
}

/// The app terminal: below the panel's terminal, inside it, and outside the
/// split tree — it isn't a workplace, it is the output of what play
/// ran, and only shows when you ask. It is born visible and only then hides:
/// xterm measures the font when opening, and in a hidden element the measure would come out
/// zero and the grid, broken.
async function criarGaveta(dono: Folha, cwd: string): Promise<Folha | undefined> {
  if (ocupado) return;
  ocupado = true;
  try {
    const el = elemento("div", "gaveta");
    const alca = elemento("div", "gaveta-alca");
    el.append(alca);
    dono.el.appendChild(el);
    const folha = await criarFolha(cwd, (f) => el.appendChild(f), false);
    if (!folha) {
      el.remove();
      return;
    }
    // The panel may have closed while the drawer's shell was opening.
    if (dono.morta) {
      destruirFolha(folha, false);
      return;
    }
    folha.dono = dono;
    const aberta = gavetaAbertaPadrao();
    el.hidden = !aberta;
    dono.gaveta = { folha, el, aberta };
    dono.el.classList.toggle("com-gaveta", aberta);
    ligarAlca(dono, alca, el);
    const aba = abaDe(dono);
    if (aba) {
      medir(aba);
      sincronizar(aba);
    }
    return folha;
  } finally {
    ocupado = false;
  }
}

/// The drawer's top edge changes its height, as the divider changes the share.
function ligarAlca(dono: Folha, alca: HTMLDivElement, el: HTMLDivElement) {
  alca.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // otherwise the drag becomes text selection in the terminals
    alca.setPointerCapture(e.pointerId);
    const mover = (ev: PointerEvent) => {
      const r = dono.el.getBoundingClientRect();
      // A piece always remains on both sides: a terminal squeezed to zero
      // has no grid to measure.
      el.style.height = `${Math.min(r.height - 100, Math.max(60, r.bottom - ev.clientY))}px`;
      const aba = abaDe(dono);
      if (!aba) return;
      medir(aba);
      agendarSync(aba);
    };
    const soltar = () => {
      alca.removeEventListener("pointermove", mover);
      alca.removeEventListener("pointerup", soltar);
    };
    alca.addEventListener("pointermove", mover);
    alca.addEventListener("pointerup", soltar);
  });
}

/// Shows or hides the panel's drawer. Open, it gets the keyboard (that is
/// what it is opened for: reading and typing); closed, the keyboard goes back to the panel. The app
/// keeps running in both cases.
function alternarGaveta(dono: Folha) {
  const g = dono.gaveta;
  const aba = abaDe(dono);
  if (!g || !aba) return;
  g.aberta = !g.aberta;
  g.el.hidden = !g.aberta;
  dono.el.classList.toggle("com-gaveta", g.aberta);
  lembrarGaveta(g.aberta);
  medir(aba);
  sincronizar(aba);
  if (g.aberta) focar(g.folha);
  else if (aba.foco === g.folha) focar(dono);
  desenharBarra(dono);
}

/// The drawer's shell exited (`exit`, ⌘W with it focused): the drawer goes away, and the app
/// running in it goes along.
function fecharGaveta(dono: Folha, jaMorto: boolean) {
  const g = dono.gaveta;
  if (!g) return;
  dono.gaveta = undefined;
  dono.execucao = undefined;
  destruirFolha(g.folha, jaMorto);
  g.el.remove();
  dono.el.classList.remove("com-gaveta");
  const aba = abaDe(dono);
  if (aba) {
    medir(aba);
    sincronizar(aba);
    if (aba.foco === g.folha) focar(dono);
  }
  desenharBarra(dono);
}

/// The app ended when the shell becomes the terminal's owner again. Two reads
/// in a row: between one command and the next in a line with `&&` the shell is in
/// front for an instant, and a single read would declare the app finished there.
function vigiar(ex: Execucao) {
  const inicio = Date.now();
  let livre = 0;
  const tique = setInterval(async () => {
    if (ex.folha.morta || ex.dono.execucao !== ex || !ex.rodando) return clearInterval(tique);
    // The shell needs an instant to read the line and put the command in front.
    if (Date.now() - inicio < 1500) return;
    const ocupado = await invoke<boolean>("pty_ocupado", { id: ex.folha.id }).catch(() => false);
    livre = ocupado ? 0 : livre + 1;
    if (livre < 2) return;
    clearInterval(tique);
    ex.rodando = false;
    desenharBarra(ex.dono);
  }, 700);
}

const pausa = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Gently first, forcefully after. flutter run's `q` shuts the app down on the
/// device; without its own key it sends Ctrl+C, which reaches the whole group — a
/// server and its children exit together. Whatever doesn't exit within a few seconds gets
/// SIGKILL: a stop that sometimes doesn't stop is worse than a brute-force stop.
async function parar(ex: Execucao) {
  if (ex.parando) return;
  ex.parando = true;
  const botao = ex.dono.barra?.parar;
  if (botao) botao.disabled = true;
  const id = ex.folha.id;
  const escrever = (data: string) => invoke("pty_write", { id, data }).catch(() => {});
  const saiu = async (ms: number) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (!(await invoke<boolean>("pty_ocupado", { id }).catch(() => false))) return true;
      await pausa(200);
    }
    return false;
  };
  try {
    await escrever(ex.plano.sair ?? "\x03");
    if (await saiu(4000)) return;
    await escrever("\x03");
    if (await saiu(2000)) return;
    await invoke("pty_sinal", { id, sinal: 9 }).catch((e) => jlog(`pty_sinal: ${e}`));
    await saiu(1000);
  } finally {
    ex.parando = false;
    ex.rodando = false;
    if (botao) botao.disabled = false;
    desenharBarra(ex.dono);
  }
}

// ---------- Claude usage in the footer ----------

/// Claude Usage Monitor's circle, in the footer's left corner: the circle is
/// the time left in the 5h session, and the number, how much of its usage still
/// remains. Everything counts down. The color is the pace's — it lights up when you spend
/// faster than time passes. With the mouse over it, two columns open to the
/// right, session and week, each with the time and the usage.
const usoEl = document.getElementById("uso") as HTMLDivElement;

/// The same radius as the volume (5.5 in the 16 viewBox): the perimeter is the whole stroke.
const USO_CIRCULO = 2 * Math.PI * 5.5;
/// The shine running along the circle and the bars, in the direction they empty.
const USO_BRILHO = 2.2;
/// One pass of the shine on the circle and the little bars, from tip to start.
const USO_ESCOAR_MS = 2400;

type BarraDeUso = { linha: HTMLSpanElement; cheio: HTMLSpanElement; ponteiro: HTMLSpanElement; num: HTMLSpanElement };

function barraDeUso(rotulo: string, classe: string): BarraDeUso {
  const linha = elemento("span", `uso-linha ${classe}`);
  const nome = elemento("span", "uso-rotulo");
  nome.textContent = rotulo;
  const trilho = elemento("span", "uso-trilho");
  const cheio = elemento("span", "uso-cheio");
  const ponteiro = elemento("span", "uso-ponteiro");
  cheio.append(ponteiro);
  trilho.append(cheio);
  const num = elemento("span", "uso-num");
  linha.append(nome, trilho, num);
  return { linha, cheio, ponteiro, num };
}

/// A column: the name and, to its right, the two lines — the time left and
/// the usage remaining.
function colunaDeUso(nome: string) {
  const coluna = elemento("span", "uso-coluna");
  const titulo = elemento("span", "uso-titulo");
  titulo.textContent = nome;
  const linhas = elemento("span", "uso-linhas");
  const tempo = barraDeUso(T.tempoRestante, "uso-tempo");
  const uso = barraDeUso(T.tokensDisponiveis, "uso-uso");
  linhas.append(tempo.linha, uso.linha);
  coluna.append(titulo, linhas);
  return { coluna, tempo, uso };
}

const usoSessao = colunaDeUso(T.sessao);
const usoSemana = colunaDeUso(T.semana);
/// `vertical`: the tokens bar beside the clock, which empties from top
/// to bottom; the hover ones empty from right to left.
const usoBarras: { cheio: HTMLSpanElement; ponteiro: HTMLSpanElement; vertical?: boolean }[] = [
  usoSessao.tempo,
  usoSessao.uso,
  usoSemana.tempo,
  usoSemana.uso,
];
const usoDetalhe = elemento("span", "uso-detalhe");
usoDetalhe.append(usoSessao.coluna, usoSemana.coluna);
const usoIcone = elemento("span", "uso-icone");
usoIcone.innerHTML = `<svg viewBox="0 0 16 16" width="26" height="26" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="circulo" cx="8" cy="8" r="5.5" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${USO_CIRCULO}" stroke-dashoffset="0"/><circle class="circulo-brilho" cx="8" cy="8" r="5.5" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${USO_BRILHO} ${USO_CIRCULO}" stroke-dashoffset="0"/><g class="ponteiros" stroke="currentColor" stroke-linecap="round"><line class="ponteiro-hora" x1="8" y1="8" x2="8" y2="5.6" stroke-width="1.2"/><line class="ponteiro-minuto" x1="8" y1="8" x2="8" y2="4.4" stroke-width="0.9"/><circle cx="8" cy="8" r="0.7" fill="currentColor" stroke="none"/></g></svg>`;
const usoCirculo = usoIcone.querySelector(".circulo") as SVGCircleElement;
const usoBrilho = usoIcone.querySelector(".circulo-brilho") as SVGCircleElement;
/// The hands inside the circle: the small one points to the tip of the lit
/// segment (how much of the session is left), and the big one makes a turn on hover.
const usoHora = usoIcone.querySelector(".ponteiro-hora") as SVGLineElement;
const usoMinuto = usoIcone.querySelector(".ponteiro-minuto") as SVGLineElement;
/// Beside the clock: the session's available tokens, an upright bar that
/// empties from top to bottom, like a battery, and the number beside it.
const usoResumo = elemento("span", "uso-resumo");
const usoPct = elemento("span", "uso-pct");
const usoMiniTrilho = elemento("span", "uso-trilho uso-mini");
const usoMini = { cheio: elemento("span", "uso-cheio"), ponteiro: elemento("span", "uso-ponteiro"), vertical: true };
usoMini.cheio.append(usoMini.ponteiro);
usoMiniTrilho.append(usoMini.cheio);
usoResumo.append(usoMiniTrilho, usoPct);
usoBarras.push(usoMini);
usoEl.append(usoIcone, usoResumo, usoDetalhe);

/// The last good reading: a 429 or the network dropping don't erase what was already known.
let usoAtual: Uso | undefined;
/// The piece of the circle lit now, in stroke length.
let usoArco = USO_CIRCULO;
/// The shine animations of the circle and the little bars, created together.
let usoEscoar: Animation[] = [];

const limitar = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

function pintarBarra(b: BarraDeUso, resta: number | null, texto: string, nivel: Nivel) {
  b.cheio.style.width = `${resta ?? 0}%`;
  b.num.textContent = resta === null ? "—" : texto;
  b.linha.dataset.nivel = nivel;
}

/// A window's tooltip: the name and, one per line, what remains of it.
function dicaDeUso(nome: string, j: Janela | null): string {
  if (!j) return T.semJanela(nome);
  return T.dicaDeUso(nome, limitar(100 - j.uso), faltaPara(j.renova));
}

/// A column: the two bars count what remains, time and usage.
function pintarColuna(c: ReturnType<typeof colunaDeUso>, j: Janela | null, janelaMin: number, nivel: Nivel) {
  if (!j) {
    pintarBarra(c.tempo, null, "", "");
    pintarBarra(c.uso, null, "", "");
    return;
  }
  const tempo = limitar(fracaoRestante(j.renova, janelaMin) * 100);
  const resta = limitar(100 - j.uso);
  const falta = faltaPara(j.renova);
  pintarBarra(c.tempo, tempo, falta, "");
  pintarBarra(c.uso, resta, `${resta}%`, nivel);
}

/// The circle's shine and the bars' little segments run from the tip back to the
/// start, in the direction everything decreases, and the minute hand makes a turn.
/// They are all created in the same call, and so they move together: same period,
/// same step, and they fade at the end. Only once, on hover — still the rest of the time.
function escoarUso() {
  for (const a of usoEscoar) a.cancel();
  usoEscoar = [];
  if (movimentoReduzido.matches) {
    usoBrilho.style.display = "none";
    return;
  }
  const tempo: KeyframeAnimationOptions = { duration: USO_ESCOAR_MS, easing: "linear" };
  usoEscoar.push(
    usoMinuto.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: USO_ESCOAR_MS,
      easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
    }),
  );
  const ponta = usoArco - USO_BRILHO;
  usoBrilho.style.display = ponta <= 0 ? "none" : "";
  if (ponta > 0) {
    usoEscoar.push(
      usoBrilho.animate(
        [
          { strokeDashoffset: -ponta, opacity: 0.9 },
          { strokeDashoffset: -ponta * 0.3, opacity: 0.9, offset: 0.7 },
          { strokeDashoffset: 0, opacity: 0 },
        ],
        tempo,
      ),
    );
  }
  for (const b of usoBarras) {
    usoEscoar.push(
      b.ponteiro.animate(
        b.vertical
          ? [
              { bottom: "calc(100% - 6px)", height: "6px", opacity: 0.9 },
              { bottom: "calc(30% - 4px)", height: "4px", opacity: 0.9, offset: 0.7 },
              { bottom: "0px", height: "2px", opacity: 0 },
            ]
          : [
              { left: "calc(100% - 10px)", width: "10px", opacity: 0.9 },
              { left: "calc(30% - 5px)", width: "5px", opacity: 0.9, offset: 0.7 },
              { left: "0px", width: "3px", opacity: 0 },
            ],
        tempo,
      ),
    );
  }
}

function desenharUso() {
  const u = usoAtual;
  usoEl.hidden = !u;
  if (!u) return;
  const s = u.sessao;
  const restante = s ? fracaoRestante(s.renova, SESSAO_MIN) : 1;
  const nivelSessao = s ? nivelDoRitmo(s.uso, restante) : "";
  pintarColuna(usoSessao, s, SESSAO_MIN, nivelSessao);
  pintarColuna(usoSemana, u.semana, SEMANA_MIN, u.semana ? nivelDoUso(u.semana.uso) : "");
  usoEl.dataset.nivel = nivelSessao;
  usoPct.textContent = s ? `${limitar(100 - s.uso)}%` : "—";
  usoMini.cheio.style.height = `${s ? limitar(100 - s.uso) : 0}%`;
  usoCirculo.style.strokeDashoffset = String(USO_CIRCULO * (1 - restante));
  usoHora.style.transform = `rotate(${restante * 360}deg)`;
  usoEl.title = `${dicaDeUso(T.sessao, s)}\n\n${dicaDeUso(T.semana, u.semana)}`;
  usoArco = USO_CIRCULO * restante;
}

/// On mouse over, the circle and the bars start from full and go down to where
/// they are: every time you look, you see they are decreasing.
function replayUso() {
  if (movimentoReduzido.matches || !usoAtual) return;
  const cheios = usoBarras.map((b) => b.cheio);
  const alvos: (HTMLElement | SVGElement)[] = [usoCirculo, usoHora, ...cheios];
  const lado = (i: number) => (usoBarras[i].vertical ? "height" : "width");
  for (const el of alvos) el.style.transition = "none";
  const larguras = cheios.map((el, i) => el.style[lado(i)]);
  const offset = usoCirculo.style.strokeDashoffset;
  const hora = usoHora.style.transform;
  cheios.forEach((el, i) => (el.style[lado(i)] = "100%"));
  usoCirculo.style.strokeDashoffset = "0";
  usoHora.style.transform = "rotate(360deg)";
  void usoEl.offsetWidth;
  for (const el of alvos) el.style.transition = "";
  cheios.forEach((el, i) => (el.style[lado(i)] = larguras[i]));
  escoarUso();
  usoCirculo.style.strokeDashoffset = offset;
  usoHora.style.transform = hora;
}
usoEl.addEventListener("mouseenter", replayUso);

/// The last usage news is kept: the status line only speaks with Claude
/// running, and opening the app must not leave the footer empty until then.
const CHAVE_USO = "termiau:uso";

/// Usage arrived through some panel's status line: it applies to all, there is
/// only one account.
function receberUso(u: Uso) {
  usoNoticia = u;
  try {
    localStorage.setItem(CHAVE_USO, JSON.stringify(u));
  } catch {
    // Just a convenience.
  }
  atualizarUso();
}

/// The news, as it is now: a window that renewed since then comes back at zero.
let usoNoticia: Uso | undefined;
function atualizarUso() {
  usoAtual = usoNoticia && {
    sessao: janelaAgora(usoNoticia.sessao),
    semana: janelaAgora(usoNoticia.semana),
  };
  desenharUso();
}

try {
  usoNoticia = JSON.parse(localStorage.getItem(CHAVE_USO) ?? "null") ?? undefined;
} catch {
  usoNoticia = undefined;
}
usoEl.hidden = true;
atualizarUso();
// Between one piece of news and the next, time keeps passing: the "time left" and the
// circle move on their own.
setInterval(atualizarUso, 30_000);

// ---------- radio: the footer one ----------

/// The list lives in `estacoes.ts`, with the explanation of where it comes from and what
/// each one's `espectro` means.
const estacoes = ESTACOES;

/// The current station is stored by its address, not its index: the list is
/// redone on every probe, and the index would start pointing at another. The volume is
/// a number from 0 to 100.
const CHAVE_ATUAL = "termiau:radio:atual";
const CHAVE_VOLUME = "termiau:lofi:volume";
/// Whether the radio was on air when the app closed: it starts playing again on launch.
const CHAVE_TOCANDO = "termiau:radio:tocando";

/// The five volume stages. A click goes up one; after full, mute. It is
/// what fits in a 30px footer: a slider needs a long target for the
/// pointer to travel, and long is exactly what there isn't room for here.
///
/// It lives HERE, not down below with the button that uses it: `volumeLofi` right below
/// already reads it, and a `const` declared after that doesn't exist yet at
/// read time. `tsc` doesn't catch it — the read happens inside a function, and from there it
/// can't tell what runs before what. The app just doesn't start: `ReferenceError:
/// Cannot access 'VOLUMES' before initialization`, and the window stays white.
const VOLUMES = [0, 25, 50, 75, 100];

/// The stored value may be from a version where volume was continuous — or
/// any number between 0 and 100. It snaps to the nearest stage: a volume
/// off the ladder would have no way to go up a step.
const estagio = (v: number): number =>
  VOLUMES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/// A missing key and a key with junk end up the same: the default. `Number(null)` is 0, and
/// without the null check the volume would be born muted on the first run.
function lembrado(chave: string, padrao: number, teto: number): number {
  const bruto = localStorage.getItem(chave);
  const n = bruto === null ? NaN : Number(bruto);
  return Number.isFinite(n) && n >= 0 && n <= teto ? Math.round(n) : padrao;
}

let estacao = Math.max(
  0,
  estacoes.findIndex((e) => e.url === localStorage.getItem(CHAVE_ATUAL)),
);
let volumeLofi = estagio(lembrado(CHAVE_VOLUME, 50, 100));

const atual = (): Estacao | undefined => estacoes[estacao];

function guardarAtual() {
  const e = atual();
  if (e) localStorage.setItem(CHAVE_ATUAL, e.url);
}
// ---------- radio: the footer controls ----------

const ICONE_PAUSA = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="1"/><rect x="9" y="3.5" width="3" height="9" rx="1"/></svg>`;
const ICONE_ESTACOES = traco("M3.5 4.5h9M3.5 8h9M3.5 11.5h9");
const ICONE_PROXIMA = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="10.7" y="3.6" width="1.7" height="8.8" rx=".85"/><path d="M3.8 4.2v7.6a.6.6 0 0 0 .92.5l5.2-3.8a.6.6 0 0 0 0-1L4.72 3.7a.6.6 0 0 0-.92.5Z"/></svg>`;

const lofiEl = document.getElementById("lofi") as HTMLDivElement;

/// Like the panel bar's buttons: the click doesn't take the keyboard from the terminal.
/// You press ▶ and keep typing where you left off.
function botaoLofi(classe: string, icone: string, titulo: string): HTMLButtonElement {
  const b = elemento("button", `lofi-btn ${classe}`);
  b.innerHTML = icone;
  b.title = titulo;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/// Where the back arrow used to be. With forty-six stations, stepping
/// back one at a time gets you nowhere — the list does.
const lofiEstacoes = botaoLofi("lofi-estacoes", ICONE_ESTACOES, T.estacoesLista);
const lofiTocar = botaoLofi("lofi-tocar", ICONE_PLAY, T.tocar);
const lofiProxima = botaoLofi("lofi-proxima", ICONE_PROXIMA, T.proximaEstacao);

/// The ring has radius 5.5 in the 16 viewBox — the perimeter is the whole stroke's
/// length, and the lit fraction comes from it.
const VOLUME_ANEL = 2 * Math.PI * 5.5;

const ICONE_VOLUME = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="anel" cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${VOLUME_ANEL}" stroke-dashoffset="${VOLUME_ANEL}"/><path class="corte" d="M5.1 5.1l5.8 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const lofiVolume = botaoLofi("lofi-volume", ICONE_VOLUME, T.volume);
const volumeAnel = lofiVolume.querySelector(".anel") as SVGCircleElement;
const volumeCorte = lofiVolume.querySelector(".corte") as SVGPathElement;

/// The ring lights from the top clockwise (hence the `rotate(-90)`
/// on the icon): full is a whole turn, mute is a slash and no stroke.
function desenharVolume() {
  volumeAnel.style.strokeDashoffset = String(VOLUME_ANEL * (1 - volumeLofi / 100));
  // `style.display`, not the `hidden` attribute: in an SVG inside HTML
  // `hidden` hides nothing without a CSS rule for it.
  volumeCorte.style.display = volumeLofi > 0 ? "none" : "";
  const proximo = VOLUMES[(VOLUMES.indexOf(volumeLofi) + 1) % VOLUMES.length];
  lofiVolume.title = T.volumeDica(volumeLofi, proximo);
}

const lofiTitulo = elemento("span", "lofi-titulo");
/// The box has a fixed width; this inner one is what moves.
const lofiTituloTexto = elemento("span", "lofi-titulo-texto");
lofiTitulo.appendChild(lofiTituloTexto);

/// How long the text takes to move one pixel. ~33 px/s: readable without
/// chasing it, and slow enough not to pull the eye of whoever is
/// looking at the terminal.
const TITULO_MS_POR_PX = 30;
/// The pause, after the whole text has gone by. It is the strip's normal state —
/// the scroll is the exception, and happens twice a minute.
const TITULO_PARADA_MS = 30_000;
/// A rest at the end, with the text's tail in view, before going back to the start. Without
/// it the last word would appear and vanish in the same frame.
const TITULO_FIM_MS = 1_500;
/// And one at the start, so new text is read from the beginning before it starts moving.
const TITULO_INICIO_MS = 1_200;

/// A `[branch]`: the brackets outside, the name in a box with a width cap, and
/// whatever doesn't fit scrolls inside like the radio station's name.
type Ramo = { el: HTMLSpanElement; caixa: HTMLSpanElement; texto: HTMLSpanElement };

function criarRamo(classe: string): Ramo {
  const texto = elemento("span", "ramo-texto");
  const caixa = elemento("span", "ramo-caixa");
  caixa.append(texto);
  const el = elemento("span", `ramo ${classe}`);
  el.append("[", caixa, "]");
  el.hidden = true;
  return { el, caixa, texto };
}

/// Only touches it when the name or visibility change: redoing the scroll on every
/// prompt would leave it stuck on the first pixel.
function exibirRamo(r: Ramo, nome: string | null) {
  const novo = nome ?? "";
  if (r.texto.textContent === novo && r.el.hidden === !nome) return;
  r.texto.textContent = novo;
  r.el.hidden = !nome;
  r.el.title = nome ? T.branch(nome) : "";
  passear(r.caixa, r.texto);
}

/// Measures again the ones left without scrolling for having arrived hidden (measuring zero).
function repassear(r: Ramo) {
  if (!r.el.hidden && !passeios.has(r.caixa)) passear(r.caixa, r.texto);
}

/// The tab chip shows the focused panel's branch. Panels show theirs
/// only when not all of them are in the same folder: with all together, repeating on every
/// bar what the chip already says is just noise.
function mostrarRamos(aba: Aba) {
  const barras = [...folhas(aba.raiz)].flatMap((f) => (f.barra ? [f.barra] : []));
  const misturadas = new Set(barras.map((b) => b.pasta)).size > 1;
  for (const b of barras) exibirRamo(b.ramo, misturadas ? b.branch : null);
  exibirRamo(aba.ramo, aba.foco.barra?.branch ?? null);
}

/// Each box's scroll in progress. It is per box because there are several: the radio and
/// each panel's branch.
const passeios = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/// Makes the text scroll when it doesn't fit the box: moves to the end, waits
/// a bit, goes back to the start and stops for thirty seconds — and again. If it fits, it
/// does nothing: scrolling a text entirely in view would be moving for the sake of it.
///
/// Called only when the text CHANGES. On every audio event the footer redraws,
/// and redoing the scroll on each one would leave it stuck on the first pixel.
function passear(caixa: HTMLElement, texto: HTMLElement) {
  clearTimeout(passeios.get(caixa));
  passeios.delete(caixa);
  texto.style.transition = "none";
  texto.style.transform = "translateX(0)";

  // Before the window appears everything measures zero. It isn't an error case: the next
  // text — and one always comes — measures again with the box already on screen.
  const sobra = texto.scrollWidth - caixa.clientWidth;
  if (sobra <= 1) return;

  const andar = () => {
    const quanto = sobra * TITULO_MS_POR_PX;
    texto.style.transition = `transform ${quanto}ms linear`;
    texto.style.transform = `translateX(${-sobra}px)`;
    passeios.set(caixa, setTimeout(voltar, quanto + TITULO_FIM_MS));
  };

  const voltar = () => {
    // Back to the start without a transition: the way back has nothing to
    // read, and unrolling the text in front of whoever read it is worse than a cut.
    texto.style.transition = "none";
    texto.style.transform = "translateX(0)";
    passeios.set(caixa, setTimeout(andar, TITULO_PARADA_MS));
  };

  passeios.set(caixa, setTimeout(andar, TITULO_INICIO_MS));
}

const passearTitulo = () => passear(lofiTitulo, lofiTituloTexto);

/// What is written on the strip now, to know when it really changed.
let tituloNoAr: string | undefined;

// ---------- radio: the sound ----------

/// There are TWO elements, not one, because Web Audio doesn't work for every
/// station.
///
/// A cross-origin source that doesn't allow CORS enters the graph zeroed — and since
/// the graph is what talks to the speaker, it would play in silence. Measured: of the
/// 312 probed, 249 sent `Access-Control-Allow-Origin` in the header and only
/// 56 actually deliver samples. The header isn't enough.
///
/// So a station that delivers goes through `audioGrafo`, with spectrum and gain; one
/// that doesn't goes through `audioDireto`, which never enters the graph and goes
/// straight to the speaker. One element can't be both:
/// `createMediaElementSource` is forever, and after it the element's sound
/// never comes out on its own again.
const audioGrafo = new Audio();
audioGrafo.crossOrigin = "anonymous";
audioGrafo.preload = "none";

const audioDireto = new Audio();
audioDireto.preload = "none";

/// What is playing now — one of the two above.
let audio = audioGrafo;

let tocandoLofi = false;
let carregandoLofi = false;
/// Whether you asked for play. It is what tells a stream that dropped from a `src` we
/// removed ourselves when pausing.
let noAr = false;
/// No network, or station off the air: the reason takes the name's place until the next
/// click that works. The strip fits one line, and the name can wait.
let avisoLofi: string | undefined;
// ---------- radio: the spectrum analyzer ----------

/// One column per frequency band, each cut into segments like an
/// LED display, with the peak that hangs in the air and comes down on its own.
///
/// The heights are MEASURED: they come from an FFT of the audio playing, which is
/// ours and came with CORS. Until v1 they were modeled — an invented lofi curve
/// on top of a clock — because the sound came from inside a YouTube iframe
/// and there were no samples to reach.
const SPEC_BANDAS = 10;
/// Five 2px segments with a 1px gap give exactly the strip's 14px.
const SPEC_SEGMENTOS = 5;
/// The same beat as the dictation wave: ~20 frames per second.
const SPEC_MS = 50;
/// How much the level and the peak fall per frame. The peak comes down much more slowly — that is
/// what it is for, leaving in the air for an instant what has already passed. The
/// rise has no brake: the attack is what makes a display look like a VU.
const SPEC_QUEDA = 0.075;
const SPEC_QUEDA_PICO = 0.014;
/// 2048 points at 48 kHz give ~23 Hz bins. With 512 the bins came out at ~94 Hz and
/// the first three bands all fell in the first two bins — three columns
/// showing the same thing, and the first of them showing the DC bin, which is no
/// sound at all.
const SPEC_FFT = 2048;
/// The range the display covers. Below 40 Hz is room rumble, and above
/// 16 kHz a 128 kbps MP3 keeps nothing: both ends would only waste
/// columns showing the floor.
const SPEC_HZ_MIN = 40;
const SPEC_HZ_MAX = 16_000;
/// How many dB the display covers, from the floor to the top of the column. Measured: on an
/// electronic track, each band lives about 7 dB below its own peak, and the upper ones
/// about 14. With a 16 dB scale that becomes three lit segments in the body of the
/// music and five on the peaks — a breathing display, not a wall.
const SPEC_ALCANCE = 16;
/// Each band's ceiling is MOVING: it rises on the peak and comes down on its own, ~1.2 dB/s. It is
/// what makes the display work for any station. A fixed ceiling doesn't exist:
/// measured on Groove Salad, the lowest band lives at -45 dB and the highest at
/// -77, and that distance changes with the genre. That was what kept everything at the top.
const SPEC_REF_QUEDA = 0.06;
/// But the ceiling doesn't come down forever: without a floor, the silence between tracks
/// would become infinite gain and the hiss would rise to the top.
const SPEC_REF_MINIMA = -58;

const lofiSpec = elemento("span", "spec");
lofiSpec.setAttribute("aria-hidden", "true");

const specNiveis = new Array<number>(SPEC_BANDAS).fill(0);
const specPicos = new Array<number>(SPEC_BANDAS).fill(0);
/// Each band's ceiling, in dB. It starts at the floor: the first music that comes in
/// raises it, and raising is immediate.
const specRefs = new Array<number>(SPEC_BANDAS).fill(SPEC_REF_MINIMA);
const specColunas = Array.from({ length: SPEC_BANDAS }, () => {
  const coluna = elemento("span", "spec-col");
  const nivel = elemento("span", "spec-nivel");
  const pico = elemento("span", "spec-pico");
  coluna.append(nivel, pico);
  lofiSpec.appendChild(coluna);
  return { nivel, pico };
});

lofiEl.append(lofiEstacoes, lofiTocar, lofiProxima, lofiVolume, lofiTitulo, lofiSpec);

let analisador: AudioAnalisador | undefined;

type AudioAnalisador = {
  no: AnalyserNode;
  raias: Float32Array<ArrayBuffer>;
  bandas: Array<{ de: number; ate: number }>;
  ganho: GainNode;
  contexto: AudioContext;
};

/// Web Audio is built only once, on the first ▶ — not at boot. An
/// `AudioContext` created for nothing is born suspended and still ties the system's
/// sound output to the page: the audio indicator would light up on a silent window.
///
/// `createMediaElementSource` diverts the `<audio>` into the graph: from
/// then on you only hear what reaches `destination`, and forgetting to connect that end
/// is the classic way to end up with no sound at all.
function ligarAnalisador(): AudioAnalisador {
  if (analisador) return analisador;
  const contexto = new AudioContext();
  const no = contexto.createAnalyser();
  no.fftSize = SPEC_FFT;
  // The analyzer's own smoothing does half of the VU's work; the rest
  // is `SPEC_QUEDA`'s slow fall.
  no.smoothingTimeConstant = 0.6;

  // The volume lives here, in a gain, not in the `<audio>`'s `volume`: once the
  // element is diverted into the graph, WebKit stops applying that attribute —
  // it accepts the value, `a.volume` reports what you set and the sound comes out
  // the same. You can see it in an analyzer: with `volume = 0` the samples stay
  // full. The slider was turning for nothing.
  const ganho = contexto.createGain();
  ganho.gain.value = volumeLofi / 100;

  // The analyzer comes BEFORE the gain: the display measures the music, not how much
  // of it you chose to hear. It is any mixing desk's pre-fader metering — at
  // low volume the columns keep counting what is playing, instead of
  // dying on the floor along with the sound.
  contexto.createMediaElementSource(audio).connect(no);
  no.connect(ganho);
  ganho.connect(contexto.destination);

  // Bands spaced in octaves, not equal parts: that is how the ear hears, and
  // in equal parts the first nine columns would all fall in the bass while
  // the last one alone would cover half the spectrum.
  const porRaia = contexto.sampleRate / SPEC_FFT;
  const razao = (SPEC_HZ_MAX / SPEC_HZ_MIN) ** (1 / SPEC_BANDAS);
  // Each band starts where the previous one ended and has at least one bin. Without
  // both rules the first bands pile up on the same bin, because down
  // there the step in Hz is smaller than the FFT's resolution. And the start is bin
  // 1: bin 0 is the DC component, which isn't sound and doesn't move.
  let anterior = 1;
  const bandas = Array.from({ length: SPEC_BANDAS }, (_, b) => {
    const de = Math.max(anterior, Math.floor((SPEC_HZ_MIN * razao ** b) / porRaia));
    const ate = Math.max(de + 1, Math.ceil((SPEC_HZ_MIN * razao ** (b + 1)) / porRaia));
    anterior = ate;
    return { de, ate };
  });

  analisador = { no, raias: new Float32Array(no.frequencyBinCount), bandas, ganho, contexto };
  return analisador;
}

/// From 0..1 to the height in pixels, snapped to the segment grid: it is the
/// step that makes the display look like LEDs and not a smooth stretching bar.
function alturaSpec(v: number): number {
  const acesos = Math.round(Math.max(0, Math.min(1, v)) * SPEC_SEGMENTOS);
  return acesos === 0 ? 0 : acesos * 3 - 1;
}

function moverSpec() {
  const a = analisador;
  if (!a) return;
  // In raw dB, not `getByteFrequencyData`'s byte: that one already comes squeezed
  // into a fixed window of -100 to -30 dB, and the window is exactly what can't be
  // fixed. With the loose number, the moving ceiling down here decides the scale.
  a.no.getFloatFrequencyData(a.raias);

  for (let b = 0; b < SPEC_BANDAS; b++) {
    const { de, ate } = a.bandas[b];
    // The band's maximum, not the average: the average of a wide treble band
    // drowns the cymbal in the silence next to it.
    let maior = -Infinity;
    for (let r = de; r < ate && r < a.raias.length; r++) maior = Math.max(maior, a.raias[r]);
    // Digital silence comes as -Infinity, which can't be compared or added.
    if (!Number.isFinite(maior)) maior = SPEC_REF_MINIMA - SPEC_ALCANCE;

    // The ceiling rises at once and comes down slowly. It is what gives the display the same
    // useful scale on a drone and on metal, with no genre table at all.
    specRefs[b] = Math.max(
      SPEC_REF_MINIMA,
      maior > specRefs[b] ? maior : specRefs[b] - SPEC_REF_QUEDA,
    );
    const alvo = Math.max(0, Math.min(1, 1 - (specRefs[b] - maior) / SPEC_ALCANCE));

    // Rises within the frame, comes down little by little.
    specNiveis[b] = alvo > specNiveis[b] ? alvo : Math.max(0, specNiveis[b] - SPEC_QUEDA);
    specPicos[b] = Math.max(specNiveis[b], specPicos[b] - SPEC_QUEDA_PICO);

    const { nivel, pico } = specColunas[b];
    const alto = alturaSpec(specNiveis[b]);
    const altoPico = alturaSpec(specPicos[b]);
    nivel.style.height = `${alto}px`;
    // The peak only shows above the bar: on top of it, it would say nothing.
    pico.hidden = altoPico <= alto;
    pico.style.bottom = `${Math.max(0, altoPico - 2)}px`;
  }
}

/// Each band's invented targets, when there is nothing to measure, and in
/// how many frames each one draws the next.
const specSorteio = new Array<number>(SPEC_BANDAS).fill(0);
const specEspera = new Array<number>(SPEC_BANDAS).fill(0);
/// How many frames until the next beat, also random.
let specBatida = 0;

const sortear = (de: number, ate: number) => de + Math.random() * (ate - de);

/// Through the direct path (the station doesn't let the audio be read) the display has
/// no samples, but standing still it looked like the radio was off. So it moves
/// fake, with no beat at all: each band draws a height and how long it
/// stays there, and every now and then (also random) comes a beat of random
/// strength in the bass. The rest — rising within the frame, coming down slowly, the peak in the
/// air — is the same as the measured one.
function moverSpecSorteado() {
  if (--specBatida <= 0) {
    specBatida = Math.round(sortear(4, 16));
    const forca = sortear(0.5, 1);
    const largura = Math.round(sortear(1, 4));
    for (let b = 0; b < largura; b++) specSorteio[b] = Math.max(specSorteio[b], forca * sortear(0.8, 1));
  }
  for (let b = 0; b < SPEC_BANDAS; b++) {
    if (--specEspera[b] <= 0) {
      specEspera[b] = Math.round(sortear(1, 7));
      // The bass tends to go higher, but any band can go to the top or
      // to the floor.
      const teto = 1 - (b / SPEC_BANDAS) * 0.35;
      specSorteio[b] = teto * Math.random() ** sortear(0.6, 1.6);
    }
    const alvo = specSorteio[b];
    specNiveis[b] = alvo > specNiveis[b] ? alvo : Math.max(0, specNiveis[b] - SPEC_QUEDA * sortear(0.6, 1.4));
    specPicos[b] = Math.max(specNiveis[b], specPicos[b] - SPEC_QUEDA_PICO);
    // A target reached is dropped: without this the column stayed pinned to it.
    specSorteio[b] *= sortear(0.7, 0.9);

    const { nivel, pico } = specColunas[b];
    const alto = alturaSpec(specNiveis[b]);
    const altoPico = alturaSpec(specPicos[b]);
    nivel.style.height = `${alto}px`;
    pico.hidden = altoPico <= alto;
    pico.style.bottom = `${Math.max(0, altoPico - 2)}px`;
  }
}

let pulsoSpec: ReturnType<typeof setInterval> | undefined;
let modoSpec: "medido" | "sorteado" | undefined;

/// Turns the animation on and off: measured (through the graph), random (through the direct
/// path) or none. The quick exit matters: `desenharLofi` runs on every
/// audio event, and restarting the interval on each one would make the display move
/// in jerks.
function animarSpec(modo: "medido" | "sorteado" | undefined) {
  if (modo === modoSpec) return;
  modoSpec = modo;
  clearInterval(pulsoSpec);
  pulsoSpec = undefined;
  if (modo) {
    pulsoSpec = setInterval(modo === "medido" ? moverSpec : moverSpecSorteado, SPEC_MS);
    return;
  }
  specSorteio.fill(0);
  specEspera.fill(0);
  // Stopped, everything on the floor: a display frozen midway would look stuck.
  specNiveis.fill(0);
  specPicos.fill(0);
  specRefs.fill(SPEC_REF_MINIMA);
  for (const { nivel, pico } of specColunas) {
    nivel.style.height = "0px";
    pico.hidden = true;
  }
}

// ---------- radio: the footer ----------

/// The ones that promised a spectrum and came mute — this session only. The mark in
/// `estacoes.ts` was measured one day; servers change configuration, and what
/// is happening now is what rules.
const semEspectro = new Set<string>();

const usaGrafo = (e: Estacao): boolean => e.espectro && !semEspectro.has(e.url);

function desenharLofi() {
  const e = atual();
  lofiTocar.innerHTML = tocandoLofi ? ICONE_PAUSA : ICONE_PLAY;
  lofiTocar.title = tocandoLofi ? T.pausar : T.tocar;
  lofiTocar.disabled = !e;
  lofiProxima.disabled = estacoes.length < 2;
  lofiEl.classList.toggle("tocando", tocandoLofi);
  lofiEl.classList.toggle("carregando", carregandoLofi && !tocandoLofi);

  const texto = avisoLofi ?? e?.nome ?? T.semEstacoes;
  if (texto !== tituloNoAr) {
    tituloNoAr = texto;
    lofiTituloTexto.textContent = texto;
    lofiTitulo.title = texto;
    passearTitulo();
  }

  // Through the graph the display measures the sound; through the direct path there are no samples, and
  // it moves randomly — standing still, it looked like the radio wasn't playing.
  animarSpec(!tocandoLofi ? undefined : audio === audioGrafo ? "medido" : "sorteado");
}

/// Both elements respond the same, and only the one on air has a voice: the other
/// may be finishing letting go of its `src` and a late event from it must not
/// touch the footer.
function ouvir(el: HTMLAudioElement) {
  el.addEventListener("playing", () => {
    if (el !== audio) return;
    tocandoLofi = true;
    carregandoLofi = false;
    avisoLofi = undefined;
    desenharLofi();
    if (el === audioGrafo) conferirEspectro();
  });

  // Empty buffer midway: ▶ blinks again until the sound comes back. It isn't
  // an error — on a live radio it is just the network breathing.
  el.addEventListener("waiting", () => {
    if (el !== audio || !noAr) return;
    carregandoLofi = true;
    desenharLofi();
  });

  // A pause that didn't come from us: the keyboard's media key, macOS's
  // "Now Playing" controls. The footer must know. On the loop's next turn,
  // because swapping `src` in the middle of a `tocarLofi` also comes through here, and then
  // the `play()` right behind it has already undone the pause.
  el.addEventListener("pause", () => {
    setTimeout(() => {
      if (el !== audio || !noAr || !el.paused) return;
      pausarLofi();
    });
  });
  // And an outside play, after it: back to live, not to the point where it stopped.
  el.addEventListener("play", () => {
    if (el !== audio || noAr) return;
    tocarLofi();
  });

  el.addEventListener("error", () => caiu(el));
  // An Icecast that closes the connection on its side arrives as end of media, not
  // as an error. On a radio, which never ends, it is the same thing.
  el.addEventListener("ended", () => caiu(el));
}

ouvir(audioGrafo);
ouvir(audioDireto);

/// The station went off the air, or never opened. No mirror to fall back on: the list is
/// of unique addresses, and what can be offered is the next one.
function caiu(el: HTMLAudioElement) {
  // Without `noAr` this would fire on the pause's `load()`, which is an error on
  // purpose; without the element check, the one just silenced would bring down
  // the one that just came in.
  if (el !== audio || !noAr) return;
  noAr = false;
  tocandoLofi = false;
  carregandoLofi = false;
  avisoLofi = T.estacaoForaDoAr;
  localStorage.removeItem(CHAVE_TOCANDO);
  desenharLofi();
}

/// How long to wait before checking whether the graph is receiving anything.
/// Less than this catches the station still filling the buffer and condemns it for nothing.
const CONFERIR_MS = 3_000;

let conferencia: ReturnType<typeof setTimeout> | undefined;

/// Playing mute is worse than playing without a display: if the station came in through the graph and the
/// graph receives nothing, it is demoted and restarts through the direct path. The
/// price is about three seconds of silence, once per station per session.
function conferirEspectro() {
  clearTimeout(conferencia);
  conferencia = setTimeout(() => {
    const a = analisador;
    const e = atual();
    if (!a || !e || audio !== audioGrafo || !tocandoLofi) return;

    a.no.getFloatFrequencyData(a.raias);
    const chao = SPEC_REF_MINIMA - SPEC_ALCANCE;
    if (a.raias.some((v) => Number.isFinite(v) && v > chao)) return;

    jlog(`radio: ${e.nome} came in mute on the graph — switching to the direct path`);
    semEspectro.add(e.url);
    tocarLofi();
  }, CONFERIR_MS);
}

/// Releases an element's socket. A paused radio would keep downloading to
/// throw away, and a live radio has nowhere to resume from afterwards.
function calar(el: HTMLAudioElement) {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/// Everything that needs the click gesture happens IN HERE, at once and with no
/// `await` in between. WebKit only allows audio under a gesture of yours, and the gesture doesn't
/// survive a wait: with an `await ctx.resume()` before `play()`, play
/// lands on the other side of the click and is refused — `NotSupportedError`, which on
/// top of that doesn't look like what it is. So `play()` goes first, synchronous, and the
/// context is released right behind it; the result is handled when it arrives.
function tocarLofi(automatico = false) {
  const e = atual();
  if (!e) return;

  noAr = true;
  carregandoLofi = true;
  avisoLofi = undefined;
  localStorage.setItem(CHAVE_TOCANDO, "1");

  // The right element for this station. If it is the other one, the one on air goes quiet
  // first — two streams playing together is what happens without this line.
  const anterior = audio;
  audio = usaGrafo(e) ? audioGrafo : audioDireto;
  if (anterior !== audio) calar(anterior);
  desenharLofi();

  audio.src = e.url;
  const pedido = audio.play();

  if (audio === audioGrafo) {
    // A context born suspended comes back here; one already running doesn't
    // mind being woken up again.
    void ligarAnalisador().contexto.resume().catch(() => {});
  } else {
    // Outside the graph there is no gain, and then the element's `volume` applies again.
    audio.volume = volumeLofi / 100;
  }

  pedido.catch((erro: unknown) => {
    // The element's `error` handles a stream that didn't open; all that is left here is
    // the browser's own refusal.
    noAr = false;
    carregandoLofi = false;
    // At launch there was no gesture, and WebKit may refuse: the radio waits for the
    // first key or click, silently, instead of erroring over something you
    // didn't ask for just now.
    if (automatico && erro instanceof DOMException && erro.name === "NotAllowedError") {
      localStorage.setItem(CHAVE_TOCANDO, "1");
      calar(audio);
      desenharLofi();
      tocarNoPrimeiroGesto();
      return;
    }
    localStorage.removeItem(CHAVE_TOCANDO);
    avisoLofi = T.radioNaoAbriu(String(erro));
    desenharLofi();
    jlog(`radio: ${erro}`);
  });
  atualizarTocandoAgora();
}

/// The gesture that unlocks audio. In the capture phase, to count even with the key going
/// to xterm; and `tocarLofi` is synchronous, so `play()` goes out inside it.
function tocarNoPrimeiroGesto() {
  const tocar = () => {
    window.removeEventListener("keydown", tocar, true);
    window.removeEventListener("pointerdown", tocar, true);
    if (!noAr && localStorage.getItem(CHAVE_TOCANDO)) tocarLofi();
  };
  window.addEventListener("keydown", tocar, true);
  window.addEventListener("pointerdown", tocar, true);
}

/// What macOS's "Now Playing" shows, and who answers the media keys:
/// without the handlers, the system would pause the element on its own and the footer
/// wouldn't know (the `pause` event above still covers that).
function atualizarTocandoAgora() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const e = atual();
  ms.metadata = e ? new MediaMetadata({ title: e.nome, artist: "TermIAu" }) : null;
  ms.playbackState = noAr ? "playing" : "paused";
}

function alternarLofi() {
  if (tocandoLofi) pausarLofi();
  else tocarLofi();
}

function pausarLofi() {
  noAr = false;
  clearTimeout(conferencia);
  calar(audio);
  tocandoLofi = false;
  carregandoLofi = false;
  localStorage.removeItem(CHAVE_TOCANDO);
  desenharLofi();
  atualizarTocandoAgora();
}

if (navigator.mediaSession) {
  navigator.mediaSession.setActionHandler("play", () => tocarLofi());
  navigator.mediaSession.setActionHandler("pause", () => pausarLofi());
  navigator.mediaSession.setActionHandler("stop", () => pausarLofi());
  navigator.mediaSession.setActionHandler("nexttrack", () => irPara(estacao + 1));
}

/// Puts a station on air. With the radio stopped it is only cued: switching
/// stations isn't a request to start playing, and the address is only chosen on ▶.
function irPara(i: number) {
  if (!estacoes.length) return;
  const n = estacoes.length;
  estacao = ((i % n) + n) % n;
  avisoLofi = undefined;
  guardarAtual();

  // While playing, the switch is immediate — and goes through `tocarLofi` because the new
  // station may want the other audio path.
  if (noAr) tocarLofi();
  desenharLofi();
  desenharLista();
  atualizarTocandoAgora();
}

lofiEstacoes.addEventListener("click", () => abrirEditor());
lofiProxima.addEventListener("click", () => irPara(estacao + 1));
lofiTocar.addEventListener("click", alternarLofi);

lofiVolume.addEventListener("click", () => {
  volumeLofi = VOLUMES[(VOLUMES.indexOf(volumeLofi) + 1) % VOLUMES.length];
  aplicarVolume();
  desenharVolume();
  localStorage.setItem(CHAVE_VOLUME, String(volumeLofi));
});

/// Applies to both paths: the graph's gain and the direct element's
/// `volume`. A short ramp on the gain instead of a jump, because `gain.value`
/// changed at once clicks. Before the first ▶ there is no graph, and nothing to
/// apply to it — the number is stored and goes in when the gain is built.
function aplicarVolume() {
  audioDireto.volume = volumeLofi / 100;
  const a = analisador;
  if (a) a.ganho.gain.setTargetAtTime(volumeLofi / 100, a.contexto.currentTime, 0.01);
}

// ---------- radio: the station picker ----------

/// Opened by the footer's ☰ or by Radio ▸ Stations…, in the menu bar. It is a
/// picker and nothing more: clicking a name puts the station on air, and there is nothing to
/// add or remove. A box in the middle of the window and not a list
/// attached to the footer because two hundred and fifty rows don't fit in a
/// 30px strip.
const lofiEditor = elemento("div", "lofi-editor");
lofiEditor.hidden = true;
const lofiCaixa = elemento("div", "lofi-caixa");
// The box takes the keyboard when it opens (esc, the arrows in the list), not ✕: focused,
// it would show as pressed.
lofiCaixa.tabIndex = -1;
const lofiCabeca = elemento("div", "lofi-cabeca");
const lofiCabecaTitulo = elemento("span", "lofi-cabeca-titulo");
lofiCabecaTitulo.textContent = T.estacoes;
const lofiFechar = botaoLofi("lofi-fechar", ICONE_FECHAR_DIALOGO, T.fecharEsc);
lofiCabeca.append(lofiCabecaTitulo, lofiFechar);
const lofiLista = elemento("div", "lofi-lista");
lofiCaixa.append(lofiCabeca, lofiLista);
lofiEditor.appendChild(lofiCaixa);
document.body.appendChild(lofiEditor);

function desenharLista() {
  lofiLista.textContent = "";
  estacoes.forEach((e, i) => {
    const linha = elemento("div", "lofi-linha");
    linha.classList.toggle("atual", i === estacao);
    const nome = elemento("button", "lofi-nome");
    nome.textContent = e.nome;
    nome.title = T.tocarEstacao(e.nome);
    if (e.genero) {
      const genero = elemento("span", "lofi-genero");
      genero.textContent = T.genero(e.genero);
      nome.appendChild(genero);
    }
    // The ones that play without a display get a mark, not a warning: it is a
    // small difference, and whoever is choosing a radio is choosing sound.
    if (!usaGrafo(e)) {
      const marca = elemento("span", "lofi-sem-spec");
      marca.textContent = T.semEspectro;
      linha.appendChild(marca);
    }
    // Choosing a station while stopped is a request to play: you came here to
    // listen, not to cue. The footer's arrows are what switch without playing.
    nome.addEventListener("click", () => {
      irPara(i);
      if (!noAr) tocarLofi();
    });
    linha.insertBefore(nome, linha.firstChild);
    lofiLista.appendChild(linha);
  });
  // The one on air scrolls into view: with two hundred and fifty rows it is almost
  // always out of it, and opening the picker at the top hides the answer to the
  // question that made you open it.
  lofiLista.querySelector(".lofi-linha.atual")?.scrollIntoView({ block: "nearest" });
}

function abrirEditor() {
  lofiEditor.hidden = false;
  desenharLista();
  lofiCaixa.focus({ preventScroll: true });
}

function fecharEditor() {
  lofiEditor.hidden = true;
  // The keyboard goes back where it was: the picker is a visit, not a destination.
  if (ativa?.foco) focar(ativa.foco);
}

// A click on the backdrop closes; a click on the box doesn't — `e.target` is the backdrop only when
// the pointer landed outside the box.
lofiEditor.addEventListener("mousedown", (e) => {
  if (e.target === lofiEditor) fecharEditor();
});

lofiFechar.addEventListener("click", () => fecharEditor());

lofiEditor.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    fecharEditor();
  }
});

desenharVolume();
desenharLofi();

// ---------- help: the shortcut list (Help ▸ Keyboard Shortcuts) ----------

/// All the app's shortcuts, by topic. Written by hand, not taken from the menu:
/// half of them aren't menu items (`nossoAtalho`'s, the differ's), and the
/// list also has to say what each one does. Changed a shortcut, change it here.
/// More than one key for the same thing becomes more than one key on the row.
const ATALHOS: { grupo: string; itens: [string | string[], string][] }[] = [
  {
    grupo: T.atAbas,
    itens: [
      ["⌘T", T.atNovaAba],
      ["⌘⇧T", T.atReabrirAAbaFechada],
      ["⌘⇧]", T.atProximaAba],
      ["⌘⇧[", T.atAbaAnterior],
      ["⌘`", T.atDiffDaBranchAAbaPresa],
      ["⌘1 … ⌘8", T.atIrParaAAbaDeNumero],
      ["⌘9", T.atUltimaAba],
    ],
  },
  {
    grupo: T.atPaineis,
    itens: [
      ["⌘D", T.atDividirAoLado],
      ["⌘⇧D", T.atDividirAbaixo],
      ["⌘⌥ ← ↑ → ↓", T.atIrParaOPainelNaquelaDirecao],
      ["⌘⇧A", T.atIrParaOPainelQueEsperaPorVoce],
      ["⌘⇧↩", T.atMaximizarOPainelOuRecolherDeVolta],
      ["⌘⇧C", T.atAlternarEntreOChatEOTerminalDoClaude],
      ["⌘⇧K", T.atCompactarAConversaDoClaudeCompact],
      [["⌘⇧↑", "⌘⇧↓"], T.atIrParaASuaMensagemAnteriorOuSeguinte],
      // ⌃D is end of input: the shell exits, and the panel goes along with it.
      [["⌘W", "⌃D"], T.atFecharOPainelOUltimoFechaAAba],
    ],
  },
  {
    grupo: T.atTerminal,
    itens: [
      ["⌘K", T.atLimparATela],
      ["⌘C", T.atCopiar],
      ["⌘V", T.atColar],
      ["⌘⇧V", T.atColarCaminhoDoArquivoCopiado],
      ["⌘A", T.atSelecionarTudo],
    ],
  },
  {
    grupo: T.atDiffDaBranch,
    itens: [
      ["V", T.atMarcarOArquivoComoVisto],
      ["S", T.atPorOuTirarOArquivoDoIndice],
      ["⇧S", T.atPorOuTirarAPastaDoArquivoDoIndice],
      ["A", T.atPorOuTirarTudoDoIndice],
      ["⌘↩", T.atCommitar],
      ["⌘R", T.atRecarregarODiff],
    ],
  },
  {
    grupo: T.atApp,
    itens: [
      ["⌘,", T.atPreferencias],
      ["⌘E", T.atEscutarDitado],
      ["⌘⇧P", T.atTocarOuPausarARadio],
      ["⌘/", T.atEstaLista],
      ["⌘M", T.atMinimizar],
      ["⌃⌘F", T.atTelaCheia],
      ["⌘H", T.atOcultarOTermiau],
      ["⌘Q", T.atSairPerguntaAntes],
    ],
  },
];

/// The same shell as the station picker — dark backdrop, box in the middle, esc
/// closes —, with the shortcut list inside.
const ajudaEl = elemento("div", "lofi-editor");
ajudaEl.hidden = true;
const ajudaCaixa = elemento("div", "lofi-caixa ajuda-caixa");
ajudaCaixa.tabIndex = -1;
const ajudaCabeca = elemento("div", "lofi-cabeca");
const ajudaTitulo = elemento("span", "lofi-cabeca-titulo");
ajudaTitulo.textContent = T.atalhosDoTeclado;
const ajudaFechar = botaoLofi("lofi-fechar", ICONE_FECHAR_DIALOGO, T.fecharEsc);
ajudaCabeca.append(ajudaTitulo, ajudaFechar);
const ajudaLista = elemento("div", "ajuda-lista");
for (const { grupo, itens } of ATALHOS) {
  const secao = elemento("section", "ajuda-grupo");
  const nome = elemento("h3", "ajuda-grupo-nome");
  nome.textContent = grupo;
  secao.append(nome);
  for (const [tecla, oque] of itens) {
    const linha = elemento("div", "ajuda-linha");
    const teclas = elemento("span", "ajuda-teclas");
    for (const t of Array.isArray(tecla) ? tecla : [tecla]) {
      const k = elemento("kbd", "ajuda-tecla");
      k.textContent = t;
      teclas.append(k);
    }
    const d = elemento("span", "ajuda-oque");
    d.textContent = oque;
    linha.append(d, teclas);
    secao.append(linha);
  }
  ajudaLista.append(secao);
}
ajudaCaixa.append(ajudaCabeca, ajudaLista);
ajudaEl.appendChild(ajudaCaixa);
document.body.appendChild(ajudaEl);

/// ⌘/ again with the list open closes it: it is the same key that brought it.
function alternarAjuda() {
  if (!ajudaEl.hidden) return fecharAjuda();
  ajudaEl.hidden = false;
  ajudaCaixa.focus({ preventScroll: true });
}

function fecharAjuda() {
  ajudaEl.hidden = true;
  if (ativa?.foco && !noDiff) focar(ativa.foco);
}

ajudaEl.addEventListener("mousedown", (e) => {
  if (e.target === ajudaEl) fecharAjuda();
});
ajudaFechar.addEventListener("click", () => fecharAjuda());
ajudaEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    fecharAjuda();
  }
});

// ---------- session: the tabs that come back ----------

/// A panel's snapshot: where it was and, if a Claude was running in it,
/// which session. It is what goes to disk and what ⌘⇧T keeps of a closed tab.
type NoSalvo =
  | { tipo: "folha"; cwd: string | null; claude?: string }
  | { tipo: "divisao"; eixo: Eixo; fracao: number; filhos: [NoSalvo, NoSalvo] };

type AbaSalva = {
  raiz: NoSalvo;
  /// The focused panel, by its position among the tree's leaves.
  foco: number;
};

/// The last closed tabs, the most recent at the end. Only from this run: quitting the
/// app saves the open ones, not the ones you had already sent away.
const fechadas: AbaSalva[] = [];
const MAX_FECHADAS = 10;

/// The id ends up on a command line typed into the shell, and came from a socket
/// any of the user's processes can write to: only what looks like an id gets through.
const ID_SESSAO = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fotografar(no: No): NoSalvo {
  if (no.tipo === "divisao") {
    return {
      tipo: "divisao",
      eixo: no.eixo,
      fracao: no.fracao,
      filhos: [fotografar(no.filhos[0]), fotografar(no.filhos[1])],
    };
  }
  // The session's folder before the shell's: with Claude in front, the two
  // are usually the same, but the session's is what `--resume` requires.
  return { tipo: "folha", cwd: no.claude?.pasta ?? no.barra?.pasta ?? null, claude: no.claude?.sessao };
}

function fotografarAba(aba: Aba): AbaSalva {
  // With the keyboard in the drawer, the owner comes back focused: the drawer doesn't come back.
  const foco = [...folhas(aba.raiz)].indexOf(aba.foco.dono ?? aba.foco);
  return { raiz: fotografar(aba.raiz), foco: Math.max(0, foco) };
}

/// Checks the shape of what came from disk. A file from another version, or edited
/// by hand, must not break the app's launch: whatever doesn't fit is ignored.
function noSalvo(x: unknown): NoSalvo | undefined {
  const n = x as Partial<Record<string, unknown>> | null;
  if (!n || typeof n !== "object") return;
  if (n.tipo === "folha") {
    return {
      tipo: "folha",
      cwd: typeof n.cwd === "string" ? n.cwd : null,
      claude: typeof n.claude === "string" && ID_SESSAO.test(n.claude) ? n.claude : undefined,
    };
  }
  if (n.tipo !== "divisao" || !Array.isArray(n.filhos)) return;
  const a = noSalvo(n.filhos[0]);
  const b = noSalvo(n.filhos[1]);
  if (!a || !b) return a ?? b;
  const fracao = typeof n.fracao === "number" && Number.isFinite(n.fracao) ? n.fracao : 0.5;
  return {
    tipo: "divisao",
    eixo: n.eixo === "abaixo" ? "abaixo" : "lado",
    fracao: Math.min(0.9, Math.max(0.1, fracao)),
    filhos: [a, b],
  };
}

function lerSessao(texto: string | null): { abas: AbaSalva[]; ativa: number } {
  const vazia = { abas: [], ativa: 0 };
  if (!texto) return vazia;
  try {
    const dado = JSON.parse(texto) as { abas?: unknown; ativa?: unknown } | null;
    if (!dado || !Array.isArray(dado.abas)) return vazia;
    const salvas = dado.abas.flatMap((a: { raiz?: unknown; foco?: unknown } | null): AbaSalva[] => {
      const raiz = noSalvo(a?.raiz);
      return raiz ? [{ raiz, foco: typeof a?.foco === "number" ? a.foco : 0 }] : [];
    });
    return { abas: salvas, ativa: typeof dado.ativa === "number" ? dado.ativa : 0 };
  } catch (e) {
    jlog(`unreadable saved session: ${e}`);
    return vazia;
  }
}

/// True until the saved tabs finish coming back. Meanwhile nothing is
/// saved: the first tab to come back would save "one tab" over the others.
let restaurando = true;
let esperaSalvar: ReturnType<typeof setTimeout> | undefined;

/// Saves the current tabs. On every change, not only on quit: a crash, a
/// `kill` or the battery dying must also find the tabs on the way back.
function salvarSessao(): Promise<void> {
  clearTimeout(esperaSalvar);
  if (restaurando) return Promise.resolve();
  const dados = JSON.stringify({
    versao: 1,
    abas: abas.map(fotografarAba),
    ativa: ativa ? abas.indexOf(ativa) : 0,
  });
  return invoke<void>("sessao_salvar", { dados }).catch((e) => {
    void jlog(`sessao_salvar: ${e}`);
  });
}

function agendarSalvar() {
  clearTimeout(esperaSalvar);
  esperaSalvar = setTimeout(() => void salvarSessao(), 500);
}

function primeiraFolha(no: NoSalvo): Extract<NoSalvo, { tipo: "folha" }> {
  return no.tipo === "folha" ? no : primeiraFolha(no.filhos[0]);
}

/// Puts the panel back where it was. If there is a Claude session, the
/// `--resume` line is typed into the shell, as play types its own: that is how
/// `claude` comes from your .zshrc's PATH. The shell is still starting — the line
/// waits in the terminal and it reads it when it reaches the prompt.
function retomar(folha: Folha, salvo: Extract<NoSalvo, { tipo: "folha" }>) {
  // Until `carregarProjeto` responds: quitting before that must not save the
  // panel without a folder.
  if (folha.barra && salvo.cwd) folha.barra.pasta ??= salvo.cwd;
  if (!salvo.claude) return;
  // Marked right away, not only when the hook reports: quitting before the resumed
  // session's first event must not forget it.
  folha.claude = {
    nome: salvo.cwd?.split("/").filter(Boolean).pop() || "claude",
    estado: "ocioso",
    sessao: salvo.claude,
    pasta: salvo.cwd ?? undefined,
  };
  invoke("pty_write", { id: folha.id, data: `claude --resume ${salvo.claude}\r` }).catch((e) =>
    jlog(`retomar: ${e}`),
  );
}

/// Rebuilds the saved tree from a panel: each split divides the panel, the
/// first child stays in it and the second goes to the new one. `feitas`
/// comes out in leaf order, which is the order the focus was saved in.
async function montar(aba: Aba, folha: Folha, salvo: NoSalvo, feitas: Folha[]) {
  if (salvo.tipo === "folha") {
    retomar(folha, salvo);
    feitas.push(folha);
    return;
  }
  const [a, b] = salvo.filhos;
  const nova = await dividirFolha(aba, folha, salvo.eixo, primeiraFolha(b).cwd, salvo.fracao);
  await montar(aba, folha, a, feitas);
  // No shell for the second side, the first keeps the whole space.
  if (nova) await montar(aba, nova, b, feitas);
}

/// Brings a tab back: the panels in the folders they were in, the layout as it
/// was, and the Claude sessions resumed.
async function reabrir(salva: AbaSalva): Promise<Aba | undefined> {
  const aba = await novaAba(primeiraFolha(salva.raiz).cwd);
  if (!aba) return;
  ocupado = true;
  try {
    const feitas: Folha[] = [];
    await montar(aba, aba.foco, salva.raiz, feitas);
    focar(feitas[salva.foco] ?? feitas[0]);
  } finally {
    ocupado = false;
  }
  return aba;
}

/// ⌘⇧T: the last closed tab comes back, like in the browser.
async function reabrirFechada() {
  const salva = fechadas.pop();
  if (!salva) return;
  // It didn't open (another shortcut in the meantime): the snapshot goes back on the stack.
  if (!(await reabrir(salva))) fechadas.push(salva);
}

/// The last run's tabs, at app launch. With none to bring back — the
/// first time, or the last tab was closed by hand —, opens a new one.
async function restaurarSessao() {
  const salva = lerSessao(await invoke<string | null>("sessao_ler").catch(() => null));
  try {
    for (const a of salva.abas) await reabrir(a);
    if (!abas.length) await novaAba();
    else ativar(abas[salva.ativa] ?? abas[0]);
  } finally {
    restaurando = false;
    agendarSalvar();
  }
}

// ---------- the dialog ----------

/// A question in the middle of the window, in the same shell as the station picker. The
/// confirm button is born with the keyboard: space or ↩ confirm, esc
/// cancels. Without `cancelar` it is just a notice, with one button.
/// `alternativa`: a third answer, on the left (the "Discard" beside "Cancel" and "Save").
type Pergunta = { titulo: string; texto: string; confirmar: string; cancelar?: string; alternativa?: string };
type Resposta = "sim" | "nao" | "alternativa";

const perguntaEl = elemento("div", "lofi-editor");
perguntaEl.hidden = true;
const perguntaCaixa = elemento("div", "lofi-caixa pergunta-caixa");
perguntaCaixa.setAttribute("role", "alertdialog");
const perguntaTitulo = elemento("span", "lofi-cabeca-titulo");
const perguntaTexto = elemento("p", "pergunta-texto");
const perguntaBotoes = elemento("div", "pergunta-botoes");
const perguntaAlternativa = elemento("button", "pergunta-btn pergunta-alternativa");
const perguntaNao = elemento("button", "pergunta-btn");
const perguntaSim = elemento("button", "pergunta-btn pergunta-sim");
perguntaBotoes.append(perguntaAlternativa, perguntaNao, perguntaSim);
perguntaCaixa.append(perguntaTitulo, perguntaTexto, perguntaBotoes);
perguntaEl.appendChild(perguntaCaixa);
document.body.appendChild(perguntaEl);

/// The one on screen: which it is and how to answer it.
let perguntaAberta: { chave: string; promessa: Promise<Resposta>; responder: (r: Resposta) => void } | undefined;

/// `chave` says which question it is. The same one, asked again with the box open (a
/// second ⌘Q), only refocuses the keyboard; another takes its place, and the previous one is
/// answered with "no".
function perguntar(chave: string, p: Pergunta): Promise<boolean> {
  return escolher(chave, p).then((r) => r === "sim");
}

/// `perguntar` with the third answer: which of the three buttons it was.
function escolher(chave: string, p: Pergunta): Promise<Resposta> {
  if (perguntaAberta?.chave === chave) {
    perguntaSim.focus();
    return perguntaAberta.promessa;
  }
  perguntaAberta?.responder("nao");

  const rotulo = (b: HTMLButtonElement, texto: string, tecla: string) => {
    const k = document.createElement("kbd");
    k.textContent = tecla;
    b.replaceChildren(texto, k);
  };
  perguntaTitulo.textContent = p.titulo;
  perguntaTexto.textContent = p.texto;
  rotulo(perguntaSim, p.confirmar, "↩");
  perguntaNao.hidden = !p.cancelar;
  if (p.cancelar) rotulo(perguntaNao, p.cancelar, "esc");
  perguntaAlternativa.hidden = !p.alternativa;
  perguntaAlternativa.textContent = p.alternativa ?? "";

  let responder!: (r: Resposta) => void;
  const promessa = new Promise<Resposta>((resolve) => {
    responder = (sim) => {
      if (perguntaAberta?.promessa !== promessa) return;
      perguntaAberta = undefined;
      perguntaEl.hidden = true;
      // The keyboard goes back where it was — a panel, or the diff tab.
      if (noDiff) presa?.quadro.contentWindow?.focus();
      else if (ativa?.foco) focar(ativa.foco);
      resolve(sim);
    };
  });
  perguntaAberta = { chave, promessa, responder };
  perguntaEl.hidden = false;
  perguntaSim.focus();
  return promessa;
}

perguntaEl.addEventListener("mousedown", (e) => {
  if (e.target === perguntaEl) perguntaAberta?.responder("nao");
});
perguntaAlternativa.addEventListener("click", () => perguntaAberta?.responder("alternativa"));
perguntaNao.addEventListener("click", () => perguntaAberta?.responder("nao"));
perguntaSim.addEventListener("click", () => perguntaAberta?.responder("sim"));
perguntaEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    perguntaAberta?.responder("nao");
    return;
  }
  // The keyboard doesn't leave the box: tab and the arrows only move between the
  // buttons on screen. Space and ↩ belong to the focused button itself.
  if (e.key === "Tab" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const botoes = [perguntaAlternativa, perguntaNao, perguntaSim].filter((b) => !b.hidden);
    const passo = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
    const i = botoes.indexOf(document.activeElement as HTMLButtonElement);
    botoes[(i + passo + botoes.length) % botoes.length]?.focus();
  }
});

// ---------- quitting: ⌘Q asks first ----------

let saindo = false;

/// Saves the tabs and quits. The save's `await` is what guarantees the
/// last change (a `cd`, a new session) reached the disk before the
/// process goes away.
async function sair() {
  if (saindo) return;
  saindo = true;
  await salvarSessao();
  await invoke("sair").catch((e) => jlog(`sair: ${e}`));
}

/// Quitting takes away all the shells and whatever is running in them, and ⌘Q lives
/// next to ⌘W and ⌘A.
async function pedirSair() {
  if (saindo) return;
  const paineis = abas.flatMap((a) => [...folhas(a.raiz)]);
  const claudes = paineis.filter((f) => f.claude?.sessao).length;
  const quantas = T.abaFecha(abas.length);
  const restaura = await invoke<boolean>("restaurar_ligado").catch(() => false);
  const volta = !restaura
    ? T.naoVoltam
    : claudes === 0
      ? T.voltamNasPastas
      : T.voltamComSessoes(claudes);
  const sim = await perguntar("sair", {
    titulo: T.sairDoTermiau,
    texto: T.sairTexto(quantas, volta),
    confirmar: T.sair,
    cancelar: T.cancelar,
  });
  if (sim) await sair();
}

// ---------- hooks: the link to Claude Code ----------

async function instalarHooks(): Promise<boolean> {
  try {
    await invoke("hooks_instalar");
    return true;
  } catch (e) {
    await perguntar("hooks", {
      titulo: T.naoConseguiLigar,
      texto: String(e),
      confirmar: T.ok,
    });
    return false;
  }
}

/// The hooks are how TermIAu knows what each Claude is doing and which
/// session it is. `pedido`: it came from the menu, and then every answer shows; at app
/// launch only what needs a decision shows.
async function conferirHooks(pedido: boolean) {
  const estado = await invoke<string>("hooks_estado").catch(() => "sem-claude");

  if (estado === "sem-claude") {
    if (pedido) {
      await perguntar("hooks", {
        titulo: T.naoAcheiClaude,
        texto: T.naoAcheiClaudeTexto,
        confirmar: T.ok,
      });
    }
    return;
  }
  if (estado === "instalado") {
    if (pedido) {
      await perguntar("hooks", {
        titulo: T.jaLigado,
        texto: T.jaLigadoTexto,
        confirmar: T.ok,
      });
    }
    return;
  }
  // At launch only what was already installed is updated: whoever installed it already
  // consented, and what changes is the hook that came with the new app. Installing
  // for the first time is always a gesture of yours, in the menu.
  if (!pedido) {
    if (estado === "desatualizado") await invoke("hooks_instalar").catch((e) => jlog(`hooks_instalar: ${e}`));
    return;
  }

  if (await instalarHooks()) {
    await perguntar("hooks", {
      titulo: T.ligado,
      texto: T.ligadoTexto,
      confirmar: T.ok,
    });
  }
}

/// TermIAu ▸ Restore Tabs on Open was just turned on or off. Turning it on
/// brings the hooks along: without them the tabs come back, but without knowing which Claude
/// session was in each panel.
async function restaurarMudou(ligado: boolean) {
  if (!ligado) return;
  // What is already open counts from now on.
  await salvarSessao();
  const estado = await invoke<string>("hooks_estado").catch(() => "sem-claude");
  const instalou = estado === "ausente" || estado === "desatualizado" ? await instalarHooks() : false;
  await perguntar("restaurar", {
    titulo: T.abasVoltam,
    texto: instalou
      ? T.abasVoltamInstalou
      : estado === "sem-claude"
        ? T.abasVoltamSemClaude
        : T.abasVoltamComSessoes,
    confirmar: T.ok,
  });
}

// ---------- teclado ----------

function atalho(e: Atalho) {
  // Navigating between panels and clearing the screen are terminal things: with the diff in
  // front there is no panel to refer to.
  if (e.altKey && ativa && !noDiff) {
    const alvo = vizinho(ativa.foco, e.code.slice(5) as "Left" | "Right" | "Up" | "Down");
    if (alvo) focar(alvo);
    return;
  }
  if (e.shiftKey) {
    if (e.code === "KeyA") return irParaEsperando();
    return irParaAba(e.code === "BracketRight" ? 1 : -1);
  }

  if (e.key === "k") {
    if (!noDiff) ativa?.foco.term.clear();
    return;
  }

  // ⌘` is the pinned tab, and all the numbers go to the terminals. By `code`,
  // not by `key`: on ABNT2 the backtick is a dead key and `key` doesn't arrive as "`".
  if (e.code === "Backquote") return void (presa && abrirPresa());
  // ⌘9 goes to the last one, not the ninth — it is the macOS standard.
  const n = Number(e.key);
  const alvo = n === 9 ? abas[abas.length - 1] : abas[n - 1];
  if (alvo) ativar(alvo);
}

window.addEventListener("keydown", (e) => {
  if (!nossoAtalho(e)) return;
  e.preventDefault();
  atalho(e);
});

// A key pressed inside the pinned tab belongs to another document and doesn't bubble up
// here: the differ's bridge forwards it, and from here it counts the same. The origin is
// checked in `source` — no other window talks to this one.
window.addEventListener("message", (e) => {
  // The floating preferences only say they closed; TermIAu's keys wait until then.
  if (prefsQuadro && e.source === prefsQuadro.contentWindow) {
    const dado = e.data as { termiauPrefsPronta?: boolean; termiauPrefsFechou?: boolean } | null;
    // Shown only once drawn: loading, the page flashes white.
    if (dado?.termiauPrefsPronta) {
      prefsQuadro.classList.add("pronta");
      prefsQuadro.contentWindow?.focus();
    }
    if (dado?.termiauPrefsFechou) fecharPreferencias();
    return;
  }
  if (!presa || e.source !== presa.quadro.contentWindow) return;
  const dado = e.data as {
    termiau?: Atalho;
    termiauPronto?: boolean;
    termiauRepoAberto?: string | null;
  } | null;

  // A repository was opened or closed in there: it is what lights up and dims the chip.
  if (dado && "termiauRepoAberto" in dado) {
    habilitarPresa(dado.termiauRepoAberto ?? null);
    return;
  }

  // The differ reports when it starts listening. A request that arrived before
  // that was stored waiting for exactly this notice.
  if (dado?.termiauPronto) {
    presa.pronta = true;
    const fila = presa.fila.splice(0);
    for (const msg of fila) presa.quadro.contentWindow?.postMessage(msg, "*");
    // The page may have reloaded with the tab already open (a dev reload, a
    // webview crash): it didn't see the `abrirPresa` that put it on screen.
    recado({ termiauVisivel: noDiff });
    return;
  }

  if (dado?.termiau && nossoAtalho(dado.termiau)) atalho(dado.termiau);
});

// ---------- lifecycle ----------

async function ligarEventos() {
  // xterm switches the cursor to the inactive style when the terminal loses focus,
  // but only rereads that when redrawing a line — and the app may go to the background
  // without the textarea getting `blur`. With nothing triggering a redraw, the little paw
  // kept blinking in a window that was no longer the top one. The window's event
  // is what knows about the background, so that is where we take the blur from.
  await janela.onFocusChanged(({ payload: focada }) => {
    if (!ativa || noDiff) return;
    if (!focada) ativa.foco.term.blur();
    // If a click already gave the keyboard back to a panel, we don't steal it back.
    else if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName ?? "")) teclado(ativa.foco);
  });

  // Focus entering the pinned tab's iframe without it being on screen is theft: something in
  // there called `focus()` (a git notice, for example) and the panel was left without the
  // keyboard. The top window gets `blur` when focus goes down into the iframe.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (ativa && !noDiff && presa && document.activeElement === presa.quadro) teclado(ativa.foco);
    });
  });

  // Claude Code's hooks come in here, via a unix socket (see ouvir_hooks
  // in Rust and hooks/termiau-evento.sh).
  await listen<string>("claude://evento", (e) => {
    try {
      const bruto = JSON.parse(e.payload);
      // `termiau ver` uses the same socket as the hooks (see hooks/termiau).
      if (bruto && typeof bruto === "object" && "ver" in bruto) receberVer(bruto as PedidoDoSocket);
      else if (bruto && typeof bruto === "object" && "status" in bruto) receberStatus(bruto as StatusDoSocket);
      else receber(bruto as EventoClaude);
    } catch (err) {
      jlog(`unreadable claude event: ${err}`);
    }
  });

  await ligarEscuta();

  // The bar's "+" does what ⌘T does — it is the same path, just within reach of the
  // mouse. `void` because the click doesn't wait for the tab to open.
  const mais = document.getElementById("nova-aba");
  mais?.addEventListener("click", () => void novaAba());
  mais?.setAttribute("title", T.novaAbaDica);
  mais?.setAttribute("aria-label", T.novaAba);

  // ⌘T, ⌘D, ⌘⇧D, ⌘⇧↩ and ⌘W arrive here: the native menu is what gets the key.
  await listen("menu://nova-aba", () => novaAba());
  await listen("menu://reabrir-aba", () => reabrirFechada());
  await listen("menu://sair", () => pedirSair());
  await listen("menu://hooks", () => conferirHooks(true));
  await listen<boolean>("menu://restaurar", (e) => restaurarMudou(e.payload));
  // The red button and "Close Window" also quit the app: they go through the
  // same question. What really quits is `sair`, which doesn't ask to close the
  // window — it ends the process.
  await janela.onCloseRequested((e) => {
    e.preventDefault();
    void pedirSair();
  });
  await listen("menu://dividir-lado", () => dividir("lado"));
  await listen("menu://dividir-abaixo", () => dividir("abaixo"));
  await listen("menu://maximizar", () => {
    if (ativa && !noDiff) alternarMaximizar(ativa.foco.dono ?? ativa.foco);
  });
  await listen("menu://fechar", () => {
    if (ativa && !noDiff) fecharFolha(ativa.foco);
  });
  await listen("menu://chat", () => {
    if (ativa && !noDiff) alternarChat(ativa.foco.dono ?? ativa.foco);
  });
  await listen("menu://visor", () => {
    if (ativa && !noDiff) alternarVisor(ativa.foco.dono ?? ativa.foco);
  });
  await listen("menu://compactar", () => {
    if (ativa && !noDiff) compactar(ativa.foco);
  });
  await listen<number>("menu://mensagem", (e) => {
    if (ativa && !noDiff) irParaMensagem(ativa.foco.dono ?? ativa.foco, e.payload);
  });
  await listen("menu://colar-caminho", () => colarCaminho());
  await listen("menu://preferencias", () => abrirPreferencias());
  await listen("menu://estacoes", () => abrirEditor());
  await listen("menu://radio", () => alternarLofi());
  await listen("menu://atalhos", () => alternarAjuda());

  // The .git of the repository open in the diff tab changed. It only passes it on: the tab
  // decides what to do with it, and it only exists after someone opens it.
  await listen<string>("differ://mudou", (e) => {
    if (presa?.pronta) recado({ termiauMudou: e.payload });
  });

  await ligarArrastar();
}

async function abrirAbas() {
  // A webview reload clears the tabs but not the shells: without this they would stay
  // alive, with nobody reading, on every dev server reload.
  await invoke("pty_close_all");
  // Before the first tab: it is what puts its chip at the start of the bar, and from there
  // it doesn't leave — `ligarArrasto` only reorders what is in the `abas` array.
  montarMenu();
  criarPresa();
  await restaurarSessao();
}

function depoisDasAbas() {
  void conferirHooks(false);

  // Window resize: only the visible tab has a size to measure; the
  // others adjust when they show up again (see `ativar`).
  // Watch the body, NOT the panels: fit() changes the panel and would feed the observer back.
  new ResizeObserver(() => {
    if (!ativa || noDiff) return;
    medir(ativa); // render local acompanha o arrasto, quadro a quadro
    agendarSync(ativa);
  }).observe(document.body);
}

// In a function, not loose in the module: top-level `await` doesn't pass Vite's build
// target, and `npm run build` would break even with dev working.
iniciar({
  fontes: () => document.fonts.ready,
  ligar: ligarEventos,
  abrirAbas,
  depois: depoisDasAbas,
  retomarRadio: () => {
    if (localStorage.getItem(CHAVE_TOCANDO)) tocarLofi(true);
  },
});
void ligarModoDiff();
void ligarLimitesDoContexto();
