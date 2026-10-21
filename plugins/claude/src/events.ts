/// What the Claude Code plugin reads out of a hook event's tool input. No DOM here:
/// that is what makes it testable.
import type { QuestionItem } from "./api";

/// The fields in which each tool says what it did, from most readable to least.
const SUMMARIES = ["description", "command", "file_path", "pattern", "query", "url", "prompt", "skill"];

export function summaryOf(input: Record<string, unknown> | undefined): string {
  for (const campo of SUMMARIES) {
    const v = input?.[campo];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}

/// The questions in a `tool_input`, or nothing if it doesn't have the expected shape:
/// then the card doesn't show, and the question stays with the terminal.
export function questionsOf(input: Record<string, unknown> | undefined): QuestionItem[] | undefined {
  const qs = input?.questions;
  if (!Array.isArray(qs) || !qs.length) return undefined;
  const ok = qs.every(
    (q) =>
      typeof q?.question === "string" &&
      Array.isArray(q.options) &&
      q.options.every((o: { label?: unknown }) => typeof o?.label === "string"),
  );
  return ok ? (qs as QuestionItem[]) : undefined;
}
