import { useEffect, useRef } from "react";
import { T } from "../../i18n/differ";
import { Trechos } from "./Trechos";
import { Icon } from "./Icons";

type Limites = { atencao: number; perigo: number; autoCompact: boolean; autoCompactEm: number };

/// As preferências do TermIAu, abertas pelo ⌘, do menu.
///
/// O palpite de branch alvo está aqui porque é só o que não pertence a um
/// repositório: o alvo de cada um fica guardado com ele, e escolher à mão no
/// seletor da barra continua valendo mais do que isto. O editor é o do botão
/// "Abrir no editor" do visor de arquivos do terminal. Os limites do contexto
/// são os da pílula na barra de cada painel do terminal.
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

  // Abriu por atalho: o teclado já está aqui, e o cursor tem de estar também.
  // Numa montagem só, e em efeito separado do de baixo de propósito: `onClose`
  // é uma função nova a cada render, então um efeito que dependesse dela
  // refazia isto a cada tecla — a letra digitada virava seleção e a seguinte a
  // substituía, deixando sempre uma letra no campo.
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
      {/* O clique de fora fecha; o de dentro não pode vazar para ele. */}
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

