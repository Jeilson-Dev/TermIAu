import { describe, expect, it } from "vitest";
import {
  filterCommands,
  readMessages,
  sideBySide,
  diffLines,
  partsOfYour,
  provisionalResolved,
  hookAnswer,
} from "./conversation";
import { questionsOf } from "../../claude/src/events";

const line = (o: unknown) => JSON.stringify(o);

describe("readMessages", () => {
  it("separates you, Claude and the tools", () => {
    const jsonl = [
      line({ type: "user", message: { content: "oi" } }),
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls\n-la", description: "List" } }] },
      }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "a" }] } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "pronto" }] } }),
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([
      { who: "you", text: "oi" },
      { who: "tool", name: "Bash", summary: "List" },
      { who: "claude", text: "pronto" },
    ]);
  });

  it("skips what isn't conversation", () => {
    const jsonl = [
      line({ type: "user", isMeta: true, message: { content: "meta" } }),
      line({ type: "user", isSidechain: true, message: { content: "subagente" } }),
      line({ type: "user", message: { content: "<local-command-stdout>x</local-command-stdout>" } }),
      line({ type: "user", message: { content: "<system-reminder>x</system-reminder>" } }),
      line({ type: "ai-title", aiTitle: "x" }),
      '{"type":"user","message":{"content":"corta',
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([]);
  });

  it("shows what Claude says between tools, which comes as thinking", () => {
    const thought = (thinking: string, thinkingDisplay?: string) =>
      line({ type: "assistant", thinkingDisplay, message: { content: [{ type: "thinking", thinking }] } });
    const jsonl = [
      thought("", "updates"),
      thought("Confirmei a versão.", "updates"),
      thought("raciocínio por extenso"),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([
      { who: "claude", text: "Confirmei a versão." },
      { who: "tool", name: "Bash", summary: "ls" },
    ]);
  });

  it("doesn't take the interruption notice for you", () => {
    const jsonl = [
      line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
      line({ type: "user", message: { content: "[Request interrupted by user]" } }),
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([]);
  });

  it("returns the /command as typed", () => {
    const jsonl = line({
      type: "user",
      message: { content: "<command-name>/handoff</command-name>\n<command-args>run x</command-args>" },
    });
    expect(readMessages(jsonl)).toEqual([{ who: "you", text: "/handoff run x" }]);
  });

  it("keeps pasted images as data URLs", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
    const jsonl = [
      line({ type: "user", message: { content: [{ type: "text", text: "olha[Image #1]" }, img] } }),
      line({ type: "user", message: { content: [img] } }),
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([
      { who: "you", text: "olha[Image #1]", images: ["data:image/png;base64,AAA"] },
      { who: "you", text: "", images: ["data:image/png;base64,AAA"] },
    ]);
  });
});

describe("filterCommands", () => {
  const all = [
    { name: "review", description: "mine" },
    { name: "clear", description: "" },
    { name: "design:design-critique", description: "" },
    { name: "code-review", description: "" },
    { name: "review", description: "embutido" },
  ];

  it("puts first the ones starting with the typed text, without repeating names", () => {
    expect(filterCommands(all, "rev").map((c) => `${c.name}|${c.description}`)).toEqual([
      "review|mine",
      "code-review|",
    ]);
  });

  it("finds a plugin command by its short name", () => {
    expect(filterCommands(all, "design-c").map((c) => c.name)).toEqual(["design:design-critique"]);
  });

  it("with nothing typed returns all", () => {
    expect(filterCommands(all, "")).toHaveLength(4);
  });
});

describe("partsOfYour", () => {
  it("removes the tags from pasted text", () => {
    const t = 'before\n<pasted_content id="56ad">\nlog\nmore\n</pasted_content id="56ad">\nafter';
    expect(partsOfYour(t, 0)).toEqual([
      { kind: "text", text: "before" },
      { kind: "pasted", text: "log\nmore" },
      { kind: "text", text: "after" },
    ]);
  });

  it("accepts the tag without an id", () => {
    expect(partsOfYour("<pasted_content>x</pasted_content>", 0)).toEqual([{ kind: "pasted", text: "x" }]);
  });

  it("puts each image where the text cites it, and the leftover at the end", () => {
    expect(partsOfYour("a[Image #3] b[Image #4]", 3)).toEqual([
      { kind: "text", text: "a" },
      { kind: "image", index: 0 },
      { kind: "text", text: "b" },
      { kind: "image", index: 1 },
      { kind: "image", index: 2 },
    ]);
  });

  it("leaves the marker as text when there is no image for it", () => {
    expect(partsOfYour("veja [Image #1]", 0)).toEqual([{ kind: "text", text: "veja [Image #1]" }]);
  });
});

describe("diffLines", () => {
  it("numbers like the terminal: removed lines by the old line, the rest by the new one", () => {
    const d = diffLines({
      path: "/x.ts",
      hunks: [{ oldStart: 40, newStart: 40, lines: [" a", "-b", "+B", "+C", " c"] }],
    });
    expect(d).toEqual({
      lines: [
        { kind: " ", text: "a", num: 40, old: 40 },
        { kind: "-", text: "b", num: 41 },
        { kind: "+", text: "B", num: 41 },
        { kind: "+", text: "C", num: 42 },
        { kind: " ", text: "c", num: 43, old: 42 },
      ],
      more: 2,
      less: 1,
    });
  });

  it("separates the hunks and ignores the end-of-file notice", () => {
    const d = diffLines({
      path: "/x.ts",
      hunks: [
        { oldStart: 1, newStart: 1, lines: ["-a", "\\ No newline at end of file"] },
        { oldStart: 9, newStart: 8, lines: ["+z"] },
      ],
    });
    expect(d.lines.map((l) => l.kind)).toEqual(["-", "…", "+"]);
  });
});

describe("readMessages and the diffs", () => {
  it("puts the diff Rust extracted as its own turn", () => {
    const files = [{ path: "/x.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+a"] }] }];
    expect(readMessages(line({ type: "diff", files }))).toEqual([{ who: "diff", files: files }]);
  });
});

describe("Claude's questions", () => {
  const qs = [
    { question: "Which color?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] },
    { question: "Which parts?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("only accepts the AskUserQuestion format", () => {
    expect(questionsOf({ questions: qs })).toEqual(qs);
    expect(questionsOf({ questions: [] })).toBeUndefined();
    expect(questionsOf({ questions: [{ question: "x" }] })).toBeUndefined();
    expect(questionsOf(undefined)).toBeUndefined();
  });

  it("waits for all questions to be answered", () => {
    expect(hookAnswer(qs, [{ labels: ["Blue"] }, undefined])).toBeUndefined();
    expect(hookAnswer(qs, [{ labels: ["Blue"] }, { labels: [], other: "  " }])).toBeUndefined();
  });

  it("builds the decision with answers keyed by question text", () => {
    const r = JSON.parse(hookAnswer(qs, [{ labels: [], other: "Purple" }, { labels: ["A", "B"], other: "C" }])!);
    expect(r).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { questions: qs, answers: { "Which color?": "Purple", "Which parts?": "A, B, C" } },
        },
      },
    });
  });
});

describe("sideBySide", () => {
  it("puts removed lines beside added ones, and context with both numbers", () => {
    const { lines } = diffLines({
      path: "/x.ts",
      hunks: [
        { oldStart: 40, newStart: 40, lines: [" a", "-b", "+B", "+C", " c"] },
        { oldStart: 90, newStart: 91, lines: ["-x"] },
      ],
    });
    expect(sideBySide(lines)).toEqual([
      { before: { kind: " ", text: "a", num: 40, old: 40 }, after: { kind: " ", text: "a", num: 40, old: 40 } },
      { before: { kind: "-", text: "b", num: 41 }, after: { kind: "+", text: "B", num: 41 } },
      { before: undefined, after: { kind: "+", text: "C", num: 42 } },
      { before: { kind: " ", text: "c", num: 42, old: 42 }, after: { kind: " ", text: "c", num: 43, old: 42 } },
      { jump: true },
      { before: { kind: "-", text: "x", num: 90 }, after: undefined },
    ]);
  });
});

describe("provisionalResolved", () => {
  it("removes the provisional bubble of the turn that arrived, not just the oldest", () => {
    expect(provisionalResolved(["a", "b"], "a")).toBe(1);
    // An old provisional one that never became a turn goes along with the one after it.
    expect(provisionalResolved(["!ls", "3.6 valid"], "3.6 valid")).toBe(2);
  });

  it("matches queued messages Claude merged into a single turn", () => {
    expect(provisionalResolved(["um", "dois", "três"], "um\ndois")).toBe(2);
  });

  it("ignores the paste wrapper, the images and the spaces", () => {
    expect(provisionalResolved(["olha  [Image #1]"], "olha")).toBe(1);
    expect(provisionalResolved(["x", "y"], '<pasted_content id="1">\ny\n</pasted_content>')).toBe(2);
  });

  it("with nothing similar, the oldest goes; with no provisional, nothing", () => {
    expect(provisionalResolved(["a", "b"], "zzz")).toBe(1);
    expect(provisionalResolved([], "a")).toBe(0);
  });
});
