import type { FileDiff } from "../types";

/** The next file still to be reviewed after `path`, wrapping around; `null` when everything is reviewed. */
export function nextToReview(files: FileDiff[], path: string, viewed: Set<string>): FileDiff | null {
  const index = files.findIndex((f) => f.path === path);
  const ordered = [...files.slice(index + 1), ...files.slice(0, Math.max(index, 0))];
  return ordered.find((f) => !viewed.has(f.path)) ?? null;
}
