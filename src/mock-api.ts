import { CONTENT_CATEGORIES, type AiRun, type AppBootstrap, type CodexAccount, type DeliverableSpec, type LoginStart, type StudyFlowApi, type SyncJob, type SyncSelection } from "../shared/types";
import { SAMPLE_ASSIGNMENTS, SAMPLE_BOOTSTRAP, SAMPLE_COURSES } from "./sample-data";
import { libraryDemo } from "./library-demo";
import { emptyAppleCalendar } from "../shared/apple-calendar";

const syncListeners = new Set<(job: SyncJob) => void>();
const runListeners = new Set<(run: AiRun) => void>();
const demoRuns = new Map<string, AiRun>();
let account: CodexAccount = { ...SAMPLE_BOOTSTRAP.codexAccount };
let canvasConnection = SAMPLE_BOOTSTRAP.connection;
const demoAssignments = new Map(SAMPLE_ASSIGNMENTS.map(assignment => [assignment.id, structuredClone(assignment)]));

function emitSync(job: SyncJob): void { syncListeners.forEach((listener) => listener(job)); }
function emitRun(run: AiRun): void { demoRuns.set(run.id, run); runListeners.forEach((listener) => listener(run)); }

function startDemoSync(selection: SyncSelection): SyncJob {
  const job: SyncJob = { id: `demo-sync-${Date.now()}`, status: "syncing", startedAt: new Date().toISOString(), selection, progress: { completed: 0, total: selection.courseIds.length * selection.categories.length, message: "Preparing selected downloads…" }, errors: [] };
  emitSync(job);
  window.setTimeout(() => emitSync({ ...job, progress: { ...job.progress, message: "Downloading Lecture slides.pdf", transfers: [{ id: "demo-file", name: "Lecture slides.pdf", courseName: "Research Methods", received: 524288, total: 1048576, status: "downloading" }] } }), 100);
  window.setTimeout(() => {
    const complete = { ...job, status: "complete" as const, finishedAt: new Date().toISOString(), progress: { ...job.progress, completed: job.progress.total, message: "Selected Canvas content is available locally." } };
    emitSync(complete);
  }, 1800);
  return job;
}

function createDemoRun(assignmentId: string, specs: DeliverableSpec[], researchedSourcesEnabled: boolean): AiRun {
  const assignment = SAMPLE_ASSIGNMENTS.find((item) => item.id === assignmentId) ?? SAMPLE_ASSIGNMENTS[0];
  return {
    id: `demo-ai-${Date.now()}`,
    assignmentId,
    status: "running",
    startedAt: new Date().toISOString(),
    workspacePath: "Documents\\StudyFlow\\Workspaces\\demo",
    brief: {
      assignmentId,
      deliverableType: "Uploaded document",
      wordOrPageLimit: assignment.descriptionMarkdown.match(/\d{3,5}\s+to\s+\d{3,5}\s+words/i)?.[0],
      citationStyle: "Confirm with course materials",
      requiredSections: ["Introduction", "Source synthesis", "Methodology analysis", "Conclusion"],
      rubricCriteria: assignment.rubric.map((rubric) => ({ criterion: rubric.description, points: rubric.points })),
      formattingRules: ["Use readable headings", "Verify all citations before submitting"],
      missingInformation: ["Research question has not been supplied in this demo."],
    },
    progress: ["Assignment workspace prepared.", "Demo mode: review the requirements sheet before connecting ChatGPT."],
    artifacts: specs.map((spec, index) => ({ id: `demo-artifact-${index}`, assignmentId, name: `${assignment.title}.${spec.format}`, format: spec.format, path: "", relativePath: `outputs/${assignment.title}.${spec.format}`, revision: 1, createdAt: new Date().toISOString(), source: "ai" })),
    researchedSourcesEnabled,
  };
}

export const mockApi: StudyFlowApi = {
  appearance: { setTheme: async () => undefined },
  appleCalendar: {
    state: async () => emptyAppleCalendar(),
    connect: async () => { throw new Error("Open the StudyFlow desktop app to connect Apple Calendar."); },
    disconnect: async () => emptyAppleCalendar(),
    refresh: async () => emptyAppleCalendar(),
    setReminders: async () => { throw new Error("Open the StudyFlow desktop app to change calendar reminders."); },
    help: async () => { window.open("https://support.apple.com/en-us/102654", "_blank", "noopener,noreferrer"); },
    subscribe: () => () => {},
  },
  library: libraryDemo,
  bootstrap: async (): Promise<AppBootstrap> => ({ ...SAMPLE_BOOTSTRAP, connection: canvasConnection, courses: [...SAMPLE_COURSES], assignments: [...demoAssignments.values()], codexAccount: account }),
  canvas: {
    connect: async (input) => {
      const initialSync = startDemoSync({ courseIds: SAMPLE_COURSES.map((course) => course.id), categories: [...CONTENT_CATEGORIES], includeArchivedCourses: false });
      canvasConnection = { baseUrl: input.baseUrl, accountName: "Demo Student", accountId: "demo", connectedAt: new Date().toISOString(), hasStoredToken: true };
      return { connection: canvasConnection, courses: [...SAMPLE_COURSES], initialSync };
    },
    disconnect: async () => { canvasConnection = null; },
    listCourses: async () => SAMPLE_COURSES,
    startSync: async (selection: SyncSelection) => startDemoSync(selection),
    cancelSync: async () => undefined,
    getSync: async () => null,
    assignment: async (id) => demoAssignments.get(id) ?? null,
    setLocalProgress: async (id, status) => {
      const assignment = demoAssignments.get(id);
      if (!assignment) throw new Error("Assignment not found.");
      const updated = { ...assignment, localProgress: { status, updatedAt: new Date().toISOString() } };
      demoAssignments.set(id, updated);
      return updated;
    },
    checkSubmission: async id => {
      const assignment = demoAssignments.get(id);
      if (!assignment) throw new Error("Assignment not found.");
      const updated = { ...assignment, canvasSubmission: { workflowState: "unsubmitted" as const, submittedAt: null, missing: false, late: false, excused: false, checkedAt: new Date().toISOString() } };
      demoAssignments.set(id, updated);
      return updated;
    },
    checkPastSubmissions: async () => ({ assignments: await Promise.all([...demoAssignments.values()].filter(assignment => assignment.dueAt && Date.parse(assignment.dueAt) < Date.now()).map(assignment => mockApi.canvas.checkSubmission(assignment.id))), errors: [] }),
  },
  codex: {
    account: async () => account,
    loginBrowser: async (): Promise<LoginStart> => {
      account = { authMode: "chatgpt", email: "student@example.com", planType: "Plus", usage: [{ label: "5-hour limit", remaining: 78, resetAt: "Later today" }], isAvailable: true };
      return { kind: "browser", loginId: "demo-browser-login", authUrl: "https://chatgpt.com" };
    },
    loginDevice: async (): Promise<LoginStart> => ({ kind: "device", loginId: "demo-device-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "DEMO-1234" }),
    logout: async () => { account = { authMode: "none", email: null, planType: null, usage: [], isAvailable: true }; },
  },
  ai: {
    history: async assignmentId => [...demoRuns.values()].filter(run => run.assignmentId === assignmentId).reverse(),
    start: async (input) => {
      const run = createDemoRun(input.assignmentId, input.deliverables, input.researchedSourcesEnabled);
      emitRun(run);
      window.setTimeout(() => emitRun({ ...run, status: "awaiting_review", finishedAt: new Date().toISOString(), output: "Demo workspace ready. Connect your ChatGPT plan to create a local, reviewable draft from your assignment materials.", progress: [...run.progress, "Draft ready for review. Nothing was submitted to Canvas."] }), 700);
      return run;
    },
    cancel: async () => undefined,
  },
  files: { open: async () => undefined, reveal: async () => undefined },
  onSync: (listener) => { syncListeners.add(listener); return () => syncListeners.delete(listener); },
  onAiRun: (listener) => { runListeners.add(listener); return () => runListeners.delete(listener); },
};
