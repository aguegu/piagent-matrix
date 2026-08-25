// Render Markdown to safe HTML for Matrix messages.
//
// Matrix supports a subset of HTML inside m.text/html formatted bodies.
// We render with markdown-it, then sanitize with DOMPurify (jsdom-backed),
// then normalize the tag whitelist to what Matrix clients reliably render.

import MarkdownIt from "markdown-it";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const md = new MarkdownIt({
  html: false,        // disallow raw HTML in source
  linkify: true,
  breaks: true,       // single \n -> <br>
  typographer: false, // avoid smart quotes that look weird in some clients
});

// Custom fence renderer: send code blocks as <pre><code class="language-x">…</code></pre>
// Matrix doesn't render fenced code with syntax highlighting by default,
// but class names are preserved for clients that do.
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info ? md.utils.escapeHtml(t.info) : "";
  const code = md.utils.escapeHtml(t.content);
  return `<pre><code class="language-${lang}">${code}</code></pre>\n`;
};

// Tags Matrix clients actually render reliably.
const ALLOWED_TAGS = [
  "b", "i", "em", "strong", "u", "s", "del", "ins",
  "code", "pre", "blockquote",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "a", "img", "span",
];

const ALLOWED_ATTR = ["href", "title", "alt", "src", "class"];

// Hook to force all links to open safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer nofollow");
    node.setAttribute("target", "_blank");
  }
  // Block any non-https images to avoid tracking pixels.
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") || "";
    if (!/^https?:\/\//.test(src)) node.removeAttribute("src");
  }
});

export function renderMarkdown(source) {
  if (!source) return "";
  const html = md.render(source);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    USE_PROFILES: { html: true },
  });
  return clean.trim();
}

// Convert plain text only (e.g. error messages) to minimal HTML.
// Escapes everything and converts newlines to <br>.
export function plainToHtml(text) {
  return DOMPurify.sanitize(String(text), {
    ALLOWED_TAGS: ["br", "p"],
    ALLOWED_ATTR: [],
  }).replace(/\n/g, "<br>");
}
