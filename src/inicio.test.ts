import { describe, expect, it } from "vitest";
import { iniciar, type Passos } from "./inicio";

/// Passos que só anotam a ordem. `fontes` pode ser trocado para simular a
/// página presa.
function passos(feitos: string[], extra: Partial<Passos> = {}): Passos {
  return {
    fontes: async () => void feitos.push("fontes"),
    ligar: async () => void feitos.push("ligar"),
    abrirAbas: async () => void feitos.push("abrirAbas"),
    depois: () => void feitos.push("depois"),
    retomarRadio: () => void feitos.push("retomarRadio"),
    ...extra,
  };
}

describe("iniciar", () => {
  it("sobe na ordem: fontes, eventos, abas, o resto e a rádio por último", async () => {
    const feitos: string[] = [];
    await iniciar(passos(feitos));
    expect(feitos).toEqual(["fontes", "ligar", "abrirAbas", "depois", "retomarRadio"]);
  });

  it("a rádio não segura as abas: as fontes só ficam prontas com a página sem stream carregando", async () => {
    // O bug: um stream carregando segura o `load` da página, e o
    // `document.fonts.ready` não resolve nunca. Aqui, as fontes só ficam
    // prontas se a rádio ainda não começou.
    const feitos: string[] = [];
    let radio = false;
    const p = passos(feitos, {
      fontes: () => (radio ? new Promise(() => {}) : Promise.resolve()),
      retomarRadio: () => {
        radio = true;
        feitos.push("retomarRadio");
      },
    });
    await iniciar(p);
    expect(feitos).toContain("abrirAbas");
    expect(feitos.indexOf("abrirAbas")).toBeLessThan(feitos.indexOf("retomarRadio"));
  });

  it("espera cada passo assíncrono terminar antes do próximo", async () => {
    const feitos: string[] = [];
    const devagar = (nome: string) => () =>
      new Promise<void>((ok) => setTimeout(() => (feitos.push(nome), ok()), 5));
    await iniciar(passos(feitos, { fontes: devagar("fontes"), ligar: devagar("ligar"), abrirAbas: devagar("abrirAbas") }));
    expect(feitos).toEqual(["fontes", "ligar", "abrirAbas", "depois", "retomarRadio"]);
  });

  it("sem abas, sem rádio: uma falha ao abrir as abas para a subida", async () => {
    const feitos: string[] = [];
    const p = passos(feitos, { abrirAbas: () => Promise.reject(new Error("pty")) });
    await expect(iniciar(p)).rejects.toThrow("pty");
    expect(feitos).toEqual(["fontes", "ligar"]);
  });
});
