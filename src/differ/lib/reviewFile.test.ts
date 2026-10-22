import { describe, expect, it } from "vitest";
import type { Bookmark, ReviewDiff } from "../types";
import { mergeComments, readReviewFile, reviewFile, reviewFileName } from "./reviewFile";

const comment = (n: number, extra: Partial<Bookmark> = {}): Bookmark => ({
  id: `c${n}`,
  path: "lib/main.dart",
  side: "new",
  startLine: n,
  endLine: n + 1,
  note: `note ${n}`,
  snapshot: ["a", "b"],
  fingerprint: "f",
  createdAt: 1,
  ...extra,
});

const diff = { branch: "feature/x", target: "main", headSha: "abcdef1234" } as ReviewDiff;

describe("review file", () => {
  it("round-trips the comments", () => {
    const file = reviewFile("app", diff, [comment(1), comment(5, { resolved: true, quote: "x" })]);
    expect(readReviewFile(JSON.stringify(file))).toEqual(file.comments);
  });

  it("names the file after repository, branch and day", () => {
    const file = reviewFile("app", diff, [], new Date("2026-10-21T12:00:00Z"));
    expect(reviewFileName(file)).toBe("app-feature-x-review-2026-10-21.json");
  });

  it("refuses what isn't an exported review", () => {
    expect(() => readReviewFile("nope")).toThrow();
    expect(() => readReviewFile(JSON.stringify({ comments: [] }))).toThrow();
  });

  it("drops comments that can't be placed", () => {
    const file = reviewFile("app", diff, [comment(1)]);
    const broken = { ...file, comments: [...file.comments, { path: "x", side: "new", startLine: 0, endLine: 1, note: "" }] };
    expect(readReviewFile(JSON.stringify(broken))).toHaveLength(1);
  });
});

describe("mergeComments", () => {
  it("adds only what isn't there yet", () => {
    const { bookmarks, added } = mergeComments([comment(1)], [comment(1), comment(1, { id: "other" }), comment(2)]);
    expect(added).toBe(1);
    expect(bookmarks.map((b) => b.id)).toEqual(["c1", "c2"]);
  });
});
