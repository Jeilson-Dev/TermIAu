/// The math for Claude's usage in the footer, without DOM — so it can be tested. The
/// numbers come from Claude Code's status line, through the Claude Code plugin
/// (`ClaudeApi.onRateLimits`).
import type { RateLimits } from "../../claude/src/api";

export type UsageWindow = { usage: number; renews: string | null };
export type Usage = { session: UsageWindow | null; week: UsageWindow | null };

/// "" (on pace), "attention" or "danger".
export type Level = "" | "attention" | "danger";

/// The session window: 5 hours. The week's: 7 days.
export const SESSION_MIN = 300;
export const WEEK_MIN = 7 * 24 * 60;

/// How much of the window is still left (0 to 1). Without a date, the window is whole.
export function remainingFraction(renews: string | null, windowMin: number, now = Date.now()): number {
  if (!renews) return 1;
  const ms = new Date(renews).getTime() - now;
  if (Number.isNaN(ms)) return 1;
  return Math.min(1, Math.max(0, ms / (windowMin * 60_000)));
}

/// The danger is being ahead of pace, not the usage itself: spent more than the
/// time that passed, and it will run out before renewing. Below half there is still
/// plenty of slack, and it stays on pace. It is Claude Usage Monitor's math.
export function paceLevel(usage: number, remaining: number): Level {
  if (usage < 50) return "";
  const deficit = usage / 100 - (1 - remaining);
  if (deficit >= 0.3) return "danger";
  if (deficit >= 0.15) return "attention";
  return "";
}

/// Without a pace window (the week), the level is the usage's.
export function usageLevel(usage: number): Level {
  if (usage >= 90) return "danger";
  if (usage >= 75) return "attention";
  return "";
}

/// "1h53", "42min", "3d4h": how long until it renews, short enough to fit in the footer.
/// `nowText` is what an already renewed window says.
export function missingFor(renews: string | null, nowText: string, now = Date.now()): string {
  if (!renews) return "";
  const ms = new Date(renews).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return nowText;
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${String(min % 60).padStart(2, "0")}`;
  return `${min}min`;
}

/// The part of Claude Code's status line with the limits: the percentage used
/// of each window and when it renews, in seconds since 1970.
export type StatusLineLimits = RateLimits;

function statusLineWindow(j: { used_percentage?: number; resets_at?: number } | null | undefined): UsageWindow | null {
  if (!j || typeof j.used_percentage !== "number") return null;
  return {
    usage: j.used_percentage,
    renews: typeof j.resets_at === "number" ? new Date(j.resets_at * 1000).toISOString() : null,
  };
}

/// Usage from the status line's limits. With neither of them (an account
/// without a plan, a Claude Code version that doesn't send them), nothing.
export function statusLineUsage(l: StatusLineLimits | null | undefined): Usage | undefined {
  const session = statusLineWindow(l?.five_hour);
  const week = statusLineWindow(l?.seven_day);
  return session || week ? { session, week } : undefined;
}

/// The window as it is now. The status line only speaks when Claude runs; a
/// window that renewed since the last news is at zero, and the next one only
/// starts counting on the next use.
export function windowNow(j: UsageWindow | null, now = Date.now()): UsageWindow | null {
  if (!j?.renews) return j;
  return new Date(j.renews).getTime() <= now ? { usage: 0, renews: null } : j;
}
