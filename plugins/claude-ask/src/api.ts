// The Claude Code plugin's services the questions use, reached through the top document
// (see the differ's lib/plugins.ts). With that plugin off, they reject.

import { call } from "../../../src/differ/lib/plugins";

/** A Claude Code session of this repository, which a question can mention. */
export interface ClaudeSession {
  id: string;
  title: string;
  /** Last write to the session, in ms since the epoch. */
  modified: number;
}

/** The Claude Code sessions stored for this repository, newest first. */
export const claudeSessions = (path: string) => call<ClaudeSession[]>("claude.sessions", { path });

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
) => call<AskResult>("claude.ask", { path, askId: id, question, context, model, session, allowEdits });

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
export const undoAsk = (path: string, changes: AskChange[]) => call<string[]>("claude.undo", { path, changes });

export const cancelAsk = (id: string) => call<void>("claude.cancel", { askId: id });
