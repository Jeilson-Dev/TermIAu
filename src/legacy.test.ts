import { describe, expect, it } from "vitest";
import { fromLegacy, LEGACY_SESSION, LEGACY_SETTINGS, LEGACY_VIEWER_PREF } from "./legacy";

describe("fromLegacy", () => {
  it("brings a session saved before the rename to today's names", () => {
    const old = {
      versao: 1,
      abas: [
        {
          raiz: {
            tipo: "divisao",
            eixo: "abaixo",
            fracao: 0.4,
            filhos: [
              { tipo: "folha", cwd: "/a", claude: "x" },
              { tipo: "folha", cwd: null },
            ],
          },
          foco: 1,
        },
      ],
      ativa: 0,
      fechadas: [{ painel: { tipo: "folha", cwd: "/b" }, eixo: "lado", fracao: 0.5 }],
    };
    expect(fromLegacy(old, LEGACY_SESSION)).toEqual({
      version: 1,
      tabs: [
        {
          root: {
            kind: "split",
            axis: "below",
            fraction: 0.4,
            children: [
              { kind: "leaf", cwd: "/a", claude: "x" },
              { kind: "leaf", cwd: null },
            ],
          },
          focus: 1,
        },
      ],
      active: 0,
      closed: [{ panel: { kind: "leaf", cwd: "/b" }, axis: "side", fraction: 0.5 }],
    });
  });

  it("leaves what is already new as it is, and prefers it over an old twin", () => {
    const now = { tabs: [], active: 2, closed: [] };
    expect(fromLegacy(now, LEGACY_SESSION)).toEqual(now);
    expect(fromLegacy({ contextoAtencao: 50, contextAttention: 70 }, LEGACY_SETTINGS)).toEqual({ contextAttention: 70 });
    expect(fromLegacy({ arranjo: "sobre", fatia: 0.3 }, LEGACY_VIEWER_PREF)).toEqual({ layout: "over", share: 0.3 });
    expect(fromLegacy(null, LEGACY_SESSION)).toBeNull();
  });
});
