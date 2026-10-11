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

# O app faz esta mesma instalação sozinho (TermIAu ▸ Ligar ao Claude Code…, ver
# `hooks_instalar` no lib.rs). Este script fica para quem está no repositório.

# O hook mora em ~/.claude, não no repo: o repo pode estar num volume externo
# que não está montado quando o Claude Code roda, e um hook que não existe vira
# um erro em cada evento.
mkdir -p "$CLAUDE_DIR/hooks"
cp "$ORIGEM" "$DESTINO"
chmod +x "$DESTINO"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
BACKUP="$SETTINGS.bak-$(date +%s)"
cp "$SETTINGS" "$BACKUP"

# Os cinco eventos que o `receber` do main.ts trata. `SessionEnd` entra porque
# é ele que apaga o estado do painel — sem ele uma aba fica com a bolinha de
# "esperando" de uma sessão que já morreu. `SessionStart` é o que conta qual é a
# sessão assim que o Claude abre: é por ela que a aba é retomada na próxima
# abertura, e sem ele o TermIAu só fica sabendo no primeiro prompt.
#
# O `Stop` é o fim de um turno: é ele que apaga o "trabalhando".
#
# Os três de ferramenta, no Bash, são a foto de antes e de depois de cada
# comando: o diff que o Claude Code não grava quando o comando termina com erro
# (ver `diff_do_bash` no termiau-evento.sh). Os de depois também avisam quando
# uma pergunta do Claude foi respondida no terminal. O `PermissionRequest` tem
# uma hora: numa pergunta, o hook espera a resposta do modo chat.
#
# Sem `async`: o hook devolve na hora (manda o JSON pro socket em segundo plano
# e sai), então não há turno do Claude para segurar.
EVENTOS='["SessionStart","UserPromptSubmit","PermissionRequest","Notification","SessionEnd","Stop","PreToolUse","PostToolUse","PostToolUseFailure"]'

jq --arg cmd "bash $DESTINO" --argjson eventos "$EVENTOS" '
  # Põe o hook do TermIAu, um por evento, substituindo qualquer registro
  # anterior dele — é o que torna rodar de novo inofensivo.
  reduce $eventos[] as $e (.;
    .hooks[$e] = (((.hooks[$e] // [])
      | map(.hooks |= map(select((.command // "") | contains("termiau-evento") | not)))
      | map(select((.hooks | length) > 0)))
      + [{hooks: [{type: "command", command: $cmd,
                   timeout: (if $e == "PermissionRequest" then 3600 else 5 end)}]}
         + (if $e == "PreToolUse" then {matcher: "Bash"}
            elif ($e | test("ToolUse")) then {matcher: "Bash|AskUserQuestion"}
            else {} end)]))
  # A status line passa pelo mesmo hook (o contexto e o uso vão para o app).
  # Uma que não é a nossa fica: quem a pôs ali quis outra coisa.
  | if (.statusLine | type) == "object" and ((.statusLine.command // "") | contains("termiau-evento") | not)
    then . else .statusLine = {type: "command", command: ($cmd + " status"), padding: 0} end
' "$BACKUP" > "$SETTINGS"

echo "hook instalado em $DESTINO"
echo "settings atualizado (backup em $BACKUP)"
echo
jq '.hooks | to_entries | map({(.key): [.value[].hooks[].command]}) | add' "$SETTINGS"
