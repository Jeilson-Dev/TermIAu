import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo, ReviewDiff } from "./types";

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });

export const loadDiff = (path: string, target: string) =>
  invoke<ReviewDiff>("load_diff", { path, target });

/** What changed since a reviewed commit; `mergeBase` (and `target`) come back as that commit. */
export const loadDiffSince = (path: string, base: string) =>
  invoke<ReviewDiff>("load_diff_since", { path, base });

/** Cheap signature of the disk state: changes when what the pending tab shows changes. */
export const workingStamp = (path: string) => invoke<string>("working_stamp", { path });

/** What is about to be committed: index, working tree and files git doesn't track. */
export const loadDiffWorking = (path: string) => invoke<ReviewDiff>("load_diff_working", { path });

/**
 * The only three calls that write to the repository. The target is a file, a
 * folder or "." for everything in the repository.
 */
export const stage = (path: string, target: string) => invoke<void>("stage", { path, target });

export const unstage = (path: string, target: string) => invoke<void>("unstage", { path, target });

/** Commits what is in the index and returns the new commit's sha. */
export const commitIndex = (path: string, message: string) =>
  invoke<string>("commit", { path, message });

export const readBlob = (path: string, oid: string) => invoke<string[]>("read_blob", { path, oid });

/** The file as it is on disk: the new side of the working tree diff has no blob. */
export const readWorktree = (path: string, file: string) =>
  invoke<string[]>("read_worktree", { path, file });

/** Starts watching this repository's .git; the notice comes back on `differ://changed`. */
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

export const readBlobBytes = (path: string, oid: string) =>
  invoke<ArrayBuffer>("read_blob_bytes", { path, oid });

export const readWorktreeBytes = (path: string, file: string) =>
  invoke<ArrayBuffer>("read_worktree_bytes", { path, file });
