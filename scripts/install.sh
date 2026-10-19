#!/usr/bin/env bash
# Packages TermIAu and puts it in /Applications. Two channels, one machine:
#
#   ./scripts/install.sh dev    -> "TermIAu Dev.app"  (dev.jeilson.termiau.dev)
#   ./scripts/install.sh prod   -> "TermIAu.app"      (dev.jeilson.termiau)
#
# Both live side by side: a different bundle name and identifier make two
# distinct apps for macOS — separate Dock, microphone permission and preferences
# — and the hooks socket is already one per process (see Config::socket
# in src-tauri/src/lib.rs). You can keep the usual one open and test dev beside
# it, without one stepping on the other.
set -euo pipefail

channel="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

case "$channel" in
  dev)  conf=(--config src-tauri/tauri.dev.conf.json); name="TermIAu Dev" ;;
  prod) conf=();                                      name="TermIAu"     ;;
  *) echo "usage: $0 dev|prod [--run]" >&2; exit 2 ;;
esac

# Only the .app: the .dmg is for handing to someone, and here the handoff is a cp.
npx tauri build "${conf[@]}" --bundles app

source="src-tauri/target/release/bundle/macos/$name.app"
target="/Applications/$name.app"
[ -d "$source" ] || { echo "bundle not found at $source" >&2; exit 1; }

# Close the running version before swapping the binary under it: an app whose .app
# vanished mid-run dies with no explanation at all.
pkill -f "^$target/Contents/MacOS/" 2>/dev/null || true

rm -rf "$target"
cp -R "$source" "$target"
# An unsigned bundle that went through a copy inherits quarantine, and then Gatekeeper
# blocks opening it. Ad-hoc signing: valid on this machine, which is the target.
xattr -cr "$target" 2>/dev/null || true
codesign --force --deep --sign - "$target" >/dev/null 2>&1 || true

echo "installed: $target"
# `--rodar` is the flag's earlier name.
case "${2:-}" in --run | --rodar) open -a "$target" ;; esac
exit 0
