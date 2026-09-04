//! O dicionário de pronúncia: as palavras que a máquina lê errado e como elas
//! deveriam soar.
//!
//! O espeak-ng lê português. Sigla e nome estrangeiro no meio da frase ele lê
//! como se fossem português também — `UX` sai "uks". O conserto é dizer o som
//! com as letras que o produzem: `UX = "iu-ex"`. A troca acontece no texto,
//! antes de qualquer fonema existir, e o resto do caminho não muda.
//!
//! Quem quiser precisão em vez de aproximação escreve os fonemas prontos
//! entre barras — `Claude = "/klˈod/"`. Esse pedaço atravessa inteiro, sem o
//! espeak-ng opinar sobre ele.

use std::collections::BTreeMap;

/// Um pedaço de texto a caminho do fonemizador.
#[derive(Debug, Clone, PartialEq)]
pub enum Trecho {
    /// Ainda é texto: vai ao espeak-ng como sempre foi.
    Texto(String),
    /// Já são fonemas, escritos à mão: entram na saída como estão.
    Fonemas(String),
}

/// As correções em vigor, prontas para procurar.
#[derive(Debug, Clone, Default)]
pub struct Dicionario {
    /// A palavra em minúsculas e como falá-la, da mais comprida para a mais
    /// curta: com `UX` e `UX designer` na lista, ganha a que diz mais.
    entradas: Vec<(Vec<char>, String)>,
}

impl Dicionario {
    /// Monta o dicionário como ele está no `config.toml`. Linha sem palavra
    /// ou sem pronúncia é ignorada em vez de atrapalhar.
    pub fn de(mapa: &BTreeMap<String, String>) -> Self {
        let mut entradas: Vec<(Vec<char>, String)> = mapa
            .iter()
            .map(|(palavra, como)| (palavra.trim(), como.trim()))
            .filter(|(palavra, como)| !palavra.is_empty() && !como.is_empty())
            .map(|(palavra, como)| (minusculas(palavra), como.to_string()))
            .collect();
        entradas.sort_by_key(|(palavra, _)| std::cmp::Reverse(palavra.len()));
        Self { entradas }
    }

    pub fn esta_vazio(&self) -> bool {
        self.entradas.is_empty()
    }

    /// Aplica as correções e devolve o texto em pedaços.
    ///
    /// Uma grafia nova entra no lugar da palavra e segue junto com o texto em
    /// volta: a frase continua chegando inteira ao espeak-ng, que é quem
    /// decide o ritmo dela. Só os fonemas escritos à mão abrem um pedaço
    /// separado, porque esses não podem passar pelo espeak-ng.
    pub fn aplicar(&self, texto: &str) -> Vec<Trecho> {
        if self.esta_vazio() {
            return vec![Trecho::Texto(texto.to_string())];
        }

        let letras: Vec<char> = texto.chars().collect();
        let baixas: Vec<char> = letras.iter().map(|c| minuscula(*c)).collect();

        let mut partes = Vec::new();
        let mut acumulado = String::new();
        let mut i = 0;
        while i < letras.len() {
            match self.casar(&baixas, i) {
                Some((fim, como)) => {
                    match fonemas_a_mao(como) {
                        Some(prontos) => {
                            if !acumulado.is_empty() {
                                partes.push(Trecho::Texto(std::mem::take(&mut acumulado)));
                            }
                            partes.push(Trecho::Fonemas(prontos.to_string()));
                        }
                        None => acumulado.push_str(como),
                    }
                    i = fim;
                }
                None => {
                    acumulado.push(letras[i]);
                    i += 1;
                }
            }
        }
        if !acumulado.is_empty() {
            partes.push(Trecho::Texto(acumulado));
        }
        partes
    }

    /// A entrada que casa nesta posição, se alguma.
    ///
    /// A palavra tem que estar inteira: `UX` não pode disparar dentro de
    /// `luxo`. Fora isso a comparação é frouxa de propósito — quem escreveu
    /// `UX` na lista não quer digitar `Ux` e `ux` também.
    fn casar(&self, baixas: &[char], i: usize) -> Option<(usize, &str)> {
        if i > 0 && baixas[i - 1].is_alphanumeric() {
            return None;
        }
        self.entradas.iter().find_map(|(palavra, como)| {
            let fim = i + palavra.len();
            let cabe = fim <= baixas.len() && baixas[i..fim] == palavra[..];
            let inteira = cabe && baixas.get(fim).is_none_or(|c| !c.is_alphanumeric());
            inteira.then_some((fim, como.as_str()))
        })
    }
}

/// `"/klˈod/"` -> `"klˈod"`. Sem as barras, é grafia comum e devolve `None`.
fn fonemas_a_mao(como: &str) -> Option<&str> {
    let dentro = como.strip_prefix('/')?.strip_suffix('/')?;
    (!dentro.trim().is_empty()).then_some(dentro)
}

fn minuscula(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn minusculas(s: &str) -> Vec<char> {
    s.chars().map(minuscula).collect()
}

#[cfg(test)]
mod testes {
    use super::*;

    fn dicionario(pares: &[(&str, &str)]) -> Dicionario {
        Dicionario::de(
            &pares
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect(),
        )
    }

    fn texto(dic: &Dicionario, entrada: &str) -> Vec<Trecho> {
        dic.aplicar(entrada)
    }

    #[test]
    fn sem_dicionario_o_texto_atravessa_inteiro() {
        let d = Dicionario::default();
        assert_eq!(texto(&d, "melhorar a UX"), vec![Trecho::Texto("melhorar a UX".into())]);
    }

    #[test]
    fn a_grafia_nova_entra_no_lugar_da_palavra() {
        let d = dicionario(&[("UX", "iu-ex")]);
        assert_eq!(
            texto(&d, "melhorar a UX do app"),
            vec![Trecho::Texto("melhorar a iu-ex do app".into())]
        );
    }

    #[test]
    fn maiuscula_nao_importa() {
        let d = dicionario(&[("UX", "iu-ex")]);
        assert_eq!(texto(&d, "a ux e a Ux"), vec![Trecho::Texto("a iu-ex e a iu-ex".into())]);
    }

    #[test]
    fn a_palavra_tem_que_estar_inteira() {
        let d = dicionario(&[("UX", "iu-ex")]);
        assert_eq!(texto(&d, "luxo e UXO"), vec![Trecho::Texto("luxo e UXO".into())]);
    }

    #[test]
    fn a_pontuacao_em_volta_nao_atrapalha() {
        let d = dicionario(&[("UX", "iu-ex")]);
        assert_eq!(texto(&d, "(UX), UX."), vec![Trecho::Texto("(iu-ex), iu-ex.".into())]);
    }

    #[test]
    fn a_entrada_mais_comprida_ganha() {
        let d = dicionario(&[("UX", "iu-ex"), ("UX designer", "iu-ex dizáiner")]);
        assert_eq!(
            texto(&d, "sou UX designer"),
            vec![Trecho::Texto("sou iu-ex dizáiner".into())]
        );
    }

    #[test]
    fn fonemas_entre_barras_abrem_um_pedaco_proprio() {
        let d = dicionario(&[("Claude", "/klˈod/")]);
        assert_eq!(
            texto(&d, "o Claude falou"),
            vec![
                Trecho::Texto("o ".into()),
                Trecho::Fonemas("klˈod".into()),
                Trecho::Texto(" falou".into()),
            ]
        );
    }

    #[test]
    fn a_palavra_sozinha_vira_so_os_fonemas() {
        let d = dicionario(&[("Claude", "/klˈod/")]);
        assert_eq!(texto(&d, "Claude"), vec![Trecho::Fonemas("klˈod".into())]);
    }

    #[test]
    fn linha_pela_metade_e_ignorada() {
        let d = dicionario(&[("UX", "  "), ("", "iu-ex")]);
        assert!(d.esta_vazio());
    }

    #[test]
    fn uma_barra_sozinha_nao_e_fonema() {
        let d = dicionario(&[("UX", "/")]);
        assert_eq!(texto(&d, "UX"), vec![Trecho::Texto("/".into())]);
    }
}
