/// The math for Claude's usage in the footer, without DOM — so it can be tested, like
/// `visor.ts`. The numbers come from Claude Code's status line, which the hook sends
/// to the app (see the start of hooks/termiau-evento.sh).

import { T } from "./i18n/terminal";

export type Janela = { uso: number; renova: string | null };
export type Uso = { sessao: Janela | null; semana: Janela | null };

/// "" (on pace), "atencao" or "perigo".
export type Nivel = "" | "atencao" | "perigo";

/// The session window: 5 hours. The week's: 7 days.
export const SESSAO_MIN = 300;
export const SEMANA_MIN = 7 * 24 * 60;

/// How much of the window is still left (0 to 1). Without a date, the window is whole.
export function fracaoRestante(renova: string | null, janelaMin: number, agora = Date.now()): number {
  if (!renova) return 1;
  const ms = new Date(renova).getTime() - agora;
  if (Number.isNaN(ms)) return 1;
  return Math.min(1, Math.max(0, ms / (janelaMin * 60_000)));
}

/// The danger is being ahead of pace, not the usage itself: spent more than the
/// time that passed, and it will run out before renewing. Below half there is still
/// plenty of slack, and it stays on pace. It is Claude Usage Monitor's math.
export function nivelDoRitmo(uso: number, restante: number): Nivel {
  if (uso < 50) return "";
  const deficit = uso / 100 - (1 - restante);
  if (deficit >= 0.3) return "perigo";
  if (deficit >= 0.15) return "atencao";
  return "";
}

/// Without a pace window (the week), the level is the usage's.
export function nivelDoUso(uso: number): Nivel {
  if (uso >= 90) return "perigo";
  if (uso >= 75) return "atencao";
  return "";
}

/// "1h53", "42min", "3d4h": how long until it renews, short enough to fit in the footer.
export function faltaPara(renova: string | null, agora = Date.now()): string {
  if (!renova) return "";
  const ms = new Date(renova).getTime() - agora;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return T.agora;
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${String(min % 60).padStart(2, "0")}`;
  return `${min}min`;
}

/// The part of Claude Code's status line with the limits: the percentage used
/// of each window and when it renews, in seconds since 1970.
export type LimitesDaStatusLine = {
  five_hour?: { used_percentage?: number; resets_at?: number } | null;
  seven_day?: { used_percentage?: number; resets_at?: number } | null;
};

function janelaDaStatusLine(j: { used_percentage?: number; resets_at?: number } | null | undefined): Janela | null {
  if (!j || typeof j.used_percentage !== "number") return null;
  return {
    uso: j.used_percentage,
    renova: typeof j.resets_at === "number" ? new Date(j.resets_at * 1000).toISOString() : null,
  };
}

/// Usage from the status line's limits. With neither of them (an account
/// without a plan, a Claude Code version that doesn't send them), nothing.
export function usoDaStatusLine(l: LimitesDaStatusLine | null | undefined): Uso | undefined {
  const sessao = janelaDaStatusLine(l?.five_hour);
  const semana = janelaDaStatusLine(l?.seven_day);
  return sessao || semana ? { sessao, semana } : undefined;
}

/// The window as it is now. The status line only speaks when Claude runs; a
/// window that renewed since the last news is at zero, and the next one only
/// starts counting on the next use.
export function janelaAgora(j: Janela | null, agora = Date.now()): Janela | null {
  if (!j?.renova) return j;
  return new Date(j.renova).getTime() <= agora ? { uso: 0, renova: null } : j;
}

/// The session's context limits, in Preferences: yellow from the
/// first, red (and the panel outlined, pulsing) from the second.
export type LimitesDoContexto = { atencao: number; perigo: number; autoCompact: boolean; autoCompactEm: number };
export const LIMITES_DO_CONTEXTO: LimitesDoContexto = { atencao: 60, perigo: 75, autoCompact: false, autoCompactEm: 76 };

const limiteValido = (n: number | undefined, padrao: number) =>
  typeof n === "number" && n >= 1 && n <= 100 ? n : padrao;

/// The level of context used. A limit outside 1 to 100 (the field cleared, a
/// half-typed number) gets the default; red beats yellow
/// when the two cross.
export function nivelDoContexto(pct: number, limites: Partial<LimitesDoContexto> = {}): Nivel {
  const perigo = limiteValido(limites.perigo, LIMITES_DO_CONTEXTO.perigo);
  const atencao = limiteValido(limites.atencao, LIMITES_DO_CONTEXTO.atencao);
  if (pct >= perigo) return "perigo";
  if (pct >= atencao) return "atencao";
  return "";
}

/// From how much auto-compact fires, or `null` when it is off. The
/// limit must exceed red: one that doesn't gets red plus one.
export function limiteDoAutoCompact(limites: Partial<LimitesDoContexto> = {}): number | null {
  if (!limites.autoCompact) return null;
  const perigo = limiteValido(limites.perigo, LIMITES_DO_CONTEXTO.perigo);
  const em = limiteValido(limites.autoCompactEm, LIMITES_DO_CONTEXTO.autoCompactEm);
  return Math.min(100, Math.max(em, perigo + 1));
}
