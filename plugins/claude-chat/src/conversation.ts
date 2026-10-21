/// A Claude Code session's conversation, read from its transcript (the JSONL in
/// `~/.claude/projects`), and what the terminal needs to find on screen what
/// you wrote. No DOM or xterm here: that is what makes this testable.

import type { QuestionItem } from "../../claude/src/api";
import { summaryOf } from "../../claude/src/events";
import type { Texts } from "./i18n";

/// One turn of the conversation, in the order it happened.
export type Message =
  | { who: "claude"; text: string }
  /// `images`: the ones you pasted, as data URLs, in the order the text
  /// cites them (`[Image #N]`).
  | { who: "you"; text: string; images?: string[] }
  /// A tool Claude used: the name and one line of what it did.
  | { who: "tool"; name: string; summary: string }
  /// What a tool changed in the files — an Edit, a Write, or a
  /// Bash command that touched a file —, right below it.
  | { who: "diff"; files: FileDiff[] };

/// A changed file and the hunks of the change, as Claude Code stores them.
/// The Claude Code plugin's engine already extracted it from the tool result (see `diff_from_result`).
export type FileDiff = {
  path: string;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
};

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type?: string; media_type?: string; data?: string };
};
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  thinkingDisplay?: string;
  message?: { content?: string | Block[] };
};

/// What Claude Code writes in the user's place: the output of a local
/// command, a system reminder, a task notice, the notice of an interruption.
/// It isn't you speaking.
const NOT_YOU = /^\s*(<(local-command-|system-reminder|task-notification|user-prompt-submit-hook|bash-)|\[Request interrupted)/;
const COMMAND = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGUMENTS = /<command-args>([\s\S]*?)<\/command-args>/;

/// What you typed, taken from what the transcript stores. A `/command` comes
/// wrapped in tags; it goes back to what was typed.
function fromUser(text: string): string | undefined {
  const command = COMMAND.exec(text);
  if (command) return `${command[1].trim()} ${ARGUMENTS.exec(text)?.[1].trim() ?? ""}`.trim();
  if (NOT_YOU.test(text) || text.startsWith("Caveat:")) return undefined;
  return text.trim() || undefined;
}

/// The text of one of your turns without what differs between what you typed and what
/// Claude stores: the pasted-text wrapper, the `[Image #N]`s, the spaces.
const comparable = (text: string) =>
  text
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(IMAGE, "")
    .replace(/\s+/g, " ")
    .trim();

/// How many of the provisional bubbles (each one's text, from oldest to
/// newest) your turn arriving from the transcript resolves. It isn't always the
/// oldest: messages sent while Claude works wait in its queue and
/// may arrive together, in a single turn; and a provisional one that never became a turn
/// (a `!command`, a send that didn't take) must not take another's place and
/// leave the right one duplicated on screen. The provisional ones before the match
/// go along: the transcript is in order, and they won't come anymore.
export function provisionalResolved(pending: string[], message: string): number {
  if (!pending.length) return 0;
  const arrived = comparable(message);
  const exact = pending.findIndex((p) => comparable(p) === arrived);
  if (exact >= 0) return exact + 1;
  let lastOne = -1;
  pending.forEach((p, i) => {
    const t = comparable(p);
    if (t && arrived.includes(t)) lastOne = i;
  });
  // Nothing similar: Claude stored something different from what was typed. The oldest
  // goes, as before.
  return lastOne >= 0 ? lastOne + 1 : 1;
}

/// The turns of a transcript chunk. Each line is a JSON; one that isn't
/// (a cut line, a new format) is skipped, and the conversation goes on.
export function readMessages(jsonl: string): Message[] {
  const messages: Message[] = [];
  for (const bruta of jsonl.split("\n")) {
    if (!bruta.trim()) continue;
    let line: Line & { files?: FileDiff[] };
    try {
      line = JSON.parse(bruta) as Line;
    } catch {
      continue;
    }
    if (line.type === "diff") {
      if (line.files?.length) messages.push({ who: "diff", files: line.files });
      continue;
    }
    // Subagents write to the same file; the conversation is only the main one.
    if (line.isSidechain || line.isMeta) continue;
    const content = line.message?.content;
    if (content === undefined) continue;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;

    if (line.type === "user") {
      // A tool's result comes back as a "user" message.
      if (blocks.some((b) => b.type === "tool_result")) continue;
      const text = blocks
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      const images = blocks.flatMap((b) =>
        b.type === "image" && b.source?.type === "base64" && b.source.data
          ? [`data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`]
          : [],
      );
      // Image only, no text: it is still you speaking.
      const your = fromUser(text) ?? (images.length && !NOT_YOU.test(text) ? "" : undefined);
      if (your !== undefined) messages.push(images.length ? { who: "you", text: your, images } : { who: "you", text: your });
    } else if (line.type === "assistant") {
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) messages.push({ who: "claude", text: b.text });
        // With `thinkingDisplay: "updates"`, what Claude says between tools comes
        // as a thinking block with text; the actual reasoning comes empty.
        else if (b.type === "thinking" && line.thinkingDisplay === "updates" && b.thinking?.trim())
          messages.push({ who: "claude", text: b.thinking });
        else if (b.type === "tool_use") {
          messages.push({ who: "tool", name: b.name ?? "tool", summary: summaryOf(b.input) });
        }
      }
    }
  }
  return messages;
}

// ---------- what you wrote, in parts ----------

/// A piece of your bubble: your text, text you pasted (which Claude
/// Code wraps in `<pasted_content>`), or one of the turn's images.
export type Part =
  | { kind: "text"; text: string }
  | { kind: "pasted"; text: string }
  | { kind: "image"; index: number };

/// The opening and closing tags may come with or without the `id` — the closing one,
/// oddly, repeats the id.
const PASTED = /<pasted_content(?:\s+id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?>/g;
const IMAGE = /\[Image #\d+\]/g;

/// Splits your text into the pieces the bubble draws in different ways. The
/// k-th `[Image #N]` is the turn's k-th image: N is counted across the whole
/// session, not the turn. An image the text doesn't cite goes at the end.
export function partsOfYour(text: string, images: number): Part[] {
  const parts: Part[] = [];
  let usedOnes = 0;
  const withText = (t: string) => {
    let since = 0;
    for (const m of t.matchAll(IMAGE)) {
      if (usedOnes >= images) break;
      const before = t.slice(since, m.index);
      if (before.trim()) parts.push({ kind: "text", text: before.trim() });
      parts.push({ kind: "image", index: usedOnes++ });
      since = m.index + m[0].length;
    }
    const rest = t.slice(since);
    if (rest.trim()) parts.push({ kind: "text", text: rest.trim() });
  };
  let since = 0;
  for (const m of text.matchAll(PASTED)) {
    withText(text.slice(since, m.index));
    parts.push({ kind: "pasted", text: m[1] });
    since = m.index + m[0].length;
  }
  withText(text.slice(since));
  while (usedOnes < images) parts.push({ kind: "image", index: usedOnes++ });
  return parts;
}

// ---------- the diff of an edit ----------

/// A diff line as the terminal shows it: what went out, what came in, the
/// surrounding context, or the `…` between two distant hunks. `num` is the line
/// in the file: the old one for what went out, the new one for the rest.
/// `old`: the number a context line had before, which side by side shows.
export type LineDiff = { kind: "-" | "+" | " " | "…"; text: string; num?: number; old?: number };

/// A diff file's lines, numbered, and how many came in and went out.
export function diffLines(file: FileDiff): { lines: LineDiff[]; more: number; less: number } {
  const lines: LineDiff[] = [];
  let more = 0;
  let less = 0;
  for (const h of file.hunks) {
    if (lines.length) lines.push({ kind: "…", text: "" });
    let oldText = h.oldStart;
    let newOne = h.newStart;
    for (const l of h.lines) {
      // "\ No newline at end of file" isn't a line of the file.
      if (l.startsWith("\\")) continue;
      const kind = l[0] === "+" || l[0] === "-" ? l[0] : " ";
      if (kind === "-") {
        less++;
        lines.push({ kind, text: l.slice(1), num: oldText++ });
      } else {
        if (kind === "+") {
          more++;
          lines.push({ kind, text: l.slice(1), num: newOne++ });
        } else lines.push({ kind, text: l.slice(1), num: newOne++, old: oldText++ });
      }
    }
  }
  return { lines, more, less };
}

/// A side-by-side line: before on the left, after on the right. An empty
/// side is a line that only exists on the other.
export type DiffPair = { jump: true } | { jump?: false; before?: LineDiff; after?: LineDiff };

/// The diff lines in two columns, as the differ shows them: the context on both
/// sides, and each block of removed lines beside the ones that replaced them.
export function sideBySide(lines: LineDiff[]): DiffPair[] {
  const pairs: DiffPair[] = [];
  let exited: LineDiff[] = [];
  let entered: LineDiff[] = [];
  const close = () => {
    for (let i = 0; i < Math.max(exited.length, entered.length); i++) pairs.push({ before: exited[i], after: entered[i] });
    exited = [];
    entered = [];
  };
  for (const l of lines) {
    if (l.kind === "-") {
      // A `-` after a `+` starts another block.
      if (entered.length) close();
      exited.push(l);
    } else if (l.kind === "+") entered.push(l);
    else {
      close();
      if (l.kind === "…") pairs.push({ jump: true });
      else pairs.push({ before: { ...l, num: l.old }, after: l });
    }
  }
  close();
  return pairs;
}

// ---------- the /commands ----------

export type Command = {
  name: string;
  description: string;
  /// Opens a menu or a screen in the terminal (pick a model, resume a session): the
  /// chat has no way to show that, so whoever sends it is taken there.
  interactive?: boolean;
};

/// The commands that come built into Claude Code. Written by hand: it doesn't publish them
/// anywhere readable from outside. Yours (commands, skills, plugins)
/// come from disk, through the Claude Code plugin's engine (`commands_list`).
export const claudeCommands = (T: Texts): Command[] => [
  { name: "clear", description: T.cmdClear },
  { name: "compact", description: T.cmdCompact },
  { name: "init", description: T.cmdInit },
  { name: "review", description: T.cmdReview },
  { name: "code-review", description: T.cmdCodeReview },
  { name: "security-review", description: T.cmdSecurityReview },
  { name: "add-dir", description: T.cmdAddDir },
  { name: "fast", description: T.cmdFast },
  { name: "model", description: T.cmdModel, interactive: true },
  { name: "resume", description: T.cmdResume, interactive: true },
  { name: "rewind", description: T.cmdRewind, interactive: true },
  { name: "context", description: T.cmdContext, interactive: true },
  { name: "usage", description: T.cmdUsage, interactive: true },
  { name: "cost", description: T.cmdCost, interactive: true },
  { name: "status", description: T.cmdStatus, interactive: true },
  { name: "config", description: T.cmdConfig, interactive: true },
  { name: "permissions", description: T.cmdPermissions, interactive: true },
  { name: "memory", description: T.cmdMemory, interactive: true },
  { name: "mcp", description: T.cmdMcp, interactive: true },
  { name: "agents", description: T.cmdAgents, interactive: true },
  { name: "hooks", description: T.cmdHooks, interactive: true },
  { name: "plugin", description: T.cmdPlugin, interactive: true },
  { name: "skills", description: T.cmdSkills, interactive: true },
  { name: "export", description: T.cmdExport, interactive: true },
  { name: "theme", description: T.cmdTheme, interactive: true },
  { name: "doctor", description: T.cmdDoctor, interactive: true },
  { name: "help", description: T.cmdHelp, interactive: true },
  { name: "login", description: T.cmdLogin, interactive: true },
  { name: "exit", description: T.cmdExit },
];

/// The commands matching what was typed after the slash: first the ones
/// starting with it, then the ones containing it. The first of each name
/// wins — a command of yours with a built-in's name is what Claude runs.
export function filterCommands(all: Command[], typed: string): Command[] {
  const q = typed.toLowerCase();
  const seen = new Set<string>();
  const begins: Command[] = [];
  const contains: Command[] = [];
  for (const c of all) {
    const name = c.name.toLowerCase();
    if (seen.has(name)) continue;
    // `plugin:name` is also found by the name alone.
    const short = name.slice(name.lastIndexOf(":") + 1);
    if (name.startsWith(q) || short.startsWith(q)) begins.push(c);
    else if (name.includes(q)) contains.push(c);
    else continue;
    seen.add(name);
  }
  return [...begins, ...contains];
}

// ---------- Claude's questions (AskUserQuestion) ----------

/// What you picked in a question: the checked options and, if you wrote it, the
/// "Other" text.
export type Choice = { labels: string[]; other?: string };

/// The answer text for a question: "Other" stands on its own; with several checked,
/// they go together separated by commas, as the terminal does.
export function choiceText(e: Choice | undefined): string | undefined {
  const other = e?.other?.trim();
  const parts = [...(e?.labels ?? []), ...(other ? [other] : [])];
  return parts.length ? parts.join(", ") : undefined;
}

/// The hook output that answers the questions: the same decision the VS Code
/// extension returns through the SDK — `allow`, with the questions back and the
/// answers keyed by each one's text. `undefined` while any is still
/// unanswered.
export function hookAnswer(questions: QuestionItem[], choices: (Choice | undefined)[]): string | undefined {
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const text = choiceText(choices[i]);
    if (!text) return undefined;
    answers[q.question] = text;
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: questions, answers } },
    },
  });
}
