import { useEffect } from "react";
import { T } from "../../i18n/differ";
import { Icon } from "./Icons";

/// The repository changed while the tab was open — commit, rebase, checkout,
/// fetch. Asks instead of reloading on its own: reloading closes the files
/// you opened and loses the place where you were reading, and doing that in the
/// middle of a review is worse than showing a diff from a minute ago.
/// Hidden behind a terminal, the tab doesn't take focus: `autoFocus` would pull
/// the keyboard into the iframe, and the shell that ran git would stop typing.
export function Changed({ onReload, onDismiss, visible }: { onReload(): void; onDismiss(): void; visible: boolean }) {
  useEffect(() => {
    const keyOf = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
      if (e.key === "Enter") onReload();
    };
    window.addEventListener("keydown", keyOf);
    return () => window.removeEventListener("keydown", keyOf);
  }, [onReload, onDismiss]);

  return (
    <div className="changed-background" onMouseDown={onDismiss}>
      <div className="changed" onMouseDown={(e) => e.stopPropagation()}>
        <Icon name="refresh" />
        <div className="changed-text">
          <strong>{T.diffChanged}</strong>
          <span>{T.diffChangedText}</span>
        </div>
        <div className="changed-buttons">
          <button className="btn" onClick={onDismiss}>
            {T.not}
          </button>
          <button className="btn primary" onClick={onReload} autoFocus={visible}>
            {T.yesReload}
          </button>
        </div>
      </div>
    </div>
  );
}
