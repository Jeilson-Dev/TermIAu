/// The radio's texts. Same rule as the app's (src/i18n): `pt` has the shape of
/// `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

/// The stations' genres are in English in `stations.ts`.
const GENRES_PT: Record<string, string> = {
  "ambient · lo-fi": "ambient · lo-fi",
  "campus · public": "campus · pública",
  "classical · opera": "clássica · ópera",
  electronic: "eletrônica",
  experimental: "experimental",
  "funk · soul · hip-hop": "funk · soul · hip-hop",
  "games · chiptune": "games · chiptune",
  independent: "independente",
  "jazz · blues": "jazz · blues",
  metal: "metal",
  "news · talk": "notícias · falado",
  oldies: "oldies",
  "reggae · dub": "reggae · dub",
  "rock · indie · folk": "rock · indie · folk",
  "world · regional": "world · regional",
};

const en = {
  stationList: "Stations (list)",
  play: "Play",
  pause: "Pause",
  nextStation: "Next station",
  volume: "Volume",
  volumeHint: (current: number, next: number) =>
    `${current === 0 ? "Muted" : `Volume ${current}%`} - click for ${next === 0 ? "mute" : `${next}%`}`,
  noStations: "no stations",
  offAir: "station off the air - try the next one",
  didNotStart: (e: string) => `the radio didn't start: ${e}`,
  stations: "Stations",
  playStation: (name: string) => `Play ${name}`,
  noSpectrum: "no spectrum",
  genre: (g: string) => g,
};

const pt: typeof en = {
  stationList: "Estações (lista)",
  play: "Tocar",
  pause: "Pausar",
  nextStation: "Próxima estação",
  volume: "Volume",
  volumeHint: (current, next) =>
    `${current === 0 ? "Mudo" : `Volume ${current}%`} - clique para ${next === 0 ? "mudo" : `${next}%`}`,
  noStations: "sem estações",
  offAir: "estação fora do ar - tente a próxima",
  didNotStart: (e) => `a rádio não abriu: ${e}`,
  stations: "Estações",
  playStation: (name) => `Tocar ${name}`,
  noSpectrum: "sem espectro",
  genre: (g) => GENRES_PT[g] ?? g,
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
