import { describe, expect, it } from "vitest";
import type { FileDiff } from "../types";
import { nextToReview } from "./navigation";

const files = ["a", "b", "c", "d"].map((path) => ({ path }) as FileDiff);
const next = (from: string, viewed: string[]) => nextToReview(files, from, new Set(viewed))?.path ?? null;

describe("nextToReview", () => {
  it("skips files already reviewed", () => {
    expect(next("a", ["b"])).toBe("c");
  });

  it("wraps around to the start of the list", () => {
    expect(next("d", [])).toBe("a");
  });

  it("returns null when everything else is reviewed", () => {
    expect(next("b", ["a", "c", "d"])).toBeNull();
  });
});
