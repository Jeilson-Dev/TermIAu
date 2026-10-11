import { useEffect, useRef } from "react";
import { T } from "../../i18n/differ";
import { Trechos } from "./Trechos";
import { Icon } from "./Icons";

type Limites = { atencao: number; perigo: number; autoCompact: boolean; autoCompactEm: number };

/// TermIAu's preferences, opened by the menu's ⌘,.
///
/// The target branch guess is here because it is the only thing that doesn't belong
/// to a repository: each one's target is stored with it, and picking by hand in the
/// bar's selector still outweighs this. The editor is the one for the "Open in
/// editor" button in the terminal's file viewer. The context limits are the
/// ones for the pill on each terminal panel's bar.
export function Prefs({
  defaultTarget,
  onDefaultTarget,
  editor,
  onEditor,
  contexto,
  onContexto,
  onClose,
}: {
  defaultTarget: string;
  onDefaultTarget(branch: string): void;
  editor: string;
  onEditor(comando: string): void;
  contexto: Limites;
  onContexto(limites: Limites): void;
  onClose(): void;
}) {
  const campo = useRef<HTMLInputElement>(null);

  // Opened by shortcut: the keyboard is already here, and the cursor must be too.
  // On mount only, and in an effect separate from the one below on purpose: `onClose`
  // is a new function on every render, so an effect depending on it
  // redid this on every keystroke — the typed letter became a selection and the next
  // one replaced it, always leaving a single letter in the field.
  useEffect(() => {
    campo.current?.focus();
    campo.current?.select();
  }, []);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onClose]);

  return (
    <div className="prefs-fundo" onMouseDown={onClose}>
      {/* A click outside closes; a click inside must not leak to it. */}
      <div className="prefs" onMouseDown={(e) => e.stopPropagation()}>
        <header className="prefs-topo">
          <h2>{T.preferencias}</h2>
          <button className="icon-btn" title={T.fecharEsc} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <label className="prefs-campo">
          <span className="prefs-nome">{T.branchPadrao}</span>
          <input
            ref={campo}
            type="text"
            value={defaultTarget}
            placeholder="main"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onDefaultTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onClose()}
          />
          <span className="prefs-ajuda">{T.branchPadraoAjuda}</span>
        </label>

        <label className="prefs-campo">
          <span className="prefs-nome">{T.editor}</span>
          <input
            type="text"
            value={editor}
            placeholder="VS Code"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onEditor(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onClose()}
          />
          <span className="prefs-ajuda"><Trechos de={T.editorAjuda} /></span>
        </label>

        <div className="prefs-campo">
          <span className="prefs-nome">{T.contextoDaSessao}</span>
          <div className="prefs-limites">
            <label className="prefs-limite">
              <span className="prefs-bolinha atencao" />
              {T.amareloAPartirDe}
              <input
                type="number"
                min={1}
                max={100}
                value={contexto.atencao}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isFinite(n)) onContexto({ ...contexto, atencao: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && onClose()}
              />
              %
            </label>
            <label className="prefs-limite">
              <span className="prefs-bolinha perigo" />
              {T.vermelhoAPartirDe}
              <input
                type="number"
                min={1}
                max={100}
                value={contexto.perigo}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isFinite(n)) onContexto({ ...contexto, perigo: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && onClose()}
              />
              %
            </label>
            <label className="prefs-limite">
              <input
                type="checkbox"
                checked={contexto.autoCompact}
                onChange={(e) => onContexto({ ...contexto, autoCompact: e.target.checked })}
              />
              {T.autoCompactAPartirDe}
              <input
                type="number"
                min={contexto.perigo + 1}
                max={100}
                value={contexto.autoCompactEm}
                disabled={!contexto.autoCompact}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isFinite(n)) onContexto({ ...contexto, autoCompactEm: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && onClose()}
              />
              %
            </label>
          </div>
          <span className="prefs-ajuda"><Trechos de={T.contextoAjuda} /></span>
        </div>
      </div>
    </div>
  );
}

