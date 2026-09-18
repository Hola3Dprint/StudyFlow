import { createHash } from "node:crypto";

export const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function chunks(text: string): Array<{ text: string; location: string }> {
  const result: Array<{ text: string; location: string }> = [];
  let location = "Document";
  for (const section of text.split(/(?=^\[Page \d+\]|^#{1,6} |^\[(?:ppt|word|xl)\/)/m)) {
    const marker = section.match(/^(\[[^\n]+\]|#{1,6} [^\n]+)/)?.[0];
    if (marker) location = marker.replace(/^#+\s*/, "");
    // Conservative character ceiling in addition to word count for technical text.
    const words = section.match(/\S+/g) ?? [];
    for (let start = 0; start < words.length;) {
      let end = start, length = 0;
      while (end < words.length && end - start < 160 && length + words[end].length < 850) length += words[end++].length + 1;
      if (end === start) end++;
      result.push({ text: words.slice(start, end).join(" "), location });
      if (end === words.length) break;
      start = Math.max(start + 1, end - 28);
    }
  }
  return result;
}
export function normalize(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values); let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
export function topVectors(query: Float32Array, rows: Array<{ id: string; vector: Float32Array }>, limit: number): Array<{ id: string; score: number }> {
  const top: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    if (row.vector.length !== query.length) continue;
    let score = 0;
    for (let i = 0; i < query.length; i++) score += query[i] * row.vector[i];
    if (top.length === limit && score <= top[top.length - 1].score) continue;
    const at = top.findIndex(item => score > item.score);
    top.splice(at < 0 ? top.length : at, 0, { id: row.id, score });
    if (top.length > limit) top.pop();
  }
  return top;
}
export function fuse(rankings: Array<Array<{ id: string }>>): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  rankings.forEach(list => list.forEach((item, index) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + index + 1))));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
export function ftsQuery(text: string): string {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 32).map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
