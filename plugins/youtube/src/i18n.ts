/// The YouTube Radio's texts. Same rule as the app's (src/i18n): `pt` has the shape of
/// `en`, and a key forgotten in one language doesn't compile.
import type { Language } from "../../../src/plugins/api";

const en = {
  playlistButton: "My playlist",
  play: "Play",
  pause: "Pause",
  next: "Next",
  volume: "Volume",
  volumeHint: (current: number, next: number) =>
    `${current === 0 ? "Muted" : `Volume ${current}%`} — click for ${next === 0 ? "mute" : `${next}%`}`,
  empty: "paste a YouTube link in ☰",
  playlist: "My playlist",
  emptyList: "Nothing here yet. Paste a YouTube link below — a live, a video or a playlist.",
  placeholder: "paste a YouTube link and press ↵",
  notALink: "that isn't a YouTube video, live or playlist link",
  alreadyThere: "it's already in the list",
  added: (title: string) => `added: ${title}`,
  play_: (title: string) => `Play ${title}`,
  remove: "Remove",
  moveUp: "Move up",
  kindVideo: "video",
  kindLive: "live",
  kindPlaylist: "playlist",
  noEmbed: "this one can't play outside YouTube — try the next",
  notFound: "video not found or private",
  failed: (e: string) => `YouTube didn't start: ${e}`,
  noAnswer: "YouTube didn't answer",
};

const pt: typeof en = {
  playlistButton: "Minha playlist",
  play: "Tocar",
  pause: "Pausar",
  next: "Próximo",
  volume: "Volume",
  volumeHint: (current, next) =>
    `${current === 0 ? "Mudo" : `Volume ${current}%`} — clique para ${next === 0 ? "mudo" : `${next}%`}`,
  empty: "cole um link do YouTube no ☰",
  playlist: "Minha playlist",
  emptyList: "Nada aqui ainda. Cole um link do YouTube abaixo — uma live, um vídeo ou uma playlist.",
  placeholder: "cole um link do YouTube e tecle ↵",
  notALink: "isso não é link de vídeo, live ou playlist do YouTube",
  alreadyThere: "já está na lista",
  added: (title) => `adicionado: ${title}`,
  play_: (title) => `Tocar ${title}`,
  remove: "Remover",
  moveUp: "Subir",
  kindVideo: "vídeo",
  kindLive: "ao vivo",
  kindPlaylist: "playlist",
  noEmbed: "este não toca fora do YouTube — tente o próximo",
  notFound: "vídeo não encontrado ou privado",
  failed: (e) => `o YouTube não abriu: ${e}`,
  noAnswer: "o YouTube não respondeu",
};

export type Texts = typeof en;

export const texts = (language: Language): Texts => (language === "pt" ? pt : en);
