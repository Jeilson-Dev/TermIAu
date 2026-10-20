//! Plugins: folders under `~/.termiau/plugins/<id>/`, each with a `termiau.json`
//! manifest and the code it names. Modeled on VS Code's extensions: the manifest
//! declares what the plugin contributes (regions, commands, menu items) and the
//! webview runs its `main` module (see `src/plugins/host.ts`).
//!
//! Rust owns the disk and the native menu: it lists, installs, enables and removes
//! plugins, serves their files over `termiau-plugin://`, and turns their commands into
//! menu items. Every change emits `plugins://changed`, and the webview reloads them.
//!
//! A package is a `.termiau` file: a zip with `termiau.json` at its root.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};
use tauri::menu::{MenuItem, Submenu};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::language::portuguese;
use crate::signing;

pub const MANIFEST: &str = "termiau.json";
pub const SCHEME: &str = "termiau-plugin";
const STATE: &str = "state.json";
/// A package bigger than this is not a plugin for a footer.
const MAX_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;

/// Text in the manifest: a plain string, or one per language.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum Localized {
    Plain(String),
    PerLanguage { en: String, pt: Option<String> },
}

impl Localized {
    fn text(&self) -> &str {
        match self {
            Localized::Plain(s) => s,
            Localized::PerLanguage { en, pt } => match pt {
                Some(pt) if portuguese() => pt,
                _ => en,
            },
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub title: Localized,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybinding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<Localized>,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    /// Checked by the webview, which owns the regions.
    #[serde(default)]
    pub regions: Vec<serde_json::Value>,
    #[serde(default)]
    pub commands: Vec<Command>,
    /// The plugin's settings. Checked and drawn by the webview (the Plugins tab).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configuration: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engines: Option<serde_json::Value>,
    pub main: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// A square image (SVG or PNG) for the Plugins tab, and later the marketplace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub activation_events: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
    /// Native executables the plugin runs (see plugin_process.rs), by name. Only a
    /// plugin signed by a trusted publisher may have them (see signing.rs).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub binaries: BTreeMap<String, String>,
    /// Where its binaries run, e.g. `darwin-arm64`. Empty means anywhere.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
}

/// One folder under `plugins/`. A broken one is still listed, with the reason,
/// so the Plugins tab can show it and offer to remove it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<Manifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The publisher that signed it, checked against the files on disk now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<String>,
}

/// This machine, the way manifests write it: `darwin-arm64`, `darwin-x64`.
pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct State {
    #[serde(default)]
    disabled: Vec<String>,
}

pub fn plugins_dir() -> Option<PathBuf> {
    crate::dirs_home().map(|h| PathBuf::from(h).join(".termiau/plugins"))
}

/// Lowercase letters, digits, dots and dashes, starting with a letter or digit. It
/// becomes a folder name and part of a URL, so nothing else gets in.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// A path that stays inside the plugin's folder: relative, and no `..`.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
}

fn validate(m: &Manifest) -> Result<(), String> {
    if !valid_id(&m.id) {
        return Err(format!("invalid id \"{}\"", m.id));
    }
    if m.name.trim().is_empty() || m.version.trim().is_empty() {
        return Err("name and version are required".into());
    }
    if !safe_relative(&m.main) {
        return Err(format!("invalid main \"{}\"", m.main));
    }
    for (field, path) in [("style", &m.style), ("icon", &m.icon)] {
        if let Some(path) = path {
            if !safe_relative(path) {
                return Err(format!("invalid {field} \"{path}\""));
            }
        }
    }
    for (name, path) in &m.binaries {
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(format!("invalid binary name \"{name}\""));
        }
        if !safe_relative(path) {
            return Err(format!("invalid binary path \"{path}\""));
        }
    }
    for c in &m.contributes.commands {
        if c.id.is_empty() || c.id.contains(':') {
            return Err(format!("invalid command id \"{}\"", c.id));
        }
    }
    Ok(())
}

fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| format!("{MANIFEST}: {e}"))?;
    validate(&m)?;
    Ok(m)
}

fn read_state(base: &Path) -> State {
    std::fs::read_to_string(base.join(STATE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_state(base: &Path, state: &State) -> Result<(), String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(base.join(STATE), text).map_err(|e| e.to_string())
}

pub fn list_in(base: &Path) -> Vec<Installed> {
    let state = read_state(base);
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut out: Vec<Installed> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        // Leftovers of an install cut in the middle start with a dot.
        .filter(|name| !name.starts_with('.'))
        .map(|id| {
            let read = std::fs::read_to_string(base.join(&id).join(MANIFEST))
                .map_err(|e| format!("{MANIFEST}: {e}"))
                .and_then(|t| parse_manifest(&t))
                .and_then(|m| {
                    if m.id != id {
                        Err(format!("folder \"{id}\" holds plugin \"{}\"", m.id))
                    } else if !base.join(&id).join(&m.main).is_file() {
                        Err(format!("main \"{}\" not found", m.main))
                    } else {
                        Ok(m)
                    }
                });
            let enabled = !state.disabled.contains(&id);
            let verified = signing::verify_dir(signing::TRUSTED_PUBLISHERS, &base.join(&id)).map(String::from);
            match read {
                Ok(m) => Installed { id, enabled, manifest: Some(m), error: None, verified },
                Err(e) => Installed { id, enabled, manifest: None, error: Some(e), verified },
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Unpacks a `.termiau` into `base/<id>/`, replacing the installed version. It goes
/// to a hidden folder first and only then takes the real name, so a broken package
/// never leaves half a plugin behind.
pub(crate) fn open_package(data: &[u8]) -> Result<(zip::ZipArchive<Cursor<&[u8]>>, Manifest), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("not a .termiau package: {e}"))?;
    let manifest = {
        let mut f = zip.by_name(MANIFEST).map_err(|_| format!("{MANIFEST} missing at the package root"))?;
        let mut text = String::new();
        f.read_to_string(&mut text).map_err(|e| format!("{MANIFEST}: {e}"))?;
        parse_manifest(&text)?
    };
    Ok((zip, manifest))
}

pub fn install_into(base: &Path, data: &[u8]) -> Result<Manifest, String> {
    install_trusting(base, data, signing::TRUSTED_PUBLISHERS)
}

/// The signature rules: a package with binaries must be signed by one of
/// `publishers`; any package that carries a signature must match it. Returns the
/// publisher, if signed.
pub(crate) fn check_signature(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    manifest: &Manifest,
    publishers: &[signing::Publisher],
) -> Result<Option<&'static str>, String> {
    let mut files = Vec::new();
    let mut signature = None;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if f.name() == signing::SIGNATURE_FILE {
            signature = Some(bytes);
        } else {
            files.push((f.name().to_string(), signing::sha256_hex(&bytes)));
        }
    }
    let publisher = match &signature {
        Some(sig) => Some(
            signing::verify(publishers, &signing::canonical_digest(files), sig)
                .ok_or("the package's signature doesn't match a trusted publisher")?,
        ),
        None => None,
    };
    if !manifest.binaries.is_empty() && publisher.is_none() {
        return Err("plugins with native code must be verified (signed by a trusted publisher)".into());
    }
    Ok(publisher)
}

fn install_trusting(base: &Path, data: &[u8], publishers: &[signing::Publisher]) -> Result<Manifest, String> {
    let (mut zip, manifest) = open_package(data)?;
    if !manifest.platforms.is_empty() && !manifest.platforms.contains(&current_platform()) {
        return Err(format!("this plugin is for {}, not {}", manifest.platforms.join(", "), current_platform()));
    }

    let mut total = 0u64;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        total += f.size();
        let name = f.name().to_string();
        if !f.is_dir() && !safe_relative(name.trim_end_matches('/')) {
            return Err(format!("unsafe path in package: {name}"));
        }
    }
    if total > MAX_PACKAGE_BYTES {
        return Err("package too big".into());
    }
    let main_inside = (0..zip.len()).any(|i| zip.by_index(i).is_ok_and(|f| f.name() == manifest.main));
    if !main_inside {
        return Err(format!("main \"{}\" missing from the package", manifest.main));
    }
    for path in manifest.binaries.values() {
        if !(0..zip.len()).any(|i| zip.by_index(i).is_ok_and(|f| f.name() == path)) {
            return Err(format!("binary \"{path}\" missing from the package"));
        }
    }
    check_signature(&mut zip, &manifest, publishers)?;

    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let staging = base.join(format!(".installing-{}-{}", manifest.id, std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let unpacked = (|| -> Result<(), String> {
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = f.enclosed_name() else { return Err(format!("unsafe path in package: {}", f.name())) };
            let dest = staging.join(rel);
            if f.is_dir() {
                std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
        // A zip keeps no exec bit we can rely on: the declared binaries get it here.
        for path in manifest.binaries.values() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(staging.join(path), std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(e) = unpacked {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    let target = base.join(&manifest.id);
    let old = base.join(format!(".old-{}-{}", manifest.id, std::process::id()));
    if target.exists() {
        std::fs::rename(&target, &old).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&staging, &target) {
        // Puts the previous version back: a failed update shouldn't uninstall.
        let _ = std::fs::rename(&old, &target);
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(manifest)
}

pub fn remove_in(base: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("invalid id \"{id}\""));
    }
    let dir = base.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut state = read_state(base);
    state.disabled.retain(|d| d != id);
    write_state(base, &state)
}

pub fn set_enabled_in(base: &Path, id: &str, enabled: bool) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("invalid id \"{id}\""));
    }
    let mut state = read_state(base);
    state.disabled.retain(|d| d != id);
    if !enabled {
        state.disabled.push(id.to_string());
    }
    write_state(base, &state)
}

fn base() -> Result<PathBuf, String> {
    plugins_dir().ok_or_else(|| "HOME not set".to_string())
}

/// After any change: the menu is rebuilt with the commands that are on now, and the
/// webview reloads its plugins.
pub(crate) fn changed(app: &AppHandle) {
    if let Err(e) = crate::build_menu(app) {
        eprintln!("[termiau] couldn't rebuild the menu: {e}");
    }
    let _ = app.emit("plugins://changed", ());
}

/// Off the main thread: checking each signature hashes the whole plugin folder
/// (megabytes, with a native engine), and a sync command would freeze the window.
#[tauri::command]
pub async fn plugins_list() -> Vec<Installed> {
    tauri::async_runtime::spawn_blocking(|| base().map(|b| list_in(&b)).unwrap_or_default())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn plugins_install(app: AppHandle, data: Vec<u8>) -> Result<Manifest, String> {
    let m = install_into(&base()?, &data)?;
    changed(&app);
    Ok(m)
}

#[tauri::command]
pub fn plugins_remove(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<crate::plugin_process::Processes>().kill(Some(&id));
    remove_in(&base()?, &id)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn plugins_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !enabled {
        app.state::<crate::plugin_process::Processes>().kill(Some(&id));
    }
    set_enabled_in(&base()?, &id, enabled)?;
    changed(&app);
    Ok(())
}

// ---------- packages opened from Finder ----------

/// `.termiau` files macOS handed to the app (a double click in Finder), waiting for
/// the webview to ask whether to install them. A queue, because at launch they
/// arrive before the webview is listening.
#[derive(Default)]
pub struct Opened(Mutex<Vec<PathBuf>>);

/// What the webview shows before asking: the package's manifest, or why it isn't one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPackage {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<Manifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_package(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "termiau")
}

/// Called from the run loop's `Opened`. Nothing is installed here: a double click
/// shouldn't install code without asking.
pub fn on_opened(app: &AppHandle, urls: &[tauri::Url]) {
    let paths: Vec<PathBuf> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter(|p| is_package(p))
        .collect();
    if paths.is_empty() {
        return;
    }
    app.state::<Opened>().0.lock().unwrap().extend(paths);
    let _ = app.emit("plugins://opened", ());
}

#[tauri::command]
pub fn plugins_take_opened(opened: tauri::State<'_, Opened>) -> Vec<OpenedPackage> {
    std::mem::take(&mut *opened.0.lock().unwrap())
        .into_iter()
        .map(|p| {
            let read = std::fs::metadata(&p)
                .map_err(|e| e.to_string())
                .and_then(|m| if m.len() > MAX_PACKAGE_BYTES { Err("package too big".into()) } else { Ok(()) })
                .and_then(|_| std::fs::read(&p).map_err(|e| e.to_string()))
                .and_then(|data| open_package(&data).map(|(_, m)| m));
            let path = p.to_string_lossy().into_owned();
            match read {
                Ok(m) => OpenedPackage { path, manifest: Some(m), error: None },
                Err(e) => OpenedPackage { path, manifest: None, error: Some(e) },
            }
        })
        .collect()
}

#[tauri::command]
pub fn plugins_install_file(app: AppHandle, path: String) -> Result<Manifest, String> {
    let path = PathBuf::from(path);
    if !is_package(&path) {
        return Err("not a .termiau file".into());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let m = install_into(&base()?, &data)?;
    changed(&app);
    Ok(m)
}

// ---------- the native menu ----------

const MENU_PREFIX: &str = "plugin:";

/// One submenu per menu name the enabled plugins use, in the order they appear. Two
/// plugins asking for the same menu share it.
pub fn menus<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Vec<Submenu<R>>> {
    let mut groups: BTreeMap<String, Vec<(String, &Command)>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let installed = base().map(|b| list_in(&b)).unwrap_or_default();
    for p in installed.iter().filter(|p| p.enabled) {
        let Some(m) = &p.manifest else { continue };
        for c in &m.contributes.commands {
            let Some(menu) = &c.menu else { continue };
            let label = menu.text().to_string();
            if !groups.contains_key(&label) {
                order.push(label.clone());
            }
            groups.entry(label).or_default().push((m.id.clone(), c));
        }
    }
    let mut out = Vec::new();
    for label in order {
        let submenu = Submenu::new(app, &label, true)?;
        for (plugin, c) in &groups[&label] {
            let id = format!("{MENU_PREFIX}{plugin}:{}", c.id);
            submenu.append(&MenuItem::with_id(app, id, c.title.text(), true, c.keybinding.as_deref())?)?;
        }
        out.push(submenu);
    }
    Ok(out)
}

/// A menu item that belongs to a plugin goes to the webview as `plugin://command`.
/// Returns false when the id isn't a plugin's.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
    let Some(rest) = id.strip_prefix(MENU_PREFIX) else { return false };
    let Some((plugin, command)) = rest.split_once(':') else { return false };
    let _ = app.emit("plugin://command", serde_json::json!({ "plugin": plugin, "command": command }));
    true
}

// ---------- termiau-plugin:// ----------

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "html" => "text/html",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        // The page's origin is tauri:// (or the dev server's http://), and a module
        // import from another scheme is a CORS request.
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_default()
}

/// The path to the file a `termiau-plugin://localhost/<id>/<file>` URL names, if it
/// stays inside that plugin's folder.
/// A file directly under `dir`, by a URL path that must stay inside it.
pub(crate) fn resolve_in(dir: &Path, url_path: &str) -> Option<PathBuf> {
    let rest = url_path.trim_start_matches('/');
    if rest.contains('%') || !safe_relative(rest) {
        return None;
    }
    let dir = dir.canonicalize().ok()?;
    let file = dir.join(rest).canonicalize().ok()?;
    (file.starts_with(&dir) && file.is_file()).then_some(file)
}

pub fn resolve(base: &Path, url_path: &str) -> Option<PathBuf> {
    let (id, rest) = url_path.trim_start_matches('/').split_once('/')?;
    if !valid_id(id) {
        return None;
    }
    resolve_in(&base.join(id), rest)
}

/// `/<id>/<file>` is an installed plugin's file; `/_marketplace/<file>` is the
/// catalog's (its icons, see marketplace.rs).
pub fn serve<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    let found = match path.trim_start_matches('/').strip_prefix(crate::marketplace::URL_PREFIX).and_then(|r| r.strip_prefix('/')) {
        Some(rest) => crate::marketplace::catalog_dir(app).and_then(|dir| resolve_in(&dir, rest)),
        None => base().ok().and_then(|base| resolve(&base, path)),
    };
    match found.and_then(|f| std::fs::read(&f).ok().map(|b| (f, b))) {
        Some((file, bytes)) => respond(StatusCode::OK, mime(&file), bytes),
        None => respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const MANIFEST_OK: &str = r#"{"id":"termiau.radio","name":"Radio","version":"1.0.0","main":"main.js","style":"style.css"}"#;

    fn package(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                z.start_file(*name, opts).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn ids_are_folder_and_url_safe() {
        assert!(valid_id("termiau.radio"));
        assert!(valid_id("my-plugin2"));
        assert!(!valid_id(""));
        assert!(!valid_id(".hidden"));
        assert!(!valid_id("Upper"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a b"));
    }

    #[test]
    fn relative_paths_stay_inside() {
        assert!(safe_relative("main.js"));
        assert!(safe_relative("dist/main.js"));
        assert!(!safe_relative("../main.js"));
        assert!(!safe_relative("a/../../b"));
        assert!(!safe_relative("/etc/passwd"));
        assert!(!safe_relative("./main.js"));
        assert!(!safe_relative(""));
    }

    #[test]
    fn installs_lists_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = package(&[(MANIFEST, MANIFEST_OK), ("main.js", "export function activate(){}"), ("style.css", "")]);
        let m = install_into(dir.path(), &pkg).unwrap();
        assert_eq!(m.id, "termiau.radio");

        let listed = list_in(dir.path());
        assert_eq!(listed.len(), 1);
        assert!(listed[0].enabled && listed[0].error.is_none());

        // Installing again replaces it, with no staging folder left behind.
        install_into(dir.path(), &pkg).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("termiau.radio")]);
    }

    #[test]
    fn refuses_bad_packages() {
        let dir = tempfile::tempdir().unwrap();
        assert!(install_into(dir.path(), b"not a zip").is_err());
        assert!(install_into(dir.path(), &package(&[("main.js", "")])).is_err());
        assert!(install_into(dir.path(), &package(&[(MANIFEST, MANIFEST_OK)])).is_err(), "main missing");
        let evil = package(&[(MANIFEST, MANIFEST_OK), ("main.js", ""), ("../evil.js", "")]);
        assert!(install_into(dir.path(), &evil).is_err());
        let bad_icon = r#"{"id":"x","name":"X","version":"1","main":"main.js","icon":"/etc/icon.png"}"#;
        assert!(install_into(dir.path(), &package(&[(MANIFEST, bad_icon), ("main.js", "")])).is_err());
        let bad_main = r#"{"id":"x","name":"X","version":"1","main":"../main.js"}"#;
        assert!(install_into(dir.path(), &package(&[(MANIFEST, bad_main)])).is_err());
        assert!(list_in(dir.path()).is_empty());
    }

    fn package_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                z.start_file(*name, opts).unwrap();
                z.write_all(body).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    const WITH_BINARY: &str =
        r#"{"id":"termiau.dictation","name":"Dictation","version":"1.0.0","main":"main.js","binaries":{"engine":"bin/engine"}}"#;

    /// A package with a binary, signed by `key` over exactly these files.
    fn signed_with_binary(key: &signing::tests::TestKey, engine: &[u8]) -> Vec<u8> {
        let files: Vec<(&str, &[u8])> = vec![(MANIFEST, WITH_BINARY.as_bytes()), ("main.js", b"x"), ("bin/engine", engine)];
        let digest = signing::canonical_digest(files.iter().map(|(n, b)| (n.to_string(), signing::sha256_hex(b))).collect());
        let sig = key.sign(&digest);
        let mut all = files.clone();
        all.push((signing::SIGNATURE_FILE, &sig));
        package_bytes(&all)
    }

    #[test]
    fn native_code_needs_a_trusted_signature() {
        let dir = tempfile::tempdir().unwrap();
        let ours = signing::tests::TestKey::new();
        let trusted = [ours.publisher("Ours")];

        // Signed by a trusted key: installs, and the binary is executable.
        install_trusting(dir.path(), &signed_with_binary(&ours, b"\x7fELF"), &trusted).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("termiau.dictation/bin/engine")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
        assert_eq!(signing::verify_dir(&trusted, &dir.path().join("termiau.dictation")), Some("Ours"));

        // Changed on disk after install: no longer verified.
        std::fs::write(dir.path().join("termiau.dictation/bin/engine"), b"evil").unwrap();
        assert_eq!(signing::verify_dir(&trusted, &dir.path().join("termiau.dictation")), None);

        // Signed by someone else, or not signed at all: refused.
        let other = signing::tests::TestKey::new();
        assert!(install_trusting(dir.path(), &signed_with_binary(&other, b"x"), &trusted).is_err());
        let unsigned = package_bytes(&[(MANIFEST, WITH_BINARY.as_bytes()), ("main.js", b"x"), ("bin/engine", b"x")]);
        let e = install_trusting(dir.path(), &unsigned, &trusted).unwrap_err();
        assert!(e.contains("must be verified"), "{e}");
    }

    #[test]
    fn a_tampered_signed_package_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ours = signing::tests::TestKey::new();
        let trusted = [ours.publisher("Ours")];
        // Signed for one engine, shipped with another.
        let files: Vec<(&str, &[u8])> = vec![(MANIFEST, WITH_BINARY.as_bytes()), ("main.js", b"x"), ("bin/engine", b"good")];
        let digest = signing::canonical_digest(files.iter().map(|(n, b)| (n.to_string(), signing::sha256_hex(b))).collect());
        let sig = ours.sign(&digest);
        let tampered = package_bytes(&[
            (MANIFEST, WITH_BINARY.as_bytes()),
            ("main.js", b"x"),
            ("bin/engine", b"evil"),
            (signing::SIGNATURE_FILE, &sig),
        ]);
        assert!(install_trusting(dir.path(), &tampered, &trusted).is_err());
    }

    /// Checks a real package against the app's trusted keys:
    /// `TERMIAU_CHECK_PACKAGE=dist-plugins/x.termiau cargo test -- --ignored real_package`.
    #[test]
    #[ignore]
    fn real_package_is_verified() {
        let path = std::env::var("TERMIAU_CHECK_PACKAGE").expect("TERMIAU_CHECK_PACKAGE");
        let data = std::fs::read(path).unwrap();
        let (mut zip, manifest) = open_package(&data).unwrap();
        let publisher = check_signature(&mut zip, &manifest, signing::TRUSTED_PUBLISHERS).unwrap();
        assert_eq!(publisher, Some("TermIAu"));
    }

    #[test]
    fn disable_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = package(&[(MANIFEST, MANIFEST_OK), ("main.js", "")]);
        install_into(dir.path(), &pkg).unwrap();
        set_enabled_in(dir.path(), "termiau.radio", false).unwrap();
        assert!(!list_in(dir.path())[0].enabled);
        set_enabled_in(dir.path(), "termiau.radio", true).unwrap();
        assert!(list_in(dir.path())[0].enabled);
        remove_in(dir.path(), "termiau.radio").unwrap();
        assert!(list_in(dir.path()).is_empty());
    }

    #[test]
    fn a_broken_folder_is_listed_with_its_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("other")).unwrap();
        std::fs::write(dir.path().join("other").join(MANIFEST), MANIFEST_OK).unwrap();
        let listed = list_in(dir.path());
        assert_eq!(listed.len(), 1);
        assert!(listed[0].manifest.is_none());
        assert!(listed[0].error.as_deref().unwrap().contains("holds plugin"));
    }

    #[test]
    fn serves_only_inside_the_plugin() {
        let dir = tempfile::tempdir().unwrap();
        install_into(dir.path(), &package(&[(MANIFEST, MANIFEST_OK), ("main.js", "x")])).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
        assert!(resolve(dir.path(), "/termiau.radio/main.js").is_some());
        assert!(resolve(dir.path(), "/termiau.radio/../secret.txt").is_none());
        assert!(resolve(dir.path(), "/termiau.radio/%2e%2e/secret.txt").is_none());
        assert!(resolve(dir.path(), "/termiau.radio/missing.js").is_none());
        assert!(resolve(dir.path(), "/termiau.radio").is_none());
    }

    #[test]
    fn localized_text_has_an_english_fallback() {
        let l: Localized = serde_json::from_str(r#"{"en":"Radio"}"#).unwrap();
        assert_eq!(l.text(), "Radio");
        let l: Localized = serde_json::from_str(r#""Radio""#).unwrap();
        assert_eq!(l.text(), "Radio");
    }
}
