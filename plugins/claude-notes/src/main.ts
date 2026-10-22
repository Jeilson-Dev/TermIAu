/// The task notebook plugin. Claude writes, as it works, the decisions it took on its
/// own, the questions it couldn't settle and what it found out (`termiau send
/// termiau.claude-notes`, taught at each session's start); they are kept per task — the
/// panel's repository and branch — so a task spanning several sessions keeps one notebook.
///
///  - On each panel's bar, a button with how many items the task has still open (lit
///    while something waits for you); it opens the task's notebook beside the terminal,
///    sharing the panel with it, or floating over it — a button on the notebook switches.
///  - ⌘⇧N opens every task's notebook, to revisit or delete old ones.
///
/// Everything stays in the plugin's storage, on this machine; nothing goes into the
/// repository.
import type { Panel, PluginContext } from "../../../src/plugins/api";
import { CLAUDE_PLUGIN, type ClaudeApi } from "../../claude/src/api";
import { texts } from "./i18n";
import { addByHand, addComment, apply, counts, FIRST_IDS, replyMessage, markRead, needsYou, newTask, removeNote, setStatus, taskKey, taskName, type Kind, type Status, type Task } from "./notes";
import { confirmButton, el, firstKind, KIND_ICON, KINDS, milestoneInput, renderNotes, renderTabs, type NoteActions, type Tab } from "./view";
import type { PanelPlace } from "../../../src/plugins/api";

const ICON_NOTES = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4zM6 2.5v11M8.5 6h2.5M8.5 9h2.5"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" transform="rotate(45 8 8)"/></svg>`;
/// The notebook floating over the terminal, and beside it.
const ICON_FLOAT = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><rect x="7.5" y="5" width="5" height="6" rx="1" fill="currentColor" fill-opacity=".35"/></svg>`;
const ICON_DOCK = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M9.5 2.5v11"/></svg>`;
const ICON_ALL = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"/></svg>`;

/// How long the drawer takes to slide in and out (style.css has the same).
const SLIDE_MS = 200;

const STORAGE_KEY = "tasks";
const LAYOUT_KEY = "layout";

/// Where the notebook opens: beside the terminal, taking a share of the panel, or
/// floating over it.
type Layout = "side" | "float";

/// One panel's button and, once opened, its drawer.
type Slot = {
  panel: Panel;
  button: HTMLButtonElement;
  /// Each tab's small icon and count on the button.
  kinds: Record<Tab, HTMLSpanElement>;
  drawer?: {
    root: HTMLDivElement;
    layout: HTMLButtonElement;
    name: HTMLSpanElement;
    tabs: HTMLDivElement;
    add: HTMLElement;
    body: HTMLDivElement;
    open: boolean;
    /// The tab picked; until you pick one, it follows `firstKind`.
    kind?: Tab;
    hide?: ReturnType<typeof setTimeout>;
  };
};

export function activate(ctx: PluginContext) {
  const t = texts(ctx.language);
  const claude = ctx.plugins.api<ClaudeApi>(CLAUDE_PLUGIN);

  // ---------- the tasks ----------

  let layout: Layout = ctx.storage.get(LAYOUT_KEY) === "float" ? "float" : "side";

  const tasks = new Map<string, Task>();
  try {
    for (const task of JSON.parse(ctx.storage.get(STORAGE_KEY) ?? "[]") as Task[]) {
      // Saved before a kind existed: it starts at 1.
      task.next = { ...FIRST_IDS, ...(task.next as Partial<Record<Kind, number>>) };
      tasks.set(task.key, task);
    }
  } catch (e) {
    ctx.log(`unreadable notebooks: ${e}`);
  }

  function put(task: Task) {
    // An emptied task goes away with its last item: there is nothing left to revisit.
    if (task.notes.length) tasks.set(task.key, task);
    else tasks.delete(task.key);
    ctx.storage.set(STORAGE_KEY, JSON.stringify([...tasks.values()]));
    redraw();
  }

  function deleteTask(key: string) {
    tasks.delete(key);
    ctx.storage.set(STORAGE_KEY, JSON.stringify([...tasks.values()]));
    redraw();
  }

  /// The reports tab is on screen: the new ones were read. After this draw, so they
  /// show as new the moment they appear.
  const seen = (task: Task) => {
    const read = markRead(task, Date.now());
    if (read !== task) setTimeout(() => put(read), 0);
  };

  /// A milestone you wrote, into the notebook of `key` — created with it, for a task
  /// that had none yet.
  const addTo = (key: string | undefined, place: PanelPlace | undefined, title: string) => {
    if (!key) return;
    const now = Date.now();
    const task = tasks.get(key) ?? (place ? newTask(place, now) : undefined);
    if (task) put(addByHand(task, "milestone", title, now));
  };

  const taskOf = (panel: Panel) => {
    const key = taskKey(panel.where());
    return key ? tasks.get(key) : undefined;
  };

  /// The replies being written, by notebook and item.
  const drafts = new Map<string, Map<string, string>>();

  /// The panel a reply goes to: the one the notebook was opened from, if Claude runs
  /// there on this task; else any panel with Claude on this task.
  const sessionPanel = (key: string, from?: Panel) => {
    const here = (p: Panel) => taskKey(p.where()) === key && !!claude.panel(p.id);
    return from && here(from) ? from : ctx.terminal.panels().find(here);
  };

  /// Your reply goes to Claude as if pasted into its prompt, framed with the item, and
  /// stays in the item's history. Only with Claude idle: working, it would land in the
  /// middle of its turn; waiting, it would answer the terminal's question.
  const reply = (key: string, id: string, text: string, from?: Panel): string | null => {
    const task = tasks.get(key);
    const note = task?.notes.find((n) => n.id === id);
    if (!task || !note) return null;
    const panel = sessionPanel(key, from);
    const c = panel && claude.panel(panel.id);
    if (!panel || !c) return t.noSession;
    if (c.state === "working") return t.claudeWorking;
    if (c.state === "waiting") return t.claudeWaiting;
    panel.paste(replyMessage(note, text));
    setTimeout(() => panel.write("\r"), 80);
    claude.setState(panel.id, "working");
    if (panel !== from) panel.notify(t.sentFromNotebook(id));
    put(addComment(task, id, text, Date.now()));
    return null;
  };

  const actionsFor = (key: string, from?: Panel): NoteActions => ({
    reply: (id, text) => reply(key, id, text, from),
    drafts: drafts.get(key) ?? drafts.set(key, new Map()).get(key)!,
    setStatus: (id, status: Status) => {
      const task = tasks.get(key);
      if (task) put(setStatus(task, id, status, Date.now()));
    },
    remove: (id) => {
      const task = tasks.get(key);
      if (task) put(removeNote(task, id, Date.now()));
    },
    addSubtask: (milestone, title) => {
      const task = tasks.get(key);
      if (task) put(addByHand(task, "todo", title, Date.now(), milestone));
    },
    mermaid: (root) => void ctx.ui.mermaid(root),
    menu: (anchor, items) => ctx.ui.menu(anchor, items),
  });

  // ---------- what Claude sends ----------

  function receive(id: number, message: unknown, replyId?: string) {
    const answer = (text: string) => {
      if (replyId) void ctx.socket.reply(replyId, text).catch(() => {});
    };
    const panel = ctx.terminal.panel(id);
    if (!panel || typeof message !== "string") return answer("error: send the message as text on stdin");
    const place = panel.where();
    const key = taskKey(place);
    if (!key) return answer(`error: ${t.noPlace}`);
    const claudeHere = claude.panel(id);
    const now = Date.now();
    const outcome = apply(tasks.get(key) ?? newTask(place, now), message, claudeHere?.session, now);
    if (outcome.changed) {
      const title = claudeHere?.title;
      put(title ? { ...outcome.task, sessionTitle: title } : outcome.task);
    }
    answer(outcome.answer);
  }

  /// What Claude reads when a session starts: how to write in the notebook — always,
  /// that is the point of it — and, when the task already has one, that it exists.
  function sessionContext(panel: Panel): string {
    const task = taskOf(panel);
    const c = counts(task);
    const lines = [
      "TermIAu keeps a notebook for the task you are on (this repository and branch), which the user reads beside the terminal. Write to it as things happen, not at the end:",
      "- decision: a choice you made on your own that the request doesn't cover or that departs from it. Body: what you did, why, the alternative you discarded, and where it lives in the code.",
      "- question: something you couldn't settle that the user (or someone they will ask) has to answer. Body: the context and what depends on the answer.",
      '- finding: something you verified or noticed about how the code or the product behaves. Send it with "status":"unconfirmed" when you did not verify it.',
      '- milestone: a stage of the work, with the subtasks that make it up - the plan, shared with the user, who adds milestones and subtasks and checks them in the notebook too. Body: what the milestone delivers and how. A subtask is a todo in it: {"kind":"todo","milestone":"M1","title":"…"}. When you finish a subtask mark it done ({"update":"T2","status":"done"}), and the milestone when all of it is ({"update":"M1","status":"done"}). Lay out milestones when the user asks you to track something, or when the work has stages the user will want to follow and check.',
      "- report: when you finish a task, or a piece of work the user asked for, a summary of what was done. Title: what the work was. Body: Markdown bullet points, in general terms - what changed and where, what was verified (tests, build) and what was left undone.",
      "Every body is Markdown, and a ```mermaid block in it is drawn as a diagram: use one (a flowchart, a sequence diagram) whenever a flow, a sequence of calls or how parts connect explains it better than prose - in any kind of item, not only reports.",
      "~/.termiau/bin/termiau send termiau.claude-notes <<'EOF'",
      '{"kind":"decision","title":"One line saying what was decided","body":"Markdown: what, why, the discarded alternative, where it lives"}',
      "EOF",
      'It answers with the item\'s id (M1, T1, D1, Q1, F1, R1). When the user confirms or rejects a decision, answers a question, or a finding gets verified, update it: {"update":"D1","status":"ratified","note":"what was said"}. Statuses: milestone active|done; todo todo|done; decision pending|ratified|reverted; question open|answered; finding unconfirmed|confirmed; report new|read (the user reading it marks it). {"list":true} returns the whole notebook. If the command answers with an error, fix the message and send it again. No need to mention these in your answer.',
    ];
    if (task?.notes.length) {
      lines.push(
        `This task's notebook already has ${task.notes.length} item(s), ${c.pending} still pending (open questions or decisions not ratified)` +
          (c.milestone || c.todo ? ` and ${c.milestone} milestone(s), ${c.todo} subtask(s) not done` : "") +
          `. Read it with {"list":true} before deciding something it may already cover.`,
      );
    }
    return lines.join("\n");
  }

  // ---------- the panel's button and drawer ----------

  const slots = new Map<number, Slot>();

  /// The button, and with `list` the open drawer's content too.
  function drawSlot(slot: Slot, list = true) {
    const task = taskOf(slot.panel);
    const c = counts(task);
    const total = task?.notes.length ?? 0;
    // Shown where there is something in the notebook, or a Claude session: that is where
    // you may want to start a checklist.
    slot.button.hidden = total === 0 && !slot.drawer?.open && !claude.panel(slot.panel.id);
    for (const kind of KINDS) {
      const k = slot.kinds[kind];
      k.lastChild!.textContent = String(c[kind]);
      k.dataset.empty = c[kind] ? "" : "true";
      k.dataset.pending = task?.notes.some((n) => n.kind === kind && needsYou(n)) ? "true" : "";
    }
    slot.button.classList.toggle("on", slot.drawer?.open === true);
    slot.button.title = slot.button.hidden ? "" : t.slotHint(c);
    const d = slot.drawer;
    if (d?.open && list) {
      const place = slot.panel.where();
      const key = taskKey(place);
      d.name.textContent = key ? taskName(task ?? newTask(place, 0)) : "";
      const kind = d.kind ?? firstKind(task);
      renderTabs(d.tabs, task, kind, t, (k) => {
        d.kind = k;
        drawSlot(slot);
      });
      d.add.hidden = kind !== "milestone";
      renderNotes(d.body, task, kind, t, ctx.language, actionsFor(key ?? "", slot.panel));
      if (kind === "report" && task) seen(task);
    }
  }

  function drawer(slot: Slot) {
    if (slot.drawer) return slot.drawer;
    const root = el("div", "notes-drawer");
    const head = el("div", "notes-head");
    const title = el("span", "notes-title", t.notebook);
    const name = el("span", "notes-task");
    const all = el("button", "notes-icon-btn");
    all.innerHTML = ICON_ALL;
    all.title = t.allTasksHint;
    all.addEventListener("click", () => openAll(taskKey(slot.panel.where())));
    const switcher = el("button", "notes-icon-btn");
    switcher.addEventListener("click", () => {
      layout = layout === "side" ? "float" : "side";
      ctx.storage.set(LAYOUT_KEY, layout);
      for (const s of slots.values()) place(s);
    });
    const close = el("button", "notes-icon-btn");
    close.innerHTML = ICON_CLOSE;
    close.title = t.close;
    close.addEventListener("click", () => toggle(slot, false));
    for (const b of [all, switcher, close]) b.addEventListener("mousedown", (e) => e.preventDefault());
    head.append(title, name, switcher, all, close);
    const tabs = el("div", "notes-tabs");
    tabs.setAttribute("role", "tablist");
    const add = milestoneInput(
      t,
      (title) => addTo(taskKey(slot.panel.where()), slot.panel.where(), title),
      () => ctx.ui.restoreFocus(),
    );
    const body = el("div", "notes-body");
    root.append(head, tabs, add, body);
    // A click in the drawer stays in it: the panel would take it as a click on the
    // terminal and send the keyboard there, out of the task field.
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    slot.drawer = { root, layout: switcher, name, tabs, add, body, open: false };
    place(slot);
    return slot.drawer;
  }

  /// Puts the notebook where the layout says: in the panel's pane beside the terminal,
  /// or in the layer over it. Open, it shows at once in its new place.
  function place(slot: Slot) {
    const d = slot.drawer;
    if (!d) return;
    const side = slot.panel.side();
    const layer = slot.panel.layer();
    side.classList.add("notes-side");
    layer.classList.add("notes-layer");
    clearTimeout(d.hide);
    (layout === "side" ? side : layer).append(d.root);
    d.root.classList.toggle("docked", layout === "side");
    d.root.classList.toggle("open", d.open);
    side.hidden = !(d.open && layout === "side");
    layer.hidden = !(d.open && layout === "float");
    d.layout.innerHTML = layout === "side" ? ICON_FLOAT : ICON_DOCK;
    d.layout.title = layout === "side" ? t.float : t.dock;
  }

  /// Opens or closes the notebook. Beside the terminal it appears at once: the terminal
  /// changes size along with it, and an animation would get it measured midway. Floating,
  /// it slides, and the layer is only hidden after the slide: hiding it at once would
  /// cut the way out.
  function toggle(slot: Slot, open = !slot.drawer?.open) {
    const d = drawer(slot);
    if (d.open === open) return;
    d.open = open;
    clearTimeout(d.hide);
    if (layout === "side") {
      place(slot);
      drawSlot(slot);
      return;
    }
    const layer = slot.panel.layer();
    if (open) {
      layer.hidden = false;
      drawSlot(slot);
      // One frame with the drawer outside, so the slide has somewhere to come from.
      requestAnimationFrame(() => requestAnimationFrame(() => d.root.classList.add("open")));
    } else {
      d.root.classList.remove("open");
      d.hide = setTimeout(() => (layer.hidden = true), SLIDE_MS);
      drawSlot(slot);
    }
  }

  // ---------- every task, to revisit or delete ----------

  let dialog: ReturnType<typeof ctx.ui.dialog> | undefined;
  let chosen: string | undefined;
  /// The tab picked in the window; it starts over (`firstKind`) on each task picked.
  let chosenKind: Tab | undefined;
  let manager:
    | {
        list: HTMLDivElement;
        name: HTMLSpanElement;
        meta: HTMLSpanElement;
        actions: HTMLDivElement;
        tabs: HTMLDivElement;
        add: HTMLElement;
        body: HTMLDivElement;
      }
    | undefined;

  function openAll(focus?: string) {
    if (!dialog) {
      dialog = ctx.ui.dialog({ title: t.allTasks, className: "notes-dialog" });
      const wrap = el("div", "notes-manager");
      const list = el("div", "notes-tasks");
      const main = el("div", "notes-main");
      const head = el("div", "notes-main-head");
      const titles = el("div", "notes-main-titles");
      const name = el("span", "notes-main-name");
      const meta = el("span", "notes-main-meta");
      titles.append(name, meta);
      const actions = el("div", "notes-main-actions");
      head.append(titles, actions);
      const tabs = el("div", "notes-tabs");
      tabs.setAttribute("role", "tablist");
      const add = milestoneInput(t, (title) => addTo(chosen, undefined, title), () => {});
      const body = el("div", "notes-body");
      main.append(head, tabs, add, body);
      wrap.append(list, main);
      dialog.body.append(wrap);
      manager = { list, name, meta, actions, tabs, add, body };
    }
    if (focus && tasks.has(focus) && focus !== chosen) {
      chosen = focus;
      chosenKind = undefined;
    }
    drawManager();
    dialog.open();
  }

  function drawManager() {
    if (!manager) return;
    const sorted = [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!chosen || !tasks.has(chosen)) chosen = sorted[0]?.key;
    manager.list.replaceChildren();
    if (!sorted.length) manager.list.append(el("p", "notes-empty", t.noTasks));
    for (const task of sorted) {
      const c = counts(task);
      const item = el("button", task.key === chosen ? "notes-task-item active" : "notes-task-item");
      item.append(el("span", "notes-task-name", taskName(task)));
      if (task.sessionTitle) item.append(el("span", "notes-task-session", task.sessionTitle));
      const meta = el("span", "notes-task-meta", t.items(task.notes.length));
      if (c.pending) meta.append(el("span", "notes-task-pending", t.pendingCount(c.pending)));
      item.append(meta);
      item.title = task.root;
      item.addEventListener("click", () => {
        if (chosen !== task.key) chosenKind = undefined;
        chosen = task.key;
        drawManager();
      });
      manager.list.append(item);
    }
    const task = chosen ? tasks.get(chosen) : undefined;
    manager.name.textContent = task ? taskName(task) : "";
    manager.meta.textContent = task
      ? [task.sessionTitle, t.updated(new Date(task.updatedAt).toLocaleString(ctx.language === "pt" ? "pt-BR" : "en", { dateStyle: "short", timeStyle: "short" }))]
          .filter(Boolean)
          .join(" · ")
      : "";
    manager.actions.replaceChildren();
    if (task) manager.actions.append(confirmButton(t.removeTask, t.confirmRemoveTask, "notes-remove-task", () => deleteTask(task.key)));
    manager.tabs.hidden = !task;
    manager.add.hidden = true;
    if (task) {
      const kind = chosenKind ?? firstKind(task);
      renderTabs(manager.tabs, task, kind, t, (k) => {
        chosenKind = k;
        drawManager();
      });
      manager.add.hidden = kind !== "milestone";
      renderNotes(manager.body, task, kind, t, ctx.language, actionsFor(task.key));
      if (kind === "report") seen(task);
    } else {
      manager.body.replaceChildren(el("p", "notes-empty", sorted.length ? t.pickTask : t.noTasks));
    }
  }

  function redraw() {
    for (const slot of slots.values()) drawSlot(slot);
    if (dialog?.isOpen) drawManager();
  }

  // ---------- wiring ----------

  ctx.subscriptions.push(
    ctx.socket.onMessage(receive),
    claude.addSessionContext((panel) => sessionContext(panel)),
    ctx.regions.panelHeader("notes", (panel, host) => {
      // The notebook, then each kind's small icon with its count: what is in it, at a glance.
      const button = el("button", "task-btn task-notes");
      button.innerHTML = ICON_NOTES;
      const kinds = {} as Record<Tab, HTMLSpanElement>;
      for (const kind of KINDS) {
        const k = el("span", "task-notes-kind");
        k.dataset.kind = kind;
        k.innerHTML = KIND_ICON[kind];
        k.append(el("span", "task-notes-count"));
        button.append(k);
        kinds[kind] = k;
      }
      // The click doesn't take the keyboard from the terminal.
      button.addEventListener("mousedown", (e) => e.preventDefault());
      host.append(button);
      const slot: Slot = { panel, button, kinds };
      button.addEventListener("click", () => toggle(slot));
      slots.set(panel.id, slot);
      drawSlot(slot);
      return {
        dispose() {
          clearTimeout(slot.drawer?.hide);
          // The pane beside the terminal gives the panel back.
          const host = slot.drawer?.root.parentElement;
          slot.drawer?.root.remove();
          if (host) host.hidden = true;
          slots.delete(panel.id);
        },
      };
    }),
    // A Claude session starting or ending shows or hides the button.
    // Only the button: this fires on every status line, and redrawing the list that
    // often would undo a delete waiting for its second click.
    claude.onChange((id) => {
      const slot = slots.get(id);
      if (slot) drawSlot(slot, false);
    }),
    ctx.terminal.onMoved((panel) => {
      const slot = slots.get(panel.id);
      if (slot) drawSlot(slot);
    }),
    ctx.commands.register("allTasks", () => {
      const panel = ctx.terminal.focusedPanel();
      openAll(panel ? taskKey(panel.where()) : undefined);
    }),
    { dispose: () => dialog?.dispose() },
  );
}
