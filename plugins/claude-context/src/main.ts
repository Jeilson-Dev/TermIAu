/// The Claude context plugin: on each panel's header, a pill with how much of the
/// context the session has used — the bar filling inside and the number on top,
/// yellow and red by the plugin's limits. In the red the whole panel gets a pulsing
/// border (the pill alone gets lost in the corner of the eye). Clicking it, or ⌘⇧K,
/// sends `/compact`; with auto-compact on, it goes on its own at the limit.
import type { Panel, PluginContext } from "../../../src/plugins/api";
import { CLAUDE_PLUGIN, type ClaudeApi, type ClaudePanel } from "../../claude/src/api";
import { texts } from "./i18n";
import { autoCompactLimit, contextLevel, type ContextLimits, type Level } from "./limits";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createContext(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

type Pill = { panel: Panel; button: HTMLButtonElement; fill: HTMLSpanElement; num: HTMLSpanElement };

function createContext(ctx: PluginContext): () => void {
  const t = texts(ctx.language);
  const claude = ctx.plugins.api<ClaudeApi>(CLAUDE_PLUGIN);
  const pills = new Map<number, Pill>();
  /// Panels where auto-compact already sent `/compact`. It only re-arms when the
  /// context drops below the limit — otherwise every status line would send another.
  const compacted = new Set<number>();

  const limits = (): ContextLimits => ({
    attention: Number(ctx.settings.get("attention")),
    danger: Number(ctx.settings.get("danger")),
    autoCompact: ctx.settings.get("autoCompact") === true,
    autoCompactAt: Number(ctx.settings.get("autoCompactAt")),
  });

  /// Sends `/compact` to the panel's Claude, as if you typed it. With it working the
  /// command would go into the queue, or into the middle of what you are typing: it
  /// only compacts when idle.
  const compact = (id: number) => claude.send(id, "/compact", t.claudeWorkingCompact);

  /// The pill stays while there is a session, idle or not — it is with Claude idle
  /// that you can compact. Before the first status line it exists, just without a number.
  function draw(id: number, c: ClaudePanel | undefined) {
    const pill = pills.get(id);
    if (!pill) return;
    pill.button.hidden = !c;
    let level: Level = "";
    if (c?.context === undefined) {
      pill.fill.style.width = "0%";
      pill.num.textContent = t.emptyContext;
      pill.button.title = t.emptyContextHint;
    } else {
      const pct = Math.round(Math.min(100, Math.max(0, c.context)));
      level = contextLevel(pct, limits());
      pill.fill.style.width = `${pct}%`;
      pill.num.textContent = t.context(pct);
      pill.button.title = t.contextHint(pct);
    }
    pill.button.dataset.level = level;
    pill.panel.setAlert(level === "danger");
  }

  /// `/compact` on its own, when the context reaches the limit. Only with Claude idle:
  /// while working, the command would go into the queue; while waiting, it would answer
  /// its question. The turn's end (`Stop`) comes through here too, in case the limit
  /// was crossed mid-turn.
  function autoCompact(id: number, c: ClaudePanel | undefined) {
    const limit = autoCompactLimit(limits());
    if (!c || c.context === undefined || limit === null) return;
    if (c.context < limit) {
      compacted.delete(id);
      return;
    }
    if (compacted.has(id) || c.state !== "idle") return;
    compacted.add(id);
    c.panel.notify(t.compactingAlone(Math.round(c.context)));
    compact(id);
  }

  ctx.subscriptions.push(
    ctx.regions.panelHeader("context", (panel, el) => {
      const button = document.createElement("button");
      button.className = "task-btn task-context";
      button.hidden = true;
      // The click doesn't take the keyboard from the terminal.
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => compact(panel.id));
      const fill = document.createElement("span");
      fill.className = "task-context-full";
      const num = document.createElement("span");
      num.className = "task-context-num";
      button.append(fill, num);
      el.append(button);
      pills.set(panel.id, { panel, button, fill, num });
      draw(panel.id, claude.panel(panel.id));
      return {
        dispose() {
          pills.delete(panel.id);
          compacted.delete(panel.id);
          panel.setAlert(false);
        },
      };
    }),
    claude.onChange((id, c) => {
      if (!c) compacted.delete(id);
      draw(id, c);
      autoCompact(id, c);
    }),
    ctx.settings.onChange(() => {
      for (const id of pills.keys()) {
        const c = claude.panel(id);
        draw(id, c);
        autoCompact(id, c);
      }
    }),
    ctx.commands.register("compact", () => {
      const panel = ctx.terminal.focusedPanel();
      if (panel) compact(panel.id);
    }),
  );

  return () => {
    for (const pill of pills.values()) pill.panel.setAlert(false);
  };
}
