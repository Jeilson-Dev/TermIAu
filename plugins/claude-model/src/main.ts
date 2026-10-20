/// The Claude model plugin: on each Claude panel's header, the session's model and
/// effort level — the model arrives with the first status line; effort only exists
/// on models that have it. Clicking either opens the list to change it, which types
/// `/model` or `/effort` into the panel's Claude.
import type { PluginContext } from "../../../src/plugins/api";
import { CLAUDE_PLUGIN, type ClaudeApi, type ClaudePanel } from "../../claude/src/api";
import { texts, type Texts } from "./i18n";

let dispose: (() => void) | undefined;

export function activate(ctx: PluginContext) {
  dispose = createModel(ctx);
}

export function deactivate() {
  dispose?.();
  dispose = undefined;
}

/// The models `/model` accepts by alias. "Default" is the account's.
const models = (t: Texts) => [
  { alias: "fable", label: "Fable" },
  { alias: "opus", label: "Opus" },
  { alias: "sonnet", label: "Sonnet" },
  { alias: "haiku", label: "Haiku" },
  { alias: "default", label: t.accountDefault },
];

/// The `/effort` levels. Not every model has all of them: Claude refuses what doesn't
/// exist, and the message shows in the terminal.
const efforts = (t: Texts) => [
  { level: "low", label: t.effortLow },
  { level: "medium", label: t.effortMedium },
  { level: "high", label: t.effortHigh },
  { level: "xhigh", label: t.effortExtraHigh },
  { level: "max", label: t.effortMax },
  { level: "auto", label: t.effortAuto },
];

type Chips = { model: HTMLButtonElement; effort: HTMLButtonElement };

function createModel(ctx: PluginContext): () => void {
  const t = texts(ctx.language);
  const claude = ctx.plugins.api<ClaudeApi>(CLAUDE_PLUGIN);
  const MODELS = models(t);
  const EFFORTS = efforts(t);
  const chips = new Map<number, Chips>();

  function draw(id: number, c: ClaudePanel | undefined) {
    const b = chips.get(id);
    if (!b) return;
    b.model.hidden = !c;
    b.model.textContent = c?.model ?? t.emptyModel;
    b.model.title = c?.model ? t.modelHint(c.model) : t.emptyModelHint;
    b.effort.hidden = !c?.effort;
    const effort = EFFORTS.find((e) => e.level === c?.effort);
    b.effort.textContent = t.effort(effort?.label ?? c?.effort ?? "");
    b.effort.title = t.effortHint;
  }

  function choose(id: number, which: "model" | "effort") {
    const b = chips.get(id);
    const c = claude.panel(id);
    if (!b || !c) return;
    const send = (command: string) => claude.send(id, command, t.claudeWorkingSwap);
    ctx.ui.menu(
      b[which],
      which === "model"
        ? MODELS.map((m) => ({
            label: m.label,
            hint: m.alias,
            chosen: m.alias !== "default" && c.model?.toLowerCase().startsWith(m.alias) === true,
            onSelect: () => send(`/model ${m.alias}`),
          }))
        : EFFORTS.map((e) => ({
            label: e.label,
            hint: e.level,
            chosen: e.level === c.effort,
            onSelect: () => send(`/effort ${e.level}`),
          })),
    );
  }

  const chip = (cls: string) => {
    const b = document.createElement("button");
    b.className = `task-btn task-claude-option ${cls}`;
    b.hidden = true;
    // The click doesn't take the keyboard from the terminal.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };

  ctx.subscriptions.push(
    ctx.regions.panelHeader("model", (panel, el) => {
      const model = chip("task-model");
      const effort = chip("task-effort");
      model.addEventListener("click", () => choose(panel.id, "model"));
      effort.addEventListener("click", () => choose(panel.id, "effort"));
      el.append(model, effort);
      chips.set(panel.id, { model, effort });
      draw(panel.id, claude.panel(panel.id));
      return { dispose: () => void chips.delete(panel.id) };
    }),
    claude.onChange(draw),
  );

  return () => chips.clear();
}
