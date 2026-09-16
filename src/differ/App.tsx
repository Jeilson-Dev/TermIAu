import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDiff, loadDiffSince, openRepo, watchRepo } from "./api";
import { COLLAPSE_MS, FileDiffView, type NewBookmark } from "./components/FileDiffView";
import { Icon } from "./components/Icons";
import { Mudou } from "./components/Mudou";
import { Prefs } from "./components/Prefs";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { bookmarkReference, checkBookmarks } from "./lib/bookmarks";
import { incrementalBase, placeBookmarks, type FixPlacement } from "./lib/fixes";
import { isGenerated } from "./lib/generated";
import { nextToReview } from "./lib/navigation";
import * as persist from "./lib/persist";
import { buildTree, flattenTree } from "./lib/tree";
import type { Bookmark, FileDiff, FocusTarget, RepoInfo, ReviewDiff, Scope, ViewMode } from "./types";
import "./styles.css";

interface LoadedReview {
  key: string;
  state: persist.ReviewState;
}

const EMPTY_BOOKMARKS: Bookmark[] = [];

/** Review state (viewed files, bookmarks) belongs to a branch of a repository. */
const reviewKey = (root: string, branch: string | null) => `${root}::${branch ?? "HEAD"}`;

/** Changes whenever the file's diff changes: resets per-file UI state and keys its reviewed mark. */
const fileKey = (file: FileDiff) => persist.diffKey(file.path, file.fingerprint);

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Pause between the steps of the "V" sequence (close → scroll → highlight). */
const STEP_PAUSE_MS = 150;

/** Scrolls with the same duration as the file open/close animation, then calls `done`. */
function animateScroll(scroller: HTMLElement, top: number, duration: number, done: () => void) {
  const start = scroller.scrollTop;
  const distance = top - start;
  if (Math.abs(distance) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    scroller.scrollTop = top;
    done();
    return;
  }
  const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const startedAt = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startedAt) / duration);
    scroller.scrollTop = start + distance * easeInOut(t);
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

/** Single-key shortcuts must not fire while the user types (bookmark notes, file filter). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "range"].includes(target.type);
}

/**
 * A review completed on this HEAD (in either scope) covers every file of any diff ending on it:
 * reviewing the few files of an incremental diff also completes the whole branch, and back.
 */
function coverCompleted(state: persist.ReviewState, diff: ReviewDiff): persist.ReviewState {
  if (!state.completed.some((c) => c.commit === diff.headSha)) return state;
  const missing = diff.files.map(fileKey).filter((key) => !(key in state.reviewed));
  if (missing.length === 0) return state;
  const now = Date.now();
  return { ...state, reviewed: { ...state.reviewed, ...Object.fromEntries(missing.map((key) => [key, now])) } };
}

/** How many of the review's notes were checked off (notes made since the review don't count). */
function ResolvedCount({
  bookmarks,
  placements,
}: {
  bookmarks: Bookmark[];
  placements: Map<string, FixPlacement> | null;
}) {
  const checking = bookmarks.filter((b) => placements?.get(b.id)?.status !== "new");
  if (checking.length === 0) return null;
  const resolved = checking.filter((b) => b.resolved).length;
  return (
    <span className={resolved === checking.length ? "badge ok" : "badge"}>
      {resolved} de {checking.length} {checking.length === 1 ? "marcador resolvido" : "marcadores resolvidos"}
    </span>
  );
}

export default function App() {
  const [settings, setSettings] = useState<persist.Settings | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [target, setTarget] = useState("");
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [review, setReview] = useState<LoadedReview | null>(null);
  const [outdated, setOutdated] = useState<Set<string>>(() => new Set());
  /** Last commit reviewed to the end, when the diff on screen starts from it (incremental). */
  const [sinceBase, setSinceBase] = useState<string | null>(null);
  const [placements, setPlacements] = useState<Map<string, FixPlacement> | null>(null);
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(false);
  const [mudou, setMudou] = useState(false);

  const scope: Scope = settings?.scope ?? "branch";
  const incremental = scope === "incremental";

  const requestId = useRef(0);
  const started = useRef(false);
  const scrollerRef = useRef<HTMLElement>(null);
  const fileEls = useRef(new Map<string, HTMLElement>());
  const scrollFrame = useRef(0);
  // "V" runs close → scroll → highlight next, one visible step at a time. While it runs the
  // highlight must not follow the scroll, and the next file waits for the close to finish.
  const holdActive = useRef(false);
  const pendingJump = useRef<{ from: string; to: string } | null>(null);

  const refresh = useCallback(async (root: string, targetBranch: string, since: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const info = await openRepo(root);
      const key = reviewKey(info.root, info.currentBranch);
      const saved = await persist.loadReview(key);
      // Incremental starts from the last commit reviewed to the end; before any, it's the branch.
      let base = since ? incrementalBase(saved.completed, info.headSha) : null;
      let result: ReviewDiff;
      try {
        result = base ? await loadDiffSince(root, base) : await loadDiff(root, targetBranch);
      } catch (err) {
        // The reviewed commit may be gone (rewritten history, gc): fall back to the branch.
        if (!base) throw err;
        base = null;
        result = await loadDiff(root, targetBranch);
      }
      let state = coverCompleted(saved, result);
      let lost: Set<string>;
      let placed: Map<string, FixPlacement> | null = null;
      if (base) {
        // Bookmarks belong to the branch's diff: here they're placed on the reviewed side instead.
        placed = await placeBookmarks(
          info.root,
          { files: result.files, headSha: result.headSha, base: result.mergeBase },
          state.bookmarks,
        );
        lost = new Set([...placed].filter(([, p]) => p.status === "lost").map(([bookmarkId]) => bookmarkId));
      } else {
        const checked = await checkBookmarks(info.root, result.files, state);
        state = checked.state;
        lost = checked.outdated;
      }
      if (id !== requestId.current) return;
      setRepo(info);
      setDiff(result);
      setReview({ key, state });
      setOutdated(lost);
      setPlacements(placed);
      setSinceBase(base);
      pendingJump.current = null;
      holdActive.current = false;
    } catch (err) {
      if (id !== requestId.current) return;
      setDiff(null);
      setPlacements(null);
      setSinceBase(null);
      setError(String(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  const openRepoAt = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const info = await openRepo(path);
        const [saved, prefs] = await Promise.all([
          persist.loadRepoConfig(info.root),
          persist.loadSettings(),
        ]);
        const branches = [...info.localBranches, ...info.remoteBranches];
        // O padrão é palpite para quem nunca foi visto, não ordem que desfaz
        // escolha feita à mão: por isso vem depois do que ficou guardado deste
        // repositório. Lido do disco, e não do estado, para já valer na primeira
        // abertura — que acontece antes de o React ter as preferências em mãos.
        const padrao = [prefs.defaultTarget, `origin/${prefs.defaultTarget}`].find(
          (b) => b && branches.includes(b),
        );
        const initial =
          saved && branches.includes(saved.target)
            ? saved.target
            : (padrao ?? info.suggestedTarget ?? info.localBranches[0] ?? "");
        setRepo(info);
        setTarget(initial);
        setDiff(null);
        setReview(null);
        setOutdated(new Set());
        setSinceBase(null);
        setPlacements(null);
        setCollapsedOverrides({});
        setActivePath(null);
        setMudou(false);
        scrollerRef.current?.scrollTo(0, 0);
        // Daqui em diante o .git deste repositório é vigiado; o aviso de que ele
        // mexeu chega como `termiau:mudou`. Falhar aqui não impede a revisão —
        // só custa o aviso, e o botão Atualizar continua no lugar.
        watchRepo(info.root).catch(() => {});
        if (initial) await refresh(info.root, initial, prefs.scope === "incremental");
        else setError("O repositório não tem branches para comparar.");
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  // Só as preferências. O repositório não se reabre sozinho: esta é uma aba do
  // TermIAu, e ela fica em branco até alguém apertar o botão de diff num painel
  // — abrir o último por conta própria seria mostrar o diff de um projeto que
  // talvez não seja nenhum dos que estão abertos na janela.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    persist
      .loadSettings()
      .catch(() => ({ viewMode: "unified" as const, defaultTarget: "", scope: "branch" as const }))
      .then(setSettings);
  }, []);

  // O painel de onde o botão de diff foi apertado manda o repositório dele por
  // aqui. O aviso de que já há quem escute vai junto: o clique pode ter sido
  // dado antes desta página existir, e nesse caso o pedido está guardado lá
  // esperando exatamente este aviso.
  useEffect(() => {
    const abrir = (e: Event) => void openRepoAt((e as CustomEvent<string>).detail);
    const preferencias = () => setPrefs(true);
    window.addEventListener("termiau:repo", abrir);
    window.addEventListener("termiau:prefs", preferencias);
    if (window.parent !== window) window.parent.postMessage({ termiauPronto: true }, "*");
    return () => {
      window.removeEventListener("termiau:repo", abrir);
      window.removeEventListener("termiau:prefs", preferencias);
    };
  }, [openRepoAt]);

  useEffect(() => {
    if (settings) persist.saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (review) persist.saveReview(review.key, review.state);
  }, [review]);

  const changeTarget = useCallback(
    (next: string) => {
      if (!repo) return;
      setTarget(next);
      persist.saveRepoConfig(repo.root, { target: next });
      refresh(repo.root, next, incremental);
    },
    [repo, incremental, refresh],
  );

  const doRefresh = useCallback(() => {
    if (repo && target) refresh(repo.root, target, incremental);
  }, [repo, target, incremental, refresh]);

  const changeScope = useCallback(
    (next: Scope) => {
      if (next === scope) return;
      setSettings((s) => s && { ...s, scope: next });
      scrollerRef.current?.scrollTo(0, 0);
      if (repo && target) refresh(repo.root, target, next === "incremental");
    },
    [scope, repo, target, refresh],
  );

  // O .git mexeu. Um commit escreve vários arquivos lá dentro, e um fetch
  // escreve muitos: sem a espera, o mesmo commit abriria o diálogo seis vezes.
  useEffect(() => {
    if (!repo) return;
    let espera: ReturnType<typeof setTimeout>;
    const avisar = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== repo.root) return;
      clearTimeout(espera);
      espera = setTimeout(() => setMudou(true), 400);
    };
    window.addEventListener("termiau:mudou", avisar);
    return () => {
      clearTimeout(espera);
      window.removeEventListener("termiau:mudou", avisar);
    };
  }, [repo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "r" && (e.metaKey || e.ctrlKey)) || e.key === "F5") {
        e.preventDefault();
        doRefresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doRefresh]);

  const setViewMode = useCallback((viewMode: ViewMode) => setSettings((s) => s && { ...s, viewMode }), []);

  const tree = useMemo(() => (diff ? buildTree(diff.files) : []), [diff]);
  const files = useMemo(() => flattenTree(tree), [tree]);
  const reviewedMap = review?.state.reviewed;
  const viewedPaths = useMemo(
    () => new Set(files.filter((f) => reviewedMap?.[fileKey(f)] !== undefined).map((f) => f.path)),
    [files, reviewedMap],
  );
  const bookmarks = review?.state.bookmarks ?? EMPTY_BOOKMARKS;
  const bookmarksByPath = useMemo(() => {
    const byPath = new Map<string, Bookmark[]>();
    for (const b of bookmarks) {
      // The file may have been renamed since the note: it goes with it.
      const path = placements?.get(b.id)?.current?.path ?? b.path;
      byPath.set(path, [...(byPath.get(path) ?? []), b]);
    }
    return byPath;
  }, [bookmarks, placements]);
  const completed = review?.state.completed;

  const updateReview = useCallback(
    (fn: (state: persist.ReviewState) => persist.ReviewState) =>
      setReview((r) => r && { ...r, state: fn(r.state) }),
    [],
  );

  const registerElement = useCallback((path: string, el: HTMLElement | null) => {
    if (el) fileEls.current.set(path, el);
    else fileEls.current.delete(path);
  }, []);

  const setCollapsed = useCallback((file: FileDiff, value: boolean) => {
    setCollapsedOverrides((o) => ({ ...o, [fileKey(file)]: value }));
  }, []);

  const markViewed = useCallback(
    (file: FileDiff, value: boolean) => {
      const key = fileKey(file);
      updateReview((s) => ({
        ...s,
        reviewed: value ? { ...s.reviewed, [key]: Date.now() } : omit(s.reviewed, key),
      }));
      // Back to the default: viewed files collapse, unviewed ones open.
      setCollapsedOverrides((o) => omit(o, key));
    },
    [updateReview],
  );

  const addBookmark = useCallback(
    (b: NewBookmark) => {
      // The commit the lines belong to: it places the note in later incremental reviews.
      const commit = b.side === "new" ? diff?.headSha : diff?.mergeBase;
      const bookmark: Bookmark = { ...b, commit, id: crypto.randomUUID(), createdAt: Date.now() };
      updateReview((s) => ({ ...s, bookmarks: [...s.bookmarks, bookmark] }));
    },
    [updateReview, diff],
  );

  const updateBookmark = useCallback(
    (id: string, note: string) =>
      updateReview((s) => ({ ...s, bookmarks: s.bookmarks.map((b) => (b.id === id ? { ...b, note } : b)) })),
    [updateReview],
  );

  const removeBookmark = useCallback(
    (id: string) => updateReview((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== id) })),
    [updateReview],
  );

  const toggleResolved = useCallback(
    (id: string) =>
      updateReview((s) => ({
        ...s,
        bookmarks: s.bookmarks.map((b) => (b.id === id ? { ...b, resolved: !b.resolved } : b)),
      })),
    [updateReview],
  );

  // Every file marked as reviewed completes the review of this commit: the next commit's
  // incremental review starts from it.
  useEffect(() => {
    if (!diff || files.length === 0 || viewedPaths.size !== files.length) return;
    if (!completed || completed.some((c) => c.commit === diff.headSha)) return;
    const checkpoint = { commit: diff.headSha, at: Date.now() };
    updateReview((s) => ({ ...s, completed: [...s.completed, checkpoint] }));
  }, [diff, files, viewedPaths, completed, updateReview]);

  const oldPaths = useMemo(() => new Map(files.map((f) => [f.path, f.oldPath])), [files]);
  const referenceOf = useCallback(
    (b: Bookmark) => {
      // In an incremental review, the reference follows the lines to where they are today.
      const current = placements?.get(b.id)?.current;
      return current
        ? bookmarkReference({ ...b, ...current, side: "new" })
        : bookmarkReference(b, oldPaths.get(b.path) ?? null);
    },
    [placements, oldPaths],
  );

  /** `smooth` glides there and only then highlights the file, so the move is easy to follow. */
  const selectFile = useCallback((path: string, smooth = false) => {
    const el = fileEls.current.get(path);
    const scroller = scrollerRef.current;
    const arrive = () => {
      setActivePath(path);
      holdActive.current = false;
    };
    if (!el || !scroller) {
      arrive();
    } else if (smooth) {
      const gap = parseFloat(getComputedStyle(scroller).getPropertyValue("--sticky-gap")) || 0;
      const target =
        scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
      animateScroll(scroller, target, COLLAPSE_MS, arrive);
    } else {
      el.scrollIntoView({ block: "start" });
      arrive();
    }
  }, []);

  const handleCollapseEnd = useCallback(
    (file: FileDiff) => {
      const jump = pendingJump.current;
      if (jump?.from !== file.path) return;
      pendingJump.current = null;
      // A short beat between "closed" and "moving on" so each step reads on its own.
      setTimeout(() => selectFile(jump.to, true), STEP_PAUSE_MS);
    },
    [selectFile],
  );

  /** The file the keyboard acts on: the one at the top of the diff. */
  const currentPath = activePath ?? files[0]?.path ?? null;

  // "V" toggles the current file; once reviewed, jump to the next one still to review.
  const toggleCurrentViewed = useCallback(() => {
    if (holdActive.current) return; // previous "V" still moving on
    const file = files.find((f) => f.path === currentPath);
    if (!file) return;
    const value = !viewedPaths.has(file.path);
    // Unviewed files are open unless the user closed them or they're generated.
    const alreadyClosed = collapsedOverrides[fileKey(file)] ?? isGenerated(file.path);
    markViewed(file, value);
    if (!value) return;
    const next = nextToReview(files, file.path, viewedPaths);
    if (!next) return;
    // Close, then scroll, then highlight the next file. Measuring the next file while this one
    // is still closing would also overshoot: the rest of the close pulls everything up.
    holdActive.current = true;
    if (alreadyClosed) selectFile(next.path, true);
    else pendingJump.current = { from: file.path, to: next.path };
  }, [files, currentPath, viewedPaths, collapsedOverrides, markViewed, selectFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "v" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      toggleCurrentViewed();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCurrentViewed]);

  const selectBookmark = useCallback(
    (b: Bookmark) => {
      const place = placements?.get(b.id);
      const anchor = place ? place.anchor : b;
      const path = place?.current?.path ?? b.path;
      if (!anchor || outdated.has(b.id)) selectFile(path);
      else setFocus({ path, side: anchor.side, line: anchor.startLine, nonce: Date.now() });
    },
    [outdated, placements, selectFile],
  );

  // Highlight in the sidebar the file currently at the top of the diff.
  const onScroll = useCallback(() => {
    if (holdActive.current || scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const gap = parseFloat(getComputedStyle(scroller).getPropertyValue("--sticky-gap")) || 0;
      const top = scroller.getBoundingClientRect().top + gap;
      // A file stays current while some of it still shows below its sticky header. As soon as its
      // end starts pushing the header up (the file is leaving), the next file takes over.
      let current = files[files.length - 1]?.path ?? null;
      for (const f of files) {
        const el = fileEls.current.get(f.path);
        if (!el) continue;
        const headerHeight = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
        if (el.getBoundingClientRect().bottom > top + headerHeight + 1) {
          current = f.path;
          break;
        }
      }
      setActivePath(current);
    });
  }, [files]);

  const viewMode = settings?.viewMode ?? "unified";

  return (
    <div className="app">
      {mudou && (
        <Mudou
          onReload={() => {
            setMudou(false);
            doRefresh();
          }}
          onDismiss={() => setMudou(false)}
        />
      )}
      {prefs && (
        <Prefs
          defaultTarget={settings?.defaultTarget ?? ""}
          onDefaultTarget={(branch) => setSettings((s) => s && { ...s, defaultTarget: branch })}
          onClose={() => setPrefs(false)}
        />
      )}
      {repo && (
        <Toolbar
          repo={repo}
          target={target}
          diff={diff}
          loading={loading}
          viewedCount={viewedPaths.size}
          viewMode={viewMode}
          scope={scope}
          sinceBase={sinceBase}
          onTargetChange={changeTarget}
          onViewMode={setViewMode}
          onScope={changeScope}
        />
      )}
      {error && (
        <div className="banner error" role="alert">
          <Icon name="warning" />
          <span>{error}</span>
          <button className="icon-btn" title="Fechar" onClick={() => setError(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {!repo ? null : (
        <div className="workspace">
          <Sidebar
            tree={tree}
            files={files}
            viewedPaths={viewedPaths}
            activePath={currentPath}
            bookmarks={bookmarks}
            outdated={outdated}
            placements={placements}
            referenceOf={referenceOf}
            onSelectFile={selectFile}
            onSelectBookmark={selectBookmark}
            onRemoveBookmark={removeBookmark}
            onToggleResolved={toggleResolved}
          />
          <main className="diff-scroller" ref={scrollerRef} onScroll={onScroll}>
            <div className="diff-content">
              <div className="sticky-cap" />
              {diff && (
                <div className="diff-summary">
                  {sinceBase ? (
                    <span>
                      Mudanças em <code className="branch-name">{diff.branch ?? "HEAD"}</code> desde a última
                      revisão completa, em <code className="branch-name">{sinceBase.slice(0, 7)}</code>
                    </span>
                  ) : (
                    <span>
                      Mudanças de <code className="branch-name">{diff.branch ?? "HEAD"}</code> desde que saiu de{" "}
                      <code className="branch-name">{diff.target}</code>
                      {incremental && " — nenhuma revisão completa ainda, então é a branch inteira"}
                    </span>
                  )}
                  {sinceBase && <ResolvedCount bookmarks={bookmarks} placements={placements} />}
                  <span className="sha" title={`base ${diff.mergeBase}\nhead ${diff.headSha}`}>
                    {diff.mergeBase.slice(0, 7)}…{diff.headSha.slice(0, 7)}
                  </span>
                </div>
              )}
              {diff && files.length === 0 && sinceBase && (
                <div className="empty-diff">
                  <h2>Nada novo</h2>
                  <p>
                    Não há commits em <code>{diff.branch ?? "HEAD"}</code> que mudem algo desde a última revisão
                    completa, em <code>{sinceBase.slice(0, 7)}</code>.
                  </p>
                </div>
              )}
              {diff && files.length === 0 && !sinceBase && (
                <div className="empty-diff">
                  <h2>Nada para revisar</h2>
                  <p>
                    Não há commits em <code>{diff.branch ?? "HEAD"}</code> que não estejam em{" "}
                    <code>{diff.target}</code>.
                  </p>
                </div>
              )}
              {diff &&
                files.map((file) => {
                  const key = fileKey(file);
                  const isViewed = viewedPaths.has(file.path);
                  return (
                    <FileDiffView
                      key={key}
                      root={diff.root}
                      file={file}
                      viewMode={viewMode}
                      viewed={isViewed}
                      active={file.path === currentPath}
                      collapsed={collapsedOverrides[key] ?? (isViewed || isGenerated(file.path))}
                      bookmarks={bookmarksByPath.get(file.path) ?? EMPTY_BOOKMARKS}
                      outdated={outdated}
                      placements={placements}
                      referenceOf={referenceOf}
                      focus={focus?.path === file.path ? focus : null}
                      scrollRoot={scrollerRef}
                      registerElement={registerElement}
                      onCollapse={setCollapsed}
                      onCollapseEnd={handleCollapseEnd}
                      onSetViewed={markViewed}
                      onAddBookmark={addBookmark}
                      onUpdateBookmark={updateBookmark}
                      onRemoveBookmark={removeBookmark}
                      onToggleResolved={toggleResolved}
                    />
                  );
                })}
              {!diff && loading && <div className="loading-state">Carregando diff…</div>}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
