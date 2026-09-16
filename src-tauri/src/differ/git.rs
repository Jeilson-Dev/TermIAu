//! Thin wrapper around the `git` CLI. Todas as leituras passam pelo `run`, que
//! recusa o lock do índice; as três escritas que existem — pôr no índice, tirar
//! do índice e commitar — passam pelo `run_write`, que precisa dele.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::differ::error::{Error, Result};

/// Config overrides that keep git's output stable regardless of the user's settings.
const STABLE_CONFIG: &[&str] = &[
    "core.quotePath=false",
    "color.ui=never",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
    "diff.external=",
];

pub struct Repo {
    root: PathBuf,
}

impl Repo {
    /// Opens the repository containing `path` (any subfolder works).
    pub fn open(path: &Path) -> Result<Repo> {
        let out = run(path, &["rev-parse", "--show-toplevel"], &[0], false)
            .map_err(|_| Error::NotARepo(path.display().to_string()))?;
        let root = String::from_utf8_lossy(&out).trim().to_string();
        Ok(Repo { root: PathBuf::from(root) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        run(&self.root, args, &[0], false)
    }

    /// Os comandos que mexem no repositório: `git add`, o inverso dele e o
    /// commit. Ao contrário de todo o resto daqui, precisam do lock do índice.
    pub fn run_write(&self, args: &[&str]) -> Result<Vec<u8>> {
        run(&self.root, args, &[0], true)
    }

    /// Como `run`, mas aceitando também a saída 1. É assim que o
    /// `git diff --no-index` diz "os dois arquivos são diferentes" — e é
    /// exatamente o que se espera dele ao diffar um arquivo novo contra o nada.
    pub fn run_diff(&self, args: &[&str]) -> Result<Vec<u8>> {
        run(&self.root, args, &[0, 1], false)
    }

    pub fn run_string(&self, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.run(args)?).trim().to_string())
    }

    /// Resolves a revision to a full commit sha, or `None` if it doesn't exist.
    pub fn resolve_commit(&self, rev: &str) -> Option<String> {
        let spec = format!("{rev}^{{commit}}");
        self.run_string(&["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])
            .ok()
            .filter(|sha| !sha.is_empty())
    }

    /// Short name of the checked-out branch, `None` when HEAD is detached.
    pub fn current_branch(&self) -> Option<String> {
        self.run_string(&["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .filter(|name| !name.is_empty())
    }

    pub fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        self.run_string(&["merge-base", "--end-of-options", a, b])
            .ok()
            .filter(|sha| !sha.is_empty())
    }
}

fn run(dir: &Path, args: &[&str], saidas_ok: &[i32], escreve: bool) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    for cfg in STABLE_CONFIG {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never take the index lock: we only read. Quem escreve pede o lock.
        .env("GIT_OPTIONAL_LOCKS", if escreve { "1" } else { "0" })
        // Cinto de segurança do commit: a mensagem já vai pronta no `-m`, e
        // uma janela de editor esperando texto travaria a aba sem explicação.
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");

    let output = cmd.output()?;
    if !saidas_ok.contains(&output.status.code().unwrap_or(-1)) {
        // O `git commit` diz "nothing added to commit" pela saída normal, não
        // pelo erro: sem isto a recusa mais comum chegaria como uma linha vazia.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        return Err(Error::Git { args: args.join(" "), stderr });
    }
    Ok(output.stdout)
}
