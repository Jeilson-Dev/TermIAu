//! Baixar os pesos do Kokoro.
//!
//! São 353 MB que não cabem confortavelmente dentro do aplicativo, então eles
//! vêm da internet uma vez e ficam no diretório de dados. Depois disso o app
//! nunca mais precisa de rede.

use crate::caminhos;
use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::path::Path;

const URL_MODELO: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
const URL_VOZES: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

/// Tamanhos aproximados, só para a barra de progresso ter o que mostrar
/// enquanto o servidor não informa o tamanho real.
const TAMANHO_MODELO: u64 = 325_532_387;
const TAMANHO_VOZES: u64 = 28_214_398;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peca {
    Modelo,
    Vozes,
}

impl Peca {
    pub fn rotulo(self) -> &'static str {
        match self {
            Peca::Modelo => "modelo de voz",
            Peca::Vozes => "vozes",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Progresso {
    pub peca: Peca,
    pub baixado: u64,
    pub total: u64,
}

impl Progresso {
    pub fn fracao(&self) -> f32 {
        if self.total == 0 {
            0.0
        } else {
            (self.baixado as f32 / self.total as f32).clamp(0.0, 1.0)
        }
    }
}

/// Os dois arquivos já estão no disco?
pub fn pronto() -> bool {
    matches!(
        (caminhos::modelo_onnx(), caminhos::arquivo_vozes()),
        (Ok(m), Ok(v)) if m.is_file() && v.is_file()
    )
}

/// Baixa o que estiver faltando, avisando o progresso. Já ter um dos arquivos
/// não é problema: ele é pulado.
pub fn baixar(mut aviso: impl FnMut(Progresso)) -> Result<()> {
    let modelo = caminhos::modelo_onnx()?;
    if !modelo.is_file() {
        buscar(URL_MODELO, &modelo, Peca::Modelo, TAMANHO_MODELO, &mut aviso)?;
    }
    let vozes = caminhos::arquivo_vozes()?;
    if !vozes.is_file() {
        buscar(URL_VOZES, &vozes, Peca::Vozes, TAMANHO_VOZES, &mut aviso)?;
    }
    Ok(())
}

fn buscar(
    url: &str,
    destino: &Path,
    peca: Peca,
    tamanho_esperado: u64,
    aviso: &mut impl FnMut(Progresso),
) -> Result<()> {
    let resposta = ureq::get(url)
        .call()
        .with_context(|| format!("não consegui baixar o {} de {url}", peca.rotulo()))?;

    let total = resposta
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(tamanho_esperado);

    // Escreve num arquivo parcial e só renomeia no fim: um download
    // interrompido não deixa para trás um modelo pela metade que o app
    // tentaria carregar depois.
    let parcial = destino.with_extension("parcial");
    let mut arquivo = std::fs::File::create(&parcial)
        .with_context(|| format!("não consegui escrever em {}", parcial.display()))?;

    let mut leitor = resposta.into_reader();
    let mut buffer = vec![0u8; 1 << 20];
    let mut baixado = 0u64;

    loop {
        let lidos = leitor.read(&mut buffer)?;
        if lidos == 0 {
            break;
        }
        arquivo.write_all(&buffer[..lidos])?;
        baixado += lidos as u64;
        aviso(Progresso { peca, baixado, total });
    }
    arquivo.flush()?;
    drop(arquivo);

    if baixado == 0 {
        let _ = std::fs::remove_file(&parcial);
        bail!("o download do {} veio vazio", peca.rotulo());
    }

    std::fs::rename(&parcial, destino)?;
    aviso(Progresso { peca, baixado, total: baixado });
    Ok(())
}

/// Apaga os pesos. Serve para o botão de "baixar de novo" quando o arquivo
/// chega corrompido.
pub fn apagar() -> Result<()> {
    for caminho in [caminhos::modelo_onnx()?, caminhos::arquivo_vozes()?] {
        if caminho.is_file() {
            std::fs::remove_file(caminho)?;
        }
    }
    Ok(())
}
