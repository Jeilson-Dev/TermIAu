#!/usr/bin/env bash
# Encaminha um evento do Claude Code para o painel do TermIAu de onde ele veio.
#
# Quem diz de qual painel é o ambiente: o TermIAu põe TERMIAU_PAINEL e
# TERMIAU_SOCK em cada shell que abre, e este hook roda como descendente dele.
# Fora do TermIAu as duas não existem e o hook sai calado — é o que deixa o
# mesmo settings.json servir para o iTerm2, o VS Code e qualquer outro terminal.
set -uo pipefail

# ---------- a status line do Claude Code ----------
#
# Registrado também como `statusLine` (com o argumento `status`). O Claude Code
# manda a cada atualização um JSON com o contexto da sessão e os limites de 5h e
# de 7 dias; dentro do TermIAu ele vai para o app — que mostra o contexto na
# barra do painel e o uso no rodapé — e a linha fica vazia, porque o app já
# mostra tudo. Fora dele vale a status line que você tinha, se ainda existir.
if [ "${1:-}" = status ]; then
  if [ -z "${TERMIAU_SOCK:-}" ] || [ ! -S "$TERMIAU_SOCK" ]; then
    ANTIGA="$HOME/.claude/statusline-command.sh"
    [ -f "$ANTIGA" ] && exec bash "$ANTIGA"
    exit 0
  fi
  STATUS=$(cat)
  [ -n "${STATUS// /}" ] || exit 0
  PAINEL="${TERMIAU_PAINEL:-0}"
  case "$PAINEL" in '' | *[!0-9]*) PAINEL=0 ;; esac
  {
    printf '{"painel":%s,"status":%s}' "$PAINEL" "$STATUS" | nc -U "$TERMIAU_SOCK" -w 1
  } >/dev/null 2>&1 &
  exit 0
fi

[ -n "${TERMIAU_SOCK:-}" ] || exit 0
[ -S "$TERMIAU_SOCK" ] || exit 0

# Lê o payload antes de ir pro segundo plano: em background a entrada padrão
# do hook já teria fechado.
PAYLOAD=$(cat)
[ -n "${PAYLOAD// /}" ] || exit 0

# ---------- o diff de um Bash, quando o Claude Code não o grava ----------
#
# Um comando que mexe em arquivo e termina com erro (um `sed -i … && grep` em
# que o grep não acha nada) não deixa diff nenhum no transcript, e o modo chat
# não teria o que mostrar. Então, dentro de um repositório git, este hook tira
# uma foto da pasta antes do Bash (PreToolUse) e outra depois (PostToolUse ou
# PostToolUseFailure); se mudou, o patch vai para ~/.termiau/diffs/<sessão>/
# <tool_use_id>.patch, de onde o Rust o lê quando o transcript não tem o diff.
#
# A foto é um `git write-tree` sobre um index à parte: nem o seu index, nem o
# stash, nem a árvore de trabalho são tocados. Entram também os arquivos fora
# do git (menos os ignorados). O index à parte fica guardado entre um comando e
# outro, e com ele o git só relê o que mudou.

DIFFS="$HOME/.termiau/diffs"

# Um campo de texto do payload, sem `jq`. O Claude Code manda o JSON compacto
# e numa linha só; os campos lidos aqui são ids e um caminho.
campo() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed 's/^"[^"]*":"//; s/"$//'
}

# Imprime a raiz do repositório e o tree da pasta inteira, uma linha cada.
foto() {
  local raiz idx tmp arvore
  raiz=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  mkdir -p "$DIFFS/index" || return 1
  idx="$DIFFS/index/$(printf '%s' "$raiz" | cksum | cut -d' ' -f1)"
  # Uma cópia por chamada: dois Bash em paralelo não disputam o mesmo index.
  tmp="$idx.$$"
  if [ -f "$idx" ]; then
    cp "$idx" "$tmp"
  else
    cp "$(git -C "$raiz" rev-parse --path-format=absolute --git-path index)" "$tmp" 2>/dev/null
  fi
  if GIT_INDEX_FILE="$tmp" git -C "$raiz" add -A . >/dev/null 2>&1 &&
    arvore=$(GIT_INDEX_FILE="$tmp" git -C "$raiz" write-tree 2>/dev/null); then
    mv "$tmp" "$idx"
    printf '%s\n%s\n' "$raiz" "$arvore"
  else
    rm -f "$tmp"
    return 1
  fi
}

diff_do_bash() {
  local evento id sessao cwd antes raiz arvore depois
  evento=$(campo hook_event_name)
  id=$(campo tool_use_id)
  sessao=$(campo session_id)
  cwd=$(campo cwd)
  # Os dois viram nome de arquivo: só o formato que eles têm.
  case "$id$sessao" in '' | *[!A-Za-z0-9_-]*) return ;; esac
  [ -d "$cwd" ] || return
  antes="$DIFFS/antes/$id"
  if [ "$evento" = PreToolUse ]; then
    mkdir -p "$DIFFS/antes" || return
    # As fotos de comandos que nunca terminaram (o Claude foi fechado no meio).
    find "$DIFFS/antes" -type f -mtime +1 -delete 2>/dev/null
    foto "$cwd" >"$antes" || rm -f "$antes"
    return
  fi
  [ -f "$antes" ] || return
  { read -r raiz; read -r arvore; } <"$antes"
  rm -f "$antes"
  depois=$(foto "$raiz" | sed -n 2p)
  [ -n "$depois" ] && [ "$depois" != "$arvore" ] || return
  mkdir -p "$DIFFS/$sessao" || return
  # A primeira linha diz de que pasta são os caminhos do patch. Um comando que
  # gera arquivos aos montes não vira um patch sem fim: 1 MB basta para a tela.
  {
    printf '# raiz %s\n' "$raiz"
    git -C "$raiz" diff --no-color --no-ext-diff --no-renames -U3 "$arvore" "$depois" 2>/dev/null
  } | head -c 1048576 >"$DIFFS/$sessao/$id.patch"
}

PAINEL="${TERMIAU_PAINEL:-0}"
case "$PAINEL" in '' | *[!0-9]*) PAINEL=0 ;; esac

case "$PAYLOAD" in
  # Depois de uma pergunta do Claude: ela foi respondida (no chat ou no
  # terminal) e o cartão do chat sai. Vai para o app como os outros eventos.
  *'"tool_name":"AskUserQuestion"'*) ;;
  *'"hook_event_name":"PreToolUse"'* | *'"hook_event_name":"PostToolUse"'* | *'"hook_event_name":"PostToolUseFailure"'*)
    diff_do_bash
    exit 0
    ;;
esac

# ---------- a pergunta do Claude, respondida pelo modo chat ----------
#
# Num `AskUserQuestion` o hook não devolve na hora: manda a pergunta ao app e
# espera a resposta pela mesma conexão (ver `Pendentes` no lib.rs). O que
# voltar é a saída do hook — a decisão com as respostas, que o Claude Code lê
# como se você tivesse escolhido no terminal. Voltar vazio (o app fechou, ou a
# pergunta foi respondida no terminal antes) é sair calado: aí vale o terminal,
# que mostra a mesma pergunta o tempo todo e responde por conta própria.
case "$PAYLOAD" in
  *'"hook_event_name":"PermissionRequest"'*'"tool_name":"AskUserQuestion"'* | \
    *'"tool_name":"AskUserQuestion"'*'"hook_event_name":"PermissionRequest"'*)
    printf '{"painel":%s,"evento":%s,"espera":true}\n' "$PAINEL" "$PAYLOAD" | nc -U "$TERMIAU_SOCK" 2>/dev/null
    exit 0
    ;;
esac

# ---------- o visor, ensinado ao Claude ----------
#
# No começo da sessão, o que o hook escreve na saída entra no contexto do
# Claude: é assim que ele fica sabendo do `termiau ver` — e só dentro do
# TermIAu, porque fora dele o hook saiu lá no começo.
case "$PAYLOAD" in
  *'"hook_event_name":"SessionStart"'*)
    if [ -x "$HOME/.termiau/bin/termiau" ]; then
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This terminal is TermIAu, which has a file viewer inside the panel itself. When the user asks to see, open or show a file or snippet, or when you point them to a specific line to check, run `~/.termiau/bin/termiau ver <file>[:line[-line]]` (path relative to the current folder or absolute). With `--ref <branch|commit>` it shows the file as it is at that point in git, for example `--ref main`. .md files open rendered. Prefer this over opening external editors (code, open -a, vim, nano). After opening it, cite the line in your answer as usual."}}'
    fi
    ;;
esac

# Devolve na hora. O TermIAu é quem decide o que fazer com o evento, e o hook
# não pode segurar o turno do Claude enquanto isso.
#
# O payload vai embrulhado, e não editado: juntar o número do painel por fora
# dispensa o `jq`, que quem só instalou o app pode não ter. O `nc` vem no macOS.
{
  printf '{"painel":%s,"evento":%s}' "$PAINEL" "$PAYLOAD" \
    | nc -U "$TERMIAU_SOCK" -w 1
} >/dev/null 2>&1 &

exit 0
