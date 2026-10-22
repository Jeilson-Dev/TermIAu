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
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
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

    // How whatever runs in the panel (`termiau`, a plugin's hook) knows who it is
    // talking to. It inherits both from this shell — and outside TermIAu they don't
    // exist, which is what keeps the same hook quiet in another terminal.
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

/// Messages that wait for an answer: the sender's connection stays open here, under a
/// number given to it on arrival, until its plugin answers (`socket_reply`) or gives
/// it up (`socket_drop`).
#[derive(Default)]
struct PendingReplies(Mutex<HashMap<String, std::os::unix::net::UnixStream>>);

/// Writes the plugin's answer to the waiting sender and closes the connection: what is
/// written here is what the sender reads back.
#[tauri::command]
fn socket_reply(pending: State<'_, PendingReplies>, id: String, answer: String) -> Result<(), String> {
    let Some(mut stream) = pending.0.lock().unwrap().remove(&id) else {
        return Err(tr("já foi respondida", "it was already answered").into());
    };
    stream.write_all(answer.as_bytes()).map_err(|e| e.to_string())
}

/// Closes the connection without an answer: the sender reads nothing.
#[tauri::command]
fn socket_drop(pending: State<'_, PendingReplies>, id: String) {
    pending.0.lock().unwrap().remove(&id);
}

/// Listens to what runs in the panels — `termiau view`/`progress` and the plugins'
/// hooks (`{"panel":…,"plugin":…,"message":…}`) — and hands it to the webview.
/// A unix socket, one connection per message: the sender writes a JSON and closes. The
/// exception is a message with `"wait":true` and a trailing newline: the connection
/// stays open waiting for the answer (see `PendingReplies`).
///
/// Why a socket and not an escape sequence through the panel's own output: the
/// latter would be more elegant (the panel's identity would come for free), but a
/// hook and the program in front write to the same tty at the same time, and a
/// message of a few KB exceeds the size at which writes stop being atomic — the risk
/// is chopping one of the program's own sequences and garbling the screen.
fn listen_socket(app: AppHandle, path: PathBuf) {
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
                // back as the command's error, for whoever sent it to fix.
                if let Some(checked) = progress::from_socket(&text) {
                    let mut stream = stream;
                    let _ = match checked {
                        Ok(event) => {
                            let _ = app.emit("socket://message", event);
                            stream.write_all(b"ok\n")
                        }
                        Err(e) => writeln!(stream, "error: {e}"),
                    };
                    return;
                }
                // A waiting message gets a number, which goes along to the webview: it
                // is how the answer comes back to this connection.
                let text = match waiting(&text) {
                    Some(mut v) => {
                        static NEXT: AtomicU64 = AtomicU64::new(1);
                        let id = format!("reply-{}", NEXT.fetch_add(1, Ordering::Relaxed));
                        v["reply_id"] = id.clone().into();
                        app.state::<PendingReplies>().0.lock().unwrap().insert(id, stream);
                        v.to_string()
                    }
                    None => text,
                };
                let _ = app.emit("socket://message", text);
            });
        }
    });
}

/// The message, already read, if it expects an answer.
fn waiting(text: &str) -> Option<serde_json::Value> {
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

/// Writes an exported review in Downloads, under `name` (a file name, nothing more) —
/// with " 2", " 3"… before the extension when one is already there — and shows it in
/// Finder. Returns where it went.
#[tauri::command(async)]
fn review_export(name: String, text: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let folder = std::path::Path::new(&home).join("Downloads");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let clean: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' || c.is_control() { '-' } else { c })
        .collect();
    let file = std::path::Path::new(&clean);
    let stem = file.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("review");
    let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("json");
    let mut target = folder.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while target.exists() {
        target = folder.join(format!("{stem} {n}.{ext}"));
        n += 1;
    }
    std::fs::write(&target, text).map_err(|e| e.to_string())?;
    let path = target.to_string_lossy().into_owned();
    reveal_in_finder(path.clone())?;
    Ok(path)
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

/// The app's data folder: the session file lives there.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("{}: {e}", tr("sem diretório de dados", "no data directory")))
}

// ---------- session: the tabs that come back on the next launch ----------

/// A single file, in the app's data folder: the open tabs, each one's
/// layout and what the plugins saved in each panel. The webview builds and reads it —
/// only text goes in and out here. In a file, not localStorage: the webview
/// writes its own whenever it pleases, and may not flush it before the app quits.
fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("session.json"))
}

#[tauri::command]
fn session_read(app: AppHandle) -> Option<String> {
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
            // layout and what its plugins saved.
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

    let view_menu = Submenu::with_items(
        app,
        tr("Exibir", "View"),
        true,
        &[&MenuItem::with_id(
            app,
            "viewer",
            tr("Mostrar ou Esconder o Arquivo", "Show or Hide File"),
            true,
            Some("CmdOrCtrl+Shift+O"),
        )?],
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
            listen_socket(app.handle().clone(), cfg.socket.clone());
            app.manage(cfg);
            app.manage(Ptys::default());
            app.manage(PendingReplies::default());
            app.manage(differ::RepoWatcher::default());
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
            "split-right" => { let _ = app.emit("menu://split-right", ()); }
            "split-down" => { let _ = app.emit("menu://split-down", ()); }
            "maximize" => { let _ = app.emit("menu://maximize", ()); }
            "close" => { let _ = app.emit("menu://close", ()); }
            "paste-path" => { let _ = app.emit("menu://paste-path", ()); }
            "preferences" => { let _ = app.emit("menu://preferences", ()); }
            "shortcuts" => { let _ = app.emit("menu://shortcuts", ()); }
            "viewer" => { let _ = app.emit("menu://viewer", ()); }
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
            review_export,
            pty_resize,
            pty_cwd,
            pty_close,
            pty_close_all,
            pty_busy,
            pty_signal,
            session_read,
            session_save,
            socket_reply,
            socket_drop,
            quit,
            launch_read,
            is_flutter_project,
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
                // The plugins' native processes (the Claude plugin's engine) die with the app.
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
    use super::waiting;

    #[test]
    fn only_a_waiting_message_keeps_the_connection() {
        let wait = r#"{"panel":1,"plugin":"p","message":{},"wait":true}"#;
        assert!(waiting(&format!("{wait}\n")).is_some());
        assert!(waiting(r#"{"panel":1,"plugin":"p","message":{}}"#).is_none());
        assert!(waiting("junk").is_none());
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
