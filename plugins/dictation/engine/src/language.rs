//! The app's language, which TermIAu passes in `TERMIAU_LANGUAGE` (`pt` or `en`):
//! the errors this engine reports end up on the footer.

use std::sync::OnceLock;

pub fn portuguese() -> bool {
    static PT: OnceLock<bool> = OnceLock::new();
    *PT.get_or_init(|| std::env::var("TERMIAU_LANGUAGE").is_ok_and(|l| l.starts_with("pt")))
}

/// The text in the app's language.
pub fn tr(pt: &'static str, en: &'static str) -> &'static str {
    if portuguese() { pt } else { en }
}
