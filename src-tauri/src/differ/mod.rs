//! O differ: o diff da branch contra a branch alvo, como no GitHub, mas local.
//!
//! Veio inteiro do projeto `differ` — os quatro módulos abaixo são cópia dele.
//! O que muda aqui é só a casca: em vez de um app com janela própria, são
//! quatro comandos que a aba presa da barra chama pela webview.
//!
//! Nada aqui escreve no repositório: é tudo `git` de leitura.

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

/// As chamadas ao git bloqueiam, e as threads do runtime assíncrono são poucas:
/// um `git diff` de repositório grande seguraria o resto do app junto.
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

/// O que mudou desde um commit revisado: é onde as correções da revisão aparecem.
#[tauri::command]
pub async fn load_diff_since(path: PathBuf, base: String) -> Result<ReviewDiff> {
    blocking(move || review::load_diff_since(&path, &base)).await
}

#[tauri::command]
pub async fn read_blob(path: PathBuf, oid: String) -> Result<Vec<String>> {
    blocking(move || review::read_blob(&path, &oid)).await
}

/// O vigia do repositório aberto na aba do diff. Um só, porque a aba mostra um
/// repositório por vez. Guardá-lo aqui é o que o mantém vivo: um watcher largado
/// se desliga, e trocar de repositório aposenta o anterior exatamente assim.
#[derive(Default)]
pub struct Vigia(Mutex<Option<RecommendedWatcher>>);

/// Só estas partes do .git mexem no que a aba mostra. O diff é de trabalho
/// commitado, então `git add` e edição de arquivo não mudam nada — e o
/// `objects/` ferve durante um fetch, milhares de eventos que terminam numa
/// atualização de ref só, que é justamente a que interessa.
fn interessa(caminho: &Path) -> bool {
    let p = caminho.to_string_lossy();
    if p.ends_with(".lock") {
        return false;
    }
    p.ends_with("/HEAD")
        || p.ends_with("/packed-refs")
        || p.contains("/refs/")
        || p.contains("/logs/")
}

/// Passa a vigiar o .git deste repositório, avisando a webview quando ele mexer.
/// Quem decide o que fazer com o aviso é a aba — aqui só se constata a mudança.
#[tauri::command]
pub async fn watch_repo(app: AppHandle, path: PathBuf) -> Result<()> {
    // `--absolute-git-dir` em vez de `<raiz>/.git`: em worktree e em submódulo o
    // .git é um arquivo apontando para outro lugar, e é o outro lugar que muda.
    let (raiz, gitdir) = blocking(move || {
        let repo = git::Repo::open(&path)?;
        let gitdir = repo.run_string(&["rev-parse", "--absolute-git-dir"])?;
        Ok((repo.root().to_string_lossy().into_owned(), PathBuf::from(gitdir)))
    })
    .await?;

    let aviso = app.clone();
    let mut vigia = notify::recommended_watcher(move |ev: notify::Result<Event>| {
        let Ok(ev) = ev else { return };
        // Ler o .git não é mexer nele — e nós mesmos o lemos a cada `git diff`.
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        if ev.paths.iter().any(|p| interessa(p)) {
            let _ = aviso.emit("differ://mudou", &raiz);
        }
    })
    .map_err(|err| Error::Internal(err.to_string()))?;

    vigia
        .watch(&gitdir, RecursiveMode::Recursive)
        .map_err(|err| Error::Internal(err.to_string()))?;
    *app.state::<Vigia>().0.lock().unwrap() = Some(vigia);
    Ok(())
}

/// Bytes crus (binário, não JSON) para as imagens poderem ser desenhadas.
#[tauri::command]
pub async fn read_blob_bytes(path: PathBuf, oid: String) -> Result<tauri::ipc::Response> {
    let bytes = blocking(move || review::read_blob_bytes(&path, &oid)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
