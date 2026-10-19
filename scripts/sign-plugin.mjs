#!/usr/bin/env node
// Signs a staged plugin folder: writes termiau.sig, an Ed25519 signature over the
// canonical digest the app checks (see src-tauri/src/signing.rs) — one line per
// file, `<sha256 hex>  <path>`, sorted by path, every file but the signature.
//
//   node scripts/sign-plugin.mjs <staged folder>
//
// The key is $TERMIAU_SIGNING_KEY or ~/.termiau-signing/ed25519.pem (made by
// scripts/signing-key.sh). Without it: exit 2, and nothing is written.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

const dir = process.argv[2];
const keyPath = process.env.TERMIAU_SIGNING_KEY || join(homedir(), ".termiau-signing/ed25519.pem");
if (!existsSync(keyPath)) {
  console.error(`no signing key at ${keyPath} (run scripts/signing-key.sh)`);
  process.exit(2);
}

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dir, p).split(sep).join("/"));
  }
};
walk(dir);

const digest = files
  .filter((f) => f !== "termiau.sig")
  .sort()
  .map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}\n`)
  .join("");

const signature = sign(null, Buffer.from(digest), createPrivateKey(readFileSync(keyPath))).toString("base64");
writeFileSync(join(dir, "termiau.sig"), JSON.stringify({ signature }) + "\n");
