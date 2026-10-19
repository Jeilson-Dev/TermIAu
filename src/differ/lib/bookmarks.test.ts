import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage, language } from "../../i18n";
import type { Bookmark } from "../types";
import { bookmarkReference, bookmarksReference } from "./bookmarks";

const base = {
  path: "packages/app/lib/main.dart",
  side: "new" as const,
  startLine: 12,
  endLine: 35,
  note: "poderia trocar esses if/else por um switch/case?",
};

const initial = language();
beforeEach(() => setLanguage("pt"));
afterEach(() => setLanguage(initial));

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
    setLanguage("en");
    expect(bookmarkReference({ ...base, side: "old" }, "lib/old.dart")).toMatch(
      /^lib\/old\.dart:12-35 \(previous version\)\n/,
    );
  });
});

describe("bookmarksReference", () => {
  const bookmark = (n: number, resolved = false) =>
    ({ ...base, id: `b${n}`, startLine: n, endLine: n, note: `nota ${n}`, resolved }) as Bookmark;

  it("joins every comment under a count, in the order given", () => {
    const text = bookmarksReference([bookmark(1), bookmark(2)], (b) => bookmarkReference(b));
    expect(text).toBe(
      "2 comentários de revisão\n\n" +
        `${base.path}:1\ncomment:\nnota 1\n\n` +
        `${base.path}:2\ncomment:\nnota 2`,
    );
  });

  it("marks the ones already checked off", () => {
    expect(bookmarksReference([bookmark(3, true)], (b) => bookmarkReference(b))).toBe(
      `1 comentário de revisão\n\n${base.path}:3\ncomment:\nnota 3\n(resolvido)`,
    );
    setLanguage("en");
    expect(bookmarksReference([bookmark(3, true)], (b) => bookmarkReference(b))).toBe(
      `1 review comment\n\n${base.path}:3\ncomment:\nnota 3\n(resolved)`,
    );
  });

  it("is empty when there is nothing to copy", () => {
    expect(bookmarksReference([], (b) => bookmarkReference(b))).toBe("");
  });
});
