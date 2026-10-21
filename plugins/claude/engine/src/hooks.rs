//! Installing TermIAu's hook in Claude Code: the script in `~/.claude/hooks`, and its
//! registration (each event, and the status line) in Claude Code's settings.json.

use std::path::PathBuf;

use crate::language::tr;

/// The hook ships inside the binary: someone who installed only the plugin doesn't have
/// the repository to run `hook/install.sh` from. That script still works and does
/// the same as `hooks_install` here.
const HOOK: &str = include_str!("../../hook/termiau-event.sh");
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "SessionEnd",
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
];

/// How our hook is registered on each event.
///
/// Tool events only matter for Bash — the snapshot before and after a
/// command, for the diff Claude Code doesn't store (see `diff_do_bash` in the
/// hook) — and, after it, for Claude's question: it is the notice that it was
/// answered in the terminal and the chat card can go. Without the matcher, the hook
/// would run on every Read.
///
/// `PermissionRequest` has an hour: on a Claude question, the hook keeps
/// waiting for the chat's answer (see `PendingReplies` in the app). On other requests it
/// returns right away, like the rest.
fn group_for_event(event: &str, command: &str) -> serde_json::Value {
    let timeout = if event == "PermissionRequest" { 3600 } else { 5 };
    let mut group = serde_json::json!({
        "hooks": [{ "type": "command", "command": command, "timeout": timeout }]
    });
    match event {
        "PreToolUse" => group["matcher"] = "Bash".into(),
        "PostToolUse" | "PostToolUseFailure" => group["matcher"] = "Bash|AskUserQuestion".into(),
        _ => {}
    }
    group
}

pub fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude"))
}

const HOOK_FILE: &str = "termiau-event.sh";

fn hook_is_ours(h: &serde_json::Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains(HOOK_FILE))
}

/// `statusLine` goes through the same hook, with the `status` argument: it is how
/// the app gets the session's context and Claude's usage (see the start of
/// termiau-event.sh). A status line that isn't ours stays where it is —
/// whoever put it there wanted something else.
fn status_line_current(settings: &serde_json::Value) -> bool {
    let s = &settings["statusLine"];
    s.is_object() && !hook_is_ours(s) || hook_is_ours(s) && s["command"].as_str().is_some_and(|c| c.ends_with(" status"))
}

fn status_line(command: &str) -> serde_json::Value {
    serde_json::json!({ "type": "command", "command": format!("{command} status"), "padding": 0 })
}

/// settings.json already calls our hook on every event, and the way
/// this version registers it: a changed matcher or timeout also calls for
/// reinstalling.
fn hooks_registered(settings: &serde_json::Value) -> bool {
    status_line_current(settings) && HOOK_EVENTS.iter().all(|e| {
        settings["hooks"][*e].as_array().is_some_and(|groups| {
            groups.iter().any(|g| {
                let Some(ours) = g["hooks"].as_array().and_then(|hs| hs.iter().find(|h| hook_is_ours(h))) else {
                    return false;
                };
                let expected = group_for_event(e, ours["command"].as_str().unwrap_or(""));
                g["matcher"] == expected["matcher"] && ours["timeout"] == expected["hooks"][0]["timeout"]
            })
        })
    })
}

/// Where the Claude Code link stands: `no-claude` (no `~/.claude`),
/// `missing` (never installed), `outdated` (installed by an earlier
/// version of the app) or `installed`.
pub fn hooks_state() -> &'static str {
    let Some(dir) = claude_dir().filter(|d| d.is_dir()) else { return "no-claude" };
    let script = dir.join("hooks").join(HOOK_FILE);
    if !script.exists() {
        return "missing";
    }
    let script_current = std::fs::read_to_string(&script).is_ok_and(|s| s == HOOK);
    let registered = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|s| hooks_registered(&s));
    if script_current && registered { "installed" } else { "outdated" }
}

/// Copies the hook to `~/.claude/hooks` and registers it in Claude Code's
/// settings.json. Idempotent, and settings gets a backup beside it before being touched.
pub fn hooks_install() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = claude_dir().ok_or(tr("não achei a pasta do usuário", "couldn't find the user folder"))?;
    let target = dir.join("hooks").join(HOOK_FILE);
    std::fs::create_dir_all(dir.join("hooks")).map_err(|e| e.to_string())?;
    std::fs::write(&target, HOOK).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    let path = dir.join("settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // A settings.json that can't be read isn't rewritten: better to go without the
    // hook than to erase someone's configuration.
    let mut settings: serde_json::Value = match text.as_deref().map(str::trim) {
        None | Some("") => serde_json::json!({}),
        Some(t) => serde_json::from_str(t)
            .map_err(|e| format!("{}: {e}", tr("o settings.json do Claude Code está ilegível", "Claude Code's settings.json is unreadable")))?,
    };
    if hooks_registered(&settings) {
        return Ok(());
    }
    settings
        .as_object_mut()
        .ok_or(tr("o settings.json do Claude Code não é um objeto", "Claude Code's settings.json is not an object"))?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let command = format!("bash {}", target.display());
    if !status_line_current(&settings) {
        settings["statusLine"] = status_line(&command);
    }
    let hooks = settings["hooks"].as_object_mut().ok_or(tr("o \"hooks\" do settings.json do Claude Code não é um objeto", "the \"hooks\" in Claude Code's settings.json is not an object"))?;
    for event in HOOK_EVENTS {
        // Any previous registration of our hook goes out, a new one goes in at the end.
        let mut groups =
            hooks.get(*event).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for g in &mut groups {
            if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                hs.retain(|h| !hook_is_ours(h));
            }
        }
        groups.retain(|g| g["hooks"].as_array().is_some_and(|hs| !hs.is_empty()));
        groups.push(group_for_event(event, &command));
        hooks.insert(event.to_string(), serde_json::Value::Array(groups));
    }

    if text.is_some() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::copy(&path, dir.join(format!("settings.json.bak-{now}")))
            .map_err(|e| e.to_string())?;
    }
    let new_text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Direct write, no rename: the settings.json of dotfiles users
    // is a link, and a `rename` over it would put a file in its place.
    std::fs::write(&path, new_text + "\n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{hooks_registered, status_line_current};
    use serde_json::json;

    #[test]
    fn someone_elses_status_line_stays() {
        let ours = |c: &str| json!({ "statusLine": { "type": "command", "command": c } });
        assert!(status_line_current(&ours("bash /h/.claude/hooks/termiau-event.sh status")));
        assert!(!status_line_current(&ours("bash /h/.claude/hooks/termiau-event.sh")));
        assert!(status_line_current(&ours("~/bin/my-status-line")));
        assert!(!hooks_registered(&json!({})));
    }
}
