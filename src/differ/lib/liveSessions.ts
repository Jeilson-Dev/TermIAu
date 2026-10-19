// The Claude sessions running in TermIAu's panels. Unlike the stored ones the question
// mentions (and runs in a throwaway copy of), these are alive: a request sent to one goes
// into its panel as if typed there, and it edits the repository while the review goes on.
// The list comes from the top document, which is where the panels live.

import { useSyncExternalStore } from "react";
import { T } from "../../i18n/differ";

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
let sessions: LiveSession[] = [];
const listeners = new Set<() => void>();

window.addEventListener("termiau:sessions", (e) => {
  sessions = (e as CustomEvent<LiveSession[]>).detail;
  for (const l of listeners) l();
});

const pending = new Map<string, (error: string | null) => void>();
window.addEventListener("termiau:request", (e) => {
  const { id, error } = (e as CustomEvent<{ id: string; error: string | null }>).detail;
  pending.get(id)?.(error);
  pending.delete(id);
});

function subscribe(l: () => void) {
  listeners.add(l);
  // The first one to look asks for the list; afterwards it arrives on its own whenever it changes.
  if (listeners.size === 1 && inFrame) window.parent.postMessage({ termiauWantsSessions: true }, "*");
  return () => listeners.delete(l);
}

/** The session is in this repository: started at its root or in a folder inside it. */
const inRepo = (s: LiveSession, root: string) => s.folder === root || s.folder.startsWith(root.replace(/\/$/, "") + "/");

export function useLiveSessions(root: string): LiveSession[] {
  const all = useSyncExternalStore(subscribe, () => sessions);
  return all.filter((s) => inRepo(s, root));
}

/** Sends the text to the session's panel. Resolves with the reason when it couldn't. */
export function sendToSession(panel: number, text: string): Promise<string | null> {
  if (!inFrame) return Promise.resolve(T.onlyInsideTermiau);
  const id = `${panel}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    window.parent.postMessage({ termiauAskInSession: { id, panel, text } }, "*");
  });
}

export function goToPanel(panel: number) {
  if (inFrame) window.parent.postMessage({ termiauGoToPanel: panel }, "*");
}
