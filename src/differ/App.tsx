import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commitIndex,
  loadDiff,
  loadDiffSince,
  loadDiffWorking,
  openRepo,
  stage,
  unstage,
  watchRepo,
  workingStamp,
} from "./api";
import { COLLAPSE_MS, FileDiffView, type NewBookmark } from "./components/FileDiffView";
import { Icon } from "./components/Icons";
import { Mudou } from "./components/Mudou";
import { Prefs } from "./components/Prefs";
import { Sidebar, type GrupoArquivos } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { Trechos } from "./components/Trechos";
import { T } from "../i18n/differ";
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

/** How long, after arriving, the scroll follows the file while what is above it settles. */
const SETTLE_MS = 900;

/**
 * Scrolls with the same duration as the file open/close animation, then calls `done`.
 *
 * The destination is measured again on every frame, not once at the start: the files
 * the scroll passes are only drawn when they get near the screen, and until
 * then they take an estimated height. Measured at the start, the target moves along the way
 * — and the scroll stops before the file or overshoots it, hiding the ones above.
 */
function animateScroll(
  scroller: HTMLElement,
  target: () => number,
  duration: number,
  done: () => void,
  cancelada: () => boolean,
) {
  const start = scroller.scrollTop;
  if (Math.abs(target() - start) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    scroller.scrollTop = target();
    done();
    return;
  }
  const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const startedAt = performance.now();
  const step = (now: number) => {
    // Another scroll started on top of this one: this one stops where it is, without
    // going on to a destination that is no longer the destination.
    if (cancelada()) return;
    const t = Math.min(1, (now - startedAt) / duration);
    scroller.scrollTop = start + (target() - start) * easeInOut(t);
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

/**
 * After arriving, holds the file at the top while what is above it finishes
 * being drawn (WebKit has no scroll anchoring to do this on its own). Lets go on the
 * user's first gesture, on a new scroll or when time runs out.
 */
function settleOn(scroller: HTMLElement, target: () => number, cancelada: () => boolean) {
  const content = scroller.firstElementChild;
  if (!content || typeof ResizeObserver === "undefined") return;
  const align = () => {
    if (cancelada()) return stop();
    const top = target();
    if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
  };
  const observer = new ResizeObserver(align);
  const gestures = ["wheel", "touchstart", "mousedown", "keydown"] as const;
  const timer = setTimeout(() => stop(), SETTLE_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
    for (const g of gestures) scroller.removeEventListener(g, stop);
  }
  observer.observe(content);
  for (const g of gestures) scroller.addEventListener(g, stop, { passive: true });
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
      {T.marcadoresResolvidos(resolved, checking.length)}
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
  /** The tab is on screen. TermIAu says so: inside a hidden iframe, the
      browser's visibility API keeps saying "visible". */
  const [visivel, setVisivel] = useState(true);

  const scope: Scope = settings?.scope ?? "branch";
  const incremental = scope === "incremental";
  const working = scope === "working";
  /** The working tree diff doesn't depend on a target branch: its old side is HEAD. */
  const readyToRefresh = !!repo && (!!target || working);

  const requestId = useRef(0);
  const started = useRef(false);
  const scrollerRef = useRef<HTMLElement>(null);
  const fileEls = useRef(new Map<string, HTMLElement>());
  const scrollFrame = useRef(0);
  // The "v" moves right away; the scroll follows behind. While it is on the way, the
  // scroll position doesn't move the cursor — the events the scroll itself
  // fires would pull it back to the file at the top of the screen.
  const scrollLock = useRef(false);
  /** Where the scroll has to go. A new "v" only changes the destination. */
  const jumpTarget = useRef<string | null>(null);
  /** Qual arquivo fechando destrava a rolagem: fechar e andar junto se atropelam. */
  const jumpFrom = useRef<string | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Scroll in progress. Changing the number cancels the previous one midway. */
  const scrollAnim = useRef(0);
  /** The cursor as it is now, even before the render happens. */
  const cursor = useRef<string | null>(null);
  /** Marked in this burst of "v", which the screen's `viewedPaths` doesn't have yet. */
  const marcados = useRef(new Set<string>());
  // When we were the ones who committed. The commit writes refs, the watcher sees it and the
  // "the repository changed" notice would show up right after the diff we already redid.
  const nossoCommit = useRef(0);
  /** The last disk signature already on screen. */
  const marcaNaTela = useRef<string | null>(null);

  const refresh = useCallback(async (root: string, targetBranch: string, escopo: Scope) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const info = await openRepo(root);
      const key = reviewKey(info.root, info.currentBranch);
      const saved = await persist.loadReview(key);
      const pendente = escopo === "working";
      // Incremental starts from the last commit reviewed to the end; before any, it's the branch.
      let base = escopo === "incremental" ? incrementalBase(saved.completed, info.headSha) : null;
      let result: ReviewDiff;
      try {
        result = pendente
          ? await loadDiffWorking(root)
          : base
            ? await loadDiffSince(root, base)
            : await loadDiff(root, targetBranch);
      } catch (err) {
        // The reviewed commit may be gone (rewritten history, gc): fall back to the branch.
        if (!base) throw err;
        base = null;
        result = await loadDiff(root, targetBranch);
      }
      // What hasn't been committed was never reviewed: here a commit's complete review
      // doesn't count as a review of what sits on top of it.
      let state = pendente ? saved : coverCompleted(saved, result);
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
      // New diff, an old trip doesn't matter: the destination may not even be in the list anymore.
      clearTimeout(jumpTimer.current);
      jumpTarget.current = null;
      jumpFrom.current = null;
      scrollLock.current = false;
      marcados.current = new Set();
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
        // The default is a guess for repositories never seen, not an order that undoes a
        // choice made by hand: that is why it comes after what was stored for this
        // repository. Read from disk, not from state, so it already applies on the first
        // open — which happens before React has the preferences at hand.
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
        // From here on this repository's .git is watched; the notice that it
        // changed arrives as `termiau:mudou`. Failing here doesn't prevent the review —
        // it only costs the notice, and the Refresh button stays in place.
        watchRepo(info.root).catch(() => {});
        // The diff of what is about to be committed doesn't compare against any branch:
        // it opens even in a single-branch repository.
        if (initial || prefs.scope === "working") await refresh(info.root, initial, prefs.scope);
        else setError(T.semBranchesParaComparar);
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  // Only the preferences. The repository doesn't reopen on its own: this is a
  // TermIAu tab, and it stays blank until someone presses the diff button on a panel
  // — opening the last one on its own would show the diff of a project that
  // may not be any of those open in the window.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    persist
      .loadSettings()
      .catch(() => persist.DEFAULT_SETTINGS)
      .then(setSettings);
  }, []);

  // The view mode is a single one for the app: changed in the chat diff, it applies here too.
  useEffect(() => {
    let parar: (() => void) | undefined;
    let vivo = true;
    persist
      .onSettings(({ viewMode }) => setSettings((s) => (s && s.viewMode !== viewMode ? { ...s, viewMode } : s)))
      .then((u) => (vivo ? (parar = u) : u()))
      .catch(() => {});
    return () => {
      vivo = false;
      parar?.();
    };
  }, []);

  // The panel whose diff button was pressed sends its repository through
  // here. The notice that someone is already listening goes along: the click may have
  // happened before this page existed, and in that case the request is stored there
  // waiting for exactly this notice.
  useEffect(() => {
    const ver = (e: Event) => setVisivel((e as CustomEvent<boolean>).detail);
    window.addEventListener("termiau:visivel", ver);
    return () => window.removeEventListener("termiau:visivel", ver);
  }, []);

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

  // With no repository open there is nothing for this tab to show, and TermIAu removes
  // its chip from the bar. This page is the one that knows, so it is the one that says so —
  // on the first render too, when `repo` is still null.
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ termiauRepoAberto: repo?.root ?? null }, "*");
  }, [repo]);

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
      refresh(repo.root, next, scope);
    },
    [repo, scope, refresh],
  );

  const doRefresh = useCallback(() => {
    if (repo && readyToRefresh) refresh(repo.root, target, scope);
  }, [repo, readyToRefresh, target, scope, refresh]);

  /// Staging and unstaging. The target is a file, a folder or "." — the
  /// whole repository. The diff is redone because the diff itself is what changed:
  /// what is in the index and what is on disk are no longer the same.
  ///
  /// One at a time: in the to-be-committed tab "v" also stages,
  /// and a burst of "v" would fire several `git add`s together — the second
  /// would run into the first one's `index.lock`. The diff is only redone when the
  /// queue empties, and the error is shown after it, or it would erase the error.
  const filaIndice = useRef<Promise<void>>(Promise.resolve());
  const naFila = useRef(0);
  const erroNaFila = useRef<string | null>(null);
  const setStaged = useCallback(
    (alvo: string, dentro: boolean) => {
      if (!repo) return;
      naFila.current++;
      filaIndice.current = filaIndice.current.then(async () => {
        try {
          await (dentro ? stage : unstage)(repo.root, alvo);
          marcaNaTela.current = null;
        } catch (err) {
          erroNaFila.current = String(err);
        }
        if (--naFila.current > 0) return;
        await refresh(repo.root, target, scope);
        if (erroNaFila.current) setError(erroNaFila.current);
        erroNaFila.current = null;
      });
    },
    [repo, target, scope, refresh],
  );

  /// The error propagates on purpose: the commit box shows it, beside the
  /// message the user just wrote and must not lose.
  const doCommit = useCallback(
    async (mensagem: string) => {
      if (!repo) return;
      await commitIndex(repo.root, mensagem);
      nossoCommit.current = Date.now();
      marcaNaTela.current = null;
      await refresh(repo.root, target, scope);
    },
    [repo, target, scope, refresh],
  );

  const changeScope = useCallback(
    (next: Scope) => {
      if (next === scope) return;
      setSettings((s) => s && { ...s, scope: next });
      scrollerRef.current?.scrollTo(0, 0);
      if (repo && (target || next === "working")) refresh(repo.root, target, next);
    },
    [scope, repo, target, refresh],
  );

  /**
   * The to-be-committed tab keeps itself up to date. The `.git`
   * watcher doesn't work here: editing a file writes nothing in there, and
   * watching the whole working tree would mean waking up on every build file.
   * So it is a clock, with a cheap disk signature in place of the diff — and only
   * while the tab is visible.
   */
  useEffect(() => {
    if (!repo || !working || !visivel || prefs) return;
    let vivo = true;
    const bater = async () => {
      try {
        const marca = await workingStamp(repo.root);
        if (!vivo) return;
        const anterior = marcaNaTela.current;
        marcaNaTela.current = marca;
        // First tick (or right after one of our `git add`s): just record it.
        if (anterior !== null && anterior !== marca) doRefresh();
      } catch {
        // Repository unavailable (folder deleted, .git vanishing during a rebase): the
        // next tick tries again, and refresh does the explaining.
      }
    };
    void bater();
    // Two seconds: a tick costs a `git diff --raw` and an `ls-files`, which on a
    // large repository aren't free — and nobody edits a file and looks
    // at the tab in the same second.
    const relogio = setInterval(bater, 2000);
    return () => {
      vivo = false;
      clearInterval(relogio);
    };
  }, [repo, working, visivel, prefs, doRefresh]);

  // .git changed. A commit writes several files in there, and a fetch
  // writes many: without the wait, the same commit would open the dialog six times.
  useEffect(() => {
    if (!repo) return;
    let espera: ReturnType<typeof setTimeout>;
    const avisar = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== repo.root) return;
      // The commit came from here: the screen already has it, there is nothing to report.
      if (Date.now() - nossoCommit.current < 3000) return;
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

  // In the to-be-committed tab the list comes split in two, like in
  // VS Code: what the commit will take and what it won't. A file half in the index
  // goes in the first group — part of it goes — and shows both buttons.
  const grupos: GrupoArquivos[] | null = useMemo(() => {
    if (!working) return null;
    const dentro = files.filter((f) => f.staged === "staged" || f.staged === "partial");
    const fora = files.filter((f) => f.staged === "unstaged");
    return [
      {
        chave: "indice",
        titulo: T.noIndice,
        tree: buildTree(dentro),
        poeTudo: false,
        vazio: T.nadaNoIndiceAinda,
      },
      {
        chave: "fora",
        titulo: T.foraDoIndice,
        tree: buildTree(fora),
        poeTudo: true,
        vazio: T.tudoNoIndice,
      },
    ];
  }, [working, files]);
  const reviewedMap = review?.state.reviewed;
  // In the to-be-committed tab, reviewing is approving for the commit: the
  // reviewed state is the index itself, not a mark stored separately. So a
  // `git add` run in the terminal also shows as reviewed, and a file only
  // half staged isn't yet — the rest of it still needs approval.
  const viewedPaths = useMemo(
    () =>
      new Set(
        files
          .filter((f) => (working ? f.staged === "staged" : reviewedMap?.[fileKey(f)] !== undefined))
          .map((f) => f.path),
      ),
    [files, reviewedMap, working],
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
      // Reviewed here means being in the index (see `viewedPaths`): marking is `git add`,
      // unmarking is `git restore --staged`.
      if (working) setStaged(file.path, value);
      else
        updateReview((s) => ({
          ...s,
          reviewed: value ? { ...s.reviewed, [key]: Date.now() } : omit(s.reviewed, key),
        }));
      // Back to the default: viewed files collapse, unviewed ones open.
      setCollapsedOverrides((o) => omit(o, key));
    },
    [updateReview, working, setStaged],
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
    // Seeing everything about to be committed isn't having reviewed the commit: the checkpoint
    // is of what is in HEAD, and the disk has things it doesn't.
    if (working) return;
    if (!completed || completed.some((c) => c.commit === diff.headSha)) return;
    const checkpoint = { commit: diff.headSha, at: Date.now() };
    updateReview((s) => ({ ...s, completed: [...s.completed, checkpoint] }));
  }, [diff, files, viewedPaths, completed, working, updateReview]);

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

  /**
   * `smooth` glides there and only then highlights the file, so the move is easy to follow.
   * `moveCursor` is false when the caller is "v": there the cursor already moved, and
   * putting it back at the end of the scroll would bring it back if another "v" already moved it ahead.
   */
  const selectFile = useCallback((path: string, smooth = false, moveCursor = true) => {
    const el = fileEls.current.get(path);
    const scroller = scrollerRef.current;
    const id = ++scrollAnim.current;
    const arrive = () => {
      if (id !== scrollAnim.current) return;
      if (moveCursor) {
        cursor.current = path;
        setActivePath(path);
      }
      scrollLock.current = false;
    };
    if (!el || !scroller) {
      arrive();
    } else if (smooth) {
      const gap = parseFloat(getComputedStyle(scroller).getPropertyValue("--sticky-gap")) || 0;
      const target = () =>
        scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
      const cancelada = () => id !== scrollAnim.current;
      animateScroll(scroller, target, COLLAPSE_MS, () => {
        arrive();
        settleOn(scroller, target, cancelada);
      }, cancelada);
    } else {
      el.scrollIntoView({ block: "start" });
      arrive();
    }
  }, []);

  /** Goes to where the cursor is now — which may no longer be where it was when the trip started. */
  const alcancarCursor = useCallback(() => {
    clearTimeout(jumpTimer.current);
    jumpFrom.current = null;
    const alvo = jumpTarget.current;
    jumpTarget.current = null;
    if (alvo) selectFile(alvo, true, false);
    else scrollLock.current = false;
  }, [selectFile]);

  /**
   * Marks the destination and leaves the scroll for later. Measuring the next file with the
   * previous one still shrinking misses the target — the rest of the collapse pulls everything
   * up —, so it waits for the collapse; the clock is the safety net for
   * when there is no collapse (file already closed) or when it doesn't notify.
   */
  const agendarRolagem = useCallback(
    (destino: string, fechando: string | null) => {
      jumpTarget.current = destino;
      jumpFrom.current = fechando;
      scrollLock.current = true;
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(alcancarCursor, COLLAPSE_MS + STEP_PAUSE_MS);
    },
    [alcancarCursor],
  );

  const handleCollapseEnd = useCallback(
    (file: FileDiff) => {
      if (jumpFrom.current !== file.path) return;
      jumpFrom.current = null;
      // A short beat between "closed" and "moving on" so each step reads on its own.
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(alcancarCursor, STEP_PAUSE_MS);
    },
    [alcancarCursor],
  );

  /** The file the keyboard acts on: the one at the top of the diff. */
  const currentPath = activePath ?? files[0]?.path ?? null;

  // The cursor in a ref too: one "v" after another moves faster than the render,
  // and the second needs to know where the first one stopped.
  useEffect(() => {
    cursor.current = currentPath;
  }, [currentPath]);

  // The burst just reached the screen: what was only in the ref is now in state.
  useEffect(() => {
    marcados.current = new Set();
  }, [viewedPaths]);

  // "V" toggles the current file; once reviewed, the cursor moves to the next one still to
  // review — right away, without waiting for the scroll: fast typists must not be slowed down by it.
  const toggleCurrentViewed = useCallback(() => {
    const atual = cursor.current ?? currentPath;
    const file = files.find((f) => f.path === atual);
    if (!file) return;
    // The screen's state plus what this burst already marked and it doesn't show yet.
    const vistos = marcados.current.size
      ? new Set([...viewedPaths, ...marcados.current])
      : viewedPaths;
    const value = !vistos.has(file.path);
    // Unviewed files are open unless the user closed them or they're generated.
    const alreadyClosed = collapsedOverrides[fileKey(file)] ?? isGenerated(file.path);
    markViewed(file, value);
    if (!value) {
      marcados.current.delete(file.path);
      return;
    }
    marcados.current.add(file.path);
    const next = nextToReview(files, file.path, vistos);
    if (!next) return;
    // The cursor is the list's, not the scroll's: the next one to review, wherever
    // it is on screen.
    cursor.current = next.path;
    setActivePath(next.path);
    agendarRolagem(next.path, alreadyClosed ? null : file.path);
  }, [files, currentPath, viewedPaths, collapsedOverrides, markViewed, agendarRolagem]);

  /** Is everything within this target already in the index? It decides whether the key stages or unstages. */
  const tudoNoIndice = useCallback(
    (alvo: string) => {
      const dentro = files.filter(
        (f) => alvo === "." || f.path === alvo || f.path.startsWith(`${alvo}/`),
      );
      return dentro.length > 0 && dentro.every((f) => f.staged === "staged");
    },
    [files],
  );

  /**
   * The three index keys, all toggling: the cursor's file, its
   * folder and the whole repository. Toggling instead of only staging is what spares a
   * second key for each of the three.
   */
  const alternarIndice = useCallback(
    (alvo: string) => void setStaged(alvo, !tudoNoIndice(alvo)),
    [setStaged, tudoNoIndice],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const tecla = e.key.toLowerCase();
      if (tecla === "v") {
        e.preventDefault();
        toggleCurrentViewed();
        return;
      }
      // The index only exists in the to-be-committed tab.
      if (!working) return;
      const atual = files.find((f) => f.path === (cursor.current ?? currentPath));
      if (tecla === "s" && atual) {
        e.preventDefault();
        // ⇧S goes up one step: the file's folder — the root is the whole repository.
        const pasta = atual.path.split("/").slice(0, -1).join("/");
        alternarIndice(e.shiftKey ? pasta || "." : atual.path);
      }
      if (tecla === "a") {
        e.preventDefault();
        alternarIndice(".");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCurrentViewed, working, files, currentPath, alternarIndice]);

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
    if (scrollLock.current || scrollFrame.current) return;
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
      cursor.current = current;
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
          visivel={visivel}
        />
      )}
      {prefs && (
        <Prefs
          defaultTarget={settings?.defaultTarget ?? ""}
          onDefaultTarget={(branch) => setSettings((s) => s && { ...s, defaultTarget: branch })}
          editor={settings?.editor ?? ""}
          onEditor={(editor) => setSettings((s) => s && { ...s, editor })}
          contexto={{
            atencao: settings?.contextoAtencao ?? persist.DEFAULT_SETTINGS.contextoAtencao,
            perigo: settings?.contextoPerigo ?? persist.DEFAULT_SETTINGS.contextoPerigo,
            autoCompact: settings?.autoCompact ?? persist.DEFAULT_SETTINGS.autoCompact,
            autoCompactEm: settings?.autoCompactEm ?? persist.DEFAULT_SETTINGS.autoCompactEm,
          }}
          onContexto={({ atencao, perigo, autoCompact, autoCompactEm }) =>
            setSettings(
              (s) => s && { ...s, contextoAtencao: atencao, contextoPerigo: perigo, autoCompact, autoCompactEm },
            )
          }
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
          <button className="icon-btn" title={T.fechar} onClick={() => setError(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {!repo ? null : (
        <div className="workspace">
          <Sidebar
            tree={tree}
            grupos={grupos}
            files={files}
            viewedPaths={viewedPaths}
            activePath={currentPath}
            bookmarks={bookmarks}
            outdated={outdated}
            placements={placements}
            referenceOf={referenceOf}
            staging={working}
            noIndice={files.filter((f) => f.staged === "staged" || f.staged === "partial").length}
            onStage={setStaged}
            onCommit={doCommit}
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
                  {working ? (
                    <span>
                      <Trechos de={T.resumoWorking(diff.branch ?? "HEAD")} />
                    </span>
                  ) : sinceBase ? (
                    <span>
                      <Trechos de={T.resumoIncremental(diff.branch ?? "HEAD", sinceBase.slice(0, 7))} />
                    </span>
                  ) : (
                    <span>
                      <Trechos de={T.resumoBranch(diff.branch ?? "HEAD", diff.target)} />
                      {incremental && T.semRevisaoCompleta}
                    </span>
                  )}
                  {sinceBase && <ResolvedCount bookmarks={bookmarks} placements={placements} />}
                  {working ? (
                    <span className="sha" title={`head ${diff.headSha}\n${T.ladoNovoEODisco}`}>
                      {diff.headSha.slice(0, 7)}…{T.disco}
                    </span>
                  ) : (
                    <span className="sha" title={`base ${diff.mergeBase}\nhead ${diff.headSha}`}>
                      {diff.mergeBase.slice(0, 7)}…{diff.headSha.slice(0, 7)}
                    </span>
                  )}
                </div>
              )}
              {diff && files.length === 0 && sinceBase && (
                <div className="empty-diff">
                  <h2>{T.nadaNovo}</h2>
                  <p>
                    <Trechos de={T.nadaNovoTexto(diff.branch ?? "HEAD", sinceBase.slice(0, 7))} />
                  </p>
                </div>
              )}
              {diff && files.length === 0 && working && (
                <div className="empty-diff">
                  <h2>{T.nadaParaCommitar}</h2>
                  <p>
                    <Trechos de={T.nadaParaCommitarTexto(diff.branch ?? "HEAD")} />
                  </p>
                </div>
              )}
              {diff && files.length === 0 && !sinceBase && !working && (
                <div className="empty-diff">
                  <h2>{T.nadaParaRevisar}</h2>
                  <p>
                    <Trechos de={T.nadaParaRevisarTexto(diff.branch ?? "HEAD", diff.target)} />
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
                      staging={working}
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
              {!diff && loading && <div className="loading-state">{T.carregandoDiff}</div>}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
