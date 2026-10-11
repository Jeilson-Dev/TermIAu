#!/usr/bin/env bash
# Packages TermIAu and puts it in /Applications. Two channels, one machine:
#
#   ./scripts/instalar.sh dev    -> "TermIAu Dev.app"  (dev.jeilson.termiau.dev)
#   ./scripts/instalar.sh prod   -> "TermIAu.app"      (dev.jeilson.termiau)
#
# Both live side by side: a different bundle name and identifier make two
# distinct apps for macOS — separate Dock, microphone permission and preferences
# — and the hooks socket is already one per process (see Config::socket
# in src-tauri/src/lib.rs). You can keep the usual one open and test dev beside
# it, without one stepping on the other.
set -euo pipefail

canal="${1:-}"
raiz="$(cd "$(dirname "$0")/.." && pwd)"
cd "$raiz"

case "$canal" in
  dev)  conf=(--config src-tauri/tauri.dev.conf.json); nome="TermIAu Dev" ;;
  prod) conf=();                                      nome="TermIAu"     ;;
  *) echo "usage: $0 dev|prod [--rodar]" >&2; exit 2 ;;
esac

# Only the .app: the .dmg is for handing to someone, and here the handoff is a cp.
npx tauri build "${conf[@]}" --bundles app

origem="src-tauri/target/release/bundle/macos/$nome.app"
destino="/Applications/$nome.app"
[ -d "$origem" ] || { echo "bundle not found at $origem" >&2; exit 1; }

# Close the running version before swapping the binary under it: an app whose .app
# vanished mid-run dies with no explanation at all.
pkill -f "^$destino/Contents/MacOS/" 2>/dev/null || true

rm -rf "$destino"
cp -R "$origem" "$destino"
# An unsigned bundle that went through a copy inherits quarantine, and then Gatekeeper
# blocks opening it. Ad-hoc signing: valid on this machine, which is the target.
xattr -cr "$destino" 2>/dev/null || true
codesign --force --deep --sign - "$destino" >/dev/null 2>&1 || true

echo "installed: $destino"
[ "${2:-}" = "--rodar" ] && open -a "$destino"
exit 0
