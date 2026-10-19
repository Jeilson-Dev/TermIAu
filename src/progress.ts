/// The math for a long task's progress in the footer, without DOM — so it can be
/// tested, like `usage.ts`. The plan comes from Claude, through `termiau progress`
/// (see hooks/termiau), already checked by Rust (see progress.rs).

export type PlanStatus = "done" | "doing" | "todo";
export type PlanItem = { name: string; status: PlanStatus };
export type PlanBlock = {
  name: string;
  status: PlanStatus;
  /// Claude's own estimate, only for a block in progress.
  percent?: number;
  /// How big the block is next to the others; 1 when absent.
  weight?: number;
  items?: PlanItem[];
};
export type TaskPlan = { title?: string; blocks: PlanBlock[] };

/// How much of the block is done (0 to 100), and whether that number is a guess. A block in
/// progress counts by Claude's percent when it gave one, else by its finished items.
export function blockProgress(b: PlanBlock): { pct: number; estimated: boolean } {
  if (b.status === "done") return { pct: 100, estimated: false };
  if (b.status === "todo") return { pct: 0, estimated: false };
  if (typeof b.percent === "number") return { pct: b.percent, estimated: true };
  const items = b.items ?? [];
  if (!items.length) return { pct: 0, estimated: false };
  return { pct: (items.filter((i) => i.status === "done").length / items.length) * 100, estimated: false };
}

/// The whole plan: the blocks' average, weighed by size. `estimated` when some block
/// went in by Claude's guess — then the footer says "~".
export function planProgress(p: TaskPlan): { pct: number; estimated: boolean; done: number; total: number } {
  let sum = 0;
  let weights = 0;
  let estimated = false;
  for (const b of p.blocks) {
    const weight = b.weight ?? 1;
    const a = blockProgress(b);
    sum += a.pct * weight;
    weights += weight;
    estimated ||= a.estimated;
  }
  return {
    pct: weights ? Math.round(sum / weights) : 0,
    estimated,
    done: p.blocks.filter((b) => b.status === "done").length,
    total: p.blocks.length,
  };
}
