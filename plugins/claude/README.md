# Claude Code — a TermIAu plugin

TermIAu's link to Claude Code, and the core the other Claude plugins depend on
(`"dependencies": ["termiau.claude"]`). It draws nothing.

- **Claude Code ▸ Connect to Claude Code…** installs the hook (`termiau-event.sh`)
  in `~/.claude` and registers it, with the status line, in Claude Code's
  `settings.json`. At launch an outdated hook is updated quietly.
- It follows each panel's session — state, context, model, effort — from the hook's
  events and status lines, which the app lends only to this plugin, signed by TermIAu
  (`ctx.claude`).
- It gives that to the plugins that show it through `ClaudeApi`
  ([`src/api.ts`](src/api.ts)): `panel(id)`, `onChange`, `onRateLimits` and
  `send(id, command, busy)`, which types a command into the panel's Claude.

Chat mode, questions, the tabs' state, session restore and `termiau progress` still
live in the app.
