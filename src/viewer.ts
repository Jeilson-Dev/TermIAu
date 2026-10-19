/// What the viewer needs to know without touching the DOM: finding file references
/// (`src/main.ts:848`) in a text. It lives in its own module so it can be tested, like
/// `conversa.ts`.

/// A reference found in a text. `beginning` and `end` are positions in the text
/// (`end` exclusive), and `file` is still as it was written: relative or not,
/// Rust is the one that knows whether it exists (`arquivos_existem`).
export type Reference = {
  beginning: number;
  end: number;
  file: string;
  line?: number;
  to?: number;
};

// A path with an extension (`a/b/c.ts`, `./x.md`, `~/notes.md`), followed,
// optionally, by `:line`, `:line-line` or `:line:column`. No spaces in the path:
// in terminal output there is no way to know where a path with spaces starts.
// The lookbehind prevents starting in the middle of something else — a URL, above all.
const DEFAULT =
  /(?<![\w/.~@+:-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?:([-–:])(\d+))?)?(?![\w/])/g;

export function findReferences(text: string): Reference[] {
  const foundOnes: Reference[] = [];
  for (const m of text.matchAll(DEFAULT)) {
    const [entire, file, line, sep, second] = m;
    // A stray number (`1.5`, `v2.0`) matches the pattern, but isn't a file.
    if (/^[\d.]+$/.test(file)) continue;
    const ref: Reference = { beginning: m.index, end: m.index + entire.length, file };
    if (line) ref.line = Number(line);
    // `:10:5` is a column, and the viewer doesn't use columns; `:10-20` is a range.
    if (second && sep !== ":" && Number(second) >= Number(line)) ref.to = Number(second);
    foundOnes.push(ref);
  }
  return foundOnes;
}

/// Is the whole text a reference? It is the chat's `<code>` test: only
/// code that is just a path becomes a link, not a snippet that quotes one.
export function referenceWhole(text: string): Reference | undefined {
  const t = text.trim();
  const [ref] = findReferences(t);
  return ref && ref.beginning === 0 && ref.end === t.length ? ref : undefined;
}

/// A line of the terminal screen: its text (with the spaces up to the edge) and
/// whether xterm marked it as a continuation of the one above (`isWrapped`).
export type ScreenLine = { text: string; broken: boolean };

/// A text built from several screen lines, with each character's position
/// on it — it is what takes a reference found in the text back to the screen.
export type LogicalLine = { text: string; pos: { line: number; col: number }[] };

// No `.` or `:` at the end: that is where sentences end, and a path broken right there
// is rare.
const TIP = /[\w/~@+-]$/;
const START = /^\s*[\w/.~@+-]/;

/// Does line `i` continue on the next one? When xterm wrapped the line, always.
/// With `join`, also when the program wrapped it: Claude Code wraps
/// its lines at the screen width and indents the continuation, and a long
/// path comes out split in two. The guess is narrow — the line got close to the
/// edge and ends, without a space, on a path character, and the next one starts
/// with another —, and the file existing is what confirms it.
export function continues(lines: ScreenLine[], i: number, cols: number, join: boolean): boolean {
  const nextOne = lines[i + 1];
  if (!nextOne) return false;
  if (nextOne.broken) return true;
  if (!join) return false;
  const current = lines[i].text.trimEnd();
  return current.length >= cols - 12 && TIP.test(current) && START.test(nextOne.text);
}

/// The logical line passing through screen line `i`. A program's
/// continuation comes in without its indentation; xterm's, whole. The guess applies
/// upward and downward separately: the caller tries the combinations, because
/// joining the next line by mistake would spoil the `:103` at the end of this one.
export function logicalLine(
  lines: ScreenLine[],
  i: number,
  cols: number,
  up: boolean,
  below = up,
): LogicalLine {
  let ini = i;
  while (ini > 0 && continues(lines, ini - 1, cols, up)) ini--;
  let end = i;
  while (continues(lines, end, cols, below)) end++;
  let text = "";
  const pos: LogicalLine["pos"] = [];
  for (let r = ini; r <= end; r++) {
    const raw = lines[r].text;
    const from = r > ini && !lines[r].broken ? raw.length - raw.trimStart().length : 0;
    const to = r < end && lines[r + 1].broken ? raw.length : raw.trimEnd().length;
    for (let c = from; c < to; c++) {
      text += raw[c];
      pos.push({ line: r, col: c });
    }
  }
  return { text, pos };
}

/// The file is markdown: it opens rendered.
export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/// An image the viewer shows as a picture, read as bytes. SVG isn't one of them: it is
/// text, comes as lines and is drawn from them.
export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic)$/i.test(path);
export const isSvg = (path: string) => /\.svg$/i.test(path);

/// What has a drawn view besides the source, and opens drawn: .md and .svg.
export const hasRendered = (path: string) => isMarkdown(path) || isSvg(path);
