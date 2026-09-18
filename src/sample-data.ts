import type { AppBootstrap, Assignment, Course } from "../shared/types";

export const SAMPLE_COURSES: Course[] = [
  { id: "research-methods", canvasId: "1101", name: "Research Methods", code: "RM 301", color: "#1769e8", workflowState: "available", lastSyncedAt: new Date().toISOString() },
  { id: "data-analysis", canvasId: "1102", name: "Data Analysis", code: "DA 240", color: "#14a6a3", workflowState: "available", lastSyncedAt: new Date().toISOString() },
  { id: "psychology-101", canvasId: "1103", name: "Psychology 101", code: "PSY 101", color: "#7857df", workflowState: "available", lastSyncedAt: new Date().toISOString() },
  { id: "sociology", canvasId: "1104", name: "Sociology", code: "SOC 220", color: "#ef8b3b", workflowState: "available", lastSyncedAt: new Date().toISOString() },
  { id: "academic-writing", canvasId: "1105", name: "Academic Writing", code: "AW 110", color: "#f2cb43", workflowState: "available", lastSyncedAt: new Date().toISOString() },
];

const researchDescription = `Identify and synthesize at least 8 peer-reviewed sources related to your research question. Evaluate their methodologies and findings, and discuss how they inform your own work.

Your review should be 1500 to 2000 words and include proper citations.`;

export const SAMPLE_ASSIGNMENTS: Assignment[] = [
  { id: "data-problem-set-1", canvasId: "2001", courseId: "data-analysis", courseName: "Data Analysis", courseColor: "#14a6a3", title: "Data Analysis Problem Set 1", dueAt: "2026-09-01T23:59:00", pointsPossible: 50, submissionTypes: ["online_upload"], descriptionHtml: "<p>Work through the assigned data problems.</p>", descriptionMarkdown: "Work through the assigned data problems.", rubric: [], attachments: [], status: "downloaded" },
  { id: "sociology-discussion-1", canvasId: "2002", courseId: "sociology", courseName: "Sociology", courseColor: "#ef8b3b", title: "Sociology Discussion 1", dueAt: "2026-09-03T23:59:00", pointsPossible: 20, submissionTypes: ["discussion_topic"], descriptionHtml: "<p>Respond to this week's prompt.</p>", descriptionMarkdown: "Respond to this week's prompt.", rubric: [], attachments: [], status: "downloaded" },
  { id: "psychology-quiz-1", canvasId: "2003", courseId: "psychology-101", courseName: "Psychology 101", courseColor: "#7857df", title: "Psychology 101 Quiz 1", dueAt: "2026-09-07T23:59:00", pointsPossible: 15, submissionTypes: ["online_quiz"], descriptionHtml: "<p>Canvas quiz metadata only.</p>", descriptionMarkdown: "Canvas quiz metadata only.", rubric: [], attachments: [], status: "downloaded", isQuiz: true },
  { id: "research-article-summary", canvasId: "2004", courseId: "research-methods", courseName: "Research Methods", courseColor: "#1769e8", title: "Research Methods Article Summary", dueAt: "2026-09-09T23:59:00", pointsPossible: 40, submissionTypes: ["online_upload"], descriptionHtml: "<p>Summarize the assigned research article.</p>", descriptionMarkdown: "Summarize the assigned research article.", rubric: [], attachments: [], status: "downloaded" },
  { id: "data-lab-1", canvasId: "2005", courseId: "data-analysis", courseName: "Data Analysis", courseColor: "#14a6a3", title: "Data Analysis Lab 1", dueAt: "2026-09-11T23:59:00", pointsPossible: 35, submissionTypes: ["online_upload"], descriptionHtml: "<p>Complete the first analysis lab.</p>", descriptionMarkdown: "Complete the first analysis lab.", rubric: [], attachments: [], status: "downloaded" },
  { id: "writing-reflection", canvasId: "2006", courseId: "academic-writing", courseName: "Academic Writing", courseColor: "#f2cb43", title: "Academic Writing Reflection 1", dueAt: "2026-09-15T23:59:00", pointsPossible: 20, submissionTypes: ["online_text_entry"], descriptionHtml: "<p>Reflect on your writing process.</p>", descriptionMarkdown: "Reflect on your writing process.", rubric: [], attachments: [], status: "downloaded" },
  {
    id: "research-methods-literature-review", canvasId: "2007", courseId: "research-methods", courseName: "Research Methods", courseColor: "#1769e8", title: "Research Methods: Literature Review", dueAt: "2026-09-16T23:59:00", pointsPossible: 100, submissionTypes: ["online_upload"],
    descriptionHtml: `<p>Identify and synthesize at least 8 peer-reviewed sources related to your research question. Evaluate their methodologies and findings, and discuss how they inform your own work.</p><p>Your review should be 1500 to 2000 words and include proper citations.</p>`,
    descriptionMarkdown: researchDescription,
    rubric: [
      { id: "coverage", description: "Synthesizes appropriate peer-reviewed sources", points: 35 },
      { id: "analysis", description: "Evaluates methodologies and findings", points: 35 },
      { id: "writing", description: "Uses clear scholarly writing and citations", points: 30 },
    ],
    attachments: [
      { id: "a1", name: "Literature Review Rubric.pdf", contentType: "PDF", size: 198_000, downloaded: true },
      { id: "a2", name: "Sample Literature Review.pdf", contentType: "PDF", size: 245_000, downloaded: true },
      { id: "a3", name: "Source Guidelines.docx", contentType: "DOCX", size: 112_000, downloaded: true },
    ], status: "downloaded",
  },
  { id: "sociology-report", canvasId: "2008", courseId: "sociology", courseName: "Sociology", courseColor: "#ef8b3b", title: "Sociology Report", dueAt: "2026-09-22T23:59:00", pointsPossible: 60, submissionTypes: ["online_upload"], descriptionHtml: "<p>Write a report based on your observations.</p>", descriptionMarkdown: "Write a report based on your observations.", rubric: [], attachments: [], status: "downloaded" },
  { id: "psychology-research-paper", canvasId: "2009", courseId: "psychology-101", courseName: "Psychology 101", courseColor: "#7857df", title: "Psychology 101 Research Paper", dueAt: "2026-09-24T23:59:00", pointsPossible: 100, submissionTypes: ["online_upload"], descriptionHtml: "<p>Draft your research paper.</p>", descriptionMarkdown: "Draft your research paper.", rubric: [], attachments: [], status: "downloaded" },
];

export const SAMPLE_BOOTSTRAP: AppBootstrap = {
  connection: null,
  courses: SAMPLE_COURSES,
  assignments: SAMPLE_ASSIGNMENTS,
  activeSync: null,
  codexAccount: { authMode: "none", email: null, planType: null, usage: [], isAvailable: true },
  libraryPath: "Documents\\StudyFlow",
};
