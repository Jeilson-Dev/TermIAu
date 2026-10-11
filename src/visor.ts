/// What the viewer needs to know without touching the DOM: finding file references
/// (`src/main.ts:848`) in a text. It lives in its own module so it can be tested, like
/// `conversa.ts`.

/// A reference found in a text. `inicio` and `fim` are positions in the text
/// (`fim` exclusive), and `arquivo` is still as it was written: relative or not,
/// Rust is the one that knows whether it exists (`arquivos_existem`).
export type Referencia = {
  inicio: number;
  fim: number;
  arquivo: string;
  linha?: number;
  ate?: number;
};

// A path with an extension (`a/b/c.ts`, `./x.md`, `~/notes.md`), followed,
// optionally, by `:line`, `:line-line` or `:line:column`. No spaces in the path:
// in terminal output there is no way to know where a path with spaces starts.
// The lookbehind prevents starting in the middle of something else — a URL, above all.
const PADRAO =
  /(?<![\w/.~@+:-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?:([-–:])(\d+))?)?(?![\w/])/g;

export function acharReferencias(texto: string): Referencia[] {
  const achadas: Referencia[] = [];
  for (const m of texto.matchAll(PADRAO)) {
    const [inteiro, arquivo, linha, sep, segundo] = m;
    // A stray number (`1.5`, `v2.0`) matches the pattern, but isn't a file.
    if (/^[\d.]+$/.test(arquivo)) continue;
    const ref: Referencia = { inicio: m.index, fim: m.index + inteiro.length, arquivo };
    if (linha) ref.linha = Number(linha);
    // `:10:5` is a column, and the viewer doesn't use columns; `:10-20` is a range.
    if (segundo && sep !== ":" && Number(segundo) >= Number(linha)) ref.ate = Number(segundo);
    achadas.push(ref);
  }
  return achadas;
}

/// Is the whole text a reference? It is the chat's `<code>` test: only
/// code that is just a path becomes a link, not a snippet that quotes one.
export function referenciaInteira(texto: string): Referencia | undefined {
  const t = texto.trim();
  const [ref] = acharReferencias(t);
  return ref && ref.inicio === 0 && ref.fim === t.length ? ref : undefined;
}

/// A line of the terminal screen: its text (with the spaces up to the edge) and
/// whether xterm marked it as a continuation of the one above (`isWrapped`).
export type LinhaDaTela = { texto: string; quebrada: boolean };

/// A text built from several screen lines, with each character's position
/// on it — it is what takes a reference found in the text back to the screen.
export type LinhaLogica = { texto: string; pos: { linha: number; col: number }[] };

// No `.` or `:` at the end: that is where sentences end, and a path broken right there
// is rare.
const PONTA = /[\w/~@+-]$/;
const COMECO = /^\s*[\w/.~@+-]/;

/// Does line `i` continue on the next one? When xterm wrapped the line, always.
/// With `juntar`, also when the program wrapped it: Claude Code wraps
/// its lines at the screen width and indents the continuation, and a long
/// path comes out split in two. The guess is narrow — the line got close to the
/// edge and ends, without a space, on a path character, and the next one starts
/// with another —, and the file existing is what confirms it.
export function continua(linhas: LinhaDaTela[], i: number, cols: number, juntar: boolean): boolean {
  const prox = linhas[i + 1];
  if (!prox) return false;
  if (prox.quebrada) return true;
  if (!juntar) return false;
  const atual = linhas[i].texto.trimEnd();
  return atual.length >= cols - 12 && PONTA.test(atual) && COMECO.test(prox.texto);
}

/// The logical line passing through screen line `i`. A program's
/// continuation comes in without its indentation; xterm's, whole. The guess applies
/// upward and downward separately: the caller tries the combinations, because
/// joining the next line by mistake would spoil the `:103` at the end of this one.
export function linhaLogica(
  linhas: LinhaDaTela[],
  i: number,
  cols: number,
  acima: boolean,
  abaixo = acima,
): LinhaLogica {
  let ini = i;
  while (ini > 0 && continua(linhas, ini - 1, cols, acima)) ini--;
  let fim = i;
  while (continua(linhas, fim, cols, abaixo)) fim++;
  let texto = "";
  const pos: LinhaLogica["pos"] = [];
  for (let r = ini; r <= fim; r++) {
    const bruto = linhas[r].texto;
    const de = r > ini && !linhas[r].quebrada ? bruto.length - bruto.trimStart().length : 0;
    const ate = r < fim && linhas[r + 1].quebrada ? bruto.length : bruto.trimEnd().length;
    for (let c = de; c < ate; c++) {
      texto += bruto[c];
      pos.push({ linha: r, col: c });
    }
  }
  return { texto, pos };
}

/// The file is markdown: it opens rendered.
export const ehMarkdown = (caminho: string) => /\.(md|markdown|mdx)$/i.test(caminho);

/// An image the viewer shows as a picture, read as bytes. SVG isn't one of them: it is
/// text, comes as lines and is drawn from them.
export const ehImagem = (caminho: string) => /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic)$/i.test(caminho);
export const ehSvg = (caminho: string) => /\.svg$/i.test(caminho);

/// What has a drawn view besides the source, and opens drawn: .md and .svg.
export const temRenderizado = (caminho: string) => ehMarkdown(caminho) || ehSvg(caminho);
