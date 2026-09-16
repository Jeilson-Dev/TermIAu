import { describe, expect, it } from "vitest";
import { segments } from "./segments";

const plain = (parts: ReturnType<typeof segments>) => parts.map((p) => [p.content, p.emph]);

describe("segments", () => {
  it("splits plain text at the changed ranges", () => {
    expect(plain(segments("abcdef", null, [[2, 4]]))).toEqual([
      ["ab", false],
      ["cd", true],
      ["ef", false],
    ]);
  });

  it("keeps token colors when a change crosses token boundaries", () => {
    const tokens = [
      { content: "const ", color: "#ff79c6" },
      { content: "x", color: "#f8f8f2" },
    ];
    expect(segments("const x", tokens, [[4, 7]])).toEqual([
      { content: "cons", color: "#ff79c6", fontStyle: undefined, emph: false },
      { content: "t ", color: "#ff79c6", fontStyle: undefined, emph: true },
      { content: "x", color: "#f8f8f2", fontStyle: undefined, emph: true },
    ]);
  });

  it("ignores tokens that don't match the line", () => {
    expect(plain(segments("abc", [{ content: "zzz" }], null))).toEqual([["abc", false]]);
  });
});
