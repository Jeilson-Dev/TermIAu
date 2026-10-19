/// The app's language: the system's. Portuguese for those with Portuguese as the
/// first macOS language; English for everyone else. WebKit delivers the system's
/// list in `navigator.languages` (measured: a macOS in en-AU gives "en-AU"),
/// so there is no need to ask Rust.
///
/// The texts of each part of the app live in a file beside this one, as a
/// `{ pt, en }` pair with the same shape — `en`'s type is `pt`'s, and forgetting a
/// key in one of the languages is a compile error.

export type Language = "pt" | "en";

/// Only the first language in the list decides: whoever put English in front wants the app
/// in English, even with Portuguese right behind.
export function languageOf(tags: readonly string[]): Language {
  return tags[0]?.toLowerCase().startsWith("pt") ? "pt" : "en";
}

const fromSystem = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
};

let current: Language = languageOf(fromSystem());

export const language = (): Language => current;

/// For tests: Node doesn't have the macOS language.
export function setLanguage(i: Language) {
  current = i;
}

/// The locale for dates and numbers: the system's when it is in the same language as the
/// app (en-AU formats as in Australia), otherwise the language's default.
export function locale(): string {
  const firstOne = fromSystem()[0];
  if (firstOne && languageOf([firstOne]) === current) return firstOne;
  return current === "pt" ? "pt-BR" : "en-US";
}

/// The texts of a part of the app, in the current language. Read at access time,
/// not at module load: that is what lets a test switch the language.
export function translations<T extends object>(pair: { pt: T; en: T }): T {
  return new Proxy({} as T, {
    get: (_, key) => (pair[current] as Record<string | symbol, unknown>)[key],
  });
}
