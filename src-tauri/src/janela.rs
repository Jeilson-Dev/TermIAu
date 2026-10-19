//! Where the window was and what size it had, between runs. Kept as the NSWindow's
//! own frame, in AppKit's global coordinates (points, origin at the bottom left of the
//! main screen): read with `frame`, put back with `setFrame:display:` — position and size
//! in a single synchronous step. Tauri's `set_position` and `set_size` are queued to run
//! later, one after the other, and don't do.
//!
//! The order matters: the window shows first, fully transparent, then gets its frame, and
//! only then becomes opaque. A hidden window belongs to the screen it was created on, the
//! main one, and macOS fits it to that screen as it comes on screen: a frame given while
//! still hidden, on the screen above, came back filling the MacBook instead.
//!
//! It is only restored when its title bar still falls on a connected screen: closed on
//! a secondary screen that is gone now, the window starts as it always did.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// A rectangle in AppKit's global coordinates: `y` is the bottom edge, growing upward.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Quadro {
    pub x: f64,
    pub y: f64,
    pub largura: f64,
    pub altura: f64,
}

/// What goes to disk. The `quadro` key is what tells it apart from the first version's
/// file (other coordinates), which no longer parses and is ignored.
#[derive(Serialize, Deserialize)]
struct Salvo {
    quadro: Quadro,
}

/// The last frame seen while the window was neither in full screen nor minimized:
/// what gets written on quit.
#[derive(Default)]
pub struct Ultima(Mutex<Option<Quadro>>);

/// The band of the title bar that must be on a screen to grab the window with the mouse.
const BARRA: f64 = 28.0;
/// How much of that band, in width, must be visible.
const VISIVEL: f64 = 100.0;
const MINIMO: (f64, f64) = (400.0, 300.0);

/// The saved frame, if it still fits a connected screen. `telas` are the screens'
/// visible frames (without the menu bar and the Dock). The title bar has to be on one of
/// them, and the size can't exceed it. None means "start as usual".
pub fn valida(q: Quadro, telas: &[Quadro]) -> Option<Quadro> {
    if !(q.x.is_finite() && q.y.is_finite() && q.largura >= MINIMO.0 && q.altura >= MINIMO.1) {
        return None;
    }
    let topo = q.y + q.altura;
    let tela = telas.iter().find(|t| {
        let largura = (q.x + q.largura).min(t.x + t.largura) - q.x.max(t.x);
        topo <= t.y + t.altura + 1.0 && topo - BARRA >= t.y && largura >= VISIVEL.min(q.largura)
    })?;
    let largura = q.largura.min(tela.largura);
    let altura = q.altura.min(tela.altura);
    // Shrunk, it keeps its top edge where it was: that is where the title bar is.
    Some(Quadro { x: q.x, y: topo - altura, largura, altura })
}

fn arquivo<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("janela.json"))
}

#[cfg(target_os = "macos")]
mod nativo {
    use super::Quadro;
    use objc2_app_kit::{NSScreen, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    /// The NSWindow behind Tauri's window. Only on the main thread, the only one where
    /// AppKit may be touched.
    fn janela(ptr: *mut std::ffi::c_void) -> Option<&'static NSWindow> {
        MainThreadMarker::new()?;
        // SAFETY: Tauri hands out the NSWindow it owns, alive while the window is.
        (!ptr.is_null()).then(|| unsafe { &*(ptr as *const NSWindow) })
    }

    pub fn ler(ptr: *mut std::ffi::c_void) -> Option<Quadro> {
        let w = janela(ptr)?;
        if w.styleMask().contains(NSWindowStyleMask::FullScreen) || w.isMiniaturized() || !w.isVisible() {
            return None;
        }
        let f = w.frame();
        Some(Quadro { x: f.origin.x, y: f.origin.y, largura: f.size.width, altura: f.size.height })
    }

    pub fn telas() -> Vec<Quadro> {
        let Some(mtm) = MainThreadMarker::new() else { return vec![] };
        NSScreen::screens(mtm)
            .iter()
            .map(|s| {
                let f = s.visibleFrame();
                Quadro { x: f.origin.x, y: f.origin.y, largura: f.size.width, altura: f.size.height }
            })
            .collect()
    }

    pub fn aplicar(ptr: *mut std::ffi::c_void, q: Quadro) {
        let Some(w) = janela(ptr) else { return };
        let r = NSRect::new(NSPoint::new(q.x, q.y), NSSize::new(q.largura, q.altura));
        w.setFrame_display(r, true);
    }

    pub fn opacidade(ptr: *mut std::ffi::c_void, alfa: f64) {
        if let Some(w) = janela(ptr) {
            w.setAlphaValue(alfa);
        }
    }
}

/// At launch: shows the window where it was, if that place still exists — or where it
/// always started, if not. It is born hidden (tauri.conf.json) and this is what shows it.
pub fn mostrar<R: Runtime>(janela: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let salvo = arquivo(janela.app_handle())
            .and_then(|a| std::fs::read_to_string(a).ok())
            .and_then(|t| serde_json::from_str::<Salvo>(&t).ok());
        let quadro = salvo.and_then(|s| valida(s.quadro, &nativo::telas()));
        if let (Some(q), Ok(ptr)) = (quadro, janela.ns_window()) {
            // On screen but invisible, so that macOS has already placed it where it wanted
            // when it gets its frame — and the jump there isn't seen.
            nativo::opacidade(ptr, 0.0);
            let _ = janela.show();
            nativo::aplicar(ptr, q);
            nativo::opacidade(ptr, 1.0);
            *janela.state::<Ultima>().0.lock().unwrap() = Some(q);
            return;
        }
    }
    let _ = janela.show();
}

/// On every move and resize: remembers the frame, in memory. Full screen, minimized and
/// still hidden don't count — what comes back is the window as you last arranged it.
pub fn anotar<R: Runtime>(janela: &tauri::Window<R>) {
    #[cfg(target_os = "macos")]
    if let Some(q) = janela.ns_window().ok().and_then(nativo::ler) {
        *janela.state::<Ultima>().0.lock().unwrap() = Some(q);
    }
}

/// On quit: the last frame goes to disk.
pub fn gravar<R: Runtime>(app: &AppHandle<R>) {
    let Some(quadro) = *app.state::<Ultima>().0.lock().unwrap() else { return };
    let Some(a) = arquivo(app) else { return };
    if let Some(pasta) = a.parent() {
        let _ = std::fs::create_dir_all(pasta);
    }
    if let Ok(t) = serde_json::to_string(&Salvo { quadro }) {
        let _ = std::fs::write(a, t);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn q(x: f64, y: f64, largura: f64, altura: f64) -> Quadro {
        Quadro { x, y, largura, altura }
    }

    // The MacBook's screen, the menu bar on top; and a 1080p above it, 34 points to the
    // left — this machine's layout.
    const PRINCIPAL: Quadro = Quadro { x: 0.0, y: 0.0, largura: 1440.0, altura: 875.0 };
    const ACIMA: Quadro = Quadro { x: -34.0, y: 900.0, largura: 1920.0, altura: 1050.0 };

    #[test]
    fn volta_onde_estava() {
        let salva = q(200.0, 100.0, 1100.0, 700.0);
        assert_eq!(valida(salva, &[PRINCIPAL]), Some(salva));
        // Filling the screen above, exactly its visible area.
        assert_eq!(valida(ACIMA, &[PRINCIPAL, ACIMA]), Some(ACIMA));
    }

    #[test]
    fn tela_que_sumiu_comeca_do_zero() {
        assert_eq!(valida(ACIMA, &[PRINCIPAL]), None);
        assert_eq!(valida(q(200.0, 100.0, 1100.0, 700.0), &[]), None);
    }

    #[test]
    fn barra_de_titulo_precisa_estar_alcancavel() {
        // Top under the menu bar, or only a sliver of it at the right edge.
        assert_eq!(valida(q(200.0, 300.0, 1100.0, 700.0), &[PRINCIPAL]), None);
        assert_eq!(valida(q(1380.0, 100.0, 1100.0, 700.0), &[PRINCIPAL]), None);
        // Mostly off to the side, but with enough of the bar visible, it stays.
        assert!(valida(q(-900.0, 100.0, 1100.0, 700.0), &[PRINCIPAL]).is_some());
    }

    #[test]
    fn maior_que_a_tela_encolhe_mantendo_o_topo() {
        let v = valida(q(0.0, -500.0, 2400.0, 1375.0), &[PRINCIPAL]).unwrap();
        assert_eq!(v, q(0.0, 0.0, 1440.0, 875.0));
    }

    #[test]
    fn lixo_no_arquivo_e_ignorado() {
        assert_eq!(valida(q(f64::NAN, 0.0, 1000.0, 600.0), &[PRINCIPAL]), None);
        assert_eq!(valida(q(0.0, 30.0, 10.0, 10.0), &[PRINCIPAL]), None);
        assert!(serde_json::from_str::<Salvo>(r#"{"x":-34.0,"y":-1050.0,"largura":1920.0,"altura":1050.0}"#).is_err());
    }
}
