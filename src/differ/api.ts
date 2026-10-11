import { invoke } from "@tauri-apps/api/core";
import type { ClaudeSession, RepoInfo, ReviewDiff } from "./types";

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

/** Starts watching this repository's .git; the notice comes back on `differ://mudou`. */
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

export const readBlobBytes = (path: string, oid: string) =>
  invoke<ArrayBuffer>("read_blob_bytes", { path, oid });

export const readWorktreeBytes = (path: string, file: string) =>
  invoke<ArrayBuffer>("read_worktree_bytes", { path, file });

/** The Claude Code sessions open in this repository, newest first. */
export const claudeSessions = (path: string) => invoke<ClaudeSession[]>("claude_sessions", { path });

/**
 * Asks Claude (`claude -p`) without saving any session. `context` goes through stdin; `session`
 * makes the question run in a copy of that session, knowing what was already discussed in it. Conversation
 * only: editing the repository's files only with `allowEdits`.
 */
export const askClaude = (
  path: string,
  id: string,
  question: string,
  context: string,
  model: string | null,
  session: string | null,
  allowEdits = false,
) => invoke<AskResult>("ask_claude", { path, id, question, context, model, session, allowEdits });

/** A file Claude touched: how it was and how it ended up (`null`: didn't exist / was deleted). */
export interface AskChange {
  path: string;
  before: string | null;
  after: string | null;
  /** Can be restored to `before`. Without it (binary, ignored by git), we only know it was touched. */
  undoable: boolean;
}

export interface AskResult {
  answer: string;
  /** Only with edits allowed; empty when it touched nothing. */
  changes: AskChange[];
}

/** Restores the files to what they were before the question; returns the ones it couldn't (changed again since). */
export const undoAsk = (path: string, changes: AskChange[]) => invoke<string[]>("undo_ask", { path, changes });

export const cancelAsk = (id: string) => invoke<void>("cancel_ask", { id });
