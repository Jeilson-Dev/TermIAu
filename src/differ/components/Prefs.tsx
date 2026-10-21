import { useEffect, useRef, useState } from "react";
import { T } from "../../i18n/differ";
import * as persist from "../lib/persist";
import type { Settings } from "../lib/persist";
import { PluginsTab } from "./PluginsTab";
import { Snippets } from "./Snippets";
import { Icon } from "./Icons";

/// TermIAu's preferences, opened by the menu's ⌘,.
///
/// The target branch guess is here because it is the only thing that doesn't belong
/// to a repository: each one's target is stored with it, and picking by hand in the
/// bar's selector still outweighs this. The editor is the one for the "Open in
/// editor" button in the terminal's file viewer. The blinking is the waiting panel's
/// orange outline and its tab's dot.
export function Prefs({
  defaultTarget,
  onDefaultTarget,
  editor,
  onEditor,
  blink,
  onBlink,
  onClose,
}: {
  defaultTarget: string;
  onDefaultTarget(branch: string): void;
  editor: string;
  onEditor(command: string): void;
  blink: boolean;
  onBlink(on: boolean): void;
  onClose(): void;
}) {
  const campo = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"termiau" | "plugins">("termiau");

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
    const keyOf = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keyOf);
    return () => window.removeEventListener("keydown", keyOf);
  }, [onClose]);

  return (
    <div className="prefs-background" onMouseDown={onClose}>
      {/* A click outside closes; a click inside must not leak to it. */}
      <div className="prefs" onMouseDown={(e) => e.stopPropagation()}>
        <header className="prefs-top">
          <h2>{T.preferences}</h2>
          <button className="icon-btn" title={T.closeEsc} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <div className="segmented prefs-tabs" role="tablist">
          {(["termiau", "plugins"] as const).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {id === "termiau" ? T.prefsTabTermiau : T.prefsTabPlugins}
            </button>
          ))}
        </div>

        {tab === "plugins" ? (
          <div className="prefs-body">
            <PluginsTab />
          </div>
        ) : (
          <div className="prefs-body">
            <label className="prefs-field">
              <span className="prefs-name">{T.branchDefault}</span>
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
              <span className="prefs-help">{T.branchDefaultHelp}</span>
            </label>

            <label className="prefs-field">
              <span className="prefs-name">{T.editor}</span>
              <input
                type="text"
                value={editor}
                placeholder="VS Code"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => onEditor(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onClose()}
              />
              <span className="prefs-help"><Snippets from={T.editorHelp} /></span>
            </label>

            <div className="prefs-field">
              <span className="prefs-name">{T.attention}</span>
              <label className="prefs-check">
                <input type="checkbox" checked={blink} onChange={(e) => onBlink(e.target.checked)} />
                {T.blinkOnAttention}
              </label>
              <span className="prefs-help">{T.blinkOnAttentionHelp}</span>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

/// The preferences on their own, floating over any tab: the page TermIAu opens with ⌘,
/// in an iframe over the whole window (`differ.html?prefs`). Each change goes to the store
/// over what is there at that moment, one after the other — the differ tab, behind,
/// writes the same preferences. Closing tells TermIAu, which removes the iframe.
export function PrefsFloating() {
  const [s, setS] = useState<Settings | null>(null);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    void persist.loadSettings().then(setS);
  }, []);

  // Drawn, with the styles in: only now does TermIAu show the iframe. Before this the page
  // is blank, and WebKit paints a blank page white.
  const ready = s !== null;
  useEffect(() => {
    if (ready) window.parent.postMessage({ termiauPrefsReady: true }, "*");
  }, [ready]);

  const mudar = (part: Partial<Settings>) => {
    setS((current) => current && { ...current, ...part });
    queue.current = queue.current
      .then(async () => persist.saveSettings({ ...(await persist.loadSettings()), ...part }))
      .catch(() => {});
  };

  if (!s) return null;
  return (
    <Prefs
      defaultTarget={s.defaultTarget}
      onDefaultTarget={(defaultTarget) => mudar({ defaultTarget })}
      editor={s.editor}
      onEditor={(editor) => mudar({ editor })}
      blink={s.blinkOnAttention}
      onBlink={(blinkOnAttention) => mudar({ blinkOnAttention })}
      onClose={() => window.parent.postMessage({ termiauPrefsClosed: true }, "*")}
    />
  );
}
