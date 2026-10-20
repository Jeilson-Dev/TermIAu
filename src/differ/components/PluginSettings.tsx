import { useEffect, useState } from "react";
import { language } from "../../i18n";
import type { SettingContribution, SettingValue } from "../../plugins/api";
import { localize, settingStorageKey, settingValue } from "../../plugins/manifest";

/// The settings a plugin declares (`contributes.configuration`), as fields under its
/// row in the Plugins tab. The value goes to localStorage; the main window, where
/// the plugin runs, hears the `storage` event and tells it (see host.ts).
export function PluginSettings({ plugin, settings }: { plugin: string; settings: SettingContribution[] }) {
  const lang = language();
  const read = () =>
    Object.fromEntries(settings.map((s) => [s.key, settingValue(s, localStorage.getItem(settingStorageKey(plugin, s.key)))]));
  const [values, setValues] = useState<Record<string, SettingValue>>(read);

  // Another Preferences window, or the plugin itself, may change them too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith(settingStorageKey(plugin, ""))) setValues(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // `read` only depends on these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, settings]);

  const save = (key: string, value: SettingValue) => {
    try {
      localStorage.setItem(settingStorageKey(plugin, key), JSON.stringify(value));
    } catch {
      return;
    }
    setValues((v) => ({ ...v, [key]: value }));
  };

  return (
    <div className="plugin-settings">
      {settings.map((s) => (
        <label key={s.key} className="plugin-setting">
          {s.type === "boolean" ? (
            <span className="plugin-setting-check">
              <input type="checkbox" checked={values[s.key] === true} onChange={(e) => save(s.key, e.target.checked)} />
              {localize(s.title, lang)}
            </span>
          ) : (
            <>
              <span className="plugin-setting-name">{localize(s.title, lang)}</span>
              <select value={String(values[s.key])} onChange={(e) => save(s.key, e.target.value)}>
                {s.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {localize(o.label, lang)}
                  </option>
                ))}
              </select>
            </>
          )}
          {s.description && <span className="plugin-setting-help">{localize(s.description, lang)}</span>}
        </label>
      ))}
    </div>
  );
}
