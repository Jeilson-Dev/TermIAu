/// The dictation's texts. Same rule as the app's (src/i18n): `pt` has the shape of
/// `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  listening: "listening…",
  sendsIn: (s: number) => `↵ in ${s}s — type to cancel`,
  turnedOff: "listening off — a minute without speaking (⌘E to resume)",
  downloadingModel: "downloading the transcription model (466 MB), only once…",
  downloadingModelPct: (pct: number) => `downloading the transcription model… ${pct}%`,
  couldNotListen: (e: string) => `couldn't listen: ${e}`,
  listeningError: (e: string) => `listening error: ${e}`,
  engineStopped: "the transcription engine stopped",
};

const pt: typeof en = {
  listening: "escutando…",
  sendsIn: (s) => `↵ em ${s}s — digite para cancelar`,
  turnedOff: "escuta desligada — um minuto sem falar (⌘E para voltar)",
  downloadingModel: "baixando o modelo de transcrição (466 MB), uma vez só…",
  downloadingModelPct: (pct) => `baixando o modelo de transcrição… ${pct}%`,
  couldNotListen: (e) => `não consegui escutar: ${e}`,
  listeningError: (e) => `erro na escuta: ${e}`,
  engineStopped: "o motor de transcrição parou",
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
