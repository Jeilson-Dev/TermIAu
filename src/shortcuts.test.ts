import { describe, expect, it } from "vitest";
import { ourShortcut, type Shortcut } from "./shortcuts";

const keyOf = (key: string, code: string, extra: Partial<Shortcut> = {}): Shortcut => ({
  key,
  code,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ...extra,
});

describe("ourShortcut", () => {
  it("⌘` is the diff tab, by code: on ABNT2 the backtick is a dead key", () => {
    expect(ourShortcut(keyOf("`", "Backquote"))).toBe(true);
    expect(ourShortcut(keyOf("Dead", "Backquote"))).toBe(true);
  });

  it("⌘1 to ⌘9 are the terminal tabs", () => {
    for (let n = 1; n <= 9; n++) expect(ourShortcut(keyOf(String(n), `Digit${n}`))).toBe(true);
    expect(ourShortcut(keyOf("0", "Digit0"))).toBe(false);
  });

  it("without ⌘ the key belongs to the shell", () => {
    expect(ourShortcut(keyOf("`", "Backquote", { metaKey: false }))).toBe(false);
    expect(ourShortcut(keyOf("1", "Digit1", { metaKey: false }))).toBe(false);
    expect(ourShortcut(keyOf("k", "KeyK", { metaKey: false }))).toBe(false);
  });

  it("⌘K clears the screen", () => {
    expect(ourShortcut(keyOf("k", "KeyK"))).toBe(true);
  });

  it("with ⇧, only ⌘⇧[, ⌘⇧] and ⌘⇧A", () => {
    expect(ourShortcut(keyOf("{", "BracketLeft", { shiftKey: true }))).toBe(true);
    expect(ourShortcut(keyOf("}", "BracketRight", { shiftKey: true }))).toBe(true);
    expect(ourShortcut(keyOf("A", "KeyA", { shiftKey: true }))).toBe(true);
    expect(ourShortcut(keyOf("~", "Backquote", { shiftKey: true }))).toBe(false);
    expect(ourShortcut(keyOf("!", "Digit1", { shiftKey: true }))).toBe(false);
  });

  it("with ⌥, only the panel arrows", () => {
    expect(ourShortcut(keyOf("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe(true);
    expect(ourShortcut(keyOf("ArrowDown", "ArrowDown", { altKey: true }))).toBe(true);
    expect(ourShortcut(keyOf("`", "Backquote", { altKey: true }))).toBe(false);
    expect(ourShortcut(keyOf("¡", "Digit1", { altKey: true }))).toBe(false);
  });

  it("⌘T, ⌘W and ⌘D stay with the native menu", () => {
    expect(ourShortcut(keyOf("t", "KeyT"))).toBe(false);
    expect(ourShortcut(keyOf("w", "KeyW"))).toBe(false);
    expect(ourShortcut(keyOf("d", "KeyD"))).toBe(false);
  });
});
