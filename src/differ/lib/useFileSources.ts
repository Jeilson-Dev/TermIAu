import { useEffect, useState } from "react";
import type { FileDiff } from "../types";
import { getBlob } from "./blobs";
import { langFor, tokenize } from "./highlight";
import type { ContextSource } from "./rows";
import type { Token } from "./segments";

export interface Sources {
  /** Full content used to expand hidden context. */
  context: ContextSource | null;
  oldTokens: Token[][] | null;
  newTokens: Token[][] | null;
}

const EMPTY: Sources = { context: null, oldTokens: null, newTokens: null };

/** Loads both versions of a file once it's on screen: for expanding context and syntax colors. */
export function useFileSources(root: string, file: FileDiff, enabled: boolean): Sources {
  const [sources, setSources] = useState<Sources>(EMPTY);

  useEffect(() => {
    if (!enabled || file.binary || file.submodule) return;
    let cancelled = false;
    const load = (oid: string | null) => (oid ? getBlob(root, oid) : Promise.resolve(null));

    (async () => {
      const [oldLines, newLines] = await Promise.all([load(file.oldOid), load(file.newOid)]);
      if (cancelled) return;
      const context: ContextSource | null = newLines
        ? { side: "new", lines: newLines }
        : oldLines && { side: "old", lines: oldLines };
      setSources((s) => ({ ...s, context }));

      const lang = langFor(file.path);
      if (!lang) return;
      const hasDeletions = file.deletions > 0;
      const [oldTokens, newTokens] = await Promise.all([
        hasDeletions && oldLines && file.oldOid ? tokenize(file.oldOid, oldLines, lang) : null,
        newLines && file.newOid ? tokenize(file.newOid, newLines, lang) : null,
      ]);
      if (!cancelled) setSources((s) => ({ ...s, oldTokens, newTokens }));
    })().catch(() => {
      // Without the blobs the diff still renders, just without colors or expansion.
    });

    return () => {
      cancelled = true;
    };
  }, [root, file, enabled]);

  return sources;
}
