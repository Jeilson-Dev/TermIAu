// The differ runs inside an <iframe>, and Tauri injects the IPC into the top
// document. Since both share the same origin (tauri://localhost in production,
// localhost:1420 in dev), we can borrow the object from the parent: the functions
// are its own, so `invoke` goes out from the document Tauri already knows. This holds for
// everything that talks to Rust, including the dialog and store plugins, which
// look up this same global.

import { ourShortcut } from "../shortcuts";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

if (!window.__TAURI_INTERNALS__ && window.parent !== window) {
  window.__TAURI_INTERNALS__ = window.parent.__TAURI_INTERNALS__;
}

// Keys pressed in here don't bubble up to the top document, and that is where
// ⌘`, ⌘1..⌘9 and ⌘⇧[ / ⌘⇧] live. Without this forwarding, entering the diff tab
// would be entering a place the keyboard can't leave.
//
// In the capture phase, and only for TermIAu's keys: the ⌘C that copies
// a line of code still belongs to the differ, and isn't even looked at here.
window.addEventListener(
  "keydown",
  (e) => {
    if (window.parent === window || !ourShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const { key, code, metaKey, shiftKey, altKey } = e;
    window.parent.postMessage({ termiau: { key, code, metaKey, shiftKey, altKey } }, "*");
  },
  true,
);

// TermIAu asks to open the repository of the panel whose diff button was
// pressed. It goes out from here as a plain document event, so the App doesn't need
// to know there is an iframe around it.
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const given = e.data as {
    termiauRepo?: string;
    termiauChanged?: string;
    termiauVisible?: boolean;
    termiauLiveSessions?: unknown[];
    termiauRequestDone?: { id: string; error: string | null };
  } | null;
  if (typeof given?.termiauRepo === "string") {
    window.dispatchEvent(new CustomEvent("termiau:repo", { detail: given.termiauRepo }));
  }
  // Hidden behind a terminal, the tab doesn't need to watch anything.
  if (typeof given?.termiauVisible === "boolean") {
    window.dispatchEvent(new CustomEvent("termiau:visible", { detail: given.termiauVisible }));
  }
  // The Claude sessions open in TermIAu's panels, and the answer to a request sent to one of them.
  if (Array.isArray(given?.termiauLiveSessions)) {
    window.dispatchEvent(new CustomEvent("termiau:sessions", { detail: given.termiauLiveSessions }));
  }
  if (given?.termiauRequestDone) {
    window.dispatchEvent(new CustomEvent("termiau:request", { detail: given.termiauRequestDone }));
  }
  if (typeof given?.termiauChanged === "string") {
    window.dispatchEvent(new CustomEvent("termiau:changed", { detail: given.termiauChanged }));
  }
});

export {};
