import { describe, expect, it } from "vitest";
import { findReferences, logicalLine, referenceWhole, type ScreenLine } from "./viewer";

const files = (t: string) => findReferences(t).map((r) => [r.file, r.line, r.to]);

describe("findReferences", () => {
  it("finds paths with line, range and column", () => {
    expect(files("veja src/main.ts:848 e a/b.dart:10-20, ou x.rs:3:7.")).toEqual([
      ["src/main.ts", 848, undefined],
      ["a/b.dart", 10, 20],
      ["x.rs", 3, undefined],
    ]);
  });

  it("keeps the position in the text", () => {
    const [r] = findReferences("⏺ Abri o `user_repository.dart:103`");
    expect("⏺ Abri o `user_repository.dart:103`".slice(r.beginning, r.end)).toBe("user_repository.dart:103");
  });

  it("accepts paths without a line, relative, absolute and with ~", () => {
    expect(files("README.md ./a.ts ../b.ts /tmp/c.json ~/notas.md")).toEqual([
      ["README.md", undefined, undefined],
      ["./a.ts", undefined, undefined],
      ["../b.ts", undefined, undefined],
      ["/tmp/c.json", undefined, undefined],
      ["~/notas.md", undefined, undefined],
    ]);
  });

  it("doesn't pick up pieces of URLs or stray numbers", () => {
    expect(files("https://github.com/a/b.ts versão 1.5 e 2.0.1")).toEqual([]);
  });

  it("leaves sentence-ending punctuation out", () => {
    expect(files("mudei o lib.rs.")).toEqual([["lib.rs", undefined, undefined]]);
  });

  it("ignores an inverted range", () => {
    expect(files("a.ts:20-10")).toEqual([["a.ts", 20, undefined]]);
  });
});

describe("referenceWhole", () => {
  it("only when the whole text is the reference", () => {
    expect(referenceWhole("src/a.ts:12")?.line).toBe(12);
    expect(referenceWhole("veja src/a.ts:12")).toBeUndefined();
    expect(referenceWhole("foo()")).toBeUndefined();
  });
});

describe("logicalLine", () => {
  const screen = (cols: number, ...lines: (string | [string, true])[]): ScreenLine[] =>
    lines.map((l) => (typeof l === "string" ? { text: l.padEnd(cols), broken: false } : { text: l[0].padEnd(cols), broken: true }));

  it("joins the continuation Claude Code wrapped and indented", () => {
    const lines = screen(30, "  Abri apps/management_console/", "  lib/data/user_repo.dart:103", "  outra coisa");
    // Upward only: the line below ("other coisa") isn't a continuation.
    const { text, pos } = logicalLine(lines, 1, 30, true, false);
    const [ref] = findReferences(text);
    expect(ref.file).toBe("apps/management_console/lib/data/user_repo.dart");
    expect(ref.line).toBe(103);
    expect(pos[ref.beginning]).toEqual({ line: 0, col: 7 });
    expect(pos[ref.end - 1]).toEqual({ line: 1, col: 28 });
  });

  it("without the guess, only xterm's wrap", () => {
    const lines = screen(10, "abc/def/gh", ["i.ts:4", true]);
    expect(logicalLine(lines, 1, 10, false).text).toBe("abc/def/ghi.ts:4");
    expect(logicalLine(screen(30, "  Abri apps/management_console/", "  lib/x.dart"), 0, 30, false).text).toBe(
      "  Abri apps/management_console/",
    );
  });

  it("doesn't join a short line or a sentence end", () => {
    expect(logicalLine(screen(30, "curta", "  b.ts"), 0, 30, true).text).toBe("curta");
    expect(logicalLine(screen(30, "uma frase bem longa que acaba.", "  b.ts"), 0, 30, true).text).toBe(
      "uma frase bem longa que acaba.",
    );
  });
});
