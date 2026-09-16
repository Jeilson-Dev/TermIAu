import { useEffect, useState } from "react";
import { rangeLabel } from "../lib/bookmarks";
import type { FixStatus } from "../lib/fixes";
import type { Bookmark } from "../types";
import { Icon } from "./Icons";

const FIX_BADGES: Record<FixStatus, { tone: string; label: string; title: string } | null> = {
  changed: { tone: "ok", label: "trecho alterado", title: "Estas linhas mudaram desde a última revisão completa" },
  unchanged: { tone: "warn", label: "trecho intocado", title: "O arquivo mudou, mas não nestas linhas" },
  fileUnchanged: {
    tone: "warn",
    label: "arquivo intocado",
    title: "Este arquivo não mudou desde a última revisão completa",
  },
  lost: { tone: "warn", label: "não localizado", title: "Estas linhas não estão na versão revisada" },
  new: null,
};

/** What changed in the bookmark's lines since the last complete review (incremental review). */
export function FixBadge({ status }: { status: FixStatus | undefined }) {
  const badge = status && FIX_BADGES[status];
  if (!badge) return null;
  return (
    <span className={`badge ${badge.tone}`} title={badge.title}>
      {badge.label}
    </span>
  );
}

export function ResolveButton({ resolved, size, onToggle }: { resolved: boolean; size?: number; onToggle(): void }) {
  return (
    <button
      className={resolved ? "icon-btn resolve on" : "icon-btn resolve"}
      title={resolved ? "Resolvido — clique para reabrir" : "Marcar como resolvido"}
      aria-pressed={resolved}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="check" size={size} />
    </button>
  );
}

/** Copies the bookmark as a prompt-ready reference, confirming with a check for a moment. */
export function CopyReferenceButton({ reference, size }: { reference: string; size?: number }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className={copied ? "icon-btn copied" : "icon-btn"}
      title="Copiar referência (caminho:linhas + comentário) para colar num prompt"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(reference).then(() => setCopied(true));
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
    </button>
  );
}

export function BookmarkBox({
  bookmark,
  reference,
  status,
  onEdit,
  onRemove,
  onToggleResolved,
}: {
  bookmark: Bookmark;
  reference: string;
  status?: FixStatus;
  onEdit(): void;
  onRemove(): void;
  onToggleResolved(): void;
}) {
  return (
    <div className={bookmark.resolved ? "bookmark resolved" : "bookmark"}>
      <div className="bookmark-head">
        <Icon name="bookmark" />
        <span>{rangeLabel(bookmark)}</span>
        <FixBadge status={status} />
        <span className="spacer" />
        <ResolveButton resolved={!!bookmark.resolved} onToggle={onToggleResolved} />
        <CopyReferenceButton reference={reference} />
        <button className="icon-btn" title="Editar marcador" onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button className="icon-btn danger" title="Remover marcador" onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>
      {bookmark.quote && <pre className="bookmark-quote">{bookmark.quote}</pre>}
      <div className="bookmark-note">{bookmark.note}</div>
    </div>
  );
}

export function BookmarkEditor({
  label,
  quote,
  initial = "",
  onSave,
  onCancel,
}: {
  label: string;
  /** The selected passage the note is about, if it's not about whole lines. */
  quote?: string;
  initial?: string;
  onSave(note: string): void | Promise<void>;
  onCancel(): void;
}) {
  const [note, setNote] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const text = note.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await onSave(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bookmark editing">
      <div className="bookmark-head">
        <Icon name="bookmark" />
        <span>{label}</span>
      </div>
      {quote && <pre className="bookmark-quote">{quote}</pre>}
      <textarea
        autoFocus
        rows={3}
        value={note}
        placeholder={quote ? "O que merece melhoria neste trecho?" : "O que merece melhoria aqui?"}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="bookmark-actions">
        <span className="hint">⌘↩ salva · Esc cancela</span>
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary" disabled={!note.trim() || saving} onClick={submit}>
          {initial ? "Salvar" : "Adicionar marcador"}
        </button>
      </div>
    </div>
  );
}
