import { useEffect } from "react";
import { T } from "../../i18n/differ";
import { Icon } from "./Icons";

/// The repository changed while the tab was open — commit, rebase, checkout,
/// fetch. Asks instead of reloading on its own: reloading closes the files
/// you opened and loses the place where you were reading, and doing that in the
/// middle of a review is worse than showing a diff from a minute ago.
/// Hidden behind a terminal, the tab doesn't take focus: `autoFocus` would pull
/// the keyboard into the iframe, and the shell that ran git would stop typing.
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
          <strong>{T.diffMudou}</strong>
          <span>{T.diffMudouTexto}</span>
        </div>
        <div className="mudou-botoes">
          <button className="btn" onClick={onDismiss}>
            {T.nao}
          </button>
          <button className="btn primary" onClick={onReload} autoFocus={visivel}>
            {T.simRecarregar}
          </button>
        </div>
      </div>
    </div>
  );
}
