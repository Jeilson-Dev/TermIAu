#!/usr/bin/env bash
# Connects Claude Code's hooks to TermIAu.
#
# TermIAu only knows where each session stands from what arrives on the socket,
# and `termiau-event.sh` is what writes to it — it has to be registered in
# Claude Code's settings.json. Without this step the app runs, but the tabs
# never light up the "waiting" dot.
#
# The script is idempotent: running it again only rewrites the same block.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
TARGET="$CLAUDE_DIR/hooks/termiau-event.sh"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/termiau-event.sh"

command -v jq >/dev/null || { echo "jq is missing"; exit 1; }
command -v nc >/dev/null || { echo "nc is missing"; exit 1; }

# The app does this same installation on its own (TermIAu ▸ Connect to Claude Code…,
# see `hooks_install` in lib.rs). This script stays for those working in the repository.

# The hook lives in ~/.claude, not in the repo: the repo may be on an external
# volume that isn't mounted when Claude Code runs, and a hook that doesn't exist
# becomes an error on every event.
mkdir -p "$CLAUDE_DIR/hooks"
cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
BACKUP="$SETTINGS.bak-$(date +%s)"
cp "$SETTINGS" "$BACKUP"

# The events main.ts's `receive` handles. `SessionEnd` is here because it is
# what clears the panel's state — without it a tab keeps the "waiting" dot of a
# session that already died. `SessionStart` is what tells which session it is
# as soon as Claude opens: it is how the tab is resumed on the next launch, and
# without it TermIAu only finds out on the first prompt.
#
# `Stop` is the end of a turn: it is what clears "working".
#
# The three tool events, on Bash, are the snapshot before and after each
# command: the diff Claude Code doesn't store when the command ends with an error
# (see `diff_of_bash` in termiau-event.sh). The after ones also report when
# a Claude question was answered in the terminal. `PermissionRequest` has
# an hour: on a question, the hook waits for chat mode's answer.
#
# No `async`: the hook returns right away (sends the JSON to the socket in the
# background and exits), so there is no Claude turn to hold up.
EVENTS='["SessionStart","UserPromptSubmit","PermissionRequest","Notification","SessionEnd","Stop","PreToolUse","PostToolUse","PostToolUseFailure"]'

jq --arg cmd "bash $TARGET" --argjson events "$EVENTS" '
  # Puts the TermIAu hook, one per event, replacing any previous registration
  # of it — that is what makes running it again harmless. `termiau-evento` is what
  # the script was called before: an install from before the rename is replaced too.
  reduce $events[] as $e (.;
    .hooks[$e] = (((.hooks[$e] // [])
      | map(.hooks |= map(select((.command // "") | test("termiau-event\\.sh|termiau-evento") | not)))
      | map(select((.hooks | length) > 0)))
      + [{hooks: [{type: "command", command: $cmd,
                   timeout: (if $e == "PermissionRequest" then 3600 else 5 end)}]}
         + (if $e == "PreToolUse" then {matcher: "Bash"}
            elif ($e | test("ToolUse")) then {matcher: "Bash|AskUserQuestion"}
            else {} end)]))
  # The status line goes through the same hook (context and usage go to the app).
  # One that is not ours stays: whoever put it there wanted something else.
  | if (.statusLine | type) == "object" and ((.statusLine.command // "") | test("termiau-event\\.sh|termiau-evento") | not)
    then . else .statusLine = {type: "command", command: ($cmd + " status"), padding: 0} end
' "$BACKUP" > "$SETTINGS"

echo "hook installed at $TARGET"
echo "settings updated (backup at $BACKUP)"
echo
jq '.hooks | to_entries | map({(.key): [.value[].hooks[].command]}) | add' "$SETTINGS"
