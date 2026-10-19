/// Dictation, as a TermIAu plugin: speak instead of typing. The microphone and the
/// transcription live in a native engine (engine/, the `engine` binary in
/// termiau.json) that the app runs for this plugin; this side draws the footer —
/// the wave and the partial text —, types each finished sentence into the focused
/// panel and sends it with Enter after a pause.
///
/// Everything lives inside `activate`, so deactivating stops it all: the engine
/// process goes with the plugin's subscriptions.
import type { Panel, PluginContext, PluginProcess } from "../../../src/plugins/api";
import { texts } from "./i18n";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createDictation(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

/// After you stop speaking, the dictation goes on its own.
const SEND_DELAY_MS = 5000;
/// Above this the microphone peak counts as speech: it is what the wave draws and
/// what holds the Enter countdown while you are still speaking.
const SPEECH_THRESHOLD = 0.1;
/// While the last syllable is recent, the strip shows the partial and not the
/// countdown — otherwise the two would fight over the same line every 200 ms.
const PARTIAL_RULES_MS = 800;
/// An open microphone with nobody speaking is battery and privacy going away, and
/// an Enter waiting for a sentence that won't come anymore. One minute of silence and
/// dictation turns itself off — ⌘E brings it back.
const IDLE_MS = 60_000;
/// One instant per little bar: at ~20 levels per second, it is a bit more than a
/// second of history on screen. New ones come in from the right.
const WAVE_BARS = 22;
/// Silence doesn't erase the wave: a thin line still says "I'm open".
const WAVE_MIN = 0.06;

/// What the engine prints, one JSON object per line (see engine/src/main.rs).
type EngineEvent =
  | { event: "modelReady"; ready: boolean }
  | { event: "progress"; value: number }
  | { event: "downloaded" }
  | { event: "started" }
  | { event: "level"; value: number }
  | { event: "partial"; text: string }
  | { event: "final"; text: string }
  | { event: "status"; value: "listening" | "stopped" }
  | { event: "error"; message: string };

function createDictation(ctx: PluginContext): () => void {
  const t = texts(ctx.language);

  // ---------- the strip ----------

  const root = ctx.regions.statusBar("dictation");
  root.classList.add("dictation");
  const wave = document.createElement("span");
  wave.className = "dictation-wave";
  wave.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "dictation-text";
  root.append(wave, text);

  const levels = new Array<number>(WAVE_BARS).fill(0);
  const bars = Array.from({ length: WAVE_BARS }, () => {
    const bar = document.createElement("span");
    wave.appendChild(bar);
    return bar;
  });

  function pushWave(level: number) {
    levels.shift();
    levels.push(level);
    for (let i = 0; i < WAVE_BARS; i++) {
      // A gain that makes normal speech fill the strip without clipping.
      const height = Math.max(WAVE_MIN, Math.min(1, levels[i] * 3.2));
      bars[i].style.transform = `scaleY(${height})`;
    }
  }

  function clearWave() {
    levels.fill(0);
    for (const bar of bars) bar.style.transform = `scaleY(${WAVE_MIN})`;
  }

  /// The strip fits one line. Showing the start of a long sentence would hide
  /// precisely what you just said, so it cuts from the front.
  function show(message: string) {
    text.textContent = message.length > 140 ? `…${message.slice(-140)}` : message;
  }

  /// Silences the strip. Its space stays: what goes away is the content, not the line.
  function hide() {
    // A countdown in progress is the most important thing on screen: an Enter is on
    // its way to a shell, and erasing the notice is worse than it staying one more second.
    if (pending) return;
    text.textContent = "";
    root.classList.remove("listening");
    clearWave();
  }

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  // ---------- auto-send ----------

  /// The scheduled Enter: the panel that got the dictation and when it goes.
  let pending: { panel: Panel; at: number } | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined;
  let lastSpeech = 0;

  function stopPulse() {
    clearInterval(pulse);
    pulse = undefined;
  }

  /// Who rules the strip: while the last syllable is recent, the partial; from
  /// then on, the countdown. Both sides ask the SAME thing — if each one
  /// decided on its own, the partial (which arrives even in silence, sometimes empty)
  /// and the 200 ms pulse would write over each other and the line would flicker.
  const partialRules = () => !pending || Date.now() - lastSpeech <= PARTIAL_RULES_MS;

  /// Closes the strip, or goes back to the partial, depending on whether the microphone is open.
  function endCountdown() {
    stopPulse();
    if (listening) show(t.listening);
    else hide();
  }

  function scheduleSend(panel: Panel) {
    pending = { panel, at: Date.now() + SEND_DELAY_MS };
    if (!pulse) pulse = setInterval(tick, 200);
  }

  /// Started speaking again: the Enter waits.
  function postponeSend() {
    if (pending) pending.at = Date.now() + SEND_DELAY_MS;
  }

  /// The keyboard has the last word, and cancels for good. Counting again requires speaking
  /// again: rescheduling on the microphone's first peak would undo the choice of whoever
  /// just decided to type.
  function cancelSend() {
    if (!pending) return;
    pending = undefined;
    endCountdown();
  }

  function tick() {
    if (!pending) return stopPulse();

    // The panel may have closed in the middle of the countdown.
    if (!pending.panel.isAlive()) {
      pending = undefined;
      return endCountdown();
    }

    const left = pending.at - Date.now();
    if (left > 0) {
      if (!partialRules()) show(t.sendsIn(Math.ceil(left / 1000)));
      return;
    }

    const { panel } = pending;
    pending = undefined;
    panel.write("\r");
    endCountdown();
  }

  ctx.subscriptions.push(ctx.terminal.onUserInput(cancelSend));

  // ---------- the engine ----------

  let engine: PluginProcess | undefined;
  let listening = false;
  /// Holds off a second ⌘E while the engine starts or the model downloads.
  let preparing = false;
  /// The one reply `ask` is waiting for, and its kinds.
  let waiting: { kinds: string[]; resolve(e: EngineEvent): void } | undefined;

  /// Sends a command and waits for one of `kinds` (or an error) back.
  function ask(cmd: string, kinds: string[]): Promise<EngineEvent> {
    return new Promise((resolve) => {
      waiting = { kinds, resolve };
      engine!.send({ cmd });
    });
  }

  async function ensureEngine(): Promise<PluginProcess> {
    if (engine) return engine;
    const proc = await ctx.process.spawn("engine");
    proc.onMessage((m) => onEvent(m as EngineEvent));
    proc.onExit(() => {
      engine = undefined;
      if (listening) {
        listening = false;
        stopWatch();
        root.classList.remove("listening");
        clearWave();
        show(t.listeningError(t.engineStopped));
        later(hide, 4000);
      }
    });
    engine = proc;
    return proc;
  }

  function onEvent(e: EngineEvent) {
    if (waiting && (waiting.kinds.includes(e.event) || e.event === "error")) {
      const w = waiting;
      waiting = undefined;
      w.resolve(e);
      return;
    }
    switch (e.event) {
      // The guess while you speak, re-evaluated every 800 ms.
      case "partial":
        if (partialRules()) show(e.text);
        break;
      // The segment closed. It goes to the focused panel NOW, not to the one
      // focused when you started speaking — which is what typing would do.
      case "final": {
        const said = e.text.trim();
        const panel = ctx.terminal.focusedPanel();
        if (!said || !panel) return;
        // Space at the end: two consecutive segments would stick into a single word.
        panel.write(`${said} `);
        // From here on silence counts as "I'm done": the countdown starts.
        scheduleSend(panel);
        break;
      }
      // The partial stays still while you don't speak; the wave is what shows the
      // microphone is really open.
      case "level":
        pushWave(e.value);
        if (e.value > SPEECH_THRESHOLD) {
          lastSpeech = Date.now();
          postponeSend();
        }
        break;
      case "progress":
        show(t.downloadingModelPct(Math.round(e.value * 100)));
        break;
      case "error":
        listening = false;
        stopWatch();
        root.classList.remove("listening");
        clearWave();
        show(t.listeningError(e.message));
        later(hide, 4000);
        break;
      case "status":
        if (e.value === "stopped" && listening) {
          listening = false;
          stopWatch();
          root.classList.remove("listening");
          clearWave();
        }
        break;
    }
  }

  let watch: ReturnType<typeof setInterval> | undefined;

  function stopWatch() {
    clearInterval(watch);
    watch = undefined;
  }

  /// Closes the microphone. It goes out through here and the idle watcher — both turn off
  /// through the same door, so neither leaves `listening` lying.
  function stopListening() {
    listening = false;
    stopWatch();
    root.classList.remove("listening");
    clearWave();
    engine?.send({ cmd: "stop" });
  }

  /// One minute silent and the microphone closes. A countdown in progress delays nothing:
  /// it lives 5 s, well within the slack, and the last speech is recent by definition.
  function checkIdle() {
    if (!listening) return stopWatch();
    if (Date.now() - lastSpeech < IDLE_MS) return;
    stopListening();
    // The strip says why it went quiet: unexplained silence looks the same as frozen.
    show(t.turnedOff);
    later(hide, 5000);
  }

  async function toggle() {
    if (preparing) return;
    if (listening) {
      stopListening();
      hide();
      return;
    }

    try {
      preparing = true;
      await ensureEngine();
      const ready = await ask("modelReady", ["modelReady"]);
      if (ready.event === "error") throw new Error(ready.message);
      if (ready.event === "modelReady" && !ready.ready) {
        show(t.downloadingModel);
        const done = await ask("downloadModel", ["downloaded"]);
        if (done.event === "error") throw new Error(done.message);
      }
      show(t.listening);
      const started = await ask("start", ["started"]);
      if (started.event === "error") throw new Error(started.message);
      listening = true;
      root.classList.add("listening");
      // Reset, `lastSpeech` is 1970: the watcher would kill dictation on the first tick.
      lastSpeech = Date.now();
      if (!watch) watch = setInterval(checkIdle, 1000);
    } catch (e) {
      show(t.couldNotListen(e instanceof Error ? e.message : String(e)));
      later(hide, 4000);
    } finally {
      preparing = false;
    }
  }

  ctx.subscriptions.push(ctx.commands.register("toggle", () => void toggle()));
  clearWave();

  return () => {
    stopWatch();
    stopPulse();
    for (const id of timers) clearTimeout(id);
    pending = undefined;
    // The engine itself is in the subscriptions: the host kills it right after this.
    engine?.send({ cmd: "stop" });
    root.replaceChildren();
  };
}
