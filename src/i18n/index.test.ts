import { afterEach, describe, expect, it } from "vitest";
import { definirIdioma, idioma, idiomaDe, traducoes } from "./index";

const inicial = idioma();
afterEach(() => definirIdioma(inicial));

describe("idiomaDe", () => {
  it("Portuguese first is Portuguese", () => {
    expect(idiomaDe(["pt-BR", "en-US"])).toBe("pt");
    expect(idiomaDe(["pt"])).toBe("pt");
    expect(idiomaDe(["PT-pt"])).toBe("pt");
  });

  it("anything else first is English", () => {
    expect(idiomaDe(["en-AU", "pt-BR"])).toBe("en");
    expect(idiomaDe(["es-ES"])).toBe("en");
    expect(idiomaDe([])).toBe("en");
  });
});

describe("traducoes", () => {
  const pt = { ola: "Olá", abas: (n: number) => (n === 1 ? "1 aba" : `${n} abas`) };
  const en: typeof pt = { ola: "Hello", abas: (n) => (n === 1 ? "1 tab" : `${n} tabs`) };
  const T = traducoes({ pt, en });

  it("reads in the current language, and follows the switch", () => {
    definirIdioma("pt");
    expect(T.ola).toBe("Olá");
    expect(T.abas(2)).toBe("2 abas");
    definirIdioma("en");
    expect(T.ola).toBe("Hello");
    expect(T.abas(1)).toBe("1 tab");
  });
});
