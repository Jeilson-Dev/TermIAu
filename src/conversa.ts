/// A Claude Code session's conversation, read from its transcript (the JSONL in
/// `~/.claude/projects`), and what the terminal needs to find on screen what
/// you wrote. No DOM or xterm here: that is what makes this testable.

import { T } from "./i18n/terminal";

/// One turn of the conversation, in the order it happened.
export type Fala =
  | { quem: "claude"; texto: string }
  /// `imagens`: the ones you pasted, as data URLs, in the order the text
  /// cites them (`[Image #N]`).
  | { quem: "voce"; texto: string; imagens?: string[] }
  /// A tool Claude used: the name and one line of what it did.
  | { quem: "ferramenta"; nome: string; resumo: string }
  /// What a tool changed in the files — an Edit, a Write, or a
  /// Bash command that touched a file —, right below it.
  | { quem: "diff"; arquivos: ArquivoDiff[] };

/// A changed file and the hunks of the change, as Claude Code stores them.
/// Rust already extracted it from the tool result (see `diff_do_resultado`).
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

/// What Claude Code writes in the user's place: the output of a local
/// command, a system reminder, a task notice. It isn't you speaking.
const NAO_E_VOCE = /^\s*<(local-command-|system-reminder|task-notification|user-prompt-submit-hook|bash-)/;
const COMANDO = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGUMENTOS = /<command-args>([\s\S]*?)<\/command-args>/;

/// What you typed, taken from what the transcript stores. A `/command` comes
/// wrapped in tags; it goes back to what was typed.
function doUsuario(texto: string): string | undefined {
  const comando = COMANDO.exec(texto);
  if (comando) return `${comando[1].trim()} ${ARGUMENTOS.exec(texto)?.[1].trim() ?? ""}`.trim();
  if (NAO_E_VOCE.test(texto) || texto.startsWith("Caveat:")) return undefined;
  return texto.trim() || undefined;
}

/// The text of one of your turns without what differs between what you typed and what
/// Claude stores: the pasted-text wrapper, the `[Image #N]`s, the spaces.
const comparavel = (texto: string) =>
  texto
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(IMAGEM, "")
    .replace(/\s+/g, " ")
    .trim();

/// How many of the provisional bubbles (each one's text, from oldest to
/// newest) your turn arriving from the transcript resolves. It isn't always the
/// oldest: messages sent while Claude works wait in its queue and
/// may arrive together, in a single turn; and a provisional one that never became a turn
/// (a `!command`, a send that didn't take) must not take another's place and
/// leave the right one duplicated on screen. The provisional ones before the match
/// go along: the transcript is in order, and they won't come anymore.
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
  // Nothing similar: Claude stored something different from what was typed. The oldest
  // goes, as before.
  return ultimo >= 0 ? ultimo + 1 : 1;
}

/// The fields in which each tool says what it did, from most readable to least.
const RESUMOS = ["description", "command", "file_path", "pattern", "query", "url", "prompt", "skill"];

export function resumoDe(input: Record<string, unknown> | undefined): string {
  for (const campo of RESUMOS) {
    const v = input?.[campo];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

/// The turns of a transcript chunk. Each line is a JSON; one that isn't
/// (a cut line, a new format) is skipped, and the conversation goes on.
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
    // Subagents write to the same file; the conversation is only the main one.
    if (linha.isSidechain || linha.isMeta) continue;
    const conteudo = linha.message?.content;
    if (conteudo === undefined) continue;
    const blocos: Bloco[] = typeof conteudo === "string" ? [{ type: "text", text: conteudo }] : conteudo;

    if (linha.type === "user") {
      // A tool's result comes back as a "user" message.
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
      // Image only, no text: it is still you speaking.
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

// ---------- what you wrote, in parts ----------

/// A piece of your bubble: your text, text you pasted (which Claude
/// Code wraps in `<pasted_content>`), or one of the turn's images.
export type Parte =
  | { tipo: "texto"; texto: string }
  | { tipo: "colado"; texto: string }
  | { tipo: "imagem"; indice: number };

/// The opening and closing tags may come with or without the `id` — the closing one,
/// oddly, repeats the id.
const COLADO = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;
const IMAGEM = /\[Image #\d+\]/g;

/// Splits your text into the pieces the bubble draws in different ways. The
/// k-th `[Image #N]` is the turn's k-th image: N is counted across the whole
/// session, not the turn. An image the text doesn't cite goes at the end.
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

// ---------- the diff of an edit ----------

/// A diff line as the terminal shows it: what went out, what came in, the
/// surrounding context, or the `…` between two distant hunks. `numero` is the line
/// in the file: the old one for what went out, the new one for the rest.
/// `antigo`: the number a context line had before, which side by side shows.
export type LinhaDiff = { tipo: "-" | "+" | " " | "…"; texto: string; numero?: number; antigo?: number };

/// A diff file's lines, numbered, and how many came in and went out.
export function linhasDoDiff(arquivo: ArquivoDiff): { linhas: LinhaDiff[]; mais: number; menos: number } {
  const linhas: LinhaDiff[] = [];
  let mais = 0;
  let menos = 0;
  for (const h of arquivo.hunks) {
    if (linhas.length) linhas.push({ tipo: "…", texto: "" });
    let velha = h.oldStart;
    let nova = h.newStart;
    for (const l of h.lines) {
      // "\ No newline at end of file" isn't a line of the file.
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

/// A side-by-side line: before on the left, after on the right. An empty
/// side is a line that only exists on the other.
export type ParDiff = { pulo: true } | { pulo?: false; antes?: LinhaDiff; depois?: LinhaDiff };

/// The diff lines in two columns, as the differ shows them: the context on both
/// sides, and each block of removed lines beside the ones that replaced them.
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
      // A `-` after a `+` starts another block.
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

/// Claude Code writes some emoji as GitHub shortcodes (`:bulb: Prompt tip`).
/// Only the known ones turn into the emoji; any other `:word:` stays as written.
const EMOJIS: Record<string, string> = {
  bulb: "💡",
  warning: "⚠️",
  information_source: "ℹ️",
  white_check_mark: "✅",
  x: "❌",
  rocket: "🚀",
  sparkles: "✨",
  tada: "🎉",
  memo: "📝",
  star: "⭐",
};

/// Bold, italic, links and emoji shortcodes in a snippet that no longer has code in it.
function enfase(s: string): string {
  return escapar(s)
    .replace(/:([a-z_]+):/g, (todo, nome: string) => EMOJIS[nome] ?? todo)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
}

/// Code between backticks comes out before everything: what is inside isn't
/// markdown, and a `**` there must stay two asterisks. It goes out to a
/// placeholder and comes back at the end, instead of splitting the line at it: a bold may
/// start before the code and end after it, and with the line split it wouldn't close.
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

/// JSON written on a single line, as Claude often quotes a payload, comes out
/// with line breaks and indentation. What isn't valid JSON, or already comes on several
/// lines, stays as is.
export function jsonLegivel(codigo: string): string {
  const t = codigo.trim();
  if (t.includes("\n") || !/^[[{]/.test(t)) return codigo;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return codigo;
  }
}

/// The markdown Claude usually writes, as HTML: headings, lists, tables,
/// code blocks, and inline emphasis. It isn't a complete parser — it is
/// enough for an answer to be readable, and everything that comes in is escaped.
/// `rebaixar`: how many levels headings go down. In the chat bubble a `#` becomes
/// h3, otherwise it would shout louder than the conversation; in the viewer the document is the whole
/// page, and headings stay as they are.
/// `caixas`: what a `- [ ]` / `- [x]` item becomes. Without it, text, as in the chat;
/// with "ver", a checkbox you can't click (a file from git); with "marcar", a
/// checkbox carrying the item's line in `data-linha`, for the viewer to write the click to disk.
export function markdown(texto: string, rebaixar = 2, caixas?: "ver" | "marcar"): string {
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
      // A mermaid diagram stays code here; the viewer swaps it for the drawing.
      if (cerca[1].trim() === "mermaid") html.push(`<pre class="mermaid"><code>${escapar(codigo.join("\n"))}</code></pre>`);
      else html.push(`<pre><code>${escapar(jsonLegivel(codigo.join("\n")))}</code></pre>`);
      continue;
    }

    const titulo = /^(#{1,6})\s+(.*)$/.exec(linha);
    if (titulo) {
      fecharParagrafo();
      const nivel = Math.min(titulo[1].length + rebaixar, 6);
      html.push(`<h${nivel}>${emLinha(titulo[2])}</h${nivel}>`);
      continue;
    }

    // Table: the header line and, right below, the dashes line.
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
        const cercaNoItem = /^(\s+)```/.exec(linhas[i]);
        if (m) itens.push(caixas ? itemComCaixa(m[3], i, caixas) : emLinha(m[3]));
        // An indented fence below an item is a code block inside it.
        else if (itens.length && cercaNoItem) {
          const recuo = cercaNoItem[1].length;
          const codigo: string[] = [];
          for (i++; i < linhas.length && !/^\s*```\s*$/.test(linhas[i]); i++) codigo.push(linhas[i].replace(new RegExp(`^ {0,${recuo}}`), ""));
          itens[itens.length - 1] += `<pre><code>${escapar(jsonLegivel(codigo.join("\n")))}</code></pre>`;
        }
        // An indented line right below an item is its continuation.
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

function itemComCaixa(texto: string, linha: number, caixas: "ver" | "marcar"): string {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(texto);
  if (!m) return emLinha(texto);
  const marcada = m[1] === " " ? "" : " checked";
  const clique = caixas === "marcar" ? ` data-linha="${linha}"` : " disabled";
  return `<input type="checkbox" class="tarefa"${marcada}${clique}>${emLinha(m[2])}`;
}

// ---------- what you wrote, on the terminal screen ----------

/// The marker Claude Code puts in front of what you sent. It changed from one
/// version to another, so every one it has used counts.
const SINAL = /^\s*[>❯›〉]\s+/;
/// How many characters from the start of the prompt are enough to recognize the line. The
/// screen wraps the text at the panel width, so only the start is comparable.
const COMECO = 24;
/// A pasted prompt may have hundreds of lines; the highlight doesn't go that far.
const ALTURA_MAXIMA = 12;

const compacto = (s: string) => s.replace(/\s+/g, " ").trim();

/// Where, among the screen lines, the prompts you sent are: the line where
/// each one starts and how many it takes (up to the first blank one).
///
/// Only matches a known prompt, not any line starting with the
/// marker: a quote in Claude's answer starts with `>` too.
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
      // The line may be shorter than the stored start: the panel is narrow
      // and the wrap came earlier. Then it is the whole line that must match.
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

// ---------- the /commands ----------

export type Comando = {
  nome: string;
  descricao: string;
  /// Opens a menu or a screen in the terminal (pick a model, resume a session): the
  /// chat has no way to show that, so whoever sends it is taken there.
  interativo?: boolean;
};

/// The commands that come built into Claude Code. Written by hand: it doesn't publish them
/// anywhere readable from outside. Yours (commands, skills, plugins)
/// come from disk, through Rust's `comandos_listar`.
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

/// The commands matching what was typed after the slash: first the ones
/// starting with it, then the ones containing it. The first of each name
/// wins — a command of yours with a built-in's name is what Claude runs.
export function filtrarComandos(todos: Comando[], digitado: string): Comando[] {
  const q = digitado.toLowerCase();
  const vistos = new Set<string>();
  const comeca: Comando[] = [];
  const contem: Comando[] = [];
  for (const c of todos) {
    const nome = c.nome.toLowerCase();
    if (vistos.has(nome)) continue;
    // `plugin:name` is also found by the name alone.
    const curto = nome.slice(nome.lastIndexOf(":") + 1);
    if (nome.startsWith(q) || curto.startsWith(q)) comeca.push(c);
    else if (nome.includes(q)) contem.push(c);
    else continue;
    vistos.add(nome);
  }
  return [...comeca, ...contem];
}

// ---------- Claude's questions (AskUserQuestion) ----------

/// A question as Claude sends it in `AskUserQuestion`'s `tool_input`.
export type Questao = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/// What you picked in a question: the checked options and, if you wrote it, the
/// "Other" text.
export type Escolha = { labels: string[]; outra?: string };

/// The questions in a `tool_input`, or nothing if it doesn't have the expected shape:
/// then the card doesn't show, and the question stays with the terminal.
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

/// The answer text for a question: "Other" stands on its own; with several checked,
/// they go together separated by commas, as the terminal does.
export function textoDaEscolha(e: Escolha | undefined): string | undefined {
  const outra = e?.outra?.trim();
  const partes = [...(e?.labels ?? []), ...(outra ? [outra] : [])];
  return partes.length ? partes.join(", ") : undefined;
}

/// The hook output that answers the questions: the same decision the VS Code
/// extension returns through the SDK — `allow`, with the questions back and the
/// answers keyed by each one's text. `undefined` while any is still
/// unanswered.
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
