//! Review data: which branch is checked out, what it can be compared against,
//! and the committed diff of the branch since it forked from the target.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::differ::diff::{self, FileDiff};
use crate::differ::error::{Error, Result};
use crate::differ::git::Repo;

/// Diff options shared by the raw and patch runs, so both list the same files in the same order.
const DIFF_OPTS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/// Candidates for the target branch when none is configured, in order of preference.
const TARGET_CANDIDATES: &[&str] = &["main", "master", "origin/main", "origin/master"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
    /// `None` when HEAD is detached.
    pub current_branch: Option<String>,
    /// `None` when the repository has no commits yet.
    pub head_sha: Option<String>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub suggested_target: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    pub root: String,
    pub branch: Option<String>,
    pub head_sha: String,
    pub target: String,
    pub target_sha: String,
    pub merge_base: String,
    pub additions: u32,
    pub deletions: u32,
    pub files: Vec<FileDiff>,
}

pub fn repo_info(path: &Path) -> Result<RepoInfo> {
    let repo = Repo::open(path)?;
    let refs = repo.run_string(&[
        "for-each-ref",
        "--format=%(refname)%09%(symref)",
        "refs/heads",
        "refs/remotes",
    ])?;

    let mut local_branches = Vec::new();
    let mut remote_branches = Vec::new();
    for line in refs.lines() {
        let (name, symref) = line.split_once('\t').unwrap_or((line, ""));
        if !symref.is_empty() {
            continue; // e.g. origin/HEAD
        }
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            local_branches.push(branch.to_string());
        } else if let Some(branch) = name.strip_prefix("refs/remotes/") {
            remote_branches.push(branch.to_string());
        }
    }

    let suggested_target = TARGET_CANDIDATES
        .iter()
        .find(|candidate| {
            local_branches.iter().chain(&remote_branches).any(|b| b == *candidate)
        })
        .map(|b| b.to_string());

    let root = repo.root();
    Ok(RepoInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        current_branch: repo.current_branch(),
        head_sha: repo.resolve_commit("HEAD"),
        local_branches,
        remote_branches,
        suggested_target,
    })
}

/// Committed changes of the checked-out branch since it forked from `target`.
pub fn load_diff(path: &Path, target: &str) -> Result<ReviewDiff> {
    let repo = Repo::open(path)?;
    let head_sha = repo.resolve_commit("HEAD").ok_or(Error::NoCommits)?;
    let target_sha = repo
        .resolve_commit(target)
        .ok_or_else(|| Error::RefNotFound(target.to_string()))?;
    let merge_base = repo
        .merge_base(&target_sha, &head_sha)
        .ok_or_else(|| Error::NoMergeBase { target: target.to_string() })?;
    let files = diff_between(&repo, &merge_base, &head_sha)?;

    Ok(ReviewDiff {
        root: repo.root().display().to_string(),
        branch: repo.current_branch(),
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        head_sha,
        target: target.to_string(),
        target_sha,
        merge_base,
        files,
    })
}

/// Committed changes since `base` (a reviewed commit) up to HEAD: what the fixes did.
/// It's a diff of the two trees, so it still works after the reviewed commit was amended
/// or rebased away, as long as git still has it.
pub fn load_diff_since(path: &Path, base: &str) -> Result<ReviewDiff> {
    let repo = Repo::open(path)?;
    let head_sha = repo.resolve_commit("HEAD").ok_or(Error::NoCommits)?;
    let base_sha = repo
        .resolve_commit(base)
        .ok_or_else(|| Error::RefNotFound(base.to_string()))?;
    let files = diff_between(&repo, &base_sha, &head_sha)?;

    Ok(ReviewDiff {
        root: repo.root().display().to_string(),
        branch: repo.current_branch(),
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        head_sha,
        target: base_sha.clone(),
        target_sha: base_sha.clone(),
        merge_base: base_sha,
        files,
    })
}

fn diff_between(repo: &Repo, from: &str, to: &str) -> Result<Vec<FileDiff>> {
    let range = [from, to, "--"];
    let raw_args = [&["diff", "--raw", "-z", "--no-abbrev"], DIFF_OPTS, &range].concat();
    let patch_args = [&["diff", "--patch", "-U3"], DIFF_OPTS, &range].concat();

    let raw = diff::parse_raw(&repo.run(&raw_args)?)?;
    let patch = diff::parse_patch(&repo.run(&patch_args)?)?;
    diff::build(raw, patch)
}

fn validate_oid(oid: &str) -> Result<()> {
    if !(oid.len() == 40 || oid.len() == 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Internal(format!("id de blob inválido: {oid}")));
    }
    Ok(())
}

/// Full content of a blob as lines, used to expand context around hunks.
pub fn read_blob(path: &Path, oid: &str) -> Result<Vec<String>> {
    validate_oid(oid)?;
    let repo = Repo::open(path)?;
    let bytes = repo.run(&["cat-file", "blob", oid])?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect())
}

const LFS_POINTER_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1\n";

/// Raw content of a blob (images). Git LFS pointers resolve to the locally cached object.
pub fn read_blob_bytes(path: &Path, oid: &str) -> Result<Vec<u8>> {
    validate_oid(oid)?;
    let repo = Repo::open(path)?;
    let bytes = repo.run(&["cat-file", "blob", oid])?;
    match lfs_oid(&bytes) {
        Some(lfs) => read_lfs_object(&repo, &lfs),
        None => Ok(bytes),
    }
}

/// The sha256 of the real content when `bytes` is a Git LFS pointer file.
fn lfs_oid(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 1024 || !bytes.starts_with(LFS_POINTER_PREFIX) {
        return None;
    }
    std::str::from_utf8(bytes)
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string)
}

/// Reads the object from the local LFS cache; never downloads, so the repository stays untouched.
fn read_lfs_object(repo: &Repo, oid: &str) -> Result<Vec<u8>> {
    let common = PathBuf::from(repo.run_string(&["rev-parse", "--git-common-dir"])?);
    let common = if common.is_absolute() { common } else { repo.root().join(common) };
    let object = common.join("lfs/objects").join(&oid[0..2]).join(&oid[2..4]).join(oid);
    std::fs::read(object).map_err(|_| Error::LfsMissing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::differ::diff::{FileStatus, LineKind};
    use std::fs;
    use std::process::Command;

    struct TestRepo {
        dir: tempfile::TempDir,
    }

    impl TestRepo {
        fn new() -> TestRepo {
            let repo = TestRepo { dir: tempfile::tempdir().unwrap() };
            repo.git(&["init", "-q", "-b", "main"]);
            repo
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn git(&self, args: &[&str]) {
            let status = Command::new("git")
                .arg("-C")
                .arg(self.path())
                .args(["-c", "user.name=Test", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        }

        fn write(&self, file: &str, content: impl AsRef<[u8]>) {
            let path = self.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn commit(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
    }

    fn file<'a>(diff: &'a ReviewDiff, path: &str) -> &'a FileDiff {
        diff.files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} not in diff"))
    }

    #[test]
    fn diffs_branch_against_merge_base() {
        let repo = TestRepo::new();
        repo.write("edit.txt", "one\ntwo\nthree\n");
        repo.write("remove.txt", "bye\n");
        repo.write("move.txt", "same content\nacross rename\nfor detection\n");
        repo.write("image.bin", [0u8, 1, 2, 3]);
        repo.write("main-only.txt", "base\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("edit.txt", "one\nTWO\nthree\nfour\n");
        fs::remove_file(repo.path().join("remove.txt")).unwrap();
        repo.git(&["mv", "move.txt", "moved.txt"]);
        repo.write("dir/novo arquivo ç.txt", "olá\n");
        repo.write("image.bin", [0u8, 9, 9, 9]);
        repo.commit("feature work");

        // Work landing on main after the fork must not show up in the review.
        repo.git(&["checkout", "-q", "main"]);
        repo.write("main-only.txt", "changed on main\n");
        repo.commit("main moves on");
        repo.git(&["checkout", "-q", "feature"]);

        // Uncommitted changes are ignored.
        repo.write("edit.txt", "dirty\n");

        let diff = load_diff(repo.path(), "main").unwrap();
        assert_eq!(diff.branch.as_deref(), Some("feature"));
        let mut paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            ["dir/novo arquivo ç.txt", "edit.txt", "image.bin", "moved.txt", "remove.txt"]
        );

        let edit = file(&diff, "edit.txt");
        assert_eq!(edit.status, FileStatus::Modified);
        assert_eq!((edit.additions, edit.deletions), (2, 1));
        let changed: Vec<_> = edit.hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind != LineKind::Context)
            .map(|l| (l.kind, l.old_no, l.new_no, l.content.as_str()))
            .collect();
        assert_eq!(
            changed,
            [
                (LineKind::Del, Some(2), None, "two"),
                (LineKind::Add, None, Some(2), "TWO"),
                (LineKind::Add, None, Some(4), "four"),
            ]
        );

        let moved = file(&diff, "moved.txt");
        assert_eq!(moved.status, FileStatus::Renamed);
        assert_eq!(moved.old_path.as_deref(), Some("move.txt"));
        assert_eq!(moved.similarity, Some(100));
        assert!(moved.hunks.is_empty());

        assert_eq!(file(&diff, "remove.txt").status, FileStatus::Deleted);
        assert!(file(&diff, "remove.txt").new_oid.is_none());
        assert_eq!(file(&diff, "dir/novo arquivo ç.txt").status, FileStatus::Added);
        assert!(file(&diff, "image.bin").binary);

        let blob = read_blob(repo.path(), edit.new_oid.as_deref().unwrap()).unwrap();
        assert_eq!(blob, ["one", "TWO", "three", "four"]);
    }

    #[test]
    fn diffs_fixes_since_reviewed_commit() {
        let repo = TestRepo::new();
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("a.txt", "a1\n");
        repo.write("b.txt", "b1\n");
        repo.commit("reviewed");
        let reviewed = load_diff(repo.path(), "main").unwrap().head_sha;

        repo.write("a.txt", "a2\n");
        repo.commit("fix");

        let fixes = load_diff_since(repo.path(), &reviewed).unwrap();
        assert_eq!(fixes.merge_base, reviewed);
        let paths: Vec<_> = fixes.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt"]);
        let a = file(&fixes, "a.txt");
        assert_eq!(read_blob(repo.path(), a.old_oid.as_deref().unwrap()).unwrap(), ["a1"]);

        assert!(matches!(load_diff_since(repo.path(), "nope"), Err(Error::RefNotFound(_))));
    }

    #[test]
    fn fingerprint_changes_only_for_touched_files() {
        let repo = TestRepo::new();
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("a.txt", "a1\n");
        repo.write("b.txt", "b1\n");
        repo.commit("first");
        let before = load_diff(repo.path(), "main").unwrap();

        repo.write("a.txt", "a2\n");
        repo.commit("second");
        let after = load_diff(repo.path(), "main").unwrap();

        assert_ne!(file(&before, "a.txt").fingerprint, file(&after, "a.txt").fingerprint);
        assert_eq!(file(&before, "b.txt").fingerprint, file(&after, "b.txt").fingerprint);
    }

    #[test]
    fn reads_image_bytes_and_local_lfs_objects() {
        let repo = TestRepo::new();
        let png = [0x89, b'P', b'N', b'G', 0, 1, 2, 255];
        let lfs_hash = format!("ab{}", "c".repeat(62));
        repo.write("plain.png", png);
        repo.write(
            "stored-in-lfs.png",
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{lfs_hash}\nsize 12\n"),
        );
        repo.commit("images");

        let git = Repo::open(repo.path()).unwrap();
        let blob = |file: &str| git.run_string(&["rev-parse", &format!("HEAD:{file}")]).unwrap();
        assert_eq!(read_blob_bytes(repo.path(), &blob("plain.png")).unwrap(), png);

        let lfs_blob = blob("stored-in-lfs.png");
        assert!(matches!(read_blob_bytes(repo.path(), &lfs_blob), Err(Error::LfsMissing)));

        let object_dir = repo.path().join(".git/lfs/objects/ab/cc");
        fs::create_dir_all(&object_dir).unwrap();
        fs::write(object_dir.join(&lfs_hash), b"real content").unwrap();
        assert_eq!(read_blob_bytes(repo.path(), &lfs_blob).unwrap(), b"real content");
    }

    #[test]
    fn reports_repo_info_and_errors() {
        let repo = TestRepo::new();
        assert!(matches!(load_diff(repo.path(), "main"), Err(Error::NoCommits)));

        repo.write("a.txt", "a\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);

        let info = repo_info(&repo.path().join(".git/..")).unwrap();
        assert_eq!(info.current_branch.as_deref(), Some("feature"));
        assert_eq!(info.suggested_target.as_deref(), Some("main"));
        assert_eq!(info.local_branches, ["feature", "main"]);

        assert!(matches!(load_diff(repo.path(), "nope"), Err(Error::RefNotFound(_))));
        assert!(matches!(load_diff(repo.path(), "--output=x"), Err(Error::RefNotFound(_))));

        repo.git(&["checkout", "-q", "--orphan", "unrelated"]);
        repo.commit("unrelated history");
        assert!(matches!(load_diff(repo.path(), "main"), Err(Error::NoMergeBase { .. })));

        let not_repo = tempfile::tempdir().unwrap();
        assert!(matches!(repo_info(not_repo.path()), Err(Error::NotARepo(_))));
    }
}
