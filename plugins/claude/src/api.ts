/// The API the Claude Code plugin gives the plugins that depend on it
/// (`"dependencies": ["termiau.claude"]`). They import only these types; the value
/// comes from `ctx.plugins.api<ClaudeApi>("termiau.claude")`.
import type { Disposable, Panel } from "../../../src/plugins/api";

export const CLAUDE_PLUGIN = "termiau.claude";

export type ClaudeState = "idle" | "working" | "waiting";

/// One of Claude's questions (`AskUserQuestion`), as its tool input has it.
export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
};

/// What is known about the Claude running in a panel.
export type ClaudePanel = {
  panel: Panel;
  /// How the panel is called: its folder's name, not "panel 2".
  name: string;
  state: ClaudeState;
  /// Claude Code's session id.
  session?: string;
  /// The folder the session was born in: `--resume` only finds it from there.
  folder?: string;
  /// The JSONL where Claude Code writes the conversation.
  transcript?: string;
  /// Why Claude stopped to wait, when the hook said.
  notice?: string;
  /// What the wait asks for. `permission`: a yes or no. `terminal`: a menu only the
  /// terminal shows (a question's options, the plan to approve). With nothing, it
  /// just waits for the next message.
  asks?: "permission" | "terminal";
  /// A question the hook is holding open for an answer from outside the terminal.
  question?: { id: string; questions: QuestionItem[] };
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

/// A chunk of a session's transcript (see the engine's `transcript_read`).
export type TranscriptChunk = { text: string; end: number; from_start: boolean; truncated: boolean };

/// A `/command` on disk: the user's, the project's or a plugin's.
export type SlashCommand = { name: string; description: string };

/// A session stored on disk, newest first.
export type SavedSession = { id: string; title: string; modified: number };

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
  /// Opens Claude Code in the panel's shell. False when another program is in front.
  start(id: number): Promise<boolean>;
  /// What you did to the session from outside the terminal: sent a message
  /// (`working`), interrupted it (`idle`).
  setState(id: number, state: ClaudeState): void;
  /// The wait was attended to (you are writing the answer).
  attend(id: number): void;
  /// Answers the permission request through the terminal's keyboard: Enter or esc.
  answerPermission(id: number, yes: boolean): void;
  /// Answers the open question; rejects when the terminal answered first.
  answerQuestion(id: number, answer: string): Promise<void>;
  /// Prompts the hook didn't see go by (a resumed conversation), for the highlight.
  rememberPrompts(id: number, prompts: string[]): void;
  /// Chat mode is on screen in the panel: then looking at it isn't attending to a
  /// permission request or a menu, which the chat shows as buttons.
  setChatOpen(id: number, open: boolean): void;
  /// Who answers ⌘⇧↑/↓ in the panel while chat mode is on screen.
  setMessageNavigator(id: number, go: ((delta: number) => void) | undefined): void;
  /// Claude Code's files, read by the plugin's engine.
  transcript(path: string, since: number): Promise<TranscriptChunk>;
  commands(folder: string | undefined): Promise<SlashCommand[]>;
  sessions(folder: string): Promise<SavedSession[]>;
}
