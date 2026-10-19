#!/usr/bin/env bash
# Rebuilds src-tauri/icons/plugin.icns — the Finder icon of .termiau packages —
# from src-tauri/icons/plugin.svg. Needs rsvg-convert (brew install librsvg);
# iconutil comes with macOS. Run it after changing the SVG; the .icns is versioned.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
svg="$root/src-tauri/icons/plugin.svg"
set_dir="$(mktemp -d)/plugin.iconset"
mkdir -p "$set_dir"
trap 'rm -rf "$(dirname "$set_dir")"' EXIT

for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$svg" -o "$set_dir/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) "$svg" -o "$set_dir/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$set_dir" -o "$root/src-tauri/icons/plugin.icns"
echo "$root/src-tauri/icons/plugin.icns"
