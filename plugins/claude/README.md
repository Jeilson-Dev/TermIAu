# Claude Code — a TermIAu plugin

TermIAu's link to Claude Code, and the core the other Claude plugins depend on
(`"dependencies": ["termiau.claude"]`). Everything Claude-specific lives here and in
those plugins; the app only offers generic surfaces (panel status, layers, saved
panel data, the diff tab's services) and the socket the hook writes to.

- **The hook.** **Claude Code ▸ Connect to Claude Code…** installs
  [`hook/termiau-event.sh`](hook/termiau-event.sh) in `~/.claude/hooks` and registers
  it, with the status line, in Claude Code's `settings.json` (a backup goes beside
  it). At launch an outdated hook is updated quietly. The hook is also what tells each new
  session about `termiau view` and `termiau progress`, the app's tools (the
  `SessionStart` context). [`hook/install.sh`](hook/install.sh) does the same from a
  checkout of the repository.
- **The sessions.** It follows each panel's session — idle, working, waiting for
  you; context, model, effort — from the hook's events and status lines, which reach
  it through the app's socket (`ctx.socket`). The state becomes
  the panel's status: the app draws the tab's dot, the waiting outline (blinking
  unless Preferences turned it off), the Dock badge and ⌘⇧A from it.
- **Resume.** The session is saved with the panel and resumed (`claude --resume`)
  when the tabs come back.
- **Your prompts** are highlighted in the terminal; **⌘⇧↑ / ⌘⇧↓** jump between them.
- **The diff tab** (through Claude in the Diff, `termiau.claude-ask`) sees the live
  sessions and sends requests to them, and asks
  Claude about a passage (`claude -p`) through the plugin's services.
- **The engine** ([`engine/`](engine/src/main.rs)) is the plugin's native binary:
  installing the hook, reading transcripts and the `/commands` on disk, the stored
  sessions and `claude -p`.

Other plugins use it through `ClaudeApi` ([`src/api.ts`](src/api.ts)).
