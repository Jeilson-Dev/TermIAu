/// The task's notebook: what Claude decided on its own, what it couldn't settle, what
/// it found out and what it reported at the end of each piece of work, kept per task — the repository and branch it happened on — and
/// not in a file in the repository. No DOM here: the messages Claude sends and the
/// text it reads back are pure, and tested.
import type { PanelPlace } from "../../../src/plugins/api";

/// A `todo` is a subtask: it belongs to a `milestone` (or to none, written before
/// milestones existed), and the notebook shows it inside it.
export type Kind = "milestone" | "todo" | "decision" | "question" | "finding" | "report";

/// Each kind's statuses, the first one being where a new item starts.
export const STATUSES = {
  milestone: ["active", "done"],
  todo: ["todo", "done"],
  decision: ["pending", "ratified", "reverted"],
  question: ["open", "answered"],
  finding: ["unconfirmed", "confirmed"],
  report: ["new", "read"],
} as const satisfies Record<Kind, readonly string[]>;

export type Status = (typeof STATUSES)[Kind][number];

/// The letter of each kind's ids: D3, Q1, F2.
const LETTER: Record<Kind, string> = { milestone: "M", todo: "T", decision: "D", question: "Q", finding: "F", report: "R" };

/// Each kind's first id number. A task saved before a kind existed gets it from here.
export const FIRST_IDS: Record<Kind, number> = { milestone: 1, todo: 1, decision: 1, question: 1, finding: 1, report: 1 };

/// A change to an item, as it happened: a new status, a note about it, or both.
export type Change = { at: number; status?: Status; note?: string; by: "claude" | "you" };

export type Note = {
  id: string;
  kind: Kind;
  title: string;
  /// Markdown.
  body: string;
  status: Status;
  /// A subtask's milestone, by id.
  milestone?: string;
  /// The Claude Code session that wrote it.
  session?: string;
  createdAt: number;
  updatedAt: number;
  history: Change[];
};

export type Task = {
  key: string;
  /// The repository's root, or the folder outside a repository.
  root: string;
  branch: string | null;
  /// The last session's title, to tell tasks apart in the list.
  sessionTitle?: string;
  notes: Note[];
  /// The next number of each kind's ids. Never goes back: a deleted D2 isn't reused.
  next: Record<Kind, number>;
  createdAt: number;
  updatedAt: number;
};

/// The task a panel is working on: its repository and branch, or its folder outside
/// a repository. `undefined` before the panel's place is known.
export function taskKey(place: PanelPlace): string | undefined {
  const root = place.repo ?? place.folder;
  if (!root) return;
  return place.repo ? `${root}\0${place.branch ?? ""}` : `${root}\0`;
}

export function newTask(place: PanelPlace, now: number): Task {
  return {
    key: taskKey(place)!,
    root: place.repo ?? place.folder!,
    branch: place.repo ? place.branch : null,
    notes: [],
    next: { ...FIRST_IDS },
    createdAt: now,
    updatedAt: now,
  };
}

/// How the task is called: the repository's folder and the branch.
export function taskName(task: Pick<Task, "root" | "branch">): string {
  const folder = task.root.split("/").filter(Boolean).pop() ?? task.root;
  return task.branch ? `${folder} · ${task.branch}` : folder;
}

/// What came from `termiau send`, already parsed.
type Message =
  | { kind: Kind; title: string; body?: string; status?: Status; milestone?: string }
  | { update: string; status?: Status; note?: string; body?: string; title?: string; milestone?: string }
  | { list: true };

/// What a message did: the task as it is now (the same object when nothing changed)
/// and the answer for whoever sent it — `error: …` when it didn't hold up.
export type Outcome = { task: Task; answer: string; changed: boolean };

const isText = (v: unknown): v is string => typeof v === "string";

/// JSON, forgiving one slip: a Markdown body written with real line breaks (and tabs)
/// inside its string. Those are escaped before parsing; everything else must be JSON.
export function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString && c === "\\") {
        out += c + (text[++i] ?? "");
        continue;
      }
      if (c === '"') inString = !inString;
      out += inString && c === "\n" ? "\\n" : inString && c === "\r" ? "" : inString && c === "\t" ? "\\t" : c;
    }
    if (out === text) throw e;
    return JSON.parse(out);
  }
}

const KINDS = Object.keys(STATUSES) as Kind[];

/// Applies a message from Claude to the task. Every error says what to send instead:
/// it is read by Claude, which then fixes the command.
export function apply(task: Task, text: string, session: string | undefined, now: number): Outcome {
  const fail = (why: string): Outcome => ({ task, answer: `error: ${why}`, changed: false });
  let raw: unknown;
  try {
    raw = parseLenient(text);
  } catch {
    return fail('the message must be JSON, like {"kind":"decision","title":"…","body":"…"}');
  }
  const m = raw as Partial<Record<string, unknown>> | null;
  if (!m || typeof m !== "object") return fail("the message must be a JSON object");

  if (m.list === true) return { task, answer: toMarkdown(task), changed: false };

  if (isText(m.update)) {
    const id = m.update.trim().toUpperCase();
    const note = task.notes.find((n) => n.id === id);
    if (!note) return fail(`no item ${id} in this task's notebook (send {"list":true} to see them)`);
    const status = m.status;
    if (status !== undefined && !(STATUSES[note.kind] as readonly unknown[]).includes(status)) {
      return fail(`the status of a ${note.kind} is one of: ${STATUSES[note.kind].join(", ")}`);
    }
    const remark = isText(m.note) && m.note.trim() ? m.note.trim() : undefined;
    const body = isText(m.body) ? m.body.trim() : undefined;
    const title = isText(m.title) && m.title.trim() ? m.title.trim() : undefined;
    const milestone = isText(m.milestone) ? m.milestone.trim().toUpperCase() : undefined;
    if (milestone !== undefined) {
      if (note.kind !== "todo") return fail('only a todo goes in a milestone');
      if (milestone && !isMilestone(task, milestone)) return fail(`no milestone ${milestone} in this task's notebook (send {"list":true} to see them)`);
    }
    if (status === undefined && !remark && body === undefined && !title && milestone === undefined) {
      return fail('an update needs at least one of "status", "note", "body", "title" or "milestone"');
    }
    const updated: Note = {
      ...note,
      status: (status as Status | undefined) ?? note.status,
      body: body ?? note.body,
      title: title ?? note.title,
      milestone: milestone === undefined ? note.milestone : milestone || undefined,
      updatedAt: now,
      history: status !== undefined || remark ? [...note.history, { at: now, status: status as Status | undefined, note: remark, by: "claude" }] : note.history,
    };
    return {
      task: { ...task, notes: task.notes.map((n) => (n === note ? updated : n)), updatedAt: now },
      answer: `updated ${id}`,
      changed: true,
    };
  }

  const kind = m.kind;
  if (!isText(kind) || !KINDS.includes(kind as Kind)) {
    return fail(`"kind" is one of: ${KINDS.join(", ")} - or send {"update":"D1",…} or {"list":true}`);
  }
  const k = kind as Kind;
  if (!isText(m.title) || !m.title.trim()) return fail('"title" is missing: one line saying what it is');
  const status = m.status ?? STATUSES[k][0];
  if (!(STATUSES[k] as readonly unknown[]).includes(status)) {
    return fail(`the status of a ${k} is one of: ${STATUSES[k].join(", ")}`);
  }
  const milestone = isText(m.milestone) && m.milestone.trim() ? m.milestone.trim().toUpperCase() : undefined;
  if (milestone && k !== "todo") return fail('only a todo goes in a milestone');
  if (milestone && !isMilestone(task, milestone)) {
    return fail(`no milestone ${milestone} in this task's notebook: create it first with {"kind":"milestone","title":"…"}`);
  }
  const id = `${LETTER[k]}${task.next[k]}`;
  const note: Note = {
    id,
    kind: k,
    title: m.title.trim(),
    body: isText(m.body) ? m.body.trim() : "",
    status: status as Status,
    milestone,
    session,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  return {
    task: { ...task, notes: [...task.notes, note], next: { ...task.next, [k]: task.next[k] + 1 }, updatedAt: now },
    answer: `recorded ${id}`,
    changed: true,
  };
}

const isMilestone = (task: Task, id: string) => task.notes.some((n) => n.kind === "milestone" && n.id === id);

/// You changed an item's status by hand, in the notebook. Checking a task off isn't
/// worth a line in its history: the checkbox already says it.
export function setStatus(task: Task, id: string, status: Status, now: number): Task {
  return {
    ...task,
    updatedAt: now,
    notes: task.notes.map((n) =>
      n.id === id && n.status !== status
        ? {
            ...n,
            status,
            updatedAt: now,
            history: n.kind === "todo" ? n.history : [...n.history, { at: now, status, by: "you" }],
          }
        : n,
    ),
  };
}

/// What you wrote to Claude about an item, kept in its history.
export function addComment(task: Task, id: string, text: string, now: number): Task {
  return {
    ...task,
    updatedAt: now,
    notes: task.notes.map((n) =>
      n.id === id ? { ...n, updatedAt: now, history: [...n.history, { at: now, note: text.trim(), by: "you" }] } : n,
    ),
  };
}

/// The message that goes to Claude when you reply to an item: which item, then what you
/// wrote, then the reminder to settle it in the notebook.
export function replyMessage(note: Pick<Note, "id" | "kind" | "status" | "title">, text: string): string {
  return [
    `About notebook item ${note.id} (${note.kind}, ${note.status}): "${note.title}"`,
    text.trim(),
    `When it is settled, update ${note.id} in the notebook.`,
  ].join("\n\n");
}

/// A milestone or a subtask you wrote yourself, in the Milestones tab. A subtask goes
/// in `milestone`.
export function addByHand(task: Task, kind: "milestone" | "todo", title: string, now: number, milestone?: string): Task {
  const note: Note = {
    id: `${LETTER[kind]}${task.next[kind]}`,
    kind,
    title: title.trim(),
    body: "",
    status: STATUSES[kind][0],
    milestone: kind === "todo" ? milestone : undefined,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  return { ...task, notes: [...task.notes, note], next: { ...task.next, [kind]: task.next[kind] + 1 }, updatedAt: now };
}

/// A milestone deleted leaves its subtasks without one: they are still work to do.
export function removeNote(task: Task, id: string, now: number): Task {
  return {
    ...task,
    notes: task.notes.filter((n) => n.id !== id).map((n) => (n.milestone === id ? { ...n, milestone: undefined } : n)),
    updatedAt: now,
  };
}

/// Still open: in its kind's first status, the one it starts at.
export const isOpen = (n: Note) => n.status === STATUSES[n.kind][0];

/// The status that settles an item: the one "Done" sets.
export const settled = (kind: Kind): Status => STATUSES[kind][1];

/// What still needs someone: open questions and decisions nobody ratified yet.
export const isPending = (n: Note) => (n.kind === "question" || n.kind === "decision") && isOpen(n);

/// What the notebook points out to you: the pending ones and the reports not read yet.
export const needsYou = (n: Note) => isPending(n) || (n.kind === "report" && isOpen(n));

/// The reports were read: shown on screen. No history for it — reading isn't a change
/// to the report.
export function markRead(task: Task, now: number): Task {
  if (!task.notes.some((n) => n.kind === "report" && n.status === "new")) return task;
  return {
    ...task,
    updatedAt: now,
    notes: task.notes.map((n) => (n.kind === "report" && n.status === "new" ? { ...n, status: "read" as const } : n)),
  };
}

/// How many items of each kind are still open — settling one takes it off the count —
/// and how many of all wait for you.
export function counts(task: Task | undefined): Record<Kind, number> & { pending: number } {
  const c = { milestone: 0, todo: 0, decision: 0, question: 0, finding: 0, report: 0, pending: 0 };
  for (const n of task?.notes ?? []) {
    if (isOpen(n)) c[n.kind]++;
    if (isPending(n)) c.pending++;
  }
  return c;
}

const HEADINGS: Record<Kind, string> = {
  milestone: "Milestones",
  todo: "Subtasks",
  decision: "Decisions",
  question: "Open questions",
  finding: "Findings",
  report: "Reports",
};

/// The notebook as Markdown: what `{"list":true}` answers Claude, and what an export
/// will hand to someone. Grouped by kind, in the order they were written.
export function toMarkdown(task: Task): string {
  if (task.notes.length === 0) return `# ${taskName(task)}\n\nThe notebook is empty.`;
  const out = [`# ${taskName(task)}`];
  for (const kind of KINDS) {
    const notes = task.notes.filter((n) => n.kind === kind);
    if (!notes.length) continue;
    out.push(`## ${HEADINGS[kind]}`);
    for (const n of notes) {
      out.push(`### ${n.id} - ${n.title} [${n.status}]${n.kind === "todo" && n.milestone ? ` (in ${n.milestone})` : ""}`);
      if (n.body) out.push(n.body);
      for (const h of n.history) {
        const what = [h.status && `→ ${h.status}`, h.note].filter(Boolean).join(": ");
        if (what) out.push(`- ${h.by === "you" ? "User" : "Claude"}: ${what}`);
      }
    }
  }
  return out.join("\n\n");
}
