import { describe, expect, it } from "vitest";
import { markdown, markOnLine, readableJson } from "./markdown";

describe("markdown", () => {
  it("with origin, each block carries the source lines it came from", () => {
    const md = "# T\n\nlinha um\nlinha dois\n\n- a\n  cont\n- b\n\n```\nx\n```\n\n| a |\n|---|\n| 1 |";
    expect(markdown(md, 0, undefined, true)).toBe(
      '<h1 data-from="1" data-to="1">T</h1>' +
        '<p data-from="3" data-to="4">linha um<br>linha dois</p>' +
        '<ul data-from="6" data-to="8"><li data-from="6" data-to="7">a<br>cont</li><li data-from="8" data-to="8">b</li></ul>' +
        '<pre data-from="10" data-to="12"><code>x</code></pre>' +
        '<table data-from="14" data-to="16"><thead><tr data-from="14" data-to="15"><th>a</th></tr></thead><tbody><tr data-from="16" data-to="16"><td>1</td></tr></tbody></table>',
    );
  });
  it("escapes what comes in", () => {
    expect(markdown("<b>oi</b>")).toBe("<p>&lt;b&gt;oi&lt;/b&gt;</p>");
  });

  it("doesn't format inside code", () => {
    expect(markdown("use `**x**` e **y**")).toBe("<p>use <code>**x**</code> e <strong>y</strong></p>");
    expect(markdown("```ts\na < b\n```")).toBe("<pre><code>a &lt; b</code></pre>");
    expect(markdown("```mermaid\na --> b\n```")).toBe('<pre class="mermaid"><code>a --&gt; b</code></pre>');
  });

  it("closes bold that has code in the middle", () => {
    expect(markdown("- **Os `GET` ficaram.** Às 14h")).toBe(
      "<ul><li><strong>Os <code>GET</code> ficaram.</strong> Às 14h</li></ul>",
    );
  });

  it("builds lists, headings and tables", () => {
    expect(markdown("## T\n- a\n- b")).toBe("<h4>T</h4><ul><li>a</li><li>b</li></ul>");
    expect(markdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("checkboxes only where asked, with the item's line to mark", () => {
    const md = "# Plan\n- [ ] a\n- [x] **b**\n- c";
    expect(markdown(md, 0)).toContain("<li>[ ] a</li>");
    expect(markdown(md, 0, "mark")).toBe(
      '<h1>Plan</h1><ul><li><input type="checkbox" class="task" data-line="1">a</li>' +
        '<li><input type="checkbox" class="task" checked data-line="2"><strong>b</strong></li><li>c</li></ul>',
    );
    expect(markdown("- [X] a", 0, "view")).toBe('<ul><li><input type="checkbox" class="task" checked disabled>a</li></ul>');
  });

  it("checkboxes in table cells, with line and column", () => {
    const md = "| done | item |\n|---|---|\n| [x] | a |\n| [ ] b | [x] |";
    expect(markdown(md, 0)).toContain("<td>[x]</td>");
    expect(markdown(md, 0, "mark")).toBe(
      "<table><thead><tr><th>done</th><th>item</th></tr></thead><tbody>" +
        '<tr><td><input type="checkbox" class="task" checked data-line="2" data-column="0"></td><td>a</td></tr>' +
        '<tr><td><input type="checkbox" class="task" data-line="3" data-column="0">b</td>' +
        '<td><input type="checkbox" class="task" checked data-line="3" data-column="1"></td></tr></tbody></table>',
    );
    expect(markdown(md, 0, "view")).toContain('<td><input type="checkbox" class="task" checked disabled></td>');
  });

  it("flips the right checkbox on the source line", () => {
    expect(markOnLine("  - [ ] a", true)).toBe("  - [x] a");
    expect(markOnLine("| [ ] b | [x] |", true, 0)).toBe("| [x] b | [x] |");
    expect(markOnLine("| [ ] b | [x] |", false, 1)).toBe("| [ ] b | [ ] |");
    expect(markOnLine("[ ] b | [x]", false, 1)).toBe("[ ] b | [ ]");
  });

  it("only links http", () => {
    expect(markdown("[x](javascript:alert(1))")).not.toContain("<a");
    expect(markdown("[x](https://a.b/c)")).toBe('<p><a href="https://a.b/c">x</a></p>');
  });

  it("links a bare URL, without the sentence's punctuation", () => {
    expect(markdown("open https://a.b/c?x=1&y=2.")).toBe(
      '<p>open <a href="https://a.b/c?x=1&amp;y=2">https://a.b/c?x=1&amp;y=2</a>.</p>',
    );
    expect(markdown("(see https://a.b/c)")).toBe('<p>(see <a href="https://a.b/c">https://a.b/c</a>)</p>');
    expect(markdown("https://w.org/Foo_(bar), ok")).toBe('<p><a href="https://w.org/Foo_(bar)">https://w.org/Foo_(bar)</a>, ok</p>');
    expect(markdown("[x](https://a.b/c) https://d.e")).toBe(
      '<p><a href="https://a.b/c">x</a> <a href="https://d.e">https://d.e</a></p>',
    );
    expect(markdown("`https://a.b/c`")).toBe("<p><code>https://a.b/c</code></p>");
  });
});

describe("readableJson", () => {
  it("expands single-line JSON", () => {
    expect(readableJson('{"type":"x","data":{"ok":true}}')).toBe('{\n  "type": "x",\n  "data": {\n    "ok": true\n  }\n}');
  });

  it("leaves alone what isn't JSON or already has line breaks", () => {
    expect(readableJson('{"a": 1, …}')).toBe('{"a": 1, …}');
    expect(readableJson("npm run build")).toBe("npm run build");
    expect(readableJson('{\n"a":1}')).toBe('{\n"a":1}');
  });

  it("works inside a markdown code block", () => {
    expect(markdown('```json\n{"a":[1]}\n```')).toContain("{\n  &quot;a&quot;: [\n    1\n  ]\n}");
  });
});
