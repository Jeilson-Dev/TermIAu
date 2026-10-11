//! Parsing of `git diff --raw -z` and `git diff --patch` output.
//!
//! Both commands are run with identical diff options, so they list the same files
//! in the same order: the raw output gives exact paths/modes/blob ids, the patch
//! output gives the hunks. `build` zips them together.

use serde::Serialize;

use crate::differ::error::{Error, Result};
use crate::idioma::tr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

/// Como o arquivo está no índice, no diff do que está para ser commitado: o
/// `git add` pode ter levado tudo, parte (o arquivo mudou de novo depois dele)
/// ou nada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Staged {
    Staged,
    Partial,
    Unstaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub content: String,
    /// The line is the last one of its file and has no trailing newline.
    pub no_newline: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Text after the second `@@` (usually the enclosing function).
    pub section: String,
    pub lines: Vec<Line>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Set for renames and copies.
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// Rename/copy similarity, 0-100.
    pub similarity: Option<u8>,
    pub old_mode: String,
    pub new_mode: String,
    /// Blob ids, `None` when the side doesn't exist (added/deleted).
    pub old_oid: Option<String>,
    pub new_oid: Option<String>,
    pub binary: bool,
    pub submodule: bool,
    pub additions: u32,
    pub deletions: u32,
    /// Changes whenever this file's diff changes; used to invalidate "viewed" marks.
    pub fingerprint: String,
    /// Só no diff do que está para ser commitado; `None` nos outros escopos,
    /// onde tudo o que se vê já é commit e índice não há.
    pub staged: Option<Staged>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, PartialEq)]
pub struct RawEntry {
    pub old_mode: String,
    pub new_mode: String,
    pub old_oid: String,
    pub new_oid: String,
    pub status: char,
    pub score: Option<u8>,
    pub old_path: String,
    pub path: String,
}

#[derive(Debug, Default)]
pub struct PatchSection {
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// Parses `git diff --raw -z --no-abbrev`.
pub fn parse_raw(out: &[u8]) -> Result<Vec<RawEntry>> {
    let mut fields = out
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    let mut entries = Vec::new();

    while let Some(meta) = fields.next() {
        let meta = meta.trim_start_matches('\n');
        if meta.is_empty() {
            continue;
        }
        let meta = meta
            .strip_prefix(':')
            .ok_or_else(|| Error::Parse(format!("{}: {meta}", tr("entrada raw inesperada", "unexpected raw entry"))))?;
        let parts: Vec<&str> = meta.split(' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status_field] = parts[..] else {
            return Err(Error::Parse(format!("{}: {meta}", tr("entrada raw inesperada", "unexpected raw entry"))));
        };
        let status = status_field
            .chars()
            .next()
            .ok_or_else(|| Error::Parse(tr("status vazio", "empty status").into()))?;
        let score = status_field[1..].parse().ok();

        let missing_path = || Error::Parse(format!("{} {meta}", tr("caminho ausente para a entrada", "missing path for entry")));
        let first = fields.next().ok_or_else(missing_path)?;
        let (old_path, path) = if matches!(status, 'R' | 'C') {
            let second = fields.next().ok_or_else(missing_path)?;
            (first, second)
        } else {
            (first.clone(), first)
        };

        entries.push(RawEntry {
            old_mode: old_mode.to_string(),
            new_mode: new_mode.to_string(),
            old_oid: old_oid.to_string(),
            new_oid: new_oid.to_string(),
            status,
            score,
            old_path,
            path,
        });
    }
    Ok(entries)
}

/// Parses `git diff --patch` output into one section per file.
pub fn parse_patch(out: &[u8]) -> Result<Vec<PatchSection>> {
    let mut sections = Vec::new();
    let mut current: Option<PatchSection> = None;
    let (mut old_no, mut new_no) = (0u32, 0u32);

    for raw_line in out.split(|b| *b == b'\n') {
        // Content lines always start with ' ', '+', '-' or '\', so a line starting
        // with "diff --git " or "@@ " is always a header.
        if raw_line.starts_with(b"diff --git ") {
            sections.extend(current.take());
            current = Some(PatchSection::default());
            continue;
        }
        let Some(section) = current.as_mut() else {
            continue;
        };
        if raw_line.starts_with(b"@@ ") {
            let hunk = parse_hunk_header(&String::from_utf8_lossy(raw_line))?;
            old_no = hunk.old_start;
            new_no = hunk.new_start;
            section.hunks.push(hunk);
            continue;
        }
        let Some(hunk) = section.hunks.last_mut() else {
            // Extended header lines (index, mode, rename from/to, ---/+++).
            if raw_line.starts_with(b"Binary files ") || raw_line == b"GIT binary patch" {
                section.binary = true;
            }
            continue;
        };

        let Some(&marker) = raw_line.first() else {
            continue;
        };
        let content = || {
            let text = String::from_utf8_lossy(&raw_line[1..]);
            text.strip_suffix('\r').unwrap_or(&text).to_string()
        };
        let line = match marker {
            b' ' => {
                let line = Line {
                    kind: LineKind::Context,
                    old_no: Some(old_no),
                    new_no: Some(new_no),
                    content: content(),
                    no_newline: false,
                };
                old_no += 1;
                new_no += 1;
                line
            }
            b'-' => {
                let line = Line {
                    kind: LineKind::Del,
                    old_no: Some(old_no),
                    new_no: None,
                    content: content(),
                    no_newline: false,
                };
                old_no += 1;
                line
            }
            b'+' => {
                let line = Line {
                    kind: LineKind::Add,
                    old_no: None,
                    new_no: Some(new_no),
                    content: content(),
                    no_newline: false,
                };
                new_no += 1;
                line
            }
            b'\\' => {
                if let Some(last) = hunk.lines.last_mut() {
                    last.no_newline = true;
                }
                continue;
            }
            _ => continue,
        };
        hunk.lines.push(line);
    }
    sections.extend(current);
    Ok(sections)
}

fn parse_hunk_header(line: &str) -> Result<Hunk> {
    let invalid = || Error::Parse(format!("{}: {line}", tr("cabeçalho de hunk inválido", "invalid hunk header")));
    let rest = line.strip_prefix("@@ ").ok_or_else(invalid)?;
    let end = rest.find(" @@").ok_or_else(invalid)?;
    let section = rest[end + 3..].trim_start().to_string();

    let mut ranges = rest[..end].split(' ');
    let old = ranges.next().and_then(|r| r.strip_prefix('-'));
    let new = ranges.next().and_then(|r| r.strip_prefix('+'));
    let (Some((old_start, old_lines)), Some((new_start, new_lines))) =
        (old.and_then(parse_range), new.and_then(parse_range))
    else {
        return Err(invalid());
    };

    Ok(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        section,
        lines: Vec::new(),
    })
}

/// "12,3" -> (12, 3); "12" -> (12, 1).
fn parse_range(range: &str) -> Option<(u32, u32)> {
    match range.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

pub fn build(raw: Vec<RawEntry>, patch: Vec<PatchSection>) -> Result<Vec<FileDiff>> {
    if raw.len() != patch.len() {
        let (lista, patch_n) = (raw.len(), patch.len());
        return Err(Error::Parse(if crate::idioma::portugues() {
            format!("{lista} arquivos na lista, mas {patch_n} no patch")
        } else {
            format!("{lista} files in the list, but {patch_n} in the patch")
        }));
    }

    let oid = |id: String| (!id.bytes().all(|b| b == b'0')).then_some(id);

    Ok(raw
        .into_iter()
        .zip(patch)
        .map(|(entry, section)| {
            let status = match entry.status {
                'A' => FileStatus::Added,
                'D' => FileStatus::Deleted,
                'R' => FileStatus::Renamed,
                'C' => FileStatus::Copied,
                'T' => FileStatus::TypeChanged,
                _ => FileStatus::Modified,
            };
            let lines = section.hunks.iter().flat_map(|h| &h.lines);
            let additions = lines.clone().filter(|l| l.kind == LineKind::Add).count() as u32;
            let deletions = lines.filter(|l| l.kind == LineKind::Del).count() as u32;
            let fingerprint = format!(
                "{}:{}:{}:{}:{}",
                entry.old_path, entry.old_oid, entry.new_oid, entry.old_mode, entry.new_mode
            );
            let renamed = matches!(status, FileStatus::Renamed | FileStatus::Copied);

            FileDiff {
                submodule: entry.old_mode == "160000" || entry.new_mode == "160000",
                old_path: renamed.then_some(entry.old_path),
                path: entry.path,
                status,
                similarity: entry.score.filter(|_| renamed),
                old_mode: entry.old_mode,
                new_mode: entry.new_mode,
                old_oid: oid(entry.old_oid),
                new_oid: oid(entry.new_oid),
                binary: section.binary,
                additions,
                deletions,
                fingerprint,
                staged: None,
                hunks: section.hunks,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_raw_entries_including_renames() {
        let out = b":100644 100644 aaa bbb M\0src/a.rs\0:100644 100644 ccc ccc R100\0old name.txt\0new name.txt\0";
        let entries = parse_raw(out).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[0].status, 'M');
        assert_eq!(entries[1].status, 'R');
        assert_eq!(entries[1].score, Some(100));
        assert_eq!(entries[1].old_path, "old name.txt");
        assert_eq!(entries[1].path, "new name.txt");
    }

    #[test]
    fn parses_hunks_with_line_numbers() {
        let patch = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@ fn main()\n keep\n-old\n+new\n+diff --git looks like a header\n@@ -10 +11,0 @@\n-gone\n\\ No newline at end of file\n";
        let sections = parse_patch(patch).unwrap();
        assert_eq!(sections.len(), 1);
        let hunks = &sections[0].hunks;
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].section, "fn main()");

        let lines = &hunks[0].lines;
        assert_eq!(lines.len(), 4);
        assert_eq!((lines[0].old_no, lines[0].new_no), (Some(1), Some(1)));
        assert_eq!((lines[1].kind, lines[1].old_no), (LineKind::Del, Some(2)));
        assert_eq!((lines[2].kind, lines[2].new_no), (LineKind::Add, Some(2)));
        assert_eq!(lines[3].content, "diff --git looks like a header");

        assert_eq!((hunks[1].old_start, hunks[1].old_lines), (10, 1));
        assert_eq!((hunks[1].new_start, hunks[1].new_lines), (11, 0));
        assert!(hunks[1].lines[0].no_newline);
    }

    #[test]
    fn detects_binary_sections() {
        let patch = b"diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n";
        let sections = parse_patch(patch).unwrap();
        assert!(sections[0].binary);
        assert!(sections[0].hunks.is_empty());
    }
}
