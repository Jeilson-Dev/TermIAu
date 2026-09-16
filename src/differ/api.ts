import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo, ReviewDiff } from "./types";

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });

export const loadDiff = (path: string, target: string) =>
  invoke<ReviewDiff>("load_diff", { path, target });

/** What changed since a reviewed commit; `mergeBase` (and `target`) come back as that commit. */
export const loadDiffSince = (path: string, base: string) =>
  invoke<ReviewDiff>("load_diff_since", { path, base });

export const readBlob = (path: string, oid: string) => invoke<string[]>("read_blob", { path, oid });

/** Passa a vigiar o .git deste repositório; o aviso volta em `differ://mudou`. */
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

export const readBlobBytes = (path: string, oid: string) =>
  invoke<ArrayBuffer>("read_blob_bytes", { path, oid });
