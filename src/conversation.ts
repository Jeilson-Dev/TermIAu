/// A Claude Code session's conversation, read from its transcript (the JSONL in
/// `~/.claude/projects`), and what the terminal needs to find on screen what
/// you wrote. No DOM or xterm here: that is what makes this testable.

import { T } from "./i18n/terminal";

/// One turn of the conversation, in the order it happened.
export type Message =
  | { who: "claude"; text: string }
  /// `images`: the ones you pasted, as data URLs, in the order the text
  /// cites them (`[Image #N]`).
  | { who: "you"; text: string; images?: string[] }
  /// A tool Claude used: the name and one line of what it did.
  | { who: "tool"; name: string; summary: string }
  /// What a tool changed in the files — an Edit, a Write, or a
  /// Bash command that touched a file —, right below it.
  | { who: "diff"; files: FileDiff[] };

/// A changed file and the hunks of the change, as Claude Code stores them.
/// Rust already extracted it from the tool result (see `diff_from_result`).
export type FileDiff = {
  path: string;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
};

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type?: string; media_type?: string; data?: string };
};
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  thinkingDisplay?: string;
  message?: { content?: string | Block[] };
};

/// What Claude Code writes in the user's place: the output of a local
/// command, a system reminder, a task notice, the notice of an interruption.
/// It isn't you speaking.
const NOT_YOU = /^\s*(<(local-command-|system-reminder|task-notification|user-prompt-submit-hook|bash-)|\[Request interrupted)/;
const COMMAND = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGUMENTS = /<command-args>([\s\S]*?)<\/command-args>/;

/// What you typed, taken from what the transcript stores. A `/command` comes
/// wrapped in tags; it goes back to what was typed.
function fromUser(text: string): string | undefined {
  const command = COMMAND.exec(text);
  if (command) return `${command[1].trim()} ${ARGUMENTS.exec(text)?.[1].trim() ?? ""}`.trim();
  if (NOT_YOU.test(text) || text.startsWith("Caveat:")) return undefined;
  return text.trim() || undefined;
}

/// The text of one of your turns without what differs between what you typed and what
/// Claude stores: the pasted-text wrapper, the `[Image #N]`s, the spaces.
const comparable = (text: string) =>
  text
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(IMAGE, "")
    .replace(/\s+/g, " ")
    .trim();

/// How many of the provisional bubbles (each one's text, from oldest to
/// newest) your turn arriving from the transcript resolves. It isn't always the
/// oldest: messages sent while Claude works wait in its queue and
/// may arrive together, in a single turn; and a provisional one that never became a turn
/// (a `!command`, a send that didn't take) must not take another's place and
/// leave the right one duplicated on screen. The provisional ones before the match
/// go along: the transcript is in order, and they won't come anymore.
export function provisionalResolved(pending: string[], message: string): number {
  if (!pending.length) return 0;
  const arrived = comparable(message);
  const exact = pending.findIndex((p) => comparable(p) === arrived);
  if (exact >= 0) return exact + 1;
  let lastOne = -1;
  pending.forEach((p, i) => {
    const t = comparable(p);
    if (t && arrived.includes(t)) lastOne = i;
  });
  // Nothing similar: Claude stored something different from what was typed. The oldest
  // goes, as before.
  return lastOne >= 0 ? lastOne + 1 : 1;
}

/// The fields in which each tool says what it did, from most readable to least.
const SUMMARIES = ["description", "command", "file_path", "pattern", "query", "url", "prompt", "skill"];

export function summaryOf(input: Record<string, unknown> | undefined): string {
  for (const campo of SUMMARIES) {
    const v = input?.[campo];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

/// The turns of a transcript chunk. Each line is a JSON; one that isn't
/// (a cut line, a new format) is skipped, and the conversation goes on.
export function readMessages(jsonl: string): Message[] {
  const messages: Message[] = [];
  for (const bruta of jsonl.split("\n")) {
    if (!bruta.trim()) continue;
    let line: Line & { files?: FileDiff[] };
    try {
      line = JSON.parse(bruta) as Line;
    } catch {
      continue;
    }
    if (line.type === "diff") {
      if (line.files?.length) messages.push({ who: "diff", files: line.files });
      continue;
    }
    // Subagents write to the same file; the conversation is only the main one.
    if (line.isSidechain || line.isMeta) continue;
    const content = line.message?.content;
    if (content === undefined) continue;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;

    if (line.type === "user") {
      // A tool's result comes back as a "user" message.
      if (blocks.some((b) => b.type === "tool_result")) continue;
      const text = blocks
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      const images = blocks.flatMap((b) =>
        b.type === "image" && b.source?.type === "base64" && b.source.data
          ? [`data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`]
          : [],
      );
      // Image only, no text: it is still you speaking.
      const your = fromUser(text) ?? (images.length && !NOT_YOU.test(text) ? "" : undefined);
      if (your !== undefined) messages.push(images.length ? { who: "you", text: your, images } : { who: "you", text: your });
    } else if (line.type === "assistant") {
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) messages.push({ who: "claude", text: b.text });
        // With `thinkingDisplay: "updates"`, what Claude says between tools comes
        // as a thinking block with text; the actual reasoning comes empty.
        else if (b.type === "thinking" && line.thinkingDisplay === "updates" && b.thinking?.trim())
          messages.push({ who: "claude", text: b.thinking });
        else if (b.type === "tool_use") {
          messages.push({ who: "tool", name: b.name ?? "tool", summary: summaryOf(b.input) });
        }
      }
    }
  }
  return messages;
}

// ---------- what you wrote, in parts ----------

/// A piece of your bubble: your text, text you pasted (which Claude
/// Code wraps in `<pasted_content>`), or one of the turn's images.
export type Part =
  | { kind: "text"; text: string }
  | { kind: "pasted"; text: string }
  | { kind: "image"; index: number };

/// The opening and closing tags may come with or without the `id` — the closing one,
/// oddly, repeats the id.
const PASTED = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;
const IMAGE = /\[Image #\d+\]/g;

/// Splits your text into the pieces the bubble draws in different ways. The
/// k-th `[Image #N]` is the turn's k-th image: N is counted across the whole
/// session, not the turn. An image the text doesn't cite goes at the end.
export function partsOfYour(text: string, images: number): Part[] {
  const parts: Part[] = [];
  let usedOnes = 0;
  const withText = (t: string) => {
    let since = 0;
    for (const m of t.matchAll(IMAGE)) {
      if (usedOnes >= images) break;
      const before = t.slice(since, m.index);
      if (before.trim()) parts.push({ kind: "text", text: before.trim() });
      parts.push({ kind: "image", index: usedOnes++ });
      since = m.index + m[0].length;
    }
    const rest = t.slice(since);
    if (rest.trim()) parts.push({ kind: "text", text: rest.trim() });
  };
  let since = 0;
  for (const m of text.matchAll(PASTED)) {
    withText(text.slice(since, m.index));
    parts.push({ kind: "pasted", text: m[1] });
    since = m.index + m[0].length;
  }
  withText(text.slice(since));
  while (usedOnes < images) parts.push({ kind: "image", index: usedOnes++ });
  return parts;
}

// ---------- the diff of an edit ----------

/// A diff line as the terminal shows it: what went out, what came in, the
/// surrounding context, or the `…` between two distant hunks. `num` is the line
/// in the file: the old one for what went out, the new one for the rest.
/// `old`: the number a context line had before, which side by side shows.
export type LineDiff = { kind: "-" | "+" | " " | "…"; text: string; num?: number; old?: number };

/// A diff file's lines, numbered, and how many came in and went out.
export function diffLines(file: FileDiff): { lines: LineDiff[]; more: number; less: number } {
  const lines: LineDiff[] = [];
  let more = 0;
  let less = 0;
  for (const h of file.hunks) {
    if (lines.length) lines.push({ kind: "…", text: "" });
    let oldText = h.oldStart;
    let newOne = h.newStart;
    for (const l of h.lines) {
      // "\ No newline at end of file" isn't a line of the file.
      if (l.startsWith("\\")) continue;
      const kind = l[0] === "+" || l[0] === "-" ? l[0] : " ";
      if (kind === "-") {
        less++;
        lines.push({ kind, text: l.slice(1), num: oldText++ });
      } else {
        if (kind === "+") {
          more++;
          lines.push({ kind, text: l.slice(1), num: newOne++ });
        } else lines.push({ kind, text: l.slice(1), num: newOne++, old: oldText++ });
      }
    }
  }
  return { lines, more, less };
}

/// A side-by-side line: before on the left, after on the right. An empty
/// side is a line that only exists on the other.
export type DiffPair = { jump: true } | { jump?: false; before?: LineDiff; after?: LineDiff };

/// The diff lines in two columns, as the differ shows them: the context on both
/// sides, and each block of removed lines beside the ones that replaced them.
export function sideBySide(lines: LineDiff[]): DiffPair[] {
  const pairs: DiffPair[] = [];
  let exited: LineDiff[] = [];
  let entered: LineDiff[] = [];
  const close = () => {
    for (let i = 0; i < Math.max(exited.length, entered.length); i++) pairs.push({ before: exited[i], after: entered[i] });
    exited = [];
    entered = [];
  };
  for (const l of lines) {
    if (l.kind === "-") {
      // A `-` after a `+` starts another block.
      if (entered.length) close();
      exited.push(l);
    } else if (l.kind === "+") entered.push(l);
    else {
      close();
      if (l.kind === "…") pairs.push({ jump: true });
      else pairs.push({ before: { ...l, num: l.old }, after: l });
    }
  }
  close();
  return pairs;
}

// ---------- markdown ----------

export const escape = (s: string) =>
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

/// What ends a sentence and not the URL written in it: `see https://a.b/c.` links
/// without the period. Already escaped, so a quote or `>` is its entity. A `)` only
/// stays when it closes a `(` of the URL itself, as in Wikipedia's.
const SENTENCE_END = /(?:[.,:;!?'*\]]|&quot;|&gt;|&lt;)+$/;

function looseLink(url: string): string {
  let end = "";
  for (;;) {
    const punctuation = SENTENCE_END.exec(url)?.[0] ?? "";
    // A `;` that closes `&amp;` is part of the URL.
    const cut = /&amp$/.test(url.slice(0, url.length - punctuation.length)) ? punctuation.slice(1) : punctuation;
    if (cut) {
      end = cut + end;
      url = url.slice(0, -cut.length);
    } else if (url.endsWith(")") && url.split(")").length > url.split("(").length) {
      end = ")" + end;
      url = url.slice(0, -1);
    } else break;
  }
  return `<a href="${url}">${url}</a>${end}`;
}

/// Bold, italic, links and emoji shortcodes in a snippet that no longer has code in it.
/// A bare URL is a link too: Claude often writes them without `[text](url)`.
function emphasis(s: string): string {
  return escape(s)
    .replace(/:([a-z_]+):/g, (todo, name: string) => EMOJIS[name] ?? todo)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(<a [^>]*>[\s\S]*?<\/a>)|https?:\/\/[^\s<]+/g, (todo, pronto?: string) => pronto ?? looseLink(todo))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
}

/// Code between backticks comes out before everything: what is inside isn't
/// markdown, and a `**` there must stay two asterisks. It goes out to a
/// placeholder and comes back at the end, instead of splitting the line at it: a bold may
/// start before the code and end after it, and with the line split it wouldn't close.
function inline(s: string): string {
  const codes: string[] = [];
  const noCode = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  return emphasis(noCode).replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escape(codes[Number(i)])}</code>`);
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/// JSON written on a single line, as Claude often quotes a payload, comes out
/// with line breaks and indentation. What isn't valid JSON, or already comes on several
/// lines, stays as is.
export function readableJson(code: string): string {
  const t = code.trim();
  if (t.includes("\n") || !/^[[{]/.test(t)) return code;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return code;
  }
}

/// The markdown Claude usually writes, as HTML: headings, lists, tables,
/// code blocks, and inline emphasis. It isn't a complete parser — it is
/// enough for an answer to be readable, and everything that comes in is escaped.
/// `demote`: how many levels headings go down. In the chat bubble a `#` becomes
/// h3, otherwise it would shout louder than the conversation; in the viewer the document is the whole
/// page, and headings stay as they are.
/// `boxes`: what a `- [ ]` / `- [x]` item becomes. Without it, text, as in the chat;
/// with "view", a checkbox you can't click (a file from git); with "mark", a
/// checkbox carrying the item's line in `data-line`, for the viewer to write the click to disk.
/// `source`: each block (and each list item and table row) carries the source lines it
/// came from, 1-based, in `data-from` / `data-to` — for the viewer to light up a requested line.
export function markdown(text: string, demote = 2, boxes?: "view" | "mark", source = false): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  const where = (from: number, to = from) => (source ? ` data-from="${from + 1}" data-to="${to + 1}"` : "");
  let paragraph: string[] = [];
  let beginning = 0;
  const closeParagraph = () => {
    if (paragraph.length) html.push(`<p${where(beginning, beginning + paragraph.length - 1)}>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      closeParagraph();
      const from = i;
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      const place = where(from, Math.min(i, lines.length - 1));
      // A mermaid diagram stays code here; the viewer swaps it for the drawing.
      if (fence[1].trim() === "mermaid") html.push(`<pre class="mermaid"${place}><code>${escape(code.join("\n"))}</code></pre>`);
      else html.push(`<pre${place}><code>${escape(readableJson(code.join("\n")))}</code></pre>`);
      continue;
    }

    const title = /^(#{1,6})\s+(.*)$/.exec(line);
    if (title) {
      closeParagraph();
      const level = Math.min(title[1].length + demote, 6);
      html.push(`<h${level}${where(i)}>${inline(title[2])}</h${level}>`);
      continue;
    }

    // Table: the header line and, right below, the dashes line.
    if (line.includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      closeParagraph();
      const from = i;
      const head = cells(line).map((c) => `<th>${inline(c)}</th>`).join("");
      const body: string[] = [];
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) {
        const n = i;
        body.push(`<tr${where(n)}>${cells(lines[i]).map((c, k) => `<td>${boxes ? cellWithBox(c, n, k, boxes) : inline(c)}</td>`).join("")}</tr>`);
      }
      i--;
      html.push(`<table${where(from, i)}><thead><tr${where(from, from + 1)}>${head}</tr></thead><tbody>${body.join("")}</tbody></table>`);
      continue;
    }

    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      closeParagraph();
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      const items: string[] = [];
      const strips: [number, number][] = [];
      const from = i;
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const fenceInItem = /^(\s+)```/.exec(lines[i]);
        if (m) {
          items.push(boxes ? itemWithBox(m[3], i, boxes) : inline(m[3]));
          strips.push([i, i]);
        }
        // An indented fence below an item is a code block inside it.
        else if (items.length && fenceInItem) {
          const indent = fenceInItem[1].length;
          const code: string[] = [];
          for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
          items[items.length - 1] += `<pre><code>${escape(readableJson(code.join("\n")))}</code></pre>`;
          strips[strips.length - 1][1] = Math.min(i, lines.length - 1);
        }
        // An indented line right below an item is its continuation.
        else if (items.length && /^\s+\S/.test(lines[i])) {
          items[items.length - 1] += `<br>${inline(lines[i].trim())}`;
          strips[strips.length - 1][1] = i;
        } else break;
      }
      i--;
      html.push(`<${tag}${where(from, i)}>${items.map((t, k) => `<li${where(...strips[k])}>${t}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      continue;
    }
    if (!paragraph.length) beginning = i;
    paragraph.push(line);
  }
  closeParagraph();
  return html.join("");
}

function itemWithBox(text: string, line: number, boxes: "view" | "mark"): string {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return inline(text);
  return box(m[1] !== " ", boxes === "mark" ? ` data-line="${line}"` : undefined) + inline(m[2]);
}

/// A table cell that starts with `[ ]` / `[x]`: the checkbox also carries the column,
/// since a row may have more than one.
function cellWithBox(text: string, line: number, column: number, boxes: "view" | "mark"): string {
  const m = /^\[([ xX])\](?:\s+(.*))?$/.exec(text);
  if (!m) return inline(text);
  const where = boxes === "mark" ? ` data-line="${line}" data-column="${column}"` : undefined;
  return box(m[1] !== " ", where) + inline(m[2] ?? "");
}

const box = (marked: boolean, where?: string) =>
  `<input type="checkbox" class="task"${marked ? " checked" : ""}${where ?? " disabled"}>`;

/// The source line with the checkbox flipped: the list item's, or, with `column`,
/// the one at the start of that table cell.
export function markOnLine(line: string, marked: boolean, column?: number): string {
  const x = `[${marked ? "x" : " "}]`;
  if (column === undefined) return line.replace(/^(\s*(?:[-*]|\d+[.)])\s+)\[[ xX]\]/, `$1${x}`);
  const parts = line.split("|");
  const k = column + (/^\s*\|/.test(line) ? 1 : 0);
  if (k >= parts.length) return line;
  parts[k] = parts[k].replace(/^(\s*)\[[ xX]\]/, `$1${x}`);
  return parts.join("|");
}

// ---------- what you wrote, on the terminal screen ----------

/// The marker Claude Code puts in front of what you sent. It changed from one
/// version to another, so every one it has used counts.
const SINAL = /^\s*[>❯›〉]\s+/;
/// How many characters from the start of the prompt are enough to recognize the line. The
/// screen wraps the text at the panel width, so only the start is comparable.
const START = 24;
/// A pasted prompt may have hundreds of lines; the highlight doesn't go that far.
const MAX_HEIGHT = 12;

const compactMode = (s: string) => s.replace(/\s+/g, " ").trim();

/// Where, among the screen lines, the prompts you sent are: the line where
/// each one starts and how many it takes (up to the first blank one).
///
/// Only matches a known prompt, not any line starting with the
/// marker: a quote in Claude's answer starts with `>` too.
export function promptLines(screen: string[], prompts: string[]): { line: number; height: number }[] {
  const starts = new Set<string>();
  for (const p of prompts) {
    const c = compactMode(p.split("\n").find((l) => l.trim()) ?? "").slice(0, START);
    if (c) starts.add(c);
  }
  if (!starts.size) return [];

  const findings: { line: number; height: number }[] = [];
  for (let i = 0; i < screen.length; i++) {
    const sinal = SINAL.exec(screen[i]);
    if (!sinal) continue;
    const rest = compactMode(screen[i].slice(sinal[0].length));
    let matched = false;
    for (const c of starts) {
      // The line may be shorter than the stored start: the panel is narrow
      // and the wrap came earlier. Then it is the whole line that must match.
      if (rest.startsWith(c) || (rest.length >= 8 && c.startsWith(rest))) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    let height = 1;
    while (height < MAX_HEIGHT && (screen[i + height] ?? "").trim() && !SINAL.test(screen[i + height])) height++;
    findings.push({ line: i, height });
    i += height - 1;
  }
  return findings;
}

// ---------- the /commands ----------

export type Command = {
  name: string;
  description: string;
  /// Opens a menu or a screen in the terminal (pick a model, resume a session): the
  /// chat has no way to show that, so whoever sends it is taken there.
  interactive?: boolean;
};

/// The commands that come built into Claude Code. Written by hand: it doesn't publish them
/// anywhere readable from outside. Yours (commands, skills, plugins)
/// come from disk, through Rust's `commands_list`.
export const CLAUDE_COMMANDS: Command[] = [
  { name: "clear", description: T.cmdClear },
  { name: "compact", description: T.cmdCompact },
  { name: "init", description: T.cmdInit },
  { name: "review", description: T.cmdReview },
  { name: "code-review", description: T.cmdCodeReview },
  { name: "security-review", description: T.cmdSecurityReview },
  { name: "add-dir", description: T.cmdAddDir },
  { name: "fast", description: T.cmdFast },
  { name: "model", description: T.cmdModel, interactive: true },
  { name: "resume", description: T.cmdResume, interactive: true },
  { name: "rewind", description: T.cmdRewind, interactive: true },
  { name: "context", description: T.cmdContext, interactive: true },
  { name: "usage", description: T.cmdUsage, interactive: true },
  { name: "cost", description: T.cmdCost, interactive: true },
  { name: "status", description: T.cmdStatus, interactive: true },
  { name: "config", description: T.cmdConfig, interactive: true },
  { name: "permissions", description: T.cmdPermissions, interactive: true },
  { name: "memory", description: T.cmdMemory, interactive: true },
  { name: "mcp", description: T.cmdMcp, interactive: true },
  { name: "agents", description: T.cmdAgents, interactive: true },
  { name: "hooks", description: T.cmdHooks, interactive: true },
  { name: "plugin", description: T.cmdPlugin, interactive: true },
  { name: "skills", description: T.cmdSkills, interactive: true },
  { name: "export", description: T.cmdExport, interactive: true },
  { name: "theme", description: T.cmdTheme, interactive: true },
  { name: "doctor", description: T.cmdDoctor, interactive: true },
  { name: "help", description: T.cmdHelp, interactive: true },
  { name: "login", description: T.cmdLogin, interactive: true },
  { name: "exit", description: T.cmdExit },
];

/// The commands matching what was typed after the slash: first the ones
/// starting with it, then the ones containing it. The first of each name
/// wins — a command of yours with a built-in's name is what Claude runs.
export function filterCommands(all: Command[], typed: string): Command[] {
  const q = typed.toLowerCase();
  const seen = new Set<string>();
  const begins: Command[] = [];
  const contains: Command[] = [];
  for (const c of all) {
    const name = c.name.toLowerCase();
    if (seen.has(name)) continue;
    // `plugin:name` is also found by the name alone.
    const short = name.slice(name.lastIndexOf(":") + 1);
    if (name.startsWith(q) || short.startsWith(q)) begins.push(c);
    else if (name.includes(q)) contains.push(c);
    else continue;
    seen.add(name);
  }
  return [...begins, ...contains];
}

// ---------- Claude's questions (AskUserQuestion) ----------

/// A question as Claude sends it in `AskUserQuestion`'s `tool_input`.
export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/// What you picked in a question: the checked options and, if you wrote it, the
/// "Other" text.
export type Choice = { labels: string[]; other?: string };

/// The questions in a `tool_input`, or nothing if it doesn't have the expected shape:
/// then the card doesn't show, and the question stays with the terminal.
export function questionsOf(input: Record<string, unknown> | undefined): QuestionItem[] | undefined {
  const qs = input?.questions;
  if (!Array.isArray(qs) || !qs.length) return undefined;
  const ok = qs.every(
    (q) =>
      typeof q?.question === "string" &&
      Array.isArray(q.options) &&
      q.options.every((o: { label?: unknown }) => typeof o?.label === "string"),
  );
  return ok ? (qs as QuestionItem[]) : undefined;
}

/// The answer text for a question: "Other" stands on its own; with several checked,
/// they go together separated by commas, as the terminal does.
export function choiceText(e: Choice | undefined): string | undefined {
  const other = e?.other?.trim();
  const parts = [...(e?.labels ?? []), ...(other ? [other] : [])];
  return parts.length ? parts.join(", ") : undefined;
}

/// The hook output that answers the questions: the same decision the VS Code
/// extension returns through the SDK — `allow`, with the questions back and the
/// answers keyed by each one's text. `undefined` while any is still
/// unanswered.
export function hookAnswer(questions: QuestionItem[], choices: (Choice | undefined)[]): string | undefined {
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const text = choiceText(choices[i]);
    if (!text) return undefined;
    answers[q.question] = text;
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: questions, answers } },
    },
  });
}
