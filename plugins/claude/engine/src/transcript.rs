//! What chat mode reads from Claude Code's files: the transcript (with the diffs of
//! each edit, already trimmed) and the `/commands` on disk.

use std::io::Read;
use std::path::PathBuf;

use crate::hooks::claude_dir;
use crate::language::tr;

/// A chunk of a Claude Code session transcript.
#[derive(serde::Serialize)]
pub struct TranscriptChunk {
    text: String,
    /// How far this chunk went, in bytes: it is the next read's `since`.
    end: u64,
    /// The start was left out (file too large), or the file shrank and the
    /// read started over: what the screen already showed is no longer valid.
    from_start: bool,
    truncated: bool,
}

/// The full transcript of a long session exceeds tens of MB, almost all of it
/// tool results. The conversation that matters is its end.
const MAX_TRANSCRIPT_BYTES: u64 = 6 * 1024 * 1024;

/// What the transcript gained since `since`. Whole lines only: the last one, if
/// Claude is still writing it, waits for the next read.
///
/// The path comes from the hook, but the webview delivers it — so only a
/// `.jsonl` inside `~/.claude` is accepted, not any file on disk.
pub fn transcript_read(path: String, since: u64) -> Result<TranscriptChunk, String> {
    use std::io::{Seek, SeekFrom};

    let base = claude_dir().ok_or("no Claude Code folder")?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&base) || file.extension().is_none_or(|e| e != "jsonl") {
        return Err(tr("não é um transcript do Claude Code", "not a Claude Code transcript").into());
    }

    let mut f = std::fs::File::open(&file).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    // Smaller than what was already read: the file was rewritten. Start over.
    let mut from_start = since > size;
    let mut start = if from_start { 0 } else { since };
    let truncated = size - start > MAX_TRANSCRIPT_BYTES;
    if truncated {
        start = size - MAX_TRANSCRIPT_BYTES;
        from_start = true;
    }

    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.take(size - start).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Jumped into the middle of the file: the first line came in half.
    let skip = if truncated { bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| p + 1) } else { 0 };
    let until = bytes.iter().rposition(|b| *b == b'\n').map_or(skip, |p| (p + 1).max(skip));
    // Almost all of the file's weight is tool results (a file read, a
    // command's output), which the chat doesn't show. It stays here: sending it to the
    // webview and making it parse megabytes of JSON froze the screen.
    let mut text = String::new();
    for line in String::from_utf8_lossy(&bytes[skip..until]).lines() {
        let is_message = line.contains(r#""type":"user""#) || line.contains(r#""type":"assistant""#);
        if !is_message {
            continue;
        }
        if !line.contains(r#""tool_use_id""#) {
            text.push_str(line);
            text.push('\n');
        } else if let Some(diff) = diff_from_result(line).or_else(|| diff_from_hook(&file, line)) {
            text.push_str(&diff);
            text.push('\n');
        }
    }
    Ok(TranscriptChunk {
        text,
        end: start + until as u64,
        from_start,
        truncated,
    })
}

/// The diff Claude Code stored in a tool result, already trimmed:
/// `{"type":"diff","files":[{"path","hunks"}]}`. It is the same one the terminal
/// draws, with the file's line numbers. It comes from two places: the
/// `structuredPatch` of an Edit or Write, and the `bashEditDiff` of a command
/// (a `sed -i`, a script) that changed a file. The rest of the result — the
/// whole previous file, in an Edit — stays here.
fn diff_from_result(line: &str) -> Option<String> {
    use serde_json::{json, Value};
    if !line.contains(r#""structuredPatch""#) && !line.contains(r#""bashEditDiff""#) {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let r = v.get("toolUseResult")?;
    let hunks = |h: &Value| -> Vec<Value> {
        h.as_array()
            .into_iter()
            .flatten()
            .map(|h| json!({ "oldStart": h["oldStart"], "newStart": h["newStart"], "lines": h["lines"] }))
            .collect()
    };
    let mut files = Vec::new();
    if let Some(edits) = r.pointer("/bashEditDiff/files").and_then(Value::as_array) {
        for f in edits {
            files.push(json!({ "path": f["filePath"], "hunks": hunks(&f["hunks"]) }));
        }
    } else if let Some(path) = r.get("filePath") {
        let mut h = hunks(&r["structuredPatch"]);
        // New file: Write brings no patch, only the content.
        if h.is_empty() && r.get("type").and_then(Value::as_str) == Some("create") {
            if let Some(c) = r.get("content").and_then(Value::as_str) {
                let lines: Vec<String> = c.lines().map(|l| format!("+{l}")).collect();
                h.push(json!({ "oldStart": 0, "newStart": 1, "lines": lines }));
            }
        }
        files.push(json!({ "path": path, "hunks": h }));
    }
    files.retain(|a| a["hunks"].as_array().is_some_and(|h| !h.is_empty()));
    if files.is_empty() {
        return None;
    }
    Some(json!({ "type": "diff", "files": files }).to_string())
}

/// The diff our hook took from a Bash, for when Claude Code didn't
/// store one (a command that changed a file and ended with an error). It lives in
/// `~/.termiau/diffs/<session>/<tool_use_id>.patch`; the session is the
/// transcript's name.
fn diff_from_hook(transcript: &std::path::Path, line: &str) -> Option<String> {
    let id = line.split(r#""tool_use_id":""#).nth(1)?.split('"').next()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let session = transcript.file_stem()?.to_str()?;
    let patch = PathBuf::from(std::env::var_os("HOME")?).join(".termiau/diffs").join(session).join(format!("{id}.patch"));
    let text = std::fs::read_to_string(patch).ok()?;
    let files = files_from_patch(&text);
    if files.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "diff", "files": files }).to_string())
}

/// A `git diff` into files and hunks, in the same format as Claude Code's
/// `structuredPatch`. The first line, `# root <folder>`, is from the hook: it is what
/// turns git's `a/…` and `b/…` paths absolute. A binary file has no
/// hunk and is left out.
fn files_from_patch(text: &str) -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut lines = text.lines();
    let root = lines.next().and_then(|l| l.strip_prefix("# root ")).unwrap_or("");
    let mut files: Vec<serde_json::Value> = Vec::new();
    let mut path: Option<String> = None;
    let mut hunks: Vec<serde_json::Value> = Vec::new();
    let mut current: Option<(u64, u64, Vec<String>)> = None;
    let close_hunk = |current: &mut Option<(u64, u64, Vec<String>)>, hunks: &mut Vec<serde_json::Value>| {
        if let Some((old, new, ls)) = current.take() {
            hunks.push(json!({ "oldStart": old, "newStart": new, "lines": ls }));
        }
    };
    let close_file =
        |path: &mut Option<String>, hunks: &mut Vec<serde_json::Value>, files: &mut Vec<serde_json::Value>| {
            if let Some(c) = path.take() {
                if !hunks.is_empty() {
                    files.push(json!({ "path": c, "hunks": std::mem::take(hunks) }));
                }
            }
            hunks.clear();
        };
    // The start of a hunk: `@@ -old[,n] +new[,n] @@`.
    let start = |l: &str| -> Option<(u64, u64)> {
        let mut parts = l.strip_prefix("@@ ")?.split(' ');
        let num = |p: &str| p.split(',').next().and_then(|n| n.parse::<u64>().ok());
        Some((num(parts.next()?.strip_prefix('-')?)?, num(parts.next()?.strip_prefix('+')?)?))
    };
    for l in lines {
        if l.starts_with("diff --git ") {
            close_hunk(&mut current, &mut hunks);
            close_file(&mut path, &mut hunks, &mut files);
        } else if current.is_none() && (l.starts_with("--- ") || l.starts_with("+++ ")) {
            // `+++ b/…` gives the name; for a deleted file it is /dev/null, and
            // the `--- a/…` that came before counts.
            if let Some(p) = l[4..].strip_prefix("a/").or_else(|| l[4..].strip_prefix("b/")) {
                path = Some(format!("{}/{}", root.trim_end_matches('/'), p));
            }
        } else if let Some((old, new)) = start(l) {
            close_hunk(&mut current, &mut hunks);
            current = Some((old, new, Vec::new()));
        } else if let Some((_, _, ls)) = current.as_mut() {
            if l.starts_with([' ', '+', '-', '\\']) {
                ls.push(l.to_string());
            } else {
                close_hunk(&mut current, &mut hunks);
            }
        }
    }
    close_hunk(&mut current, &mut hunks);
    close_file(&mut path, &mut hunks, &mut files);
    files
}

/// A `/command` Claude Code accepts beyond its built-in ones: the user's,
/// the project's and the installed plugins' commands and skills.
#[derive(serde::Serialize)]
pub struct SlashCommand {
    name: String,
    description: String,
}

/// The `description:` in a command's or skill's header. Only the start of the
/// file is read, and only its first line matters: it is what fits in the list.
fn description_of(file: &std::path::Path) -> String {
    let mut text = String::new();
    let Ok(f) = std::fs::File::open(file) else { return text };
    let _ = f.take(16 * 1024).read_to_string(&mut text);
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    lines
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| d.trim().trim_matches(['"', '\'']).chars().take(160).collect())
        .unwrap_or_default()
}

/// The `.md` files of a commands folder. A subfolder becomes a prefix, like in Claude
/// Code: `commands/git/commit.md` is `/git:commit`.
fn commands_in_folder(dir: &std::path::Path, prefix: &str, depth: u8, out: &mut Vec<SlashCommand>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let path = item.path();
        let Some(name) = path.file_stem().and_then(|n| n.to_str()) else { continue };
        if path.is_dir() {
            if depth > 0 {
                commands_in_folder(&path, &format!("{prefix}{name}:"), depth - 1, out);
            }
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(SlashCommand { name: format!("{prefix}{name}"), description: description_of(&path) });
        }
    }
}

/// The skills of a folder: each subfolder with a `SKILL.md` is one.
fn skills_in_folder(dir: &std::path::Path, prefix: &str, out: &mut Vec<SlashCommand>) {
    let Ok(items) = std::fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let skill = item.path().join("SKILL.md");
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        if skill.is_file() {
            out.push(SlashCommand { name: format!("{prefix}{name}"), description: description_of(&skill) });
        }
    }
}

/// What can be called with `/` in the session running in `folder`, besides
/// Claude Code's built-in commands (the webview already knows those). The project
/// comes before the user, and the user before plugins: it is the order the
/// list shows, and the project's are the most used in it.
pub fn commands_list(folder: Option<String>) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    if let Some(folder) = folder {
        // Going up from the session's folder, as Claude Code does: a session
        // opened in a subfolder still sees the project root's `.claude`.
        for dir in std::path::Path::new(&folder).ancestors() {
            let claude = dir.join(".claude");
            // `~/.claude` is the user's, and comes right below.
            if claude_dir().is_some_and(|d| d == claude) {
                break;
            }
            commands_in_folder(&claude.join("commands"), "", 3, &mut out);
            skills_in_folder(&claude.join("skills"), "", &mut out);
        }
    }
    let Some(base) = claude_dir() else { return out };
    commands_in_folder(&base.join("commands"), "", 3, &mut out);
    skills_in_folder(&base.join("skills"), "", &mut out);

    // Each installed plugin brings its own, called as `/plugin:name`.
    let plugins = std::fs::read_to_string(base.join("plugins/installed_plugins.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(map) = plugins.as_ref().and_then(|p| p["plugins"].as_object()) {
        for (key, installs) in map {
            let plugin = key.split('@').next().unwrap_or(key);
            for inst in installs.as_array().into_iter().flatten() {
                let Some(root) = inst["installPath"].as_str().map(PathBuf::from) else { continue };
                let prefix = format!("{plugin}:");
                commands_in_folder(&root.join("commands"), &prefix, 3, &mut out);
                skills_in_folder(&root.join("skills"), &prefix, &mut out);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::files_from_patch;

    #[test]
    fn reads_the_hook_patch() {
        let patch = "# root /repo\n\
diff --git a/new.txt b/new.txt\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/new.txt\n\
@@ -0,0 +1 @@\n\
+new\n\
diff --git a/x.txt b/x.txt\n\
--- a/x.txt\n\
+++ b/x.txt\n\
@@ -1,3 +1,3 @@\n\
 a\n\
-b\n\
+B\n\
@@ -40 +40 @@\n\
--- old\n\
+++ new\n\
diff --git a/deleted.txt b/deleted.txt\n\
--- a/deleted.txt\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-x\n\
diff --git a/img.png b/img.png\n\
Binary files a/img.png and b/img.png differ\n";
        let a = files_from_patch(patch);
        let paths: Vec<_> = a.iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["/repo/new.txt", "/repo/x.txt", "/repo/deleted.txt"]);
        assert_eq!(a[0]["hunks"][0]["newStart"], 1);
        // Inside a hunk, `--- old` is a removed line, not a header.
        assert_eq!(a[1]["hunks"][1]["lines"], serde_json::json!(["--- old", "+++ new"]));
        assert_eq!(a[1]["hunks"][0]["oldStart"], 1);
    }
}
