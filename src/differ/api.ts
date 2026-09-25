import { invoke } from "@tauri-apps/api/core";
import type { ClaudeSession, RepoInfo, ReviewDiff } from "./types";

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

/** As sessões do Claude Code abertas neste repositório, da mais recente para a mais antiga. */
export const claudeSessions = (path: string) => invoke<ClaudeSession[]>("claude_sessions", { path });

/**
 * Pergunta ao Claude (`claude -p`) sem salvar sessão nenhuma. `context` vai pelo stdin; `session`
 * faz a pergunta rodar numa cópia dessa sessão, sabendo do que já foi conversado nela. Só conversa:
 * editar os arquivos do repositório só com `allowEdits`.
 */
export const askClaude = (
  path: string,
  id: string,
  question: string,
  context: string,
  model: string | null,
  session: string | null,
  allowEdits = false,
) => invoke<AskResult>("ask_claude", { path, id, question, context, model, session, allowEdits });

/** Um arquivo que o Claude mexeu: como estava e como ficou (`null`: não existia / foi apagado). */
export interface AskChange {
  path: string;
  before: string | null;
  after: string | null;
  /** Dá para voltar ao `before`. Sem ele (binário, ignorado pelo git), só se sabe que mexeu. */
  undoable: boolean;
}

export interface AskResult {
  answer: string;
  /** Só com alterações liberadas; vazio quando ele não mexeu em nada. */
  changes: AskChange[];
}

/** Volta os arquivos ao que eram antes da pergunta; devolve os que não deu (mexidos de novo depois). */
export const undoAsk = (path: string, changes: AskChange[]) => invoke<string[]>("undo_ask", { path, changes });

export const cancelAsk = (id: string) => invoke<void>("cancel_ask", { id });
