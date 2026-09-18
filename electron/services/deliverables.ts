import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, ImportedXmlComponent, Packer, Paragraph, TextRun, AlignmentType } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { escapeTex, protectEquations, renderEquation, type EquationPart } from "./equations";
import { marked, type Token } from "marked";
import pptxgen from "pptxgenjs";
import type { AssignmentBrief, DeliverableSpec, OutputArtifact } from "../../shared/types";
import { createId, ensureDirectory, resolveInside, sanitizeFileName, sha256File } from "./utils";

interface GenerateDeliverablesInput {
  workspacePath: string;
  assignmentId: string;
  title: string;
  draft: string;
  brief: AssignmentBrief;
  specs: DeliverableSpec[];
  sourceLedger: string;
}

function inlineText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === "br") return "\n";
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

function documentBlocks(markdown: string): Array<{ text: string; heading?: number }> {
  return marked.lexer(markdown).flatMap(token => {
    if (token.type === "space") return [];
    if (token.type === "heading") return [{ text: inlineText(token.tokens ?? []), heading: token.depth }];
    if (token.type === "list") return token.items.map((item: { text: string }) => ({ text: "- " + plainText(item.text) }));
    if (token.type === "blockquote") return documentBlocks(token.text);
    if (token.type === "table") return [{ text: [token.header, ...token.rows].map((row: Array<{ tokens: Token[] }>) => row.map(cell => inlineText(cell.tokens)).join(" | ")).join("\n") }];
    return [{ text: "tokens" in token && Array.isArray(token.tokens) ? inlineText(token.tokens) : "text" in token && typeof token.text === "string" ? token.text : "" }];
  }).filter(block => block.text.trim());
}

function plainText(markdown: string): string {
  const protectedMath = protectEquations(markdown);
  return protectedMath.restore(documentBlocks(protectedMath.markdown).map(block => block.text).join("\n\n").trim());
}

function mathBlocks(markdown: string): Array<{ parts: EquationPart[]; text: string; heading?: number }> {
  const protectedMath = protectEquations(markdown);
  return documentBlocks(protectedMath.markdown).map(block => ({ ...block, parts: protectedMath.parts(block.text) }));
}

function latexDocument(title: string, markdown: string): string {
  const body = mathBlocks(markdown).map(block => {
    const content = block.parts.map(part => "text" in part ? escapeTex(part.text) : `${part.display ? "\\[" : "\\("}${part.latex}${part.display ? "\\]" : "\\)"}`).join("");
    return block.heading ? `\\${block.heading === 1 ? "section" : "subsection"}*{${content}}` : content;
  }).join("\n\n");
  return `\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath,amssymb}\n\\begin{document}\n\\section*{${escapeTex(title)}}\n${body}\n\\end{document}\n`;
}

function markdownDocument(input: GenerateDeliverablesInput): string {
  const startsWithTitle = input.draft.trimStart().startsWith(`# ${input.title}\n`);
  return `${startsWithTitle ? "" : `# ${input.title}\n\n`}${input.draft.trim()}\n`;
}

async function artifactFromFile(input: GenerateDeliverablesInput, filePath: string, format: OutputArtifact["format"]): Promise<OutputArtifact> {
  const info = await import("node:fs/promises").then((fs) => fs.stat(filePath));
  return {
    id: createId("artifact"),
    assignmentId: input.assignmentId,
    name: path.basename(filePath),
    format,
    path: filePath,
    relativePath: path.relative(input.workspacePath, filePath),
    size: info.size,
    checksum: await sha256File(filePath),
    revision: 1,
    createdAt: new Date().toISOString(),
    source: "ai",
  };
}

async function writeDocx(filePath: string, title: string, markdown: string): Promise<void> {
  const blocks = mathBlocks(markdown);
  if (blocks[0]?.heading && blocks[0].text === title) blocks.shift();
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const document = new Document({ sections: [{
    properties: {},
    children: [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
      ...blocks.map(block => {
        const paragraph = new Paragraph({ heading: block.heading ? headings[Math.min(block.heading - 1, 2)] : undefined, alignment: block.parts.some(part => "latex" in part && part.display) ? AlignmentType.CENTER : undefined, spacing: { after: 160 } });
        for (const part of block.parts) {
          if ("latex" in part) {
            const imported = ImportedXmlComponent.fromXmlString(renderEquation(part).omml);
            const equation = (imported as unknown as { root: ImportedXmlComponent[] }).root[0];
            if (!equation) throw new Error("Word equation conversion failed.");
            paragraph.addChildElement(equation);
          }
          else part.text.split("\n").forEach((text, index) => paragraph.addChildElement(new TextRun({ text, break: index ? 1 : undefined })));
        }
        return paragraph;
      }),
    ],
  }] });
  await writeFile(filePath, await Packer.toBuffer(document));
}

async function writePdf(filePath: string, title: string, markdown: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ margin: 54, size: "LETTER", info: { Title: title, Author: "StudyFlow" } });
    const stream = createWriteStream(filePath);
    document.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
    document.on("error", reject);
    document.fontSize(19).fillColor("#14213d").text(title);
    const blocks = mathBlocks(markdown);
    if (blocks[0]?.heading && blocks[0].text === title) blocks.shift();
    for (const block of blocks) {
      document.moveDown(0.6).font(block.heading ? "Helvetica-Bold" : "Helvetica").fontSize(block.heading ? 14 : 11).fillColor("#222b45");
      let x = 54;
      let lineHeight = block.heading ? 20 : 17;
      const newline = () => { document.y += lineHeight; x = 54; lineHeight = block.heading ? 20 : 17; if (document.y + lineHeight > 738) document.addPage(); };
      for (const part of block.parts) {
        if ("text" in part) {
          for (const word of part.text.split(/(\s+)/)) {
            if (word.includes("\n")) { newline(); continue; }
            const width = document.widthOfString(word);
            if (x + width > 558 && x > 54) newline();
            if (x === 54 && !word.trim()) continue;
            const y = document.y;
            document.text(word, x, y, { lineBreak: false });
            document.y = y; x += width;
          }
          continue;
        }
        const equation = renderEquation(part);
        const scale = Math.min(1, 504 / equation.width);
        const height = equation.height * scale;
        if (height > 650) throw new Error("Equation is too tall for a page. Split it into smaller aligned calculation steps.");
        const width = equation.width * scale;
        if (part.display && x > 54 || x + width > 558) newline();
        if (document.y + height + 12 > 738) document.addPage();
        SVGtoPDF(document, equation.svg, part.display ? 54 + (504 - width) / 2 : x, document.y, { width, height, assumePt: true });
        lineHeight = Math.max(lineHeight, height + 6); x += width;
        if (part.display) newline();
      }
      if (x > 54) newline();
    }
    document.end();
  });
}

async function writePptx(filePath: string, title: string, markdown: string, brief: AssignmentBrief): Promise<void> {
  const deck = new pptxgen();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "StudyFlow";
  deck.subject = title;
  deck.title = title;
  const titleSlide = deck.addSlide();
  titleSlide.background = { color: "FFFFFF" };
  titleSlide.addText(title, { x: 0.7, y: 1.3, w: 11.8, h: 0.7, fontFace: "Aptos", fontSize: 28, bold: true, color: "14213D" });
  titleSlide.addText("Reviewable StudyFlow draft", { x: 0.72, y: 2.1, w: 7.5, h: 0.3, fontFace: "Aptos", fontSize: 13, color: "1769E8" });
  const contentSlide = deck.addSlide();
  contentSlide.addText("Draft overview", { x: 0.7, y: 0.55, w: 6, h: 0.4, fontFace: "Aptos", fontSize: 22, bold: true, color: "14213D" });
  const fullDraft = plainText(markdown);
  const pages = fullDraft.match(/[\s\S]{1,1200}/g) ?? [""];
  contentSlide.addText(pages[0], { x: 0.7, y: 1.2, w: 7.4, h: 5.5, fontFace: "Aptos", fontSize: 15, color: "222B45", breakLine: false, valign: "top" });
  for (const page of pages.slice(1)) {
    const slide = deck.addSlide();
    slide.addText("Worked solution — continued", { x: 0.7, y: 0.55, w: 11.8, h: 0.4, fontSize: 22, bold: true });
    slide.addText(page, { x: 0.7, y: 1.2, w: 11.8, h: 5.5, fontSize: 15, valign: "top" });
  }
  contentSlide.addShape(deck.ShapeType.rect, { x: 8.55, y: 1.2, w: 3.8, h: 5.2, fill: { color: "F3F7FF" }, line: { color: "DCE4F2" } });
  contentSlide.addText("Requirements", { x: 8.9, y: 1.52, w: 3, h: 0.3, fontFace: "Aptos", fontSize: 16, bold: true, color: "14213D" });
  const requirements = [brief.wordOrPageLimit && `Length: ${brief.wordOrPageLimit}`, brief.citationStyle && `Citations: ${brief.citationStyle}`, ...brief.requiredSections.map((section) => `Section: ${section}`)].filter(Boolean).join("\n");
  contentSlide.addText(requirements || "Verify Canvas requirements before submitting.", { x: 8.9, y: 2.05, w: 2.95, h: 3.7, fontFace: "Aptos", fontSize: 11, color: "44506A", breakLine: false, valign: "top" });
  await deck.writeFile({ fileName: filePath });
}

async function writeXlsx(filePath: string, input: GenerateDeliverablesInput): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StudyFlow";
  const overview = workbook.addWorksheet("Requirements");
  overview.columns = [{ header: "Requirement", key: "requirement", width: 30 }, { header: "Detail", key: "detail", width: 80 }];
  overview.addRows([
    { requirement: "Assignment", detail: input.title },
    { requirement: "Length", detail: input.brief.wordOrPageLimit ?? "Confirm against Canvas instructions" },
    { requirement: "Citation style", detail: input.brief.citationStyle ?? "Confirm against Canvas instructions" },
    ...input.brief.requiredSections.map((section) => ({ requirement: "Required section", detail: section })),
    ...input.brief.formattingRules.map((rule) => ({ requirement: "Formatting", detail: rule })),
  ]);
  overview.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  overview.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1769E8" } };
  const draft = workbook.addWorksheet("Draft");
  draft.columns = [{ header: "Reviewable draft", key: "draft", width: 120 }];
  for (const text of plainText(input.draft).match(/[\s\S]{1,2000}/g) ?? []) {
    const row = draft.addRow({ draft: text });
    row.alignment = { wrapText: true, vertical: "top" };
  }
  draft.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  draft.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1769E8" } };
  await workbook.xlsx.writeFile(filePath);
}

export async function generateDeliverables(input: GenerateDeliverablesInput): Promise<OutputArtifact[]> {
  const outputDirectory = resolveInside(input.workspacePath, "outputs");
  await ensureDirectory(outputDirectory);
  const body = markdownDocument(input);
  const baseName = sanitizeFileName(input.title, "studyflow-draft");
  const artifacts: OutputArtifact[] = [];
  const specs = input.specs.length ? input.specs : [{ format: "docx" as const }, { format: "pdf" as const }, { format: "md" as const }];
  for (const spec of specs) {
    const filePath = resolveInside(outputDirectory, `${baseName}.${spec.format}`);
    switch (spec.format) {
      case "md": await writeFile(filePath, body, "utf8"); break;
      case "txt": await writeFile(filePath, plainText(body), "utf8"); break;
      case "tex": await writeFile(filePath, latexDocument(input.title, input.draft), "utf8"); break;
      case "csv": await writeFile(filePath, `field,value\nassignment,"${input.title.replace(/"/g, '""')}"\nlength,"${(input.brief.wordOrPageLimit ?? "").replace(/"/g, '""')}"\ndraft,"${plainText(input.draft).replace(/"/g, '""')}"\n`, "utf8"); break;
      case "docx": await writeDocx(filePath, input.title, input.draft); break;
      case "pdf": await writePdf(filePath, input.title, input.draft); break;
      case "pptx": await writePptx(filePath, input.title, input.draft, input.brief); break;
      case "xlsx": await writeXlsx(filePath, input); break;
      case "zip": {
        const zip = new JSZip();
        zip.file("README.md", body);
        zip.file("requirements.json", JSON.stringify(input.brief, null, 2));
        await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
        break;
      }
      default: {
        const exhaustive: never = spec.format;
        throw new Error(`Unsupported output format: ${exhaustive}`);
      }
    }
    artifacts.push(await artifactFromFile(input, filePath, spec.format));
  }
  await writeFile(resolveInside(outputDirectory, "source-ledger.md"), input.sourceLedger || "No verified source citations were available.\n", "utf8");
  return artifacts;
}

export async function readGeneratedArtifact(pathToArtifact: string): Promise<Buffer> {
  return readFile(pathToArtifact);
}
