import { describe, expect, it, vi } from "vitest";
import type { Bookmark, FileDiff, Hunk, LineKind } from "../types";
import { incrementalBase, mapOldLine, placeBookmarks, touches } from "./fixes";

// Old blob "o" holds l1..l10; new blob "n" is the same with a line added after l8.
vi.mock("./blobs", () => ({
  getBlob: async (_root: string, oid: string) => {
    const old = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    return oid === "n" ? [...old.slice(0, 8), "later", ...old.slice(8)] : old;
  },
}));

function hunk(oldStart: number, oldLines: number, newStart: number, newLines: number, lines: [LineKind, number | null, number | null][]): Hunk {
  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    section: "",
    lines: lines.map(([kind, oldNo, newNo]) => ({ kind, oldNo, newNo, content: "", noNewline: false })),
  };
}

// Old line 4 replaced by two lines; two lines inserted after old line 8.
const HUNKS = [
  hunk(3, 4, 3, 5, [
    ["context", 3, 3],
    ["del", 4, null],
    ["add", null, 4],
    ["add", null, 5],
    ["context", 5, 6],
    ["context", 6, 7],
  ]),
  hunk(8, 0, 10, 2, [
    ["add", null, 10],
    ["add", null, 11],
  ]),
];

describe("mapOldLine", () => {
  it("follows lines through the fixes", () => {
    expect([1, 3, 4, 5, 7, 8, 9].map((n) => mapOldLine(HUNKS, n))).toEqual([1, 3, 4, 6, 8, 9, 12]);
  });
});

describe("touches", () => {
  it("sees deletions and insertions inside the range only", () => {
    expect(touches(HUNKS, 4, 4)).toBe(true);
    expect(touches(HUNKS, 3, 4)).toBe(true);
    expect(touches(HUNKS, 5, 6)).toBe(false);
    expect(touches(HUNKS, 8, 9)).toBe(true);
    expect(touches(HUNKS, 7, 8)).toBe(false);
    expect(touches(HUNKS, 1, 2)).toBe(false);
  });
});

const bookmark = (id: string, over: Partial<Bookmark>): Bookmark => ({
  id,
  path: "a.txt",
  side: "new",
  startLine: 4,
  endLine: 4,
  note: "",
  snapshot: ["l4"],
  fingerprint: "",
  createdAt: 0,
  ...over,
});

describe("incrementalBase", () => {
  const completed = [
    { commit: "c1", at: 2 },
    { commit: "c2", at: 6 },
    { commit: "c3", at: 4 },
  ];

  it("is the last commit reviewed to the end", () => {
    expect(incrementalBase(completed, "head")).toBe("c2");
  });

  it("keeps the previous one while the review just completed is still HEAD", () => {
    expect(incrementalBase(completed, "c2")).toBe("c3");
  });

  it("is null when nothing was reviewed to the end yet", () => {
    expect(incrementalBase([], "head")).toBeNull();
    expect(incrementalBase([{ commit: "head", at: 1 }], "head")).toBeNull();
  });
});

describe("placeBookmarks", () => {
  it("places review notes on the reviewed lines and tells what the fixes did", async () => {
    const file = { path: "a.txt", oldPath: null, oldOid: "o", newOid: "n", hunks: HUNKS } as FileDiff;
    const placed = await placeBookmarks("/repo", { files: [file], headSha: "head", base: "base" }, [
      bookmark("changed", { commit: "base" }),
      bookmark("moved", { commit: "older", startLine: 2, endLine: 2, snapshot: ["l9"] }),
      bookmark("elsewhere", { path: "b.txt", commit: "base" }),
      bookmark("lost", { commit: "older", snapshot: ["gone"] }),
      bookmark("new", { commit: "head", startLine: 5, endLine: 5 }),
      bookmark("later", { commit: "between", startLine: 9, endLine: 9, snapshot: ["later"] }),
    ]);
    expect(placed.get("later")).toEqual({
      status: "unchanged",
      anchor: { side: "new", startLine: 9, endLine: 9 },
      current: { path: "a.txt", startLine: 9, endLine: 9 },
    });

    expect(placed.get("changed")).toEqual({
      status: "changed",
      anchor: { side: "old", startLine: 4, endLine: 4 },
      current: { path: "a.txt", startLine: 4, endLine: 4 },
    });
    expect(placed.get("moved")).toEqual({
      status: "unchanged",
      anchor: { side: "old", startLine: 9, endLine: 9 },
      current: { path: "a.txt", startLine: 12, endLine: 12 },
    });
    expect(placed.get("elsewhere")?.status).toBe("fileUnchanged");
    expect(placed.get("lost")).toEqual({ status: "lost", anchor: null, current: null });
    expect(placed.get("new")?.anchor).toEqual({ side: "new", startLine: 5, endLine: 5 });
  });
});
