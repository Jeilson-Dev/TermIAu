// The Claude sessions running in TermIAu's panels. Unlike the stored ones the question
// mentions (and runs in a throwaway copy of), these are alive: a request sent to one goes
// into its panel as if typed there, and it edits the repository while the review goes on.
// The list comes from the Claude Code plugin, through the top document (see the differ's
// lib/plugins.ts).

import { call, useTopic } from "../../../src/differ/lib/plugins";

export interface LiveSession {
  /** The panel it runs in: what the request is addressed to. */
  panel: number;
  session: string;
  /** The folder name, as the panel calls it. */
  name: string;
  /** The panel's title (Claude sets it to what the session is about). */
  title: string;
  /** The folder the session started in. */
  folder: string;
  state: "idle" | "working" | "waiting";
}

const inFrame = window.parent !== window;
const none: LiveSession[] = [];

/** The session is in this repository: started at its root or in a folder inside it. */
const inRepo = (s: LiveSession, root: string) => s.folder === root || s.folder.startsWith(root.replace(/\/$/, "") + "/");

/** The Claude Code plugin publishes them; with it off, there are none. */
export function useLiveSessions(root: string): LiveSession[] {
  const all = useTopic<LiveSession[]>("claude.liveSessions") ?? none;
  return all.filter((s) => inRepo(s, root));
}

/** Sends the text to the session's panel. Resolves with the reason when it couldn't. */
export function sendToSession(panel: number, text: string): Promise<string | null> {
  return call<string | null>("claude.askInSession", { panel, text }).catch((e) => String(e));
}

export function goToPanel(panel: number) {
  if (inFrame) window.parent.postMessage({ termiauGoToPanel: panel }, "*");
}
