// What the plugins offer the diff tab, through the top document: services it calls by
// name (the Claude Code plugin's `claude.ask`, `claude.sessions`…) and topics it is told
// (`claude.liveSessions`). With the plugin off, a call rejects.

import { useSyncExternalStore } from "react";
import { T } from "../../i18n/differ";

const inFrame = typeof window !== "undefined" && window.parent !== window;
const topics = new Map<string, unknown>();
const listeners = new Set<() => void>();
/// Rejections carry the plugin's message as is, like `invoke`'s: it is ready to show.
const pending = new Map<string, { resolve(v: unknown): void; reject(e: string): void }>();

const changed = () => {
  for (const l of listeners) l();
};

// Outside a browser (the tests that import the API) there is no window to listen on.
if (typeof window !== "undefined") {
  window.addEventListener("termiau:topic", (e) => {
    const { topic, value } = (e as CustomEvent<{ topic: string; value: unknown }>).detail;
    topics.set(topic, value);
    changed();
  });

  window.addEventListener("termiau:reply", (e) => {
    const { id, value, error } = (e as CustomEvent<{ id: string; value?: unknown; error?: string }>).detail;
    const p = pending.get(id);
    pending.delete(id);
    if (error !== undefined) p?.reject(error);
    else p?.resolve(value);
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  // The first one to look asks for what there is; afterwards it arrives on its own.
  if (listeners.size === 1 && inFrame) window.parent.postMessage({ termiauWantsTopics: true }, "*");
  return () => listeners.delete(l);
}

/** A topic's last value, `undefined` until a plugin publishes it. */
export function useTopic<T>(topic: string): T | undefined {
  return useSyncExternalStore(subscribe, () => topics.get(topic) as T | undefined);
}

/** Calls the plugin serving `name`. Rejects with its error, or when no plugin serves it. */
export function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!inFrame) return Promise.reject(T.onlyInsideTermiau);
  const id = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ termiauCall: { id, name, args } }, "*");
  });
}
