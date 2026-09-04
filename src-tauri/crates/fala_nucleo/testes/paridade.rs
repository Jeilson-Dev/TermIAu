//! O fonemizador tem que continuar concordando com o `misaki` do Python.
//!
//! As frases e os fonemas esperados em `fixtures/fonemas.txt` foram gerados
//! com `misaki.espeak.EspeakG2P(language="pt-br")`, que é a biblioteca usada
//! no treino do Kokoro. Se este teste quebrar, a fala vai sair com sotaque
//! errado muito antes de alguém notar olhando o código.

const FIXTURES: &str = include_str!("fixtures/fonemas.txt");

#[test]
fn fonemas_batem_com_o_misaki() {
    let mut conferidas = 0;
    for (n, linha) in FIXTURES.lines().enumerate() {
        let linha = linha.trim();
        if linha.is_empty() || linha.starts_with('#') {
            continue;
        }
        let (texto, esperado) = linha.split_once('\t').unwrap_or_else(|| {
            panic!("linha {} da fixture não tem tabulação: {linha:?}", n + 1)
        });

        let obtido = fala_nucleo::fonemas::fonemizar(texto)
            .unwrap_or_else(|e| panic!("não fonemizou {texto:?}: {e:#}"));

        assert_eq!(obtido, esperado, "divergência em {texto:?}");
        conferidas += 1;
    }
    assert!(conferidas >= 20, "esperava ao menos 20 frases, conferi {conferidas}");
}
