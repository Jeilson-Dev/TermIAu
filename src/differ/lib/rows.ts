// Turns a file's hunks into the rows the diff table renders: hunk lines, context
// revealed by expanding, and "gap" rows standing for the lines still hidden.

import { diffWordsWithSpace } from "diff";
import type { FileDiff, Hunk, LineKind, Side } from "../types";

/** Lines revealed per click on an expand button. */
export const EXPAND_STEP = 20;

/** Half-open character range [start, end). */
export type Range = [number, number];

export interface LineRow {
  type: "line";
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  content: string;
  noNewline: boolean;
  /** Changed character ranges within the line (word-level highlight). */
  emph: Range[] | null;
  /** Revealed by expanding context, not part of the original hunks. */
  expanded: boolean;
}

export type GapPosition = "top" | "middle" | "bottom";

export interface GapRow {
  type: "gap";
  index: number;
  position: GapPosition;
  /** Lines still hidden; `null` when unknown (end of file before its content loads). */
  remaining: number | null;
  /** Header of the hunk right after the gap. */
  header: string | null;
}

export type Row = LineRow | GapRow;

export interface PairRow {
  type: "pair";
  left: LineRow | null;
  right: LineRow | null;
}

export type SplitRow = PairRow | GapRow;

/** Unchanged lines between hunks (or before the first / after the last one). */
export interface Gap {
  index: number;
  position: GapPosition;
  oldStart: number;
  newStart: number;
  size: number | null;
  header: string | null;
}

/** How many lines were revealed from each end of a gap. */
export interface Expansion {
  top: number;
  bottom: number;
}

/** Full file content used to reveal hidden context, and which side it comes from. */
export interface ContextSource {
  side: Side;
  lines: string[];
}

// A hunk side with zero lines reports the line *before* it as its start.
const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);
const nextLine = (start: number, count: number) => (count === 0 ? start + 1 : start + count);

export function hunkHeader(h: Hunk): string {
  const section = h.section ? ` ${h.section}` : "";
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${section}`;
}

/** One gap before each hunk plus a trailing one. Added/deleted files show whole, so no gaps. */
export function fileGaps(file: FileDiff, context: ContextSource | null): Gap[] {
  if (file.hunks.length === 0 || file.status === "added" || file.status === "deleted") return [];

  const gaps: Gap[] = [];
  let oldNext = 1;
  let newNext = 1;
  file.hunks.forEach((h, index) => {
    gaps.push({
      index,
      position: index === 0 ? "top" : "middle",
      oldStart: oldNext,
      newStart: newNext,
      size: Math.max(0, firstLine(h.oldStart, h.oldLines) - oldNext),
      header: hunkHeader(h),
    });
    oldNext = nextLine(h.oldStart, h.oldLines);
    newNext = nextLine(h.newStart, h.newLines);
  });

  const trailingStart = context?.side === "old" ? oldNext : newNext;
  gaps.push({
    index: file.hunks.length,
    position: "bottom",
    oldStart: oldNext,
    newStart: newNext,
    size: context ? Math.max(0, context.lines.length - trailingStart + 1) : null,
    header: null,
  });
  return gaps;
}

export function buildRows(
  hunks: Hunk[],
  gaps: Gap[],
  expansions: Record<number, Expansion>,
  context: ContextSource | null,
): Row[] {
  const rows: Row[] = [];
  hunks.forEach((hunk, i) => {
    if (gaps[i]) pushGap(rows, gaps[i], expansions[i], context);
    rows.push(...hunkRows(hunk));
  });
  const trailing = gaps[hunks.length];
  if (trailing) pushGap(rows, trailing, expansions[trailing.index], context);
  return rows;
}

function pushGap(rows: Row[], gap: Gap, expansion: Expansion | undefined, context: ContextSource | null) {
  const gapRow = (remaining: number | null): GapRow => ({
    type: "gap",
    index: gap.index,
    position: gap.position,
    remaining,
    header: gap.header,
  });
  if (gap.size === null || !context) {
    if (gap.size !== 0 || gap.position === "top") rows.push(gapRow(gap.size));
    return;
  }

  const top = Math.min(expansion?.top ?? 0, gap.size);
  const bottom = Math.min(expansion?.bottom ?? 0, gap.size - top);
  const remaining = gap.size - top - bottom;

  for (let k = 0; k < top; k++) rows.push(contextRow(gap, k, context));
  // A first hunk starting at line 1 still gets its header row.
  if (remaining > 0 || (gap.position === "top" && gap.size === 0)) rows.push(gapRow(remaining));
  for (let k = gap.size - bottom; k < gap.size; k++) rows.push(contextRow(gap, k, context));
}

function contextRow(gap: Gap, offset: number, context: ContextSource): LineRow {
  const oldNo = gap.oldStart + offset;
  const newNo = gap.newStart + offset;
  return {
    type: "line",
    kind: "context",
    oldNo,
    newNo,
    content: context.lines[(context.side === "new" ? newNo : oldNo) - 1] ?? "",
    noNewline: false,
    emph: null,
    expanded: true,
  };
}

function hunkRows(hunk: Hunk): LineRow[] {
  const rows: LineRow[] = hunk.lines.map((line) => ({
    type: "line",
    kind: line.kind,
    oldNo: line.oldNo,
    newNo: line.newNo,
    content: line.content,
    noNewline: line.noNewline,
    emph: null,
    expanded: false,
  }));

  // Pair each block of removed lines with the added lines right after it.
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < rows.length && rows[i].kind === "del") i++;
    const addStart = i;
    while (i < rows.length && rows[i].kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const [oldEmph, newEmph] = intraline(rows[delStart + k].content, rows[addStart + k].content);
      rows[delStart + k].emph = oldEmph;
      rows[addStart + k].emph = newEmph;
    }
  }
  return rows;
}

/** Word-level changes between a removed and an added line; `null` when the line was mostly rewritten. */
export function intraline(oldText: string, newText: string): [Range[] | null, Range[] | null] {
  if (oldText.length + newText.length > 2000) return [null, null];

  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let o = 0;
  let n = 0;
  let common = 0;
  for (const change of diffWordsWithSpace(oldText, newText)) {
    const len = change.value.length;
    if (change.added) {
      pushRange(newRanges, n, n + len);
      n += len;
    } else if (change.removed) {
      pushRange(oldRanges, o, o + len);
      o += len;
    } else {
      o += len;
      n += len;
      common += len;
    }
  }
  if (common < 0.4 * Math.max(oldText.length, newText.length)) return [null, null];
  return [oldRanges, newRanges];
}

function pushRange(ranges: Range[], start: number, end: number) {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  const isKind = (row: Row | undefined, kind: LineKind): row is LineRow =>
    row?.type === "line" && row.kind === kind;

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === "gap") {
      out.push(row);
      i++;
    } else if (row.kind === "context") {
      out.push({ type: "pair", left: row, right: row });
      i++;
    } else {
      const dels: LineRow[] = [];
      const adds: LineRow[] = [];
      while (isKind(rows[i], "del")) dels.push(rows[i++] as LineRow);
      while (isKind(rows[i], "add")) adds.push(rows[i++] as LineRow);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        out.push({ type: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
      }
    }
  }
  return out;
}

/** Expansions that make `line` visible, or `null` when it isn't inside a hidden gap. */
export function revealLine(
  gaps: Gap[],
  expansions: Record<number, Expansion>,
  side: Side,
  line: number,
): Record<number, Expansion> | null {
  for (const gap of gaps) {
    if (gap.size === null) continue;
    const offset = line - (side === "new" ? gap.newStart : gap.oldStart);
    if (offset < 0 || offset >= gap.size) continue;
    const current = expansions[gap.index] ?? { top: 0, bottom: 0 };
    const hiddenFrom = current.top;
    const hiddenTo = gap.size - current.bottom;
    if (offset < hiddenFrom || offset >= hiddenTo) return null;
    // Reveal from the top down to the line, plus a little context after it.
    return { ...expansions, [gap.index]: { ...current, top: Math.min(gap.size, offset + 4) } };
  }
  return null;
}
