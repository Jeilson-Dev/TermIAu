import { structuredPatch } from "diff";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { T } from "../../i18n/differ";
import { claudeSessions, type AskChange } from "../api";
import * as asks from "../lib/asks";
import type { AskState } from "../lib/asks";
import { rangeLabel } from "../lib/bookmarks";
import type { ClaudeSession, FileDiff } from "../types";
import { Icon } from "./Icons";

const MODELS = [
  { id: "", label: T.modeloPadrao },
  { id: "haiku", label: T.haikuRapido },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: T.opusCuidadoso },
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
  if (min < 1) return T.agora;
  if (min < 60) return T.haMin(min);
  const h = Math.round(min / 60);
  if (h < 24) return T.haHoras(h);
  return T.haDias(Math.round(h / 24));
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
          <span className="badge warn">{T.binarioSemFoto}</span>
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
            <div className="ask-patch-hunk">{T.maisLinhas(patch.lines.length - PATCH_MAX_LINES)}</div>
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
          {turn.undone ? T.alteracoesDesfeitasTitulo : T.alterouArquivos(turn.changes.length)}
        </span>
        <span className="spacer" />
        {!turn.undone && undoable && (
          <button
            className="btn"
            disabled={undoing || !!ask.running}
            title={T.desfazerDica}
            onClick={async () => {
              setUndoing(true);
              await asks.undo(ask.id, root, index);
              setUndoing(false);
            }}
          >
            <Icon name="history" size={13} />
            {T.desfazer}
          </button>
        )}
      </div>
      {turn.undoKept && (
        <div className="ask-error">
          {T.naoDesfeitos(turn.undoKept.join(", "))}
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
          <span className="badge" title={T.copiaDaSessaoDica}>
            {sessionTitle}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          title={running ? T.fecharECancelar : T.fecharPergunta}
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
            {t.edits && <span className="badge warn">{T.alteracoesLiberadas}</span>}
          </div>
          {t.answer !== undefined && <Answer text={t.answer} />}
          <Changes ask={ask} index={i} root={root} />
          {t.error && <div className="ask-error">{t.error}</div>}
          {t.answer === undefined && !t.error && (
            <div className="ask-waiting">
              {t.edits ? T.alterando : session ? T.perguntandoComSessao : T.perguntando}
              <button className="link-btn" onClick={() => asks.cancel(id)}>
                {T.cancelar}
              </button>
            </div>
          )}
        </div>
      ))}

      {draft !== null ? (
        <>
          <div className="ask-label">{T.marcadorParaOAgente}</div>
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
            <span className="hint">{T.salvaVoltaDecisao}</span>
            <button className="btn" onClick={() => set({ draft: null })}>
              {T.refazer}
            </button>
            <button className="btn primary" disabled={!draft.trim()} onClick={() => onDecide(draft.trim())}>
              {ask.bookmarkId ? T.reescreverMarcador : T.criarMarcador}
            </button>
          </div>
        </>
      ) : decision !== null ? (
        <>
          <div className="ask-label">{T.oQueDecidiu}</div>
          <textarea
            autoFocus
            rows={2}
            value={decision}
            disabled={!!running}
            placeholder={T.exemploDecisao}
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
              {T.escrevendoMarcador}
              <button className="link-btn" onClick={() => asks.cancel(id)}>
                {T.cancelar}
              </button>
            </div>
          ) : (
            <div className="bookmark-actions">
              <span className="hint">{T.elaboraVolta}</span>
              <button className="btn" onClick={() => set({ decision: null })}>
                {T.voltar}
              </button>
              <button className="btn primary" disabled={!decision.trim()} onClick={draftNote}>
                {T.elaborarMarcador}
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
                ? T.oQueAlterar
                : turns.length
                  ? T.continuarConversa
                  : T.oQueSaber
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
              title={T.modeloQueResponde}
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
              title={T.mencionarSessaoDica}
            >
              <option value="">{T.semSessao}</option>
              {sessions === null && <option disabled>{T.carregandoSessoes}</option>}
              {sessions?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {ago(s.modified)}
                </option>
              ))}
            </select>
            <label
              className={allowEdits ? "ask-edits on" : "ask-edits"}
              title={T.permitirAlteracoesDica}
            >
              <input
                type="checkbox"
                checked={allowEdits}
                disabled={!!running}
                onChange={(e) => set({ allowEdits: e.target.checked })}
              />
              {T.permitirAlteracoes}
            </label>
            <span className="hint">{allowEdits ? T.enviaAtalho : T.perguntaAtalho}</span>
            {answered && (
              <button className="btn" disabled={!!running} onClick={() => set({ decision: "" })}>
                <Icon name="bookmark" size={13} />
                {T.registrarDecisao}
              </button>
            )}
            <button className="btn primary" disabled={!input.trim() || !!running} onClick={send}>
              {allowEdits ? T.pedirAlteracao : T.perguntar}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
