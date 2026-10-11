import { afterEach, describe, expect, it } from "vitest";
import { definirIdioma, idioma, idiomaDe, traducoes } from "./index";

const inicial = idioma();
afterEach(() => definirIdioma(inicial));

describe("idiomaDe", () => {
  it("português na frente é português", () => {
    expect(idiomaDe(["pt-BR", "en-US"])).toBe("pt");
    expect(idiomaDe(["pt"])).toBe("pt");
    expect(idiomaDe(["PT-pt"])).toBe("pt");
  });

  it("qualquer outra coisa na frente é inglês", () => {
    expect(idiomaDe(["en-AU", "pt-BR"])).toBe("en");
    expect(idiomaDe(["es-ES"])).toBe("en");
    expect(idiomaDe([])).toBe("en");
  });
});

describe("traducoes", () => {
  const pt = { ola: "Olá", abas: (n: number) => (n === 1 ? "1 aba" : `${n} abas`) };
  const en: typeof pt = { ola: "Hello", abas: (n) => (n === 1 ? "1 tab" : `${n} tabs`) };
  const T = traducoes({ pt, en });

  it("lê no idioma de agora, e acompanha a troca", () => {
    definirIdioma("pt");
    expect(T.ola).toBe("Olá");
    expect(T.abas(2)).toBe("2 abas");
    definirIdioma("en");
    expect(T.ola).toBe("Hello");
    expect(T.abas(1)).toBe("1 tab");
  });
});
