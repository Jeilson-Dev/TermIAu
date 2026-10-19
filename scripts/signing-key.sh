#!/usr/bin/env bash
# Creates the Ed25519 key that signs TermIAu's verified plugins, once, and prints
# the public half to paste into TRUSTED_PUBLISHERS in src-tauri/src/signing.rs.
#
# The private key stays on this machine, outside the repository:
#   ~/.termiau-signing/ed25519.pem   (or the path in $TERMIAU_SIGNING_KEY)
# scripts/package-plugin.sh signs with it. Without it, a plugin that ships native
# binaries can't be packaged, and the app refuses to install it unsigned.
set -euo pipefail

key="${TERMIAU_SIGNING_KEY:-$HOME/.termiau-signing/ed25519.pem}"

if [[ ! -f "$key" ]]; then
  mkdir -p "$(dirname "$key")"
  chmod 700 "$(dirname "$key")"
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    process.stdout.write(privateKey.export({ format: "pem", type: "pkcs8" }));
  ' > "$key"
  chmod 600 "$key"
  echo "created $key" >&2
fi

node -e '
  const { createPrivateKey, createPublicKey } = require("node:crypto");
  const fs = require("node:fs");
  const pub = createPublicKey(createPrivateKey(fs.readFileSync(process.argv[1])));
  const raw = pub.export({ format: "der", type: "spki" }).subarray(-32);
  console.log("public key (hex): " + raw.toString("hex"));
' "$key"
