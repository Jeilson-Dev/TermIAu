import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type { Token } from "./segments";

/** Bigger files render without syntax colors to keep the UI responsive. */
const MAX_LINES = 8000;
const MAX_CHARS = 600_000;

const DRACULA_COMMENT = "#6272a4";

const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
};

const BY_EXTENSION: Record<string, string> = {
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  cc: "cpp",
  htm: "html",
  svg: "xml",
  plist: "xml",
  csproj: "xml",
  env: "dotenv",
};

export function langFor(path: string): BundledLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const id = BY_NAME[name] ?? (name.startsWith("dockerfile") ? "docker" : (BY_EXTENSION[ext] ?? ext));
  return id && id in bundledLanguages ? (id as BundledLanguage) : null;
}

let highlighter: Promise<Highlighter> | null = null;
const cache = new Map<string, Promise<Token[][] | null>>();

/** Tokens per line for a whole file, or `null` when it's too big or can't be highlighted. */
export function tokenize(oid: string, lines: string[], lang: BundledLanguage): Promise<Token[][] | null> {
  const key = `${oid}:${lang}`;
  let tokens = cache.get(key);
  if (!tokens) {
    tokens = run(lines, lang).catch(() => null);
    cache.set(key, tokens);
  }
  return tokens;
}

/** Tokens without the cache: the terminal's viewer rereads the file on every edit, and every version would be kept. */
export const tokenizeFresh = (lines: string[], lang: BundledLanguage) => run(lines, lang).catch(() => null);

async function run(lines: string[], lang: BundledLanguage): Promise<Token[][] | null> {
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  if (lines.length > MAX_LINES || size > MAX_CHARS) return null;

  highlighter ??= createHighlighter({ themes: ["dracula"], langs: [] });
  const h = await highlighter;
  await h.loadLanguage(lang);
  return h
    .codeToTokensBase(lines.join("\n"), { lang, theme: "dracula" })
    .map((line) =>
      line.map((t) => ({
        content: t.content,
        // Comments follow a CSS variable so changed lines can raise their contrast.
        color: t.color?.toLowerCase() === DRACULA_COMMENT ? "var(--syntax-comment)" : t.color,
        fontStyle: t.fontStyle,
      })),
    );
}
