import { describe, expect, it } from "vitest";
import { andamentoDoBloco, andamentoDoPlano, type PlanoDaTarefa } from "./progresso";

describe("progresso", () => {
  it("counts a block in progress by its percent, else by its finished items", () => {
    expect(andamentoDoBloco({ name: "a", status: "doing", percent: 30, items: [{ name: "x", status: "done" }] })).toEqual({ pct: 30, estimado: true });
    expect(
      andamentoDoBloco({
        name: "a",
        status: "doing",
        items: [
          { name: "x", status: "done" },
          { name: "y", status: "doing" },
          { name: "z", status: "todo" },
          { name: "w", status: "done" },
        ],
      }),
    ).toEqual({ pct: 50, estimado: false });
    expect(andamentoDoBloco({ name: "a", status: "doing" })).toEqual({ pct: 0, estimado: false });
  });

  it("ignores percent and items on blocks already done or not started", () => {
    expect(andamentoDoBloco({ name: "a", status: "done", percent: 10 }).pct).toBe(100);
    expect(andamentoDoBloco({ name: "a", status: "todo", items: [{ name: "x", status: "done" }] }).pct).toBe(0);
  });

  it("averages the blocks by weight", () => {
    const plano: PlanoDaTarefa = {
      blocks: [
        { name: "A", status: "done" },
        { name: "B", status: "doing", percent: 50 },
        { name: "C", status: "todo", weight: 2 },
      ],
    };
    expect(andamentoDoPlano(plano)).toEqual({ pct: 38, estimado: true, feitos: 1, total: 3 });
  });

  it("is exact when no block is a guess", () => {
    const plano: PlanoDaTarefa = { blocks: [{ name: "A", status: "done" }, { name: "B", status: "todo" }] };
    expect(andamentoDoPlano(plano)).toEqual({ pct: 50, estimado: false, feitos: 1, total: 2 });
  });
});
