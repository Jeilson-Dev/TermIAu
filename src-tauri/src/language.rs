//! The app's language, same as `src/i18n/index.ts`: Portuguese when the first
//! macOS language is Portuguese, English for everything else. The native menu
//! is built here in Rust, before the webview exists, so the check is redone
//! on this side.

use std::sync::OnceLock;

/// Only the first language in the list decides.
pub fn portuguese_from<S: AsRef<str>>(tags: &[S]) -> bool {
    tags.first().is_some_and(|t| t.as_ref().to_lowercase().starts_with("pt"))
}

pub fn portuguese() -> bool {
    static PT: OnceLock<bool> = OnceLock::new();
    *PT.get_or_init(|| portuguese_from(&from_system()))
}

#[cfg(target_os = "macos")]
fn from_system() -> Vec<String> {
    objc2_foundation::NSLocale::preferredLanguages().iter().map(|s| s.to_string()).collect()
}

#[cfg(not(target_os = "macos"))]
fn from_system() -> Vec<String> {
    Vec::new()
}

/// The text in the app's language.
pub fn tr(pt: &'static str, en: &'static str) -> &'static str {
    if portuguese() { pt } else { en }
}

#[cfg(test)]
mod tests {
    use super::portuguese_from;

    #[test]
    fn only_the_first_language_decides() {
        assert!(portuguese_from(&["pt-BR", "en-US"]));
        assert!(portuguese_from(&["PT-pt"]));
        assert!(!portuguese_from(&["en-AU", "pt-BR"]));
        assert!(!portuguese_from(&["es-ES"]));
        assert!(!portuguese_from::<&str>(&[]));
    }
}
