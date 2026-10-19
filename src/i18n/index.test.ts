import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, language, languageOf, translations } from "./index";

const initial = language();
afterEach(() => setLanguage(initial));

describe("languageOf", () => {
  it("Portuguese first is Portuguese", () => {
    expect(languageOf(["pt-BR", "en-US"])).toBe("pt");
    expect(languageOf(["pt"])).toBe("pt");
    expect(languageOf(["PT-pt"])).toBe("pt");
  });

  it("anything else first is English", () => {
    expect(languageOf(["en-AU", "pt-BR"])).toBe("en");
    expect(languageOf(["es-ES"])).toBe("en");
    expect(languageOf([])).toBe("en");
  });
});

describe("translations", () => {
  const pt = { ola: "Olá", tabs: (n: number) => (n === 1 ? "1 aba" : `${n} abas`) };
  const en: typeof pt = { ola: "Hello", tabs: (n) => (n === 1 ? "1 tab" : `${n} tabs`) };
  const T = translations({ pt, en });

  it("reads in the current language, and follows the switch", () => {
    setLanguage("pt");
    expect(T.ola).toBe("Olá");
    expect(T.tabs(2)).toBe("2 abas");
    setLanguage("en");
    expect(T.ola).toBe("Hello");
    expect(T.tabs(1)).toBe("1 tab");
  });
});
