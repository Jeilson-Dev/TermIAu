//! The engine's language: the plugin says which at start (`{"cmd":"language"}`).

use std::sync::atomic::{AtomicBool, Ordering};

static PORTUGUESE: AtomicBool = AtomicBool::new(false);

pub fn set(language: &str) {
    PORTUGUESE.store(language == "pt", Ordering::Relaxed);
}

pub fn tr(pt: &'static str, en: &'static str) -> &'static str {
    if PORTUGUESE.load(Ordering::Relaxed) { pt } else { en }
}
