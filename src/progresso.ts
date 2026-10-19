/// The math for a long task's progress in the footer, without DOM — so it can be
/// tested, like `uso.ts`. The plan comes from Claude, through `termiau progresso`
/// (see hooks/termiau), already checked by Rust (see progresso.rs).

export type StatusDoPlano = "done" | "doing" | "todo";
export type ItemDoPlano = { name: string; status: StatusDoPlano };
export type BlocoDoPlano = {
  name: string;
  status: StatusDoPlano;
  /// Claude's own estimate, only for a block in progress.
  percent?: number;
  /// How big the block is next to the others; 1 when absent.
  weight?: number;
  items?: ItemDoPlano[];
};
export type PlanoDaTarefa = { title?: string; blocks: BlocoDoPlano[] };

/// How much of the block is done (0 to 100), and whether that number is a guess. A block in
/// progress counts by Claude's percent when it gave one, else by its finished items.
export function andamentoDoBloco(b: BlocoDoPlano): { pct: number; estimado: boolean } {
  if (b.status === "done") return { pct: 100, estimado: false };
  if (b.status === "todo") return { pct: 0, estimado: false };
  if (typeof b.percent === "number") return { pct: b.percent, estimado: true };
  const itens = b.items ?? [];
  if (!itens.length) return { pct: 0, estimado: false };
  return { pct: (itens.filter((i) => i.status === "done").length / itens.length) * 100, estimado: false };
}

/// The whole plan: the blocks' average, weighed by size. `estimado` when some block
/// went in by Claude's guess — then the footer says "~".
export function andamentoDoPlano(p: PlanoDaTarefa): { pct: number; estimado: boolean; feitos: number; total: number } {
  let soma = 0;
  let pesos = 0;
  let estimado = false;
  for (const b of p.blocks) {
    const peso = b.weight ?? 1;
    const a = andamentoDoBloco(b);
    soma += a.pct * peso;
    pesos += peso;
    estimado ||= a.estimado;
  }
  return {
    pct: pesos ? Math.round(soma / pesos) : 0,
    estimado,
    feitos: p.blocks.filter((b) => b.status === "done").length,
    total: p.blocks.length,
  };
}
