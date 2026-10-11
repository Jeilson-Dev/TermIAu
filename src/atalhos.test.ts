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
  it("⌘` é a aba do diff, pelo code: no ABNT2 a crase é tecla morta", () => {
    expect(nossoAtalho(tecla("`", "Backquote"))).toBe(true);
    expect(nossoAtalho(tecla("Dead", "Backquote"))).toBe(true);
  });

  it("⌘1 a ⌘9 são as abas de terminal", () => {
    for (let n = 1; n <= 9; n++) expect(nossoAtalho(tecla(String(n), `Digit${n}`))).toBe(true);
    expect(nossoAtalho(tecla("0", "Digit0"))).toBe(false);
  });

  it("sem ⌘ a tecla é do shell", () => {
    expect(nossoAtalho(tecla("`", "Backquote", { metaKey: false }))).toBe(false);
    expect(nossoAtalho(tecla("1", "Digit1", { metaKey: false }))).toBe(false);
    expect(nossoAtalho(tecla("k", "KeyK", { metaKey: false }))).toBe(false);
  });

  it("⌘K limpa a tela", () => {
    expect(nossoAtalho(tecla("k", "KeyK"))).toBe(true);
  });

  it("com ⇧, só ⌘⇧[, ⌘⇧] e ⌘⇧A", () => {
    expect(nossoAtalho(tecla("{", "BracketLeft", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("}", "BracketRight", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("A", "KeyA", { shiftKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("~", "Backquote", { shiftKey: true }))).toBe(false);
    expect(nossoAtalho(tecla("!", "Digit1", { shiftKey: true }))).toBe(false);
  });

  it("com ⌥, só as setas dos painéis", () => {
    expect(nossoAtalho(tecla("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("ArrowDown", "ArrowDown", { altKey: true }))).toBe(true);
    expect(nossoAtalho(tecla("`", "Backquote", { altKey: true }))).toBe(false);
    expect(nossoAtalho(tecla("¡", "Digit1", { altKey: true }))).toBe(false);
  });

  it("⌘T, ⌘W e ⌘D ficam com o menu nativo", () => {
    expect(nossoAtalho(tecla("t", "KeyT"))).toBe(false);
    expect(nossoAtalho(tecla("w", "KeyW"))).toBe(false);
    expect(nossoAtalho(tecla("d", "KeyD"))).toBe(false);
  });
});
