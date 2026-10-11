import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definirIdioma, idioma } from "./i18n";
import { faltaPara, fracaoRestante, janelaAgora, limiteDoAutoCompact, nivelDoRitmo, nivelDoContexto, nivelDoUso, usoDaStatusLine } from "./uso";

// The texts expected here are the Portuguese ones.
const inicial = idioma();
beforeEach(() => definirIdioma("pt"));
afterEach(() => definirIdioma(inicial));

const agora = Date.parse("2026-10-09T12:00:00Z");
const daqui = (min: number) => new Date(agora + min * 60_000).toISOString();

describe("uso", () => {
  it("measures how much of the window is left", () => {
    expect(fracaoRestante(daqui(150), 300, agora)).toBe(0.5);
    expect(fracaoRestante(daqui(-5), 300, agora)).toBe(0);
    expect(fracaoRestante(null, 300, agora)).toBe(1);
  });

  it("lights up by pace, not by usage", () => {
    // 60% spent with 60% of the window gone: on pace.
    expect(nivelDoRitmo(60, 0.4)).toBe("");
    // 60% spent with 20% gone: it will run out early.
    expect(nivelDoRitmo(60, 0.8)).toBe("perigo");
    expect(nivelDoRitmo(60, 0.6)).toBe("atencao");
    expect(nivelDoRitmo(40, 1)).toBe("");
  });

  it("for the week, by usage", () => {
    expect(nivelDoUso(74)).toBe("");
    expect(nivelDoUso(80)).toBe("atencao");
    expect(nivelDoUso(95)).toBe("perigo");
  });

  it("says how long is left, briefly", () => {
    expect(faltaPara(daqui(113), agora)).toBe("1h53");
    expect(faltaPara(daqui(42), agora)).toBe("42min");
    expect(faltaPara(daqui(60 * 76), agora)).toBe("3d4h");
    expect(faltaPara(daqui(-1), agora)).toBe("agora");
  });
});

describe("usoDaStatusLine", () => {
  it("reads the limits Claude Code sends", () => {
    const u = usoDaStatusLine({
      five_hour: { used_percentage: 42, resets_at: agora / 1000 + 3600 },
      seven_day: { used_percentage: 18 },
    });
    expect(u?.sessao).toEqual({ uso: 42, renova: daqui(60) });
    expect(u?.semana).toEqual({ uso: 18, renova: null });
  });

  it("no limits, nothing", () => {
    expect(usoDaStatusLine(undefined)).toBeUndefined();
    expect(usoDaStatusLine({ five_hour: null })).toBeUndefined();
  });

  it("a window that already renewed comes back at zero", () => {
    expect(janelaAgora({ uso: 80, renova: daqui(-1) }, agora)).toEqual({ uso: 0, renova: null });
    expect(janelaAgora({ uso: 80, renova: daqui(5) }, agora)).toEqual({ uso: 80, renova: daqui(5) });
  });
});

describe("nivelDoContexto", () => {
  it("yellow and red by the limits", () => {
    expect(nivelDoContexto(59)).toBe("");
    expect(nivelDoContexto(60)).toBe("atencao");
    expect(nivelDoContexto(75)).toBe("perigo");
    expect(nivelDoContexto(50, { atencao: 40, perigo: 50 })).toBe("perigo");
    expect(nivelDoContexto(45, { atencao: 40, perigo: 50 })).toBe("atencao");
  });

  it("an invalid limit gets the default", () => {
    expect(nivelDoContexto(70, { atencao: 0, perigo: Number.NaN })).toBe("atencao");
    expect(nivelDoContexto(80, { perigo: 200 })).toBe("perigo");
  });

  it("red wins when the limits cross", () => {
    expect(nivelDoContexto(70, { atencao: 80, perigo: 70 })).toBe("perigo");
  });
});

describe("limiteDoAutoCompact", () => {
  it("off has no limit", () => {
    expect(limiteDoAutoCompact()).toBeNull();
    expect(limiteDoAutoCompact({ autoCompact: false, autoCompactEm: 80 })).toBeNull();
  });

  it("on uses the value, or the default of 76", () => {
    expect(limiteDoAutoCompact({ autoCompact: true })).toBe(76);
    expect(limiteDoAutoCompact({ autoCompact: true, autoCompactEm: 90 })).toBe(90);
  });

  it("must exceed red", () => {
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 75, autoCompactEm: 70 })).toBe(76);
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 85, autoCompactEm: 76 })).toBe(86);
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 100, autoCompactEm: 90 })).toBe(100);
  });
});
