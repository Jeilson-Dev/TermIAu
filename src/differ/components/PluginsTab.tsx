import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "../../i18n/differ";
import type { Manifest } from "../../plugins/api";
import { ACTIVATION_ERRORS_KEY, pluginFileUrl, type InstalledPlugin } from "../../plugins/manifest";
import { Icon } from "./Icons";
import { Marketplace } from "./Marketplace";
import { PluginIcon, VerifiedBadge } from "./PluginIcon";
import { PluginSettings } from "./PluginSettings";

/// How long "Really remove?" waits for the second click.
const CONFIRM_MS = 3000;

/// The Preferences' Plugins tab: what is installed, turning each one on and off,
/// removing, and installing a `.termiau` package from a file.
///
/// Rust does the work (src-tauri/src/plugins.rs) and tells the main window, which
/// reloads its plugins; this tab only lists again after each action. The errors a
/// plugin hits while activating come from the main window through localStorage —
/// this page is a same-origin iframe, so it reads the key and hears it change.
export function PluginsTab() {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [activationErrors, setActivationErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setPlugins(await invoke<InstalledPlugin[]>("plugins_list").catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    const readErrors = () => {
      try {
        setActivationErrors(JSON.parse(localStorage.getItem(ACTIVATION_ERRORS_KEY) ?? "{}"));
      } catch {
        setActivationErrors({});
      }
    };
    readErrors();
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVATION_ERRORS_KEY) readErrors();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh]);

  // The second click has to come soon: after a while the button goes back to
  // "Remove". `onBlur` alone isn't enough — WebKit doesn't focus a clicked button.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  /// Each action ends listing again, whatever happened: the folder is the truth.
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await action();
      if (done) setMessage({ text: done });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setBusy(false);
      setConfirming(null);
      await refresh();
    }
  };

  const install = (f: File) =>
    run(async () => {
      const data = Array.from(new Uint8Array(await f.arrayBuffer()));
      const m = await invoke<Manifest>("plugins_install", { data });
      return T.pluginsInstalled(m.name, m.version);
    });

  return (
    <div className="plugins-tab">
      <p className="prefs-help plugins-trust">{T.pluginsTrust}</p>

      <div className="plugins-actions">
        <button className="btn primary" onClick={() => setMarketOpen(true)}>
          {T.marketplaceOpen}
        </button>
        <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
          {busy ? T.pluginsInstalling : T.pluginsInstall}
        </button>
        <input
          ref={file}
          type="file"
          accept=".termiau"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared, so picking the same file again (an updated build) fires again.
            e.target.value = "";
            if (f) void install(f);
          }}
        />
        {message && <span className={message.error ? "plugins-message error" : "plugins-message"}>{message.text}</span>}
      </div>

      {plugins === null && (
        <p className="prefs-help plugins-loading">
          <Icon name="refresh" size={13} className="spin" />
          {T.pluginsLoading}
        </p>
      )}
      {plugins?.length === 0 && <p className="prefs-help">{T.pluginsEmpty}</p>}

      {marketOpen && (
        <Marketplace installed={plugins ?? []} onChanged={refresh} onClose={() => setMarketOpen(false)} />
      )}

      <ul className="plugins-list">
        {plugins?.map((p) => {
          const error = p.error ?? (p.enabled ? activationErrors[p.id] : undefined);
          return (
            <li key={p.id} className={p.enabled ? "plugin-row" : "plugin-row disabled"}>
              <PluginIcon src={p.manifest?.icon ? pluginFileUrl(p.id, p.manifest.icon, p.manifest.version) : undefined} />
              <div className="plugin-info">
                <span className="plugin-name">
                  {p.manifest?.name ?? p.id}
                  {p.manifest && <span className="plugin-version">{p.manifest.version}</span>}
                  {p.verified && <VerifiedBadge publisher={p.verified} />}
                </span>
                <span className="plugin-id">{p.id}</span>
                {p.manifest?.description && <span className="plugin-description">{p.manifest.description}</span>}
                {error && (
                  <span className="plugin-error">
                    {T.pluginsBroken}: {error}
                  </span>
                )}
                {p.enabled && p.manifest?.contributes?.configuration?.length ? (
                  <PluginSettings plugin={p.id} settings={p.manifest.contributes.configuration} />
                ) : null}
              </div>
              <div className="plugin-controls">
                {p.manifest && (
                  <label className="plugin-toggle">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={busy}
                      onChange={(e) => void run(() => invoke("plugins_set_enabled", { id: p.id, enabled: e.target.checked }))}
                    />
                    {T.pluginsEnabled}
                  </label>
                )}
                <button
                  className={confirming === p.id ? "btn plugin-remove confirming" : "btn plugin-remove"}
                  disabled={busy}
                  onClick={() =>
                    confirming === p.id ? void run(() => invoke("plugins_remove", { id: p.id })) : setConfirming(p.id)
                  }
                  onBlur={() => setConfirming((c) => (c === p.id ? null : c))}
                >
                  {/* Both labels share one cell, so the button is always as wide as the longer one. */}
                  <span aria-hidden={confirming === p.id}>{T.pluginsRemove}</span>
                  <span aria-hidden={confirming !== p.id}>{T.pluginsConfirmRemove}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
