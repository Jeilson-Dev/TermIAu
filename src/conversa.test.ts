import { describe, expect, it } from "vitest";
import {
  filtrarComandos,
  jsonLegivel,
  lerFalas,
  ladoALado,
  linhasDoDiff,
  linhasDePrompt,
  markdown,
  partesDoSeu,
  provisoriosResolvidos,
  questoesDe,
  respostaDoHook,
} from "./conversa";

const linha = (o: unknown) => JSON.stringify(o);

describe("lerFalas", () => {
  it("separates you, Claude and the tools", () => {
    const jsonl = [
      linha({ type: "user", message: { content: "oi" } }),
      linha({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }),
      linha({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls\n-la", description: "Lista" } }] },
      }),
      linha({ type: "user", message: { content: [{ type: "tool_result", content: "a" }] } }),
      linha({ type: "assistant", message: { content: [{ type: "text", text: "pronto" }] } }),
    ].join("\n");
    expect(lerFalas(jsonl)).toEqual([
      { quem: "voce", texto: "oi" },
      { quem: "ferramenta", nome: "Bash", resumo: "Lista" },
      { quem: "claude", texto: "pronto" },
    ]);
  });

  it("skips what isn't conversation", () => {
    const jsonl = [
      linha({ type: "user", isMeta: true, message: { content: "meta" } }),
      linha({ type: "user", isSidechain: true, message: { content: "subagente" } }),
      linha({ type: "user", message: { content: "<local-command-stdout>x</local-command-stdout>" } }),
      linha({ type: "user", message: { content: "<system-reminder>x</system-reminder>" } }),
      linha({ type: "ai-title", aiTitle: "x" }),
      '{"type":"user","message":{"content":"corta',
    ].join("\n");
    expect(lerFalas(jsonl)).toEqual([]);
  });

  it("returns the /command as typed", () => {
    const jsonl = linha({
      type: "user",
      message: { content: "<command-name>/handoff</command-name>\n<command-args>run x</command-args>" },
    });
    expect(lerFalas(jsonl)).toEqual([{ quem: "voce", texto: "/handoff run x" }]);
  });

  it("keeps pasted images as data URLs", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
    const jsonl = [
      linha({ type: "user", message: { content: [{ type: "text", text: "olha[Image #1]" }, img] } }),
      linha({ type: "user", message: { content: [img] } }),
    ].join("\n");
    expect(lerFalas(jsonl)).toEqual([
      { quem: "voce", texto: "olha[Image #1]", imagens: ["data:image/png;base64,AAA"] },
      { quem: "voce", texto: "", imagens: ["data:image/png;base64,AAA"] },
    ]);
  });
});

describe("markdown", () => {
  it("escapes what comes in", () => {
    expect(markdown("<b>oi</b>")).toBe("<p>&lt;b&gt;oi&lt;/b&gt;</p>");
  });

  it("doesn't format inside code", () => {
    expect(markdown("use `**x**` e **y**")).toBe("<p>use <code>**x**</code> e <strong>y</strong></p>");
    expect(markdown("```ts\na < b\n```")).toBe("<pre><code>a &lt; b</code></pre>");
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

  it("only links http", () => {
    expect(markdown("[x](javascript:alert(1))")).not.toContain("<a");
    expect(markdown("[x](https://a.b/c)")).toBe('<p><a href="https://a.b/c">x</a></p>');
  });
});

describe("linhasDePrompt", () => {
  const tela = [
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
    expect(linhasDePrompt(tela, prompts)).toEqual([
      { linha: 0, altura: 1 },
      { linha: 4, altura: 2 },
    ]);
  });

  it("without a prompt marks nothing", () => {
    expect(linhasDePrompt(tela, [])).toEqual([]);
  });

  it("matches a line wrapped by a narrow panel", () => {
    expect(linhasDePrompt(["> uma pergunta"], ["uma pergunta que continua depois da quebra"])).toEqual([
      { linha: 0, altura: 1 },
    ]);
  });
});

describe("filtrarComandos", () => {
  const todos = [
    { nome: "review", descricao: "meu" },
    { nome: "clear", descricao: "" },
    { nome: "design:design-critique", descricao: "" },
    { nome: "code-review", descricao: "" },
    { nome: "review", descricao: "embutido" },
  ];

  it("puts first the ones starting with the typed text, without repeating names", () => {
    expect(filtrarComandos(todos, "rev").map((c) => `${c.nome}|${c.descricao}`)).toEqual([
      "review|meu",
      "code-review|",
    ]);
  });

  it("finds a plugin command by its short name", () => {
    expect(filtrarComandos(todos, "design-c").map((c) => c.nome)).toEqual(["design:design-critique"]);
  });

  it("with nothing typed returns all", () => {
    expect(filtrarComandos(todos, "")).toHaveLength(4);
  });
});

describe("partesDoSeu", () => {
  it("removes the tags from pasted text", () => {
    const t = 'antes\n<pasted_content id="56ad">\nlog\nmais\n</pasted_content id="56ad">\ndepois';
    expect(partesDoSeu(t, 0)).toEqual([
      { tipo: "texto", texto: "antes" },
      { tipo: "colado", texto: "log\nmais" },
      { tipo: "texto", texto: "depois" },
    ]);
  });

  it("accepts the tag without an id", () => {
    expect(partesDoSeu("<pasted_content>x</pasted_content>", 0)).toEqual([{ tipo: "colado", texto: "x" }]);
  });

  it("puts each image where the text cites it, and the leftover at the end", () => {
    expect(partesDoSeu("a[Image #3] b[Image #4]", 3)).toEqual([
      { tipo: "texto", texto: "a" },
      { tipo: "imagem", indice: 0 },
      { tipo: "texto", texto: "b" },
      { tipo: "imagem", indice: 1 },
      { tipo: "imagem", indice: 2 },
    ]);
  });

  it("leaves the marker as text when there is no image for it", () => {
    expect(partesDoSeu("veja [Image #1]", 0)).toEqual([{ tipo: "texto", texto: "veja [Image #1]" }]);
  });
});

describe("linhasDoDiff", () => {
  it("numbers like the terminal: removed lines by the old line, the rest by the new one", () => {
    const d = linhasDoDiff({
      caminho: "/x.ts",
      hunks: [{ oldStart: 40, newStart: 40, lines: [" a", "-b", "+B", "+C", " c"] }],
    });
    expect(d).toEqual({
      linhas: [
        { tipo: " ", texto: "a", numero: 40, antigo: 40 },
        { tipo: "-", texto: "b", numero: 41 },
        { tipo: "+", texto: "B", numero: 41 },
        { tipo: "+", texto: "C", numero: 42 },
        { tipo: " ", texto: "c", numero: 43, antigo: 42 },
      ],
      mais: 2,
      menos: 1,
    });
  });

  it("separates the hunks and ignores the end-of-file notice", () => {
    const d = linhasDoDiff({
      caminho: "/x.ts",
      hunks: [
        { oldStart: 1, newStart: 1, lines: ["-a", "\\ No newline at end of file"] },
        { oldStart: 9, newStart: 8, lines: ["+z"] },
      ],
    });
    expect(d.linhas.map((l) => l.tipo)).toEqual(["-", "…", "+"]);
  });
});

describe("lerFalas and the diffs", () => {
  it("puts the diff Rust extracted as its own turn", () => {
    const arquivos = [{ caminho: "/x.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+a"] }] }];
    expect(lerFalas(linha({ type: "diff", arquivos }))).toEqual([{ quem: "diff", arquivos }]);
  });
});

describe("Claude's questions", () => {
  const qs = [
    { question: "Qual cor?", header: "Cor", options: [{ label: "Azul" }, { label: "Verde" }] },
    { question: "Quais partes?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("only accepts the AskUserQuestion format", () => {
    expect(questoesDe({ questions: qs })).toEqual(qs);
    expect(questoesDe({ questions: [] })).toBeUndefined();
    expect(questoesDe({ questions: [{ question: "x" }] })).toBeUndefined();
    expect(questoesDe(undefined)).toBeUndefined();
  });

  it("waits for all questions to be answered", () => {
    expect(respostaDoHook(qs, [{ labels: ["Azul"] }, undefined])).toBeUndefined();
    expect(respostaDoHook(qs, [{ labels: ["Azul"] }, { labels: [], outra: "  " }])).toBeUndefined();
  });

  it("builds the decision with answers keyed by question text", () => {
    const r = JSON.parse(respostaDoHook(qs, [{ labels: [], outra: "Roxo" }, { labels: ["A", "B"], outra: "C" }])!);
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

describe("jsonLegivel", () => {
  it("expands single-line JSON", () => {
    expect(jsonLegivel('{"type":"x","data":{"ok":true}}')).toBe('{\n  "type": "x",\n  "data": {\n    "ok": true\n  }\n}');
  });

  it("leaves alone what isn't JSON or already has line breaks", () => {
    expect(jsonLegivel('{"a": 1, …}')).toBe('{"a": 1, …}');
    expect(jsonLegivel("npm run build")).toBe("npm run build");
    expect(jsonLegivel('{\n"a":1}')).toBe('{\n"a":1}');
  });

  it("works inside a markdown code block", () => {
    expect(markdown('```json\n{"a":[1]}\n```')).toContain("{\n  &quot;a&quot;: [\n    1\n  ]\n}");
  });
});

describe("ladoALado", () => {
  it("puts removed lines beside added ones, and context with both numbers", () => {
    const { linhas } = linhasDoDiff({
      caminho: "/x.ts",
      hunks: [
        { oldStart: 40, newStart: 40, lines: [" a", "-b", "+B", "+C", " c"] },
        { oldStart: 90, newStart: 91, lines: ["-x"] },
      ],
    });
    expect(ladoALado(linhas)).toEqual([
      { antes: { tipo: " ", texto: "a", numero: 40, antigo: 40 }, depois: { tipo: " ", texto: "a", numero: 40, antigo: 40 } },
      { antes: { tipo: "-", texto: "b", numero: 41 }, depois: { tipo: "+", texto: "B", numero: 41 } },
      { antes: undefined, depois: { tipo: "+", texto: "C", numero: 42 } },
      { antes: { tipo: " ", texto: "c", numero: 42, antigo: 42 }, depois: { tipo: " ", texto: "c", numero: 43, antigo: 42 } },
      { pulo: true },
      { antes: { tipo: "-", texto: "x", numero: 90 }, depois: undefined },
    ]);
  });
});

describe("provisoriosResolvidos", () => {
  it("removes the provisional bubble of the turn that arrived, not just the oldest", () => {
    expect(provisoriosResolvidos(["a", "b"], "a")).toBe(1);
    // An old provisional one that never became a turn goes along with the one after it.
    expect(provisoriosResolvidos(["!ls", "3.6 valido"], "3.6 valido")).toBe(2);
  });

  it("matches queued messages Claude merged into a single turn", () => {
    expect(provisoriosResolvidos(["um", "dois", "três"], "um\ndois")).toBe(2);
  });

  it("ignores the paste wrapper, the images and the spaces", () => {
    expect(provisoriosResolvidos(["olha  [Image #1]"], "olha")).toBe(1);
    expect(provisoriosResolvidos(["x", "y"], '<pasted_content id="1">\ny\n</pasted_content>')).toBe(2);
  });

  it("with nothing similar, the oldest goes; with no provisional, nothing", () => {
    expect(provisoriosResolvidos(["a", "b"], "zzz")).toBe(1);
    expect(provisoriosResolvidos([], "a")).toBe(0);
  });
});
