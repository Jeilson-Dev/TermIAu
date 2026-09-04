//! Catálogo e download dos modelos ggml do whisper.cpp.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

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
    ("tiny",           "Tiny",       "mais rápido, qualidade fraca",        75),
    ("base",           "Base",       "rápido, qualidade razoável",         142),
    ("small",          "Small",      "bom equilíbrio — recomendado",       466),
    ("medium",         "Medium",     "melhor, mais pesado",              1_500),
    ("large-v3-turbo", "Large v3 Turbo", "melhor qualidade, rápido em Apple Silicon", 1_620),
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

/// Baixa o modelo, informando o progresso (0..1) em `on_progress`.
///
/// Grava em `.part` e só move para o destino no fim, para nunca deixar um
/// modelo pela metade parecendo pronto. Se já existe um `.part`, retoma de
/// onde parou via `Range` — são arquivos de centenas de MB.
pub fn download(
    app_data: &Path,
    id: &str,
    on_progress: impl Fn(f64, u64, u64),
) -> anyhow::Result<PathBuf> {
    if !CATALOG.iter().any(|&(c, ..)| c == id) {
        anyhow::bail!("modelo desconhecido: {id}");
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
    let resp = req.call().map_err(|e| anyhow::anyhow!("download falhou: {e}"))?;

    // 206 = servidor aceitou retomar; qualquer outra coisa recomeça do zero
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
    // com 206, o tamanho total vem no Content-Range: "bytes 100-999/1000"
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
        // reporta a cada ~2 MB para não inundar a interface
        if done - last_report > 2 << 20 {
            last_report = done;
            on_progress(frac(done, total), done, total);
        }
    }
    file.flush()?;
    drop(file);

    if total > 0 && done < total {
        anyhow::bail!("download incompleto: {done} de {total} bytes");
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
