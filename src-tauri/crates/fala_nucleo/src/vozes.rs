//! O arquivo de vozes do Kokoro.
//!
//! `voices-v1.0.bin` tem cara de binário opaco, mas é um `.npz`: um zip com um
//! `.npy` por voz. Cada voz é uma matriz 510 x 1 x 256 — uma linha de estilo
//! para cada tamanho possível de frase, porque o timbre que o modelo usa
//! depende de quantos fonemas ele vai pronunciar.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

const DIMENSAO: usize = 256;

pub struct Vozes {
    tabelas: HashMap<String, Vec<f32>>,
}

impl Vozes {
    pub fn abrir(caminho: &Path) -> Result<Self> {
        let arquivo = std::fs::File::open(caminho)
            .with_context(|| format!("não consegui abrir {}", caminho.display()))?;
        let mut zip = zip::ZipArchive::new(arquivo)
            .with_context(|| format!("{} não é um arquivo de vozes válido", caminho.display()))?;

        let mut tabelas = HashMap::new();
        for i in 0..zip.len() {
            let mut entrada = zip.by_index(i)?;
            let nome = entrada
                .name()
                .trim_end_matches(".npy")
                .to_string();
            let mut bruto = Vec::new();
            entrada.read_to_end(&mut bruto)?;
            tabelas.insert(nome, ler_npy_f32(&bruto)?);
        }
        Ok(Self { tabelas })
    }

    pub fn nomes(&self) -> Vec<&str> {
        let mut n: Vec<&str> = self.tabelas.keys().map(|s| s.as_str()).collect();
        n.sort_unstable();
        n
    }

    /// O vetor de estilo para uma frase de `n` fonemas, misturando as vozes
    /// pedidas com seus pesos.
    ///
    /// Frases mais longas usam linhas mais adiante da tabela: o modelo foi
    /// treinado assim, com o timbre variando conforme o tamanho do que vai
    /// pronunciar. Passar do fim da tabela é grampeado.
    pub fn estilo(&self, mistura: &[(String, f32)], n: usize) -> Result<Vec<f32>> {
        if mistura.is_empty() {
            bail!("nenhuma voz para misturar");
        }

        let mut acumulado = vec![0.0f32; DIMENSAO];
        for (nome, peso) in mistura {
            let tabela = self
                .tabelas
                .get(nome.as_str())
                .with_context(|| format!("a voz {nome:?} não está no arquivo de vozes"))?;
            let linhas = tabela.len() / DIMENSAO;
            if linhas == 0 {
                bail!("a voz {nome:?} veio vazia");
            }
            let linha = n.clamp(1, linhas) - 1;
            let faixa = &tabela[linha * DIMENSAO..(linha + 1) * DIMENSAO];
            for (destino, valor) in acumulado.iter_mut().zip(faixa) {
                *destino += valor * peso;
            }
        }
        Ok(acumulado)
    }
}

/// Lê um `.npy` de float32. O cabeçalho é texto: um dicionário Python com o
/// tipo, a ordem e o formato.
fn ler_npy_f32(bruto: &[u8]) -> Result<Vec<f32>> {
    if bruto.len() < 10 || &bruto[..6] != b"\x93NUMPY" {
        bail!("não é um arquivo .npy");
    }
    let maior = bruto[6];
    let tamanho_cabecalho = match maior {
        1 => u16::from_le_bytes([bruto[8], bruto[9]]) as usize,
        2..=3 => u32::from_le_bytes([bruto[8], bruto[9], bruto[10], bruto[11]]) as usize,
        outro => bail!("versão {outro} de .npy não suportada"),
    };
    let inicio_cabecalho = if maior == 1 { 10 } else { 12 };
    let fim_cabecalho = inicio_cabecalho + tamanho_cabecalho;

    let cabecalho = std::str::from_utf8(&bruto[inicio_cabecalho..fim_cabecalho])?;
    if !cabecalho.contains("'<f4'") && !cabecalho.contains("\"<f4\"") {
        bail!("esperava float32 little-endian, veio {cabecalho}");
    }
    if cabecalho.contains("'fortran_order': True") {
        bail!("matriz em ordem Fortran não suportada");
    }

    let corpo = &bruto[fim_cabecalho..];
    Ok(corpo
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}
