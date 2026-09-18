import { parse } from "mathjs";
import { z } from "zod";

const schema = z.object({ expression: z.string().min(1).max(2000), variables: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), z.number().finite()).default({}), label: z.string().max(300).default("Calculation") });
const functions = new Set(["sqrt", "abs", "sin", "cos", "tan", "asin", "acos", "atan", "log", "exp", "round", "min", "max"]);
export function calculate(args: unknown) {
  const value = schema.parse(args);
  if (Object.keys(value.variables).length > 50) throw new Error("Too many variables.");
  const tree = parse(value.expression);
  let count = 0;
  tree.traverse(node => {
    const name = (node as unknown as { name: string }).name;
    if (++count > 250) throw new Error("Calculation is too complex; split into steps.");
    if (!["ConstantNode", "SymbolNode", "OperatorNode", "FunctionNode", "ParenthesisNode"].includes(node.type)) throw new Error("Only scalar arithmetic and approved math functions are allowed.");
    if (node.type === "SymbolNode" && !Object.hasOwn(value.variables, name) && !["pi", "e"].includes(name) && !functions.has(name)) throw new Error("Unknown calculation variable.");
    if (node.type === "FunctionNode" && !functions.has(name)) throw new Error("Unsupported calculation function.");
    if (node.type === "OperatorNode" && !["+", "-", "*", "/", "^"].includes((node as unknown as { op: string }).op)) throw new Error("Unsupported operator.");
    if (node.type === "ConstantNode" && typeof (node as unknown as { value: unknown }).value !== "number") throw new Error("Only numeric constants are allowed.");
  });
  const result: unknown = tree.compile().evaluate(new Map(Object.entries(value.variables)));
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("Calculation must return a finite real number.");
  return { ...value, result, note: "Numerical arithmetic verification only. Angles are in radians. Show formulas, substitutions, units and explicit conversions in the draft; this tool does not verify the physical model." };
}
