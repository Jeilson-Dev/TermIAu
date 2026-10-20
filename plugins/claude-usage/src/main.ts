/// The Claude usage plugin: Claude Usage Monitor's circle, in the footer's left
/// corner. The circle is the time left in the 5h session, and the number, how much
/// of its usage still remains. Everything counts down. The color is the pace's — it
/// lights up when you spend faster than time passes. With the mouse over it, two
/// columns open to the right, session and week, each with the time and the usage.
///
/// The numbers come from Claude Code's status line, through the Claude Code plugin.
import type { PluginContext } from "../../../src/plugins/api";
import { CLAUDE_PLUGIN, type ClaudeApi } from "../../claude/src/api";
import { texts, type Texts } from "./i18n";
import {
  missingFor,
  paceLevel,
  remainingFraction,
  SESSION_MIN,
  statusLineUsage,
  usageLevel,
  WEEK_MIN,
  windowNow,
  type Level,
  type Usage,
  type UsageWindow,
} from "./usage";

/// The same radius as the volume (5.5 in the 16 viewBox): the perimeter is the whole stroke.
const USAGE_CIRCLE = 2 * Math.PI * 5.5;
/// The shine running along the circle and the bars, in the direction they empty.
const USAGE_GLOW = 2.2;
/// One pass of the shine on the circle and the little bars, from tip to start.
const USAGE_DRAIN_MS = 2400;
/// The last usage news is kept: the status line only speaks with Claude running, and
/// opening the app must not leave the footer empty until then.
const KEY_LAST = "last";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createUsage(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

type UsageBar = { line: HTMLSpanElement; full: HTMLSpanElement; pointer: HTMLSpanElement; num: HTMLSpanElement };

function usageBar(label: string, cls: string): UsageBar {
  const line = el("span", `usage-line ${cls}`);
  const name = el("span", "usage-label");
  name.textContent = label;
  const track = el("span", "usage-track");
  const full = el("span", "usage-full");
  const pointer = el("span", "usage-pointer");
  full.append(pointer);
  track.append(full);
  const num = el("span", "usage-num");
  line.append(name, track, num);
  return { line, full, pointer, num };
}

/// A column: the name and, to its right, the two lines — the time left and the
/// usage remaining.
function usageColumn(t: Texts, name: string) {
  const column = el("span", "usage-column");
  const title = el("span", "usage-title");
  title.textContent = name;
  const lines = el("span", "usage-lines");
  const time = usageBar(t.timeLeft, "usage-time");
  const usage = usageBar(t.availableTokens, "usage-tokens");
  lines.append(time.line, usage.line);
  column.append(title, lines);
  return { column, time, usage };
}

const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

function createUsage(ctx: PluginContext): () => void {
  const t = texts(ctx.language);
  const claude = ctx.plugins.api<ClaudeApi>(CLAUDE_PLUGIN);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const root = el("div", "claude-usage");
  const session = usageColumn(t, t.session);
  const week = usageColumn(t, t.week);
  /// `vertical`: the tokens bar beside the clock, which empties from top to bottom;
  /// the hover ones empty from right to left.
  const bars: { full: HTMLSpanElement; pointer: HTMLSpanElement; vertical?: boolean }[] = [
    session.time,
    session.usage,
    week.time,
    week.usage,
  ];
  const detail = el("span", "usage-detail");
  detail.append(session.column, week.column);
  const icon = el("span", "usage-icon");
  icon.innerHTML = `<svg viewBox="0 0 16 16" width="26" height="26" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6" opacity=".26"/><circle class="circle" cx="8" cy="8" r="5.5" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${USAGE_CIRCLE}" stroke-dashoffset="0"/><circle class="circle-glow" cx="8" cy="8" r="5.5" stroke-width="1.6" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${USAGE_GLOW} ${USAGE_CIRCLE}" stroke-dashoffset="0"/><g class="pointers" stroke="currentColor" stroke-linecap="round"><line class="pointer-hour" x1="8" y1="8" x2="8" y2="5.6" stroke-width="1.2"/><line class="pointer-minute" x1="8" y1="8" x2="8" y2="4.4" stroke-width="0.9"/><circle cx="8" cy="8" r="0.7" fill="currentColor" stroke="none"/></g></svg>`;
  const circle = icon.querySelector(".circle") as SVGCircleElement;
  const glow = icon.querySelector(".circle-glow") as SVGCircleElement;
  /// The hands inside the circle: the small one points to the tip of the lit segment
  /// (how much of the session is left), and the big one makes a turn on hover.
  const hour = icon.querySelector(".pointer-hour") as SVGLineElement;
  const minute = icon.querySelector(".pointer-minute") as SVGLineElement;
  /// Beside the clock: the session's available tokens, an upright bar that empties
  /// from top to bottom, like a battery, and the number beside it.
  const summary = el("span", "usage-summary");
  const pct = el("span", "usage-pct");
  const miniTrack = el("span", "usage-track usage-mini");
  const mini = { full: el("span", "usage-full"), pointer: el("span", "usage-pointer"), vertical: true };
  mini.full.append(mini.pointer);
  miniTrack.append(mini.full);
  summary.append(miniTrack, pct);
  bars.push(mini);
  root.append(icon, summary, detail);
  root.hidden = true;
  ctx.regions.statusBar("usage").append(root);

  /// The news, as it arrived, and as it is now: a window that renewed since then
  /// comes back at zero.
  let news: Usage | undefined;
  let current: Usage | undefined;
  /// The piece of the circle lit now, in stroke length.
  let arc = USAGE_CIRCLE;
  /// The shine animations of the circle and the little bars, created together.
  let drain: Animation[] = [];

  function paintBar(b: UsageBar, remains: number | null, text: string, level: Level) {
    b.full.style.width = `${remains ?? 0}%`;
    b.num.textContent = remains === null ? "—" : text;
    b.line.dataset.level = level;
  }

  /// A window's tooltip: the name and, one per line, what remains of it.
  function hint(name: string, j: UsageWindow | null): string {
    if (!j) return t.noWindow(name);
    return t.usageHint(name, clamp(100 - j.usage), missingFor(j.renews, t.now));
  }

  /// A column: the two bars count what remains, time and usage.
  function paintColumn(c: ReturnType<typeof usageColumn>, j: UsageWindow | null, windowMin: number, level: Level) {
    if (!j) {
      paintBar(c.time, null, "", "");
      paintBar(c.usage, null, "", "");
      return;
    }
    const time = clamp(remainingFraction(j.renews, windowMin) * 100);
    const remains = clamp(100 - j.usage);
    paintBar(c.time, time, missingFor(j.renews, t.now), "");
    paintBar(c.usage, remains, `${remains}%`, level);
  }

  /// The circle's shine and the bars' little segments run from the tip back to the
  /// start, in the direction everything decreases, and the minute hand makes a turn.
  /// They are all created in the same call, and so they move together: same period,
  /// same step, and they fade at the end. Only once, on hover — still the rest of the time.
  function drainUsage() {
    for (const a of drain) a.cancel();
    drain = [];
    if (reducedMotion.matches) {
      glow.style.display = "none";
      return;
    }
    const time: KeyframeAnimationOptions = { duration: USAGE_DRAIN_MS, easing: "linear" };
    drain.push(
      minute.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: USAGE_DRAIN_MS,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
      }),
    );
    const tip = arc - USAGE_GLOW;
    glow.style.display = tip <= 0 ? "none" : "";
    if (tip > 0) {
      drain.push(
        glow.animate(
          [
            { strokeDashoffset: -tip, opacity: 0.9 },
            { strokeDashoffset: -tip * 0.3, opacity: 0.9, offset: 0.7 },
            { strokeDashoffset: 0, opacity: 0 },
          ],
          time,
        ),
      );
    }
    for (const b of bars) {
      drain.push(
        b.pointer.animate(
          b.vertical
            ? [
                { bottom: "calc(100% - 6px)", height: "6px", opacity: 0.9 },
                { bottom: "calc(30% - 4px)", height: "4px", opacity: 0.9, offset: 0.7 },
                { bottom: "0px", height: "2px", opacity: 0 },
              ]
            : [
                { left: "calc(100% - 10px)", width: "10px", opacity: 0.9 },
                { left: "calc(30% - 5px)", width: "5px", opacity: 0.9, offset: 0.7 },
                { left: "0px", width: "3px", opacity: 0 },
              ],
          time,
        ),
      );
    }
  }

  function draw() {
    const u = current;
    root.hidden = !u;
    if (!u) return;
    const s = u.session;
    const remaining = s ? remainingFraction(s.renews, SESSION_MIN) : 1;
    const sessionLevel = s ? paceLevel(s.usage, remaining) : "";
    paintColumn(session, s, SESSION_MIN, sessionLevel);
    paintColumn(week, u.week, WEEK_MIN, u.week ? usageLevel(u.week.usage) : "");
    root.dataset.level = sessionLevel;
    pct.textContent = s ? `${clamp(100 - s.usage)}%` : "—";
    mini.full.style.height = `${s ? clamp(100 - s.usage) : 0}%`;
    circle.style.strokeDashoffset = String(USAGE_CIRCLE * (1 - remaining));
    hour.style.transform = `rotate(${remaining * 360}deg)`;
    root.title = `${hint(t.session, s)}\n\n${hint(t.week, u.week)}`;
    arc = USAGE_CIRCLE * remaining;
  }

  /// On mouse over, the circle and the bars start from full and go down to where
  /// they are: every time you look, you see they are decreasing.
  function replay() {
    if (reducedMotion.matches || !current) return;
    const filled = bars.map((b) => b.full);
    const targets: (HTMLElement | SVGElement)[] = [circle, hour, ...filled];
    const side = (i: number) => (bars[i].vertical ? "height" : "width");
    for (const e of targets) e.style.transition = "none";
    const widths = filled.map((e, i) => e.style[side(i)]);
    const offset = circle.style.strokeDashoffset;
    const hourNow = hour.style.transform;
    filled.forEach((e, i) => (e.style[side(i)] = "100%"));
    circle.style.strokeDashoffset = "0";
    hour.style.transform = "rotate(360deg)";
    void root.offsetWidth;
    for (const e of targets) e.style.transition = "";
    filled.forEach((e, i) => (e.style[side(i)] = widths[i]));
    drainUsage();
    circle.style.strokeDashoffset = offset;
    hour.style.transform = hourNow;
  }
  root.addEventListener("mouseenter", replay);

  function update() {
    current = news && { session: windowNow(news.session), week: windowNow(news.week) };
    draw();
  }

  try {
    news = (JSON.parse(ctx.storage.get(KEY_LAST) ?? "null") as Usage | null) ?? undefined;
  } catch {
    news = undefined;
  }
  update();

  // Usage arrives through some panel's status line: it applies to all, there is only
  // one account.
  const limits = claude.onRateLimits((l) => {
    const u = statusLineUsage(l);
    if (!u) return;
    news = u;
    try {
      ctx.storage.set(KEY_LAST, JSON.stringify(u));
    } catch {
      // Just a convenience.
    }
    update();
  });

  // Between one piece of news and the next, time keeps passing: the "time left" and the
  // circle move on their own.
  const timer = setInterval(update, 30_000);

  return () => {
    clearInterval(timer);
    limits.dispose();
    for (const a of drain) a.cancel();
    root.remove();
  };
}
