import sanitizeHtml from "sanitize-html";

export function sanitizeEmailHtml(html: string): string | undefined {
  if (!html) return undefined;
  return sanitizeHtml(html, {
    allowedTags: [
      "a", "abbr", "b", "blockquote", "br", "caption", "code", "div", "em", "h1", "h2", "h3", "h4",
      "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td",
      "th", "thead", "tr", "u", "ul",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https", "mailto"],
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { href: attributes.href ?? "#", rel: "noreferrer noopener", target: "_blank" },
      }),
    },
  });
}
