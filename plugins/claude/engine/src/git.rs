//! The few `git` calls the diff tab's questions need: the repository root, a loose
//! snapshot of the working tree and reading files from it.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Repo {
    root: PathBuf,
}

impl Repo {
    pub fn open(path: &Path) -> Result<Repo, String> {
        let out = run(path, &["rev-parse", "--show-toplevel"])?;
        Ok(Repo { root: PathBuf::from(String::from_utf8_lossy(&out).trim()) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn run(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        run(&self.root, args)
    }

    pub fn run_string(&self, args: &[&str]) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&self.run(args)?).trim().to_string())
    }

    /// Resolves a revision to a full commit sha, or `None` if it doesn't exist.
    pub fn resolve_commit(&self, rev: &str) -> Option<String> {
        let spec = format!("{rev}^{{commit}}");
        self.run_string(&["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])
            .ok()
            .filter(|sha| !sha.is_empty())
    }
}

/// Read-only: never takes the index lock, never waits for a prompt or an editor.
fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}
