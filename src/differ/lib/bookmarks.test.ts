import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage, language } from "../../i18n";
import type { Bookmark } from "../types";
import { bookmarkReference, bookmarksReference } from "./bookmarks";

const base = {
  path: "packages/app/lib/main.dart",
  side: "new" as const,
  startLine: 12,
  endLine: 35,
  note: "could these if/else become a switch/case?",
};

const initial = language();
beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage(initial));

describe("bookmarkReference", () => {
  it("formats a line range with the comment", () => {
    expect(bookmarkReference(base)).toBe(
      "packages/app/lib/main.dart:12-35\ncomment:\ncould these if/else become a switch/case?",
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
      /^lib\/old\.dart:12-35 \(previous version\)\n/,
    );
    setLanguage("pt");
    expect(bookmarkReference({ ...base, side: "old" }, "lib/old.dart")).toMatch(
      /^lib\/old\.dart:12-35 \(versão anterior\)\n/,
    );
  });
});

describe("bookmarksReference", () => {
  const bookmark = (n: number, resolved = false) =>
    ({ ...base, id: `b${n}`, startLine: n, endLine: n, note: `note ${n}`, resolved }) as Bookmark;

  it("joins every comment under a count, in the order given", () => {
    const text = bookmarksReference([bookmark(1), bookmark(2)], (b) => bookmarkReference(b));
    expect(text).toBe(
      "2 review comments\n\n" +
        `${base.path}:1\ncomment:\nnote 1\n\n` +
        `${base.path}:2\ncomment:\nnote 2`,
    );
  });

  it("marks the ones already checked off", () => {
    expect(bookmarksReference([bookmark(3, true)], (b) => bookmarkReference(b))).toBe(
      `1 review comment\n\n${base.path}:3\ncomment:\nnote 3\n(resolved)`,
    );
    setLanguage("pt");
    expect(bookmarksReference([bookmark(3, true)], (b) => bookmarkReference(b))).toBe(
      `1 comentário de revisão\n\n${base.path}:3\ncomment:\nnote 3\n(resolvido)`,
    );
  });

  it("is empty when there is nothing to copy", () => {
    expect(bookmarksReference([], (b) => bookmarkReference(b))).toBe("");
  });
});
