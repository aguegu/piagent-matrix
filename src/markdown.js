// Markdown -> HTML for Matrix formatted_body.
//
// Agent replies are markdown: code fences, lists, bold, links. Sent as a plain
// body they render literally, which is unreadable for anything containing code.
//
// Two layers of defence, because agent output is not trusted input — it can
// echo back whatever a tool read off disk:
//   1. markdown-it runs with html:false, so raw HTML in the source is escaped
//      rather than passed through.
//   2. the result is sanitized down to the tag set Matrix clients actually
//      render, so anything exotic that slips through is dropped.
//
// v1 used DOMPurify for step 2, which drags in jsdom. sanitize-html does the
// same job here and is already in the tree as a matrix-bot-sdk dependency.

import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const md = new MarkdownIt({
  html: false, // never trust raw HTML in agent output
  linkify: true,
  breaks: true, // a single newline is a line break, which is what chat implies
  typographer: false, // smart quotes look wrong inside code-ish text
});

// Matrix doesn't highlight fenced code itself, but the language class is
// preserved for clients that do.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info ? md.utils.escapeHtml(token.info.trim().split(/\s+/)[0]) : "";
  const code = md.utils.escapeHtml(token.content);
  return `<pre><code${lang ? ` class="language-${lang}"` : ""}>${code}</code></pre>\n`;
};

// The subset of https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes
// that clients render dependably.
const ALLOWED_TAGS = [
  "b", "i", "em", "strong", "u", "s", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "a", "span", "sub", "sup",
  "table", "thead", "tbody", "tr", "th", "td", "caption",
];

/** Render markdown to sanitized HTML suitable for formatted_body. */
export function renderMarkdown(source) {
  if (!source) return "";
  return sanitizeHtml(md.render(source), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      // rel/target are set by transformTags below; they must be allowed here
      // too, or the attribute filter strips them straight back off.
      a: ["href", "title", "rel", "target"],
      code: ["class"],
      span: ["data-mx-color", "data-mx-bg-color"],
      ol: ["start"],
    },
    // No data:/javascript: URIs — mxc is how Matrix references its own media.
    allowedSchemes: ["https", "http", "mxc", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
    },
  }).trim();
}

/** Escape text for literal inclusion in HTML. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
