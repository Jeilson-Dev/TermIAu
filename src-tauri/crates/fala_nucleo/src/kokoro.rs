//! O modelo em si: fonemas entram, forma de onda sai.

use crate::{vocab, vozes::Vozes};
use anyhow::{bail, Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

pub const TAXA_AMOSTRAGEM: u32 = 24_000;

pub struct Kokoro {
    sessao: Session,
    vozes: Vozes,
    /// O nome que este grafo dá à entrada de fonemas (`input_ids` ou `tokens`,
    /// conforme a exportação). Descoberto do próprio modelo.
    entrada_tokens: String,
}

impl Kokoro {
    /// Carrega o modelo. É a parte cara — uns três segundos e 325 MB de disco
    /// lidos — e é por isso que o app da bandeja existe: para pagar esse preço
    /// uma vez só.
    pub fn carregar(onnx: &Path, vozes: &Path) -> Result<Self> {
        let vozes = Vozes::abrir(vozes)?;
        let sessao = Session::builder()
            .context("não consegui preparar o ONNX Runtime")?
            .commit_from_file(onnx)
            .with_context(|| format!("não consegui carregar o modelo em {}", onnx.display()))?;

        let entrada_tokens = sessao
            .inputs()
            .iter()
            .map(|e| e.name().to_string())
            .find(|n| n != "style" && n != "speed")
            .context("o modelo não tem uma entrada de fonemas reconhecível")?;

        Ok(Self { sessao, vozes, entrada_tokens })
    }

    pub fn vozes_disponiveis(&self) -> Vec<&str> {
        self.vozes.nomes()
    }

    /// Fonemas -> amostras de áudio em 24 kHz, mono.
    ///
    /// Frases compridas passam pelo modelo em lotes. Cada lote sai com
    /// silêncio nas pontas; ele é aparado e trocado pela pausa que a
    /// pontuação pede, senão a emenda soa como um soluço.
    pub fn sintetizar(&mut self, fonemas: &str, mistura: &[(String, f32)], velocidade: f32) -> Result<Vec<f32>> {
        let mut audio = Vec::new();
        for lote in vocab::lotes(fonemas)? {
            let bruto = self.uma_passada(&lote.fonemas, mistura, velocidade)?;
            if bruto.is_empty() {
                continue;
            }
            let (inicio, fim) = crate::audio::aparar(&bruto);
            audio.extend_from_slice(&bruto[inicio..fim]);
            if lote.pausa > 0.0 {
                audio.extend(crate::audio::silencio(lote.pausa, TAXA_AMOSTRAGEM));
            }
        }
        if audio.is_empty() {
            bail!("o modelo não produziu áudio para {fonemas:?}");
        }
        Ok(audio)
    }

    fn uma_passada(&mut self, fonemas: &str, mistura: &[(String, f32)], velocidade: f32) -> Result<Vec<f32>> {
        let tokens = vocab::tokenizar(fonemas);
        if tokens.is_empty() {
            return Ok(Vec::new());
        }

        // O estilo depende do tamanho da frase; o modelo foi treinado assim.
        let estilo = self.vozes.estilo(mistura, tokens.len())?;

        // O 0 na frente e atrás é o silêncio que delimita a fala.
        let mut ids = Vec::with_capacity(tokens.len() + 2);
        ids.push(0i64);
        ids.extend_from_slice(&tokens);
        ids.push(0i64);

        if std::env::var("FALA_DEPURAR").is_ok() {
            eprintln!("[depurar] fonemas={fonemas:?}");
            eprintln!("[depurar] tokens({})={:?}", tokens.len(), tokens);
            eprintln!("[depurar] estilo[..6]={:?}", &estilo[..6]);
            eprintln!("[depurar] entrada_tokens={}", self.entrada_tokens);
        }
        let t_ids = Tensor::from_array((vec![1i64, ids.len() as i64], ids))?;
        let t_estilo = Tensor::from_array((vec![1i64, estilo.len() as i64], estilo))?;
        let t_velocidade = Tensor::from_array((vec![1i64], vec![velocidade]))?;

        let saidas = self.sessao.run(ort::inputs![
            self.entrada_tokens.as_str() => t_ids,
            "style" => t_estilo,
            "speed" => t_velocidade,
        ])?;

        let (_, amostras) = saidas[0].try_extract_tensor::<f32>()?;
        Ok(amostras.to_vec())
    }
}
