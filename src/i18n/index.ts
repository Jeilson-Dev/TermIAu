/// O idioma do app: o do sistema. Português para quem tem o português como
/// primeira língua do macOS; inglês para todo o resto. O WebKit entrega a lista
/// do sistema no `navigator.languages` (medido: um macOS em en-AU dá "en-AU"),
/// então não é preciso perguntar ao Rust.
///
/// Os textos de cada parte do app moram num arquivo ao lado deste, como um par
/// `{ pt, en }` com a mesma forma — o tipo do `en` é o do `pt`, e esquecer uma
/// chave numa das línguas é erro de compilação.

export type Idioma = "pt" | "en";

/// Só a primeira língua da lista decide: quem pôs o inglês na frente quer o app
/// em inglês, mesmo com o português logo atrás.
export function idiomaDe(tags: readonly string[]): Idioma {
  return tags[0]?.toLowerCase().startsWith("pt") ? "pt" : "en";
}

const doSistema = (): readonly string[] => {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
};

let atual: Idioma = idiomaDe(doSistema());

export const idioma = (): Idioma => atual;

/// Para os testes: o Node não tem o idioma do macOS.
export function definirIdioma(i: Idioma) {
  atual = i;
}

/// O locale para datas e números: o do sistema quando ele é da mesma língua do
/// app (en-AU formata como na Austrália), senão o padrão da língua.
export function localidade(): string {
  const primeiro = doSistema()[0];
  if (primeiro && idiomaDe([primeiro]) === atual) return primeiro;
  return atual === "pt" ? "pt-BR" : "en-US";
}

/// Os textos de uma parte do app, no idioma de agora. Lidos na hora do acesso,
/// e não na carga do módulo: é o que deixa um teste trocar o idioma.
export function traducoes<T extends object>(par: { pt: T; en: T }): T {
  return new Proxy({} as T, {
    get: (_, chave) => (par[atual] as Record<string | symbol, unknown>)[chave],
  });
}
