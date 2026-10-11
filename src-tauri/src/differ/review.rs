//! Review data: which branch is checked out, what it can be compared against,
//! and the committed diff of the branch since it forked from the target.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::differ::diff::{self, FileDiff, FileStatus, Staged};
use crate::differ::error::{Error, Result};
use crate::idioma::tr;
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
    diff_com(repo, &[from, to, "--"], false)
}

/// The two diff passes — the list and the patch — with the same command-line
/// tail, which is what guarantees the same files in the same order in both.
/// `solto` is for `--no-index`, which exits with 1 when it finds a difference.
fn diff_com(repo: &Repo, fim: &[&str], solto: bool) -> Result<Vec<FileDiff>> {
    let raw_args = [&["diff", "--raw", "-z", "--no-abbrev"], DIFF_OPTS, fim].concat();
    let patch_args = [&["diff", "--patch", "-U3"], DIFF_OPTS, fim].concat();
    let rodar = |args: &[&str]| if solto { repo.run_diff(args) } else { repo.run(args) };

    let raw = diff::parse_raw(&rodar(&raw_args)?)?;
    let patch = diff::parse_patch(&rodar(&patch_args)?)?;
    diff::build(raw, patch)
}

/// What is about to be committed: the index and the working tree against HEAD,
/// plus the files git doesn't track yet. It is `git status` seen as a diff —
/// with or without `git add`, everything that would go into the next commit.
pub fn load_diff_working(path: &Path) -> Result<ReviewDiff> {
    let repo = Repo::open(path)?;
    let head_sha = repo.resolve_commit("HEAD").ok_or(Error::NoCommits)?;

    // `diff HEAD` already merges what was added with what wasn't: its new side
    // is the working tree, and the index comes along on the way.
    let mut files = diff_com(&repo, &["HEAD", "--"], false)?;
    files.extend(nao_rastreados(&repo)?);
    // Two git passes become a single list on screen, and it has to be in
    // order — untracked files don't all go at the end.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    chaves_do_disco(&repo, &mut files);
    marcar_indice(&repo, &mut files)?;

    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Ok(ReviewDiff {
        root: repo.root().display().to_string(),
        branch: repo.current_branch(),
        additions,
        deletions,
        // There aren't two commits here: all three fields point to HEAD, which is
        // the old side of everything this tab shows.
        target: "HEAD".to_string(),
        target_sha: head_sha.clone(),
        merge_base: head_sha.clone(),
        head_sha,
        files,
    })
}

/// The files git doesn't know yet, each one whole, as a new file. `--no-index`
/// is what makes git diff a loose file against nothing; they can't go in a
/// single pass because it only accepts two paths at a time.
fn nao_rastreados(repo: &Repo) -> Result<Vec<FileDiff>> {
    let lista = repo.run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut files = Vec::new();
    for nome in lista.split(|b| *b == 0) {
        if nome.is_empty() {
            continue;
        }
        let nome = String::from_utf8_lossy(nome).into_owned();
        // An unreadable file (a broken link, a denied permission) must not bring
        // down the whole tab: it drops from the list and the others carry on.
        if let Ok(achados) = diff_com(repo, &["--no-index", "--", "/dev/null", &nome], true) {
            files.extend(achados);
        }
    }
    Ok(files)
}

/// Prefix of content keys that aren't git blobs: the new side of the working tree
/// diff is on disk, not in the object database.
const CHAVE_DISCO: &str = "wt:";

/// Gives the new side of working tree files a content key in place of the blob
/// id, which doesn't exist there — the content hasn't gone through git yet. The
/// key carries size and modification time because it is what says "this
/// changed": it is how the content cache and the reviewed mark get redone.
fn chaves_do_disco(repo: &Repo, files: &mut [FileDiff]) {
    for file in files {
        if file.new_oid.is_some() || file.status == FileStatus::Deleted {
            continue;
        }
        let Ok(meta) = std::fs::metadata(repo.root().join(&file.path)) else {
            continue;
        };
        let carimbo = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let chave = format!("{CHAVE_DISCO}{}-{carimbo}:{}", meta.len(), file.path);
        file.fingerprint = format!("{}:{chave}", file.fingerprint);
        file.new_oid = Some(chave);
    }
}

/// A cheap signature of what the to-be-committed tab shows: it changes when
/// something there changed, and only then. It is the light half of `load_diff_working`
/// — the raw list and the untracked names, without generating any patch — plus
/// the size and time of each file on disk, which is what says an already
/// modified file was modified again: in git's lists, it stays the same.
pub fn working_stamp(path: &Path) -> Result<String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let repo = Repo::open(path)?;
    let mut h = DefaultHasher::new();
    repo.resolve_commit("HEAD").hash(&mut h);

    let raw = repo.run(&["diff", "--raw", "-z", "--no-abbrev", "HEAD", "--"])?;
    raw.hash(&mut h);
    let outros = repo.run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    outros.hash(&mut h);

    let rastreados = diff::parse_raw(&raw)?.into_iter().map(|e| e.path);
    let novos = outros
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned());
    for nome in rastreados.chain(novos) {
        let Ok(meta) = std::fs::metadata(repo.root().join(&nome)) else {
            continue;
        };
        meta.len().hash(&mut h);
        if let Ok(t) = meta.modified().and_then(|t| Ok(t.duration_since(std::time::UNIX_EPOCH))) {
            t.map(|d| d.as_millis()).unwrap_or(0).hash(&mut h);
        }
    }
    Ok(format!("{:x}", h.finish()))
}

/// Tells for each file whether `git add` has taken it. Two lists of names: what
/// the index has beyond HEAD and what the disk has beyond the index — a file in
/// both is half in the index, because it changed again after `git add`.
fn marcar_indice(repo: &Repo, files: &mut [FileDiff]) -> Result<()> {
    let nomes = |args: &[&str]| -> Result<Vec<String>> {
        let out = repo.run(args)?;
        Ok(out
            .split(|b| *b == 0)
            .filter(|n| !n.is_empty())
            .map(|n| String::from_utf8_lossy(n).into_owned())
            .collect())
    };
    let no_indice = nomes(&["diff", "--name-only", "-z", "--cached", "HEAD", "--"])?;
    let no_disco = nomes(&["diff", "--name-only", "-z", "--"])?;

    for file in files {
        let indice = no_indice.contains(&file.path);
        let disco = no_disco.contains(&file.path);
        file.staged = Some(match (indice, disco) {
            (true, true) => Staged::Partial,
            (true, false) => Staged::Staged,
            // What git doesn't track is in neither list, and outside the index
            // is exactly where it is.
            _ => Staged::Unstaged,
        });
    }
    Ok(())
}

/// Stages — the button's `git add`. The target is a file, a folder or `.` for
/// the whole repository. `-A` is what makes the folder and `.` also take what
/// was deleted and what git doesn't track yet; on a single file it changes
/// nothing. The target goes as a literal pathspec: a file named `*.txt` or
/// starting with `-` must not become a wildcard or a command-line option.
pub fn stage(path: &Path, alvo: &str) -> Result<()> {
    let repo = Repo::open(path)?;
    repo.run_write(&["add", "-A", "--", &pathspec(alvo)])?;
    Ok(())
}

/// Unstages, leaving the disk as it is. Same reach as `stage`:
/// a file, a folder or `.` for everything.
pub fn unstage(path: &Path, alvo: &str) -> Result<()> {
    let repo = Repo::open(path)?;
    repo.run_write(&["restore", "--staged", "--", &pathspec(alvo)])?;
    Ok(())
}

/// Commits what is in the index and returns the new commit. What was left out of
/// the index stays on disk, untouched — it is the usual `git commit`, hooks and
/// all, just without an editor: the message goes ready-made.
pub fn commit(path: &Path, message: &str) -> Result<String> {
    let repo = Repo::open(path)?;
    if message.trim().is_empty() {
        return Err(Error::Internal(tr("O commit precisa de uma mensagem.", "The commit needs a message.").to_string()));
    }
    repo.run_write(&["commit", "-m", message])?;
    repo.resolve_commit("HEAD").ok_or(Error::NoCommits)
}

fn pathspec(file: &str) -> String {
    format!(":(literal){file}")
}

/// The path of a working tree file, guaranteed to be inside the repository.
/// The webview asks for the file by name, and a name coming from outside must
/// not become `../../.ssh/id_rsa`.
fn no_repositorio(raiz: &Path, arquivo: &str) -> Result<PathBuf> {
    let alvo = raiz.join(arquivo);
    let (alvo, raiz) = (
        alvo.canonicalize().map_err(Error::Io)?,
        raiz.canonicalize().map_err(Error::Io)?,
    );
    if !alvo.starts_with(&raiz) {
        return Err(Error::Internal(format!("{}: {arquivo}", tr("caminho fora do repositório", "path outside the repository"))));
    }
    Ok(alvo)
}

/// The file as it is on disk now: the new side of the working tree diff,
/// where there is no blob to read.
pub fn read_worktree(path: &Path, arquivo: &str) -> Result<Vec<String>> {
    let repo = Repo::open(path)?;
    let bytes = std::fs::read(no_repositorio(repo.root(), arquivo)?)?;
    Ok(em_linhas(&bytes))
}

/// Raw bytes of the file on disk — images not committed yet.
pub fn read_worktree_bytes(path: &Path, arquivo: &str) -> Result<Vec<u8>> {
    let repo = Repo::open(path)?;
    Ok(std::fs::read(no_repositorio(repo.root(), arquivo)?)?)
}

fn validate_oid(oid: &str) -> Result<()> {
    if !(oid.len() == 40 || oid.len() == 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Internal(format!("{}: {oid}", tr("id de blob inválido", "invalid blob id"))));
    }
    Ok(())
}

/// Full content of a blob as lines, used to expand context around hunks.
pub fn read_blob(path: &Path, oid: &str) -> Result<Vec<String>> {
    validate_oid(oid)?;
    let repo = Repo::open(path)?;
    let bytes = repo.run(&["cat-file", "blob", oid])?;
    Ok(em_linhas(&bytes))
}

/// The content as lines, the way the rest of the differ counts them: without the
/// final newline and without Windows' trailing \r.
fn em_linhas(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    if text.is_empty() {
        return Vec::new();
    }
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect()
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
            // In the repository's own config, not just on the helper's command
            // line: the `commit` here is the real one, and it doesn't pass `-c`.
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "t@t"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
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
    fn diffs_working_tree_including_untracked() {
        let repo = TestRepo::new();
        repo.write("editado.txt", "um\ndois\n");
        repo.write("apagado.txt", "tchau\n");
        repo.write("intocado.txt", "igual\n");
        repo.commit("base");

        // The three states the tab has to show together: what went into the
        // index, what stayed out of it and what git doesn't even know.
        repo.write("adicionado.txt", "novo no índice\n");
        repo.git(&["add", "adicionado.txt"]);
        repo.write("editado.txt", "um\nDOIS\n");
        fs::remove_file(repo.path().join("apagado.txt")).unwrap();
        repo.write("solto.txt", "ninguém me rastreia\n");
        repo.write(".gitignore", "ignorado.txt\n");
        repo.git(&["add", ".gitignore"]);
        repo.write("ignorado.txt", "não apareço\n");

        let diff = load_diff_working(repo.path()).unwrap();
        let mostrados: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            mostrados,
            [".gitignore", "adicionado.txt", "apagado.txt", "editado.txt", "solto.txt"]
        );

        assert_eq!(file(&diff, "adicionado.txt").status, FileStatus::Added);
        assert_eq!(file(&diff, "apagado.txt").status, FileStatus::Deleted);
        assert_eq!(file(&diff, "editado.txt").status, FileStatus::Modified);

        // The file git doesn't track comes in whole, as a new file.
        let solto = file(&diff, "solto.txt");
        assert_eq!(solto.status, FileStatus::Added);
        assert_eq!(solto.additions, 1);
        assert_eq!(solto.hunks[0].lines[0].kind, LineKind::Add);

        // The new side of what is on disk gets a content key in place of the
        // blob id, which doesn't exist there.
        assert!(solto.new_oid.as_deref().unwrap().starts_with(CHAVE_DISCO));
        assert!(file(&diff, "editado.txt").new_oid.as_deref().unwrap().starts_with(CHAVE_DISCO));
        // What is already in the index has a real blob.
        let no_indice = file(&diff, "adicionado.txt").new_oid.clone().unwrap();
        assert_eq!(no_indice.len(), 40);
        assert_eq!(read_worktree(repo.path(), "solto.txt").unwrap(), ["ninguém me rastreia"]);
        assert!(read_worktree(repo.path(), "../fora.txt").is_err());
    }

    #[test]
    fn stages_unstages_and_commits() {
        let repo = TestRepo::new();
        repo.write("editado.txt", "um\n");
        repo.commit("base");
        repo.write("editado.txt", "dois\n");
        repo.write("solto.txt", "novo\n");

        let pendente = || load_diff_working(repo.path()).unwrap();
        assert_eq!(file(&pendente(), "editado.txt").staged, Some(Staged::Unstaged));
        assert_eq!(file(&pendente(), "solto.txt").staged, Some(Staged::Unstaged));

        stage(repo.path(), "solto.txt").unwrap();
        assert_eq!(file(&pendente(), "solto.txt").staged, Some(Staged::Staged));

        // Changed again after `git add`: half is in the index, half isn't.
        repo.write("solto.txt", "novo e mudado\n");
        assert_eq!(file(&pendente(), "solto.txt").staged, Some(Staged::Partial));

        unstage(repo.path(), "solto.txt").unwrap();
        assert_eq!(file(&pendente(), "solto.txt").staged, Some(Staged::Unstaged));

        // The commit takes what is in the index and leaves the rest where it was.
        stage(repo.path(), "editado.txt").unwrap();
        let novo = commit(repo.path(), "só o editado").unwrap();
        assert_eq!(novo.len(), 40);
        let depois = pendente();
        assert_eq!(depois.head_sha, novo);
        let restantes: Vec<&str> = depois.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(restantes, ["solto.txt"]);

        // With nothing in the index git refuses, and its refusal is what the tab shows.
        let erro = commit(repo.path(), "vazio").unwrap_err().to_string();
        assert!(erro.contains("nothing added") || erro.contains("no changes added"), "{erro}");
        assert!(commit(repo.path(), "   ").is_err());
    }

    #[test]
    fn stages_folders_and_everything() {
        let repo = TestRepo::new();
        repo.write("fora.txt", "raiz\n");
        repo.write("sub/um.txt", "um\n");
        repo.write("sub/dois.txt", "dois\n");
        repo.commit("base");
        // A folder with a bit of everything: edited, deleted and never seen.
        repo.write("sub/um.txt", "um mudado\n");
        fs::remove_file(repo.path().join("sub/dois.txt")).unwrap();
        repo.write("sub/tres.txt", "novo\n");
        repo.write("fora.txt", "raiz mudada\n");

        let pendente = || load_diff_working(repo.path()).unwrap();
        let estado = |d: &ReviewDiff, p: &str| file(d, p).staged;

        // The folder takes all three states at once and doesn't touch what is outside it.
        stage(repo.path(), "sub").unwrap();
        let d = pendente();
        assert_eq!(estado(&d, "sub/um.txt"), Some(Staged::Staged));
        assert_eq!(estado(&d, "sub/dois.txt"), Some(Staged::Staged));
        assert_eq!(estado(&d, "sub/tres.txt"), Some(Staged::Staged));
        assert_eq!(estado(&d, "fora.txt"), Some(Staged::Unstaged));

        // `.` is the whole repository, both ways.
        stage(repo.path(), ".").unwrap();
        assert!(pendente().files.iter().all(|f| f.staged == Some(Staged::Staged)));
        unstage(repo.path(), ".").unwrap();
        assert!(pendente().files.iter().all(|f| f.staged == Some(Staged::Unstaged)));
    }

    #[test]
    fn working_stamp_changes_with_the_work() {
        let repo = TestRepo::new();
        repo.write("a.txt", "um\n");
        repo.commit("base");

        let marca = || working_stamp(repo.path()).unwrap();
        let parado = marca();
        assert_eq!(parado, marca(), "touching nothing, the signature stays the same");

        repo.write("a.txt", "dois\n");
        let editado = marca();
        assert_ne!(parado, editado);

        // The case git's lists miss: already modified, modified again.
        repo.write("a.txt", "três\n");
        let de_novo = marca();
        assert_ne!(editado, de_novo);

        repo.write("novo.txt", "apareci\n");
        let com_novo = marca();
        assert_ne!(de_novo, com_novo);

        stage(repo.path(), ".").unwrap();
        let no_indice = marca();
        assert_ne!(com_novo, no_indice);

        repo.git(&["commit", "-q", "-m", "tudo"]);
        assert_ne!(no_indice, marca());
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
