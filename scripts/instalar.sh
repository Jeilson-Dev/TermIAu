#!/usr/bin/env bash
# Empacota o TermIAu e põe em /Applications. Dois canais, uma máquina:
#
#   ./scripts/instalar.sh dev    -> "TermIAu Dev.app"  (dev.jeilson.termiau.dev)
#   ./scripts/instalar.sh prod   -> "TermIAu.app"      (dev.jeilson.termiau)
#
# Os dois convivem lado a lado: nome de bundle e identificador diferentes são
# dois apps distintos para o macOS — Dock, permissão de microfone e preferências
# separadas — e o socket dos hooks já nasce um por processo (ver Config::socket
# em src-tauri/src/lib.rs). Dá para deixar a de sempre aberta e testar a dev ao
# lado, sem uma pisar na outra.
set -euo pipefail

canal="${1:-}"
raiz="$(cd "$(dirname "$0")/.." && pwd)"
cd "$raiz"

case "$canal" in
  dev)  conf=(--config src-tauri/tauri.dev.conf.json); nome="TermIAu Dev" ;;
  prod) conf=();                                      nome="TermIAu"     ;;
  *) echo "uso: $0 dev|prod [--rodar]" >&2; exit 2 ;;
esac

# Só o .app: o .dmg é para entregar a alguém, e aqui a entrega é um cp.
npx tauri build "${conf[@]}" --bundles app

origem="src-tauri/target/release/bundle/macos/$nome.app"
destino="/Applications/$nome.app"
[ -d "$origem" ] || { echo "não achei o bundle em $origem" >&2; exit 1; }

# Fecha a versão em pé antes de trocar o binário debaixo dela: um app cujo .app
# sumiu no meio da execução morre sem explicação nenhuma.
pkill -f "^$destino/Contents/MacOS/" 2>/dev/null || true

rm -rf "$destino"
cp -R "$origem" "$destino"
# Bundle não assinado que passou por cópia herda quarentena, e aí o Gatekeeper
# barra a abertura. Assinatura ad-hoc: vale nesta máquina, que é o alvo.
xattr -cr "$destino" 2>/dev/null || true
codesign --force --deep --sign - "$destino" >/dev/null 2>&1 || true

echo "instalado: $destino"
[ "${2:-}" = "--rodar" ] && open -a "$destino"
exit 0
