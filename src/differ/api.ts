import { invoke } from "@tauri-apps/api/core";
import type { RepoInfo, ReviewDiff } from "./types";

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });

export const loadDiff = (path: string, target: string) =>
  invoke<ReviewDiff>("load_diff", { path, target });

/** What changed since a reviewed commit; `mergeBase` (and `target`) come back as that commit. */
export const loadDiffSince = (path: string, base: string) =>
  invoke<ReviewDiff>("load_diff_since", { path, base });

/** Assinatura barata do estado do disco: muda quando muda o que a aba pendente mostra. */
export const workingStamp = (path: string) => invoke<string>("working_stamp", { path });

/** O que está para ser commitado: índice, árvore de trabalho e arquivos que o git não rastreia. */
export const loadDiffWorking = (path: string) => invoke<ReviewDiff>("load_diff_working", { path });

/**
 * As três únicas chamadas que escrevem no repositório. O alvo é um arquivo, uma
 * pasta ou "." para tudo o que há no repositório.
 */
export const stage = (path: string, target: string) => invoke<void>("stage", { path, target });

export const unstage = (path: string, target: string) => invoke<void>("unstage", { path, target });

/** Commita o que está no índice e devolve o sha do commit novo. */
export const commitIndex = (path: string, message: string) =>
  invoke<string>("commit", { path, message });

export const readBlob = (path: string, oid: string) => invoke<string[]>("read_blob", { path, oid });

/** O arquivo como está no disco: o lado novo do diff da árvore de trabalho não tem blob. */
export const readWorktree = (path: string, file: string) =>
  invoke<string[]>("read_worktree", { path, file });

/** Passa a vigiar o .git deste repositório; o aviso volta em `differ://mudou`. */
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

export const readBlobBytes = (path: string, oid: string) =>
  invoke<ArrayBuffer>("read_blob_bytes", { path, oid });

export const readWorktreeBytes = (path: string, file: string) =>
  invoke<ArrayBuffer>("read_worktree_bytes", { path, file });
