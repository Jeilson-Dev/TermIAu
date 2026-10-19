import { describe, expect, it } from "vitest";
import { blockProgress, planProgress, type TaskPlan } from "./progress";

describe("progress", () => {
  it("counts a block in progress by its percent, else by its finished items", () => {
    expect(blockProgress({ name: "a", status: "doing", percent: 30, items: [{ name: "x", status: "done" }] })).toEqual({ pct: 30, estimated: true });
    expect(
      blockProgress({
        name: "a",
        status: "doing",
        items: [
          { name: "x", status: "done" },
          { name: "y", status: "doing" },
          { name: "z", status: "todo" },
          { name: "w", status: "done" },
        ],
      }),
    ).toEqual({ pct: 50, estimated: false });
    expect(blockProgress({ name: "a", status: "doing" })).toEqual({ pct: 0, estimated: false });
  });

  it("ignores percent and items on blocks already done or not started", () => {
    expect(blockProgress({ name: "a", status: "done", percent: 10 }).pct).toBe(100);
    expect(blockProgress({ name: "a", status: "todo", items: [{ name: "x", status: "done" }] }).pct).toBe(0);
  });

  it("averages the blocks by weight", () => {
    const plan: TaskPlan = {
      blocks: [
        { name: "A", status: "done" },
        { name: "B", status: "doing", percent: 50 },
        { name: "C", status: "todo", weight: 2 },
      ],
    };
    expect(planProgress(plan)).toEqual({ pct: 38, estimated: true, done: 1, total: 3 });
  });

  it("is exact when no block is a guess", () => {
    const plan: TaskPlan = { blocks: [{ name: "A", status: "done" }, { name: "B", status: "todo" }] };
    expect(planProgress(plan)).toEqual({ pct: 50, estimated: false, done: 1, total: 2 });
  });
});
