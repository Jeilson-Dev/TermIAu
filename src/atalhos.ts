/// Os atalhos que o TermIAu consome na webview, num módulo só — porque quem
/// precisa saber quais são não é só o terminal: a aba presa roda num documento
/// à parte e tem de reconhecer as mesmas teclas para devolvê-las (ver
/// src/differ/ponte.ts). Nada de xterm aqui dentro, senão o bundle do differ
/// arrastaria o terminal junto.

/// O que o teclado precisa entregar. É um objeto, e não o `KeyboardEvent`, para
/// a mesma tecla poder chegar de outro documento, reconstruída.
export type Atalho = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "shiftKey" | "altKey">;

/// O xterm precisa saber quais são para não mandar a tecla pro shell antes de o
/// handler da janela agir.
/// ⌘T, ⌘W, ⌘D e ⌘⇧↩ não entram: são itens de menu, e no macOS o menu fica com a
/// tecla antes de qualquer coisa chegar na página (ver `montar_menu` no Rust).
export function nossoAtalho(e: Atalho): boolean {
  if (!e.metaKey) return false;
  if (e.altKey) return e.code.startsWith("Arrow");
  if (e.shiftKey) {
    return e.code === "BracketLeft" || e.code === "BracketRight" || e.code === "KeyA";
  }
  return e.key === "k" || /^[1-9]$/.test(e.key);
}
