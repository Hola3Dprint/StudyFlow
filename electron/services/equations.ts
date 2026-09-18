import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import { mml2omml } from "mathml2omml";

export interface Equation { latex: string; display: boolean }
export type EquationPart = { text: string } | Equation;
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: ["base", "ams"], maxBuffer: 16000, maxMacros: 1000, formatError: (_jax: unknown, error: Error) => { throw error; } });
const document = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
const visitor = new SerializedMmlVisitor();

export function renderEquation(equation: Equation): { svg: string; omml: string; width: number; height: number; mathml: string } {
  if (equation.latex.length > 16000 || /\\(?:href|url|includegraphics|require|html|def|newcommand|renewcommand|input|write|include|usepackage)\b/.test(equation.latex)) throw new Error("Unsupported or unsafe equation command. Use standard LaTeX math notation.");
  tex.reset();
  const node = document.convert(equation.latex, { display: equation.display });
  let svg = adaptor.outerHTML(node).match(/<svg[\s\S]*<\/svg>/)?.[0];
  if (!svg) throw new Error("Equation could not be rendered.");
  const box = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
  if (!box || box.length !== 4 || box.some(value => !Number.isFinite(value))) throw new Error("Invalid equation dimensions.");
  const width = box[2] / 1000 * 12, height = box[3] / 1000 * 12;
  svg = svg.replace(/width="[^"]*"/, `width="${width}"`).replace(/height="[^"]*"/, `height="${height}"`).replace(/currentColor/g, "#000000");
  tex.reset();
  const root = document.convert(equation.latex, { display: equation.display, end: 20 });
  const mathml = visitor.visitTree(root);
  if (mathml.includes("<merror")) throw new Error("Invalid LaTeX equation.");
  return { svg, omml: mml2omml(mathml), width, height, mathml };
}

/** Protect math from Markdown's escape/emphasis handling; leave code untouched. */
export function protectEquations(markdown: string): { markdown: string; parts(text: string): EquationPart[]; restore(text: string): string; equations: Equation[] } {
  const equations: Equation[] = [];
  let prefix = "STUDYFLOWMATHTOKEN";
  while (markdown.includes(prefix)) prefix += "X";
  const protectedMarkdown = markdown.replace(/```[\s\S]*?```|`[^`\n]*`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?![\s$])([^\n$]*?\S)\$(?!\d)/g, (full, displayDollar, displayBracket, inlineBracket, inlineDollar) => {
    if (full.startsWith("`")) return full;
    const equation = { latex: String(displayDollar ?? displayBracket ?? inlineBracket ?? inlineDollar).trim(), display: displayDollar !== undefined || displayBracket !== undefined };
    const token = `${prefix}${equations.length}END`;
    equations.push(equation);
    return equation.display ? `\n\n${token}\n\n` : token;
  });
  const parts = (text: string): EquationPart[] => {
    const values: EquationPart[] = []; let end = 0;
    for (const match of text.matchAll(new RegExp(`${prefix}(\\d+)END`, "g"))) {
      if (match.index > end) values.push({ text: text.slice(end, match.index) });
      values.push(equations[Number(match[1])]); end = match.index + match[0].length;
    }
    if (end < text.length) values.push({ text: text.slice(end) });
    return values;
  };
  return { markdown: protectedMarkdown, equations, parts, restore: text => parts(text).map(part => "text" in part ? part.text : `${part.display ? "\\[" : "\\("}${part.latex}${part.display ? "\\]" : "\\)"}`).join("") };
}

export function escapeTex(text: string): string {
  return text.replace(/[\\{}$&#%_^~]/g, char => ({ "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}" })[char]!);
}
