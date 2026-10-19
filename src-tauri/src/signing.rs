//! Verified plugins: an Ed25519 signature over everything in the package.
//!
//! A plugin that ships native binaries runs code outside the webview with the
//! user's full rights, so the app only takes one signed by a trusted publisher. A
//! JS-only plugin may stay unsigned; signed, it shows as verified.
//!
//! What is signed is a canonical digest: one line per file, `<sha256 hex>  <path>`,
//! sorted by path, every file but the signature itself. The same digest is computed
//! from the zip at install time and from the plugin's folder before each binary
//! launch, so a file changed on disk after install is caught too.
//! `scripts/package-plugin.sh` writes the signature as `termiau.sig`.

use std::path::Path;

use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};

pub const SIGNATURE_FILE: &str = "termiau.sig";

pub struct Publisher {
    pub name: &'static str,
    /// The raw 32-byte Ed25519 public key (scripts/signing-key.sh prints it).
    pub key: [u8; 32],
}

/// Whose signatures the app trusts. Today only TermIAu's own key.
pub const TRUSTED_PUBLISHERS: &[Publisher] = &[Publisher {
    name: "TermIAu",
    key: [
        0x1c, 0x5e, 0xc4, 0x31, 0xd0, 0xbb, 0x90, 0x26, 0x1a, 0x7a, 0x44, 0x5f, 0xf0, 0x04, 0x6f, 0x25, 0xa0, 0x56, 0x3d,
        0xe6, 0x2d, 0x60, 0x4c, 0x03, 0xf6, 0x82, 0x0e, 0x4e, 0x4f, 0x03, 0x48, 0x9a,
    ],
}];

#[derive(serde::Deserialize)]
struct SignatureFile {
    signature: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// The text that gets signed, from `(path, sha256 hex)` pairs. Paths use `/`.
pub fn canonical_digest(mut files: Vec<(String, String)>) -> String {
    files.retain(|(path, _)| path != SIGNATURE_FILE);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.iter().map(|(path, hash)| format!("{hash}  {path}\n")).collect()
}

/// The publisher whose key signed `digest`, if any of `publishers` did.
pub fn verify(publishers: &[Publisher], digest: &str, signature_file: &[u8]) -> Option<&'static str> {
    let parsed: SignatureFile = serde_json::from_slice(signature_file).ok()?;
    let signature = base64::engine::general_purpose::STANDARD.decode(parsed.signature.trim()).ok()?;
    publishers
        .iter()
        .find(|p| UnparsedPublicKey::new(&ED25519, p.key).verify(digest.as_bytes(), &signature).is_ok())
        .map(|p| p.name)
}

/// Every file under `dir`, as `(relative path, sha256 hex)`.
pub fn hash_dir(dir: &Path) -> std::io::Result<Vec<(String, String)>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                out.push((rel, sha256_hex(&std::fs::read(&path)?)));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    Ok(out)
}

/// The publisher of an installed plugin's folder, checked against what is on disk now.
pub fn verify_dir(publishers: &[Publisher], dir: &Path) -> Option<&'static str> {
    let signature = std::fs::read(dir.join(SIGNATURE_FILE)).ok()?;
    verify(publishers, &canonical_digest(hash_dir(dir).ok()?), &signature)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    /// A fresh key pair standing in for a publisher in tests.
    pub struct TestKey(Ed25519KeyPair);

    impl TestKey {
        pub fn new() -> Self {
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
            TestKey(Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap())
        }

        pub fn publisher(&self, name: &'static str) -> Publisher {
            Publisher { name, key: self.0.public_key().as_ref().try_into().unwrap() }
        }

        /// The `termiau.sig` for `digest`.
        pub fn sign(&self, digest: &str) -> Vec<u8> {
            let sig = base64::engine::general_purpose::STANDARD.encode(self.0.sign(digest.as_bytes()));
            serde_json::json!({ "signature": sig }).to_string().into_bytes()
        }
    }

    #[test]
    fn the_digest_is_sorted_and_skips_the_signature() {
        let d = canonical_digest(vec![
            ("b.js".into(), "22".into()),
            (SIGNATURE_FILE.into(), "ff".into()),
            ("a.json".into(), "11".into()),
        ]);
        assert_eq!(d, "11  a.json\n22  b.js\n");
    }

    #[test]
    fn only_a_listed_key_verifies() {
        let digest = canonical_digest(vec![("main.js".into(), sha256_hex(b"x"))]);
        let ours = TestKey::new();
        let theirs = TestKey::new();
        let trusted = [ours.publisher("Ours")];
        assert_eq!(verify(&trusted, &digest, &ours.sign(&digest)), Some("Ours"));
        assert_eq!(verify(&trusted, &digest, &theirs.sign(&digest)), None);
        assert_eq!(verify(&trusted, "other digest", &ours.sign(&digest)), None);
        assert_eq!(verify(&trusted, &digest, b"not json"), None);
        assert_eq!(verify(TRUSTED_PUBLISHERS, &digest, &theirs.sign(&digest)), None);
    }
}
