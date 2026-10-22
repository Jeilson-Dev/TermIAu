/// The Claude model plugin's texts. Same rule as the app's (src/i18n): `pt` has the
/// shape of `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  emptyModel: "Model -",
  modelHint: (model: string) => `Session model: ${model} - click to change`,
  emptyModelHint: "Session model: arrives when Claude answers",
  effort: (level: string) => `Effort ${level}`,
  effortHint: "Claude's effort level - click to change",
  accountDefault: "Account default",
  effortLow: "low",
  effortMedium: "medium",
  effortHigh: "high",
  effortExtraHigh: "extra high",
  effortMax: "max",
  effortAuto: "auto",
  claudeWorkingSwap: "Claude is working: switch once it stops.",
};

const pt: typeof en = {
  emptyModel: "Modelo -",
  modelHint: (model) => `Modelo da sessão: ${model} - clique para trocar`,
  emptyModelHint: "Modelo da sessão: chega quando o Claude responder",
  effort: (level) => `Esforço ${level}`,
  effortHint: "Nível de esforço do Claude - clique para trocar",
  accountDefault: "Padrão da conta",
  effortLow: "baixo",
  effortMedium: "médio",
  effortHigh: "alto",
  effortExtraHigh: "extra alto",
  effortMax: "máximo",
  effortAuto: "automático",
  claudeWorkingSwap: "O Claude está trabalhando: troque quando ele parar.",
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
