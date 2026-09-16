//! Thin wrapper around the `git` CLI. Every call is read-only.

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
        let out = run(path, &["rev-parse", "--show-toplevel"])
            .map_err(|_| Error::NotARepo(path.display().to_string()))?;
        let root = String::from_utf8_lossy(&out).trim().to_string();
        Ok(Repo { root: PathBuf::from(root) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        run(&self.root, args)
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

fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    for cfg in STABLE_CONFIG {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never take the index lock: we only read.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");

    let output = cmd.output()?;
    if !output.status.success() {
        return Err(Error::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(output.stdout)
}
