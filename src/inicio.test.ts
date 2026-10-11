import { describe, expect, it } from "vitest";
import { iniciar, type Passos } from "./inicio";

/// Steps that only record the order. `fontes` can be swapped to simulate the
/// stuck page.
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
  it("starts in order: fonts, events, tabs, the rest and the radio last", async () => {
    const feitos: string[] = [];
    await iniciar(passos(feitos));
    expect(feitos).toEqual(["fontes", "ligar", "abrirAbas", "depois", "retomarRadio"]);
  });

  it("the radio doesn't hold the tabs: fonts are only ready with no stream loading on the page", async () => {
    // The bug: a loading stream holds the page's `load`, and
    // `document.fonts.ready` never resolves. Here, the fonts only become
    // ready if the radio hasn't started yet.
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

  it("waits for each async step to finish before the next", async () => {
    const feitos: string[] = [];
    const devagar = (nome: string) => () =>
      new Promise<void>((ok) => setTimeout(() => (feitos.push(nome), ok()), 5));
    await iniciar(passos(feitos, { fontes: devagar("fontes"), ligar: devagar("ligar"), abrirAbas: devagar("abrirAbas") }));
    expect(feitos).toEqual(["fontes", "ligar", "abrirAbas", "depois", "retomarRadio"]);
  });

  it("no tabs, no radio: a failure opening the tabs stops the startup", async () => {
    const feitos: string[] = [];
    const p = passos(feitos, { abrirAbas: () => Promise.reject(new Error("pty")) });
    await expect(iniciar(p)).rejects.toThrow("pty");
    expect(feitos).toEqual(["fontes", "ligar"]);
  });
});
