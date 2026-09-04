#!/usr/bin/env bash
# Encaminha um evento do Claude Code para o painel do TermIAu de onde ele veio.
#
# Quem diz de qual painel é o ambiente: o TermIAu põe TERMIAU_PAINEL e
# TERMIAU_SOCK em cada shell que abre, e este hook roda como descendente dele.
# Fora do TermIAu as duas não existem e o hook sai calado — é o que deixa o
# mesmo settings.json servir para o iTerm2, o VS Code e qualquer outro terminal.
set -uo pipefail

[ -n "${TERMIAU_SOCK:-}" ] || exit 0
[ -S "$TERMIAU_SOCK" ] || exit 0

# Lê o payload antes de ir pro segundo plano: em background a entrada padrão
# do hook já teria fechado.
PAYLOAD=$(cat)
[ -n "${PAYLOAD// /}" ] || exit 0

# Devolve na hora. O TermIAu é quem decide o que fazer com o evento, e o hook
# não pode segurar o turno do Claude enquanto isso.
{
  printf '%s' "$PAYLOAD" \
    | jq -c --argjson painel "${TERMIAU_PAINEL:-0}" '. + {painel: $painel}' \
    | nc -U "$TERMIAU_SOCK" -w 1
} >/dev/null 2>&1 &

exit 0
