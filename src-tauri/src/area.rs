//! The macOS clipboard, the way a terminal needs it.
//!
//! Plain ⌘V belongs to the system (a menu item, see `montar_menu`) and pastes text.
//! But when the clipboard holds *files* — a ⌘C in Finder — there is no text at
//! all: there is a list of `file://` URLs, one per item. This module reads that
//! list, and ⌘⇧V turns it into paths on the command line.

use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString};
use objc2_foundation::NSURL;
use serde::Serialize;

/// What the clipboard held at the moment of ⌘⇧V.
#[derive(Serialize)]
pub struct Colagem {
    /// POSIX paths, already without the `file://` and the `%20`s.
    arquivos: Vec<String>,
    /// Only set when there are no files — then ⌘⇧V acts as a plain ⌘V,
    /// instead of doing nothing and looking like the key is broken.
    texto: Option<String>,
}

#[tauri::command]
pub fn area_colar() -> Colagem {
    let area = NSPasteboard::generalPasteboard();

    let mut arquivos = Vec::new();
    if let Some(itens) = area.pasteboardItems() {
        for item in itens {
            // One item per file, and file-URL is the type Finder writes.
            // Reading each item, not the whole clipboard, is what makes copying
            // three files return three paths instead of only the first.
            let Some(url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
                continue;
            };
            // `file:///Users/x/a%20folder` -> `/Users/x/a folder`. NSURL undoes
            // the percent-encoding: doing it by hand would get accents wrong,
            // since they arrive decomposed (a "ç" is c + cedilla) and in UTF-8.
            if let Some(caminho) = NSURL::URLWithString(&url).and_then(|u| u.path()) {
                arquivos.push(caminho.to_string());
            }
        }
    }

    let texto = if arquivos.is_empty() {
        area.stringForType(unsafe { NSPasteboardTypeString })
            .map(|s| s.to_string())
    } else {
        None
    };

    Colagem { arquivos, texto }
}
