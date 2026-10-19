import { describe, expect, it } from "vitest";
import {
  filterCommands,
  readableJson,
  readMessages,
  sideBySide,
  diffLines,
  promptLines,
  markdown,
  markOnLine,
  partsOfYour,
  provisionalResolved,
  questionsOf,
  hookAnswer,
} from "./conversation";

const line = (o: unknown) => JSON.stringify(o);

describe("readMessages", () => {
  it("separates you, Claude and the tools", () => {
    const jsonl = [
      line({ type: "user", message: { content: "oi" } }),
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls\n-la", description: "Lista" } }] },
      }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "a" }] } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "pronto" }] } }),
    ].join("\n");
    expect(readMessages(jsonl)).toEqual([
      { who: "you", text: "oi" },
      { who: "tool", name: "Bash", summary: "Lista" },
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

describe("markdown", () => {
  it("with origem, each block carries the source lines it came from", () => {
    const md = "# T\n\nlinha um\nlinha dois\n\n- a\n  cont\n- b\n\n```\nx\n```\n\n| a |\n|---|\n| 1 |";
    expect(markdown(md, 0, undefined, true)).toBe(
      '<h1 data-from="1" data-to="1">T</h1>' +
        '<p data-from="3" data-to="4">linha um<br>linha dois</p>' +
        '<ul data-from="6" data-to="8"><li data-from="6" data-to="7">a<br>cont</li><li data-from="8" data-to="8">b</li></ul>' +
        '<pre data-from="10" data-to="12"><code>x</code></pre>' +
        '<table data-from="14" data-to="16"><thead><tr data-from="14" data-to="15"><th>a</th></tr></thead><tbody><tr data-from="16" data-to="16"><td>1</td></tr></tbody></table>',
    );
  });
  it("escapes what comes in", () => {
    expect(markdown("<b>oi</b>")).toBe("<p>&lt;b&gt;oi&lt;/b&gt;</p>");
  });

  it("doesn't format inside code", () => {
    expect(markdown("use `**x**` e **y**")).toBe("<p>use <code>**x**</code> e <strong>y</strong></p>");
    expect(markdown("```ts\na < b\n```")).toBe("<pre><code>a &lt; b</code></pre>");
    expect(markdown("```mermaid\na --> b\n```")).toBe('<pre class="mermaid"><code>a --&gt; b</code></pre>');
  });

  it("closes bold that has code in the middle", () => {
    expect(markdown("- **Os `GET` ficaram.** Às 14h")).toBe(
      "<ul><li><strong>Os <code>GET</code> ficaram.</strong> Às 14h</li></ul>",
    );
  });

  it("builds lists, headings and tables", () => {
    expect(markdown("## T\n- a\n- b")).toBe("<h4>T</h4><ul><li>a</li><li>b</li></ul>");
    expect(markdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("checkboxes only where asked, with the item's line to mark", () => {
    const md = "# Plano\n- [ ] a\n- [x] **b**\n- c";
    expect(markdown(md, 0)).toContain("<li>[ ] a</li>");
    expect(markdown(md, 0, "mark")).toBe(
      '<h1>Plano</h1><ul><li><input type="checkbox" class="task" data-line="1">a</li>' +
        '<li><input type="checkbox" class="task" checked data-line="2"><strong>b</strong></li><li>c</li></ul>',
    );
    expect(markdown("- [X] a", 0, "view")).toBe('<ul><li><input type="checkbox" class="task" checked disabled>a</li></ul>');
  });

  it("checkboxes in table cells, with line and column", () => {
    const md = "| feito | item |\n|---|---|\n| [x] | a |\n| [ ] b | [x] |";
    expect(markdown(md, 0)).toContain("<td>[x]</td>");
    expect(markdown(md, 0, "mark")).toBe(
      "<table><thead><tr><th>feito</th><th>item</th></tr></thead><tbody>" +
        '<tr><td><input type="checkbox" class="task" checked data-line="2" data-column="0"></td><td>a</td></tr>' +
        '<tr><td><input type="checkbox" class="task" data-line="3" data-column="0">b</td>' +
        '<td><input type="checkbox" class="task" checked data-line="3" data-column="1"></td></tr></tbody></table>',
    );
    expect(markdown(md, 0, "view")).toContain('<td><input type="checkbox" class="task" checked disabled></td>');
  });

  it("flips the right checkbox on the source line", () => {
    expect(markOnLine("  - [ ] a", true)).toBe("  - [x] a");
    expect(markOnLine("| [ ] b | [x] |", true, 0)).toBe("| [x] b | [x] |");
    expect(markOnLine("| [ ] b | [x] |", false, 1)).toBe("| [ ] b | [ ] |");
    expect(markOnLine("[ ] b | [x]", false, 1)).toBe("[ ] b | [ ]");
  });

  it("only links http", () => {
    expect(markdown("[x](javascript:alert(1))")).not.toContain("<a");
    expect(markdown("[x](https://a.b/c)")).toBe('<p><a href="https://a.b/c">x</a></p>');
  });

  it("links a bare URL, without the sentence's punctuation", () => {
    expect(markdown("open https://a.b/c?x=1&y=2.")).toBe(
      '<p>open <a href="https://a.b/c?x=1&amp;y=2">https://a.b/c?x=1&amp;y=2</a>.</p>',
    );
    expect(markdown("(see https://a.b/c)")).toBe('<p>(see <a href="https://a.b/c">https://a.b/c</a>)</p>');
    expect(markdown("https://w.org/Foo_(bar), ok")).toBe('<p><a href="https://w.org/Foo_(bar)">https://w.org/Foo_(bar)</a>, ok</p>');
    expect(markdown("[x](https://a.b/c) https://d.e")).toBe(
      '<p><a href="https://a.b/c">x</a> <a href="https://d.e">https://d.e</a></p>',
    );
    expect(markdown("`https://a.b/c`")).toBe("<p><code>https://a.b/c</code></p>");
  });
});

describe("promptLines", () => {
  const screen = [
    "❯ para remover o pooling o q falta eh...",
    "",
    "● Para remover o polling o que falta é",
    "  > uma citação",
    "❯ segunda pergunta bem",
    "  comprida",
    "",
    "❯ ",
  ];

  it("finds only the known prompts", () => {
    const prompts = ["para remover o pooling o q falta eh...", "segunda pergunta bem\ncomprida"];
    expect(promptLines(screen, prompts)).toEqual([
      { line: 0, height: 1 },
      { line: 4, height: 2 },
    ]);
  });

  it("without a prompt marks nothing", () => {
    expect(promptLines(screen, [])).toEqual([]);
  });

  it("matches a line wrapped by a narrow panel", () => {
    expect(promptLines(["> uma pergunta"], ["uma pergunta que continua depois da quebra"])).toEqual([
      { line: 0, height: 1 },
    ]);
  });
});

describe("filterCommands", () => {
  const all = [
    { name: "review", description: "meu" },
    { name: "clear", description: "" },
    { name: "design:design-critique", description: "" },
    { name: "code-review", description: "" },
    { name: "review", description: "embutido" },
  ];

  it("puts first the ones starting with the typed text, without repeating names", () => {
    expect(filterCommands(all, "rev").map((c) => `${c.name}|${c.description}`)).toEqual([
      "review|meu",
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
    const t = 'antes\n<pasted_content id="56ad">\nlog\nmais\n</pasted_content id="56ad">\ndepois';
    expect(partsOfYour(t, 0)).toEqual([
      { kind: "text", text: "antes" },
      { kind: "pasted", text: "log\nmais" },
      { kind: "text", text: "depois" },
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
    { question: "Qual cor?", header: "Cor", options: [{ label: "Azul" }, { label: "Verde" }] },
    { question: "Quais partes?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("only accepts the AskUserQuestion format", () => {
    expect(questionsOf({ questions: qs })).toEqual(qs);
    expect(questionsOf({ questions: [] })).toBeUndefined();
    expect(questionsOf({ questions: [{ question: "x" }] })).toBeUndefined();
    expect(questionsOf(undefined)).toBeUndefined();
  });

  it("waits for all questions to be answered", () => {
    expect(hookAnswer(qs, [{ labels: ["Azul"] }, undefined])).toBeUndefined();
    expect(hookAnswer(qs, [{ labels: ["Azul"] }, { labels: [], other: "  " }])).toBeUndefined();
  });

  it("builds the decision with answers keyed by question text", () => {
    const r = JSON.parse(hookAnswer(qs, [{ labels: [], other: "Roxo" }, { labels: ["A", "B"], other: "C" }])!);
    expect(r).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { questions: qs, answers: { "Qual cor?": "Roxo", "Quais partes?": "A, B, C" } },
        },
      },
    });
  });
});

describe("readableJson", () => {
  it("expands single-line JSON", () => {
    expect(readableJson('{"type":"x","data":{"ok":true}}')).toBe('{\n  "type": "x",\n  "data": {\n    "ok": true\n  }\n}');
  });

  it("leaves alone what isn't JSON or already has line breaks", () => {
    expect(readableJson('{"a": 1, …}')).toBe('{"a": 1, …}');
    expect(readableJson("npm run build")).toBe("npm run build");
    expect(readableJson('{\n"a":1}')).toBe('{\n"a":1}');
  });

  it("works inside a markdown code block", () => {
    expect(markdown('```json\n{"a":[1]}\n```')).toContain("{\n  &quot;a&quot;: [\n    1\n  ]\n}");
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
    expect(provisionalResolved(["!ls", "3.6 valido"], "3.6 valido")).toBe(2);
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
