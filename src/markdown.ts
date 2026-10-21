/// Markdown to HTML, for the file viewer's `.md` and any plugin that renders it (the
/// Claude chat). No DOM here: that is what makes it testable.

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
