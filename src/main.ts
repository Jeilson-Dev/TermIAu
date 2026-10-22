import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ourShortcut, type Shortcut } from "./shortcuts";
import { start } from "./startup";
import { T } from "./i18n/terminal";
import { language } from "./i18n";
import { configsOf, playList, taskBefore, tasksOf, type ConfigLaunch, type Task } from "./run/launch";
import { commandLine, runnerFor, type Plan } from "./run/runners";
import { quote, word } from "./run/shell";
import type { DifferService, Disposable, MenuItem, Panel, PanelStatus } from "./plugins/api";
import { createPluginHost } from "./plugins/host";
import { CLOSE_DIALOG_ICON, footerButton, marquee } from "./ui";
import { escape, markdown, markOnLine } from "./markdown";
import {
  findReferences,
  isImage,
  isMarkdown,
  isSvg,
  hasRendered,
  logicalLine,
  referenceWhole,
  type ScreenLine,
  type Reference,
} from "./viewer";
import { blockProgress, planProgress, type TaskPlan } from "./progress";
import { loadSettings, onSettings, type Settings } from "./differ/lib/persist";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

// Webview console -> process stderr, otherwise JS errors vanish.
// The HTML `lang` is fixed; the right one is the system's (see src/i18n).
document.documentElement.lang = language();

const jlog = (m: string) => invoke("js_log", { msg: m });
window.addEventListener("error", (e) => jlog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => jlog(`REJECT ${e.reason}`));

const appWindow = getCurrentWindow();
const bar = document.getElementById("tabs") as HTMLDivElement;
const panel = document.getElementById("panes") as HTMLDivElement;

const TERM_OPTIONS = {
  // Same as iTerm2: p10k runs on nerdfont-complete and needs its glyphs,
  // which SF Mono/Menlo don't have — without this the prompt turns into boxes.
  fontFamily: '"MesloLGS NF", Menlo, monospace',
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  // Option composes characters, it doesn't become Meta: that is what makes ⌥C give "ç" and ⌥E+E give
  // "é". With Meta on, xterm sent ESC+c to the shell and the letter vanished.
  // What is lost is ⌥+letter as a readline shortcut (⌥F, ⌥B, ⌥.) — but the
  // keys that matter still work: xterm itself sends ESC b / ESC f on
  // ⌥← and ⌥→, and ESC DEL on ⌥⌫, because they are low-code keys and don't go
  // through the composition path.
  macOptionIsMeta: false,
  scrollback: 10_000,
  // OSC 8 links (Claude Code writes its own this way), with the same rule
  // as the ones the addon finds in the text.
  linkHandler: { activate: (e: MouseEvent, uri: string) => openLink(e, uri) },
  // Dracula, from the official spec (https://draculatheme.withTask/spec) and the ANSI palette
  // its terminals use. Without the 16 ANSI colors the theme would be half done: the
  // background would be Dracula and `ls` would keep coming out in xterm's default colors.
  theme: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
} as const;

/// How a split divides the space: "side" puts panels side by side
/// (vertical border), "below" stacks them (horizontal border).
type Axis = "side" | "below";

/// A panel: a terminal and its PTY. It is always a leaf of the tab's tree.
type Leaf = {
  kind: "leaf";
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  turnOff: UnlistenFn[];
  title: string;
  /// Last grid already reported to the kernel — avoids repeated SIGWINCH for the same size.
  lastOne: { rows: number; cols: number };
  parent?: Split;
  /// The node keeps pointing to its parents after being torn out, so walking up the tree
  /// doesn't tell a dead panel from a live one. This flag does.
  dead?: boolean;
  /// The tree's panels have a bar: title, play, stop, diff.
  bar?: Bar;
  /// The terminal of the app this panel's play button runs.
  drawer?: Drawer;
  /// In a drawer terminal: the panel that owns it.
  owner?: Leaf;
  /// The app this panel's play button launched, in its drawer.
  execution?: Run;
  /// The file shown in the panel, over the terminal and the plugins' layers. It exists
  /// after the first `termiau view` or ⌘-click on a reference.
  viewer?: Viewer;
  /// The file explorer, a drawer over the panel. It exists after the first time it opens.
  explorer?: Explorer;
  /// The plan of the long task Claude is doing here, as it published it with
  /// `termiau progress`. It shows in the footer, beside the usage.
  progress?: TaskPlan;
  /// The plugins that turned the panel's alert border on (`Panel.setAlert`).
  alerts?: Set<string>;
  /// Each plugin's status for the panel (`Panel.setStatus`): what the tab's dot, the
  /// waiting outline, the Dock badge and ⌘⇧A read.
  statuses?: Map<string, PanelStatus>;
  /// Each plugin's layer over the terminal (`Panel.layer`), and the element of it that
  /// gets the keyboard while it is on screen (`Panel.setKeyboard`).
  layers?: Map<string, HTMLElement>;
  keyboards?: Map<string, HTMLElement>;
  /// Each plugin's pane beside the terminal (`Panel.side`).
  sides?: Map<string, HTMLElement>;
  /// What each plugin wants back when the panel reopens (`Panel.setSaved`).
  saved?: Record<string, string>;
  /// Each plugin's title for the panel (`Panel.setTitle`): the session running in it,
  /// shown in place of the terminal's title.
  titles?: Map<string, string>;
};

/// What the panel is called: the title a plugin gave it (the last one set), or else the
/// terminal's.
function titleOf(leaf: Leaf): string {
  return [...(leaf.titles?.values() ?? [])].pop() ?? leaf.title;
}

/// A split: two children and the share that goes to the first. Nesting these nodes
/// gives the layouts iTerm2 makes — splitting an already split panel.
type Split = {
  kind: "split";
  axis: Axis;
  fraction: number;
  children: [TreeNode, TreeNode];
  el: HTMLDivElement;
  parent?: Split;
};

type TreeNode = Leaf | Split;

type Tab = {
  body: HTMLDivElement;
  chip: HTMLDivElement;
  /// The chip's text (see `showTicker`); scrolls inside when it doesn't fit.
  label: HTMLSpanElement;
  labelText: HTMLSpanElement;
  /// The text the label is showing, to only restart the scroll when it changes.
  shown?: string;
  /// The name given with a double click. Above everything: while there is one, it is
  /// what the tab says.
  name?: string;
  root: TreeNode;
  /// The panel that gets the keyboard; its title is what the tab shows.
  focus: Leaf;
  /// The panel taking the whole tab, with the others hidden for a while.
  /// They stay alive in the tree — restoring brings the layout back as it was.
  maximized?: Leaf;
};

/// The terminal of the app a panel's play button runs: inside the panel, below its
/// terminal, outside the split tree — and hideable. See `createDrawer`.
type Drawer = {
  leaf: Leaf;
  el: HTMLDivElement;
  open: boolean;
};

const tabs: Tab[] = [];
let active: Tab | undefined;
/// A shortcut repeated quickly would fire two concurrent `createLeaf`s, and both
/// would touch the same tree at the same time.
let busy = false;

/// The pinned tab: the differ, the branch's diff against the target branch. It lives outside the
/// `tabs` array on purpose — it has no PTY, doesn't split, doesn't close and doesn't leave
/// first place. Inside the array, every function that sweeps panels today would
/// have to ask first whether that tab has any; outside it, none needs to know
/// it exists.
type Pinned = {
  body: HTMLDivElement;
  chip: HTMLDivElement;
  frame: HTMLIFrameElement;
  /// The differ has mounted and is listening for messages.
  ready: boolean;
  /// Messages given before that. The first click almost always arrives before the
  /// page exists — it only loads when the tab is opened for the first time.
  queue: unknown[];
  /// There is a repository open in there. The differ itself says so, since it
  /// knows whether opening worked: sending a panel's cwd doesn't guarantee that the
  /// folder is a repository.
  repoOpen: boolean;
};
let pinned: Pinned | undefined;
/// The root of the repository open in the diff, as the differ reports it. It is how
/// that project's panels light up the diff button: the diff is of a
/// repository, not a panel, and two panels may belong to the same one.
let diffRepo: string | null = null;
/// True while the pinned tab is the one on screen. `active` keeps
/// pointing to the terminal we came from — that is where we go back.
let inDiff = false;

// ---------- tree ----------

function* leaves(no: TreeNode): Generator<Leaf> {
  if (no.kind === "leaf") yield no;
  else for (const f of no.children) yield* leaves(f);
}

/// Walks up to the root and finds out whose it is. Avoids storing the tab in every
/// leaf, which would create an annoying cycle to set up when creating the first one.
function tabOf(no: TreeNode): Tab | undefined {
  // A drawer's terminal isn't in the tree: its tab is the owner's.
  if (no.kind === "leaf" && no.owner) return tabOf(no.owner);
  let root = no;
  while (root.parent) root = root.parent;
  return tabs.find((a) => a.root === root);
}

/// The panels on screen: the tree's, and the open drawers. Hidden,
/// a drawer keeps its last size, like a hidden tab (see `activate`).
function* visibleOnes(tab: Tab): Generator<Leaf> {
  // Maximized, only it is on screen. The hidden ones keep the grid they had,
  // like a hidden tab: no measuring, no SIGWINCH to zero.
  for (const f of tab.maximized ? [tab.maximized] : leaves(tab.root)) {
    // The drawer before its owner: it is inside the owner's element, and whoever looks for
    // the panel under the pointer (`leafIn`) has to find it first.
    if (f.drawer?.open) yield f.drawer.leaf;
    yield f;
  }
}

/// Swaps one child for another, keeping the position — it is what preserves the order of
/// the grid tracks, which decides which panel goes on which side.
function switchChild(parent: Split, older: TreeNode, fresh: TreeNode) {
  parent.children[parent.children[0] === older ? 0 : 1] = fresh;
  fresh.parent = parent;
}

/// The grid has three tracks: first child, gap, second child. The gap's
/// thickness is style.css's `--gap` — the same measure that keeps the panel cards
/// apart from each other and from the window's edge.
function applyFraction(d: Split) {
  const tracks = `${d.fraction}fr var(--gap) ${1 - d.fraction}fr`;
  d.el.style.gridTemplate = d.axis === "side" ? `1fr / ${tracks}` : `${tracks} / 1fr`;
}

// ---------- measuring ----------

/// Redoes the grid of every visible panel in the tab from its size on screen.
/// Local drawing only: doesn't talk to the kernel.
function measure(tab: Tab) {
  for (const f of visibleOnes(tab)) f.fit.fit();
}

/// Tells the kernel the grids that actually changed, so the TUI redraws correctly.
function sync(tab: Tab) {
  for (const f of visibleOnes(tab)) {
    if (f.term.rows === f.lastOne.rows && f.term.cols === f.lastOne.cols) continue;
    f.lastOne = { rows: f.term.rows, cols: f.term.cols };
    invoke("pty_resize", { id: f.id, ...f.lastOne }).catch((e) => jlog(`pty_resize: ${e}`));
  }
}

let pendingItem: ReturnType<typeof setTimeout> | undefined;
/// A single SIGWINCH, when the drag stops. Without this the shell redraws the prompt
/// every frame (~45 times in a drag), which looks like a new shell.
function scheduleSync(tab: Tab) {
  clearTimeout(pendingItem);
  pendingItem = setTimeout(() => {
    // Re-measure before comparing: what counted during the drag was each
    // frame's layout, and the last one may have caught the window in the middle of an
    // animation. The settled layout is what rules.
    measure(tab);
    sync(tab);
  }, 80);
}

// ---------- focus ----------

function focusLeaf(leaf: Leaf) {
  const tab = tabOf(leaf);
  if (!tab) return;
  // Going to a hidden panel (⌘⇧A, one waiting for you) means wanting to see it:
  // the layout comes back first. The maximized panel's drawer is on screen, and stays.
  const owner = leaf.owner ?? leaf;
  if (tab.maximized && tab.maximized !== owner) collapse(tab);
  tab.focus.el.classList.remove("focused");
  tab.focus = leaf;
  leaf.el.classList.add("focused");
  keyboard(leaf);
  rotular(tab);
  // Looking at the panel may be attending to it: the plugin that asked for attention decides.
  for (const fn of focusListeners) fn(leaf.id);
  paint();
}

function rotular(tab: Tab) {
  showBranches(tab);
  const title = titleOf(tab.focus);
  if (tab === active && !inDiff) appWindow.setTitle(`${title} - TermIAu`).catch(() => {});
}

function activate(tab: Tab) {
  hidePinned();
  active = tab;
  for (const a of tabs) {
    const current = a === tab;
    a.body.hidden = !current;
    a.chip.classList.toggle("active", current);
  }
  // The tab was hidden (zero size) and may have missed window resizes
  // in the meantime: re-measure now, before giving focus back.
  measure(tab);
  sync(tab);
  // The label measured zero with the tab hidden: forgetting what it shows makes `rotular`
  // measure its scroll again.
  tab.shown = undefined;
  keyboard(tab.focus);
  rotular(tab);
  scheduleSave();
}

// ---------- creation ----------

/// Opens a shell and returns its panel. `insert` puts the element in its
/// final place BEFORE we measure: off screen the grid would come out zeroed, and it is
/// what goes into the spawn.
///
/// `withBar`: the tree's panels have their bar (title, play, diff); a
/// drawer's terminal doesn't — the owner's bar controls it.
async function createLeaf(
  cwd: string | null,
  insert: (el: HTMLDivElement) => void,
  withBar = true,
): Promise<Leaf | undefined> {
  const el = document.createElement("div");
  el.className = "leaf";
  const bar = withBar ? createBar() : undefined;
  // The terminal lives in an element of its own: the panel also carries the bar on top and,
  // when play runs something, the drawer below. Inside it, `leaf-screen` holds
  // the terminal and the plugins' layers; the split viewer sits beside it, not on top.
  const host = element("div", "leaf-term");
  const screen = element("div", "leaf-screen");
  host.append(screen);
  if (bar) el.append(bar.el);
  el.append(host);
  // Below the terminal and above the drawer: it says where this shell is, not the app's.
  if (bar) el.append(bar.footer);
  insert(el);

  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => openLink(e, uri)));
  term.attachCustomKeyEventHandler((e) => {
    // ⇧↩ inserts a newline instead of sending: xterm sends the same `\r` as Enter,
    // so it sends `ESC ↩`, which Claude reads as a new line (and zsh too).
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      if (e.type === "keydown") term.input("\x1b\r");
      return false;
    }
    return !ourShortcut(e);
  });
  term.open(screen);
  fit.fit();

  let id: number;
  try {
    id = await invoke<number>("pty_spawn", { rows: term.rows, cols: term.cols, cwd });
  } catch (e) {
    el.remove();
    term.dispose();
    jlog(`pty_spawn failed: ${e}`);
    return;
  }

  const leaf: Leaf = {
    kind: "leaf",
    id,
    term,
    fit,
    el,
    turnOff: [],
    title: "shell",
    lastOne: { rows: term.rows, cols: term.cols },
    bar,
  };

  // Clicking a panel sends the keyboard to it, no shortcut needed. The drawer
  // sits inside the panel, but a click on it is its own: it has its own focus.
  el.addEventListener("mousedown", (e) => {
    if (leaf.drawer?.el.contains(e.target as Node)) return;
    // With the split viewer, the keyboard stays on the side you clicked.
    if (leaf.viewer) leaf.viewer.withKeyboard = leaf.viewer.el.contains(e.target as Node);
    focusLeaf(leaf);
  });
  wireBar(leaf);
  wireFileLinks(leaf);

  // PTY -> screen. Rust sends base64 so as not to break UTF-8 in the middle of a chunk.
  leaf.turnOff.push(
    await listen<string>(`pty://data/${id}`, (e) => {
      const bin = atob(e.payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    }),
  );
  // The shell ended on its own — ⌃D, `exit`, crash: the panel goes with it.
  leaf.turnOff.push(
    await listen(`pty://exit/${id}`, () => closeLeaf(leaf, { alreadyDead: true })),
  );

  // Only now does Rust start pumping: an event emitted before this point
  // would have no one listening and the start of the prompt would be lost.
  await invoke("pty_attach", { id });

  // screen -> PTY. `onData` is user input: plugins write through `pty_write` directly
  // and don't pass here, so what you type is distinguishable from what a plugin writes.
  term.onData((data) => {
    // The terminal's own answers to the program aren't you touching the panel.
    if (!TERMINAL_ANSWER.test(data)) for (const listener of userInputListeners) listener(id, data);
    invoke("pty_write", { id, data }).catch((e) => jlog(`pty_write: ${e}`));
  });
  // The prompt (p10k, zsh) publishes the directory via OSC; it is the tab's title.
  term.onTitleChange((t) => {
    leaf.title = t || "shell";
    const tab = tabOf(leaf);
    if (tab?.focus === leaf) rotular(tab);
    // The bar shows the title, and a `cd` may have changed project.
    drawBar(leaf);
    scheduleProject(leaf);
  });

  drawBar(leaf);
  drawMaximize(leaf);
  scheduleProject(leaf);
  if (leaf.bar) {
    pluginPanels.set(leaf.id, leaf);
    for (const fn of panelOpened) fn(leaf.id);
  }
  return leaf;
}

/// xterm's `onData` doesn't only carry what you type: the terminal itself
/// answers the program through it — focus in or out, cursor position,
/// terminal attributes, the mouse, colors. None of that is you touching the panel.
/// Focus matters most: switching tabs sends an "I left", and without this filter
/// leaving a waiting panel would look like answering it.
const TERMINAL_ANSWER = /^\x1b(?:\[[IO]$|\[[?>=]?[\d;]*[Rcnty]$|\[<|\[M|[\]P_])/;

/// How long the ✕ stays armed waiting for the second click. Short on purpose:
/// it is a confirmation, not a mode — past that, the tab goes back to being a tab.
const CONFIRM_CLOSE = 1000;

/// How to disarm the tab that is armed now, if any. Two tabs in
/// red at the same time would say both are closing, and only one is: arming
/// one disarms the other.
let disarmClose: (() => void) | undefined;

/// `at`: the folder the tab opens in, for callers who already know it — a tab
/// coming back (see `reopen`). Without it, the focused panel's applies.
async function newTab(at?: string | null): Promise<Tab | undefined> {
  if (busy) return;
  busy = true;
  try {
    // A new tab opens where the focused panel is, like in other terminals. Rust
    // falls back to HOME on its own if it can't find out (deleted folder, for example).
    const cwd =
      at !== undefined ? at : active ? await invoke<string | null>("pty_cwd", { id: active.focus.id }) : null;

    const body = document.createElement("div");
    body.className = "tab-body";
    panel.appendChild(body);
    // Measure in the final place: with the previous tab still visible, the two
    // would split the area and the grid would come out at half height.
    hidePinned();
    if (active) active.body.hidden = true;

    const leaf = await createLeaf(cwd, (el) => body.appendChild(el));
    if (!leaf) {
      // No shell, no tab: undo and give the screen back to whatever was open.
      body.remove();
      if (active) active.body.hidden = false;
      return;
    }

    const chip = document.createElement("div");
    chip.className = "tab";
    // The panel's status dot; stays transparent while no plugin set one.
    const sinal = document.createElement("span");
    sinal.className = "tab-dot";
    const label = element("span", "tab-title");
    const labelText = element("span", "tab-title-text");
    labelText.textContent = leaf.title;
    label.append(labelText);
    const close = document.createElement("span");
    close.className = "tab-close";
    // The "+" of the new tab, turned: the same stroke and size, where the "✕" glyph came out small.
    close.innerHTML = ICON_CLOSE_TAB;
    chip.append(sinal, label, close);
    bar.appendChild(chip);

    const tab: Tab = { body, chip, label, labelText, root: leaf, focus: leaf };
    leaf.el.classList.add("focused");

    // Closing a tab has no undo: the shell dies with it, and with it whatever was
    // running there. That is why ✕ asks twice — the first click only lights the
    // red ring, the notice that it is THIS tab going away, and the
    // second, within CONFIRM_CLOSE, is what closes it. Without the second, the ring
    // fades on its own and nothing happened.
    let wait: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      if (wait === undefined) return;
      clearTimeout(wait);
      wait = undefined;
      chip.classList.remove("armada");
      if (disarmClose === disarm) disarmClose = undefined;
    };

    chip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // ✕ closes the whole tab; on the rest of the chip, it only activates.
      if (e.target === close) {
        // Second click within the window: that is what they really wanted.
        if (wait !== undefined) {
          disarm();
          closeTab(tab);
          return;
        }
        disarmClose?.();
        chip.classList.add("armada");
        wait = setTimeout(disarm, CONFIRM_CLOSE);
        disarmClose = disarm;
      } else {
        // Clicked the chip, not ✕: changed their mind about closing.
        disarm();
        activate(tab);
      }
    });
    chip.addEventListener("dblclick", (e) => {
      if (e.target !== close) renameTab(tab);
    });
    // Middle button closes, like in the browser. It is a gesture nobody makes by
    // accident, so this one skips the confirmation.
    chip.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      disarm();
      closeTab(tab);
    });

    tabs.push(tab);
    wireDragging(tab);
    syncBar();
    activate(tab);
    return tab;
  } finally {
    busy = false;
  }
}

function syncBar() {
  // With the pinned tab in the bar there are always two chips, so it no longer
  // hides. That was the price of the diff always being one click away.
  bar.hidden = !pinned && tabs.length < 2;
}

// ---------- reordenar abas ----------

/// How far the pointer must move for the intent to become a drag. Without this
/// slack, a click with a shaky hand would reorder the bar unasked.
const DRAG_THRESHOLD = 4;

/// Dragging a chip along the bar moves the tab — and the array order is the
/// same one ⌘1..⌘9 and ⌘⇧[ use, so moving here moves it everywhere.
///
/// The chip follows the pointer via `transform`, which doesn't touch the layout: while
/// dragging, the neighbors stay where they were and serve as a ruler. The swap
/// happens as soon as the chip's center passes a neighbor's center, so the
/// bar reorders during the drag, not only on release.
function wireDragging(tab: Tab) {
  const chip = tab.chip;

  chip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // ✕ is a button, not a handle: whoever presses there wants to close, not move.
    if ((e.target as HTMLElement).classList.contains("tab-close")) return;

    // Point from which the offset is counted. It changes on every swap, because the chip
    // gets a new position in the layout and the `transform` must be discounted
    // from it so the chip doesn't jump on screen.
    let source = e.clientX;
    let dragging = false;

    const mover = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - source) < DRAG_THRESHOLD || tabs.length < 2) return;
        dragging = true;
        chip.classList.add("dragging");
      }
      chip.style.transform = `translateX(${ev.clientX - source}px)`;

      // Only the two neighbors matter: to reach the third you have to pass
      // the second, and by then the swap with it has already happened.
      const i = tabs.indexOf(tab);
      const center = meio(chip);
      let target: Tab | undefined;
      if (tabs[i - 1] && center < meio(tabs[i - 1].chip)) target = tabs[i - 1];
      else if (tabs[i + 1] && center > meio(tabs[i + 1].chip)) target = tabs[i + 1];
      if (!target) return;

      const before = chip.getBoundingClientRect().left;
      const j = tabs.indexOf(target);
      tabs[i] = target;
      tabs[j] = tab;
      bar.insertBefore(chip, j < i ? target.chip : target.chip.nextSibling);
      // Both measurements carry the same `transform`, so the difference between
      // them is only how much the layout moved — which is what the origin absorbs.
      source += chip.getBoundingClientRect().left - before;
      chip.style.transform = `translateX(${ev.clientX - source}px)`;
    };

    const release = () => {
      window.removeEventListener("pointermove", mover);
      chip.classList.remove("dragging");
      chip.style.transform = "";
      // The bar's order is the order in which the tabs come back.
      scheduleSave();
    };

    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", release, { once: true });
    window.addEventListener("pointercancel", release, { once: true });
  });
}

/// The chip's horizontal center as it is on screen — with the drag's `transform`
/// included, which is exactly what `getBoundingClientRect` returns.
function meio(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

// ---------- aba pinned: o diff ----------

/// The chip's icon. The pinned tab shows no text: it is always in the bar, and
/// a 180px chip reading "Diff" would compete for space with the name of what
/// you are running — which is the information that changes.
const ICON_DIFF = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>`;

/// Builds the pinned tab. Called before the first terminal tab: that is how its
/// chip ends up as the bar's first child, out of reach of any drag —
/// `wireDragging` only reorders what is in the `tabs` array, and it isn't there.
///
/// The differ goes in an <iframe>, not mounted here in the document: its CSS is
/// global (it touches `body`, `button`, the scrollbar) and its shortcuts
/// are single keys. In a separate document, none of that reaches the terminal —
/// and Tauri's IPC crosses over because the origin is the same (see ponte.ts).
function createPinned() {
  const body = document.createElement("div");
  body.className = "tab-body";
  body.hidden = true;
  const frame = document.createElement("iframe");
  frame.className = "frame";
  frame.src = "/differ.html";
  // The iframe goes inside a frame, not loose in the tab: the card's rounded
  // corner doesn't clip an iframe's content in WebKit — what clips is a plain
  // element with `overflow:hidden` around it.
  const outline = element("div", "outline");
  outline.appendChild(frame);
  body.appendChild(outline);
  panel.appendChild(body);

  const chip = document.createElement("div");
  chip.className = "tab pinned";
  chip.title = T.branchDiff;
  chip.innerHTML = ICON_DIFF;
  bar.appendChild(chip);
  chip.addEventListener("mousedown", (e) => {
    if (e.button === 0) openPinned();
  });

  pinned = { body, chip, frame, ready: false, queue: [], repoOpen: false };
  enablePinned(null);
}

/// Lights up or dims the diff chip. A tab that can only show a blank screen
/// doesn't open: while there is no repository, the chip stays dimmed and clicking
/// it does nothing.
function enablePinned(root: string | null) {
  if (!pinned) return;
  pinned.repoOpen = !!root;
  diffRepo = root;
  pinned.chip.classList.toggle("disabled", !root);
  // Lit in the same color as the diff button of the panel the repository came from: the
  // two icons lit at the same time are what links one place to the other.
  pinned.chip.classList.toggle("on", !!root);
  const name = root?.split("/").filter(Boolean).pop();
  pinned.chip.title = root
    ? T.diffOf(name ?? T.repository)
    : T.noRepository;
  // Each panel's diff button says whether that project is the one in there,
  // and what is in there just changed.
  for (const a of tabs) for (const f of leaves(a.root)) drawBar(f);
}

/// The panel is in the repository the diff shows. It compares the two roots, not the
/// folder against the root: a panel inside a submodule is in another
/// repository, even though it is inside this one's folder.
function inDiffRepo(b: Bar): boolean {
  return !!diffRepo && b.repo === diffRepo;
}

/// Talks to the differ page, storing the message if it hasn't loaded yet.
function flash(msg: unknown) {
  if (!pinned) return;
  if (pinned.ready) pinned.frame.contentWindow?.postMessage(msg, "*");
  else pinned.queue.push(msg);
}

/// What plugins offer the diff tab (`ctx.differ`): services it calls by name, topics
/// whose last value it is told, and scripts it loads into its page (by plugin) — again
/// whenever it asks, after a reload.
const differServices = new Map<string, DifferService>();
const differTopics = new Map<string, unknown>();
const differExtensions = new Map<string, string>();

function announceExtensions() {
  flash({ termiauExtensions: [...differExtensions].map(([id, main]) => ({ id, main })) });
}

function publishTopics() {
  announceExtensions();
  for (const [topic, value] of differTopics) flash({ termiauTopic: { topic, value } });
}

/// A call from the diff tab, answered by the plugin that serves it.
async function differCall({ id, name, args }: { id: string; name: string; args?: Record<string, unknown> }) {
  const handler = differServices.get(name);
  try {
    if (!handler) throw new Error(T.serviceUnavailable);
    const value = await handler(args ?? {});
    flash({ termiauReply: { id, value } });
  } catch (e) {
    flash({ termiauReply: { id, error: e instanceof Error ? e.message : String(e) } });
  }
}

/// Takes the panel's repository to the diff tab and brings it to the front.
async function openDiff(leaf: Leaf) {
  // Forced: this click is what will give it a repository.
  openPinned(true);
  const cwd = await invoke<string | null>("pty_cwd", { id: leaf.id }).catch(() => null);
  if (cwd) flash({ termiauRepo: cwd });
}

/// ⌘, — the preferences float over whatever tab is on screen. They are the differ's page
/// on its own (`differ.html?prefs`), in an iframe over the whole window: their CSS is
/// the differ's, and loose in this document it would reach the terminal (see `createPinned`).
/// The page says when it is drawn (`termiauPrefsReady`) and closes itself by message
/// (`termiauPrefsClosed`).
let prefsFrame: HTMLIFrameElement | undefined;

function openPreferences() {
  if (prefsFrame) return prefsFrame.contentWindow?.focus();
  const q = document.createElement("iframe");
  q.className = "prefs-frame";
  q.src = "/differ.html?prefs";
  document.body.append(q);
  prefsFrame = q;
}

function closePreferences() {
  prefsFrame?.remove();
  prefsFrame = undefined;
  // The keyboard goes back where it was — a panel, or the diff tab.
  if (inDiff) pinned?.frame.contentWindow?.focus();
  else if (active?.focus) focusLeaf(active.focus);
}

function openPinned(force = false) {
  if (!pinned || inDiff) return;
  // Dimmed: clicking the chip, ⌘` and the tab cycle pass through here and stop.
  if (!pinned.repoOpen && !force) return;
  if (active) {
    active.body.hidden = true;
    active.chip.classList.remove("active");
    // xterm only switches the cursor to the inactive style when focus is taken away; without
    // this the little paw would keep blinking behind the diff.
    active.focus.term.blur();
  }
  inDiff = true;
  // The tab only keeps up with the working tree while it is in view:
  // checking the disk every second behind a terminal would be wasted
  // work. This is where we know whether it is in view.
  flash({ termiauVisible: true });
  pinned.body.hidden = false;
  pinned.chip.classList.add("active");
  pinned.frame.focus();
  pinned.frame.contentWindow?.focus();
  appWindow.setTitle(T.titleDiff).catch(() => {});
}

/// Takes the pinned tab off screen. The caller is whoever will put a terminal in its place.
function hidePinned() {
  if (!pinned || !inDiff) return;
  inDiff = false;
  flash({ termiauVisible: false });
  pinned.body.hidden = true;
  pinned.chip.classList.remove("active");
}

// ---------- splitting ----------

function createDivisor(d: Split): HTMLDivElement {
  const divisor = document.createElement("div");
  divisor.className = `divisor ${d.axis}`;

  divisor.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // otherwise the drag becomes text selection in the terminals
    divisor.setPointerCapture(e.pointerId);

    const mover = (ev: PointerEvent) => {
      const r = d.el.getBoundingClientRect();
      const bruta =
        d.axis === "side" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      // A panel squeezed to zero has no grid to measure and xterm complains.
      d.fraction = Math.min(0.9, Math.max(0.1, bruta));
      applyFraction(d);

      const tab = tabOf(d);
      if (!tab) return;
      measure(tab); // the drawing follows the drag, frame by frame
      scheduleSync(tab);
    };
    const release = () => {
      divisor.removeEventListener("pointermove", mover);
      divisor.removeEventListener("pointerup", release);
      scheduleSave();
    };
    divisor.addEventListener("pointermove", mover);
    divisor.addEventListener("pointerup", release);
  });

  return divisor;
}

async function split(axis: Axis) {
  if (busy || inDiff || !active) return;
  busy = true;
  const tab = active;
  // Splitting changes the layout, and it must be in view for that.
  finishAnimation();
  if (tab.maximized) collapse(tab, false);
  const target = tab.focus;
  try {
    const cwd = await invoke<string | null>("pty_cwd", { id: target.id });
    const newOne = await splitLeaf(tab, target, axis, cwd);
    if (newOne) focusLeaf(newOne);
  } finally {
    busy = false;
  }
}

/// Cuts `target` in two and returns the new panel, which takes the second place.
/// Doesn't touch focus or `busy`: that is the caller's job — ⌘D, or a tab
/// coming back that rebuilds the layout split by split (see `build`). The tab must
/// be on screen: the new panel is measured in place.
async function splitLeaf(
  tab: Tab,
  target: Leaf,
  axis: Axis,
  cwd: string | null,
  fraction = 0.5,
): Promise<Leaf | undefined> {
  // Removing from the document an element containing the focused textarea steals focus
  // without firing `blur`. xterm would keep thinking it has the keyboard: the
  // `.xterm-focus` mark up and a cursor blinking in a panel that no longer gets keys.
  // While focus is still real, we tell it.
  target.term.blur();

  // The panel's place in the page is reserved before touching it: building the
  // split moves `target.el` into it and the original position would be lost.
  const marker = document.createComment("split");
  target.el.replaceWith(marker);

  const d: Split = {
    kind: "split",
    axis,
    fraction,
    children: [target, target], // the second is replaced as soon as the shell opens
    el: document.createElement("div"),
    parent: target.parent,
  };
  d.el.className = "split";
  applyFraction(d);
  d.el.append(target.el, createDivisor(d));
  marker.replaceWith(d.el);

  const newOne = await createLeaf(cwd, (el) => d.el.appendChild(el));
  if (!newOne) {
    // Undo the split and put the panel back — with the keyboard back on it.
    d.el.replaceWith(target.el);
    target.term.focus();
    return;
  }

  d.children = [target, newOne];
  target.parent = d;
  newOne.parent = d;
  if (d.parent) switchChild(d.parent, target, d);
  else tab.root = d;
  tab.body.classList.add("divided");
  markMaximized(tab);

  measure(tab);
  sync(tab);
  scheduleSave();
  return newOne;
}

// ---------- fechamento ----------

/// Releases the panel's resources. Doesn't touch the tree — the caller does that.
function destroyLeaf(leaf: Leaf, alreadyDead: boolean) {
  leaf.dead = true;
  // The drawer lives inside the panel: it goes along, and so does the app running in it.
  if (leaf.drawer) destroyLeaf(leaf.drawer.leaf, false);
  leaf.execution = undefined;
  clearInterval(leaf.viewer?.pulse);
  for (const off of leaf.turnOff) off();
  leaf.turnOff = [];
  if (!alreadyDead) invoke("pty_close", { id: leaf.id }).catch((e) => jlog(`pty_close: ${e}`));
  leaf.term.dispose();
  leaf.el.remove();
  // The panel's plan leaves the footer with it.
  if (leaf.progress) drawProgress();
  if (pluginPanels.delete(leaf.id)) for (const fn of panelClosed) fn(leaf.id);
}

function closeLeaf(leaf: Leaf, opts: { alreadyDead?: boolean } = {}) {
  if (leaf.dead) return; // the shell's exit may arrive after we already closed it
  const tab = tabOf(leaf);
  if (!tab) return;
  // The drawer has no parent, but it isn't the last panel either: close only it.
  if (leaf.owner) return closeDrawer(leaf.owner, opts.alreadyDead ?? false);
  // The tab's last panel: no layout is left, so the tab is what closes.
  if (!leaf.parent) return closeTab(tab);

  const parent = leaf.parent;
  const sibling = parent.children[parent.children[0] === leaf ? 1 : 0];
  // Before destroying: ⌘⇧T brings the panel back too, beside the one with the keyboard.
  storeClosed({ panel: snapshot(leaf) as Extract<SavedNode, { kind: "leaf" }>, axis: parent.axis, fraction: parent.fraction });
  // The animation walks the tree's splits, and the tree is about to change.
  finishAnimation();
  // Closed the maximized one: there is nothing left to keep full screen.
  if (tab.maximized === leaf) tab.maximized = undefined;
  destroyLeaf(leaf, opts.alreadyDead ?? false);

  // The sibling moves up and alone takes the space that was both's. It leaves the DOM along with
  // the parent, so the place is marked before tearing out the split.
  const marker = document.createComment("promocao");
  parent.el.replaceWith(marker);
  marker.replaceWith(sibling.el);

  sibling.parent = parent.parent;
  if (parent.parent) switchChild(parent.parent, parent, sibling);
  else tab.root = sibling;
  tab.body.classList.toggle("divided", tab.root.kind === "split");
  // A hidden one that closed on its own (an `exit`, the shell crashed) changed the tree
  // under the maximized one: the path to it is different now.
  markMaximized(tab);

  measure(tab);
  sync(tab);
  paint();
  // Focus was on the panel that died: it falls to the neighbor that took its place.
  if (tab.focus === leaf) focusLeaf(leaves(sibling).next().value as Leaf);
  // It survived, but the promotion moved its element in the DOM and the textarea lost
  // real focus — with no `blur`, xterm didn't even know. Refocus.
  else keyboard(tab.focus);
}

function closeTab(tab: Tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;

  // Before destroying: this snapshot is what ⌘⇧T brings the tab back from.
  storeClosed({ tab: snapshotTab(tab) });

  tabs.splice(i, 1);
  for (const f of leaves(tab.root)) destroyLeaf(f, false);
  tab.body.remove();
  tab.chip.remove();

  if (tabs.length === 0) {
    // Closing the last tab is quitting, and whoever closed it already said what they wanted: no
    // question. The session is saved empty — the next launch starts clean.
    void quit();
    return;
  }
  syncBar();
  paint();
  // Focus goes to the neighbor on the right; if it was the last, to the one on the left.
  if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
}

// ---------- maximize ----------

/// Marks in the DOM the path from the root to the maximized panel: it is what CSS uses
/// to hide the rest without removing anything from the tree. Redone on every change to it.
/// With a single panel there is nothing to hide, and the state undoes itself.
function markMaximized(tab: Tab) {
  if (tab.maximized && (tab.maximized.dead || tab.root.kind === "leaf")) {
    tab.maximized = undefined;
  }
  for (const el of tab.body.querySelectorAll(".path")) el.classList.remove("path");
  const m = tab.maximized;
  tab.body.classList.toggle("maximized", !!m);
  if (m) {
    let no: TreeNode | undefined = m;
    for (; no; no = no.parent) no.el.classList.add("path");
  }
  for (const f of leaves(tab.root)) drawMaximize(f);
}

/// Shorter than CSS's `--time`: that one is for signals lighting up and dimming;
/// this one is the whole layout moving, and it has to feel like a response to the click.
const MAXIMIZE_DURATION = 240;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/// The animation in progress, if any. Finishing means jumping to the last frame: whoever
/// touches the tree (split, close) or toggles again midway doesn't wait.
let animation: { finish: () => void } | undefined;

function finishAnimation() {
  animation?.finish();
}

/// One frame on the way to `m`, from 0 (the usual layout) to 1 (it alone).
/// Each split along the path hands the whole share to `m`'s side and the gap closes.
/// It is the grid that moves, not a `transform`: scaling the terminal would blur the text.
/// xterm's grid doesn't follow — whoever is squeezed gets clipped by the card,
/// and everyone is re-measured only once, at the end.
function frameMaximize(m: Leaf, t: number) {
  let child: TreeNode = m;
  for (let d = m.parent; d; child = d, d = d.parent) {
    const target = d.children[0] === child ? 1 : 0;
    const f = d.fraction + (target - d.fraction) * t;
    const tracks = `${f}fr calc(var(--gap) * ${1 - t}) ${1 - f}fr`;
    d.el.style.gridTemplate = d.axis === "side" ? `1fr / ${tracks}` : `${tracks} / 1fr`;
  }
}

function animateMaximize(m: Leaf, from: number, dest: number, end: () => void) {
  finishAnimation();
  const beginning = performance.now();
  let raf = 0;
  const thisOne = {
    finish() {
      if (animation !== thisOne) return;
      animation = undefined;
      cancelAnimationFrame(raf);
      // The grid goes back to the real fractions; with the panel maximized CSS
      // rules the layout, and they stay stored for when it restores.
      for (let d = m.parent; d; d = d.parent) applyFraction(d);
      end();
    },
  };
  animation = thisOne;
  if (reducedMotion.matches) return thisOne.finish();
  const frame = (now: number) => {
    const p = Math.min(1, (now - beginning) / MAXIMIZE_DURATION);
    // Leaves fast and lands slowly, like the rest of the app's animations.
    const e = 1 - Math.pow(1 - p, 3);
    frameMaximize(m, from + (dest - from) * e);
    if (p < 1) raf = requestAnimationFrame(frame);
    else thisOne.finish();
  };
  raf = requestAnimationFrame(frame);
}

function maximize(leaf: Leaf) {
  const tab = tabOf(leaf);
  if (!tab || tab.root.kind === "leaf") return;
  finishAnimation();
  tab.maximized = leaf;
  for (const f of leaves(tab.root)) drawMaximize(f);
  focusLeaf(leaf);
  // The others only vanish at the end: until then they are being squeezed, in view.
  animateMaximize(leaf, 0, 1, () => {
    markMaximized(tab);
    measure(tab);
    sync(tab);
  });
}

/// `animate: false` is for callers about to touch the tree right after (split):
/// the layout must be in place now, not a quarter of a second from now.
function collapse(tab: Tab, animate = true) {
  finishAnimation();
  const m = tab.maximized;
  if (!m) return;
  const goBack = () => {
    // The hidden ones come back with their previous grid; the window may have
    // changed size in the meantime.
    measure(tab);
    sync(tab);
    // The panel leaves full screen without `blur`: refocus the keyboard.
    tab.focus.term.focus();
  };
  tab.maximized = undefined;
  if (!animate) {
    markMaximized(tab);
    return goBack();
  }
  // The grid is set to the last frame BEFORE CSS releases the other panels:
  // removing the classes with the usual fractions on the grid would flash the whole layout.
  frameMaximize(m, 1);
  markMaximized(tab);
  animateMaximize(m, 1, 0, goBack);
}

function toggleMaximize(leaf: Leaf) {
  const tab = tabOf(leaf);
  if (!tab) return;
  if (tab.maximized) collapse(tab);
  else maximize(leaf);
}

// ---------- navigating between panels ----------

/// Nearest panel in the requested direction. On-screen geometry counts, not the
/// tree's shape: it is what makes ⌥→ go to the panel visibly to the right,
/// even if it is in another branch.
function neighbor(leaf: Leaf, dir: "Left" | "Right" | "Up" | "Down"): Leaf | undefined {
  const tab = tabOf(leaf);
  if (!tab) return;
  const r = leaf.el.getBoundingClientRect();
  const horizontal = dir === "Left" || dir === "Right";
  const sinal = dir === "Left" || dir === "Up" ? -1 : 1;

  // The current panel's center on the other axis. Among several panels at the same
  // distance — one above and three below —, it goes to the one most aligned with it,
  // which is the middle one. From there, the side ones are one step each.
  const center = (q: DOMRect) => (horizontal ? q.top + q.height / 2 : q.left + q.width / 2);
  const my = center(r);

  let best: Leaf | undefined;
  let smaller = Infinity;
  let offset = Infinity;
  for (const f of visibleOnes(tab)) {
    if (f === leaf) continue;
    const q = f.el.getBoundingClientRect();
    // Progress in the requested direction; negative means it is on the wrong side.
    const step = sinal * (horizontal ? q.left - r.left : q.top - r.top);
    if (step <= 0) continue;
    // It must overlap on the other axis, otherwise the panel in the opposite corner would win.
    const crosses = horizontal
      ? q.bottom > r.top && q.top < r.bottom
      : q.right > r.left && q.left < r.right;
    if (!crosses) continue;
    const d = Math.abs(center(q) - my);
    // The 2px slack absorbs the grid's rounding: panels in the same row
    // may start half a pixel apart.
    if (step < smaller - 2 || (Math.abs(step - smaller) <= 2 && d < offset)) {
      smaller = step;
      offset = d;
      best = f;
    }
  }
  return best;
}

function goToTab(delta: number) {
  // The pinned tab joins the ring like any other — it is first in the bar,
  // and ⌘⇧[ on the next tab must land on it. Dimmed, it stays out, unless
  // it is the one on screen: a panel's diff button opens it before the
  // repository loads, and the cycle must be able to leave from there.
  const inside = pinned && (pinned.repoOpen || inDiff);
  const ring: (Tab | Pinned)[] = inside ? [pinned as Pinned, ...tabs] : [...tabs];
  const i = inDiff ? 0 : active ? ring.indexOf(active) : -1;
  if (i < 0 || ring.length < 2) return;
  // Circular: from the last to the first, like in iTerm2.
  const target = ring[(i + delta + ring.length) % ring.length];
  if (target === pinned) openPinned();
  else activate(target as Tab);
}

// ---------- what the hooks report, and the panels' signals ----------

/// A message for a plugin, from something running in a panel (its hook, say). A
/// sender waiting for an answer carries the number Rust gave it. The app only passes
/// it on: the plugin is what makes sense of it.
type SocketMessage = { panel: number; plugin: string; message?: unknown; reply_id?: string };

function receive(raw: SocketMessage) {
  const listeners = socketListeners.get(raw.plugin);
  // The panel closed before the message arrived, or its plugin isn't on: nobody answers.
  if (!leafByPanel(raw.panel) || !listeners?.size) {
    if (raw.reply_id) void invoke("socket_drop", { id: raw.reply_id });
    return;
  }
  for (const fn of listeners) fn(raw.panel, raw.message, raw.reply_id);
}

function leafByPanel(id: number): Leaf | undefined {
  for (const a of tabs) for (const f of leaves(a.root)) if (f.id === id) return f;
  return undefined;
}

/// The strongest of the plugins' statuses for the panel.
function statusOf(leaf: Leaf): PanelStatus | undefined {
  const all = [...(leaf.statuses?.values() ?? [])];
  return all.includes("waiting") ? "waiting" : all.includes("working") ? "working" : undefined;
}

/// Redraws the status signals: a dot on each tab, an outline on the waiting
/// panel, and the Dock badge with how many are waiting — which is what shows with the whole
/// app in the background.
function paint() {
  let waiting = 0;
  for (const tab of tabs) {
    let sinal = "";
    for (const f of leaves(tab.root)) {
      const state = statusOf(f);
      f.el.classList.toggle("waiting", state === "waiting");
      if (state === "waiting") {
        waiting++;
        sinal = "waiting";
      } else if (state === "working" && sinal !== "waiting") {
        sinal = "working";
      }
    }
    tab.chip.dataset.status = sinal;
    // Opening or closing a panel changes how many folders the tab has.
    showBranches(tab);
  }
  appWindow.setBadgeCount(waiting || undefined).catch(() => {});
  // Everything that changes the tabs or the panels goes through here.
  scheduleSave();
}

/// Jumps to the next panel that is waiting, in any tab. Repeating the
/// shortcut goes through all of them, and doesn't get stuck on the first.
function goToWaiting() {
  const queue: { tab: Tab; leaf: Leaf }[] = [];
  for (const tab of tabs) {
    for (const f of leaves(tab.root)) {
      if (statusOf(f) === "waiting") queue.push({ tab, leaf: f });
    }
  }
  if (!queue.length) return;

  const current = queue.findIndex((x) => x.leaf === active?.focus);
  const target = queue[(current + 1) % queue.length];
  if (target.tab !== active) activate(target.tab);
  focusLeaf(target.leaf);
}

/// A copy button on each code block of rendered markdown — a .md in the viewer. It
/// copies the block as it is: the command ready to paste. In a frame around the block,
/// not inside it: the block scrolls sideways, and the button would go along.
function copyButtons(el: HTMLElement) {
  for (const pre of el.querySelectorAll<HTMLPreElement>("pre:not(.mermaid)")) {
    const outline = element("div", "code-block");
    const b = element("button", "copy-code");
    const goBack = () => {
      b.innerHTML = ICON_COPY;
      b.title = T.copyCode;
      b.classList.remove("copied");
    };
    goBack();
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard
        .writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "")
        .then(() => {
          b.innerHTML = ICON_COPIED;
          b.title = T.codeCopied;
          b.classList.add("copied");
          setTimeout(goBack, 1500);
        })
        .catch((err) => jlog(`copy: ${err}`));
    });
    pre.replaceWith(outline);
    outline.append(pre, b);
  }
}

/// The blinking of the waiting signals, from Preferences: off, they stay lit and still.
async function wirePreferences() {
  try {
    const apply = ({ blinkOnAttention }: Settings) =>
      document.documentElement.classList.toggle("no-blink", !blinkOnAttention);
    apply(await loadSettings());
    await onSettings(apply);
  } catch (e) {
    jlog(`preferences: ${e}`);
  }
}

/// Who gets the panel's keyboard: the explorer, the viewer, a plugin's layer on
/// screen (the Claude chat's field), or the terminal.
function keyboard(leaf: Leaf) {
  const v = leaf.viewer;
  if (leaf.explorer?.isOpen && !leaf.explorer.fixed) return leaf.explorer.tree.focus({ preventScroll: true });
  if (v?.isOpen && (layoutViewer === "over" || v.withKeyboard)) return (v.edit?.area ?? v.body).focus({ preventScroll: true });
  const plugin = layerKeyboard(leaf);
  if (plugin) plugin.focus({ preventScroll: true });
  else leaf.term.focus();
}

/// The keyboard target of a plugin layer or pane that is on screen, if any.
function layerKeyboard(leaf: Leaf): HTMLElement | undefined {
  for (const [owner, target] of leaf.keyboards ?? []) {
    if (leaf.layers?.get(owner)?.hidden === false || leaf.sides?.get(owner)?.hidden === false) return target;
  }
}

/// ⌘ or ⌃ click opens the link in the browser; a plain click is left for
/// selecting and positioning, like in iTerm.
function openLink(e: MouseEvent, url: string) {
  if (!e.metaKey && !e.ctrlKey) return;
  invoke("open_link", { url }).catch((err) => jlog(`open link: ${err}`));
}

/// Shorter than maximize's: it is a layer appearing, not the layout moving.
const LAYER_DURATION = 180;

/// A layer comes in or goes out over the terminal (the viewer): fades with a slight
/// slide. On the way out it only vanishes at the end, and meanwhile it doesn't hold
/// clicks — the terminal below is already the panel.
function transitionLayer(layer: { el: HTMLElement; isOpen: boolean; transition?: Animation }) {
  const { el, isOpen } = layer;
  const meio = layer.transition?.playState === "running" ? layer.transition.currentTime : null;
  layer.transition?.cancel();
  layer.transition = undefined;
  el.style.pointerEvents = isOpen ? "" : "none";
  if (isOpen) el.hidden = false;
  if (reducedMotion.matches) {
    el.hidden = !isOpen;
    return;
  }
  const frames = [
    { opacity: 0, transform: "translateY(8px)" },
    { opacity: 1, transform: "none" },
  ];
  const t = el.animate(isOpen ? frames : frames.reverse(), {
    duration: LAYER_DURATION,
    easing: isOpen ? "cubic-bezier(0.2, 0.7, 0.3, 1)" : "ease-in",
  });
  // Turning around midway starts from the mirrored point, without a jump.
  if (typeof meio === "number") t.currentTime = Math.max(0, LAYER_DURATION - meio);
  layer.transition = t;
  t.onfinish = () => {
    if (layer.transition !== t) return;
    layer.transition = undefined;
    if (!layer.isOpen) el.hidden = true;
  };
}

// ---------- the viewer: a file inside the panel ----------

/// What to show: a file, the line (or range) to mark and, with `ref`, its
/// version at that point in git instead of the one on disk.
type ViewRequest = { path: string; line?: number; to?: number; ref?: string };

/// What arrives through the socket when someone runs `termiau view` (see hooks/termiau).
type SocketViewRequest = {
  panel: number;
  view: { path?: string; line?: number | null; to?: number | null; ref?: string | null };
};

/// The file beside the terminal (or the chat), or over it: the terminal
/// stays alive, with Claude running, and the bar button shows and hides the
/// file. How it is arranged in the panel is `layoutViewer`.
type Viewer = {
  el: HTMLDivElement;
  /// The border between the file and the terminal, which can be dragged. Split mode only.
  handle: HTMLDivElement;
  body: HTMLDivElement;
  path: HTMLSpanElement;
  ref: HTMLSpanElement;
  goBack: HTMLButtonElement;
  advance: HTMLButtonElement;
  mode: HTMLButtonElement;
  layout: HTMLButtonElement;
  /// Reading or editing: the eye and the pencil, side by side, the current one lit.
  modes: HTMLDivElement;
  read: HTMLButtonElement;
  editButton: HTMLButtonElement;
  save: HTMLButtonElement;
  close: HTMLButtonElement;
  /// Edit mode. Meanwhile nothing redraws the viewer.
  edit?: Edit;
  isOpen: boolean;
  transition?: Animation;
  /// In split mode, who has the keyboard: the file or the terminal/chat. It is the
  /// side you clicked last.
  withKeyboard: boolean;
  /// Where you left the scroll. It isn't read from `scrollTop` at redraw time:
  /// caught in the middle of a write, the file arrives short (or empty), the scroll
  /// shrinks along, and the next reread would go back to the top.
  scrollPos: number;
  /// The scroll events the redraw itself causes aren't you scrolling.
  holding: number;
  /// The files open in this panel, one tab each, and the one on screen. ‹ and › move
  /// between them too.
  history: ViewRequest[];
  pos: number;
  /// What each tab not on screen had when it was left — its lines, its scroll, its
  /// edit in progress. The one on screen lives in the fields below.
  states: Map<ViewRequest, TabState>;
  /// The tab strip, between the header and the body.
  tabs: HTMLDivElement;
  /// A .md shown rendered, not as source.
  rendered: boolean;
  /// The shown file's stamp: changed on disk, the viewer rereads it.
  stamp?: string;
  lines?: string[];
  /// A binary image (`isImage`), as a data URL. Then there are no `lines`.
  image?: string;
  /// Leaving the edit to a rendered .md: how far down it was, as a fraction — the
  /// rendered page has another height, and pixels wouldn't land on the same place.
  fraction?: number;
  pulse?: ReturnType<typeof setInterval>;
  /// Responses arriving out of order (‹ › pressed quickly) don't draw
  /// over the newest one.
  turn: number;
};

/// A tab that is not on screen, as it was left.
type TabState = {
  lines?: string[];
  image?: string;
  stamp?: string;
  edit?: Edit;
  rendered: boolean;
  scrollPos: number;
};

/// How many tabs the viewer keeps open. Past that, the oldest one without unsaved
/// changes closes.
const VIEWER_HISTORY = 30;
/// How often the open viewer checks whether the file changed on disk.
const VIEWER_MS = 1000;

/// How the viewer is arranged in the panel: beside the terminal, above it, or
/// over it, covering it. Applies to all panels, and so does the (viewer's) share.
type Layout = "side" | "below" | "over";
const LAYOUTS: Layout[] = ["side", "below", "over"];
const LAYOUT_LABEL: Record<Layout, string> = {
  side: T.layoutSide,
  below: T.layoutBelow,
  over: T.layoutOver,
};
const VIEWER_KEY = "termiau:viewer";

let { layout: layoutViewer, share: shareViewer } = readPrefViewer();

function readPrefViewer(): { layout: Layout; share: number } {
  try {
    const savedItem = JSON.parse(localStorage.getItem(VIEWER_KEY) ?? "{}") as {
      layout?: Layout;
      share?: number;
    };
    return {
      layout: savedItem.layout && LAYOUTS.includes(savedItem.layout) ? savedItem.layout : "side",
      share: typeof savedItem.share === "number" ? Math.min(0.85, Math.max(0.15, savedItem.share)) : 0.5,
    };
  } catch {
    return { layout: "side", share: 0.5 };
  }
}

function rememberPrefViewer() {
  try {
    localStorage.setItem(VIEWER_KEY, JSON.stringify({ layout: layoutViewer, share: shareViewer }));
  } catch {
    // Just a convenience.
  }
}

function receiveView(raw: SocketViewRequest) {
  const leaf = leafByPanel(raw.panel);
  const { path, line, to, ref } = raw.view ?? {};
  if (!leaf || typeof path !== "string" || !path.startsWith("/")) return;
  openFile(leaf, {
    path: path,
    line: typeof line === "number" && line > 0 ? line : undefined,
    to: typeof to === "number" && to > 0 ? to : undefined,
    ref: typeof ref === "string" && ref ? ref : undefined,
  });
}

/// Shows the file in the panel's viewer, opening it if it was closed. In a
/// drawer terminal, the owner panel shows it.
function openFile(leaf: Leaf, request: ViewRequest) {
  const owner = leaf.owner ?? leaf;
  if (owner.dead) return;
  const v = (owner.viewer ??= createViewer(owner));
  // Already open: its tab comes to the front, as it was left. A requested line moves it
  // there — in a rendered .md, to the block that line became.
  const i = v.history.findIndex((p) => p.path === request.path && p.ref === request.ref);
  if (i >= 0) {
    const already = v.history[i];
    if (request.line) {
      already.line = request.line;
      already.to = request.to;
    }
    let stored = true;
    if (i !== v.pos) {
      storeTab(v);
      stored = activateTab(v, i);
    }
    if (!v.isOpen) toggleViewer(owner, !!request.line || !stored);
    else showTab(owner, !!request.line || !stored);
    return;
  }
  // A new tab, right after the one on screen.
  if (v.history.length) storeTab(v);
  v.history.splice(v.pos + 1, 0, request);
  v.pos = Math.min(v.pos + 1, v.history.length - 1);
  v.lines = v.image = v.stamp = v.edit = undefined;
  v.scrollPos = 0;
  v.rendered = hasRendered(request.path);
  pruneTabs(v);
  if (v.isOpen) void loadViewer(owner, true);
  else toggleViewer(owner, true);
}

/// The tab on screen, kept as it is: lines, scroll, the edit in progress (with its box,
/// out of the page but alive, undo included).
function storeTab(v: Viewer) {
  const p = v.history[v.pos];
  if (!p) return;
  const ed = v.edit;
  if (ed) ed.scrollPos = [ed.area.scrollLeft, ed.area.scrollTop];
  v.states.set(p, {
    lines: v.lines,
    image: v.image,
    stamp: v.stamp,
    edit: ed,
    rendered: v.rendered,
    scrollPos: v.scrollPos,
  });
}

/// Puts tab `i` on the viewer's fields, without drawing. False when it had never been
/// shown (there is nothing kept, it has to be read).
function activateTab(v: Viewer, i: number): boolean {
  v.pos = i;
  v.turn++;
  const p = v.history[i];
  const e = v.states.get(p);
  v.states.delete(p);
  v.lines = e?.lines;
  v.image = e?.image;
  v.stamp = e?.stamp;
  v.edit = e?.edit;
  v.rendered = e?.rendered ?? hasRendered(p.path);
  v.scrollPos = e?.scrollPos ?? 0;
  return !!e;
}

/// Draws the tab on screen: an edit in progress goes back as it was; the rest is reread
/// from disk, which may have changed meanwhile.
function showTab(leaf: Leaf, scroll: boolean) {
  const v = leaf.viewer;
  const ed = v?.edit;
  if (!v) return;
  if (!ed) return void loadViewer(leaf, scroll);
  viewerCaption(leaf);
  v.body.replaceChildren(ed.root);
  const [x, y] = ed.scrollPos ?? [0, 0];
  ed.area.scrollLeft = x;
  ed.area.scrollTop = y;
  ed.area.dispatchEvent(new Event("scroll"));
  ed.area.focus({ preventScroll: true });
}

function switchTab(leaf: Leaf, i: number) {
  const v = leaf.viewer;
  if (!v || i < 0 || i >= v.history.length || i === v.pos) return;
  storeTab(v);
  const stored = activateTab(v, i);
  showTab(leaf, !stored);
}

/// Closes a file's tab. With unsaved changes it comes to the front and asks first.
async function closeFile(leaf: Leaf, i: number) {
  const v = leaf.viewer;
  if (!v || i < 0 || i >= v.history.length) return;
  if (i !== v.pos) switchTab(leaf, i);
  if (!(await canDropEdit(leaf))) return;
  if (v.edit) clearTimeout(v.edit.wait);
  v.edit = undefined;
  // The last one: the viewer closes, and is born empty the next time.
  if (v.history.length === 1) {
    if (v.isOpen) toggleViewer(leaf);
    v.history = [];
    v.pos = 0;
    v.lines = v.image = v.stamp = undefined;
    drawBar(leaf);
    return;
  }
  v.history.splice(i, 1);
  const stored = activateTab(v, Math.min(i, v.history.length - 1));
  showTab(leaf, !stored);
}

/// Loose, the drawer is a passing thing: a click outside it closes it, like a menu.
/// Pinned it is part of the panel, and stays. The folder button on the bar doesn't count
/// as outside — it closes it by itself, and counting it would reopen it right away.
function watchOutside(leaf: Leaf) {
  const ex = leaf.explorer;
  if (!ex) return;
  const watch = ex.isOpen && !ex.fixed;
  if (watch && !ex.outside) {
    ex.outside = (e) => {
      const target = e.target as Node;
      if (ex.el.contains(target) || leaf.bar?.explore.contains(target)) return;
      toggleExplorer(leaf);
    };
    document.addEventListener("mousedown", ex.outside, true);
  } else if (!watch && ex.outside) {
    document.removeEventListener("mousedown", ex.outside, true);
    ex.outside = undefined;
  }
}

/// Past the limit, the oldest tabs without unsaved changes close.
function pruneTabs(v: Viewer) {
  while (v.history.length > VIEWER_HISTORY) {
    const j = v.history.findIndex((p, k) => {
      const ed = v.states.get(p)?.edit;
      return k !== v.pos && !(ed && ed.area.value !== ed.savedItem);
    });
    if (j < 0) return;
    v.states.delete(v.history[j]);
    v.history.splice(j, 1);
    if (j < v.pos) v.pos--;
  }
}

/// The tabs, the one on screen lit. One with unsaved changes shows a dot in place of ✕
/// (the ✕ comes back under the mouse).
function drawTabsViewer(v: Viewer) {
  v.tabs.replaceChildren(
    ...v.history.map((p, i) => {
      const ed = i === v.pos ? v.edit : v.states.get(p)?.edit;
      const tab = element("div", "viewer-tab");
      tab.dataset.i = String(i);
      tab.classList.toggle("current", i === v.pos);
      tab.classList.toggle("dirty", !!ed && ed.area.value !== ed.savedItem);
      tab.title = p.ref ? `${p.path} @ ${p.ref}` : p.path;
      const name = element("span", "viewer-tab-name");
      name.textContent = p.path.slice(p.path.lastIndexOf("/") + 1);
      tab.append(name);
      if (p.ref) {
        const ref = element("span", "viewer-tab-ref");
        ref.textContent = p.ref;
        tab.append(ref);
      }
      const close = element("span", "viewer-tab-close");
      close.innerHTML = ICON_CLOSE_TAB;
      close.title = T.closeFile;
      tab.append(close);
      return tab;
    }),
  );
  v.tabs.querySelector(".current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- the file explorer ----------

type Input = { name: string; folder: boolean };

type Explorer = {
  el: HTMLDivElement;
  title: HTMLSpanElement;
  tree: HTMLDivElement;
  isOpen: boolean;
  /// The project's folder (the repository's root, or the shell's folder).
  root: string;
  /// The folders expanded in the tree, which stay so between openings.
  openOnes: Set<string>;
  /// Each folder's listing, read once per opening: reopening shows what changed.
  lists: Map<string, Input[]>;
  /// Responses arriving out of order don't draw over the newest tree.
  turn: number;
  /// Pinned: it stops floating and takes the panel's left side, and choosing a file
  /// doesn't close it.
  fixed: boolean;
  pin: HTMLButtonElement;
  /// Open and loose, a click anywhere else closes it: the listener for that, while it exists.
  outside?: (e: MouseEvent) => void;
};

/// A drawer from the left, over the terminal, the plugins' layers and the viewer — it pushes nothing
/// aside. Choosing a file opens it in the viewer and closes the drawer.
function createExplorer(leaf: Leaf): Explorer {
  const el = element("div", "explorer");
  const head = element("div", "explorer-head");
  const title = element("span", "explorer-title");
  const close = element("button", "viewer-btn viewer-btn-icon");
  close.innerHTML = ICON_CLOSE;
  close.title = T.closeExplorer;
  close.addEventListener("mousedown", (e) => e.preventDefault());
  close.addEventListener("click", () => toggleExplorer(leaf));
  const pin = element("button", "viewer-btn viewer-btn-icon explorer-pin");
  pin.innerHTML = ICON_PIN;
  pin.title = T.pinExplorer;
  pin.addEventListener("mousedown", (e) => e.preventDefault());
  pin.addEventListener("click", () => pinExplorer(leaf, !ex.fixed));
  head.append(title, pin, close);
  const tree = element("div", "explorer-tree");
  tree.tabIndex = 0;
  el.append(head, tree);
  leaf.el.querySelector(".leaf-term")?.append(el);
  const ex: Explorer = {
    el,
    title,
    tree,
    isOpen: false,
    root: "",
    openOnes: new Set(),
    lists: new Map(),
    turn: 0,
    fixed: false,
    pin,
  };
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Pinned, esc only gives the keyboard back: the tree stays.
    if (ex.fixed) keyboard(leaf);
    else toggleExplorer(leaf);
  });
  wireExplorerDrag(tree);
  tree.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".explorer-item");
    const path = item?.dataset.path;
    if (!item || !path) return;
    if (item.dataset.folder) {
      if (!ex.openOnes.delete(path)) ex.openOnes.add(path);
      void drawExplorer(leaf);
      return;
    }
    if (!ex.fixed) toggleExplorer(leaf);
    openFile(leaf, { path });
    // Pinned, the tree stays on screen: the chosen file is the one that lights up now.
    if (ex.fixed) void drawExplorer(leaf);
  });
  return ex;
}

/// Dragging a file or folder out of the tree drops its path on a panel — in its chat's
/// field or on its terminal's line, like a drag from Finder. Followed by hand, with
/// pointer events: Tauri keeps the window's native drags for itself, and the page's own
/// HTML5 drag-and-drop doesn't come through.
function wireExplorerDrag(tree: HTMLElement) {
  tree.addEventListener("pointerdown", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".explorer-item");
    const path = item?.dataset.path;
    if (!item || !path || e.button !== 0) return;
    const [x0, y0] = [e.clientX, e.clientY];
    let ghost: HTMLElement | undefined;
    const target = (ev: PointerEvent) => {
      // Over the explorer itself there is nowhere to drop.
      const sob = document.elementFromPoint(ev.clientX, ev.clientY);
      return sob?.closest(".explorer") ? undefined : leafAtPoint(ev.clientX, ev.clientY);
    };
    const mover = (ev: PointerEvent) => {
      if (!ghost) {
        // A few pixels before it counts as a drag: a click stays a click.
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        ghost = element("div", "drag-ghost");
        ghost.textContent = path.slice(path.lastIndexOf("/") + 1);
        document.body.append(ghost);
        document.body.classList.add("dragging");
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
      markReceiving(target(ev));
    };
    const release = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("dragging");
      markReceiving(undefined);
      // The click that follows the release is not a choice in the tree.
      tree.addEventListener("click", (c) => c.stopImmediatePropagation(), { capture: true, once: true });
      const leaf = ev.type === "pointerup" ? target(ev) : undefined;
      if (leaf) releasePaths(leaf, [path]);
    };
    // On the window, not with pointer capture: captured, the click that follows goes to
    // the tree instead of the item, and a plain click no longer opens anything.
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  });
}

/// Pinned, the drawer becomes part of the panel: the terminal and the viewer step aside
/// for it (`.explorer-fixed`, padding on the side) instead of being covered.
function pinExplorer(leaf: Leaf, fixed: boolean) {
  const ex = leaf.explorer;
  if (!ex) return;
  ex.fixed = fixed;
  ex.el.classList.toggle("docked", fixed);
  ex.pin.classList.toggle("on", fixed);
  ex.pin.title = fixed ? T.releaseExplorer : T.pinExplorer;
  fitExplorer(leaf);
}

function fitExplorer(leaf: Leaf) {
  watchOutside(leaf);
  const ex = leaf.explorer;
  const termHost = leaf.el.querySelector(".leaf-term");
  const fixed = !!ex?.fixed && ex.isOpen;
  if (!termHost || termHost.classList.contains("explorer-docked") === fixed) return;
  termHost.classList.toggle("explorer-docked", fixed);
  // The terminal changed width without the window changing: it is measured again here.
  const tab = tabOf(leaf);
  if (tab && tab === active && !inDiff) {
    measure(tab);
    scheduleSync(tab);
  }
}

function toggleExplorer(leaf: Leaf) {
  const root = leaf.bar?.repo ?? leaf.bar?.folder;
  const newOne = !leaf.explorer;
  const ex = (leaf.explorer ??= createExplorer(leaf));
  // Just created, the drawer has never been drawn closed: without a layout first, the
  // browser goes straight to open and there is no slide.
  if (newOne) void ex.el.offsetWidth;
  ex.isOpen = !ex.isOpen && !!root;
  ex.el.classList.toggle("opened", ex.isOpen);
  fitExplorer(leaf);
  if (ex.isOpen && root) {
    if (ex.root !== root) {
      ex.root = root;
      ex.openOnes.clear();
    }
    ex.lists.clear();
    ex.title.textContent = root.slice(root.lastIndexOf("/") + 1) || root;
    ex.title.title = root;
    void drawExplorer(leaf);
    ex.tree.focus({ preventScroll: true });
  } else if (tabOf(leaf)?.focus === leaf) {
    keyboard(leaf);
  }
  drawBar(leaf);
}

/// The little mark before the name, by extension: as in an editor's tree, it is what
/// lets you find the file by eye.
const EXPLORER_MARKS: Record<string, [string, string]> = {
  ts: ["TS", "cyan"],
  tsx: ["TS", "cyan"],
  js: ["JS", "yellow"],
  jsx: ["JS", "yellow"],
  mjs: ["JS", "yellow"],
  json: ["{}", "yellow"],
  html: ["<>", "orange"],
  css: ["#", "purple"],
  md: ["M↓", "cyan"],
  rs: ["RS", "orange"],
  sh: ["$", "green"],
  py: ["PY", "yellow"],
  dart: ["D", "cyan"],
  toml: ["⚙", "comment"],
  yaml: ["⚙", "comment"],
  yml: ["⚙", "comment"],
  png: ["▣", "pink"],
  jpg: ["▣", "pink"],
  jpeg: ["▣", "pink"],
  gif: ["▣", "pink"],
  svg: ["▣", "pink"],
};

async function drawExplorer(leaf: Leaf) {
  const ex = leaf.explorer;
  if (!ex) return;
  const turn = ++ex.turn;
  const current = leaf.viewer?.history[leaf.viewer.pos]?.path;
  const lines: HTMLElement[] = [];
  const notice = (text: string, level: number) => {
    const el = element("div", "explorer-notice");
    el.style.paddingLeft = `${22 + level * 12}px`;
    el.textContent = text;
    lines.push(el);
  };
  const goDown = async (folder: string, level: number) => {
    let items = ex.lists.get(folder);
    if (!items) {
      try {
        items = await invoke<Input[]>("folder_list", { path: folder });
      } catch (e) {
        notice(T.couldNotList(String(e)), level);
        return;
      }
      ex.lists.set(folder, items);
    }
    if (!items.length) notice(T.emptyFolder, level);
    for (const it of items) {
      const path = `${folder}/${it.name}`;
      const open = it.folder && ex.openOnes.has(path);
      const line = element("div", "explorer-item");
      line.dataset.path = path;
      if (it.folder) line.dataset.folder = "1";
      line.style.paddingLeft = `${8 + level * 12}px`;
      line.classList.toggle("open", open);
      line.classList.toggle("current", path === current);
      const marker = element("span", "explorer-mark");
      if (it.folder) marker.textContent = "›";
      else {
        const ext = it.name.slice(it.name.lastIndexOf(".") + 1).toLowerCase();
        const [text, color] = EXPLORER_MARKS[ext] ?? ["≡", "fg-dim"];
        marker.textContent = text;
        marker.style.color = `var(--${color})`;
      }
      const name = element("span", "explorer-name");
      name.textContent = it.name;
      line.append(marker, name);
      lines.push(line);
      if (open) await goDown(path, level + 1);
    }
  };
  await goDown(ex.root, 0);
  if (turn === ex.turn) ex.tree.replaceChildren(...lines);
}

/// Shows or hides the viewer. Hiding and showing again goes back to where you
/// were; `scroll` is for a newly requested file, which opens at the top (or at the line).
function toggleViewer(leaf: Leaf, scroll = false) {
  const v = leaf.viewer;
  if (!v?.history.length) return;
  v.isOpen = !v.isOpen;
  // When opening split, the keyboard stays where it was: in a plugin's layer, in the terminal.
  if (v.isOpen) v.withKeyboard = false;
  if (layoutViewer === "over") transitionLayer(v);
  else {
    // Split, the terminal changes size along with it: no animation, which would get it
    // measured midway.
    v.transition?.cancel();
    v.transition = undefined;
    v.el.style.pointerEvents = "";
    v.el.hidden = !v.isOpen;
  }
  tidyViewer(leaf);
  clearInterval(v.pulse);
  v.pulse = undefined;
  if (v.isOpen) {
    void loadViewer(leaf, scroll);
    v.pulse = setInterval(() => void checkViewer(leaf), VIEWER_MS);
  }
  drawBar(leaf);
  if (tabOf(leaf)?.focus === leaf) keyboard(leaf);
}

/// Puts the viewer in its arrangement's place: shares the terminal's space with it, or
/// leaves it on top. The terminal that changed size is measured again.
function tidyViewer(leaf: Leaf) {
  const v = leaf.viewer;
  const host = v?.el.parentElement;
  if (!v || !host) return;
  const divided = v.isOpen && layoutViewer !== "over";
  const before = host.className;
  host.classList.toggle("viewer-side", divided && layoutViewer === "side");
  host.classList.toggle("viewer-below", divided && layoutViewer === "below");
  host.style.setProperty("--viewer-share", `${(shareViewer * 100).toFixed(2)}%`);
  v.layout.innerHTML = ICON_LAYOUT[layoutViewer];
  v.layout.title = T.clickToSwitch(LAYOUT_LABEL[layoutViewer]);
  if (host.className === before) return;
  const tab = tabOf(leaf);
  if (tab && tab === active && !inDiff) {
    measure(tab);
    scheduleSync(tab);
  }
}

/// Dragging the border changes how much of the panel is the file's; double click, half and half.
function wireViewerHandle(leaf: Leaf, v: Viewer) {
  const host = () => v.el.parentElement;
  const apply = (share: number) => {
    shareViewer = Math.min(0.85, Math.max(0.15, share));
    host()?.style.setProperty("--viewer-share", `${(shareViewer * 100).toFixed(2)}%`);
    const tab = tabOf(leaf);
    if (!tab) return;
    measure(tab);
    scheduleSync(tab);
  };
  v.handle.addEventListener("pointerdown", (e) => {
    const h = host();
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    v.handle.setPointerCapture(e.pointerId);
    v.handle.classList.add("dragging");
    const mover = (ev: PointerEvent) => {
      const r = h.getBoundingClientRect();
      apply(layoutViewer === "side" ? (r.right - ev.clientX) / r.width : (ev.clientY - r.top) / r.height);
    };
    const release = () => {
      v.handle.removeEventListener("pointermove", mover);
      v.handle.removeEventListener("pointerup", release);
      v.handle.removeEventListener("pointercancel", release);
      v.handle.classList.remove("dragging");
      rememberPrefViewer();
    };
    v.handle.addEventListener("pointermove", mover);
    v.handle.addEventListener("pointerup", release);
    v.handle.addEventListener("pointercancel", release);
  });
  v.handle.addEventListener("dblclick", () => {
    apply(0.5);
    rememberPrefViewer();
  });
}

function createViewer(leaf: Leaf): Viewer {
  const el = element("div", "viewer");
  el.hidden = true;
  const head = element("div", "viewer-head");
  const goBack = element("button", "viewer-btn");
  goBack.textContent = "‹";
  goBack.title = T.previousFile;
  const advance = element("button", "viewer-btn");
  advance.textContent = "›";
  advance.title = T.nextFile;
  const path = element("span", "viewer-path");
  const ref = element("span", "viewer-ref");
  const mode = element("button", "viewer-btn viewer-btn-text");
  const layout = element("button", "viewer-btn viewer-btn-icon");
  const read = element("button", "viewer-btn viewer-btn-icon");
  read.innerHTML = ICON_EYE;
  read.title = T.readHint;
  const editButton = element("button", "viewer-btn viewer-btn-icon");
  editButton.innerHTML = ICON_PENCIL;
  editButton.title = T.editHint;
  const modes = element("div", "viewer-modes");
  modes.append(read, editButton);
  const save = element("button", "viewer-btn viewer-btn-icon viewer-btn-save");
  save.innerHTML = ICON_FLOPPY;
  save.title = T.saveHint;
  save.hidden = true;
  const editor = element("button", "viewer-btn viewer-btn-text");
  editor.textContent = T.openInEditor;
  editor.title = T.editorInPreferences;
  const copy = element("button", "viewer-btn viewer-btn-icon");
  const copyBack = () => {
    copy.innerHTML = ICON_COPY;
    copy.title = T.copyPath;
    copy.classList.remove("copied");
  };
  copyBack();
  const finder = element("button", "viewer-btn viewer-btn-icon");
  finder.innerHTML = ICON_FOLDER;
  finder.title = T.showInFinder;
  const close = element("button", "viewer-btn viewer-btn-icon");
  close.innerHTML = ICON_CLOSE;
  close.title = T.backToTerminal;
  head.append(goBack, advance, path, ref, mode, layout, save, modes, copy, finder, editor, close);
  const tabs = element("div", "viewer-tabs");
  const body = element("div", "viewer-body");
  body.tabIndex = 0;
  el.append(head, tabs, body);
  const handle = element("div", "viewer-handle");
  // Inside the terminal's element, beside its screen: split, the viewer
  // takes a share of it; on top, it covers it entirely.
  leaf.el.querySelector(".leaf-term")?.append(handle, el);

  const v: Viewer = {
    el,
    handle,
    body,
    path,
    ref,
    goBack,
    advance,
    mode,
    layout,
    modes,
    read,
    editButton,
    save,
    close,
    isOpen: false,
    withKeyboard: false,
    scrollPos: 0,
    holding: 0,
    history: [],
    pos: 0,
    states: new Map(),
    tabs,
    rendered: false,
    turn: 0,
  };
  wireViewerHandle(leaf, v);
  body.addEventListener("scroll", () => {
    if (!v.holding) v.scrollPos = body.scrollTop;
  });
  // The buttons don't take the keyboard from the body: esc keeps closing.
  for (const b of [goBack, advance, mode, layout, read, editButton, save, copy, finder, editor, close]) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
  }
  layout.addEventListener("click", () => {
    layoutViewer = LAYOUTS[(LAYOUTS.indexOf(layoutViewer) + 1) % LAYOUTS.length];
    rememberPrefViewer();
    v.transition?.cancel();
    v.transition = undefined;
    tidyViewer(leaf);
    if (tabOf(leaf)?.focus === leaf) keyboard(leaf);
  });
  goBack.addEventListener("click", () => switchTab(leaf, v.pos - 1));
  advance.addEventListener("click", () => switchTab(leaf, v.pos + 1));
  // A click on a tab shows it; on its ✕, or with the middle button, it closes.
  tabs.addEventListener("mousedown", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".viewer-tab");
    if (!tab || e.button !== 0) return;
    e.preventDefault();
    const i = Number(tab.dataset.i);
    if ((e.target as HTMLElement).closest(".viewer-tab-close")) void closeFile(leaf, i);
    else switchTab(leaf, i);
  });
  tabs.addEventListener("auxclick", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".viewer-tab");
    if (tab && e.button === 1) void closeFile(leaf, Number(tab.dataset.i));
  });
  mode.addEventListener("click", () => {
    v.rendered = !v.rendered;
    drawViewer(leaf, true);
  });
  editor.addEventListener("click", () => {
    const p = v.history[v.pos];
    void (async () => {
      const command = (await loadSettings().catch(() => undefined))?.editor.trim() || null;
      await invoke("open_in_editor", { path: p.path, line: p.line ?? null, command: command });
    })().catch((e) => notify(leaf, T.editorError(String(e))));
  });
  // The absolute path, as the header's tooltip shows it: ready to paste anywhere.
  copy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(v.history[v.pos].path)
      .then(() => {
        copy.innerHTML = ICON_COPIED;
        copy.title = T.copiedPath;
        copy.classList.add("copied");
        setTimeout(copyBack, 1500);
      })
      .catch((err) => jlog(`copy: ${err}`));
  });
  finder.addEventListener("click", () => {
    invoke("reveal_in_finder", { path: v.history[v.pos].path }).catch((e) => notify(leaf, T.finderError(String(e))));
  });
  read.addEventListener("click", () => void leaveEdit(leaf));
  editButton.addEventListener("click", () => enterEdit(leaf));
  save.addEventListener("click", () => void saveEdit(leaf));
  close.addEventListener("click", () => (v.edit ? void leaveEdit(leaf) : toggleViewer(leaf)));
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    toggleViewer(leaf);
  });
  body.addEventListener("click", (e) => {
    if (referenceClick(leaf, e, folderOf(v.history[v.pos].path))) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    openLink(e, a.href);
  });
  body.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.matches("input.task[data-line]")) return;
    if (box.checked) {
      box.classList.add("just-marked");
      box.addEventListener("animationend", () => box.classList.remove("just-marked"), { once: true });
    }
    void markTask(leaf, box);
  });
  return v;
}

/// A checkbox clicked in a rendered .md: `[ ]` ↔ `[x]` on that line of the file, on
/// disk. The line changes in `v.lines` before Rust answers, so a second quick click
/// already starts from it.
async function markTask(leaf: Leaf, box: HTMLInputElement) {
  const v = leaf.viewer;
  const lines = v?.lines;
  const n = Number(box.dataset.line);
  const before = lines?.[n];
  if (!v || !lines || before === undefined) return;
  const column = box.dataset.column === undefined ? undefined : Number(box.dataset.column);
  const after = markOnLine(before, box.checked, column);
  lines[n] = after;
  try {
    v.stamp = await invoke<string>("file_replace_line", { path: v.history[v.pos].path, line: n, before: before, after: after });
  } catch (e) {
    lines[n] = before;
    box.checked = !box.checked;
    notify(leaf, T.couldNotMark(String(e)));
  }
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/// The path as read on the bar: from the panel's folder, or with `~`.
function shortPath(leaf: Leaf, path: string): string {
  const base = leaf.bar?.repo ?? leaf.bar?.folder;
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return withTilde(path);
}

/// The path with the home folder as `~`.
function withTilde(path: string): string {
  const home = path.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

/// The header follows the tab on screen: its path (with the line), its ref, its buttons.
function viewerCaption(leaf: Leaf) {
  const v = leaf.viewer;
  const p = v?.history[v.pos];
  if (!v || !p) return;
  v.path.textContent = shortPath(leaf, p.path) + (p.line ? `:${p.line}${p.to ? `-${p.to}` : ""}` : "");
  v.path.title = p.path;
  v.ref.textContent = p.ref ?? "";
  v.ref.hidden = !p.ref;
  buttonsViewer(v);
}

async function loadViewer(leaf: Leaf, scroll: boolean) {
  const v = leaf.viewer;
  if (!v || v.edit) return;
  const p = v.history[v.pos];
  const turn = ++v.turn;
  viewerCaption(leaf);
  try {
    if (isImage(p.path)) {
      const img = await invoke<{ url: string; stamp: string }>("file_image", { path: p.path, gitRef: p.ref ?? null });
      if (turn !== v.turn) return;
      v.lines = undefined;
      v.image = img.url;
      v.stamp = img.stamp;
    } else {
      const fileData = await invoke<{ lines: string[]; stamp: string }>("file_read", { path: p.path, gitRef: p.ref ?? null });
      if (turn !== v.turn) return;
      v.lines = fileData.lines;
      v.image = undefined;
      v.stamp = fileData.stamp;
    }
  } catch (e) {
    if (turn !== v.turn) return;
    v.lines = undefined;
    v.image = undefined;
    v.stamp = undefined;
    const error = element("div", "viewer-error");
    error.textContent = T.couldNotOpen(String(e));
    v.body.replaceChildren(error);
    v.mode.hidden = true;
    buttonsViewer(v);
    return;
  }
  drawViewer(leaf, scroll);
}

/// Claude edited the open file: the viewer follows, without losing the scroll.
async function checkViewer(leaf: Leaf) {
  const v = leaf.viewer;
  if (!v?.isOpen || !v.stamp || v.edit) return;
  const p = v.history[v.pos];
  if (p.ref) return;
  const now = await invoke<string | null>("file_stamp", { path: p.path }).catch(() => null);
  if (now && now !== v.stamp && v.history[v.pos] === p) void loadViewer(leaf, false);
}

function drawViewer(leaf: Leaf, scroll: boolean) {
  const v = leaf.viewer;
  const lines = v?.lines;
  if (!v || (!lines && !v.image) || v.edit) return;
  const p = v.history[v.pos];
  const md = isMarkdown(p.path);
  v.mode.hidden = !hasRendered(p.path);
  buttonsViewer(v);
  v.mode.textContent = v.rendered ? T.viewFont : T.viewRendered;
  // The scroll the redraw moves (the content disappears and comes back) isn't yours: only
  // what you do after two frames counts.
  const holding = ++v.holding;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (v.holding === holding) v.holding = 0;
    }),
  );
  const top = scroll ? 0 : v.scrollPos;

  if (v.image || (lines && isSvg(p.path) && v.rendered)) {
    const url = v.image ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent((lines ?? []).join("\n"))}`;
    v.body.replaceChildren(viewerImage(url));
    return;
  }
  if (!lines) return;

  if (md && v.rendered) {
    const html = element("div", "viewer-md markdown");
    html.innerHTML = markdown(lines.join("\n"), 0, p.ref ? "view" : "mark", true);
    const markedOnes = markBlocks(html, p.line, p.to);
    copyButtons(html);
    v.body.replaceChildren(html);
    const turn = v.turn;
    void drawMermaid(html, () => turn === v.turn);
    if (scroll && markedOnes[0]) {
      // As in the source: a third below the top.
      const blockTop = markedOnes[0].getBoundingClientRect().top - v.body.getBoundingClientRect().top + v.body.scrollTop;
      v.body.scrollTop = blockTop - v.body.clientHeight / 3;
      v.fraction = undefined;
    } else if (v.fraction !== undefined) {
      v.body.scrollTop = v.fraction * (v.body.scrollHeight - v.body.clientHeight);
      v.scrollPos = v.body.scrollTop;
      v.fraction = undefined;
    } else v.body.scrollTop = top;
    if (scroll) v.scrollPos = 0;
    return;
  }

  const from = p.line ?? 0;
  const to = Math.max(from, p.to ?? from);
  const code = element("div", "viewer-code");
  code.style.setProperty("--digits", String(String(lines.length).length));
  code.innerHTML = lines
    .map((l, i) => {
      const n = i + 1;
      const marked = n >= from && n <= to ? " marked" : "";
      return `<div class="viewer-line${marked}"><span class="viewer-num">${n}</span><span class="viewer-text">${escape(l) || " "}</span></div>`;
    })
    .join("");
  v.body.replaceChildren(code);
  if (scroll && from) {
    const target = code.children[from - 1] as HTMLElement | undefined;
    // A third below the top: lets you see what comes before the line.
    if (target) v.body.scrollTop = target.offsetTop - v.body.clientHeight / 3;
  } else {
    v.body.scrollTop = top;
  }
  if (scroll) v.scrollPos = v.body.scrollTop;
  void colorizeViewer(v, code, p.path, lines);
}

/// In a rendered .md, the blocks the lines `from`–`to` became, lit like the source's
/// lines. The innermost ones: a list item or a table row, not the whole list or table.
function markBlocks(html: HTMLElement, from?: number, to?: number): HTMLElement[] {
  if (!from) return [];
  const end = Math.max(from, to ?? from);
  const touched = [...html.querySelectorAll<HTMLElement>("[data-from]")].filter(
    (b) => Number(b.dataset.from) <= end && Number(b.dataset.to) >= from,
  );
  const markedOnes = touched.filter((b) => !touched.some((o) => o !== b && b.contains(o)));
  for (const b of markedOnes) b.classList.add("marked");
  return markedOnes;
}

/// The edit mode: the file in a text box over its own colored copy. The box's text
/// is transparent — only the caret and the selection show —, and below it a <pre>
/// draws the same lines with the read mode's colors, following the scroll. The numbers
/// go in a margin of their own, outside what is selected.
type Edit = {
  area: HTMLTextAreaElement;
  colors: HTMLPreElement;
  numbers: HTMLPreElement;
  root: HTMLDivElement;
  /// The text as it was last saved: what tells whether there is something to save.
  savedItem: string;
  /// The colored HTML of each line, by its text, from the last tokenization: while typing,
  /// the lines that didn't change keep their colors until the next one.
  painted: Map<string, string>;
  total: number;
  wait?: ReturnType<typeof setTimeout>;
  /// Where the box was scrolled when its tab was left.
  scrollPos?: [number, number];
};

/// The viewer's buttons follow the mode: editing, the source/rendered switch rests, Save
/// shows up (lit only with something to save) and ✕ leaves editing. The tabs too.
function buttonsViewer(v: Viewer) {
  const ed = v.edit;
  const p = v.history[v.pos];
  v.el.classList.toggle("is-editing", !!ed);
  v.modes.hidden = !!p?.ref || !v.lines;
  v.read.classList.toggle("on", !ed);
  v.editButton.classList.toggle("on", !!ed);
  v.save.hidden = !ed;
  v.save.disabled = !ed || ed.area.value === ed.savedItem;
  v.goBack.disabled = v.pos === 0;
  v.advance.disabled = v.pos === v.history.length - 1;
  if (ed) v.mode.hidden = true;
  v.close.title = ed ? T.leaveEditing : T.backToTerminal;
  drawTabsViewer(v);
}

/// A line's tokens as HTML, with the theme's colors — the same in reading and in editing.
function htmlFromTokens(line: { content: string; color?: string; fontStyle?: number }[]): string {
  return line
    .map((t) => {
      const style = [t.color ? `color:${t.color}` : "", t.fontStyle === 1 ? "font-style:italic" : ""].filter(Boolean).join(";");
      return style ? `<span style="${style}">${escape(t.content)}</span>` : escape(t.content);
    })
    .join("");
}

/// Edit mode: right in the viewer. Not for a git version, which has nowhere to be saved.
function enterEdit(leaf: Leaf) {
  const v = leaf.viewer;
  if (!v?.lines || v.edit || v.history[v.pos]?.ref) return;
  const root = element("div", "viewer-editor");
  const margin = element("div", "viewer-editor-margin");
  const numbers = element("pre", "viewer-editor-numbers");
  margin.append(numbers);
  const campo = element("div", "viewer-editor-field");
  const colors = element("pre", "viewer-editor-colors");
  const area = element("textarea", "viewer-edit");
  area.spellcheck = false;
  area.value = v.lines.join("\n");
  campo.append(colors, area);
  root.append(margin, campo);
  const ed: Edit = { area, colors, numbers, root, savedItem: area.value, painted: new Map(), total: 0 };
  v.edit = ed;
  // Tab indents the way the file already does.
  const indent = v.lines.some((l) => l.startsWith("\t")) ? "\t" : "  ";
  area.addEventListener("input", () => {
    paintEdit(ed);
    buttonsViewer(v);
    clearTimeout(ed.wait);
    ed.wait = setTimeout(() => void colorizeEdit(leaf, ed), 200);
  });
  area.addEventListener("scroll", () => {
    colors.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
    numbers.style.transform = `translateY(${-area.scrollTop}px)`;
  });
  area.addEventListener("keydown", (e) => {
    const cmd = e.metaKey && !e.altKey && !e.ctrlKey;
    if (cmd && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveEdit(leaf);
    } else if (e.key === "Escape") {
      // Not up to the body, where esc closes the viewer.
      e.preventDefault();
      e.stopPropagation();
      void leaveEdit(leaf);
    } else if (e.key === "Tab" && !cmd && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertText", false, indent);
    } else if (cmd && e.key.toLowerCase() === "z") {
      // The Edit menu has no Undo — it would reach the terminal too —, so ⌘Z is handled here.
      e.preventDefault();
      document.execCommand(e.shiftKey ? "redo" : "undo");
    } else if (cmd && e.key.toLowerCase() === "x") {
      e.preventDefault();
      document.execCommand("cut");
    }
  });
  paintEdit(ed);
  // The edit opens where reading was. The source has the same lines, font and padding as
  // the box, so the same scroll; rendered, the same fraction of the way. And the caret
  // goes to the first line on screen: left at the end, where the box puts it, the
  // scroll would jump down there.
  const read = v.body;
  const fromCode = !v.rendered;
  const top = read.scrollTop;
  const fraction = read.scrollHeight > read.clientHeight ? top / (read.scrollHeight - read.clientHeight) : 0;
  read.replaceChildren(root);
  area.scrollTop = fromCode ? top : fraction * (area.scrollHeight - area.clientHeight);
  const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18.6;
  const first = Math.max(0, Math.floor(area.scrollTop / lineHeight));
  const lines = area.value.split("\n");
  const beginning = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
  area.setSelectionRange(beginning, beginning);
  area.focus({ preventScroll: true });
  area.dispatchEvent(new Event("scroll"));
  buttonsViewer(v);
  void colorizeEdit(leaf, ed);
}

/// Redraws the colored copy and the numbers from the box's text. A changed line goes
/// plain until the next tokenization colors it.
function paintEdit(ed: Edit) {
  const lines = ed.area.value.split("\n");
  // The trailing space keeps a last empty line: a <pre> drops the final line break.
  ed.colors.innerHTML = `${lines.map((l) => ed.painted.get(l) ?? escape(l)).join("\n")}\n `;
  if (lines.length !== ed.total) {
    ed.total = lines.length;
    ed.numbers.textContent = Array.from({ length: lines.length }, (_, i) => i + 1).join("\n");
    ed.root.style.setProperty("--digits", String(String(lines.length).length));
  }
}

async function colorizeEdit(leaf: Leaf, ed: Edit) {
  const v = leaf.viewer;
  if (!v) return;
  const { langFor, tokenizeFresh } = await import("./differ/lib/highlight");
  const lang = langFor(v.history[v.pos].path);
  if (!lang) return;
  const lines = ed.area.value.split("\n");
  const tokens = await tokenizeFresh(lines, lang);
  if (!tokens || v.edit !== ed) return;
  ed.painted = new Map(tokens.map((t, i) => [lines[i], htmlFromTokens(t)]));
  paintEdit(ed);
}

async function saveEdit(leaf: Leaf): Promise<boolean> {
  const v = leaf.viewer;
  const ed = v?.edit;
  if (!v || !ed) return false;
  const text = ed.area.value;
  try {
    v.stamp = await invoke<string>("file_save", {
      path: v.history[v.pos].path,
      text: text,
      since: v.stamp ?? "",
    });
  } catch (e) {
    notify(leaf, T.couldNotSave(String(e)));
    return false;
  }
  v.lines = text.split("\n");
  ed.savedItem = text;
  buttonsViewer(v);
  return true;
}

/// Whether the edit on screen can go: nothing unsaved, or the question answered with
/// save (and saved) or discard.
async function canDropEdit(leaf: Leaf): Promise<boolean> {
  const ed = leaf.viewer?.edit;
  if (!ed || ed.area.value === ed.savedItem) return true;
  const r = await choose("viewer-leave-editing", {
    title: T.saveChangesTitle,
    text: T.saveChangesText,
    confirm: T.save,
    alternative: T.discard,
    cancel: T.cancel,
  });
  if (r === "alternative" || (r === "yes" && (await saveEdit(leaf)))) return true;
  ed.area.focus();
  return false;
}

/// Back to reading. With unsaved changes it asks first: save, discard or stay.
async function leaveEdit(leaf: Leaf) {
  const v = leaf.viewer;
  const ed = v?.edit;
  if (!v || !ed || !(await canDropEdit(leaf))) return;
  clearTimeout(ed.wait);
  // Reading comes back where the edit was (see `enterEdit`).
  const a = ed.area;
  if (v.rendered) v.fraction = a.scrollHeight > a.clientHeight ? a.scrollTop / (a.scrollHeight - a.clientHeight) : 0;
  else v.scrollPos = a.scrollTop;
  v.edit = undefined;
  // What was saved may be older than the disk: rereading also brings the stamp up to date.
  await loadViewer(leaf, false);
  v.body.focus({ preventScroll: true });
}

/// An image, fitted to the viewer; a click switches to actual size and back. The
/// checkerboard behind it is what shows a transparent area as transparent.
function viewerImage(url: string): HTMLElement {
  const box = element("div", "viewer-image");
  const img = element("img", "");
  img.alt = "";
  const size = element("div", "viewer-image-size");
  img.addEventListener("load", () => (size.textContent = `${img.naturalWidth} × ${img.naturalHeight}`));
  img.addEventListener("error", () => (size.textContent = T.unreadableImage));
  img.addEventListener("click", () => box.classList.toggle("real"));
  img.src = url;
  box.append(img, size);
  return box;
}

let mermaidPronto: Promise<typeof import("mermaid").default> | null = null;
let mermaidN = 0;

/// The ```mermaid blocks of a rendered .md (or of a plugin's Markdown), as drawings. The
/// import only happens when there is one: mermaid weighs more than the rest of the
/// viewer. A diagram that doesn't parse stays as code; `current` false drops the rest.
async function drawMermaid(html: HTMLElement, current = () => true) {
  const blocks = [...html.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (!blocks.length) return;
  mermaidPronto ??= import("mermaid").then(({ default: m }) => {
    m.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
    return m;
  });
  const mermaid = await mermaidPronto;
  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`mermaid-${++mermaidN}`, block.textContent ?? "");
      if (!current() || !block.isConnected) return;
      const drawing = element("div", "viewer-mermaid");
      // What it was drawn from: a page redrawn with the same diagram can keep this drawing.
      drawing.dataset.source = block.textContent ?? "";
      const area = element("div", "viewer-mermaid-area");
      area.innerHTML = svg;
      drawing.append(area);
      block.replaceWith(drawing);
      const figure = area.querySelector("svg");
      if (figure) mermaidZoom(drawing, area, figure);
    } catch (e) {
      jlog(`mermaid: ${e}`);
    }
  }
}

/// Zoom on a diagram: the buttons, a trackpad pinch (WebKit delivers it as
/// `gesturechange`) or ⌘ + scroll, keeping the point under the pointer in place. It
/// starts fitting the width; dragging moves it when it is larger than the box.
function mermaidZoom(drawing: HTMLElement, area: HTMLElement, svg: SVGSVGElement) {
  const box = svg.viewBox.baseVal;
  const width = box?.width || svg.getBoundingClientRect().width || 1;
  const height = box?.height || svg.getBoundingClientRect().height || 1;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  let scale = 1;
  const pct = element("button", "visor-mermaid-pct");
  const apply = (newOne: number, x = area.clientWidth / 2, y = area.clientHeight / 2) => {
    newOne = Math.min(8, Math.max(0.1, newOne));
    const px = (area.scrollLeft + x) / scale;
    const py = (area.scrollTop + y) / scale;
    scale = newOne;
    svg.style.width = `${width * scale}px`;
    svg.style.height = `${height * scale}px`;
    area.scrollLeft = px * scale - x;
    area.scrollTop = py * scale - y;
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  // 24px: the area's padding, on both sides.
  const adjusted = () => Math.min(1, (area.clientWidth - 24) / width);
  apply(adjusted());

  const less = element("button", "viewer-mermaid-button");
  less.textContent = "−";
  less.title = T.zoomLess;
  less.addEventListener("click", () => apply(scale / 1.25));
  pct.title = T.zoomAdjust;
  pct.addEventListener("click", () => apply(adjusted()));
  const more = element("button", "viewer-mermaid-button");
  more.textContent = "+";
  more.title = T.zoomMore;
  more.addEventListener("click", () => apply(scale * 1.25));
  const bar = element("div", "viewer-mermaid-zoom");
  bar.append(less, pct, more);
  drawing.append(bar);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = area.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  area.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      apply(scale * Math.exp(-e.deltaY * 0.01), ...point(e));
    },
    { passive: false },
  );
  let beforeGesture = 1;
  area.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    beforeGesture = scale;
  });
  area.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    apply(beforeGesture * g.scale, ...point(g));
  });

  area.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const left = area.scrollLeft;
    const top = area.scrollTop;
    area.setPointerCapture(e.pointerId);
    area.classList.add("dragging");
    const mover = (m: PointerEvent) => {
      area.scrollLeft = left - (m.clientX - x0);
      area.scrollTop = top - (m.clientY - y0);
    };
    const release = () => {
      area.removeEventListener("pointermove", mover);
      area.classList.remove("dragging");
    };
    area.addEventListener("pointermove", mover);
    area.addEventListener("pointerup", release, { once: true });
    area.addEventListener("pointercancel", release, { once: true });
  });
}

/// Colors come later, from the same shiki as the differ: the file shows right away, and
/// the import only weighs on the first time the viewer opens.
async function colorizeViewer(v: Viewer, code: HTMLDivElement, path: string, lines: string[]) {
  const turn = v.turn;
  const { langFor, tokenizeFresh } = await import("./differ/lib/highlight");
  const lang = langFor(path);
  if (!lang) return;
  const tokens = await tokenizeFresh(lines, lang);
  if (!tokens || turn !== v.turn || !code.isConnected) return;
  const texts = code.querySelectorAll<HTMLElement>(".viewer-text");
  tokens.forEach((line, i) => {
    const target = texts[i];
    if (target && line.length) target.innerHTML = htmlFromTokens(line);
  });
}

// ---------- file references: ⌘-click ----------

/// The folder the panel's relative paths start from: the one of the process in
/// front of the shell, which with Claude running is its folder. Kept for a few
/// seconds, because xterm asks on every line the mouse passes over.
const folders = new WeakMap<Leaf, { at: number; folder: Promise<string | null> }>();
function panelFolder(leaf: Leaf): Promise<string | null> {
  const stored = folders.get(leaf);
  if (stored && Date.now() - stored.at < 3000) return stored.folder;
  const folder = invoke<string | null>("pty_cwd", { id: leaf.id })
    .catch(() => null)
    .then((p) => p ?? leaf.bar?.folder ?? null);
  folders.set(leaf, { at: Date.now(), folder });
  return folder;
}

/// The references that really exist, already with the absolute path.
async function resolver(base: string | null, refs: Reference[]): Promise<(string | null)[]> {
  if (!base || !refs.length) return refs.map(() => null);
  return invoke<(string | null)[]>("files_exist", { base, candidates: refs.map((r) => r.file) }).catch(() =>
    refs.map(() => null),
  );
}

/// A `path:line` in the terminal output becomes a link: ⌘-click opens it in the viewer.
/// Only those that exist — the panel's folder says where a relative one starts from.
function wireFileLinks(leaf: Leaf) {
  const term = leaf.term;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const cols = term.cols;
      // A window of lines around it: no path spans more than that.
      const base = Math.max(0, y - 1 - 10);
      const lines: ScreenLine[] = [];
      for (let i = base; i < Math.min(buf.length, y + 10); i++) {
        const l = buf.getLine(i);
        lines.push({ text: l?.translateToString(false) ?? "", broken: l?.isWrapped ?? false });
      }
      const here = y - 1 - base;
      // With and without the continuation guess, upward and downward: joining two
      // lines that weren't one would spoil the whole reference in one of them.
      type Found = { ref: Reference; from: { line: number; col: number }; to: { line: number; col: number }; text: string };
      const findings: Found[] = [];
      const combinations: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];
      for (const [up, below] of combinations) {
        const { text, pos } = logicalLine(lines, here, cols, up, below);
        for (const ref of findReferences(text)) {
          const snippet = pos.slice(ref.beginning, ref.end);
          if (!snippet.some((p) => p.line === here)) continue;
          const from = snippet[0];
          const to = snippet[snippet.length - 1];
          if (findings.some((a) => a.from.line === from.line && a.from.col === from.col && a.to.line === to.line && a.to.col === to.col)) continue;
          findings.push({ ref, from, to, text: text.slice(ref.beginning, ref.end) });
        }
      }
      if (!findings.length) return callback(undefined);
      void (async () => {
        const paths = await resolver(await panelFolder(leaf), findings.map((a) => a.ref));
        const live = findings.flatMap((a, i) => (paths[i] ? [{ ...a, path: paths[i] }] : []));
        const point = (p: { line: number; col: number }) => p.line * cols + p.col;
        // A piece that exists inside a larger path that also exists
        // (`lib/x.dart` inside `apps/lib/x.dart`): the larger one stays.
        const links = live
          .filter((a) => !live.some((b) => b !== a && point(b.from) <= point(a.from) && point(b.to) >= point(a.to) && b.text.length > a.text.length))
          .map((a) => ({
            range: { start: { x: a.from.col + 1, y: base + a.from.line + 1 }, end: { x: a.to.col + 1, y: base + a.to.line + 1 } },
            text: a.text,
            decorations: { pointerCursor: true, underline: true },
            activate: (e: MouseEvent) => {
              if (!e.metaKey && !e.ctrlKey) return;
              openFile(leaf, { path: a.path, line: a.ref.line, to: a.ref.to });
            },
          }));
        callback(links.length ? links : undefined);
      })();
    },
  });
}

/// ⌘-click on a `<code>` that is just a path (in the chat, in a viewer .md).
/// Returns whether the click was that, so the caller doesn't handle it again.
function referenceClick(leaf: Leaf, e: MouseEvent, base?: string): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  const code = (e.target as HTMLElement).closest("code");
  const ref = code && referenceWhole(code.textContent ?? "");
  if (!ref) return false;
  e.preventDefault();
  void (async () => {
    const [path] = await resolver(base ?? (await panelFolder(leaf)), [ref]);
    if (path) openFile(leaf, { path, line: ref.line, to: ref.to });
    else notify(leaf.owner ?? leaf, T.notFound(ref.file));
  })();
  return true;
}

// ---------- paths: dragging and pasting files ----------

/// Several files become several arguments, each protected by `quote`.
/// The space at the end is so the next
/// file (or the rest of the command) doesn't stick to the previous one.
const lineOf = (paths: string[]) => paths.map(quote).join(" ") + " ";

/// Hands the text to the panel through xterm's paste path, not through
/// `pty_write` directly: xterm is what wraps it in bracketed paste when the program
/// on the other side asked for it. Without that Claude Code (and vim, and zsh) would get the
/// paste as if each character had been typed.
function paste(leaf: Leaf, text: string) {
  if (!text) return;
  leaf.term.paste(text);
}

/// Which panel is under the pointer. The drag doesn't go through the DOM — Tauri
/// reports it, and the position comes in physical pixels —, so dividing by the screen's
/// scale is up to us. `devicePixelRatio` and not the `scaleFactor` stored at
/// startup: the window may have moved to a monitor with another density in between.
function leafIn(p: { x: number; y: number }): Leaf | undefined {
  return leafAtPoint(p.x / devicePixelRatio, p.y / devicePixelRatio);
}

/// The same, in the page's own pixels (a drag the page itself follows).
function leafAtPoint(x: number, y: number): Leaf | undefined {
  if (!active) return;
  const target = document.elementFromPoint(x, y);
  if (!target) return;
  for (const f of visibleOnes(active)) if (f.el.contains(target)) return f;
}

/// The panel lit as the destination of a drag (Finder's or the explorer's).
let receiving: Leaf | undefined;
function markReceiving(f?: Leaf) {
  if (receiving === f) return;
  receiving?.el.classList.remove("receiving");
  receiving = f;
  receiving?.el.classList.add("receiving");
}

/// Dropped paths go where you would type next: in the field of a plugin layer on
/// screen (the Claude chat's) — the terminal is hidden behind it —, otherwise on the
/// terminal's line. Dropping on a panel also picks it.
function releasePaths(leaf: Leaf, paths: string[]) {
  if (!paths.length) return;
  focusLeaf(leaf);
  const target = layerKeyboard(leaf);
  const campo = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target : undefined;
  if (!campo) return paste(leaf, lineOf(paths));
  const from = campo.selectionStart ?? campo.value.length;
  const before = campo.value.slice(0, from);
  const space = before && !/\s$/.test(before) ? " " : "";
  campo.setRangeText(space + lineOf(paths), from, campo.selectionEnd ?? from, "end");
  // The field grows and the `/` menu follows what was typed, as with the keyboard.
  campo.dispatchEvent(new Event("input"));
  campo.focus();
}

/// Dragging a file from Finder and dropping it here writes its path on the line,
/// in the panel under the pointer — not the one with the keyboard.
async function wireDrag() {
  const mark = markReceiving;

  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    // With the diff in front there is no panel under the pointer, and the panel with the
    // keyboard is hidden: the path would end up in a terminal nobody sees.
    if (inDiff) return;
    if (payload.type === "leave") return mark(undefined);
    if (payload.type !== "drop") return mark(leafIn(payload.position));

    // Dropping outside a panel (on the tab bar, on the voice strip) still has an
    // obvious destination: the panel with the keyboard.
    const leaf = leafIn(payload.position) ?? active?.focus;
    mark(undefined);
    if (leaf) releasePaths(leaf, payload.paths);
  });
}

/// ⌘⇧V: what is on the clipboard goes in as a path. Plain ⌘V pastes
/// the text Finder left along with it — the file's *name*, with no folder at all,
/// which is no use as an argument. With no file on the clipboard, it pastes the text and that's it: a
/// key that does nothing looks like a broken key.
async function pastePath() {
  if (!active || inDiff) return;
  const clipboard = await invoke<{ files: string[]; text: string | null }>("clipboard_paste");
  const leaf = active.focus;
  if (clipboard.files.length) paste(leaf, lineOf(clipboard.files));
  else if (clipboard.text) paste(leaf, clipboard.text);
}

// ---------- panel bar: title, play, stop and diff ----------

/// The project a panel is in, as its launch.json describes it.
type Project = {
  folder: string;
  home: string;
  /// The ones play runs: without separators or CodeLens ones (see `playList`).
  configs: ConfigLaunch[];
  /// The picker button's list, with group titles among the configurations.
  menu: (ConfigLaunch | string)[];
  tasks: Task[];
  /// A launch.json that couldn't be read: play explains instead of vanishing.
  error?: string;
};

/// An app a panel's play button launched. It runs in the panel's drawer, a
/// plain shell where the command is typed: that is how the app inherits PATH and the
/// rest of your .zshrc — which is, almost always, the only place where `flutter`
/// is on PATH.
type Run = {
  /// O panel cujo play rodou o app.
  owner: Leaf;
  /// The drawer's terminal, where the app runs.
  leaf: Leaf;
  folder: string;
  name: string;
  plan: Plan;
  running: boolean;
  stopping?: boolean;
};

/// A panel's bars. Each panel has its own: with the screen split into two
/// projects, each one has its own play, its own running app and its own diff.
/// The one on top carries the title and the actions; the one below (`footer`) says where
/// the shell is — the folder on the left, the diff and the branch on the right.
type Bar = {
  el: HTMLDivElement;
  title: HTMLSpanElement;
  footer: HTMLDivElement;
  /// The shell's folder, with the home folder as `~`.
  path: HTMLSpanElement;
  /// The plugins' `panelHeader` slots, after the title.
  plugins: HTMLDivElement;
  notice: HTMLSpanElement;
  actions: HTMLSpanElement;
  drawer: HTMLButtonElement;
  stop: HTMLButtonElement;
  groupPlay: HTMLDivElement;
  play: HTMLButtonElement;
  playIcon: HTMLSpanElement;
  /// The name of the chosen configuration. It lives on the picker button, not on play:
  /// it is the list's label, and clicking it is how you switch configurations.
  name: HTMLSpanElement;
  choose: HTMLButtonElement;
  diff: HTMLButtonElement;
  viewer: HTMLButtonElement;
  explore: HTMLButtonElement;
  maximize: HTMLButtonElement;
  close: HTMLButtonElement;
  project: Project | null;
  /// The root of the git repository this panel's shell is in, or `null` if
  /// it isn't in any. It says whether the diff button has somewhere to
  /// lead, and it is how we know whether the open diff is this panel's.
  repo: string | null;
  /// The shell's folder and its branch, on the bottom bar.
  folder: string | null;
  branch: string | null;
  /// The diff button's label: the branch, which gives way to "See diff" on hover.
  diffBranch: HTMLSpanElement;
  /// `loadProject` responses arriving out of order (several `cd`s
  /// in a row) must not overwrite the newest one.
  request: number;
  waitProject?: ReturnType<typeof setTimeout>;
  waitNotice?: ReturnType<typeof setTimeout>;
};

type Found = { folder: string; home: string; launch: string; tasks: string | null };

const stroke = (d: string) =>
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1l-7.9-5.1a.6.6 0 0 0-.92.5Z"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>`;
const ICON_RESTART = stroke("M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3");
const ICON_CHOOSE = stroke("M4.5 6.5 8 10l3.5-3.5");
/// The tab's ✕: the new tab's "+" (index.html), turned 45°.
const ICON_CLOSE_TAB = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.75v8.5M1.75 6h8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" transform="rotate(45 6 6)"/></svg>`;
/// The panel's ✕: the "+" turned 45°, like the tab's.
const ICON_CLOSE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" transform="rotate(45 8 8)"/></svg>`;
const ICON_MAXIMIZE = stroke("M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9");
const ICON_COLLAPSE = stroke("M13.5 2.5 9 7M9 3.5V7h3.5M2.5 13.5 7 9M7 12.5V9H3.5");
const ICON_COPY = stroke("M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.5 10.5V3a1 1 0 0 1 1-1h7.5");
const ICON_COPIED = stroke("M3 8.5l3.2 3L13 4.5");
const ICON_EYE = stroke("M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z");
const ICON_PENCIL = stroke("M11 2.5 13.5 5l-8 8-3 .5.5-3 8-8ZM9.5 4 12 6.5");
const ICON_FLOPPY = stroke("M3 2.5h8l2.5 2.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5ZM5 2.5V6h5V2.5M5 13.5v-4h6v4");
const ICON_PIN = stroke("M6 1.5h4M7 1.5v4L4.5 8.5h7L9 5.5v-4M8 8.5v6");
const ICON_FOLDER = stroke("M1.5 4.5a1 1 0 0 1 1-1h3.4l1.5 1.6h6.1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z");
const ICON_FILE = stroke("M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5ZM9.5 1.5V5H13M6 8.5h4M6 11h4");
/// The viewer's arrangement button (see `Layout`).
const ICON_LAYOUT: Record<Layout, string> = {
  side: stroke("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM8 2.5v11"),
  below: stroke("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM2 8h12"),
  over: stroke("M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM5 5.5h6v5H5Z"),
};
const ICON_DRAWER = stroke("M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5ZM2 9.5h12");

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

/// A bar button. The click doesn't take the keyboard from the terminal: the hot
/// reload `r`, typed right after, keeps going to the app — and coming back from the
/// diff tab finds the panel with the cursor.
function buttonTask(cls: string, html: string): HTMLButtonElement {
  const b = element("button", `task-btn ${cls}`);
  b.innerHTML = html;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

function createBar(): Bar {
  const el = element("div", "panel-bar");
  const title = element("span", "task-title");
  const notice = element("span", "task-notice");
  const controls = element("div", "task-controls");
  const actions = element("span", "task-actions");
  const drawer = buttonTask("task-drawer", ICON_DRAWER);
  const stop = buttonTask("task-stop", ICON_STOP);
  // Two buttons, not one split: play runs, the dropdown picks. While the
  // configuration's name lived inside play, the whole box looked like a
  // list — and clicking the name, the biggest target and the one that looks most like a
  // dropdown label, ran the app. Now the name belongs to the dropdown, and play is just ▶.
  const playIcon = element("span", "task-icon");
  const play = buttonTask("task-play", "");
  play.append(playIcon);
  const name = element("span", "task-name");
  const seta = element("span", "task-arrow");
  seta.innerHTML = ICON_CHOOSE;
  const choose = buttonTask("task-choose", "");
  choose.append(name, seta);
  const groupPlay = element("div", "task-play-group");
  groupPlay.append(play, choose);
  // The branch is the button's label, and on hover "See diff" takes its place. Both
  // share one cell, so the button is as wide as the longer one and doesn't jump.
  const diffBranch = element("span", "diff-branch");
  const diffSee = element("span", "diff-see");
  diffSee.textContent = T.seeDiff;
  const diffLabel = element("span", "diff-label");
  diffLabel.append(diffBranch, diffSee);
  const diff = buttonTask("task-diff", ICON_DIFF);
  diff.append(diffLabel);
  diff.title = T.thisPanelDiff;
  // Only shows after the first file is opened: before that there is nothing to show.
  const viewer = buttonTask("task-viewer", ICON_FILE);
  viewer.hidden = true;
  const maximize = buttonTask("task-maximize", ICON_MAXIMIZE);
  // `drawMaximize` decides whether it shows, once the leaf has a tab.
  maximize.hidden = true;
  const close = buttonTask("task-close", ICON_CLOSE);
  close.title = T.closePanel;
  // Like maximize: `drawMaximize` shows it once the leaf has a tab.
  close.hidden = true;
  controls.append(actions, drawer, stop, groupPlay, viewer, maximize, close);
  // On the left, like the drawer it opens.
  const explore = buttonTask("task-explore", ICON_FOLDER);
  const plugins = element("div", "panel-plugins");
  el.append(explore, title, plugins, notice, controls);

  const footer = element("div", "panel-footer");
  const path = element("span", "footer-path");
  const where = element("div", "footer-where");
  where.append(diff);
  footer.append(path, where);
  return {
    el,
    title,
    footer,
    path,
    plugins,
    folder: null,
    branch: null,
    diffBranch,
    notice,
    actions,
    drawer,
    stop,
    groupPlay,
    play,
    playIcon,
    name,
    choose,
    diff,
    viewer,
    explore,
    maximize,
    close,
    project: null,
    repo: null,
    request: 0,
  };
}

function wireBar(leaf: Leaf) {
  const b = leaf.bar;
  if (!b) return;
  b.explore.addEventListener("click", () => toggleExplorer(leaf));
  b.play.addEventListener("click", () => {
    const cfg = chosenConfig(b.project);
    if (cfg) void execute(leaf, cfg);
  });
  b.choose.addEventListener("click", () => toggleMenu(leaf));
  b.drawer.addEventListener("click", () => toggleDrawer(leaf));
  b.stop.addEventListener("click", () => {
    if (leaf.execution?.running) void stop(leaf.execution);
  });
  // The diff is of a repository, and the panel knows which one: each has its own
  // directory — with the screen split into three projects, each panel says its own.
  b.diff.addEventListener("click", () => void openDiff(leaf));
  b.viewer.addEventListener("click", () => toggleViewer(leaf));
  b.maximize.addEventListener("click", () => toggleMaximize(leaf));
  b.close.addEventListener("click", () => closeLeaf(leaf));
  // Double-clicking the bar does the same — the big target, like a window's
  // title bar. Not on its buttons: two clicks on play are two plays.
  b.el.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    toggleMaximize(leaf);
  });
}

/// The button only exists with the screen split: with a single panel it already is the whole tab.
function drawMaximize(leaf: Leaf) {
  const b = leaf.bar;
  const tab = tabOf(leaf);
  if (!b || !tab) return;
  const full = tab.maximized === leaf;
  b.maximize.hidden = tab.root.kind === "leaf";
  b.maximize.classList.toggle("on", full);
  b.maximize.innerHTML = full ? ICON_COLLAPSE : ICON_MAXIMIZE;
  b.maximize.title = full ? T.collapsePanel : T.takeTab;
  // Alone in the tab, ⌘W and the tab's ✕ already close it: the bar's ✕ is for a split.
  b.close.hidden = tab.root.kind === "leaf";
}

function drawBar(leaf: Leaf) {
  const b = leaf.bar;
  if (!b) return;
  const title = titleOf(leaf);
  b.title.textContent = title;
  b.title.title = title;
  const path = b.folder ? withTilde(b.folder) : "";
  // The bar cuts the path on the left (`direction: rtl`); the mark keeps the `~/` at the
  // start, where the right-to-left run would otherwise move it.
  b.path.textContent = path && `\u200e${path}`;
  b.path.title = path;

  const g = leaf.drawer;
  b.drawer.hidden = !g;
  b.drawer.classList.toggle("on", g?.open === true);
  b.drawer.title = g?.open ? T.hideDrawer : T.showDrawer;

  const ex = leaf.execution;
  const running = ex?.running === true;
  b.stop.hidden = !running;
  b.stop.title = ex ? T.stop(ex.name) : "";
  b.actions.replaceChildren();
  if (ex && running) {
    for (const action of ex.plan.actions ?? []) {
      const button = buttonTask("task-action", "");
      button.textContent = `${action.icon} ${action.label}`;
      button.title = T.actionHint(action.label, action.keyOf);
      button.addEventListener("click", () => {
        invoke("pty_write", { id: ex.leaf.id, data: action.keyOf }).catch((e) => jlog(`action: ${e}`));
      });
      b.actions.append(button);
    }
  }

  // Outside a repository the diff has nothing to show: the button goes away, as
  // play goes away where there is no launch.json — a dimmed button in every shell is noise.
  // Purple when this repository is the one open in the diff: the same color that
  // lights up on that tab's chip, and the pair of lit icons is what links one to the other.
  const inDiffNow = inDiffRepo(b);
  b.diff.hidden = !b.repo;
  b.diff.classList.toggle("on", inDiffNow);
  b.diff.title = inDiffNow
    ? T.openInDiff
    : T.thisPanelDiff;

  const exploring = leaf.explorer?.isOpen === true;
  b.explore.hidden = !(b.repo ?? b.folder);
  b.explore.classList.toggle("on", exploring);
  b.explore.title = exploring ? T.closeExplorer : T.openExplorer;

  const viewer = leaf.viewer;
  b.viewer.hidden = !viewer?.history.length;
  b.viewer.classList.toggle("on", viewer?.isOpen === true);
  b.viewer.title = viewer?.isOpen ? T.hideFile : T.showFile;

  // No launch.json, no play: a dimmed button in every shell would be noise.
  const proj = b.project;
  b.groupPlay.hidden = !proj;
  const cfg = chosenConfig(proj);
  const restart = running && ex?.folder === proj?.folder && ex?.name === cfg?.name;
  b.playIcon.innerHTML = restart ? ICON_RESTART : ICON_PLAY;
  b.play.disabled = !cfg;
  b.play.title =
    proj?.error ?? (cfg ? (restart ? T.restart(cfg.name) : T.run(cfg.name)) : T.noConfigurations);

  // With a single configuration there is nothing to pick, but the name is still the
  // only clue to what ▶ will run. So the button stays, without the arrow and without the
  // click: it becomes a label. It only goes away when there is no name to show.
  const several = (proj?.configs.length ?? 0) > 1;
  b.name.textContent = cfg?.name ?? "";
  b.choose.hidden = !cfg;
  b.choose.disabled = !several;
  b.choose.classList.toggle("label", !several);
  b.choose.title = several ? T.chooseConfiguration : (cfg?.name ?? "");
}

/// Redone when the panel is created and on every new title — a `cd` changes the title, and
/// may have changed project along with it.
function scheduleProject(leaf: Leaf) {
  const b = leaf.bar;
  if (!b) return;
  clearTimeout(b.waitProject);
  b.waitProject = setTimeout(() => void loadProject(leaf), 250);
}

async function loadProject(leaf: Leaf) {
  const b = leaf.bar;
  if (!b || leaf.dead) return;
  const request = ++b.request;
  let fresh: Project | null = null;
  const cwd = await invoke<string | null>("pty_cwd", { id: leaf.id }).catch(() => null);
  const found = cwd ? await invoke<Found | null>("launch_read", { cwd }).catch(() => null) : null;
  // Without a repository the diff button has nowhere to lead, and a `cd` may have
  // taken the panel out of one or put it in another.
  const root = cwd
    ? await invoke<string | null>("repo_root", { path: cwd }).catch(() => null)
    : null;
  // Outside a repository it doesn't even ask. With a detached HEAD it also returns null: there
  // is no branch name to show.
  const branch = root
    ? await invoke<string | null>("repo_branch", { path: cwd }).catch(() => null)
    : null;
  if (found) {
    const { folder: folder, home } = found;
    let projectTasks: Task[] = [];
    try {
      projectTasks = found.tasks ? tasksOf(found.tasks) : [];
    } catch (e) {
      jlog(`unreadable tasks.json in ${folder}: ${e}`);
    }
    try {
      fresh = { folder, home, ...playList(configsOf(found.launch)), tasks: projectTasks };
    } catch (e) {
      fresh = { folder, home, configs: [], menu: [], tasks: [], error: T.unreadableLaunch(String(e)) };
    }
  }
  if (request !== b.request || leaf.dead) return;
  const moved = b.repo !== root || b.folder !== cwd || b.branch !== branch;
  b.repo = root;
  b.project = fresh;
  b.folder = cwd;
  b.branch = branch;
  if (moved) for (const fn of movedListeners) fn(leaf.id);
  const tab = tabOf(leaf);
  if (tab) showBranches(tab);
  drawBar(leaf);
  // The footer's progress says which branch the task is on.
  if (leaf.progress) drawProgress();
  // A `cd` changes the folder the panel comes back in.
  scheduleSave();
}

/// The configuration play runs: the last one chosen in this project, or the first.
function chosenConfig(project: Project | null): ConfigLaunch | undefined {
  if (!project) return;
  let name: string | null = null;
  try {
    name = localStorage.getItem(`termiau:config:${project.folder}`);
  } catch {
    // Without storage, the first one stays.
  }
  return project.configs.find((c) => c.name === name) ?? project.configs[0];
}

function rememberConfig(folder: string, name: string) {
  try {
    localStorage.setItem(`termiau:config:${folder}`, name);
  } catch {
    // Just a convenience.
  }
}

/// The configuration list. A single one for the window, placed beside the button that
/// opened it: inside a panel it would be clipped by the panel's edge.
const menuEl = element("div", "task-menu");
/// The gap between the button and the list.
const MENU_GAP = 4;
/// How far the list keeps from the window's edge. Touching it, it looks clipped
/// even when it fits entirely.
const MENU_MARGIN = 24;
let menuOf: Leaf | undefined;
/// The button that opened the list: the same panel has three (configurations, model and
/// effort), and clicking another switches the list instead of closing it.
let menuAncora: HTMLElement | undefined;

function buildMenu() {
  menuEl.hidden = true;
  document.body.append(menuEl);
  // Clicking outside closes the list, like any menu. The button that opens it is left
  // out: it toggles on its own.
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Element;
    if (!menuEl.hidden && !menuEl.contains(target) && !target.closest?.(".task-choose")) closeMenu();
  });
}

function closeMenu() {
  menuEl.hidden = true;
  menuOf = undefined;
  menuAncora = undefined;
}

function toggleMenu(leaf: Leaf) {
  if (!menuEl.hidden && menuOf === leaf && menuAncora === leaf.bar?.choose) return closeMenu();
  const b = leaf.bar;
  const proj = b?.project;
  if (!b || !proj?.configs.length) return;
  const current = chosenConfig(proj);
  menuEl.replaceChildren(
    ...proj.menu.map((cfg) => {
      if (typeof cfg === "string") {
        const group = element("div", "task-menu-group");
        group.textContent = cfg;
        return group;
      }
      const item = element("button", cfg === current ? "chosen" : "");
      item.textContent = cfg.name;
      const kind = element("span", "task-menu-kind");
      kind.textContent = cfg.type;
      item.append(kind);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      // Choosing only chooses: play is what runs. The choice applies to the project,
      // so the other panels in it start showing the same one.
      item.addEventListener("click", () => {
        rememberConfig(proj.folder, cfg.name);
        closeMenu();
        for (const a of tabs) {
          for (const f of leaves(a.root)) if (f.bar?.project?.folder === proj.folder) drawBar(f);
        }
      });
      return item;
    }),
  );
  openMenu(leaf, b.choose);
}

/// Shows the already built list beside the button that opened it.
function openMenu(leaf: Leaf, ancora: HTMLElement) {
  // Measures the list at its natural height before deciding where it goes: that height
  // says whether it fits below. All in the same frame, so nothing flickers.
  menuEl.style.maxHeight = "";
  menuEl.style.top = "0px";
  menuEl.style.bottom = "";
  menuEl.hidden = false;
  const height = menuEl.offsetHeight;

  const r = ancora.getBoundingClientRect();
  menuEl.style.right = `${window.innerWidth - r.right}px`;
  const underneath = window.innerHeight - r.bottom - MENU_GAP - MENU_MARGIN;
  const onTop = r.top - MENU_GAP - MENU_MARGIN;
  // Opens downward, like every dropdown. It only goes up when it doesn't fit below and
  // there is more room above: a panel in the bottom half of the window has its bar
  // near the edge, and below it the list would be two items tall — or
  // none, which is what happened when the math went negative and the browser
  // threw max-height away. On both sides the height is limited to the space
  // left: a launch.json with dozens of configurations scrolls instead of overflowing.
  if (height <= underneath || underneath >= onTop) {
    menuEl.style.top = `${r.bottom + MENU_GAP}px`;
    menuEl.style.maxHeight = `${Math.max(underneath, 0)}px`;
  } else {
    menuEl.style.top = "";
    menuEl.style.bottom = `${window.innerHeight - r.top + MENU_GAP}px`;
    menuEl.style.maxHeight = `${Math.max(onTop, 0)}px`;
  }
  menuEl.querySelector(".chosen")?.scrollIntoView({ block: "nearest" });
  menuOf = leaf;
  menuAncora = ancora;
}

/// A short message on the bar, beside the title: a play that couldn't run says why.
function notify(leaf: Leaf, text: string) {
  const b = leaf.bar;
  if (!b) return;
  b.notice.textContent = text;
  b.notice.title = text;
  clearTimeout(b.waitNotice);
  b.waitNotice = setTimeout(() => {
    b.notice.textContent = "";
    b.notice.title = "";
  }, 8000);
}

async function execute(owner: Leaf, cfg: ConfigLaunch) {
  closeMenu();
  const proj = owner.bar?.project;
  if (!proj || owner.dead) return;
  rememberConfig(proj.folder, cfg.name);
  const runner = runnerFor(cfg.type);
  if (!runner) return notify(owner, T.unsupportedKind(cfg.name, cfg.type));

  let plan: Plan;
  let line: string;
  try {
    const ctx = {
      folder: proj.folder,
      home: proj.home,
      isFlutter: (folder: string) => invoke<boolean>("is_flutter_project", { folder: folder }),
    };
    plan = await runner.build(cfg, ctx);
    line = commandLine(plan, taskBefore(cfg, proj.tasks, ctx));
  } catch (e) {
    return notify(owner, `${cfg.name}: ${e instanceof Error ? e.message : e}`);
  }

  // Each panel has an app terminal, in its drawer. If it already exists, it is
  // reused — what play ran there before stops first; a command
  // you typed in it yourself, still running, isn't interrupted.
  let leaf: Leaf | undefined;
  const drawer = owner.drawer;
  if (drawer) {
    leaf = drawer.leaf;
    if (owner.execution?.running) await stop(owner.execution);
    else if (await invoke<boolean>("pty_busy", { id: leaf.id }).catch(() => false)) {
      return notify(owner, T.drawerBusy);
    }
    // The shell may have changed folders since last time.
    line = `cd ${word(plan.cwd)} && ${line}`;
  } else {
    leaf = await createDrawer(owner, plan.cwd);
    if (leaf && !owner.drawer?.open) notify(owner, T.runningHidden(cfg.name));
  }
  if (!leaf || leaf.dead || owner.dead) return;

  const ex: Run = { owner, leaf, folder: proj.folder, name: cfg.name, plan, running: true };
  owner.execution = ex;
  await invoke("pty_write", { id: leaf.id, data: `${line}\r` }).catch((e) => jlog(`play: ${e}`));
  watch(ex);
  drawBar(owner);
}

// ---------- drawer: the app terminal ----------

/// Opens as you left it last time; the first time, hidden.
function drawerOpenByDefault(): boolean {
  try {
    return localStorage.getItem("termiau:drawer") === "open";
  } catch {
    return false;
  }
}

function rememberDrawer(open: boolean) {
  try {
    localStorage.setItem("termiau:drawer", open ? "open" : "closed");
  } catch {
    // Just a convenience.
  }
}

/// The app terminal: below the panel's terminal, inside it, and outside the
/// split tree — it isn't a workplace, it is the output of what play
/// ran, and only shows when you ask. It is born visible and only then hides:
/// xterm measures the font when opening, and in a hidden element the measure would come out
/// zero and the grid, broken.
async function createDrawer(owner: Leaf, cwd: string): Promise<Leaf | undefined> {
  if (busy) return;
  busy = true;
  try {
    const el = element("div", "drawer");
    const handle = element("div", "drawer-handle");
    el.append(handle);
    owner.el.appendChild(el);
    const leaf = await createLeaf(cwd, (f) => el.appendChild(f), false);
    if (!leaf) {
      el.remove();
      return;
    }
    // The panel may have closed while the drawer's shell was opening.
    if (owner.dead) {
      destroyLeaf(leaf, false);
      return;
    }
    leaf.owner = owner;
    const open = drawerOpenByDefault();
    el.hidden = !open;
    owner.drawer = { leaf, el, open };
    owner.el.classList.toggle("with-drawer", open);
    wireHandle(owner, handle, el);
    const tab = tabOf(owner);
    if (tab) {
      measure(tab);
      sync(tab);
    }
    return leaf;
  } finally {
    busy = false;
  }
}

/// The drawer's top edge changes its height, as the divider changes the share.
function wireHandle(owner: Leaf, handle: HTMLDivElement, el: HTMLDivElement) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // otherwise the drag becomes text selection in the terminals
    handle.setPointerCapture(e.pointerId);
    const mover = (ev: PointerEvent) => {
      const r = owner.el.getBoundingClientRect();
      // A piece always remains on both sides: a terminal squeezed to zero
      // has no grid to measure.
      el.style.height = `${Math.min(r.height - 100, Math.max(60, r.bottom - ev.clientY))}px`;
      const tab = tabOf(owner);
      if (!tab) return;
      measure(tab);
      scheduleSync(tab);
    };
    const release = () => {
      handle.removeEventListener("pointermove", mover);
      handle.removeEventListener("pointerup", release);
    };
    handle.addEventListener("pointermove", mover);
    handle.addEventListener("pointerup", release);
  });
}

/// Shows or hides the panel's drawer. Open, it gets the keyboard (that is
/// what it is opened for: reading and typing); closed, the keyboard goes back to the panel. The app
/// keeps running in both cases.
function toggleDrawer(owner: Leaf) {
  const g = owner.drawer;
  const tab = tabOf(owner);
  if (!g || !tab) return;
  g.open = !g.open;
  g.el.hidden = !g.open;
  owner.el.classList.toggle("with-drawer", g.open);
  rememberDrawer(g.open);
  measure(tab);
  sync(tab);
  if (g.open) focusLeaf(g.leaf);
  else if (tab.focus === g.leaf) focusLeaf(owner);
  drawBar(owner);
}

/// The drawer's shell exited (`exit`, ⌘W with it focused): the drawer goes away, and the app
/// running in it goes along.
function closeDrawer(owner: Leaf, alreadyDead: boolean) {
  const g = owner.drawer;
  if (!g) return;
  owner.drawer = undefined;
  owner.execution = undefined;
  destroyLeaf(g.leaf, alreadyDead);
  g.el.remove();
  owner.el.classList.remove("with-drawer");
  const tab = tabOf(owner);
  if (tab) {
    measure(tab);
    sync(tab);
    if (tab.focus === g.leaf) focusLeaf(owner);
  }
  drawBar(owner);
}

/// The app ended when the shell becomes the terminal's owner again. Two reads
/// in a row: between one command and the next in a line with `&&` the shell is in
/// front for an instant, and a single read would declare the app finished there.
function watch(ex: Run) {
  const beginning = Date.now();
  let livre = 0;
  const tick = setInterval(async () => {
    if (ex.leaf.dead || ex.owner.execution !== ex || !ex.running) return clearInterval(tick);
    // The shell needs an instant to read the line and put the command in front.
    if (Date.now() - beginning < 1500) return;
    const busy = await invoke<boolean>("pty_busy", { id: ex.leaf.id }).catch(() => false);
    livre = busy ? 0 : livre + 1;
    if (livre < 2) return;
    clearInterval(tick);
    ex.running = false;
    drawBar(ex.owner);
  }, 700);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Gently first, forcefully after. flutter run's `q` shuts the app down on the
/// device; without its own key it sends Ctrl+C, which reaches the whole group — a
/// server and its children exit together. Whatever doesn't exit within a few seconds gets
/// SIGKILL: a stop that sometimes doesn't stop is worse than a brute-force stop.
async function stop(ex: Run) {
  if (ex.stopping) return;
  ex.stopping = true;
  const button = ex.owner.bar?.stop;
  if (button) button.disabled = true;
  const id = ex.leaf.id;
  const write = (data: string) => invoke("pty_write", { id, data }).catch(() => {});
  const exited = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await invoke<boolean>("pty_busy", { id }).catch(() => false))) return true;
      await pause(200);
    }
    return false;
  };
  try {
    await write(ex.plan.quit ?? "\x03");
    if (await exited(4000)) return;
    await write("\x03");
    if (await exited(2000)) return;
    await invoke("pty_signal", { id, signal: 9 }).catch((e) => jlog(`pty_signal: ${e}`));
    await exited(1000);
  } finally {
    ex.stopping = false;
    ex.running = false;
    if (button) button.disabled = false;
    drawBar(ex.owner);
  }
}

// ---------- a long task's progress, in the footer ----------

/// Beside the usage, one pill per panel whose Claude published a plan (`termiau progress`):
/// a ring with how much is done, the number, and the folder and branch it is in —
/// with several sessions working, that is what says which task is which. Clicking opens the
/// blocks and items above the footer.
const progressEl = document.getElementById("progress") as HTMLDivElement;
let progressOpen: Leaf | undefined;
let progressPanel: HTMLDivElement | undefined;
/// What is on screen. `paint` runs on every status line; redrawing the same thing would
/// throw away the open list's scroll every few seconds.
let progressKey = "";

type SocketPlan = { panel: number; progress: TaskPlan | null };

function receiveProgress(raw: SocketPlan) {
  const leaf = leafByPanel(raw.panel);
  if (!leaf) return;
  leaf.progress = raw.progress ?? undefined;
  drawProgress();
}

/// Where the task is: the panel's folder, its branch and its tab's number.
function whereIs(leaf: Leaf) {
  const owner = leaf.owner ?? leaf;
  const folder = owner.bar?.folder?.split("/").filter(Boolean).pop() ?? T.panelN(leaf.id);
  const tab = tabOf(leaf);
  return { folder, branch: owner.bar?.branch ?? null, tab: tab ? tabs.indexOf(tab) + 1 : 0 };
}

const placeLabel = (o: ReturnType<typeof whereIs>) => (o.branch ? `${o.folder} ⎇ ${o.branch}` : o.folder);
const progressText = (a: { pct: number; estimated: boolean }) => `${a.estimated ? "~" : ""}${Math.round(a.pct)}%`;

function progressRing(pct: number): string {
  const c = 2 * Math.PI * 5.5;
  return `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.8" opacity=".26"/><circle class="progress-arc" cx="8" cy="8" r="5.5" stroke-width="1.8" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/></svg>`;
}

function withProgress(): Leaf[] {
  const list: Leaf[] = [];
  for (const a of tabs) for (const f of leaves(a.root)) if (f.progress && !f.dead) list.push(f);
  return list;
}

function drawProgress() {
  const list = withProgress();
  if (progressOpen && !list.includes(progressOpen)) progressOpen = undefined;
  const key = JSON.stringify([list.map((f) => [f.id, f.progress, whereIs(f)]), progressOpen?.id]);
  if (key === progressKey) return;
  progressKey = key;

  progressEl.hidden = !list.length;
  progressEl.replaceChildren(
    ...list.map((f) => {
      const plan = f.progress as TaskPlan;
      const a = planProgress(plan);
      const where = whereIs(f);
      const pilula = element("button", "progress-pill");
      pilula.classList.toggle("open", f === progressOpen);
      pilula.classList.toggle("complete", a.done === a.total);
      pilula.innerHTML = progressRing(a.pct);
      const pct = element("span", "progress-pct");
      pct.textContent = progressText(a);
      const place = element("span", "progress-where");
      place.textContent = placeLabel(where);
      pilula.append(pct, place);
      pilula.title = T.progressHint(plan.title ?? where.folder, a.done, a.total);
      pilula.addEventListener("click", (e) => {
        e.stopPropagation();
        progressOpen = progressOpen === f ? undefined : f;
        drawProgress();
      });
      return pilula;
    }),
  );
  drawPanelOfProgress(list);
}

const SINAL_DO_STATUS = { done: "✓", doing: "◐", todo: "○" } as const;

/// The open list: the plan's title, where it is, the total and each block with its bar —
/// and, under the blocks that have them, the items.
function drawPanelOfProgress(list: Leaf[]) {
  const leaf = progressOpen;
  const plan = leaf?.progress;
  if (!leaf || !plan) {
    progressPanel?.remove();
    progressPanel = undefined;
    return;
  }
  const panel = (progressPanel ??= element("div", "progress-panel"));
  if (!panel.isConnected) document.body.append(panel);
  const where = whereIs(leaf);
  const a = planProgress(plan);

  const head = element("div", "progress-head");
  const texts = element("div", "progress-texts");
  const title = element("div", "progress-title");
  title.textContent = plan.title ?? where.folder;
  const sub = element("div", "progress-sub");
  sub.textContent = `${placeLabel(where)} · ${T.tabN(where.tab)}`;
  texts.append(title, sub);
  const go = element("button", "progress-btn");
  go.textContent = T.goToPanel;
  go.addEventListener("click", () => {
    const tab = tabOf(leaf);
    progressOpen = undefined;
    drawProgress();
    if (!tab) return;
    activate(tab);
    focusLeaf(leaf);
  });
  const remove = element("button", "progress-btn progress-remove");
  remove.innerHTML = ICON_CLOSE;
  remove.title = T.removeFromFooter;
  remove.addEventListener("click", () => {
    leaf.progress = undefined;
    drawProgress();
  });
  head.append(texts, go, remove);

  const bar = (pct: number) => {
    const track = element("span", "progress-track");
    const full = element("span", "progress-full");
    full.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    track.append(full);
    return track;
  };
  const total = element("div", "progress-total");
  const summary = element("span", "progress-summary");
  summary.textContent = `${progressText(a)} · ${T.blocksDone(a.done, a.total)}`;
  total.append(bar(a.pct), summary);

  const blocks = element("ol", "progress-blocks");
  for (const b of plan.blocks) {
    const ab = blockProgress(b);
    const li = element("li", "progress-block");
    li.dataset.status = b.status;
    const line = element("div", "progress-line");
    const sinal = element("span", "progress-dot");
    sinal.textContent = SINAL_DO_STATUS[b.status];
    const name = element("span", "progress-name");
    name.textContent = b.name;
    const pct = element("span", "progress-num");
    pct.textContent = progressText(ab);
    line.append(sinal, name, bar(ab.pct), pct);
    li.append(line);
    if (b.items?.length) {
      const items = element("ul", "progress-items");
      for (const i of b.items) {
        const item = element("li", "progress-item");
        item.dataset.status = i.status;
        const s = element("span", "progress-dot");
        s.textContent = SINAL_DO_STATUS[i.status];
        const n = element("span", "progress-name");
        n.textContent = i.name;
        item.append(s, n);
        items.append(item);
      }
      li.append(items);
    }
    blocks.append(li);
  }
  panel.replaceChildren(head, total, blocks);

  // Above its pill, without leaving the window on the right.
  const pilula = progressEl.children[list.indexOf(leaf)] as HTMLElement | undefined;
  const x = pilula?.getBoundingClientRect().left ?? 10;
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8))}px`;
}

function closeProgress() {
  if (!progressOpen) return;
  progressOpen = undefined;
  drawProgress();
}

window.addEventListener("mousedown", (e) => {
  if (progressPanel?.contains(e.target as Node) || progressEl.contains(e.target as Node)) return;
  closeProgress();
});
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || !progressOpen) return;
    e.stopPropagation();
    closeProgress();
  },
  true,
);
progressEl.hidden = true;

/// Each panel's diff button says its branch (`HEAD` when detached); the tab chip says
/// the focused panel's folder and session (see `showTicker`).
function showBranches(tab: Tab) {
  for (const f of leaves(tab.root)) if (f.bar) f.bar.diffBranch.textContent = f.bar.branch ?? "HEAD";
  showTicker(tab);
}

/// The tab's label: the name you gave it; else the session running in the focused panel
/// (Claude's); else that panel's folder — or, before the folder is known, the terminal's
/// title. The branch is on the panel's bottom bar.
function showTicker(tab: Tab) {
  const { session, folder } = labelParts(tab);
  const text = tab.name ?? autoLabel(tab);
  // The hover says everything the label may be hiding.
  tab.chip.title = [...new Set([tab.name, session, folder].filter(Boolean))].join(" · ") || text;
  if (tab.shown === text || tab.label.querySelector("input")) return;
  tab.shown = text;
  tab.labelText.textContent = text;
  marquee(tab.label, tab.labelText);
}

function labelParts(tab: Tab): { session?: string; folder: string | null } {
  const leaf = tab.focus;
  const b = leaf.bar;
  const folder = b?.folder ? b.folder.split("/").filter(Boolean).pop() || b.folder : null;
  return { session: [...(leaf.titles?.values() ?? [])].pop(), folder };
}

/// What the tab says when nobody named it.
function autoLabel(tab: Tab): string {
  const { session, folder } = labelParts(tab);
  return session ?? folder ?? titleOf(tab.focus);
}

/// Double click on the chip: the label becomes a field. Enter or leaving keeps the name,
/// Esc gives up; emptied, the tab goes back to naming itself.
function renameTab(tab: Tab) {
  if (tab.label.querySelector("input")) return;
  const field = element("input", "tab-rename");
  field.value = tab.name ?? tab.labelText.textContent ?? "";
  field.spellcheck = false;
  field.autocomplete = "off";
  tab.labelText.hidden = true;
  tab.label.append(field);
  field.focus();
  field.select();

  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    if (keep) {
      const name = field.value.trim();
      // Confirmed as it came, with no name before, it isn't a name: it is what the tab
      // already says on its own, and fixing it would stop it following the session.
      tab.name = name && (tab.name || name !== autoLabel(tab)) ? name : undefined;
      scheduleSave();
    }
    field.remove();
    tab.labelText.hidden = false;
    tab.shown = undefined;
    showTicker(tab);
    // Left by clicking another tab: the keyboard already went there.
    if (tab === active && document.activeElement === document.body) keyboard(tab.focus);
  };
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
  // Clicking inside the field moves the cursor in it: not a drag, not the chip's click.
  field.addEventListener("mousedown", (e) => e.stopPropagation());
}


// ---------- help: the shortcut list (Help ▸ Keyboard Shortcuts) ----------

/// All the app's shortcuts, by topic. Written by hand, not taken from the menu:
/// half of them aren't menu items (`ourShortcut`'s, the differ's), and the
/// list also has to say what each one does. Changed a shortcut, change it here.
/// More than one key for the same thing becomes more than one key on the row.
const SHORTCUTS: { group: string; items: [string | string[], string][] }[] = [
  {
    group: T.scTabs,
    items: [
      ["⌘T", T.scNewTab],
      ["⌘⇧T", T.scReopenClosed],
      ["⌘⇧]", T.scNextTab],
      ["⌘⇧[", T.scPreviousTab],
      ["⌘`", T.scBranchDiffPinned],
      ["⌘1 … ⌘8", T.scTabByNumber],
      ["⌘9", T.scLastTab],
    ],
  },
  {
    group: T.scPanels,
    items: [
      ["⌘D", T.scSplitRight],
      ["⌘⇧D", T.scSplitDown],
      ["⌘⌥ ← ↑ → ↓", T.scPanelInDirection],
      ["⌘⇧A", T.scPanelWaiting],
      ["⌘⇧↩", T.scMaximizePanel],
      // ⌃D is end of input: the shell exits, and the panel goes along with it.
      [["⌘W", "⌃D"], T.scClosePanel],
    ],
  },
  {
    group: T.scTerminal,
    items: [
      ["⌘K", T.scClearScreen],
      ["⌘C", T.scCopy],
      ["⌘V", T.scPaste],
      ["⌘⇧V", T.scPastePath],
      ["⌘A", T.scSelectAll],
    ],
  },
  {
    group: T.scBranchDiff,
    items: [
      ["V", T.scMarkViewed],
      ["S", T.scStageFile],
      ["⇧S", T.scStageFolder],
      ["A", T.scStageAll],
      ["⌘↩", T.scCommit],
      ["⌘R", T.scReloadDiff],
    ],
  },
  {
    group: T.scApp,
    items: [
      ["⌘,", T.scPreferences],
      ["⌘/", T.scThisList],
      ["⌘M", T.scMinimize],
      ["⌃⌘F", T.scFullScreen],
      ["⌘H", T.scHideTermiau],
      ["⌘Q", T.scQuit],
    ],
  },
];

/// The shared dialog shell (see ui.ts) — dark backdrop, box in the middle, esc
/// closes —, with the shortcut list inside.
const helpEl = element("div", "dialog");
helpEl.hidden = true;
const helpBox = element("div", "dialog-box help-box");
helpBox.tabIndex = -1;
const helpHead = element("div", "dialog-header");
const helpTitle = element("span", "dialog-title");
helpTitle.textContent = T.keyboardShortcuts;
const helpClose = footerButton("dialog-close", CLOSE_DIALOG_ICON, T.closeEsc);
helpHead.append(helpTitle, helpClose);
const helpList = element("div", "help-list");

function shortcutGroup(group: string, items: [string | string[], string][]): HTMLElement {
  const section = element("section", "help-group");
  const name = element("h3", "help-group-name");
  name.textContent = group;
  section.append(name);
  for (const [keyOf, what] of items) {
    const line = element("div", "help-line");
    const keys = element("span", "help-keys");
    for (const t of Array.isArray(keyOf) ? keyOf : [keyOf]) {
      const k = element("kbd", "help-key");
      k.textContent = t;
      keys.append(k);
    }
    const d = element("span", "help-what");
    d.textContent = what;
    line.append(d, keys);
    section.append(line);
  }
  return section;
}

for (const { group, items } of SHORTCUTS) helpList.append(shortcutGroup(group, items));
helpBox.append(helpHead, helpList);
helpEl.appendChild(helpBox);
document.body.appendChild(helpEl);

/// The active plugins' shortcuts, in a group of their own at the end. Redrawn on every
/// plugin reload; with none, the group goes away.
let pluginShortcuts: HTMLElement | undefined;

function setPluginShortcuts(rows: [string, string][]) {
  pluginShortcuts?.remove();
  pluginShortcuts = rows.length ? shortcutGroup(T.shortcutsPlugins, rows) : undefined;
  if (pluginShortcuts) helpList.append(pluginShortcuts);
}

// ---------- plugins (see src/plugins/host.ts) ----------

/// Who wants to know the user typed in a panel: plugins, through
/// `ctx.terminal.onUserInput` (Claude's plugin clears a waiting panel on it).
const userInputListeners = new Set<(id: number, data: string) => void>();
/// Who wants to know a panel got the keyboard (`ctx.terminal.onFocus`).
const focusListeners = new Set<(id: number) => void>();
/// Who wants to know a panel's folder, repository or branch changed (`ctx.terminal.onMoved`).
const movedListeners = new Set<(id: number) => void>();
/// Who wants back what it saved in restored panels, by plugin.
const restoredListeners = new Map<string, Set<(id: number, saved: string) => void>>();

/// The panels plugins can see — every one with a header bar — and who wants to know
/// when one opens or closes (the host, for the `panelHeader` slots).
const pluginPanels = new Map<number, Leaf>();
const panelOpened = new Set<(id: number) => void>();
const panelClosed = new Set<(id: number) => void>();

/// Who hears the socket's messages, by the plugin they are addressed to.
const socketListeners = new Map<string, Set<(panel: number, message: unknown, replyId?: string) => void>>();

/// A panel as plugin `owner` sees it.
function pluginPanel(leaf: Leaf, owner: string): Panel {
  return {
    id: leaf.id,
    get title() {
      return leaf.title;
    },
    setTitle: (title) => setTitle(leaf, owner, title),
    xterm: leaf.term,
    write: (text) => void invoke("pty_write", { id: leaf.id, data: text }).catch((e) => jlog(`plugin pty_write: ${e}`)),
    paste: (text) => paste(leaf, text),
    isAlive: () => !leaf.dead,
    cwd: () => invoke<string | null>("pty_cwd", { id: leaf.id }).catch(() => null),
    where: () => ({ folder: leaf.bar?.folder ?? null, repo: leaf.bar?.repo ?? null, branch: leaf.bar?.branch ?? null }),
    isBusy: () => invoke<boolean>("pty_busy", { id: leaf.id }).catch(() => false),
    focus: () => {
      const tab = tabOf(leaf);
      if (!tab || leaf.dead) return;
      if (tab !== active) activate(tab);
      focusLeaf(leaf);
    },
    notify: (text) => notify(leaf, text),
    setAlert: (on) => setAlert(leaf, owner, on),
    setStatus: (status) => {
      // Plugins report on every change they hear (a status line every few seconds):
      // only a different status redraws the tabs.
      leaf.statuses ??= new Map();
      if (leaf.statuses.get(owner) === status) return;
      if (status) leaf.statuses.set(owner, status);
      else leaf.statuses.delete(owner);
      paint();
    },
    side: () => pluginSide(leaf, owner),
    layer: () => {
      let layer = leaf.layers?.get(owner);
      if (layer) return layer;
      layer = element("div", "plugin-layer");
      layer.dataset.plugin = owner;
      layer.hidden = true;
      // Inside the terminal's element, not beside it: hiding the terminal would remove
      // the measure FitAddon computes the grid from, and the program would get a
      // SIGWINCH on every switch.
      leaf.el.querySelector(".leaf-screen")?.append(layer);
      (leaf.layers ??= new Map()).set(owner, layer);
      return layer;
    },
    setKeyboard: (target) => {
      leaf.keyboards ??= new Map();
      if (target) leaf.keyboards.set(owner, target);
      else leaf.keyboards.delete(owner);
      if (tabOf(leaf)?.focus === leaf) keyboard(leaf);
    },
    setSaved: (value) => {
      leaf.saved ??= {};
      if (leaf.saved[owner] === value) return;
      if (value === undefined) delete leaf.saved[owner];
      else leaf.saved[owner] = value;
      scheduleSave();
    },
  };
}

const SIDE_KEY = "termiau:plugin-side";

/// The plugins' panes' share of the panel (`Panel.side`): one for every panel and plugin.
let shareSide = readShareSide();
document.documentElement.style.setProperty("--plugin-side-share", `${(shareSide * 100).toFixed(2)}%`);

function readShareSide(): number {
  try {
    const share = Number(localStorage.getItem(SIDE_KEY) ?? NaN);
    return share >= 0.15 && share <= 0.85 ? share : 0.4;
  } catch {
    return 0.4;
  }
}

/// Plugin `owner`'s pane beside the terminal. Shown or hidden, the terminal is measured
/// again: it lost or got back the pane's share. The border before it drags the share.
function pluginSide(leaf: Leaf, owner: string): HTMLElement {
  const existing = leaf.sides?.get(owner);
  if (existing) return existing;
  const handle = element("div", "plugin-side-handle");
  const side = element("div", "plugin-side");
  side.dataset.plugin = owner;
  side.hidden = handle.hidden = true;
  leaf.el.querySelector(".leaf-term")?.append(handle, side);
  (leaf.sides ??= new Map()).set(owner, side);
  const remeasure = () => {
    const tab = tabOf(leaf);
    if (!tab || tab !== active || inDiff) return;
    measure(tab);
    scheduleSync(tab);
  };
  new MutationObserver(() => {
    handle.hidden = side.hidden;
    if (!side.isConnected) handle.remove();
    remeasure();
  }).observe(side, { attributes: true, attributeFilter: ["hidden"] });
  handle.addEventListener("pointerdown", (e) => {
    const host = side.parentElement;
    if (!host) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const mover = (ev: PointerEvent) => {
      const r = host.getBoundingClientRect();
      shareSide = Math.min(0.85, Math.max(0.15, (r.right - ev.clientX) / r.width));
      document.documentElement.style.setProperty("--plugin-side-share", `${(shareSide * 100).toFixed(2)}%`);
      remeasure();
    };
    const release = () => {
      handle.removeEventListener("pointermove", mover);
      handle.removeEventListener("pointerup", release);
      handle.removeEventListener("pointercancel", release);
      handle.classList.remove("dragging");
      try {
        localStorage.setItem(SIDE_KEY, String(shareSide));
      } catch {
        // Just a convenience.
      }
    };
    handle.addEventListener("pointermove", mover);
    handle.addEventListener("pointerup", release);
    handle.addEventListener("pointercancel", release);
  });
  return side;
}

/// Plugin `owner`'s title for the panel; `undefined` gives the terminal's back.
function setTitle(leaf: Leaf, owner: string, title: string | undefined) {
  const before = titleOf(leaf);
  leaf.titles ??= new Map();
  // Set again, it goes to the end: the last one set is the one shown.
  leaf.titles.delete(owner);
  if (title) leaf.titles.set(owner, title);
  const tab = tabOf(leaf);
  if (tab?.focus === leaf) rotular(tab);
  if (titleOf(leaf) !== before) drawBar(leaf);
}

/// Takes back what plugin `owner` left on the panels when it is turned off.
function clearPanels(owner: string) {
  for (const leaf of pluginPanels.values()) {
    if (leaf.titles?.has(owner)) setTitle(leaf, owner, undefined);
    setAlert(leaf, owner, false);
    if (leaf.statuses?.delete(owner)) paint();
    leaf.layers?.get(owner)?.remove();
    leaf.layers?.delete(owner);
    const side = leaf.sides?.get(owner);
    if (side) {
      side.previousElementSibling?.remove();
      side.remove();
      leaf.sides?.delete(owner);
      const tab = tabOf(leaf);
      if (tab && tab === active && !inDiff) {
        measure(tab);
        scheduleSync(tab);
      }
    }
    if (leaf.keyboards?.delete(owner) && tabOf(leaf)?.focus === leaf) keyboard(leaf);
  }
}

/// Restored panels whose plugin hadn't started yet: plugins start after the tabs.
const pendingRestored = new Map<number, Record<string, string>>();

/// What a restored panel brought back for each plugin, delivered to it now if it is
/// listening, or kept until it starts.
function deliverRestored(leaf: Leaf, saved: Record<string, string>) {
  leaf.saved = { ...saved };
  const pending: Record<string, string> = {};
  for (const [owner, value] of Object.entries(saved)) {
    const listeners = restoredListeners.get(owner);
    if (listeners?.size) for (const fn of listeners) fn(leaf.id, value);
    else pending[owner] = value;
  }
  if (Object.keys(pending).length) pendingRestored.set(leaf.id, pending);
}

function setAlert(leaf: Leaf, owner: string, on: boolean) {
  leaf.alerts ??= new Set();
  if (on) leaf.alerts.add(owner);
  else leaf.alerts.delete(owner);
  leaf.el.classList.toggle("alert", leaf.alerts.size > 0);
}

/// The app's dropdown with a plugin's items, beside the button that asked for it.
function pluginMenu(anchor: HTMLElement, items: MenuItem[]) {
  if (!menuEl.hidden && menuAncora === anchor) return closeMenu();
  const leaf = [...pluginPanels.values()].find((l) => l.el.contains(anchor)) ?? active?.focus;
  if (!leaf) return;
  menuEl.replaceChildren(
    ...items.map((o) => {
      const item = element("button", o.chosen ? "chosen" : "");
      item.textContent = o.label;
      if (o.hint) {
        const hint = element("span", "task-menu-kind");
        hint.textContent = o.hint;
        item.append(hint);
      }
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        closeMenu();
        o.onSelect();
      });
      return item;
    }),
  );
  openMenu(leaf, anchor);
}

const listenerSet = <T>(set: Set<T>, fn: T): Disposable => {
  set.add(fn);
  return { dispose: () => void set.delete(fn) };
};

const plugins = createPluginHost({
  language: language(),
  focusedPanel: (owner) => (active?.focus ? pluginPanel(active.focus, owner) : undefined),
  panel: (id, owner) => {
    const leaf = pluginPanels.get(id);
    return leaf && !leaf.dead ? pluginPanel(leaf, owner) : undefined;
  },
  panelIds: () => [...pluginPanels.keys()],
  panelHeader: (id) => pluginPanels.get(id)?.bar?.plugins,
  onPanelOpened: (fn) => void panelOpened.add(fn),
  onPanelClosed: (fn) => void panelClosed.add(fn),
  onFocus: (fn) => listenerSet(focusListeners, fn),
  onMoved: (fn) => listenerSet(movedListeners, fn),
  onRestored(owner, fn) {
    for (const [id, saved] of pendingRestored) {
      if (owner in saved && pluginPanels.has(id)) {
        fn(id, saved[owner]);
        delete saved[owner];
      }
    }
    const set = restoredListeners.get(owner) ?? new Set();
    restoredListeners.set(owner, set);
    return listenerSet(set, fn);
  },
  clearPanels,
  menu: pluginMenu,
  onSocket(owner, fn) {
    const set = socketListeners.get(owner) ?? new Set();
    socketListeners.set(owner, set);
    return listenerSet(set, fn);
  },
  socketReply: (id, answer) => invoke<void>("socket_reply", { id, answer }),
  socketDrop: (id) => void invoke("socket_drop", { id }).catch((e) => jlog(`socket_drop: ${e}`)),
  onUserInput: (listener) => listenerSet(userInputListeners, listener),
  openLink,
  mermaid: (root) => drawMermaid(root),
  openReference: (id, e) => {
    const leaf = pluginPanels.get(id);
    return !!leaf && referenceClick(leaf, e);
  },
  isShortcut: ourShortcut,
  differServe(name, handler) {
    differServices.set(name, handler);
    return {
      dispose() {
        if (differServices.get(name) === handler) differServices.delete(name);
      },
    };
  },
  differPublish(topic, value) {
    differTopics.set(topic, value);
    flash({ termiauTopic: { topic, value } });
  },
  differExtend(owner, main) {
    differExtensions.set(owner, main);
    announceExtensions();
    return {
      dispose() {
        if (differExtensions.get(owner) !== main) return;
        differExtensions.delete(owner);
        announceExtensions();
      },
    };
  },
  log: (m) => void jlog(m),
  restoreFocus: () => {
    if (active?.focus && !inDiff) focusLeaf(active.focus);
  },
  closeLabel: T.closeEsc,
  setShortcuts: setPluginShortcuts,
  ask: ({ title, text, confirm, cancel }) =>
    ask("plugin", { title: title, text: text, confirm: confirm, cancel: cancel }),
  texts: {
    cancel: T.cancel,
    ok: T.ok,
    installTitle: T.installPluginTitle,
    installText: T.installPluginText,
    installConfirm: T.installPluginConfirm,
    installedTitle: T.pluginInstalledTitle,
    installed: T.pluginInstalled,
    notInstalledTitle: T.pluginNotInstalledTitle,
    notInstalled: T.pluginNotInstalled,
    dependencyMissing: T.pluginDependencyMissing,
    dependencyOff: T.pluginDependencyOff,
    dependencyBroken: T.pluginDependencyBroken,
    dependencyCycle: T.pluginDependencyCycle,
  },
});

/// ⌘/ again with the list open closes it: it is the same key that brought it.
function toggleHelp() {
  if (!helpEl.hidden) return closeHelp();
  helpEl.hidden = false;
  helpBox.focus({ preventScroll: true });
}

function closeHelp() {
  helpEl.hidden = true;
  if (active?.focus && !inDiff) focusLeaf(active.focus);
}

helpEl.addEventListener("mousedown", (e) => {
  if (e.target === helpEl) closeHelp();
});
helpClose.addEventListener("click", () => closeHelp());
helpEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeHelp();
  }
});

// ---------- session: the tabs that come back ----------

/// A panel's snapshot: where it was and what each plugin wants back in it (the Claude
/// Code plugin: which session to resume). It is what goes to disk and what ⌘⇧T keeps
/// of a closed tab.
type SavedNode =
  | { kind: "leaf"; cwd: string | null; plugins?: Record<string, string> }
  | { kind: "split"; axis: Axis; fraction: number; children: [SavedNode, SavedNode] };

type SavedTab = {
  root: SavedNode;
  /// The focused panel, by its position among the tree's leaves.
  focus: number;
  /// The name given to the tab, if any.
  name?: string;
};

/// Something ⌘⇧T brings back: a whole tab, or a single panel — with the split it was in
/// (axis and share), to reopen beside the panel with the keyboard.
type Closed =
  | { tab: SavedTab }
  | { panel: Extract<SavedNode, { kind: "leaf" }>; axis: Axis; fraction: number };

/// The last closed tabs and panels, the most recent at the end. They go to disk with the
/// session: after a crash or a `kill`, ⌘⇧T still brings them back.
const closed: Closed[] = [];
const MAX_CLOSED = 10;

function storeClosed(f: Closed) {
  closed.push(f);
  if (closed.length > MAX_CLOSED) closed.shift();
  scheduleSave();
}

function savedClosed(x: unknown): Closed | undefined {
  const f = x as { tab?: unknown; panel?: unknown; axis?: unknown; fraction?: unknown } | null;
  if (!f || typeof f !== "object") return;
  if (f.tab) {
    const tab = savedTab(f.tab);
    return tab && { tab };
  }
  const panel = savedNode(f.panel);
  if (panel?.kind !== "leaf") return;
  const fraction = typeof f.fraction === "number" && Number.isFinite(f.fraction) ? Math.min(0.9, Math.max(0.1, f.fraction)) : 0.5;
  return { panel, axis: f.axis === "below" ? "below" : "side", fraction };
}

function snapshot(no: TreeNode): SavedNode {
  if (no.kind === "split") {
    return {
      kind: "split",
      axis: no.axis,
      fraction: no.fraction,
      children: [snapshot(no.children[0]), snapshot(no.children[1])],
    };
  }
  const plugins = no.saved && Object.keys(no.saved).length ? { ...no.saved } : undefined;
  return { kind: "leaf", cwd: no.bar?.folder ?? null, plugins };
}

function snapshotTab(tab: Tab): SavedTab {
  // With the keyboard in the drawer, the owner comes back focused: the drawer doesn't come back.
  const focus = [...leaves(tab.root)].indexOf(tab.focus.owner ?? tab.focus);
  return { root: snapshot(tab.root), focus: Math.max(0, focus), name: tab.name };
}

/// Checks the shape of what came from disk. A file from another version, or edited
/// by hand, must not break the app's launch: whatever doesn't fit is ignored.
function savedNode(x: unknown): SavedNode | undefined {
  const n = x as Partial<Record<string, unknown>> | null;
  if (!n || typeof n !== "object") return;
  if (n.kind === "leaf") {
    const cwd = typeof n.cwd === "string" ? n.cwd : null;
    const plugins: Record<string, string> = {};
    if (n.plugins && typeof n.plugins === "object") {
      for (const [k, v] of Object.entries(n.plugins)) if (typeof v === "string") plugins[k] = v;
    }
    return { kind: "leaf", cwd, plugins: Object.keys(plugins).length ? plugins : undefined };
  }
  if (n.kind !== "split" || !Array.isArray(n.children)) return;
  const a = savedNode(n.children[0]);
  const b = savedNode(n.children[1]);
  if (!a || !b) return a ?? b;
  const fraction = typeof n.fraction === "number" && Number.isFinite(n.fraction) ? n.fraction : 0.5;
  return {
    kind: "split",
    axis: n.axis === "below" ? "below" : "side",
    fraction: Math.min(0.9, Math.max(0.1, fraction)),
    children: [a, b],
  };
}

function savedTab(x: unknown): SavedTab | undefined {
  const a = x as { root?: unknown; focus?: unknown; name?: unknown } | null;
  const root = savedNode(a?.root);
  if (!root) return;
  const name = typeof a?.name === "string" && a.name.trim() ? a.name.trim() : undefined;
  return { root, focus: typeof a?.focus === "number" ? a.focus : 0, name };
}

function readSession(text: string | null): { tabs: SavedTab[]; active: number; closed: Closed[] } {
  const emptyOne = { tabs: [], active: 0, closed: [] };
  if (!text) return emptyOne;
  try {
    const given = JSON.parse(text) as { tabs?: unknown; active?: unknown; closed?: unknown } | null;
    if (!given || !Array.isArray(given.tabs)) return emptyOne;
    const closed = Array.isArray(given.closed) ? given.closed.flatMap((f) => savedClosed(f) ?? []) : [];
    const savedOnes = given.tabs.flatMap((a: unknown) => savedTab(a) ?? []);
    return { tabs: savedOnes, active: typeof given.active === "number" ? given.active : 0, closed: closed.slice(-MAX_CLOSED) };
  } catch (e) {
    jlog(`unreadable saved session: ${e}`);
    return emptyOne;
  }
}

/// True until the saved tabs finish coming back. Meanwhile nothing is
/// saved: the first tab to come back would save "one tab" over the others.
let restoring = true;
let waitSave: ReturnType<typeof setTimeout> | undefined;

/// Saves the current tabs. On every change, not only on quit: a crash, a
/// `kill` or the battery dying must also find the tabs on the way back.
function saveSession(): Promise<void> {
  clearTimeout(waitSave);
  if (restoring) return Promise.resolve();
  const data = JSON.stringify({
    version: 1,
    tabs: tabs.map(snapshotTab),
    active: active ? tabs.indexOf(active) : 0,
    closed,
  });
  return invoke<void>("session_save", { data: data }).catch((e) => {
    void jlog(`session_save: ${e}`);
  });
}

function scheduleSave() {
  clearTimeout(waitSave);
  waitSave = setTimeout(() => void saveSession(), 500);
}

function firstLeaf(no: SavedNode): Extract<SavedNode, { kind: "leaf" }> {
  return no.kind === "leaf" ? no : firstLeaf(no.children[0]);
}

/// Puts the panel back where it was, and hands each plugin what it saved there (the
/// Claude Code plugin types its `--resume`).
function resume(leaf: Leaf, savedItem: Extract<SavedNode, { kind: "leaf" }>) {
  // Until `loadProject` responds: quitting before that must not save the
  // panel without a folder.
  if (leaf.bar && savedItem.cwd) leaf.bar.folder ??= savedItem.cwd;
  if (savedItem.plugins) deliverRestored(leaf, savedItem.plugins);
}

/// Rebuilds the saved tree from a panel: each split divides the panel, the
/// first child stays in it and the second goes to the new one. `doneOnes`
/// comes out in leaf order, which is the order the focus was saved in.
async function build(tab: Tab, leaf: Leaf, savedItem: SavedNode, doneOnes: Leaf[]) {
  if (savedItem.kind === "leaf") {
    resume(leaf, savedItem);
    doneOnes.push(leaf);
    return;
  }
  const [a, b] = savedItem.children;
  const newOne = await splitLeaf(tab, leaf, savedItem.axis, firstLeaf(b).cwd, savedItem.fraction);
  await build(tab, leaf, a, doneOnes);
  // No shell for the second side, the first keeps the whole space.
  if (newOne) await build(tab, newOne, b, doneOnes);
}

/// Brings a tab back: the panels in the folders they were in, the layout as it
/// was, and what the plugins saved in them.
async function reopen(saved: SavedTab): Promise<Tab | undefined> {
  const tab = await newTab(firstLeaf(saved.root).cwd);
  if (!tab) return;
  tab.name = saved.name;
  showTicker(tab);
  busy = true;
  try {
    const doneOnes: Leaf[] = [];
    await build(tab, tab.focus, saved.root, doneOnes);
    focusLeaf(doneOnes[saved.focus] ?? doneOnes[0]);
  } finally {
    busy = false;
  }
  return tab;
}

/// ⌘⇧T: the last closed tab or panel comes back, like in the browser. A panel
/// reopens beside the one with the keyboard, split the way it was, with what its plugins saved.
async function reopenClosed() {
  const saved = closed.pop();
  if (!saved) return;
  const cameBack = "tab" in saved ? !!(await reopen(saved.tab)) : await reopenPanel(saved);
  // It didn't open (another shortcut in the meantime): the snapshot goes back on the stack.
  if (!cameBack) closed.push(saved);
  scheduleSave();
}

async function reopenPanel(savedItem: Extract<Closed, { panel: unknown }>): Promise<boolean> {
  // With the diff in front, or no tab at all, it comes back as a tab of its own.
  if (!active || inDiff || busy) return !active && !!(await reopen({ root: savedItem.panel, focus: 0 }));
  const tab = active;
  const target = tab.focus.owner ?? tab.focus;
  busy = true;
  try {
    const newOne = await splitLeaf(tab, target, savedItem.axis, savedItem.panel.cwd, savedItem.fraction);
    if (!newOne) return false;
    resume(newOne, savedItem.panel);
    focusLeaf(newOne);
    return true;
  } finally {
    busy = false;
  }
}

/// The last run's tabs, at app launch. With none to bring back — the
/// first time, or the last tab was closed by hand —, opens a new one.
async function restoreSession() {
  const saved = readSession(await invoke<string | null>("session_read").catch(() => null));
  closed.push(...saved.closed);
  try {
    for (const a of saved.tabs) await reopen(a);
    if (!tabs.length) await newTab();
    else activate(tabs[saved.active] ?? tabs[0]);
  } finally {
    restoring = false;
    scheduleSave();
  }
}

// ---------- the dialog ----------

/// A question in the middle of the window, in the shared dialog shell (see ui.ts). The
/// confirm button is born with the keyboard: space or ↩ confirm, esc
/// cancels. Without `cancel` it is just a notice, with one button.
/// `alternative`: a third answer, on the left (the "Discard" beside "Cancel" and "Save").
type Question = { title: string; text: string; confirm: string; cancel?: string; alternative?: string };
type Answer = "yes" | "no" | "alternative";

const questionEl = element("div", "dialog");
questionEl.hidden = true;
const questionBox = element("div", "dialog-box question-box");
questionBox.setAttribute("role", "alertdialog");
const questionTitle = element("span", "dialog-title");
const questionText = element("p", "question-text");
const questionButtons = element("div", "question-buttons");
const questionAlternative = element("button", "question-btn question-alternative");
const questionNot = element("button", "question-btn");
const questionYes = element("button", "question-btn question-yes");
questionButtons.append(questionAlternative, questionNot, questionYes);
questionBox.append(questionTitle, questionText, questionButtons);
questionEl.appendChild(questionBox);
document.body.appendChild(questionEl);

/// The one on screen: which it is and how to answer it.
let questionOpen: { key: string; promise: Promise<Answer>; reply: (r: Answer) => void } | undefined;

/// `key` says which question it is. The same one, asked again with the box open (a
/// second ⌘Q), only refocuses the keyboard; another takes its place, and the previous one is
/// answered with "no".
function ask(key: string, p: Question): Promise<boolean> {
  return choose(key, p).then((r) => r === "yes");
}

/// `ask` with the third answer: which of the three buttons it was.
function choose(key: string, p: Question): Promise<Answer> {
  if (questionOpen?.key === key) {
    questionYes.focus();
    return questionOpen.promise;
  }
  questionOpen?.reply("no");

  const label = (b: HTMLButtonElement, text: string, keyOf: string) => {
    const k = document.createElement("kbd");
    k.textContent = keyOf;
    b.replaceChildren(text, k);
  };
  questionTitle.textContent = p.title;
  questionText.textContent = p.text;
  label(questionYes, p.confirm, "↩");
  questionNot.hidden = !p.cancel;
  if (p.cancel) label(questionNot, p.cancel, "esc");
  questionAlternative.hidden = !p.alternative;
  questionAlternative.textContent = p.alternative ?? "";

  let reply!: (r: Answer) => void;
  const promise = new Promise<Answer>((resolve) => {
    reply = (yes) => {
      if (questionOpen?.promise !== promise) return;
      questionOpen = undefined;
      questionEl.hidden = true;
      // The keyboard goes back where it was — a panel, or the diff tab.
      if (inDiff) pinned?.frame.contentWindow?.focus();
      else if (active?.focus) focusLeaf(active.focus);
      resolve(yes);
    };
  });
  questionOpen = { key, promise, reply };
  questionEl.hidden = false;
  questionYes.focus();
  return promise;
}

questionEl.addEventListener("mousedown", (e) => {
  if (e.target === questionEl) questionOpen?.reply("no");
});
questionAlternative.addEventListener("click", () => questionOpen?.reply("alternative"));
questionNot.addEventListener("click", () => questionOpen?.reply("no"));
questionYes.addEventListener("click", () => questionOpen?.reply("yes"));
questionEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    questionOpen?.reply("no");
    return;
  }
  // The keyboard doesn't leave the box: tab and the arrows only move between the
  // buttons on screen. Space and ↩ belong to the focused button itself.
  if (e.key === "Tab" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const buttons = [questionAlternative, questionNot, questionYes].filter((b) => !b.hidden);
    const step = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  }
});

// ---------- quitting: ⌘Q asks first ----------

let leaving = false;

/// Saves the tabs and quits. The save's `await` is what guarantees the
/// last change (a `cd`, a new session) reached the disk before the
/// process goes away.
async function quit() {
  if (leaving) return;
  leaving = true;
  await saveSession();
  await invoke("quit").catch((e) => jlog(`quit: ${e}`));
}

/// Quitting takes away all the shells and whatever is running in them, and ⌘Q lives
/// next to ⌘W and ⌘A.
async function askQuit() {
  if (leaving) return;
  const panels = tabs.flatMap((a) => [...leaves(a.root)]);
  const resuming = panels.filter((f) => f.saved && Object.keys(f.saved).length).length;
  const howMany = T.tabCloses(tabs.length);
  const back = resuming === 0 ? T.comeBackInFolders : T.comeBackResuming(resuming);
  const yes = await ask("quit", {
    title: T.quitTermiau,
    text: T.quitText(howMany, back),
    confirm: T.quit,
    cancel: T.cancel,
  });
  if (yes) await quit();
}

// ---------- keyboard ----------

function shortcut(e: Shortcut) {
  // Navigating between panels and clearing the screen are terminal things: with the diff in
  // front there is no panel to refer to.
  if (e.altKey && active && !inDiff) {
    const target = neighbor(active.focus, e.code.slice(5) as "Left" | "Right" | "Up" | "Down");
    if (target) focusLeaf(target);
    return;
  }
  if (e.shiftKey) {
    if (e.code === "KeyA") return goToWaiting();
    return goToTab(e.code === "BracketRight" ? 1 : -1);
  }

  if (e.key === "k") {
    if (!inDiff) active?.focus.term.clear();
    return;
  }

  // ⌘` is the pinned tab, and all the numbers go to the terminals. By `code`,
  // not by `key`: on ABNT2 the backtick is a dead key and `key` doesn't arrive as "`".
  if (e.code === "Backquote") return void (pinned && openPinned());
  // ⌘9 goes to the last one, not the ninth — it is the macOS standard.
  const n = Number(e.key);
  const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (target) activate(target);
}

window.addEventListener("keydown", (e) => {
  if (!ourShortcut(e)) return;
  e.preventDefault();
  shortcut(e);
});

// A key pressed inside the pinned tab belongs to another document and doesn't bubble up
// here: the differ's bridge forwards it, and from here it counts the same. The origin is
// checked in `source` — no other window talks to this one.
window.addEventListener("message", (e) => {
  // The floating preferences only say they closed; TermIAu's keys wait until then.
  if (prefsFrame && e.source === prefsFrame.contentWindow) {
    const given = e.data as { termiauPrefsReady?: boolean; termiauPrefsClosed?: boolean } | null;
    // Shown only once drawn: loading, the page flashes white.
    if (given?.termiauPrefsReady) {
      prefsFrame.classList.add("ready");
      prefsFrame.contentWindow?.focus();
    }
    if (given?.termiauPrefsClosed) closePreferences();
    return;
  }
  if (!pinned || e.source !== pinned.frame.contentWindow) return;
  const given = e.data as {
    termiau?: Shortcut;
    termiauPronto?: boolean;
    termiauRepoOpen?: string | null;
    termiauWantsTopics?: boolean;
    termiauCall?: { id: string; name: string; args?: Record<string, unknown> };
    termiauGoToPanel?: number;
  } | null;

  if (given?.termiauWantsTopics) return publishTopics();
  if (given?.termiauCall) return void differCall(given.termiauCall);
  if (typeof given?.termiauGoToPanel === "number") {
    const leaf = leafByPanel(given.termiauGoToPanel);
    const tab = leaf && tabOf(leaf);
    if (leaf && tab) {
      activate(tab);
      focusLeaf(leaf);
    }
    return;
  }

  // A repository was opened or closed in there: it is what lights up and dims the chip.
  if (given && "termiauRepoOpen" in given) {
    enablePinned(given.termiauRepoOpen ?? null);
    return;
  }

  // The differ reports when it starts listening. A request that arrived before
  // that was stored waiting for exactly this notice.
  if (given?.termiauPronto) {
    pinned.ready = true;
    const queue = pinned.queue.splice(0);
    for (const msg of queue) pinned.frame.contentWindow?.postMessage(msg, "*");
    // The page may have reloaded with the tab already open (a dev reload, a
    // webview crash): it didn't see the `openPinned` that put it on screen.
    flash({ termiauVisible: inDiff });
    return;
  }

  if (given?.termiau && ourShortcut(given.termiau)) shortcut(given.termiau);
});

// ---------- lifecycle ----------

async function wireEvents() {
  // xterm switches the cursor to the inactive style when the terminal loses focus,
  // but only rereads that when redrawing a line — and the app may go to the background
  // without the textarea getting `blur`. With nothing triggering a redraw, the little paw
  // kept blinking in a window that was no longer the top one. The window's event
  // is what knows about the background, so that is where we take the blur from.
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (!active || inDiff) return;
    if (!focused) active.focus.term.blur();
    // If a click already gave the keyboard back to a panel, we don't steal it back.
    else if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName ?? "")) keyboard(active.focus);
  });

  // Focus entering the pinned tab's iframe without it being on screen is theft: something in
  // there called `focus()` (a git notice, for example) and the panel was left without the
  // keyboard. The top window gets `blur` when focus goes down into the iframe.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (active && !inDiff && pinned && document.activeElement === pinned.frame) keyboard(active.focus);
    });
  });

  // What runs in the panels talks to the app here, via a unix socket (see
  // listen_socket in Rust).
  await listen<string>("socket://message", (e) => {
    try {
      const raw = JSON.parse(e.payload);
      // `termiau view` uses the same socket as the hooks (see hooks/termiau).
      if (raw && typeof raw === "object" && "view" in raw) receiveView(raw as SocketViewRequest);
      // `termiau progress`, already checked by Rust (see progress.rs).
      else if (raw && typeof raw === "object" && "progress" in raw) receiveProgress(raw as SocketPlan);
      else if (raw && typeof raw === "object" && typeof raw.panel === "number" && typeof raw.plugin === "string")
        receive(raw as SocketMessage);
    } catch (err) {
      jlog(`unreadable socket message: ${err}`);
    }
  });


  // The bar's "+" does what ⌘T does — it is the same path, just within reach of the
  // mouse. `void` because the click doesn't wait for the tab to open.
  const more = document.getElementById("new-tab");
  more?.addEventListener("click", () => void newTab());
  more?.setAttribute("title", T.newTabHint);
  more?.setAttribute("aria-label", T.newTab);

  // ⌘T, ⌘D, ⌘⇧D, ⌘⇧↩ and ⌘W arrive here: the native menu is what gets the key.
  await listen("menu://new-tab", () => newTab());
  await listen("menu://reopen-tab", () => reopenClosed());
  await listen("menu://quit", () => askQuit());
  // The red button and "Close Window" also quit the app: they go through the
  // same question. What really quits is `quit`, which doesn't ask to close the
  // window — it ends the process.
  await appWindow.onCloseRequested((e) => {
    e.preventDefault();
    void askQuit();
  });
  await listen("menu://split-right", () => split("side"));
  await listen("menu://split-down", () => split("below"));
  await listen("menu://maximize", () => {
    if (active && !inDiff) toggleMaximize(active.focus.owner ?? active.focus);
  });
  await listen("menu://close", () => {
    if (active && !inDiff) closeLeaf(active.focus);
  });
  await listen("menu://viewer", () => {
    if (active && !inDiff) toggleViewer(active.focus.owner ?? active.focus);
  });
  await listen("menu://paste-path", () => pastePath());
  await listen("menu://preferences", () => openPreferences());
  await listen("menu://shortcuts", () => toggleHelp());

  // The .git of the repository open in the diff tab changed. It only passes it on: the tab
  // decides what to do with it, and it only exists after someone opens it.
  await listen<string>("differ://changed", (e) => {
    if (pinned?.ready) flash({ termiauChanged: e.payload });
  });

  await wireDrag();
}

async function openTabs() {
  // A webview reload clears the tabs but not the shells: without this they would stay
  // alive, with nobody reading, on every dev server reload.
  await invoke("pty_close_all");
  // Before the first tab: it is what puts its chip at the start of the bar, and from there
  // it doesn't leave — `wireDragging` only reorders what is in the `tabs` array.
  buildMenu();
  createPinned();
  await restoreSession();
}

function afterTabs() {

  // Window resize: only the visible tab has a size to measure; the
  // others adjust when they show up again (see `activate`).
  // Watch the body, NOT the panels: fit() changes the panel and would feed the observer back.
  new ResizeObserver(() => {
    if (!active || inDiff) return;
    measure(active); // the local render follows the drag, frame by frame
    scheduleSync(active);
  }).observe(document.body);
}

// In a function, not loose in the module: top-level `await` doesn't pass Vite's build
// target, and `npm run build` would break even with dev working.
start({
  fonts: () => document.fonts.ready,
  connect: wireEvents,
  openTabs,
  after: afterTabs,
  activatePlugins: () => void plugins.start(),
});
void wirePreferences();
