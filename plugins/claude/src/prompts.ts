/// What you sent to Claude, found on the terminal screen to highlight it. No DOM or
/// xterm here: that is what makes it testable.

/// The marker Claude Code puts in front of what you sent. It changed from one
/// version to another, so every one it has used counts.
const SINAL = /^\s*[>❯›〉]\s+/;
/// How many characters from the start of the prompt are enough to recognize the line. The
/// screen wraps the text at the panel width, so only the start is comparable.
const START = 24;
/// A pasted prompt may have hundreds of lines; the highlight doesn't go that far.
const MAX_HEIGHT = 12;

const compactMode = (s: string) => s.replace(/\s+/g, " ").trim();

/// Where, among the screen lines, the prompts you sent are: the line where
/// each one starts and how many it takes (up to the first blank one).
///
/// Only matches a known prompt, not any line starting with the
/// marker: a quote in Claude's answer starts with `>` too.
export function promptLines(screen: string[], prompts: string[]): { line: number; height: number }[] {
  const starts = new Set<string>();
  for (const p of prompts) {
    const c = compactMode(p.split("\n").find((l) => l.trim()) ?? "").slice(0, START);
    if (c) starts.add(c);
  }
  if (!starts.size) return [];

  const findings: { line: number; height: number }[] = [];
  for (let i = 0; i < screen.length; i++) {
    const sinal = SINAL.exec(screen[i]);
    if (!sinal) continue;
    const rest = compactMode(screen[i].slice(sinal[0].length));
    let matched = false;
    for (const c of starts) {
      // The line may be shorter than the stored start: the panel is narrow
      // and the wrap came earlier. Then it is the whole line that must match.
      if (rest.startsWith(c) || (rest.length >= 8 && c.startsWith(rest))) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    let height = 1;
    while (height < MAX_HEIGHT && (screen[i + height] ?? "").trim() && !SINAL.test(screen[i + height])) height++;
    findings.push({ line: i, height });
    i += height - 1;
  }
  return findings;
}
