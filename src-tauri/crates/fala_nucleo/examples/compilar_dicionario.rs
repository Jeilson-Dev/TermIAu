//! Compila um `*_dict` do espeak-ng a partir do `dictsource` do código-fonte.
//!
//! O `assets/espeak-ng-data` deste repositório é um recorte: só o português
//! caberia, não fosse o espeak trocar de idioma sozinho no meio da frase. Ele
//! faz isso por palavras marcadas com `_^_EN` e `_^_DE` no dicionário do
//! português — e um idioma sem dicionário derruba o processo, porque o
//! `LookupDict2` lê a tabela de hash de um tradutor que nunca foi preenchida.
//!
//! Então os dicionários desses dois idiomas entram no recorte, e este exemplo
//! é como eles foram gerados:
//!
//! ```bash
//! FONTE=$(find target -type d -name dictsource | head -1)
//! cargo run -p fala_nucleo --example compilar_dicionario -- "$FONTE" en de
//! ```
use std::ffi::CString;

fn main() {
    let mut args = std::env::args().skip(1);
    let fonte = args.next().expect("uso: compilar_dicionario <dictsource> <idioma>...");
    let idiomas: Vec<String> = args.collect();
    assert!(!idiomas.is_empty(), "diga ao menos um idioma");

    // O compilador escreve o `.dict` no diretório de dados do espeak, então o
    // espeak precisa estar de pé antes.
    let pai = fala_nucleo::fonemas::preparar_dados().expect("preparar os dados do espeak");
    let caminho = CString::new(pai.to_string_lossy().as_ref()).unwrap();
    let taxa = unsafe {
        espeak_rs_sys::espeak_Initialize(
            espeak_rs_sys::espeak_AUDIO_OUTPUT_AUDIO_OUTPUT_RETRIEVAL,
            0,
            caminho.as_ptr(),
            espeak_rs_sys::espeakINITIALIZE_DONT_EXIT as i32,
        )
    };
    assert!(taxa > 0, "o espeak-ng não iniciou");

    // O `dsource` precisa terminar em barra: o compilador concatena o nome do
    // arquivo direto nele.
    let fonte = if fonte.ends_with('/') { fonte } else { format!("{fonte}/") };
    let dsource = CString::new(fonte).unwrap();

    for idioma in &idiomas {
        let voz = CString::new(idioma.as_str()).unwrap();
        let ok = unsafe { espeak_rs_sys::espeak_SetVoiceByName(voz.as_ptr()) };
        assert_eq!(ok, espeak_rs_sys::espeak_ERROR_EE_OK, "sem a voz {idioma}");

        let nome = CString::new(idioma.as_str()).unwrap();
        let status = unsafe {
            espeak_rs_sys::espeak_ng_CompileDictionary(
                dsource.as_ptr(),
                nome.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(status, 0, "o {idioma}_dict não compilou (status {status})");

        let saida = pai.join("espeak-ng-data").join(format!("{idioma}_dict"));
        let tamanho = std::fs::metadata(&saida).map(|m| m.len()).unwrap_or(0);
        println!("{} — {} KB", saida.display(), tamanho / 1024);
    }
}
