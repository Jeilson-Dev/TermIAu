// What plugins add to the diff tab itself (`ctx.differ.extend`). A plugin's script is
// loaded into this page, next to the App, and gives back a `DifferExtension`: tools
// for a passage (a bookmark, the note being written, a selection) and boxes it draws
// under lines of a file. The top document says which scripts there are — again when
// a plugin is turned on or off.
//
// The script renders with this page's React (`window.termiauDiffer`): a second copy
// of React can't draw inside this tree.

import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { IconName } from "../components/Icons";
import type { FileDiff, Side } from "../types";

/** Lines of a file the reviewer is looking at. */
export interface Passage {
  path: string;
  side: Side;
  start: number;
  end: number;
  /** The selected text, when it isn't about whole lines. */
  quote?: string;
  /** Came from a bookmark: its id and its comment. */
  bookmarkId?: string;
  note?: string;
}

export interface PassageTool {
  /** Becomes the button's class, `tool-<id>`. */
  id: string;
  icon: IconName;
  /** The button beside the note being written, and on a selection. */
  label: string;
  /** The tooltip on a bookmark, beside the note being written, on a selection. */
  titles: { bookmark: string; note: string; selection: string };
  /** `text`: what was already written in the note. */
  run(passage: Passage, text?: string): void;
}

/** A box the extension shows under the passage's last line. */
export interface PassageBox {
  key: string;
  passage: Passage;
}

export interface BoxContext {
  root: string;
  /** The version of the file on screen now. */
  file: FileDiff;
  /** Saves `note` as the passage's bookmark — rewriting the one it came from. */
  bookmark(note: string): Promise<void>;
}

export interface DifferExtension {
  tools?: PassageTool[];
  boxes?: {
    /** The file's boxes; the same array as long as nothing in them changes. */
    of(path: string): PassageBox[];
    subscribe(listener: () => void): () => void;
    render(box: PassageBox, ctx: BoxContext): ReactNode;
  };
  /** Takes back what it put in the page (its stylesheet). */
  dispose?(): void;
}

export type DifferExtensionModule = { activate(): DifferExtension };

declare global {
  interface Window {
    termiauDiffer?: { React: typeof React; jsx: typeof jsx };
  }
}

const inFrame = typeof window !== "undefined" && window.parent !== window;
let loaded: { id: string; main: string; ext?: DifferExtension }[] = [];
/// Modules being imported: the list may arrive again before they finish.
const loading = new Set<string>();
/// The last list the top document sent.
let wanted: { id: string; main: string }[] = [];
const listeners = new Set<() => void>();
const NONE: PassageBox[] = [];
let tools: PassageTool[] = [];
let boxesCache = new Map<string, PassageBox[]>();
let unsubscribers: (() => void)[] = [];

function changed() {
  tools = loaded.flatMap((l) => l.ext?.tools ?? []);
  boxesCache = new Map();
  for (const u of unsubscribers) u();
  unsubscribers = loaded.flatMap((l) => {
    const b = l.ext?.boxes;
    return b ? [b.subscribe(boxesChanged)] : [];
  });
  for (const l of listeners) l();
}

function boxesChanged() {
  boxesCache = new Map();
  for (const l of listeners) l();
}

async function load(list: { id: string; main: string }[]) {
  wanted = list;
  for (const l of loaded) {
    if (list.some((x) => x.id === l.id && x.main === l.main)) continue;
    try {
      l.ext?.dispose?.();
    } catch (e) {
      console.error(`differ extension ${l.id}: dispose failed`, e);
    }
  }
  const kept = loaded.filter((l) => list.some((x) => x.id === l.id && x.main === l.main));
  const fresh = list.filter((x) => !kept.some((l) => l.id === x.id) && !loading.has(x.main));
  loaded = kept;
  changed();
  for (const x of fresh) {
    loading.add(x.main);
    try {
      const mod = (await import(/* @vite-ignore */ x.main)) as Partial<DifferExtensionModule>;
      if (typeof mod.activate !== "function") throw new Error("exports no activate()");
      // Turned off while it was loading.
      if (!wanted.some((w) => w.main === x.main)) continue;
      loaded = [...loaded, { ...x, ext: mod.activate() }];
      changed();
    } catch (e) {
      console.error(`differ extension ${x.id}: failed to load`, e);
    } finally {
      loading.delete(x.main);
    }
  }
}

if (inFrame) {
  window.termiauDiffer = { React, jsx };
  window.addEventListener("termiau:extensions", (e) => void load((e as CustomEvent<{ id: string; main: string }[]>).detail));
  // The list arrives with the plugins' topics, asked for once the page is up.
  window.parent.postMessage({ termiauWantsTopics: true }, "*");
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The passage tools of the loaded extensions. */
export function usePassageTools(): PassageTool[] {
  return useSyncExternalStore(subscribe, () => tools);
}

/** The boxes of the file, from every extension, with what draws each one. */
export function useBoxes(path: string): { box: PassageBox; render: (ctx: BoxContext) => ReactNode }[] {
  const boxes = useSyncExternalStore(subscribe, () => {
    let list = boxesCache.get(path);
    if (!list) {
      list = loaded.flatMap((l) => l.ext?.boxes?.of(path) ?? []);
      if (!list.length) list = NONE;
      boxesCache.set(path, list);
    }
    return list;
  });
  return useMemo(
    () =>
      boxes.map((box) => {
        const owner = loaded.find((l) => l.ext?.boxes?.of(path).includes(box));
        return { box, render: (ctx: BoxContext) => owner?.ext?.boxes?.render(box, ctx) ?? null };
      }),
    [boxes, path],
  );
}
