//! Asking Claude about a snippet of the diff without leaving the review.
//!
//! It is the command-line `claude -p`: answers and exits. Nothing is saved —
//! neither the quick question nor one that mentions a session, which runs in a
//! copy of it (`--fork-session`) thrown away at the end. The mentioned session
//! stays as it was, and `/resume` doesn't fill up with one-off questions.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::git::Repo;
use crate::language::tr;

type Result<T> = std::result::Result<T, String>;

/// The pid of each question in progress, by the id the diff tab gave it. It is
/// what lets the cancel button kill the right process.
fn running() -> &'static Mutex<HashMap<String, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// How many sessions the list offers: the most recent ones are what matter.
const MAX_SESSIONS: usize = 20;
/// The title lives at the end of the file, which reaches several MB. Reading the tail is enough.
const TAIL_BYTES: u64 = 512 * 1024;

const INSTRUCTIONS_PT: &str = "Você está sendo consultado de dentro de uma ferramenta de revisão de código \
(a aba de diff do TermIAu). O stdin traz o trecho em revisão, o diff do arquivo e, se houver, a conversa \
até aqui. Responda em português, direto ao ponto e curto — a resposta aparece embaixo do trecho, no meio \
do diff.";

const INSTRUCTIONS_EN: &str = "You are being consulted from inside a code review tool (TermIAu's diff \
tab). Stdin holds the passage under review, the file's diff and, if any, the conversation so far. \
Answer in English, straight to the point and short — the answer shows up below the passage, in the \
middle of the diff.";

const CHAT_ONLY_PT: &str = " Isto é só uma conversa: pode ler o repositório para entender o contexto, mas \
não altere nada — nem que peçam. Se pedirem uma alteração, explique o que faria.";

const CHAT_ONLY_EN: &str = " This is only a conversation: you may read the repository to understand \
the context, but do not change anything — not even if asked. If asked for a change, explain what you \
would do.";

const WITH_EDITS_PT: &str = " O revisor liberou alterações: pode editar os arquivos do repositório quando \
ele pedir. Diga no fim o que alterou.";

const WITH_EDITS_EN: &str = " The reviewer allowed edits: you may edit the repository's files when \
they ask. Say at the end what you changed.";

/// What each mode can do. `--tools` says which tools exist, not which are
/// allowed — so the user's settings (an auto mode, an Edit `allow`) have no way
/// to give writing back to a conversation-only question. No Bash in either:
/// the diff already comes in the context.
///
/// And no `SendMessage`, which matters most: a question that mentions an
/// orchestrator's session inherits its role. With the tool at hand, it once
/// treated the reviewer's doubt as an order and dispatched a "user decision" to
/// the team's agents — who applied it, with nobody having decided anything.
const READ_TOOLS: &str = "Read,Grep,Glob";
const WRITE_TOOLS: &str = "Read,Grep,Glob,Edit,Write";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    /// Last write to the session file, in ms since the epoch.
    pub modified: u64,
}

/// The `claude` binary. The app opened from Finder inherits a minimal PATH,
/// without the installer's `~/.local/bin` — so it looks in the usual places and,
/// last, asks the user's login shell, which has the real PATH.
fn claude_binary() -> Result<&'static Path> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidates = vec![
            PathBuf::from(&home).join(".local/bin/claude"),
            PathBuf::from(&home).join(".claude/local/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path).map(|d| d.join("claude")));
        }
        if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
            return Some(found);
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let output = Command::new(shell).args(["-lic", "command -v claude"]).output().ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| l.starts_with('/'))
            .map(PathBuf::from)
    })
    .as_deref()
    .ok_or_else(|| tr("não encontrei o `claude` instalado nesta máquina.", "couldn't find `claude` installed on this machine.").into())
}

/// Where Claude Code keeps the sessions started in this folder: the path becomes
/// a directory name by replacing everything that isn't a letter or digit with `-`.
fn sessions_dir(root: &Path) -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".claude"),
    };
    let name: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(base.join("projects").join(name))
}

/// A session's title: the one the user gave, else the one Claude gave, else the
/// last prompt. `None` for a session with no conversation at all.
fn title_of(file: &Path) -> Option<String> {
    let mut f = std::fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES))).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;

    let (mut given, mut generated, mut prompt) = (None, None, None);
    // The first line may have been cut in the middle; parsing it just fails.
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let text = |field: &str| v.get(field).and_then(|t| t.as_str()).map(str::to_owned);
        match v.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => given = text("customTitle").or(given),
            Some("ai-title") => generated = text("aiTitle").or(generated),
            Some("last-prompt") => prompt = text("lastPrompt").or(prompt),
            _ => {}
        }
    }
    let t = given.or(generated).or(prompt)?;
    let t = t.lines().next().unwrap_or_default().trim();
    Some(if t.chars().count() > 90 { format!("{}…", t.chars().take(90).collect::<String>()) } else { t.to_owned() })
}

/// The Claude Code sessions open at this repository's root, from newest
/// to oldest.
pub fn sessions(root: &Path) -> Result<Vec<Session>> {
    let Some(dir) = sessions_dir(root) else { return Ok(Vec::new()) };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };

    let mut files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let modified_at = p.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((p, modified_at.as_millis() as u64))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));

    Ok(files
        .into_iter()
        .filter_map(|(p, modified)| {
            let title = title_of(&p)?;
            let id = p.file_stem()?.to_string_lossy().into_owned();
            Some(Session { id, title, modified })
        })
        .take(MAX_SESSIONS)
        .collect())
}

/// A file Claude touched in a question with edits allowed: how it was and how
/// it ended up. `None` means "didn't exist" (before) or "deleted" (after).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// It can be safely restored to `before`. Not when it's unknown how the file
    /// was (ignored by git, too large) or when it is binary.
    pub undoable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub answer: String,
    pub changes: Vec<FileChange>,
}

/// An untracked file larger than this stays out of the snapshot: undoing its
/// edit becomes unavailable, rather than the snapshot wasting memory.
const SNAPSHOT_MAX_FILE: u64 = 1024 * 1024;
const SNAPSHOT_MAX_TOTAL: u64 = 32 * 1024 * 1024;

/// How the working tree was before the question. Tracked files fit in a loose
/// commit from `git stash create` — which touches no ref, index or disk — and
/// the untracked ones, which it doesn't pick up, are copied.
struct Snapshot {
    base: Option<String>,
    untracked: HashSet<String>,
    copies: HashMap<String, Vec<u8>>,
}

fn take_snapshot(repo: &Repo) -> Snapshot {
    let base = repo
        .run_string(&["stash", "create"])
        .ok()
        .filter(|sha| !sha.is_empty())
        .or_else(|| repo.resolve_commit("HEAD"));
    let list = repo.run(&["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    let untracked: HashSet<String> = list
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect();
    let mut copies = HashMap::new();
    let mut total = 0;
    for name in &untracked {
        let path = repo.root().join(name);
        let Ok(meta) = path.metadata() else { continue };
        if meta.len() > SNAPSHOT_MAX_FILE || total + meta.len() > SNAPSHOT_MAX_TOTAL {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            total += meta.len();
            copies.insert(name.clone(), bytes);
        }
    }
    Snapshot { base, untracked, copies }
}

enum Before {
    Content(Vec<u8>),
    Missing,
    Unknown,
}

impl Snapshot {
    fn before(&self, repo: &Repo, name: &str) -> Before {
        if self.untracked.contains(name) {
            return self.copies.get(name).map_or(Before::Unknown, |b| Before::Content(b.clone()));
        }
        if let Some(base) = &self.base {
            if let Ok(bytes) = repo.run(&["show", &format!("{base}:{name}")]) {
                return Before::Content(bytes);
            }
        }
        // Neither tracked nor new: either it didn't exist, or git ignores it — then there is no snapshot.
        let ignored = repo.run(&["check-ignore", "-q", "--", name]).is_ok();
        if ignored { Before::Unknown } else { Before::Missing }
    }
}

/// The path Claude used, relative to the root. It writes absolute paths, and
/// sometimes through the other side of a link (`/tmp` and `/private/tmp`, on macOS).
fn relative(root_dir: &Path, path: &str) -> Option<String> {
    let p = Path::new(path);
    let p = if p.is_absolute() { p.to_path_buf() } else { root_dir.join(p) };
    if let Ok(r) = p.strip_prefix(root_dir) {
        return Some(r.to_string_lossy().into_owned());
    }
    let root_dir = root_dir.canonicalize().ok()?;
    let real = match p.canonicalize() {
        Ok(real) => real,
        Err(_) => p.parent()?.canonicalize().ok()?.join(p.file_name()?),
    };
    real.strip_prefix(&root_dir).ok().map(|r| r.to_string_lossy().into_owned())
}

/// The files on which Claude used a writing tool, in order.
fn edited_files(lines: &[serde_json::Value]) -> Vec<String> {
    let mut seen = Vec::new();
    for v in lines {
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(parts) = v.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        for part in parts {
            if part.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            if !matches!(part.get("name").and_then(|n| n.as_str()), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) {
                continue;
            }
            let input = part.get("input");
            let path = input
                .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
                .and_then(|c| c.as_str());
            if let Some(c) = path {
                if !seen.iter().any(|v| v == c) {
                    seen.push(c.to_owned());
                }
            }
        }
    }
    seen
}

fn change_of(repo: &Repo, snapshot: &Snapshot, name: String) -> FileChange {
    let after = std::fs::read(repo.root().join(&name)).ok();
    let (before, known) = match snapshot.before(repo, &name) {
        Before::Content(b) => (Some(b), true),
        Before::Missing => (None, true),
        Before::Unknown => (None, false),
    };
    // Binaries are neither shown nor undone from here: only the name stays, to know it was touched.
    let text = |b: Option<Vec<u8>>| b.map(String::from_utf8).transpose();
    match (text(before), text(after)) {
        (Ok(before), Ok(after)) => FileChange { path: name, before, after, undoable: known },
        _ => FileChange { path: name, before: None, after: None, undoable: false },
    }
}

/// Runs the question and returns the answer — and, with edits allowed, what
/// changed in each touched file, for the reviewer to see and be able to undo.
/// `context` goes through stdin: the snippet, the diff and the conversation so far.
#[allow(clippy::too_many_arguments)]
pub fn ask(
    root: &Path,
    id: &str,
    question: &str,
    context: &str,
    model: Option<&str>,
    session: Option<&str>,
    allow_edits: bool,
) -> Result<Answer> {
    let (tools, mode, rule) = if allow_edits {
        (WRITE_TOOLS, "acceptEdits", tr(WITH_EDITS_PT, WITH_EDITS_EN))
    } else {
        // `dontAsk` denies what wasn't allowed, instead of waiting for someone to answer.
        (READ_TOOLS, "dontAsk", tr(CHAT_ONLY_PT, CHAT_ONLY_EN))
    };
    let repo = Repo::open(root)?;
    let snapshot = allow_edits.then(|| take_snapshot(&repo));

    let mut cmd = Command::new(claude_binary()?);
    cmd.current_dir(root)
        // `stream-json` instead of `json`: it is where the tools used show up,
        // and they are how we know which files were touched.
        .args(["-p", question, "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .args(["--append-system-prompt", &format!("{}{rule}", tr(INSTRUCTIONS_PT, INSTRUCTIONS_EN))])
        .args(["--tools", tools, "--permission-mode", mode])
        // The user's MCP servers bring their own writing tools (create a ticket, send a message).
        .arg("--strict-mcp-config")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        cmd.args(["--resume", s, "--fork-session"]);
    }

    let mut child = cmd.spawn().map_err(|err| format!("{}: {err}", tr("não deu para rodar o `claude`", "couldn't run `claude`")))?;
    running().lock().unwrap().insert(id.to_owned(), child.id());

    // On a separate thread: a large context fills the pipe before claude starts
    // reading, and writing it all from here would block waiting for the output.
    let mut input = child.stdin.take();
    let context = context.to_owned();
    std::thread::spawn(move || {
        if let Some(e) = input.as_mut() {
            let _ = e.write_all(context.as_bytes());
        }
    });

    let output = child.wait_with_output();
    let cancelled = running().lock().unwrap().remove(id).is_none();
    let output = output.map_err(|e| e.to_string())?;

    let lines: Vec<serde_json::Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Cancelled or failed, the question may have edited files before stopping.
    // Then what changed must not get lost in the error: it comes back as the answer, with the notice.
    let changes = match &snapshot {
        Some(snapshot) => edited_files(&lines)
            .iter()
            .filter_map(|c| relative(repo.root(), c))
            .map(|name| change_of(&repo, snapshot, name))
            .collect(),
        None => Vec::new(),
    };
    let result = lines.iter().rev().find(|v| v.get("type").and_then(|t| t.as_str()) == Some("result"));
    let text = result.and_then(|v| v.get("result")).and_then(|r| r.as_str()).unwrap_or_default().to_owned();
    let failed = result.and_then(|v| v.get("is_error")).and_then(|e| e.as_bool()).unwrap_or(true);

    if cancelled || result.is_none() || failed {
        let reason = if cancelled {
            tr("pergunta cancelada.", "question cancelled.").to_owned()
        } else if result.is_some() {
            text
        } else {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if error.is_empty() { format!("{} {}", tr("o `claude` saiu com", "`claude` exited with"), output.status) } else { error }
        };
        if changes.is_empty() {
            return Err(reason);
        }
        return Ok(Answer { answer: format!("⚠︎ {reason}"), changes });
    }
    Ok(Answer { answer: text, changes })
}

/// Restores the files to what they were before the question. Only touches a file
/// that is still exactly as Claude left it: if someone edited it afterwards,
/// undoing would erase that work — it stays, and comes back in the list of failures.
pub fn undo(root: &Path, changes: &[FileChange]) -> Result<Vec<String>> {
    let repo = Repo::open(root)?;
    let root_dir = repo.root().canonicalize().map_err(|e| e.to_string())?;
    let mut kept = Vec::new();
    for a in changes.iter().filter(|a| a.undoable) {
        let path = repo.root().join(&a.path);
        let inside = match path.parent().and_then(|p| p.canonicalize().ok()) {
            Some(parent) => parent.starts_with(&root_dir),
            None => false,
        };
        let now = std::fs::read(&path).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        if !inside || now != a.after {
            kept.push(a.path.clone());
            continue;
        }
        let done = match &a.before {
            Some(content) => std::fs::write(&path, content),
            None => std::fs::remove_file(&path),
        };
        if done.is_err() {
            kept.push(a.path.clone());
        }
    }
    Ok(kept)
}

/// Kills the question in progress. Removing the pid from the map first is what
/// tells `ask` that the empty output was a cancellation, not a failure.
pub fn cancel(id: &str) {
    if let Some(pid) = running().lock().unwrap().remove(id) {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}
