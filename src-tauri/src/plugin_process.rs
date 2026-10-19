//! Native processes of plugins: the binaries a verified plugin declares in its
//! manifest (`binaries`), started on the webview's request and spoken to with
//! newline-delimited JSON over stdin/stdout.
//!
//! A plugin can only start its own declared binaries, from its own folder, and
//! only while the folder still matches its signature — checked again before every
//! launch, so a file changed on disk after install doesn't run (see signing.rs).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::{plugins, signing};

struct Running {
    plugin: String,
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Processes {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Running>>,
}

impl Processes {
    /// Stops every process of `plugin` (it was disabled, removed or replaced), or all
    /// of them with `None` (the app is quitting).
    pub fn kill(&self, plugin: Option<&str>) {
        let mut running = self.running.lock().unwrap();
        let handles: Vec<u64> =
            running.iter().filter(|(_, r)| plugin.is_none_or(|p| r.plugin == p)).map(|(h, _)| *h).collect();
        for h in handles {
            if let Some(mut r) = running.remove(&h) {
                let _ = r.child.kill();
                let _ = r.child.wait();
            }
        }
    }
}

/// Where a plugin keeps its own files (a downloaded model, for one): outside its
/// install folder, so an update or a signature check never touches them.
pub fn data_dir(plugin: &str) -> Option<PathBuf> {
    crate::dirs_home().map(|h| PathBuf::from(h).join(".termiau/plugin-data").join(plugin))
}

#[derive(Clone, serde::Serialize)]
struct Message {
    handle: u64,
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct Exit {
    handle: u64,
    code: Option<i32>,
}

#[tauri::command]
pub fn plugin_process_spawn(app: AppHandle, state: State<'_, Processes>, plugin: String, binary: String) -> Result<u64, String> {
    let base = plugins::plugins_dir().ok_or("HOME not set")?;
    let installed = plugins::list_in(&base);
    let p = installed
        .iter()
        .find(|p| p.id == plugin && p.enabled)
        .ok_or_else(|| format!("plugin \"{plugin}\" isn't installed and enabled"))?;
    let manifest = p.manifest.as_ref().ok_or_else(|| format!("plugin \"{plugin}\" didn't load"))?;
    let rel = manifest.binaries.get(&binary).ok_or_else(|| format!("plugin \"{plugin}\" declares no binary \"{binary}\""))?;

    let dir = base.join(&plugin);
    if signing::verify_dir(signing::TRUSTED_PUBLISHERS, &dir).is_none() {
        return Err(format!("plugin \"{plugin}\" no longer matches its signature; reinstall it"));
    }
    let file = plugins::resolve_in(&dir, rel).ok_or_else(|| format!("binary \"{rel}\" not found"))?;

    let data = data_dir(&plugin).ok_or("HOME not set")?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;

    let mut child = Command::new(&file)
        .current_dir(&data)
        .env("TERMIAU_PLUGIN_DATA", &data)
        .env("TERMIAU_LANGUAGE", if crate::language::portuguese() { "pt" } else { "en" })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start {binary}: {e}"))?;

    let handle = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    let tag = format!("{plugin}/{binary}");
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[{tag}] {line}");
        }
    });

    let out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = out.emit("plugin-process://message", Message { handle, line });
        }
        // stdout closed: the process ended (or is about to). Reap it if it is still ours.
        let processes = out.state::<Processes>();
        let code = processes.running.lock().unwrap().remove(&handle).and_then(|mut r| r.child.wait().ok()?.code());
        let _ = out.emit("plugin-process://exit", Exit { handle, code });
    });

    state.running.lock().unwrap().insert(handle, Running { plugin, child, stdin });
    Ok(handle)
}

#[tauri::command]
pub fn plugin_process_send(state: State<'_, Processes>, handle: u64, line: String) -> Result<(), String> {
    let mut running = state.running.lock().unwrap();
    let r = running.get_mut(&handle).ok_or("the process isn't running")?;
    let line = line.replace('\n', " ");
    writeln!(r.stdin, "{line}").and_then(|_| r.stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_process_kill(state: State<'_, Processes>, handle: u64) {
    if let Some(mut r) = state.running.lock().unwrap().remove(&handle) {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}
