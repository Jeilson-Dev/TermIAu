//! Áudio já sintetizado.
//!
//! Falar a mesma frase duas vezes é comum ("o teste passou", "pronto") e
//! sintetizar custa tempo. O cache troca disco por latência e se limita
//! sozinho, descartando o mais velho.

use crate::caminhos;
use anyhow::Result;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Teto do cache. Passou disso, os arquivos mais antigos saem.
const LIMITE_BYTES: u64 = 64 * 1024 * 1024;

/// A chave é tudo que muda o áudio. Mudou a voz, a velocidade ou o jeito de
/// ler alguma palavra, é outro arquivo.
pub fn chave(texto: &str, voz: &str, velocidade: f32, pronuncia: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(texto.as_bytes());
    hash.update([0]);
    hash.update(voz.as_bytes());
    hash.update([0]);
    hash.update(format!("{velocidade:.3}").as_bytes());
    hash.update([0]);
    hash.update(pronuncia.as_bytes());
    hex::encode(&hash.finalize()[..16])
}

pub fn caminho(chave: &str) -> Result<PathBuf> {
    Ok(caminhos::cache()?.join(format!("{chave}.wav")))
}

pub fn buscar(chave: &str) -> Option<PathBuf> {
    let caminho = caminho(chave).ok()?;
    caminho.is_file().then_some(caminho)
}

/// Corta o cache de volta ao limite. Falhar aqui não é motivo para não falar,
/// então o erro é engolido por quem chama.
pub fn podar() -> Result<()> {
    let dir = caminhos::cache()?;
    let mut arquivos: Vec<(PathBuf, u64, std::time::SystemTime)> = std::fs::read_dir(&dir)?
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| {
                (
                    e.path(),
                    meta.len(),
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                )
            })
        })
        .collect();

    let mut total: u64 = arquivos.iter().map(|(_, t, _)| t).sum();
    if total <= LIMITE_BYTES {
        return Ok(());
    }

    arquivos.sort_by_key(|(_, _, quando)| *quando);
    for (caminho, tamanho, _) in arquivos {
        if total <= LIMITE_BYTES {
            break;
        }
        if std::fs::remove_file(&caminho).is_ok() {
            total = total.saturating_sub(tamanho);
        }
    }
    Ok(())
}

/// Quanto o cache ocupa e quantos áudios guarda, para a tela de configuração.
pub fn tamanho() -> (u64, usize) {
    let Ok(dir) = caminhos::cache() else {
        return (0, 0);
    };
    let Ok(entradas) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let tamanhos: Vec<u64> = entradas
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .collect();
    (tamanhos.iter().sum(), tamanhos.len())
}

pub fn limpar() -> Result<()> {
    let dir = caminhos::cache()?;
    for entrada in std::fs::read_dir(dir)?.flatten() {
        if entrada.metadata().map(|m| m.is_file()).unwrap_or(false) {
            let _ = std::fs::remove_file(entrada.path());
        }
    }
    Ok(())
}
