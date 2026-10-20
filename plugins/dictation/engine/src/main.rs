//! The Dictation plugin's engine: microphone capture and local speech
//! transcription, run by TermIAu as a plugin process (see the app's
//! src-tauri/src/plugin_process.rs).
//!
//! ```text
//! cpal (microphone, native rate)
//!   -> downmix to mono
//!   -> resample  (windowed sinc -> 16 kHz)
//!   -> stt       (energy VAD + whisper.cpp with Metal)
//!   -> stdout    (the plugin types the text into the focused panel)
//! ```
//!
//! It speaks newline-delimited JSON. On stdin, commands:
//!   {"cmd":"modelReady"} {"cmd":"downloadModel"} {"cmd":"stop"}
//!   {"cmd":"start","language":"pt"|"en"|...|"auto"}
//! On stdout, events:
//!   {"event":"modelReady","ready":bool}  {"event":"progress","value":0..1}
//!   {"event":"downloaded"}  {"event":"started"}  {"event":"level","value":0..1}
//!   {"event":"partial","text":...}  {"event":"final","text":...}
//!   {"event":"status","value":"listening"|"stopped"}  {"event":"error","message":...}
//! Closing stdin (the app quit, or the plugin was turned off) stops everything.

// The microphone list and the model catalog have no screen using them yet: they
// are the surface of a future settings, and deleting them to bring them back later
// is worse than these allows.
#[allow(dead_code)]
mod audio;
mod language;
#[allow(dead_code)]
mod model;
mod resample;
mod stt;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use language::tr;
use serde_json::{json, Value};

/// The recommended balance of speed and accuracy — 466 MB, multilingual. The
/// others in the catalog stay in `model` for when there is a setting for them.
const MODEL: &str = "small";

/// One line of JSON on stdout. Locked, because three threads report at once.
fn emit(event: Value) {
    static OUT: Mutex<()> = Mutex::new(());
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

fn error(message: impl std::fmt::Display) {
    emit(json!({ "event": "error", "message": message.to_string() }));
}

/// The plugin's own folder for data, which TermIAu passes.
fn data_dir() -> PathBuf {
    std::env::var_os("TERMIAU_PLUGIN_DATA").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".termiau/plugin-data/termiau.dictation")
    })
}

/// Where the model is. Ours first; then where TermIAu kept it while dictation was
/// part of the app, and the old Escuta app's folder — whoever already downloaded
/// 466 MB there needn't download again. If none has it, ours is where it will land.
fn model_path() -> PathBuf {
    let ours = model::path_for(&data_dir(), MODEL);
    if ours.exists() {
        return ours;
    }
    let support = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support");
    ["dev.jeilson.termiau", "dev.jeilson.termiau.dev", "ai.dimenso.escuta"]
        .iter()
        .map(|app| support.join(app).join("models").join(format!("ggml-{MODEL}.bin")))
        .find(|p| p.exists())
        .unwrap_or(ours)
}

/// The session's stop flag, while the microphone is open.
static SESSION: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn stop() {
    if let Some(flag) = SESSION.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Opens the microphone. Three threads: capture, level meter and transcription —
/// the `cpal::Stream` must live entirely on the thread that opened it.
fn start(language: String) -> Result<(), String> {
    let mut session = SESSION.lock().unwrap();
    // A session that died on its own (microphone gone, corrupted model) leaves
    // the flag behind; clear it before deciding whether we are still listening.
    if session.as_ref().is_some_and(|f| f.load(Ordering::Relaxed)) {
        *session = None;
    }
    if session.is_some() {
        return Err(tr("já estou escutando", "already listening").into());
    }
    let path = model_path();
    if !path.exists() {
        return Err(tr("o modelo ainda não foi baixado", "the model hasn't been downloaded yet").into());
    }

    let flag = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let (level_tx, level_rx) = std::sync::mpsc::channel::<f32>();

    // 1) capture
    {
        let flag = flag.clone();
        std::thread::spawn(move || {
            if let Err(e) = audio::capture(None, audio_tx, level_tx, flag.clone()) {
                error(e);
                flag.store(true, Ordering::Relaxed);
                emit(json!({ "event": "status", "value": "stopped" }));
            }
        });
    }

    // 2) meter: aggregates the peak and reports ~20x per second, otherwise it would
    //    be one line per audio buffer.
    {
        let flag = flag.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                let mut peak = 0.0f32;
                let until = Instant::now() + Duration::from_millis(50);
                while Instant::now() < until {
                    match level_rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(v) => peak = peak.max(v),
                        Err(_) => break,
                    }
                }
                emit(json!({ "event": "level", "value": peak }));
            }
            emit(json!({ "event": "level", "value": 0.0 }));
        });
    }

    // 3) transcription
    {
        let flag = flag.clone();
        let path = path.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let engine = match stt::Engine::load(&path, &language) {
                Ok(e) => e,
                Err(e) => {
                    error(e);
                    flag.store(true, Ordering::Relaxed);
                    emit(json!({ "event": "status", "value": "stopped" }));
                    return;
                }
            };
            stt::run(engine, audio_rx, flag, |ev| match ev {
                stt::Event::Partial(t) => emit(json!({ "event": "partial", "text": t })),
                stt::Event::Final(t) => emit(json!({ "event": "final", "text": t })),
                stt::Event::Status(s) => emit(json!({ "event": "status", "value": s })),
                stt::Event::Error(e) => error(e),
            });
        });
    }

    *session = Some(flag);
    Ok(())
}

fn download() {
    std::thread::spawn(|| {
        let result = model::download(&data_dir(), MODEL, |fraction, _, _| {
            emit(json!({ "event": "progress", "value": fraction }));
        });
        match result {
            Ok(_) => emit(json!({ "event": "downloaded" })),
            Err(e) => error(e),
        }
    });
}

/// The language the plugin asked for: a two-letter code, or `auto` for Whisper
/// to detect it. Without one (or with junk), it detects.
fn spoken_language(message: &Value) -> String {
    match message.get("language").and_then(Value::as_str) {
        Some(l) if l == "auto" || (l.len() == 2 && l.chars().all(|c| c.is_ascii_lowercase())) => l.to_string(),
        _ => "auto".to_string(),
    }
}

fn main() {
    // Without this whisper.cpp dumps its log onto the process output — and stdout
    // is the protocol.
    whisper_rs::install_logging_hooks();

    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            error(format!("not a command: {line}"));
            continue;
        };
        match message.get("cmd").and_then(Value::as_str) {
            Some("modelReady") => emit(json!({ "event": "modelReady", "ready": model_path().exists() })),
            Some("downloadModel") => download(),
            Some("start") => match start(spoken_language(&message)) {
                Ok(()) => emit(json!({ "event": "started" })),
                Err(e) => error(e),
            },
            Some("stop") => stop(),
            other => error(format!("unknown command: {other:?}")),
        }
    }
    // stdin closed: TermIAu is gone or turned the plugin off.
    stop();
    std::thread::sleep(Duration::from_millis(200));
}

#[cfg(test)]
mod tests {
    use super::spoken_language;
    use serde_json::json;

    #[test]
    fn the_language_is_a_code_or_auto() {
        assert_eq!(spoken_language(&json!({ "cmd": "start", "language": "en" })), "en");
        assert_eq!(spoken_language(&json!({ "cmd": "start", "language": "auto" })), "auto");
        // Missing or junk: Whisper detects it.
        assert_eq!(spoken_language(&json!({ "cmd": "start" })), "auto");
        assert_eq!(spoken_language(&json!({ "cmd": "start", "language": "--x" })), "auto");
    }
}
