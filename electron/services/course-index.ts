import { readdir, readFile, writeFile, stat, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { markdownFromHtml, resolveInside } from "./utils";
import { IMAGE_EXTENSION } from "./document-visuals";

export interface IndexedMaterial { id: string; path: string; size: number; checksum: string; textPath?: string; excerpt: string; status: string; visual?: { kind: "pdf" | "image"; pages?: number } }

export async function indexCourse(root: string, destination: string, includePaths?: Set<string>): Promise<IndexedMaterial[]> {
  await mkdir(destination, { recursive: true });
  const entries: IndexedMaterial[] = [];
  const walk = async (folder: string): Promise<void> => {
    const children = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const source = resolveInside(folder, child.name);
      if (child.isDirectory()) { await walk(source); continue; }
      if (!child.isFile() || child.name.endsWith(".partial")) continue;
      const relative = path.relative(root, source);
      if (includePaths && !includePaths.has(path.resolve(source))) continue;
      const size = (await stat(source)).size;
      if (size > 250 * 1024 * 1024) continue;
      const bytes = await readFile(source);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const id = createHash("sha256").update(relative).digest("hex").slice(0, 16);
      const copied = resolveInside(destination, "files", ...relative.split(path.sep));
      await mkdir(path.dirname(copied), { recursive: true });
      await cp(source, copied);
      let text = "";
      let visual: IndexedMaterial["visual"] = IMAGE_EXTENSION.test(relative) ? { kind: "image", pages: 1 } : /\.pdf$/i.test(relative) ? { kind: "pdf" } : undefined;
      let status = "File available; text extraction unavailable. Read the original with an appropriate tool; do not assume its contents.";
      try {
        const extension = path.extname(relative).toLowerCase();
        if (/^\.(md|txt|csv|json|tex|html?|xml)$/.test(extension)) text = /html?/.test(extension) ? markdownFromHtml(bytes.toString("utf8")) : bytes.toString("utf8");
        if (extension === ".pdf") {
          const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
          const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
          const document = await task.promise;
          visual = { kind: "pdf", pages: document.numPages };
          try {
            for (let number = 1; number <= document.numPages && text.length < 2_000_000; number += 1) {
              const page = await document.getPage(number);
              const content = await page.getTextContent();
              text += `\n[Page ${number}]\n` + content.items.map(item => "str" in item ? item.str : "").join(" ");
            }
          } finally { await task.destroy(); }
          if (!text.replace(/\[Page \d+\]/g, "").trim()) { text = ""; status = "Scanned PDF; use view to read page images"; }
        }
        if ([".docx", ".pptx", ".xlsx"].includes(extension)) {
          const zip = await JSZip.loadAsync(bytes);
          const parts = Object.values(zip.files).filter(file => /^(word\/document|ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)|xl\/(sharedStrings|worksheets\/sheet\d+))\.xml$/.test(file.name)).sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
          const texts: string[] = [];
          for (const part of parts) {
            if (texts.join("").length > 2_000_000) break;
            texts.push(`\n[${part.name}]\n${(await part.async("string")).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ")}`);
          }
          text = texts.join("\n");
        }
        if (text) status = text.length > 2_000_000 ? "Text truncated; original retained" : "Text indexed";
      } catch { status = "Extraction failed; original retained"; }
      if (visual) status += "; use studyflow_documents view for diagrams and page images";
      const textPath = text ? `text/${id}.txt` : undefined;
      if (textPath) { await mkdir(resolveInside(destination, "text"), { recursive: true }); await writeFile(resolveInside(destination, "text", `${id}.txt`), text.slice(0, 2_000_000)); }
      entries.push({ id, path: `files/${relative.replaceAll("\\", "/")}`, size, checksum, textPath, excerpt: text.slice(0, 600), status, visual });
    }
  };
  await walk(root);
  await writeFile(resolveInside(destination, "index.json"), JSON.stringify(entries, null, 2));
  await writeFile(resolveInside(destination, "INDEX.md"), ["# Course material index", "Search index.json for names and excerpts; search text/ for full extracted contents. Cite file IDs plus page/slide/section locators. Module JSON preserves ordering and links. Unsupported documents require reading the original; report gaps.", ...entries.map(entry => `- ${entry.id} | ${entry.path} | ${entry.textPath ?? "original only"} | ${entry.status}\n  ${entry.excerpt.replaceAll("\n", " ")}`)].join("\n"));
  return entries;
}
