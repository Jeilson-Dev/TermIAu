//! O idioma do app, o mesmo do `src/i18n/index.ts`: português quando a primeira
//! língua do macOS é português, inglês para todo o resto. O menu nativo é
//! montado aqui no Rust, antes de a webview existir, então a conta é refeita
//! deste lado.

use std::sync::OnceLock;

/// Só a primeira língua da lista decide.
pub fn portugues_de<S: AsRef<str>>(tags: &[S]) -> bool {
    tags.first().is_some_and(|t| t.as_ref().to_lowercase().starts_with("pt"))
}

pub fn portugues() -> bool {
    static P: OnceLock<bool> = OnceLock::new();
    *P.get_or_init(|| portugues_de(&do_sistema()))
}

#[cfg(target_os = "macos")]
fn do_sistema() -> Vec<String> {
    objc2_foundation::NSLocale::preferredLanguages().iter().map(|s| s.to_string()).collect()
}

#[cfg(not(target_os = "macos"))]
fn do_sistema() -> Vec<String> {
    Vec::new()
}

/// O texto no idioma do app.
pub fn tr(pt: &'static str, en: &'static str) -> &'static str {
    if portugues() { pt } else { en }
}

#[cfg(test)]
mod testes {
    use super::portugues_de;

    #[test]
    fn so_a_primeira_lingua_decide() {
        assert!(portugues_de(&["pt-BR", "en-US"]));
        assert!(portugues_de(&["PT-pt"]));
        assert!(!portugues_de(&["en-AU", "pt-BR"]));
        assert!(!portugues_de(&["es-ES"]));
        assert!(!portugues_de::<&str>(&[]));
    }
}
