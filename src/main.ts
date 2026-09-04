import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  macOptionIsMeta: true,
  scrollback: 10_000,
  theme: {
    background: "#14161a",
    foreground: "#d5d8de",
    cursor: "#d97757",
    selectionBackground: "#33405a",
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

const abas: Aba[] = [];
let ativa: Aba | undefined;
/// Atalho repetido rápido dispararia dois `criarFolha` concorrentes, e os dois
/// mexeriam na mesma árvore ao mesmo tempo.
let ocupado = false;

/// Atalhos que o TermIAu consome aqui na webview. O xterm precisa saber quais
/// são para não mandar a tecla pro shell antes de o handler da janela agir.
/// ⌘T, ⌘W e ⌘D não entram: são itens de menu, e no macOS o menu fica com a
/// tecla antes de qualquer coisa chegar na página (ver `montar_menu` no Rust).
function nossoAtalho(e: KeyboardEvent): boolean {
  if (!e.metaKey) return false;
  if (e.altKey) return e.code.startsWith("Arrow");
  if (e.shiftKey) {
    return e.code === "BracketLeft" || e.code === "BracketRight" || e.code === "KeyA";
  }
  return e.key === "k" || /^[1-9]$/.test(e.key);
}

// ---------- árvore ----------

function* folhas(no: No): Generator<Folha> {
  if (no.tipo === "folha") yield no;
  else for (const f of no.filhos) yield* folhas(f);
}

/// Sobe até a raiz e descobre de quem ela é. Evita guardar a aba dentro de cada
/// folha, que criaria um ciclo chato de montar na hora de criar a primeira.
function abaDe(no: No): Aba | undefined {
  let raiz = no;
  while (raiz.pai) raiz = raiz.pai;
  return abas.find((a) => a.raiz === raiz);
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
  for (const f of folhas(aba.raiz)) f.fit.fit();
}

/// Avisa o kernel das grades que realmente mudaram, pro TUI se redesenhar certo.
function sincronizar(aba: Aba) {
  for (const f of folhas(aba.raiz)) {
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
  if (aba === ativa) janela.setTitle(`${aba.foco.titulo} — TermIAu`).catch(() => {});
}

function ativar(aba: Aba) {
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
async function criarFolha(
  cwd: string | null,
  inserir: (el: HTMLDivElement) => void,
): Promise<Folha | undefined> {
  const el = document.createElement("div");
  el.className = "folha";
  inserir(el);

  const term = new Terminal(OPCOES_TERM);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.attachCustomKeyEventHandler((e) => !nossoAtalho(e));
  term.open(el);
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
  };

  // Clicar num painel manda o teclado pra ele, sem precisar de atalho.
  el.addEventListener("mousedown", () => focar(folha));

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

  // tela -> PTY
  term.onData((data) => {
    invoke("pty_write", { id, data }).catch((e) => jlog(`pty_write: ${e}`));
  });
  // O prompt (p10k, zsh) publica o diretório por OSC; é o título da aba.
  term.onTitleChange((t) => {
    folha.titulo = t || "shell";
    const aba = abaDe(folha);
    if (aba?.foco === folha) rotular(aba);
  });

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
    sincronizarBarra();
    ativar(aba);
  } finally {
    ocupado = false;
  }
}

function sincronizarBarra() {
  barra.hidden = abas.length < 2;
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
  if (ocupado || !ativa) return;
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
  for (const f of folhas(aba.raiz)) {
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
  if (!ativa) return;
  const i = abas.indexOf(ativa);
  // Circular: da última pra primeira, como no iTerm2.
  ativar(abas[(i + delta + abas.length) % abas.length]);
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

// ---------- escuta: falar em vez de digitar ----------

const voz = document.getElementById("voz") as HTMLDivElement;
const vozNivel = voz.querySelector(".voz-nivel > span") as HTMLSpanElement;
const vozTexto = voz.querySelector(".voz-texto") as HTMLSpanElement;

let escutando = false;
/// Segura um segundo ⌘⇧E enquanto o modelo baixa — são centenas de MB.
let preparando = false;

/// A faixa cabe uma linha. Mostrar o começo de uma frase longa esconderia
/// justamente o que você acabou de falar, então corta pela frente.
function mostrarVoz(texto: string) {
  vozTexto.textContent = texto.length > 140 ? `…${texto.slice(-140)}` : texto;
}

function fecharVoz() {
  voz.hidden = true;
  vozNivel.style.width = "0";
  vozTexto.textContent = "";
  // A faixa ocupa espaço de verdade: sumindo, os painéis recuperam as linhas.
  if (ativa) {
    medir(ativa);
    sincronizar(ativa);
  }
}

async function alternarEscuta() {
  if (preparando) return;
  if (escutando) {
    escutando = false;
    await invoke("escuta_parar").catch((e) => jlog(`escuta_parar: ${e}`));
    fecharVoz();
    return;
  }

  voz.hidden = false;
  if (ativa) {
    medir(ativa);
    sincronizar(ativa);
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
  } catch (e) {
    mostrarVoz(`não consegui escutar: ${e}`);
    setTimeout(fecharVoz, 4000);
  } finally {
    preparando = false;
  }
}

async function ligarEscuta() {
  // Parcial: o palpite enquanto você fala, reavaliado a cada 800 ms.
  await listen<string>("escuta://parcial", (e) => mostrarVoz(e.payload));

  // Final: o trecho fechou. Vai para o painel em foco AGORA, não para o que
  // estava em foco quando você começou a falar — é o que digitar faria.
  await listen<string>("escuta://final", (e) => {
    const texto = e.payload.trim();
    if (!texto || !ativa) return;
    // Espaço no fim: dois trechos seguidos grudariam numa palavra só.
    invoke("pty_write", { id: ativa.foco.id, data: `${texto} ` })
      .catch((err) => jlog(`pty_write da voz: ${err}`));
    mostrarVoz("escutando…");
  });

  // O parcial fica parado enquanto você não fala; é a barra que mostra que o
  // microfone está aberto de verdade.
  await listen<number>("escuta://nivel", (e) => {
    vozNivel.style.width = `${Math.min(100, e.payload * 320)}%`;
  });

  await listen<number>("escuta://progresso", (e) => {
    mostrarVoz(`baixando o modelo de transcrição… ${Math.round(e.payload * 100)}%`);
  });

  await listen<string>("escuta://erro", (e) => {
    escutando = false;
    mostrarVoz(`erro na escuta: ${e.payload}`);
    setTimeout(fecharVoz, 4000);
  });

  await listen("menu://escutar", () => alternarEscuta());
  await listen("menu://calar", () => invoke("calar").catch((e) => jlog(`calar: ${e}`)));
}

// ---------- teclado ----------

window.addEventListener("keydown", (e) => {
  if (!nossoAtalho(e)) return;
  e.preventDefault();

  if (e.altKey && ativa) {
    const alvo = vizinho(ativa.foco, e.code.slice(5) as "Left" | "Right" | "Up" | "Down");
    if (alvo) focar(alvo);
    return;
  }
  if (e.shiftKey) {
    if (e.code === "KeyA") return irParaEsperando();
    return irParaAba(e.code === "BracketRight" ? 1 : -1);
  }

  if (e.key === "k") return ativa?.foco.term.clear();

  // ⌘9 vai pra última, não pra nona — é o padrão do macOS.
  const n = Number(e.key);
  const alvo = n === 9 ? abas[abas.length - 1] : abas[n - 1];
  if (alvo) ativar(alvo);
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
    if (!ativa) return;
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
    if (ativa) fecharFolha(ativa.foco);
  });

  // Um reload da webview apaga as abas mas não os shells: sem isto eles ficariam
  // vivos, sem ninguém lendo, a cada recarga do dev server.
  await invoke("pty_close_all");
  await novaAba();

  // Redimensionamento da janela: só a aba visível tem dimensão pra medir; as
  // outras se ajustam quando voltam a aparecer (ver `ativar`).
  // Observa o body, NÃO os painéis: fit() altera o painel e realimentaria o observer.
  new ResizeObserver(() => {
    if (!ativa) return;
    medir(ativa); // render local acompanha o arrasto, quadro a quadro
    agendarSync(ativa);
  }).observe(document.body);
}

// Numa função, não solto no módulo: `await` de topo não passa no alvo de build
// do Vite, e o `npm run build` quebraria mesmo com o dev funcionando.
iniciar();
