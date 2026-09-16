// Incremental review: the diff from the last commit reviewed to the end up to HEAD, with the
// bookmarks placed on its old side (which is exactly the content they were written on).

import type { Bookmark, FileDiff, Hunk, ReviewCheckpoint, Side } from "../types";
import { getBlob } from "./blobs";

/** Where a bookmark is shown in the diff on screen. */
export interface Anchor {
  side: Side;
  startLine: number;
  endLine: number;
}

/**
 * What the fixes did to a bookmark's lines:
 * - `changed`: some fix touched them;
 * - `unchanged`: the file changed, but not these lines;
 * - `fileUnchanged`: the file is not in the fixes at all;
 * - `lost`: the lines couldn't be found in the reviewed version;
 * - `new`: the bookmark was made on the current HEAD, it isn't a review note being checked.
 */
export type FixStatus = "changed" | "unchanged" | "fileUnchanged" | "lost" | "new";

export interface FixPlacement {
  status: FixStatus;
  anchor: Anchor | null;
  /** The bookmark's lines in the current (HEAD) file, so a copied reference points at today's code. */
  current: { path: string; startLine: number; endLine: number } | null;
}

/**
 * Base of the incremental review: the last commit reviewed to the end (every file marked).
 * A review completed on HEAD itself waits for the next commit, so the diff just reviewed stays
 * on screen until then. Null when nothing was reviewed to the end: the branch's own base applies.
 */
export function incrementalBase(completed: ReviewCheckpoint[], headSha: string | null): string | null {
  let last: ReviewCheckpoint | null = null;
  for (const c of completed) if (c.commit !== headSha && (!last || c.at > last.at)) last = c;
  return last?.commit ?? null;
}

/** Whether the hunks delete a line in `start..end`, or insert one between two of its lines. */
export function touches(hunks: Hunk[], start: number, end: number): boolean {
  for (const h of hunks) {
    // Old line right before the next line of the hunk (a pure insertion starts after `oldStart`).
    let before = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    for (const l of h.lines) {
      if (l.kind === "add") {
        if (before >= start && before < end) return true;
        continue;
      }
      before = l.oldNo!;
      if (l.kind === "del" && before >= start && before <= end) return true;
    }
  }
  return false;
}

/** The new-side line an old line ended up at; a deleted line maps to where it used to be. */
export function mapOldLine(hunks: Hunk[], line: number): number {
  let delta = 0;
  for (const h of hunks) {
    const insertion = h.oldLines === 0;
    if (insertion ? line <= h.oldStart : line < h.oldStart) break;
    if (!insertion && line < h.oldStart + h.oldLines) {
      let next = h.newLines === 0 ? h.newStart + 1 : h.newStart;
      for (const l of h.lines) {
        if (l.oldNo === line) return l.newNo ?? next;
        if (l.newNo !== null) next = l.newNo + 1;
      }
    }
    delta += h.newLines - h.oldLines;
  }
  return line + delta;
}

/**
 * First line of the bookmark's snapshot in `lines`: at its own line numbers, or (when code
 * above it moved) at the one other place it appears. Bookmarks written on `lines` themselves
 * are trusted without comparing.
 */
function locate(lines: string[], b: Bookmark, written: boolean): number | null {
  if (written) return b.startLine;
  const size = b.endLine - b.startLine + 1;
  if (b.snapshot.length !== size) return null;
  const at = (start: number) => b.snapshot.every((l, i) => lines[start - 1 + i] === l);
  if (at(b.startLine)) return b.startLine;
  let found: number | null = null;
  for (let start = 1; start + size - 1 <= lines.length; start++) {
    if (!at(start)) continue;
    if (found !== null) return null; // ambiguous
    found = start;
  }
  return found;
}

export async function placeBookmarks(
  root: string,
  diff: { files: FileDiff[]; headSha: string; base: string },
  bookmarks: Bookmark[],
): Promise<Map<string, FixPlacement>> {
  const byPath = new Map<string, FileDiff>();
  for (const f of diff.files) byPath.set(f.path, f);
  for (const f of diff.files) if (f.oldPath && !byPath.has(f.oldPath)) byPath.set(f.oldPath, f);

  const entries = await Promise.all(
    bookmarks.map(async (b): Promise<[string, FixPlacement]> => {
      const same = { path: b.path, startLine: b.startLine, endLine: b.endLine };
      const file = byPath.get(b.path);
      if (!file) {
        return [b.id, { status: "fileUnchanged", anchor: null, current: b.side === "new" ? same : null }];
      }
      if (b.commit === diff.headSha && b.side === "new") {
        const anchor: Anchor = { side: "new", startLine: b.startLine, endLine: b.endLine };
        return [b.id, { status: "new", anchor, current: same }];
      }

      let start: number | null = null;
      if (file.oldOid) {
        try {
          start = locate(await getBlob(root, file.oldOid), b, b.commit === diff.base);
        } catch {
          // Unreadable content: the bookmark can't be placed.
        }
      }
      if (start === null && file.newOid) {
        // Written after the base (a later round): the lines may still be there, untouched, today.
        try {
          const found = locate(await getBlob(root, file.newOid), b, false);
          if (found !== null) {
            const lines = { startLine: found, endLine: found + (b.endLine - b.startLine) };
            return [
              b.id,
              { status: "unchanged", anchor: { side: "new", ...lines }, current: { path: file.path, ...lines } },
            ];
          }
        } catch {
          // Unreadable content: the bookmark can't be placed.
        }
      }
      if (start === null) return [b.id, { status: "lost", anchor: null, current: null }];

      const end = start + (b.endLine - b.startLine);
      const newStart = mapOldLine(file.hunks, start);
      const current = file.newOid
        ? { path: file.path, startLine: newStart, endLine: Math.max(newStart, mapOldLine(file.hunks, end)) }
        : null;
      return [
        b.id,
        {
          status: touches(file.hunks, start, end) ? "changed" : "unchanged",
          anchor: { side: "old", startLine: start, endLine: end },
          current,
        },
      ];
    }),
  );
  return new Map(entries);
}
