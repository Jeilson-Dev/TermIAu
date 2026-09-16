// Mirrors the serialized structs in src-tauri/src/{review,diff}.rs.

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";

export type LineKind = "context" | "add" | "del";

export interface Line {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  content: string;
  noNewline: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: Line[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  similarity: number | null;
  oldMode: string;
  newMode: string;
  oldOid: string | null;
  newOid: string | null;
  binary: boolean;
  submodule: boolean;
  additions: number;
  deletions: number;
  fingerprint: string;
  hunks: Hunk[];
}

export type Side = "old" | "new";

export type ViewMode = "unified" | "split";

/** The whole branch against its target, or only what changed since the last complete review. */
export type Scope = "branch" | "incremental";

/** A local note anchored to a line range, like a bookmark between book pages. */
export interface Bookmark {
  id: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  note: string;
  /** Text selected in the code when the note is about a passage rather than whole lines. */
  quote?: string;
  /** Commit whose version of the file the lines refer to (the reviewed HEAD, for new-side notes). */
  commit?: string;
  /** Checked off after verifying the fix. */
  resolved?: boolean;
  /** Content of the anchored lines when the bookmark was created; used to detect outdated ones. */
  snapshot: string[];
  /** File fingerprint the snapshot was last confirmed against. */
  fingerprint: string;
  createdAt: number;
}

/** A commit whose diff had every file marked as reviewed. */
export interface ReviewCheckpoint {
  commit: string;
  at: number;
}

/** Request to scroll a file line into view (the nonce re-triggers the same target). */
export interface FocusTarget {
  path: string;
  side: Side;
  line: number;
  nonce: number;
}

export interface RepoInfo {
  root: string;
  name: string;
  currentBranch: string | null;
  headSha: string | null;
  localBranches: string[];
  remoteBranches: string[];
  suggestedTarget: string | null;
}

export interface ReviewDiff {
  root: string;
  branch: string | null;
  headSha: string;
  target: string;
  targetSha: string;
  mergeBase: string;
  additions: number;
  deletions: number;
  files: FileDiff[];
}
