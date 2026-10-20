mod clipboard;
mod differ;
mod language;
mod marketplace;
mod plugin_process;
mod plugins;
mod progress;
mod signing;
mod window;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use language::tr;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

/// Everything we need to keep from a live PTY session — one per tab.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The shell's pid. Compared to the terminal's foreground group, it tells whether
    /// a program is running in front of it (see `pty_busy`).
    pid: Option<u32>,
    /// Set before we kill the shell on purpose (tab closed, webview
    /// reload). The wait thread checks this so it doesn't announce "exited"
    /// for a tab the user already sent away.
    closing: Arc<AtomicBool>,
    /// Stored at spawn and taken at attach. The threads that consume both
    /// only start once the tab says it is already listening to its events — see
    /// `pty_attach`. Meanwhile the shell's output waits in the PTY buffer.
    reader: Option<Box<dyn Read + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
struct Ptys {
    sessions: Mutex<HashMap<u64, Session>>,
    /// Ids are born here, not in JS: a webview reload would reset the counter there
    /// and the new tab would collide with the orphan session of the same number.
    next_id: AtomicU64,
}

/// What is resolved once at boot and holds for the whole run.
struct Config {
    socket: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            // The pid in the name lets two TermIAu windows coexist without
            // stealing each other's events; the hook finds the path in the panel's environment.
            socket: std::env::temp_dir().join(format!("termiau-{}.sock", std::process::id())),
        }
    }
}

/// Webview errors are invisible in the terminal without this bridge.
#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[termiau] webview error: {msg}");
}

/// Variables a shell session legitimately needs to inherit from the system.
/// Everything else is junk from whoever launched the app (npm, cargo, the parent
/// terminal) and has no business here: the login shell rebuilds PATH, FPATH etc.
const INHERITED_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",              // without this, git/ssh with an agent stop working
    "__CF_USER_TEXT_ENCODING",    // macOS text encoding
];

fn shell(cwd: Option<String>, id: u64, cfg: &Config) -> CommandBuilder {
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(sh);
    cmd.arg("-l"); // login shell: loads the user's full PATH

    // Start from scratch: otherwise the shell inherits the environment of whoever opened
    // the app (npm_*, CARGO_*, ITERM_SESSION_ID...) and behaves as if it were in that context.
    cmd.env_clear();
    for k in INHERITED_ENV {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }

    // Minimal bootstrap PATH; /etc/zprofile + .zshrc build the rest.
    // `termiau` goes last: /etc/zprofile puts the system ones in front and
    // keeps those already there, so it stays findable without getting ahead
    // of anything of yours.
    let mut path = String::from("/usr/bin:/bin:/usr/sbin:/sbin");
    if let Some(bin) = cli_dir() {
        path = format!("{path}:{}", bin.display());
    }
    cmd.env("PATH", path);

    // A new tab inherits the source tab's directory, like iTerm2. A cwd that
    // no longer exists (deleted folder) would make the spawn fail: fall back to HOME.
    let dir = cwd
        .filter(|p| std::path::Path::new(p).is_dir())
        .or_else(dirs_home);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }

    // Without this, TUI apps don't know they can use color.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TermIAu");

    // How the Claude Code hook knows who it is talking to. It runs as a grandchild
    // of this shell, so it inherits both — and outside TermIAu they don't exist, which
    // is what keeps the same hook quiet in another terminal.
    cmd.env("TERMIAU_PANEL", id.to_string());
    cmd.env("TERMIAU_SOCK", &cfg.socket);
    cmd
}

pub(crate) fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Opens a new shell and returns the session id. Its events go out on
/// `pty://data/<id>` and `pty://exit/<id>`, so each tab hears only its own.
/// The shell starts running here, but nobody reads its output until `pty_attach`.
#[tauri::command]
fn pty_spawn(
    state: State<'_, Ptys>,
    cfg: State<'_, Config>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(shell(cwd, id, &cfg)).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    drop(pair.slave); // release the slave side, otherwise we never see EOF

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
            pid,
            closing: Arc::new(AtomicBool::new(false)),
            reader: Some(reader),
            child: Some(child),
        },
    );

    Ok(id)
}

/// Starts the threads that pump the session. Separate from spawn on purpose: an
/// event emitted before the tab calls `listen` would be dropped, and what would
/// be lost is precisely the start of the prompt.
#[tauri::command]
fn pty_attach(app: AppHandle, state: State<'_, Ptys>, id: u64) -> Result<(), String> {
    let (mut reader, mut child, closing) = {
        let mut sessions = state.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("pty not started")?;
        let reader = s.reader.take().ok_or("pty already attached")?;
        let child = s.child.take().ok_or("pty already attached")?;
        (reader, child, s.closing.clone())
    };

    // Reader thread: pumps the shell's output to the window.
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Err(e) => { eprintln!("[termiau] read error on pty {id}: {e}"); break }
                Ok(n) => {
                    // base64 because a chunk may cut a UTF-8 character in half.
                    let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = reader_app.emit(&format!("pty://data/{id}"), payload);
                }
            }
        }
    });

    // Wait thread: tells the UI when the shell dies on its own (`exit`, crash).
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        if !closing.load(Ordering::SeqCst) {
            let _ = app.emit(&format!("pty://exit/{id}"), code);
        }
    });

    Ok(())
}

/// A link from the terminal or the chat, in the default browser. Inside the WebView
/// `window.open` goes nowhere.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !["http://", "https://", "mailto:"].iter().any(|p| url.starts_with(p)) {
        return Err(format!("{}: {url}", tr("link não suportado", "unsupported link")));
    }
    std::process::Command::new("/usr/bin/open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, Ptys>, id: u64, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("pty not started")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, Ptys>, id: u64, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("pty not started")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// The session's current working directory — what the new tab will inherit.
/// On macOS the kernel answers this by the pid of the PTY's foreground process.
#[tauri::command]
fn pty_cwd(state: State<'_, Ptys>, id: u64) -> Option<String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id)?;
    let pid = s.master.process_group_leader()?;
    process_cwd(pid)
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: i32) -> Option<String> {
    // `lsof -a -d cwd` is the path with no new dependency; -F outputs fields
    // prefixed by a letter, and the cwd one is `n`.
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(str::to_string))
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Closes a tab: kills its shell and forgets the session.
#[tauri::command]
fn pty_close(state: State<'_, Ptys>, id: u64) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        s.closing.store(true, Ordering::SeqCst);
        let _ = s.killer.kill();
    }
}

/// Every webview reload starts from scratch: without this the previous tabs'
/// shells would stay alive, with no tab pointing at them.
#[tauri::command]
fn pty_close_all(state: State<'_, Ptys>) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        s.closing.store(true, Ordering::SeqCst);
        let _ = s.killer.kill();
    }
}

/// There is a program in front of the shell — the app the play button launched, a `vim`.
/// The terminal has a foreground process group; when it is the shell itself,
/// the typed command has already finished.
#[tauri::command]
fn pty_busy(state: State<'_, Ptys>, id: u64) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(s) = sessions.get(&id) else { return false };
    match (s.master.process_group_leader(), s.pid) {
        (Some(foreground), Some(shell)) => foreground as u32 != shell,
        _ => false,
    }
}

/// Sends a signal to the foreground program. It goes to the whole group, like
/// Ctrl+C: the children it spawned (a server, the emulator process) exit
/// along with it instead of being orphaned. The shell never gets it — closing the panel
/// is another matter, handled by `pty_close`.
#[tauri::command]
fn pty_signal(state: State<'_, Ptys>, id: u64, signal: i32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("pty not started")?;
    let foreground = s.master.process_group_leader().ok_or("no foreground process")?;
    if Some(foreground as u32) == s.pid {
        return Ok(());
    }
    if unsafe { libc::kill(-foreground, signal) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// The project's `.vscode/launch.json` for a panel, with `tasks.json` beside it.
#[derive(serde::Serialize)]
struct Launch {
    /// The folder holding `.vscode`: it is the configurations' `${workspaceFolder}`.
    folder: String,
    home: String,
    launch: String,
    tasks: Option<String>,
}

/// The nearest one going up from the panel's directory: a panel in a
/// project subfolder still runs the root's launch.json, like VS Code opened
/// at the repository root.
#[tauri::command]
fn launch_read(cwd: String) -> Option<Launch> {
    std::path::Path::new(&cwd).ancestors().find_map(|dir| {
        let vscode = dir.join(".vscode");
        let launch = std::fs::read_to_string(vscode.join("launch.json")).ok()?;
        Some(Launch {
            folder: dir.display().to_string(),
            home: dirs_home().unwrap_or_default(),
            launch,
            tasks: std::fs::read_to_string(vscode.join("tasks.json")).ok(),
        })
    })
}

/// A Dart project is Flutter when the pubspec depends on the Flutter SDK — it is
/// what decides between `flutter run` and `dart run`, as the Dart extension does.
#[tauri::command]
fn is_flutter_project(folder: String) -> bool {
    std::fs::read_to_string(std::path::Path::new(&folder).join("pubspec.yaml"))
        .map(|pubspec| pubspec.contains("sdk: flutter"))
        .unwrap_or(false)
}

/// A chunk of a Claude Code session transcript.
#[derive(serde::Serialize)]
struct TranscriptChunk {
    text: String,
    /// How far this chunk went, in bytes: it is the next read's `since`.
    end: u64,
    /// The start was left out (file too large), or the file shrank and the
    /// read started over: what the screen already showed is no longer valid.
    from_start: bool,
    truncated: bool,
}

/// The full transcript of a long session exceeds tens of MB, almost all of it
/// tool results. The conversation that matters is its end.
const MAX_TRANSCRIPT_BYTES: u64 = 6 * 1024 * 1024;

/// What the transcript gained since `since`. Whole lines only: the last one, if
/// Claude is still writing it, waits for the next read.
///
/// The path comes from the hook, but the webview delivers it — so only a
/// `.jsonl` inside `~/.claude` is accepted, not any file on disk.
#[tauri::command]
fn transcript_read(path: String, since: u64) -> Result<TranscriptChunk, String> {
    use std::io::{Seek, SeekFrom};

    let base = claude_dir().ok_or("no Claude Code folder")?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&base) || file.extension().is_none_or(|e| e != "jsonl") {
        return Err(tr("não é um transcript do Claude Code", "not a Claude Code transcript").into());
    }

    let mut f = std::fs::File::open(&file).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    // Smaller than what was already read: the file was rewritten. Start over.
    let mut from_start = since > size;
    let mut start = if from_start { 0 } else { since };
    let truncated = size - start > MAX_TRANSCRIPT_BYTES;
    if truncated {
        start = size - MAX_TRANSCRIPT_BYTES;
        from_start = true;
    }

    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.take(size - start).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Jumped into the middle of the file: the first line came in half.
    let skip = if truncated { bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| p + 1) } else { 0 };
    let until = bytes.iter().rposition(|b| *b == b'\n').map_or(skip, |p| (p + 1).max(skip));
    // Almost all of the file's weight is tool results (a file read, a
    // command's output), which the chat doesn't show. It stays here: sending it to the
    // webview and making it parse megabytes of JSON froze the screen.
    let mut text = String::new();
    for line in String::from_utf8_lossy(&bytes[skip..until]).lines() {
        let is_message = line.contains(r#""type":"user""#) || line.contains(r#""type":"assistant""#);
        if !is_message {
            continue;
        }
        if !line.contains(r#""tool_use_id""#) {
            text.push_str(line);
            text.push('\n');
        } else if let Some(diff) = diff_from_result(line).or_else(|| diff_from_hook(&file, line)) {
            text.push_str(&diff);
            text.push('\n');
        }
    }
    Ok(TranscriptChunk {
        text,
        end: start + until as u64,
        from_start,
        truncated,
    })
}

/// The diff Claude Code stored in a tool result, already trimmed:
/// `{"type":"diff","files":[{"path","hunks"}]}`. It is the same one the terminal
/// draws, with the file's line numbers. It comes from two places: the
/// `structuredPatch` of an Edit or Write, and the `bashEditDiff` of a command
/// (a `sed -i`, a script) that changed a file. The rest of the result — the
/// whole previous file, in an Edit — stays here.
fn diff_from_result(line: &str) -> Option<String> {
    use serde_json::{json, Value};
    if !line.contains(r#""structuredPatch""#) && !line.contains(r#""bashEditDiff""#) {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let r = v.get("toolUseResult")?;
    let hunks = |h: &Value| -> Vec<Value> {
        h.as_array()
            .into_iter()
            .flatten()
            .map(|h| json!({ "oldStart": h["oldStart"], "newStart": h["newStart"], "lines": h["lines"] }))
            .collect()
    };
    let mut files = Vec::new();
    if let Some(edits) = r.pointer("/bashEditDiff/files").and_then(Value::as_array) {
        for f in edits {
            files.push(json!({ "path": f["filePath"], "hunks": hunks(&f["hunks"]) }));
        }
    } else if let Some(path) = r.get("filePath") {
        let mut h = hunks(&r["structuredPatch"]);
        // New file: Write brings no patch, only the content.
        if h.is_empty() && r.get("type").and_then(Value::as_str) == Some("create") {
            if let Some(c) = r.get("content").and_then(Value::as_str) {
                let lines: Vec<String> = c.lines().map(|l| format!("+{l}")).collect();
                h.push(json!({ "oldStart": 0, "newStart": 1, "lines": lines }));
            }
        }
        files.push(json!({ "path": path, "hunks": h }));
    }
    files.retain(|a| a["hunks"].as_array().is_some_and(|h| !h.is_empty()));
    if files.is_empty() {
        return None;
    }
    Some(json!({ "type": "diff", "files": files }).to_string())
}

/// The diff our hook took from a Bash, for when Claude Code didn't
/// store one (a command that changed a file and ended with an error). It lives in
/// `~/.termiau/diffs/<session>/<tool_use_id>.patch`; the session is the
/// transcript's name.
fn diff_from_hook(transcript: &std::path::Path, line: &str) -> Option<String> {
    let id = line.split(r#""tool_use_id":""#).nth(1)?.split('"').next()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let session = transcript.file_stem()?.to_str()?;
    let patch = PathBuf::from(dirs_home()?).join(".termiau/diffs").join(session).join(format!("{id}.patch"));
    let text = std::fs::read_to_string(patch).ok()?;
    let files = files_from_patch(&text);
    if files.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "diff", "files": files }).to_string())
}

/// A `git diff` into files and hunks, in the same format as Claude Code's
/// `structuredPatch`. The first line, `# root <folder>`, is from the hook: it is what
/// turns git's `a/…` and `b/…` paths absolute. A binary file has no
/// hunk and is left out.
fn files_from_patch(text: &str) -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut lines = text.lines();
    let root = lines.next().and_then(|l| l.strip_prefix("# root ")).unwrap_or("");
    let mut files: Vec<serde_json::Value> = Vec::new();
    let mut path: Option<String> = None;
    let mut hunks: Vec<serde_json::Value> = Vec::new();
    let mut current: Option<(u64, u64, Vec<String>)> = None;
    let close_hunk = |current: &mut Option<(u64, u64, Vec<String>)>, hunks: &mut Vec<serde_json::Value>| {
        if let Some((old, new, ls)) = current.take() {
            hunks.push(json!({ "oldStart": old, "newStart": new, "lines": ls }));
        }
    };
    let close_file =
        |path: &mut Option<String>, hunks: &mut Vec<serde_json::Value>, files: &mut Vec<serde_json::Value>| {
            if let Some(c) = path.take() {
                if !hunks.is_empty() {
                    files.push(json!({ "path": c, "hunks": std::mem::take(hunks) }));
                }
            }
            hunks.clear();
        };
    // The start of a hunk: `@@ -old[,n] +new[,n] @@`.
    let start = |l: &str| -> Option<(u64, u64)> {
        let mut parts = l.strip_prefix("@@ ")?.split(' ');
        let num = |p: &str| p.split(',').next().and_then(|n| n.parse::<u64>().ok());
        Some((num(parts.next()?.strip_prefix('-')?)?, num(parts.next()?.strip_prefix('+')?)?))
    };
    for l in lines {
        if l.starts_with("diff --git ") {
            close_hunk(&mut current, &mut hunks);
            close_file(&mut path, &mut hunks, &mut files);
        } else if current.is_none() && (l.starts_with("--- ") || l.starts_with("+++ ")) {
            // `+++ b/…` gives the name; for a deleted file it is /dev/null, and
            // the `--- a/…` that came before counts.
            if let Some(p) = l[4..].strip_prefix("a/").or_else(|| l[4..].strip_prefix("b/")) {
                path = Some(format!("{}/{}", root.trim_end_matches('/'), p));
            }
        } else if let Some((old, new)) = start(l) {
            close_hunk(&mut current, &mut hunks);
            current = Some((old, new, Vec::new()));
        } else if let Some((_, _, ls)) = current.as_mut() {
            if l.starts_with([' ', '+', '-', '\\']) {
                ls.push(l.to_string());
            } else {
                close_hunk(&mut current, &mut hunks);
            }
        }
    }
    close_hunk(&mut current, &mut hunks);
    close_file(&mut path, &mut hunks, &mut files);
    files
}

/// A `/command` Claude Code accepts beyond its built-in ones: the user's,
/// the project's and the installed plugins' commands and skills.
#[derive(serde::Serialize)]
struct SlashCommand {
    name: String,
    description: String,
}

/// The `description:` in a command's or skill's header. Only the start of the
/// file is read, and only its first line matters: it is what fits in the list.
fn description_of(file: &std::path::Path) -> String {
    let mut text = String::new();
    let Ok(f) = std::fs::File::open(file) else { return text };
    let _ = f.take(16 * 1024).read_to_string(&mut text);
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    lines
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| d.trim().trim_matches(['"', '\'']).chars().take(160).collect())
        .unwrap_or_default()
}

/// The `.md` files of a commands folder. A subfolder becomes a prefix, like in Claude
/// Code: `commands/git/commit.md` is `/git:commit`.
fn commands_in_folder(dir: &std::path::Path, prefix: &str, depth: u8, out: &mut Vec<SlashCommand>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let path = item.path();
        let Some(name) = path.file_stem().and_then(|n| n.to_str()) else { continue };
        if path.is_dir() {
            if depth > 0 {
                commands_in_folder(&path, &format!("{prefix}{name}:"), depth - 1, out);
            }
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(SlashCommand { name: format!("{prefix}{name}"), description: description_of(&path) });
        }
    }
}

/// The skills of a folder: each subfolder with a `SKILL.md` is one.
fn skills_in_folder(dir: &std::path::Path, prefix: &str, out: &mut Vec<SlashCommand>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let skill = item.path().join("SKILL.md");
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        if skill.is_file() {
            out.push(SlashCommand { name: format!("{prefix}{name}"), description: description_of(&skill) });
        }
    }
}

/// What can be called with `/` in the session running in `folder`, besides
/// Claude Code's built-in commands (the webview already knows those). The project
/// comes before the user, and the user before plugins: it is the order the
/// list shows, and the project's are the most used in it.
#[tauri::command]
fn commands_list(folder: Option<String>) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    if let Some(folder) = folder {
        // Going up from the session's folder, as Claude Code does: a session
        // opened in a subfolder still sees the project root's `.claude`.
        for dir in std::path::Path::new(&folder).ancestors() {
            let claude = dir.join(".claude");
            // `~/.claude` is the user's, and comes right below.
            if claude_dir().is_some_and(|d| d == claude) {
                break;
            }
            commands_in_folder(&claude.join("commands"), "", 3, &mut out);
            skills_in_folder(&claude.join("skills"), "", &mut out);
        }
    }
    let Some(base) = claude_dir() else { return out };
    commands_in_folder(&base.join("commands"), "", 3, &mut out);
    skills_in_folder(&base.join("skills"), "", &mut out);

    // Each installed plugin brings its own, called as `/plugin:name`.
    let plugins = std::fs::read_to_string(base.join("plugins/installed_plugins.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(map) = plugins.as_ref().and_then(|p| p["plugins"].as_object()) {
        for (key, installs) in map {
            let plugin = key.split('@').next().unwrap_or(key);
            for inst in installs.as_array().into_iter().flatten() {
                let Some(root) = inst["installPath"].as_str().map(PathBuf::from) else { continue };
                let prefix = format!("{plugin}:");
                commands_in_folder(&root.join("commands"), &prefix, 3, &mut out);
                skills_in_folder(&root.join("skills"), &prefix, &mut out);
            }
        }
    }
    out
}

/// Claude's questions (`AskUserQuestion`) waiting for an answer from chat mode:
/// the hook's connection stays open here, under a number given to it on arrival (the
/// `PermissionRequest` doesn't carry the `tool_use_id`), until the chat answers
/// (`question_answer`) or gives it up (`question_drop`).
#[derive(Default)]
struct PendingQuestions(Mutex<HashMap<String, std::os::unix::net::UnixStream>>);

/// Returns to the hook the decision the chat built, and closes the connection: what is
/// written here is the hook's output, and Claude Code reads it as the answer.
#[tauri::command]
fn question_answer(pending: State<'_, PendingQuestions>, id: String, answer: String) -> Result<(), String> {
    let Some(mut stream) = pending.0.lock().unwrap().remove(&id) else {
        return Err(tr("a pergunta já foi respondida", "the question was already answered").into());
    };
    stream.write_all(answer.as_bytes()).map_err(|e| e.to_string())
}

/// Closes the connection without an answer: the hook exits quietly and the question stays with the
/// terminal. That is what happens when it was answered there.
#[tauri::command]
fn question_drop(pending: State<'_, PendingQuestions>, id: String) {
    pending.0.lock().unwrap().remove(&id);
}

/// Listens to the events Claude Code's hooks send and hands them to the webview.
/// A unix socket, one connection per event: the hook writes a JSON and closes. The
/// exception is Claude's question: it arrives with `"wait":true` and a trailing
/// newline, and the connection stays open waiting for the answer (see
/// `PendingQuestions`).
///
/// Why a socket and not an escape sequence through the panel's own output: the
/// latter would be more elegant (the panel's identity would come for free), but the
/// hook and Claude Code write to the same tty at the same time, and a `delta` of
/// a few KB exceeds the size at which writes stop being atomic — the risk is
/// chopping one of Claude's own sequences and garbling the screen.
fn listen_hooks(app: AppHandle, path: PathBuf) {
    let _ = std::fs::remove_file(&path);
    clean_orphan_sockets(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return eprintln!("[termiau] couldn't open {path:?}: {e}"),
    };

    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(stream) = connection else { continue };
            let app = app.clone();
            // One thread per event: a slow hook must not hold up the others' queue.
            std::thread::spawn(move || {
                use std::io::BufRead;
                let mut text = String::new();
                // Up to the newline or the end, whichever comes first. A ceiling so an
                // absurd payload doesn't turn into endless memory.
                let Ok(reader) = stream.try_clone() else { return };
                if std::io::BufReader::new(reader.take(256 * 1024)).read_line(&mut text).is_err() {
                    return;
                }
                if text.trim().is_empty() {
                    return;
                }
                // `termiau progress` waits for the answer: a plan that doesn't hold up goes
                // back to Claude as the command's error, for it to fix.
                if let Some(checked) = progress::from_socket(&text) {
                    let mut stream = stream;
                    let _ = match checked {
                        Ok(event) => {
                            let _ = app.emit("claude://event", event);
                            stream.write_all(b"ok\n")
                        }
                        Err(e) => writeln!(stream, "error: {e}"),
                    };
                    return;
                }
                // The question gets a number, which goes along to the webview: it is
                // how the answer comes back to this connection.
                let text = match waiting_question(&text) {
                    Some(mut v) => {
                        static NEXT: AtomicU64 = AtomicU64::new(1);
                        let id = format!("question-{}", NEXT.fetch_add(1, Ordering::Relaxed));
                        v["question_id"] = id.clone().into();
                        app.state::<PendingQuestions>().0.lock().unwrap().insert(id, stream);
                        v.to_string()
                    }
                    None => text,
                };
                let _ = app.emit("claude://event", text);
            });
        }
    });
}

/// The event, already read, if it is a question that expects an answer.
fn waiting_question(text: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    (v["wait"].as_bool() == Some(true)).then_some(v)
}

// ---------- the viewer: a file shown inside the panel ----------

/// The command Claude (or you) runs to open a file in the panel:
/// `termiau view file:line`. It only talks to the socket, like the hook.
const CLI: &str = include_str!("../../hooks/termiau");

fn cli_dir() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".termiau/bin"))
}

/// Writes `termiau` to ~/.termiau/bin every time the app opens, if it changed. It
/// lives outside the bundle because the panel's shell needs to find it at a fixed path,
/// and that path is how the hook teaches it to Claude.
fn install_cli() {
    use std::os::unix::fs::PermissionsExt;
    let Some(dir) = cli_dir() else { return };
    let target = dir.join("termiau");
    if std::fs::read_to_string(&target).is_ok_and(|t| t == CLI) {
        return;
    }
    let done = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&target, CLI))
        .and_then(|_| std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)));
    if let Err(e) = done {
        eprintln!("[termiau] couldn't install {target:?}: {e}");
    }
}

/// Above this the viewer won't open: it is a file to read, not a log of gigabytes.
const VIEWER_MAX: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize)]
struct ViewerFile {
    lines: Vec<String>,
    /// Changes when the file changes on disk: it is what the viewer compares to
    /// redraw while Claude edits. Empty for a git version, which doesn't change.
    stamp: String,
}

fn stamp(path: &std::path::Path) -> Option<String> {
    let m = std::fs::metadata(path).ok()?;
    let modified_at = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}", modified_at.as_nanos(), m.len()))
}

fn viewer_lines(bytes: Vec<u8>) -> Result<Vec<String>, String> {
    if bytes.len() as u64 > VIEWER_MAX {
        return Err(tr("arquivo grande demais para o visor (mais de 5 MB)", "file too large for the viewer (over 5 MB)").into());
    }
    // Same guess as git: a NUL at the start means a binary file.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(tr("é um arquivo binário", "it's a binary file").into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    Ok(text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect())
}

/// The file's bytes and its stamp. With `git_ref`, as it is at that commit or
/// branch (`git show <git_ref>:./<file>`), not on disk — it is "how it was on main" —, and
/// with no stamp, since a git version doesn't change.
fn file_bytes(path: &str, git_ref: Option<String>) -> Result<(Vec<u8>, String), String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{}: {path}", tr("caminho relativo", "relative path")));
    }
    let Some(git_ref) = git_ref.filter(|r| !r.is_empty()) else {
        if !p.is_file() {
            return Err(format!("{}: {path}", tr("não existe", "doesn't exist")));
        }
        let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
        return Ok((bytes, stamp(p).unwrap_or_default()));
    };
    // A ref starting with `-` would become a git option.
    if git_ref.starts_with('-') || git_ref.contains(char::is_whitespace) {
        return Err(format!("{}: {git_ref}", tr("ref inválida", "invalid ref")));
    }
    let folder = p.parent().ok_or("path has no folder")?;
    let name = p.file_name().ok_or("path has no name")?.to_string_lossy();
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(folder)
        .arg("show")
        .arg(format!("{git_ref}:./{name}"))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let error = String::from_utf8_lossy(&out.stderr);
        return Err(error.lines().next().unwrap_or(tr("git show falhou", "git show failed")).to_string());
    }
    Ok((out.stdout, String::new()))
}

/// The whole file, as lines.
#[tauri::command(async)]
fn file_read(path: String, git_ref: Option<String>) -> Result<ViewerFile, String> {
    let (bytes, stamp) = file_bytes(&path, git_ref)?;
    Ok(ViewerFile { lines: viewer_lines(bytes)?, stamp })
}

/// Above this the viewer won't show an image: it travels to the page as base64.
const MAX_IMAGE: usize = 25 * 1024 * 1024;

#[derive(serde::Serialize)]
struct Image {
    url: String,
    stamp: String,
}

/// An image for the viewer, as a data URL. The type comes from the extension, the
/// same one that made the viewer ask for an image.
#[tauri::command(async)]
fn file_image(path: String, git_ref: Option<String>) -> Result<Image, String> {
    let (bytes, stamp) = file_bytes(&path, git_ref)?;
    if bytes.len() > MAX_IMAGE {
        return Err(tr("imagem grande demais para o visor (mais de 25 MB)", "image too large for the viewer (over 25 MB)").into());
    }
    let ext = path.rsplit('.').next().unwrap_or_default().to_lowercase();
    let kind = match ext.as_str() {
        "jpg" | "jpeg" => "jpeg",
        "ico" => "x-icon",
        "tif" => "tiff",
        other => other,
    };
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Image { url: format!("data:image/{kind};base64,{data}"), stamp })
}

/// Cheap enough for the viewer to ask every second: just a `stat`.
#[tauri::command]
fn file_stamp(path: String) -> Option<String> {
    stamp(std::path::Path::new(&path))
}

/// A checkbox clicked in a rendered .md: line `line` (from 0) goes from `before` to
/// `after` on disk, and returns the new stamp. Not async on purpose: two quick
/// clicks are written in order.
#[tauri::command]
fn file_replace_line(path: String, line: usize, before: String, after: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("{}: {path}", tr("caminho relativo", "relative path")));
    }
    let text = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    std::fs::write(p, replace_line(&text, line, &before, &after)?).map_err(|e| e.to_string())?;
    Ok(stamp(p).unwrap_or_default())
}

/// The viewer's edit mode, saving. `since` is the stamp the text was loaded with: if the
/// file changed on disk since (Claude edited it), nothing is written — saving would
/// erase that edit. Returns the new stamp.
#[tauri::command]
fn file_save(path: String, text: String, since: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("{}: {path}", tr("caminho relativo", "relative path")));
    }
    if stamp(p).unwrap_or_default() != since {
        return Err(tr(
            "o arquivo mudou no disco desde que a edição começou",
            "the file changed on disk since editing started",
        )
        .into());
    }
    let before = std::fs::read(p).map_err(|e| e.to_string())?;
    std::fs::write(p, with_line_endings(&text, &before)).map_err(|e| e.to_string())?;
    Ok(stamp(p).unwrap_or_default())
}

/// The text box only knows `\n` and the viewer dropped the final newline: the file
/// gets back its CRLF, if it had them, and its final newline.
fn with_line_endings(text: &str, before: &[u8]) -> String {
    let end = if before.windows(2).any(|w| w == b"\r\n") { "\r\n" } else { "\n" };
    let mut out = text.replace('\n', end);
    if before.ends_with(b"\n") && !text.is_empty() {
        out.push_str(end);
    }
    out
}

/// The rest of the file stays byte for byte, line endings included. If the line is no
/// longer `before`, the file changed under the viewer and nothing is replaced.
fn replace_line(text: &str, line: usize, before: &str, after: &str) -> Result<String, String> {
    let changed = || tr("a linha mudou no disco", "the line changed on disk").to_string();
    let mut out = String::with_capacity(text.len() + after.len());
    let mut found = false;
    for (i, part) in text.split_inclusive('\n').enumerate() {
        if i != line {
            out.push_str(part);
            continue;
        }
        let body = part.trim_end_matches(['\n', '\r']);
        if body != before {
            return Err(changed());
        }
        out.push_str(after);
        out.push_str(&part[body.len()..]);
        found = true;
    }
    if found { Ok(out) } else { Err(changed()) }
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    folder: bool,
}

/// A folder's entries, for the file explorer: folders first, then files, by name
/// ignoring case. `.git` and `.DS_Store` stay out — nobody opens them from there.
#[tauri::command(async)]
fn folder_list(path: String) -> Result<Vec<DirEntry>, String> {
    let mut items: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".DS_Store" {
                return None;
            }
            // `metadata` follows links: a link to a folder opens as a folder.
            let folder = std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            Some(DirEntry { name, folder })
        })
        .collect();
    items.sort_by(|a, b| b.folder.cmp(&a.folder).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(items)
}

/// Which of these paths (relative to `base`, absolute or with `~`) are files
/// that exist, already absolute. It is what tells a real `user_repository.dart:103`
/// apart from any `e.g.` in the terminal output.
#[tauri::command(async)]
fn files_exist(base: String, candidates: Vec<String>) -> Vec<Option<String>> {
    let home = dirs_home().unwrap_or_default();
    candidates
        .into_iter()
        .map(|c| {
            let p = if let Some(rest) = c.strip_prefix("~/") {
                PathBuf::from(&home).join(rest)
            } else {
                PathBuf::from(&base).join(&c)
            };
            p.is_file().then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

/// The file's folder in Finder, with the file selected (`open -R`). Gone from disk
/// (a file seen at a git ref, since deleted), the nearest folder that still exists.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let mut target = std::path::Path::new(&path);
    if !target.is_absolute() {
        return Err(format!("{}: {path}", tr("caminho relativo", "relative path")));
    }
    while !target.exists() {
        target = target.parent().ok_or_else(|| tr("pasta não encontrada", "folder not found").to_string())?;
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(target).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens the file in the editor, at the line. `command` is the one from Preferences, with
/// `{file}` and `{line}`, run in an interactive login shell: that is what reads
/// .zshrc, where the aliases live (a `work='codium .'`) and the PATH for `cursor`,
/// `zed` and `code`. It runs at the file's repository root, so a `.` in the
/// alias is the project, not the app's folder. Without it, VS Code through `vscode://`, which
/// jumps to the line even with the editor already open and doesn't need `code`.
#[tauri::command(async)]
fn open_in_editor(path: String, line: Option<u32>, command: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&path).is_absolute() {
        return Err(format!("{}: {path}", tr("caminho relativo", "relative path")));
    }
    let line = line.unwrap_or(1);
    let Some(command) = command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) else {
        // Percent-encode what isn't safe in a URL: the space in a
        // "/Volumes/External MacOS" would break the link.
        let encoded: String = path
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let url = format!("vscode://file{encoded}:{line}");
        std::process::Command::new("/usr/bin/open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    };
    let command_line = editor_command(&command, &path, line);
    let folder = std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")).to_path_buf();
    let root = std::process::Command::new("git")
        .arg("-C")
        .arg(&folder)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(folder);
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(sh)
        .args(["-i", "-l", "-c", &command_line])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // `code -g` returns right away; an editor that stays attached to the terminal (`--wait`)
    // must not hold the button. Up to 5 s to find out whether it failed, then let go.
    for _ in 0..50 {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) if st.success() => return Ok(()),
            Some(st) => {
                let mut error = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut error);
                }
                // The last line: the first ones are from .zshrc (the prompt, plugin
                // warnings), and the command's error comes after them.
                let last = error.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return Err(if last.is_empty() { format!("{} {st}", tr("o comando saiu com", "the command exited with")) } else { last });
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The Preferences command with the file and line filled in. The path goes
/// in single quotes (a space in the name doesn't split the argument); without
/// `{file}` in the command, it goes at the end.
fn editor_command(command: &str, path: &str, line: u32) -> String {
    let quoted = format!("'{}'", path.replace('\'', "'\\''"));
    let with_line = command.replace("{line}", &line.to_string());
    if with_line.contains("{file}") {
        with_line.replace("{file}", &quoted)
    } else {
        format!("{with_line} {quoted}")
    }
}

// ---------- hooks: installing them from inside the app ----------

/// The hook ships inside the binary: someone who downloaded only the app doesn't have the
/// repository to run `hooks/install.sh` from. That script still works and does
/// the same as `hooks_install` here.
const HOOK: &str = include_str!("../../hooks/termiau-event.sh");
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "SessionEnd",
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
];

/// How our hook is registered on each event.
///
/// Tool events only matter for Bash — the snapshot before and after a
/// command, for the diff Claude Code doesn't store (see `diff_do_bash` in the
/// hook) — and, after it, for Claude's question: it is the notice that it was
/// answered in the terminal and the chat card can go. Without the matcher, the hook
/// would run on every Read.
///
/// `PermissionRequest` has an hour: on a Claude question, the hook keeps
/// waiting for the chat's answer (see `PendingQuestions`). On other requests it
/// returns right away, like the rest.
fn group_for_event(event: &str, command: &str) -> serde_json::Value {
    let timeout = if event == "PermissionRequest" { 3600 } else { 5 };
    let mut group = serde_json::json!({
        "hooks": [{ "type": "command", "command": command, "timeout": timeout }]
    });
    match event {
        "PreToolUse" => group["matcher"] = "Bash".into(),
        "PostToolUse" | "PostToolUseFailure" => group["matcher"] = "Bash|AskUserQuestion".into(),
        _ => {}
    }
    group
}

fn claude_dir() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".claude"))
}

const HOOK_FILE: &str = "termiau-event.sh";

fn hook_is_current(h: &serde_json::Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains(HOOK_FILE))
}

/// `statusLine` goes through the same hook, with the `status` argument: it is how
/// the app gets the session's context and Claude's usage (see the start of
/// termiau-event.sh). A status line that isn't ours stays where it is —
/// whoever put it there wanted something else.
fn status_line_current(settings: &serde_json::Value) -> bool {
    let s = &settings["statusLine"];
    s.is_object() && !hook_is_current(s) || hook_is_current(s) && s["command"].as_str().is_some_and(|c| c.ends_with(" status"))
}

fn status_line(command: &str) -> serde_json::Value {
    serde_json::json!({ "type": "command", "command": format!("{command} status"), "padding": 0 })
}

/// settings.json already calls our hook on every event, and the way
/// this version registers it: a changed matcher or timeout also calls for
/// reinstalling.
fn hooks_registered(settings: &serde_json::Value) -> bool {
    status_line_current(settings) && HOOK_EVENTS.iter().all(|e| {
        settings["hooks"][*e].as_array().is_some_and(|groups| {
            groups.iter().any(|g| {
                let Some(ours) = g["hooks"].as_array().and_then(|hs| hs.iter().find(|h| hook_is_current(h))) else {
                    return false;
                };
                let expected = group_for_event(e, ours["command"].as_str().unwrap_or(""));
                g["matcher"] == expected["matcher"] && ours["timeout"] == expected["hooks"][0]["timeout"]
            })
        })
    })
}

/// Where the Claude Code link stands: `no-claude` (no `~/.claude`),
/// `missing` (never installed), `outdated` (installed by an earlier
/// version of the app) or `installed`.
#[tauri::command]
fn hooks_state() -> &'static str {
    let Some(dir) = claude_dir().filter(|d| d.is_dir()) else { return "no-claude" };
    let script = dir.join("hooks").join(HOOK_FILE);
    if !script.exists() {
        return "missing";
    }
    let script_current = std::fs::read_to_string(&script).is_ok_and(|s| s == HOOK);
    let registered = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|s| hooks_registered(&s));
    if script_current && registered { "installed" } else { "outdated" }
}

/// Copies the hook to `~/.claude/hooks` and registers it in Claude Code's
/// settings.json. Idempotent, and settings gets a backup beside it before being touched.
#[tauri::command]
fn hooks_install() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = claude_dir().ok_or(tr("não achei a pasta do usuário", "couldn't find the user folder"))?;
    let target = dir.join("hooks").join(HOOK_FILE);
    std::fs::create_dir_all(dir.join("hooks")).map_err(|e| e.to_string())?;
    std::fs::write(&target, HOOK).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    let path = dir.join("settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // A settings.json that can't be read isn't rewritten: better to go without the
    // hook than to erase someone's configuration.
    let mut settings: serde_json::Value = match text.as_deref().map(str::trim) {
        None | Some("") => serde_json::json!({}),
        Some(t) => serde_json::from_str(t)
            .map_err(|e| format!("{}: {e}", tr("o settings.json do Claude Code está ilegível", "Claude Code's settings.json is unreadable")))?,
    };
    if hooks_registered(&settings) {
        return Ok(());
    }
    settings
        .as_object_mut()
        .ok_or(tr("o settings.json do Claude Code não é um objeto", "Claude Code's settings.json is not an object"))?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let command = format!("bash {}", target.display());
    if !status_line_current(&settings) {
        settings["statusLine"] = status_line(&command);
    }
    let hooks = settings["hooks"].as_object_mut().ok_or(tr("o \"hooks\" do settings.json do Claude Code não é um objeto", "the \"hooks\" in Claude Code's settings.json is not an object"))?;
    for event in HOOK_EVENTS {
        // Any previous registration of our hook goes out, a new one goes in at the end.
        let mut groups =
            hooks.get(*event).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for g in &mut groups {
            if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                hs.retain(|h| !hook_is_current(h));
            }
        }
        groups.retain(|g| g["hooks"].as_array().is_some_and(|hs| !hs.is_empty()));
        groups.push(group_for_event(event, &command));
        hooks.insert(event.to_string(), serde_json::Value::Array(groups));
    }

    if text.is_some() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::copy(&path, dir.join(format!("settings.json.bak-{now}")))
            .map_err(|e| e.to_string())?;
    }
    let new_text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Direct write, no rename: the settings.json of dotfiles users
    // is a link, and a `rename` over it would put a file in its place.
    std::fs::write(&path, new_text + "\n").map_err(|e| e.to_string())
}

/// One socket is left over per run that died without exiting cleanly (a `kill`, a crash).
/// Since the name carries the pid, we can tell which ones no longer have an owner.
fn clean_orphan_sockets(current: &PathBuf) {
    let Some(dir) = current.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path == *current {
            continue;
        }
        let Some(pid) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("termiau-"))
            .and_then(|n| n.strip_suffix(".sock"))
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        // Signal 0 does nothing: it only asks whether the process still exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The app's data folder: the session file and the "restore tabs" flag live there.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("{}: {e}", tr("sem diretório de dados", "no data directory")))
}

// ---------- session: the tabs that come back on the next launch ----------

/// A single file, in the app's data folder: the open tabs, each one's
/// layout and each panel's Claude session. The webview builds and reads it —
/// only text goes in and out here. In a file, not localStorage: the webview
/// writes its own whenever it pleases, and may not flush it before the app quits.
fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("session.json"))
}

/// Coming back with the tabs is the user's choice (TermIAu ▸ Restore Tabs on
/// Open), and starts off. The choice is this file's existence: the menu is
/// built here in Rust, before the webview exists to say anything.
fn restore_marker(app: &AppHandle) -> Option<PathBuf> {
    Some(data_dir(app).ok()?.join("restore-tabs"))
}

#[tauri::command]
fn restore_enabled(app: AppHandle) -> bool {
    restore_marker(&app).is_some_and(|m| m.exists())
}

/// The click on the menu item. macOS itself toggles the checkmark; from here go the
/// flag on disk and the notice to the webview.
fn toggle_restore(app: &AppHandle) {
    let Some(marker) = restore_marker(app) else { return };
    let enabled = !marker.exists();
    let done = if enabled {
        marker.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&marker, ""))
    } else {
        std::fs::remove_file(&marker)
    };
    if let Err(e) = done {
        eprintln!("[termiau] couldn't save the restore-tabs choice: {e}");
    }
    let _ = app.emit("menu://restore", marker.exists());
}

/// Off, there is nothing to bring back: the webview opens a new tab. The session
/// keeps being saved just the same — turning it on midday already counts for the
/// next launch.
#[tauri::command]
fn session_read(app: AppHandle) -> Option<String> {
    if !restore_enabled(app.clone()) {
        return None;
    }
    std::fs::read_to_string(session_file(&app).ok()?).ok()
}

#[tauri::command]
fn session_save(app: AppHandle, data: String) -> Result<(), String> {
    let target = session_file(&app)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write alongside and rename: an app killed mid-write leaves the
    // previous file whole, not half a JSON.
    let draft = target.with_extension("json.tmp");
    std::fs::write(&draft, data).map_err(|e| e.to_string())?;
    std::fs::rename(&draft, &target).map_err(|e| e.to_string())
}

/// Quits the app. The webview calls it, after the user confirms and the
/// session is saved.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Tauri's default menu reserves ⌘W for "Close Window" and the macOS menu
/// consumes the shortcut before the webview — the tab never saw the key. We replace the
/// whole menu so ⌘T and ⌘W belong to the tabs; the native Edit items
/// stay there because ⌘C/⌘V depend on them.
pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = Submenu::with_items(
        app,
        "TermIAu",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(tr("Sobre o TermIAu", "About TermIAu")), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            // ⌘, is where every macOS app keeps this — and, being a menu item,
            // the key never even reaches the webview: the menu takes it first.
            &MenuItem::with_id(app, "preferences", tr("Preferências…", "Preferences…"), true, Some("CmdOrCtrl+,"))?,
            // Turning it on also installs Claude Code's hooks, which is where the
            // session to resume in each panel comes from.
            &CheckMenuItem::with_id(
                app,
                "restore",
                tr("Restaurar Abas ao Abrir", "Restore Tabs on Launch"),
                true,
                restore_enabled(app.clone()),
                None::<&str>,
            )?,
            // The hooks alone, for those who only want the "waiting" notice on the tabs.
            &MenuItem::with_id(app, "hooks", tr("Ligar ao Claude Code…", "Connect to Claude Code…"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(tr("Serviços", "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(tr("Ocultar TermIAu", "Hide TermIAu")))?,
            &PredefinedMenuItem::hide_others(app, Some(tr("Ocultar Outros", "Hide Others")))?,
            &PredefinedMenuItem::separator(app)?,
            // Our own item, not the ready-made `quit`: that one quits the app at once, and
            // a stray ⌘Q takes away all the shells. This one only tells the
            // webview, which asks first (see `askQuit` in main.ts).
            &MenuItem::with_id(app, "quit", tr("Sair do TermIAu", "Quit TermIAu"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let file = Submenu::with_items(
        app,
        tr("Arquivo", "File"),
        true,
        &[
            &MenuItem::with_id(app, "new-tab", tr("Nova Aba", "New Tab"), true, Some("CmdOrCtrl+T"))?,
            // Like in the browser: brings back the last closed tab (or panel), with its
            // layout and Claude sessions resumed.
            &MenuItem::with_id(
                app,
                "reopen-tab",
                tr("Reabrir Aba ou Painel Fechado", "Reopen Closed Tab or Panel"),
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "split-right", tr("Dividir ao Lado", "Split Right"), true, Some("CmdOrCtrl+D"))?,
            &MenuItem::with_id(
                app,
                "split-down",
                tr("Dividir Abaixo", "Split Down"),
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            // Toggles: maximizes the focused panel or brings the others back on screen.
            &MenuItem::with_id(
                app,
                "maximize",
                tr("Maximizar ou Recolher Painel", "Maximize or Restore Pane"),
                true,
                Some("CmdOrCtrl+Shift+Enter"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Closes the focused panel; with a single panel, the whole tab goes.
            &MenuItem::with_id(app, "close", tr("Fechar", "Close"), true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::close_window(app, Some(tr("Fechar Janela", "Close Window")))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        tr("Editar", "Edit"),
        true,
        &[
            &PredefinedMenuItem::copy(app, Some(tr("Copiar", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr("Colar", "Paste")))?,
            // ⌘V pastes the file's name (or nothing, if Finder left no
            // text); this one pastes the path, which is what works as an argument.
            &MenuItem::with_id(
                app,
                "paste-path",
                tr("Colar Caminho", "Paste Path"),
                true,
                Some("CmdOrCtrl+Shift+V"),
            )?,
            &PredefinedMenuItem::select_all(app, Some(tr("Selecionar Tudo", "Select All")))?,
        ],
    )?;

    // How the focused panel's Claude session is shown: its terminal or the
    // conversation in bubbles. And the jumps between what you wrote, which work in
    // both modes — ⌘⇧↑ and ⌘⇧↓ are iTerm2's mark jumps.
    let view_menu = Submenu::with_items(
        app,
        tr("Exibir", "View"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "chat",
                tr("Alternar entre Chat e Terminal", "Toggle Chat and Terminal"),
                true,
                Some("CmdOrCtrl+Shift+C"),
            )?,
            &MenuItem::with_id(
                app,
                "viewer",
                tr("Mostrar ou Esconder o Arquivo", "Show or Hide File"),
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &MenuItem::with_id(
                app,
                "compact",
                tr("Compactar a Conversa do Claude", "Compact Claude Conversation"),
                true,
                Some("CmdOrCtrl+Shift+K"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "previous-message",
                tr("Sua Mensagem Anterior", "Your Previous Message"),
                true,
                Some("CmdOrCtrl+Shift+Up"),
            )?,
            &MenuItem::with_id(
                app,
                "next-message",
                tr("Sua Próxima Mensagem", "Your Next Message"),
                true,
                Some("CmdOrCtrl+Shift+Down"),
            )?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        tr("Janela", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(tr("Minimizar", "Minimize")))?,
            &PredefinedMenuItem::fullscreen(app, Some(tr("Tela Cheia", "Enter Full Screen")))?,
        ],
    )?;

    // The shortcut list. ⌘/ is the help shortcut in most apps; as a menu
    // item, the key stays with the menu and doesn't reach the shell.
    let help_menu = Submenu::with_items(
        app,
        tr("Ajuda", "Help"),
        true,
        &[&MenuItem::with_id(app, "shortcuts", tr("Atalhos do Teclado", "Keyboard Shortcuts"), true, Some("CmdOrCtrl+/"))?],
    )?;

    // The plugins' menus go between the app's own and Window/Help, like in VS Code
    // (see plugins.rs). Rebuilt whenever a plugin is installed, enabled or removed.
    let plugin_menus = plugins::menus(app)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&app_menu, &file, &edit_menu, &view_menu];
    items.extend(plugin_menus.iter().map(|s| s as &dyn tauri::menu::IsMenuItem<tauri::Wry>));
    items.extend([&window_menu as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &help_menu]);
    app.set_menu(Menu::with_items(app, &items)?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The differ keeps, in a JSON in the app's data folder, each repository's
        // target branch and what has already been reviewed.
        .plugin(tauri_plugin_store::Builder::new().build())
        // The installed plugins' files and the marketplace's icons (see plugins.rs).
        .register_uri_scheme_protocol(plugins::SCHEME, |ctx, request| plugins::serve(ctx.app_handle(), request))
        .setup(|app| {
            let cfg = Config::default();
            listen_hooks(app.handle().clone(), cfg.socket.clone());
            app.manage(cfg);
            app.manage(Ptys::default());
            app.manage(PendingQuestions::default());
            app.manage(differ::RepoWatcher::default());
            app.manage(differ::RunningAsks::default());
            app.manage(window::Last::default());
            app.manage(plugins::Opened::default());
            app.manage(plugin_process::Processes::default());
            // Born hidden (tauri.conf.json): it shows already in its place, without jumping there.
            if let Some(w) = app.get_webview_window("main") {
                window::show(&w);
            }
            build_menu(app.handle())?;
            install_cli();
            Ok(())
        })
        .on_window_event(|w, ev| match ev {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => window::record(w),
            tauri::WindowEvent::CloseRequested { .. } => window::save(w.app_handle()),
            _ => {}
        })
        // The menu only knows the key was pressed; the webview owns the tabs.
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "new-tab" => { let _ = app.emit("menu://new-tab", ()); }
            "reopen-tab" => { let _ = app.emit("menu://reopen-tab", ()); }
            "quit" => { let _ = app.emit("menu://quit", ()); }
            "hooks" => { let _ = app.emit("menu://hooks", ()); }
            "restore" => toggle_restore(app),
            "split-right" => { let _ = app.emit("menu://split-right", ()); }
            "split-down" => { let _ = app.emit("menu://split-down", ()); }
            "maximize" => { let _ = app.emit("menu://maximize", ()); }
            "close" => { let _ = app.emit("menu://close", ()); }
            "paste-path" => { let _ = app.emit("menu://paste-path", ()); }
            "preferences" => { let _ = app.emit("menu://preferences", ()); }
            "shortcuts" => { let _ = app.emit("menu://shortcuts", ()); }
            "chat" => { let _ = app.emit("menu://chat", ()); }
            "viewer" => { let _ = app.emit("menu://viewer", ()); }
            "compact" => { let _ = app.emit("menu://compact", ()); }
            "previous-message" => { let _ = app.emit("menu://message", -1); }
            "next-message" => { let _ = app.emit("menu://message", 1); }
            id => { plugins::on_menu(app, id); }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_attach,
            pty_write,
            open_link,
            file_read,
            file_stamp,
            file_replace_line,
            file_save,
            file_image,
            folder_list,
            files_exist,
            open_in_editor,
            reveal_in_finder,
            pty_resize,
            pty_cwd,
            pty_close,
            pty_close_all,
            pty_busy,
            pty_signal,
            session_read,
            session_save,
            restore_enabled,
            hooks_state,
            hooks_install,
            question_answer,
            question_drop,
            quit,
            launch_read,
            is_flutter_project,
            transcript_read,
            commands_list,
            clipboard::clipboard_paste,
            differ::open_repo,
            differ::load_diff,
            differ::load_diff_since,
            differ::load_diff_working,
            differ::read_blob,
            differ::read_blob_bytes,
            differ::read_worktree,
            differ::read_worktree_bytes,
            differ::repo_root,
            differ::repo_branch,
            differ::working_stamp,
            differ::stage,
            differ::unstage,
            differ::commit,
            differ::watch_repo,
            differ::claude_sessions,
            differ::ask_claude,
            differ::cancel_ask,
            differ::undo_ask,
            plugins::plugins_list,
            plugins::plugins_install,
            plugins::plugins_remove,
            plugins::plugins_set_enabled,
            plugins::plugins_take_opened,
            plugins::plugins_install_file,
            marketplace::marketplace_catalog,
            marketplace::marketplace_install,
            plugin_process::plugin_process_spawn,
            plugin_process::plugin_process_send,
            plugin_process::plugin_process_kill,
            js_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building TermIAu")
        .run(|app, event| {
            // A .termiau opened from Finder (see plugins.rs and Info.plist).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                plugins::on_opened(app, urls);
            }
            if let tauri::RunEvent::Exit = event {
                // The plugins' native processes (dictation's engine) die with the app.
                app.state::<plugin_process::Processes>().kill(None);
                window::save(app);
                // The socket is a real file; without this one would be left per
                // run in the temp directory.
                let _ = std::fs::remove_file(&app.state::<Config>().socket);
            }
        });
}

#[cfg(test)]
mod patch_tests {
    use super::{files_from_patch, waiting_question};

    #[test]
    fn only_a_waiting_question_keeps_the_connection() {
        let wait = r#"{"panel":1,"event":{"tool_name":"AskUserQuestion"},"wait":true}"#;
        assert!(waiting_question(&format!("{wait}\n")).is_some());
        assert!(waiting_question(r#"{"panel":1,"event":{"tool_name":"AskUserQuestion"}}"#).is_none());
        assert!(waiting_question("junk").is_none());
    }

    #[test]
    fn reads_the_hook_patch() {
        let patch = "# root /repo\n\
diff --git a/new.txt b/new.txt\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/new.txt\n\
@@ -0,0 +1 @@\n\
+new\n\
diff --git a/x.txt b/x.txt\n\
--- a/x.txt\n\
+++ b/x.txt\n\
@@ -1,3 +1,3 @@\n\
 a\n\
-b\n\
+B\n\
@@ -40 +40 @@\n\
--- old\n\
+++ new\n\
diff --git a/deleted.txt b/deleted.txt\n\
--- a/deleted.txt\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-x\n\
diff --git a/img.png b/img.png\n\
Binary files a/img.png and b/img.png differ\n";
        let a = files_from_patch(patch);
        let paths: Vec<_> = a.iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["/repo/new.txt", "/repo/x.txt", "/repo/deleted.txt"]);
        assert_eq!(a[0]["hunks"][0]["newStart"], 1);
        // Inside a hunk, `--- old` is a removed line, not a header.
        assert_eq!(a[1]["hunks"][1]["lines"], serde_json::json!(["--- old", "+++ new"]));
        assert_eq!(a[1]["hunks"][0]["oldStart"], 1);
    }
}

#[cfg(test)]
mod viewer_tests {
    use super::{file_read, files_exist, with_line_endings, editor_command, folder_list, viewer_lines, replace_line};

    #[test]
    fn lists_folders_first_then_by_name() {
        let items = folder_list(env!("CARGO_MANIFEST_DIR").into()).unwrap();
        let first_file = items.iter().position(|e| !e.folder).unwrap();
        assert!(items[..first_file].iter().all(|e| e.folder));
        assert!(items[first_file..].iter().all(|e| !e.folder));
        assert!(items.iter().any(|e| e.folder && e.name == "src"));
        assert!(items.iter().any(|e| !e.folder && e.name == "Cargo.toml"));
        assert!(items.iter().all(|e| e.name != ".DS_Store"));
    }

    #[test]
    fn save_keeps_the_file_line_endings() {
        assert_eq!(with_line_endings("a\nb", b"x\ny\n"), "a\nb\n");
        assert_eq!(with_line_endings("a\nb", b"x\r\ny\r\n"), "a\r\nb\r\n");
        assert_eq!(with_line_endings("a\nb", b"x\ny"), "a\nb");
        assert_eq!(with_line_endings("", b"x\n"), "");
    }

    #[test]
    fn replaces_only_the_line_and_keeps_endings() {
        assert_eq!(replace_line("a\r\n- [ ] b\r\nc", 1, "- [ ] b", "- [x] b").unwrap(), "a\r\n- [x] b\r\nc");
        assert_eq!(replace_line("- [x] b", 0, "- [x] b", "- [ ] b").unwrap(), "- [ ] b");
        assert!(replace_line("a\n- [x] b\n", 1, "- [ ] b", "- [x] b").is_err());
        assert!(replace_line("a\n", 3, "a", "b").is_err());
    }

    #[test]
    fn editor_command_quotes_the_path() {
        assert_eq!(
            editor_command("cursor -g {file}:{line}", "/a b/it's.ts", 7),
            "cursor -g '/a b/it'\\''s.ts':7"
        );
        assert_eq!(editor_command("zed", "/x.md", 1), "zed '/x.md'");
        assert_eq!(editor_command("zed {file}:{line}", "/x.md", 3), "zed '/x.md':3");
    }

    #[test]
    fn lines_without_the_end_and_without_cr() {
        assert_eq!(viewer_lines(b"a\r\nb\n".to_vec()).unwrap(), vec!["a", "b"]);
        assert!(viewer_lines(b"x\0y".to_vec()).is_err());
    }

    #[test]
    fn reads_from_disk_and_from_a_ref() {
        let here = env!("CARGO_MANIFEST_DIR");
        let cargo = format!("{here}/Cargo.toml");
        let on_disk = file_read(cargo.clone(), None).unwrap();
        assert!(on_disk.lines.iter().any(|l| l.starts_with("[package]")));
        assert!(!on_disk.stamp.is_empty());
        let head = file_read(cargo, Some("HEAD".into())).unwrap();
        assert!(head.lines.iter().any(|l| l.starts_with("[package]")));
        assert!(head.stamp.is_empty());
        assert!(file_read("relativo.txt".into(), None).is_err());
        assert!(file_read(format!("{here}/Cargo.toml"), Some("--output=/tmp/x".into())).is_err());
    }

    #[test]
    fn only_the_ones_that_exist() {
        let here = env!("CARGO_MANIFEST_DIR").to_string();
        let r = files_exist(here.clone(), vec!["Cargo.toml".into(), "does-not-exist.rs".into(), "src".into()]);
        assert_eq!(r, vec![Some(format!("{here}/Cargo.toml")), None, None]);
    }
}
