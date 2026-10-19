/// The shortcuts TermIAu consumes in the webview, in a single module — because the
/// terminal isn't the only one that needs to know them: the pinned tab runs in a separate
/// document and has to recognize the same keys to hand them back (see
/// src/differ/ponte.ts). No xterm in here, or the differ bundle
/// would drag the terminal along.

/// What the keyboard needs to deliver. It is an object, not the `KeyboardEvent`, so
/// the same key can arrive from another document, rebuilt.
export type Shortcut = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "shiftKey" | "altKey">;

/// xterm needs to know them so it doesn't send the key to the shell before the
/// window handler acts.
/// ⌘T, ⌘W, ⌘D and ⌘⇧↩ aren't here: they are menu items, and on macOS the menu takes the
/// key before anything reaches the page (see `montar_menu` in Rust).
export function ourShortcut(e: Shortcut): boolean {
  if (!e.metaKey) return false;
  if (e.altKey) return e.code.startsWith("Arrow");
  if (e.shiftKey) {
    return e.code === "BracketLeft" || e.code === "BracketRight" || e.code === "KeyA";
  }
  return e.key === "k" || e.code === "Backquote" || /^[1-9]$/.test(e.key);
}
