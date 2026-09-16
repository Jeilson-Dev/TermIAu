const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
  "podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
]);

/** Machine-generated files start collapsed: they're rarely worth reading line by line. */
export function isGenerated(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return LOCKFILES.has(name) || /\.min\.(js|css)$/.test(name) || name.endsWith(".map");
}
