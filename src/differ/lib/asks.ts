// As perguntas ao Claude moram aqui, e não na visão do arquivo. A aba pendente se
// refaz sozinha quando o disco muda — e uma pergunta com alterações liberadas
// muda o disco. Se a conversa morasse no componente, ela sumiria (e o processo
// morreria) no meio da própria alteração que se queria ver.

import { T } from "../../i18n/differ";
import { useSyncExternalStore } from "react";
import { askClaude, cancelAsk, undoAsk, type AskChange } from "../api";
import type { FileDiff, Side } from "../types";
import { getBlob } from "./blobs";
import { rangeLabel } from "./bookmarks";

/** Onde a pergunta está presa e de onde ela veio. */
export interface Ask {
  id: string;
  path: string;
  side: Side;
  start: number;
  end: number;
  quote?: string;
  /** Pergunta feita a partir de um marcador: a decisão reescreve o comentário dele. */
  bookmarkId?: string;
  /** O comentário do marcador, que entra no contexto. */
  note?: string;
}

export interface Turn {
  question: string;
  /** Feita com alterações liberadas. */
  edits?: boolean;
  answer?: string;
  error?: string;
  /** O que o Claude mexeu nos arquivos nesta vez, para ver e poder desfazer. */
  changes?: AskChange[];
  undone?: boolean;
  /** Arquivos que não deu para desfazer (alguém mexeu de novo depois). */
  undoKept?: string[];
}

export interface AskState extends Ask {
  turns: Turn[];
  input: string;
  model: string;
  session: string;
  allowEdits: boolean;
  /** Id do processo em andamento (pergunta ou elaboração do marcador). */
  running: string | null;
  /** O que o revisor diz que decidiu, em poucas palavras. */
  decision: string | null;
  /** O marcador que o modelo escreveu a partir da decisão, editável antes de salvar. */
  draft: string | null;
  noteError: string | null;
}

const MODEL_KEY = "differ.ask.model";
/** O diff do arquivo vai no contexto até este tanto de linhas; depois disso, só o trecho. */
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

/** As perguntas de um arquivo; a mesma lista enquanto nada nelas muda. */
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
    // Só não fica lembrado para a próxima.
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
      // Nunca lembrado entre caixas: cada pergunta começa só conversando.
      allowEdits: false,
      running: null,
      decision: null,
      draft: null,
      noteError: null,
    },
  ];
  emit();
}

/** Fecha a caixa. Só aqui (e no cancelar) o processo em andamento morre. */
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

/** O que vai pelo stdin: onde o trecho está, o que ele diz, o diff em volta e a conversa até aqui. */
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
    // Sem o conteúdo, o Claude ainda tem o caminho e as linhas para ler sozinho.
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
 * O pedido para escrever o marcador. A decisão é do revisor; a conversa só entra para dar precisão
 * ao texto — é o que impede o agente final de receber de volta uma discussão já encerrada.
 */
function decisionPrompt(decision: string): string {
  return T.pedidoDoMarcador(decision);
}

/**
 * Manda a pergunta digitada. `file` é a versão do arquivo que está na tela agora: o contexto sai
 * dela, e o resto roda sem depender de componente nenhum estar montado.
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
  // Fechada ou cancelada enquanto rodava: a resposta não tem mais onde ir.
  if (get(id)?.running !== run) return;
  update(id, { running: null, turns: [...history, result] });
}

export function cancel(id: string) {
  const a = get(id);
  if (!a?.running) return;
  cancelAsk(a.running).catch(() => {});
  // Cancelar a elaboração do marcador não mexe na conversa; cancelar a pergunta tira ela.
  const drafting = a.running.endsWith(":decisao");
  update(id, { running: null, turns: drafting ? a.turns : a.turns.slice(0, -1) });
}

// A conversa já vai inteira no contexto, então o texto sai sem mencionar sessão: mais rápido e barato.
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
