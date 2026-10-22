/// The Claude Code plugin's texts. Same rule as the app's (src/i18n): `pt` has the
/// shape of `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  ok: "OK",
  couldNotConnect: "Couldn't connect to Claude Code",
  claudeNotFound: "Claude Code not found",
  claudeNotFoundText: "The ~/.claude folder doesn't exist. Open Claude Code once and try again.",
  alreadyOn: "Already connected",
  alreadyOnText: "TermIAu's hooks are installed in Claude Code and up to date.",
  on: "Connected to Claude Code",
  onText: "It applies to Claude sessions opened from now on; the ones already running need to be restarted.",
  hasAQuestion: "Claude has a question for you.",
  asksPermission: (tool: string, what: string) => `Claude asks permission to use ${tool}${what ? `: ${what}` : "."}`,
  oneTool: "a tool",
  panelN: (n: number) => `panel ${n}`,
  alreadyAnswered: "The question was already answered.",
  sessionNoLongerOpen: "That session is no longer open in any panel.",
  sessionWaitingForYou: (name: string) =>
    `The session in ${name} is waiting for your answer in its panel - answer there and send again.`,
};

const pt: typeof en = {
  ok: "OK",
  couldNotConnect: "Não consegui ligar ao Claude Code",
  claudeNotFound: "Não achei o Claude Code",
  claudeNotFoundText: "A pasta ~/.claude não existe. Abra o Claude Code uma vez e tente de novo.",
  alreadyOn: "Já está ligado",
  alreadyOnText: "Os hooks do TermIAu estão instalados no Claude Code e em dia.",
  on: "Ligado ao Claude Code",
  onText: "Vale para as sessões do Claude abertas a partir de agora; as que já estão rodando precisam ser reiniciadas.",
  hasAQuestion: "O Claude tem uma pergunta para você.",
  asksPermission: (tool, what) => `O Claude pede permissão para usar ${tool}${what ? `: ${what}` : "."}`,
  oneTool: "uma ferramenta",
  panelN: (n) => `painel ${n}`,
  alreadyAnswered: "A pergunta já tinha sido respondida.",
  sessionNoLongerOpen: "Essa sessão não está mais aberta em nenhum painel.",
  sessionWaitingForYou: (name) =>
    `A sessão em ${name} está esperando uma resposta sua no painel - responda lá e envie de novo.`,
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
