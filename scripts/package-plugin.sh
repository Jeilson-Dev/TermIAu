#!/usr/bin/env bash
# Builds a plugin from plugins/<name>/ and packages it as a .termiau file, the
# format the Plugins tab installs (see src-tauri/src/plugins.rs):
#
#   ./scripts/package-plugin.sh radio   -> dist-plugins/termiau.radio-1.0.0.termiau
#
# A .termiau is a zip with termiau.json at its root, next to the files the
# manifest names (main, style, icon and binaries).
#
# A plugin with native binaries has its Rust crate in plugins/<name>/engine: it is
# built in release, ad-hoc signed for macOS (local, no Apple account) and copied to
# the path the manifest declares. Every package is then signed with the
# publisher key (scripts/sign-plugin.mjs) when there is one; for a plugin with
# binaries the key is required, since the app refuses native code unsigned.
set -euo pipefail

name="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/plugins/$name"

if [[ -z "$name" || ! -f "$dir/termiau.json" ]]; then
  echo "usage: $0 <plugin>   (one of: $(ls "$root/plugins" | tr '\n' ' '))" >&2
  exit 1
fi

cd "$root"
npx vite build --config "$dir/vite.config.ts"

field() { node -e "process.stdout.write(String(require(process.argv[1])[process.argv[2]] ?? ''))" "$dir/termiau.json" "$1"; }
id="$(field id)"
version="$(field version)"
style="$(field style)"
icon="$(field icon)"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$dir/termiau.json" "$stage/"
cp "$dir/dist/$(field main)" "$stage/"
[[ -n "$style" ]] && cp "$dir/$style" "$stage/"
if [[ -n "$icon" ]]; then
  mkdir -p "$stage/$(dirname "$icon")"
  cp "$dir/$icon" "$stage/$icon"
fi

binaries="$(node -e 'for (const p of Object.values(require(process.argv[1]).binaries ?? {})) console.log(p)' "$dir/termiau.json")"
if [[ -n "$binaries" ]]; then
  cargo build --release --quiet --manifest-path "$dir/engine/Cargo.toml" >&2
  while IFS= read -r bin; do
    mkdir -p "$stage/$(dirname "$bin")"
    cp "$dir/engine/target/release/$(basename "$bin")" "$stage/$bin"
    codesign --force --sign - "$stage/$bin" >&2
  done <<< "$binaries"
fi

if ! node "$root/scripts/sign-plugin.mjs" "$stage"; then
  if [[ -n "$binaries" ]]; then
    echo "a plugin with native binaries must be signed" >&2
    exit 1
  fi
  echo "unsigned: $id (JS only, installs without the Verified badge)" >&2
fi

mkdir -p "$root/dist-plugins"
out="$root/dist-plugins/$id-$version.termiau"
rm -f "$out"
(cd "$stage" && zip -qrX "$out" .)
echo "$out"
