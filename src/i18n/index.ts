/// The app's language: the system's. Portuguese for those with Portuguese as the
/// first macOS language; English for everyone else. WebKit delivers the system's
/// list in `navigator.languages` (measured: a macOS in en-AU gives "en-AU"),
/// so there is no need to ask Rust.
///
/// The texts of each part of the app live in a file beside this one, as a
/// `{ pt, en }` pair with the same shape — `en`'s type is `pt`'s, and forgetting a
/// key in one of the languages is a compile error.

export type Idioma = "pt" | "en";

/// Only the first language in the list decides: whoever put English in front wants the app
/// in English, even with Portuguese right behind.
export function idiomaDe(tags: readonly string[]): Idioma {
  return tags[0]?.toLowerCase().startsWith("pt") ? "pt" : "en";
}

const doSistema = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
};

let atual: Idioma = idiomaDe(doSistema());

export const idioma = (): Idioma => atual;

/// For tests: Node doesn't have the macOS language.
export function definirIdioma(i: Idioma) {
  atual = i;
}

/// The locale for dates and numbers: the system's when it is in the same language as the
/// app (en-AU formats as in Australia), otherwise the language's default.
export function localidade(): string {
  const primeiro = doSistema()[0];
  if (primeiro && idiomaDe([primeiro]) === atual) return primeiro;
  return atual === "pt" ? "pt-BR" : "en-US";
}

/// The texts of a part of the app, in the current language. Read at access time,
/// not at module load: that is what lets a test switch the language.
export function traducoes<T extends object>(par: { pt: T; en: T }): T {
  return new Proxy({} as T, {
    get: (_, chave) => (par[atual] as Record<string | symbol, unknown>)[chave],
  });
}
