#!/usr/bin/env bash
# Forwards a Claude Code event to the TermIAu panel it came from.
#
# The environment says which panel: TermIAu sets TERMIAU_PANEL and
# TERMIAU_SOCK in every shell it opens, and this hook runs as its descendant.
# Outside TermIAu neither exists and the hook exits quietly — that is what lets the
# same settings.json serve iTerm2, VS Code and any other terminal.
set -uo pipefail

# ---------- Claude Code's status line ----------
#
# Also registered as `statusLine` (with the `status` argument). Claude Code
# sends on every update a JSON with the session's context and the 5h and
# 7-day limits; inside TermIAu it goes to the app — which shows the context on the
# panel bar and the usage in the footer — and the line stays empty, because the app already
# shows everything. Outside it, the status line you had applies, if it still exists.
if [ "${1:-}" = status ]; then
  if [ -z "${TERMIAU_SOCK:-}" ] || [ ! -S "$TERMIAU_SOCK" ]; then
    PREVIOUS="$HOME/.claude/statusline-command.sh"
    [ -f "$PREVIOUS" ] && exec bash "$PREVIOUS"
    exit 0
  fi
  STATUS=$(cat)
  [ -n "${STATUS// /}" ] || exit 0
  PANEL="${TERMIAU_PANEL:-0}"
  case "$PANEL" in '' | *[!0-9]*) PANEL=0 ;; esac
  {
    printf '{"panel":%s,"status":%s}' "$PANEL" "$STATUS" | nc -U "$TERMIAU_SOCK" -w 1
  } >/dev/null 2>&1 &
  exit 0
fi

[ -n "${TERMIAU_SOCK:-}" ] || exit 0
[ -S "$TERMIAU_SOCK" ] || exit 0

# Read the payload before going to the background: in background the hook's
# standard input would already have closed.
PAYLOAD=$(cat)
[ -n "${PAYLOAD// /}" ] || exit 0

# ---------- a Bash's diff, when Claude Code doesn't store it ----------
#
# A command that changes a file and ends with an error (a `sed -i … && grep` where
# grep finds nothing) leaves no diff in the transcript, and chat mode
# would have nothing to show. So, inside a git repository, this hook takes
# a snapshot of the folder before the Bash (PreToolUse) and another after (PostToolUse or
# PostToolUseFailure); if it changed, the patch goes to ~/.termiau/diffs/<session>/
# <tool_use_id>.patch, where Rust reads it when the transcript doesn't have the diff.
#
# The snapshot is a `git write-tree` over a separate index: neither your index, nor the
# stash, nor the working tree are touched. Files outside git come in too
# (except ignored ones). The separate index is kept between one command and
# the next, and with it git only rereads what changed.

DIFFS="$HOME/.termiau/diffs"

# A text field of the payload, without `jq`. Claude Code sends the JSON compact
# and on a single line; the fields read here are ids and a path.
field() {
  printf '%s' "$PAYLOAD" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed 's/^"[^"]*":"//; s/"$//'
}

# Prints the repository root and the whole folder's tree, one line each.
snapshot() {
  local root idx tmp tree
  root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  mkdir -p "$DIFFS/index" || return 1
  idx="$DIFFS/index/$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
  # One copy per call: two Bash calls in parallel don't fight over the same index.
  tmp="$idx.$$"
  if [ -f "$idx" ]; then
    cp "$idx" "$tmp"
  else
    cp "$(git -C "$root" rev-parse --path-format=absolute --git-path index)" "$tmp" 2>/dev/null
  fi
  if GIT_INDEX_FILE="$tmp" git -C "$root" add -A . >/dev/null 2>&1 &&
    tree=$(GIT_INDEX_FILE="$tmp" git -C "$root" write-tree 2>/dev/null); then
    mv "$tmp" "$idx"
    printf '%s\n%s\n' "$root" "$tree"
  else
    rm -f "$tmp"
    return 1
  fi
}

diff_of_bash() {
  local event id session cwd before root tree after
  event=$(field hook_event_name)
  id=$(field tool_use_id)
  session=$(field session_id)
  cwd=$(field cwd)
  # Both become file names: only the format they have.
  case "$id$session" in '' | *[!A-Za-z0-9_-]*) return ;; esac
  [ -d "$cwd" ] || return
  before="$DIFFS/before/$id"
  if [ "$event" = PreToolUse ]; then
    mkdir -p "$DIFFS/before" || return
    # Snapshots of commands that never finished (Claude was closed midway).
    find "$DIFFS/before" -type f -mtime +1 -delete 2>/dev/null
    snapshot "$cwd" >"$before" || rm -f "$before"
    return
  fi
  [ -f "$before" ] || return
  { read -r root; read -r tree; } <"$before"
  rm -f "$before"
  after=$(snapshot "$root" | sed -n 2p)
  [ -n "$after" ] && [ "$after" != "$tree" ] || return
  mkdir -p "$DIFFS/$session" || return
  # The first line says which folder the patch's paths are from. A command that
  # generates files by the bunch doesn't become an endless patch: 1 MB is enough for the screen.
  {
    printf '# root %s\n' "$root"
    git -C "$root" diff --no-color --no-ext-diff --no-renames -U3 "$tree" "$after" 2>/dev/null
  } | head -c 1048576 >"$DIFFS/$session/$id.patch"
}

PANEL="${TERMIAU_PANEL:-0}"
case "$PANEL" in '' | *[!0-9]*) PANEL=0 ;; esac

case "$PAYLOAD" in
  # After a Claude question: it was answered (in the chat or in the
  # terminal) and the chat card goes away. It goes to the app like the other events.
  *'"tool_name":"AskUserQuestion"'*) ;;
  *'"hook_event_name":"PreToolUse"'* | *'"hook_event_name":"PostToolUse"'* | *'"hook_event_name":"PostToolUseFailure"'*)
    diff_of_bash
    exit 0
    ;;
esac

# ---------- Claude's question, answered by chat mode ----------
#
# On an `AskUserQuestion` the hook doesn't return right away: it sends the question to the app and
# waits for the answer over the same connection (see `PendingQuestions` in lib.rs). What
# comes back is the hook's output — the decision with the answers, which Claude Code reads
# as if you had chosen in the terminal. Coming back empty (the app closed, or the
# question was answered in the terminal first) means exiting quietly: then the terminal applies,
# which shows the same question all along and answers on its own.
case "$PAYLOAD" in
  *'"hook_event_name":"PermissionRequest"'*'"tool_name":"AskUserQuestion"'* | \
    *'"tool_name":"AskUserQuestion"'*'"hook_event_name":"PermissionRequest"'*)
    printf '{"panel":%s,"event":%s,"wait":true}\n' "$PANEL" "$PAYLOAD" | nc -U "$TERMIAU_SOCK" 2>/dev/null
    exit 0
    ;;
esac

# ---------- the viewer and the progress footer, taught to Claude ----------
#
# At the start of the session, what the hook writes to its output goes into Claude's
# context: that is how it learns about `termiau view` and `termiau progress` — and only
# inside TermIAu, because outside it the hook exited at the very start.
case "$PAYLOAD" in
  *'"hook_event_name":"SessionStart"'*)
    if [ -x "$HOME/.termiau/bin/termiau" ]; then
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This terminal is TermIAu, which has a file viewer inside the panel itself. When the user asks to see, open or show a file or snippet, or when you point them to a specific line to check, run `~/.termiau/bin/termiau view <file>[:line[-line]]` (path relative to the current folder or absolute). With `--ref <branch|commit>` it shows the file as it is at that point in git, for example `--ref main`. .md files open rendered. Prefer this over opening external editors (code, open -a, vim, nano). After opening it, cite the line in your answer as usual.\n\nTermIAu also shows a long task'\''s progress in its footer. When you start a task with several steps (roughly four or more, or one that will take a while), publish a plan and keep it current: run it right after planning, and again every time a block or item starts or finishes. Send the whole plan each time, on stdin; it replaces the previous one:\n~/.termiau/bin/termiau progress <<'\''EOF'\''\n{\"title\":\"FMN-123 rules editor\",\"blocks\":[{\"name\":\"A. DTOs and repository\",\"status\":\"done\"},{\"name\":\"B. Rules editor\",\"status\":\"doing\",\"percent\":30,\"items\":[{\"name\":\"Condition card\",\"status\":\"done\"},{\"name\":\"Group row\",\"status\":\"doing\"},{\"name\":\"Empty state\",\"status\":\"todo\"}]},{\"name\":\"C. Save and discard\",\"status\":\"todo\",\"weight\":2}]}\nEOF\n`status` is done, doing or todo. Blocks are the big steps and `items` (optional) the pieces of the one in progress. Give `percent` (0-100) only to a block in progress and only when you have a real basis for it; without it the block counts by its items. `weight` (default 1) is for blocks much bigger or smaller than the others. Keep names short. When everything is done, send the plan with every block done. If the command answers with an error, fix the plan and send it again. No need to mention these updates in your answer."}}'
    fi
    ;;
esac

# Returns right away. TermIAu decides what to do with the event, and the hook
# must not hold Claude's turn meanwhile.
#
# The payload goes wrapped, not edited: adding the panel number outside
# spares `jq`, which someone who only installed the app may not have. `nc` ships with macOS.
{
  printf '{"panel":%s,"event":%s}' "$PANEL" "$PAYLOAD" \
    | nc -U "$TERMIAU_SOCK" -w 1
} >/dev/null 2>&1 &

exit 0
