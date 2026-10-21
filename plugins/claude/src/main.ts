/// The Claude Code plugin: TermIAu's link to Claude Code, and the core the other Claude
/// plugins depend on. It installs the hook that makes each Claude report what it is
/// doing, follows every panel's session from the hook's events and status lines, and
/// gives that to the plugins that draw it (context, usage, model, chat) through
/// `ClaudeApi`.
///
/// What it does itself, on the app's generic surfaces:
///  - each panel's state becomes the panel's status (`working`, `waiting`): the app
///    draws the tab's dot, the waiting outline, the Dock badge and ⌘⇧A from it;
///  - the session is saved with the panel, and resumed when the tabs come back;
///  - your prompts are highlighted in the terminal, and ⌘⇧↑/↓ jump between them;
///  - the diff tab sees the live sessions, sends requests to them, and asks
///    Claude (`claude -p`) about a passage through the engine.
///
/// The raw events come from the plugin's hook, through the app's socket
/// (`ctx.socket`). Everything that touches Claude Code's files or runs
/// `claude` is in the plugin's engine (engine/src/main.rs).
import type { IDecoration } from "@xterm/xterm";
import type { Panel, PluginContext, PluginProcess } from "../../../src/plugins/api";
import type {
  ClaudeApi,
  ClaudePanel,
  ClaudeState,
  QuestionItem,
  RateLimits,
  SavedSession,
  SlashCommand,
  TranscriptChunk,
} from "./api";
import { questionsOf, summaryOf } from "./events";
import { texts, type Texts } from "./i18n";
import { promptLines } from "./prompts";

/// What is known about a panel's Claude, beyond the panel itself.
type Session = Omit<ClaudePanel, "panel">;

/// The parts of Claude Code's status line this plugin reads.
type StatusLine = {
  context_window?: { used_percentage?: number | null } | null;
  rate_limits?: RateLimits | null;
  model?: { display_name?: string | null } | null;
  effort?: { level?: string | null } | null;
};

/// What a hook event carries that this plugin reads (see Claude Code's hooks).
type HookEvent = {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  question_id?: string;
};

/// What the panel saves to be resumed when the tabs come back.
type Saved = { session: string; folder?: string | null };

/// The tools whose wait is a menu of options, not a yes or no: the
/// Enter of "Allow" would pick the first option without you having read it.
const NEED_TERMINAL = new Set(["AskUserQuestion", "ExitPlanMode"]);

/// The id ends up on a command line typed into the shell, and came from a socket
/// any of the user's processes can write to: only what looks like an id gets through.
const ID_SESSION = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/// How many prompts a panel remembers. The oldest have already left the scrollback.
const MAX_PROMPTS = 300;
/// How often the highlight is redone while the screen changes. It is a frequency
/// cap, not a wait for silence: Claude working writes nonstop
/// (the counter, the animation), and waiting for it to go quiet would mean never highlighting.
const MARKS_MS = 400;
/// How many lines before the start of the screen are still reread: a prompt may
/// have started there and continue inside it.
const MARK_SLACK = 16;

/// A prompt's highlight, by panel.
type Marks = {
  prompts: string[];
  marks: Map<string, IDecoration>;
  /// How the screen was at the last search: what had already gone into scrollback
  /// doesn't change anymore, and needn't be read again.
  seen?: { base: number; cols: number; prompts: number };
  wait?: ReturnType<typeof setTimeout>;
};

export function activate(ctx: PluginContext): ClaudeApi {
  const t = texts(ctx.language);
  const socket = ctx.socket;

  const sessions = new Map<number, Session>();
  const changeListeners = new Set<(id: number, claude: ClaudePanel | undefined) => void>();
  const limitListeners = new Set<(limits: RateLimits) => void>();
  let lastLimits: RateLimits | undefined;
  const chatOpen = new Set<number>();
  const navigators = new Map<number, (delta: number) => void>();
  const highlights = new Map<number, Marks>();

  // ---------- the engine ----------

  let engine: Promise<PluginProcess> | undefined;
  let nextRequest = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  function startEngine(): Promise<PluginProcess> {
    if (engine) return engine;
    const started = ctx.process.spawn("engine").then((proc) => {
      proc.onMessage((m) => {
        const r = m as { id?: number; ok?: unknown; error?: string };
        const p = r.id === undefined ? undefined : pending.get(r.id);
        if (!p) return;
        pending.delete(r.id!);
        if (r.error !== undefined) p.reject(new Error(r.error));
        else p.resolve(r.ok);
      });
      proc.onExit((code) => {
        ctx.log(`engine exited (${code})`);
        engine = undefined;
        for (const p of pending.values()) p.reject(new Error(`engine exited (${code})`));
        pending.clear();
      });
      proc.send({ id: 0, cmd: "language", language: ctx.language });
      return proc;
    });
    started.catch(() => (engine = undefined));
    return (engine = started);
  }

  async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const proc = await startEngine();
    const id = nextRequest++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      proc.send({ id, cmd, ...args });
    });
  }

  // ---------- the sessions ----------

  function view(id: number): ClaudePanel | undefined {
    const s = sessions.get(id);
    const panel = ctx.terminal.panel(id);
    return s && panel ? { panel, ...s } : undefined;
  }

  /// Everything that changes a session goes through here: the panel's signals, what is
  /// saved with it, the diff tab's list and the plugins that draw it.
  function changed(id: number) {
    const s = sessions.get(id);
    const panel = ctx.terminal.panel(id);
    if (panel) {
      panel.setStatus(s?.state === "waiting" ? "waiting" : s?.state === "working" ? "working" : undefined);
      const saved: Saved | undefined = s?.session ? { session: s.session, folder: s.folder ?? null } : undefined;
      panel.setSaved(saved && JSON.stringify(saved));
    }
    publishLive();
    const v = view(id);
    for (const fn of changeListeners) fn(id, v);
  }

  function setState(id: number, state: ClaudeState) {
    const s = sessions.get(id);
    if (!s || s.state === state) return;
    s.state = state;
    if (state !== "waiting") {
      s.asks = undefined;
      s.notice = undefined;
    }
    changed(id);
  }

  /// Gives up on the panel's pending question: its hook exits without an answer, and if
  /// it is still open, the terminal is the one that answers.
  function dropQuestion(s: Session | undefined) {
    const id = s?.question?.id;
    if (!id) return;
    s!.question = undefined;
    socket.drop(id);
  }

  function receive(id: number, raw: Record<string, unknown>) {
    const ev = raw as HookEvent;
    const panel = ctx.terminal.panel(id);
    if (!panel) {
      if (ev.question_id) socket.drop(ev.question_id);
      return;
    }
    // The folder name is what the panel is called.
    const name = ev.cwd?.split("/").filter(Boolean).pop() || t.panelN(id);
    // The session changes without Claude exiting (a `/clear`, a `/resume`): the last
    // event's always wins. The folder is the one from each session's first event — afterwards
    // Claude may have moved, and `--resume` looks for the session where it was born.
    const before = sessions.get(id);
    const session = ev.session_id ?? before?.session;
    const same = before?.session === session;
    const s: Session = {
      name,
      state: before?.state ?? "idle",
      session,
      folder: (same && before?.folder) || ev.cwd,
      transcript: ev.transcript_path ?? (same ? before?.transcript : undefined),
      // The pending question carries across events until it is answered.
      question: same ? before?.question : undefined,
      asks: before?.asks,
      notice: before?.notice,
      // A new session starts with its own context; the model and the effort stay —
      // they are the panel's, not the conversation's.
      context: same ? before?.context : undefined,
      model: before?.model,
      effort: before?.effort,
    };
    sessions.set(id, s);

    switch (ev.hook_event_name) {
      case "UserPromptSubmit":
        s.state = "working";
        s.asks = s.notice = undefined;
        if (ev.prompt) rememberPrompts(id, [ev.prompt]);
        // A new prompt: the question that was open was left behind.
        dropQuestion(s);
        break;
      case "Stop":
        // The turn ended. A wait that arrived earlier (a question, a
        // permission) still stands.
        if (s.state === "working") s.state = "idle";
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        // The question was answered — in the chat, or in the terminal before it. The hook
        // still waiting exits quietly, and the card goes away. A session only has one
        // open question at a time, so the tool name is enough.
        if (s.question && ev.tool_name === "AskUserQuestion") {
          dropQuestion(s);
          if (s.state === "waiting") s.state = "working";
          s.asks = s.notice = undefined;
        }
        break;
      case "PermissionRequest": {
        s.state = "waiting";
        // A new question in place of another: the previous one won't come back.
        if (ev.question_id) dropQuestion(s);
        const questions = ev.tool_name === "AskUserQuestion" ? questionsOf(ev.tool_input) : undefined;
        if (ev.question_id && questions) {
          s.question = { id: ev.question_id, questions: questions as QuestionItem[] };
          s.asks = "terminal";
          s.notice = t.hasAQuestion;
          break;
        }
        s.notice = t.asksPermission(ev.tool_name ?? t.oneTool, summaryOf(ev.tool_input));
        s.asks = ev.tool_name && NEED_TERMINAL.has(ev.tool_name) ? "terminal" : "permission";
        break;
      }
      case "Notification":
        s.state = "waiting";
        // The permission notification arrives right after `PermissionRequest`, and
        // says less than it: the request and text already there stay.
        if (ev.notification_type === "permission_prompt" || /permission/i.test(ev.message ?? "")) {
          s.asks = before?.asks ?? "permission";
          s.notice = (before?.asks && before.notice) || ev.message;
        } else {
          s.asks = ev.notification_type === "elicitation_dialog" ? "terminal" : undefined;
          s.notice = ev.message;
        }
        break;
      case "SessionEnd":
        dropQuestion(s);
        sessions.delete(id);
        break;
    }
    changed(id);
  }

  function receiveStatus(id: number, raw: Record<string, unknown>) {
    const st = raw as StatusLine;
    if (st.rate_limits) {
      lastLimits = st.rate_limits;
      for (const fn of limitListeners) fn(st.rate_limits);
    }
    const s = sessions.get(id);
    if (!s) return;
    const used = st.context_window?.used_percentage;
    if (typeof used === "number") s.context = used;
    if (st.model?.display_name) s.model = st.model.display_name;
    // The level really goes away when the new model has no effort.
    if (st.model) s.effort = st.effort?.level ?? undefined;
    changed(id);
  }

  /// Looking at the panel is attending to it: the notice has done its job. With the
  /// chat on screen too, if what is missing is a message; a permission request or a
  /// menu stays lit until answered (through the chat's buttons or in the terminal).
  function looked(id: number) {
    const s = sessions.get(id);
    if (s?.state !== "waiting") return;
    if (chatOpen.has(id) && s.asks && !s.question) return;
    setState(id, "idle");
  }

  // ---------- your prompts, highlighted in the terminal ----------

  function rememberPrompts(id: number, newOnes: string[]) {
    const panel = ctx.terminal.panel(id);
    if (!panel) return;
    const h = highlights.get(id) ?? watch(panel);
    for (const p of newOnes) if (p.trim() && !h.prompts.includes(p)) h.prompts.push(p);
    if (h.prompts.length > MAX_PROMPTS) h.prompts.splice(0, h.prompts.length - MAX_PROMPTS);
    scheduleMarks(panel, h);
  }

  /// Claude redraws the screen whenever it wants, and the highlight has to follow the
  /// lines: it is redone after each batch of output.
  function watch(panel: Panel): Marks {
    const h: Marks = { prompts: [], marks: new Map() };
    highlights.set(panel.id, h);
    const d = panel.xterm.onWriteParsed(() => scheduleMarks(panel, h));
    ctx.subscriptions.push(d);
    return h;
  }

  function scheduleMarks(panel: Panel, h: Marks) {
    if (!h.prompts.length || h.wait !== undefined) return;
    h.wait = setTimeout(() => {
      h.wait = undefined;
      mark(panel, h);
    }, MARKS_MS);
  }

  /// Puts a highlight on each screen line that is one of your prompts. Searches again
  /// each time instead of marking at send time: Claude Code rewrites the
  /// whole conversation on a resize, and a mark placed earlier would go away
  /// with the old lines.
  function mark(panel: Panel, h: Marks) {
    if (!panel.isAlive() || !h.prompts.length) return;
    const term = panel.xterm;
    const buf = term.buffer.active;
    // On the alternate screen (Claude's full-screen mode) xterm draws no
    // decorations at all; there the highlight is up to chat mode.
    if (buf.type !== "normal") return;

    // What has already gone into scrollback is immutable: as long as it only grows,
    // rereading from where the screen started last time is enough. Shrank (a clear, a
    // resize redraw), changed width or a new prompt arrived: then reread everything.
    const v = h.seen;
    const whole = !v || buf.baseY < v.base || v.cols !== term.cols || v.prompts !== h.prompts.length;
    const from = whole ? 0 : Math.max(0, v.base - MARK_SLACK);
    h.seen = { base: buf.baseY, cols: term.cols, prompts: h.prompts.length };

    const screen: string[] = [];
    for (let i = from; i < buf.length; i++) screen.push(buf.getLine(i)?.translateToString(true) ?? "");
    const want = new Map<string, { line: number; height: number }>();
    for (const a of promptLines(screen, h.prompts)) {
      want.set(`${a.line + from}:${a.height}:${term.cols}`, { line: a.line + from, height: a.height });
    }

    // The key keeps the line from when the mark was born, and scrolling moves it:
    // the map is rebuilt with the line each mark is on now.
    const oldOnes = h.marks;
    const marks = (h.marks = new Map<string, IDecoration>());
    for (const [key, d] of oldOnes) {
      const current = `${d.marker.line}:${key.slice(key.indexOf(":") + 1)}`;
      // Above where the reading started nothing was checked: the mark stays.
      if (!d.isDisposed && d.marker.line < from) marks.set(current, d);
      else if (d.isDisposed || !want.has(current) || marks.has(current)) d.dispose();
      else marks.set(current, d);
    }
    for (const [key, a] of want) {
      if (marks.has(key)) continue;
      const marker = term.registerMarker(a.line - (buf.baseY + buf.cursorY));
      const d = marker && term.registerDecoration({ marker, x: 0, width: term.cols, height: a.height });
      if (!d) continue;
      d.onRender((el) => el.classList.add("prompt-mark"));
      marks.set(key, d);
    }
  }

  /// Jumps to your previous or next prompt: in the terminal's scrollback or, with
  /// chat mode on screen, between your bubbles.
  function goToMessage(delta: number) {
    const panel = ctx.terminal.focusedPanel();
    if (!panel) return;
    const navigate = navigators.get(panel.id);
    if (navigate) return navigate(delta);
    const h = highlights.get(panel.id);
    if (h) mark(panel, h);
    const lines = [...(h?.marks.values() ?? [])].map((d) => d.marker.line).sort((a, b) => a - b);
    const top = panel.xterm.buffer.active.viewportY;
    const target = delta < 0 ? lines.filter((l) => l < top).pop() : lines.find((l) => l > top);
    if (target !== undefined) panel.xterm.scrollToLine(target);
    else if (delta > 0) panel.xterm.scrollToBottom();
  }

  // ---------- the tabs that come back ----------

  /// The panel came back with the tabs: its session is resumed. The `--resume` line is
  /// typed into the shell, as play types its own: that is how `claude` comes from
  /// your .zshrc's PATH. The shell is still starting — the line waits in the terminal
  /// and it reads it when it reaches the prompt.
  async function resume(panel: Panel, raw: string) {
    let saved: Saved;
    try {
      saved = JSON.parse(raw) as Saved;
    } catch {
      return;
    }
    if (!ID_SESSION.test(saved.session ?? "")) return;
    const folder = saved.folder ?? undefined;
    // Marked right away, not only when the hook reports: quitting before the resumed
    // session's first event must not forget it.
    sessions.set(panel.id, {
      name: folder?.split("/").filter(Boolean).pop() || "claude",
      state: "idle",
      session: saved.session,
      folder,
    });
    changed(panel.id);
    // `--resume` only finds the session from the folder it was born in.
    const here = await panel.cwd();
    const cd = folder && here !== folder ? `cd '${folder.replace(/'/g, `'\\''`)}' && ` : "";
    panel.write(`${cd}claude --resume ${saved.session}\r`);
  }

  // ---------- the diff tab ----------

  /// The live sessions, as the diff tab sees them: where to send a review request.
  let liveSent = "";
  function publishLive() {
    const list = [...sessions.entries()].flatMap(([id, s]) => {
      const panel = ctx.terminal.panel(id);
      if (!s.session || !panel) return [];
      // Claude Code puts a spinner in front of the title while it works.
      const title = panel.title.replace(/^[^\p{L}\p{N}]+/u, "");
      return [{ panel: id, session: s.session, name: s.name, title, folder: s.folder ?? "", state: s.state }];
    });
    const key = JSON.stringify(list);
    if (key === liveSent) return;
    liveSent = key;
    ctx.differ.publish("claude.liveSessions", list);
  }

  /// A change asked from the diff tab goes to the session as if typed in its panel: the paste
  /// way (several lines as one block), and Enter after, on its own. A session waiting for a yes or no
  /// would take the paste as the answer — that one is refused.
  function askInSession(id: number, text: string): string | null {
    const s = sessions.get(id);
    const panel = ctx.terminal.panel(id);
    if (!s?.session || !panel) return t.sessionNoLongerOpen;
    if (s.state === "waiting") return t.sessionWaitingForYou(s.name);
    panel.paste(text);
    setTimeout(() => panel.write("\r"), 80);
    setState(id, "working");
    return null;
  }

  // ---------- wiring ----------

  ctx.subscriptions.push(
    // What the hook sends: `{"status":…}`, Claude Code's status line, or `{"event":…}`,
    // a hook event; one that waits for an answer (a question) gets `question_id`.
    socket.onMessage((id, message, replyId) => {
      const m = message as { status?: Record<string, unknown>; event?: Record<string, unknown> } | null;
      if (m?.status) receiveStatus(id, m.status);
      else if (m?.event) receive(id, replyId ? { ...m.event, question_id: replyId } : m.event);
      else if (replyId) socket.drop(replyId);
    }),
    ctx.terminal.onFocus((panel) => looked(panel.id)),
    // Touching the panel is attending to it, as much as clicking it: the "waiting"
    // notice goes on the first key. Esc alone interrupts Claude, and when interrupted
    // it doesn't send `Stop`.
    ctx.terminal.onUserInput((panel, data) => {
      const s = sessions.get(panel.id);
      if (s?.state === "waiting") setState(panel.id, "idle");
      else if (data === "\x1b" && s?.state === "working") setState(panel.id, "idle");
    }),
    ctx.terminal.onClosed((id) => {
      dropQuestion(sessions.get(id));
      sessions.delete(id);
      chatOpen.delete(id);
      navigators.delete(id);
      const h = highlights.get(id);
      clearTimeout(h?.wait);
      highlights.delete(id);
      publishLive();
      for (const fn of changeListeners) fn(id, undefined);
    }),
    ctx.terminal.onRestored((panel, saved) => void resume(panel, saved)),
    ctx.commands.register("connect", () => void connect(call, t, ctx, true)),
    ctx.commands.register("previousMessage", () => goToMessage(-1)),
    ctx.commands.register("nextMessage", () => goToMessage(1)),
    ctx.differ.serve("claude.askInSession", ({ panel, text }) => askInSession(Number(panel), String(text ?? ""))),
    ctx.differ.serve("claude.sessions", ({ path }) => call<SavedSession[]>("sessions", { path })),
    ctx.differ.serve("claude.ask", (args) => call("ask", args)),
    ctx.differ.serve("claude.undo", (args) => call<string[]>("undo", args)),
    ctx.differ.serve("claude.cancel", ({ askId }) => call("cancel", { askId })),
  );
  publishLive();

  // At launch only what was already installed is updated: whoever installed it already
  // consented, and what changes is the hook that came with the new plugin.
  void connect(call, t, ctx, false);

  return {
    panel: view,
    onChange(fn) {
      changeListeners.add(fn);
      for (const id of sessions.keys()) fn(id, view(id));
      return { dispose: () => void changeListeners.delete(fn) };
    },
    onRateLimits(fn) {
      limitListeners.add(fn);
      if (lastLimits) fn(lastLimits);
      return { dispose: () => void limitListeners.delete(fn) };
    },
    send(id, command, busy) {
      const s = sessions.get(id);
      const panel = ctx.terminal.panel(id);
      if (!s || !panel) return;
      if (s.state === "working") return panel.notify(busy);
      panel.write(command);
      setTimeout(() => panel.write("\r"), 80);
    },
    async start(id) {
      const panel = ctx.terminal.panel(id);
      // With another program in front of the shell, `claude` would be typed inside
      // it — in a vim, in a running server.
      if (!panel || (await panel.isBusy())) return false;
      if (sessions.has(id)) return true;
      panel.write("claude\r");
      // Marked right away: the rest arrives with the session's first event.
      sessions.set(id, { name: panel.title, state: "idle" });
      changed(id);
      return true;
    },
    setState,
    attend: (id) => {
      const s = sessions.get(id);
      if (s?.state === "waiting" && (!s.asks || s.question)) setState(id, "idle");
    },
    answerPermission(id, yes) {
      const s = sessions.get(id);
      const panel = ctx.terminal.panel(id);
      if (s?.state !== "waiting" || s.asks !== "permission" || !panel) return;
      panel.write(yes ? "\r" : "\x1b");
      // Accepted, Claude keeps working; declined, it stops and waits for you to say
      // what to do instead.
      setState(id, yes ? "working" : "idle");
    },
    async answerQuestion(id, answer) {
      const s = sessions.get(id);
      const question = s?.question;
      if (!s || !question) throw new Error(t.alreadyAnswered);
      s.question = undefined;
      s.state = "working";
      s.asks = s.notice = undefined;
      changed(id);
      await socket.reply(question.id, answer);
    },
    rememberPrompts,
    setChatOpen(id, open) {
      if (open) chatOpen.add(id);
      else chatOpen.delete(id);
    },
    setMessageNavigator(id, go) {
      if (go) navigators.set(id, go);
      else navigators.delete(id);
    },
    transcript: (path, since) => call<TranscriptChunk>("transcript_read", { path, since }),
    commands: (folder) => call<SlashCommand[]>("commands_list", { folder: folder ?? null }),
    sessions: (folder) => call<SavedSession[]>("sessions", { path: folder }),
  };
}

/// Installs or updates the hook. `request`: it came from the menu, and then every
/// answer shows; at launch only an outdated hook is updated, quietly.
async function connect(
  call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  t: Texts,
  ctx: PluginContext,
  request: boolean,
) {
  type HookState = "no-claude" | "missing" | "outdated" | "installed";
  const state = await call<HookState>("hooks_state").catch((e) => {
    ctx.log(`hooks_state: ${e}`);
    return "no-claude" as const;
  });
  const tell = (title: string, text: string) => ctx.ui.ask({ title, text, confirm: t.ok });

  if (!request) {
    if (state === "outdated") await call("hooks_install").catch((e) => ctx.log(`hooks_install: ${e}`));
    return;
  }
  if (state === "no-claude") return void (await tell(t.claudeNotFound, t.claudeNotFoundText));
  if (state === "installed") return void (await tell(t.alreadyOn, t.alreadyOnText));
  try {
    await call("hooks_install");
    await tell(t.on, t.onText);
  } catch (e) {
    await tell(t.couldNotConnect, e instanceof Error ? e.message : String(e));
  }
}

