import { useEffect, useRef } from "react";
import { Icon } from "./Icons";

/// As preferências do diff, abertas pelo ⌘, do menu do TermIAu.
///
/// Só há o palpite de branch alvo aqui porque é só o que não pertence a um
/// repositório: o alvo de cada um fica guardado com ele, e escolher à mão no
/// seletor da barra continua valendo mais do que isto.
export function Prefs({
  defaultTarget,
  onDefaultTarget,
  onClose,
}: {
  defaultTarget: string;
  onDefaultTarget(branch: string): void;
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
          <h2>Preferências</h2>
          <button className="icon-btn" title="Fechar (Esc)" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <label className="prefs-campo">
          <span className="prefs-nome">Branch padrão</span>
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
          <span className="prefs-ajuda">
            Com o que comparar um repositório aberto pela primeira vez. Depois disso vale a última
            branch que você escolheu nele — esta aqui não desfaz escolha feita à mão.
          </span>
        </label>
      </div>
    </div>
  );
}
