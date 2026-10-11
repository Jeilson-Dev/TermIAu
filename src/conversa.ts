/// A conversa de uma sessão do Claude Code, lida do transcript dela (o JSONL em
/// `~/.claude/projects`), e o que o terminal precisa para achar na tela o que
/// você escreveu. Nada de DOM nem de xterm aqui: é o que deixa isto testável.

import { T } from "./i18n/terminal";

/// Uma fala da conversa, na ordem em que aconteceu.
export type Fala =
  | { quem: "claude"; texto: string }
  /// `imagens`: as que você colou, como data URLs, na ordem em que o texto as
  /// cita (`[Image #N]`).
  | { quem: "voce"; texto: string; imagens?: string[] }
  /// Uma ferramenta que o Claude usou: o nome e uma linha do que ela fez.
  | { quem: "ferramenta"; nome: string; resumo: string }
  /// O que uma ferramenta mudou nos arquivos — um Edit, um Write, ou um
  /// comando do Bash que mexeu em arquivo —, logo abaixo dela.
  | { quem: "diff"; arquivos: ArquivoDiff[] };

/// Um arquivo mudado e os trechos da mudança, como o Claude Code os guarda.
/// O Rust já tirou do resultado da ferramenta (ver `diff_do_resultado`).
export type ArquivoDiff = {
  caminho: string;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
};

type Bloco = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type?: string; media_type?: string; data?: string };
};
type Linha = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: string | Bloco[] };
};

/// O que o Claude Code escreve no lugar do usuário: a saída de um comando
/// local, um lembrete do sistema, o aviso de uma tarefa. Não é você falando.
const NAO_E_VOCE = /^\s*<(local-command-|system-reminder|task-notification|user-prompt-submit-hook|bash-)/;
const COMANDO = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGUMENTOS = /<command-args>([\s\S]*?)<\/command-args>/;

/// O que você digitou, tirado do que o transcript guarda. Um `/comando` vem
/// embrulhado em tags; volta a ser o que foi digitado.
function doUsuario(texto: string): string | undefined {
  const comando = COMANDO.exec(texto);
  if (comando) return `${comando[1].trim()} ${ARGUMENTOS.exec(texto)?.[1].trim() ?? ""}`.trim();
  if (NAO_E_VOCE.test(texto) || texto.startsWith("Caveat:")) return undefined;
  return texto.trim() || undefined;
}

/// O texto de uma fala sua sem o que muda entre o que você digitou e o que o
/// Claude grava: o embrulho do texto colado, as `[Image #N]`, os espaços.
const comparavel = (texto: string) =>
  texto
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(IMAGEM, "")
    .replace(/\s+/g, " ")
    .trim();

/// Quantos dos balões provisórios (o texto de cada um, do mais antigo ao mais
/// novo) a fala sua que chegou do transcript resolve. Não é sempre o mais
/// antigo: mensagens mandadas com o Claude trabalhando ficam na fila dele e
/// podem chegar juntas, numa fala só; e um provisório que nunca virou fala
/// (um `!comando`, um envio que não pegou) não pode tomar o lugar de outro e
/// deixar o certo duplicado na tela. Os provisórios de antes do que casou
/// saem junto: o transcript é em ordem, e eles não vêm mais.
export function provisoriosResolvidos(pendentes: string[], fala: string): number {
  if (!pendentes.length) return 0;
  const chegou = comparavel(fala);
  const exato = pendentes.findIndex((p) => comparavel(p) === chegou);
  if (exato >= 0) return exato + 1;
  let ultimo = -1;
  pendentes.forEach((p, i) => {
    const t = comparavel(p);
    if (t && chegou.includes(t)) ultimo = i;
  });
  // Nada parecido: o Claude gravou diferente do que foi digitado. Sai o mais
  // antigo, como antes.
  return ultimo >= 0 ? ultimo + 1 : 1;
}

/// Os campos em que cada ferramenta diz o que fez, do mais legível ao menos.
const RESUMOS = ["description", "command", "file_path", "pattern", "query", "url", "prompt", "skill"];

export function resumoDe(input: Record<string, unknown> | undefined): string {
  for (const campo of RESUMOS) {
    const v = input?.[campo];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

/// As falas de um trecho do transcript. Cada linha é um JSON; a que não for
/// (uma linha cortada, um formato novo) é pulada, e a conversa segue.
export function lerFalas(jsonl: string): Fala[] {
  const falas: Fala[] = [];
  for (const bruta of jsonl.split("\n")) {
    if (!bruta.trim()) continue;
    let linha: Linha & { arquivos?: ArquivoDiff[] };
    try {
      linha = JSON.parse(bruta) as Linha;
    } catch {
      continue;
    }
    if (linha.type === "diff") {
      if (linha.arquivos?.length) falas.push({ quem: "diff", arquivos: linha.arquivos });
      continue;
    }
    // Os subagentes escrevem no mesmo arquivo; a conversa é só a principal.
    if (linha.isSidechain || linha.isMeta) continue;
    const conteudo = linha.message?.content;
    if (conteudo === undefined) continue;
    const blocos: Bloco[] = typeof conteudo === "string" ? [{ type: "text", text: conteudo }] : conteudo;

    if (linha.type === "user") {
      // O resultado de uma ferramenta volta como mensagem "do usuário".
      if (blocos.some((b) => b.type === "tool_result")) continue;
      const texto = blocos
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      const imagens = blocos.flatMap((b) =>
        b.type === "image" && b.source?.type === "base64" && b.source.data
          ? [`data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`]
          : [],
      );
      // Só imagem, sem texto: ainda é você falando.
      const seu = doUsuario(texto) ?? (imagens.length && !NAO_E_VOCE.test(texto) ? "" : undefined);
      if (seu !== undefined) falas.push(imagens.length ? { quem: "voce", texto: seu, imagens } : { quem: "voce", texto: seu });
    } else if (linha.type === "assistant") {
      for (const b of blocos) {
        if (b.type === "text" && b.text?.trim()) falas.push({ quem: "claude", texto: b.text });
        else if (b.type === "tool_use") {
          falas.push({ quem: "ferramenta", nome: b.name ?? "ferramenta", resumo: resumoDe(b.input) });
        }
      }
    }
  }
  return falas;
}

// ---------- o que você escreveu, em partes ----------

/// Um pedaço do seu balão: texto seu, um texto que você colou (que o Claude
/// Code embrulha em `<pasted_content>`), ou uma das imagens da fala.
export type Parte =
  | { tipo: "texto"; texto: string }
  | { tipo: "colado"; texto: string }
  | { tipo: "imagem"; indice: number };

/// A tag de abrir e a de fechar podem vir com o `id` ou sem ele — a de fechar,
/// estranhamente, repete o id.
const COLADO = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;
const IMAGEM = /\[Image #\d+\]/g;

/// Parte o seu texto nos pedaços que o balão desenha de jeitos diferentes. A
/// k-ésima `[Image #N]` é a k-ésima imagem da fala: o N é contado na sessão
/// inteira, não na fala. Imagem que o texto não cita vai para o fim.
export function partesDoSeu(texto: string, imagens: number): Parte[] {
  const partes: Parte[] = [];
  let usadas = 0;
  const comTexto = (t: string) => {
    let desde = 0;
    for (const m of t.matchAll(IMAGEM)) {
      if (usadas >= imagens) break;
      const antes = t.slice(desde, m.index);
      if (antes.trim()) partes.push({ tipo: "texto", texto: antes.trim() });
      partes.push({ tipo: "imagem", indice: usadas++ });
      desde = m.index + m[0].length;
    }
    const resto = t.slice(desde);
    if (resto.trim()) partes.push({ tipo: "texto", texto: resto.trim() });
  };
  let desde = 0;
  for (const m of texto.matchAll(COLADO)) {
    comTexto(texto.slice(desde, m.index));
    partes.push({ tipo: "colado", texto: m[1] });
    desde = m.index + m[0].length;
  }
  comTexto(texto.slice(desde));
  while (usadas < imagens) partes.push({ tipo: "imagem", indice: usadas++ });
  return partes;
}

// ---------- o diff de uma edição ----------

/// Uma linha do diff como o terminal a mostra: o que saiu, o que entrou, o
/// contexto em volta, ou o `…` entre dois trechos distantes. `numero` é a linha
/// no arquivo: a de antes para o que saiu, a de depois para o resto.
/// `antigo`: o número que uma linha de contexto tinha antes, que o lado a lado mostra.
export type LinhaDiff = { tipo: "-" | "+" | " " | "…"; texto: string; numero?: number; antigo?: number };

/// As linhas de um arquivo do diff, numeradas, e quantas entraram e saíram.
export function linhasDoDiff(arquivo: ArquivoDiff): { linhas: LinhaDiff[]; mais: number; menos: number } {
  const linhas: LinhaDiff[] = [];
  let mais = 0;
  let menos = 0;
  for (const h of arquivo.hunks) {
    if (linhas.length) linhas.push({ tipo: "…", texto: "" });
    let velha = h.oldStart;
    let nova = h.newStart;
    for (const l of h.lines) {
      // "\\ No newline at end of file" não é linha do arquivo.
      if (l.startsWith("\\")) continue;
      const tipo = l[0] === "+" || l[0] === "-" ? l[0] : " ";
      if (tipo === "-") {
        menos++;
        linhas.push({ tipo, texto: l.slice(1), numero: velha++ });
      } else {
        if (tipo === "+") {
          mais++;
          linhas.push({ tipo, texto: l.slice(1), numero: nova++ });
        } else linhas.push({ tipo, texto: l.slice(1), numero: nova++, antigo: velha++ });
      }
    }
  }
  return { linhas, mais, menos };
}

/// Uma linha do lado a lado: o antes à esquerda, o depois à direita. Um lado
/// vazio é linha que só existe no outro.
export type ParDiff = { pulo: true } | { pulo?: false; antes?: LinhaDiff; depois?: LinhaDiff };

/// As linhas do diff em duas colunas, como o differ mostra: o contexto dos dois
/// lados, e cada bloco de linhas que saíram ao lado das que entraram no lugar.
export function ladoALado(linhas: LinhaDiff[]): ParDiff[] {
  const pares: ParDiff[] = [];
  let saiu: LinhaDiff[] = [];
  let entrou: LinhaDiff[] = [];
  const fechar = () => {
    for (let i = 0; i < Math.max(saiu.length, entrou.length); i++) pares.push({ antes: saiu[i], depois: entrou[i] });
    saiu = [];
    entrou = [];
  };
  for (const l of linhas) {
    if (l.tipo === "-") {
      // Um `-` depois de `+` começa outro bloco.
      if (entrou.length) fechar();
      saiu.push(l);
    } else if (l.tipo === "+") entrou.push(l);
    else {
      fechar();
      if (l.tipo === "…") pares.push({ pulo: true });
      else pares.push({ antes: { ...l, numero: l.antigo }, depois: l });
    }
  }
  fechar();
  return pares;
}

// ---------- markdown ----------

export const escapar = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// Negrito, itálico e link de um trecho que já não tem código dentro.
function enfase(s: string): string {
  return escapar(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
}

/// O código entre crases sai antes de tudo: o que está dentro dele não é
/// markdown, e um `**` ali tem de continuar sendo dois asteriscos. Sai para um
/// marcador e volta no fim, em vez de partir a linha nele: um negrito pode
/// começar antes do código e terminar depois, e partida a linha ele não fecha.
function emLinha(s: string): string {
  const codigos: string[] = [];
  const semCodigo = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codigos.push(c) - 1}\u0000`);
  return enfase(semCodigo).replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escapar(codigos[Number(i)])}</code>`);
}

const celulas = (linha: string) =>
  linha
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/// Um JSON escrito numa linha só, como o Claude costuma citar um payload, sai
/// com quebras e recuo. O que não for JSON válido, ou já vier em várias
/// linhas, fica como está.
export function jsonLegivel(codigo: string): string {
  const t = codigo.trim();
  if (t.includes("\n") || !/^[[{]/.test(t)) return codigo;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return codigo;
  }
}

/// O markdown que o Claude costuma escrever, em HTML: título, lista, tabela,
/// bloco de código, e a ênfase de dentro da linha. Não é um parser completo — é
/// o bastante para uma resposta ficar legível, e tudo o que entra é escapado.
/// `rebaixar`: quantos níveis os títulos descem. No balão do chat um `#` vira
/// h3, senão gritaria mais que a conversa; no visor o documento é a página
/// inteira, e os títulos ficam como estão.
export function markdown(texto: string, rebaixar = 2): string {
  const linhas = texto.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  let paragrafo: string[] = [];
  const fecharParagrafo = () => {
    if (paragrafo.length) html.push(`<p>${paragrafo.map(emLinha).join("<br>")}</p>`);
    paragrafo = [];
  };

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    const cerca = /^\s*```(.*)$/.exec(linha);
    if (cerca) {
      fecharParagrafo();
      const codigo: string[] = [];
      for (i++; i < linhas.length && !/^\s*```\s*$/.test(linhas[i]); i++) codigo.push(linhas[i]);
      html.push(`<pre><code>${escapar(jsonLegivel(codigo.join("\n")))}</code></pre>`);
      continue;
    }

    const titulo = /^(#{1,6})\s+(.*)$/.exec(linha);
    if (titulo) {
      fecharParagrafo();
      const nivel = Math.min(titulo[1].length + rebaixar, 6);
      html.push(`<h${nivel}>${emLinha(titulo[2])}</h${nivel}>`);
      continue;
    }

    // Tabela: a linha de cabeçalho e, logo abaixo, a de tracinhos.
    if (linha.includes("|") && /^\s*\|?\s*:?-{2,}/.test(linhas[i + 1] ?? "")) {
      fecharParagrafo();
      const cabeca = celulas(linha).map((c) => `<th>${emLinha(c)}</th>`).join("");
      const corpo: string[] = [];
      for (i += 2; i < linhas.length && linhas[i].includes("|"); i++) {
        corpo.push(`<tr>${celulas(linhas[i]).map((c) => `<td>${emLinha(c)}</td>`).join("")}</tr>`);
      }
      i--;
      html.push(`<table><thead><tr>${cabeca}</tr></thead><tbody>${corpo.join("")}</tbody></table>`);
      continue;
    }

    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(linha);
    if (item) {
      fecharParagrafo();
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      const itens: string[] = [];
      for (; i < linhas.length; i++) {
        const m = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(linhas[i]);
        if (m) itens.push(emLinha(m[3]));
        // Linha recuada logo abaixo de um item é a continuação dele.
        else if (itens.length && /^\s+\S/.test(linhas[i])) itens[itens.length - 1] += `<br>${emLinha(linhas[i].trim())}`;
        else break;
      }
      i--;
      html.push(`<${tag}>${itens.map((t) => `<li>${t}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (!linha.trim()) {
      fecharParagrafo();
      continue;
    }
    paragrafo.push(linha);
  }
  fecharParagrafo();
  return html.join("");
}

// ---------- o que você escreveu, na tela do terminal ----------

/// O sinal que o Claude Code põe na frente do que você mandou. Mudou de uma
/// versão para outra, então valem os que ele já usou.
const SINAL = /^\s*[>❯›〉]\s+/;
/// Quantos caracteres do começo do prompt bastam para reconhecer a linha. A
/// tela quebra o texto na largura do painel, então só o começo é comparável.
const COMECO = 24;
/// Um prompt colado pode ter centenas de linhas; o destaque não vai tão longe.
const ALTURA_MAXIMA = 12;

const compacto = (s: string) => s.replace(/\s+/g, " ").trim();

/// Onde, entre as linhas da tela, estão os prompts que você mandou: a linha em
/// que cada um começa e quantas ele ocupa (até a primeira em branco).
///
/// Só casa com prompt conhecido, e não com qualquer linha que comece pelo
/// sinal: uma citação na resposta do Claude começa com `>` também.
export function linhasDePrompt(tela: string[], prompts: string[]): { linha: number; altura: number }[] {
  const comecos = new Set<string>();
  for (const p of prompts) {
    const c = compacto(p.split("\n").find((l) => l.trim()) ?? "").slice(0, COMECO);
    if (c) comecos.add(c);
  }
  if (!comecos.size) return [];

  const achados: { linha: number; altura: number }[] = [];
  for (let i = 0; i < tela.length; i++) {
    const sinal = SINAL.exec(tela[i]);
    if (!sinal) continue;
    const resto = compacto(tela[i].slice(sinal[0].length));
    let casou = false;
    for (const c of comecos) {
      // A linha pode ser mais curta que o começo guardado: o painel é estreito
      // e a quebra veio antes. Aí é a linha inteira que tem de bater.
      if (resto.startsWith(c) || (resto.length >= 8 && c.startsWith(resto))) {
        casou = true;
        break;
      }
    }
    if (!casou) continue;
    let altura = 1;
    while (altura < ALTURA_MAXIMA && (tela[i + altura] ?? "").trim() && !SINAL.test(tela[i + altura])) altura++;
    achados.push({ linha: i, altura });
    i += altura - 1;
  }
  return achados;
}

// ---------- os /comandos ----------

export type Comando = {
  nome: string;
  descricao: string;
  /// Abre um menu ou uma tela no terminal (escolher modelo, retomar sessão): o
  /// chat não tem como mostrar isso, então quem o manda é levado para lá.
  interativo?: boolean;
};

/// Os comandos que já vêm no Claude Code. Escritos à mão: ele não os publica em
/// lugar nenhum que dê para ler de fora. Os seus (comandos, skills, plugins)
/// vêm do disco, pelo `comandos_listar` do Rust.
export const COMANDOS_DO_CLAUDE: Comando[] = [
  { nome: "clear", descricao: T.cmdClear },
  { nome: "compact", descricao: T.cmdCompact },
  { nome: "init", descricao: T.cmdInit },
  { nome: "review", descricao: T.cmdReview },
  { nome: "code-review", descricao: T.cmdCodeReview },
  { nome: "security-review", descricao: T.cmdSecurityReview },
  { nome: "add-dir", descricao: T.cmdAddDir },
  { nome: "fast", descricao: T.cmdFast },
  { nome: "model", descricao: T.cmdModel, interativo: true },
  { nome: "resume", descricao: T.cmdResume, interativo: true },
  { nome: "rewind", descricao: T.cmdRewind, interativo: true },
  { nome: "context", descricao: T.cmdContext, interativo: true },
  { nome: "usage", descricao: T.cmdUsage, interativo: true },
  { nome: "cost", descricao: T.cmdCost, interativo: true },
  { nome: "status", descricao: T.cmdStatus, interativo: true },
  { nome: "config", descricao: T.cmdConfig, interativo: true },
  { nome: "permissions", descricao: T.cmdPermissions, interativo: true },
  { nome: "memory", descricao: T.cmdMemory, interativo: true },
  { nome: "mcp", descricao: T.cmdMcp, interativo: true },
  { nome: "agents", descricao: T.cmdAgents, interativo: true },
  { nome: "hooks", descricao: T.cmdHooks, interativo: true },
  { nome: "plugin", descricao: T.cmdPlugin, interativo: true },
  { nome: "skills", descricao: T.cmdSkills, interativo: true },
  { nome: "export", descricao: T.cmdExport, interativo: true },
  { nome: "theme", descricao: T.cmdTheme, interativo: true },
  { nome: "doctor", descricao: T.cmdDoctor, interativo: true },
  { nome: "help", descricao: T.cmdHelp, interativo: true },
  { nome: "login", descricao: T.cmdLogin, interativo: true },
  { nome: "exit", descricao: T.cmdExit },
];

/// Os comandos que casam com o que foi digitado depois da barra: primeiro os
/// que começam por ele, depois os que o têm no meio. O primeiro de cada nome
/// vence — um comando seu com o nome de um embutido é o que o Claude roda.
export function filtrarComandos(todos: Comando[], digitado: string): Comando[] {
  const q = digitado.toLowerCase();
  const vistos = new Set<string>();
  const comeca: Comando[] = [];
  const contem: Comando[] = [];
  for (const c of todos) {
    const nome = c.nome.toLowerCase();
    if (vistos.has(nome)) continue;
    // `plugin:nome` também é achado pelo nome sozinho.
    const curto = nome.slice(nome.lastIndexOf(":") + 1);
    if (nome.startsWith(q) || curto.startsWith(q)) comeca.push(c);
    else if (nome.includes(q)) contem.push(c);
    else continue;
    vistos.add(nome);
  }
  return [...comeca, ...contem];
}

// ---------- as perguntas do Claude (AskUserQuestion) ----------

/// Uma pergunta como o Claude a manda no `tool_input` do `AskUserQuestion`.
export type Questao = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/// O que você escolheu numa pergunta: as opções marcadas e, se escreveu, o
/// texto do "Outra".
export type Escolha = { labels: string[]; outra?: string };

/// As perguntas de um `tool_input`, ou nada se ele não tiver a forma esperada:
/// aí o cartão não aparece, e a pergunta fica com o terminal.
export function questoesDe(input: Record<string, unknown> | undefined): Questao[] | undefined {
  const qs = input?.questions;
  if (!Array.isArray(qs) || !qs.length) return undefined;
  const ok = qs.every(
    (q) =>
      typeof q?.question === "string" &&
      Array.isArray(q.options) &&
      q.options.every((o: { label?: unknown }) => typeof o?.label === "string"),
  );
  return ok ? (qs as Questao[]) : undefined;
}

/// O texto da resposta de uma pergunta: o "Outra" vale por si; marcadas várias,
/// vão juntas por vírgula, como o terminal faz.
export function textoDaEscolha(e: Escolha | undefined): string | undefined {
  const outra = e?.outra?.trim();
  const partes = [...(e?.labels ?? []), ...(outra ? [outra] : [])];
  return partes.length ? partes.join(", ") : undefined;
}

/// A saída do hook que responde as perguntas: a mesma decisão que a extensão
/// do VS Code devolve pelo SDK — `allow`, com as perguntas de volta e as
/// respostas pelo texto de cada uma. `undefined` enquanto faltar responder
/// alguma.
export function respostaDoHook(questoes: Questao[], escolhas: (Escolha | undefined)[]): string | undefined {
  const answers: Record<string, string> = {};
  for (const [i, q] of questoes.entries()) {
    const texto = textoDaEscolha(escolhas[i]);
    if (!texto) return undefined;
    answers[q.question] = texto;
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: questoes, answers } },
    },
  });
}
