// The questions to Claude live here, not in the file view. The pending tab
// redoes itself when the disk changes — and a question with edits allowed
// changes the disk. If the conversation lived in the component, it would vanish (and the process
// would die) in the middle of the very change one wanted to see.

import { T } from "../../i18n/differ";
import { useSyncExternalStore } from "react";
import { askClaude, cancelAsk, undoAsk, type AskChange } from "../api";
import type { FileDiff, Side } from "../types";
import { getBlob } from "./blobs";
import { rangeLabel } from "./bookmarks";

/** Where the question is pinned and where it came from. */
export interface Ask {
  id: string;
  path: string;
  side: Side;
  start: number;
  end: number;
  quote?: string;
  /** A question asked from a bookmark: the decision rewrites its comment. */
  bookmarkId?: string;
  /** The bookmark's comment, which goes into the context. */
  note?: string;
}

export interface Turn {
  question: string;
  /** Asked with edits allowed. */
  edits?: boolean;
  answer?: string;
  error?: string;
  /** What Claude changed in the files this time, to see and be able to undo. */
  changes?: AskChange[];
  undone?: boolean;
  /** Files that couldn't be undone (someone changed them again afterwards). */
  undoKept?: string[];
}

export interface AskState extends Ask {
  turns: Turn[];
  input: string;
  model: string;
  session: string;
  allowEdits: boolean;
  /** Id of the process in progress (question or bookmark drafting). */
  running: string | null;
  /** What the reviewer says they decided, in a few words. */
  decision: string | null;
  /** The bookmark the model wrote from the decision, editable before saving. */
  draft: string | null;
  noteError: string | null;
}

const MODEL_KEY = "differ.ask.model";
/** The file's diff goes into the context up to this many lines; beyond that, only the snippet. */
const DIFF_MAX_LINES = 600;

let asks: AskState[] = [];
const listeners = new Set<() => void>();
const byPath = new Map<string, AskState[]>();

function emit() {
  byPath.clear();
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const NONE: AskState[] = [];

/** A file's questions; the same list as long as nothing in them changes. */
function asksOf(path: string): AskState[] {
  let list = byPath.get(path);
  if (!list) {
    list = asks.filter((a) => a.path === path);
    if (!list.length) list = NONE;
    byPath.set(path, list);
  }
  return list;
}

export function useAsks(path: string): AskState[] {
  return useSyncExternalStore(subscribe, () => asksOf(path));
}

const get = (id: string) => asks.find((a) => a.id === id);

export function update(id: string, patch: Partial<AskState>) {
  if (!get(id)) return;
  asks = asks.map((a) => (a.id === id ? { ...a, ...patch } : a));
  emit();
}

function savedModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "haiku";
  } catch {
    return "haiku";
  }
}

export function setModel(id: string, model: string) {
  update(id, { model });
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    // It just isn't remembered for next time.
  }
}

export function open(ask: Omit<Ask, "id">, question = "") {
  const id = `${ask.path}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  asks = [
    ...asks,
    {
      ...ask,
      id,
      turns: [],
      input: question,
      model: savedModel(),
      session: "",
      // Never remembered across boxes: every question starts as conversation only.
      allowEdits: false,
      running: null,
      decision: null,
      draft: null,
      noteError: null,
    },
  ];
  emit();
}

/** Closes the box. Only here (and on cancel) does the process in progress die. */
export function close(id: string) {
  const a = get(id);
  if (a?.running) cancelAsk(a.running).catch(() => {});
  asks = asks.filter((x) => x.id !== id);
  emit();
}

function diffText(file: FileDiff): string | null {
  const out: string[] = [];
  for (const h of file.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}`.trimEnd());
    for (const l of h.lines) out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.content);
    if (out.length > DIFF_MAX_LINES) return null;
  }
  return out.join("\n");
}

/** What goes through stdin: where the snippet is, what it says, the surrounding diff and the conversation so far. */
async function buildContext(root: string, file: FileDiff, ask: AskState, turns: Turn[]): Promise<string> {
  const parts: string[] = [];
  const version = ask.side === "old" ? T.versaoAnteriorAntes : T.versaoNova;
  parts.push(T.arquivoVersao(ask.side === "old" && file.oldPath ? file.oldPath : file.path, version));
  parts.push(`${rangeLabel({ side: ask.side, startLine: ask.start, endLine: ask.end })}:`);

  const oid = ask.side === "new" ? file.newOid : file.oldOid;
  try {
    if (oid) {
      const lines = (await getBlob(root, oid)).slice(ask.start - 1, ask.end);
      parts.push(lines.map((l, i) => `${ask.start + i} | ${l}`).join("\n"));
    }
  } catch {
    // Without the content, Claude still has the path and the lines to read on its own.
  }
  if (ask.quote) parts.push(`${T.trechoSelecionado}\n${ask.quote}`);
  if (ask.note) parts.push(`${T.comentarioJaFeito}\n${ask.note}`);

  const diff = diffText(file);
  parts.push(diff ? `${T.diffDoArquivo}\n${diff}` : T.diffGrandeDemais);

  const done = turns.filter((t) => t.answer);
  if (done.length) {
    const turnText = (t: Turn) => {
      const lines = [`${T.pergunta} ${t.question}`, `${T.resposta} ${t.answer}`];
      if (t.changes?.length) {
        const files = t.changes.map((c) => c.path).join(", ");
        lines.push(t.undone ? T.alteracoesDesfeitas(files) : T.alterou(files));
      }
      return lines.join("\n");
    };
    parts.push(`${T.conversaAteAqui}\n` + done.map(turnText).join("\n\n"));
  }
  return parts.join("\n\n");
}

/**
 * The request to write the bookmark. The decision is the reviewer's; the conversation only comes in to make
 * the text precise — it is what keeps the final agent from getting back an already settled discussion.
 */
function decisionPrompt(decision: string): string {
  return T.pedidoDoMarcador(decision);
}

/**
 * Sends the typed question. `file` is the version of the file on screen now: the context comes
 * from it, and the rest runs without depending on any component being mounted.
 */
export async function send(id: string, root: string, file: FileDiff) {
  const a = get(id);
  const question = a?.input.trim();
  if (!a || !question || a.running) return;
  const run = `${id}:${a.turns.length}`;
  const history = a.turns;
  const edits = a.allowEdits;
  update(id, { turns: [...history, { question, edits }], input: "", running: run });

  let result: Turn;
  try {
    const context = await buildContext(root, file, a, history);
    const res = await askClaude(root, run, question, context, a.model || null, a.session || null, edits);
    result = { question, edits, answer: res.answer, changes: res.changes.length ? res.changes : undefined };
  } catch (err) {
    result = { question, edits, error: String(err) };
  }
  // Closed or cancelled while running: the answer has nowhere to go anymore.
  if (get(id)?.running !== run) return;
  update(id, { running: null, turns: [...history, result] });
}

export function cancel(id: string) {
  const a = get(id);
  if (!a?.running) return;
  cancelAsk(a.running).catch(() => {});
  // Cancelling the bookmark drafting doesn't touch the conversation; cancelling the question removes it.
  const drafting = a.running.endsWith(":decisao");
  update(id, { running: null, turns: drafting ? a.turns : a.turns.slice(0, -1) });
}

// The whole conversation already goes in the context, so the text goes out without mentioning a session: faster and cheaper.
export async function draftNote(id: string, root: string, file: FileDiff) {
  const a = get(id);
  const said = a?.decision?.trim();
  if (!a || !said || a.running) return;
  const run = `${id}:decisao`;
  update(id, { running: run, noteError: null });
  let text: string | null = null;
  let error: string | null = null;
  try {
    const context = await buildContext(root, file, a, a.turns);
    text = (await askClaude(root, run, decisionPrompt(said), context, a.model || null, null)).answer.trim();
  } catch (err) {
    error = String(err);
  }
  if (get(id)?.running !== run) return;
  update(id, text ? { running: null, draft: text } : { running: null, noteError: error ?? T.modeloSemTexto });
}

export async function undo(id: string, root: string, turnIndex: number) {
  const a = get(id);
  const changes = a?.turns[turnIndex]?.changes;
  if (!a || !changes) return;
  let kept: string[];
  try {
    kept = await undoAsk(root, changes);
  } catch (err) {
    kept = changes.map((c) => `${c.path} (${String(err)})`);
  }
  const now = get(id);
  if (!now) return;
  update(id, {
    turns: now.turns.map((t, i) => (i === turnIndex ? { ...t, undone: true, undoKept: kept.length ? kept : undefined } : t)),
  });
}
