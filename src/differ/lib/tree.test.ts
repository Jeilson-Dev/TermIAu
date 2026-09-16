import { describe, expect, it } from "vitest";
import type { FileDiff } from "../types";
import { buildTree, filterTree, flattenTree, type TreeNode } from "./tree";

const files = ["src/z.ts", "README.md", "src/a/b/d.ts", "src/a/b/c.ts"].map(
  (path) => ({ path }) as FileDiff,
);

const shape = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.type === "file" ? n.name : { [n.name]: shape(n.children) }));

describe("buildTree", () => {
  it("lists folders first and collapses single-folder chains", () => {
    expect(shape(buildTree(files))).toEqual([{ src: [{ "a/b": ["c.ts", "d.ts"] }, "z.ts"] }, "README.md"]);
  });

  it("flattens in the same order the tree shows", () => {
    expect(flattenTree(buildTree(files)).map((f) => f.path)).toEqual([
      "src/a/b/c.ts",
      "src/a/b/d.ts",
      "src/z.ts",
      "README.md",
    ]);
  });

  it("filters files by path, keeping their folders", () => {
    expect(shape(filterTree(buildTree(files), "D.TS"))).toEqual([{ src: [{ "a/b": ["d.ts"] }] }]);
  });
});
