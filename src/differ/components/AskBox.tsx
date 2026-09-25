import { structuredPatch } from "diff";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { claudeSessions, type AskChange } from "../api";
import * as asks from "../lib/asks";
import type { AskState } from "../lib/asks";
import { rangeLabel } from "../lib/bookmarks";
import type { ClaudeSession, FileDiff } from "../types";
import { Icon } from "./Icons";

const MODELS = [
  { id: "", label: "Modelo padrão" },
  { id: "haiku", label: "Haiku — rápido" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus — mais cuidadoso" },
];
/** Linhas de diff mostradas por arquivo alterado; o resto se vê na aba pendente. */
const PATCH_MAX_LINES = 300;

// Uma lista por repositório, refeita depois de um tempo: sessões novas aparecem sem reabrir a aba.
const sessionsCache = new Map<string, { at: number; list: Promise<ClaudeSession[]> }>();
function sessionsOf(root: string): Promise<ClaudeSession[]> {
  const hit = sessionsCache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = claudeSessions(root);
  list.catch(() => sessionsCache.delete(root));
  sessionsCache.set(root, { at: Date.now(), list });
  return list;
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

/** Markdown só o bastante para a resposta ler bem: blocos de código, `código` e **negrito**. */
function Answer({ text }: { text: string }) {
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <div className="ask-answer">
      {blocks.map((b, i) =>
        i % 2 ? (
          <pre key={i} className="bookmark-quote">
            {b.replace(/\n$/, "")}
          </pre>
        ) : (
          <div key={i}>{inline(b)}</div>
        ),
      )}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** O diff de um arquivo que o Claude mexeu, recolhível, com as contas de linhas no cabeçalho. */
function ChangeView({ change }: { change: AskChange }) {
  const [open, setOpen] = useState(true);
  const patch = useMemo(() => {
    if (change.before === null && change.after === null) return null;
    const p = structuredPatch(change.path, change.path, change.before ?? "", change.after ?? "", "", "", { context: 2 });
    let add = 0;
    let del = 0;
    const lines: { kind: string; text: string }[] = [];
    for (const h of p.hunks) {
      lines.push({ kind: "hunk", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
      for (const l of h.lines) {
        if (l.startsWith("\\")) continue;
        const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
        if (kind === "add") add++;
        if (kind === "del") del++;
        lines.push({ kind, text: l });
      }
    }
    return { add, del, lines };
  }, [change]);

  const label =
    change.before === null && change.after !== null && change.undoable
      ? "novo"
      : change.after === null && change.before !== null
        ? "apagado"
        : null;

  return (
    <div className="ask-change">
      <button className="ask-change-head" onClick={() => setOpen(!open)}>
        <Icon name="chevron-down" size={12} className={open ? "file-chevron" : "file-chevron closed"} />
        <span className="ask-change-path">{change.path}</span>
        {label && <span className="badge">{label}</span>}
        {patch ? (
          <span className="ask-change-stat">
            <span className="add">+{patch.add}</span> <span className="del">−{patch.del}</span>
          </span>
        ) : (
          <span className="badge warn">binário ou sem foto — não dá para mostrar</span>
        )}
      </button>
      {open && patch && (
        <pre className="ask-patch">
          {patch.lines.slice(0, PATCH_MAX_LINES).map((l, i) => (
            <div key={i} className={`ask-patch-${l.kind}`}>
              {l.text}
            </div>
          ))}
          {patch.lines.length > PATCH_MAX_LINES && (
            <div className="ask-patch-hunk">… mais {patch.lines.length - PATCH_MAX_LINES} linhas — veja o arquivo na aba pendente</div>
          )}
        </pre>
      )}
    </div>
  );
}

function Changes({ ask, index, root }: { ask: AskState; index: number; root: string }) {
  const turn = ask.turns[index];
  const [undoing, setUndoing] = useState(false);
  if (!turn.changes?.length) return null;
  const undoable = turn.changes.some((c) => c.undoable);
  return (
    <div className={turn.undone ? "ask-changes undone" : "ask-changes"}>
      <div className="ask-changes-head">
        <Icon name="edit" size={13} />
        <span>
          {turn.undone
            ? "Alterações desfeitas"
            : `Alterou ${turn.changes.length} ${turn.changes.length === 1 ? "arquivo" : "arquivos"}`}
        </span>
        <span className="spacer" />
        {!turn.undone && undoable && (
          <button
            className="btn"
            disabled={undoing || !!ask.running}
            title="Volta os arquivos a como estavam antes deste pedido. Arquivo mexido de novo depois disso fica como está."
            onClick={async () => {
              setUndoing(true);
              await asks.undo(ask.id, root, index);
              setUndoing(false);
            }}
          >
            <Icon name="history" size={13} />
            Desfazer
          </button>
        )}
      </div>
      {turn.undoKept && (
        <div className="ask-error">
          Não desfeitos, porque mudaram de novo depois deste pedido: {turn.undoKept.join(", ")}
        </div>
      )}
      {!turn.undone && turn.changes.map((c) => <ChangeView key={c.path} change={c} />)}
    </div>
  );
}

export function AskBox({
  root,
  file,
  ask,
  onDecide,
}: {
  root: string;
  /** A versão do arquivo na tela agora: é dela que sai o contexto de cada pergunta. */
  file: FileDiff;
  ask: AskState;
  /** Vira marcador (ou reescreve o do qual a pergunta saiu) com o que ficou decidido. */
  onDecide(note: string): void | Promise<void>;
}) {
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const { id, turns, input, model, session, allowEdits, running, decision, draft, noteError } = ask;
  const set = (patch: Partial<AskState>) => asks.update(id, patch);

  useEffect(() => {
    let live = true;
    sessionsOf(root)
      .then((list) => live && setSessions(list))
      .catch(() => live && setSessions([]));
    return () => {
      live = false;
    };
  }, [root]);

  const send = () => asks.send(id, root, file);
  const draftNote = () => asks.draftNote(id, root, file);
  const sessionTitle = sessions?.find((s) => s.id === session)?.title;
  const answered = turns.some((t) => t.answer);

  return (
    <div className="bookmark ask">
      <div className="bookmark-head">
        <Icon name="sparkle" />
        <span>{rangeLabel({ side: ask.side, startLine: ask.start, endLine: ask.end })}</span>
        {sessionTitle && (
          <span className="badge" title="As perguntas rodam numa cópia desta sessão, que continua intacta">
            {sessionTitle}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          title={running ? "Fechar e cancelar a pergunta" : "Fechar pergunta"}
          onClick={() => asks.close(id)}
        >
          <Icon name="x" />
        </button>
      </div>
      {ask.quote && <pre className="bookmark-quote">{ask.quote}</pre>}
      {ask.note && <div className="bookmark-note ask-note">{ask.note}</div>}

      {turns.map((t, i) => (
        <div className="ask-turn" key={i}>
          <div className="ask-question">
            {t.question}
            {t.edits && <span className="badge warn">alterações liberadas</span>}
          </div>
          {t.answer !== undefined && <Answer text={t.answer} />}
          <Changes ask={ask} index={i} root={root} />
          {t.error && <div className="ask-error">{t.error}</div>}
          {t.answer === undefined && !t.error && (
            <div className="ask-waiting">
              {t.edits ? "Alterando…" : session ? "Perguntando, com a sessão como contexto…" : "Perguntando…"}
              <button className="link-btn" onClick={() => asks.cancel(id)}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      ))}

      {draft !== null ? (
        <>
          <div className="ask-label">Marcador que vai para o agente — revise antes de salvar</div>
          <textarea
            autoFocus
            rows={4}
            value={draft}
            onChange={(e) => set({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                e.preventDefault();
                onDecide(draft.trim());
              } else if (e.key === "Escape") {
                e.preventDefault();
                set({ draft: null });
              }
            }}
          />
          <div className="bookmark-actions">
            <span className="hint">⌘↩ salva · Esc volta à decisão</span>
            <button className="btn" onClick={() => set({ draft: null })}>
              Refazer
            </button>
            <button className="btn primary" disabled={!draft.trim()} onClick={() => onDecide(draft.trim())}>
              {ask.bookmarkId ? "Reescrever marcador" : "Criar marcador"}
            </button>
          </div>
        </>
      ) : decision !== null ? (
        <>
          <div className="ask-label">O que você decidiu? O modelo escreve o marcador a partir da conversa.</div>
          <textarea
            autoFocus
            rows={2}
            value={decision}
            disabled={!!running}
            placeholder="Ex.: vamos pela segunda opção, mas sem mexer na API pública"
            onChange={(e) => set({ decision: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                draftNote();
              } else if (e.key === "Escape" && !running) {
                e.preventDefault();
                set({ decision: null });
              }
            }}
          />
          {noteError && <div className="ask-error">{noteError}</div>}
          {running ? (
            <div className="ask-waiting">
              Escrevendo o marcador…
              <button className="link-btn" onClick={() => asks.cancel(id)}>
                Cancelar
              </button>
            </div>
          ) : (
            <div className="bookmark-actions">
              <span className="hint">⌘↩ elabora · Esc volta</span>
              <button className="btn" onClick={() => set({ decision: null })}>
                Voltar
              </button>
              <button className="btn primary" disabled={!decision.trim()} onClick={draftNote}>
                Elaborar marcador
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <textarea
            autoFocus
            rows={2}
            value={input}
            disabled={!!running}
            placeholder={
              allowEdits
                ? "O que o Claude deve alterar? Dá para ver e desfazer depois."
                : turns.length
                  ? "Continuar a conversa… (ou ajustar o que ele alterou)"
                  : "O que você quer saber sobre este trecho?"
            }
            onChange={(e) => set({ input: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && !input && !turns.length) {
                e.preventDefault();
                asks.close(id);
              }
            }}
          />
          <div className="bookmark-actions ask-actions">
            <select
              value={model}
              disabled={!!running}
              onChange={(e) => asks.setModel(id, e.target.value)}
              title="Modelo que responde"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              value={session}
              disabled={!!running}
              onChange={(e) => set({ session: e.target.value })}
              title="Mencionar uma sessão: a resposta sabe do que foi conversado nela. Mais lento e mais caro — carrega a conversa inteira."
            >
              <option value="">Sem sessão — rápido</option>
              {sessions === null && <option disabled>Carregando sessões…</option>}
              {sessions?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {ago(s.modified)}
                </option>
              ))}
            </select>
            <label
              className={allowEdits ? "ask-edits on" : "ask-edits"}
              title="Desligado, o Claude só conversa: não tem nem as ferramentas de edição. Ligado, pode editar os arquivos do repositório — e o que ele mudar aparece aqui para ver e desfazer."
            >
              <input
                type="checkbox"
                checked={allowEdits}
                disabled={!!running}
                onChange={(e) => set({ allowEdits: e.target.checked })}
              />
              Permitir alterações
            </label>
            <span className="hint">⌘↩ {allowEdits ? "envia" : "pergunta"}</span>
            {answered && (
              <button className="btn" disabled={!!running} onClick={() => set({ decision: "" })}>
                <Icon name="bookmark" size={13} />
                Registrar decisão
              </button>
            )}
            <button className="btn primary" disabled={!input.trim() || !!running} onClick={send}>
              {allowEdits ? "Pedir alteração" : "Perguntar"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
