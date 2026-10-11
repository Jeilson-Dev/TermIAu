import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { T } from "../../i18n/differ";
import { bookmarksReference, rangeLabel } from "../lib/bookmarks";
import type { FixPlacement } from "../lib/fixes";
import { dirStaged, filterTree, flattenTree, type TreeNode } from "../lib/tree";
import type { Bookmark, FileDiff, StagedState } from "../types";
import { CopyAllButton, CopyReferenceButton, FixBadge, ResolveButton } from "./BookmarkBox";
import { Icon, StatusIcon } from "./Icons";

/** A section of the file list: in the index and out of it, like in VS Code. */
export interface GrupoArquivos {
  chave: string;
  titulo: string;
  tree: TreeNode[];
  /** What the header button does to the whole repository. */
  poeTudo: boolean;
  vazio: string;
}

interface Props {
  tree: TreeNode[];
  /** When there are groups, the list is split by them; without them, it is the whole tree. */
  grupos: GrupoArquivos[] | null;
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
  noIndice: number;
  onStage(path: string, dentro: boolean): void;
  /// Lets git's error propagate: the box shows it, along with the typed text.
  onCommit(message: string): Promise<void>;
  onSelectFile(path: string): void;
  onSelectBookmark(bookmark: Bookmark): void;
  onRemoveBookmark(id: string): void;
  onToggleResolved(id: string): void;
}

export function Sidebar(props: Props) {
  const [tab, setTab] = useState<"files" | "bookmarks">("files");
  return (
    <aside className="sidebar">
      {props.staging && <CommitBox noIndice={props.noIndice} onCommit={props.onCommit} />}
      <div className="tabs" role="tablist">
        <button role="tab" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          {T.abaArquivos} <span className="count">{props.files.length}</span>
        </button>
        <button role="tab" className={tab === "bookmarks" ? "active" : ""} onClick={() => setTab("bookmarks")}>
          {T.abaMarcadores} <span className="count">{props.bookmarks.length}</span>
        </button>
      </div>
      {tab === "files" ? (
        <FileTree
          tree={props.tree}
          grupos={props.grupos}
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
        />
      )}
    </aside>
  );
}

/** The message and the button that commits what is in the index, above the file list. */
function CommitBox({ noIndice, onCommit }: { noIndice: number; onCommit(m: string): Promise<void> }) {
  const [mensagem, setMensagem] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pode = noIndice > 0 && mensagem.trim() !== "" && !enviando;

  const commitar = async () => {
    if (!pode) return;
    setEnviando(true);
    setErro(null);
    try {
      await onCommit(mensagem);
      setMensagem("");
    } catch (err) {
      // Git's refusal is the most useful answer there is here — a hook that blocked it,
      // identity not configured, nothing in the index. It goes to the screen whole.
      setErro(String(err));
    } finally {
      setEnviando(false);
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
        placeholder={noIndice > 0 ? T.mensagemDoCommit : T.nadaNoIndice}
        value={mensagem}
        onChange={(e) => setMensagem(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void commitar();
        }}
      />
      <button className="commit-btn" disabled={!pode} title={T.commitarDica} onClick={() => void commitar()}>
        <Icon name="check" size={14} />
        {enviando ? T.commitando : noIndice > 0 ? T.commitN(noIndice) : T.commit}
      </button>
      {erro && <p className="commit-erro">{erro}</p>}
    </div>
  );
}

/** A file's + and −: `git add` and its inverse, without leaving the list. */
function StageButtons({
  path,
  staged,
  onStage,
  pasta = false,
}: {
  path: string;
  staged: StagedState;
  onStage(path: string, dentro: boolean): void;
  pasta?: boolean;
}) {
  // Half in the index, both fit: one takes the rest, the other removes everything.
  const por = staged !== "staged";
  const tirar = staged !== "unstaged";
  return (
    <span className={`stage-acoes ${staged}`}>
      {por && (
        <button
          className="stage-btn"
          title={
            staged === "partial"
              ? pasta
                ? T.porRestoDaPasta
                : T.porRestoDoArquivo
              : pasta
                ? T.porPasta
                : T.porArquivo
          }
          onClick={() => onStage(path, true)}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
      {tirar && (
        <button
          className="stage-btn tirar"
          title={pasta ? T.tirarPasta : T.tirarArquivo}
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
  grupos,
  viewedPaths,
  activePath,
  onSelect,
  onStage,
}: {
  tree: TreeNode[];
  grupos: GrupoArquivos[] | null;
  viewedPaths: Set<string>;
  activePath: string | null;
  onSelect(path: string): void;
  onStage?(path: string, dentro: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [gruposFechados, setGruposFechados] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);
  const gruposVisiveis = useMemo(
    () => grupos?.map((g) => ({ ...g, visible: filterTree(g.tree, query), total: flattenTree(g.tree).length })),
    [grupos, query],
  );
  const filtering = query.trim() !== "";

  /** Every folder in the list, for the button that collapses all at once. */
  const todasPastas = useMemo(() => {
    const nomes: string[] = [];
    const visitar = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== "dir") continue;
        nomes.push(node.path);
        visitar(node.children);
      }
    };
    visitar(grupos ? grupos.flatMap((g) => g.tree) : tree);
    return nomes;
  }, [grupos, tree]);

  // The button toggles instead of only collapsing: whoever collapsed everything to find a
  // file wants the way back on the same key.
  const tudoRecolhido = todasPastas.length > 0 && todasPastas.every((p) => closed.has(p));
  const alternarTudo = () => {
    setClosed(tudoRecolhido ? new Set() : new Set(todasPastas));
    setGruposFechados(new Set());
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

  const alternarGrupo = (chave: string) =>
    setGruposFechados((prev) => {
      const next = new Set(prev);
      if (next.has(chave)) next.delete(chave);
      else next.add(chave);
      return next;
    });

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const indent = { paddingLeft: 10 + depth * 14 };
    if (node.type === "file") {
      const { path, status, staged } = node.file;
      const isViewed = viewedPaths.has(path);
      const cls = `tree-file${path === activePath ? " active" : ""}${isViewed ? " viewed" : ""}`;
      const linha = (
        <button className={cls} style={indent} title={path} onClick={() => onSelect(path)}>
          <StatusIcon status={status} />
          <span className="tree-name">{node.name}</span>
          {isViewed && <Icon name="check" className="viewed-mark" size={14} />}
        </button>
      );
      // The index buttons are siblings of the row, not children: a button inside a
      // button isn't valid HTML, and a click on one would become a click on the other.
      if (!onStage || !staged) return <Fragment key={path}>{linha}</Fragment>;
      return (
        <div key={path} className="tree-file-linha">
          {linha}
          <StageButtons path={path} staged={staged} onStage={onStage} />
        </div>
      );
    }
    const open = filtering || !closed.has(node.path);
    const staged = onStage ? dirStaged(node) : null;
    const linhaDir = (
      <button className="tree-dir" style={indent} title={node.path} onClick={() => toggle(node.path)}>
        {/* Always the same chevron, rotating: swapping the icon midway
            would cut its turn short. */}
        <Icon
          name="chevron-down"
          className={open ? "tree-chevron" : "tree-chevron fechado"}
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
          <div className="tree-file-linha">
            {linhaDir}
            <StageButtons path={node.path} staged={staged} onStage={onStage} pasta />
          </div>
        ) : (
          linhaDir
        )}
        {/* What is inside stays mounted and gets clipped by height: that is what
            allows animating both ways, and the rows are cheap. */}
        <div className={open ? "tree-dobra aberta" : "tree-dobra"}>
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
          placeholder={T.filtrarArquivos}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {todasPastas.length > 0 && (
          <button
            className="icon-btn"
            title={tudoRecolhido ? T.abrirPastas : T.recolherPastas}
            onClick={alternarTudo}
          >
            <Icon name={tudoRecolhido ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        )}
      </div>
      <div className="tree-items" ref={listRef}>
        {gruposVisiveis
          ? gruposVisiveis.map((g) => {
              // While filtering, the group opens on its own: hiding the search
              // result behind a closed group would be saying there is nothing.
              const aberto = filtering || !gruposFechados.has(g.chave);
              return (
                <Fragment key={g.chave}>
                  <div className="tree-grupo">
                    <button className="tree-grupo-botao" onClick={() => alternarGrupo(g.chave)}>
                      <Icon
                        name="chevron-down"
                        className={aberto ? "tree-chevron" : "tree-chevron fechado"}
                        size={12}
                      />
                      <span className="tree-grupo-nome">{g.titulo}</span>
                      <span className="count">{g.total}</span>
                    </button>
                    {onStage && g.total > 0 && (
                      <button
                        className={`stage-btn${g.poeTudo ? "" : " tirar"}`}
                        title={
                          g.poeTudo
                            ? T.porTudo
                            : T.tirarTudo
                        }
                        onClick={() => onStage(".", g.poeTudo)}
                      >
                        <Icon name={g.poeTudo ? "plus" : "minus"} size={13} />
                      </button>
                    )}
                  </div>
                  <div className={aberto ? "tree-dobra aberta" : "tree-dobra"}>
                    <div className="tree-dobra-clip">
                      {g.visible.map((node) => renderNode(node, 0))}
                      {g.visible.length === 0 && <p className="muted tree-empty">{g.vazio}</p>}
                    </div>
                  </div>
                </Fragment>
              );
            })
          : visible.map((node) => renderNode(node, 0))}
        {!gruposVisiveis && visible.length === 0 && (
          <p className="muted tree-empty">{T.nenhumArquivo}</p>
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

  // From the already sorted list, not the raw array: the pasted text comes out in the same order
  // the review is read on screen, file by file, line by line.
  const tudo = useMemo(
    () => bookmarksReference(groups.flatMap(([, items]) => items), referenceOf),
    [groups, referenceOf],
  );

  if (bookmarks.length === 0) {
    return (
      <div className="empty-list">
        <Icon name="bookmark" size={24} />
        <p>{T.nenhumMarcador}</p>
        <p className="muted">
          {T.comoMarcarAntes}
          <strong>+</strong>
          {T.comoMarcarDepois}
        </p>
        <p className="muted">
          {T.comoComentarAntes}
          <strong>{T.comentar}</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="bookmark-list">
      <div className="bookmark-tudo">
        <CopyAllButton reference={tudo} count={bookmarks.length} />
      </div>
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
                    isOutdated && <span className="badge warn">{T.desatualizado}</span>
                  )}
                  <span className="spacer" />
                  <ResolveButton resolved={!!b.resolved} size={14} onToggle={() => onToggleResolved(b.id)} />
                  <CopyReferenceButton reference={referenceOf(b)} size={14} />
                  <button
                    className="icon-btn danger"
                    title={T.removerMarcador}
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
