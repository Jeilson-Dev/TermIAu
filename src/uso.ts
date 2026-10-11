/// As contas do uso do Claude no rodapé, sem DOM — para ter teste, como o
/// `visor.ts`. Os números vêm da status line do Claude Code, que o hook manda
/// para o app (ver o começo de hooks/termiau-evento.sh).

export type Janela = { uso: number; renova: string | null };
export type Uso = { sessao: Janela | null; semana: Janela | null };

/// "" (no ritmo), "atencao" ou "perigo".
export type Nivel = "" | "atencao" | "perigo";

/// A janela da sessão: 5 horas. A da semana: 7 dias.
export const SESSAO_MIN = 300;
export const SEMANA_MIN = 7 * 24 * 60;

/// Quanto da janela ainda falta (0 a 1). Sem data, a janela está inteira.
export function fracaoRestante(renova: string | null, janelaMin: number, agora = Date.now()): number {
  if (!renova) return 1;
  const ms = new Date(renova).getTime() - agora;
  if (Number.isNaN(ms)) return 1;
  return Math.min(1, Math.max(0, ms / (janelaMin * 60_000)));
}

/// O perigo é estar à frente do ritmo, e não o uso em si: gastou mais do que o
/// tempo que passou, e vai acabar antes de renovar. Abaixo da metade ainda há
/// folga de sobra, e fica no ritmo. É a conta do Claude Usage Monitor.
export function nivelDoRitmo(uso: number, restante: number): Nivel {
  if (uso < 50) return "";
  const deficit = uso / 100 - (1 - restante);
  if (deficit >= 0.3) return "perigo";
  if (deficit >= 0.15) return "atencao";
  return "";
}

/// Sem janela de ritmo (a semana), o nível é o do uso.
export function nivelDoUso(uso: number): Nivel {
  if (uso >= 90) return "perigo";
  if (uso >= 75) return "atencao";
  return "";
}

/// "1h53", "42min", "3d4h": quanto falta para renovar, curto para caber no rodapé.
export function faltaPara(renova: string | null, agora = Date.now()): string {
  if (!renova) return "";
  const ms = new Date(renova).getTime() - agora;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "agora";
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${String(min % 60).padStart(2, "0")}`;
  return `${min}min`;
}

/// O pedaço da status line do Claude Code com os limites: a porcentagem usada
/// de cada janela e quando ela renova, em segundos desde 1970.
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

/// O uso a partir dos limites da status line. Sem nenhum dos dois (uma conta
/// sem plano, uma versão do Claude Code que não manda), nada.
export function usoDaStatusLine(l: LimitesDaStatusLine | null | undefined): Uso | undefined {
  const sessao = janelaDaStatusLine(l?.five_hour);
  const semana = janelaDaStatusLine(l?.seven_day);
  return sessao || semana ? { sessao, semana } : undefined;
}

/// A janela como está agora. A status line só fala quando o Claude roda; uma
/// janela que já renovou desde a última notícia está zerada, e a próxima só
/// começa a contar no próximo uso.
export function janelaAgora(j: Janela | null, agora = Date.now()): Janela | null {
  if (!j?.renova) return j;
  return new Date(j.renova).getTime() <= agora ? { uso: 0, renova: null } : j;
}

/// Os limites do contexto da sessão, nas Preferências: amarelo a partir do
/// primeiro, vermelho (e o painel contornado, pulsando) a partir do segundo.
export type LimitesDoContexto = { atencao: number; perigo: number; autoCompact: boolean; autoCompactEm: number };
export const LIMITES_DO_CONTEXTO: LimitesDoContexto = { atencao: 60, perigo: 75, autoCompact: false, autoCompactEm: 76 };

const limiteValido = (n: number | undefined, padrao: number) =>
  typeof n === "number" && n >= 1 && n <= 100 ? n : padrao;

/// O nível do contexto usado. Um limite fora de 1 a 100 (o campo apagado, um
/// número digitado pela metade) vale o padrão; o vermelho vence o amarelo
/// quando os dois se cruzam.
export function nivelDoContexto(pct: number, limites: Partial<LimitesDoContexto> = {}): Nivel {
  const perigo = limiteValido(limites.perigo, LIMITES_DO_CONTEXTO.perigo);
  const atencao = limiteValido(limites.atencao, LIMITES_DO_CONTEXTO.atencao);
  if (pct >= perigo) return "perigo";
  if (pct >= atencao) return "atencao";
  return "";
}

/// A partir de quanto o auto-compact dispara, ou `null` com ele desligado. O
/// limite tem de passar do vermelho: um que não passa vale o vermelho mais um.
export function limiteDoAutoCompact(limites: Partial<LimitesDoContexto> = {}): number | null {
  if (!limites.autoCompact) return null;
  const perigo = limiteValido(limites.perigo, LIMITES_DO_CONTEXTO.perigo);
  const em = limiteValido(limites.autoCompactEm, LIMITES_DO_CONTEXTO.autoCompactEm);
  return Math.min(100, Math.max(em, perigo + 1));
}
