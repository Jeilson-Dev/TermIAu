/// The small UI pieces the core and the plugins share: the footer button, the
/// dialog shell and the marquee. They used to be the radio's; the help, the
/// confirm dialog and the branch name borrowed them, and now the plugin API hands
/// them out (see src/plugins/api.ts).

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

/// Like the panel bar's buttons: the click doesn't take the keyboard from the terminal.
/// You press ▶ and keep typing where you left off.
export function footerButton(className: string, iconHtml: string, title: string): HTMLButtonElement {
  const b = element("button", `footer-btn ${className}`);
  b.innerHTML = iconHtml;
  b.title = title;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/// A dialog's ✕: drawn like the differ's Preferences one — 16px and a 1.5 stroke, in a
/// 24px button —, so every dialog closes with the same ✕.
export const CLOSE_DIALOG_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" transform="rotate(45 8 8)"/></svg>`;

export type DialogShell = {
  root: HTMLDivElement;
  box: HTMLDivElement;
  header: HTMLDivElement;
  title: HTMLSpanElement;
  close: HTMLButtonElement;
};

/// The shell alone: backdrop, box, header with title and ✕. Hidden and already in the
/// page. Who builds it wires the closing.
export function dialogShell(title: string, closeLabel: string, boxClass = ""): DialogShell {
  const root = element("div", "dialog");
  root.hidden = true;
  const box = element("div", `dialog-box ${boxClass}`.trim());
  // The box takes the keyboard when it opens (esc, the arrows in a list), not ✕:
  // focused, it would show as pressed.
  box.tabIndex = -1;
  const header = element("div", "dialog-header");
  const titleEl = element("span", "dialog-title");
  titleEl.textContent = title;
  const close = footerButton("dialog-close", CLOSE_DIALOG_ICON, closeLabel);
  header.append(titleEl, close);
  box.append(header);
  root.appendChild(box);
  document.body.appendChild(root);
  return { root, box, header, title: titleEl, close };
}

/// A shell that opens and closes itself: esc, ✕ and a click on the backdrop close it
/// — a click on the box doesn't: `e.target` is the backdrop only when the pointer
/// landed outside the box.
export function createDialog(
  title: string,
  closeLabel: string,
  onClosed: () => void,
  boxClass = "",
): DialogShell & { body: HTMLDivElement; open(): void; closeDialog(): void; dispose(): void } {
  const shell = dialogShell(title, closeLabel, boxClass);
  const body = element("div", "dialog-body");
  shell.box.append(body);

  const closeDialog = () => {
    if (shell.root.hidden) return;
    shell.root.hidden = true;
    onClosed();
  };
  shell.root.addEventListener("mousedown", (e) => {
    if (e.target === shell.root) closeDialog();
  });
  shell.close.addEventListener("click", closeDialog);
  shell.root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
    }
  });

  return {
    ...shell,
    body,
    open() {
      shell.root.hidden = false;
      shell.box.focus({ preventScroll: true });
    },
    closeDialog,
    dispose() {
      shell.root.remove();
    },
  };
}

/// How long the text takes to move one pixel. ~33 px/s: readable without
/// chasing it, and slow enough not to pull the eye of whoever is
/// looking at the terminal.
const MARQUEE_MS_PER_PX = 30;
/// The pause, after the whole text has gone by. It is the strip's normal state —
/// the scroll is the exception, and happens twice a minute.
const MARQUEE_PAUSE_MS = 30_000;
/// A rest at the end, with the text's tail in view, before going back to the start. Without
/// it the last word would appear and vanish in the same frame.
const MARQUEE_END_MS = 1_500;
/// And one at the start, so new text is read from the beginning before it starts moving.
const MARQUEE_START_MS = 1_200;

/// Each box's scroll in progress. It is per box because there are several: the radio and
/// each panel's branch.
const marquees = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export const isMarqueeRunning = (box: HTMLElement): boolean => marquees.has(box);

/// Makes the text scroll when it doesn't fit the box: moves to the end, waits
/// a bit, goes back to the start and stops for thirty seconds — and again. If it fits, it
/// does nothing: scrolling a text entirely in view would be moving for the sake of it.
///
/// Call it only when the text CHANGES. Redoing the scroll on every redraw would leave it
/// stuck on the first pixel.
export function marquee(box: HTMLElement, text: HTMLElement) {
  clearTimeout(marquees.get(box));
  marquees.delete(box);
  text.style.transition = "none";
  text.style.transform = "translateX(0)";

  // Before the window appears everything measures zero. It isn't an error case: the next
  // text — and one always comes — measures again with the box already on screen.
  const overflow = text.scrollWidth - box.clientWidth;
  if (overflow <= 1) return;

  const forward = () => {
    const duration = overflow * MARQUEE_MS_PER_PX;
    text.style.transition = `transform ${duration}ms linear`;
    text.style.transform = `translateX(${-overflow}px)`;
    marquees.set(box, setTimeout(back, duration + MARQUEE_END_MS));
  };

  const back = () => {
    // Back to the start without a transition: the way back has nothing to
    // read, and unrolling the text in front of whoever read it is worse than a cut.
    text.style.transition = "none";
    text.style.transform = "translateX(0)";
    marquees.set(box, setTimeout(forward, MARQUEE_PAUSE_MS));
  };

  marquees.set(box, setTimeout(forward, MARQUEE_START_MS));
}

/// Stops a box's scroll, for a plugin taking its slot away.
export function stopMarquee(box: HTMLElement) {
  clearTimeout(marquees.get(box));
  marquees.delete(box);
}
