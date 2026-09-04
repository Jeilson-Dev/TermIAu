//! Texto em português -> fonemas que o Kokoro entende.
//!
//! O Kokoro não fonemiza português sozinho: quem faz isso é o espeak-ng, e o
//! modelo espera exatamente a convenção do `misaki` (a biblioteca usada no
//! treino). Este módulo reproduz esse caminho em Rust — o espeak-ng vai
//! compilado dentro do binário, sem Python e sem instalar nada no sistema.
//!
//! A saída é idêntica, caractere por caractere, à do
//! `misaki.espeak.EspeakG2P(language="pt-br")`; `testes/paridade.rs` mantém
//! essa promessa honesta.

use crate::pronuncia::{Dicionario, Trecho};
use anyhow::{bail, Context, Result};
use include_dir::{include_dir, Dir};
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// O recorte pt-br do espeak-ng-data: tabelas de fonemas, entonação e o
/// dicionário do português. ~740 KB, contra 19 MB do pacote completo.
static DADOS_ESPEAK: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../assets/espeak-ng-data");

/// Muda quando o conteúdo de `assets/espeak-ng-data` mudar, para reescrever o
/// que já foi extraído em vez de confiar em arquivos velhos.
const VERSAO_DADOS: &str = "2";

const IPA: u32 = 0x02;
const TIE: u32 = 0x80;

/// A pontuação que o `phonemizer` preserva (`_DEFAULT_MARKS`). Ela não vira
/// som, mas o Kokoro usa para respirar: sem ela a fala sai atropelada.
const PONTUACAO: &str = ";:,.!?¡¿—…\"«»\u{201c}\u{201d}(){}[]";

/// A tabela de substituição do `misaki`, na ordem do `sorted()` do Python.
/// São ditongos e africadas que o modelo aprendeu como um símbolo só.
const E2M: &[(&str, &str)] = &[
    ("a^ɪ", "I"),
    ("a^ʊ", "W"),
    ("d^z", "ʣ"),
    ("d^ʒ", "ʤ"),
    ("e^ɪ", "A"),
    ("o^ʊ", "O"),
    ("s^s", "S"),
    ("t^s", "ʦ"),
    ("t^ʃ", "ʧ"),
    ("ɔ^ɪ", "Y"),
    ("ə^ʊ", "Q"),
];

/// O espeak-ng guarda estado global no processo: duas fonemizações ao mesmo
/// tempo devolvem lixo, e dois inícios ao mesmo tempo derrubam o processo.
/// Este cadeado serializa as duas coisas; o que ele guarda é se o início já
/// foi feito.
static ESPEAK: Mutex<bool> = Mutex::new(false);

/// Grava o espeak-ng-data no disco (só na primeira vez) e devolve o diretório
/// que o contém, que é o que o `espeak_Initialize` espera receber.
pub fn preparar_dados() -> Result<PathBuf> {
    let pai = crate::caminhos::dados()?;
    let destino = pai.join("espeak-ng-data");
    let marca = destino.join(".versao");

    if std::fs::read_to_string(&marca).ok().as_deref() == Some(VERSAO_DADOS) {
        return Ok(pai);
    }

    extrair(&DADOS_ESPEAK, &destino)?;
    std::fs::write(&marca, VERSAO_DADOS)?;
    Ok(pai)
}

fn extrair(dir: &Dir<'_>, destino: &Path) -> Result<()> {
    std::fs::create_dir_all(destino)?;
    for arquivo in dir.files() {
        let nome = arquivo.path().file_name().context("arquivo sem nome")?;
        std::fs::write(destino.join(nome), arquivo.contents())?;
    }
    for sub in dir.dirs() {
        let nome = sub.path().file_name().context("diretório sem nome")?;
        extrair(sub, &destino.join(nome))?;
    }
    Ok(())
}

/// Acorda o espeak-ng, uma vez por processo. Quem chama já tem o cadeado na
/// mão — iniciar duas vezes ao mesmo tempo é falha de memória, não engano.
fn iniciar() -> Result<()> {
    let pai = preparar_dados()?;
    let caminho = CString::new(pai.to_string_lossy().as_ref())?;
    let taxa = unsafe {
        espeak_rs_sys::espeak_Initialize(
            espeak_rs_sys::espeak_AUDIO_OUTPUT_AUDIO_OUTPUT_RETRIEVAL,
            0,
            caminho.as_ptr(),
            espeak_rs_sys::espeakINITIALIZE_DONT_EXIT as i32,
        )
    };
    if taxa <= 0 {
        bail!("o espeak-ng não iniciou (código {taxa}); dados em {}", pai.display());
    }
    let voz = CString::new("pt-br")?;
    let ok = unsafe { espeak_rs_sys::espeak_SetVoiceByName(voz.as_ptr()) };
    if ok != espeak_rs_sys::espeak_ERROR_EE_OK {
        bail!("o espeak-ng não tem a voz pt-br");
    }
    Ok(())
}

/// Texto em português do Brasil -> fonemas do Kokoro.
pub fn fonemizar(texto: &str) -> Result<String> {
    fonemizar_com(texto, &Dicionario::default())
}

/// O mesmo, com o dicionário de pronúncia por cima.
///
/// As palavras corrigidas são acertadas antes de o espeak-ng ver o texto: as
/// que ganharam outra grafia seguem no meio da frase, e as que vieram com
/// fonemas escritos à mão entram na saída sem passar por ele.
pub fn fonemizar_com(texto: &str, dicionario: &Dicionario) -> Result<String> {
    // Uma thread que entrou em pânico no meio de uma fala não pode deixar o
    // espeak-ng trancado para sempre: seguimos com o que restou.
    let mut iniciado = ESPEAK.lock().unwrap_or_else(|e| e.into_inner());
    if !*iniciado {
        iniciar()?;
        *iniciado = true;
    }

    let mut fonemas = String::new();
    for trecho in dicionario.aplicar(texto) {
        match trecho {
            Trecho::Fonemas(prontos) => fonemas.push_str(&prontos),
            Trecho::Texto(texto) => fonemas.push_str(&de_texto(&texto)?),
        }
    }
    Ok(fonemas.trim().to_string())
}

/// Um pedaço de texto corrido, do jeito que sempre foi feito.
fn de_texto(texto: &str) -> Result<String> {
    // Cada trecho é aparado no caminho, mas o espaço das pontas é o que separa
    // esta palavra dos fonemas do vizinho: sem ele, "o Claude" viraria uma
    // palavra só.
    let espaco_antes = texto.starts_with(char::is_whitespace);
    let espaco_depois = texto.ends_with(char::is_whitespace);

    // O `misaki` troca os parênteses por aspas angulares antes de fonemizar,
    // e desfaz a troca no fim. Reproduzimos o desvio para casar com o treino.
    let texto = texto.replace('«', "\u{201c}").replace('»', "\u{201d}");
    let texto = texto.replace('(', "«").replace(')', "»");

    let mut fonemas = String::new();
    for (trecho, e_pontuacao) in fatiar_pontuacao(&texto) {
        if e_pontuacao {
            fonemas.push_str(&trecho);
        } else if !trecho.trim().is_empty() {
            fonemas.push_str(espeak(trecho.trim())?.trim());
        }
    }

    let mut fonemas = fonemas.trim().to_string();
    for (de, para) in E2M {
        fonemas = fonemas.replace(de, para);
    }
    fonemas = fonemas.replace('^', "").replace('-', "");
    let fonemas = fonemas.replace('«', "(").replace('»', ")");

    // Um trecho que era só espaço vira um espaço, não dois.
    if fonemas.is_empty() {
        return Ok(if espaco_antes || espaco_depois { " ".into() } else { String::new() });
    }

    Ok(format!(
        "{}{fonemas}{}",
        if espaco_antes { " " } else { "" },
        if espaco_depois { " " } else { "" },
    ))
}

/// Uma volta no espeak-ng. Ele devolve uma oração por chamada, avançando um
/// ponteiro pelo texto até zerá-lo.
fn espeak(texto: &str) -> Result<String> {
    let modo = (IPA | TIE | (('^' as u32) << 8)) as i32;
    let texto = CString::new(texto)?;
    let mut ponteiro: *const c_char = texto.as_ptr();
    let mut saida = String::new();

    while !ponteiro.is_null() {
        let resposta = unsafe {
            espeak_rs_sys::espeak_TextToPhonemes(
                &mut ponteiro as *mut *const c_char as *mut *const c_void,
                espeak_rs_sys::espeakCHARS_UTF8 as i32,
                modo,
            )
        };
        if resposta.is_null() {
            continue;
        }
        saida.push_str(&unsafe { CStr::from_ptr(resposta) }.to_string_lossy());
    }
    Ok(sem_marcas_de_idioma(&saida))
}

/// Palavra estrangeira no meio da frase faz o espeak marcar a troca de idioma
/// com `(en)`. O modelo não conhece esse símbolo; fora.
fn sem_marcas_de_idioma(s: &str) -> String {
    let mut saida = String::with_capacity(s.len());
    let mut profundidade = 0usize;
    for c in s.chars() {
        match c {
            '(' => profundidade += 1,
            ')' => profundidade = profundidade.saturating_sub(1),
            _ if profundidade == 0 => saida.push(c),
            _ => {}
        }
    }
    saida
}

/// Separa o texto em trechos falados e blocos de pontuação, como o
/// `Punctuation` do `phonemizer`: um bloco é a maior sequência de pontuação e
/// espaço que contenha ao menos um sinal. O espaço colado no sinal faz parte
/// dele — é o que produz o `", "` no meio dos fonemas.
fn fatiar_pontuacao(texto: &str) -> Vec<(String, bool)> {
    let letras: Vec<char> = texto.chars().collect();
    let n = letras.len();
    let e_sinal = |c: char| PONTUACAO.contains(c);
    let mut e_bloco = vec![false; n];

    let mut i = 0;
    while i < n {
        if e_sinal(letras[i]) || letras[i].is_whitespace() {
            let inicio = i;
            let mut tem_sinal = false;
            while i < n && (e_sinal(letras[i]) || letras[i].is_whitespace()) {
                tem_sinal |= e_sinal(letras[i]);
                i += 1;
            }
            if tem_sinal {
                e_bloco[inicio..i].fill(true);
            }
        } else {
            i += 1;
        }
    }

    let mut partes = Vec::new();
    let mut i = 0;
    while i < n {
        let marca = e_bloco[i];
        let inicio = i;
        while i < n && e_bloco[i] == marca {
            i += 1;
        }
        partes.push((letras[inicio..i].iter().collect::<String>(), marca));
    }
    partes
}

#[cfg(test)]
mod testes {
    use super::*;
    use std::collections::BTreeMap;

    fn dicionario(pares: &[(&str, &str)]) -> Dicionario {
        Dicionario::de(
            &pares
                .iter()
                .map(|(p, c)| (p.to_string(), c.to_string()))
                .collect::<BTreeMap<_, _>>(),
        )
    }

    #[test]
    fn a_palavra_corrigida_sai_pela_grafia_nova() {
        let como_estava = fonemizar("UX").unwrap();
        let corrigida = fonemizar_com("UX", &dicionario(&[("UX", "iu-ex")])).unwrap();
        assert_ne!(corrigida, como_estava);
        assert_eq!(corrigida, fonemizar("iu-ex").unwrap());
    }

    #[test]
    fn os_fonemas_escritos_a_mao_atravessam_inteiros() {
        let saida =
            fonemizar_com("o Claude falou", &dicionario(&[("Claude", "/klˈod/")])).unwrap();
        // Inteiros e separados: sem o espaço, colariam nas palavras vizinhas e
        // virariam outra palavra.
        assert!(saida.contains(" klˈod "), "{saida:?}");
    }

    /// O espeak troca de idioma sozinho no meio da frase: umas poucas palavras
    /// do dicionário do português mandam ler em inglês ou alemão. Um idioma
    /// sem `*_dict` no recorte não falhava com educação — o `LoadDictionary`
    /// desistia deixando a tabela de hash do tradutor recém-alocado como o
    /// `malloc` a entregou, e a primeira busca lia um ponteiro de lixo. Era um
    /// SIGSEGV, e levava o app da bandeja inteiro junto, com fila e tudo.
    ///
    /// Se este teste derrubar o processo em vez de falhar, é isto de volta.
    #[test]
    fn a_troca_de_idioma_nao_derruba_o_processo() {
        for palavra in ["michael", "playstation", "trump", "feuerbach", "ß"] {
            let fonemas = fonemizar(palavra).unwrap();
            assert!(!fonemas.is_empty(), "{palavra:?} não virou fonema nenhum");
        }
        // Depois da troca, o espeak volta a ler acrônimo letra por letra — o
        // caminho exato em que ele caía.
        assert!(!fonemizar("o michael falou de UX no SQL").unwrap().is_empty());
    }

    #[test]
    fn a_frase_sem_palavra_corrigida_fica_como_era() {
        let d = dicionario(&[("UX", "iu-ex")]);
        let texto = "Que a Força esteja com você, sempre.";
        assert_eq!(fonemizar_com(texto, &d).unwrap(), fonemizar(texto).unwrap());
    }
}
