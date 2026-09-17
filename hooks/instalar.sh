#!/usr/bin/env bash
# Liga os hooks do Claude Code ao TermIAu.
#
# O TermIAu só sabe em que pé está cada sessão pelo que chega no socket, e quem
# escreve nele é o `termiau-evento.sh` — que precisa estar registrado no
# settings.json do Claude Code. Sem este passo o app fica de pé, mas as abas
# nunca acendem a bolinha de "esperando".
#
# O script é idempotente: rodar de novo só reescreve o mesmo bloco.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
DESTINO="$CLAUDE_DIR/hooks/termiau-evento.sh"
ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/termiau-evento.sh"

command -v jq >/dev/null || { echo "falta o jq"; exit 1; }
command -v nc >/dev/null || { echo "falta o nc"; exit 1; }

# O hook mora em ~/.claude, não no repo: o repo pode estar num volume externo
# que não está montado quando o Claude Code roda, e um hook que não existe vira
# um erro em cada evento.
mkdir -p "$CLAUDE_DIR/hooks"
cp "$ORIGEM" "$DESTINO"
chmod +x "$DESTINO"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
BACKUP="$SETTINGS.bak-$(date +%s)"
cp "$SETTINGS" "$BACKUP"

# Os quatro eventos que o `receber` do main.ts trata. `SessionEnd` entra porque
# é ele que apaga o estado do painel — sem ele uma aba fica com a bolinha de
# "esperando" de uma sessão que já morreu.
#
# Sem `async`: o hook devolve na hora (manda o JSON pro socket em segundo plano
# e sai), então não há turno do Claude para segurar.
EVENTOS='["UserPromptSubmit","PermissionRequest","Notification","SessionEnd"]'

jq --arg cmd "bash $DESTINO" --argjson eventos "$EVENTOS" '
  # Põe o hook do TermIAu, um por evento, substituindo qualquer registro
  # anterior dele — é o que torna rodar de novo inofensivo.
  reduce $eventos[] as $e (.;
    .hooks[$e] = (((.hooks[$e] // [])
      | map(.hooks |= map(select((.command // "") | contains("termiau-evento") | not)))
      | map(select((.hooks | length) > 0)))
      + [{hooks: [{type: "command", command: $cmd, timeout: 5}]}]))
' "$BACKUP" > "$SETTINGS"

echo "hook instalado em $DESTINO"
echo "settings atualizado (backup em $BACKUP)"
echo
jq '.hooks | to_entries | map({(.key): [.value[].hooks[].command]}) | add' "$SETTINGS"
