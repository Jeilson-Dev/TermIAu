/// The Claude Code plugin's texts. Same rule as the app's (src/i18n): `pt` has the
/// shape of `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  ok: "OK",
  notSigned: "Claude Code only works as the copy signed by TermIAu",
  couldNotConnect: "Couldn't connect to Claude Code",
  claudeNotFound: "Claude Code not found",
  claudeNotFoundText: "The ~/.claude folder doesn't exist. Open Claude Code once and try again.",
  alreadyOn: "Already connected",
  alreadyOnText: "TermIAu's hooks are installed in Claude Code and up to date.",
  on: "Connected to Claude Code",
  onText: "It applies to Claude sessions opened from now on; the ones already running need to be restarted.",
};

const pt: typeof en = {
  ok: "OK",
  notSigned: "o Claude Code só funciona na cópia assinada pelo TermIAu",
  couldNotConnect: "Não consegui ligar ao Claude Code",
  claudeNotFound: "Não achei o Claude Code",
  claudeNotFoundText: "A pasta ~/.claude não existe. Abra o Claude Code uma vez e tente de novo.",
  alreadyOn: "Já está ligado",
  alreadyOnText: "Os hooks do TermIAu estão instalados no Claude Code e em dia.",
  on: "Ligado ao Claude Code",
  onText: "Vale para as sessões do Claude abertas a partir de agora; as que já estão rodando precisam ser reiniciadas.",
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
