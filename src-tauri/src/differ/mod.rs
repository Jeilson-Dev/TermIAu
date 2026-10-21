//! The differ: the branch's diff against the target branch, like on GitHub, but local.
//!
//! It came whole from the `differ` project — the four modules below are copies of it.
//! Only the shell changes here: instead of an app with its own window, they are
//! commands the pinned tab in the bar calls through the webview.
//!
//! Almost nothing here writes to the repository: apart from `stage_file`,
//! `unstage_file` and `commit` — the three of the to-be-committed tab —, it is all
//! read-only `git`, and the others don't even take the index lock (see `run` in git.rs).

mod diff;
mod error;
mod git;
mod review;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use error::{Error, Result};
use review::{RepoInfo, ReviewDiff};


/// Git calls block, and the async runtime has few threads: a `git diff` on a
/// large repository would hold up the rest of the app with it.
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| Error::Internal(err.to_string()))?
}

#[tauri::command]
pub async fn open_repo(path: PathBuf) -> Result<RepoInfo> {
    blocking(move || review::repo_info(&path)).await
}

#[tauri::command]
pub async fn load_diff(path: PathBuf, target: String) -> Result<ReviewDiff> {
    blocking(move || review::load_diff(&path, &target)).await
}

/// What changed since a reviewed commit: where the review's fixes show up.
#[tauri::command]
pub async fn load_diff_since(path: PathBuf, base: String) -> Result<ReviewDiff> {
    blocking(move || review::load_diff_since(&path, &base)).await
}

/// What is about to be committed: index, working tree and new files.
#[tauri::command]
pub async fn load_diff_working(path: PathBuf) -> Result<ReviewDiff> {
    blocking(move || review::load_diff_working(&path)).await
}

/// The root of the repository containing the folder, or `None` when there is
/// none. It tells whether a panel's diff button leads anywhere.
#[tauri::command]
pub async fn repo_root(path: PathBuf) -> Result<Option<String>> {
    blocking(move || Ok(git::Repo::open(&path).ok().map(|r| r.root().display().to_string()))).await
}

/// The branch the folder is on, for the panel bar. `None` outside a repository
/// and with a detached HEAD — then there is no name to show.
#[tauri::command]
pub async fn repo_branch(path: PathBuf) -> Result<Option<String>> {
    blocking(move || Ok(git::Repo::open(&path).ok().and_then(|r| r.current_branch()))).await
}

/// A signature of the working tree state, so the tab knows it changed without
/// redoing the whole diff on every clock tick.
#[tauri::command]
pub async fn working_stamp(path: PathBuf) -> Result<String> {
    blocking(move || review::working_stamp(&path)).await
}

/// Stages `target` — a file, a folder or `.` for the whole repository. Along
/// with `unstage` and `commit`, it is one of the only three things the differ
/// writes; everything else here is reading.
#[tauri::command]
pub async fn stage(path: PathBuf, target: String) -> Result<()> {
    blocking(move || review::stage(&path, &target)).await
}

#[tauri::command]
pub async fn unstage(path: PathBuf, target: String) -> Result<()> {
    blocking(move || review::unstage(&path, &target)).await
}

/// Commits what is in the index and returns the new commit's sha.
#[tauri::command]
pub async fn commit(path: PathBuf, message: String) -> Result<String> {
    blocking(move || review::commit(&path, &message)).await
}

/// The file as it is on disk. The new side of the working tree diff has no
/// blob to read: the content hasn't gone through git yet.
#[tauri::command]
pub async fn read_worktree(path: PathBuf, file: String) -> Result<Vec<String>> {
    blocking(move || review::read_worktree(&path, &file)).await
}

#[tauri::command]
pub async fn read_blob(path: PathBuf, oid: String) -> Result<Vec<String>> {
    blocking(move || review::read_blob(&path, &oid)).await
}

/// The watcher of the repository open in the diff tab. Just one, because the tab
/// shows one repository at a time. Keeping it here is what keeps it alive: a
/// dropped watcher shuts down, and switching repositories retires the previous one
/// exactly that way.
#[derive(Default)]
pub struct RepoWatcher(Mutex<Option<RecommendedWatcher>>);

/// Only these parts of .git affect what the tab shows. The diff is of committed
/// work, so `git add` and file edits change nothing — and `objects/` boils
/// during a fetch, thousands of events ending in a single ref update, which is
/// precisely the one that matters.
fn matters(path: &Path) -> bool {
    let p = path.to_string_lossy();
    if p.ends_with(".lock") {
        return false;
    }
    p.ends_with("/HEAD")
        || p.ends_with("/packed-refs")
        || p.contains("/refs/")
        || p.contains("/logs/")
}

/// Starts watching this repository's .git, notifying the webview when it changes.
/// The tab decides what to do with the notice — here we only detect the change.
#[tauri::command]
pub async fn watch_repo(app: AppHandle, path: PathBuf) -> Result<()> {
    // `--absolute-git-dir` instead of `<root>/.git`: in a worktree or submodule
    // .git is a file pointing elsewhere, and it is the elsewhere that changes.
    let (root_dir, gitdir) = blocking(move || {
        let repo = git::Repo::open(&path)?;
        let gitdir = repo.run_string(&["rev-parse", "--absolute-git-dir"])?;
        Ok((repo.root().to_string_lossy().into_owned(), PathBuf::from(gitdir)))
    })
    .await?;

    let notify_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |ev: notify::Result<Event>| {
        let Ok(ev) = ev else { return };
        // Reading .git is not changing it — and we read it ourselves on every `git diff`.
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        if ev.paths.iter().any(|p| matters(p)) {
            let _ = notify_app.emit("differ://changed", &root_dir);
        }
    })
    .map_err(|err| Error::Internal(err.to_string()))?;

    watcher
        .watch(&gitdir, RecursiveMode::Recursive)
        .map_err(|err| Error::Internal(err.to_string()))?;
    *app.state::<RepoWatcher>().0.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Raw bytes (binary, not JSON) so images can be drawn.
#[tauri::command]
pub async fn read_blob_bytes(path: PathBuf, oid: String) -> Result<tauri::ipc::Response> {
    let bytes = blocking(move || review::read_blob_bytes(&path, &oid)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The same, for an image that is only on disk so far.
#[tauri::command]
pub async fn read_worktree_bytes(path: PathBuf, file: String) -> Result<tauri::ipc::Response> {
    let bytes = blocking(move || review::read_worktree_bytes(&path, &file)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
