import { describe, expect, it } from "vitest";
import { bookmarkReference } from "./bookmarks";

const base = {
  path: "packages/app/lib/main.dart",
  side: "new" as const,
  startLine: 12,
  endLine: 35,
  note: "poderia trocar esses if/else por um switch/case?",
};

describe("bookmarkReference", () => {
  it("formats a line range with the comment", () => {
    expect(bookmarkReference(base)).toBe(
      "packages/app/lib/main.dart:12-35\ncomment:\npoderia trocar esses if/else por um switch/case?",
    );
  });

  it("uses a single number for a single line", () => {
    expect(bookmarkReference({ ...base, endLine: 12 })).toMatch(/^packages\/app\/lib\/main\.dart:12\n/);
  });

  it("includes the selected passage", () => {
    expect(bookmarkReference({ ...base, endLine: 13, quote: "if (a) {\n} else {" })).toBe(
      "packages/app/lib/main.dart:12-13\nselection:\nif (a) {\n} else {\ncomment:\n" + base.note,
    );
  });

  it("points old-side notes at the previous path", () => {
    expect(bookmarkReference({ ...base, side: "old" }, "lib/old.dart")).toMatch(
      /^lib\/old\.dart:12-35 \(versão anterior\)\n/,
    );
  });
});
