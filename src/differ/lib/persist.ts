// Local persistence (a JSON file in the app's data folder).

import { load, type Store } from "@tauri-apps/plugin-store";
import type { Bookmark, ReviewCheckpoint, Scope, ViewMode } from "../types";

export interface Settings {
  viewMode: ViewMode;
  /** Palpite de branch alvo para um repositório visto pela primeira vez. */
  defaultTarget: string;
  /** Branch inteira ou só o que mudou desde a última revisão completa. */
  scope: Scope;
  /**
   * O "Abrir no editor" do visor do terminal: um comando com `{arquivo}` e `{linha}`, rodado no
   * seu shell. Vazio é o VS Code, pelo `vscode://`, que não depende do `code` estar no PATH.
   */
  editor: string;
  /** O contexto da sessão do Claude, em %: a pílula fica amarela a partir deste. */
  contextoAtencao: number;
  /** E vermelha a partir deste, com o painel contornado de vermelho, pulsando. */
  contextoPerigo: number;
  /** Manda o `/compact` sozinho quando o contexto chega em `autoCompactEm`. Desligado por padrão. */
  autoCompact: boolean;
  /** O % do auto-compact. Tem de passar do vermelho: abaixo dele, vale o vermelho mais um. */
  autoCompactEm: number;
}

export interface RepoConfig {
  target: string;
}

export interface ReviewState {
  /**
   * File diffs marked as reviewed (`diffKey`) → when. Keyed by the diff itself, so the whole
   * branch and the incremental review keep their own marks, and identical diffs share them.
   */
  reviewed: Record<string, number>;
  bookmarks: Bookmark[];
  /** Commits reviewed to the end (every file marked): where the incremental review starts. */
  completed: ReviewCheckpoint[];
}

/** One file's diff: its path and the fingerprint of what changed in it. */
export const diffKey = (path: string, fingerprint: string) => `${path}\0${fingerprint}`;

/** Reviewed marks kept per branch; past this, the oldest go. */
const MAX_REVIEWED = 5000;

export const DEFAULT_SETTINGS: Settings = {
  viewMode: "unified",
  defaultTarget: "",
  scope: "branch",
  editor: "",
  contextoAtencao: 60,
  contextoPerigo: 75,
  autoCompact: false,
  autoCompactEm: 76,
};

let store: Promise<Store> | null = null;
const getStore = () => (store ??= load("differ.json", { autoSave: 300, defaults: {} }));

async function read<T>(key: string): Promise<T | undefined> {
  return (await getStore()).get<T>(key);
}

async function write(key: string, value: unknown): Promise<void> {
  await (await getStore()).set(key, value);
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>("settings")) };
}

export const saveSettings = (settings: Settings) => write("settings", settings);

/**
 * Unificado ou lado a lado vale para o app inteiro: o diff do chat do TermIAu lê e grava o
 * mesmo `settings.viewMode` daqui. Gravar só o modo preserva o resto das preferências.
 */
export async function saveViewMode(viewMode: ViewMode): Promise<void> {
  await saveSettings({ ...(await loadSettings()), viewMode });
}

/** Avisa quando as preferências mudam — inclusive quando quem mudou foi a outra página. */
export async function onSettings(cb: (settings: Settings) => void): Promise<() => void> {
  return (await getStore()).onKeyChange<Partial<Settings>>("settings", (v) => cb({ ...DEFAULT_SETTINGS, ...v }));
}

export const loadRepoConfig = (root: string) => read<RepoConfig>(`repo:${root}`);

export const saveRepoConfig = (root: string, config: RepoConfig) => write(`repo:${root}`, config);

export async function loadReview(key: string): Promise<ReviewState> {
  const saved = await read<Partial<ReviewState> & { viewed?: Record<string, string> }>(`review:${key}`);
  const reviewed = { ...saved?.reviewed };
  // Earlier format: path -> fingerprint of the branch diff, one mark per file.
  for (const [path, fingerprint] of Object.entries(saved?.viewed ?? {})) {
    reviewed[diffKey(path, fingerprint)] ??= Date.now();
  }
  const kept =
    Object.keys(reviewed).length > MAX_REVIEWED
      ? Object.fromEntries(Object.entries(reviewed).sort((a, b) => b[1] - a[1]).slice(0, MAX_REVIEWED))
      : reviewed;
  return { reviewed: kept, bookmarks: saved?.bookmarks ?? [], completed: saved?.completed ?? [] };
}

export const saveReview = (key: string, state: ReviewState) => write(`review:${key}`, state);
