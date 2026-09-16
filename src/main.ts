import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { nossoAtalho, type Atalho } from "./atalhos";
import { configsDe, listaDoPlay, tarefaAntes, tarefasDe, type ConfigLaunch, type Tarefa } from "./run/launch";
import { linhaDeComando, runnerPara, type Plano } from "./run/runners";
import { citar, palavra } from "./run/shell";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// Console da webview -> stderr do processo, senão erro de JS some.
const jlog = (m: string) => invoke("js_log", { msg: m });
window.addEventListener("error", (e) => jlog(`ERRO ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => jlog(`REJECT ${e.reason}`));

const janela = getCurrentWindow();
const barra = document.getElementById("tabs") as HTMLDivElement;
const painel = document.getElementById("panes") as HTMLDivElement;

const OPCOES_TERM = {
  // Mesma do iTerm2: o p10k roda em nerdfont-complete e precisa dos glifos,
  // que SF Mono/Menlo não têm — sem isto o prompt vira caixinhas.
  fontFamily: '"MesloLGS NF", Menlo, monospace',
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  // Option compõe caractere, não vira Meta: é o que faz ⌥C dar "ç" e ⌥E+E dar
  // "é". Com Meta ligado o xterm mandava ESC+c pro shell e a letra sumia.
  // O que se perde é ⌥+letra como atalho de readline (⌥F, ⌥B, ⌥.) — mas as
  // teclas que importam continuam: o próprio xterm manda ESC b / ESC f no
  // ⌥← e ⌥→, e ESC DEL no ⌥⌫, porque são teclas de código baixo e não passam
  // pelo caminho de composição.
  macOptionIsMeta: false,
  scrollback: 10_000,
  // Dracula, do spec oficial (https://draculatheme.com/spec) e da paleta ANSI
  // que os terminais dele usam. Sem os 16 do ANSI o tema ficaria pela metade: o
  // fundo seria Dracula e o `ls` continuaria saindo nas cores padrão do xterm.
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

/// Como a divisão parte o espaço: "lado" põe os painéis um ao lado do outro
/// (fronteira vertical), "abaixo" empilha (fronteira horizontal).
type Eixo = "lado" | "abaixo";

/// Um painel: um terminal e o PTY dele. É sempre uma folha da árvore da aba.
type Folha = {
  tipo: "folha";
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  desligar: UnlistenFn[];
  titulo: string;
  /// Última grade já comunicada ao kernel — evita SIGWINCH repetido do mesmo tamanho.
  ultimo: { rows: number; cols: number };
  pai?: Divisao;
  /// O nó continua apontando pros pais depois de arrancado, então subir a árvore
  /// não distingue um painel morto de um vivo. Esta marca distingue.
  morta?: boolean;
  /// Presente enquanto houver uma sessão do Claude Code rodando neste painel.
  claude?: SessaoClaude;
  /// Os painéis da árvore têm uma barra: título, play, stop, diff.
  barra?: Barra;
  /// O terminal do app que o play deste painel roda.
  gaveta?: Gaveta;
  /// Num terminal de gaveta: o painel dono dela.
  dono?: Folha;
  /// O app que o play deste painel mandou rodar, na gaveta dele.
  execucao?: Execucao;
};

type SessaoClaude = {
  /// Como a voz chama este painel. É o nome da pasta, não "painel 2": ouvir
  /// "o MOBILE precisa da sua permissão" diz onde ir; um número, não.
  nome: string;
  estado: "ocioso" | "trabalhando" | "esperando";
};

/// Um corte: dois filhos e a fatia que cabe ao primeiro. Aninhando estes nós
/// saem os layouts que o iTerm2 faz — dividir um painel já dividido.
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
  raiz: No;
  /// Painel que recebe o teclado; é o título dele que a aba mostra.
  foco: Folha;
};

/// O terminal do app que o play de um painel roda: dentro do painel, embaixo do
/// terminal dele, fora da árvore de divisões — e escondível. Ver `criarGaveta`.
type Gaveta = {
  folha: Folha;
  el: HTMLDivElement;
  aberta: boolean;
};

const abas: Aba[] = [];
let ativa: Aba | undefined;
/// Atalho repetido rápido dispararia dois `criarFolha` concorrentes, e os dois
/// mexeriam na mesma árvore ao mesmo tempo.
let ocupado = false;

/// A aba presa: o differ, o diff da branch contra a branch alvo. Vive fora do
/// array `abas` de propósito — ela não tem PTY, não divide, não fecha e não sai
/// do primeiro lugar. Dentro do array, cada função que hoje varre painéis teria
/// de perguntar antes se aquela aba tem algum; fora dele, nenhuma precisa saber
/// que ela existe.
type Presa = {
  corpo: HTMLDivElement;
  chip: HTMLDivElement;
  quadro: HTMLIFrameElement;
  /// O differ já montou e está ouvindo recados.
  pronta: boolean;
  /// Recados dados antes disso. O primeiro clique quase sempre chega antes de a
  /// página existir — ela só carrega quando a aba é aberta pela primeira vez.
  fila: unknown[];
};
let presa: Presa | undefined;
/// Verdadeiro enquanto quem ocupa a tela é a aba presa. `ativa` continua
/// apontando pro terminal de onde se veio — é pra ele que se volta.
let noDiff = false;

// ---------- árvore ----------

function* folhas(no: No): Generator<Folha> {
  if (no.tipo === "folha") yield no;
  else for (const f of no.filhos) yield* folhas(f);
}

/// Sobe até a raiz e descobre de quem ela é. Evita guardar a aba dentro de cada
/// folha, que criaria um ciclo chato de montar na hora de criar a primeira.
function abaDe(no: No): Aba | undefined {
  // O terminal de uma gaveta não está na árvore: a aba dele é a do dono.
  if (no.tipo === "folha" && no.dono) return abaDe(no.dono);
  let raiz = no;
  while (raiz.pai) raiz = raiz.pai;
  return abas.find((a) => a.raiz === raiz);
}

/// Os painéis que estão na tela: os da árvore, e as gavetas abertas. Escondida,
/// a gaveta guarda o último tamanho, como uma aba escondida (ver `ativar`).
function* visiveis(aba: Aba): Generator<Folha> {
  for (const f of folhas(aba.raiz)) {
    // A gaveta antes do dono: ela está dentro do elemento dele, e quem procura
    // o painel sob o ponteiro (`folhaEm`) tem de achá-la primeiro.
    if (f.gaveta?.aberta) yield f.gaveta.folha;
    yield f;
  }
}

/// Troca um filho por outro, mantendo a posição — é o que preserva a ordem dos
/// tracks do grid, que é quem decide qual painel fica de que lado.
function trocarFilho(pai: Divisao, velho: No, novo: No) {
  pai.filhos[pai.filhos[0] === velho ? 0 : 1] = novo;
  novo.pai = pai;
}

/// O grid tem três tracks: primeiro filho, divisor, segundo filho.
function aplicarFracao(d: Divisao) {
  const tracks = `${d.fracao}fr 6px ${1 - d.fracao}fr`;
  d.el.style.gridTemplate = d.eixo === "lado" ? `1fr / ${tracks}` : `${tracks} / 1fr`;
}

// ---------- medição ----------

/// Refaz a grade de cada painel visível da aba a partir do tamanho na tela.
/// Só o desenho local: não fala com o kernel.
function medir(aba: Aba) {
  for (const f of visiveis(aba)) f.fit.fit();
}

/// Avisa o kernel das grades que realmente mudaram, pro TUI se redesenhar certo.
function sincronizar(aba: Aba) {
  for (const f of visiveis(aba)) {
    if (f.term.rows === f.ultimo.rows && f.term.cols === f.ultimo.cols) continue;
    f.ultimo = { rows: f.term.rows, cols: f.term.cols };
    invoke("pty_resize", { id: f.id, ...f.ultimo }).catch((e) => jlog(`pty_resize: ${e}`));
  }
}

let pendente: ReturnType<typeof setTimeout> | undefined;
/// Um SIGWINCH só, quando o arrasto parar. Sem isto o shell redesenha o prompt
/// a cada frame (~45 vezes num arrasto), o que parece um shell novo.
function agendarSync(aba: Aba) {
  clearTimeout(pendente);
  pendente = setTimeout(() => {
    // Remede antes de comparar: o que valeu durante o arrasto foi o layout de
    // cada frame, e o último deles pode ter pegado a janela no meio de uma
    // animação. Quem manda é o layout já parado.
    medir(aba);
    sincronizar(aba);
  }, 80);
}

// ---------- foco ----------

function focar(folha: Folha) {
  const aba = abaDe(folha);
  if (!aba) return;
  aba.foco.el.classList.remove("focada");
  aba.foco = folha;
  folha.el.classList.add("focada");
  folha.term.focus();
  rotular(aba);
  // Olhar pro painel é atender: o aviso já cumpriu o papel dele.
  if (folha.claude?.estado === "esperando") folha.claude.estado = "ocioso";
  pintar();
}

function rotular(aba: Aba) {
  aba.rotulo.textContent = aba.foco.titulo;
  aba.chip.title = aba.foco.titulo;
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
  // A aba estava escondida (dimensão zero) e pode ter perdido redimensionamentos
  // da janela nesse meio-tempo: remede agora, antes de devolver o foco.
  medir(aba);
  sincronizar(aba);
  aba.foco.term.focus();
  rotular(aba);
}

// ---------- criação ----------

/// Abre um shell e devolve o painel dele. `inserir` põe o elemento no lugar
/// definitivo ANTES de medirmos: fora da tela a grade sairia zerada, e é ela
/// que vai no spawn.
///
/// `comBarra`: os painéis da árvore têm a barra deles (título, play, diff); o
/// terminal de uma gaveta não — quem o controla é a barra do dono.
async function criarFolha(
  cwd: string | null,
  inserir: (el: HTMLDivElement) => void,
  comBarra = true,
): Promise<Folha | undefined> {
  const el = document.createElement("div");
  el.className = "folha";
  const barra = comBarra ? criarBarra() : undefined;
  // O terminal mora num elemento só dele: o painel ainda leva a barra em cima e,
  // quando o play roda algo, a gaveta embaixo.
  const host = elemento("div", "folha-termo");
  if (barra) el.append(barra.el);
  el.append(host);
  inserir(el);

  const term = new Terminal(OPCOES_TERM);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.attachCustomKeyEventHandler((e) => !nossoAtalho(e));
  term.open(host);
  fit.fit();

  let id: number;
  try {
    id = await invoke<number>("pty_spawn", { rows: term.rows, cols: term.cols, cwd });
  } catch (e) {
    el.remove();
    term.dispose();
    jlog(`pty_spawn falhou: ${e}`);
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

  // Clicar num painel manda o teclado pra ele, sem precisar de atalho. A gaveta
  // fica dentro do painel, mas o clique nela é dela: ela tem o próprio foco.
  el.addEventListener("mousedown", (e) => {
    if (folha.gaveta?.el.contains(e.target as Node)) return;
    focar(folha);
  });
  ligarBarra(folha);

  // PTY -> tela. O Rust manda base64 pra não quebrar UTF-8 no meio de um chunk.
  folha.desligar.push(
    await listen<string>(`pty://data/${id}`, (e) => {
      const bin = atob(e.payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    }),
  );
  // Shell terminou por conta própria — ⌃D, `exit`, crash: o painel vai junto.
  folha.desligar.push(
    await listen(`pty://exit/${id}`, () => fecharFolha(folha, { jaMorto: true })),
  );

  // Só agora o Rust começa a bombear: evento emitido antes deste ponto
  // não teria ninguém ouvindo e o começo do prompt se perderia.
  await invoke("pty_attach", { id });

  // tela -> PTY. `onData` é entrada do usuário: o ditado entra por `pty_write`
  // direto e não passa por aqui, então digitar é distinguível de falar.
  term.onData((data) => {
    cancelarEnvio();
    invoke("pty_write", { id, data }).catch((e) => jlog(`pty_write: ${e}`));
  });
  // O prompt (p10k, zsh) publica o diretório por OSC; é o título da aba.
  term.onTitleChange((t) => {
    folha.titulo = t || "shell";
    const aba = abaDe(folha);
    if (aba?.foco === folha) rotular(aba);
    // A barra mostra o título, e um `cd` pode ter mudado de projeto.
    desenharBarra(folha);
    agendarProjeto(folha);
  });

  desenharBarra(folha);
  agendarProjeto(folha);
  return folha;
}

async function novaAba() {
  if (ocupado) return;
  ocupado = true;
  try {
    // Aba nova abre onde o painel em foco está, como nos outros terminais. O Rust
    // cai no HOME sozinho se não conseguir descobrir (pasta apagada, por exemplo).
    const cwd = ativa ? await invoke<string | null>("pty_cwd", { id: ativa.foco.id }) : null;

    const corpo = document.createElement("div");
    corpo.className = "aba";
    painel.appendChild(corpo);
    // Mede-se no lugar definitivo: com a aba anterior ainda visível, as duas
    // dividiriam a área e a grade sairia com metade da altura.
    esconderPresa();
    if (ativa) ativa.corpo.hidden = true;

    const folha = await criarFolha(cwd, (el) => corpo.appendChild(el));
    if (!folha) {
      // Sem shell não há aba: desfaz e devolve a tela pra quem estava aberto.
      corpo.remove();
      if (ativa) ativa.corpo.hidden = false;
      return;
    }

    const chip = document.createElement("div");
    chip.className = "tab";
    // Bolinha de estado do Claude; fica transparente enquanto não houver sessão.
    const sinal = document.createElement("span");
    sinal.className = "tab-sinal";
    const rotulo = document.createElement("span");
    rotulo.className = "tab-titulo";
    rotulo.textContent = folha.titulo;
    const fechar = document.createElement("span");
    fechar.className = "tab-fechar";
    fechar.textContent = "✕";
    chip.append(sinal, rotulo, fechar);
    barra.appendChild(chip);

    const aba: Aba = { corpo, chip, rotulo, raiz: folha, foco: folha };
    folha.el.classList.add("focada");

    chip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // O ✕ fecha a aba inteira; no resto do chip, só ativa.
      if (e.target === fechar) fecharAba(aba);
      else ativar(aba);
    });
    // Botão do meio fecha, como no navegador.
    chip.addEventListener("auxclick", (e) => {
      if (e.button === 1) fecharAba(aba);
    });

    abas.push(aba);
    ligarArrasto(aba);
    sincronizarBarra();
    ativar(aba);
  } finally {
    ocupado = false;
  }
}

function sincronizarBarra() {
  // Com a aba presa na barra há sempre dois chips, então ela não se esconde
  // mais. Foi o preço de o diff estar sempre a um clique.
  barra.hidden = !presa && abas.length < 2;
}

// ---------- reordenar abas ----------

/// O quanto o ponteiro precisa andar para a intenção virar arrasto. Sem esta
/// folga, um clique com a mão trêmula reordenaria a barra sem ninguém pedir.
const LIMIAR_ARRASTO = 4;

/// Arrastar um chip pela barra muda a aba de lugar — e a ordem do array é a
/// mesma que o ⌘1..⌘9 e o ⌘⇧[ usam, então mover aqui move em tudo.
///
/// O chip segue o ponteiro por `transform`, que não mexe no layout: enquanto
/// arrasta, os vizinhos continuam onde estavam e servem de régua. A troca
/// acontece assim que o centro do chip passa o centro de um vizinho, então a
/// barra já reordena durante o arrasto, e não só ao soltar.
function ligarArrasto(aba: Aba) {
  const chip = aba.chip;

  chip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // O ✕ é botão, não alça: quem aperta ali quer fechar, não mover.
    if ((e.target as HTMLElement).classList.contains("tab-fechar")) return;

    // Ponto do qual se conta o deslocamento. Muda a cada troca, porque o chip
    // ganha uma posição nova no layout e o `transform` precisa ser descontado
    // dela para o chip não pular na tela.
    let origem = e.clientX;
    let arrastando = false;

    const mover = (ev: PointerEvent) => {
      if (!arrastando) {
        if (Math.abs(ev.clientX - origem) < LIMIAR_ARRASTO || abas.length < 2) return;
        arrastando = true;
        chip.classList.add("arrastando");
      }
      chip.style.transform = `translateX(${ev.clientX - origem}px)`;

      // Só os dois vizinhos importam: para chegar no terceiro é preciso passar
      // pelo segundo, e aí a troca com ele já aconteceu.
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
      // As duas medidas carregam o mesmo `transform`, então a diferença entre
      // elas é só o tanto que o layout andou — que é o que a origem absorve.
      origem += chip.getBoundingClientRect().left - antes;
      chip.style.transform = `translateX(${ev.clientX - origem}px)`;
    };

    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      chip.classList.remove("arrastando");
      chip.style.transform = "";
    };

    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
    window.addEventListener("pointercancel", soltar, { once: true });
  });
}

/// Centro horizontal do chip como ele está na tela — com o `transform` do
/// arrasto incluído, que é justamente o que `getBoundingClientRect` devolve.
function meio(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

// ---------- aba presa: o diff ----------

/// O ícone do chip. A aba presa não mostra texto: ela está sempre na barra, e
/// um chip de 180px escrito "Diff" competiria pelo espaço com o nome do que
/// você está rodando — que é a informação que muda.
const ICONE_DIFF = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

/// Monta a aba presa. Chamada antes da primeira aba de terminal: é assim que o
/// chip dela fica sendo o primeiro filho da barra, e nenhum arrasto o alcança —
/// `ligarArrasto` só reordena o que está no array `abas`, e ela não está.
///
/// O differ vai num <iframe>, não montado aqui no documento: o CSS dele é
/// global (mexe em `body`, em `button`, na barra de rolagem) e os atalhos dele
/// são de uma tecla só. Num documento à parte, nada disso alcança o terminal —
/// e o IPC do Tauri atravessa porque a origem é a mesma (ver ponte.ts).
function criarPresa() {
  const corpo = document.createElement("div");
  corpo.className = "aba";
  corpo.hidden = true;
  const quadro = document.createElement("iframe");
  quadro.className = "quadro";
  quadro.src = "/differ.html";
  corpo.appendChild(quadro);
  painel.appendChild(corpo);

  const chip = document.createElement("div");
  chip.className = "tab presa";
  chip.title = "Diff da branch";
  chip.innerHTML = ICONE_DIFF;
  barra.appendChild(chip);
  chip.addEventListener("mousedown", (e) => {
    if (e.button === 0) abrirPresa();
  });

  presa = { corpo, chip, quadro, pronta: false, fila: [] };
}

/// Fala com a página do differ, guardando o recado se ela ainda não carregou.
function recado(msg: unknown) {
  if (!presa) return;
  if (presa.pronta) presa.quadro.contentWindow?.postMessage(msg, "*");
  else presa.fila.push(msg);
}

/// Leva o repositório do painel para a aba do diff e a traz para a frente.
async function abrirDiff(folha: Folha) {
  abrirPresa();
  const cwd = await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null);
  if (cwd) recado({ termiauRepo: cwd });
}

/// ⌘, — as preferências moram no differ, que é quem tem o que configurar e
/// quem guarda o arquivo. Abrir a aba junto é parte do gesto.
function abrirPreferencias() {
  abrirPresa();
  recado({ termiauPrefs: true });
}

function abrirPresa() {
  if (!presa || noDiff) return;
  if (ativa) {
    ativa.corpo.hidden = true;
    ativa.chip.classList.remove("ativa");
    // O xterm só troca o cursor pro estilo inativo quando lhe tiram o foco; sem
    // isto a patinha continuaria piscando atrás do diff.
    ativa.foco.term.blur();
  }
  noDiff = true;
  presa.corpo.hidden = false;
  presa.chip.classList.add("ativa");
  presa.quadro.focus();
  presa.quadro.contentWindow?.focus();
  janela.setTitle("Diff — TermIAu").catch(() => {});
}

/// Tira a aba presa da tela. Quem chama é quem vai pôr um terminal no lugar.
function esconderPresa() {
  if (!presa || !noDiff) return;
  noDiff = false;
  presa.corpo.hidden = true;
  presa.chip.classList.remove("ativa");
}

// ---------- divisão ----------

function criarDivisor(d: Divisao): HTMLDivElement {
  const divisor = document.createElement("div");
  divisor.className = `divisor ${d.eixo}`;

  divisor.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // senão o arrasto vira seleção de texto nos terminais
    divisor.setPointerCapture(e.pointerId);

    const mover = (ev: PointerEvent) => {
      const r = d.el.getBoundingClientRect();
      const bruta =
        d.eixo === "lado" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      // Um painel espremido a zero fica sem grade pra medir e o xterm reclama.
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
  const alvo = aba.foco;
  try {
    const cwd = await invoke<string | null>("pty_cwd", { id: alvo.id });

    // Tirar do documento um elemento que contém o textarea focado rouba o foco
    // sem disparar `blur`. O xterm continuaria achando que tem o teclado: marca
    // `.xterm-focus` de pé e cursor piscando num painel que já não recebe tecla.
    // Enquanto o foco ainda é real, avisamos.
    alvo.term.blur();

    // O lugar do painel na página é reservado antes de mexer nele: montar a
    // divisão move `alvo.el` pra dentro dela e a posição original se perderia.
    const marca = document.createComment("divisao");
    alvo.el.replaceWith(marca);

    const d: Divisao = {
      tipo: "divisao",
      eixo,
      fracao: 0.5,
      filhos: [alvo, alvo], // o segundo é substituído assim que o shell abrir
      el: document.createElement("div"),
      pai: alvo.pai,
    };
    d.el.className = "divisao";
    aplicarFracao(d);
    d.el.append(alvo.el, criarDivisor(d));
    marca.replaceWith(d.el);

    const nova = await criarFolha(cwd, (el) => d.el.appendChild(el));
    if (!nova) {
      // Desfaz o corte e devolve o painel ao lugar — com o teclado de volta nele.
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

    medir(aba);
    sincronizar(aba);
    focar(nova);
  } finally {
    ocupado = false;
  }
}

// ---------- fechamento ----------

/// Solta os recursos do painel. Não mexe na árvore — quem faz isso é quem chama.
function destruirFolha(folha: Folha, jaMorto: boolean) {
  folha.morta = true;
  // A gaveta mora dentro do painel: vai junto, e o app que rodava nela também.
  if (folha.gaveta) destruirFolha(folha.gaveta.folha, false);
  folha.execucao = undefined;
  for (const off of folha.desligar) off();
  folha.desligar = [];
  if (!jaMorto) invoke("pty_close", { id: folha.id }).catch((e) => jlog(`pty_close: ${e}`));
  folha.term.dispose();
  folha.el.remove();
}

function fecharFolha(folha: Folha, opts: { jaMorto?: boolean } = {}) {
  if (folha.morta) return; // o exit do shell pode chegar depois de já termos fechado
  const aba = abaDe(folha);
  if (!aba) return;
  // A gaveta não tem pai, mas também não é o último painel: fecha só ela.
  if (folha.dono) return fecharGaveta(folha.dono, opts.jaMorto ?? false);
  // Último painel da aba: não sobra layout nenhum, então é a aba que fecha.
  if (!folha.pai) return fecharAba(aba);

  const pai = folha.pai;
  const irmao = pai.filhos[pai.filhos[0] === folha ? 1 : 0];
  destruirFolha(folha, opts.jaMorto ?? false);

  // O irmão sobe e ocupa sozinho o espaço que era dos dois. Sai do DOM junto com
  // o pai, por isso o lugar é marcado antes de arrancar a divisão.
  const marca = document.createComment("promocao");
  pai.el.replaceWith(marca);
  marca.replaceWith(irmao.el);

  irmao.pai = pai.pai;
  if (pai.pai) trocarFilho(pai.pai, pai, irmao);
  else aba.raiz = irmao;
  aba.corpo.classList.toggle("dividida", aba.raiz.tipo === "divisao");

  medir(aba);
  sincronizar(aba);
  pintar();
  // O foco estava no painel que morreu: cai no vizinho que ocupou o lugar.
  if (aba.foco === folha) focar(folhas(irmao).next().value as Folha);
  // Sobreviveu, mas a promoção moveu o elemento dele no DOM e o textarea ficou
  // sem o foco de verdade — sem `blur`, o xterm nem soube. Reencosta.
  else aba.foco.term.focus();
}

function fecharAba(aba: Aba) {
  const i = abas.indexOf(aba);
  if (i < 0) return;

  abas.splice(i, 1);
  for (const f of folhas(aba.raiz)) destruirFolha(f, false);
  aba.corpo.remove();
  aba.chip.remove();

  if (abas.length === 0) {
    janela.close().catch((e) => jlog(`close: ${e}`));
    return;
  }
  sincronizarBarra();
  pintar();
  // Foco vai pra vizinha da direita; se era a última, pra da esquerda.
  if (ativa === aba) ativar(abas[Math.min(i, abas.length - 1)]);
}

// ---------- navegação entre painéis ----------

/// Painel mais próximo na direção pedida. Vale a geometria na tela, não a forma
/// da árvore: é o que faz ⌥→ ir pro painel que está visivelmente à direita,
/// mesmo que ele esteja em outro ramo.
function vizinho(folha: Folha, dir: "Left" | "Right" | "Up" | "Down"): Folha | undefined {
  const aba = abaDe(folha);
  if (!aba) return;
  const r = folha.el.getBoundingClientRect();
  const horizontal = dir === "Left" || dir === "Right";
  const sinal = dir === "Left" || dir === "Up" ? -1 : 1;

  let melhor: Folha | undefined;
  let menor = Infinity;
  for (const f of visiveis(aba)) {
    if (f === folha) continue;
    const q = f.el.getBoundingClientRect();
    // Avanço na direção pedida; negativo quer dizer que está pro lado errado.
    const passo = sinal * (horizontal ? q.left - r.left : q.top - r.top);
    if (passo <= 0) continue;
    // Precisa se sobrepor no outro eixo, senão o painel do canto oposto ganharia.
    const cruza = horizontal
      ? q.bottom > r.top && q.top < r.bottom
      : q.right > r.left && q.left < r.right;
    if (!cruza) continue;
    if (passo < menor) {
      menor = passo;
      melhor = f;
    }
  }
  return melhor;
}

function irParaAba(delta: number) {
  // A aba presa entra no anel como qualquer outra — ela é a primeira da barra,
  // e ⌘⇧[ na aba seguinte tem de cair nela.
  const anel: (Aba | Presa)[] = presa ? [presa, ...abas] : [...abas];
  const i = noDiff ? 0 : ativa ? anel.indexOf(ativa) : -1;
  if (i < 0 || anel.length < 2) return;
  // Circular: da última pra primeira, como no iTerm2.
  const alvo = anel[(i + delta + anel.length) % anel.length];
  if (alvo === presa) abrirPresa();
  else ativar(alvo as Aba);
}

// ---------- sessões do Claude ----------

/// O que chega dos hooks. `painel` é posto pelo termiau-evento.sh a partir do
/// ambiente do shell; o resto vem do Claude Code como está.
type EventoClaude = {
  painel: number;
  hook_event_name: string;
  cwd?: string;
  message?: string;
  title?: string;
  delta?: string;
  message_id?: string;
  index?: number;
  final?: boolean;
};

/// Acima disto, em vez de ler a mensagem inteira em voz alta, pedimos uma frase.
const LIMITE_RESUMO = 440;
/// Teto do que se fala de uma vez. Passar disso vira monólogo.
const MAX_FALA = 220;

/// Pedaços de mensagem sendo remontados, por `message_id`.
const remontagem = new Map<string, Map<number, string>>();

function folhaPorPainel(id: number): Folha | undefined {
  for (const a of abas) for (const f of folhas(a.raiz)) if (f.id === id) return f;
  return undefined;
}

function* sessoes(): Generator<Folha> {
  for (const a of abas) for (const f of folhas(a.raiz)) if (f.claude) yield f;
}

/// Redesenha os sinais de estado: bolinha em cada aba, contorno no painel que
/// espera, e o badge do Dock com quantos esperam — que é o que se vê com o app
/// inteiro em segundo plano.
function pintar() {
  let esperando = 0;
  for (const aba of abas) {
    let sinal = "";
    for (const f of folhas(aba.raiz)) {
      const estado = f.claude?.estado;
      f.el.classList.toggle("esperando", estado === "esperando");
      if (estado === "esperando") {
        esperando++;
        sinal = "esperando";
      } else if (estado === "trabalhando" && sinal !== "esperando") {
        sinal = "trabalhando";
      }
    }
    aba.chip.dataset.claude = sinal;
  }
  janela.setBadgeCount(esperando || undefined).catch(() => {});
}

/// Fala, dizendo de quem é a vez quando há mais de uma sessão aberta. Com uma
/// só não há a quem confundir, e o nome vira ruído em toda frase.
function anunciar(folha: Folha, frase: string) {
  const texto = frase.trim();
  if (!texto) return;
  let vivas = 0;
  for (const _ of sessoes()) vivas++;
  const quem = vivas > 1 && folha.claude ? `${folha.claude.nome}: ` : "";
  // O chamador escolhe a voz: cada projeto ganha uma do rodízio e fica com ela.
  // É a segunda pista de origem, e essa não custa uma palavra em cada frase.
  invoke("falar", { texto: quem + texto, chamador: folha.claude?.nome })
    .catch((e) => jlog(`falar: ${e}`));
}

/// Tira do texto o que é marcação para os olhos e não diz nada em voz alta.
function paraOuvido(t: string): string {
  return t
    .replace(/`+/g, "")
    .replace(/\*+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/// Espera uma condição sem travar nada; devolve mesmo se ela não vier.
function aguardar(pronto: () => boolean, limite: number): Promise<void> {
  return new Promise((resolve) => {
    const fim = Date.now() + limite;
    const tenta = () =>
      pronto() || Date.now() > fim ? resolve() : setTimeout(tenta, 50);
    tenta();
  });
}

/// O MessageDisplay chega em pedaços, um evento por `delta`. Só dá pra falar
/// quando a mensagem fecha — e como cada hook é um processo próprio, o pedaço
/// marcado como último pode chegar antes de um do meio.
async function remontar(folha: Folha, ev: EventoClaude) {
  if (!ev.message_id) return;
  let pedacos = remontagem.get(ev.message_id);
  if (!pedacos) remontagem.set(ev.message_id, (pedacos = new Map()));
  if (ev.delta) pedacos.set(ev.index ?? 0, ev.delta);
  if (!ev.final) return;

  const total = (ev.index ?? 0) + 1;
  await aguardar(() => pedacos.size >= total, 2000);
  remontagem.delete(ev.message_id);

  const inteiro = paraOuvido(
    [...pedacos.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).join(""),
  );
  if (!inteiro) return;

  // Mensagem curta se fala como veio; longa, o Haiku destila numa frase.
  const frase =
    inteiro.length <= LIMITE_RESUMO
      ? inteiro
      : paraOuvido(await invoke<string>("resumir", { texto: inteiro }).catch(() => ""));

  anunciar(folha, frase.slice(0, MAX_FALA));
}

/// As mensagens do Claude Code vêm em inglês; as recorrentes viram frase nossa,
/// o resto se fala como veio.
function aviso(msg: string): string {
  if (/permission|approve/i.test(msg)) return "precisa da sua permissão";
  if (/waiting|idle/i.test(msg)) return "está esperando você";
  return paraOuvido(msg).slice(0, MAX_FALA);
}

function receber(ev: EventoClaude) {
  const folha = folhaPorPainel(ev.painel);
  if (!folha) return; // o painel fechou antes do evento chegar

  // O nome da pasta é o que a voz usa e o que aparece na aba.
  const nome = ev.cwd?.split("/").filter(Boolean).pop() || `painel ${ev.painel}`;
  folha.claude = { nome, estado: folha.claude?.estado ?? "ocioso" };

  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
      folha.claude.estado = "trabalhando";
      break;
    case "PermissionRequest":
      folha.claude.estado = "esperando";
      anunciar(folha, "precisa da sua permissão");
      break;
    case "Notification":
      folha.claude.estado = "esperando";
      anunciar(folha, aviso(ev.message || ev.title || ""));
      break;
    case "MessageDisplay":
      remontar(folha, ev);
      return; // o estado não muda; pintar sairia à toa a cada pedaço
    case "SessionEnd":
      folha.claude = undefined;
      break;
  }
  pintar();
}

/// Pula pro próximo painel que está esperando, em qualquer aba. Repetir o
/// atalho percorre todos, e não fica preso no primeiro.
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

// ---------- envio automático ----------

/// Depois de você parar de falar, o ditado vai sozinho.
const ESPERA_ENVIO_MS = 5000;
/// O mesmo limiar que abaixa a voz do lado do Rust (LIMIAR_MIC). Se os dois
/// divergirem, a onda mostraria "falando" enquanto a contagem conta silêncio.
const LIMIAR_FALA = 0.1;
/// Enquanto a última sílaba for recente, a faixa mostra o parcial e não a
/// contagem — senão os dois brigariam pela mesma linha a cada 200 ms.
const PARCIAL_MANDA_MS = 800;

/// O Enter marcado: o painel que recebeu o ditado e quando ele vai.
let envio: { folha: Folha; em: number } | undefined;
let pulso: ReturnType<typeof setInterval> | undefined;
let ultimaFala = 0;

function pararPulso() {
  clearInterval(pulso);
  pulso = undefined;
}

/// Quem manda na faixa: enquanto a última sílaba for recente, o parcial; a
/// partir daí, a contagem. Os dois lados perguntam a MESMA coisa — se cada um
/// decidisse por conta, o parcial (que chega mesmo no silêncio, às vezes vazio)
/// e o pulso de 200 ms escreveriam por cima um do outro e a linha piscaria.
function parcialMandaNaFaixa() {
  return !envio || Date.now() - ultimaFala <= PARCIAL_MANDA_MS;
}

/// Fecha a faixa, ou volta ao parcial, conforme o microfone esteja aberto.
function encerrarContagem() {
  pararPulso();
  if (escutando) mostrarVoz("escutando…");
  else fecharVoz();
}

function agendarEnvio(folha: Folha) {
  envio = { folha, em: Date.now() + ESPERA_ENVIO_MS };
  if (!pulso) pulso = setInterval(baterEnvio, 200);
}

/// Voltou a falar: o Enter fica para depois.
function adiarEnvio() {
  if (envio) envio.em = Date.now() + ESPERA_ENVIO_MS;
}

/// Teclado tem a última palavra, e cancela de vez. Voltar a contar exige falar
/// de novo: reagendar no primeiro pico do microfone desfaria a escolha de quem
/// acabou de decidir digitar.
function cancelarEnvio() {
  if (!envio) return;
  envio = undefined;
  encerrarContagem();
}

function baterEnvio() {
  if (!envio) return pararPulso();

  // O painel pode ter fechado no meio da contagem.
  if (envio.folha.morta) {
    envio = undefined;
    return encerrarContagem();
  }

  const falta = envio.em - Date.now();
  if (falta > 0) {
    if (!parcialMandaNaFaixa()) {
      mostrarVoz(`↵ em ${Math.ceil(falta / 1000)}s — digite para cancelar`);
    }
    return;
  }

  const { folha } = envio;
  envio = undefined;
  invoke("pty_write", { id: folha.id, data: "\r" }).catch((e) => jlog(`envio: ${e}`));
  encerrarContagem();
}

// ---------- escuta: falar em vez de digitar ----------

const voz = document.getElementById("voz") as HTMLDivElement;
const vozOnda = voz.querySelector(".voz-onda") as HTMLSpanElement;
const vozTexto = voz.querySelector(".voz-texto") as HTMLSpanElement;

let escutando = false;
/// Segura um segundo ⌘E enquanto o modelo baixa — são centenas de MB.
let preparando = false;

/// Microfone aberto sem ninguém falando é bateria e privacidade indo embora, e
/// um Enter à espera de uma frase que não vem mais. Um minuto de silêncio e a
/// escuta se desliga sozinha — ⌘E a traz de volta.
const INATIVIDADE_MS = 60_000;
let vigia: ReturnType<typeof setInterval> | undefined;

/// Um instante por barrinha: a ~20 nivéis por segundo, são pouco mais de um
/// segundo de história na tela. As novas entram pela direita.
const ONDA_BARRAS = 22;
/// O silêncio não apaga a onda: uma linha fina ainda diz "estou aberto".
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
    // O mesmo ganho que a barra usava: fala normal enche a faixa sem estourar.
    const altura = Math.max(ONDA_MINIMA, Math.min(1, onda[i] * 3.2));
    ondaBarras[i].style.transform = `scaleY(${altura})`;
  }
}

function limparOnda() {
  onda.fill(0);
  for (const barra of ondaBarras) barra.style.transform = `scaleY(${ONDA_MINIMA})`;
}

/// A faixa cabe uma linha. Mostrar o começo de uma frase longa esconderia
/// justamente o que você acabou de falar, então corta pela frente.
function mostrarVoz(texto: string) {
  vozTexto.textContent = texto.length > 140 ? `…${texto.slice(-140)}` : texto;
}

/// Cala a faixa. O espaço dela fica: quem some é o conteúdo, não a linha.
function fecharVoz() {
  // Uma contagem em curso é a coisa mais importante na tela: um Enter está a
  // caminho de um shell, e apagar o aviso é pior que ele ficar mais um segundo.
  if (envio) return;
  vozTexto.textContent = "";
  voz.classList.remove("escutando");
  limparOnda();
}

function pararVigia() {
  clearInterval(vigia);
  vigia = undefined;
}

/// Fecha o microfone. Sai daqui e do vigia da inatividade — os dois desligam
/// pela mesma porta, para nenhum deixar o `escutando` mentindo.
async function pararEscuta() {
  escutando = false;
  pararVigia();
  voz.classList.remove("escutando");
  limparOnda();
  await invoke("escuta_parar").catch((e) => jlog(`escuta_parar: ${e}`));
}

/// Um minuto calado e o microfone fecha. Uma contagem em curso não atrasa nada:
/// ela vive 5 s, muito dentro da folga, e a última fala é recente por definição.
async function baterInatividade() {
  if (!escutando) return pararVigia();
  if (Date.now() - ultimaFala < INATIVIDADE_MS) return;
  await pararEscuta();
  // A faixa avisa por que emudeceu: silêncio sem explicação é igual a travado.
  mostrarVoz("escuta desligada — um minuto sem falar (⌘E para voltar)");
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
      mostrarVoz("baixando o modelo de transcrição (466 MB), uma vez só…");
      await invoke("escuta_baixar_modelo");
    }
    mostrarVoz("escutando…");
    await invoke("escuta_comecar");
    escutando = true;
    voz.classList.add("escutando");
    // Zerado, `ultimaFala` é 1970: o vigia mataria a escuta no primeiro tique.
    ultimaFala = Date.now();
    if (!vigia) vigia = setInterval(baterInatividade, 1000);
  } catch (e) {
    mostrarVoz(`não consegui escutar: ${e}`);
    setTimeout(fecharVoz, 4000);
  } finally {
    preparando = false;
  }
}

async function ligarEscuta() {
  // Parcial: o palpite enquanto você fala, reavaliado a cada 800 ms.
  await listen<string>("escuta://parcial", (e) => {
    if (parcialMandaNaFaixa()) mostrarVoz(e.payload);
  });

  // Final: o trecho fechou. Vai para o painel em foco AGORA, não para o que
  // estava em foco quando você começou a falar — é o que digitar faria.
  await listen<string>("escuta://final", (e) => {
    const texto = e.payload.trim();
    if (!texto || !ativa) return;
    // Espaço no fim: dois trechos seguidos grudariam numa palavra só.
    const folha = ativa.foco;
    invoke("pty_write", { id: folha.id, data: `${texto} ` })
      .catch((err) => jlog(`pty_write da voz: ${err}`));
    // Daqui pra frente silêncio vale como "acabei": a contagem começa.
    agendarEnvio(folha);
  });

  // O parcial fica parado enquanto você não fala; é a onda que mostra que o
  // microfone está aberto de verdade.
  await listen<number>("escuta://nivel", (e) => {
    empurrarOnda(e.payload);
    if (e.payload > LIMIAR_FALA) {
      ultimaFala = Date.now();
      adiarEnvio();
    }
  });

  await listen<number>("escuta://progresso", (e) => {
    mostrarVoz(`baixando o modelo de transcrição… ${Math.round(e.payload * 100)}%`);
  });

  await listen<string>("escuta://erro", (e) => {
    escutando = false;
    pararVigia();
    voz.classList.remove("escutando");
    limparOnda();
    mostrarVoz(`erro na escuta: ${e.payload}`);
    setTimeout(fecharVoz, 4000);
  });

  await listen("menu://escutar", () => alternarEscuta());

  // Ctrl+Espaço liga e desliga a voz. Sem indicador fixo em lugar nenhum, então
  // a própria faixa diz como ficou e depois se cala — o silêncio de uma voz
  // desligada é indistinguível do silêncio de uma que não tinha nada a dizer.
  await listen("menu://voz", async () => {
    try {
      const ligada = await invoke<boolean>("voz_alternar");
      // A faixa já tem dono: o parcial, ou uma contagem que não pode ser
      // tapada por um aviso passageiro.
      if (escutando || envio) return;
      mostrarVoz(ligada ? "voz ligada" : "voz desligada");
      setTimeout(fecharVoz, 1800);
    } catch (e) {
      jlog(`voz_alternar: ${e}`);
    }
  });
}

// ---------- caminhos: arrastar e colar arquivos ----------

/// Vários arquivos viram vários argumentos, cada um protegido por `citar`.
/// O espaço no fim é para o próximo
/// arquivo (ou o resto do comando) não colar no anterior.
const linhaDe = (caminhos: string[]) => caminhos.map(citar).join(" ") + " ";

/// Entrega o texto ao painel pelo caminho de colagem do xterm, não por
/// `pty_write` direto: é ele que embrulha em bracketed paste quando o programa
/// do outro lado pediu. Sem isso o Claude Code (e o vim, e o zsh) receberiam a
/// colagem como se cada caractere tivesse sido digitado.
function colar(folha: Folha, texto: string) {
  if (!texto) return;
  folha.term.paste(texto);
}

/// Qual painel está sob o ponteiro. O arrasto não passa pelo DOM — quem avisa é
/// o Tauri, e a posição vem em pixels físicos —, então a divisão pela escala da
/// tela é por nossa conta. `devicePixelRatio` e não o `scaleFactor` guardado no
/// início: a janela pode ter ido pra um monitor de outra densidade no meio.
function folhaEm(p: { x: number; y: number }): Folha | undefined {
  if (!ativa) return;
  const alvo = document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio);
  if (!alvo) return;
  for (const f of visiveis(ativa)) if (f.el.contains(alvo)) return f;
}

/// Arrastar um arquivo do Finder e soltar aqui escreve o caminho dele na linha,
/// no painel sob o ponteiro — não no que está com o teclado.
async function ligarArrastar() {
  let marcada: Folha | undefined;
  const marcar = (f?: Folha) => {
    if (marcada === f) return;
    marcada?.el.classList.remove("recebendo");
    marcada = f;
    marcada?.el.classList.add("recebendo");
  };

  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    // Com o diff na frente não há painel sob o ponteiro, e o painel com o
    // teclado está escondido: o caminho iria parar num terminal que ninguém vê.
    if (noDiff) return;
    if (payload.type === "leave") return marcar(undefined);
    if (payload.type !== "drop") return marcar(folhaEm(payload.position));

    // Soltar fora de um painel (na barra de abas, na faixa da voz) ainda tem um
    // destino óbvio: o painel que está com o teclado.
    const folha = folhaEm(payload.position) ?? ativa?.foco;
    marcar(undefined);
    if (!folha) return;
    // Soltar num painel também é escolhê-lo — o caminho aparece onde o cursor
    // está, e é ali que o resto do comando vai ser digitado.
    focar(folha);
    colar(folha, linhaDe(payload.paths));
  });
}

/// ⌘⇧V: o que está na área de transferência entra como caminho. O ⌘V comum cola
/// o texto que o Finder deixou junto — o *nome* do arquivo, sem pasta nenhuma,
/// que não serve de argumento. Sem arquivo na área, cola o texto e pronto: uma
/// tecla que não faz nada parece uma tecla quebrada.
async function colarCaminho() {
  if (!ativa || noDiff) return;
  const area = await invoke<{ arquivos: string[]; texto: string | null }>("area_colar");
  const folha = ativa.foco;
  if (area.arquivos.length) colar(folha, linhaDe(area.arquivos));
  else if (area.texto) colar(folha, area.texto);
}

// ---------- barra do painel: título, play, stop e diff ----------

/// O projeto em que um painel está, como o launch.json dele o descreve.
type Projeto = {
  pasta: string;
  home: string;
  /// As que o play roda: sem separadores nem as de CodeLens (ver `listaDoPlay`).
  configs: ConfigLaunch[];
  /// A lista do botão de escolher, com os títulos de grupo entre as configurações.
  menu: (ConfigLaunch | string)[];
  tarefas: Tarefa[];
  /// launch.json que não deu para ler: o play explica em vez de sumir.
  erro?: string;
};

/// Um app que o play de um painel mandou rodar. Roda na gaveta do painel, um
/// shell comum onde o comando é digitado: é assim que o app herda o PATH e o
/// resto do seu .zshrc — que é, quase sempre, o único lugar onde o `flutter`
/// está no PATH.
type Execucao = {
  /// O painel cujo play rodou o app.
  dono: Folha;
  /// O terminal da gaveta, onde o app roda.
  folha: Folha;
  pasta: string;
  nome: string;
  plano: Plano;
  rodando: boolean;
  parando?: boolean;
};

/// A barra de um painel. Cada painel tem a sua: com a tela dividida em dois
/// projetos, cada um tem o seu play, o seu app rodando e o seu diff.
type Barra = {
  el: HTMLDivElement;
  titulo: HTMLSpanElement;
  aviso: HTMLSpanElement;
  acoes: HTMLSpanElement;
  gaveta: HTMLButtonElement;
  parar: HTMLButtonElement;
  grupoPlay: HTMLDivElement;
  play: HTMLButtonElement;
  playIcone: HTMLSpanElement;
  playNome: HTMLSpanElement;
  escolher: HTMLButtonElement;
  diff: HTMLButtonElement;
  projeto: Projeto | null;
  /// Respostas de `carregarProjeto` chegando fora de ordem (vários `cd`
  /// seguidos) não podem sobrescrever a mais nova.
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
const ICONE_GAVETA = traco("M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM2 9.5h12");

function elemento<K extends keyof HTMLElementTagNameMap>(tag: K, classe: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = classe;
  return el;
}

/// Um botão da barra. O clique não tira o teclado do terminal: o `r` do hot
/// reload, digitado logo depois, continua indo para o app — e voltar da aba do
/// diff acha o painel com o cursor.
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
  const playIcone = elemento("span", "tarefa-icone");
  const playNome = elemento("span", "tarefa-nome");
  const play = botaoTarefa("tarefa-play", "");
  play.append(playIcone, playNome);
  const escolher = botaoTarefa("tarefa-escolher", ICONE_ESCOLHER);
  escolher.title = "Escolher a configuração do launch.json";
  const grupoPlay = elemento("div", "tarefa-play-grupo");
  grupoPlay.append(play, escolher);
  const diff = botaoTarefa("tarefa-diff", ICONE_DIFF);
  diff.title = "Diff da branch deste painel";
  controles.append(acoes, gaveta, parar, grupoPlay, diff);
  el.append(titulo, aviso, controles);
  return {
    el,
    titulo,
    aviso,
    acoes,
    gaveta,
    parar,
    grupoPlay,
    play,
    playIcone,
    playNome,
    escolher,
    diff,
    projeto: null,
    pedido: 0,
  };
}

function ligarBarra(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  b.play.addEventListener("click", () => {
    const cfg = configEscolhida(b.projeto);
    if (cfg) void executar(folha, cfg);
  });
  b.escolher.addEventListener("click", () => alternarMenu(folha));
  b.gaveta.addEventListener("click", () => alternarGaveta(folha));
  b.parar.addEventListener("click", () => {
    if (folha.execucao?.rodando) void parar(folha.execucao);
  });
  // O diff é de um repositório, e quem sabe qual é o painel: cada um tem o seu
  // diretório — com a tela dividida em três projetos, cada painel diz o seu.
  b.diff.addEventListener("click", () => void abrirDiff(folha));
}

function desenharBarra(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  b.titulo.textContent = folha.titulo;
  b.titulo.title = folha.titulo;

  const g = folha.gaveta;
  b.gaveta.hidden = !g;
  b.gaveta.classList.toggle("ligado", g?.aberta === true);
  b.gaveta.title = g?.aberta ? "Esconder o terminal do app" : "Mostrar o terminal do app";

  const ex = folha.execucao;
  const rodando = ex?.rodando === true;
  b.parar.hidden = !rodando;
  b.parar.title = ex ? `Parar ${ex.nome}` : "";
  b.acoes.replaceChildren();
  if (ex && rodando) {
    for (const acao of ex.plano.acoes ?? []) {
      const botao = botaoTarefa("tarefa-acao", "");
      botao.textContent = `${acao.icone} ${acao.rotulo}`;
      botao.title = `${acao.rotulo} — o mesmo que apertar ${acao.tecla} no terminal do app`;
      botao.addEventListener("click", () => {
        invoke("pty_write", { id: ex.folha.id, data: acao.tecla }).catch((e) => jlog(`ação: ${e}`));
      });
      b.acoes.append(botao);
    }
  }

  // Sem launch.json não há play: um botão apagado em todo shell seria ruído.
  const proj = b.projeto;
  b.grupoPlay.hidden = !proj;
  const cfg = configEscolhida(proj);
  const reiniciar = rodando && ex?.pasta === proj?.pasta && ex?.nome === cfg?.name;
  b.playIcone.innerHTML = reiniciar ? ICONE_REINICIAR : ICONE_PLAY;
  b.playNome.textContent = cfg?.name ?? "";
  b.play.disabled = !cfg;
  b.play.title =
    proj?.erro ?? (cfg ? `${reiniciar ? "Reiniciar" : "Rodar"} ${cfg.name}` : "O launch.json não tem configurações");
  b.escolher.hidden = (proj?.configs.length ?? 0) < 2;
}

/// Refeito na criação do painel e a cada título novo — um `cd` muda o título, e
/// pode ter mudado de projeto junto.
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
  if (achado) {
    const { pasta, home } = achado;
    let tarefasDoProjeto: Tarefa[] = [];
    try {
      tarefasDoProjeto = achado.tasks ? tarefasDe(achado.tasks) : [];
    } catch (e) {
      jlog(`tasks.json ilegível em ${pasta}: ${e}`);
    }
    try {
      novo = { pasta, home, ...listaDoPlay(configsDe(achado.launch)), tarefas: tarefasDoProjeto };
    } catch (e) {
      novo = { pasta, home, configs: [], menu: [], tarefas: [], erro: `launch.json ilegível: ${e}` };
    }
  }
  if (pedido !== b.pedido || folha.morta) return;
  b.projeto = novo;
  desenharBarra(folha);
}

/// A configuração que o play roda: a última escolhida neste projeto, ou a primeira.
function configEscolhida(projeto: Projeto | null): ConfigLaunch | undefined {
  if (!projeto) return;
  let nome: string | null = null;
  try {
    nome = localStorage.getItem(`termiau:config:${projeto.pasta}`);
  } catch {
    // Sem armazenamento, fica a primeira.
  }
  return projeto.configs.find((c) => c.name === nome) ?? projeto.configs[0];
}

function lembrarConfig(pasta: string, nome: string) {
  try {
    localStorage.setItem(`termiau:config:${pasta}`, nome);
  } catch {
    // Só uma conveniência.
  }
}

/// A lista de configurações. Uma só para a janela, posta junto do botão de quem
/// a abriu: dentro de um painel ela seria cortada pela borda dele.
const menuEl = elemento("div", "tarefa-menu");
let menuDe: Folha | undefined;

function montarMenu() {
  menuEl.hidden = true;
  document.body.append(menuEl);
  // Clicar fora fecha a lista, como qualquer menu. O botão que a abre fica de
  // fora: ele mesmo alterna.
  document.addEventListener("mousedown", (e) => {
    const alvo = e.target as Element;
    if (!menuEl.hidden && !menuEl.contains(alvo) && !alvo.closest?.(".tarefa-escolher")) fecharMenu();
  });
}

function fecharMenu() {
  menuEl.hidden = true;
  menuDe = undefined;
}

function alternarMenu(folha: Folha) {
  if (!menuEl.hidden && menuDe === folha) return fecharMenu();
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
      // Escolher só escolhe: quem roda é o play. A escolha vale para o projeto,
      // então os outros painéis nele passam a mostrar a mesma.
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
  const r = b.escolher.getBoundingClientRect();
  menuEl.style.top = `${r.bottom + 4}px`;
  menuEl.style.right = `${window.innerWidth - r.right}px`;
  // Um launch.json com dezenas de configurações passa da janela: a lista rola.
  menuEl.style.maxHeight = `${window.innerHeight - r.bottom - 12}px`;
  menuEl.hidden = false;
  menuEl.querySelector(".escolhida")?.scrollIntoView({ block: "nearest" });
  menuDe = folha;
}

/// Recado curto na barra, ao lado do título: o play que não pôde rodar diz por quê.
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
  if (!runner) return avisar(dono, `${cfg.name}: "type": "${cfg.type}" ainda não é suportado`);

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

  // Cada painel tem um terminal do app, na gaveta dele. Já existindo, é
  // reaproveitado — o que o play rodou lá antes para primeiro; um comando que
  // você mesmo digitou nele, ainda rodando, não é interrompido.
  let folha: Folha | undefined;
  const gaveta = dono.gaveta;
  if (gaveta) {
    folha = gaveta.folha;
    if (dono.execucao?.rodando) await parar(dono.execucao);
    else if (await invoke<boolean>("pty_ocupado", { id: folha.id }).catch(() => false)) {
      return avisar(dono, "o terminal do app está rodando outro comando");
    }
    // O shell pode ter andado de pasta desde a última vez.
    linha = `cd ${palavra(plano.cwd)} && ${linha}`;
  } else {
    folha = await criarGaveta(dono, plano.cwd);
    if (folha && !dono.gaveta?.aberta) avisar(dono, `${cfg.name} rodando no terminal do app, escondido — ▤ mostra`);
  }
  if (!folha || folha.morta || dono.morta) return;

  const ex: Execucao = { dono, folha, pasta: proj.pasta, nome: cfg.name, plano, rodando: true };
  dono.execucao = ex;
  await invoke("pty_write", { id: folha.id, data: `${linha}\r` }).catch((e) => jlog(`play: ${e}`));
  vigiar(ex);
  desenharBarra(dono);
}

// ---------- gaveta: o terminal do app ----------

/// Abre como você a deixou da última vez; na primeira, escondida.
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
    // Só uma conveniência.
  }
}

/// O terminal do app: embaixo do terminal do painel, dentro dele, e fora da
/// árvore de divisões — não é um lugar de trabalho, é a saída do que o play
/// rodou, e só aparece quando você pede. Nasce visível e só depois se esconde:
/// o xterm mede a letra ao abrir, e num elemento escondido a medida sairia
/// zero e a grade, quebrada.
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
    // O painel pode ter fechado enquanto o shell da gaveta abria.
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

/// A borda de cima da gaveta muda a altura dela, como o divisor muda a fatia.
function ligarAlca(dono: Folha, alca: HTMLDivElement, el: HTMLDivElement) {
  alca.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // senão o arrasto vira seleção de texto nos terminais
    alca.setPointerCapture(e.pointerId);
    const mover = (ev: PointerEvent) => {
      const r = dono.el.getBoundingClientRect();
      // Sobra sempre um pedaço dos dois lados: um terminal espremido a zero
      // fica sem grade para medir.
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

/// Mostra ou esconde a gaveta do painel. Aberta, ela recebe o teclado (é para
/// isso que se abre: ler e digitar); fechada, o teclado volta ao painel. O app
/// continua rodando nos dois casos.
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

/// O shell da gaveta saiu (`exit`, ⌘W com ela em foco): some a gaveta, e o app
/// que rodava nela vai junto.
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

/// O app acabou quando o shell volta a ser o dono do terminal. Duas leituras
/// seguidas: entre um comando e o próximo de uma linha com `&&` o shell fica na
/// frente por um instante, e uma leitura só daria o app por encerrado ali.
function vigiar(ex: Execucao) {
  const inicio = Date.now();
  let livre = 0;
  const tique = setInterval(async () => {
    if (ex.folha.morta || ex.dono.execucao !== ex || !ex.rodando) return clearInterval(tique);
    // O shell precisa de um instante para ler a linha e pôr o comando na frente.
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

/// Com calma primeiro, com força depois. O `q` do flutter run desliga o app no
/// aparelho; sem tecla própria vai Ctrl+C, que chega ao grupo inteiro — um
/// servidor e os filhos dele saem juntos. Quem não sair em alguns segundos leva
/// SIGKILL: um stop que às vezes não para é pior que um stop bruto.
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

// ---------- teclado ----------

function atalho(e: Atalho) {
  // Navegar entre painéis e limpar a tela são coisas do terminal: com o diff na
  // frente não há painel a que se referir.
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

  // ⌘1 é a aba presa: ela é a primeira da barra, então os terminais começam no
  // ⌘2. ⌘9 vai pra última, não pra nona — é o padrão do macOS.
  const n = Number(e.key);
  if (n === 1 && presa) return abrirPresa();
  const alvo = n === 9 ? abas[abas.length - 1] : abas[n - 2];
  if (alvo) ativar(alvo);
}

window.addEventListener("keydown", (e) => {
  if (!nossoAtalho(e)) return;
  e.preventDefault();
  atalho(e);
});

// A tecla apertada dentro da aba presa é de outro documento e não sobe até
// aqui: a ponte do differ a reenvia, e daqui ela vale igual. A origem é
// conferida no `source` — nenhuma outra janela fala com esta.
window.addEventListener("message", (e) => {
  if (!presa || e.source !== presa.quadro.contentWindow) return;
  const dado = e.data as { termiau?: Atalho; termiauPronto?: boolean } | null;

  // O differ avisa quando começa a ouvir. Um pedido que tenha chegado antes
  // disso estava guardado esperando exatamente este aviso.
  if (dado?.termiauPronto) {
    presa.pronta = true;
    const fila = presa.fila.splice(0);
    for (const msg of fila) presa.quadro.contentWindow?.postMessage(msg, "*");
    return;
  }

  if (dado?.termiau && nossoAtalho(dado.termiau)) atalho(dado.termiau);
});

// ---------- ciclo de vida ----------

async function iniciar() {
  // Medir a célula antes da fonte carregar dá largura errada em toda a grade.
  await document.fonts.ready;

  // O xterm troca o cursor pro estilo inativo quando o terminal perde o foco,
  // mas relê isso só ao redesenhar uma linha — e o app pode ir pro segundo plano
  // sem que a textarea receba `blur`. Sem nada disparando redesenho, a patinha
  // ficava piscando numa janela que não era mais a de cima. Quem sabe do
  // segundo plano é o evento da janela, então é dele que tiramos o blur.
  await janela.onFocusChanged(({ payload: focada }) => {
    if (!ativa || noDiff) return;
    if (!focada) ativa.foco.term.blur();
    // Se um clique já devolveu o teclado a um painel, não roubamos de volta.
    else if (document.activeElement?.tagName !== "TEXTAREA") ativa.foco.term.focus();
  });

  // Os hooks do Claude Code entram por aqui, via socket unix (ver ouvir_hooks
  // no Rust e hooks/termiau-evento.sh).
  await listen<string>("claude://evento", (e) => {
    try {
      receber(JSON.parse(e.payload) as EventoClaude);
    } catch (err) {
      jlog(`evento do claude ilegível: ${err}`);
    }
  });

  await ligarEscuta();

  // ⌘T, ⌘D, ⌘⇧D e ⌘W chegam por aqui: quem recebe a tecla é o menu nativo.
  await listen("menu://nova-aba", () => novaAba());
  await listen("menu://dividir-lado", () => dividir("lado"));
  await listen("menu://dividir-abaixo", () => dividir("abaixo"));
  await listen("menu://fechar", () => {
    if (ativa && !noDiff) fecharFolha(ativa.foco);
  });
  await listen("menu://colar-caminho", () => colarCaminho());
  await listen("menu://preferencias", () => abrirPreferencias());

  // O .git do repositório aberto na aba do diff mexeu. Só repassa: quem decide
  // o que fazer com isso é a aba, e ela só existe depois de alguém abri-la.
  await listen<string>("differ://mudou", (e) => {
    if (presa?.pronta) recado({ termiauMudou: e.payload });
  });

  await ligarArrastar();

  // Um reload da webview apaga as abas mas não os shells: sem isto eles ficariam
  // vivos, sem ninguém lendo, a cada recarga do dev server.
  await invoke("pty_close_all");
  // Antes da primeira aba: é o que põe o chip dela no começo da barra, e é de lá
  // que ela não sai — `ligarArrasto` só reordena o que está no array `abas`.
  montarMenu();
  criarPresa();
  await novaAba();

  // Redimensionamento da janela: só a aba visível tem dimensão pra medir; as
  // outras se ajustam quando voltam a aparecer (ver `ativar`).
  // Observa o body, NÃO os painéis: fit() altera o painel e realimentaria o observer.
  new ResizeObserver(() => {
    if (!ativa || noDiff) return;
    medir(ativa); // render local acompanha o arrasto, quadro a quadro
    agendarSync(ativa);
  }).observe(document.body);
}

// Numa função, não solto no módulo: `await` de topo não passa no alvo de build
// do Vite, e o `npm run build` quebraria mesmo com o dev funcionando.
iniciar();
