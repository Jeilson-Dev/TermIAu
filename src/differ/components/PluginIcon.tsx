import { useEffect, useState } from "react";
import { T } from "../../i18n/differ";
import { Icon } from "./Icons";

/// The icon of a plugin that declares none — the same drawing Finder shows for a
/// .termiau file (src-tauri/icons/plugin.icns).
const DEFAULT_ICON = new URL("../../../src-tauri/icons/plugin.svg", import.meta.url).href;

/// A plugin's icon, or the default one when it has none or it doesn't load. Used by
/// the Plugins tab and the marketplace.
export function PluginIcon({ src, className = "plugin-icon" }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <img
      className={className}
      src={src && !failed ? src : DEFAULT_ICON}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/// Signed by a publisher the app trusts — the only kind of plugin allowed to ship
/// native code (see src-tauri/src/signing.rs).
export function VerifiedBadge({ publisher }: { publisher: string }) {
  return (
    <span className="plugin-verified" title={T.pluginsVerifiedBy(publisher)}>
      <Icon name="check" />
      {T.pluginsVerified}
    </span>
  );
}
