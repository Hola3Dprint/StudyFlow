import type { Assignment, AssignmentBrief } from "../../shared/types";

const CITATION_PATTERNS: Array<[RegExp, string]> = [
  [/\bapa(?:\s+(?:7|7th|seventh))?\b/i, "APA 7"],
  [/\bmla(?:\s+(?:9|9th|ninth))?\b/i, "MLA 9"],
  [/\bchicago\b/i, "Chicago"],
  [/\bbluebook\b/i, "Bluebook"],
  [/\bharvard\b/i, "Harvard"],
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sectionCandidates(markdown: string): string[] {
  const headingMatches = [...markdown.matchAll(/^#{1,4}\s+(.+)$/gm)].map((match) => match[1]);
  const imperativeMatches = [...markdown.matchAll(/(?:include|organize|address|discuss|explain|provide)\s+(?:an?\s+)?(?:section(?:s)?\s+(?:for|on)\s+)?([A-Z][^.;:\n]{3,80})/gi)]
    .flatMap((match) => match[1].split(/,|\s+and\s+|\s+or\s+/i).map((section) => section.trim().replace(/^a\s+/i, "")));
  return unique([...headingMatches, ...imperativeMatches]).slice(0, 12);
}

export function extractAssignmentBrief(assignment: Assignment): AssignmentBrief {
  const text = `${assignment.title}\n${assignment.descriptionMarkdown}`;
  const wordMatch = text.match(/\b(\d{2,5})\s*(?:to|-|–)\s*(\d{2,5})\s*words?\b|\b(\d{2,5})\s*words?\b|\b(\d+)\s*(?:to|-|–)\s*(\d+)\s*pages?\b/i);
  const citationStyle = CITATION_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
  const formattingRules = unique([
    ...[...text.matchAll(/(?:must|should|required to)\s+([^.!?\n]{8,130})/gi)].map((match) => match[1]),
    ...[...text.matchAll(/(?:double[- ]spaced|12[- ]point|times new roman|title page|works cited|references page|proper citations?)/gi)].map((match) => match[0]),
  ]).slice(0, 12);
  const missingInformation: string[] = [];
  if (!assignment.descriptionMarkdown.trim()) missingInformation.push("Canvas did not include assignment instructions.");
  if (!citationStyle && /citation|source|reference/i.test(text)) missingInformation.push("The required citation style is not stated.");
  if (assignment.submissionTypes.length === 0) missingInformation.push("Canvas did not specify a submission format.");
  if (assignment.lockedForUser || assignment.isQuiz) missingInformation.push("This item is a quiz or locked item; StudyFlow will not generate answers for an exam.");

  return {
    assignmentId: assignment.id,
    deliverableType: assignment.submissionTypes.includes("online_upload") ? "Uploaded document" : assignment.submissionTypes.includes("online_text_entry") ? "Text entry" : "Assignment deliverable",
    wordOrPageLimit: wordMatch?.[0],
    citationStyle,
    requiredSections: sectionCandidates(assignment.descriptionMarkdown),
    rubricCriteria: assignment.rubric.map((criterion) => ({ criterion: criterion.description, points: criterion.points })),
    formattingRules,
    missingInformation,
    safetyNotice: assignment.isQuiz || assignment.lockedForUser ? "StudyFlow will not prepare answers for quizzes, live tests, or locked assessments." : undefined,
  };
}

export function hasAssessmentSafetyBlock(assignment: Assignment): boolean {
  const content = `${assignment.title}\n${assignment.descriptionMarkdown}`.toLowerCase();
  return assignment.isQuiz === true || assignment.lockedForUser === true || /\b(timed|proctored|live exam|midterm|final exam|quiz)\b/.test(content);
}
