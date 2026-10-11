import { useEffect } from "react";
import { Icon } from "./Icons";

/// O repositório mexeu enquanto a aba estava aberta — commit, rebase, checkout,
/// fetch. Pergunta em vez de recarregar sozinho: recarregar fecha os arquivos
/// que você abriu e desfaz o lugar onde você estava lendo, e fazer isso no meio
/// de uma revisão é pior do que mostrar diff de um minuto atrás.
/// Escondida atrás de um terminal, a aba não pega o foco: o `autoFocus` puxaria
/// o teclado para dentro do iframe, e o shell que rodou o git pararia de digitar.
export function Mudou({ onReload, onDismiss, visivel }: { onReload(): void; onDismiss(): void; visivel: boolean }) {
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
      if (e.key === "Enter") onReload();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onReload, onDismiss]);

  return (
    <div className="mudou-fundo" onMouseDown={onDismiss}>
      <div className="mudou" onMouseDown={(e) => e.stopPropagation()}>
        <Icon name="refresh" />
        <div className="mudou-texto">
          <strong>O diff mudou</strong>
          <span>O repositório recebeu commits desde que esta revisão foi carregada.</span>
        </div>
        <div className="mudou-botoes">
          <button className="btn" onClick={onDismiss}>
            Não
          </button>
          <button className="btn primary" onClick={onReload} autoFocus={visivel}>
            Sim, recarregar
          </button>
        </div>
      </div>
    </div>
  );
}
