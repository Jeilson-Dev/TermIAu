import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { T } from "../../i18n/differ";
import { bookmarksReference, rangeLabel } from "../lib/bookmarks";
import type { FixPlacement } from "../lib/fixes";
import { dirStaged, filterTree, flattenTree, type TreeNode } from "../lib/tree";
import type { Bookmark, FileDiff, StagedState } from "../types";
import { CopyAllButton, CopyReferenceButton, FixBadge, ResolveButton } from "./BookmarkBox";
import { Icon, StatusIcon } from "./Icons";

/** A section of the file list: in the index and out of it, like in VS Code. */
export interface GroupFiles {
  key: string;
  title: string;
  tree: TreeNode[];
  /** What the header button does to the whole repository. */
  stagesAll: boolean;
  empty: string;
}

interface Props {
  tree: TreeNode[];
  /** When there are groups, the list is split by them; without them, it is the whole tree. */
  groups: GroupFiles[] | null;
  files: FileDiff[];
  viewedPaths: Set<string>;
  activePath: string | null;
  bookmarks: Bookmark[];
  outdated: Set<string>;
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  /// Only in the to-be-committed tab: the others have no index or commit.
  staging: boolean;
  /// How many files have something in the index — it is what the commit button will take.
  inIndex: number;
  onStage(path: string, inside: boolean): void;
  /// Lets git's error propagate: the box shows it, along with the typed text.
  onCommit(message: string): Promise<void>;
  onSelectFile(path: string): void;
  onSelectBookmark(bookmark: Bookmark): void;
  onRemoveBookmark(id: string): void;
  onToggleResolved(id: string): void;
  /// Saves the comments, in the list's order, to a file another TermIAu imports.
  onExport(comments: Bookmark[]): Promise<void>;
  /// Brings in an exported review's comments; says how it went.
  onImport(text: string): Promise<string>;
}

export function Sidebar(props: Props) {
  const [tab, setTab] = useState<"files" | "bookmarks">("files");
  return (
    <aside className="sidebar">
      {props.staging && <CommitBox inIndex={props.inIndex} onCommit={props.onCommit} />}
      <div className="tabs" role="tablist">
        <button role="tab" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          {T.tabFiles} <span className="count">{props.files.length}</span>
        </button>
        <button role="tab" className={tab === "bookmarks" ? "active" : ""} onClick={() => setTab("bookmarks")}>
          {T.tabBookmarks} <span className="count">{props.bookmarks.length}</span>
        </button>
      </div>
      {tab === "files" ? (
        <FileTree
          tree={props.tree}
          groups={props.groups}
          viewedPaths={props.viewedPaths}
          activePath={props.activePath}
          onSelect={props.onSelectFile}
          onStage={props.staging ? props.onStage : undefined}
        />
      ) : (
        <BookmarkList
          bookmarks={props.bookmarks}
          files={props.files}
          outdated={props.outdated}
          placements={props.placements}
          referenceOf={props.referenceOf}
          onSelect={props.onSelectBookmark}
          onRemove={props.onRemoveBookmark}
          onToggleResolved={props.onToggleResolved}
          onExport={props.onExport}
          onImport={props.onImport}
        />
      )}
    </aside>
  );
}

/** The message and the button that commits what is in the index, above the file list. */
function CommitBox({ inIndex, onCommit }: { inIndex: number; onCommit(m: string): Promise<void> }) {
  const [messageText, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = inIndex > 0 && messageText.trim() !== "" && !sending;

  const commit = async () => {
    if (!can) return;
    setSending(true);
    setError(null);
    try {
      await onCommit(messageText);
      setMessage("");
    } catch (err) {
      // Git's refusal is the most useful answer there is here — a hook that blocked it,
      // identity not configured, nothing in the index. It goes to the screen whole.
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="commit-box">
      {/* A commit message is full of file names, flags and identifiers:
          spellcheck and auto-capitalization only get in the way, and macOS autocorrect
          even turns the dashes of `--staged` into an em dash. */}
      <textarea
        className="commit-msg"
        rows={2}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        placeholder={inIndex > 0 ? T.messageOfCommit : T.nothingStaged}
        value={messageText}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void commit();
        }}
      />
      <button className="commit-btn" disabled={!can} title={T.commitHint} onClick={() => void commit()}>
        <Icon name="check" size={14} />
        {sending ? T.committing : inIndex > 0 ? T.commitN(inIndex) : T.commit}
      </button>
      {error && <p className="commit-error">{error}</p>}
    </div>
  );
}

/** A file's + and −: `git add` and its inverse, without leaving the list. */
function StageButtons({
  path,
  staged,
  onStage,
  folder = false,
}: {
  path: string;
  staged: StagedState;
  onStage(path: string, inside: boolean): void;
  folder?: boolean;
}) {
  // Half in the index, both fit: one takes the rest, the other removes everything.
  const por = staged !== "staged";
  const remove = staged !== "unstaged";
  return (
    <span className={`stage-actions ${staged}`}>
      {por && (
        <button
          className="stage-btn"
          title={
            staged === "partial"
              ? folder
                ? T.byRestOfFolder
                : T.byRestOfFile
              : folder
                ? T.byFolder
                : T.byFile
          }
          onClick={() => onStage(path, true)}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
      {remove && (
        <button
          className="stage-btn remove"
          title={folder ? T.removeFolder : T.removeFile}
          onClick={() => onStage(path, false)}
        >
          <Icon name="minus" size={13} />
        </button>
      )}
    </span>
  );
}

function FileTree({
  tree,
  groups,
  viewedPaths,
  activePath,
  onSelect,
  onStage,
}: {
  tree: TreeNode[];
  groups: GroupFiles[] | null;
  viewedPaths: Set<string>;
  activePath: string | null;
  onSelect(path: string): void;
  onStage?(path: string, inside: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [groupsClosed, setGroupsClosed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);
  const groupsVisible = useMemo(
    () => groups?.map((g) => ({ ...g, visible: filterTree(g.tree, query), total: flattenTree(g.tree).length })),
    [groups, query],
  );
  const filtering = query.trim() !== "";

  /** Every folder in the list, for the button that collapses all at once. */
  const allFolders = useMemo(() => {
    const names: string[] = [];
    const visit = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== "dir") continue;
        names.push(node.path);
        visit(node.children);
      }
    };
    visit(groups ? groups.flatMap((g) => g.tree) : tree);
    return names;
  }, [groups, tree]);

  // The button toggles instead of only collapsing: whoever collapsed everything to find a
  // file wants the way back on the same key.
  const allCollapsed = allFolders.length > 0 && allFolders.every((p) => closed.has(p));
  const toggleAll = () => {
    setClosed(allCollapsed ? new Set() : new Set(allFolders));
    setGroupsClosed(new Set());
  };

  useEffect(() => {
    listRef.current?.querySelector(".tree-file.active")?.scrollIntoView({ block: "nearest" });
  }, [activePath]);

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleGroup = (key: string) =>
    setGroupsClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const indent = { paddingLeft: 10 + depth * 14 };
    if (node.type === "file") {
      const { path, status, staged } = node.file;
      const isViewed = viewedPaths.has(path);
      const cls = `tree-file${path === activePath ? " active" : ""}${isViewed ? " viewed" : ""}`;
      const line = (
        <button className={cls} style={indent} title={path} onClick={() => onSelect(path)}>
          <StatusIcon status={status} />
          <span className="tree-name">{node.name}</span>
          {isViewed && <Icon name="check" className="viewed-mark" size={14} />}
        </button>
      );
      // The index buttons are siblings of the row, not children: a button inside a
      // button isn't valid HTML, and a click on one would become a click on the other.
      if (!onStage || !staged) return <Fragment key={path}>{line}</Fragment>;
      return (
        <div key={path} className="tree-file-line">
          {line}
          <StageButtons path={path} staged={staged} onStage={onStage} />
        </div>
      );
    }
    const open = filtering || !closed.has(node.path);
    const staged = onStage ? dirStaged(node) : null;
    const lineDir = (
      <button className="tree-dir" style={indent} title={node.path} onClick={() => toggle(node.path)}>
        {/* Always the same chevron, rotating: swapping the icon midway
            would cut its turn short. */}
        <Icon
          name="chevron-down"
          className={open ? "tree-chevron" : "tree-chevron closed"}
          size={12}
        />
        <Icon name={open ? "folder-open" : "folder"} className="tree-folder" size={15} />
        <span className="tree-name">{node.name}</span>
      </button>
    );
    return (
      <Fragment key={`dir:${node.path}`}>
        {onStage && staged ? (
          // The whole folder at once: `git add` accepts its path just as it
          // accepts a file's, and takes along what was deleted and what still
          // isn't tracked in there.
          <div className="tree-file-line">
            {lineDir}
            <StageButtons path={node.path} staged={staged} onStage={onStage} folder />
          </div>
        ) : (
          lineDir
        )}
        {/* What is inside stays mounted and gets clipped by height: that is what
            allows animating both ways, and the rows are cheap. */}
        <div className={open ? "tree-dobra open" : "tree-dobra"}>
          <div className="tree-dobra-clip">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        </div>
      </Fragment>
    );
  };

  return (
    <div className="file-tree">
      <div className="tree-filter">
        <input
          type="search"
          placeholder={T.filterFiles}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {allFolders.length > 0 && (
          <button
            className="icon-btn"
            title={allCollapsed ? T.openFolders : T.collapseFolders}
            onClick={toggleAll}
          >
            <Icon name={allCollapsed ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        )}
      </div>
      <div className="tree-items" ref={listRef}>
        {groupsVisible
          ? groupsVisible.map((g) => {
              // While filtering, the group opens on its own: hiding the search
              // result behind a closed group would be saying there is nothing.
              const isOpen = filtering || !groupsClosed.has(g.key);
              return (
                <Fragment key={g.key}>
                  <div className="tree-group">
                    <button className="tree-group-button" onClick={() => toggleGroup(g.key)}>
                      <Icon
                        name="chevron-down"
                        className={isOpen ? "tree-chevron" : "tree-chevron closed"}
                        size={12}
                      />
                      <span className="tree-group-name">{g.title}</span>
                      <span className="count">{g.total}</span>
                    </button>
                    {onStage && g.total > 0 && (
                      <button
                        className={`stage-btn${g.stagesAll ? "" : " remove"}`}
                        title={
                          g.stagesAll
                            ? T.byAll
                            : T.removeAll
                        }
                        onClick={() => onStage(".", g.stagesAll)}
                      >
                        <Icon name={g.stagesAll ? "plus" : "minus"} size={13} />
                      </button>
                    )}
                  </div>
                  <div className={isOpen ? "tree-dobra open" : "tree-dobra"}>
                    <div className="tree-dobra-clip">
                      {g.visible.map((node) => renderNode(node, 0))}
                      {g.visible.length === 0 && <p className="muted tree-empty">{g.empty}</p>}
                    </div>
                  </div>
                </Fragment>
              );
            })
          : visible.map((node) => renderNode(node, 0))}
        {!groupsVisible && visible.length === 0 && (
          <p className="muted tree-empty">{T.noFile}</p>
        )}
      </div>
    </div>
  );
}

function BookmarkList({
  bookmarks,
  files,
  outdated,
  placements,
  referenceOf,
  onSelect,
  onRemove,
  onToggleResolved,
  onExport,
  onImport,
}: {
  bookmarks: Bookmark[];
  files: FileDiff[];
  outdated: Set<string>;
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  onSelect(bookmark: Bookmark): void;
  onRemove(id: string): void;
  onToggleResolved(id: string): void;
  onExport(comments: Bookmark[]): Promise<void>;
  onImport(text: string): Promise<string>;
}) {
  const groups = useMemo(() => {
    const order = new Map(files.map((f, i) => [f.path, i]));
    const rank = (b: Bookmark) => order.get(b.path) ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...bookmarks].sort(
      (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.startLine - b.startLine,
    );
    const byPath = new Map<string, Bookmark[]>();
    for (const b of sorted) byPath.set(b.path, [...(byPath.get(b.path) ?? []), b]);
    return [...byPath];
  }, [bookmarks, files]);

  // From the already sorted list, not the raw array: the pasted text comes out in the same order
  // the review is read on screen, file by file, line by line.
  const everything = useMemo(
    () => bookmarksReference(groups.flatMap(([, items]) => items), referenceOf),
    [groups, referenceOf],
  );

  const sorted = useMemo(() => groups.flatMap(([, items]) => items), [groups]);
  const reviewFile = <ReviewFileButtons comments={sorted} onExport={onExport} onImport={onImport} />;

  if (bookmarks.length === 0) {
    return (
      <div className="empty-list">
        {reviewFile}
        <Icon name="bookmark" size={24} />
        <p>{T.noBookmark}</p>
        <p className="muted">
          {T.howToMarkBefore}
          <strong>+</strong>
          {T.howToMarkAfter}
        </p>
        <p className="muted">
          {T.howToCommentBefore}
          <strong>{T.comment}</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="bookmark-list">
      <div className="bookmark-all">
        <CopyAllButton reference={everything} count={bookmarks.length} />
      </div>
      {reviewFile}
      {groups.map(([path, items]) => (
        <div key={path} className="bookmark-group">
          <div className="bookmark-group-path" title={path}>
            {path}
          </div>
          {items.map((b) => {
            const isOutdated = outdated.has(b.id);
            const status = placements?.get(b.id)?.status;
            const cls = `bookmark-item${isOutdated ? " outdated" : ""}${b.resolved ? " resolved" : ""}`;
            return (
              <div
                key={b.id}
                className={cls}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(b)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(b)}
              >
                <div className="bookmark-item-head">
                  <span>{rangeLabel(b)}</span>
                  {status ? (
                    <FixBadge status={status} />
                  ) : (
                    isOutdated && <span className="badge warn">{T.outdated}</span>
                  )}
                  <span className="spacer" />
                  <ResolveButton resolved={!!b.resolved} size={14} onToggle={() => onToggleResolved(b.id)} />
                  <CopyReferenceButton reference={referenceOf(b)} size={14} />
                  <button
                    className="icon-btn danger"
                    title={T.removeBookmark}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(b.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <div className="bookmark-item-note">{b.note}</div>
                {isOutdated && b.snapshot.length > 0 && (
                  <pre className="bookmark-snapshot">{b.snapshot.join("\n")}</pre>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/// How long "Exported" and the import's message stay before going away.
const REVIEW_FILE_MS = 4000;

/// Export and import of the review's comments: export saves them to a file for someone
/// else, import brings someone's into this review. Import also shows with no comments
/// yet — that is exactly who receives a review.
function ReviewFileButtons({
  comments,
  onExport,
  onImport,
}: {
  comments: Bookmark[];
  onExport(comments: Bookmark[]): Promise<void>;
  onImport(text: string): Promise<string>;
}) {
  const [exported, setExported] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!exported && !message) return;
    const timer = setTimeout(() => {
      setExported(false);
      setMessage(null);
    }, REVIEW_FILE_MS);
    return () => clearTimeout(timer);
  }, [exported, message]);

  const doExport = async () => {
    setMessage(null);
    try {
      await onExport(comments);
      setExported(true);
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  const doImport = async (f: File) => {
    try {
      setMessage({ text: await onImport(await f.text()) });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <div className="review-file">
      <div className="review-file-buttons">
        {comments.length > 0 && (
          <button className={exported ? "copy-all copied" : "copy-all"} title={T.reviewExportHint} onClick={doExport}>
            <Icon name={exported ? "check" : "export"} size={14} />
            {exported ? T.reviewExported : T.reviewExport}
          </button>
        )}
        <button className="copy-all" title={T.reviewImportHint} onClick={() => file.current?.click()}>
          <Icon name="import" size={14} />
          {T.reviewImport}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared, so picking the same file again fires again.
            e.target.value = "";
            if (f) void doImport(f);
          }}
        />
      </div>
      {message && <p className={message.error ? "review-file-message error" : "review-file-message"}>{message.text}</p>}
    </div>
  );
}
