import { T } from "../../i18n/differ";
import type { Bookmark, FileDiff } from "../types";
import { getBlob } from "./blobs";
import type { ReviewState } from "./persist";

export function rangeLabel(b: Pick<Bookmark, "side" | "startLine" | "endLine">): string {
  const lines = b.startLine === b.endLine ? T.linha(b.startLine) : T.linhas(b.startLine, b.endLine);
  return b.side === "old" ? `${lines} (${T.versaoAnterior})` : lines;
}

/**
 * The bookmark as text to paste into a prompt: `path:start-end`, the selected passage (if any)
 * and the note. Notes on the old side point at the file's previous path and say so.
 */
export function bookmarkReference(
  b: Pick<Bookmark, "path" | "side" | "startLine" | "endLine" | "note" | "quote">,
  oldPath: string | null = null,
): string {
  const lines = b.startLine === b.endLine ? `${b.startLine}` : `${b.startLine}-${b.endLine}`;
  const head =
    b.side === "old" ? `${oldPath ?? b.path}:${lines} (${T.versaoAnterior})` : `${b.path}:${lines}`;
  const parts = [head];
  if (b.quote) parts.push("selection:", b.quote);
  parts.push("comment:", b.note);
  return parts.join("\n");
}

/**
 * Todos os comentários num texto só, na ordem em que a lista os mostra — para
 * colar a revisão inteira de uma vez num prompt. Cada um sai exatamente como o
 * `bookmarkReference` o escreve, separados por linha em branco; os já resolvidos
 * vão marcados, porque num prompt eles mudam o pedido em vez de somar a ele.
 */
export function bookmarksReference(
  bookmarks: Bookmark[],
  referenceOf: (b: Bookmark) => string,
): string {
  if (bookmarks.length === 0) return "";
  const titulo = T.comentariosDeRevisao(bookmarks.length);
  const corpo = bookmarks.map((b) => (b.resolved ? `${referenceOf(b)}\n(${T.resolvido})` : referenceOf(b)));
  return [titulo, ...corpo].join("\n\n");
}

/**
 * A bookmark is outdated when its lines no longer hold the content it was created on.
 * Bookmarks still matching get their fingerprint refreshed so the next check is free.
 */
export async function checkBookmarks(
  root: string,
  files: FileDiff[],
  state: ReviewState,
): Promise<{ state: ReviewState; outdated: Set<string> }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const outdated = new Set<string>();

  const bookmarks = await Promise.all(
    state.bookmarks.map(async (bookmark) => {
      const file = byPath.get(bookmark.path);
      if (file?.fingerprint === bookmark.fingerprint) return bookmark;
      const oid = bookmark.side === "new" ? file?.newOid : file?.oldOid;
      if (file && oid) {
        try {
          const lines = (await getBlob(root, oid)).slice(bookmark.startLine - 1, bookmark.endLine);
          const same =
            lines.length === bookmark.snapshot.length && lines.every((l, i) => l === bookmark.snapshot[i]);
          if (same) return { ...bookmark, fingerprint: file.fingerprint };
        } catch {
          // Treat unreadable content as changed.
        }
      }
      outdated.add(bookmark.id);
      return bookmark;
    }),
  );

  return { state: { ...state, bookmarks }, outdated };
}
