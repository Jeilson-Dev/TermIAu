import { useEffect, useState } from "react";
import { T } from "../../i18n/differ";
import { rangeLabel } from "../lib/bookmarks";
import type { PassageTool } from "../lib/extensions";
import type { FixStatus } from "../lib/fixes";
import type { Bookmark } from "../types";
import { Icon } from "./Icons";

const FIX_BADGES: Record<FixStatus, { tone: string; label: string; title: string } | null> = {
  changed: { tone: "ok", label: T.snippetChanged, title: T.snippetChangedHint },
  unchanged: { tone: "warn", label: T.snippetUntouched, title: T.snippetUntouchedHint },
  fileUnchanged: { tone: "warn", label: T.fileUntouched, title: T.fileUntouchedHint },
  lost: { tone: "warn", label: T.notLocated, title: T.notLocatedHint },
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
      title={resolved ? T.resolvedHint : T.markResolved}
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
/** The "copied" that flashes for a moment and goes back to normal, for both copy buttons. */
function useCopy(text: string): [boolean, (e: { stopPropagation(): void }) => void] {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => setCopied(true));
  };
  return [copied, copy];
}

export function CopyReferenceButton({ reference, size }: { reference: string; size?: number }) {
  const [copied, copy] = useCopy(reference);

  return (
    <button
      className={copied ? "icon-btn copied" : "icon-btn"}
      title={T.copyReference}
      onClick={copy}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
    </button>
  );
}

/** The file's path, in the diff header. The ✓ and the "Copied!" are the notice. */
export function CopyPathButton({ path }: { path: string }) {
  const [copied, copy] = useCopy(path);

  return (
    <button
      className={copied ? "icon-btn subtle copied" : "icon-btn subtle"}
      title={copied ? T.copied : T.copyPath}
      aria-label={copied ? T.copied : T.copyPath}
      onClick={copy}
    >
      <Icon key={copied ? "check" : "copy"} name={copied ? "check" : "copy"} size={14} />
      {copied && (
        <span className="copied-bubble" role="status">
          {T.copied}
        </span>
      )}
    </button>
  );
}

/** The same, for the whole review: every comment in a single paste. */
export function CopyAllButton({ reference, count }: { reference: string; count: number }) {
  const [copied, copy] = useCopy(reference);

  return (
    <button
      className={copied ? "copy-all copied" : "copy-all"}
      title={T.copyAllHint}
      onClick={copy}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? T.copiedOnes : T.copyAll(count)}
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
  tools,
  onTool,
}: {
  bookmark: Bookmark;
  reference: string;
  status?: FixStatus;
  onEdit(): void;
  onRemove(): void;
  onToggleResolved(): void;
  /** What plugins offer for the bookmark's passage. */
  tools: PassageTool[];
  onTool(tool: PassageTool): void;
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
        {tools.map((tool) => (
          <button key={tool.id} className={`icon-btn tool-${tool.id}`} title={tool.titles.bookmark} onClick={() => onTool(tool)}>
            <Icon name={tool.icon} />
          </button>
        ))}
        <button className="icon-btn" title={T.editBookmark} onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button className="icon-btn danger" title={T.removeBookmark} onClick={onRemove}>
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
  tools = [],
  onTool,
}: {
  label: string;
  /** The selected passage the note is about, if it's not about whole lines. */
  quote?: string;
  initial?: string;
  onSave(note: string): void | Promise<void>;
  onCancel(): void;
  /** Instead of saving the note, hand the passage to a plugin's tool — with what was
   *  already written. ⌘⇧↩ is the first one. */
  tools?: PassageTool[];
  onTool?(tool: PassageTool, text: string): void;
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
        placeholder={quote ? T.improvementInSnippet : T.improvementHere}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && tools[0] && onTool) {
            e.preventDefault();
            onTool(tools[0], note.trim());
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
        <span className="hint">{T.saveCancels}</span>
        <button className="btn" onClick={onCancel}>
          {T.cancel}
        </button>
        {onTool &&
          tools.map((tool) => (
            <button key={tool.id} className={`btn tool-${tool.id}`} title={tool.titles.note} onClick={() => onTool(tool, note.trim())}>
              <Icon name={tool.icon} size={13} />
              {tool.label}
            </button>
          ))}
        <button className="btn primary" disabled={!note.trim() || saving} onClick={submit}>
          {initial ? T.save : T.addBookmark}
        </button>
      </div>
    </div>
  );
}
