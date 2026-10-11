//! Catalog and download of the whisper.cpp ggml models.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use crate::idioma::tr;

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(serde::Serialize, Clone)]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub mb: u32,
    pub downloaded: bool,
}

const CATALOG: &[(&str, &str, &str, u32)] = &[
    ("tiny",           "Tiny",       "fastest, poor quality",             75),
    ("base",           "Base",       "fast, fair quality",               142),
    ("small",          "Small",      "good balance — recommended",       466),
    ("medium",         "Medium",     "better, heavier",                1_500),
    ("large-v3-turbo", "Large v3 Turbo", "best quality, fast on Apple Silicon", 1_620),
];

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("models")
}

pub fn path_for(app_data: &Path, id: &str) -> PathBuf {
    dir(app_data).join(format!("ggml-{id}.bin"))
}

pub fn catalog(app_data: &Path) -> Vec<ModelInfo> {
    CATALOG
        .iter()
        .map(|&(id, label, note, mb)| ModelInfo {
            id,
            label,
            note,
            mb,
            downloaded: path_for(app_data, id).exists(),
        })
        .collect()
}

/// Downloads the model, reporting progress (0..1) through `on_progress`.
///
/// Writes to `.part` and only moves it into place at the end, so a half
/// model never looks ready. If a `.part` already exists, resumes where it
/// stopped via `Range` — these files are hundreds of MB.
pub fn download(
    app_data: &Path,
    id: &str,
    on_progress: impl Fn(f64, u64, u64),
) -> anyhow::Result<PathBuf> {
    if !CATALOG.iter().any(|&(c, ..)| c == id) {
        anyhow::bail!("{}: {id}", tr("modelo desconhecido", "unknown model"));
    }
    let dest = path_for(app_data, id);
    if dest.exists() {
        return Ok(dest);
    }
    std::fs::create_dir_all(dir(app_data))?;

    let tmp = dest.with_extension("part");
    let have = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);

    let url = format!("{BASE_URL}/ggml-{id}.bin");
    let mut req = ureq::get(&url);
    if have > 0 {
        req = req.header("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| anyhow::anyhow!("{}: {e}", tr("download falhou", "download failed")))?;

    // 206 = the server accepted resuming; anything else starts over
    let resumed = resp.status().as_u16() == 206;
    let header = |k: &str| {
        resp.headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let len: u64 = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    // with 206, the total size comes in Content-Range: "bytes 100-999/1000"
    let total = if resumed {
        header("content-range")
            .and_then(|v| v.rsplit('/').next().and_then(|t| t.parse().ok()))
            .unwrap_or(have + len)
    } else {
        len
    };

    let mut done = if resumed { have } else { 0 };
    let mut file = if resumed {
        std::fs::OpenOptions::new().append(true).open(&tmp)?
    } else {
        std::fs::File::create(&tmp)?
    };

    let mut reader = resp.into_body().into_reader();
    let mut buf = vec![0u8; 1 << 18];
    let mut last_report = 0u64;
    on_progress(frac(done, total), done, total);

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        // report every ~2 MB so as not to flood the UI
        if done - last_report > 2 << 20 {
            last_report = done;
            on_progress(frac(done, total), done, total);
        }
    }
    file.flush()?;
    drop(file);

    if total > 0 && done < total {
        anyhow::bail!("{}", if crate::idioma::portugues() { format!("download incompleto: {done} de {total} bytes") } else { format!("incomplete download: {done} of {total} bytes") });
    }
    std::fs::rename(&tmp, &dest)?;
    on_progress(1.0, done, total.max(done));
    Ok(dest)
}

fn frac(done: u64, total: u64) -> f64 {
    if total > 0 {
        (done as f64 / total as f64).min(1.0)
    } else {
        0.0
    }
}
