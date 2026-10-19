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
pub struct Frame {
    pub x: f64,
    pub y: f64,
    // The aliases read the file written while these fields had Portuguese names.
    #[serde(alias = "largura")]
    pub width: f64,
    #[serde(alias = "altura")]
    pub height: f64,
}

/// What goes to disk. The `frame` key is what tells it apart from the first version's
/// file (other coordinates), which no longer parses and is ignored.
#[derive(Serialize, Deserialize)]
struct Saved {
    #[serde(alias = "quadro")]
    frame: Frame,
}

/// The last frame seen while the window was neither in full screen nor minimized:
/// what gets written on quit.
#[derive(Default)]
pub struct Last(Mutex<Option<Frame>>);

/// The band of the title bar that must be on a screen to grab the window with the mouse.
const TITLE_BAR: f64 = 28.0;
/// How much of that band, in width, must be visible.
const VISIBLE: f64 = 100.0;
const MINIMUM: (f64, f64) = (400.0, 300.0);

/// The saved frame, if it still fits a connected screen. `screens` are the screens'
/// visible frames (without the menu bar and the Dock). The title bar has to be on one of
/// them, and the size can't exceed it. None means "start as usual".
pub fn validate(q: Frame, screens: &[Frame]) -> Option<Frame> {
    if !(q.x.is_finite() && q.y.is_finite() && q.width >= MINIMUM.0 && q.height >= MINIMUM.1) {
        return None;
    }
    let top = q.y + q.height;
    let screen = screens.iter().find(|t| {
        let width = (q.x + q.width).min(t.x + t.width) - q.x.max(t.x);
        top <= t.y + t.height + 1.0 && top - TITLE_BAR >= t.y && width >= VISIBLE.min(q.width)
    })?;
    let width = q.width.min(screen.width);
    let height = q.height.min(screen.height);
    // Shrunk, it keeps its top edge where it was: that is where the title bar is.
    Some(Frame { x: q.x, y: top - height, width, height })
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("window.json"))
}

/// The same file under the name it had before (`janela.json`), read once if the new
/// one doesn't exist yet.
fn legacy_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("janela.json"))
}

#[cfg(target_os = "macos")]
mod native {
    use super::Frame;
    use objc2_app_kit::{NSScreen, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    /// The NSWindow behind Tauri's window. Only on the main thread, the only one where
    /// AppKit may be touched.
    fn window(ptr: *mut std::ffi::c_void) -> Option<&'static NSWindow> {
        MainThreadMarker::new()?;
        // SAFETY: Tauri hands out the NSWindow it owns, alive while the window is.
        (!ptr.is_null()).then(|| unsafe { &*(ptr as *const NSWindow) })
    }

    pub fn read(ptr: *mut std::ffi::c_void) -> Option<Frame> {
        let w = window(ptr)?;
        if w.styleMask().contains(NSWindowStyleMask::FullScreen) || w.isMiniaturized() || !w.isVisible() {
            return None;
        }
        let f = w.frame();
        Some(Frame { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height })
    }

    pub fn screens() -> Vec<Frame> {
        let Some(mtm) = MainThreadMarker::new() else { return vec![] };
        NSScreen::screens(mtm)
            .iter()
            .map(|s| {
                let f = s.visibleFrame();
                Frame { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height }
            })
            .collect()
    }

    pub fn apply(ptr: *mut std::ffi::c_void, q: Frame) {
        let Some(w) = window(ptr) else { return };
        let r = NSRect::new(NSPoint::new(q.x, q.y), NSSize::new(q.width, q.height));
        w.setFrame_display(r, true);
    }

    pub fn opacity(ptr: *mut std::ffi::c_void, alpha: f64) {
        if let Some(w) = window(ptr) {
            w.setAlphaValue(alpha);
        }
    }
}

/// At launch: shows the window where it was, if that place still exists — or where it
/// always started, if not. It is born hidden (tauri.conf.json) and this is what shows it.
pub fn show<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle();
        let saved = [file(app), legacy_file(app)]
            .into_iter()
            .flatten()
            .find_map(|a| std::fs::read_to_string(a).ok())
            .and_then(|t| serde_json::from_str::<Saved>(&t).ok());
        let frame = saved.and_then(|s| validate(s.frame, &native::screens()));
        if let (Some(q), Ok(ptr)) = (frame, window.ns_window()) {
            // On screen but invisible, so that macOS has already placed it where it wanted
            // when it gets its frame — and the jump there isn't seen.
            native::opacity(ptr, 0.0);
            let _ = window.show();
            native::apply(ptr, q);
            native::opacity(ptr, 1.0);
            *window.state::<Last>().0.lock().unwrap() = Some(q);
            return;
        }
    }
    let _ = window.show();
}

/// On every move and resize: remembers the frame, in memory. Full screen, minimized and
/// still hidden don't count — what comes back is the window as you last arranged it.
pub fn record<R: Runtime>(window: &tauri::Window<R>) {
    #[cfg(target_os = "macos")]
    if let Some(q) = window.ns_window().ok().and_then(native::read) {
        *window.state::<Last>().0.lock().unwrap() = Some(q);
    }
}

/// On quit: the last frame goes to disk.
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let Some(frame) = *app.state::<Last>().0.lock().unwrap() else { return };
    let Some(a) = file(app) else { return };
    if let Some(folder) = a.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if let Ok(t) = serde_json::to_string(&Saved { frame }) {
        let _ = std::fs::write(a, t);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn q(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame { x, y, width, height }
    }

    // The MacBook's screen, the menu bar on top; and a 1080p above it, 34 points to the
    // left — this machine's layout.
    const MAIN: Frame = Frame { x: 0.0, y: 0.0, width: 1440.0, height: 875.0 };
    const ABOVE: Frame = Frame { x: -34.0, y: 900.0, width: 1920.0, height: 1050.0 };

    #[test]
    fn comes_back_where_it_was() {
        let salva = q(200.0, 100.0, 1100.0, 700.0);
        assert_eq!(validate(salva, &[MAIN]), Some(salva));
        // Filling the screen above, exactly its visible area.
        assert_eq!(validate(ABOVE, &[MAIN, ABOVE]), Some(ABOVE));
    }

    #[test]
    fn a_gone_screen_starts_fresh() {
        assert_eq!(validate(ABOVE, &[MAIN]), None);
        assert_eq!(validate(q(200.0, 100.0, 1100.0, 700.0), &[]), None);
    }

    #[test]
    fn title_bar_must_be_reachable() {
        // Top under the menu bar, or only a sliver of it at the right edge.
        assert_eq!(validate(q(200.0, 300.0, 1100.0, 700.0), &[MAIN]), None);
        assert_eq!(validate(q(1380.0, 100.0, 1100.0, 700.0), &[MAIN]), None);
        // Mostly off to the side, but with enough of the bar visible, it stays.
        assert!(validate(q(-900.0, 100.0, 1100.0, 700.0), &[MAIN]).is_some());
    }

    #[test]
    fn bigger_than_the_screen_shrinks_keeping_the_top() {
        let v = validate(q(0.0, -500.0, 2400.0, 1375.0), &[MAIN]).unwrap();
        assert_eq!(v, q(0.0, 0.0, 1440.0, 875.0));
    }

    #[test]
    fn junk_in_the_file_is_ignored() {
        assert_eq!(validate(q(f64::NAN, 0.0, 1000.0, 600.0), &[MAIN]), None);
        assert_eq!(validate(q(0.0, 30.0, 10.0, 10.0), &[MAIN]), None);
        assert!(serde_json::from_str::<Saved>(r#"{"x":-34.0,"y":-1050.0,"largura":1920.0,"altura":1050.0}"#).is_err());
    }
}
