/// What the user pastes into the playlist, turned into something the player loads.

export type Item = {
  kind: "video" | "playlist";
  id: string;
  /// From oEmbed when it was added; the id until it arrives.
  title: string;
  /// Set by the player once it sees the video is a live stream.
  live?: boolean;
  /// Where it stopped, to resume there: seconds into the video and, in a playlist,
  /// which video. A live has none — it resumes live.
  position?: { time: number; index?: number };
};

const VIDEO_ID = /^[\w-]{11}$/;
/// Playlist ids are longer than a video's and start with a two-letter kind (PL, OL,
/// UU, FL…). Mixes (`RD…`) are generated per viewer and don't load as a playlist.
const PLAYLIST_ID = /^(?!RD)[A-Z]{2}[\w-]{10,}$/;

const HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"];

/// Accepts what YouTube gives you to copy: the video's URL, a live's, a short's, the
/// embed's, `youtu.be`, a playlist's — or the bare id. A watch link that carries a
/// `list` is the playlist: copying while a playlist plays gives you that link, and
/// the playlist is what you were listening to.
export function parseLink(raw: string): Pick<Item, "kind" | "id"> | undefined {
  const text = raw.trim();
  if (VIDEO_ID.test(text)) return { kind: "video", id: text };
  if (PLAYLIST_ID.test(text)) return { kind: "playlist", id: text };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return VIDEO_ID.test(id) ? { kind: "video", id } : undefined;
  }
  if (!HOSTS.includes(host)) return undefined;

  const list = url.searchParams.get("list");
  if (list && PLAYLIST_ID.test(list)) return { kind: "playlist", id: list };

  const v = url.searchParams.get("v");
  if (v && VIDEO_ID.test(v)) return { kind: "video", id: v };

  const m = url.pathname.match(/^\/(?:embed|live|shorts|v)\/([\w-]{11})(?:\/|$)/);
  return m ? { kind: "video", id: m[1] } : undefined;
}

/// The link oEmbed is asked about.
export function linkOf(item: Pick<Item, "kind" | "id">): string {
  return item.kind === "playlist"
    ? `https://www.youtube.com/playlist?list=${item.id}`
    : `https://www.youtube.com/watch?v=${item.id}`;
}

/// One item's identity in storage: a video and a playlist could share an id
/// only in theory, but the kind costs nothing.
export const keyOf = (item: Pick<Item, "kind" | "id">) => `${item.kind}:${item.id}`;
