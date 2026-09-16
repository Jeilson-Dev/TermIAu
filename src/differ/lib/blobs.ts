import { readBlob, readWorktree } from "../api";
import { WORKTREE_KEY } from "../types";

// Blob ids are content hashes, so a cached blob never goes stale. A worktree key carries the
// file's size and mtime for the same reason: editing the file changes the key.
const cache = new Map<string, Promise<string[]>>();

/** The path a worktree key points to, or null when the key is a plain blob id. */
export function worktreePath(key: string): string | null {
  if (!key.startsWith(WORKTREE_KEY)) return null;
  const rest = key.slice(WORKTREE_KEY.length);
  const separator = rest.indexOf(":");
  return separator < 0 ? null : rest.slice(separator + 1);
}

export function getBlob(root: string, oid: string): Promise<string[]> {
  let blob = cache.get(oid);
  if (!blob) {
    const file = worktreePath(oid);
    blob = file === null ? readBlob(root, oid) : readWorktree(root, file);
    blob.catch(() => cache.delete(oid));
    cache.set(oid, blob);
  }
  return blob;
}
