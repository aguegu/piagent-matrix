import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, escapeHtml } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders fenced code with a language class", () => {
    const html = renderMarkdown("```bash\ndf -h /\n```");
    assert.match(html, /<pre><code class="language-bash">/);
    assert.match(html, /df -h \//);
  });

  it("does not apply markdown inside code", () => {
    // Underscores in a shell command must survive verbatim, not become <em>.
    const html = renderMarkdown("```bash\ngrep _x_ file\n```");
    assert.match(html, /grep _x_ file/);
    assert.doesNotMatch(html, /<em>/);
  });

  it("renders lists and inline formatting", () => {
    const html = renderMarkdown("- one\n- **two**\n- `three`");
    assert.match(html, /<ul>/);
    assert.match(html, /<strong>two<\/strong>/);
    assert.match(html, /<code>three<\/code>/);
  });

  it("escapes raw HTML rather than passing it through", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("neutralises an event-handler image", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    // The text may still be visible, but only as escaped content: what matters
    // is that no <img> tag and no live attribute reach the client.
    assert.doesNotMatch(html, /<img/i, "no real img element");
    assert.match(html, /&lt;img/, "escaped to text instead");
  });

  it("refuses javascript: links but keeps https ones", () => {
    const html = renderMarkdown("[bad](javascript:alert(1)) [good](https://example.org)");
    // markdown-it declines to linkify the unsafe scheme, so it stays as plain
    // text. The requirement is that nothing is *linked* to it.
    assert.doesNotMatch(html, /href\s*=\s*"javascript:/i, "never an href");
    assert.doesNotMatch(html, /<a[^>]*javascript:/i, "no anchor carrying it at all");
    assert.match(html, /href="https:\/\/example\.org"/, "safe links still work");
  });

  it("marks links safe to open", () => {
    const html = renderMarkdown("[ok](https://example.org)");
    assert.match(html, /rel="noopener noreferrer nofollow"/);
    assert.match(html, /target="_blank"/);
  });

  it("returns empty string for empty input", () => {
    assert.equal(renderMarkdown(""), "");
    assert.equal(renderMarkdown(undefined), "");
  });
});

describe("escapeHtml", () => {
  it("escapes the characters that would break out of a tag", () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
