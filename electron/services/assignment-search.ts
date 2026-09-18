import type { Assignment } from "../../shared/types";
const STOP = new Set("the and for that this with from your you are will should have has was were into each all any not can may must use using used please submit submission assignment assignments homework problem problems question questions answer answers complete completed work show points due date uploaded upload file files pdf docx html https http www com edu canvas instructure instructions include following required page pages read review name student course class syllabus rubric criteria description title attachment attachments source text image visual generated unverified inspect original details diagram diagrams".split(" "));
export function topicTerms(text: string): string[] {
  return (text.replace(/https?:\/\/\S+/gi, " ").toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{2,}/gu) ?? []).filter(term => !STOP.has(term) && !/^hw\d*$/.test(term));
}
export function assignmentSearchQuery(assignment: Assignment, attachmentText = ""): string {
  const scores = new Map<string, number>();
  const add = (text: string, weight: number) => { for (const term of topicTerms(text)) scores.set(term, (scores.get(term) ?? 0) + weight); };
  add(assignment.title, 5); add(assignment.descriptionMarkdown.slice(0, 6000), 2);
  add(assignment.rubric.map(row => row.description).join(" ").slice(0, 2000), 1); add(attachmentText.slice(0, 12000), 1);
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([term]) => term).join(" ");
}
