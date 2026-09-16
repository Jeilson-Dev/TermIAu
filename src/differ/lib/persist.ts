// Local persistence (a JSON file in the app's data folder).

import { load, type Store } from "@tauri-apps/plugin-store";
import type { Bookmark, ReviewCheckpoint, Scope, ViewMode } from "../types";

export interface Settings {
  viewMode: ViewMode;
  /** Palpite de branch alvo para um repositório visto pela primeira vez. */
  defaultTarget: string;
  /** Branch inteira ou só o que mudou desde a última revisão completa. */
  scope: Scope;
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

const DEFAULT_SETTINGS: Settings = { viewMode: "unified", defaultTarget: "", scope: "branch" };

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
