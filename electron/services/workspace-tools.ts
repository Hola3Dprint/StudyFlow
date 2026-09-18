import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { viewDocument } from "./document-visuals";

const cropInput = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(crop => crop.x + crop.width <= 1 && crop.y + crop.height <= 1, "Crop must fit inside the page or image.");
const input = z.object({ action: z.enum(["list", "read", "search", "view", "office_xml", "source_ledger"]), path: z.string().max(4096).default("."), page: z.number().int().min(1).default(1), crop: cropInput.optional(), query: z.string().max(1000).optional(), offset: z.number().int().min(0).default(0), text: z.string().max(100000).optional() });
export const WORKSPACE_TOOLS = [{ type: "function", name: "studyflow_documents", description: "Access only this assignment workspace. list returns file names; read returns up to 24000 characters at offset; search finds literal text in a file (query required); view returns an actual image of a PDF page (page is 1-based) or PNG/JPEG/WebP/GIF/BMP. Optional crop uses normalized x,y,width,height from 0 to 1 to zoom diagram labels. Use view for figures, scanned questions and PDF layout; text extraction omits visual information. office_xml lists XML parts in a DOCX/PPTX/XLSX or reads the exact part named in query; source_ledger replaces source-ledger.md with text. Start with assignment-materials.json and materials/course/INDEX.md.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "read", "search", "view", "office_xml", "source_ledger"] }, path: { type: "string" }, page: { type: "integer", minimum: 1 }, crop: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 } }, required: ["x", "y", "width", "height"], additionalProperties: false }, query: { type: "string" }, offset: { type: "integer", minimum: 0 }, text: { type: "string" } }, required: ["action"], additionalProperties: false } }];

WORKSPACE_TOOLS.push({ type: "function", name: "studyflow_calculate", description: "Verify scalar arithmetic locally and record expression, variables and result in calculations.json. Supports + - * / ^, sqrt, abs, sin/cos/tan, asin/acos/atan, log, exp, round, min/max. Angles are radians. No code execution or network.", inputSchema: { type: "object", properties: { expression: { type: "string" }, variables: { type: "object", additionalProperties: { type: "number" } }, label: { type: "string" } }, required: ["expression"], additionalProperties: false } } as unknown as typeof WORKSPACE_TOOLS[number]);

export class WorkspaceTools {
  constructor(private readonly workspace: string, private readonly signal: AbortSignal) {}

  private async file(relative: string): Promise<string> {
    if (this.signal.aborted) throw new DOMException("AI run cancelled", "AbortError");
    if (path.isAbsolute(relative) || relative.includes(":") || relative.split(/[\\/]/).includes("..")) throw new Error("Only relative assignment-workspace paths are allowed.");
    const root = await realpath(this.workspace);
    const target = path.resolve(root, relative);
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Links are not allowed in assignment tools.");
    }
    const actual = await realpath(target);
    const delta = path.relative(root, actual);
    if (delta.startsWith("..") || path.isAbsolute(delta)) throw new Error("File is outside this assignment workspace.");
    return actual;
  }

  async call(tool: string, args: unknown): Promise<Record<string, unknown>> {
    try {
      if (tool === "studyflow_calculate") {
        const root = await this.file(".");
        const { calculate } = await import("./calculator");
        const result = calculate(args);
        const log = path.join(root, "calculations.json");
        let records: unknown[] = [];
        try { const safe = await this.file("calculations.json"); records = JSON.parse(await readFile(safe, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!Array.isArray(records) || records.length >= 1000) throw new Error("Calculation record limit reached.");
        records.push(result);
        await writeFile(log, JSON.stringify(records, null, 2));
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
      }
      if (tool !== "studyflow_documents") throw new Error("Unknown assignment tool.");
      const value = input.parse(args);
      const target = await this.file(value.action === "source_ledger" ? "source-ledger.md" : value.path);
      let text: string;
      if (value.action === "list") {
        const children = await readdir(target, { withFileTypes: true });
        text = JSON.stringify(children.filter(child => !child.isSymbolicLink()).slice(0, 2000).map(child => ({ name: child.name, directory: child.isDirectory() })));
      } else if (value.action === "source_ledger") {
        if (!value.text) throw new Error("Provide the full verified source ledger in text.");
        await writeFile(target, value.text);
        text = "Source ledger updated.";
      } else {
        const info = await lstat(target);
        if (value.action === "view") {
          if (!info.isFile() || info.size > 250 * 1024 * 1024) throw new Error("Visual file exceeds the 250 MB safety limit.");
          const visual = await viewDocument(target, value.page, this.signal, value.crop);
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ path: value.path, page: value.page, totalPages: visual.pages, width: visual.width, height: visual.height, crop: value.crop ?? null }) }, { type: "inputImage", imageUrl: visual.imageUrl }] };
        }
        if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error("Use the indexed extracted text for this large or non-text material.");
        let contents: string;
        if (value.action === "office_xml") {
          const zip = await JSZip.loadAsync(await readFile(target));
          if (!value.query) contents = JSON.stringify(Object.keys(zip.files).filter(name => name.endsWith(".xml")));
          else { const part = zip.file(value.query); if (!part) throw new Error("XML part not found."); contents = await part.async("string"); }
        } else {
          if (!/\.(md|txt|csv|json|tex|html?|xml|py|js|ts|css)$/i.test(target)) throw new Error("Read its indexed extracted text, or office_xml for Office files. Binary documents cannot be read as plain text.");
          contents = await readFile(target, "utf8");
        }
        if (value.action === "search") {
          if (!value.query) throw new Error("A literal search query is required.");
          contents = contents.split("\n").flatMap((line, index) => line.toLowerCase().includes(value.query!.toLowerCase()) ? [`${index + 1}: ${line}`] : []).join("\n");
        }
        text = JSON.stringify({ totalCharacters: contents.length, offset: value.offset, text: contents.slice(value.offset, value.offset + 24000), more: contents.length > value.offset + 24000 });
      }
      return { success: true, contentItems: [{ type: "inputText", text }] };
    } catch (error) {
      // Avoid exposing absolute host paths or arbitrary filesystem errors.
      const message = error instanceof Error && !/ENOENT|EACCES|EPERM|ENOTDIR/.test(error.message) ? error.message : "File unavailable inside the assignment workspace. Check list or the course index.";
      return { success: false, contentItems: [{ type: "inputText", text: message }] };
    }
  }
}
