/// The context pill's math, without DOM — so it can be tested.

/// "" (below the limits), "attention" or "danger".
export type Level = "" | "attention" | "danger";

/// The session's context limits, the plugin's settings: yellow from the first, red
/// (and the panel outlined, pulsing) from the second.
export type ContextLimits = { attention: number; danger: number; autoCompact: boolean; autoCompactAt: number };
export const CONTEXT_LIMITS: ContextLimits = { attention: 60, danger: 75, autoCompact: false, autoCompactAt: 76 };

const validLimit = (n: number | undefined, fallback: number) =>
  typeof n === "number" && n >= 1 && n <= 100 ? n : fallback;

/// The level of context used. A limit outside 1 to 100 (the field cleared, a
/// half-typed number) gets the default; red beats yellow
/// when the two cross.
export function contextLevel(pct: number, limits: Partial<ContextLimits> = {}): Level {
  const danger = validLimit(limits.danger, CONTEXT_LIMITS.danger);
  const attention = validLimit(limits.attention, CONTEXT_LIMITS.attention);
  if (pct >= danger) return "danger";
  if (pct >= attention) return "attention";
  return "";
}

/// From how much auto-compact fires, or `null` when it is off. The
/// limit must exceed red: one that doesn't gets red plus one.
export function autoCompactLimit(limits: Partial<ContextLimits> = {}): number | null {
  if (!limits.autoCompact) return null;
  const danger = validLimit(limits.danger, CONTEXT_LIMITS.danger);
  const at = validLimit(limits.autoCompactAt, CONTEXT_LIMITS.autoCompactAt);
  return Math.min(100, Math.max(at, danger + 1));
}
