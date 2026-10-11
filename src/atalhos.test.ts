import { describe, expect, it } from "vitest";
import { nossoAtalho, type Atalho } from "./atalhos";

const tecla = (key: string, code: string, extra: Partial<Atalho> = {}): Atalho => ({
  key,
  code,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ...extra,
});

describe("nossoAtalho", () => {
  it("⌘` is the diff tab, by code: on ABNT2 the backtick is a dead key", () => {
    expect(nossoAtalho(tecla("`", "Backquote"))).toBe(true);
    expect(nossoAtalho(tecla("Dead", "Backquote"))).toBe(true);
  });

  it("⌘1 to ⌘9 are the terminal tabs", () => {
    for (let n = 1; n <= 9; n++) expect(nossoAtalho(tecla(String(n), `Digit${n}`))).toBe(true);
    expect(nossoAtalho(tecla("0", "Digit0"))).toBe(false);
  });

  it("without ⌘ the key belongs to the shell", () => {
    expect(nossoAtalho(tecla("`", "Backquote", { metaKey: false }))).toBe(false);
    expect(nossoAtalho(tecla("1", "Digit1", { metaKey: false }))).toBe(false);
    expect(nossoAtalho(tecla("k", "KeyK", { metaKey: false }))).toBe(false);
  });

  it("⌘K clears the screen", () => {
    expect(nossoAtalho(tecla("k", "KeyK"))).toBe(true);
  });

  it("with ⇧, only ⌘⇧[, ⌘⇧] and ⌘⇧A", () => {
    expect(nossoAtalho(tecla("{", "BracketLeft", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("}", "BracketRight", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("A", "KeyA", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("~", "Backquote", { shiftKey: true }))).toBe(false);
    expect(nossoAtalho(tecla("!", "Digit1", { shiftKey: true }))).toBe(false);
  });

  it("with ⌥, only the panel arrows", () => {
    expect(nossoAtalho(tecla("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("ArrowDown", "ArrowDown", { altKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("`", "Backquote", { altKey: true }))).toBe(false);
    expect(nossoAtalho(tecla("¡", "Digit1", { altKey: true }))).toBe(false);
  });

  it("⌘T, ⌘W and ⌘D stay with the native menu", () => {
    expect(nossoAtalho(tecla("t", "KeyT"))).toBe(false);
    expect(nossoAtalho(tecla("w", "KeyW"))).toBe(false);
    expect(nossoAtalho(tecla("d", "KeyD"))).toBe(false);
  });
});
