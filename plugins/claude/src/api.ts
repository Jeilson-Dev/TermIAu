/// The API the Claude Code plugin gives the plugins that depend on it
/// (`"dependencies": ["termiau.claude"]`). They import only these types; the value
/// comes from `ctx.plugins.api<ClaudeApi>("termiau.claude")`.
import type { Disposable, Panel } from "../../../src/plugins/api";

export const CLAUDE_PLUGIN = "termiau.claude";

export type ClaudeState = "idle" | "working" | "waiting";

/// What is known about the Claude running in a panel.
export type ClaudePanel = {
  panel: Panel;
  state: ClaudeState;
  /// Claude Code's session id.
  session?: string;
  /// How much of the context window is used, in percent. Unknown until the first
  /// status line of the session.
  context?: number;
  /// The model's display name, e.g. "Opus 5.5".
  model?: string;
  /// The effort level, e.g. "high". Gone when the model has none.
  effort?: string;
};

/// The account's usage windows, as the status line sends them: the percentage used
/// and when each renews, in seconds since 1970.
export type RateLimits = {
  five_hour?: { used_percentage?: number; resets_at?: number } | null;
  seven_day?: { used_percentage?: number; resets_at?: number } | null;
};

export interface ClaudeApi {
  /// The panel's Claude, if one is running there.
  panel(id: number): ClaudePanel | undefined;
  /// Fires when a panel's Claude changes — a status line, a hook event — and with
  /// `undefined` when the session ends. Calls back at once for the running ones.
  onChange(handler: (id: number, claude: ClaudePanel | undefined) => void): Disposable;
  /// The account's limits, from whichever panel's status line has them. Calls back
  /// at once with the last ones, if any.
  onRateLimits(handler: (limits: RateLimits) => void): Disposable;
  /// Types a command into the panel's Claude and presses Enter (`/compact`,
  /// `/model opus`). While it is working, shows `busy` on the panel's bar instead.
  send(id: number, command: string, busy: string): void;
}
