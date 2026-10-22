import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T } from "../../i18n/differ";
import { compareVersions, pluginFileUrl, type InstalledPlugin } from "../../plugins/manifest";
import { Icon } from "./Icons";
import { PluginIcon, VerifiedBadge } from "./PluginIcon";

/// One plugin in the catalog (see src-tauri/src/marketplace.rs).
type Entry = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  package: string;
  size: number;
  sha256: string;
  /// Set by the app after checking the package's signature (see marketplace.rs).
  verified?: string;
  /// Installed along with it, when missing.
  dependencies?: string[];
};

type State = "install" | "update" | "installed";

function stateOf(entry: Entry, installed: InstalledPlugin | undefined): State {
  const version = installed?.manifest?.version;
  if (!version) return "install";
  return compareVersions(entry.version, version) > 0 ? "update" : "installed";
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/// The Preferences' Marketplace section: the catalog's plugins as cards, with search and
/// install / update. It lists what is installed on its own, to tell install from update.
///
/// Installing goes through Rust, which checks the package against the catalog and
/// tells the main window — the same path as the Plugins section's "Install from file".
export function Marketplace({ onClose }: { onClose(): void }) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const search = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setInstalled(await invoke<InstalledPlugin[]>("plugins_list").catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    invoke<{ plugins: Entry[] }>("marketplace_catalog")
      .then((c) => setEntries(c.plugins))
      .catch((e) => setError(String(e)));
    search.current?.focus();
  }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!entries || !q) return entries ?? [];
    return entries.filter((e) =>
      [e.name, e.id, e.author ?? "", e.description ?? ""].some((s) => s.toLowerCase().includes(q)),
    );
  }, [entries, query]);

  const install = async (e: Entry) => {
    setWorking(e.id);
    setFailures(({ [e.id]: _, ...rest }) => rest);
    try {
      await invoke("marketplace_install", { id: e.id });
    } catch (err) {
      setFailures((f) => ({ ...f, [e.id]: String(err) }));
    } finally {
      await refresh();
      setWorking(null);
    }
  };

  return (
    <>
      <header className="prefs-top market-header">
        <div className="market-title">
          <h2>{T.marketplace}</h2>
          {entries && <span className="market-count">{T.marketplaceCount(entries.length)}</span>}
        </div>
        <input
          ref={search}
          className="market-search"
          type="search"
          placeholder={T.marketplaceSearch}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon-btn" title={T.closeEsc} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="market-body">
        {error && <p className="market-empty error">{error}</p>}
        {entries?.length === 0 && <p className="market-empty">{T.marketplaceEmpty}</p>}
        {entries && entries.length > 0 && shown.length === 0 && (
          <p className="market-empty">{T.marketplaceNoMatch(query.trim())}</p>
        )}

        <div className="market-grid">
          {shown.map((e) => {
            const state = stateOf(
              e,
              installed.find((p) => p.id === e.id),
            );
            const busy = working === e.id;
            return (
              <article key={e.id} className="market-card">
                <div className="market-card-top">
                  <PluginIcon
                    className="market-icon"
                    src={e.icon ? pluginFileUrl("_marketplace", e.icon, e.sha256.slice(0, 12)) : undefined}
                  />
                  <div className="market-card-head">
                    <span className="market-name">
                      {e.name}
                      {e.verified && <VerifiedBadge publisher={e.verified} />}
                    </span>
                    {e.author && <span className="market-author">{T.marketplaceBy(e.author)}</span>}
                    <span className="market-meta">
                      {e.version} · {kb(e.size)}
                    </span>
                  </div>
                </div>
                {e.description && <p className="market-description">{e.description}</p>}
                {!!e.dependencies?.length && (
                  <p className="market-requires">
                    {T.marketplaceRequires(e.dependencies.map((d) => entries?.find((x) => x.id === d)?.name ?? d).join(", "))}
                  </p>
                )}
                {failures[e.id] && <p className="market-failure">{failures[e.id]}</p>}
                <div className="market-card-actions">
                  <button
                    className={state === "installed" ? "btn" : "btn primary"}
                    disabled={state === "installed" || working !== null}
                    onClick={() => void install(e)}
                  >
                    {state === "installed" && <Icon name="check" />}
                    {busy
                      ? T.pluginsInstalling
                      : state === "update"
                        ? T.marketplaceUpdate(e.version)
                        : state === "installed"
                          ? T.marketplaceInstalled
                          : T.marketplaceInstall}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}
