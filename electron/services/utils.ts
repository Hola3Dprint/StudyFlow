import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex -- Windows prohibits ASCII control characters in filenames.
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function sanitizeFileName(value: string, fallback = "untitled"): string {
  const cleaned = value
    .replace(INVALID_FILE_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return fallback;
  return cleaned;
}

export function resolveInside(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts.map((part) => sanitizeFileName(part)));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe local path was rejected.");
  }
  return resolved;
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeCanvasHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "a", "b", "blockquote", "br", "code", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}

export function markdownFromHtml(html: string): string {
  const service = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });
  return service.turndown(sanitizeCanvasHtml(html)).trim();
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(access[_-]?token|authorization|token)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]");
}

export async function assertEnoughDiskSpace(directory: string, bytesNeeded: number): Promise<void> {
  const fs = await import("node:fs/promises");
  if (typeof fs.statfs !== "function") return;
  const information = await fs.statfs(directory);
  if (information.bavail * information.bsize < bytesNeeded) {
    throw new Error("StudyFlow needs more free disk space before downloading this attachment.");
  }
}
