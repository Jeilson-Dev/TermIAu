import type { Range } from "./rows";

/** A syntax token as produced by the highlighter. */
export interface Token {
  content: string;
  color?: string;
  /** Bit flags: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number;
}

export interface Segment extends Token {
  emph: boolean;
}

/** Splits a line into styled pieces, overlaying word-level change ranges on syntax tokens. */
export function segments(content: string, tokens: Token[] | null, emph: Range[] | null): Segment[] {
  if (!content) return [];
  // Tokens come from the full file; ignore them if they don't match this line exactly.
  const usable = tokens && tokens.map((t) => t.content).join("") === content;
  const base: Token[] = usable ? tokens : [{ content }];
  const ranges = emph ?? [];

  const out: Segment[] = [];
  let pos = 0;
  let ri = 0;
  for (const token of base) {
    const text = token.content;
    let start = 0;
    while (start < text.length) {
      const abs = pos + start;
      while (ri < ranges.length && ranges[ri][1] <= abs) ri++;
      const range = ranges[ri];
      const inside = range !== undefined && range[0] <= abs;
      const boundary = range === undefined ? text.length : (inside ? range[1] : range[0]) - pos;
      const end = Math.min(text.length, boundary);
      out.push({ content: text.slice(start, end), color: token.color, fontStyle: token.fontStyle, emph: inside });
      start = end;
    }
    pos += text.length;
  }
  return out;
}
