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
import { ESTACOES, type Estacao } from "./estacoes";
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
  /// A branch do painel em foco, logo depois do título do chip.
  ramo: Ramo;
  raiz: No;
  /// Painel que recebe o teclado; é o título dele que a aba mostra.
  foco: Folha;
  /// O painel que ocupa a aba inteira, com os outros escondidos por um tempo.
  /// Eles continuam vivos na árvore — recolher devolve o layout como estava.
  maximizada?: Folha;
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
  /// Há repositório aberto lá dentro. Quem diz é o próprio differ, que é quem
  /// sabe se abrir deu certo: mandar o cwd de um painel não garante que aquela
  /// pasta seja um repositório.
  repoAberto: boolean;
};
let presa: Presa | undefined;
/// A raiz do repositório aberto no diff, como o differ a reporta. É por ela que
/// os painéis daquele projeto acendem o botão de diff: o diff é de um
/// repositório, não de um painel, e dois painéis podem ser do mesmo.
let repoDoDiff: string | null = null;
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
  // Maximizado, só ele está na tela. Os escondidos guardam a grade que tinham,
  // como uma aba escondida: sem medida, nada de SIGWINCH pra zero.
  for (const f of aba.maximizada ? [aba.maximizada] : folhas(aba.raiz)) {
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

/// O grid tem três tracks: primeiro filho, vão, segundo filho. A espessura do
/// vão é o `--vao` do style.css — é a mesma medida que afasta os cartões dos
/// painéis um do outro e da borda da janela.
function aplicarFracao(d: Divisao) {
  const tracks = `${d.fracao}fr var(--vao) ${1 - d.fracao}fr`;
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
  // Ir pra um painel escondido (o ⌘⇧A, um que espera por você) é querer vê-lo:
  // o layout volta antes. A gaveta do maximizado está na tela, e fica.
  const dono = folha.dono ?? folha;
  if (aba.maximizada && aba.maximizada !== dono) recolher(aba);
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
  // A aba estava escondida (dimensão zero) e pode ter perdido redimensionamentos
  // da janela nesse meio-tempo: remede agora, antes de devolver o foco.
  medir(aba);
  sincronizar(aba);
  // A branch que chegou com a aba escondida mediu zero e não saiu andando.
  for (const f of visiveis(aba)) if (f.barra) repassear(f.barra.ramo);
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
  desenharMaximizar(folha);
  agendarProjeto(folha);
  return folha;
}

/// Quanto tempo o ✕ fica armado esperando o segundo clique. Curto de propósito:
/// é uma confirmação, não um modo — passou disso, a aba volta a ser uma aba.
const CONFIRMA_FECHAR = 1000;

/// Como desarmar a aba que está armada agora, se houver uma. Duas abas de
/// vermelho ao mesmo tempo diriam que as duas vão fechar, e só uma vai: armar
/// uma desarma a outra.
let desarmarFechar: (() => void) | undefined;

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
    const ramo = criarRamo("tab-ramo");
    const fechar = document.createElement("span");
    fechar.className = "tab-fechar";
    fechar.textContent = "✕";
    chip.append(sinal, rotulo, ramo.el, fechar);
    barra.appendChild(chip);

    const aba: Aba = { corpo, chip, rotulo, ramo, raiz: folha, foco: folha };
    folha.el.classList.add("focada");

    // Fechar aba não tem desfazer: o shell morre junto, e com ele o que estava
    // rodando ali. Por isso o ✕ pede duas vezes — o primeiro clique só acende o
    // anel de vermelho, que é o aviso de que é ESTA aba que vai embora, e o
    // segundo, dentro de CONFIRMA_FECHAR, é que fecha. Sem o segundo, o anel
    // se desfaz sozinho e nada aconteceu.
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
      // O ✕ fecha a aba inteira; no resto do chip, só ativa.
      if (e.target === fechar) {
        // Segundo clique dentro da janela: é o que ele queria mesmo.
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
        // Clicou no chip, não no ✕: mudou de ideia sobre fechar.
        desarmar();
        ativar(aba);
      }
    });
    // Botão do meio fecha, como no navegador. É um gesto que ninguém dá sem
    // querer, então este não passa pela confirmação.
    chip.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      desarmar();
      fecharAba(aba);
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
  // O iframe vai dentro de uma moldura, e não solto na aba: o canto arredondado
  // do cartão não corta o conteúdo de um iframe no WebKit — quem corta é um
  // elemento comum com `overflow:hidden` em volta dele.
  const moldura = elemento("div", "moldura");
  moldura.appendChild(quadro);
  corpo.appendChild(moldura);
  painel.appendChild(corpo);

  const chip = document.createElement("div");
  chip.className = "tab presa";
  chip.title = "Diff da branch";
  chip.innerHTML = ICONE_DIFF;
  barra.appendChild(chip);
  chip.addEventListener("mousedown", (e) => {
    if (e.button === 0) abrirPresa();
  });

  presa = { corpo, chip, quadro, pronta: false, fila: [], repoAberto: false };
  habilitarPresa(null);
}

/// Acende ou apaga o chip do diff. Uma aba que só sabe mostrar tela em branco
/// não se abre: enquanto não houver repositório, o chip fica apagado e o clique
/// nele não faz nada. O ⌘, continua entrando — as preferências moram lá, e não
/// dependem de repositório nenhum.
function habilitarPresa(raiz: string | null) {
  if (!presa) return;
  presa.repoAberto = !!raiz;
  repoDoDiff = raiz;
  presa.chip.classList.toggle("desabilitada", !raiz);
  // Acesa na mesma cor do botão de diff do painel de onde o repositório veio: os
  // dois ícones acesos ao mesmo tempo são o que liga um lugar ao outro.
  presa.chip.classList.toggle("ligado", !!raiz);
  const nome = raiz?.split("/").filter(Boolean).pop();
  presa.chip.title = raiz
    ? `Diff de ${nome ?? "repositório"}`
    : "Nenhum repositório aberto — use o botão de diff de um painel";
  // O botão de diff de cada painel diz se é aquele projeto que está lá dentro,
  // e quem está lá dentro acabou de mudar.
  for (const a of abas) for (const f of folhas(a.raiz)) desenharBarra(f);
}

/// O painel está no repositório que o diff mostra. São as duas raízes, e não a
/// pasta contra a raiz: um painel dentro de um submódulo está noutro
/// repositório, mesmo estando dentro da pasta deste.
function noRepoDoDiff(b: Barra): boolean {
  return !!repoDoDiff && b.repo === repoDoDiff;
}

/// Fala com a página do differ, guardando o recado se ela ainda não carregou.
function recado(msg: unknown) {
  if (!presa) return;
  if (presa.pronta) presa.quadro.contentWindow?.postMessage(msg, "*");
  else presa.fila.push(msg);
}

/// Leva o repositório do painel para a aba do diff e a traz para a frente.
async function abrirDiff(folha: Folha) {
  // Forçado: é este clique que vai dar um repositório a ela.
  abrirPresa(true);
  const cwd = await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null);
  if (cwd) recado({ termiauRepo: cwd });
}

/// ⌘, — as preferências moram no differ, que é quem tem o que configurar e
/// quem guarda o arquivo. Abrir a aba junto é parte do gesto.
function abrirPreferencias() {
  abrirPresa(true);
  recado({ termiauPrefs: true });
}

function abrirPresa(forcar = false) {
  if (!presa || noDiff) return;
  // Apagada: o clique no chip, o ⌘1 e o ciclo das abas passam por aqui e param.
  if (!presa.repoAberto && !forcar) return;
  if (ativa) {
    ativa.corpo.hidden = true;
    ativa.chip.classList.remove("ativa");
    // O xterm só troca o cursor pro estilo inativo quando lhe tiram o foco; sem
    // isto a patinha continuaria piscando atrás do diff.
    ativa.foco.term.blur();
  }
  noDiff = true;
  // A aba só se mantém em dia com a árvore de trabalho enquanto está à vista:
  // olhar o disco de segundo em segundo por trás de um terminal seria trabalho
  // jogado fora. Quem sabe se ela está à vista é daqui.
  recado({ termiauVisivel: true });
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
  recado({ termiauVisivel: false });
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
  // Dividir é mexer no layout, e ele tem de estar à vista pra isso.
  terminarAnimacao();
  if (aba.maximizada) recolher(aba, false);
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
    marcarMaximizada(aba);

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
  // A animação anda pelos cortes da árvore, e a árvore vai mudar.
  terminarAnimacao();
  // Fechou o maximizado: não há mais o que manter em tela cheia.
  if (aba.maximizada === folha) aba.maximizada = undefined;
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
  // Um escondido que fechou sozinho (um `exit`, o shell caiu) mudou a árvore
  // por baixo do maximizado: o caminho até ele é outro agora.
  marcarMaximizada(aba);

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

// ---------- maximizar ----------

/// Marca no DOM o caminho da raiz até o painel maximizado: é o que o CSS usa
/// pra esconder o resto sem tirar nada da árvore. Refeito a cada mudança nela.
/// Com um painel só não há o que esconder, e o estado se desfaz sozinho.
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

/// Mais curta que o `--tempo` do CSS: aquele é de sinais que acendem e apagam;
/// este é o layout inteiro andando, e ele tem de parecer resposta ao clique.
const DURACAO_MAXIMIZAR = 240;
const movimentoReduzido = matchMedia("(prefers-reduced-motion: reduce)");

/// A animação em curso, se houver. Terminar é pular pro último quadro: quem
/// mexe na árvore (dividir, fechar) ou alterna de novo no meio não espera.
let animacao: { terminar: () => void } | undefined;

function terminarAnimacao() {
  animacao?.terminar();
}

/// Um quadro do caminho até `m`, de 0 (o layout de sempre) a 1 (ele sozinho).
/// Cada corte do caminho entrega a fatia inteira ao lado de `m` e o vão fecha.
/// É o grid que anda, não um `transform`: escalar o terminal borraria o texto.
/// A grade do xterm não acompanha — quem está espremido é cortado pelo cartão,
/// e todo mundo é remedido uma vez só, no fim.
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
      // O grid volta às frações de verdade; com o painel maximizado quem manda
      // no layout é o CSS, e elas ficam guardadas pra quando recolher.
      for (let d = m.pai; d; d = d.pai) aplicarFracao(d);
      fim();
    },
  };
  animacao = esta;
  if (movimentoReduzido.matches) return esta.terminar();
  const quadro = (agora: number) => {
    const p = Math.min(1, (agora - inicio) / DURACAO_MAXIMIZAR);
    // Sai rápido e pousa devagar, como o resto das animações do app.
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
  // Os outros só somem no fim: até lá eles estão sendo espremidos, à vista.
  animarMaximizar(folha, 0, 1, () => {
    marcarMaximizada(aba);
    medir(aba);
    sincronizar(aba);
  });
}

/// `animar: false` é pra quem vai mexer na árvore logo em seguida (dividir):
/// o layout tem de estar no lugar já, não daqui a um quarto de segundo.
function recolher(aba: Aba, animar = true) {
  terminarAnimacao();
  const m = aba.maximizada;
  if (!m) return;
  const voltar = () => {
    // Os que estavam escondidos voltam com a grade de antes; a janela pode ter
    // mudado de tamanho nesse meio-tempo.
    medir(aba);
    sincronizar(aba);
    // O painel sai do lugar de tela cheia sem `blur`: reencosta o teclado.
    aba.foco.term.focus();
  };
  aba.maximizada = undefined;
  if (!animar) {
    marcarMaximizada(aba);
    return voltar();
  }
  // O grid é posto no último quadro ANTES de o CSS soltar os outros painéis:
  // tirar as classes com as frações de sempre no grid piscaria o layout todo.
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

  // O centro do painel de agora no outro eixo. Entre vários painéis à mesma
  // distância — um em cima e três embaixo —, vai para o mais alinhado com ele,
  // que é o do meio. De lá, os dos lados ficam a um passo cada.
  const centro = (q: DOMRect) => (horizontal ? q.top + q.height / 2 : q.left + q.width / 2);
  const meu = centro(r);

  let melhor: Folha | undefined;
  let menor = Infinity;
  let desvio = Infinity;
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
    const d = Math.abs(centro(q) - meu);
    // A folga de 2px absorve o arredondamento do grid: painéis da mesma fileira
    // podem começar meio pixel um do outro.
    if (passo < menor - 2 || (Math.abs(passo - menor) <= 2 && d < desvio)) {
      menor = passo;
      desvio = d;
      melhor = f;
    }
  }
  return melhor;
}

function irParaAba(delta: number) {
  // A aba presa entra no anel como qualquer outra — ela é a primeira da barra,
  // e ⌘⇧[ na aba seguinte tem de cair nela. Apagada ela fica de fora, a não ser
  // que seja ela que esteja na tela: o ⌘, abre as preferências sem repositório
  // nenhum, e de lá o ciclo tem de conseguir sair.
  const dentro = presa && (presa.repoAberto || noDiff);
  const anel: (Aba | Presa)[] = dentro ? [presa as Presa, ...abas] : [...abas];
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
};

function folhaPorPainel(id: number): Folha | undefined {
  for (const a of abas) for (const f of folhas(a.raiz)) if (f.id === id) return f;
  return undefined;
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
    // Abrir ou fechar um painel muda quantas pastas a aba tem.
    mostrarRamos(aba);
  }
  janela.setBadgeCount(esperando || undefined).catch(() => {});
}

function receber(ev: EventoClaude) {
  const folha = folhaPorPainel(ev.painel);
  if (!folha) return; // o painel fechou antes do evento chegar

  // O nome da pasta é o que aparece na aba.
  const nome = ev.cwd?.split("/").filter(Boolean).pop() || `painel ${ev.painel}`;
  folha.claude = { nome, estado: folha.claude?.estado ?? "ocioso" };

  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
      folha.claude.estado = "trabalhando";
      break;
    case "PermissionRequest":
    case "Notification":
      folha.claude.estado = "esperando";
      break;
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
/// Acima disto o pico do microfone conta como fala: é o que a onda desenha e o
/// que segura a contagem do Enter enquanto você ainda está falando.
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
  /// O nome da configuração escolhida. Mora no botão de escolher, não no play:
  /// é o rótulo da lista, e é clicando nele que se troca de configuração.
  nome: HTMLSpanElement;
  escolher: HTMLButtonElement;
  diff: HTMLButtonElement;
  maximizar: HTMLButtonElement;
  projeto: Projeto | null;
  /// A raiz do repositório git em que o shell deste painel está, ou `null` se
  /// ele não estiver em nenhum. É ela que diz se o botão de diff tem para onde
  /// levar, e é por ela que se sabe se o diff aberto é o deste painel.
  repo: string | null;
  /// A pasta do shell e a branch dela. Quem decide se a branch aparece na
  /// barra é `mostrarRamos`: só quando os painéis da aba não estão todos na
  /// mesma pasta — senão a do chip da aba já diz tudo.
  pasta: string | null;
  branch: string | null;
  ramo: Ramo;
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
const ICONE_MAXIMIZAR = traco("M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9");
const ICONE_RECOLHER = traco("M13.5 2.5 9 7M9 3.5V7h3.5M2.5 13.5 7 9M7 12.5V9H3.5");
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
  // Dois botões, e não um partido: o play roda, o dropdown escolhe. Enquanto o
  // nome da configuração morava dentro do play, a caixa inteira parecia uma
  // lista — e clicar no nome, que é o alvo maior e o que mais parece rótulo de
  // dropdown, rodava o app. Agora o nome é do dropdown, e o play é só o ▶.
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
  diff.title = "Diff da branch deste painel";
  const maximizar = botaoTarefa("tarefa-maximizar", ICONE_MAXIMIZAR);
  // Quem decide se aparece é `desenharMaximizar`, quando a folha já tem aba.
  maximizar.hidden = true;
  controles.append(acoes, gaveta, parar, grupoPlay, diff, maximizar);
  const ramo = criarRamo("tarefa-ramo");
  el.append(titulo, ramo.el, aviso, controles);
  return {
    el,
    titulo,
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
    maximizar,
    projeto: null,
    repo: null,
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
  b.maximizar.addEventListener("click", () => alternarMaximizar(folha));
  // Duplo clique na barra faz o mesmo — o alvo grande, como a barra de título
  // de uma janela. Nos botões dela, não: dois cliques no play são dois plays.
  b.el.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    alternarMaximizar(folha);
  });
}

/// O botão só existe com a tela dividida: com um painel só ele já é a aba toda.
function desenharMaximizar(folha: Folha) {
  const b = folha.barra;
  const aba = abaDe(folha);
  if (!b || !aba) return;
  const cheio = aba.maximizada === folha;
  b.maximizar.hidden = aba.raiz.tipo === "folha";
  b.maximizar.classList.toggle("ligado", cheio);
  b.maximizar.innerHTML = cheio ? ICONE_RECOLHER : ICONE_MAXIMIZAR;
  b.maximizar.title = cheio ? "Recolher — ver os outros painéis (⌘⇧↩)" : "Ocupar a aba toda (⌘⇧↩)";
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

  // Fora de um repositório o diff não tem o que mostrar: o botão some, como o
  // play some onde não há launch.json — um botão apagado em todo shell é ruído.
  // Roxo quando é este repositório que está aberto no diff: a mesma cor que
  // acende no chip da aba de lá, e é o par de ícones acesos que liga um ao outro.
  const noDiffAgora = noRepoDoDiff(b);
  b.diff.hidden = !b.repo;
  b.diff.classList.toggle("ligado", noDiffAgora);
  b.diff.title = noDiffAgora
    ? "Este projeto está aberto na aba do diff"
    : "Diff da branch deste painel";

  // Sem launch.json não há play: um botão apagado em todo shell seria ruído.
  const proj = b.projeto;
  b.grupoPlay.hidden = !proj;
  const cfg = configEscolhida(proj);
  const reiniciar = rodando && ex?.pasta === proj?.pasta && ex?.nome === cfg?.name;
  b.playIcone.innerHTML = reiniciar ? ICONE_REINICIAR : ICONE_PLAY;
  b.play.disabled = !cfg;
  b.play.title =
    proj?.erro ?? (cfg ? `${reiniciar ? "Reiniciar" : "Rodar"} ${cfg.name}` : "O launch.json não tem configurações");

  // Com uma configuração só não há o que escolher, mas o nome continua sendo a
  // única pista do que o ▶ vai rodar. Então o botão fica, sem a seta e sem o
  // clique: vira rótulo. Some de vez só quando não há nome nenhum a mostrar.
  const varias = (proj?.configs.length ?? 0) > 1;
  b.nome.textContent = cfg?.name ?? "";
  b.escolher.hidden = !cfg;
  b.escolher.disabled = !varias;
  b.escolher.classList.toggle("rotulo", !varias);
  b.escolher.title = varias ? "Escolher a configuração do launch.json" : (cfg?.name ?? "");
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
  // Sem repositório o botão de diff não tem para onde levar, e um `cd` pode ter
  // tirado o painel de um ou posto ele em outro.
  const raiz = cwd
    ? await invoke<string | null>("repo_root", { path: cwd }).catch(() => null)
    : null;
  // Fora de repositório nem pergunta. Com o HEAD solto também volta nulo: não
  // há nome de branch para mostrar.
  const branch = raiz
    ? await invoke<string | null>("repo_branch", { path: cwd }).catch(() => null)
    : null;
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
  b.repo = raiz;
  b.projeto = novo;
  b.pasta = cwd;
  b.branch = branch;
  const aba = abaDe(folha);
  if (aba) mostrarRamos(aba);
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
/// O vão entre o botão e a lista.
const VAO_MENU = 4;
/// Quanto a lista guarda da borda da janela. Encostada, ela parece cortada
/// mesmo quando cabe inteira.
const MARGEM_MENU = 24;
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
  // Mede a lista na altura natural antes de decidir onde ela vai: é essa altura
  // que diz se cabe embaixo. Tudo no mesmo quadro, então nada pisca.
  menuEl.style.maxHeight = "";
  menuEl.style.top = "0px";
  menuEl.style.bottom = "";
  menuEl.hidden = false;
  const altura = menuEl.offsetHeight;

  const r = b.escolher.getBoundingClientRect();
  menuEl.style.right = `${window.innerWidth - r.right}px`;
  const embaixo = window.innerHeight - r.bottom - VAO_MENU - MARGEM_MENU;
  const emCima = r.top - VAO_MENU - MARGEM_MENU;
  // Abre para baixo, como todo dropdown. Sobe só quando embaixo não cabe e em
  // cima há mais espaço: um painel na metade de baixo da janela tem a barra
  // perto da borda, e embaixo dela a lista teria dois itens de altura — ou
  // nenhum, que era o que acontecia quando a conta dava negativa e o navegador
  // jogava o max-height fora. Nos dois lados a altura é limitada ao espaço que
  // sobra: um launch.json com dezenas de configurações rola em vez de vazar.
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

// ---------- rádio: a do rodapé ----------

/// A lista mora no `estacoes.ts`, com a explicação de onde ela vem e do que o
/// `espectro` de cada uma quer dizer.
const estacoes = ESTACOES;

/// A estação de agora vai guardada pelo endereço, e não pelo índice: a lista é
/// refeita a cada sondagem, e o índice passaria a apontar para outra. O volume é
/// um número de 0 a 100.
const CHAVE_ATUAL = "termiau:radio:atual";
const CHAVE_VOLUME = "termiau:lofi:volume";

/// Os cinco estágios do volume. Um clique sobe um; depois do cheio, mudo. É o
/// que cabe num rodapé de 30px: um slider precisa de um alvo comprido para o
/// ponteiro andar, e comprido é exatamente o que não sobra aqui.
///
/// Fica AQUI, e não lá embaixo com o botão que o usa: o `volumeLofi` logo abaixo
/// já o lê, e uma `const` declarada depois disso não existe ainda na hora de
/// ler. O `tsc` não pega — a leitura acontece dentro de uma função, e de lá ele
/// não sabe dizer quem roda antes de quem. O app é que não sobe: `ReferenceError:
/// Cannot access 'VOLUMES' before initialization`, e a janela fica branca.
const VOLUMES = [0, 25, 50, 75, 100];

/// O valor guardado pode ser de uma versão em que o volume era contínuo — ou
/// qualquer número entre 0 e 100. Encaixa no estágio mais próximo: um volume
/// fora da escada não teria como subir um degrau.
const estagio = (v: number): number =>
  VOLUMES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/// Chave ausente e chave com lixo dão no mesmo: o padrão. `Number(null)` é 0, e
/// sem a checagem de nulo o volume nasceria mudo na primeira execução.
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
// ---------- rádio: os controles do rodapé ----------

const ICONE_PAUSA = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="1"/><rect x="9" y="3.5" width="3" height="9" rx="1"/></svg>`;
const ICONE_ESTACOES = traco("M3.5 4.5h9M3.5 8h9M3.5 11.5h9");
const ICONE_PROXIMA = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="10.7" y="3.6" width="1.7" height="8.8" rx=".85"/><path d="M3.8 4.2v7.6a.6.6 0 0 0 .92.5l5.2-3.8a.6.6 0 0 0 0-1L4.72 3.7a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICONE_TIRAR = traco("M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4");

const lofiEl = document.getElementById("lofi") as HTMLDivElement;

/// Como os botões da barra do painel: o clique não tira o teclado do terminal.
/// Você aperta o ▶ e continua digitando de onde parou.
function botaoLofi(classe: string, icone: string, titulo: string): HTMLButtonElement {
  const b = elemento("button", `lofi-btn ${classe}`);
  b.innerHTML = icone;
  b.title = titulo;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/// No lugar onde morava a seta de voltar. Com quarenta e seis estações, andar
/// para trás de uma em uma não leva a lugar nenhum — a lista leva.
const lofiEstacoes = botaoLofi("lofi-estacoes", ICONE_ESTACOES, "Estações (lista)");
const lofiTocar = botaoLofi("lofi-tocar", ICONE_PLAY, "Tocar");
const lofiProxima = botaoLofi("lofi-proxima", ICONE_PROXIMA, "Próxima estação");

/// O anel tem raio 5,5 no viewBox de 16 — o perímetro é o comprimento do traço
/// inteiro, e é dele que sai a fração acesa.
const VOLUME_ANEL = 2 * Math.PI * 5.5;

const ICONE_VOLUME = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="anel" cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${VOLUME_ANEL}" stroke-dashoffset="${VOLUME_ANEL}"/><path class="corte" d="M5.1 5.1l5.8 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const lofiVolume = botaoLofi("lofi-volume", ICONE_VOLUME, "Volume");
const volumeAnel = lofiVolume.querySelector(".anel") as SVGCircleElement;
const volumeCorte = lofiVolume.querySelector(".corte") as SVGPathElement;

/// O anel acende de cima para baixo no sentido do relógio (daí o `rotate(-90)`
/// no ícone): cheio é uma volta inteira, mudo é um corte e nenhum traço.
function desenharVolume() {
  volumeAnel.style.strokeDashoffset = String(VOLUME_ANEL * (1 - volumeLofi / 100));
  // `style.display`, e não o atributo `hidden`: num SVG dentro de HTML o
  // `hidden` não apaga nada sem uma regra de CSS para ele.
  volumeCorte.style.display = volumeLofi > 0 ? "none" : "";
  const proximo = VOLUMES[(VOLUMES.indexOf(volumeLofi) + 1) % VOLUMES.length];
  lofiVolume.title = `${volumeLofi === 0 ? "Mudo" : `Volume ${volumeLofi}%`} — clique para ${
    proximo === 0 ? "mudo" : `${proximo}%`
  }`;
}

const lofiTitulo = elemento("span", "lofi-titulo");
/// A caixa tem largura fixa; quem anda é este de dentro.
const lofiTituloTexto = elemento("span", "lofi-titulo-texto");
lofiTitulo.appendChild(lofiTituloTexto);

/// Quanto tempo o texto leva para andar um pixel. ~33 px/s: dá para ler sem
/// correr atrás, e é devagar o bastante para não puxar o olho de quem está
/// olhando o terminal.
const TITULO_MS_POR_PX = 30;
/// A parada, depois de ter passado o texto todo. É o estado normal da faixa —
/// o passeio é a exceção, e acontece duas vezes por minuto.
const TITULO_PARADA_MS = 30_000;
/// Um beco no fim, com o rabo do texto à vista, antes de voltar ao começo. Sem
/// ele a última palavra apareceria e sumiria no mesmo quadro.
const TITULO_FIM_MS = 1_500;
/// E um no começo, para o texto novo ser lido do início antes de sair andando.
const TITULO_INICIO_MS = 1_200;

/// Um `[branch]`: os colchetes fora, o nome numa caixa com teto de largura, e
/// o que não cabe passeia lá dentro como o nome da estação da rádio.
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

/// Só mexe quando o nome ou a visibilidade mudam: refazer o passeio a cada
/// prompt o deixaria preso no primeiro pixel.
function exibirRamo(r: Ramo, nome: string | null) {
  const novo = nome ?? "";
  if (r.texto.textContent === novo && r.el.hidden === !nome) return;
  r.texto.textContent = novo;
  r.el.hidden = !nome;
  r.el.title = nome ? `Branch ${nome}` : "";
  passear(r.caixa, r.texto);
}

/// Mede de novo quem ficou sem passeio por ter chegado escondido (medindo zero).
function repassear(r: Ramo) {
  if (!r.el.hidden && !passeios.has(r.caixa)) passear(r.caixa, r.texto);
}

/// O chip da aba mostra a branch do painel em foco. Os painéis mostram a deles
/// só quando nem todos estão na mesma pasta: com todos juntos, repetir em cada
/// barra o que o chip já diz é só ruído.
function mostrarRamos(aba: Aba) {
  const barras = [...folhas(aba.raiz)].flatMap((f) => (f.barra ? [f.barra] : []));
  const misturadas = new Set(barras.map((b) => b.pasta)).size > 1;
  for (const b of barras) exibirRamo(b.ramo, misturadas ? b.branch : null);
  exibirRamo(aba.ramo, aba.foco.barra?.branch ?? null);
}

/// O passeio em curso de cada caixa. É por caixa porque são várias: a rádio e
/// a branch de cada painel.
const passeios = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/// Põe o texto para passear quando ele não cabe na caixa: anda até o fim, dá
/// um tempo, volta ao começo e para trinta segundos — e de novo. Cabendo, não
/// faz nada: passear um texto inteiro à vista seria só mexer por mexer.
///
/// Chamada só quando o texto MUDA. A cada evento do áudio o rodapé se redesenha,
/// e refazer o passeio em cada um o deixaria preso no primeiro pixel.
function passear(caixa: HTMLElement, texto: HTMLElement) {
  clearTimeout(passeios.get(caixa));
  passeios.delete(caixa);
  texto.style.transition = "none";
  texto.style.transform = "translateX(0)";

  // Antes da janela aparecer tudo mede zero. Não é caso de erro: o próximo
  // texto — e sempre vem um — mede de novo com a caixa já na tela.
  const sobra = texto.scrollWidth - caixa.clientWidth;
  if (sobra <= 1) return;

  const andar = () => {
    const quanto = sobra * TITULO_MS_POR_PX;
    texto.style.transition = `transform ${quanto}ms linear`;
    texto.style.transform = `translateX(${-sobra}px)`;
    passeios.set(caixa, setTimeout(voltar, quanto + TITULO_FIM_MS));
  };

  const voltar = () => {
    // De volta ao começo sem transição: o caminho de volta não tem nada para
    // ler, e desandar o texto na frente de quem leu é pior que um corte.
    texto.style.transition = "none";
    texto.style.transform = "translateX(0)";
    passeios.set(caixa, setTimeout(andar, TITULO_PARADA_MS));
  };

  passeios.set(caixa, setTimeout(andar, TITULO_INICIO_MS));
}

const passearTitulo = () => passear(lofiTitulo, lofiTituloTexto);

/// O que está escrito na faixa agora, para saber quando mudou de verdade.
let tituloNoAr: string | undefined;

// ---------- rádio: o som ----------

/// São DOIS elementos, e não um, porque o Web Audio não serve para toda
/// estação.
///
/// Uma fonte de outra origem que não libera CORS entra no grafo zerada — e como
/// o grafo é quem fala com o alto-falante, ela tocaria em silêncio. Medido: das
/// 312 sondadas, 249 mandavam `Access-Control-Allow-Origin` no cabeçalho e só
/// 56 entregam amostra de verdade. O cabeçalho não basta.
///
/// Então a estação que entrega vai pelo `audioGrafo`, com espectro e ganho; a
/// que não entrega vai pelo `audioDireto`, que nunca entra no grafo e sai
/// direto no alto-falante. Um elemento não pode ser os dois: o
/// `createMediaElementSource` é para sempre, e depois dele o som do elemento
/// não volta a sair sozinho.
const audioGrafo = new Audio();
audioGrafo.crossOrigin = "anonymous";
audioGrafo.preload = "none";

const audioDireto = new Audio();
audioDireto.preload = "none";

/// O que está tocando agora — um dos dois de cima.
let audio = audioGrafo;

let tocandoLofi = false;
let carregandoLofi = false;
/// Se você pediu play. É o que separa um stream que caiu de um `src` que nós
/// mesmos tiramos ao pausar.
let noAr = false;
/// Sem rede, ou estação fora do ar: o motivo toma o lugar do nome até o próximo
/// clique que der certo. A faixa cabe uma linha, e o nome pode esperar.
let avisoLofi: string | undefined;
// ---------- rádio: o analisador de espectro ----------

/// Uma coluna por faixa de frequência, cada uma recortada em segmentos como um
/// mostrador de LEDs, com o pico que fica no ar e desce sozinho.
///
/// As alturas são MEDIDAS: saem de uma FFT do áudio que está tocando, que é
/// nosso e veio com CORS. Até a v1 eram modeladas — uma curva de lofi inventada
/// em cima de um relógio — porque o som vinha de dentro de um iframe do YouTube
/// e não havia amostra a que chegar.
const SPEC_BANDAS = 10;
/// Cinco segmentos de 2px com 1px de vão dão exatamente os 14px da faixa.
const SPEC_SEGMENTOS = 5;
/// O mesmo compasso da onda da escuta: ~20 quadros por segundo.
const SPEC_MS = 50;
/// Quanto o nível e o pico caem por quadro. O pico desce bem mais devagar — é
/// disso que ele serve, de deixar no ar por um instante o que já passou. A
/// subida não tem freio: é o ataque que faz um mostrador parecer um VU.
const SPEC_QUEDA = 0.075;
const SPEC_QUEDA_PICO = 0.014;
/// 2048 pontos a 48 kHz dão raias de ~23 Hz. Com 512 as raias saíam a ~94 Hz e
/// as três primeiras bandas caíam todas nas duas primeiras raias — três colunas
/// mostrando a mesma coisa, e a primeira delas mostrando a raia DC, que não é
/// som nenhum.
const SPEC_FFT = 2048;
/// A faixa que o mostrador cobre. Abaixo de 40 Hz é ronco de sala, e acima de
/// 16 kHz um MP3 de 128 kbps não guarda nada: as duas pontas só gastariam
/// coluna para mostrar chão.
const SPEC_HZ_MIN = 40;
const SPEC_HZ_MAX = 16_000;
/// Quantos dB o mostrador cobre, do chão ao topo da coluna. Medido: numa faixa
/// de electronic, cada banda vive uns 7 dB abaixo do próprio pico, e as de cima
/// uns 14. Com 16 dB de escala isso vira três segmentos acesos no corpo da
/// música e cinco nos picos — que é um mostrador respirando, e não uma parede.
const SPEC_ALCANCE = 16;
/// O teto de cada banda é MÓVEL: sobe no pico e desce sozinho, ~1,2 dB/s. É o
/// que faz o mostrador valer para qualquer estação. Um teto fixo não existe:
/// medido no Groove Salad, a banda mais grave vive a -45 dB e a mais aguda a
/// -77, e essa distância muda com o gênero. Era isso que deixava tudo no topo.
const SPEC_REF_QUEDA = 0.06;
/// Só que o teto não desce para sempre: sem um piso, o silêncio entre faixas
/// viraria ganho infinito e o chiado subiria até o topo.
const SPEC_REF_MINIMA = -58;

const lofiSpec = elemento("span", "spec");
lofiSpec.setAttribute("aria-hidden", "true");

const specNiveis = new Array<number>(SPEC_BANDAS).fill(0);
const specPicos = new Array<number>(SPEC_BANDAS).fill(0);
/// O teto de cada banda, em dB. Começa no piso: a primeira música que entrar o
/// levanta, e levantar é imediato.
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

/// O Web Audio se monta uma vez só, e no primeiro ▶ — não no boot. Um
/// `AudioContext` criado à toa nasce suspenso e mesmo assim prende a saída de
/// som do sistema à página: o indicador de áudio acenderia numa janela calada.
///
/// `createMediaElementSource` desvia o `<audio>` para dentro do grafo: a partir
/// daí só se ouve o que chega em `destination`, e esquecer de ligar essa ponta
/// é o jeito clássico de ficar sem som nenhum.
function ligarAnalisador(): AudioAnalisador {
  if (analisador) return analisador;
  const contexto = new AudioContext();
  const no = contexto.createAnalyser();
  no.fftSize = SPEC_FFT;
  // O amortecimento do próprio analisador faz metade do trabalho do VU; o resto
  // é a queda lenta do `SPEC_QUEDA`.
  no.smoothingTimeConstant = 0.6;

  // O volume mora aqui, num ganho, e não no `volume` do `<audio>`: desviado o
  // elemento para dentro do grafo, o WebKit para de aplicar aquele atributo —
  // ele aceita o valor, o `a.volume` passa a valer o que você pôs e o som sai
  // igual. Dá para ver num analisador: com `volume = 0` a amostra continua
  // cheia. O slider girava à toa.
  const ganho = contexto.createGain();
  ganho.gain.value = volumeLofi / 100;

  // O analisador vem ANTES do ganho: o mostrador mede a música, não o quanto
  // você escolheu ouvir dela. É a medição pré-fader de qualquer mesa — no
  // volume baixo as colunas continuam contando o que está tocando, em vez de
  // morrerem no chão junto com o som.
  contexto.createMediaElementSource(audio).connect(no);
  no.connect(ganho);
  ganho.connect(contexto.destination);

  // Bandas espaçadas em oitavas, e não em partes iguais: o ouvido ouve assim, e
  // em partes iguais as nove primeiras colunas cairiam todas no grave enquanto
  // a última sozinha cobriria metade do espectro.
  const porRaia = contexto.sampleRate / SPEC_FFT;
  const razao = (SPEC_HZ_MAX / SPEC_HZ_MIN) ** (1 / SPEC_BANDAS);
  // Cada banda começa onde a anterior acabou e tem pelo menos uma raia. Sem as
  // duas regras as primeiras bandas se empilham na mesma raia, porque lá
  // embaixo o passo em Hz é menor que a resolução da FFT. E o começo é a raia
  // 1: a 0 é a componente contínua, que não é som e não sai do lugar.
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

/// De 0..1 para a altura em pixels, encaixada na grade dos segmentos: é o
/// degrau que faz o mostrador parecer LED e não uma barra lisa esticando.
function alturaSpec(v: number): number {
  const acesos = Math.round(Math.max(0, Math.min(1, v)) * SPEC_SEGMENTOS);
  return acesos === 0 ? 0 : acesos * 3 - 1;
}

function moverSpec() {
  const a = analisador;
  if (!a) return;
  // Em dB crus, e não no byte de `getByteFrequencyData`: aquele já vem espremido
  // numa janela fixa de -100 a -30 dB, e é justamente a janela que não pode ser
  // fixa. Com o número solto, quem decide a escala é o teto móvel aqui embaixo.
  a.no.getFloatFrequencyData(a.raias);

  for (let b = 0; b < SPEC_BANDAS; b++) {
    const { de, ate } = a.bandas[b];
    // O maior da banda, e não a média: a média de uma banda larga do agudo
    // afoga o prato no silêncio que está do lado dele.
    let maior = -Infinity;
    for (let r = de; r < ate && r < a.raias.length; r++) maior = Math.max(maior, a.raias[r]);
    // Silêncio digital vem como -Infinity, que não se compara nem se soma.
    if (!Number.isFinite(maior)) maior = SPEC_REF_MINIMA - SPEC_ALCANCE;

    // O teto sobe de uma vez e desce devagar. É o que dá ao mostrador a mesma
    // escala útil num drone e num metal, sem tabela de gênero nenhuma.
    specRefs[b] = Math.max(
      SPEC_REF_MINIMA,
      maior > specRefs[b] ? maior : specRefs[b] - SPEC_REF_QUEDA,
    );
    const alvo = Math.max(0, Math.min(1, 1 - (specRefs[b] - maior) / SPEC_ALCANCE));

    // Sobe no quadro, desce aos poucos.
    specNiveis[b] = alvo > specNiveis[b] ? alvo : Math.max(0, specNiveis[b] - SPEC_QUEDA);
    specPicos[b] = Math.max(specNiveis[b], specPicos[b] - SPEC_QUEDA_PICO);

    const { nivel, pico } = specColunas[b];
    const alto = alturaSpec(specNiveis[b]);
    const altoPico = alturaSpec(specPicos[b]);
    nivel.style.height = `${alto}px`;
    // O pico só aparece acima da barra: em cima dela não diria nada.
    pico.hidden = altoPico <= alto;
    pico.style.bottom = `${Math.max(0, altoPico - 2)}px`;
  }
}

let pulsoSpec: ReturnType<typeof setInterval> | undefined;

/// Liga e desliga a animação. A saída rápida importa: `desenharLofi` roda a cada
/// evento do áudio, e reiniciar o intervalo em cada um faria o mostrador andar
/// aos trancos.
function animarSpec(ligado: boolean) {
  if (ligado === !!pulsoSpec) return;
  clearInterval(pulsoSpec);
  pulsoSpec = undefined;
  if (ligado) {
    pulsoSpec = setInterval(moverSpec, SPEC_MS);
    return;
  }
  // Parado, tudo no chão: um mostrador congelado no meio pareceria travado.
  specNiveis.fill(0);
  specPicos.fill(0);
  specRefs.fill(SPEC_REF_MINIMA);
  for (const { nivel, pico } of specColunas) {
    nivel.style.height = "0px";
    pico.hidden = true;
  }
}

// ---------- rádio: o rodapé ----------

/// As que prometiam espectro e vieram mudas — só nesta sessão. A marca no
/// `estacoes.ts` foi medida um dia; servidor muda de configuração, e quem manda
/// é o que está acontecendo agora.
const semEspectro = new Set<string>();

const usaGrafo = (e: Estacao): boolean => e.espectro && !semEspectro.has(e.url);

function desenharLofi() {
  const e = atual();
  lofiTocar.innerHTML = tocandoLofi ? ICONE_PAUSA : ICONE_PLAY;
  lofiTocar.title = tocandoLofi ? "Pausar" : "Tocar";
  lofiTocar.disabled = !e;
  lofiProxima.disabled = estacoes.length < 2;
  lofiEl.classList.toggle("tocando", tocandoLofi);
  lofiEl.classList.toggle("carregando", carregandoLofi && !tocandoLofi);

  const texto = avisoLofi ?? e?.nome ?? "sem estações";
  if (texto !== tituloNoAr) {
    tituloNoAr = texto;
    lofiTituloTexto.textContent = texto;
    lofiTitulo.title = texto;
    passearTitulo();
  }

  // O mostrador só anda quando há o que medir: pelo caminho direto não há
  // amostra, e dez colunas paradas no chão dizem isso melhor que dez colunas
  // inventadas.
  animarSpec(tocandoLofi && audio === audioGrafo);
}

/// Os dois elementos respondem igual, e só o que está no ar tem voz: o outro
/// pode estar terminando de soltar o `src` e um evento atrasado dele não pode
/// mexer no rodapé.
function ouvir(el: HTMLAudioElement) {
  el.addEventListener("playing", () => {
    if (el !== audio) return;
    tocandoLofi = true;
    carregandoLofi = false;
    avisoLofi = undefined;
    desenharLofi();
    if (el === audioGrafo) conferirEspectro();
  });

  // Buffer vazio no meio do caminho: o ▶ pisca de novo até o som voltar. Não é
  // erro — numa rádio ao vivo é só a rede respirando.
  el.addEventListener("waiting", () => {
    if (el !== audio || !noAr) return;
    carregandoLofi = true;
    desenharLofi();
  });

  el.addEventListener("error", () => caiu(el));
  // Um Icecast que fecha a conexão do lado dele chega como fim de mídia, e não
  // como erro. Numa rádio, que não acaba, é a mesma coisa.
  el.addEventListener("ended", () => caiu(el));
}

ouvir(audioGrafo);
ouvir(audioDireto);

/// A estação saiu do ar, ou nunca abriu. Sem espelho a que recorrer: a lista é
/// de endereços únicos, e o que dá para oferecer é a próxima.
function caiu(el: HTMLAudioElement) {
  // Sem o `noAr` isto dispararia no `load()` do pause, que é um erro de
  // propósito; sem a checagem do elemento, o que acabou de ser calado derrubaria
  // o que acabou de entrar.
  if (el !== audio || !noAr) return;
  noAr = false;
  tocandoLofi = false;
  carregandoLofi = false;
  avisoLofi = "estação fora do ar — tente a próxima";
  desenharLofi();
}

/// Quanto esperar antes de conferir se o grafo está recebendo alguma coisa.
/// Menos que isto pega a estação ainda enchendo o buffer e a condena à toa.
const CONFERIR_MS = 3_000;

let conferencia: ReturnType<typeof setTimeout> | undefined;

/// Toca mudo é pior que tocar sem mostrador: se a estação entrou pelo grafo e o
/// grafo não recebe nada, ela é rebaixada e recomeça pelo caminho direto. O
/// preço é uns três segundos de silêncio, uma vez por estação por sessão.
function conferirEspectro() {
  clearTimeout(conferencia);
  conferencia = setTimeout(() => {
    const a = analisador;
    const e = atual();
    if (!a || !e || audio !== audioGrafo || !tocandoLofi) return;

    a.no.getFloatFrequencyData(a.raias);
    const chao = SPEC_REF_MINIMA - SPEC_ALCANCE;
    if (a.raias.some((v) => Number.isFinite(v) && v > chao)) return;

    jlog(`radio: ${e.nome} veio muda no grafo — indo pelo caminho direto`);
    semEspectro.add(e.url);
    tocarLofi();
  }, CONFERIR_MS);
}

/// Solta o socket de um elemento. Uma rádio em pausa continuaria baixando para
/// jogar fora, e uma rádio ao vivo não tem onde continuar depois.
function calar(el: HTMLAudioElement) {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/// Tudo o que precisa do gesto do clique acontece AQUI DENTRO, de uma vez e sem
/// `await` no meio. O WebKit só libera áudio sob um gesto seu, e o gesto não
/// atravessa uma espera: com um `await ctx.resume()` antes do `play()`, o play
/// cai do outro lado do clique e é recusado — `NotSupportedError`, que ainda
/// por cima não parece o que é. Então o `play()` sai primeiro, síncrono, e o
/// contexto é solto logo atrás; o resultado é tratado quando chegar.
function tocarLofi() {
  const e = atual();
  if (!e) return;

  noAr = true;
  carregandoLofi = true;
  avisoLofi = undefined;

  // O elemento certo para esta estação. Se for o outro, o que estava no ar cala
  // antes — dois streams tocando juntos é o que acontece sem esta linha.
  const anterior = audio;
  audio = usaGrafo(e) ? audioGrafo : audioDireto;
  if (anterior !== audio) calar(anterior);
  desenharLofi();

  audio.src = e.url;
  const pedido = audio.play();

  if (audio === audioGrafo) {
    // Um contexto que nasceu suspenso volta aqui; um que já está rodando não se
    // incomoda de ser acordado de novo.
    void ligarAnalisador().contexto.resume().catch(() => {});
  } else {
    // Fora do grafo não há ganho, e aí o `volume` do elemento volta a valer.
    audio.volume = volumeLofi / 100;
  }

  pedido.catch((erro: unknown) => {
    // O `error` do elemento cuida do stream que não abriu; aqui só sobra a
    // recusa do próprio navegador.
    noAr = false;
    carregandoLofi = false;
    avisoLofi = `a rádio não abriu: ${erro}`;
    desenharLofi();
    jlog(`radio: ${erro}`);
  });
}

function pausarLofi() {
  noAr = false;
  clearTimeout(conferencia);
  calar(audio);
  tocandoLofi = false;
  carregandoLofi = false;
  desenharLofi();
}

/// Põe uma estação no ar. Com a rádio parada ela fica só engatilhada: trocar de
/// estação não é pedido para começar a tocar, e o endereço só é escolhido no ▶.
function irPara(i: number) {
  if (!estacoes.length) return;
  const n = estacoes.length;
  estacao = ((i % n) + n) % n;
  avisoLofi = undefined;
  guardarAtual();

  // Tocando, a troca é imediata — e passa pelo `tocarLofi` porque a estação
  // nova pode querer o outro caminho de áudio.
  if (noAr) tocarLofi();
  desenharLofi();
  desenharLista();
}

lofiEstacoes.addEventListener("click", () => abrirEditor());
lofiProxima.addEventListener("click", () => irPara(estacao + 1));
lofiTocar.addEventListener("click", () => (tocandoLofi ? pausarLofi() : tocarLofi()));

lofiVolume.addEventListener("click", () => {
  volumeLofi = VOLUMES[(VOLUMES.indexOf(volumeLofi) + 1) % VOLUMES.length];
  aplicarVolume();
  desenharVolume();
  localStorage.setItem(CHAVE_VOLUME, String(volumeLofi));
});

/// Vale para os dois caminhos: o ganho do grafo e o `volume` do elemento
/// direto. Uma rampa curta no ganho em vez de um salto, porque `gain.value`
/// trocado de uma vez estala. Antes do primeiro ▶ não há grafo, e não há o que
/// aplicar nele — o número fica guardado e entra quando o ganho for montado.
function aplicarVolume() {
  audioDireto.volume = volumeLofi / 100;
  const a = analisador;
  if (a) a.ganho.gain.setTargetAtTime(volumeLofi / 100, a.contexto.currentTime, 0.01);
}

// ---------- rádio: o seletor de estações ----------

/// Aberto pelo ☰ do rodapé ou por Rádio ▸ Estações…, na barra de menu. É um
/// seletor e só: clicar num nome põe a estação no ar, e não há nada para
/// adicionar nem para remover. Uma caixa no meio da janela e não uma lista
/// presa ao rodapé porque duzentas e cinquenta linhas não cabem numa faixa de
/// 30px.
const lofiEditor = elemento("div", "lofi-editor");
lofiEditor.hidden = true;
const lofiCaixa = elemento("div", "lofi-caixa");
const lofiCabeca = elemento("div", "lofi-cabeca");
const lofiCabecaTitulo = elemento("span", "lofi-cabeca-titulo");
lofiCabecaTitulo.textContent = "Estações";
const lofiFechar = botaoLofi("lofi-fechar", ICONE_TIRAR, "Fechar (esc)");
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
    nome.title = `Tocar ${e.nome}`;
    if (e.genero) {
      const genero = elemento("span", "lofi-genero");
      genero.textContent = e.genero;
      nome.appendChild(genero);
    }
    // As que tocam sem mostrador levam uma marca, e não um aviso: é uma
    // diferença pequena, e quem está escolhendo rádio está escolhendo som.
    if (!usaGrafo(e)) {
      const marca = elemento("span", "lofi-sem-spec");
      marca.textContent = "sem espectro";
      linha.appendChild(marca);
    }
    // Escolher uma estação parada é pedido para tocar: você veio aqui para
    // ouvir, e não para engatilhar. As setas do rodapé é que trocam sem tocar.
    nome.addEventListener("click", () => {
      irPara(i);
      if (!noAr) tocarLofi();
    });
    linha.insertBefore(nome, linha.firstChild);
    lofiLista.appendChild(linha);
  });
  // A que está no ar entra na vista: com duzentas e cinquenta linhas ela quase
  // sempre está fora dela, e abrir o seletor no topo esconde a resposta da
  // pergunta que fez você abrir.
  lofiLista.querySelector(".lofi-linha.atual")?.scrollIntoView({ block: "nearest" });
}

function abrirEditor() {
  lofiEditor.hidden = false;
  desenharLista();
  lofiFechar.focus();
}

function fecharEditor() {
  lofiEditor.hidden = true;
  // O teclado volta para onde estava: o seletor é uma visita, não um destino.
  if (ativa?.foco) focar(ativa.foco);
}

// Clique no escuro fecha; clique na caixa, não — `e.target` é o fundo só quando
// o ponteiro caiu fora dela.
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

// ---------- ajuda: a lista de atalhos (Ajuda ▸ Atalhos do Teclado) ----------

/// Todos os atalhos do app, por assunto. Escrita à mão, e não tirada do menu:
/// metade deles não é item de menu (os do `nossoAtalho`, os do differ), e a
/// lista tem de dizer também o que cada um faz. Mexeu num atalho, mexe aqui.
/// Mais de uma tecla para a mesma coisa vira mais de uma tecla na linha.
const ATALHOS: { grupo: string; itens: [string | string[], string][] }[] = [
  {
    grupo: "Abas",
    itens: [
      ["⌘T", "Nova aba"],
      ["⌘⇧]", "Próxima aba"],
      ["⌘⇧[", "Aba anterior"],
      ["⌘1", "Diff da branch (a aba presa)"],
      ["⌘2 … ⌘8", "Ir para a aba de número"],
      ["⌘9", "Última aba"],
    ],
  },
  {
    grupo: "Painéis",
    itens: [
      ["⌘D", "Dividir ao lado"],
      ["⌘⇧D", "Dividir abaixo"],
      ["⌘⌥ ← ↑ → ↓", "Ir para o painel naquela direção"],
      ["⌘⇧A", "Ir para o painel que espera por você"],
      ["⌘⇧↩", "Maximizar o painel ou recolher de volta"],
      // ⌃D é o fim de entrada: o shell sai, e o painel vai junto com ele.
      [["⌘W", "⌃D"], "Fechar o painel (o último fecha a aba)"],
    ],
  },
  {
    grupo: "Terminal",
    itens: [
      ["⌘K", "Limpar a tela"],
      ["⌘C", "Copiar"],
      ["⌘V", "Colar"],
      ["⌘⇧V", "Colar caminho do arquivo copiado"],
      ["⌘A", "Selecionar tudo"],
    ],
  },
  {
    grupo: "Diff da branch",
    itens: [
      ["V", "Marcar o arquivo como visto"],
      ["S", "Pôr ou tirar o arquivo do índice"],
      ["⇧S", "Pôr ou tirar a pasta do arquivo do índice"],
      ["A", "Pôr ou tirar tudo do índice"],
      ["⌘↩", "Commitar"],
      ["⌘R", "Recarregar o diff"],
    ],
  },
  {
    grupo: "App",
    itens: [
      ["⌘,", "Preferências"],
      ["⌘E", "Escutar (ditado)"],
      ["⌘/", "Esta lista"],
      ["⌘M", "Minimizar"],
      ["⌃⌘F", "Tela cheia"],
      ["⌘H", "Ocultar o TermIAu"],
      ["⌘Q", "Sair"],
    ],
  },
];

/// A mesma casca do seletor de estações — fundo escuro, caixa no meio, esc
/// fecha —, com a lista de atalhos dentro.
const ajudaEl = elemento("div", "lofi-editor");
ajudaEl.hidden = true;
const ajudaCaixa = elemento("div", "lofi-caixa ajuda-caixa");
const ajudaCabeca = elemento("div", "lofi-cabeca");
const ajudaTitulo = elemento("span", "lofi-cabeca-titulo");
ajudaTitulo.textContent = "Atalhos do Teclado";
const ajudaFechar = botaoLofi("lofi-fechar", ICONE_TIRAR, "Fechar (esc)");
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

/// ⌘/ de novo com a lista aberta fecha: é a mesma tecla que a trouxe.
function alternarAjuda() {
  if (!ajudaEl.hidden) return fecharAjuda();
  ajudaEl.hidden = false;
  ajudaFechar.focus();
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
  const dado = e.data as {
    termiau?: Atalho;
    termiauPronto?: boolean;
    termiauRepoAberto?: string | null;
  } | null;

  // Abriu ou fechou repositório lá dentro: é o que acende e apaga o chip.
  if (dado && "termiauRepoAberto" in dado) {
    habilitarPresa(dado.termiauRepoAberto ?? null);
    return;
  }

  // O differ avisa quando começa a ouvir. Um pedido que tenha chegado antes
  // disso estava guardado esperando exatamente este aviso.
  if (dado?.termiauPronto) {
    presa.pronta = true;
    const fila = presa.fila.splice(0);
    for (const msg of fila) presa.quadro.contentWindow?.postMessage(msg, "*");
    // A página pode ter recarregado com a aba já aberta (um reload do dev, um
    // crash da webview): ela não viu o `abrirPresa` que a pôs na tela.
    recado({ termiauVisivel: noDiff });
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

  // O "+" da barra faz o que o ⌘T faz — é o mesmo caminho, só que no alcance do
  // mouse. `void` porque o clique não espera a aba abrir.
  document.getElementById("nova-aba")?.addEventListener("click", () => void novaAba());

  // ⌘T, ⌘D, ⌘⇧D, ⌘⇧↩ e ⌘W chegam por aqui: quem recebe a tecla é o menu nativo.
  await listen("menu://nova-aba", () => novaAba());
  await listen("menu://dividir-lado", () => dividir("lado"));
  await listen("menu://dividir-abaixo", () => dividir("abaixo"));
  await listen("menu://maximizar", () => {
    if (ativa && !noDiff) alternarMaximizar(ativa.foco.dono ?? ativa.foco);
  });
  await listen("menu://fechar", () => {
    if (ativa && !noDiff) fecharFolha(ativa.foco);
  });
  await listen("menu://colar-caminho", () => colarCaminho());
  await listen("menu://preferencias", () => abrirPreferencias());
  await listen("menu://estacoes", () => abrirEditor());
  await listen("menu://atalhos", () => alternarAjuda());

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
