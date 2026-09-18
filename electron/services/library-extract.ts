import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { chunks } from "./library-core";
import { viewDocument, IMAGE_EXTENSION } from "./document-visuals";
import { markdownFromHtml } from "./utils";

export interface ExtractedPassage { text: string; location: string; image?: string; warning?: string; confidence?: number }
const require = createRequire(import.meta.url);
export class LibraryExtractor {
  private ocr?: Worker;
  async close() { await this.ocr?.terminate(); this.ocr = undefined; }
  private async recognize(image: string) {
    const data = require("@tesseract.js-data/eng") as { langPath: string };
    this.ocr ??= await createWorker("eng", OEM.LSTM_ONLY, { langPath: data.langPath, cacheMethod: "none", gzip: true });
    const result = await this.ocr.recognize(image);
    return { text: result.data.text, confidence: result.data.confidence };
  }
  async extract(file: string, destination: string, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<ExtractedPassage[]> {
    const bytes = await readFile(file);
    const extension = path.extname(file).toLowerCase();
    const out: ExtractedPassage[] = [];
    await mkdir(destination, { recursive: true });
    const visual = async (imageUrl: string, location: string, text: string, index: number) => {
      await checkpoint(); signal.throwIfAborted();
      const image = path.join(destination, `${index}.png`);
      await writeFile(image, Buffer.from(imageUrl.split(",")[1], "base64"));
      let warning: string | undefined, confidence: number | undefined;
      if (text.trim().length < 80) {
        try { const result = await this.recognize(image); text = [...new Set([text.trim(), result.text.trim()].filter(Boolean))].join("\n"); confidence = result.confidence; warning = "OCR text may omit handwriting, equations or diagram details. Inspect the original."; }
        catch { warning = "OCR unavailable. Inspect original image; labels are not text-searchable."; }
      }
      out.push({ image, location, text: text.slice(0, 24000), warning, confidence });
      for (const part of chunks(text)) out.push({ ...part, location, warning, confidence });
    };
    if (extension === ".pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
      try {
        const pdf = await task.promise;
        for (let page = 1; page <= pdf.numPages; page++) {
          await checkpoint(); signal.throwIfAborted();
          const content = await (await pdf.getPage(page)).getTextContent();
          const text = content.items.map(item => "str" in item ? item.str : "").join(" ");
          const image = await viewDocument(file, page, signal);
          await visual(image.imageUrl, `Page ${page}`, text, page);
        }
      } finally { await task.destroy(); }
    } else if (IMAGE_EXTENSION.test(file)) {
      await visual((await viewDocument(file, 1, signal)).imageUrl, "Image", "", 1);
    } else if ([".docx", ".pptx", ".xlsx"].includes(extension)) {
      const zip = await JSZip.loadAsync(bytes);
      for (const part of Object.values(zip.files).sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        await checkpoint();
        if (/^(word\/document|ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)|xl\/(sharedStrings|worksheets\/sheet\d+))\.xml$/.test(part.name)) {
          const xml = await part.async("string");
          if (xml.length > 2_000_000) throw new Error("Office text part exceeds extraction limit.");
          const text = xml.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
          out.push(...chunks(text).map(chunk => ({ ...chunk, location: part.name })));
        } else if (/^(word|ppt|xl)\/media\//.test(part.name) && IMAGE_EXTENSION.test(part.name)) {
          const data = await part.async("nodebuffer");
          if (data.length > 25 * 1024 * 1024) continue;
          const image = path.join(destination, `embedded-${out.length}${path.extname(part.name)}`);
          await writeFile(image, data);
          await visual((await viewDocument(image, 1, signal)).imageUrl, `Embedded image: ${part.name}`, "", out.length + 1);
        }
      }
    } else if (/\.(txt|md|csv|json|tex|html?|xml)$/i.test(file)) {
      if (bytes.length > 2_000_000) throw new Error("Text exceeds the 2 MB extraction limit; original retained.");
      const text = /\.html?$/i.test(file) ? markdownFromHtml(bytes.toString("utf8")) : bytes.toString("utf8");
      out.push(...chunks(text));
    }
    if (!out.length) out.push({ text: path.basename(file), location: "Document", warning: "No extractable text. Open the original." });
    return out;
  }
}
