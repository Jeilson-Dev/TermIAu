//! O motor do Fala Cláudio: português falado nesta máquina, sem rede e sem
//! conta em lugar nenhum.
//!
//! O caminho é sempre o mesmo:
//!
//! ```text
//! texto -> fonemas (espeak-ng)  ->  Kokoro (ONNX)  ->  WAV  ->  afplay
//! ```
//!
//! O passo caro é carregar o modelo, não sintetizar. Por isso [`Falador`] é
//! feito para nascer uma vez e viver: o app da bandeja o mantém quente e o
//! CLI só empurra texto para lá.

pub mod audio;
pub mod cache;
pub mod caminhos;
pub mod config;
pub mod fonemas;
pub mod kokoro;
pub mod modelo;
pub mod palco;
pub mod pronuncia;
pub mod protocolo;
pub mod vocab;
pub mod vozes;

pub use config::Config;
pub use kokoro::TAXA_AMOSTRAGEM;

use anyhow::Result;
use std::path::PathBuf;
use std::process::Child;

/// Um sintetizador vivo, com o modelo já na memória.
pub struct Falador {
    motor: kokoro::Kokoro,
}

/// Uma fala em andamento.
pub struct Fala {
    /// O WAV que está tocando (no cache ou num temporário).
    pub arquivo: PathBuf,
    /// O `afplay`. Matá-lo cala a fala no meio.
    pub processo: Child,
    /// Se o áudio veio pronto do cache, sem passar pelo modelo.
    pub do_cache: bool,
}

impl Falador {
    /// Carrega o modelo. Custa alguns segundos; faça uma vez.
    pub fn novo() -> Result<Self> {
        let onnx = caminhos::modelo_onnx()?;
        let vozes = caminhos::arquivo_vozes()?;
        Ok(Self { motor: kokoro::Kokoro::carregar(&onnx, &vozes)? })
    }

    pub fn vozes(&self) -> Vec<&str> {
        self.motor.vozes_disponiveis()
    }

    /// Sintetiza e devolve as amostras, sem tocar nada.
    pub fn amostras(&mut self, texto: &str, config: &Config) -> Result<Vec<f32>> {
        let dicionario = pronuncia::Dicionario::de(&config.pronuncia);
        let fonemas = fonemas::fonemizar_com(texto, &dicionario)?;
        self.motor.sintetizar(&fonemas, &config.mistura_efetiva(), config.velocidade)
    }

    /// Sintetiza (ou aproveita o cache) e começa a tocar.
    pub fn falar(&mut self, texto: &str, config: &Config) -> Result<Fala> {
        let texto = preparar(texto, config.max_caracteres);
        let chave = cache::chave(
            &texto,
            &config.assinatura_da_voz(),
            config.velocidade,
            &config.assinatura_da_pronuncia(),
        );

        if config.cache {
            if let Some(arquivo) = cache::buscar(&chave) {
                let processo = audio::tocar(&arquivo, config.volume)?;
                return Ok(Fala { arquivo, processo, do_cache: true });
            }
        }

        let amostras = self.amostras(&texto, config)?;
        let arquivo = if config.cache {
            let destino = cache::caminho(&chave)?;
            audio::gravar(&destino, &amostras, TAXA_AMOSTRAGEM)?;
            let _ = cache::podar();
            destino
        } else {
            let destino = std::env::temp_dir()
                .join(format!("fala-claudio-{}.wav", std::process::id()));
            audio::gravar(&destino, &amostras, TAXA_AMOSTRAGEM)?;
            destino
        };

        let processo = audio::tocar(&arquivo, config.volume)?;
        Ok(Fala { arquivo, processo, do_cache: false })
    }

    /// Sintetiza e grava num arquivo escolhido, sem tocar.
    pub fn gravar_em(&mut self, texto: &str, config: &Config, destino: &std::path::Path) -> Result<()> {
        let texto = preparar(texto, config.max_caracteres);
        let amostras = self.amostras(&texto, config)?;
        audio::gravar(destino, &amostras, TAXA_AMOSTRAGEM)
    }
}

/// Normaliza o texto e aplica o teto de caracteres, cortando no fim de frase
/// mais próximo — nunca no meio de uma palavra.
pub fn preparar(texto: &str, max: usize) -> String {
    let texto = texto.trim();
    if max == 0 || texto.chars().count() <= max {
        return texto.to_string();
    }

    let ate: String = texto.chars().take(max).collect();
    let fim_de_frase = ate.rfind(['.', '!', '?', ';']).map(|i| i + 1);
    let corte = fim_de_frase.or_else(|| ate.rfind(' ')).unwrap_or(ate.len());
    ate[..corte].trim().to_string()
}

/// O começo de um texto: as duas primeiras frases, e nunca mais que um
/// punhado de caracteres.
///
/// Serve para mostrar uma fila de falas sem despejar nela o parágrafo inteiro
/// de cada uma. Duas frases costumam bastar para reconhecer qual aviso é qual,
/// que é tudo o que se quer olhando uma fila.
pub fn duas_frases(texto: &str) -> String {
    const TETO: usize = 140;
    const FIM: [char; 4] = ['.', '!', '?', '…'];

    let texto = texto.split_whitespace().collect::<Vec<_>>().join(" ");

    let mut frases = 0;
    let mut corte = None;
    for (i, c) in texto.char_indices() {
        if FIM.contains(&c) {
            // "1.000" e "etc..." não são fim de frase; o que fecha é o último
            // sinal de uma sequência, seguido de espaço ou do fim do texto.
            let resto = &texto[i + c.len_utf8()..];
            let proximo = resto.chars().next();
            if proximo.is_some_and(|p| !p.is_whitespace() && !FIM.contains(&p)) {
                continue;
            }
            if proximo.is_some_and(|p| FIM.contains(&p)) {
                continue;
            }
            frases += 1;
            if frases == 2 {
                corte = Some(i + c.len_utf8());
                break;
            }
        }
    }

    let ate = corte.map(|i| &texto[..i]).unwrap_or(&texto).trim();
    if ate.chars().count() <= TETO {
        return ate.to_string();
    }

    // Frase comprida demais para caber: corta entre palavras e avisa com as
    // reticências que ficou faltando coisa.
    let curto: String = ate.chars().take(TETO).collect();
    let corte = curto.rfind(' ').unwrap_or(curto.len());
    format!("{}…", curto[..corte].trim_end())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn o_resumo_para_na_segunda_frase() {
        let t = "Primeira frase. Segunda frase. Terceira frase.";
        assert_eq!(duas_frases(t), "Primeira frase. Segunda frase.");
    }

    #[test]
    fn o_resumo_deixa_passar_frase_unica_inteira() {
        assert_eq!(duas_frases("uma frase só, sem ponto"), "uma frase só, sem ponto");
    }

    #[test]
    fn o_resumo_nao_corta_dentro_de_um_numero() {
        let t = "O cache tem 1.024 áudios. Cabe mais. Muito mais.";
        assert_eq!(duas_frases(t), "O cache tem 1.024 áudios. Cabe mais.");
    }

    #[test]
    fn o_resumo_encurta_frase_comprida_entre_palavras() {
        let t = "palavra ".repeat(40);
        let resumo = duas_frases(&t);
        assert!(resumo.ends_with('…'), "{resumo:?}");
        assert!(resumo.chars().count() <= 141, "{resumo:?}");
        assert!(!resumo.contains("palavr…"), "cortou no meio de uma palavra: {resumo:?}");
    }

    #[test]
    fn corta_no_fim_da_frase() {
        let t = "Primeira frase. Segunda frase bem mais comprida que o teto.";
        assert_eq!(preparar(t, 25), "Primeira frase.");
    }

    #[test]
    fn corta_entre_palavras_quando_nao_ha_pontuacao() {
        assert_eq!(preparar("uma frase sem pontuacao alguma", 14), "uma frase sem");
    }

    #[test]
    fn sem_teto_nao_corta() {
        let t = "  texto com espaco em volta  ";
        assert_eq!(preparar(t, 0), "texto com espaco em volta");
    }
}
