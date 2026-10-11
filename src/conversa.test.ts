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
  it("separa você, o Claude e as ferramentas", () => {
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

  it("pula o que não é conversa", () => {
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

  it("devolve o /comando como foi digitado", () => {
    const jsonl = linha({
      type: "user",
      message: { content: "<command-name>/handoff</command-name>\n<command-args>run x</command-args>" },
    });
    expect(lerFalas(jsonl)).toEqual([{ quem: "voce", texto: "/handoff run x" }]);
  });

  it("guarda as imagens coladas como data URL", () => {
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
  it("escapa o que entra", () => {
    expect(markdown("<b>oi</b>")).toBe("<p>&lt;b&gt;oi&lt;/b&gt;</p>");
  });

  it("não formata dentro de código", () => {
    expect(markdown("use `**x**` e **y**")).toBe("<p>use <code>**x**</code> e <strong>y</strong></p>");
    expect(markdown("```ts\na < b\n```")).toBe("<pre><code>a &lt; b</code></pre>");
  });

  it("fecha o negrito que tem código no meio", () => {
    expect(markdown("- **Os `GET` ficaram.** Às 14h")).toBe(
      "<ul><li><strong>Os <code>GET</code> ficaram.</strong> Às 14h</li></ul>",
    );
  });

  it("monta lista, título e tabela", () => {
    expect(markdown("## T\n- a\n- b")).toBe("<h4>T</h4><ul><li>a</li><li>b</li></ul>");
    expect(markdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("só liga http", () => {
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

  it("acha só os prompts conhecidos", () => {
    const prompts = ["para remover o pooling o q falta eh...", "segunda pergunta bem\ncomprida"];
    expect(linhasDePrompt(tela, prompts)).toEqual([
      { linha: 0, altura: 1 },
      { linha: 4, altura: 2 },
    ]);
  });

  it("sem prompt não marca nada", () => {
    expect(linhasDePrompt(tela, [])).toEqual([]);
  });

  it("casa com a linha quebrada por um painel estreito", () => {
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

  it("põe na frente os que começam pelo digitado, sem repetir nome", () => {
    expect(filtrarComandos(todos, "rev").map((c) => `${c.nome}|${c.descricao}`)).toEqual([
      "review|meu",
      "code-review|",
    ]);
  });

  it("acha o comando de plugin pelo nome curto", () => {
    expect(filtrarComandos(todos, "design-c").map((c) => c.nome)).toEqual(["design:design-critique"]);
  });

  it("sem nada digitado devolve todos", () => {
    expect(filtrarComandos(todos, "")).toHaveLength(4);
  });
});

describe("partesDoSeu", () => {
  it("tira as tags do texto colado", () => {
    const t = 'antes\n<pasted_content id="56ad">\nlog\nmais\n</pasted_content id="56ad">\ndepois';
    expect(partesDoSeu(t, 0)).toEqual([
      { tipo: "texto", texto: "antes" },
      { tipo: "colado", texto: "log\nmais" },
      { tipo: "texto", texto: "depois" },
    ]);
  });

  it("aceita a tag sem id", () => {
    expect(partesDoSeu("<pasted_content>x</pasted_content>", 0)).toEqual([{ tipo: "colado", texto: "x" }]);
  });

  it("põe cada imagem onde o texto a cita, e a que sobra no fim", () => {
    expect(partesDoSeu("a[Image #3] b[Image #4]", 3)).toEqual([
      { tipo: "texto", texto: "a" },
      { tipo: "imagem", indice: 0 },
      { tipo: "texto", texto: "b" },
      { tipo: "imagem", indice: 1 },
      { tipo: "imagem", indice: 2 },
    ]);
  });

  it("deixa o marcador como texto quando não há imagem para ele", () => {
    expect(partesDoSeu("veja [Image #1]", 0)).toEqual([{ tipo: "texto", texto: "veja [Image #1]" }]);
  });
});

describe("linhasDoDiff", () => {
  it("numera como o terminal: o que saiu pela linha de antes, o resto pela de depois", () => {
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

  it("separa os trechos e ignora o aviso de fim de arquivo", () => {
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

describe("lerFalas e os diffs", () => {
  it("põe o diff que o Rust extraiu como fala própria", () => {
    const arquivos = [{ caminho: "/x.ts", hunks: [{ oldStart: 1, newStart: 1, lines: ["+a"] }] }];
    expect(lerFalas(linha({ type: "diff", arquivos }))).toEqual([{ quem: "diff", arquivos }]);
  });
});

describe("as perguntas do Claude", () => {
  const qs = [
    { question: "Qual cor?", header: "Cor", options: [{ label: "Azul" }, { label: "Verde" }] },
    { question: "Quais partes?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("só aceita o formato do AskUserQuestion", () => {
    expect(questoesDe({ questions: qs })).toEqual(qs);
    expect(questoesDe({ questions: [] })).toBeUndefined();
    expect(questoesDe({ questions: [{ question: "x" }] })).toBeUndefined();
    expect(questoesDe(undefined)).toBeUndefined();
  });

  it("espera todas as perguntas respondidas", () => {
    expect(respostaDoHook(qs, [{ labels: ["Azul"] }, undefined])).toBeUndefined();
    expect(respostaDoHook(qs, [{ labels: ["Azul"] }, { labels: [], outra: "  " }])).toBeUndefined();
  });

  it("monta a decisão com as respostas pelo texto da pergunta", () => {
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
  it("abre o JSON de uma linha só", () => {
    expect(jsonLegivel('{"type":"x","data":{"ok":true}}')).toBe('{\n  "type": "x",\n  "data": {\n    "ok": true\n  }\n}');
  });

  it("deixa como está o que não é JSON ou já tem quebras", () => {
    expect(jsonLegivel('{"a": 1, …}')).toBe('{"a": 1, …}');
    expect(jsonLegivel("npm run build")).toBe("npm run build");
    expect(jsonLegivel('{\n"a":1}')).toBe('{\n"a":1}');
  });

  it("vale dentro do bloco de código do markdown", () => {
    expect(markdown('```json\n{"a":[1]}\n```')).toContain("{\n  &quot;a&quot;: [\n    1\n  ]\n}");
  });
});

describe("ladoALado", () => {
  it("põe o que saiu ao lado do que entrou, e o contexto com os dois números", () => {
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
  it("tira o provisório da fala que chegou, e não só o mais antigo", () => {
    expect(provisoriosResolvidos(["a", "b"], "a")).toBe(1);
    // Um provisório velho que nunca virou fala sai junto com o de depois.
    expect(provisoriosResolvidos(["!ls", "3.6 valido"], "3.6 valido")).toBe(2);
  });

  it("casa mensagens da fila que o Claude juntou numa fala só", () => {
    expect(provisoriosResolvidos(["um", "dois", "três"], "um\ndois")).toBe(2);
  });

  it("ignora o embrulho do colado, as imagens e os espaços", () => {
    expect(provisoriosResolvidos(["olha  [Image #1]"], "olha")).toBe(1);
    expect(provisoriosResolvidos(["x", "y"], '<pasted_content id="1">\ny\n</pasted_content>')).toBe(2);
  });

  it("sem nada parecido, sai o mais antigo; sem provisório, nada", () => {
    expect(provisoriosResolvidos(["a", "b"], "zzz")).toBe(1);
    expect(provisoriosResolvidos([], "a")).toBe(0);
  });
});
