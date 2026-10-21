//! The YouTube Radio plugin's engine, run by TermIAu as a plugin process (see the
//! app's src-tauri/src/plugin_process.rs).
//!
//! It does two things the webview can't:
//!
//!  1. Serves the player page (`player.html`) on `http://127.0.0.1`. From the
//!     installed app's origin, `tauri://localhost`, YouTube refuses the embed with
//!     error 153 — the browser sends no `Referer` from that scheme. A page of ours on
//!     127.0.0.1 is an origin YouTube accepts, and the plugin loads it in an iframe.
//!  2. Looks up a link's title in YouTube's oEmbed, which sends no
//!     `Access-Control-Allow-Origin`: a `fetch` from the webview would hit CORS.
//!
//! It speaks newline-delimited JSON. On stdin, commands:
//!   {"cmd":"title","id":...,"url":...}
//! On stdout, events:
//!   {"event":"listening","port":N}
//!   {"event":"title","id":...,"title":...}  {"event":"title","id":...,"error":...}
//!   {"event":"error","message":...}
//! Closing stdin (the app quit, or the plugin was turned off) ends the process.

use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;

use serde_json::{json, Value};

const PAGE: &str = include_str!("player.html");

/// One line of JSON on stdout. Locked, because the title lookups report from
/// their own threads.
fn emit(event: Value) {
    static OUT: Mutex<()> = Mutex::new(());
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

/// Every request gets the page: it is the only thing served, and the query string
/// (the language) is read by the page itself.
fn serve(mut stream: TcpStream) {
    let mut buf = [0u8; 4096];
    let _ = stream.read(&mut buf);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{PAGE}",
        PAGE.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

/// Only YouTube links reach oEmbed: the URL comes from what the user pasted, and
/// the engine shouldn't fetch whatever that is.
fn title(url: &str) -> Result<String, String> {
    if !url.starts_with("https://www.youtube.com/") {
        return Err("not a YouTube link".into());
    }
    let mut endpoint = String::from("https://www.youtube.com/oembed?format=json&url=");
    for b in url.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => endpoint.push(b as char),
            _ => endpoint.push_str(&format!("%{b:02X}")),
        }
    }
    let body = ureq::get(&endpoint)
        .call()
        .map_err(|e| e.to_string())?
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    json["title"].as_str().map(str::to_owned).ok_or_else(|| "no title in the answer".into())
}

fn main() {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => return emit(json!({ "event": "error", "message": e.to_string() })),
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    emit(json!({ "event": "listening", "port": port }));

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || serve(stream));
        }
    });

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else { continue };
        if cmd["cmd"] != "title" {
            continue;
        }
        let id = cmd["id"].clone();
        let url = cmd["url"].as_str().unwrap_or_default().to_owned();
        std::thread::spawn(move || match title(&url) {
            Ok(t) => emit(json!({ "event": "title", "id": id, "title": t })),
            Err(e) => emit(json!({ "event": "title", "id": id, "error": e })),
        });
    }
}
