//! Thin wrapper around the `git` CLI. All reads go through `run`, which refuses
//! the index lock; the three writes that exist — staging, unstaging and
//! committing — go through `run_write`, which needs it.

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

    /// The commands that change the repository: `git add`, its inverse and
    /// commit. Unlike everything else here, they need the index lock.
    pub fn run_write(&self, args: &[&str]) -> Result<Vec<u8>> {
        run(&self.root, args, &[0], true)
    }

    /// Like `run`, but also accepting exit code 1. That is how
    /// `git diff --no-index` says "the two files differ" — exactly what is
    /// expected of it when diffing a new file against nothing.
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

fn run(dir: &Path, args: &[&str], ok_codes: &[i32], writes: bool) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    for cfg in STABLE_CONFIG {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never take the index lock when only reading. Writers ask for it.
        .env("GIT_OPTIONAL_LOCKS", if writes { "1" } else { "0" })
        // Safety belt for commit: the message is already in `-m`, and an
        // editor window waiting for text would hang the tab with no explanation.
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");

    let output = cmd.output()?;
    if !ok_codes.contains(&output.status.code().unwrap_or(-1)) {
        // `git commit` says "nothing added to commit" on stdout, not stderr:
        // without this the most common refusal would arrive as an empty line.
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
