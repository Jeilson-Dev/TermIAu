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

use super::error::{Error, Result};
use super::git::Repo;
use crate::idioma::tr;

/// The pid of each question in progress, by the id the webview gave it. It is
/// what lets the cancel button kill the right process.
#[derive(Default)]
pub struct Perguntas(pub Mutex<HashMap<String, u32>>);

/// How many sessions the list offers: the most recent ones are what matter.
const SESSOES_MAX: usize = 20;
/// The title lives at the end of the file, which reaches several MB. Reading the tail is enough.
const RABO_BYTES: u64 = 512 * 1024;

const INSTRUCOES_PT: &str = "Você está sendo consultado de dentro de uma ferramenta de revisão de código \
(a aba de diff do TermIAu). O stdin traz o trecho em revisão, o diff do arquivo e, se houver, a conversa \
até aqui. Responda em português, direto ao ponto e curto — a resposta aparece embaixo do trecho, no meio \
do diff.";

const INSTRUCOES_EN: &str = "You are being consulted from inside a code review tool (TermIAu's diff \
tab). Stdin holds the passage under review, the file's diff and, if any, the conversation so far. \
Answer in English, straight to the point and short — the answer shows up below the passage, in the \
middle of the diff.";

const SO_CONVERSA_PT: &str = " Isto é só uma conversa: pode ler o repositório para entender o contexto, mas \
não altere nada — nem que peçam. Se pedirem uma alteração, explique o que faria.";

const SO_CONVERSA_EN: &str = " This is only a conversation: you may read the repository to understand \
the context, but do not change anything — not even if asked. If asked for a change, explain what you \
would do.";

const COM_ALTERACOES_PT: &str = " O revisor liberou alterações: pode editar os arquivos do repositório quando \
ele pedir. Diga no fim o que alterou.";

const COM_ALTERACOES_EN: &str = " The reviewer allowed edits: you may edit the repository's files when \
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
const FERRAMENTAS_LEITURA: &str = "Read,Grep,Glob";
const FERRAMENTAS_ESCRITA: &str = "Read,Grep,Glob,Edit,Write";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sessao {
    pub id: String,
    pub title: String,
    /// Last write to the session file, in ms since the epoch.
    pub modified: u64,
}

/// The `claude` binary. The app opened from Finder inherits a minimal PATH,
/// without the installer's `~/.local/bin` — so it looks in the usual places and,
/// last, asks the user's login shell, which has the real PATH.
fn binario() -> Result<&'static Path> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidatos = vec![
            PathBuf::from(&home).join(".local/bin/claude"),
            PathBuf::from(&home).join(".claude/local/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            candidatos.extend(std::env::split_paths(&path).map(|d| d.join("claude")));
        }
        if let Some(achado) = candidatos.into_iter().find(|p| p.is_file()) {
            return Some(achado);
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let saida = Command::new(shell).args(["-lic", "command -v claude"]).output().ok()?;
        String::from_utf8_lossy(&saida.stdout)
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| l.starts_with('/'))
            .map(PathBuf::from)
    })
    .as_deref()
    .ok_or_else(|| Error::Claude(tr("não encontrei o `claude` instalado nesta máquina.", "couldn't find `claude` installed on this machine.").into()))
}

/// Where Claude Code keeps the sessions started in this folder: the path becomes
/// a directory name by replacing everything that isn't a letter or digit with `-`.
fn pasta_sessoes(root: &Path) -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".claude"),
    };
    let nome: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(base.join("projects").join(nome))
}

/// A session's title: the one the user gave, else the one Claude gave, else the
/// last prompt. `None` for a session with no conversation at all.
fn titulo(arquivo: &Path) -> Option<String> {
    let mut f = std::fs::File::open(arquivo).ok()?;
    let tamanho = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(tamanho.saturating_sub(RABO_BYTES))).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;

    let (mut dado, mut gerado, mut prompt) = (None, None, None);
    // The first line may have been cut in the middle; parsing it just fails.
    for linha in String::from_utf8_lossy(&bytes).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(linha) else { continue };
        let texto = |campo: &str| v.get(campo).and_then(|t| t.as_str()).map(str::to_owned);
        match v.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => dado = texto("customTitle").or(dado),
            Some("ai-title") => gerado = texto("aiTitle").or(gerado),
            Some("last-prompt") => prompt = texto("lastPrompt").or(prompt),
            _ => {}
        }
    }
    let t = dado.or(gerado).or(prompt)?;
    let t = t.lines().next().unwrap_or_default().trim();
    Some(if t.chars().count() > 90 { format!("{}…", t.chars().take(90).collect::<String>()) } else { t.to_owned() })
}

/// The Claude Code sessions open at this repository's root, from newest
/// to oldest.
pub fn sessoes(root: &Path) -> Result<Vec<Sessao>> {
    let Some(pasta) = pasta_sessoes(root) else { return Ok(Vec::new()) };
    let Ok(entradas) = std::fs::read_dir(&pasta) else { return Ok(Vec::new()) };

    let mut arquivos: Vec<(PathBuf, u64)> = entradas
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let quando = p.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((p, quando.as_millis() as u64))
        })
        .collect();
    arquivos.sort_by(|a, b| b.1.cmp(&a.1));

    Ok(arquivos
        .into_iter()
        .filter_map(|(p, modified)| {
            let title = titulo(&p)?;
            let id = p.file_stem()?.to_string_lossy().into_owned();
            Some(Sessao { id, title, modified })
        })
        .take(SESSOES_MAX)
        .collect())
}

/// A file Claude touched in a question with edits allowed: how it was and how
/// it ended up. `None` means "didn't exist" (before) or "deleted" (after).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alteracao {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// It can be safely restored to `before`. Not when it's unknown how the file
    /// was (ignored by git, too large) or when it is binary.
    pub undoable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resposta {
    pub answer: String,
    pub changes: Vec<Alteracao>,
}

/// An untracked file larger than this stays out of the snapshot: undoing its
/// edit becomes unavailable, rather than the snapshot wasting memory.
const FOTO_MAX_ARQUIVO: u64 = 1024 * 1024;
const FOTO_MAX_TOTAL: u64 = 32 * 1024 * 1024;

/// How the working tree was before the question. Tracked files fit in a loose
/// commit from `git stash create` — which touches no ref, index or disk — and
/// the untracked ones, which it doesn't pick up, are copied.
struct Foto {
    base: Option<String>,
    nao_rastreados: HashSet<String>,
    copias: HashMap<String, Vec<u8>>,
}

fn fotografar(repo: &Repo) -> Foto {
    let base = repo
        .run_string(&["stash", "create"])
        .ok()
        .filter(|sha| !sha.is_empty())
        .or_else(|| repo.resolve_commit("HEAD"));
    let lista = repo.run(&["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    let nao_rastreados: HashSet<String> = lista
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect();
    let mut copias = HashMap::new();
    let mut total = 0;
    for nome in &nao_rastreados {
        let caminho = repo.root().join(nome);
        let Ok(meta) = caminho.metadata() else { continue };
        if meta.len() > FOTO_MAX_ARQUIVO || total + meta.len() > FOTO_MAX_TOTAL {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&caminho) {
            total += meta.len();
            copias.insert(nome.clone(), bytes);
        }
    }
    Foto { base, nao_rastreados, copias }
}

enum Antes {
    Conteudo(Vec<u8>),
    NaoExistia,
    Desconhecido,
}

impl Foto {
    fn antes(&self, repo: &Repo, nome: &str) -> Antes {
        if self.nao_rastreados.contains(nome) {
            return self.copias.get(nome).map_or(Antes::Desconhecido, |b| Antes::Conteudo(b.clone()));
        }
        if let Some(base) = &self.base {
            if let Ok(bytes) = repo.run(&["show", &format!("{base}:{nome}")]) {
                return Antes::Conteudo(bytes);
            }
        }
        // Neither tracked nor new: either it didn't exist, or git ignores it — then there is no snapshot.
        let ignorado = repo.run(&["check-ignore", "-q", "--", nome]).is_ok();
        if ignorado { Antes::Desconhecido } else { Antes::NaoExistia }
    }
}

/// The path Claude used, relative to the root. It writes absolute paths, and
/// sometimes through the other side of a link (`/tmp` and `/private/tmp`, on macOS).
fn relativo(raiz: &Path, caminho: &str) -> Option<String> {
    let p = Path::new(caminho);
    let p = if p.is_absolute() { p.to_path_buf() } else { raiz.join(p) };
    if let Ok(r) = p.strip_prefix(raiz) {
        return Some(r.to_string_lossy().into_owned());
    }
    let raiz = raiz.canonicalize().ok()?;
    let real = match p.canonicalize() {
        Ok(real) => real,
        Err(_) => p.parent()?.canonicalize().ok()?.join(p.file_name()?),
    };
    real.strip_prefix(&raiz).ok().map(|r| r.to_string_lossy().into_owned())
}

/// The files on which Claude used a writing tool, in order.
fn editados(linhas: &[serde_json::Value]) -> Vec<String> {
    let mut vistos = Vec::new();
    for v in linhas {
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(partes) = v.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        for parte in partes {
            if parte.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            if !matches!(parte.get("name").and_then(|n| n.as_str()), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) {
                continue;
            }
            let entrada = parte.get("input");
            let caminho = entrada
                .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
                .and_then(|c| c.as_str());
            if let Some(c) = caminho {
                if !vistos.iter().any(|v| v == c) {
                    vistos.push(c.to_owned());
                }
            }
        }
    }
    vistos
}

fn alteracao(repo: &Repo, foto: &Foto, nome: String) -> Alteracao {
    let depois = std::fs::read(repo.root().join(&nome)).ok();
    let (antes, conhecido) = match foto.antes(repo, &nome) {
        Antes::Conteudo(b) => (Some(b), true),
        Antes::NaoExistia => (None, true),
        Antes::Desconhecido => (None, false),
    };
    // Binaries are neither shown nor undone from here: only the name stays, to know it was touched.
    let texto = |b: Option<Vec<u8>>| b.map(String::from_utf8).transpose();
    match (texto(antes), texto(depois)) {
        (Ok(before), Ok(after)) => Alteracao { path: nome, before, after, undoable: conhecido },
        _ => Alteracao { path: nome, before: None, after: None, undoable: false },
    }
}

/// Runs the question and returns the answer — and, with edits allowed, what
/// changed in each touched file, for the reviewer to see and be able to undo.
/// `contexto` goes through stdin: the snippet, the diff and the conversation so far.
#[allow(clippy::too_many_arguments)]
pub fn perguntar(
    root: &Path,
    pids: &Perguntas,
    id: &str,
    pergunta: &str,
    contexto: &str,
    modelo: Option<&str>,
    sessao: Option<&str>,
    alterar: bool,
) -> Result<Resposta> {
    let (ferramentas, modo, regra) = if alterar {
        (FERRAMENTAS_ESCRITA, "acceptEdits", tr(COM_ALTERACOES_PT, COM_ALTERACOES_EN))
    } else {
        // `dontAsk` denies what wasn't allowed, instead of waiting for someone to answer.
        (FERRAMENTAS_LEITURA, "dontAsk", tr(SO_CONVERSA_PT, SO_CONVERSA_EN))
    };
    let repo = Repo::open(root)?;
    let foto = alterar.then(|| fotografar(&repo));

    let mut cmd = Command::new(binario()?);
    cmd.current_dir(root)
        // `stream-json` instead of `json`: it is where the tools used show up,
        // and they are how we know which files were touched.
        .args(["-p", pergunta, "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .args(["--append-system-prompt", &format!("{}{regra}", tr(INSTRUCOES_PT, INSTRUCOES_EN))])
        .args(["--tools", ferramentas, "--permission-mode", modo])
        // The user's MCP servers bring their own writing tools (create a ticket, send a message).
        .arg("--strict-mcp-config")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(m) = modelo.filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(s) = sessao.filter(|s| !s.is_empty()) {
        cmd.args(["--resume", s, "--fork-session"]);
    }

    let mut filho = cmd.spawn().map_err(|err| Error::Claude(format!("{}: {err}", tr("não deu para rodar o `claude`", "couldn't run `claude`"))))?;
    pids.0.lock().unwrap().insert(id.to_owned(), filho.id());

    // On a separate thread: a large context fills the pipe before claude starts
    // reading, and writing it all from here would block waiting for the output.
    let mut entrada = filho.stdin.take();
    let contexto = contexto.to_owned();
    std::thread::spawn(move || {
        if let Some(e) = entrada.as_mut() {
            let _ = e.write_all(contexto.as_bytes());
        }
    });

    let saida = filho.wait_with_output();
    let cancelada = pids.0.lock().unwrap().remove(id).is_none();
    let saida = saida?;

    let linhas: Vec<serde_json::Value> = String::from_utf8_lossy(&saida.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Cancelled or failed, the question may have edited files before stopping.
    // Then what changed must not get lost in the error: it comes back as the answer, with the notice.
    let changes = match &foto {
        Some(foto) => editados(&linhas)
            .iter()
            .filter_map(|c| relativo(repo.root(), c))
            .map(|nome| alteracao(&repo, foto, nome))
            .collect(),
        None => Vec::new(),
    };
    let fim = linhas.iter().rev().find(|v| v.get("type").and_then(|t| t.as_str()) == Some("result"));
    let texto = fim.and_then(|v| v.get("result")).and_then(|r| r.as_str()).unwrap_or_default().to_owned();
    let falhou = fim.and_then(|v| v.get("is_error")).and_then(|e| e.as_bool()).unwrap_or(true);

    if cancelada || fim.is_none() || falhou {
        let motivo = if cancelada {
            tr("pergunta cancelada.", "question cancelled.").to_owned()
        } else if fim.is_some() {
            texto
        } else {
            let erro = String::from_utf8_lossy(&saida.stderr).trim().to_owned();
            if erro.is_empty() { format!("{} {}", tr("o `claude` saiu com", "`claude` exited with"), saida.status) } else { erro }
        };
        if changes.is_empty() {
            return Err(Error::Claude(motivo));
        }
        return Ok(Resposta { answer: format!("⚠︎ {motivo}"), changes });
    }
    Ok(Resposta { answer: texto, changes })
}

/// Restores the files to what they were before the question. Only touches a file
/// that is still exactly as Claude left it: if someone edited it afterwards,
/// undoing would erase that work — it stays, and comes back in the list of failures.
pub fn desfazer(root: &Path, alteracoes: &[Alteracao]) -> Result<Vec<String>> {
    let repo = Repo::open(root)?;
    let raiz = repo.root().canonicalize()?;
    let mut ficaram = Vec::new();
    for a in alteracoes.iter().filter(|a| a.undoable) {
        let caminho = repo.root().join(&a.path);
        let dentro = match caminho.parent().and_then(|p| p.canonicalize().ok()) {
            Some(pai) => pai.starts_with(&raiz),
            None => false,
        };
        let agora = std::fs::read(&caminho).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        if !dentro || agora != a.after {
            ficaram.push(a.path.clone());
            continue;
        }
        let feito = match &a.before {
            Some(conteudo) => std::fs::write(&caminho, conteudo),
            None => std::fs::remove_file(&caminho),
        };
        if feito.is_err() {
            ficaram.push(a.path.clone());
        }
    }
    Ok(ficaram)
}

/// Kills the question in progress. Removing the pid from the map first is what
/// tells `perguntar` that the empty output was a cancellation, not a failure.
pub fn cancelar(pids: &Perguntas, id: &str) {
    if let Some(pid) = pids.0.lock().unwrap().remove(id) {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}
