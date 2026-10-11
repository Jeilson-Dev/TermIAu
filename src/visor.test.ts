import { describe, expect, it } from "vitest";
import { acharReferencias, linhaLogica, referenciaInteira, type LinhaDaTela } from "./visor";

const arquivos = (t: string) => acharReferencias(t).map((r) => [r.arquivo, r.linha, r.ate]);

describe("acharReferencias", () => {
  it("finds paths with line, range and column", () => {
    expect(arquivos("veja src/main.ts:848 e a/b.dart:10-20, ou x.rs:3:7.")).toEqual([
      ["src/main.ts", 848, undefined],
      ["a/b.dart", 10, 20],
      ["x.rs", 3, undefined],
    ]);
  });

  it("keeps the position in the text", () => {
    const [r] = acharReferencias("⏺ Abri o `user_repository.dart:103`");
    expect("⏺ Abri o `user_repository.dart:103`".slice(r.inicio, r.fim)).toBe("user_repository.dart:103");
  });

  it("accepts paths without a line, relative, absolute and with ~", () => {
    expect(arquivos("README.md ./a.ts ../b.ts /tmp/c.json ~/notas.md")).toEqual([
      ["README.md", undefined, undefined],
      ["./a.ts", undefined, undefined],
      ["../b.ts", undefined, undefined],
      ["/tmp/c.json", undefined, undefined],
      ["~/notas.md", undefined, undefined],
    ]);
  });

  it("doesn't pick up pieces of URLs or stray numbers", () => {
    expect(arquivos("https://github.com/a/b.ts versão 1.5 e 2.0.1")).toEqual([]);
  });

  it("leaves sentence-ending punctuation out", () => {
    expect(arquivos("mudei o lib.rs.")).toEqual([["lib.rs", undefined, undefined]]);
  });

  it("ignores an inverted range", () => {
    expect(arquivos("a.ts:20-10")).toEqual([["a.ts", 20, undefined]]);
  });
});

describe("referenciaInteira", () => {
  it("only when the whole text is the reference", () => {
    expect(referenciaInteira("src/a.ts:12")?.linha).toBe(12);
    expect(referenciaInteira("veja src/a.ts:12")).toBeUndefined();
    expect(referenciaInteira("foo()")).toBeUndefined();
  });
});

describe("linhaLogica", () => {
  const tela = (cols: number, ...linhas: (string | [string, true])[]): LinhaDaTela[] =>
    linhas.map((l) => (typeof l === "string" ? { texto: l.padEnd(cols), quebrada: false } : { texto: l[0].padEnd(cols), quebrada: true }));

  it("joins the continuation Claude Code wrapped and indented", () => {
    const linhas = tela(30, "  Abri apps/management_console/", "  lib/data/user_repo.dart:103", "  outra coisa");
    // Upward only: the line below ("outra coisa") isn't a continuation.
    const { texto, pos } = linhaLogica(linhas, 1, 30, true, false);
    const [ref] = acharReferencias(texto);
    expect(ref.arquivo).toBe("apps/management_console/lib/data/user_repo.dart");
    expect(ref.linha).toBe(103);
    expect(pos[ref.inicio]).toEqual({ linha: 0, col: 7 });
    expect(pos[ref.fim - 1]).toEqual({ linha: 1, col: 28 });
  });

  it("without the guess, only xterm's wrap", () => {
    const linhas = tela(10, "abc/def/gh", ["i.ts:4", true]);
    expect(linhaLogica(linhas, 1, 10, false).texto).toBe("abc/def/ghi.ts:4");
    expect(linhaLogica(tela(30, "  Abri apps/management_console/", "  lib/x.dart"), 0, 30, false).texto).toBe(
      "  Abri apps/management_console/",
    );
  });

  it("doesn't join a short line or a sentence end", () => {
    expect(linhaLogica(tela(30, "curta", "  b.ts"), 0, 30, true).texto).toBe("curta");
    expect(linhaLogica(tela(30, "uma frase bem longa que acaba.", "  b.ts"), 0, 30, true).texto).toBe(
      "uma frase bem longa que acaba.",
    );
  });
});
