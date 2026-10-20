/// The footer radio, as a TermIAu plugin. It draws in its `statusBar` slot (see
/// termiau.json) and answers the Radio menu's two commands.
///
/// Everything lives inside `activate`: deactivating has to stop the sound, close
/// the Web Audio graph, stop the timers and let go of the media keys, and keeping
/// the state in one closure is what makes that complete.
import type { PluginContext } from "../../../src/plugins/api";
import { texts } from "./i18n";
import { STATIONS, type Station } from "./stations";
import { KEY_PLAYING, KEY_STATION, KEY_VOLUME } from "./storage";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createRadio(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

const stroke = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1l-7.9-5.1a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="1"/><rect x="9" y="3.5" width="3" height="9" rx="1"/></svg>`;
const ICON_STATIONS = stroke("M3.5 4.5h9M3.5 8h9M3.5 11.5h9");
const ICON_NEXT = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="10.7" y="3.6" width="1.7" height="8.8" rx=".85"/><path d="M3.8 4.2v7.6a.6.6 0 0 0 .92.5l5.2-3.8a.6.6 0 0 0 0-1L4.72 3.7a.6.6 0 0 0-.92.5Z"/></svg>`;

/// The ring has radius 5.5 in the 16 viewBox — the perimeter is the whole stroke's
/// length, and the lit fraction comes from it.
const VOLUME_RING = 2 * Math.PI * 5.5;
const ICON_VOLUME = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="ring" cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${VOLUME_RING}" stroke-dashoffset="${VOLUME_RING}"/><path class="mute-slash" d="M5.1 5.1l5.8 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/// The five volume stages. A click goes up one; after full, mute. It is
/// what fits in a 30px footer: a slider needs a long target for the
/// pointer to travel, and long is exactly what there isn't room for here.
///
/// It must be declared BEFORE anything that reads it at startup (`volume` inside
/// `createRadio`): a `const` read before its declaration throws `ReferenceError:
/// Cannot access 'VOLUME_STEPS' before initialization`, and `tsc` doesn't catch it
/// when the read happens inside a function. In the app that left the window white.
const VOLUME_STEPS = [0, 25, 50, 75, 100];

/// The stored value may be from a version where volume was continuous — or
/// any number between 0 and 100. It snaps to the nearest stage: a volume
/// off the ladder would have no way to go up a step.
const toStep = (v: number): number =>
  VOLUME_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// ---------- the spectrum analyzer ----------

/// One column per frequency band, each cut into segments like an
/// LED display, with the peak that hangs in the air and comes down on its own.
///
/// The heights are MEASURED: they come from an FFT of the audio playing, which
/// came with CORS.
const SPEC_BANDS = 10;
/// Five 2px segments with a 1px gap give exactly the strip's 14px.
const SPEC_SEGMENTS = 5;
/// The same beat as the dictation wave: ~20 frames per second.
const SPEC_MS = 50;
/// How much the level and the peak fall per frame. The peak comes down much more slowly — that is
/// what it is for, leaving in the air for an instant what has already passed. The
/// rise has no brake: the attack is what makes a display look like a VU.
const SPEC_FALL = 0.075;
const SPEC_PEAK_FALL = 0.014;
/// 2048 points at 48 kHz give ~23 Hz bins. With 512 the bins came out at ~94 Hz and
/// the first three bands all fell in the first two bins — three columns
/// showing the same thing, and the first of them showing the DC bin, which is no
/// sound at all.
const SPEC_FFT = 2048;
/// The range the display covers. Below 40 Hz is room rumble, and above
/// 16 kHz a 128 kbps MP3 keeps nothing: both ends would only waste
/// columns showing the floor.
const SPEC_HZ_MIN = 40;
const SPEC_HZ_MAX = 16_000;
/// How many dB the display covers, from the floor to the top of the column. Measured: on an
/// electronic track, each band lives about 7 dB below its own peak, and the upper ones
/// about 14. With a 16 dB scale that becomes three lit segments in the body of the
/// music and five on the peaks — a breathing display, not a wall.
const SPEC_RANGE = 16;
/// Each band's ceiling is MOVING: it rises on the peak and comes down on its own, ~1.2 dB/s. It is
/// what makes the display work for any station. A fixed ceiling doesn't exist:
/// measured on Groove Salad, the lowest band lives at -45 dB and the highest at
/// -77, and that distance changes with the genre. That was what kept everything at the top.
const SPEC_REF_FALL = 0.06;
/// But the ceiling doesn't come down forever: without a floor, the silence between tracks
/// would become infinite gain and the hiss would rise to the top.
const SPEC_REF_MIN = -58;

/// How long to wait before checking whether the graph is receiving anything.
/// Less than this catches the station still filling the buffer and condemns it for nothing.
const CHECK_MS = 3_000;

type Analyser = {
  node: AnalyserNode;
  bins: Float32Array<ArrayBuffer>;
  bands: Array<{ from: number; to: number }>;
  gain: GainNode;
  context: AudioContext;
};

const random = (from: number, to: number) => from + Math.random() * (to - from);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function createRadio(ctx: PluginContext): () => void {
  const t = texts(ctx.language);
  const stations = STATIONS;

  /// A missing key and a key with junk end up the same: the default. `Number(null)` is 0, and
  /// without the null check the volume would be born muted on the first run.
  function remembered(key: string, fallback: number, max: number): number {
    const raw = ctx.storage.get(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : fallback;
  }

  let station = Math.max(0, stations.findIndex((s) => s.url === ctx.storage.get(KEY_STATION)));
  let volume = toStep(remembered(KEY_VOLUME, 50, 100));

  const current = (): Station | undefined => stations[station];

  function saveCurrent() {
    const s = current();
    if (s) ctx.storage.set(KEY_STATION, s.url);
  }

  // ---------- the footer controls ----------

  const root = ctx.regions.statusBar("radio");
  root.classList.add("radio");

  /// Where the back arrow used to be. With two hundred and fifty stations, stepping
  /// back one at a time gets you nowhere — the list does.
  const stationsButton = ctx.ui.button("radio-stations", ICON_STATIONS, t.stationList);
  const playButton = ctx.ui.button("radio-play", ICON_PLAY, t.play);
  const nextButton = ctx.ui.button("radio-next", ICON_NEXT, t.nextStation);
  const volumeButton = ctx.ui.button("radio-volume", ICON_VOLUME, t.volume);
  const volumeRing = volumeButton.querySelector(".ring") as SVGCircleElement;
  const volumeSlash = volumeButton.querySelector(".mute-slash") as SVGPathElement;

  /// The ring lights from the top clockwise (hence the `rotate(-90)`
  /// on the icon): full is a whole turn, mute is a slash and no stroke.
  function drawVolume() {
    volumeRing.style.strokeDashoffset = String(VOLUME_RING * (1 - volume / 100));
    // `style.display`, not the `hidden` attribute: in an SVG inside HTML
    // `hidden` hides nothing without a CSS rule for it.
    volumeSlash.style.display = volume > 0 ? "none" : "";
    const next = VOLUME_STEPS[(VOLUME_STEPS.indexOf(volume) + 1) % VOLUME_STEPS.length];
    volumeButton.title = t.volumeHint(volume, next);
  }

  const title = el("span", "radio-title");
  /// The box has a fixed width; this inner one is what moves.
  const titleText = el("span", "radio-title-text");
  title.appendChild(titleText);

  /// What is written on the strip now, to know when it really changed.
  let titleOnAir: string | undefined;

  // ---------- the sound ----------

  /// There are TWO elements, not one, because Web Audio doesn't work for every
  /// station.
  ///
  /// A cross-origin source that doesn't allow CORS enters the graph zeroed — and since
  /// the graph is what talks to the speaker, it would play in silence. Measured: of the
  /// 312 probed, 249 sent `Access-Control-Allow-Origin` in the header and only
  /// 56 actually deliver samples. The header isn't enough.
  ///
  /// So a station that delivers goes through `graphAudio`, with spectrum and gain; one
  /// that doesn't goes through `directAudio`, which never enters the graph and goes
  /// straight to the speaker. One element can't be both:
  /// `createMediaElementSource` is forever, and after it the element's sound
  /// never comes out on its own again.
  const graphAudio = new Audio();
  graphAudio.crossOrigin = "anonymous";
  graphAudio.preload = "none";

  const directAudio = new Audio();
  directAudio.preload = "none";

  /// What is playing now — one of the two above.
  let audio = graphAudio;

  let playing = false;
  let loading = false;
  /// Whether you asked for play. It is what tells a stream that dropped from a `src` we
  /// removed ourselves when pausing.
  let onAir = false;
  /// No network, or station off the air: the reason takes the name's place until the next
  /// click that works. The strip fits one line, and the name can wait.
  let notice: string | undefined;

  // ---------- the spectrum ----------

  const spectrum = el("span", "radio-spectrum");
  spectrum.setAttribute("aria-hidden", "true");

  const levels = new Array<number>(SPEC_BANDS).fill(0);
  const peaks = new Array<number>(SPEC_BANDS).fill(0);
  /// Each band's ceiling, in dB. It starts at the floor: the first music that comes in
  /// raises it, and raising is immediate.
  const refs = new Array<number>(SPEC_BANDS).fill(SPEC_REF_MIN);
  const columns = Array.from({ length: SPEC_BANDS }, () => {
    const column = el("span", "radio-spectrum-col");
    const level = el("span", "radio-spectrum-level");
    const peak = el("span", "radio-spectrum-peak");
    column.append(level, peak);
    spectrum.appendChild(column);
    return { level, peak };
  });

  root.append(stationsButton, playButton, nextButton, volumeButton, title, spectrum);

  let analyser: Analyser | undefined;

  /// Web Audio is built only once, on the first ▶ — not at boot. An
  /// `AudioContext` created for nothing is born suspended and still ties the system's
  /// sound output to the page: the audio indicator would light up on a silent window.
  ///
  /// `createMediaElementSource` diverts the `<audio>` into the graph: from
  /// then on you only hear what reaches `destination`, and forgetting to connect that end
  /// is the classic way to end up with no sound at all.
  function connectAnalyser(): Analyser {
    if (analyser) return analyser;
    const context = new AudioContext();
    const node = context.createAnalyser();
    node.fftSize = SPEC_FFT;
    // The analyzer's own smoothing does half of the VU's work; the rest
    // is `SPEC_FALL`'s slow fall.
    node.smoothingTimeConstant = 0.6;

    // The volume lives here, in a gain, not in the `<audio>`'s `volume`: once the
    // element is diverted into the graph, WebKit stops applying that attribute —
    // it accepts the value, `a.volume` reports what you set and the sound comes out
    // the same.
    const gain = context.createGain();
    gain.gain.value = volume / 100;

    // The analyzer comes BEFORE the gain: the display measures the music, not how much
    // of it you chose to hear. It is any mixing desk's pre-fader metering — at
    // low volume the columns keep counting what is playing, instead of
    // dying on the floor along with the sound.
    context.createMediaElementSource(graphAudio).connect(node);
    node.connect(gain);
    gain.connect(context.destination);

    // Bands spaced in octaves, not equal parts: that is how the ear hears, and
    // in equal parts the first nine columns would all fall in the bass while
    // the last one alone would cover half the spectrum.
    const perBin = context.sampleRate / SPEC_FFT;
    const ratio = (SPEC_HZ_MAX / SPEC_HZ_MIN) ** (1 / SPEC_BANDS);
    // Each band starts where the previous one ended and has at least one bin. Without
    // both rules the first bands pile up on the same bin, because down
    // there the step in Hz is smaller than the FFT's resolution. And the start is bin
    // 1: bin 0 is the DC component, which isn't sound and doesn't move.
    let previous = 1;
    const bands = Array.from({ length: SPEC_BANDS }, (_, b) => {
      const from = Math.max(previous, Math.floor((SPEC_HZ_MIN * ratio ** b) / perBin));
      const to = Math.max(from + 1, Math.ceil((SPEC_HZ_MIN * ratio ** (b + 1)) / perBin));
      previous = to;
      return { from, to };
    });

    analyser = { node, bins: new Float32Array(node.frequencyBinCount), bands, gain, context };
    return analyser;
  }

  /// From 0..1 to the height in pixels, snapped to the segment grid: it is the
  /// step that makes the display look like LEDs and not a smooth stretching bar.
  function barHeight(v: number): number {
    const lit = Math.round(Math.max(0, Math.min(1, v)) * SPEC_SEGMENTS);
    return lit === 0 ? 0 : lit * 3 - 1;
  }

  function drawColumn(b: number) {
    const { level, peak } = columns[b];
    const high = barHeight(levels[b]);
    const peakHigh = barHeight(peaks[b]);
    level.style.height = `${high}px`;
    // The peak only shows above the bar: on top of it, it would say nothing.
    peak.hidden = peakHigh <= high;
    peak.style.bottom = `${Math.max(0, peakHigh - 2)}px`;
  }

  function stepMeasured() {
    const a = analyser;
    if (!a) return;
    // In raw dB, not `getByteFrequencyData`'s byte: that one already comes squeezed
    // into a fixed window of -100 to -30 dB, and the window is exactly what can't be
    // fixed. With the loose number, the moving ceiling down here decides the scale.
    a.node.getFloatFrequencyData(a.bins);

    for (let b = 0; b < SPEC_BANDS; b++) {
      const { from, to } = a.bands[b];
      // The band's maximum, not the average: the average of a wide treble band
      // drowns the cymbal in the silence next to it.
      let max = -Infinity;
      for (let r = from; r < to && r < a.bins.length; r++) max = Math.max(max, a.bins[r]);
      // Digital silence comes as -Infinity, which can't be compared or added.
      if (!Number.isFinite(max)) max = SPEC_REF_MIN - SPEC_RANGE;

      // The ceiling rises at once and comes down slowly. It is what gives the display the same
      // useful scale on a drone and on metal, with no genre table at all.
      refs[b] = Math.max(SPEC_REF_MIN, max > refs[b] ? max : refs[b] - SPEC_REF_FALL);
      const target = Math.max(0, Math.min(1, 1 - (refs[b] - max) / SPEC_RANGE));

      // Rises within the frame, comes down little by little.
      levels[b] = target > levels[b] ? target : Math.max(0, levels[b] - SPEC_FALL);
      peaks[b] = Math.max(levels[b], peaks[b] - SPEC_PEAK_FALL);
      drawColumn(b);
    }
  }

  /// Each band's invented targets, when there is nothing to measure, and in
  /// how many frames each one draws the next.
  const randomTargets = new Array<number>(SPEC_BANDS).fill(0);
  const randomWait = new Array<number>(SPEC_BANDS).fill(0);
  /// How many frames until the next beat, also random.
  let beatIn = 0;

  /// Through the direct path (the station doesn't let the audio be read) the display has
  /// no samples, but standing still it looked like the radio was off. So it moves
  /// fake, with no beat at all: each band draws a height and how long it
  /// stays there, and every now and then (also random) comes a beat of random
  /// strength in the bass. The rest — rising within the frame, coming down slowly, the peak in the
  /// air — is the same as the measured one.
  function stepRandom() {
    if (--beatIn <= 0) {
      beatIn = Math.round(random(4, 16));
      const strength = random(0.5, 1);
      const width = Math.round(random(1, 4));
      for (let b = 0; b < width; b++) randomTargets[b] = Math.max(randomTargets[b], strength * random(0.8, 1));
    }
    for (let b = 0; b < SPEC_BANDS; b++) {
      if (--randomWait[b] <= 0) {
        randomWait[b] = Math.round(random(1, 7));
        // The bass tends to go higher, but any band can go to the top or
        // to the floor.
        const ceiling = 1 - (b / SPEC_BANDS) * 0.35;
        randomTargets[b] = ceiling * Math.random() ** random(0.6, 1.6);
      }
      const target = randomTargets[b];
      levels[b] = target > levels[b] ? target : Math.max(0, levels[b] - SPEC_FALL * random(0.6, 1.4));
      peaks[b] = Math.max(levels[b], peaks[b] - SPEC_PEAK_FALL);
      // A target reached is dropped: without this the column stayed pinned to it.
      randomTargets[b] *= random(0.7, 0.9);
      drawColumn(b);
    }
  }

  let spectrumTimer: ReturnType<typeof setInterval> | undefined;
  let spectrumMode: "measured" | "random" | undefined;

  /// Turns the animation on and off: measured (through the graph), random (through the direct
  /// path) or none. The quick exit matters: `draw` runs on every
  /// audio event, and restarting the interval on each one would make the display move
  /// in jerks.
  function animateSpectrum(mode: "measured" | "random" | undefined) {
    if (mode === spectrumMode) return;
    spectrumMode = mode;
    clearInterval(spectrumTimer);
    spectrumTimer = undefined;
    if (mode) {
      spectrumTimer = setInterval(mode === "measured" ? stepMeasured : stepRandom, SPEC_MS);
      return;
    }
    randomTargets.fill(0);
    randomWait.fill(0);
    // Stopped, everything on the floor: a display frozen midway would look stuck.
    levels.fill(0);
    peaks.fill(0);
    refs.fill(SPEC_REF_MIN);
    for (const { level, peak } of columns) {
      level.style.height = "0px";
      peak.hidden = true;
    }
  }

  // ---------- the footer ----------

  /// The ones that promised a spectrum and came mute — this session only. The mark in
  /// `stations.ts` was measured one day; servers change configuration, and what
  /// is happening now is what rules.
  const noSpectrum = new Set<string>();

  const usesGraph = (s: Station): boolean => s.spectrum && !noSpectrum.has(s.url);

  function draw() {
    const s = current();
    playButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    playButton.title = playing ? t.pause : t.play;
    playButton.disabled = !s;
    nextButton.disabled = stations.length < 2;
    root.classList.toggle("playing", playing);
    root.classList.toggle("loading", loading && !playing);

    const text = notice ?? s?.name ?? t.noStations;
    if (text !== titleOnAir) {
      titleOnAir = text;
      titleText.textContent = text;
      title.title = text;
      ctx.ui.marquee(title, titleText);
    }

    // Through the graph the display measures the sound; through the direct path there are no samples, and
    // it moves randomly — standing still, it looked like the radio wasn't playing.
    animateSpectrum(!playing ? undefined : audio === graphAudio ? "measured" : "random");
  }

  /// Every listener on the audio elements, so deactivating can take them all off.
  const unlisten: Array<() => void> = [];

  function on<K extends keyof HTMLMediaElementEventMap>(target: HTMLMediaElement, type: K, fn: () => void) {
    target.addEventListener(type, fn);
    unlisten.push(() => target.removeEventListener(type, fn));
  }

  /// Both elements respond the same, and only the one on air has a voice: the other
  /// may be finishing letting go of its `src` and a late event from it must not
  /// touch the footer.
  function listenTo(a: HTMLAudioElement) {
    on(a, "playing", () => {
      if (a !== audio) return;
      playing = true;
      loading = false;
      notice = undefined;
      draw();
      if (a === graphAudio) checkSpectrum();
    });

    // Empty buffer midway: ▶ blinks again until the sound comes back. It isn't
    // an error — on a live radio it is just the network breathing.
    on(a, "waiting", () => {
      if (a !== audio || !onAir) return;
      loading = true;
      draw();
    });

    // A pause that didn't come from us: the keyboard's media key, macOS's
    // "Now Playing" controls. The footer must know. On the loop's next turn,
    // because swapping `src` in the middle of a `play` also comes through here, and then
    // the `play()` right behind it has already undone the pause.
    on(a, "pause", () => {
      setTimeout(() => {
        if (a !== audio || !onAir || !a.paused) return;
        pause();
      });
    });
    // And an outside play, after it: back to live, not to the point where it stopped.
    on(a, "play", () => {
      if (a !== audio || onAir) return;
      play();
    });

    on(a, "error", () => dropped(a));
    // An Icecast that closes the connection on its side arrives as end of media, not
    // as an error. On a radio, which never ends, it is the same thing.
    on(a, "ended", () => dropped(a));
  }

  listenTo(graphAudio);
  listenTo(directAudio);

  /// The station went off the air, or never opened. No mirror to fall back on: the list is
  /// of unique addresses, and what can be offered is the next one.
  function dropped(a: HTMLAudioElement) {
    // Without `onAir` this would fire on the pause's `load()`, which is an error on
    // purpose; without the element check, the one just silenced would bring down
    // the one that just came in.
    if (a !== audio || !onAir) return;
    onAir = false;
    playing = false;
    loading = false;
    notice = t.offAir;
    ctx.storage.remove(KEY_PLAYING);
    draw();
  }

  let check: ReturnType<typeof setTimeout> | undefined;

  /// Playing mute is worse than playing without a display: if the station came in through the graph and the
  /// graph receives nothing, it is demoted and restarts through the direct path. The
  /// price is about three seconds of silence, once per station per session.
  function checkSpectrum() {
    clearTimeout(check);
    check = setTimeout(() => {
      const a = analyser;
      const s = current();
      if (!a || !s || audio !== graphAudio || !playing) return;

      a.node.getFloatFrequencyData(a.bins);
      const floor = SPEC_REF_MIN - SPEC_RANGE;
      if (a.bins.some((v) => Number.isFinite(v) && v > floor)) return;

      ctx.log(`${s.name} came in mute on the graph — switching to the direct path`);
      noSpectrum.add(s.url);
      play();
    }, CHECK_MS);
  }

  /// Releases an element's socket. A paused radio would keep downloading to
  /// throw away, and a live radio has nowhere to resume from afterwards.
  function silence(a: HTMLAudioElement) {
    a.pause();
    a.removeAttribute("src");
    a.load();
  }

  /// Everything that needs the click gesture happens IN HERE, at once and with no
  /// `await` in between. WebKit only allows audio under a gesture of yours, and the gesture doesn't
  /// survive a wait: with an `await ctx.resume()` before `play()`, play
  /// lands on the other side of the click and is refused — `NotSupportedError`, which on
  /// top of that doesn't look like what it is. So `play()` goes first, synchronous, and the
  /// context is released right behind it; the result is handled when it arrives.
  function play(automatic = false) {
    const s = current();
    if (!s) return;

    onAir = true;
    loading = true;
    notice = undefined;
    ctx.storage.set(KEY_PLAYING, "1");

    // The right element for this station. If it is the other one, the one on air goes quiet
    // first — two streams playing together is what happens without this line.
    const previous = audio;
    audio = usesGraph(s) ? graphAudio : directAudio;
    if (previous !== audio) silence(previous);
    draw();

    audio.src = s.url;
    const request = audio.play();

    if (audio === graphAudio) {
      // A context born suspended comes back here; one already running doesn't
      // mind being woken up again.
      void connectAnalyser().context.resume().catch(() => {});
    } else {
      // Outside the graph there is no gain, and then the element's `volume` applies again.
      audio.volume = volume / 100;
    }

    request.catch((error: unknown) => {
      // The element's `error` handles a stream that didn't open; all that is left here is
      // the browser's own refusal.
      onAir = false;
      loading = false;
      // At launch there was no gesture, and WebKit may refuse: the radio waits for the
      // first key or click, silently, instead of erroring over something you
      // didn't ask for just now.
      if (automatic && error instanceof DOMException && error.name === "NotAllowedError") {
        ctx.storage.set(KEY_PLAYING, "1");
        silence(audio);
        draw();
        playOnFirstGesture();
        return;
      }
      ctx.storage.remove(KEY_PLAYING);
      notice = t.didNotStart(String(error));
      draw();
      ctx.log(String(error));
    });
    updateNowPlaying();
  }

  let releaseGesture: (() => void) | undefined;

  /// The gesture that unlocks audio. In the capture phase, to count even with the key going
  /// to xterm; and `play` is synchronous, so `play()` goes out inside it.
  function playOnFirstGesture() {
    releaseGesture?.();
    const go = () => {
      releaseGesture?.();
      if (!onAir && ctx.storage.get(KEY_PLAYING)) play();
    };
    window.addEventListener("keydown", go, true);
    window.addEventListener("pointerdown", go, true);
    releaseGesture = () => {
      window.removeEventListener("keydown", go, true);
      window.removeEventListener("pointerdown", go, true);
      releaseGesture = undefined;
    };
  }

  /// What macOS's "Now Playing" shows, and who answers the media keys:
  /// without the handlers, the system would pause the element on its own and the footer
  /// wouldn't know (the `pause` event above still covers that).
  function updateNowPlaying() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const s = current();
    ms.metadata = s ? new MediaMetadata({ title: s.name, artist: "TermIAu" }) : null;
    ms.playbackState = onAir ? "playing" : "paused";
  }

  function toggle() {
    if (playing) pause();
    else play();
  }

  function pause() {
    onAir = false;
    clearTimeout(check);
    silence(audio);
    playing = false;
    loading = false;
    ctx.storage.remove(KEY_PLAYING);
    draw();
    updateNowPlaying();
  }

  const mediaActions: MediaSessionAction[] = ["play", "pause", "stop", "nexttrack"];
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler("play", () => play());
    navigator.mediaSession.setActionHandler("pause", () => pause());
    navigator.mediaSession.setActionHandler("stop", () => pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => tuneTo(station + 1));
  }

  /// Puts a station on air. With the radio stopped it is only cued: switching
  /// stations isn't a request to start playing, and the address is only chosen on ▶.
  function tuneTo(i: number) {
    if (!stations.length) return;
    const n = stations.length;
    station = ((i % n) + n) % n;
    notice = undefined;
    saveCurrent();

    // While playing, the switch is immediate — and goes through `play` because the new
    // station may want the other audio path.
    if (onAir) play();
    draw();
    if (picker.isOpen) drawList();
    updateNowPlaying();
  }

  stationsButton.addEventListener("click", () => openPicker());
  nextButton.addEventListener("click", () => tuneTo(station + 1));
  playButton.addEventListener("click", toggle);

  volumeButton.addEventListener("click", () => {
    volume = VOLUME_STEPS[(VOLUME_STEPS.indexOf(volume) + 1) % VOLUME_STEPS.length];
    applyVolume();
    drawVolume();
    ctx.storage.set(KEY_VOLUME, String(volume));
  });

  /// Applies to both paths: the graph's gain and the direct element's
  /// `volume`. A short ramp on the gain instead of a jump, because `gain.value`
  /// changed at once clicks. Before the first ▶ there is no graph, and nothing to
  /// apply to it — the number is stored and goes in when the gain is built.
  function applyVolume() {
    directAudio.volume = volume / 100;
    const a = analyser;
    if (a) a.gain.gain.setTargetAtTime(volume / 100, a.context.currentTime, 0.01);
  }

  // ---------- the station picker ----------

  /// Opened by the footer's ☰ or by Radio ▸ Stations…, in the menu bar. It is a
  /// picker and nothing more: clicking a name puts the station on air, and there is nothing to
  /// add or remove. A box in the middle of the window and not a list
  /// attached to the footer because two hundred and fifty rows don't fit in a
  /// 30px strip.
  const picker = ctx.ui.dialog({ title: t.stations, className: "radio-picker" });
  const list = el("div", "radio-list");
  picker.body.append(list);

  function drawList() {
    list.textContent = "";
    stations.forEach((s, i) => {
      const row = el("div", "radio-row");
      row.classList.toggle("current", i === station);
      const name = el("button", "radio-name");
      name.textContent = s.name;
      name.title = t.playStation(s.name);
      if (s.genre) {
        const genre = el("span", "radio-genre");
        genre.textContent = t.genre(s.genre);
        name.appendChild(genre);
      }
      // The ones that play without a display get a mark, not a warning: it is a
      // small difference, and whoever is choosing a radio is choosing sound.
      if (!usesGraph(s)) {
        const mark = el("span", "radio-no-spectrum");
        mark.textContent = t.noSpectrum;
        row.appendChild(mark);
      }
      // Choosing a station while stopped is a request to play: you came here to
      // listen, not to cue. The footer's arrows are what switch without playing.
      name.addEventListener("click", () => {
        tuneTo(i);
        if (!onAir) play();
      });
      row.insertBefore(name, row.firstChild);
      list.appendChild(row);
    });
    // The one on air scrolls into view: with two hundred and fifty rows it is almost
    // always out of it, and opening the picker at the top hides the answer to the
    // question that made you open it.
    list.querySelector(".radio-row.current")?.scrollIntoView({ block: "nearest" });
  }

  function openPicker() {
    picker.open();
    drawList();
  }

  ctx.subscriptions.push(
    ctx.commands.register("toggle", toggle),
    ctx.commands.register("stations", openPicker),
  );

  drawVolume();
  draw();

  // `onStartupFinished`: the tabs are already open, so a stream that holds the page's
  // `load` can't keep them from opening (see src/startup.ts).
  if (ctx.storage.get(KEY_PLAYING)) play(true);

  return () => {
    // Deactivating isn't pausing: what `playing` says on disk stays, so turning the
    // plugin back on (or the next launch) resumes it.
    const wasPlaying = ctx.storage.get(KEY_PLAYING);
    onAir = false;
    clearTimeout(check);
    releaseGesture?.();
    animateSpectrum(undefined);
    silence(graphAudio);
    silence(directAudio);
    for (const off of unlisten.splice(0)) off();
    void analyser?.context.close().catch(() => {});
    analyser = undefined;
    if (navigator.mediaSession) {
      for (const a of mediaActions) navigator.mediaSession.setActionHandler(a, null);
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
    if (wasPlaying) ctx.storage.set(KEY_PLAYING, wasPlaying);
    root.replaceChildren();
  };
}
