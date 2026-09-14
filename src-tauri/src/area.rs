//! A área de transferência do macOS, do jeito que um terminal precisa dela.
//!
//! O ⌘V comum é do sistema (um item de menu, ver `montar_menu`) e cola texto.
//! Mas quando o que está na área é *arquivo* — um ⌘C no Finder — não há texto
//! nenhum: o que há é uma lista de URLs `file://`, uma por item. Quem lê essa
//! lista é este módulo, e é ela que o ⌘⇧V vira caminho na linha de comando.

use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString};
use objc2_foundation::NSURL;
use serde::Serialize;

/// O que havia na área no momento do ⌘⇧V.
#[derive(Serialize)]
pub struct Colagem {
    /// Caminhos POSIX, já sem o `file://` e sem os `%20`.
    arquivos: Vec<String>,
    /// Só vem quando não há arquivo nenhum — aí o ⌘⇧V age como um ⌘V comum,
    /// em vez de não fazer nada e parecer que a tecla não funciona.
    texto: Option<String>,
}

#[tauri::command]
pub fn area_colar() -> Colagem {
    let area = NSPasteboard::generalPasteboard();

    let mut arquivos = Vec::new();
    if let Some(itens) = area.pasteboardItems() {
        for item in itens {
            // Um item por arquivo, e o tipo file-URL é o que o Finder escreve.
            // Ler o item, e não a área inteira, é o que faz copiar três
            // arquivos devolver três caminhos em vez de só o primeiro.
            let Some(url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
                continue;
            };
            // `file:///Users/x/uma%20pasta` -> `/Users/x/uma pasta`. Quem desfaz
            // o percent-encoding é o NSURL: fazendo na mão erraríamos nos
            // acentos, que chegam decompostos (o "ç" é c + cedilha) e em UTF-8.
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
