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
import { Changed } from "./components/Changed";
import { Sidebar, type GroupFiles } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { Snippets } from "./components/Snippets";
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

/** Pause between the steps of the "V" sequence (close → scroll). */
const STEP_PAUSE_MS = 150;

/** How long, after arriving, the file is held at the top while what is above it settles. */
const SETTLE_MS = 900;

/** How far the file's top is from where it should be: the top of the scroller, below the sticky gap. */
function distanceFromTop(scroller: HTMLElement, el: HTMLElement): number {
  const gap = parseFloat(getComputedStyle(scroller).getPropertyValue("--sticky-gap")) || 0;
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
}

/** How long the glide to the next file takes. */
const SLIDE_MS = 450;

/**
 * Glides the file's header to the top, fast at first and slowing down to a stop, then keeps
 * it there for a moment while what is above it finishes changing size (WebKit has no scroll
 * anchoring to do this on its own). The destination is measured again on every frame — a
 * diff reloading or a file above being drawn moves it along the way —, and so is the file:
 * the reload may remount it. The anchor is measured by the section's top, where the header
 * sits in its natural place: the header itself is sticky, and stuck at the top it would
 * read as "arrived" even with the scroll in the middle of the diff. Lets go on your first
 * gesture anywhere in the page, on a new trip or when time runs out.
 */
function land(scroller: HTMLElement, file: () => HTMLElement | undefined, cancelled: () => boolean) {
  /** How far the header still is, or undefined while the file isn't on the page (remounting). */
  const missing = () => {
    const el = file();
    return el?.isConnected ? distanceFromTop(scroller, el) : undefined;
  };
  const gestures = ["wheel", "touchstart", "mousedown", "keydown"] as const;
  let parado = false;
  const stop = () => {
    parado = true;
    for (const g of gestures) window.removeEventListener(g, stop, true);
  };
  for (const g of gestures) window.addEventListener(g, stop, { capture: true, passive: true });

  const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const slows = (t: number) => 1 - (1 - t) ** 3;
  const beginning = performance.now();
  const from = scroller.scrollTop;
  const step = (now: number) => {
    if (parado) return;
    if (cancelled() || now - beginning > SLIDE_MS + SETTLE_MS) return stop();
    const t = suave ? Math.min(1, (now - beginning) / SLIDE_MS) : 1;
    const d = missing();
    if (d !== undefined) {
      // Where the destination is now, in absolute scroll terms.
      const target = scroller.scrollTop + d;
      const pos = t < 1 ? from + (target - from) * slows(t) : target;
      if (Math.abs(scroller.scrollTop - pos) >= 1) scroller.scrollTop = pos;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The keys that scroll the page by themselves. */
const KEYS_OF_SCROLL = new Set([" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

/**
 * Holds the scroll still while a reviewed file closes: the wheel, the trackpad, the keys and
 * the scrollbar don't move it, and whatever moves it anyway goes back. Moving during the
 * close is what made the trip to the next file start from the wrong place. Returns what lets go.
 */
function lockScroll(scroller: HTMLElement): () => void {
  const top = scroller.scrollTop;
  const hold = () => {
    if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
  };
  const blockIt = (e: Event) => e.preventDefault();
  const keys = (e: KeyboardEvent) => {
    if (KEYS_OF_SCROLL.has(e.key) && !isTyping(e.target)) e.preventDefault();
  };
  scroller.addEventListener("scroll", hold);
  scroller.addEventListener("wheel", blockIt, { passive: false });
  scroller.addEventListener("touchmove", blockIt, { passive: false });
  window.addEventListener("keydown", keys, true);
  return () => {
    scroller.removeEventListener("scroll", hold);
    scroller.removeEventListener("wheel", blockIt);
    scroller.removeEventListener("touchmove", blockIt);
    window.removeEventListener("keydown", keys, true);
  };
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
      {T.bookmarksResolved(resolved, checking.length)}
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
  const [changed, setChanged] = useState(false);
  /** The tab is on screen. TermIAu says so: inside a hidden iframe, the
      browser's visibility API keeps saying "visible". */
  const [visible, setVisible] = useState(true);

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
  // The "v" moves the cursor right away; the scroll follows behind, and until it arrives
  // "v" waits. While it is on the way, the scroll position doesn't move the cursor — the
  // events the scroll itself fires would pull it back to the file at the top of the screen.
  const scrollLock = useRef(false);
  /** Where the scroll has to go. A new mark (the header's checkbox) only changes the destination. */
  const jumpTarget = useRef<string | null>(null);
  /** Which file's closing unlocks scrollPos: closing and moving at once would trip over each other. */
  const jumpFrom = useRef<string | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Lets go of the scroll held still while the reviewed file closes (see `lockScroll`). */
  const unlock = useRef<(() => void) | undefined>(undefined);
  /** Scroll in progress. Changing the number cancels the previous one midway. */
  const scrollAnim = useRef(0);
  /** The cursor as it is now, even before the render happens. */
  const cursor = useRef<string | null>(null);
  /** Marked in this burst of "v", which the screen's `viewedPaths` doesn't have yet. */
  const markedOnes = useRef(new Set<string>());
  // When we were the ones who committed. The commit writes refs, the watcher sees it and the
  // "the repository changed" notice would show up right after the diff we already redid.
  const ourCommit = useRef(0);
  /** The last disk signature already on screen. */
  const markInScreen = useRef<string | null>(null);

  const refresh = useCallback(async (root: string, targetBranch: string, scope: Scope) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const info = await openRepo(root);
      const key = reviewKey(info.root, info.currentBranch);
      const saved = await persist.loadReview(key);
      const pendingItem = scope === "working";
      // Incremental starts from the last commit reviewed to the end; before any, it's the branch.
      let base = scope === "incremental" ? incrementalBase(saved.completed, info.headSha) : null;
      let result: ReviewDiff;
      try {
        result = pendingItem
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
      let state = pendingItem ? saved : coverCompleted(saved, result);
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
      // A trip under way goes on as long as its destination is still in the new diff. In the
      // to-be-committed tab, marking is a `git add`, and the diff reloads right after it:
      // cancelling here left the screen still, and with the lock gone the scroll pulled the
      // cursor back to whatever was at the top — so the next "v" marked the wrong file.
      const destination = jumpTarget.current;
      if (!destination || !result.files.some((f) => f.path === destination)) {
        clearTimeout(jumpTimer.current);
        unlock.current?.();
        unlock.current = undefined;
        jumpTarget.current = null;
        jumpFrom.current = null;
        scrollLock.current = false;
      }
      markedOnes.current = new Set();
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
        const fallback = [prefs.defaultTarget, `origin/${prefs.defaultTarget}`].find(
          (b) => b && branches.includes(b),
        );
        const initial =
          saved && branches.includes(saved.target)
            ? saved.target
            : (fallback ?? info.suggestedTarget ?? info.localBranches[0] ?? "");
        setRepo(info);
        setTarget(initial);
        setDiff(null);
        setReview(null);
        setOutdated(new Set());
        setSinceBase(null);
        setPlacements(null);
        setCollapsedOverrides({});
        setActivePath(null);
        setChanged(false);
        scrollerRef.current?.scrollTo(0, 0);
        // From here on this repository's .git is watched; the notice that it
        // changed arrives as `termiau:changed`. Failing here doesn't prevent the review —
        // it only costs the notice, and the Refresh button stays in place.
        watchRepo(info.root).catch(() => {});
        // The diff of what is about to be committed doesn't compare against any branch:
        // it opens even in a single-branch repository.
        if (initial || prefs.scope === "working") await refresh(info.root, initial, prefs.scope);
        else setError(T.noBranchesToCompare);
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

  // The preferences are written by others too: the view mode by the chat diff, the rest by
  // the floating preferences (⌘,). What arrives replaces what is here — otherwise the next
  // save from this tab would write the old values back over them.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    persist
      .onSettings((newOnes) => setSettings((s) => (s && JSON.stringify(s) !== JSON.stringify(newOnes) ? newOnes : s)))
      .then((u) => (alive ? (stop = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  // The panel whose diff button was pressed sends its repository through
  // here. The notice that someone is already listening goes along: the click may have
  // happened before this page existed, and in that case the request is stored there
  // waiting for exactly this notice.
  useEffect(() => {
    const view = (e: Event) => setVisible((e as CustomEvent<boolean>).detail);
    window.addEventListener("termiau:visible", view);
    return () => window.removeEventListener("termiau:visible", view);
  }, []);

  useEffect(() => {
    const openIt = (e: Event) => void openRepoAt((e as CustomEvent<string>).detail);
    window.addEventListener("termiau:repo", openIt);
    if (window.parent !== window) window.parent.postMessage({ termiauPronto: true }, "*");
    return () => window.removeEventListener("termiau:repo", openIt);
  }, [openRepoAt]);

  // With no repository open there is nothing for this tab to show, and TermIAu removes
  // its chip from the bar. This page is the one that knows, so it is the one that says so —
  // on the first render too, when `repo` is still null.
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ termiauRepoOpen: repo?.root ?? null }, "*");
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
  const queueIndex = useRef<Promise<void>>(Promise.resolve());
  const inQueue = useRef(0);
  const queueError = useRef<string | null>(null);
  const setStaged = useCallback(
    (target: string, inside: boolean) => {
      if (!repo) return;
      inQueue.current++;
      queueIndex.current = queueIndex.current.then(async () => {
        try {
          await (inside ? stage : unstage)(repo.root, target);
          markInScreen.current = null;
        } catch (err) {
          queueError.current = String(err);
        }
        if (--inQueue.current > 0) return;
        await refresh(repo.root, target, scope);
        if (queueError.current) setError(queueError.current);
        queueError.current = null;
      });
    },
    [repo, target, scope, refresh],
  );

  /// The error propagates on purpose: the commit box shows it, beside the
  /// message the user just wrote and must not lose.
  const doCommit = useCallback(
    async (messageText: string) => {
      if (!repo) return;
      await commitIndex(repo.root, messageText);
      ourCommit.current = Date.now();
      markInScreen.current = null;
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
    if (!repo || !working || !visible) return;
    let alive = true;
    const bater = async () => {
      try {
        const marker = await workingStamp(repo.root);
        if (!alive) return;
        const previous = markInScreen.current;
        markInScreen.current = marker;
        // First tick (or right after one of our `git add`s): just record it.
        if (previous !== null && previous !== marker) doRefresh();
      } catch {
        // Repository unavailable (folder deleted, .git vanishing during a rebase): the
        // next tick tries again, and refresh does the explaining.
      }
    };
    void bater();
    // Two seconds: a tick costs a `git diff --raw` and an `ls-files`, which on a
    // large repository aren't free — and nobody edits a file and looks
    // at the tab in the same second.
    const clock = setInterval(bater, 2000);
    return () => {
      alive = false;
      clearInterval(clock);
    };
  }, [repo, working, visible, doRefresh]);

  // .git changed. A commit writes several files in there, and a fetch
  // writes many: without the wait, the same commit would open the dialog six times.
  useEffect(() => {
    if (!repo) return;
    let wait: ReturnType<typeof setTimeout>;
    const notify = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== repo.root) return;
      // The commit came from here: the screen already has it, there is nothing to report.
      if (Date.now() - ourCommit.current < 3000) return;
      clearTimeout(wait);
      wait = setTimeout(() => setChanged(true), 400);
    };
    window.addEventListener("termiau:changed", notify);
    return () => {
      clearTimeout(wait);
      window.removeEventListener("termiau:changed", notify);
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
  const groups: GroupFiles[] | null = useMemo(() => {
    if (!working) return null;
    const inside = files.filter((f) => f.staged === "staged" || f.staged === "partial");
    const outside = files.filter((f) => f.staged === "unstaged");
    return [
      {
        key: "index",
        title: T.inIndex,
        tree: buildTree(inside),
        stagesAll: false,
        empty: T.nothingStagedYet,
      },
      {
        key: "outside",
        title: T.outsideIndex,
        tree: buildTree(outside),
        stagesAll: true,
        empty: T.allStaged,
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

  /** A file chosen in the sidebar or through a note: its header at the top. */
  const selectFile = useCallback((path: string) => {
    const el = fileEls.current.get(path);
    if (el) el.scrollIntoView({ block: "start" });
    cursor.current = path;
    setActivePath(path);
    scrollLock.current = false;
  }, []);

  /** Goes to where the cursor is now — which may no longer be where it was when the trip started. */
  const reachCursor = useCallback(() => {
    clearTimeout(jumpTimer.current);
    unlock.current?.();
    unlock.current = undefined;
    jumpFrom.current = null;
    const target = jumpTarget.current;
    jumpTarget.current = null;
    const scroller = scrollerRef.current;
    if (target && scroller) {
      const id = ++scrollAnim.current;
      land(scroller, () => fileEls.current.get(target), () => id !== scrollAnim.current);
    }
    // Arrived: "v" works again, and the scroll moves the cursor again.
    scrollLock.current = false;
  }, []);

  /**
   * Three steps. Marks the destination; holds the scroll still, with the closing file's
   * header at the top, while its body closes; and only once it has closed scrolls to the
   * destination's header. Measuring the next file with the previous one still shrinking
   * misses the target — the rest of the collapse pulls everything up. The clock is the
   * safety net for when the collapse doesn't notify; with nothing closing, it goes right away.
   */
  const scheduleScroll = useCallback(
    (destination: string, closing: string | null) => {
      jumpTarget.current = destination;
      jumpFrom.current = closing;
      scrollLock.current = true;
      clearTimeout(jumpTimer.current);
      // Whatever was still holding the previous file at the top lets go: left running, it
      // would pull the scroll back to it during this close.
      ++scrollAnim.current;
      unlock.current?.();
      unlock.current = undefined;
      const scroller = scrollerRef.current;
      const section = closing ? fileEls.current.get(closing) : undefined;
      if (scroller && section) {
        // The header of the one closing at the top first, then nothing moves until it closes.
        const d = distanceFromTop(scroller, section);
        if (d < 0) scroller.scrollTop += d;
        unlock.current = lockScroll(scroller);
      }
      jumpTimer.current = setTimeout(reachCursor, closing ? COLLAPSE_MS + STEP_PAUSE_MS : 0);
    },
    [reachCursor],
  );

  const handleCollapseEnd = useCallback(
    (file: FileDiff) => {
      if (jumpFrom.current !== file.path) return;
      jumpFrom.current = null;
      // A short beat between "closed" and "moving on" so each step reads on its own.
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(reachCursor, STEP_PAUSE_MS);
    },
    [reachCursor],
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
    markedOnes.current = new Set();
  }, [viewedPaths]);

  /**
   * Marks or unmarks a file. Once reviewed, the cursor moves to the next one still to
   * review and the scroll takes that one's top to the top of the screen. Until it gets
   * there, "v" does nothing (see the key handler): the next one can't be marked unseen. Whether
   * from "v" or from the header's checkbox: left where it was, the scroll would show
   * whatever slid up under it, which in a long diff is its middle.
   */
  const setSeen = useCallback(
    (file: FileDiff, value: boolean) => {
      // The screen's state plus what this burst already marked and it doesn't show yet.
      const seen = markedOnes.current.size
        ? new Set([...viewedPaths, ...markedOnes.current])
        : viewedPaths;
      // Unviewed files are open unless the user closed them or they're generated.
      const alreadyClosed = collapsedOverrides[fileKey(file)] ?? isGenerated(file.path);
      markViewed(file, value);
      if (!value) {
        markedOnes.current.delete(file.path);
        return;
      }
      markedOnes.current.add(file.path);
      const next = nextToReview(files, file.path, seen);
      if (!next) return;
      // The cursor is the list's, not the scroll's: the next one to review, wherever
      // it is on screen.
      cursor.current = next.path;
      setActivePath(next.path);
      scheduleScroll(next.path, alreadyClosed ? null : file.path);
    },
    [files, viewedPaths, collapsedOverrides, markViewed, scheduleScroll],
  );

  // "V" toggles the current file.
  const toggleCurrentViewed = useCallback(() => {
    const current = cursor.current ?? currentPath;
    const file = files.find((f) => f.path === current);
    if (!file) return;
    const seen = markedOnes.current.size ? new Set([...viewedPaths, ...markedOnes.current]) : viewedPaths;
    setSeen(file, !seen.has(file.path));
  }, [files, currentPath, viewedPaths, setSeen]);

  /** Is everything within this target already in the index? It decides whether the key stages or unstages. */
  const allStaged = useCallback(
    (target: string) => {
      const inside = files.filter(
        (f) => target === "." || f.path === target || f.path.startsWith(`${target}/`),
      );
      return inside.length > 0 && inside.every((f) => f.staged === "staged");
    },
    [files],
  );

  /**
   * The three index keys, all toggling: the cursor's file, its
   * folder and the whole repository. Toggling instead of only staging is what spares a
   * second key for each of the three.
   */
  const toggleIndex = useCallback(
    (target: string) => void setStaged(target, !allStaged(target)),
    [setStaged, allStaged],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const keyOf = e.key.toLowerCase();
      if (keyOf === "v") {
        e.preventDefault();
        // Only the file already on screen can be marked. Held down, the key repeats and
        // would mark the next ones unseen; pressed again during the trip, it would mark
        // the destination before it arrives — and both skip a file you never looked at.
        if (e.repeat || scrollLock.current) return;
        toggleCurrentViewed();
        return;
      }
      // The index only exists in the to-be-committed tab.
      if (!working) return;
      const current = files.find((f) => f.path === (cursor.current ?? currentPath));
      if (keyOf === "s" && current) {
        e.preventDefault();
        // ⇧S goes up one step: the file's folder — the root is the whole repository.
        const folder = current.path.split("/").slice(0, -1).join("/");
        toggleIndex(e.shiftKey ? folder || "." : current.path);
      }
      if (keyOf === "a") {
        e.preventDefault();
        toggleIndex(".");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCurrentViewed, working, files, currentPath, toggleIndex]);

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
      {changed && (
        <Changed
          onReload={() => {
            setChanged(false);
            doRefresh();
          }}
          onDismiss={() => setChanged(false)}
          visible={visible}
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
          <button className="icon-btn" title={T.close} onClick={() => setError(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {!repo ? null : (
        <div className="workspace">
          <Sidebar
            tree={tree}
            groups={groups}
            files={files}
            viewedPaths={viewedPaths}
            activePath={currentPath}
            bookmarks={bookmarks}
            outdated={outdated}
            placements={placements}
            referenceOf={referenceOf}
            staging={working}
            inIndex={files.filter((f) => f.staged === "staged" || f.staged === "partial").length}
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
                      <Snippets from={T.summaryWorking(diff.branch ?? "HEAD")} />
                    </span>
                  ) : sinceBase ? (
                    <span>
                      <Snippets from={T.summaryIncremental(diff.branch ?? "HEAD", sinceBase.slice(0, 7))} />
                    </span>
                  ) : (
                    <span>
                      <Snippets from={T.summaryBranch(diff.branch ?? "HEAD", diff.target)} />
                      {incremental && T.noCompleteReview}
                    </span>
                  )}
                  {sinceBase && <ResolvedCount bookmarks={bookmarks} placements={placements} />}
                  {working ? (
                    <span className="sha" title={`head ${diff.headSha}\n${T.newSideIsDisk}`}>
                      {diff.headSha.slice(0, 7)}…{T.disk}
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
                  <h2>{T.nothingNew}</h2>
                  <p>
                    <Snippets from={T.nothingNewText(diff.branch ?? "HEAD", sinceBase.slice(0, 7))} />
                  </p>
                </div>
              )}
              {diff && files.length === 0 && working && (
                <div className="empty-diff">
                  <h2>{T.nothingForCommit}</h2>
                  <p>
                    <Snippets from={T.nothingForCommitText(diff.branch ?? "HEAD")} />
                  </p>
                </div>
              )}
              {diff && files.length === 0 && !sinceBase && !working && (
                <div className="empty-diff">
                  <h2>{T.nothingForReview}</h2>
                  <p>
                    <Snippets from={T.nothingForReviewText(diff.branch ?? "HEAD", diff.target)} />
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
                      onSetViewed={setSeen}
                      onAddBookmark={addBookmark}
                      onUpdateBookmark={updateBookmark}
                      onRemoveBookmark={removeBookmark}
                      onToggleResolved={toggleResolved}
                    />
                  );
                })}
              {!diff && loading && <div className="loading-state">{T.loadingDiff}</div>}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
