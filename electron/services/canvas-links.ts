import sanitizeHtml from "sanitize-html";

export interface CanvasFileLink { id: string; url: string }

/** Parse attributes as HTML, not regex, so Canvas's encoded and relative links work. */
export function canvasFileLinks(html: string, origin: string, courseId: string): CanvasFileLink[] {
  const links = new Map<string, CanvasFileLink>();
  const collect = (value?: string) => {
    if (!value) return;
    try {
      const url = new URL(value, `${origin}/courses/${encodeURIComponent(courseId)}/`);
      if (url.origin !== origin || url.username || url.password) return;
      const match = url.pathname.match(/^\/(?:api\/v1\/)?(?:courses\/(\d+)\/)?files(?:\/(\d+)(?:\/(?:download|preview))?)?\/?$/);
      if (!match || (match[1] && match[1] !== courseId)) return;
      const id = match[2] ?? url.searchParams.get("preview");
      if (!id || !/^\d+$/.test(id)) return;
      links.set(id, { id, url: `${origin}/courses/${courseId}/files/${id}` });
    } catch { /* Malformed and non-Canvas links are not download targets. */ }
  };
  sanitizeHtml(html, {
    transformTags: {
      a: (tagName, attribs) => { collect(attribs.href); collect(attribs["data-api-endpoint"]); return { tagName, attribs }; },
      img: (tagName, attribs) => { collect(attribs.src); collect(attribs["data-api-endpoint"]); return { tagName, attribs }; },
    },
  });
  return [...links.values()];
}
