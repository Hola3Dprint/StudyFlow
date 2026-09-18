import { readFile } from "node:fs/promises";

export interface VisualCrop { x: number; y: number; width: number; height: number }
export const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** The caller must validate the real workspace path before invoking this renderer. */
export async function viewDocument(file: string, pageNumber: number, signal: AbortSignal, crop?: VisualCrop): Promise<{ imageUrl: string; pages: number; width: number; height: number }> {
  signal.throwIfAborted();
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const bytes = await readFile(file);
  let source;
  let pages = 1;
  if (/\.pdf$/i.test(file)) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const abort = () => { void task.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    try {
      const document = await task.promise;
      pages = document.numPages;
      if (pageNumber > pages) throw new Error(`This PDF has ${pages} pages. Use a page from 1 to ${pages}.`);
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      // Bound memory; a crop can request a higher resolution for small diagram labels.
      const scale = Math.min((crop ? 4000 : 2400) / Math.max(base.width, base.height), 4);
      const viewport = page.getViewport({ scale });
      source = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = source.getContext("2d");
      await page.render({ canvas: source as never, canvasContext: context as never, viewport }).promise;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); await task.destroy(); }
  } else if (IMAGE_EXTENSION.test(file)) {
    if (pageNumber !== 1) throw new Error("Use page 1 for a standalone image.");
    source = await loadImage(bytes);
    if (source.width * source.height > 40_000_000) throw new Error("Image exceeds the 40-megapixel visual safety limit.");
  } else throw new Error("Visual access supports PDF pages and PNG, JPEG, WebP, GIF or BMP images.");
  signal.throwIfAborted();
  const region = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const sx = Math.floor(source.width * region.x), sy = Math.floor(source.height * region.y);
  const sw = Math.max(1, Math.floor(source.width * region.width)), sh = Math.max(1, Math.floor(source.height * region.height));
  const ratio = Math.min(1, 2400 / Math.max(sw, sh));
  const output = createCanvas(Math.max(1, Math.round(sw * ratio)), Math.max(1, Math.round(sh * ratio)));
  const context = output.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, output.width, output.height);
  const png = await output.encode("png");
  signal.throwIfAborted();
  if (png.byteLength > 12 * 1024 * 1024) throw new Error("Rendered image is too large. Request a smaller crop.");
  return { imageUrl: `data:image/png;base64,${png.toString("base64")}`, pages, width: output.width, height: output.height };
}
