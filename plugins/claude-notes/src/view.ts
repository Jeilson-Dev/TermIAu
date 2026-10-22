/// Draws a task's notebook: the items by kind, each with its status, its text in Markdown
/// (and its mermaid diagrams), what changed in it and the delete button; the milestones
/// with their subtasks. The panel's notebook and the window with every task draw it the
/// same way.
import type { MenuItem } from "../../../src/plugins/api";
import { markdown } from "../../../src/markdown";
import type { Texts } from "./i18n";
import { isOpen, needsYou, settled, STATUSES, type Kind, type Note, type Status, type Task } from "./notes";

/// How long "Really delete?" waits for the second click.
export const CONFIRM_MS = 3000;

export type NoteActions = {
  setStatus(id: string, status: Status): void;
  /// A subtask you wrote, into milestone `milestone`.
  addSubtask(milestone: string, title: string): void;
  /// Draws the mermaid diagrams of what was just rendered in `root`.
  mermaid(root: HTMLElement): void;
  remove(id: string): void;
  menu(anchor: HTMLElement, items: MenuItem[]): void;
  /// Sends what you wrote about the item to the task's Claude session; says why not
  /// when it can't.
  reply(id: string, text: string): string | null;
  /// The replies being written, by item id: open ones are here, even empty. They outlive
  /// the list being redrawn while Claude writes. A subtask being written into a
  /// milestone is here too, under `+` and the milestone's id.
  drafts: Map<string, string>;
};

/// The kinds with a tab. Subtasks have none: they show inside their milestone.
export type Tab = Exclude<Kind, "todo">;

export const KINDS: Tab[] = ["milestone", "decision", "question", "finding", "report"];

/// The tab an item shows in.
const tabOf = (kind: Kind): Tab => (kind === "todo" ? "milestone" : kind);

/// Each tab's small icon: a milestone's flag, a decision's diamond, a question mark, a
/// finding's check, a report's lines. The panel's button and the tabs use the same ones.
export const KIND_ICON: Record<Tab, string> = {
  milestone: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5"/></svg>`,
  decision: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/></svg>`,
  question: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5.5 5.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.7v.3M8 12.7v.1"/></svg>`,
  finding: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>`,
  report: `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>`,
};

/// The kind a notebook opens on: the first one with something waiting for you (a new
/// report too), else the first with anything, else tasks.
export function firstKind(task: Task | undefined): Tab {
  const notes = task?.notes ?? [];
  return (
    KINDS.find((k) => notes.some((n) => tabOf(n.kind) === k && needsYou(n))) ??
    KINDS.find((k) => notes.some((n) => tabOf(n.kind) === k)) ??
    "milestone"
  );
}

/// The field over the Milestones list where you write a new one: Enter adds it, Esc
/// leaves. It lives outside the list, so what you are typing survives the list being
/// redrawn while Claude writes.
export function milestoneInput(t: Texts, add: (title: string) => void, leave: () => void): HTMLElement {
  const row = el("div", "notes-add");
  const field = el("input", "notes-add-field");
  field.placeholder = t.addMilestone;
  field.spellcheck = false;
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && field.value.trim()) {
      add(field.value);
      field.value = "";
    } else if (e.key === "Escape") {
      field.value = "";
      field.blur();
      leave();
    }
  });
  row.append(field);
  return row;
}

/// The tabs over the list, one per kind: only its icon and how many of its items are
/// still open (lit while one of them waits for you), the name on hover. Below them, the picked tab's
/// name, as the list's title. Redrawn with the list.
export function renderTabs(into: HTMLElement, task: Task | undefined, current: Tab, t: Texts, pick: (kind: Tab) => void) {
  const changed = into.dataset.kind !== current;
  into.dataset.kind = current;
  into.replaceChildren();
  const row = el("div", "notes-tab-row");
  const heading = el("h3", "notes-heading", t.kinds[current]);
  heading.dataset.kind = current;
  if (changed) heading.classList.add("switching");
  into.append(row, heading);
  for (const kind of KINDS) {
    const notes = task?.notes.filter((n) => n.kind === kind) ?? [];
    const tab = el("button", kind === current ? "notes-tab active" : "notes-tab");
    tab.dataset.kind = kind;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(kind === current));
    const icon = el("span", "notes-tab-icon");
    icon.innerHTML = KIND_ICON[kind];
    const count = el("span", "notes-count", String(notes.filter(isOpen).length));
    if (notes.some(needsYou)) count.classList.add("pending");
    tab.title = t.kinds[kind];
    tab.setAttribute("aria-label", t.kinds[kind]);
    tab.append(icon, count);
    tab.addEventListener("mousedown", (e) => e.preventDefault());
    tab.addEventListener("click", () => pick(kind));
    row.append(tab);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/// A button that asks twice: the first click turns it red with the question, the second,
/// within CONFIRM_MS, does it. Left alone, it goes back by itself. Both labels share one
/// cell, so the button doesn't change width.
export function confirmButton(label: string, confirm: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el("button", `notes-confirm ${cls}`);
  const first = el("span", "", label);
  const second = el("span", "", confirm);
  second.setAttribute("aria-hidden", "true");
  b.append(first, second);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (on: boolean) => {
    b.classList.toggle("confirming", on);
    first.setAttribute("aria-hidden", String(on));
    second.setAttribute("aria-hidden", String(!on));
  };
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      arm(false);
      run();
      return;
    }
    arm(true);
    timer = setTimeout(() => {
      timer = undefined;
      arm(false);
    }, CONFIRM_MS);
  });
  return b;
}

const when = (t: number, language: string) =>
  new Date(t).toLocaleString(language === "pt" ? "pt-BR" : "en", { dateStyle: "short", timeStyle: "short" });

/// The item's Markdown, its mermaid diagrams drawn once the list is on screen.
function noteBody(n: Note): HTMLElement {
  const body = el("div", "note-body markdown");
  body.innerHTML = markdown(n.body, 3);
  return body;
}

function noteCard(n: Note, t: Texts, language: string, actions: NoteActions, subtasks: Note[]): HTMLElement {
  const card = el("article", "note");
  card.dataset.kind = n.kind;
  card.dataset.status = n.status;

  // The first line is the item's bar: its id, status and what you can do with it. The
  // title gets the whole line below.
  const bar = el("div", "note-bar");
  const status = el("button", "note-status", t.statuses[n.status]);
  status.title = t.changeStatus;
  status.addEventListener("mousedown", (e) => e.preventDefault());
  status.addEventListener("click", () =>
    actions.menu(
      status,
      STATUSES[n.kind].map((s) => ({
        label: t.statuses[s],
        chosen: s === n.status,
        onSelect: () => actions.setStatus(n.id, s),
      })),
    ),
  );
  bar.append(el("span", "note-id", n.id), status);
  if (n.kind === "milestone" && subtasks.length) {
    bar.append(el("span", "note-progress", `${subtasks.filter((s) => !isOpen(s)).length}/${subtasks.length}`));
  }
  bar.append(el("span", "note-spacer"));
  if (isOpen(n) && n.kind !== "report") {
    const done = el("button", "note-done", `✓ ${t.done}`);
    done.title = t.doneHint(t.statuses[settled(n.kind)]);
    done.addEventListener("mousedown", (e) => e.preventDefault());
    done.addEventListener("click", () => actions.setStatus(n.id, settled(n.kind)));
    bar.append(done);
  }
  const replyButton = el("button", "note-reply-btn", t.reply);
  replyButton.addEventListener("mousedown", (e) => e.preventDefault());
  bar.append(replyButton, confirmButton(t.remove, t.confirmRemove, "note-remove", () => actions.remove(n.id)));
  card.append(bar, el("div", "note-title", n.title));

  if (n.body) card.append(noteBody(n));
  if (n.kind === "milestone") card.append(subtaskList(subtasks, t, actions), subtaskInput(n.id, t, actions));
  if (n.history.length) card.append(historyList(n, t));
  card.append(el("div", "note-meta", when(n.createdAt, language)));
  card.append(replyBox(n, t, actions, replyButton));
  return card;
}

/// A milestone's subtasks: a checkbox each, its Markdown below when it has some.
function subtaskList(subtasks: Note[], t: Texts, actions: NoteActions): HTMLElement {
  const list = el("ul", "note-subtasks");
  for (const n of subtasks) {
    const item = el("li", "note-subtask");
    item.dataset.status = n.status;
    const row = el("label", "note-subtask-row");
    const box = el("input", "note-check");
    box.type = "checkbox";
    box.checked = n.status === "done";
    box.addEventListener("change", () => actions.setStatus(n.id, box.checked ? "done" : "todo"));
    row.append(box, el("span", "note-subtask-title", n.title), el("span", "note-id", n.id));
    row.append(confirmButton(t.remove, t.confirmRemove, "note-remove", () => actions.remove(n.id)));
    item.append(row);
    if (n.body) item.append(noteBody(n));
    list.append(item);
  }
  return list;
}

/// Under a milestone's subtasks, the field where you write one more: Enter adds it, Esc
/// leaves. What you are typing is kept in `drafts`, for the list redrawn meanwhile.
function subtaskInput(milestone: string, t: Texts, actions: NoteActions): HTMLElement {
  const key = `+${milestone}`;
  const field = el("input", "note-subtask-field");
  field.placeholder = t.addSubtask;
  field.spellcheck = false;
  field.dataset.id = key;
  field.value = actions.drafts.get(key) ?? "";
  field.addEventListener("input", () => {
    if (field.value) actions.drafts.set(key, field.value);
    else actions.drafts.delete(key);
  });
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing && field.value.trim()) {
      actions.drafts.delete(key);
      actions.addSubtask(milestone, field.value);
    } else if (e.key === "Escape") {
      actions.drafts.delete(key);
      field.value = "";
      field.blur();
    }
  });
  return field;
}

/// What changed in the item and what was said about it, in order.
function historyList(n: Note, t: Texts): HTMLElement {
  const list = el("ul", "note-history");
  for (const h of n.history) {
    const li = el("li", "");
    li.append(el("span", "note-who", h.by === "you" ? t.you : "Claude"));
    if (h.status) li.append(el("span", "note-to", `→ ${t.statuses[h.status]}`));
    if (h.note) li.append(el("span", "note-said", h.note));
    list.append(li);
  }
  return list;
}

/// The reply under an item: a text box, Enter sends (⇧Enter breaks the line), Esc or
/// Cancel close it. It opens and closes sliding, and what was typed stays in `drafts`.
function replyBox(n: Note, t: Texts, actions: NoteActions, opener: HTMLButtonElement): HTMLElement {
  const box = el("div", "note-reply");
  const inner = el("div", "note-reply-inner");
  const field = el("textarea", "note-reply-field");
  field.rows = 3;
  field.placeholder = t.replyPlaceholder;
  field.dataset.id = n.id;
  const error = el("p", "note-reply-error");
  error.hidden = true;
  const cancel = el("button", "note-reply-cancel", t.cancel);
  const send = el("button", "note-reply-send", t.send);
  const row = el("div", "note-reply-row");
  row.append(error, cancel, send);
  inner.append(field, row);
  box.append(inner);

  const draft = actions.drafts.get(n.id);
  const setOpen = (open: boolean) => {
    box.classList.toggle("open", open);
    opener.classList.toggle("on", open);
    if (open) {
      if (!actions.drafts.has(n.id)) actions.drafts.set(n.id, "");
    } else {
      actions.drafts.delete(n.id);
      field.value = "";
      error.hidden = true;
    }
  };
  if (draft !== undefined) {
    field.value = draft;
    setOpen(true);
  }

  const submit = () => {
    if (!field.value.trim()) return;
    const why = actions.reply(n.id, field.value);
    if (why) {
      error.textContent = why;
      error.hidden = false;
      return;
    }
    setOpen(false);
  };
  opener.addEventListener("click", () => {
    const open = !box.classList.contains("open");
    setOpen(open);
    if (open) field.focus();
  });
  cancel.addEventListener("click", () => setOpen(false));
  send.addEventListener("click", submit);
  field.addEventListener("input", () => {
    actions.drafts.set(n.id, field.value);
    error.hidden = true;
  });
  field.addEventListener("keydown", (e) => {
    // Esc closes the reply, not the window it is in.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  });
  return box;
}

/// Replaces `into`'s content with the task's items of one tab. Keeps the scroll when
/// the tab is the same: the list is redrawn whenever Claude writes, and jumping to the
/// top under the reader would lose their place. Another tab fades in from the top.
export function renderNotes(into: HTMLElement, task: Task | undefined, kind: Tab, t: Texts, language: string, actions: NoteActions) {
  const same = into.dataset.kind === kind;
  const scroll = same ? into.scrollTop : 0;
  // A reply or a subtask being typed keeps the cursor where it was across the redraw.
  const active = document.activeElement;
  const typing =
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && into.contains(active)
      ? { id: active.dataset.id, at: active.selectionStart }
      : undefined;
  // The diagrams already drawn stay, when the same ones come back: drawing them again
  // would flicker on every write.
  const drawn = new Map<string, HTMLElement[]>();
  for (const d of into.querySelectorAll<HTMLElement>(".viewer-mermaid[data-source]")) {
    const source = d.dataset.source!;
    drawn.set(source, [...(drawn.get(source) ?? []), d]);
  }
  into.dataset.kind = kind;
  into.replaceChildren();
  const notes = task?.notes.filter((n) => n.kind === kind) ?? [];
  const subtasks = (id?: string) => task?.notes.filter((n) => n.kind === "todo" && n.milestone === id) ?? [];
  const loose = kind === "milestone" ? task?.notes.filter((n) => n.kind === "todo" && !notes.some((m) => m.id === n.milestone)) ?? [] : [];
  if (!notes.length && !loose.length) {
    into.append(el("p", "notes-empty", task?.notes.length ? t.emptyKind[kind] : t.empty));
  } else {
    into.append(...notes.map((n) => noteCard(n, t, language, actions, subtasks(n.id))));
    // Subtasks written before milestones existed, or whose milestone was deleted.
    if (loose.length) {
      const group = el("article", "note note-loose");
      group.dataset.kind = "milestone";
      group.append(el("div", "note-title", t.noMilestone), subtaskList(loose, t, actions));
      into.append(group);
    }
  }
  for (const block of into.querySelectorAll<HTMLElement>("pre.mermaid")) {
    const kept = drawn.get(block.textContent ?? "")?.shift();
    if (kept) block.replaceWith(kept);
  }
  actions.mermaid(into);
  into.scrollTop = scroll;
  if (typing?.id) {
    const field = into.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-id="${typing.id}"]`);
    field?.focus();
    if (typing.at !== null) field?.setSelectionRange(typing.at, typing.at);
  }
  if (!same) {
    into.classList.remove("switching");
    void into.offsetWidth;
    into.classList.add("switching");
  }
}
