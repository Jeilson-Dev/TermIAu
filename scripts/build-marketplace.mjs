#!/usr/bin/env node
// Builds the marketplace catalog from the plugins in plugins/: each one is
// packaged (scripts/package-plugin.sh) and the result goes to dist-marketplace/,
// which the app bundles as a resource (see tauri.conf.json and
// src-tauri/src/marketplace.rs):
//
//   dist-marketplace/
//     index.json                    the catalog
//     packages/<id>-<version>.termiau
//     icons/<id>.<ext>
//
// The catalog is local for now. Its shape is the one an online catalog will have —
// paths relative to index.json become URLs, and the sha256 is checked either way.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-marketplace");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "packages"), { recursive: true });
mkdirSync(join(out, "icons"), { recursive: true });

const plugins = [];
for (const name of readdirSync(join(root, "plugins")).sort()) {
  const dir = join(root, "plugins", name);
  if (!existsSync(join(dir, "termiau.json"))) continue;
  const manifest = JSON.parse(readFileSync(join(dir, "termiau.json"), "utf8"));

  const built = execFileSync(join(root, "scripts/package-plugin.sh"), [name], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .pop();
  const packageFile = `packages/${manifest.id}-${manifest.version}.termiau`;
  copyFileSync(built, join(out, packageFile));
  const data = readFileSync(join(out, packageFile));

  let icon;
  if (manifest.icon) {
    icon = `icons/${manifest.id}${extname(manifest.icon)}`;
    copyFileSync(join(dir, manifest.icon), join(out, icon));
  }

  plugins.push({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    icon,
    package: packageFile,
    size: statSync(join(out, packageFile)).size,
    sha256: createHash("sha256").update(data).digest("hex"),
    dependencies: manifest.dependencies,
  });
  console.log(`${manifest.id} ${manifest.version}`);
}

writeFileSync(join(out, "index.json"), JSON.stringify({ version: 1, plugins }, null, 2) + "\n");
console.log(join(out, "index.json"));
