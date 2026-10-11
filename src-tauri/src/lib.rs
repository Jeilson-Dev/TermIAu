mod area;
mod differ;
mod escuta;
mod idioma;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use idioma::tr;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

/// Everything we need to keep from a live PTY session — one per tab.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The shell's pid. Compared to the terminal's foreground group, it tells whether
    /// a program is running in front of it (see `pty_ocupado`).
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
const HERDA: &[&str] = &[
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
    for k in HERDA {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }

    // Minimal bootstrap PATH; /etc/zprofile + .zshrc build the rest.
    // `termiau` goes last: /etc/zprofile puts the system ones in front and
    // keeps those already there, so it stays findable without getting ahead
    // of anything of yours.
    let mut path = String::from("/usr/bin:/bin:/usr/sbin:/sbin");
    if let Some(bin) = dir_cli() {
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
    cmd.env("TERMIAU_PAINEL", id.to_string());
    cmd.env("TERMIAU_SOCK", &cfg.socket);
    cmd
}

fn dirs_home() -> Option<String> {
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
fn abrir_link(url: String) -> Result<(), String> {
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
    cwd_do_processo(pid)
}

#[cfg(target_os = "macos")]
fn cwd_do_processo(pid: i32) -> Option<String> {
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
fn cwd_do_processo(pid: i32) -> Option<String> {
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
fn pty_ocupado(state: State<'_, Ptys>, id: u64) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(s) = sessions.get(&id) else { return false };
    match (s.master.process_group_leader(), s.pid) {
        (Some(frente), Some(shell)) => frente as u32 != shell,
        _ => false,
    }
}

/// Sends a signal to the foreground program. It goes to the whole group, like
/// Ctrl+C: the children it spawned (a server, the emulator process) exit
/// along with it instead of being orphaned. The shell never gets it — closing the panel
/// is another matter, handled by `pty_close`.
#[tauri::command]
fn pty_sinal(state: State<'_, Ptys>, id: u64, sinal: i32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("pty not started")?;
    let frente = s.master.process_group_leader().ok_or("no foreground process")?;
    if Some(frente as u32) == s.pid {
        return Ok(());
    }
    if unsafe { libc::kill(-frente, sinal) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// The project's `.vscode/launch.json` for a panel, with `tasks.json` beside it.
#[derive(serde::Serialize)]
struct Launch {
    /// The folder holding `.vscode`: it is the configurations' `${workspaceFolder}`.
    pasta: String,
    home: String,
    launch: String,
    tasks: Option<String>,
}

/// The nearest one going up from the panel's directory: a panel in a
/// project subfolder still runs the root's launch.json, like VS Code opened
/// at the repository root.
#[tauri::command]
fn launch_ler(cwd: String) -> Option<Launch> {
    std::path::Path::new(&cwd).ancestors().find_map(|dir| {
        let vscode = dir.join(".vscode");
        let launch = std::fs::read_to_string(vscode.join("launch.json")).ok()?;
        Some(Launch {
            pasta: dir.display().to_string(),
            home: dirs_home().unwrap_or_default(),
            launch,
            tasks: std::fs::read_to_string(vscode.join("tasks.json")).ok(),
        })
    })
}

/// A Dart project is Flutter when the pubspec depends on the Flutter SDK — it is
/// what decides between `flutter run` and `dart run`, as the Dart extension does.
#[tauri::command]
fn projeto_flutter(pasta: String) -> bool {
    std::fs::read_to_string(std::path::Path::new(&pasta).join("pubspec.yaml"))
        .map(|pubspec| pubspec.contains("sdk: flutter"))
        .unwrap_or(false)
}

/// A chunk of a Claude Code session transcript.
#[derive(serde::Serialize)]
struct Trecho {
    texto: String,
    /// How far this chunk went, in bytes: it is the next read's `desde`.
    fim: u64,
    /// The start was left out (file too large), or the file shrank and the
    /// read started over: what the screen already showed is no longer valid.
    do_zero: bool,
    cortado: bool,
}

/// The full transcript of a long session exceeds tens of MB, almost all of it
/// tool results. The conversation that matters is its end.
const TRANSCRICAO_TETO: u64 = 6 * 1024 * 1024;

/// What the transcript gained since `desde`. Whole lines only: the last one, if
/// Claude is still writing it, waits for the next read.
///
/// The path comes from the hook, but the webview delivers it — so only a
/// `.jsonl` inside `~/.claude` is accepted, not any file on disk.
#[tauri::command]
fn transcricao_ler(caminho: String, desde: u64) -> Result<Trecho, String> {
    use std::io::{Seek, SeekFrom};

    let base = dir_claude().ok_or("no Claude Code folder")?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let arquivo = PathBuf::from(&caminho).canonicalize().map_err(|e| e.to_string())?;
    if !arquivo.starts_with(&base) || arquivo.extension().is_none_or(|e| e != "jsonl") {
        return Err(tr("não é um transcript do Claude Code", "not a Claude Code transcript").into());
    }

    let mut f = std::fs::File::open(&arquivo).map_err(|e| e.to_string())?;
    let tamanho = f.metadata().map_err(|e| e.to_string())?.len();
    // Smaller than what was already read: the file was rewritten. Start over.
    let mut do_zero = desde > tamanho;
    let mut inicio = if do_zero { 0 } else { desde };
    let cortado = tamanho - inicio > TRANSCRICAO_TETO;
    if cortado {
        inicio = tamanho - TRANSCRICAO_TETO;
        do_zero = true;
    }

    f.seek(SeekFrom::Start(inicio)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.take(tamanho - inicio).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Jumped into the middle of the file: the first line came in half.
    let pular = if cortado { bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| p + 1) } else { 0 };
    let ate = bytes.iter().rposition(|b| *b == b'\n').map_or(pular, |p| (p + 1).max(pular));
    // Almost all of the file's weight is tool results (a file read, a
    // command's output), which the chat doesn't show. It stays here: sending it to the
    // webview and making it parse megabytes of JSON froze the screen.
    let mut texto = String::new();
    for linha in String::from_utf8_lossy(&bytes[pular..ate]).lines() {
        let fala = linha.contains(r#""type":"user""#) || linha.contains(r#""type":"assistant""#);
        if !fala {
            continue;
        }
        if !linha.contains(r#""tool_use_id""#) {
            texto.push_str(linha);
            texto.push('\n');
        } else if let Some(diff) = diff_do_resultado(linha).or_else(|| diff_do_hook(&arquivo, linha)) {
            texto.push_str(&diff);
            texto.push('\n');
        }
    }
    Ok(Trecho {
        texto,
        fim: inicio + ate as u64,
        do_zero,
        cortado,
    })
}

/// The diff Claude Code stored in a tool result, already trimmed:
/// `{"type":"diff","arquivos":[{"caminho","hunks"}]}`. It is the same one the terminal
/// draws, with the file's line numbers. It comes from two places: the
/// `structuredPatch` of an Edit or Write, and the `bashEditDiff` of a command
/// (a `sed -i`, a script) that changed a file. The rest of the result — the
/// whole previous file, in an Edit — stays here.
fn diff_do_resultado(linha: &str) -> Option<String> {
    use serde_json::{json, Value};
    if !linha.contains(r#""structuredPatch""#) && !linha.contains(r#""bashEditDiff""#) {
        return None;
    }
    let v: Value = serde_json::from_str(linha).ok()?;
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
    let mut arquivos = Vec::new();
    if let Some(files) = r.pointer("/bashEditDiff/files").and_then(Value::as_array) {
        for f in files {
            arquivos.push(json!({ "caminho": f["filePath"], "hunks": hunks(&f["hunks"]) }));
        }
    } else if let Some(caminho) = r.get("filePath") {
        let mut h = hunks(&r["structuredPatch"]);
        // New file: Write brings no patch, only the content.
        if h.is_empty() && r.get("type").and_then(Value::as_str) == Some("create") {
            if let Some(c) = r.get("content").and_then(Value::as_str) {
                let linhas: Vec<String> = c.lines().map(|l| format!("+{l}")).collect();
                h.push(json!({ "oldStart": 0, "newStart": 1, "lines": linhas }));
            }
        }
        arquivos.push(json!({ "caminho": caminho, "hunks": h }));
    }
    arquivos.retain(|a| a["hunks"].as_array().is_some_and(|h| !h.is_empty()));
    if arquivos.is_empty() {
        return None;
    }
    Some(json!({ "type": "diff", "arquivos": arquivos }).to_string())
}

/// The diff our hook took from a Bash, for when Claude Code didn't
/// store one (a command that changed a file and ended with an error). It lives in
/// `~/.termiau/diffs/<session>/<tool_use_id>.patch`; the session is the
/// transcript's name.
fn diff_do_hook(transcript: &std::path::Path, linha: &str) -> Option<String> {
    let id = linha.split(r#""tool_use_id":""#).nth(1)?.split('"').next()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let sessao = transcript.file_stem()?.to_str()?;
    let patch = PathBuf::from(dirs_home()?).join(".termiau/diffs").join(sessao).join(format!("{id}.patch"));
    let texto = std::fs::read_to_string(patch).ok()?;
    let arquivos = arquivos_do_patch(&texto);
    if arquivos.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "diff", "arquivos": arquivos }).to_string())
}

/// A `git diff` into files and hunks, in the same format as Claude Code's
/// `structuredPatch`. The first line, `# raiz <folder>`, is from the hook: it is what
/// turns git's `a/…` and `b/…` paths absolute. A binary file has no
/// hunk and is left out.
fn arquivos_do_patch(texto: &str) -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut linhas = texto.lines();
    let raiz = linhas.next().and_then(|l| l.strip_prefix("# raiz ")).unwrap_or("");
    let mut arquivos: Vec<serde_json::Value> = Vec::new();
    let mut caminho: Option<String> = None;
    let mut hunks: Vec<serde_json::Value> = Vec::new();
    let mut atual: Option<(u64, u64, Vec<String>)> = None;
    let fechar_hunk = |atual: &mut Option<(u64, u64, Vec<String>)>, hunks: &mut Vec<serde_json::Value>| {
        if let Some((velha, nova, ls)) = atual.take() {
            hunks.push(json!({ "oldStart": velha, "newStart": nova, "lines": ls }));
        }
    };
    let fechar_arquivo =
        |caminho: &mut Option<String>, hunks: &mut Vec<serde_json::Value>, arquivos: &mut Vec<serde_json::Value>| {
            if let Some(c) = caminho.take() {
                if !hunks.is_empty() {
                    arquivos.push(json!({ "caminho": c, "hunks": std::mem::take(hunks) }));
                }
            }
            hunks.clear();
        };
    // The start of a hunk: `@@ -old[,n] +new[,n] @@`.
    let inicio = |l: &str| -> Option<(u64, u64)> {
        let mut partes = l.strip_prefix("@@ ")?.split(' ');
        let num = |p: &str| p.split(',').next().and_then(|n| n.parse::<u64>().ok());
        Some((num(partes.next()?.strip_prefix('-')?)?, num(partes.next()?.strip_prefix('+')?)?))
    };
    for l in linhas {
        if l.starts_with("diff --git ") {
            fechar_hunk(&mut atual, &mut hunks);
            fechar_arquivo(&mut caminho, &mut hunks, &mut arquivos);
        } else if atual.is_none() && (l.starts_with("--- ") || l.starts_with("+++ ")) {
            // `+++ b/…` gives the name; for a deleted file it is /dev/null, and
            // the `--- a/…` that came before counts.
            if let Some(p) = l[4..].strip_prefix("a/").or_else(|| l[4..].strip_prefix("b/")) {
                caminho = Some(format!("{}/{}", raiz.trim_end_matches('/'), p));
            }
        } else if let Some((velha, nova)) = inicio(l) {
            fechar_hunk(&mut atual, &mut hunks);
            atual = Some((velha, nova, Vec::new()));
        } else if let Some((_, _, ls)) = atual.as_mut() {
            if l.starts_with([' ', '+', '-', '\\']) {
                ls.push(l.to_string());
            } else {
                fechar_hunk(&mut atual, &mut hunks);
            }
        }
    }
    fechar_hunk(&mut atual, &mut hunks);
    fechar_arquivo(&mut caminho, &mut hunks, &mut arquivos);
    arquivos
}

/// A `/command` Claude Code accepts beyond its built-in ones: the user's,
/// the project's and the installed plugins' commands and skills.
#[derive(serde::Serialize)]
struct Comando {
    nome: String,
    descricao: String,
}

/// The `description:` in a command's or skill's header. Only the start of the
/// file is read, and only its first line matters: it is what fits in the list.
fn descricao_de(arquivo: &std::path::Path) -> String {
    let mut texto = String::new();
    let Ok(f) = std::fs::File::open(arquivo) else { return texto };
    let _ = f.take(16 * 1024).read_to_string(&mut texto);
    let mut linhas = texto.lines();
    if linhas.next().map(str::trim) != Some("---") {
        return String::new();
    }
    linhas
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| d.trim().trim_matches(['"', '\'']).chars().take(160).collect())
        .unwrap_or_default()
}

/// The `.md` files of a commands folder. A subfolder becomes a prefix, like in Claude
/// Code: `commands/git/commit.md` is `/git:commit`.
fn comandos_da_pasta(dir: &std::path::Path, prefixo: &str, fundo: u8, saida: &mut Vec<Comando>) {
    let Ok(itens) = std::fs::read_dir(dir) else { return };
    for item in itens.flatten() {
        let caminho = item.path();
        let Some(nome) = caminho.file_stem().and_then(|n| n.to_str()) else { continue };
        if caminho.is_dir() {
            if fundo > 0 {
                comandos_da_pasta(&caminho, &format!("{prefixo}{nome}:"), fundo - 1, saida);
            }
        } else if caminho.extension().is_some_and(|e| e == "md") {
            saida.push(Comando { nome: format!("{prefixo}{nome}"), descricao: descricao_de(&caminho) });
        }
    }
}

/// The skills of a folder: each subfolder with a `SKILL.md` is one.
fn skills_da_pasta(dir: &std::path::Path, prefixo: &str, saida: &mut Vec<Comando>) {
    let Ok(itens) = std::fs::read_dir(dir) else { return };
    for item in itens.flatten() {
        let skill = item.path().join("SKILL.md");
        let Some(nome) = item.file_name().to_str().map(str::to_owned) else { continue };
        if skill.is_file() {
            saida.push(Comando { nome: format!("{prefixo}{nome}"), descricao: descricao_de(&skill) });
        }
    }
}

/// What can be called with `/` in the session running in `pasta`, besides
/// Claude Code's built-in commands (the webview already knows those). The project
/// comes before the user, and the user before plugins: it is the order the
/// list shows, and the project's are the most used in it.
#[tauri::command]
fn comandos_listar(pasta: Option<String>) -> Vec<Comando> {
    let mut saida = Vec::new();
    if let Some(pasta) = pasta {
        // Going up from the session's folder, as Claude Code does: a session
        // opened in a subfolder still sees the project root's `.claude`.
        for dir in std::path::Path::new(&pasta).ancestors() {
            let claude = dir.join(".claude");
            // `~/.claude` is the user's, and comes right below.
            if dir_claude().is_some_and(|d| d == claude) {
                break;
            }
            comandos_da_pasta(&claude.join("commands"), "", 3, &mut saida);
            skills_da_pasta(&claude.join("skills"), "", &mut saida);
        }
    }
    let Some(base) = dir_claude() else { return saida };
    comandos_da_pasta(&base.join("commands"), "", 3, &mut saida);
    skills_da_pasta(&base.join("skills"), "", &mut saida);

    // Each installed plugin brings its own, called as `/plugin:name`.
    let plugins = std::fs::read_to_string(base.join("plugins/installed_plugins.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(mapa) = plugins.as_ref().and_then(|p| p["plugins"].as_object()) {
        for (chave, instalacoes) in mapa {
            let plugin = chave.split('@').next().unwrap_or(chave);
            for inst in instalacoes.as_array().into_iter().flatten() {
                let Some(raiz) = inst["installPath"].as_str().map(PathBuf::from) else { continue };
                let prefixo = format!("{plugin}:");
                comandos_da_pasta(&raiz.join("commands"), &prefixo, 3, &mut saida);
                skills_da_pasta(&raiz.join("skills"), &prefixo, &mut saida);
            }
        }
    }
    saida
}

/// Claude's questions (`AskUserQuestion`) waiting for an answer from chat mode:
/// the hook's connection stays open here, under a number given to it on arrival (the
/// `PermissionRequest` doesn't carry the `tool_use_id`), until the chat answers
/// (`pergunta_responder`) or gives it up (`pergunta_largar`).
#[derive(Default)]
struct Pendentes(Mutex<HashMap<String, std::os::unix::net::UnixStream>>);

/// Returns to the hook the decision the chat built, and closes the connection: what is
/// written here is the hook's output, and Claude Code reads it as the answer.
#[tauri::command]
fn pergunta_responder(pendentes: State<'_, Pendentes>, id: String, resposta: String) -> Result<(), String> {
    let Some(mut fluxo) = pendentes.0.lock().unwrap().remove(&id) else {
        return Err(tr("a pergunta já foi respondida", "the question was already answered").into());
    };
    fluxo.write_all(resposta.as_bytes()).map_err(|e| e.to_string())
}

/// Closes the connection without an answer: the hook exits quietly and the question stays with the
/// terminal. That is what happens when it was answered there.
#[tauri::command]
fn pergunta_largar(pendentes: State<'_, Pendentes>, id: String) {
    pendentes.0.lock().unwrap().remove(&id);
}

/// Listens to the events Claude Code's hooks send and hands them to the webview.
/// A unix socket, one connection per event: the hook writes a JSON and closes. The
/// exception is Claude's question: it arrives with `"espera":true` and a trailing
/// newline, and the connection stays open waiting for the answer (see
/// `Pendentes`).
///
/// Why a socket and not an escape sequence through the panel's own output: the
/// latter would be more elegant (the panel's identity would come for free), but the
/// hook and Claude Code write to the same tty at the same time, and a `delta` of
/// a few KB exceeds the size at which writes stop being atomic — the risk is
/// chopping one of Claude's own sequences and garbling the screen.
fn ouvir_hooks(app: AppHandle, caminho: PathBuf) {
    let _ = std::fs::remove_file(&caminho);
    limpar_sockets_orfaos(&caminho);
    let ouvinte = match UnixListener::bind(&caminho) {
        Ok(l) => l,
        Err(e) => return eprintln!("[termiau] couldn't open {caminho:?}: {e}"),
    };

    std::thread::spawn(move || {
        for conexao in ouvinte.incoming() {
            let Ok(fluxo) = conexao else { continue };
            let app = app.clone();
            // One thread per event: a slow hook must not hold up the others' queue.
            std::thread::spawn(move || {
                use std::io::BufRead;
                let mut texto = String::new();
                // Up to the newline or the end, whichever comes first. A ceiling so an
                // absurd payload doesn't turn into endless memory.
                let Ok(leitor) = fluxo.try_clone() else { return };
                if std::io::BufReader::new(leitor.take(256 * 1024)).read_line(&mut texto).is_err() {
                    return;
                }
                if texto.trim().is_empty() {
                    return;
                }
                // The question gets a number, which goes along to the webview: it is
                // how the answer comes back to this connection.
                let texto = match pergunta_em_espera(&texto) {
                    Some(mut v) => {
                        static PROXIMA: AtomicU64 = AtomicU64::new(1);
                        let id = format!("pergunta-{}", PROXIMA.fetch_add(1, Ordering::Relaxed));
                        v["pergunta_id"] = id.clone().into();
                        app.state::<Pendentes>().0.lock().unwrap().insert(id, fluxo);
                        v.to_string()
                    }
                    None => texto,
                };
                let _ = app.emit("claude://evento", texto);
            });
        }
    });
}

/// The event, already read, if it is a question that expects an answer.
fn pergunta_em_espera(texto: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(texto.trim()).ok()?;
    (v["espera"].as_bool() == Some(true)).then_some(v)
}

// ---------- the viewer: a file shown inside the panel ----------

/// The command Claude (or you) runs to open a file in the panel:
/// `termiau ver file:line`. It only talks to the socket, like the hook.
const CLI: &str = include_str!("../../hooks/termiau");

fn dir_cli() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".termiau/bin"))
}

/// Writes `termiau` to ~/.termiau/bin every time the app opens, if it changed. It
/// lives outside the bundle because the panel's shell needs to find it at a fixed path,
/// and that path is how the hook teaches it to Claude.
fn instalar_cli() {
    use std::os::unix::fs::PermissionsExt;
    let Some(dir) = dir_cli() else { return };
    let destino = dir.join("termiau");
    if std::fs::read_to_string(&destino).is_ok_and(|t| t == CLI) {
        return;
    }
    let feito = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&destino, CLI))
        .and_then(|_| std::fs::set_permissions(&destino, std::fs::Permissions::from_mode(0o755)));
    if let Err(e) = feito {
        eprintln!("[termiau] couldn't install {destino:?}: {e}");
    }
}

/// Above this the viewer won't open: it is a file to read, not a log of gigabytes.
const VISOR_MAX: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize)]
struct Arquivo {
    linhas: Vec<String>,
    /// Changes when the file changes on disk: it is what the viewer compares to
    /// redraw while Claude edits. Empty for a git version, which doesn't change.
    carimbo: String,
}

fn carimbo(caminho: &std::path::Path) -> Option<String> {
    let m = std::fs::metadata(caminho).ok()?;
    let quando = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}", quando.as_nanos(), m.len()))
}

fn texto_do_visor(bytes: Vec<u8>) -> Result<Vec<String>, String> {
    if bytes.len() as u64 > VISOR_MAX {
        return Err(tr("arquivo grande demais para o visor (mais de 5 MB)", "file too large for the viewer (over 5 MB)").into());
    }
    // Same guess as git: a NUL at the start means a binary file.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(tr("é um arquivo binário", "it's a binary file").into());
    }
    let texto = String::from_utf8_lossy(&bytes);
    let texto = texto.strip_suffix('\n').unwrap_or(&texto);
    Ok(texto.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect())
}

/// The whole file, as lines. With `rf`, as it is at that commit or
/// branch (`git show <rf>:./<file>`), not on disk — it is "how it was on main".
#[tauri::command(async)]
fn arquivo_ler(caminho: String, rf: Option<String>) -> Result<Arquivo, String> {
    let p = std::path::Path::new(&caminho);
    if !p.is_absolute() {
        return Err(format!("{}: {caminho}", tr("caminho relativo", "relative path")));
    }
    let Some(rf) = rf.filter(|r| !r.is_empty()) else {
        if !p.is_file() {
            return Err(format!("{}: {caminho}", tr("não existe", "doesn't exist")));
        }
        let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
        return Ok(Arquivo { linhas: texto_do_visor(bytes)?, carimbo: carimbo(p).unwrap_or_default() });
    };
    // A ref starting with `-` would become a git option.
    if rf.starts_with('-') || rf.contains(char::is_whitespace) {
        return Err(format!("{}: {rf}", tr("ref inválida", "invalid ref")));
    }
    let pasta = p.parent().ok_or("path has no folder")?;
    let nome = p.file_name().ok_or("path has no name")?.to_string_lossy();
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(pasta)
        .arg("show")
        .arg(format!("{rf}:./{nome}"))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let erro = String::from_utf8_lossy(&out.stderr);
        return Err(erro.lines().next().unwrap_or(tr("git show falhou", "git show failed")).to_string());
    }
    Ok(Arquivo { linhas: texto_do_visor(out.stdout)?, carimbo: String::new() })
}

/// Cheap enough for the viewer to ask every second: just a `stat`.
#[tauri::command]
fn arquivo_carimbo(caminho: String) -> Option<String> {
    carimbo(std::path::Path::new(&caminho))
}

/// Which of these paths (relative to `base`, absolute or with `~`) are files
/// that exist, already absolute. It is what tells a real `user_repository.dart:103`
/// apart from any `e.g.` in the terminal output.
#[tauri::command(async)]
fn arquivos_existem(base: String, candidatos: Vec<String>) -> Vec<Option<String>> {
    let home = dirs_home().unwrap_or_default();
    candidatos
        .into_iter()
        .map(|c| {
            let p = if let Some(resto) = c.strip_prefix("~/") {
                PathBuf::from(&home).join(resto)
            } else {
                PathBuf::from(&base).join(&c)
            };
            p.is_file().then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

/// Opens the file in the editor, at the line. `comando` is the one from Preferences, with
/// `{arquivo}` and `{linha}`, run in an interactive login shell: that is what reads
/// .zshrc, where the aliases live (a `work='codium .'`) and the PATH for `cursor`,
/// `zed` and `code`. It runs at the file's repository root, so a `.` in the
/// alias is the project, not the app's folder. Without it, VS Code through `vscode://`, which
/// jumps to the line even with the editor already open and doesn't need `code`.
#[tauri::command(async)]
fn abrir_no_editor(caminho: String, linha: Option<u32>, comando: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&caminho).is_absolute() {
        return Err(format!("{}: {caminho}", tr("caminho relativo", "relative path")));
    }
    let linha = linha.unwrap_or(1);
    let Some(comando) = comando.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) else {
        // Percent-encode what isn't safe in a URL: the space in a
        // "/Volumes/External MacOS" would break the link.
        let codificado: String = caminho
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let url = format!("vscode://file{codificado}:{linha}");
        std::process::Command::new("/usr/bin/open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    };
    let linha_de_comando = comando_do_editor(&comando, &caminho, linha);
    let pasta = std::path::Path::new(&caminho).parent().unwrap_or(std::path::Path::new("/")).to_path_buf();
    let raiz = std::process::Command::new("git")
        .arg("-C")
        .arg(&pasta)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(pasta);
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut filho = std::process::Command::new(sh)
        .args(["-i", "-l", "-c", &linha_de_comando])
        .current_dir(raiz)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // `code -g` returns right away; an editor that stays attached to the terminal (`--wait`)
    // must not hold the button. Up to 5 s to find out whether it failed, then let go.
    for _ in 0..50 {
        match filho.try_wait().map_err(|e| e.to_string())? {
            Some(st) if st.success() => return Ok(()),
            Some(st) => {
                let mut erro = String::new();
                if let Some(mut e) = filho.stderr.take() {
                    let _ = e.read_to_string(&mut erro);
                }
                // The last line: the first ones are from .zshrc (the prompt, plugin
                // warnings), and the command's error comes after them.
                let ultima = erro.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return Err(if ultima.is_empty() { format!("{} {st}", tr("o comando saiu com", "the command exited with")) } else { ultima });
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    std::thread::spawn(move || {
        let _ = filho.wait();
    });
    Ok(())
}

/// The Preferences command with the file and line filled in. The path goes
/// in single quotes (a space in the name doesn't split the argument); without
/// `{arquivo}` in the command, it goes at the end.
fn comando_do_editor(comando: &str, caminho: &str, linha: u32) -> String {
    let citado = format!("'{}'", caminho.replace('\'', "'\\''"));
    // `{file}` and `{line}` are the names in the English UI; both work.
    let comando = comando.replace("{file}", "{arquivo}");
    let com_linha = comando.replace("{line}", "{linha}").replace("{linha}", &linha.to_string());
    if com_linha.contains("{arquivo}") {
        com_linha.replace("{arquivo}", &citado)
    } else {
        format!("{com_linha} {citado}")
    }
}

// ---------- hooks: installing them from inside the app ----------

/// The hook ships inside the binary: someone who downloaded only the app doesn't have the
/// repository to run `hooks/instalar.sh` from. That script still works and does
/// the same as `hooks_instalar` here.
const HOOK: &str = include_str!("../../hooks/termiau-evento.sh");
const HOOK_EVENTOS: &[&str] = &[
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
/// waiting for the chat's answer (see `Pendentes`). On other requests it
/// returns right away, like the rest.
fn grupo_do_evento(evento: &str, comando: &str) -> serde_json::Value {
    let timeout = if evento == "PermissionRequest" { 3600 } else { 5 };
    let mut grupo = serde_json::json!({
        "hooks": [{ "type": "command", "command": comando, "timeout": timeout }]
    });
    match evento {
        "PreToolUse" => grupo["matcher"] = "Bash".into(),
        "PostToolUse" | "PostToolUseFailure" => grupo["matcher"] = "Bash|AskUserQuestion".into(),
        _ => {}
    }
    grupo
}

fn dir_claude() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".claude"))
}

fn hook_nosso(h: &serde_json::Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains("termiau-evento"))
}

/// `statusLine` goes through the same hook, with the `status` argument: it is how
/// the app gets the session's context and Claude's usage (see the start of
/// termiau-evento.sh). A status line that isn't ours stays where it is —
/// whoever put it there wanted something else.
fn status_line_em_dia(settings: &serde_json::Value) -> bool {
    let s = &settings["statusLine"];
    s.is_object() && !hook_nosso(s) || s["command"].as_str().is_some_and(|c| c.ends_with(" status"))
}

fn status_line(comando: &str) -> serde_json::Value {
    serde_json::json!({ "type": "command", "command": format!("{comando} status"), "padding": 0 })
}

/// settings.json already calls our hook on every event, and the way
/// this version registers it: a changed matcher or timeout also calls for
/// reinstalling.
fn hooks_registrados(settings: &serde_json::Value) -> bool {
    status_line_em_dia(settings) && HOOK_EVENTOS.iter().all(|e| {
        settings["hooks"][*e].as_array().is_some_and(|grupos| {
            grupos.iter().any(|g| {
                let Some(nosso) = g["hooks"].as_array().and_then(|hs| hs.iter().find(|h| hook_nosso(h))) else {
                    return false;
                };
                let esperado = grupo_do_evento(e, nosso["command"].as_str().unwrap_or(""));
                g["matcher"] == esperado["matcher"] && nosso["timeout"] == esperado["hooks"][0]["timeout"]
            })
        })
    })
}

/// Where the Claude Code link stands: `sem-claude` (no `~/.claude`),
/// `ausente` (never installed), `desatualizado` (installed by an earlier
/// version of the app) or `instalado`.
#[tauri::command]
fn hooks_estado() -> &'static str {
    let Some(dir) = dir_claude().filter(|d| d.is_dir()) else { return "sem-claude" };
    let script = dir.join("hooks/termiau-evento.sh");
    if !script.exists() {
        return "ausente";
    }
    let script_em_dia = std::fs::read_to_string(&script).is_ok_and(|s| s == HOOK);
    let registrado = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|s| hooks_registrados(&s));
    if script_em_dia && registrado { "instalado" } else { "desatualizado" }
}

/// Copies the hook to `~/.claude/hooks` and registers it in Claude Code's
/// settings.json. Idempotent, and settings gets a backup beside it before being touched.
#[tauri::command]
fn hooks_instalar() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = dir_claude().ok_or(tr("não achei a pasta do usuário", "couldn't find the user folder"))?;
    let destino = dir.join("hooks/termiau-evento.sh");
    std::fs::create_dir_all(dir.join("hooks")).map_err(|e| e.to_string())?;
    std::fs::write(&destino, HOOK).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&destino, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    let caminho = dir.join("settings.json");
    let texto = match std::fs::read_to_string(&caminho) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // A settings.json that can't be read isn't rewritten: better to go without the
    // hook than to erase someone's configuration.
    let mut settings: serde_json::Value = match texto.as_deref().map(str::trim) {
        None | Some("") => serde_json::json!({}),
        Some(t) => serde_json::from_str(t)
            .map_err(|e| format!("{}: {e}", tr("o settings.json do Claude Code está ilegível", "Claude Code's settings.json is unreadable")))?,
    };
    if hooks_registrados(&settings) {
        return Ok(());
    }
    settings
        .as_object_mut()
        .ok_or(tr("o settings.json do Claude Code não é um objeto", "Claude Code's settings.json is not an object"))?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let comando = format!("bash {}", destino.display());
    if !status_line_em_dia(&settings) {
        settings["statusLine"] = status_line(&comando);
    }
    let hooks = settings["hooks"].as_object_mut().ok_or(tr("o \"hooks\" do settings.json do Claude Code não é um objeto", "the \"hooks\" in Claude Code's settings.json is not an object"))?;
    for evento in HOOK_EVENTOS {
        // Any previous registration of our hook goes out, a new one goes in at the end.
        let mut grupos =
            hooks.get(*evento).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for g in &mut grupos {
            if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                hs.retain(|h| !hook_nosso(h));
            }
        }
        grupos.retain(|g| g["hooks"].as_array().is_some_and(|hs| !hs.is_empty()));
        grupos.push(grupo_do_evento(evento, &comando));
        hooks.insert(evento.to_string(), serde_json::Value::Array(grupos));
    }

    if texto.is_some() {
        let agora = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::copy(&caminho, dir.join(format!("settings.json.bak-{agora}")))
            .map_err(|e| e.to_string())?;
    }
    let novo = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Direct write, no rename: the settings.json of dotfiles users
    // is a link, and a `rename` over it would put a file in its place.
    std::fs::write(&caminho, novo + "\n").map_err(|e| e.to_string())
}

/// One socket is left over per run that died without exiting cleanly (a `kill`, a crash).
/// Since the name carries the pid, we can tell which ones no longer have an owner.
fn limpar_sockets_orfaos(atual: &PathBuf) {
    let Some(dir) = atual.parent() else { return };
    let Ok(entradas) = std::fs::read_dir(dir) else { return };
    for e in entradas.flatten() {
        let caminho = e.path();
        if caminho == *atual {
            continue;
        }
        let Some(pid) = caminho
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
            let _ = std::fs::remove_file(&caminho);
        }
    }
}

// ---------- dictation: speech transcription ----------

/// The recommended balance for Portuguese — 466 MB. The others in the catalog
/// stay in `escuta::model` for when there is a settings screen.
const MODELO: &str = "small";
const IDIOMA: &str = "pt";

#[derive(Default)]
struct Escuta {
    /// Set to ask the session's three threads to stop.
    parar: Mutex<Option<Arc<AtomicBool>>>,
}

fn dir_dados(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("{}: {e}", tr("sem diretório de dados", "no data directory")))
}

/// Where the model is. Looks for ours first and then the Escuta app's, which
/// was a separate project: whoever already downloaded 466 MB there needn't download again.
fn caminho_modelo(app: &AppHandle) -> Result<PathBuf, String> {
    let nosso = escuta::model::path_for(&dir_dados(app)?, MODELO);
    if nosso.exists() {
        return Ok(nosso);
    }
    let herdado = dirs_home()
        .map(PathBuf::from)
        .map(|h| h.join("Library/Application Support/ai.dimenso.escuta/models"))
        .map(|d| d.join(format!("ggml-{MODELO}.bin")));
    match herdado {
        Some(p) if p.exists() => Ok(p),
        _ => Ok(nosso), // doesn't exist yet; the path is where the download will land
    }
}

#[tauri::command]
fn escuta_modelo_pronto(app: AppHandle) -> Result<bool, String> {
    Ok(caminho_modelo(&app)?.exists())
}

/// Downloads the model, reporting progress on `escuta://progresso` (0 to 1).
#[tauri::command]
async fn escuta_baixar_modelo(app: AppHandle) -> Result<(), String> {
    let dir = dir_dados(&app)?;
    std::fs::create_dir_all(escuta::model::dir(&dir)).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let aviso = app.clone();
        escuta::model::download(&dir, MODELO, move |frac, _, _| {
            let _ = aviso.emit("escuta://progresso", frac);
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turns on the microphone. Three threads: capture, level meter and transcription —
/// the `cpal::Stream` must live entirely on the thread that opened it.
#[tauri::command]
fn escuta_comecar(app: AppHandle, state: State<'_, Escuta>) -> Result<(), String> {
    let mut guarda = state.parar.lock().unwrap();
    // A session that died on its own (microphone gone, corrupted model) leaves
    // the flag behind; clear it before deciding whether we are still listening.
    if guarda.as_ref().is_some_and(|p| p.load(Ordering::Relaxed)) {
        *guarda = None;
    }
    if guarda.is_some() {
        return Err(tr("já estou escutando", "already listening").into());
    }

    let modelo = caminho_modelo(&app)?;
    if !modelo.exists() {
        return Err(tr("o modelo ainda não foi baixado", "the model hasn't been downloaded yet").into());
    }

    let parar = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let (nivel_tx, nivel_rx) = std::sync::mpsc::channel::<f32>();

    // 1) capture
    {
        let parar = parar.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = escuta::audio::capture(None, audio_tx, nivel_tx, parar.clone()) {
                let _ = app.emit("escuta://erro", e.to_string());
                parar.store(true, Ordering::Relaxed);
                let _ = app.emit("escuta://estado", "parado");
            }
        });
    }

    // 2) meter: aggregates the peak and emits ~20x per second, otherwise it would be one event
    //    per audio buffer.
    {
        let parar = parar.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            while !parar.load(Ordering::Relaxed) {
                let mut pico = 0.0f32;
                let limite = std::time::Instant::now() + std::time::Duration::from_millis(50);
                while std::time::Instant::now() < limite {
                    match nivel_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(v) => pico = pico.max(v),
                        Err(_) => break,
                    }
                }
                let _ = app.emit("escuta://nivel", pico);
            }
            let _ = app.emit("escuta://nivel", 0.0);
        });
    }

    // 3) transcription
    {
        let parar = parar.clone();
        let app = app.clone();
        let caminho = modelo.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let motor = match escuta::stt::Engine::load(&caminho, IDIOMA) {
                Ok(m) => m,
                Err(e) => {
                    let _ = app.emit("escuta://erro", e.to_string());
                    parar.store(true, Ordering::Relaxed);
                    let _ = app.emit("escuta://estado", "parado");
                    return;
                }
            };
            escuta::stt::run(motor, audio_rx, parar, |ev| match ev {
                escuta::stt::Event::Partial(t) => { let _ = app.emit("escuta://parcial", t); }
                escuta::stt::Event::Final(t) => { let _ = app.emit("escuta://final", t); }
                escuta::stt::Event::Status(s) => { let _ = app.emit("escuta://estado", s); }
                escuta::stt::Event::Error(e) => { let _ = app.emit("escuta://erro", e); }
            });
        });
    }

    *guarda = Some(parar);
    Ok(())
}

#[tauri::command]
fn escuta_parar(state: State<'_, Escuta>) {
    if let Some(parar) = state.parar.lock().unwrap().take() {
        parar.store(true, Ordering::Relaxed);
    }
}

// ---------- session: the tabs that come back on the next launch ----------

/// A single file, in the app's data folder: the open tabs, each one's
/// layout and each panel's Claude session. The webview builds and reads it —
/// only text goes in and out here. In a file, not localStorage: the webview
/// writes its own whenever it pleases, and the app exits through `_exit` (see `run`).
fn arquivo_sessao(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir_dados(app)?.join("sessao.json"))
}

/// Coming back with the tabs is the user's choice (TermIAu ▸ Restore Tabs on
/// Open), and starts off. The choice is this file's existence: the menu is
/// built here in Rust, before the webview exists to say anything.
fn marca_restaurar(app: &AppHandle) -> Option<PathBuf> {
    Some(dir_dados(app).ok()?.join("restaurar-abas"))
}

#[tauri::command]
fn restaurar_ligado(app: AppHandle) -> bool {
    marca_restaurar(&app).is_some_and(|m| m.exists())
}

/// The click on the menu item. macOS itself toggles the checkmark; from here go the
/// flag on disk and the notice to the webview.
fn alternar_restaurar(app: &AppHandle) {
    let Some(marca) = marca_restaurar(app) else { return };
    let ligado = !marca.exists();
    let feito = if ligado {
        marca.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&marca, ""))
    } else {
        std::fs::remove_file(&marca)
    };
    if let Err(e) = feito {
        eprintln!("[termiau] couldn't save the restore-tabs choice: {e}");
    }
    let _ = app.emit("menu://restaurar", marca.exists());
}

/// Off, there is nothing to bring back: the webview opens a new tab. The session
/// keeps being saved just the same — turning it on midday already counts for the
/// next launch.
#[tauri::command]
fn sessao_ler(app: AppHandle) -> Option<String> {
    if !restaurar_ligado(app.clone()) {
        return None;
    }
    std::fs::read_to_string(arquivo_sessao(&app).ok()?).ok()
}

#[tauri::command]
fn sessao_salvar(app: AppHandle, dados: String) -> Result<(), String> {
    let destino = arquivo_sessao(&app)?;
    if let Some(dir) = destino.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write alongside and rename: an app killed mid-write leaves the
    // previous file whole, not half a JSON.
    let rascunho = destino.with_extension("json.tmp");
    std::fs::write(&rascunho, dados).map_err(|e| e.to_string())?;
    std::fs::rename(&rascunho, &destino).map_err(|e| e.to_string())
}

/// Quits the app. The webview calls it, after the user confirms and the
/// session is saved.
#[tauri::command]
fn sair(app: AppHandle) {
    app.exit(0);
}

/// Tauri's default menu reserves ⌘W for "Close Window" and the macOS menu
/// consumes the shortcut before the webview — the tab never saw the key. We replace the
/// whole menu so ⌘T and ⌘W belong to the tabs; the native Edit items
/// stay there because ⌘C/⌘V depend on them.
fn montar_menu(app: &AppHandle) -> tauri::Result<()> {
    let sobre = Submenu::with_items(
        app,
        "TermIAu",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(tr("Sobre o TermIAu", "About TermIAu")), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            // ⌘, is where every macOS app keeps this — and, being a menu item,
            // the key never even reaches the webview: the menu takes it first.
            &MenuItem::with_id(app, "preferencias", tr("Preferências…", "Preferences…"), true, Some("CmdOrCtrl+,"))?,
            // Turning it on also installs Claude Code's hooks, which is where the
            // session to resume in each panel comes from.
            &CheckMenuItem::with_id(
                app,
                "restaurar",
                tr("Restaurar Abas ao Abrir", "Restore Tabs on Launch"),
                true,
                restaurar_ligado(app.clone()),
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
            // webview, which asks first (see `pedirSair` in main.ts).
            &MenuItem::with_id(app, "sair", tr("Sair do TermIAu", "Quit TermIAu"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let arquivo = Submenu::with_items(
        app,
        tr("Arquivo", "File"),
        true,
        &[
            &MenuItem::with_id(app, "nova-aba", tr("Nova Aba", "New Tab"), true, Some("CmdOrCtrl+T"))?,
            // Like in the browser: brings back the last closed tab, with its
            // layout and Claude sessions resumed.
            &MenuItem::with_id(
                app,
                "reabrir-aba",
                tr("Reabrir Aba Fechada", "Reopen Closed Tab"),
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "dividir-lado", tr("Dividir ao Lado", "Split Right"), true, Some("CmdOrCtrl+D"))?,
            &MenuItem::with_id(
                app,
                "dividir-abaixo",
                tr("Dividir Abaixo", "Split Down"),
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            // Toggles: maximizes the focused panel or brings the others back on screen.
            &MenuItem::with_id(
                app,
                "maximizar",
                tr("Maximizar ou Recolher Painel", "Maximize or Restore Pane"),
                true,
                Some("CmdOrCtrl+Shift+Enter"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Closes the focused panel; with a single panel, the whole tab goes.
            &MenuItem::with_id(app, "fechar", tr("Fechar", "Close"), true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::close_window(app, Some(tr("Fechar Janela", "Close Window")))?,
        ],
    )?;

    let editar = Submenu::with_items(
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
                "colar-caminho",
                tr("Colar Caminho", "Paste Path"),
                true,
                Some("CmdOrCtrl+Shift+V"),
            )?,
            &PredefinedMenuItem::select_all(app, Some(tr("Selecionar Tudo", "Select All")))?,
        ],
    )?;

    let escuta = Submenu::with_items(
        app,
        tr("Escuta", "Dictation"),
        true,
        &[
            // ⌘E, not Ctrl+Space: on macOS that switches the input source
            // when more than one is installed. ⌘E is free — the menu consumes it
            // before the webview.
            &MenuItem::with_id(app, "escutar", tr("Escutar", "Listen"), true, Some("CmdOrCtrl+E"))?,
        ],
    )?;

    // The footer radio. The editor gets no shortcut: it is opened now and then, and
    // every key taken here is one less key for the shell. Not play: it is
    // what you press without taking your hand off the keyboard.
    let radio = Submenu::with_items(
        app,
        tr("Rádio", "Radio"),
        true,
        &[
            &MenuItem::with_id(app, "radio", tr("Tocar / Pausar", "Play / Pause"), true, Some("CmdOrCtrl+Shift+P"))?,
            &MenuItem::with_id(app, "estacoes", tr("Estações…", "Stations…"), true, None::<&str>)?,
        ],
    )?;

    // How the focused panel's Claude session is shown: its terminal or the
    // conversation in bubbles. And the jumps between what you wrote, which work in
    // both modes — ⌘⇧↑ and ⌘⇧↓ are iTerm2's mark jumps.
    let exibir = Submenu::with_items(
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
                "visor",
                tr("Mostrar ou Esconder o Arquivo", "Show or Hide File"),
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &MenuItem::with_id(
                app,
                "compactar",
                tr("Compactar a Conversa do Claude", "Compact Claude Conversation"),
                true,
                Some("CmdOrCtrl+Shift+K"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "mensagem-anterior",
                tr("Sua Mensagem Anterior", "Your Previous Message"),
                true,
                Some("CmdOrCtrl+Shift+Up"),
            )?,
            &MenuItem::with_id(
                app,
                "mensagem-seguinte",
                tr("Sua Próxima Mensagem", "Your Next Message"),
                true,
                Some("CmdOrCtrl+Shift+Down"),
            )?,
        ],
    )?;

    let janela = Submenu::with_items(
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
    let ajuda = Submenu::with_items(
        app,
        tr("Ajuda", "Help"),
        true,
        &[&MenuItem::with_id(app, "atalhos", tr("Atalhos do Teclado", "Keyboard Shortcuts"), true, Some("CmdOrCtrl+/"))?],
    )?;

    app.set_menu(Menu::with_items(
        app,
        &[&sobre, &arquivo, &editar, &exibir, &escuta, &radio, &janela, &ajuda],
    )?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The differ keeps, in a JSON in the app's data folder, each repository's
        // target branch and what has already been reviewed.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let cfg = Config::default();
            ouvir_hooks(app.handle().clone(), cfg.socket.clone());
            app.manage(cfg);
            app.manage(Ptys::default());
            app.manage(Escuta::default());
            app.manage(Pendentes::default());
            app.manage(differ::Vigia::default());
            app.manage(differ::Perguntas::default());
            // Without this whisper.cpp dumps its log onto the process output.
            whisper_rs::install_logging_hooks();
            montar_menu(app.handle())?;
            instalar_cli();
            Ok(())
        })
        // The menu only knows the key was pressed; the webview owns the tabs.
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "nova-aba" => { let _ = app.emit("menu://nova-aba", ()); }
            "reabrir-aba" => { let _ = app.emit("menu://reabrir-aba", ()); }
            "sair" => { let _ = app.emit("menu://sair", ()); }
            "hooks" => { let _ = app.emit("menu://hooks", ()); }
            "restaurar" => alternar_restaurar(app),
            "dividir-lado" => { let _ = app.emit("menu://dividir-lado", ()); }
            "dividir-abaixo" => { let _ = app.emit("menu://dividir-abaixo", ()); }
            "maximizar" => { let _ = app.emit("menu://maximizar", ()); }
            "fechar" => { let _ = app.emit("menu://fechar", ()); }
            "colar-caminho" => { let _ = app.emit("menu://colar-caminho", ()); }
            "preferencias" => { let _ = app.emit("menu://preferencias", ()); }
            "escutar" => { let _ = app.emit("menu://escutar", ()); }
            "estacoes" => { let _ = app.emit("menu://estacoes", ()); }
            "radio" => { let _ = app.emit("menu://radio", ()); }
            "atalhos" => { let _ = app.emit("menu://atalhos", ()); }
            "chat" => { let _ = app.emit("menu://chat", ()); }
            "visor" => { let _ = app.emit("menu://visor", ()); }
            "compactar" => { let _ = app.emit("menu://compactar", ()); }
            "mensagem-anterior" => { let _ = app.emit("menu://mensagem", -1); }
            "mensagem-seguinte" => { let _ = app.emit("menu://mensagem", 1); }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_attach,
            pty_write,
            abrir_link,
            arquivo_ler,
            arquivo_carimbo,
            arquivos_existem,
            abrir_no_editor,
            pty_resize,
            pty_cwd,
            pty_close,
            pty_close_all,
            escuta_modelo_pronto,
            escuta_baixar_modelo,
            escuta_comecar,
            escuta_parar,
            pty_ocupado,
            pty_sinal,
            sessao_ler,
            sessao_salvar,
            restaurar_ligado,
            hooks_estado,
            hooks_instalar,
            pergunta_responder,
            pergunta_largar,
            sair,
            launch_ler,
            projeto_flutter,
            transcricao_ler,
            comandos_listar,
            area::area_colar,
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
            js_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building TermIAu")
        .run(|app, evento| {
            if let tauri::RunEvent::Exit = evento {
                // The socket is a real file; without this one would be left per
                // run in the temp directory.
                let _ = std::fs::remove_file(&app.state::<Config>().socket);

                // And we exit without going through C++ static destructors. ggml
                // frees the Metal device in one of them and aborts on its own
                // assert when any resource set is still alive — and one is,
                // because the whisper thread is still up holding the context
                // when the window closes. Quitting the app printed an abort and 20
                // lines of backtrace (ggml-metal-device.m:608, llama.cpp#17869).
                // Nothing is left to clean up here: the socket is already gone, and the shells
                // get SIGHUP when the kernel closes the ptys along with the process.
                unsafe { libc::_exit(0) };
            }
        });
}

#[cfg(test)]
mod testes_patch {
    use super::{arquivos_do_patch, pergunta_em_espera};

    #[test]
    fn so_a_pergunta_que_espera_fica_com_a_conexao() {
        let espera = r#"{"painel":1,"evento":{"tool_name":"AskUserQuestion"},"espera":true}"#;
        assert!(pergunta_em_espera(&format!("{espera}\n")).is_some());
        assert!(pergunta_em_espera(r#"{"painel":1,"evento":{"tool_name":"AskUserQuestion"}}"#).is_none());
        assert!(pergunta_em_espera("lixo").is_none());
    }

    #[test]
    fn le_o_patch_do_hook() {
        let patch = "# raiz /repo\n\
diff --git a/novo.txt b/novo.txt\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/novo.txt\n\
@@ -0,0 +1 @@\n\
+novo\n\
diff --git a/x.txt b/x.txt\n\
--- a/x.txt\n\
+++ b/x.txt\n\
@@ -1,3 +1,3 @@\n\
 a\n\
-b\n\
+B\n\
@@ -40 +40 @@\n\
--- velho\n\
+++ novo\n\
diff --git a/apagado.txt b/apagado.txt\n\
--- a/apagado.txt\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-x\n\
diff --git a/img.png b/img.png\n\
Binary files a/img.png and b/img.png differ\n";
        let a = arquivos_do_patch(patch);
        let caminhos: Vec<_> = a.iter().map(|f| f["caminho"].as_str().unwrap()).collect();
        assert_eq!(caminhos, ["/repo/novo.txt", "/repo/x.txt", "/repo/apagado.txt"]);
        assert_eq!(a[0]["hunks"][0]["newStart"], 1);
        // Inside a hunk, `--- velho` is a removed line, not a header.
        assert_eq!(a[1]["hunks"][1]["lines"], serde_json::json!(["--- velho", "+++ novo"]));
        assert_eq!(a[1]["hunks"][0]["oldStart"], 1);
    }
}

#[cfg(test)]
mod testes_visor {
    use super::{arquivo_ler, arquivos_existem, comando_do_editor, texto_do_visor};

    #[test]
    fn comando_do_editor_cita_o_caminho() {
        assert_eq!(
            comando_do_editor("cursor -g {arquivo}:{linha}", "/a b/it's.ts", 7),
            "cursor -g '/a b/it'\\''s.ts':7"
        );
        assert_eq!(comando_do_editor("zed", "/x.md", 1), "zed '/x.md'");
        assert_eq!(comando_do_editor("zed {file}:{line}", "/x.md", 3), "zed '/x.md':3");
    }

    #[test]
    fn linhas_sem_o_fim_e_sem_cr() {
        assert_eq!(texto_do_visor(b"a\r\nb\n".to_vec()).unwrap(), vec!["a", "b"]);
        assert!(texto_do_visor(b"x\0y".to_vec()).is_err());
    }

    #[test]
    fn le_do_disco_e_de_uma_ref() {
        let aqui = env!("CARGO_MANIFEST_DIR");
        let cargo = format!("{aqui}/Cargo.toml");
        let disco = arquivo_ler(cargo.clone(), None).unwrap();
        assert!(disco.linhas.iter().any(|l| l.starts_with("[package]")));
        assert!(!disco.carimbo.is_empty());
        let head = arquivo_ler(cargo, Some("HEAD".into())).unwrap();
        assert!(head.linhas.iter().any(|l| l.starts_with("[package]")));
        assert!(head.carimbo.is_empty());
        assert!(arquivo_ler("relativo.txt".into(), None).is_err());
        assert!(arquivo_ler(format!("{aqui}/Cargo.toml"), Some("--output=/tmp/x".into())).is_err());
    }

    #[test]
    fn so_os_que_existem() {
        let aqui = env!("CARGO_MANIFEST_DIR").to_string();
        let r = arquivos_existem(aqui.clone(), vec!["Cargo.toml".into(), "nao-existe.rs".into(), "src".into()]);
        assert_eq!(r, vec![Some(format!("{aqui}/Cargo.toml")), None, None]);
    }
}
