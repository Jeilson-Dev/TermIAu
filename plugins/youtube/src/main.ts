/// The YouTube Radio, as a TermIAu plugin: lives, videos and playlists from the
/// user's own list, in the footer like the Radio plugin.
///
/// The sound comes from YouTube's official player (IFrame API), in a 1px iframe. The
/// player's page is NOT this window's: from the installed app's origin,
/// `tauri://localhost`, YouTube refuses the embed with error 153. The plugin's engine
/// (engine/src/main.rs) serves the page on `http://127.0.0.1`, an origin YouTube
/// accepts, and the two sides talk with `postMessage` (see engine/src/player.html).
///
/// Everything lives inside `activate`, like the Radio: deactivating has to stop the
/// sound, the engine and the timers, and one closure is what makes that complete.
import type { PluginContext, PluginProcess } from "../../../src/plugins/api";
import { texts } from "./i18n";
import { keyOf, linkOf, parseLink, type Item } from "./links";
import { KEY_CURRENT, KEY_ITEMS, KEY_PLAYING, KEY_VOLUME } from "./storage";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createYoutube(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

const stroke = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1l-7.9-5.1a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="1"/><rect x="9" y="3.5" width="3" height="9" rx="1"/></svg>`;
const ICON_LIST = stroke("M3.5 4.5h9M3.5 8h9M3.5 11.5h9");
const ICON_NEXT = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="10.7" y="3.6" width="1.7" height="8.8" rx=".85"/><path d="M3.8 4.2v7.6a.6.6 0 0 0 .92.5l5.2-3.8a.6.6 0 0 0 0-1L4.72 3.7a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICON_REMOVE = stroke("M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4");
const ICON_UP = stroke("M8 12.5v-9M4.5 7 8 3.5 11.5 7");

const VOLUME_RING = 2 * Math.PI * 5.5;
const ICON_VOLUME = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="ring" cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${VOLUME_RING}" stroke-dashoffset="${VOLUME_RING}"/><path class="mute-slash" d="M5.1 5.1l5.8 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/// The Radio's five volume stages: a click goes up one; after full, mute.
const VOLUME_STEPS = [0, 25, 50, 75, 100];
const toStep = (v: number): number =>
  VOLUME_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/// The player's states, raw: `YT.PlayerState` only exists inside the iframe.
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

/// A `ready` that never comes would leave ▶ blinking forever.
const READY_MS = 15_000;

// ---------- the spectrum ----------

/// The audio plays inside YouTube's iframe, another origin: no sample reaches this
/// page, so the display moves like the Radio's for stations without CORS — random,
/// with the same fall and peak.
const SPEC_BANDS = 10;
const SPEC_SEGMENTS = 5;
const SPEC_MS = 50;
const SPEC_FALL = 0.075;
const SPEC_PEAK_FALL = 0.014;

const random = (from: number, to: number) => from + Math.random() * (to - from);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/// What the player page reports (see engine/src/player.html).
type Report = {
  ready?: boolean;
  state?: number;
  /// What the report is about: a late one from the item before must not count
  /// for the one just loaded.
  video?: string;
  list?: string;
  title?: string;
  live?: boolean;
  index?: number;
  count?: number;
  time?: number;
  error?: number;
  apiFailed?: boolean;
};

type Command =
  | { cmd: "load"; video: string; start?: number }
  | { cmd: "load"; playlist: string; index?: number; start?: number }
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "next" }
  | { cmd: "volume"; value: number };

function createYoutube(ctx: PluginContext): () => void {
  const t = texts(ctx.language);

  function loadItems(): Item[] {
    try {
      const parsed = JSON.parse(ctx.storage.get(KEY_ITEMS) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((i) => i && (i.kind === "video" || i.kind === "playlist") && typeof i.id === "string") : [];
    } catch {
      return [];
    }
  }

  let items = loadItems();
  let current = Math.max(0, items.findIndex((i) => keyOf(i) === ctx.storage.get(KEY_CURRENT)));
  const storedVolume = Number(ctx.storage.get(KEY_VOLUME) ?? NaN);
  let volume = toStep(Number.isFinite(storedVolume) ? storedVolume : 50);

  const item = (): Item | undefined => items[current];

  function saveItems() {
    ctx.storage.set(KEY_ITEMS, JSON.stringify(items));
  }

  function saveCurrent() {
    const i = item();
    if (i) ctx.storage.set(KEY_CURRENT, keyOf(i));
  }

  // ---------- the footer controls ----------

  const root = ctx.regions.statusBar("youtube");
  root.classList.add("youtube");

  const listButton = ctx.ui.button("youtube-list", ICON_LIST, t.playlistButton);
  const playButton = ctx.ui.button("youtube-play", ICON_PLAY, t.play);
  const nextButton = ctx.ui.button("youtube-next", ICON_NEXT, t.next);
  const volumeButton = ctx.ui.button("youtube-volume", ICON_VOLUME, t.volume);
  const volumeRing = volumeButton.querySelector(".ring") as SVGCircleElement;
  const volumeSlash = volumeButton.querySelector(".mute-slash") as SVGPathElement;

  function drawVolume() {
    volumeRing.style.strokeDashoffset = String(VOLUME_RING * (1 - volume / 100));
    volumeSlash.style.display = volume > 0 ? "none" : "";
    const next = VOLUME_STEPS[(VOLUME_STEPS.indexOf(volume) + 1) % VOLUME_STEPS.length];
    volumeButton.title = t.volumeHint(volume, next);
  }

  const title = el("span", "youtube-title");
  const titleText = el("span", "youtube-title-text");
  title.appendChild(titleText);
  let titleOnAir: string | undefined;

  const spectrum = el("span", "youtube-spectrum");
  spectrum.setAttribute("aria-hidden", "true");
  const levels = new Array<number>(SPEC_BANDS).fill(0);
  const peaks = new Array<number>(SPEC_BANDS).fill(0);
  const targets = new Array<number>(SPEC_BANDS).fill(0);
  const waits = new Array<number>(SPEC_BANDS).fill(0);
  let beatIn = 0;
  const columns = Array.from({ length: SPEC_BANDS }, () => {
    const column = el("span", "youtube-spectrum-col");
    const level = el("span", "youtube-spectrum-level");
    const peak = el("span", "youtube-spectrum-peak");
    column.append(level, peak);
    spectrum.appendChild(column);
    return { level, peak };
  });

  root.append(listButton, playButton, nextButton, volumeButton, title, spectrum);

  const barHeight = (v: number) => {
    const lit = Math.round(Math.max(0, Math.min(1, v)) * SPEC_SEGMENTS);
    return lit === 0 ? 0 : lit * 3 - 1;
  };

  function stepSpectrum() {
    if (--beatIn <= 0) {
      beatIn = Math.round(random(4, 16));
      const strength = random(0.5, 1);
      const width = Math.round(random(1, 4));
      for (let b = 0; b < width; b++) targets[b] = Math.max(targets[b], strength * random(0.8, 1));
    }
    for (let b = 0; b < SPEC_BANDS; b++) {
      if (--waits[b] <= 0) {
        waits[b] = Math.round(random(1, 7));
        targets[b] = (1 - (b / SPEC_BANDS) * 0.35) * Math.random() ** random(0.6, 1.6);
      }
      levels[b] = targets[b] > levels[b] ? targets[b] : Math.max(0, levels[b] - SPEC_FALL * random(0.6, 1.4));
      peaks[b] = Math.max(levels[b], peaks[b] - SPEC_PEAK_FALL);
      targets[b] *= random(0.7, 0.9);
      const { level, peak } = columns[b];
      const high = barHeight(levels[b]);
      const peakHigh = barHeight(peaks[b]);
      level.style.height = `${high}px`;
      peak.hidden = peakHigh <= high;
      peak.style.bottom = `${Math.max(0, peakHigh - 2)}px`;
    }
  }

  let spectrumTimer: ReturnType<typeof setInterval> | undefined;

  function animateSpectrum(on: boolean) {
    if (on === (spectrumTimer !== undefined)) return;
    clearInterval(spectrumTimer);
    spectrumTimer = undefined;
    if (on) {
      spectrumTimer = setInterval(stepSpectrum, SPEC_MS);
      return;
    }
    levels.fill(0);
    peaks.fill(0);
    targets.fill(0);
    waits.fill(0);
    for (const { level, peak } of columns) {
      level.style.height = "0px";
      peak.hidden = true;
    }
  }

  // ---------- the state ----------

  let playing = false;
  let loading = false;
  /// Whether you asked for play: what tells a pause of ours from one that came from
  /// the player.
  let onAir = false;
  /// Replaces the title until the next click that works.
  let notice: string | undefined;
  /// What the player says is playing: a playlist's current video, a live's name.
  let playerTitle: string | undefined;
  /// Where in a YouTube playlist the player is, to know whether ⏭ stays inside it.
  let playlistIndex = -1;
  let playlistCount = 0;
  /// The item the player has loaded, so ▶ after ⏸ resumes instead of reloading.
  let loadedKey: string | undefined;
  let loadedLive = false;

  function draw() {
    const i = item();
    playButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    playButton.title = playing ? t.pause : t.play;
    playButton.disabled = !i;
    nextButton.disabled = !i;
    root.classList.toggle("playing", playing);
    root.classList.toggle("loading", loading && !playing);

    const text = notice ?? (onAir ? playerTitle : undefined) ?? i?.title ?? t.empty;
    if (text !== titleOnAir) {
      titleOnAir = text;
      titleText.textContent = text;
      title.title = text;
      ctx.ui.marquee(title, titleText);
    }
    animateSpectrum(playing);
  }

  // ---------- the engine and the player page ----------

  let engine: Promise<{ proc: PluginProcess; port: number }> | undefined;
  /// Titles asked of the engine, by the item's key.
  const titleRequests = new Map<string, (title: string | undefined) => void>();

  /// Started on the first ▶ or the first link pasted, not at boot: a process and a
  /// server for something you may never use this session.
  function startEngine(): Promise<{ proc: PluginProcess; port: number }> {
    if (engine) return engine;
    const started = (async () => {
      const proc = await ctx.process.spawn("engine");
      return new Promise<{ proc: PluginProcess; port: number }>((resolve, reject) => {
        proc.onMessage((m) => {
          const msg = m as { event: string; port?: number; id?: string; title?: string; error?: string; message?: string };
          if (msg.event === "listening" && msg.port) resolve({ proc, port: msg.port });
          else if (msg.event === "error") reject(new Error(msg.message));
          else if (msg.event === "title" && msg.id) {
            if (msg.error) ctx.log(`title of ${msg.id}: ${msg.error}`);
            titleRequests.get(msg.id)?.(msg.title);
            titleRequests.delete(msg.id);
          }
        });
        proc.onExit((code) => {
          ctx.log(`engine exited (${code})`);
          engine = undefined;
          frameReady = undefined;
          frame?.remove();
          frame = undefined;
          loadedKey = undefined;
          reject(new Error(`engine exited (${code})`));
          if (onAir) dropped(t.noAnswer);
        });
      });
    })();
    // A failure isn't kept: the next ▶ tries again.
    started.catch(() => (engine = undefined));
    return (engine = started);
  }

  let frame: HTMLIFrameElement | undefined;
  let frameOrigin = "";
  let frameReady: Promise<void> | undefined;
  let readyNow: (() => void) | undefined;

  function openPlayer(): Promise<void> {
    if (frameReady) return frameReady;
    const opening = (async () => {
      const { port } = await startEngine();
      frameOrigin = `http://127.0.0.1:${port}`;
      await new Promise<void>((resolve, reject) => {
        const limit = setTimeout(() => reject(new Error(t.noAnswer)), READY_MS);
        readyNow = () => {
          clearTimeout(limit);
          resolve();
        };
        frame = el("iframe", "youtube-frame");
        frame.allow = "autoplay; encrypted-media";
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        frame.src = `${frameOrigin}/`;
        document.body.appendChild(frame);
      });
    })();
    opening.catch(() => {
      frameReady = undefined;
      frame?.remove();
      frame = undefined;
    });
    return (frameReady = opening);
  }

  function send(command: Command) {
    frame?.contentWindow?.postMessage({ termiauYoutube: command }, frameOrigin);
  }

  function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow) return;
    const r = (e.data as { termiauYoutube?: Report } | null)?.termiauYoutube;
    if (!r) return;
    if (r.ready) return readyNow?.();
    if (r.apiFailed) return dropped(t.noAnswer);
    if (r.error !== undefined) return playerError(r.error);
    if (r.state === undefined) return;

    if (r.title) playerTitle = r.title;
    playlistIndex = r.index ?? -1;
    playlistCount = r.count ?? 0;
    const i = item();
    if (i && loadedKey === keyOf(i)) {
      loadedLive = !!r.live;
      // A video's title from the player beats the one oEmbed may not have sent; a
      // live gets its mark the first time it is seen live.
      if (i.kind === "video" && ((r.title && i.title === i.id) || !!r.live !== !!i.live)) {
        if (r.title && i.title === i.id) i.title = r.title;
        i.live = !!r.live || undefined;
        saveItems();
        if (picker.isOpen) drawList();
      }
    }

    // Where it is, saved as it plays and when it pauses: closing the app, switching
    // items or turning the plugin off then resumes there. Not while loading — the
    // player says 0 before it has seeked to the resume point.
    const about = i?.kind === "playlist" ? r.list : r.video;
    if (i && loadedKey === keyOf(i) && about === i.id && !r.live && r.time !== undefined && (r.state === YT_PLAYING || r.state === YT_PAUSED)) {
      i.position = { time: Math.floor(r.time), index: r.index !== undefined && r.index >= 0 ? r.index : undefined };
      saveItems();
    }

    switch (r.state) {
      case YT_PLAYING:
        playing = true;
        loading = false;
        notice = undefined;
        break;
      case YT_BUFFERING:
        loading = true;
        break;
      // A pause that didn't come from ⏸ (the media keys): the footer must know.
      case YT_PAUSED:
        onAir = false;
        playing = false;
        loading = false;
        ctx.storage.remove(KEY_PLAYING);
        break;
      case YT_ENDED:
        // Inside a YouTube playlist each video ends too, and the player goes on to
        // the next by itself: only after the last one does the list move on.
        if (i?.kind === "playlist" && playlistIndex >= 0 && playlistIndex < playlistCount - 1) break;
        playing = false;
        // Played to the end: next time it starts over.
        if (i?.position) {
          delete i.position;
          saveItems();
        }
        if (onAir) return tuneTo(current + 1);
        break;
    }
    draw();
  }
  window.addEventListener("message", onMessage);

  /// 2 bad parameter, 5 the HTML5 player failed, 100 gone or private, 101 and 150
  /// the owner doesn't allow embedding.
  function playerError(code: number) {
    ctx.log(`player error ${code}`);
    // Inside a YouTube playlist one bad video doesn't stop the rest.
    if (item()?.kind === "playlist" && playlistIndex >= 0 && playlistIndex < playlistCount - 1) return send({ cmd: "next" });
    dropped(code === 100 ? t.notFound : code === 101 || code === 150 ? t.noEmbed : t.failed(`error ${code}`));
  }

  function dropped(reason: string) {
    onAir = false;
    playing = false;
    loading = false;
    notice = reason;
    ctx.storage.remove(KEY_PLAYING);
    draw();
  }

  // ---------- playing ----------

  async function play() {
    const i = item();
    if (!i) return;
    onAir = true;
    loading = true;
    notice = undefined;
    ctx.storage.set(KEY_PLAYING, "1");
    draw();
    try {
      await openPlayer();
    } catch (e) {
      ctx.log(String(e));
      return dropped(t.failed(e instanceof Error ? e.message : String(e)));
    }
    if (!onAir || item() !== i) return;
    send({ cmd: "volume", value: volume });
    // A paused live resumes at the live edge, not where it stopped: it is a radio.
    if (loadedKey === keyOf(i) && !loadedLive) return send({ cmd: "play" });
    loadedKey = keyOf(i);
    loadedLive = !!i.live;
    playerTitle = undefined;
    playlistIndex = -1;
    playlistCount = 0;
    const start = i.live ? undefined : i.position?.time;
    send(
      i.kind === "playlist"
        ? { cmd: "load", playlist: i.id, index: i.position?.index, start }
        : { cmd: "load", video: i.id, start },
    );
  }

  function pause() {
    onAir = false;
    playing = false;
    loading = false;
    send({ cmd: "pause" });
    ctx.storage.remove(KEY_PLAYING);
    draw();
  }

  function toggle() {
    if (onAir) pause();
    else void play();
  }

  /// Inside a YouTube playlist, ⏭ goes to its next video; after its last one, and on
  /// a single video or a live, to the next item of the list.
  function next() {
    const i = item();
    if (onAir && i?.kind === "playlist" && loadedKey === keyOf(i) && playlistIndex >= 0 && playlistIndex < playlistCount - 1) {
      return send({ cmd: "next" });
    }
    tuneTo(current + 1);
  }

  /// Puts an item on air. Stopped, it is only cued: switching isn't a request to play.
  function tuneTo(i: number) {
    if (!items.length) return;
    const n = items.length;
    current = ((i % n) + n) % n;
    notice = undefined;
    saveCurrent();
    // A list of one plays it again from the start.
    loadedKey = undefined;
    if (onAir) void play();
    draw();
    if (picker.isOpen) drawList();
  }

  listButton.addEventListener("click", () => openPicker());
  playButton.addEventListener("click", toggle);
  nextButton.addEventListener("click", next);
  volumeButton.addEventListener("click", () => {
    volume = VOLUME_STEPS[(VOLUME_STEPS.indexOf(volume) + 1) % VOLUME_STEPS.length];
    send({ cmd: "volume", value: volume });
    drawVolume();
    ctx.storage.set(KEY_VOLUME, String(volume));
  });

  // ---------- the playlist ----------

  /// Opened by the footer's ☰ or YouTube ▸ My Playlist…. Paste a link and ↵ to add
  /// it; click a name to play it, ↑ to move it up, ✕ to remove it.
  const picker = ctx.ui.dialog({ title: t.playlist, className: "youtube-picker" });
  const list = el("div", "youtube-list");
  const field = el("input", "youtube-field");
  field.type = "text";
  field.placeholder = t.placeholder;
  field.spellcheck = false;
  const message = el("div", "youtube-message");
  picker.body.append(list, field, message);

  function drawList() {
    list.textContent = "";
    if (!items.length) {
      const empty = el("p", "youtube-empty");
      empty.textContent = t.emptyList;
      list.appendChild(empty);
      return;
    }
    items.forEach((it, i) => {
      const row = el("div", "youtube-row");
      row.classList.toggle("current", i === current);

      const name = el("button", "youtube-name");
      name.textContent = it.title;
      name.title = t.play_(it.title);
      name.addEventListener("click", () => {
        tuneTo(i);
        if (!onAir) void play();
      });

      const kind = el("span", "youtube-kind");
      kind.textContent = it.kind === "playlist" ? t.kindPlaylist : it.live ? t.kindLive : t.kindVideo;

      const up = ctx.ui.button("youtube-row-btn", ICON_UP, t.moveUp);
      up.disabled = i === 0;
      up.addEventListener("click", () => move(i, i - 1));

      const remove = ctx.ui.button("youtube-row-btn", ICON_REMOVE, t.remove);
      remove.addEventListener("click", () => removeAt(i));

      row.append(name, kind, up, remove);
      list.appendChild(row);
    });
    list.querySelector(".youtube-row.current")?.scrollIntoView({ block: "nearest" });
  }

  function move(from: number, to: number) {
    const onAirItem = item();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    current = onAirItem ? items.indexOf(onAirItem) : 0;
    saveItems();
    drawList();
  }

  function removeAt(i: number) {
    const removed = items[i];
    const wasCurrent = i === current;
    items.splice(i, 1);
    saveItems();
    if (wasCurrent) {
      if (onAir) pause();
      loadedKey = undefined;
      current = Math.min(i, Math.max(0, items.length - 1));
    } else if (i < current) {
      current--;
    }
    saveCurrent();
    if (!items.length) ctx.storage.remove(KEY_CURRENT);
    titleRequests.delete(keyOf(removed));
    draw();
    drawList();
  }

  function say(text: string) {
    message.textContent = text;
  }

  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const link = parseLink(field.value);
    if (!link) return say(t.notALink);
    const key = keyOf(link);
    if (items.some((i) => keyOf(i) === key)) return say(t.alreadyThere);

    const added: Item = { ...link, title: link.id };
    items.push(added);
    saveItems();
    field.value = "";
    say(t.added(added.title));
    if (items.length === 1) {
      current = 0;
      saveCurrent();
      draw();
    }
    drawList();

    // The name arrives later; until then the row shows the id.
    titleRequests.set(key, (name) => {
      if (!name || !items.includes(added)) return;
      added.title = name;
      saveItems();
      if (message.textContent === t.added(added.id)) say(t.added(name));
      draw();
      if (picker.isOpen) drawList();
    });
    startEngine()
      .then(({ proc }) => proc.send({ cmd: "title", id: key, url: linkOf(link) }))
      .catch((err) => ctx.log(`title: ${err}`));
  });

  function openPicker() {
    say("");
    picker.open();
    drawList();
    field.focus();
  }

  ctx.subscriptions.push(
    ctx.commands.register("toggle", toggle),
    ctx.commands.register("next", next),
    ctx.commands.register("playlist", openPicker),
  );

  drawVolume();
  draw();

  // `onStartupFinished`: the tabs are already open. It was on air when the app
  // closed, so it goes back on.
  if (ctx.storage.get(KEY_PLAYING) && item()) void play();

  return () => {
    // Deactivating isn't pausing: what `playing` says on disk stays, so turning the
    // plugin back on (or the next launch) resumes it.
    const wasPlaying = ctx.storage.get(KEY_PLAYING);
    onAir = false;
    animateSpectrum(false);
    window.removeEventListener("message", onMessage);
    frame?.remove();
    frame = undefined;
    void engine?.then(({ proc }) => proc.kill()).catch(() => {});
    engine = undefined;
    picker.dispose();
    if (wasPlaying) ctx.storage.set(KEY_PLAYING, wasPlaying);
    root.replaceChildren();
  };
}
