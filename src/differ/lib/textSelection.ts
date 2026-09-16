import type { Side } from "../types";

/** Text selected in the diff's code, as the lines of one side it covers. */
export interface TextSelection {
  side: Side;
  start: number;
  end: number;
  /** The selected characters, without line numbers or diff signs. */
  quote: string;
}

/** Length of the text between the start of `el` and a point inside it. */
function offsetIn(el: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * Reads the page selection when it lies in the code of `container` (cells marked `.code-text`).
 * A selection crossing both sides keeps the side it started on in split view, and the new side
 * in unified view, where context and added lines both belong to the new file.
 */
export function readTextSelection(container: HTMLElement, split: boolean): TextSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const cells = [...container.querySelectorAll<HTMLElement>(".code-text")].filter((el) =>
    range.intersectsNode(el),
  );
  if (cells.length === 0) return null;

  const start = range.startContainer;
  const startCell = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>(".code-text");
  const side: Side = split
    ? ((startCell ?? cells[0]).dataset.side as Side)
    : cells.some((el) => el.dataset.side === "new")
      ? "new"
      : "old";

  const parts = cells
    .filter((el) => el.dataset.side === side)
    .map((el) => {
      const text = el.textContent ?? "";
      const from = el.contains(range.startContainer) ? offsetIn(el, range.startContainer, range.startOffset) : 0;
      const to = el.contains(range.endContainer) ? offsetIn(el, range.endContainer, range.endOffset) : text.length;
      return { line: Number(el.dataset.line), text: text.slice(from, to) };
    });
  // A selection ending at the very start of a line (triple click) touches it without taking any of it.
  while (parts.length > 0 && !parts[0].text) parts.shift();
  while (parts.length > 0 && !parts[parts.length - 1].text) parts.pop();
  if (parts.length === 0) return null;

  return {
    side,
    start: parts[0].line,
    end: parts[parts.length - 1].line,
    quote: parts.map((p) => p.text).join("\n"),
  };
}
