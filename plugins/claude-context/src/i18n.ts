/// The Claude context plugin's texts. Same rule as the app's (src/i18n): `pt` has the
/// shape of `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  emptyContext: "Context -",
  emptyContextHint: "Session context: arrives when Claude answers - click to compact (⌘⇧K)",
  context: (pct: number) => `Context ${pct}%`,
  contextHint: (pct: number) => `Session context: ${pct}% used, ${100 - pct}% free - click to compact (⌘⇧K)`,
  claudeWorkingCompact: "Claude is working: compact once it stops.",
  compactingAlone: (pct: number) => `Context at ${pct}%: compacting automatically.`,
};

const pt: typeof en = {
  emptyContext: "Contexto -",
  emptyContextHint: "Contexto da sessão: chega quando o Claude responder - clique para compactar (⌘⇧K)",
  context: (pct) => `Contexto ${pct}%`,
  contextHint: (pct) => `Contexto da sessão: ${pct}% usado, ${100 - pct}% livre - clique para compactar (⌘⇧K)`,
  claudeWorkingCompact: "O Claude está trabalhando: compacte quando ele parar.",
  compactingAlone: (pct) => `Contexto em ${pct}%: compactando sozinho.`,
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
