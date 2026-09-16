import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bookmarksReference, rangeLabel } from "../lib/bookmarks";
import type { FixPlacement } from "../lib/fixes";
import { dirStaged, filterTree, flattenTree, type TreeNode } from "../lib/tree";
import type { Bookmark, FileDiff, StagedState } from "../types";
import { CopyAllButton, CopyReferenceButton, FixBadge, ResolveButton } from "./BookmarkBox";
import { Icon, StatusIcon } from "./Icons";

/** Uma seção da lista de arquivos: no índice e fora dele, como no VS Code. */
export interface GrupoArquivos {
  chave: string;
  titulo: string;
  tree: TreeNode[];
  /** O que o botão do cabeçalho faz com o repositório inteiro. */
  poeTudo: boolean;
  vazio: string;
}

interface Props {
  tree: TreeNode[];
  /** Quando há grupos, a lista é dividida por eles; sem eles, é a árvore inteira. */
  grupos: GrupoArquivos[] | null;
  files: FileDiff[];
  viewedPaths: Set<string>;
  activePath: string | null;
  bookmarks: Bookmark[];
  outdated: Set<string>;
  placements: Map<string, FixPlacement> | null;
  referenceOf(bookmark: Bookmark): string;
  /// Só na aba do que está para ser commitado: nas outras não há índice nem commit.
  staging: boolean;
  /// Quantos arquivos têm algo no índice — é o que o botão de commit vai levar.
  noIndice: number;
  onStage(path: string, dentro: boolean): void;
  /// Deixa o erro do git subir: quem o mostra é a caixa, junto do texto digitado.
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
          Arquivos <span className="count">{props.files.length}</span>
        </button>
        <button role="tab" className={tab === "bookmarks" ? "active" : ""} onClick={() => setTab("bookmarks")}>
          Marcadores <span className="count">{props.bookmarks.length}</span>
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

/** A mensagem e o botão que commita o que está no índice, em cima da lista de arquivos. */
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
      // A recusa do git é a resposta mais útil que existe aqui — hook que barrou,
      // identidade não configurada, nada no índice. Vai inteira para a tela.
      setErro(String(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="commit-box">
      {/* Mensagem de commit é cheia de nome de arquivo, de flag e de identificador:
          corretor e maiúscula automática só atrapalham, e a autocorreção do macOS
          ainda troca o traço do `--staged` por travessão. */}
      <textarea
        className="commit-msg"
        rows={2}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        placeholder={noIndice > 0 ? "Mensagem do commit" : "Nada no índice — ponha arquivos com o +"}
        value={mensagem}
        onChange={(e) => setMensagem(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void commitar();
        }}
      />
      <button className="commit-btn" disabled={!pode} title="Commitar o índice (⌘↵)" onClick={() => void commitar()}>
        <Icon name="check" size={14} />
        {enviando ? "Commitando…" : noIndice > 0 ? `Commit (${noIndice})` : "Commit"}
      </button>
      {erro && <p className="commit-erro">{erro}</p>}
    </div>
  );
}

/** O + e o − de um arquivo: o `git add` e o inverso dele, sem sair da lista. */
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
  // Pela metade no índice, os dois cabem: um leva o resto, o outro tira tudo.
  const por = staged !== "staged";
  const tirar = staged !== "unstaged";
  const oQue = pasta ? "a pasta inteira" : "o arquivo";
  return (
    <span className={`stage-acoes ${staged}`}>
      {por && (
        <button
          className="stage-btn"
          title={
            staged === "partial"
              ? `Pôr no índice também o que ficou de fora (git add ${pasta ? "da pasta" : ""})`.trim()
              : `Pôr ${oQue} no índice (git add)`
          }
          onClick={() => onStage(path, true)}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
      {tirar && (
        <button
          className="stage-btn tirar"
          title={`Tirar ${oQue} do índice, deixando o disco como está (git restore --staged)`}
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

  /** Toda pasta que está na lista, para o botão que recolhe de uma vez só. */
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

  // O botão alterna em vez de só recolher: quem recolheu tudo para achar um
  // arquivo quer o caminho de volta na mesma tecla.
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
      // Os botões do índice são irmãos da linha, não filhos: botão dentro de
      // botão não é HTML válido, e o clique de um viraria o clique do outro.
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
        {/* Sempre o mesmo chevron, girando: trocar o ícone no meio do caminho
            cortaria a volta dele. */}
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
          // A pasta inteira de uma vez: `git add` aceita o caminho dela como
          // aceita o de um arquivo, e leva junto o que foi apagado e o que ainda
          // não é rastreado lá dentro.
          <div className="tree-file-linha">
            {linhaDir}
            <StageButtons path={node.path} staged={staged} onStage={onStage} pasta />
          </div>
        ) : (
          linhaDir
        )}
        {/* O que está dentro fica montado e vai sendo cortado pela altura: é o que
            permite animar nos dois sentidos, e são linhas baratas. */}
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
          placeholder="Filtrar arquivos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {todasPastas.length > 0 && (
          <button
            className="icon-btn"
            title={tudoRecolhido ? "Abrir todas as pastas" : "Recolher todas as pastas"}
            onClick={alternarTudo}
          >
            <Icon name={tudoRecolhido ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        )}
      </div>
      <div className="tree-items" ref={listRef}>
        {gruposVisiveis
          ? gruposVisiveis.map((g) => {
              // Filtrando, o grupo se abre sozinho: esconder o resultado da
              // busca atrás de um grupo fechado seria dizer que não há nada.
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
                            ? "Pôr no índice tudo o que há no repositório (git add -A)"
                            : "Tirar do índice tudo (git restore --staged)"
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
          <p className="muted tree-empty">Nenhum arquivo encontrado.</p>
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

  // Da lista já ordenada, e não do array cru: o texto colado sai na mesma ordem
  // em que a revisão é lida na tela, arquivo por arquivo, linha por linha.
  const tudo = useMemo(
    () => bookmarksReference(groups.flatMap(([, items]) => items), referenceOf),
    [groups, referenceOf],
  );

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
