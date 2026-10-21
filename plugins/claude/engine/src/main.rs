//! The Claude Code plugin's engine, run by TermIAu as a plugin process (see the
//! app's src-tauri/src/plugin_process.rs). Everything that touches Claude Code's
//! files or runs `claude` lives here, out of the app:
//!
//!  - installing the hook (`hooks.rs`);
//!  - reading a session's transcript and the `/commands` on disk, for chat mode
//!    (`transcript.rs`);
//!  - the diff tab's questions, `claude -p`, and the stored sessions they can
//!    mention (`ask.rs`).
//!
//! It speaks newline-delimited JSON. Each request carries an `id`, and its answer
//! comes back with it — `{"id":1,"ok":…}` or `{"id":1,"error":"…"}` — in any order:
//! each request runs on its own thread, so a question to Claude doesn't hold up a
//! transcript read. Closing stdin (the app quit, or the plugin was turned off) ends
//! the process.

mod ask;
mod git;
mod hooks;
mod language;
mod transcript;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

/// One line of JSON on stdout. Locked, because the requests answer from their own threads.
fn emit(message: Value) {
    static OUT: Mutex<()> = Mutex::new(());
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn text(req: &Value, key: &str) -> Result<String, String> {
    req[key].as_str().map(str::to_owned).ok_or_else(|| format!("missing \"{key}\""))
}

fn optional(req: &Value, key: &str) -> Option<String> {
    req[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn to_value<T: serde::Serialize>(v: Result<T, String>) -> Result<Value, String> {
    v.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

fn handle(req: &Value) -> Result<Value, String> {
    match req["cmd"].as_str().unwrap_or_default() {
        "language" => {
            language::set(req["language"].as_str().unwrap_or("en"));
            Ok(Value::Null)
        }
        "hooks_state" => Ok(json!(hooks::hooks_state())),
        "hooks_install" => hooks::hooks_install().map(|_| Value::Null),
        "transcript_read" => to_value(transcript::transcript_read(text(req, "path")?, req["since"].as_u64().unwrap_or(0))),
        "commands_list" => to_value(Ok(transcript::commands_list(optional(req, "folder")))),
        "sessions" => to_value(ask::sessions(&PathBuf::from(text(req, "path")?))),
        "ask" => to_value(ask::ask(
            &PathBuf::from(text(req, "path")?),
            &text(req, "askId")?,
            &text(req, "question")?,
            &text(req, "context").unwrap_or_default(),
            optional(req, "model").as_deref(),
            optional(req, "session").as_deref(),
            req["allowEdits"].as_bool().unwrap_or(false),
        )),
        "undo" => {
            let changes: Vec<ask::FileChange> =
                serde_json::from_value(req["changes"].clone()).map_err(|e| e.to_string())?;
            to_value(ask::undo(&PathBuf::from(text(req, "path")?), &changes))
        }
        "cancel" => {
            ask::cancel(&text(req, "askId")?);
            Ok(Value::Null)
        }
        other => Err(format!("unknown command \"{other}\"")),
    }
}

fn main() {
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        std::thread::spawn(move || {
            let id = req["id"].clone();
            match handle(&req) {
                Ok(ok) => emit(json!({ "id": id, "ok": ok })),
                Err(error) => emit(json!({ "id": id, "error": error })),
            }
        });
    }
}
