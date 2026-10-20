/// The Claude Code plugin: TermIAu's link to Claude Code. It installs the hook that
/// makes each Claude report what it is doing, follows every panel's session from the
/// hook's events and status lines, and gives that to the plugins that draw it
/// (context, usage, model) through `ClaudeApi` — it draws nothing itself.
///
/// The raw events come from the app (`ctx.claude`), which only lends them to this
/// plugin, signed by TermIAu: the others reach Claude Code through here.
import type { ClaudeChannel, PluginContext } from "../../../src/plugins/api";
import type { ClaudeApi, ClaudePanel, RateLimits } from "./api";
import { texts, type Texts } from "./i18n";

/// What the status lines told about a panel's session.
type Known = { session?: string; context?: number; model?: string; effort?: string };

/// The parts of Claude Code's status line this plugin reads.
type StatusLine = {
  context_window?: { used_percentage?: number | null } | null;
  rate_limits?: RateLimits | null;
  model?: { display_name?: string | null } | null;
  effort?: { level?: string | null } | null;
};

export function activate(ctx: PluginContext): ClaudeApi {
  const t = texts(ctx.language);
  const channel = ctx.claude;
  if (!channel) throw new Error(t.notSigned);

  const known = new Map<number, Known>();
  const changeListeners = new Set<(id: number, claude: ClaudePanel | undefined) => void>();
  const limitListeners = new Set<(limits: RateLimits) => void>();
  let lastLimits: RateLimits | undefined;

  function view(id: number): ClaudePanel | undefined {
    const session = channel!.session(id);
    const panel = ctx.terminal.panel(id);
    if (!session || !panel) return undefined;
    const k = known.get(id);
    return { panel, state: session.state, session: session.session, context: k?.context, model: k?.model, effort: k?.effort };
  }

  function changed(id: number) {
    const v = view(id);
    for (const fn of changeListeners) fn(id, v);
  }

  ctx.subscriptions.push(
    channel.onEvent((id, event) => {
      if (event.hook_event_name === "SessionEnd") {
        known.delete(id);
        return changed(id);
      }
      const k = known.get(id) ?? {};
      const session = typeof event.session_id === "string" ? event.session_id : undefined;
      // A new session (`/clear`, `/resume`) starts with its own context; the model
      // and the effort stay — they are the panel's, not the conversation's.
      if (session && session !== k.session) {
        k.context = undefined;
        k.session = session;
      }
      known.set(id, k);
      changed(id);
    }),
    channel.onStatus((id, raw) => {
      const st = raw as StatusLine;
      if (st.rate_limits) {
        lastLimits = st.rate_limits;
        for (const fn of limitListeners) fn(st.rate_limits);
      }
      const session = channel.session(id);
      if (!session) return;
      const k = known.get(id) ?? { session: session.session };
      const used = st.context_window?.used_percentage;
      if (typeof used === "number") k.context = used;
      if (st.model?.display_name) k.model = st.model.display_name;
      // The level really goes away when the new model has no effort.
      if (st.model) k.effort = st.effort?.level ?? undefined;
      known.set(id, k);
      changed(id);
    }),
    ctx.commands.register("connect", () => void connect(channel, t, ctx, true)),
  );

  // At launch only what was already installed is updated: whoever installed it already
  // consented, and what changes is the hook that came with the new app.
  void connect(channel, t, ctx, false);

  return {
    panel: view,
    onChange(fn) {
      changeListeners.add(fn);
      for (const id of known.keys()) fn(id, view(id));
      return { dispose: () => void changeListeners.delete(fn) };
    },
    onRateLimits(fn) {
      limitListeners.add(fn);
      if (lastLimits) fn(lastLimits);
      return { dispose: () => void limitListeners.delete(fn) };
    },
    send: (id, command, busy) => channel.send(id, command, busy),
  };
}

/// Installs or updates the hook. `request`: it came from the menu, and then every
/// answer shows; at launch only an outdated hook is updated, quietly.
async function connect(channel: ClaudeChannel, t: Texts, ctx: PluginContext, request: boolean) {
  const state = await channel.hooks.state().catch(() => "no-claude" as const);
  const tell = (title: string, text: string) => ctx.ui.ask({ title, text, confirm: t.ok });

  if (!request) {
    if (state === "outdated") await channel.hooks.install().catch((e) => ctx.log(`hooks_install: ${e}`));
    return;
  }
  if (state === "no-claude") return void (await tell(t.claudeNotFound, t.claudeNotFoundText));
  if (state === "installed") return void (await tell(t.alreadyOn, t.alreadyOnText));
  try {
    await channel.hooks.install();
    await tell(t.on, t.onText);
  } catch (e) {
    await tell(t.couldNotConnect, String(e));
  }
}
