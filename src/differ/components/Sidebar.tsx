import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rangeLabel } from "../lib/bookmarks";
import type { FixPlacement } from "../lib/fixes";
import { filterTree, type TreeNode } from "../lib/tree";
import type { Bookmark, FileDiff } from "../types";
import { CopyReferenceButton, FixBadge, ResolveButton } from "./BookmarkBox";
import { Icon, StatusIcon } from "./Icons";

interface Props {
  tree: TreeNode[];
  files: FileDiff[];
  viewedPaths: Set<string>;
  activePath: string | null;
  bookmarks: Bookmark[];
  outdated: Set<string>;
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  onSelectFile(path: string): void;
  onSelectBookmark(bookmark: Bookmark): void;
  onRemoveBookmark(id: string): void;
  onToggleResolved(id: string): void;
}

export function Sidebar(props: Props) {
  const [tab, setTab] = useState<"files" | "bookmarks">("files");
  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button role="tab" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          Arquivos <span className="count">{props.files.length}</span>
        </button>
        <button role="tab" className={tab === "bookmarks" ? "active" : ""} onClick={() => setTab("bookmarks")}>
          Marcadores <span className="count">{props.bookmarks.length}</span>
        </button>
      </div>
      {tab === "files" ? (
        <FileTree
          tree={props.tree}
          viewedPaths={props.viewedPaths}
          activePath={props.activePath}
          onSelect={props.onSelectFile}
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
        />
      )}
    </aside>
  );
}

function FileTree({
  tree,
  viewedPaths,
  activePath,
  onSelect,
}: {
  tree: TreeNode[];
  viewedPaths: Set<string>;
  activePath: string | null;
  onSelect(path: string): void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim() !== "";

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

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const indent = { paddingLeft: 10 + depth * 14 };
    if (node.type === "file") {
      const { path, status } = node.file;
      const isViewed = viewedPaths.has(path);
      const cls = `tree-file${path === activePath ? " active" : ""}${isViewed ? " viewed" : ""}`;
      return (
        <button key={path} className={cls} style={indent} title={path} onClick={() => onSelect(path)}>
          <StatusIcon status={status} />
          <span className="tree-name">{node.name}</span>
          {isViewed && <Icon name="check" className="viewed-mark" size={14} />}
        </button>
      );
    }
    const open = filtering || !closed.has(node.path);
    return (
      <Fragment key={`dir:${node.path}`}>
        <button className="tree-dir" style={indent} title={node.path} onClick={() => toggle(node.path)}>
          <Icon name={open ? "chevron-down" : "chevron-right"} className="tree-chevron" size={12} />
          <Icon name={open ? "folder-open" : "folder"} className="tree-folder" size={15} />
          <span className="tree-name">{node.name}</span>
        </button>
        {open && node.children.map((child) => renderNode(child, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div className="file-tree">
      <div className="tree-filter">
        <input
          type="search"
          placeholder="Filtrar arquivos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="tree-items" ref={listRef}>
        {visible.map((node) => renderNode(node, 0))}
        {visible.length === 0 && <p className="muted tree-empty">Nenhum arquivo encontrado.</p>}
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
}: {
  bookmarks: Bookmark[];
  files: FileDiff[];
  outdated: Set<string>;
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  onSelect(bookmark: Bookmark): void;
  onRemove(id: string): void;
  onToggleResolved(id: string): void;
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

  if (bookmarks.length === 0) {
    return (
      <div className="empty-list">
        <Icon name="bookmark" size={24} />
        <p>Nenhum marcador ainda.</p>
        <p className="muted">
          Passe o mouse sobre uma linha do diff e clique no <strong>+</strong>. Arraste para marcar várias
          linhas.
        </p>
        <p className="muted">
          Ou selecione um trecho do código e clique em <strong>Comentar</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="bookmark-list">
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
                    isOutdated && <span className="badge warn">desatualizado</span>
                  )}
                  <span className="spacer" />
                  <ResolveButton resolved={!!b.resolved} size={14} onToggle={() => onToggleResolved(b.id)} />
                  <CopyReferenceButton reference={referenceOf(b)} size={14} />
                  <button
                    className="icon-btn danger"
                    title="Remover marcador"
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
