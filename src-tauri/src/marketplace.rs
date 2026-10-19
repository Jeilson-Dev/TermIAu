//! The marketplace's catalog: an `index.json` listing plugins, each with its package,
//! icon and sha256 (built by `scripts/build-marketplace.mjs`).
//!
//! For now the catalog is local — bundled with the app as the `marketplace/`
//! resource. Its shape is the one an online catalog will have: the relative paths in
//! it become URLs, and the sha256 is checked either way. Installing reuses
//! `plugins::install_into`, the same path as a package picked from disk.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use crate::plugins::{self, safe_relative, valid_id, Manifest};

/// The catalog's own URL prefix inside `termiau-plugin://`: `_` can't start a plugin
/// id, so it never collides with an installed plugin's folder.
pub const URL_PREFIX: &str = "_marketplace";

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Relative to index.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Relative to index.json.
    pub package: String,
    pub size: u64,
    pub sha256: String,
    /// Filled by the app from the package's signature, never read from the catalog:
    /// a catalog saying "verified" proves nothing.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub verified: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct Catalog {
    pub version: u32,
    pub plugins: Vec<Entry>,
}

/// Where the catalog lives: the bundled resource; in a debug build without it, the
/// repository's `dist-marketplace/` (run `npm run marketplace`).
pub fn catalog_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("marketplace"));
    if let Some(d) = bundled.filter(|d| d.join("index.json").is_file()) {
        return Some(d);
    }
    #[cfg(debug_assertions)]
    {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-marketplace");
        if repo.join("index.json").is_file() {
            return Some(repo);
        }
    }
    None
}

/// Reads and checks the catalog. An entry with an unsafe id or path is dropped, not
/// fatal: one bad line shouldn't empty the marketplace.
pub fn read_catalog(dir: &Path) -> Result<Catalog, String> {
    let text = std::fs::read_to_string(dir.join("index.json")).map_err(|e| format!("index.json: {e}"))?;
    let mut catalog: Catalog = serde_json::from_str(&text).map_err(|e| format!("index.json: {e}"))?;
    if catalog.version != 1 {
        return Err(format!("unsupported catalog version {}", catalog.version));
    }
    catalog.plugins.retain(|e| {
        valid_id(&e.id) && safe_relative(&e.package) && e.icon.as_deref().is_none_or(safe_relative)
    });
    Ok(catalog)
}

/// Reads an entry's package and checks it is the one the catalog describes: size,
/// sha256, and the id and version inside it.
pub fn read_package(dir: &Path, entry: &Entry) -> Result<Vec<u8>, String> {
    let data = std::fs::read(dir.join(&entry.package)).map_err(|e| format!("{}: {e}", entry.package))?;
    if data.len() as u64 != entry.size {
        return Err("the package's size doesn't match the catalog".into());
    }
    let hash = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !hash.eq_ignore_ascii_case(&entry.sha256) {
        return Err("the package's checksum doesn't match the catalog".into());
    }
    Ok(data)
}

pub fn install_from(dir: &Path, base: &Path, id: &str) -> Result<Manifest, String> {
    let catalog = read_catalog(dir)?;
    let entry = catalog.plugins.iter().find(|e| e.id == id).ok_or_else(|| format!("\"{id}\" isn't in the catalog"))?;
    let data = read_package(dir, entry)?;
    let m = plugins::install_into(base, &data)?;
    if m.id != entry.id || m.version != entry.version {
        // Installed already; the mismatch only means the catalog is stale.
        eprintln!("[termiau] catalog says {} {}, package is {} {}", entry.id, entry.version, m.id, m.version);
    }
    Ok(m)
}

fn dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    catalog_dir(app).ok_or_else(|| "no marketplace catalog in this build (npm run marketplace)".to_string())
}

/// The publisher that signed an entry's package, checked here.
fn publisher_of(dir: &Path, entry: &Entry) -> Option<&'static str> {
    let data = read_package(dir, entry).ok()?;
    let (mut zip, manifest) = plugins::open_package(&data).ok()?;
    plugins::check_signature(&mut zip, &manifest, crate::signing::TRUSTED_PUBLISHERS).ok()?
}

#[tauri::command]
pub fn marketplace_catalog(app: AppHandle) -> Result<Catalog, String> {
    let dir = dir_of(&app)?;
    let mut catalog = read_catalog(&dir)?;
    for e in &mut catalog.plugins {
        e.verified = publisher_of(&dir, e).map(String::from);
    }
    Ok(catalog)
}

#[tauri::command]
pub fn marketplace_install(app: AppHandle, id: String) -> Result<Manifest, String> {
    let base = plugins::plugins_dir().ok_or("HOME not set")?;
    let m = install_from(&dir_of(&app)?, &base, &id)?;
    plugins::changed(&app);
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn package(manifest: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            z.start_file(plugins::MANIFEST, opts).unwrap();
            z.write_all(manifest.as_bytes()).unwrap();
            z.start_file("main.js", opts).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    fn catalog_with(dir: &Path, data: &[u8], sha: &str) {
        std::fs::create_dir_all(dir.join("packages")).unwrap();
        std::fs::write(dir.join("packages/p.termiau"), data).unwrap();
        let index = serde_json::json!({
            "version": 1,
            "plugins": [
                { "id": "termiau.radio", "name": "Radio", "version": "1.0.0", "package": "packages/p.termiau",
                  "size": data.len(), "sha256": sha },
                { "id": "evil", "name": "Evil", "version": "1", "package": "../outside.termiau", "size": 0, "sha256": "" }
            ]
        });
        std::fs::write(dir.join("index.json"), index.to_string()).unwrap();
    }

    const MANIFEST: &str = r#"{"id":"termiau.radio","name":"Radio","version":"1.0.0","main":"main.js"}"#;

    #[test]
    fn installs_a_checked_package_and_drops_unsafe_entries() {
        let cat = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let data = package(MANIFEST);
        let sha = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect::<String>();
        catalog_with(cat.path(), &data, &sha);

        let catalog = read_catalog(cat.path()).unwrap();
        assert_eq!(catalog.plugins.len(), 1, "the entry pointing outside is dropped");

        let m = install_from(cat.path(), home.path(), "termiau.radio").unwrap();
        assert_eq!(m.id, "termiau.radio");
        assert!(home.path().join("termiau.radio/main.js").is_file());
    }

    #[test]
    fn refuses_a_package_that_isnt_the_catalogs() {
        let cat = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        catalog_with(cat.path(), &package(MANIFEST), &"0".repeat(64));
        let e = install_from(cat.path(), home.path(), "termiau.radio").unwrap_err();
        assert!(e.contains("checksum"), "{e}");
        assert!(install_from(cat.path(), home.path(), "missing").is_err());
    }
}
