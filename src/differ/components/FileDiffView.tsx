import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { getBlob } from "../lib/blobs";
import { rangeLabel } from "../lib/bookmarks";
import type { FixPlacement } from "../lib/fixes";
import { isImage } from "../lib/images";
import { EXPAND_STEP, buildRows, fileGaps, revealLine, splitRows, type Expansion } from "../lib/rows";
import { readTextSelection, type TextSelection } from "../lib/textSelection";
import { useFileSources } from "../lib/useFileSources";
import type { Bookmark, FileDiff, FocusTarget, Side, ViewMode } from "../types";
import { T } from "../../i18n/differ";
import * as askStore from "../lib/asks";
import type { Ask, AskState } from "../lib/asks";
import { AskBox } from "./AskBox";
import { BookmarkBox, BookmarkEditor, CopyPathButton } from "./BookmarkBox";
import { SplitTable, UnifiedTable, type RowContext, type Selection } from "./DiffTable";
import { DiffStat, Icon, StatusIcon } from "./Icons";
import { ImageDiff } from "./ImageDiff";

export type NewBookmark = Omit<Bookmark, "id" | "createdAt">;

/** Diffs with more lines than this wait for a click before rendering. */
const LARGE_DIFF_LINES = 1500;
const ROW_HEIGHT = 20;
const IMAGE_PLACEHOLDER_HEIGHT = 360;

/** Duration of the open/close animation; keep in sync with .file-body-wrap in styles.css. */
export const COLLAPSE_MS = 440;

interface Draft {
  side: Side;
  start: number;
  end: number;
  /** Set when the note is about selected text rather than whole lines. */
  quote?: string;
}

/** Text selected in the code, offered for a note by a button placed where the mouse let go. */
interface CommentOffer extends TextSelection {
  top: number;
  left: number;
}

interface Props {
  root: string;
  file: FileDiff;
  viewMode: ViewMode;
  viewed: boolean;
  /** The to-be-committed tab: there, reviewed means being in the index. */
  staging?: boolean;
  /** The file keyboard shortcuts act on. */
  active: boolean;
  collapsed: boolean;
  bookmarks: Bookmark[];
  outdated: Set<string>;
  /** Where each bookmark goes while checking fixes (null in the branch's review). */
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  focus: FocusTarget | null;
  scrollRoot: RefObject<HTMLElement | null>;
  registerElement(path: string, el: HTMLElement | null): void;
  onCollapse(file: FileDiff, collapsed: boolean): void;
  /** The closing animation finished (the body is gone and the layout below has settled). */
  onCollapseEnd(file: FileDiff): void;
  onSetViewed(file: FileDiff, viewed: boolean): void;
  onAddBookmark(bookmark: NewBookmark): void;
  onUpdateBookmark(id: string, note: string): void;
  onRemoveBookmark(id: string): void;
  onToggleResolved(id: string): void;
}

function emptyNote(file: FileDiff): string {
  if (file.binary) return T.fileBinary;
  if (file.status === "renamed") return T.fileRenamed;
  if (file.oldMode !== file.newMode) return T.permissionChanged(file.oldMode, file.newMode);
  return T.noChanges;
}

export const FileDiffView = memo(function FileDiffView(props: Props) {
  const { root, file, viewMode, viewed, active, collapsed, bookmarks, outdated, focus, scrollRoot } = props;
  const { placements, referenceOf, registerElement, onCollapse, onCollapseEnd, onSetViewed } = props;
  const { onAddBookmark, onUpdateBookmark, onRemoveBookmark, onToggleResolved } = props;

  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [showLarge, setShowLarge] = useState(false);
  const [expansions, setExpansions] = useState<Record<number, Expansion>>({});
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const dragging = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pick, setPick] = useState<CommentOffer | null>(null);
  // Outside the component: the pending tab remounts it when the disk changes, and the conversation must stay.
  const asks = askStore.useAsks(file.path);
  const pendingFocus = useRef<FocusTarget | null>(null);

  // The body stays mounted while it animates closed and is dropped afterwards, so collapsed
  // files cost nothing. `open` drives the height animation, one frame after mounting.
  const [renderBody, setRenderBody] = useState(!collapsed);
  const [open, setOpen] = useState(!collapsed);
  const previousCollapsed = useRef(collapsed);
  const closing = useRef(false);

  // Runs once per close: when the height transition ends, or from the fallback timer when there
  // is no transition (reduced motion).
  const finishClose = () => {
    if (!closing.current) return;
    closing.current = false;
    setRenderBody(false);
    onCollapseEnd(file);
  };
  const finishCloseRef = useRef(finishClose);
  finishCloseRef.current = finishClose;

  useEffect(() => {
    if (previousCollapsed.current === collapsed) return;
    previousCollapsed.current = collapsed;

    if (collapsed) {
      closing.current = true;
      setOpen(false);
      // Keep the header in place while the body closes under it, instead of the page jumping past it.
      const section = sectionRef.current;
      const scroller = scrollRoot.current;
      // Written to the scroller itself: `scrollIntoView` from inside the iframe may scroll
      // TermIAu's page around it too.
      if (section && scroller) {
        const gap = parseFloat(getComputedStyle(scroller).getPropertyValue("--sticky-gap")) || 0;
        const d = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
        if (d < 0) scroller.scrollTop += d;
      }
      const timer = setTimeout(() => finishCloseRef.current(), COLLAPSE_MS + 150);
      return () => clearTimeout(timer);
    }

    closing.current = false;
    setRenderBody(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setOpen(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, scrollRoot]);

  const totalLines = useMemo(() => file.hunks.reduce((n, h) => n + h.lines.length, 0), [file]);
  const large = totalLines > LARGE_DIFF_LINES;
  // Images (even Git LFS pointers, which git diffs as text) get the visual comparison.
  const image = isImage(file.path) && !file.submodule;
  const hasContent = !image && !file.binary && file.hunks.length > 0;
  const bodyVisible = renderBody && inView && hasContent && (!large || showLarge);

  const sources = useFileSources(root, file, bodyVisible);
  const gaps = useMemo(() => fileGaps(file, sources.context), [file, sources.context]);
  const rows = useMemo(
    () => (bodyVisible ? buildRows(file.hunks, gaps, expansions, sources.context) : []),
    [bodyVisible, file.hunks, gaps, expansions, sources.context],
  );
  const pairs = useMemo(() => (viewMode === "split" ? splitRows(rows) : null), [rows, viewMode]);

  const setSectionRef = useCallback(
    (el: HTMLElement | null) => {
      sectionRef.current = el;
      registerElement(file.path, el);
    },
    [file.path, registerElement],
  );

  // Render the body only once the file gets near the viewport.
  useEffect(() => {
    if (inView || !sectionRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { root: scrollRoot.current, rootMargin: "1500px 0px" },
    );
    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, [inView, scrollRoot]);

  const setSelection = (sel: Selection | null) => {
    selectionRef.current = sel;
    setSelectionState(sel);
  };

  // Releasing the mouse after dragging over line numbers opens the bookmark editor.
  useEffect(() => {
    const finish = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const sel = selectionRef.current;
      if (sel) {
        setDraft({ side: sel.side, start: Math.min(sel.anchor, sel.head), end: Math.max(sel.anchor, sel.head) });
      }
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, []);

  // Releasing the mouse over selected code offers to comment on that passage.
  const offerComment = (e: MouseEvent) => {
    if (dragging.current || !bodyRef.current || !sectionRef.current) return;
    const found = readTextSelection(bodyRef.current, viewMode === "split");
    if (!found) {
      setPick(null);
      return;
    }
    const box = sectionRef.current.getBoundingClientRect();
    setPick({ ...found, top: e.clientY - box.top + 14, left: e.clientX - box.left });
  };

  // The offer goes away with the selection (a click elsewhere, Esc, the editor taking focus).
  useEffect(() => {
    if (!pick) return;
    const onChange = () => {
      if (window.getSelection()?.isCollapsed ?? true) setPick(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [pick]);

  const commentPick = () => {
    if (!pick) return;
    setEditingId(null);
    setDraft({ side: pick.side, start: pick.start, end: pick.end, quote: pick.quote });
    setSelection({ side: pick.side, anchor: pick.start, head: pick.end });
    setPick(null);
    window.getSelection()?.removeAllRanges();
  };

  const openAsk = (ask: Omit<Ask, "id" | "path">, question?: string) => askStore.open({ ...ask, path: file.path }, question);

  const askPick = () => {
    if (!pick) return;
    openAsk({ side: pick.side, start: pick.start, end: pick.end, quote: pick.quote });
    setPick(null);
    window.getSelection()?.removeAllRanges();
  };

  const inline = useMemo(() => {
    const at = new Map<string, Bookmark[]>();
    const marked = new Set<string>();
    for (const b of bookmarks) {
      if (outdated.has(b.id)) continue;
      // Checking fixes, review notes sit on the reviewed (old) side; ones made since stay put.
      const place = placements?.get(b.id);
      const anchor = place ? place.anchor : b;
      if (!anchor) continue;
      const key = `${anchor.side}:${anchor.endLine}`;
      at.set(key, [...(at.get(key) ?? []), b]);
      for (let n = anchor.startLine; n <= anchor.endLine; n++) marked.add(`${anchor.side}:${n}`);
    }
    return { at, marked };
  }, [bookmarks, outdated, placements]);
  const outdatedCount = bookmarks.filter((b) => outdated.has(b.id)).length;

  // A focus request (from the bookmark list) opens the file and scrolls to the line.
  useEffect(() => {
    if (!focus) return;
    pendingFocus.current = focus;
    setInView(true);
    setShowLarge(true);
    if (collapsed) onCollapse(file, false);
    // Only react to new requests, not to the file toggling afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || !bodyVisible) return;
    const attr = target.side === "new" ? "data-new" : "data-old";
    const row = bodyRef.current?.querySelector<HTMLElement>(`tr[${attr}="${target.line}"]`);
    if (row) {
      pendingFocus.current = null;
      row.scrollIntoView({ block: "center" });
      row.classList.remove("flash");
      void row.offsetWidth; // restart the animation
      row.classList.add("flash");
      return;
    }
    if (!sources.context) return; // wait for the content needed to reveal hidden lines
    const next = revealLine(gaps, expansions, target.side, target.line);
    if (next) setExpansions(next);
    else pendingFocus.current = null;
  });

  const cancelDraft = () => {
    setDraft(null);
    setSelection(null);
  };

  async function addBookmark(range: Draft, note: string) {
    const oid = range.side === "new" ? file.newOid : file.oldOid;
    let snapshot: string[] = [];
    try {
      if (oid) snapshot = (await getBlob(root, oid)).slice(range.start - 1, range.end);
    } catch {
      // Without a snapshot the bookmark shows as outdated once the file changes.
    }
    onAddBookmark({
      path: file.path,
      side: range.side,
      startLine: range.start,
      endLine: range.end,
      note,
      quote: range.quote,
      snapshot,
      fingerprint: file.fingerprint,
    });
  }

  async function saveDraft(note: string) {
    if (!draft) return;
    await addBookmark(draft, note);
    cancelDraft();
  }

  // The decision made with Claude becomes the bookmark — or rewrites the one the question came from.
  async function decide(ask: AskState, note: string) {
    if (ask.bookmarkId) onUpdateBookmark(ask.bookmarkId, note);
    else await addBookmark(ask, note);
    askStore.close(ask.id);
  }

  const askBox = (a: AskState) => (
    <AskBox key={a.id} root={root} file={file} ask={a} onDecide={(note) => decide(a, note)} />
  );

  // An edit may remove from the diff the line the question was pinned to. It doesn't vanish
  // because of that: it moves to the top of the file, where the conversation (and undo) stay at hand.
  const orphans = useMemo(() => {
    if (!asks.length || !rows.length) return [];
    const anchors = new Set<string>();
    for (const row of rows) {
      if (row.type === "gap") continue;
      if (row.kind !== "add" && row.oldNo !== null) anchors.add(`old:${row.oldNo}`);
      if (row.kind !== "del" && row.newNo !== null) anchors.add(`new:${row.newNo}`);
    }
    return asks.filter((a) => !anchors.has(`${a.side}:${a.end}`));
  }, [asks, rows]);

  const ctx: RowContext = {
    sources,
    selection,
    marked: inline.marked,
    onPlus(side, line) {
      setEditingId(null);
      setDraft(null);
      setPick(null);
      dragging.current = true;
      setSelection({ side, anchor: line, head: line });
    },
    onEnter(oldNo, newNo) {
      const sel = selectionRef.current;
      if (!dragging.current || !sel) return;
      const line = sel.side === "new" ? newNo : oldNo;
      if (line !== null && line !== sel.head) setSelection({ ...sel, head: line });
    },
    onExpand(gap, direction) {
      setExpansions((prev) => {
        const current = prev[gap.index] ?? { top: 0, bottom: 0 };
        const next =
          direction === "down"
            ? { ...current, top: current.top + EXPAND_STEP }
            : direction === "up"
              ? { ...current, bottom: current.bottom + EXPAND_STEP }
              : { ...current, top: current.top + (gap.remaining ?? 0) };
        return { ...prev, [gap.index]: next };
      });
    },
    renderAfter(side, line) {
      const list = inline.at.get(`${side}:${line}`);
      const showDraft = draft !== null && draft.side === side && draft.end === line;
      const here = asks.filter((a) => a.side === side && a.end === line);
      if (!list && !showDraft && !here.length) return null;
      return (
        <div className="annotations" key={side}>
          {list?.map((b) =>
            editingId === b.id ? (
              <BookmarkEditor
                key={b.id}
                label={rangeLabel(b)}
                quote={b.quote}
                initial={b.note}
                onSave={(note) => {
                  onUpdateBookmark(b.id, note);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <BookmarkBox
                key={b.id}
                bookmark={b}
                reference={referenceOf(b)}
                status={placements?.get(b.id)?.status}
                onEdit={() => setEditingId(b.id)}
                onRemove={() => onRemoveBookmark(b.id)}
                onToggleResolved={() => onToggleResolved(b.id)}
                onAsk={() =>
                  openAsk({
                    side: b.side,
                    start: b.startLine,
                    end: b.endLine,
                    quote: b.quote,
                    note: b.note,
                    bookmarkId: b.id,
                  })
                }
              />
            ),
          )}
          {here.map(askBox)}
          {showDraft && (
            <BookmarkEditor
              label={rangeLabel({ side: draft.side, startLine: draft.start, endLine: draft.end })}
              quote={draft.quote}
              onSave={saveDraft}
              onCancel={cancelDraft}
              onAsk={(question) => {
                openAsk({ side: draft.side, start: draft.start, end: draft.end, quote: draft.quote }, question);
                cancelDraft();
              }}
            />
          )}
        </div>
      );
    },
  };

  let body: ReactNode;
  if (image) {
    body = inView ? <ImageDiff root={root} file={file} /> : <div style={{ height: IMAGE_PLACEHOLDER_HEIGHT }} />;
  } else if (!hasContent) {
    body = <div className="file-note">{emptyNote(file)}</div>;
  } else if (large && !showLarge) {
    body = (
      <div className="file-note">
        {T.diffLarge(totalLines)}{" "}
        <button className="link-btn" onClick={() => setShowLarge(true)}>
          {T.loadDiff}
        </button>
      </div>
    );
  } else if (!inView) {
    body = <div style={{ height: totalLines * ROW_HEIGHT }} />;
  } else {
    body = (
      <>
        {orphans.length > 0 && <div className="annotations orphan-asks">{orphans.map(askBox)}</div>}
        {pairs ? <SplitTable rows={pairs} ctx={ctx} /> : <UnifiedTable rows={rows} ctx={ctx} />}
      </>
    );
  }

  const modeChanged =
    file.oldMode !== file.newMode && file.status !== "added" && file.status !== "deleted";

  return (
    // Styled as collapsed only once the closing animation is over.
    <section
      className={`file${collapsed && !renderBody ? " collapsed" : ""}${active ? " active" : ""}`}
      ref={setSectionRef}
    >
      <header className="file-header">
        <button
          className="icon-btn"
          onClick={() => onCollapse(file, !collapsed)}
          title={collapsed ? T.expandFile : T.collapseFile}
        >
          <Icon name="chevron-down" className={collapsed ? "file-chevron closed" : "file-chevron"} />
        </button>
        <StatusIcon status={file.status} />
        <span className="file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && (
            <>
              <span className="old-path">{file.oldPath}</span>
              <Icon name="arrow-right" className="rename-arrow" />
            </>
          )}
          <span>{file.path}</span>
        </span>
        <CopyPathButton path={file.path} />
        {modeChanged && (
          <span className="badge">
            {file.oldMode} → {file.newMode}
          </span>
        )}
        {outdatedCount > 0 && (
          <span className="badge warn">
            {T.bookmarksOutdated(outdatedCount)}
          </span>
        )}
        <span className="spacer" />
        {image ? (
          <span className="badge">{T.image}</span>
        ) : (
          <DiffStat additions={file.additions} deletions={file.deletions} />
        )}
        <label
          className={viewed ? "viewed-toggle on" : "viewed-toggle"}
          title={
            (props.staging ? T.reviewedInIndexHint : T.markReviewed) +
            (active ? " (V)" : "")
          }
        >
          <input type="checkbox" checked={viewed} onChange={() => onSetViewed(file, !viewed)} />
          {T.reviewed}
          {/* Always rendered so the button keeps its width; only shown on the active file. */}
          <kbd className={active ? undefined : "hidden-hint"} aria-hidden={!active}>
            V
          </kbd>
        </label>
      </header>
      {renderBody && (
        <div
          className={open ? "file-body-wrap open" : "file-body-wrap"}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && !open) finishClose();
          }}
        >
          <div className="file-body-clip">
            <div className="file-body" ref={bodyRef} onMouseUp={offerComment}>
              {body}
            </div>
          </div>
        </div>
      )}
      {pick && (
        // Keep the selection alive until the click lands.
        <div className="comment-selection" style={{ top: pick.top, left: pick.left }} onMouseDown={(e) => e.preventDefault()}>
          <button
            title={T.commentSelection(rangeLabel({ side: pick.side, startLine: pick.start, endLine: pick.end }).toLowerCase())}
            onClick={commentPick}
          >
            <Icon name="bookmark" size={13} />
            {T.comment}
          </button>
          <span className="sep" />
          <button className="ask-pick" title={T.askSelection} onClick={askPick}>
            <Icon name="sparkle" size={13} />
            {T.ask}
          </button>
        </div>
      )}
    </section>
  );
});
