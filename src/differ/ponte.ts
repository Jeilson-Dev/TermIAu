// O differ roda dentro de um <iframe>, e o Tauri injeta o IPC no documento de
// cima. Como os dois são da mesma origem (tauri://localhost em produção,
// localhost:1420 no dev), dá para pegar o objeto emprestado do pai: as funções
// são dele, então o `invoke` sai do documento que o Tauri já conhece. Vale para
// tudo que fala com o Rust, inclusive os plugins de diálogo e de store, que
// buscam este mesmo global.

import { nossoAtalho } from "../atalhos";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

if (!window.__TAURI_INTERNALS__ && window.parent !== window) {
  window.__TAURI_INTERNALS__ = window.parent.__TAURI_INTERNALS__;
}

// As teclas apertadas aqui dentro não sobem para o documento de cima, e é lá
// que moram o ⌘`, o ⌘1..⌘9 e o ⌘⇧[ / ⌘⇧]. Sem este reenvio, entrar na aba do diff
// seria entrar num lugar de onde o teclado não sai.
//
// Na fase de captura, e só para as teclas que são do TermIAu: o ⌘C que copia
// uma linha de código continua sendo do differ, e nem é olhado aqui.
window.addEventListener(
  "keydown",
  (e) => {
    if (window.parent === window || !nossoAtalho(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const { key, code, metaKey, shiftKey, altKey } = e;
    window.parent.postMessage({ termiau: { key, code, metaKey, shiftKey, altKey } }, "*");
  },
  true,
);

// O TermIAu manda abrir o repositório do painel de onde o botão de diff foi
// apertado. Sai daqui como evento comum do documento, para o App não precisar
// saber que existe um iframe em volta dele.
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const dado = e.data as {
    termiauRepo?: string;
    termiauPrefs?: boolean;
    termiauMudou?: string;
    termiauVisivel?: boolean;
  } | null;
  if (typeof dado?.termiauRepo === "string") {
    window.dispatchEvent(new CustomEvent("termiau:repo", { detail: dado.termiauRepo }));
  }
  // ⌘, no menu do TermIAu: as preferências são daqui, então é aqui que abrem.
  if (dado?.termiauPrefs) window.dispatchEvent(new Event("termiau:prefs"));
  // Escondida atrás de um terminal, a aba não precisa vigiar nada.
  if (typeof dado?.termiauVisivel === "boolean") {
    window.dispatchEvent(new CustomEvent("termiau:visivel", { detail: dado.termiauVisivel }));
  }
  if (typeof dado?.termiauMudou === "string") {
    window.dispatchEvent(new CustomEvent("termiau:mudou", { detail: dado.termiauMudou }));
  }
});

export {};
