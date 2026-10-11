import { Terminal, type IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { nossoAtalho, type Atalho } from "./atalhos";
import { iniciar } from "./inicio";
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
  ehMarkdown,
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
  // Os links OSC 8 (o Claude Code escreve os dele assim), com a mesma regra
  // dos que o addon acha no texto.
  linkHandler: { activate: (e: MouseEvent, uri: string) => abrirLink(e, uri) },
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
  /// O que você mandou pro Claude neste painel: é por aqui que o terminal acha,
  /// na tela, as linhas suas para destacar (ver `marcar`).
  prompts?: string[];
  /// O destaque de cada prompt achado, pela linha em que está.
  marcas?: Map<string, IDecoration>;
  /// Como a tela estava na última busca: o que já tinha saído para a rolagem
  /// não muda mais, e não precisa ser lido de novo (ver `marcar`).
  vistas?: { base: number; cols: number; prompts: number };
  esperaMarcas?: ReturnType<typeof setTimeout>;
  /// A conversa em balões, por cima do terminal. Existe depois da primeira vez
  /// que o painel entra no modo chat.
  chat?: Chat;
  /// O arquivo mostrado no painel, por cima do terminal e do chat. Existe
  /// depois do primeiro `termiau ver` ou ⌘-clique numa referência.
  visor?: Visor;
};

type SessaoClaude = {
  /// Como a voz chama este painel. É o nome da pasta, não "painel 2": ouvir
  /// "o MOBILE precisa da sua permissão" diz onde ir; um número, não.
  nome: string;
  estado: "ocioso" | "trabalhando" | "esperando";
  /// O id da sessão, como o hook o informa. É o que o `claude --resume` pede
  /// para retomá-la quando a aba volta (ver `retomar`).
  sessao?: string;
  /// A pasta em que a sessão nasceu: o `--resume` só a acha a partir dela.
  pasta?: string;
  /// O JSONL em que o Claude Code grava a conversa. É dele que o modo chat lê.
  transcricao?: string;
  /// Por que o Claude parou para esperar, quando o hook disse.
  aviso?: string;
  /// O que a espera pede. `permissao`: um sim ou não, que o chat responde por
  /// botões. `terminal`: um menu que só o terminal mostra (as opções de uma
  /// pergunta, o plano a aprovar). Sem nada, ele só espera a próxima mensagem —
  /// e essa o campo do chat manda tão bem quanto o terminal.
  pede?: "permissao" | "terminal";
  /// Uma pergunta do Claude (`AskUserQuestion`) que o modo chat pode
  /// responder: o hook está esperando por ela (ver `Pendentes` no lib.rs). O
  /// terminal mostra a mesma pergunta ao mesmo tempo, e quem responder primeiro
  /// vale.
  pergunta?: { id: string; questoes: Questao[] };
  /// Quanto do contexto a sessão já usou (0 a 100), pela status line.
  contexto?: number;
  /// O modelo da sessão (o `display_name`, "Opus 5.5") e o nível de esforço
  /// ("high"), também pela status line. Um modelo sem esforço não manda o nível.
  modelo?: string;
  esforco?: string;
  /// O auto-compact já mandou o `/compact` desta vez. Só volta a valer quando o
  /// contexto descer do limite — senão cada status line mandaria outro.
  compactou?: boolean;
};

/// As ferramentas cuja espera é um menu de opções, e não um sim ou não: o
/// Enter do "Permitir" escolheria a primeira opção sem você tê-la lido.
const PEDEM_TERMINAL = new Set(["AskUserQuestion", "ExitPlanMode"]);

/// A espera se resolve sem sair do chat: é só uma mensagem que falta, ou uma
/// pergunta que o cartão do chat responde.
const atendivelNoChat = (folha: Folha) =>
  folha.chat?.aberto && (!folha.claude?.pede || folha.claude.pergunta !== undefined);

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
  for (const f of visiveis(aba)) {
    f.fit.fit();
    // Dividir, fechar e trocar de aba tiram o painel do lugar (ou da tela), e o
    // navegador zera a rolagem de quem passa por isso.
    if (f.chat?.aberto) reporRolagem(f.chat);
  }
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
  teclado(folha);
  rotular(aba);
  // Olhar pro painel é atender: o aviso já cumpriu o papel dele. No modo chat
  // também, se o que falta é uma mensagem; um pedido de permissão ou um menu
  // fica aceso até ser respondido (pelos botões do aviso ou no terminal).
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
  // A aba estava escondida (dimensão zero) e pode ter perdido redimensionamentos
  // da janela nesse meio-tempo: remede agora, antes de devolver o foco.
  medir(aba);
  sincronizar(aba);
  // A branch que chegou com a aba escondida mediu zero e não saiu andando.
  for (const f of visiveis(aba)) if (f.barra) repassear(f.barra.ramo);
  teclado(aba.foco);
  rotular(aba);
  agendarSalvar();
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
  // quando o play roda algo, a gaveta embaixo. Dentro dele, a `folha-tela` tem
  // o terminal e o chat; o visor dividido fica ao lado dela, e não por cima.
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
    // ⇧↩ quebra linha em vez de enviar: o xterm manda o mesmo `\r` do Enter,
    // então vai `ESC ↩`, que o Claude lê como nova linha (e o zsh também).
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
    // Com o visor dividido, o teclado fica do lado que você clicou.
    if (folha.visor) folha.visor.comTeclado = folha.visor.el.contains(e.target as Node);
    focar(folha);
  });
  ligarBarra(folha);
  ligarLinksDeArquivo(folha);

  // PTY -> tela. O Rust manda base64 pra não quebrar UTF-8 no meio de um chunk.
  folha.desligar.push(
    await listen<string>(`pty://data/${id}`, (e) => {
      const bin = atob(e.payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // O Claude redesenha a tela quando quer, e o destaque dos seus prompts
      // tem de ir atrás das linhas: refaz depois de cada leva de saída.
      term.write(bytes, () => agendarMarcas(folha));
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
    // Mexer no painel é atender, tanto quanto clicar nele: o aviso de
    // "esperando" para de piscar na primeira tecla. O `focar` só cobre quem
    // chega no painel; quem já estava nele digita direto.
    if (folha.claude?.estado === "esperando" && !RESPOSTA_DO_TERMINAL.test(data)) {
      folha.claude.estado = "ocioso";
      pintar();
    }
    // Esc sozinho interrompe o Claude, e interrompido ele não manda o `Stop`.
    if (data === "\x1b" && folha.claude?.estado === "trabalhando") {
      folha.claude.estado = "ocioso";
      pintar();
    }
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

/// O `onData` do xterm não traz só o que você digita: o próprio terminal
/// responde por ali ao programa — foco que entrou ou saiu, posição do cursor,
/// atributos do terminal, o mouse, cores. Nada disso é você mexendo no painel.
/// O foco é o que mais importa: trocar de aba manda um "saí", e sem este filtro
/// sair de perto de um painel que espera apagaria o aviso dele.
const RESPOSTA_DO_TERMINAL = /^\x1b(?:\[[IO]$|\[[?>=]?[\d;]*[Rcnty]$|\[<|\[M|[\]P_])/;

/// Quanto tempo o ✕ fica armado esperando o segundo clique. Curto de propósito:
/// é uma confirmação, não um modo — passou disso, a aba volta a ser uma aba.
const CONFIRMA_FECHAR = 1000;

/// Como desarmar a aba que está armada agora, se houver uma. Duas abas de
/// vermelho ao mesmo tempo diriam que as duas vão fechar, e só uma vai: armar
/// uma desarma a outra.
let desarmarFechar: (() => void) | undefined;

/// `em`: a pasta em que a aba abre, para quem já sabe qual é — uma aba que
/// está voltando (ver `reabrir`). Sem ele, vale a do painel em foco.
async function novaAba(em?: string | null): Promise<Aba | undefined> {
  if (ocupado) return;
  ocupado = true;
  try {
    // Aba nova abre onde o painel em foco está, como nos outros terminais. O Rust
    // cai no HOME sozinho se não conseguir descobrir (pasta apagada, por exemplo).
    const cwd =
      em !== undefined ? em : ativa ? await invoke<string | null>("pty_cwd", { id: ativa.foco.id }) : null;

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
    return aba;
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
      // A ordem da barra é a ordem em que as abas voltam.
      agendarSalvar();
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
  // Apagada: o clique no chip, o ⌘` e o ciclo das abas passam por aqui e param.
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
  // Dividir é mexer no layout, e ele tem de estar à vista pra isso.
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

/// Corta `alvo` em dois e devolve o painel novo, que fica com o segundo lugar.
/// Não mexe no foco nem no `ocupado`: isso é de quem chama — o ⌘D, ou uma aba
/// que está voltando e remonta o layout corte a corte (ver `montar`). A aba tem
/// de estar na tela: o painel novo é medido no lugar.
async function dividirFolha(
  aba: Aba,
  alvo: Folha,
  eixo: Eixo,
  cwd: string | null,
  fracao = 0.5,
): Promise<Folha | undefined> {
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
    fracao,
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
  agendarSalvar();
  return nova;
}

// ---------- fechamento ----------

/// Solta os recursos do painel. Não mexe na árvore — quem faz isso é quem chama.
function destruirFolha(folha: Folha, jaMorto: boolean) {
  folha.morta = true;
  // A gaveta mora dentro do painel: vai junto, e o app que rodava nela também.
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
  else teclado(aba.foco);
}

function fecharAba(aba: Aba) {
  const i = abas.indexOf(aba);
  if (i < 0) return;

  // Antes de destruir: é desta foto que o ⌘⇧T traz a aba de volta.
  fechadas.push(fotografarAba(aba));
  if (fechadas.length > MAX_FECHADAS) fechadas.shift();

  abas.splice(i, 1);
  for (const f of folhas(aba.raiz)) destruirFolha(f, false);
  aba.corpo.remove();
  aba.chip.remove();

  if (abas.length === 0) {
    // Fechar a última aba é sair, e quem fechou já disse o que queria: sem
    // pergunta. A sessão fica salva vazia — a próxima abertura começa limpa.
    void sair();
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
  session_id?: string;
  transcript_path?: string;
  /// No `UserPromptSubmit`: o que você escreveu.
  prompt?: string;
  /// No `Notification`: o que o Claude quer de você.
  message?: string;
  /// No `Notification`, nas versões que o mandam: `permission_prompt`,
  /// `idle_prompt`, `elicitation_dialog`...
  notification_type?: string;
  /// No `PermissionRequest`: a ferramenta que pede permissão, e com o quê.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /// Nos eventos de ferramenta (menos o `PermissionRequest`): qual chamada.
  tool_use_id?: string;
};

/// O que a status line do Claude Code manda, pelo hook (`termiau-evento.sh
/// status`). Só os campos que o app usa.
type StatusDoSocket = {
  painel: number;
  status: {
    context_window?: { used_percentage?: number | null } | null;
    rate_limits?: LimitesDaStatusLine | null;
    model?: { display_name?: string | null } | null;
    effort?: { level?: string | null } | null;
  };
};

/// O contexto, o modelo e o esforço vão para a barra do painel da sessão; o
/// uso, para o rodapé.
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
  // O nível some de verdade quando o modelo novo não tem esforço.
  const esforco = st.model ? (st.effort?.level ?? undefined) : c.esforco;
  const mudou = c.contexto !== contexto || c.modelo !== modelo || c.esforco !== esforco;
  Object.assign(c, { contexto, modelo, esforco });
  if (mudou) desenharBarra(folha);
  autoCompactar(folha);
}

/// O `/compact` sozinho, quando o contexto chega no limite das Preferências.
/// Só com o Claude parado: trabalhando, o comando entraria na fila; esperando,
/// responderia a pergunta dele. O `Stop` chama de novo, para o caso de o limite
/// ter sido passado no meio do turno.
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
  avisar(folha, `Contexto em ${Math.round(c.contexto)}%: compactando sozinho.`);
  compactar(folha);
}

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
      desenharAviso(f);
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
  // Tudo o que muda as abas, os painéis ou as sessões do Claude passa por aqui.
  agendarSalvar();
}

function receber(
  bruto:
    | EventoClaude
    | { painel: number; evento: Omit<EventoClaude, "painel">; espera?: boolean; pergunta_id?: string },
) {
  // O hook embrulha o payload do Claude com o número do painel por fora. O de
  // antes punha o `painel` dentro dele — e pode ser esse o que ainda está
  // instalado.
  const ev: EventoClaude = "evento" in bruto ? { ...bruto.evento, painel: bruto.painel } : bruto;
  // Uma pergunta do Claude cujo hook ficou esperando a resposta do chat, com
  // o número que o Rust deu a ela.
  const perguntaId = "pergunta_id" in bruto ? bruto.pergunta_id : undefined;
  const folha = folhaPorPainel(ev.painel);
  if (!folha) {
    // O painel fechou antes do evento chegar: o hook não espera por ninguém.
    if (perguntaId) void invoke("pergunta_largar", { id: perguntaId });
    return;
  }

  // O nome da pasta é o que aparece na aba.
  const nome = ev.cwd?.split("/").filter(Boolean).pop() || `painel ${ev.painel}`;
  // A sessão muda sem o Claude sair (um `/clear`, um `/resume`): vale sempre a
  // do último evento. A pasta é a do primeiro evento de cada sessão — depois o
  // Claude pode ter andado, e o `--resume` procura a sessão onde ela nasceu.
  const antes = folha.claude;
  const sessao = ev.session_id ?? antes?.sessao;
  const pasta = (antes?.sessao === sessao && antes?.pasta) || ev.cwd;
  const transcricao = ev.transcript_path ?? (antes?.sessao === sessao ? antes?.transcricao : undefined);
  // A pergunta pendente atravessa os eventos até ser respondida.
  const pergunta = antes?.sessao === sessao ? antes?.pergunta : undefined;
  // O contexto também: ele só chega pela status line, e um evento do hook que o
  // esquecesse apagaria a pílula até o Claude rodar de novo.
  const contexto = antes?.sessao === sessao ? antes?.contexto : undefined;
  const compactou = antes?.sessao === sessao ? antes?.compactou : undefined;
  // O modelo e o esforço atravessam um `/clear`: são do Claude que está rodando.
  const { modelo, esforco } = antes ?? {};
  folha.claude = { nome, estado: antes?.estado ?? "ocioso", sessao, pasta, transcricao, pergunta, contexto, modelo, esforco, compactou };

  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
      folha.claude.estado = "trabalhando";
      if (ev.prompt) lembrarPrompts(folha, [ev.prompt]);
      // Um prompt novo: a pergunta que estava aberta foi deixada para trás.
      largarPergunta(folha);
      break;
    case "Stop":
      // O turno acabou. Uma espera que chegou antes (uma pergunta, uma
      // permissão) continua de pé.
      if (folha.claude.estado === "trabalhando") folha.claude.estado = "ocioso";
      autoCompactar(folha);
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      // A pergunta foi respondida — no chat, ou no terminal antes dele. O hook
      // que ainda esperava sai calado, e o cartão some. Uma sessão só tem uma
      // pergunta aberta por vez, então o nome da ferramenta basta.
      if (pergunta && ev.tool_name === "AskUserQuestion") {
        largarPergunta(folha);
        if (folha.claude.estado === "esperando") folha.claude.estado = "trabalhando";
        folha.claude.pede = undefined;
        folha.claude.aviso = undefined;
      }
      break;
    case "PermissionRequest": {
      folha.claude.estado = "esperando";
      // Uma pergunta nova no lugar de outra: a de antes não volta mais.
      if (perguntaId) largarPergunta(folha);
      const questoes = ev.tool_name === "AskUserQuestion" ? questoesDe(ev.tool_input) : undefined;
      if (perguntaId && questoes) {
        folha.claude.pergunta = { id: perguntaId, questoes };
        folha.claude.pede = "terminal";
        folha.claude.aviso = "O Claude tem uma pergunta para você.";
        break;
      }
      const tool = ev.tool_name ?? "uma ferramenta";
      const oque = resumoDe(ev.tool_input);
      folha.claude.aviso = `O Claude pede permissão para usar ${tool}${oque ? `: ${oque}` : "."}`;
      folha.claude.pede = ev.tool_name && PEDEM_TERMINAL.has(ev.tool_name) ? "terminal" : "permissao";
      break;
    }
    case "Notification":
      folha.claude.estado = "esperando";
      // A notificação de permissão chega logo depois do `PermissionRequest`, e
      // diz menos que ele: o pedido e o texto que já estavam ficam.
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
  // O botão do chat só existe onde há conversa para mostrar.
  desenharBarra(folha);
  // A sessão pode ter mudado por baixo de um chat aberto (`/clear`, `/resume`),
  // e um prompt novo já está no transcript: lê agora, sem esperar o pulso.
  if (folha.chat?.aberto) void lerChat(folha);
}

/// Desiste da pergunta pendente do painel: o hook dela sai sem resposta, e se
/// ela ainda estiver aberta, o terminal é quem responde.
function largarPergunta(folha: Folha) {
  const id = folha.claude?.pergunta?.id;
  if (!id) return;
  folha.claude!.pergunta = undefined;
  invoke("pergunta_largar", { id }).catch((e) => jlog(`pergunta_largar: ${e}`));
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

// ---------- os seus prompts, destacados no terminal ----------

/// Quantos prompts o painel lembra. Os mais antigos já saíram da rolagem.
const MAX_PROMPTS = 300;
/// De quanto em quanto o destaque se refaz enquanto a tela muda. É um teto de
/// frequência, não uma espera pelo silêncio: o Claude trabalhando escreve sem
/// parar (o contador, a animação), e esperar ele calar seria nunca destacar.
const MARCAS_MS = 400;
/// Quantas linhas antes do começo da tela ainda são relidas: um prompt pode
/// ter começado lá e continuar dentro dela.
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

/// Põe um destaque em cada linha da tela que é um prompt seu. Procura de novo a
/// cada vez em vez de marcar na hora do envio: o Claude Code reescreve a
/// conversa inteira num redimensionamento, e a marca posta antes iria embora
/// com as linhas velhas.
function marcar(folha: Folha) {
  if (folha.morta || !folha.prompts?.length) return;
  const { term } = folha;
  const buf = term.buffer.active;
  // Na tela alternativa (o modo de tela cheia do Claude) o xterm não desenha
  // decoração nenhuma; lá o destaque fica por conta do modo chat.
  if (buf.type !== "normal") return;

  // A rolagem tem milhares de linhas, e o Claude trabalhando reescreve a tela
  // várias vezes por segundo. Mas o que já subiu para a rolagem é imutável:
  // enquanto ela só crescer, basta reler de onde a tela começava na última vez.
  // Encolheu (um clear, o redesenho de um resize), mudou de largura ou chegou
  // prompt novo: aí relê tudo.
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

  // A chave guarda a linha de quando a marca nasceu, e a rolagem anda com ela:
  // o mapa é refeito com a linha em que cada marca está agora.
  const antigas = folha.marcas ?? new Map<string, IDecoration>();
  const marcas = (folha.marcas = new Map<string, IDecoration>());
  for (const [chave, d] of antigas) {
    const atual = `${d.marker.line}:${chave.slice(chave.indexOf(":") + 1)}`;
    // Acima de onde a leitura começou ninguém foi conferido: a marca fica.
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

/// Pula para o seu prompt anterior ou seguinte: na rolagem do terminal ou, no
/// modo chat, entre os seus balões.
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

// ---------- modo chat: a conversa em balões ----------

/// A conversa do Claude de um painel, lida do transcript e desenhada por cima
/// do terminal. O terminal continua vivo embaixo, com a sessão rodando: o chat
/// é outro jeito de ver a mesma conversa, e o que se escreve no campo dele vai
/// para o Claude pelo mesmo caminho do teclado.
type Chat = {
  el: HTMLDivElement;
  lista: HTMLDivElement;
  aviso: HTMLDivElement;
  avisoTexto: HTMLSpanElement;
  /// O cartão da pergunta do Claude, e de qual pergunta é o que está desenhado:
  /// redesenhar a cada `pintar` apagaria o que você já marcou.
  pergunta: HTMLDivElement;
  perguntaDe?: string;
  /// A linha "trabalhando…" entre a conversa e o campo, e desde quando.
  pensando: HTMLDivElement;
  pensandoDesde?: number;
  /// Os seus balões que já estão na tela mas ainda não no transcript: o Claude
  /// só grava o prompt quando o recebe, e esperar por ele deixava o envio com
  /// cara de travado. Saem, na ordem, quando os de verdade chegam.
  pendentes: { el: HTMLElement; texto: string }[];
  /// Os botões que respondem um pedido de permissão sem sair do chat.
  permitir: HTMLButtonElement;
  negar: HTMLButtonElement;
  campo: HTMLTextAreaElement;
  /// A lista de `/comandos`, acima do campo enquanto se digita um.
  menu: HTMLDivElement;
  /// Os comandos do disco (seus, do projeto, dos plugins) e os que casam com o
  /// que está digitado, com o escolhido.
  comandos: Comando[];
  achados: Comando[];
  escolhido: number;
  /// As sessões a retomar, enquanto a lista do `/resume` está aberta: aí o
  /// menu mostra estas, e o que se digita no campo as filtra.
  sessoes?: SessaoSalva[];
  sessoesAchadas: SessaoSalva[];
  /// "Mostrar anteriores": as falas que ficaram de fora da tela (ver `CHAT_JANELA`).
  mais: HTMLButtonElement;
  /// A conversa inteira, e a partir de qual fala ela está desenhada.
  falas: Fala[];
  desde: number;
  /// Onde a rolagem estava, para devolvê-la quando o navegador a zerar.
  topo: number;
  noFim: boolean;
  /// Presente enquanto a lista está sendo levada ao fim (ver `reporRolagem`).
  grude?: number;
  /// Um aviso do próprio chat, na mesma faixa do "o Claude espera por você".
  recado?: string;
  aberto: boolean;
  /// O transcript que está na tela, e até que byte dele já foi lido.
  caminho?: string;
  fim: number;
  lendo?: boolean;
  pulso?: ReturnType<typeof setInterval>;
  /// As miniaturas das imagens já coladas no prompt do Claude, à espera do Enter.
  anexos: HTMLDivElement;
  /// A entrada ou saída em curso: alternar no meio dela parte de onde parou.
  transicao?: Animation;
};

/// De quanto em quanto o chat aberto confere se o transcript cresceu. O Claude
/// só grava uma fala quando ela termina, então não há o que ganhar lendo mais
/// depressa — e fechado, o chat não lê nada.
const CHAT_MS = 700;
/// Quantas falas entram na tela de cada vez. Uma sessão longa tem milhares, e
/// todas desenhadas são um documento enorme que o navegador refaz inteiro a
/// cada mudança de largura do painel — dividir, maximizar e trocar de modo
/// ficavam pesados na proporção da conversa.
const CHAT_JANELA = 80;

/// A faixa acima do campo: o Claude parou para esperar por você, ou o chat tem
/// algo a dizer. Sem nenhum dos dois ela não existe.
function desenharAviso(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  const pergunta = folha.claude?.pergunta;
  chat.pergunta.hidden = !pergunta;
  if (!pergunta) chat.perguntaDe = undefined;
  else if (chat.perguntaDe !== pergunta.id) desenharPergunta(folha, chat, pergunta);
  // Com o cartão na tela, a faixa só diria o mesmo que ele.
  const esperando = folha.claude?.estado === "esperando" && !pergunta;
  chat.aviso.hidden = !esperando && !chat.recado;
  chat.avisoTexto.textContent = esperando
    ? (folha.claude?.aviso ?? "O Claude está esperando por você.")
    : (chat.recado ?? "");
  chat.avisoTexto.title = chat.avisoTexto.textContent;
  const permissao = esperando && folha.claude?.pede === "permissao";
  chat.permitir.hidden = chat.negar.hidden = !permissao;
  desenharPensando(folha);
}

/// "Trabalhando… 12s": o Claude recebeu e ainda não terminou o turno. É o que
/// o terminal mostra com o asterisco girando; sem isto, o chat ficava parado
/// e não dava para saber se a mensagem tinha chegado.
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
  chat.pensando.textContent = `Trabalhando… ${tempo} · esc interrompe`;
}

/// O cartão de uma pergunta do Claude, em passos: uma pergunta por vez, com as
/// abas de todas em cima para ir e voltar. Numa pergunta de uma escolha só, o
/// clique já responde e passa para a próxima — e, na última, manda tudo —, como
/// no terminal. Múltipla escolha, "Outra…" e opções com prévia pedem o botão.
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
      // O terminal respondeu antes, ou o Claude desistiu da pergunta.
      chat.recado = "A pergunta já tinha sido respondida no terminal.";
      jlog(`pergunta_responder: ${e}`);
      pintar();
    });
    pintar();
    teclado(folha);
  };
  /// Vai para a próxima sem resposta; sem nenhuma faltando, manda.
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

    // As abas: com uma pergunta só não há para onde ir.
    if (questoes.length > 1) {
      const abas = elemento("div", "chat-pergunta-abas");
      for (const [i, outra] of questoes.entries()) {
        const aba = elemento("button", "chat-pergunta-aba");
        aba.textContent = `${respondida(i) ? "✓" : "○"} ${outra.header || `Pergunta ${i + 1}`}`;
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
      dica.textContent = " · marque quantas quiser";
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
    outra.placeholder = "Escreva a sua resposta e tecle ↩";
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
    outraBotao.textContent = "Outra…";
    outraBotao.setAttribute("aria-pressed", String(e.outra !== undefined));
    outraBotao.addEventListener("click", () => {
      // Numa escolha só, escrever a sua tira a marcada.
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
    terminal.textContent = "Ver no terminal";
    terminal.addEventListener("click", () => alternarChat(folha));
    const voltar = elemento("button", "chat-pergunta-terminal");
    voltar.textContent = "Voltar";
    voltar.addEventListener("click", () => {
      passo--;
      desenhar();
    });
    // Na última sem resposta o botão já manda; antes dela, segue.
    const ultima = questoes.every((_, i) => i === passo || respondida(i));
    const seguir = elemento("button", "chat-pergunta-responder");
    seguir.textContent = ultima ? "Responder" : "Próxima";
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

/// Responde o pedido de permissão que está no terminal, pelo teclado dele: o
/// Enter aceita a opção de cima ("Yes"), o esc recusa. É o que se apertaria lá.
function responderPermissao(folha: Folha, sim: boolean) {
  const claude = folha.claude;
  if (claude?.estado !== "esperando" || claude.pede !== "permissao") return;
  invoke("pty_write", { id: folha.id, data: sim ? "\r" : "\x1b" }).catch((e) => jlog(`permissão: ${e}`));
  // Aceito, o Claude segue trabalhando; recusado, ele para e espera você dizer
  // o que fazer em vez disso — e isso o campo do chat manda.
  claude.estado = sim ? "trabalhando" : "ocioso";
  claude.pede = undefined;
  claude.aviso = undefined;
  pintar();
  teclado(folha);
}

/// Devolve a rolagem do chat para onde você a deixou.
function reporRolagem(chat: Chat) {
  const { lista } = chat;
  if (!chat.noFim) {
    if (lista.scrollTop !== chat.topo) lista.scrollTop = chat.topo;
    return;
  }
  lista.scrollTop = lista.scrollHeight;
  // Uma vez só não chega ao fim: as falas de fora da tela têm altura de palpite
  // (o `content-visibility` do style.css), e só ganham a de verdade quando a
  // rolagem as alcança — aí a lista cresce e o fim já é outro. Insiste por
  // alguns quadros, até a altura parar de mudar.
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

/// Desenha mais uma leva das falas antigas, acima das que já estão na tela,
/// sem tirar do lugar o que você está lendo.
function mostrarAnteriores(chat: Chat) {
  const ate = chat.desde;
  chat.desde = Math.max(0, ate - CHAT_JANELA);
  const altura = chat.lista.scrollHeight;
  chat.mais.after(...chat.falas.slice(chat.desde, ate).map(desenharFala));
  chat.mais.hidden = chat.desde === 0;
  chat.lista.scrollTop += chat.lista.scrollHeight - altura;
}

/// As miniaturas saem junto com a mensagem que as levou.
function limparAnexos(chat: Chat) {
  for (const img of chat.anexos.querySelectorAll("img")) URL.revokeObjectURL(img.src);
  chat.anexos.replaceChildren();
  chat.anexos.hidden = true;
}

/// Quem recebe o teclado do painel: o campo do chat, se é ele que está na tela.
function teclado(folha: Folha) {
  const v = folha.visor;
  if (v?.aberto && (arranjoVisor === "sobre" || v.comTeclado)) v.corpo.focus({ preventScroll: true });
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
  permitir.textContent = "Permitir";
  permitir.addEventListener("click", () => responderPermissao(folha, true));
  const negar = elemento("button", "chat-aviso-nao");
  negar.textContent = "Negar";
  negar.addEventListener("click", () => responderPermissao(folha, false));
  const ver = elemento("button", "chat-aviso-ver");
  ver.textContent = "Ver no terminal";
  ver.addEventListener("click", () => alternarChat(folha));
  aviso.append(avisoTexto, permitir, negar, ver);
  const mais = elemento("button", "chat-mais");
  mais.textContent = "Mostrar mensagens anteriores";
  mais.hidden = true;
  const campo = elemento("textarea", "chat-campo");
  campo.rows = 1;
  campo.placeholder = "Mensagem para o Claude — ↩ envia, ⇧↩ quebra a linha, / comandos, esc interrompe";
  const menu = elemento("div", "chat-comandos");
  menu.hidden = true;
  const anexos = elemento("div", "chat-anexos");
  anexos.hidden = true;
  el.append(lista, pensando, pergunta, aviso, menu, anexos, campo);
  // Dentro do elemento do terminal, e não ao lado: escondê-lo tiraria a medida
  // de onde o FitAddon calcula a grade, e o Claude receberia um SIGWINCH a cada
  // troca de modo.
  folha.el.querySelector(".folha-tela")?.append(el);

  const crescer = () => {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(campo.scrollHeight, 160)}px`;
  };
  /// Manda o texto para o Claude. Um `/comando` vai digitado, e não colado: é
  /// digitado que o Claude Code o reconhece como comando em qualquer caso. O
  /// resto vai pelo caminho de colagem, como o ⌘V — várias linhas chegam como
  /// um bloco só, e não como um Enter a cada quebra. O Enter vai depois, à
  /// parte: junto da colagem o Claude o tomaria por mais uma linha dela.
  const enviar = (texto: string) => {
    // O `/resume` sozinho abriria a lista de sessões no terminal, onde o chat
    // não a vê. A lista é montada aqui, e o que vai para o Claude é o
    // `/resume` já com a sessão escolhida.
    if (texto === "/resume") return void abrirSessoes(folha);
    chat.sessoes = undefined;
    limparAnexos(chat);
    campo.value = "";
    crescer();
    desenharComandos(chat);
    const comando = /^\/([\w:.-]+)/.exec(texto);
    // A mensagem vai para a tela já, apagada até o transcript a confirmar. Um
    // `/comando` não: muitos nem viram fala, e o balão ficaria lá pendurado.
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
      invoke("pty_write", { id: folha.id, data: texto }).catch((err) => jlog(`chat comando: ${err}`));
    } else colar(folha, texto);
    setTimeout(() => {
      invoke("pty_write", { id: folha.id, data: "\r" }).catch((err) => jlog(`chat envio: ${err}`));
    }, 80);
    // O que o comando abre (a lista de modelos, as sessões a retomar) aparece
    // no terminal, e é lá que se responde. O chat não sai da frente sozinho:
    // avisa, e o botão do aviso leva até lá.
    const nome = comando?.[1];
    // Com argumento o comando já diz o que quer, e não abre tela nenhuma.
    const abreTela = texto === `/${nome}` && COMANDOS_DO_CLAUDE.some((c) => c.interativo && c.nome === nome);
    chat.recado = abreTela ? `O /${nome} abriu uma tela no terminal.` : undefined;
    pintar();
  };
  const completar = (c: Comando) => {
    campo.value = `/${c.nome} `;
    crescer();
    desenharComandos(chat);
  };

  campo.addEventListener("input", () => {
    crescer();
    // Escrever a resposta é atender, como a primeira tecla no terminal.
    if (folha.claude?.estado === "esperando" && atendivelNoChat(folha)) {
      folha.claude.estado = "ocioso";
      pintar();
    }
    // Abriu a lista agora: os comandos do disco podem ter mudado desde a
    // última vez (uma skill nova, outro projeto).
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
    // O clique não tira o teclado do campo.
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
      // Tab completa, para quem vai escrever os argumentos; Enter já manda.
      if (e.key === "Tab") {
        e.preventDefault();
        return completar(chat.achados[chat.escolhido]);
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        return enviar(`/${chat.achados[chat.escolhido].nome}`);
      }
      // Esc fecha a lista; só sem ela é que ele interrompe o Claude.
      if (e.key === "Escape") {
        e.preventDefault();
        menu.hidden = true;
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Com um pedido de permissão aberto, o esc lá é o "não": o aviso vai junto.
      if (folha.claude?.estado === "esperando" && folha.claude.pede === "permissao") {
        return responderPermissao(folha, false);
      }
      invoke("pty_write", { id: folha.id, data: "\x1b" }).catch((err) => jlog(`chat esc: ${err}`));
      // Interrompido, o Claude não manda o `Stop`: o "trabalhando" sai aqui.
      if (folha.claude?.estado === "trabalhando") {
        folha.claude.estado = "ocioso";
        pintar();
      }
      return;
    }
    // Enter no meio de uma composição (acento, IME) confirma a letra, não envia.
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    // A marca no campo é só para você ver onde a imagem está: no prompt do
    // Claude ela já entrou com o ⌃V, e mandada de novo viraria texto.
    const texto = campo.value.replace(/\[Image #\d+\] ?/g, "").trim();
    if (texto) enviar(texto);
    else if (!chat.anexos.hidden) {
      campo.value = "";
      crescer();
      invoke("pty_write", { id: folha.id, data: "\r" }).catch((err) => jlog(`chat envio: ${err}`));
      limparAnexos(chat);
    }
  });
  // Clicar em qualquer lugar do chat é como clicar no terminal: o teclado vai
  // para o campo, e dá para sair digitando. Menos quando o clique foi para
  // outra coisa — um botão, um link, outro campo — ou para selecionar texto.
  el.addEventListener("mouseup", (e) => {
    const alvo = e.target as HTMLElement;
    if (alvo.closest("button, a, input, textarea, select, summary")) return;
    if (!(getSelection()?.isCollapsed ?? true)) return;
    campo.focus({ preventScroll: true });
  });
  // Um link da resposta abre fora, como os do terminal: dentro, ele trocaria a
  // página do app inteiro pela do link.
  lista.addEventListener("click", (e) => {
    // ⌘-clique num `caminho:linha` da resposta abre o arquivo no visor.
    if (cliqueEmReferencia(folha, e)) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    abrirLink(e, a.href);
  });
  // Imagem colada vai para o Claude como no terminal: o ⌃V é o que faz o Claude
  // Code ler a área de transferência e anexá-la ao prompt que está montando. O
  // texto do campo vai depois, junto do Enter.
  campo.addEventListener("paste", (e) => {
    const arquivo = [...(e.clipboardData?.items ?? [])]
      .find((i) => i.kind === "file" && i.type.startsWith("image/"))
      ?.getAsFile();
    if (!arquivo) return;
    e.preventDefault();
    invoke("pty_write", { id: folha.id, data: "\x16" }).catch((err) => jlog(`chat imagem: ${err}`));
    const img = elemento("img", "chat-anexo");
    img.src = URL.createObjectURL(arquivo);
    img.alt = "imagem anexada";
    img.addEventListener("click", () => ampliarImagem(img.src));
    anexos.append(img);
    anexos.hidden = false;
    // O número que o Claude Code vai dar a ela: ele conta na sessão inteira.
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
      // Fora da tela a lista não tem altura, e o que ela diz da rolagem é zero.
      // E a caminho do fim, as posições de passagem não são escolha sua.
      if (!lista.clientHeight || chat.grude !== undefined) return;
      chat.topo = lista.scrollTop;
      chat.noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 40;
    },
    { passive: true },
  );
  // Rolou com a mão no meio do caminho: quem manda é você.
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

/// Os comandos e as skills do disco, para a lista do `/`. A pasta é a da
/// sessão: é dela que o Claude Code enxerga o `.claude` do projeto.
async function carregarComandos(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  try {
    const doDisco = await invoke<Comando[]>("comandos_listar", { pasta: folha.claude?.pasta ?? null });
    chat.comandos = doDisco;
    desenharComandos(chat);
  } catch (e) {
    jlog(`comandos: ${e}`);
  }
}

/// A lista aparece enquanto o campo é só uma barra e um nome ainda sem espaço;
/// depois do espaço já são os argumentos, e ela sai do caminho.
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

/// Uma sessão do Claude Code guardada no disco, como o `claude_sessions` a lista.
type SessaoSalva = { id: string; title: string; modified: number };

/// "há 5 min", "há 3 h", "há 2 d": o bastante para achar a conversa de ontem.
function haQuanto(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / (60 * 24))} d`;
}

/// A lista do `/resume`, dentro do chat: as sessões guardadas da pasta em que
/// esta nasceu, que é onde o Claude Code as procura.
async function abrirSessoes(folha: Folha) {
  const chat = folha.chat;
  if (!chat) return;
  chat.campo.value = "";
  chat.campo.style.height = "auto";
  const pasta = folha.claude?.pasta ?? (await invoke<string | null>("pty_cwd", { id: folha.id }).catch(() => null));
  const todas = pasta ? await invoke<SessaoSalva[]>("claude_sessions", { path: pasta }).catch(() => []) : [];
  // A sessão em que já se está não é uma a retomar.
  const outras = todas.filter((s) => s.id !== folha.claude?.sessao);
  if (!outras.length) {
    chat.recado = "Não há outra sessão guardada nesta pasta.";
    return desenharAviso(folha);
  }
  chat.recado = undefined;
  desenharAviso(folha);
  chat.sessoes = outras;
  chat.escolhido = 0;
  desenharComandos(chat);
  chat.campo.focus();
}

/// O menu, no lugar dos comandos: as sessões cujo título tem o que está no
/// campo. Com o campo vazio, todas.
function desenharSessoes(chat: Chat) {
  const q = chat.campo.value.trim().toLowerCase();
  chat.sessoesAchadas = (chat.sessoes ?? []).filter((s) => s.title.toLowerCase().includes(q));
  chat.escolhido = Math.max(0, Math.min(chat.escolhido, chat.sessoesAchadas.length - 1));
  const cabeca = elemento("div", "chat-comandos-cabeca");
  cabeca.textContent = chat.sessoesAchadas.length
    ? "Retomar uma sessão — ↑↓ escolhe, ↩ retoma, esc cancela, digite para filtrar"
    : "Nenhuma sessão com esse texto — esc cancela";
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
  // O seu texto vai como foi escrito; só a resposta do Claude é markdown.
  if (f.quem === "voce") desenharSeu(el, f.texto, f.imagens ?? []);
  else el.innerHTML = markdown(f.texto);
  return el;
}

/// Quantas linhas de diff entram na tela. Um `Write` de um arquivo inteiro
/// teria milhares; o resto está no arquivo.
const DIFF_MAXIMO = 400;

/// Unificado ou lado a lado: o mesmo modo do differ, guardado nas preferências
/// dele. Trocar aqui troca lá, e o contrário também.
let modoDiff: ViewMode = "unified";

/// O arquivo de cada diff na tela, para redesenhá-lo quando o modo muda.
const arquivoDoDiff = new WeakMap<HTMLElement, ArquivoDiff>();

const ICONE_UNIFICADO = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 6h7M4.5 10h7"/></svg>`;
const ICONE_LADO_A_LADO = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>`;

/// Os limites da pílula do contexto, das Preferências (⌘,).
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
    jlog(`limites do contexto: ${e}`);
  }
}

async function ligarModoDiff() {
  try {
    trocarModoDiff((await loadSettings()).viewMode);
    await onSettings(({ viewMode }) => trocarModoDiff(viewMode));
  } catch (e) {
    jlog(`preferências do diff: ${e}`);
  }
}

/// Redesenha os diffs do chat no modo novo. O que estava aberto continua aberto.
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

/// O que uma ferramenta mudou num arquivo, como o terminal mostra: o nome, a
/// contagem, as linhas numeradas. Em prévia como as mensagens longas — as
/// primeiras linhas, e o resto a um clique.
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
  // O ícone é o do modo para onde o clique leva.
  const modo = elemento("button", "chat-diff-modo");
  modo.innerHTML = lado ? ICONE_UNIFICADO : ICONE_LADO_A_LADO;
  modo.title = lado ? "Ver unificado (vale para todos os diffs)" : "Ver lado a lado (vale para todos os diffs)";
  modo.addEventListener("mousedown", (e) => e.preventDefault());
  modo.addEventListener("click", () => {
    const novo: ViewMode = lado ? "unified" : "split";
    trocarModoDiff(novo);
    saveViewMode(novo).catch((e) => jlog(`salvar modo do diff: ${e}`));
  });
  resumo.append(nome, ` ${partes}`, modo);
  // A coluna dos números tem a largura do maior deles.
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
    nota.textContent = `… mais ${total - DIFF_MAXIMO} linhas`;
    el.append(nota);
  }
  return el;
}

/// A partir de quantas linhas (ou caracteres, para quem cola uma linha só
/// enorme) um texto nasce recolhido. Um log colado ocupava a tela inteira e
/// empurrava a resposta para longe.
const LONGA_LINHAS = 10;
const LONGA_CHARS = 900;

/// O seu balão: o que você digitou, o que colou (sem as tags `<pasted_content>`
/// que o Claude Code põe em volta) e as imagens, cada uma onde o texto a cita.
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
      titulo.textContent = `Texto colado · ${linhas} ${linhas === 1 ? "linha" : "linhas"}`;
      caixa.append(titulo, recolhivel(p.texto));
      el.append(caixa);
    } else el.append(recolhivel(p.texto));
  }
}

/// Um texto que, longo, nasce recolhido em poucas linhas com um botão para
/// abrir. Curto, é só o texto.
function recolhivel(texto: string): HTMLElement {
  const corpo = elemento("div", "");
  corpo.textContent = texto;
  const linhas = texto.split("\n").length;
  return emPrevia(corpo, linhas, linhas > LONGA_LINHAS || texto.length > LONGA_CHARS);
}

/// O mesmo para qualquer conteúdo (o diff de uma edição): `longo` diz se ele
/// nasce recolhido com o botão, e `linhas` é o que o botão conta.
function emPrevia(corpo: HTMLElement, linhas: number, longo: boolean): HTMLElement {
  const el = elemento("div", "chat-recolhivel");
  corpo.classList.add("chat-recolhivel-corpo");
  el.append(corpo);
  if (!longo) return el;
  const botao = elemento("button", "chat-recolhivel-botao");
  const rotulo = () => {
    botao.textContent = el.classList.contains("recolhida") ? `Mostrar tudo · ${linhas} linhas` : "Recolher";
  };
  botao.addEventListener("click", () => {
    el.classList.toggle("recolhida");
    rotulo();
    // Recolhido do meio (o botão flutua), o começo do texto ficaria lá em
    // cima, fora da tela: traz ele de volta para não perder o lugar.
    if (el.classList.contains("recolhida")) el.scrollIntoView({ block: "nearest" });
  });
  el.classList.add("recolhida");
  el.append(botao);
  rotulo();
  return el;
}

/// A imagem em tamanho de tela, por cima de tudo. Clique ou esc fecham.
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

/// Lê o que o transcript ganhou e põe no fim da conversa.
async function lerChat(folha: Folha) {
  const chat = folha.chat;
  if (!chat || chat.lendo || folha.morta) return;
  // A sessão acabou: a última conversa continua na tela, só não cresce mais.
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
        nota.textContent = "O começo desta conversa ficou no terminal: aqui está só a parte mais recente.";
        chat.lista.prepend(nota);
      }
      chat.falas = [];
      // Da conversa que já existia, só o fim vai para a tela.
      chat.desde = Math.max(0, falas.length - CHAT_JANELA);
      chat.mais.hidden = chat.desde === 0;
      chat.noFim = true;
    }
    chat.caminho = caminho;
    chat.fim = t.fim;
    if (!falas.length) return;
    const primeira = Math.max(chat.desde - chat.falas.length, 0);
    chat.falas.push(...falas);
    // Cada fala sua que chega toma o lugar do balão provisório dela.
    for (const f of falas) {
      if (f.quem !== "voce") continue;
      const n = provisoriosResolvidos(
        chat.pendentes.map((p) => p.texto),
        f.texto,
      );
      for (const p of chat.pendentes.splice(0, n)) p.el.remove();
    }
    chat.lista.append(...falas.slice(primeira).map(desenharFala));
    // Só acompanha o fim quem já estava nele: quem subiu para reler não é
    // puxado de volta a cada fala nova.
    if (chat.aberto) reporRolagem(chat);
    // A conversa retomada traz prompts que o hook não viu passar.
    lembrarPrompts(folha, falas.flatMap((f) => (f.quem === "voce" ? [f.texto] : [])));
  } catch (e) {
    // O Claude só cria o arquivo na primeira fala: até lá, não há o que ler.
    if (!String(e).includes("No such file")) jlog(`chat: ${e}`);
  } finally {
    chat.lendo = false;
  }
}

/// Troca o painel entre o terminal e a conversa em balões. É por painel: com a
/// tela dividida, um pode estar no chat e o vizinho no terminal.
/// ⌘ ou ⌃ clique abre o link no navegador; o clique sozinho fica para
/// selecionar e posicionar, como no iTerm.
function abrirLink(e: MouseEvent, url: string) {
  if (!e.metaKey && !e.ctrlKey) return;
  invoke("abrir_link", { url }).catch((err) => jlog(`abrir link: ${err}`));
}

/// Mais curta que a do maximizar: é uma camada que aparece, não o layout andando.
const DURACAO_CHAT = 180;

/// Entra ou sai o chat de cima do terminal: esmaece com um leve deslize. Na
/// saída ele só some de vez no fim, e enquanto isso não segura os cliques — o
/// terminal embaixo já é o painel.
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
  // Virar no meio do caminho começa do ponto espelhado, sem pulo.
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
    // Sem sessão do Claude no painel, o botão a abre: o chat é o jeito de
    // começar uma conversa naquela pasta, e não só de ver uma que já existe.
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

/// Abre o Claude Code no shell do painel, na pasta em que ele está, e já entra
/// no modo chat. A conversa aparece quando o hook do `SessionStart` disser qual
/// é o transcript dela.
async function abrirClaudeNoChat(folha: Folha) {
  // Com outro programa na frente do shell, o `claude` seria digitado dentro
  // dele — num vim, num servidor rodando.
  if (await invoke<boolean>("pty_ocupado", { id: folha.id }).catch(() => false)) {
    return avisar(folha, "Há um programa rodando neste painel: o Claude não foi aberto");
  }
  // O clique repetido enquanto a pergunta acima ia e voltava.
  if (folha.morta || folha.claude || folha.chat?.aberto) return;
  await invoke("pty_write", { id: folha.id, data: "claude\r" }).catch((e) => jlog(`abrir claude: ${e}`));
  // Marcada desde já: é o que faz o segundo clique fechar o chat em vez de
  // digitar `claude` de novo. O resto chega com o primeiro evento da sessão.
  folha.claude = { nome: folha.titulo, estado: "ocioso" };
  alternarChat(folha);
}

// ---------- o visor: um arquivo dentro do painel ----------

/// O que mostrar: um arquivo, a linha (ou o trecho) a marcar e, com `ref`, a
/// versão dele naquele ponto do git em vez da do disco.
type PedidoVer = { caminho: string; linha?: number; ate?: number; ref?: string };

/// O que chega pelo socket quando alguém roda `termiau ver` (ver hooks/termiau).
type PedidoDoSocket = {
  painel: number;
  ver: { caminho?: string; linha?: number | null; ate?: number | null; ref?: string | null };
};

/// O arquivo ao lado do terminal (ou do chat), ou por cima dele: o terminal
/// segue vivo, com o Claude rodando, e o botão da barra mostra e esconde o
/// arquivo. Como ele se arruma no painel é o `arranjoVisor`.
type Visor = {
  el: HTMLDivElement;
  /// A borda entre o arquivo e o terminal, que se arrasta. Só no dividido.
  alca: HTMLDivElement;
  corpo: HTMLDivElement;
  caminho: HTMLSpanElement;
  ref: HTMLSpanElement;
  voltar: HTMLButtonElement;
  avancar: HTMLButtonElement;
  modo: HTMLButtonElement;
  arranjo: HTMLButtonElement;
  aberto: boolean;
  transicao?: Animation;
  /// No dividido, quem fica com o teclado: o arquivo ou o terminal/chat. É o
  /// lado em que você clicou por último.
  comTeclado: boolean;
  /// Onde você deixou a rolagem. Não se lê do `scrollTop` na hora de redesenhar:
  /// pego no meio de uma gravação, o arquivo chega curto (ou vazio), a rolagem
  /// encolhe junto, e a releitura seguinte voltaria para o topo.
  rolagem: number;
  /// Os eventos de rolagem que o próprio redesenho provoca não são você rolando.
  segurando: number;
  /// Os arquivos abertos neste painel, para ‹ e › andarem entre eles.
  historico: PedidoVer[];
  pos: number;
  /// Um .md mostrado renderizado, e não como fonte.
  renderizado: boolean;
  /// O carimbo do arquivo mostrado: mudou no disco, o visor relê.
  carimbo?: string;
  linhas?: string[];
  pulso?: ReturnType<typeof setInterval>;
  /// Respostas chegando fora de ordem (‹ › apertados depressa) não desenham
  /// por cima da mais nova.
  vez: number;
};

/// Quantos arquivos o ‹ alcança.
const VISOR_HISTORICO = 30;
/// De quanto em quanto o visor aberto confere se o arquivo mudou no disco.
const VISOR_MS = 1000;

/// Como o visor se arruma no painel: ao lado do terminal, em cima dele, ou por
/// cima, cobrindo-o. Vale para todos os painéis, e a fatia (do visor) também.
type Arranjo = "lado" | "abaixo" | "sobre";
const ARRANJOS: Arranjo[] = ["lado", "abaixo", "sobre"];
const ROTULO_ARRANJO: Record<Arranjo, string> = {
  lado: "Lado a lado",
  abaixo: "Arquivo em cima, terminal embaixo",
  sobre: "Por cima do terminal",
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
    // Só uma conveniência.
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

/// Mostra o arquivo no visor do painel, abrindo-o se estava fechado. Num
/// terminal de gaveta, quem mostra é o painel dono dela.
function abrirArquivo(folha: Folha, pedido: PedidoVer) {
  const dono = folha.dono ?? folha;
  if (dono.morta) return;
  const v = (dono.visor ??= criarVisor(dono));
  const atual = v.historico[v.pos];
  // O mesmo arquivo de novo, sem linha: é só mostrá-lo, sem perder onde você estava.
  if (atual && atual.caminho === pedido.caminho && atual.ref === pedido.ref && !pedido.linha && !atual.linha) {
    if (v.aberto) void carregarVisor(dono, false);
    else alternarVisor(dono);
    return;
  }
  v.historico = [...v.historico.slice(0, v.pos + 1), pedido].slice(-VISOR_HISTORICO);
  v.pos = v.historico.length - 1;
  // Com uma linha pedida, o .md abre na fonte: é lá que a linha existe.
  v.renderizado = ehMarkdown(pedido.caminho) && !pedido.linha;
  if (v.aberto) void carregarVisor(dono, true);
  else alternarVisor(dono, true);
}

/// Mostra ou esconde o visor. Esconder e mostrar de novo volta para onde você
/// estava; `rolar` é para um arquivo recém-pedido, que abre no topo (ou na linha).
function alternarVisor(folha: Folha, rolar = false) {
  const v = folha.visor;
  if (!v?.historico.length) return;
  v.aberto = !v.aberto;
  // Ao abrir dividido, o teclado fica onde estava: no chat, no terminal.
  if (v.aberto) v.comTeclado = false;
  if (arranjoVisor === "sobre") transicionarChat(v);
  else {
    // Dividido o terminal muda de tamanho junto: sem animação, que o faria
    // ser medido no meio dela.
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

/// Põe o visor no lugar do arranjo: divide o espaço do terminal com ele, ou o
/// deixa por cima. O terminal que mudou de tamanho é medido de novo.
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
  v.arranjo.title = `${ROTULO_ARRANJO[arranjoVisor]} — clique para trocar`;
  if (host.className === antes) return;
  const aba = abaDe(folha);
  if (aba && aba === ativa && !noDiff) {
    medir(aba);
    agendarSync(aba);
  }
}

/// Arrastar a borda muda quanto do painel é do arquivo; dois cliques, meio a meio.
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
  voltar.title = "Arquivo anterior";
  const avancar = elemento("button", "visor-btn");
  avancar.textContent = "›";
  avancar.title = "Próximo arquivo";
  const caminho = elemento("span", "visor-caminho");
  const ref = elemento("span", "visor-ref");
  const modo = elemento("button", "visor-btn visor-btn-texto");
  const arranjo = elemento("button", "visor-btn visor-btn-icone");
  const editor = elemento("button", "visor-btn visor-btn-texto");
  editor.textContent = "Abrir no editor";
  editor.title = "O editor se escolhe nas Preferências (⌘,)";
  const fechar = elemento("button", "visor-btn");
  fechar.textContent = "✕";
  fechar.title = "Voltar ao terminal (esc)";
  cabeca.append(voltar, avancar, caminho, ref, modo, arranjo, editor, fechar);
  const corpo = elemento("div", "visor-corpo");
  corpo.tabIndex = 0;
  el.append(cabeca, corpo);
  const alca = elemento("div", "visor-alca");
  // Dentro do elemento do terminal, ao lado da tela dele: dividido, o visor
  // toma uma fatia dela; por cima, a cobre inteira.
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
    aberto: false,
    comTeclado: false,
    rolagem: 0,
    segurando: 0,
    historico: [],
    pos: 0,
    renderizado: false,
    vez: 0,
  };
  ligarAlcaVisor(folha, v);
  corpo.addEventListener("scroll", () => {
    if (!v.segurando) v.rolagem = corpo.scrollTop;
  });
  // Os botões não tiram o teclado do corpo: o esc continua fechando.
  for (const b of [voltar, avancar, modo, arranjo, editor, fechar]) b.addEventListener("mousedown", (e) => e.preventDefault());
  arranjo.addEventListener("click", () => {
    arranjoVisor = ARRANJOS[(ARRANJOS.indexOf(arranjoVisor) + 1) % ARRANJOS.length];
    lembrarPrefVisor();
    v.transicao?.cancel();
    v.transicao = undefined;
    arrumarVisor(folha);
    if (abaDe(folha)?.foco === folha) teclado(folha);
  });
  const andar = (passo: number) => {
    const pos = v.pos + passo;
    if (pos < 0 || pos >= v.historico.length) return;
    v.pos = pos;
    const p = v.historico[pos];
    v.renderizado = ehMarkdown(p.caminho) && !p.linha;
    void carregarVisor(folha, true);
  };
  voltar.addEventListener("click", () => andar(-1));
  avancar.addEventListener("click", () => andar(1));
  modo.addEventListener("click", () => {
    v.renderizado = !v.renderizado;
    desenharVisor(folha, true);
  });
  editor.addEventListener("click", () => {
    const p = v.historico[v.pos];
    void (async () => {
      const comando = (await loadSettings().catch(() => undefined))?.editor.trim() || null;
      await invoke("abrir_no_editor", { caminho: p.caminho, linha: p.linha ?? null, comando });
    })().catch((e) => avisar(folha, `Editor: ${e}`));
  });
  fechar.addEventListener("click", () => alternarVisor(folha));
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
  return v;
}

const pastaDe = (caminho: string) => caminho.slice(0, caminho.lastIndexOf("/")) || "/";

/// O caminho como se lê na barra: a partir da pasta do painel, ou com `~`.
function caminhoCurto(folha: Folha, caminho: string): string {
  const base = folha.barra?.repo ?? folha.barra?.pasta;
  if (base && caminho.startsWith(`${base}/`)) return caminho.slice(base.length + 1);
  const home = caminho.match(/^\/Users\/[^/]+\//)?.[0];
  return home ? `~/${caminho.slice(home.length)}` : caminho;
}

async function carregarVisor(folha: Folha, rolar: boolean) {
  const v = folha.visor;
  if (!v) return;
  const p = v.historico[v.pos];
  const vez = ++v.vez;
  v.caminho.textContent = caminhoCurto(folha, p.caminho) + (p.linha ? `:${p.linha}${p.ate ? `-${p.ate}` : ""}` : "");
  v.caminho.title = p.caminho;
  v.ref.textContent = p.ref ?? "";
  v.ref.hidden = !p.ref;
  v.voltar.disabled = v.pos === 0;
  v.avancar.disabled = v.pos === v.historico.length - 1;
  try {
    const arq = await invoke<{ linhas: string[]; carimbo: string }>("arquivo_ler", { caminho: p.caminho, rf: p.ref ?? null });
    if (vez !== v.vez) return;
    v.linhas = arq.linhas;
    v.carimbo = arq.carimbo;
  } catch (e) {
    if (vez !== v.vez) return;
    v.linhas = undefined;
    v.carimbo = undefined;
    const erro = elemento("div", "visor-erro");
    erro.textContent = `Não deu para abrir: ${e}`;
    v.corpo.replaceChildren(erro);
    v.modo.hidden = true;
    return;
  }
  desenharVisor(folha, rolar);
}

/// O Claude editou o arquivo aberto: o visor acompanha, sem perder a rolagem.
async function conferirVisor(folha: Folha) {
  const v = folha.visor;
  if (!v?.aberto || !v.carimbo) return;
  const p = v.historico[v.pos];
  if (p.ref) return;
  const agora = await invoke<string | null>("arquivo_carimbo", { caminho: p.caminho }).catch(() => null);
  if (agora && agora !== v.carimbo && v.historico[v.pos] === p) void carregarVisor(folha, false);
}

function desenharVisor(folha: Folha, rolar: boolean) {
  const v = folha.visor;
  const linhas = v?.linhas;
  if (!v || !linhas) return;
  const p = v.historico[v.pos];
  const md = ehMarkdown(p.caminho);
  v.modo.hidden = !md;
  v.modo.textContent = v.renderizado ? "Ver fonte" : "Ver renderizado";
  // A rolagem que o redesenho mexe (o conteúdo some e volta) não é sua: só a
  // que você fizer depois de dois quadros conta.
  const segurando = ++v.segurando;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (v.segurando === segurando) v.segurando = 0;
    }),
  );
  const topo = rolar ? 0 : v.rolagem;

  if (md && v.renderizado) {
    const html = elemento("div", "visor-md chat-claude");
    html.innerHTML = markdown(linhas.join("\n"), 0);
    v.corpo.replaceChildren(html);
    v.corpo.scrollTop = topo;
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
    // Um terço abaixo do topo: dá para ver o que vem antes da linha.
    if (alvo) v.corpo.scrollTop = alvo.offsetTop - v.corpo.clientHeight / 3;
  } else {
    v.corpo.scrollTop = topo;
  }
  if (rolar) v.rolagem = v.corpo.scrollTop;
  void colorirVisor(v, codigo, p.caminho, linhas);
}

/// As cores vêm depois, do mesmo shiki do differ: o arquivo aparece na hora, e
/// o import só pesa na primeira vez que o visor abre.
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
    if (!alvo || !linha.length) return;
    alvo.innerHTML = linha
      .map((t) => {
        const estilo = [t.color ? `color:${t.color}` : "", t.fontStyle === 1 ? "font-style:italic" : ""].filter(Boolean).join(";");
        return estilo ? `<span style="${estilo}">${escapar(t.content)}</span>` : escapar(t.content);
      })
      .join("");
  });
}

// ---------- referências a arquivo: ⌘-clique ----------

/// A pasta de onde os caminhos relativos do painel partem: a do processo na
/// frente do shell, que com o Claude rodando é a pasta dele. Guardada por uns
/// segundos, porque o xterm pergunta a cada linha por onde o mouse passa.
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

/// As referências que existem de verdade, já com o caminho absoluto.
async function resolver(base: string | null, refs: Referencia[]): Promise<(string | null)[]> {
  if (!base || !refs.length) return refs.map(() => null);
  return invoke<(string | null)[]>("arquivos_existem", { base, candidatos: refs.map((r) => r.arquivo) }).catch(() =>
    refs.map(() => null),
  );
}

/// Um `caminho:linha` na saída do terminal vira link: ⌘-clique abre no visor.
/// Só os que existem — a pasta do painel é que diz de onde o relativo parte.
function ligarLinksDeArquivo(folha: Folha) {
  const term = folha.term;
  term.registerLinkProvider({
    provideLinks(y, devolver) {
      const buf = term.buffer.active;
      const cols = term.cols;
      // Uma janela de linhas em volta: nenhum caminho atravessa mais que isso.
      const base = Math.max(0, y - 1 - 10);
      const linhas: LinhaDaTela[] = [];
      for (let i = base; i < Math.min(buf.length, y + 10); i++) {
        const l = buf.getLine(i);
        linhas.push({ texto: l?.translateToString(false) ?? "", quebrada: l?.isWrapped ?? false });
      }
      const aqui = y - 1 - base;
      // Com e sem o palpite de continuação, para cima e para baixo: juntar duas
      // linhas que não eram uma só estragaria a referência inteira numa delas.
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
        // Um pedaço que existe dentro de um caminho maior que também existe
        // (`lib/x.dart` dentro de `apps/lib/x.dart`): fica o maior.
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

/// ⌘-clique num `<code>` que é só um caminho (no chat, num .md do visor).
/// Devolve se o clique era isso, para quem chamou não tratar de novo.
function cliqueEmReferencia(folha: Folha, e: MouseEvent, base?: string): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  const code = (e.target as HTMLElement).closest("code");
  const ref = code && referenciaInteira(code.textContent ?? "");
  if (!ref) return false;
  e.preventDefault();
  void (async () => {
    const [caminho] = await resolver(base ?? (await pastaDoPainel(folha)), [ref]);
    if (caminho) abrirArquivo(folha, { caminho, linha: ref.linha, ate: ref.ate });
    else avisar(folha.dono ?? folha, `Não achei ${ref.arquivo}`);
  })();
  return true;
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
  /// O contexto da sessão do Claude: uma pílula só, a barra enchendo com o que
  /// já foi usado e o número por cima dela. O clique compacta a conversa.
  contexto: HTMLButtonElement;
  contextoCheio: HTMLSpanElement;
  contextoNum: HTMLSpanElement;
  /// O modelo e o esforço da sessão, ao lado do contexto. O clique abre a
  /// lista para trocar.
  modelo: HTMLButtonElement;
  esforco: HTMLButtonElement;
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
  chat: HTMLButtonElement;
  visor: HTMLButtonElement;
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
const ICONE_CHAT = traco("M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z");
const ICONE_ARQUIVO = traco("M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5ZM9.5 1.5V5H13M6 8.5h4M6 11h4");
/// O botão de arranjo do visor (ver `Arranjo`).
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
  const chat = botaoTarefa("tarefa-chat", ICONE_CHAT);
  // Só aparece depois do primeiro arquivo aberto: antes não há o que mostrar.
  const visor = botaoTarefa("tarefa-visor", ICONE_ARQUIVO);
  visor.hidden = true;
  const maximizar = botaoTarefa("tarefa-maximizar", ICONE_MAXIMIZAR);
  // Quem decide se aparece é `desenharMaximizar`, quando a folha já tem aba.
  maximizar.hidden = true;
  controles.append(acoes, gaveta, parar, grupoPlay, diff, chat, visor, maximizar);
  const ramo = criarRamo("tarefa-ramo");
  const contexto = botaoTarefa("tarefa-contexto", "");
  contexto.hidden = true;
  const contextoCheio = elemento("span", "tarefa-contexto-cheio");
  const contextoNum = elemento("span", "tarefa-contexto-num");
  contexto.append(contextoCheio, contextoNum);
  const modelo = botaoTarefa("tarefa-claude-opcao tarefa-modelo", "");
  const esforco = botaoTarefa("tarefa-claude-opcao tarefa-esforco", "");
  modelo.hidden = esforco.hidden = true;
  el.append(titulo, ramo.el, contexto, modelo, esforco, aviso, controles);
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
    maximizar,
    projeto: null,
    repo: null,
    pedido: 0,
  };
}

function ligarBarra(folha: Folha) {
  const b = folha.barra;
  if (!b) return;
  b.contexto.addEventListener("click", () => compactar(folha));
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
  // O diff é de um repositório, e quem sabe qual é o painel: cada um tem o seu
  // diretório — com a tela dividida em três projetos, cada painel diz o seu.
  b.diff.addEventListener("click", () => void abrirDiff(folha));
  b.chat.addEventListener("click", () => alternarChat(folha));
  b.visor.addEventListener("click", () => alternarVisor(folha));
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

  // O contexto enche conforme a conversa cresce: amarelo e vermelho pelos
  // limites das Preferências. A pílula fica enquanto houver sessão, ociosa ou
  // não — é com o Claude parado que dá para compactar. Antes da primeira
  // status line ela existe, só sem número.
  const usado = folha.claude?.contexto;
  b.contexto.hidden = !folha.claude;
  let nivel: Nivel = "";
  if (usado === undefined) {
    b.contextoCheio.style.width = "0%";
    b.contextoNum.textContent = "Contexto —";
    b.contexto.title = "Contexto da sessão: chega quando o Claude responder — clique para compactar (⌘⇧K)";
  } else {
    const pct = Math.round(Math.min(100, Math.max(0, usado)));
    nivel = nivelDoContexto(pct, limitesDoContexto);
    b.contextoCheio.style.width = `${pct}%`;
    b.contextoNum.textContent = `Contexto ${pct}%`;
    b.contexto.title = `Contexto da sessão: ${pct}% usado, ${100 - pct}% livre — clique para compactar (⌘⇧K)`;
  }
  b.contexto.dataset.nivel = nivel;
  // No vermelho, o painel inteiro avisa: a pílula sozinha some no canto do olho.
  folha.el.classList.toggle("contexto-cheio", nivel === "perigo");

  // O modelo chega com a primeira status line; o esforço só existe nos modelos
  // que o têm.
  const c = folha.claude;
  b.modelo.hidden = !c;
  b.modelo.textContent = c?.modelo ?? "Modelo —";
  b.modelo.title = c?.modelo ? `Modelo da sessão: ${c.modelo} — clique para trocar` : "Modelo da sessão: chega quando o Claude responder";
  b.esforco.hidden = !c?.esforco;
  const esf = ESFORCOS.find((e) => e.nivel === c?.esforco);
  b.esforco.textContent = `Esforço ${esf?.rotulo ?? c?.esforco ?? ""}`;
  b.esforco.title = "Nível de esforço do Claude — clique para trocar";

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

  // Sempre à mão: com sessão do Claude ele troca de modo; sem ela, abre uma
  // nesta pasta, já no chat.
  const noChat = folha.chat?.aberto === true;
  b.chat.hidden = false;
  b.chat.classList.toggle("ligado", noChat);
  b.chat.title = noChat
    ? "Voltar ao terminal (⌘⇧C)"
    : folha.claude
      ? "Ver a conversa em modo chat (⌘⇧C)"
      : "Abrir o Claude nesta pasta, em modo chat (⌘⇧C)";

  const visor = folha.visor;
  b.visor.hidden = !visor?.historico.length;
  b.visor.classList.toggle("ligado", visor?.aberto === true);
  b.visor.title = visor?.aberto ? "Esconder o arquivo (⌘⇧O)" : "Mostrar o arquivo (⌘⇧O)";

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
  // Um `cd` muda a pasta em que o painel volta.
  agendarSalvar();
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
/// O botão que abriu a lista: o mesmo painel tem três (configurações, modelo e
/// esforço), e clicar em outro troca a lista em vez de fechar.
let menuAncora: HTMLElement | undefined;

function montarMenu() {
  menuEl.hidden = true;
  document.body.append(menuEl);
  // Clicar fora fecha a lista, como qualquer menu. O botão que a abre fica de
  // fora: ele mesmo alterna.
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
  abrirMenu(folha, b.escolher);
}

/// Mostra a lista já montada junto do botão que a abriu.
function abrirMenu(folha: Folha, ancora: HTMLElement) {
  // Mede a lista na altura natural antes de decidir onde ela vai: é essa altura
  // que diz se cabe embaixo. Tudo no mesmo quadro, então nada pisca.
  menuEl.style.maxHeight = "";
  menuEl.style.top = "0px";
  menuEl.style.bottom = "";
  menuEl.hidden = false;
  const altura = menuEl.offsetHeight;

  const r = ancora.getBoundingClientRect();
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
  menuAncora = ancora;
}

/// Os modelos que o `/model` aceita pelo apelido. O "padrão" é o da conta.
const MODELOS = [
  { apelido: "fable", rotulo: "Fable" },
  { apelido: "opus", rotulo: "Opus" },
  { apelido: "sonnet", rotulo: "Sonnet" },
  { apelido: "haiku", rotulo: "Haiku" },
  { apelido: "default", rotulo: "Padrão da conta" },
];

/// Os níveis do `/effort`. Nem todo modelo tem todos: o Claude recusa o que
/// não houver, e o recado aparece no terminal.
const ESFORCOS = [
  { nivel: "low", rotulo: "baixo" },
  { nivel: "medium", rotulo: "médio" },
  { nivel: "high", rotulo: "alto" },
  { nivel: "xhigh", rotulo: "extra alto" },
  { nivel: "max", rotulo: "máximo" },
  { nivel: "auto", rotulo: "automático" },
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
        mandarAoClaude(folha, o.comando, "troque");
      });
      return item;
    }),
  );
  abrirMenu(folha, ancora);
}

/// Recado curto na barra, ao lado do título: o play que não pôde rodar diz por quê.
/// Manda o `/compact` para o Claude do painel, como se você o digitasse — o
/// mesmo caminho do campo do chat. Com ele trabalhando o comando entraria na
/// fila, ou no meio do que você estiver digitando: só compacta parado.
function compactar(folha: Folha) {
  mandarAoClaude(folha, "/compact", "compacte");
}

/// Digita um comando no Claude do painel e dá Enter. O verbo vai no aviso de
/// quando ele está trabalhando.
function mandarAoClaude(folha: Folha, comando: string, verbo: string) {
  const dono = folha.dono ?? folha;
  if (!dono.claude) return;
  if (dono.claude.estado === "trabalhando") {
    avisar(dono, `O Claude está trabalhando: ${verbo} quando ele parar.`);
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

// ---------- o uso do Claude no rodapé ----------

/// O círculo do Claude Usage Monitor, no canto esquerdo do rodapé: o círculo é
/// o tempo que falta na sessão de 5h, e o número, quanto do uso dela ainda
/// resta. Tudo conta para baixo. A cor é a do ritmo — acende quando você gasta
/// mais depressa do que o tempo passa. Com o mouse em cima, abrem para a
/// direita duas colunas, sessão e semana, cada uma com o tempo e o uso.
const usoEl = document.getElementById("uso") as HTMLDivElement;

/// O mesmo raio do volume (5,5 no viewBox de 16): o perímetro é o traço inteiro.
const USO_CIRCULO = 2 * Math.PI * 5.5;
/// O brilho que corre pelo círculo e pelas barras, no sentido em que esvaziam.
const USO_BRILHO = 2.2;
/// Uma passada do brilho do círculo e das barrinhas, da ponta ao começo.
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

/// Uma coluna: o nome e, à direita dele, as duas linhas — o tempo que falta e
/// o uso que resta.
function colunaDeUso(nome: string) {
  const coluna = elemento("span", "uso-coluna");
  const titulo = elemento("span", "uso-titulo");
  titulo.textContent = nome;
  const linhas = elemento("span", "uso-linhas");
  const tempo = barraDeUso("Tempo restante", "uso-tempo");
  const uso = barraDeUso("Tokens disponíveis", "uso-uso");
  linhas.append(tempo.linha, uso.linha);
  coluna.append(titulo, linhas);
  return { coluna, tempo, uso };
}

const usoSessao = colunaDeUso("Sessão");
const usoSemana = colunaDeUso("Semana");
/// `vertical`: a barra dos tokens ao lado do relógio, que esvazia de cima
/// para baixo; as do hover esvaziam da direita para a esquerda.
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
/// Os ponteiros dentro do círculo: o pequeno aponta para a ponta do trecho
/// aceso (quanto falta da sessão), e o grande dá uma volta no hover.
const usoHora = usoIcone.querySelector(".ponteiro-hora") as SVGLineElement;
const usoMinuto = usoIcone.querySelector(".ponteiro-minuto") as SVGLineElement;
/// Ao lado do relógio: os tokens disponíveis da sessão, uma barra em pé que
/// esvazia de cima para baixo, como uma bateria, e o número ao lado dela.
const usoResumo = elemento("span", "uso-resumo");
const usoPct = elemento("span", "uso-pct");
const usoMiniTrilho = elemento("span", "uso-trilho uso-mini");
const usoMini = { cheio: elemento("span", "uso-cheio"), ponteiro: elemento("span", "uso-ponteiro"), vertical: true };
usoMini.cheio.append(usoMini.ponteiro);
usoMiniTrilho.append(usoMini.cheio);
usoResumo.append(usoMiniTrilho, usoPct);
usoBarras.push(usoMini);
usoEl.append(usoIcone, usoResumo, usoDetalhe);

/// A última leitura boa: um 429 ou a rede caindo não apagam o que já se sabia.
let usoAtual: Uso | undefined;
/// O pedaço do círculo aceso agora, em comprimento de traço.
let usoArco = USO_CIRCULO;
/// As animações do brilho do círculo e das barrinhas, criadas juntas.
let usoEscoar: Animation[] = [];

const limitar = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

function pintarBarra(b: BarraDeUso, resta: number | null, texto: string, nivel: Nivel) {
  b.cheio.style.width = `${resta ?? 0}%`;
  b.num.textContent = resta === null ? "—" : texto;
  b.linha.dataset.nivel = nivel;
}

/// A dica de uma janela: o nome e, uma por linha, o que resta dela.
function dicaDeUso(nome: string, j: Janela | null): string {
  if (!j) return `${nome}:\nsem janela aberta`;
  return `${nome}:\n${limitar(100 - j.uso)}% de tokens disponíveis\n${faltaPara(j.renova)} de tempo restante`;
}

/// Uma coluna: as duas barras contam o que resta, o tempo e o uso.
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

/// O brilho do círculo e as barrinhas das barras correm da ponta de volta ao
/// começo, no sentido em que tudo diminui, e o ponteiro do minuto dá uma volta.
/// São criados todos na mesma chamada, e por isso andam juntos: mesmo período,
/// mesmo passo, e apagam no fim. Uma vez só, no hover — parado o resto do tempo.
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
  usoEl.title = `${dicaDeUso("Sessão", s)}\n\n${dicaDeUso("Semana", u.semana)}`;
  usoArco = USO_CIRCULO * restante;
}

/// Ao passar o mouse, o círculo e as barras partem do cheio e descem até onde
/// estão: a cada vez que você olha, vê que estão diminuindo.
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

/// A última notícia do uso fica guardada: a status line só fala com o Claude
/// rodando, e abrir o app não pode deixar o rodapé vazio até lá.
const CHAVE_USO = "termiau:uso";

/// O uso chegou pela status line de algum painel: vale para todos, a conta é
/// uma só.
function receberUso(u: Uso) {
  usoNoticia = u;
  try {
    localStorage.setItem(CHAVE_USO, JSON.stringify(u));
  } catch {
    // Só uma conveniência.
  }
  atualizarUso();
}

/// A notícia, como está agora: a janela que renovou desde ela volta zerada.
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
// Entre uma notícia e outra, o tempo continua passando: o "quanto falta" e o
// círculo andam sozinhos.
setInterval(atualizarUso, 30_000);

// ---------- rádio: a do rodapé ----------

/// A lista mora no `estacoes.ts`, com a explicação de onde ela vem e do que o
/// `espectro` de cada uma quer dizer.
const estacoes = ESTACOES;

/// A estação de agora vai guardada pelo endereço, e não pelo índice: a lista é
/// refeita a cada sondagem, e o índice passaria a apontar para outra. O volume é
/// um número de 0 a 100.
const CHAVE_ATUAL = "termiau:radio:atual";
const CHAVE_VOLUME = "termiau:lofi:volume";
/// Se a rádio estava no ar quando o app fechou: ela volta a tocar na abertura.
const CHAVE_TOCANDO = "termiau:radio:tocando";

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

/// Os alvos inventados de cada banda, quando não há o que medir, e daqui a
/// quantos quadros cada uma sorteia o próximo.
const specSorteio = new Array<number>(SPEC_BANDAS).fill(0);
const specEspera = new Array<number>(SPEC_BANDAS).fill(0);
/// Quantos quadros faltam para a próxima batida, também sorteados.
let specBatida = 0;

const sortear = (de: number, ate: number) => de + Math.random() * (ate - de);

/// Pelo caminho direto (a estação não deixa o áudio ser lido) o mostrador não
/// tem amostra, mas parado ele parecia a rádio desligada. Então ele anda de
/// mentira, sem compasso nenhum: cada banda sorteia a altura e quanto tempo
/// fica nela, e de tempos em tempos (também sorteados) vem uma batida de força
/// sorteada nos graves. O resto — subir no quadro, descer aos poucos, o pico no
/// ar — é o mesmo do medido.
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
      // Os graves tendem a ir mais alto, mas qualquer banda pode ir ao topo ou
      // ao chão.
      const teto = 1 - (b / SPEC_BANDAS) * 0.35;
      specSorteio[b] = teto * Math.random() ** sortear(0.6, 1.6);
    }
    const alvo = specSorteio[b];
    specNiveis[b] = alvo > specNiveis[b] ? alvo : Math.max(0, specNiveis[b] - SPEC_QUEDA * sortear(0.6, 1.4));
    specPicos[b] = Math.max(specNiveis[b], specPicos[b] - SPEC_QUEDA_PICO);
    // O alvo cumprido se desfaz: sem isto a coluna ficava pregada nele.
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

/// Liga e desliga a animação: medida (pelo grafo), sorteada (pelo caminho
/// direto) ou nenhuma. A saída rápida importa: `desenharLofi` roda a cada
/// evento do áudio, e reiniciar o intervalo em cada um faria o mostrador andar
/// aos trancos.
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

  // Pelo grafo o mostrador mede o som; pelo caminho direto não há amostra, e
  // ele anda sorteado — parado, parecia que a rádio não estava tocando.
  animarSpec(!tocandoLofi ? undefined : audio === audioGrafo ? "medido" : "sorteado");
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

  // Pausa que não veio de nós: a tecla de mídia do teclado, os controles de
  // "Tocando agora" do macOS. O rodapé tem de saber. Na volta seguinte do laço,
  // porque trocar o `src` no meio de um `tocarLofi` também passa por aqui, e aí
  // o `play()` logo atrás já desfez a pausa.
  el.addEventListener("pause", () => {
    setTimeout(() => {
      if (el !== audio || !noAr || !el.paused) return;
      pausarLofi();
    });
  });
  // E o play de fora, depois dela: volta ao vivo, e não ao ponto em que parou.
  el.addEventListener("play", () => {
    if (el !== audio || noAr) return;
    tocarLofi();
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
  localStorage.removeItem(CHAVE_TOCANDO);
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
function tocarLofi(automatico = false) {
  const e = atual();
  if (!e) return;

  noAr = true;
  carregandoLofi = true;
  avisoLofi = undefined;
  localStorage.setItem(CHAVE_TOCANDO, "1");

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
    // Na abertura não houve gesto, e o WebKit pode recusar: a rádio espera a
    // primeira tecla ou clique, calada, em vez de dar erro por algo que você
    // não pediu agora.
    if (automatico && erro instanceof DOMException && erro.name === "NotAllowedError") {
      localStorage.setItem(CHAVE_TOCANDO, "1");
      calar(audio);
      desenharLofi();
      tocarNoPrimeiroGesto();
      return;
    }
    localStorage.removeItem(CHAVE_TOCANDO);
    avisoLofi = `a rádio não abriu: ${erro}`;
    desenharLofi();
    jlog(`radio: ${erro}`);
  });
  atualizarTocandoAgora();
}

/// O gesto que libera o áudio. Na captura, para valer mesmo com a tecla indo
/// para o xterm; e o `tocarLofi` é síncrono, então o `play()` sai dentro dele.
function tocarNoPrimeiroGesto() {
  const tocar = () => {
    window.removeEventListener("keydown", tocar, true);
    window.removeEventListener("pointerdown", tocar, true);
    if (!noAr && localStorage.getItem(CHAVE_TOCANDO)) tocarLofi();
  };
  window.addEventListener("keydown", tocar, true);
  window.addEventListener("pointerdown", tocar, true);
}

/// O que o "Tocando agora" do macOS mostra, e quem responde às teclas de mídia:
/// sem os handlers, o sistema pausaria o elemento por conta própria e o rodapé
/// ficaria sem saber (o evento `pause` de cima ainda cobre isso).
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
      ["⌘⇧T", "Reabrir a aba fechada"],
      ["⌘⇧]", "Próxima aba"],
      ["⌘⇧[", "Aba anterior"],
      ["⌘`", "Diff da branch (a aba presa)"],
      ["⌘1 … ⌘8", "Ir para a aba de número"],
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
      ["⌘⇧C", "Alternar entre o chat e o terminal do Claude"],
      ["⌘⇧K", "Compactar a conversa do Claude (/compact)"],
      [["⌘⇧↑", "⌘⇧↓"], "Ir para a sua mensagem anterior ou seguinte"],
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
      ["⌘⇧P", "Tocar ou pausar a rádio"],
      ["⌘/", "Esta lista"],
      ["⌘M", "Minimizar"],
      ["⌃⌘F", "Tela cheia"],
      ["⌘H", "Ocultar o TermIAu"],
      ["⌘Q", "Sair (pergunta antes)"],
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

// ---------- sessão: as abas que voltam ----------

/// A foto de um painel: onde ele estava e, se havia um Claude rodando nele,
/// qual sessão. É o que vai para o disco e o que o ⌘⇧T guarda de uma aba fechada.
type NoSalvo =
  | { tipo: "folha"; cwd: string | null; claude?: string }
  | { tipo: "divisao"; eixo: Eixo; fracao: number; filhos: [NoSalvo, NoSalvo] };

type AbaSalva = {
  raiz: NoSalvo;
  /// O painel em foco, pela posição dele entre as folhas da árvore.
  foco: number;
};

/// As últimas abas fechadas, a mais recente no fim. Só desta execução: fechar o
/// app guarda as abertas, não as que você já tinha mandado embora.
const fechadas: AbaSalva[] = [];
const MAX_FECHADAS = 10;

/// O id vai parar numa linha de comando digitada no shell, e veio de um socket
/// em que qualquer processo do usuário escreve: só passa o que tem cara de id.
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
  // A pasta da sessão antes da do shell: com o Claude na frente, as duas
  // costumam ser a mesma, mas é a da sessão que o `--resume` exige.
  return { tipo: "folha", cwd: no.claude?.pasta ?? no.barra?.pasta ?? null, claude: no.claude?.sessao };
}

function fotografarAba(aba: Aba): AbaSalva {
  // Com o teclado na gaveta, quem volta em foco é o dono: a gaveta não volta.
  const foco = [...folhas(aba.raiz)].indexOf(aba.foco.dono ?? aba.foco);
  return { raiz: fotografar(aba.raiz), foco: Math.max(0, foco) };
}

/// Confere a forma do que veio do disco. Um arquivo de outra versão, ou mexido
/// à mão, não pode derrubar a abertura do app: o que não serve é ignorado.
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
    jlog(`sessão salva ilegível: ${e}`);
    return vazia;
  }
}

/// Verdadeiro até as abas salvas terminarem de voltar. Enquanto isso nada é
/// gravado: a primeira aba a voltar salvaria "uma aba" por cima das outras.
let restaurando = true;
let esperaSalvar: ReturnType<typeof setTimeout> | undefined;

/// Grava as abas de agora. A cada mudança, e não só ao sair: um crash, um
/// `kill` ou a bateria acabando também têm de achar as abas na volta.
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

/// Põe o painel de volta onde estava. Havendo sessão do Claude, a linha do
/// `--resume` é digitada no shell, como o play digita a dele: é assim que o
/// `claude` sai do PATH do seu .zshrc. O shell ainda está subindo — a linha
/// espera no terminal e ele a lê quando chegar ao prompt.
function retomar(folha: Folha, salvo: Extract<NoSalvo, { tipo: "folha" }>) {
  // Até o `carregarProjeto` responder: sair antes disso não pode salvar o
  // painel sem pasta.
  if (folha.barra && salvo.cwd) folha.barra.pasta ??= salvo.cwd;
  if (!salvo.claude) return;
  // Marcado desde já, e não só quando o hook avisar: sair antes do primeiro
  // evento da sessão retomada não pode esquecê-la.
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

/// Refaz a árvore salva a partir de um painel: cada corte divide o painel, o
/// primeiro filho continua nele e o segundo vai para o que nasceu. `feitas`
/// sai na ordem das folhas, que é a ordem em que o foco foi salvo.
async function montar(aba: Aba, folha: Folha, salvo: NoSalvo, feitas: Folha[]) {
  if (salvo.tipo === "folha") {
    retomar(folha, salvo);
    feitas.push(folha);
    return;
  }
  const [a, b] = salvo.filhos;
  const nova = await dividirFolha(aba, folha, salvo.eixo, primeiraFolha(b).cwd, salvo.fracao);
  await montar(aba, folha, a, feitas);
  // Sem shell para o segundo lado, o primeiro fica com o espaço todo.
  if (nova) await montar(aba, nova, b, feitas);
}

/// Traz uma aba de volta: os painéis nas pastas em que estavam, o layout como
/// era, e as sessões do Claude retomadas.
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

/// ⌘⇧T: a última aba fechada volta, como no navegador.
async function reabrirFechada() {
  const salva = fechadas.pop();
  if (!salva) return;
  // Não abriu (outro atalho no meio do caminho): a foto volta para a pilha.
  if (!(await reabrir(salva))) fechadas.push(salva);
}

/// As abas da última execução, na abertura do app. Sem nenhuma para trazer — a
/// primeira vez, ou a última aba foi fechada à mão —, abre uma nova.
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

// ---------- a caixa de pergunta ----------

/// Uma pergunta no meio da janela, na mesma casca do seletor de estações. O
/// botão de confirmar já nasce com o teclado: espaço ou ↩ confirmam, esc
/// cancela. Sem `cancelar` ela é só um aviso, com um botão.
type Pergunta = { titulo: string; texto: string; confirmar: string; cancelar?: string };

const perguntaEl = elemento("div", "lofi-editor");
perguntaEl.hidden = true;
const perguntaCaixa = elemento("div", "lofi-caixa pergunta-caixa");
perguntaCaixa.setAttribute("role", "alertdialog");
const perguntaTitulo = elemento("span", "lofi-cabeca-titulo");
const perguntaTexto = elemento("p", "pergunta-texto");
const perguntaBotoes = elemento("div", "pergunta-botoes");
const perguntaNao = elemento("button", "pergunta-btn");
const perguntaSim = elemento("button", "pergunta-btn pergunta-sim");
perguntaBotoes.append(perguntaNao, perguntaSim);
perguntaCaixa.append(perguntaTitulo, perguntaTexto, perguntaBotoes);
perguntaEl.appendChild(perguntaCaixa);
document.body.appendChild(perguntaEl);

/// A que está na tela: quem é e como respondê-la.
let perguntaAberta: { chave: string; promessa: Promise<boolean>; responder: (sim: boolean) => void } | undefined;

/// `chave` diz qual pergunta é. A mesma, feita de novo com a caixa aberta (um
/// segundo ⌘Q), só reencosta o teclado; outra toma o lugar, e a anterior fica
/// respondida com "não".
function perguntar(chave: string, p: Pergunta): Promise<boolean> {
  if (perguntaAberta?.chave === chave) {
    perguntaSim.focus();
    return perguntaAberta.promessa;
  }
  perguntaAberta?.responder(false);

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

  let responder!: (sim: boolean) => void;
  const promessa = new Promise<boolean>((resolve) => {
    responder = (sim) => {
      if (perguntaAberta?.promessa !== promessa) return;
      perguntaAberta = undefined;
      perguntaEl.hidden = true;
      // O teclado volta para onde estava — um painel, ou a aba do diff.
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
  if (e.target === perguntaEl) perguntaAberta?.responder(false);
});
perguntaNao.addEventListener("click", () => perguntaAberta?.responder(false));
perguntaSim.addEventListener("click", () => perguntaAberta?.responder(true));
perguntaEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    perguntaAberta?.responder(false);
    return;
  }
  // O teclado não sai da caixa: tab e as setas só alternam entre os dois
  // botões. Espaço e ↩ são do próprio botão em foco.
  if (e.key === "Tab" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const outro = document.activeElement === perguntaSim ? perguntaNao : perguntaSim;
    (outro.hidden ? perguntaSim : outro).focus();
  }
});

// ---------- sair: o ⌘Q pergunta antes ----------

let saindo = false;

/// Salva as abas e encerra. O `await` do salvamento é o que garante que a
/// última mudança (um `cd`, uma sessão nova) chegou ao disco antes de o
/// processo sumir.
async function sair() {
  if (saindo) return;
  saindo = true;
  await salvarSessao();
  await invoke("sair").catch((e) => jlog(`sair: ${e}`));
}

/// Sair leva embora todos os shells e o que estiver rodando neles, e ⌘Q mora
/// ao lado do ⌘W e do ⌘A.
async function pedirSair() {
  if (saindo) return;
  const paineis = abas.flatMap((a) => [...folhas(a.raiz)]);
  const claudes = paineis.filter((f) => f.claude?.sessao).length;
  const quantas = abas.length === 1 ? "A aba aberta fecha" : `As ${abas.length} abas abertas fecham`;
  const restaura = await invoke<boolean>("restaurar_ligado").catch(() => false);
  const volta = !restaura
    ? "Elas não voltam na próxima abertura — TermIAu ▸ Restaurar Abas ao Abrir liga isso."
    : claudes === 0
      ? "Na próxima abertura elas voltam, nas mesmas pastas."
      : claudes === 1
        ? "Na próxima abertura elas voltam, e a sessão do Claude é retomada."
        : `Na próxima abertura elas voltam, e as ${claudes} sessões do Claude são retomadas.`;
  const sim = await perguntar("sair", {
    titulo: "Sair do TermIAu?",
    texto: `${quantas} e o que estiver rodando nelas para. ${volta}`,
    confirmar: "Sair",
    cancelar: "Cancelar",
  });
  if (sim) await sair();
}

// ---------- hooks: a ligação com o Claude Code ----------

async function instalarHooks(): Promise<boolean> {
  try {
    await invoke("hooks_instalar");
    return true;
  } catch (e) {
    await perguntar("hooks", {
      titulo: "Não consegui ligar ao Claude Code",
      texto: String(e),
      confirmar: "Ok",
    });
    return false;
  }
}

/// É pelos hooks que o TermIAu sabe o que cada Claude está fazendo e qual é a
/// sessão dele. `pedido`: veio do menu, e aí toda resposta aparece; na abertura
/// do app só aparece o que precisa de uma decisão.
async function conferirHooks(pedido: boolean) {
  const estado = await invoke<string>("hooks_estado").catch(() => "sem-claude");

  if (estado === "sem-claude") {
    if (pedido) {
      await perguntar("hooks", {
        titulo: "Não achei o Claude Code",
        texto: "A pasta ~/.claude não existe. Abra o Claude Code uma vez e tente de novo.",
        confirmar: "Ok",
      });
    }
    return;
  }
  if (estado === "instalado") {
    if (pedido) {
      await perguntar("hooks", {
        titulo: "Já está ligado",
        texto: "Os hooks do TermIAu estão instalados no Claude Code e em dia.",
        confirmar: "Ok",
      });
    }
    return;
  }
  // Na abertura só se atualiza o que já estava instalado: quem instalou já
  // consentiu, e o que muda é o hook que veio junto com o app novo. Instalar
  // pela primeira vez é sempre um gesto seu, no menu.
  if (!pedido) {
    if (estado === "desatualizado") await invoke("hooks_instalar").catch((e) => jlog(`hooks_instalar: ${e}`));
    return;
  }

  if (await instalarHooks()) {
    await perguntar("hooks", {
      titulo: "Ligado ao Claude Code",
      texto: "Vale para as sessões do Claude abertas a partir de agora; as que já estão rodando precisam ser reiniciadas.",
      confirmar: "Ok",
    });
  }
}

/// TermIAu ▸ Restaurar Abas ao Abrir acabou de ser ligado ou desligado. Ligar
/// traz os hooks junto: sem eles as abas voltam, mas sem saber que sessão do
/// Claude havia em cada painel.
async function restaurarMudou(ligado: boolean) {
  if (!ligado) return;
  // O que já está aberto entra na conta desde já.
  await salvarSessao();
  const estado = await invoke<string>("hooks_estado").catch(() => "sem-claude");
  const instalou = estado === "ausente" || estado === "desatualizado" ? await instalarHooks() : false;
  await perguntar("restaurar", {
    titulo: "As abas voltam na próxima abertura",
    texto: instalou
      ? "Liguei também o TermIAu ao Claude Code (um hook em ~/.claude/hooks, registrado no settings.json, com backup): é por ele que as sessões são retomadas. Vale para os Claudes abertos a partir de agora."
      : estado === "sem-claude"
        ? "Cada painel volta na pasta em que estava. Não achei o Claude Code (~/.claude), então não há sessões para retomar."
        : "Cada painel volta na pasta em que estava, e as sessões do Claude são retomadas.",
    confirmar: "Ok",
  });
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

  // ⌘` é a aba presa, e os números ficam todos para os terminais. Pelo `code`,
  // não pelo `key`: no ABNT2 a crase é tecla morta e o `key` não chega como "`".
  if (e.code === "Backquote") return void (presa && abrirPresa());
  // ⌘9 vai pra última, não pra nona — é o padrão do macOS.
  const n = Number(e.key);
  const alvo = n === 9 ? abas[abas.length - 1] : abas[n - 1];
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

async function ligarEventos() {
  // O xterm troca o cursor pro estilo inativo quando o terminal perde o foco,
  // mas relê isso só ao redesenhar uma linha — e o app pode ir pro segundo plano
  // sem que a textarea receba `blur`. Sem nada disparando redesenho, a patinha
  // ficava piscando numa janela que não era mais a de cima. Quem sabe do
  // segundo plano é o evento da janela, então é dele que tiramos o blur.
  await janela.onFocusChanged(({ payload: focada }) => {
    if (!ativa || noDiff) return;
    if (!focada) ativa.foco.term.blur();
    // Se um clique já devolveu o teclado a um painel, não roubamos de volta.
    else if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName ?? "")) teclado(ativa.foco);
  });

  // Foco que entra no iframe da aba presa sem ela estar na tela é roubo: algo lá
  // dentro chamou `focus()` (um aviso do git, por exemplo) e o painel ficou sem
  // teclado. A janela de cima recebe `blur` quando o foco desce pro iframe.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (ativa && !noDiff && presa && document.activeElement === presa.quadro) teclado(ativa.foco);
    });
  });

  // Os hooks do Claude Code entram por aqui, via socket unix (ver ouvir_hooks
  // no Rust e hooks/termiau-evento.sh).
  await listen<string>("claude://evento", (e) => {
    try {
      const bruto = JSON.parse(e.payload);
      // O `termiau ver` usa o mesmo socket dos hooks (ver hooks/termiau).
      if (bruto && typeof bruto === "object" && "ver" in bruto) receberVer(bruto as PedidoDoSocket);
      else if (bruto && typeof bruto === "object" && "status" in bruto) receberStatus(bruto as StatusDoSocket);
      else receber(bruto as EventoClaude);
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
  await listen("menu://reabrir-aba", () => reabrirFechada());
  await listen("menu://sair", () => pedirSair());
  await listen("menu://hooks", () => conferirHooks(true));
  await listen<boolean>("menu://restaurar", (e) => restaurarMudou(e.payload));
  // O botão vermelho e o "Fechar Janela" também encerram o app: passam pela
  // mesma pergunta. Quem sai de verdade é o `sair`, que não pede para fechar a
  // janela — encerra o processo.
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

  // O .git do repositório aberto na aba do diff mexeu. Só repassa: quem decide
  // o que fazer com isso é a aba, e ela só existe depois de alguém abri-la.
  await listen<string>("differ://mudou", (e) => {
    if (presa?.pronta) recado({ termiauMudou: e.payload });
  });

  await ligarArrastar();
}

async function abrirAbas() {
  // Um reload da webview apaga as abas mas não os shells: sem isto eles ficariam
  // vivos, sem ninguém lendo, a cada recarga do dev server.
  await invoke("pty_close_all");
  // Antes da primeira aba: é o que põe o chip dela no começo da barra, e é de lá
  // que ela não sai — `ligarArrasto` só reordena o que está no array `abas`.
  montarMenu();
  criarPresa();
  await restaurarSessao();
}

function depoisDasAbas() {
  void conferirHooks(false);

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
