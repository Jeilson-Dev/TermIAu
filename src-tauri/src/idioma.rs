//! The app's language, same as `src/i18n/index.ts`: Portuguese when the first
//! macOS language is Portuguese, English for everything else. The native menu
//! is built here in Rust, before the webview exists, so the check is redone
//! on this side.

use std::sync::OnceLock;

/// Only the first language in the list decides.
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

/// The text in the app's language.
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
