import { useEffect, useState } from "react";
import { T } from "../../i18n/differ";
import { rangeLabel } from "../lib/bookmarks";
import type { FixStatus } from "../lib/fixes";
import type { Bookmark } from "../types";
import { Icon } from "./Icons";

const FIX_BADGES: Record<FixStatus, { tone: string; label: string; title: string } | null> = {
  changed: { tone: "ok", label: T.trechoAlterado, title: T.trechoAlteradoDica },
  unchanged: { tone: "warn", label: T.trechoIntocado, title: T.trechoIntocadoDica },
  fileUnchanged: { tone: "warn", label: T.arquivoIntocado, title: T.arquivoIntocadoDica },
  lost: { tone: "warn", label: T.naoLocalizado, title: T.naoLocalizadoDica },
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
      title={resolved ? T.resolvidoDica : T.marcarResolvido}
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
/** O "copiado" que pisca por um instante e volta ao normal, dos dois botões de copiar. */
function useCopiar(texto: string): [boolean, (e: { stopPropagation(): void }) => void] {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copiar = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    navigator.clipboard.writeText(texto).then(() => setCopied(true));
  };
  return [copied, copiar];
}

export function CopyReferenceButton({ reference, size }: { reference: string; size?: number }) {
  const [copied, copiar] = useCopiar(reference);

  return (
    <button
      className={copied ? "icon-btn copied" : "icon-btn"}
      title={T.copiarReferencia}
      onClick={copiar}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
    </button>
  );
}

/** O caminho do arquivo, no cabeçalho do diff. O ✓ e o "Copiado!" são o aviso. */
export function CopyPathButton({ path }: { path: string }) {
  const [copied, copiar] = useCopiar(path);

  return (
    <button
      className={copied ? "icon-btn subtle copied" : "icon-btn subtle"}
      title={copied ? T.copiado : T.copiarCaminho}
      aria-label={copied ? T.copiado : T.copiarCaminho}
      onClick={copiar}
    >
      <Icon key={copied ? "check" : "copy"} name={copied ? "check" : "copy"} size={14} />
      {copied && (
        <span className="copiado-balao" role="status">
          {T.copiado}
        </span>
      )}
    </button>
  );
}

/** O mesmo, para a revisão inteira: todos os comentários numa colada só. */
export function CopyAllButton({ reference, count }: { reference: string; count: number }) {
  const [copied, copiar] = useCopiar(reference);

  return (
    <button
      className={copied ? "copiar-tudo copied" : "copiar-tudo"}
      title={T.copiarTodosDica}
      onClick={copiar}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? T.copiados : T.copiarTodos(count)}
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
  onAsk,
}: {
  bookmark: Bookmark;
  reference: string;
  status?: FixStatus;
  onEdit(): void;
  onRemove(): void;
  onToggleResolved(): void;
  /** Tirar a dúvida com o Claude antes de decidir o que o marcador diz. */
  onAsk?(): void;
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
        {onAsk && (
          <button className="icon-btn" title={T.perguntarSobreTrecho} onClick={onAsk}>
            <Icon name="sparkle" />
          </button>
        )}
        <button className="icon-btn" title={T.editarMarcador} onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button className="icon-btn danger" title={T.removerMarcador} onClick={onRemove}>
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
  onAsk,
}: {
  label: string;
  /** The selected passage the note is about, if it's not about whole lines. */
  quote?: string;
  initial?: string;
  onSave(note: string): void | Promise<void>;
  onCancel(): void;
  /** Em vez de anotar, perguntar ao Claude — levando o que já foi escrito como pergunta. */
  onAsk?(text: string): void;
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
        placeholder={quote ? T.melhoriaNoTrecho : T.melhoriaAqui}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && onAsk) {
            e.preventDefault();
            onAsk(note.trim());
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="bookmark-actions">
        <span className="hint">{T.salvaCancela}</span>
        <button className="btn" onClick={onCancel}>
          {T.cancelar}
        </button>
        {onAsk && (
          <button className="btn" title={T.perguntarAntesDica} onClick={() => onAsk(note.trim())}>
            <Icon name="sparkle" size={13} />
            {T.perguntarAoClaude}
          </button>
        )}
        <button className="btn primary" disabled={!note.trim() || saving} onClick={submit}>
          {initial ? T.salvar : T.adicionarMarcador}
        </button>
      </div>
    </div>
  );
}
