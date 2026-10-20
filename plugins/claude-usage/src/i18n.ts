/// The Claude usage plugin's texts. Same rule as the app's (src/i18n): `pt` has the
/// shape of `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  now: "now",
  timeLeft: "Time left",
  availableTokens: "Tokens available",
  session: "Session",
  week: "Week",
  noWindow: (name: string) => `${name}:\nno open window`,
  usageHint: (name: string, pct: number, missing: string) =>
    `${name}:\n${pct}% of tokens available\n${missing} of time left`,
};

const pt: typeof en = {
  now: "agora",
  timeLeft: "Tempo restante",
  availableTokens: "Tokens disponíveis",
  session: "Sessão",
  week: "Semana",
  noWindow: (name) => `${name}:\nsem janela aberta`,
  usageHint: (name, pct, missing) => `${name}:\n${pct}% de tokens disponíveis\n${missing} de tempo restante`,
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
