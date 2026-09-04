//! Onde cada coisa mora no disco.
//!
//! Três lugares, com propósitos diferentes: a configuração é do usuário e é
//! editável à mão; os modelos são grandes e baixados uma vez; o cache é
//! descartável e o app se vira sem ele.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// `~/Library/Application Support/fala_claudio` — modelos e dados do espeak.
pub fn dados() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .context("não achei o diretório de dados do usuário")?
        .join("fala_claudio");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `~/.config/fala_claudio` — o `config.toml`, para quem gosta de editar a mão.
pub fn config() -> Result<PathBuf> {
    let dir = dirs::home_dir()
        .context("não achei o diretório do usuário")?
        .join(".config")
        .join("fala_claudio");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `~/Library/Caches/fala_claudio` — áudio já sintetizado.
pub fn cache() -> Result<PathBuf> {
    let dir = dirs::cache_dir()
        .context("não achei o diretório de cache")?
        .join("fala_claudio");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn arquivo_config() -> Result<PathBuf> {
    Ok(config()?.join("config.toml"))
}

pub fn dir_modelos() -> Result<PathBuf> {
    let dir = dados()?.join("modelos");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn modelo_onnx() -> Result<PathBuf> {
    Ok(dir_modelos()?.join("kokoro-v1.0.onnx"))
}

pub fn arquivo_vozes() -> Result<PathBuf> {
    Ok(dir_modelos()?.join("voices-v1.0.bin"))
}

/// O soquete por onde o CLI conversa com o app da bandeja.
pub fn soquete() -> Result<PathBuf> {
    Ok(dados()?.join("fala.sock"))
}
