import type { Bookmark, ReviewDiff } from "../types";

/// What an exported review says it is. A file without it isn't one.
const KIND = "termiau-review";
const VERSION = 1;

/// A review's comments in a file of their own, to hand to someone who reads them in their
/// TermIAu (Comments ▸ Import). It carries where the review was made, so whoever
/// imports knows which branch and commit the lines refer to.
export interface ReviewFile {
  kind: typeof KIND;
  version: number;
  repo: string;
  branch: string | null;
  target: string;
  headSha: string;
  exportedAt: string;
  comments: Bookmark[];
}

export function reviewFile(repo: string, diff: ReviewDiff, comments: Bookmark[], now = new Date()): ReviewFile {
  return {
    kind: KIND,
    version: VERSION,
    repo,
    branch: diff.branch,
    target: diff.target,
    headSha: diff.headSha,
    exportedAt: now.toISOString(),
    comments,
  };
}

/// The file's name: repository, branch and day, readable in Downloads.
export function reviewFileName(file: ReviewFile): string {
  const day = file.exportedAt.slice(0, 10);
  const branch = (file.branch ?? file.headSha.slice(0, 7)).replace(/[/\\:]/g, "-");
  return `${file.repo}-${branch}-review-${day}.json`;
}

const isText = (v: unknown): v is string => typeof v === "string";
const isLine = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/// The comments of an exported review. Throws when the text isn't one; drops, one by one,
/// the comments that lack what places them (path, side, lines, note).
export function readReviewFile(text: string): Bookmark[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  const file = data as Partial<ReviewFile> | null;
  if (file?.kind !== KIND || !Array.isArray(file.comments)) throw new Error("not a review");
  return file.comments.flatMap((raw): Bookmark[] => {
    const c = raw as Partial<Bookmark> | null;
    if (!c || !isText(c.path) || (c.side !== "old" && c.side !== "new") || !isText(c.note)) return [];
    if (!isLine(c.startLine) || !isLine(c.endLine) || c.endLine < c.startLine) return [];
    return [
      {
        id: isText(c.id) && c.id ? c.id : crypto.randomUUID(),
        path: c.path,
        side: c.side,
        startLine: c.startLine,
        endLine: c.endLine,
        note: c.note,
        quote: isText(c.quote) ? c.quote : undefined,
        commit: isText(c.commit) ? c.commit : undefined,
        resolved: c.resolved === true ? true : undefined,
        snapshot: Array.isArray(c.snapshot) ? c.snapshot.filter(isText) : [],
        // Checked again against this machine's diff (`checkBookmarks`).
        fingerprint: isText(c.fingerprint) ? c.fingerprint : "",
        createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
      },
    ];
  });
}

/// The imported comments after the ones already there. The same comment twice — the same
/// file imported again — comes in only once: by id, or by place and note.
export function mergeComments(current: Bookmark[], incoming: Bookmark[]): { bookmarks: Bookmark[]; added: number } {
  const key = (b: Bookmark) => `${b.path}\0${b.side}\0${b.startLine}\0${b.endLine}\0${b.note}`;
  const ids = new Set(current.map((b) => b.id));
  const keys = new Set(current.map(key));
  const fresh: Bookmark[] = [];
  for (const b of incoming) {
    if (ids.has(b.id) || keys.has(key(b))) continue;
    ids.add(b.id);
    keys.add(key(b));
    fresh.push(b);
  }
  return { bookmarks: [...current, ...fresh], added: fresh.length };
}
