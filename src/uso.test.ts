import { describe, expect, it } from "vitest";
import { faltaPara, fracaoRestante, janelaAgora, limiteDoAutoCompact, nivelDoRitmo, nivelDoContexto, nivelDoUso, usoDaStatusLine } from "./uso";

const agora = Date.parse("2026-10-09T12:00:00Z");
const daqui = (min: number) => new Date(agora + min * 60_000).toISOString();

describe("uso", () => {
  it("mede quanto da janela falta", () => {
    expect(fracaoRestante(daqui(150), 300, agora)).toBe(0.5);
    expect(fracaoRestante(daqui(-5), 300, agora)).toBe(0);
    expect(fracaoRestante(null, 300, agora)).toBe(1);
  });

  it("acende pelo ritmo, e não pelo uso", () => {
    // 60% gastos com 60% da janela passada: no ritmo.
    expect(nivelDoRitmo(60, 0.4)).toBe("");
    // 60% gastos com 20% passados: vai acabar antes.
    expect(nivelDoRitmo(60, 0.8)).toBe("perigo");
    expect(nivelDoRitmo(60, 0.6)).toBe("atencao");
    expect(nivelDoRitmo(40, 1)).toBe("");
  });

  it("na semana, pelo uso", () => {
    expect(nivelDoUso(74)).toBe("");
    expect(nivelDoUso(80)).toBe("atencao");
    expect(nivelDoUso(95)).toBe("perigo");
  });

  it("diz quanto falta, curto", () => {
    expect(faltaPara(daqui(113), agora)).toBe("1h53");
    expect(faltaPara(daqui(42), agora)).toBe("42min");
    expect(faltaPara(daqui(60 * 76), agora)).toBe("3d4h");
    expect(faltaPara(daqui(-1), agora)).toBe("agora");
  });
});

describe("usoDaStatusLine", () => {
  it("lê os limites que o Claude Code manda", () => {
    const u = usoDaStatusLine({
      five_hour: { used_percentage: 42, resets_at: agora / 1000 + 3600 },
      seven_day: { used_percentage: 18 },
    });
    expect(u?.sessao).toEqual({ uso: 42, renova: daqui(60) });
    expect(u?.semana).toEqual({ uso: 18, renova: null });
  });

  it("sem limites, nada", () => {
    expect(usoDaStatusLine(undefined)).toBeUndefined();
    expect(usoDaStatusLine({ five_hour: null })).toBeUndefined();
  });

  it("uma janela que já renovou volta zerada", () => {
    expect(janelaAgora({ uso: 80, renova: daqui(-1) }, agora)).toEqual({ uso: 0, renova: null });
    expect(janelaAgora({ uso: 80, renova: daqui(5) }, agora)).toEqual({ uso: 80, renova: daqui(5) });
  });
});

describe("nivelDoContexto", () => {
  it("amarelo e vermelho pelos limites", () => {
    expect(nivelDoContexto(59)).toBe("");
    expect(nivelDoContexto(60)).toBe("atencao");
    expect(nivelDoContexto(75)).toBe("perigo");
    expect(nivelDoContexto(50, { atencao: 40, perigo: 50 })).toBe("perigo");
    expect(nivelDoContexto(45, { atencao: 40, perigo: 50 })).toBe("atencao");
  });

  it("limite inválido vale o padrão", () => {
    expect(nivelDoContexto(70, { atencao: 0, perigo: Number.NaN })).toBe("atencao");
    expect(nivelDoContexto(80, { perigo: 200 })).toBe("perigo");
  });

  it("o vermelho vence quando os limites se cruzam", () => {
    expect(nivelDoContexto(70, { atencao: 80, perigo: 70 })).toBe("perigo");
  });
});

describe("limiteDoAutoCompact", () => {
  it("desligado não tem limite", () => {
    expect(limiteDoAutoCompact()).toBeNull();
    expect(limiteDoAutoCompact({ autoCompact: false, autoCompactEm: 80 })).toBeNull();
  });

  it("ligado usa o valor, ou o padrão de 76", () => {
    expect(limiteDoAutoCompact({ autoCompact: true })).toBe(76);
    expect(limiteDoAutoCompact({ autoCompact: true, autoCompactEm: 90 })).toBe(90);
  });

  it("tem de passar do vermelho", () => {
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 75, autoCompactEm: 70 })).toBe(76);
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 85, autoCompactEm: 76 })).toBe(86);
    expect(limiteDoAutoCompact({ autoCompact: true, perigo: 100, autoCompactEm: 90 })).toBe(100);
  });
});
