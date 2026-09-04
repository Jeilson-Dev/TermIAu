//! Empacotar as amostras em WAV e tocar.
//!
//! A reprodução sai pelo `afplay` do macOS: é um processo separado, o que
//! deixa a fala interrompível (basta matá-lo) sem prender o app.

use anyhow::{bail, Context, Result};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// WAV mono, 16 bits, na taxa dada. Formato que qualquer coisa toca.
pub fn wav(amostras: &[f32], taxa: u32) -> Vec<u8> {
    let bytes_dados = amostras.len() * 2;
    let mut saida = Vec::with_capacity(44 + bytes_dados);

    saida.extend_from_slice(b"RIFF");
    saida.extend_from_slice(&((36 + bytes_dados) as u32).to_le_bytes());
    saida.extend_from_slice(b"WAVEfmt ");
    saida.extend_from_slice(&16u32.to_le_bytes()); // tamanho do bloco fmt
    saida.extend_from_slice(&1u16.to_le_bytes()); // PCM
    saida.extend_from_slice(&1u16.to_le_bytes()); // mono
    saida.extend_from_slice(&taxa.to_le_bytes());
    saida.extend_from_slice(&(taxa * 2).to_le_bytes()); // bytes por segundo
    saida.extend_from_slice(&2u16.to_le_bytes()); // alinhamento
    saida.extend_from_slice(&16u16.to_le_bytes()); // bits por amostra
    saida.extend_from_slice(b"data");
    saida.extend_from_slice(&(bytes_dados as u32).to_le_bytes());

    for amostra in amostras {
        let v = (amostra.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        saida.extend_from_slice(&v.to_le_bytes());
    }
    saida
}

/// Toca um WAV que já está no disco. Devolve o processo, para quem quiser
/// interromper a fala no meio.
pub fn tocar(arquivo: &Path, volume: u8) -> Result<Child> {
    let ganho = (volume.min(100) as f32 / 100.0).to_string();
    Command::new("afplay")
        .arg("-v")
        .arg(ganho)
        .arg(arquivo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("não consegui chamar o afplay")
}

/// A reserva: a voz sintética do macOS. Pior, instantânea e sempre presente.
/// Ela existe para que uma falha do Kokoro não vire silêncio.
pub fn falar_pelo_macos(texto: &str, voz: &str, volume: u8) -> Result<()> {
    let ganho = (volume.min(100) as f32 / 100.0).clamp(0.0, 1.0);
    let mut filho = Command::new("say")
        .arg("-v")
        .arg(voz)
        .arg("--")
        .arg(format!("[[volm {ganho:.2}]] {texto}"))
        .stdin(Stdio::null())
        .spawn()
        .context("não consegui chamar o `say` do macOS")?;
    let status = filho.wait()?;
    if !status.success() {
        bail!("o `say` terminou com erro ({status})");
    }
    Ok(())
}

/// Grava as amostras em disco como WAV.
pub fn gravar(caminho: &Path, amostras: &[f32], taxa: u32) -> Result<()> {
    let mut arquivo = std::fs::File::create(caminho)
        .with_context(|| format!("não consegui escrever em {}", caminho.display()))?;
    arquivo.write_all(&wav(amostras, taxa))?;
    Ok(())
}

/// Onde a fala começa e termina, ignorando o silêncio das pontas.
///
/// O modelo entrega cada lote embrulhado em silêncio — quase dois segundos no
/// começo. Emendar lotes assim soa como buracos no meio da frase, então o
/// silêncio sai daqui e a pausa certa é recolocada depois, do tamanho que a
/// pontuação pedir.
///
/// É o `librosa.effects.trim` com os padrões que o Kokoro usa: quadros de
/// 2048 amostras a cada 512, e silêncio é tudo 60 dB abaixo do pico.
pub fn aparar(amostras: &[f32]) -> (usize, usize) {
    const QUADRO: usize = 2048;
    const SALTO: usize = 512;
    const TETO_DB: f32 = 60.0;
    const MINIMO: f32 = 1e-10;

    let n = amostras.len();
    if n == 0 {
        return (0, 0);
    }

    // O sinal é analisado com meio quadro de silêncio em volta, para que o
    // primeiro quadro fique centrado na primeira amostra.
    let borda = QUADRO / 2;
    let amostra = |i: usize| -> f32 {
        if i < borda || i >= borda + n {
            0.0
        } else {
            amostras[i - borda]
        }
    };

    let quantos = (n + 1).div_ceil(SALTO);
    let potencias: Vec<f32> = (0..quantos)
        .map(|q| {
            let inicio = q * SALTO;
            let soma: f32 = (0..QUADRO).map(|k| amostra(inicio + k).powi(2)).sum();
            soma / QUADRO as f32
        })
        .collect();

    let pico = potencias.iter().copied().fold(0.0f32, f32::max);
    let referencia_db = 10.0 * pico.max(MINIMO).log10();

    let mut primeiro = None;
    let mut ultimo = 0;
    for (q, potencia) in potencias.iter().enumerate() {
        let db = 10.0 * potencia.max(MINIMO).log10() - referencia_db;
        if db > -TETO_DB {
            primeiro.get_or_insert(q);
            ultimo = q;
        }
    }

    match primeiro {
        Some(p) => (p * SALTO, n.min((ultimo + 1) * SALTO)),
        None => (0, 0),
    }
}

/// `segundos` de silêncio em 24 kHz.
pub fn silencio(segundos: f32, taxa: u32) -> Vec<f32> {
    vec![0.0; (segundos * taxa as f32).max(0.0) as usize]
}
