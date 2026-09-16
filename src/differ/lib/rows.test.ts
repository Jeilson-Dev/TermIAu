import { describe, expect, it } from "vitest";
import type { FileDiff, FileStatus, Hunk, Line } from "../types";
import { buildRows, fileGaps, intraline, revealLine, splitRows, type ContextSource, type LineRow, type Row } from "./rows";

/** Builds a hunk from lines written like a patch: " ctx", "-old", "+new". */
function hunk(oldStart: number, newStart: number, spec: string[]): Hunk {
  let o = oldStart;
  let n = newStart;
  const lines: Line[] = spec.map((s) => {
    const content = s.slice(1);
    if (s[0] === "+") return { kind: "add", oldNo: null, newNo: n++, content, noNewline: false };
    if (s[0] === "-") return { kind: "del", oldNo: o++, newNo: null, content, noNewline: false };
    return { kind: "context", oldNo: o++, newNo: n++, content, noNewline: false };
  });
  return {
    oldStart,
    oldLines: lines.filter((l) => l.kind !== "add").length,
    newStart,
    newLines: lines.filter((l) => l.kind !== "del").length,
    section: "",
    lines,
  };
}

function file(hunks: Hunk[], status: FileStatus = "modified"): FileDiff {
  return {
    path: "f.ts",
    oldPath: null,
    status,
    similarity: null,
    oldMode: "100644",
    newMode: "100644",
    oldOid: "a",
    newOid: "b",
    binary: false,
    submodule: false,
    additions: 0,
    deletions: 0,
    fingerprint: "x",
    hunks,
  };
}

// New file: 40 lines "n1".."n40". Line 8 changed, "n28" inserted.
const context: ContextSource = { side: "new", lines: Array.from({ length: 40 }, (_, i) => `n${i + 1}`) };
const sample = file([
  hunk(5, 5, [" n5", " n6", " n7", "-o8", "+n8", " n9", " n10", " n11"]),
  hunk(25, 25, [" n25", " n26", " n27", "+n28", " n29", " n30", " n31"]),
]);

const lineRows = (rows: Row[]) => rows.filter((r): r is LineRow => r.type === "line");

describe("fileGaps", () => {
  it("finds the hidden lines before, between and after hunks", () => {
    const gaps = fileGaps(sample, context);
    expect(gaps.map((g) => [g.position, g.oldStart, g.newStart, g.size])).toEqual([
      ["top", 1, 1, 4],
      ["middle", 12, 12, 13],
      ["bottom", 31, 32, 9],
    ]);
  });

  it("doesn't know the trailing gap until the content loads", () => {
    expect(fileGaps(sample, null)[2].size).toBeNull();
  });

  it("has no gaps for added files", () => {
    expect(fileGaps(file([hunk(0, 1, ["+a", "+b"])], "added"), null)).toEqual([]);
  });
});

describe("buildRows", () => {
  it("shows gap rows between hunks when nothing is expanded", () => {
    const rows = buildRows(sample.hunks, fileGaps(sample, context), {}, context);
    expect(rows.map((r) => (r.type === "gap" ? `gap:${r.remaining}` : r.kind))).toEqual([
      "gap:4",
      ...["context", "context", "context", "del", "add", "context", "context", "context"],
      "gap:13",
      ...["context", "context", "context", "add", "context", "context", "context"],
      "gap:9",
    ]);
  });

  it("reveals context from both ends of a gap", () => {
    const rows = buildRows(sample.hunks, fileGaps(sample, context), { 1: { top: 2, bottom: 3 } }, context);
    const expanded = lineRows(rows).filter((r) => r.expanded);
    expect(expanded.map((r) => [r.oldNo, r.newNo, r.content])).toEqual([
      [12, 12, "n12"],
      [13, 13, "n13"],
      [22, 22, "n22"],
      [23, 23, "n23"],
      [24, 24, "n24"],
    ]);
    expect(rows.find((r) => r.type === "gap" && r.index === 1)).toMatchObject({ remaining: 8 });
  });

  it("drops the gap row once fully expanded, keeping old/new numbering apart", () => {
    const rows = buildRows(sample.hunks, fileGaps(sample, context), { 2: { top: 100, bottom: 0 } }, context);
    expect(rows.some((r) => r.type === "gap" && r.index === 2)).toBe(false);
    const tail = lineRows(rows).slice(-9);
    expect(tail[0]).toMatchObject({ oldNo: 31, newNo: 32, content: "n32" });
    expect(tail[8]).toMatchObject({ oldNo: 39, newNo: 40, content: "n40" });
  });

  it("marks the words that changed inside a replaced line", () => {
    const f = file([hunk(1, 1, ["-const a = 1;", "+const a = 2;"])]);
    const [del, add] = lineRows(buildRows(f.hunks, [], {}, null));
    expect(del.emph).toEqual([[10, 11]]);
    expect(add.emph).toEqual([[10, 11]]);
  });
});

describe("splitRows", () => {
  it("pairs removed and added lines side by side", () => {
    const pairs = splitRows(buildRows(sample.hunks, [], {}, null));
    expect(pairs[3]).toMatchObject({ left: { content: "o8" }, right: { content: "n8" } });
    const insertion = pairs.find((p) => p.type === "pair" && p.right?.content === "n28");
    expect(insertion).toMatchObject({ left: null });
    expect(pairs).toHaveLength(7 + 7);
  });
});

describe("revealLine", () => {
  it("expands the gap containing a hidden line", () => {
    expect(revealLine(fileGaps(sample, context), {}, "new", 18)).toEqual({ 1: { top: 10, bottom: 0 } });
  });

  it("does nothing for lines that are already visible", () => {
    expect(revealLine(fileGaps(sample, context), {}, "new", 6)).toBeNull();
  });
});

describe("intraline", () => {
  it("skips lines that were rewritten entirely", () => {
    expect(intraline("abc", "xyz")).toEqual([null, null]);
  });
});
