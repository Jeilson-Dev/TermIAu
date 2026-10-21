import { describe, expect, it } from "vitest";
import { promptLines } from "./prompts";

describe("promptLines", () => {
  const screen = [
    "❯ what is left to remove the pooling...",
    "",
    "● To remove the polling, what is left is",
    "  > a quote",
    "❯ a second, quite",
    "  long question",
    "",
    "❯ ",
  ];

  it("finds only the known prompts", () => {
    const prompts = ["what is left to remove the pooling...", "a second, quite\nlong question"];
    expect(promptLines(screen, prompts)).toEqual([
      { line: 0, height: 1 },
      { line: 4, height: 2 },
    ]);
  });

  it("without a prompt marks nothing", () => {
    expect(promptLines(screen, [])).toEqual([]);
  });

  it("matches a line wrapped by a narrow panel", () => {
    expect(promptLines(["> a question"], ["a question that goes on after the wrap"])).toEqual([
      { line: 0, height: 1 },
    ]);
  });
});
