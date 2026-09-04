//! Fonemas -> números, e frases -> lotes que cabem no modelo.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::sync::OnceLock;

/// O modelo enxerga no máximo 510 fonemas de cada vez.
pub const MAX_FONEMAS: usize = 510;

/// Pontuação que fecha uma frase, e a que só separa orações. A diferença é
/// quanto silêncio vem depois.
const FIM_DE_FRASE: &str = ".!?…";
const FIM_DE_ORACAO: &str = ",;:";

/// Silêncio inserido entre lotes, em segundos.
pub const PAUSA_FRASE: f32 = 0.25;
pub const PAUSA_ORACAO: f32 = 0.10;

/// O vocabulário do Kokoro v1.0: 114 símbolos, extraídos do `config.json` do
/// `kokoro-onnx`. Fonema fora dessa lista é descartado — foi assim no treino.
const VOCAB_JSON: &str = include_str!("../../../assets/vocab.json");

fn vocab() -> &'static HashMap<char, i64> {
    static V: OnceLock<HashMap<char, i64>> = OnceLock::new();
    V.get_or_init(|| {
        let bruto: HashMap<String, i64> =
            serde_json::from_str(VOCAB_JSON).expect("vocab.json embutido é inválido");
        bruto
            .into_iter()
            .filter_map(|(k, v)| k.chars().next().map(|c| (c, v)))
            .collect()
    })
}

/// Os fonemas que o modelo reconhece, na ordem em que aparecem.
pub fn tokenizar(fonemas: &str) -> Vec<i64> {
    let v = vocab();
    fonemas.chars().filter_map(|c| v.get(&c).copied()).collect()
}

/// Um pedaço de fala e o silêncio que vem depois dele.
#[derive(Debug, Clone, PartialEq)]
pub struct Lote {
    pub fonemas: String,
    pub pausa: f32,
}

/// Divide os fonemas em lotes que cabem no modelo.
///
/// O corte procura o lugar menos destrutivo nesta ordem: fim de frase, fim de
/// oração, entre palavras e — só em último caso, quando uma única palavra é
/// maior que o contexto — no meio. Os lotes saem equilibrados de propósito:
/// um lote curto no fim sairia com ritmo e volume diferentes dos vizinhos.
pub fn lotes(fonemas: &str) -> Result<Vec<Lote>> {
    let normalizado = fonemas.split_whitespace().collect::<Vec<_>>().join(" ");
    let atomos = atomos(&normalizado, MAX_FONEMAS, 0);
    if atomos.is_empty() {
        bail!("não sobrou nenhum fonema para sintetizar");
    }

    let tamanhos: Vec<usize> = atomos.iter().map(|a| a.chars().count()).collect();
    let menos_lotes = empacotar(&tamanhos, MAX_FONEMAS).len();

    // O menor limite que ainda não custa um lote a mais: é o que equilibra.
    let mut baixo = *tamanhos.iter().max().unwrap_or(&MAX_FONEMAS);
    let mut alto = MAX_FONEMAS;
    while baixo < alto {
        let meio = (baixo + alto) / 2;
        if empacotar(&tamanhos, meio).len() <= menos_lotes {
            alto = meio;
        } else {
            baixo = meio + 1;
        }
    }

    let grupos = empacotar(&tamanhos, baixo);
    let ultimo = grupos.len().saturating_sub(1);
    Ok(grupos
        .into_iter()
        .enumerate()
        .map(|(i, (inicio, fim))| {
            let texto = atomos[inicio..fim].join(" ");
            let pausa = if i == ultimo { 0.0 } else { pausa_depois(&texto) };
            Lote { fonemas: texto, pausa }
        })
        .collect())
}

/// Quanto silêncio um lote que termina assim pede.
fn pausa_depois(fonemas: &str) -> f32 {
    match fonemas.trim_end().chars().last() {
        Some(c) if FIM_DE_FRASE.contains(c) => PAUSA_FRASE,
        Some(c) if FIM_DE_ORACAO.contains(c) => PAUSA_ORACAO,
        _ => 0.0,
    }
}

/// Quebra o texto em pedaços dentro do limite, descendo de fronteira em
/// fronteira só quando a de cima não resolveu.
fn atomos(fonemas: &str, limite: usize, nivel: usize) -> Vec<String> {
    if fonemas.chars().count() <= limite {
        return if fonemas.is_empty() { Vec::new() } else { vec![fonemas.to_string()] };
    }

    for n in nivel..3 {
        let pedacos = quebrar(fonemas, n);
        if pedacos.len() > 1 {
            return pedacos
                .iter()
                .flat_map(|p| atomos(p.trim(), limite, n + 1))
                .collect();
        }
    }

    // Uma palavra sozinha maior que o contexto. Fatiar é feio, perder é pior.
    fonemas
        .chars()
        .collect::<Vec<_>>()
        .chunks(limite)
        .map(|c| c.iter().collect())
        .collect()
}

/// Nível 0 corta depois de fim de frase, 1 depois de fim de oração, 2 em
/// qualquer espaço. A pontuação fica com o texto que veio antes dela, que é
/// como o modelo foi treinado.
fn quebrar(fonemas: &str, nivel: usize) -> Vec<String> {
    let letras: Vec<char> = fonemas.chars().collect();
    let marca = |c: char| match nivel {
        0 => FIM_DE_FRASE.contains(c),
        1 => FIM_DE_ORACAO.contains(c),
        _ => true,
    };

    let mut pedacos = Vec::new();
    let mut atual = String::new();
    let mut i = 0;
    while i < letras.len() {
        let c = letras[i];
        if c.is_whitespace() && (nivel == 2 || atual.chars().last().is_some_and(marca)) {
            while i < letras.len() && letras[i].is_whitespace() {
                i += 1;
            }
            pedacos.push(std::mem::take(&mut atual));
            continue;
        }
        atual.push(c);
        i += 1;
    }
    if !atual.is_empty() {
        pedacos.push(atual);
    }
    pedacos
}

/// Agrupa pedaços consecutivos em lotes dentro do limite, como faixas de
/// índices. O `+ 1` é o espaço que volta na hora de juntar.
fn empacotar(tamanhos: &[usize], limite: usize) -> Vec<(usize, usize)> {
    let mut lotes = Vec::new();
    let (mut inicio, mut tamanho) = (0usize, 0usize);

    for (i, &n) in tamanhos.iter().enumerate() {
        let candidato = if i == inicio { n } else { tamanho + 1 + n };
        if candidato > limite && i > inicio {
            lotes.push((inicio, i));
            inicio = i;
            tamanho = n;
        } else {
            tamanho = candidato;
        }
    }
    if !tamanhos.is_empty() {
        lotes.push((inicio, tamanhos.len()));
    }
    lotes
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn frase_curta_vira_um_lote_sem_pausa() {
        let l = lotes("tˈɛsʧy").unwrap();
        assert_eq!(l, vec![Lote { fonemas: "tˈɛsʧy".into(), pausa: 0.0 }]);
    }

    #[test]
    fn frase_longa_quebra_no_ponto_final() {
        let uma = format!("{} ", "ba".repeat(140)); // 280 fonemas + espaço
        let texto = format!("{uma}. {uma}.");
        let l = lotes(&texto).unwrap();
        assert!(l.len() >= 2, "esperava mais de um lote, veio {}", l.len());
        assert_eq!(l[0].pausa, PAUSA_FRASE);
        assert_eq!(l.last().unwrap().pausa, 0.0);
        assert!(l.iter().all(|x| x.fonemas.chars().count() <= MAX_FONEMAS));
    }

    #[test]
    fn tokeniza_ignorando_o_que_o_modelo_nao_conhece() {
        assert_eq!(tokenizar("tˈɛsʧy"), vec![62, 156, 86, 61, 133, 67]);
        assert_eq!(tokenizar("t\u{1F600}"), vec![62]);
    }
}
