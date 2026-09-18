export const CONTENT_CATEGORIES = [
  "modules",
  "files",
  "pages",
  "assignments",
  "rubrics",
  "syllabus",
  "announcements",
  "discussions",
  "calendar",
  "quizzes",
  "attachments",
] as const;

export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];
export type SyncStatus = "idle" | "queued" | "syncing" | "partial" | "complete" | "failed" | "cancelled";
export type ArtifactFormat = "docx" | "pdf" | "pptx" | "xlsx" | "csv" | "md" | "txt" | "tex" | "zip";

export interface CanvasConnection {
  baseUrl: string;
  accountName?: string;
  accountId?: string;
  connectedAt?: string;
  hasStoredToken: boolean;
}

export interface Course {
  id: string;
  canvasId: string;
  /** Displayed Canvas name. This is the user's nickname when Canvas has one. */
  name: string;
  /** Canvas's original course name when the current user has configured a nickname. */
  originalName?: string;
  nickname?: string;
  code: string;
  color: string;
  workflowState: "available" | "completed" | "unpublished" | "archived";
  startAt?: string | null;
  endAt?: string | null;
  lastSyncedAt?: string | null;
  isArchived?: boolean;
  /** Only Canvas dashboard favorites are visible or eligible for syncing. */
  isFavorite?: boolean;
}

export interface Attachment {
  skippedReason?: "video";
  source?: "description";
  sourceUrl?: string;
  downloadError?: string;
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  url?: string;
  localPath?: string;
  downloaded?: boolean;
  revision?: number;
}

export interface RubricCriterion {
  id: string;
  description: string;
  longDescription?: string;
  points: number;
  ratings?: Array<{ description: string; points: number }>;
}

export type LocalAssignmentStatus = "not_started" | "completed" | "submitted";

export interface CanvasSubmissionStatus {
  workflowState: "unsubmitted" | "submitted" | "pending_review" | "graded" | "unknown";
  submittedAt: string | null;
  missing: boolean;
  late: boolean;
  excused: boolean;
  checkedAt: string;
}

export interface SubmissionCheckResult {
  assignments: Assignment[];
  errors: Array<{ courseId: string; message: string }>;
}

export interface Assignment {
  /** No longer returned by a complete Canvas course snapshot; retain local materials. */
  canvasRemoved?: boolean;
  canvasSubmission?: CanvasSubmissionStatus;
  /** Student-maintained tracker only; never writes a Canvas submission. */
  localProgress?: { status: LocalAssignmentStatus; updatedAt: string };
  id: string;
  canvasId: string;
  courseId: string;
  courseName: string;
  courseColor: string;
  title: string;
  dueAt?: string | null;
  pointsPossible?: number | null;
  submissionTypes: string[];
  descriptionHtml: string;
  descriptionMarkdown: string;
  rubric: RubricCriterion[];
  attachments: Attachment[];
  localFolder?: string;
  status?: "downloaded" | "pending" | "archived";
  isQuiz?: boolean;
  lockedForUser?: boolean;
  updatedAt?: string | null;
}

export interface SyncSelection {
  courseIds: string[];
  categories: ContentCategory[];
  includeArchivedCourses: boolean;
}

export interface SyncProgress {
  transfers?: Array<{ id: string; name: string; courseName: string; received: number; total?: number; status: "downloading" | "complete" | "failed" }>;
  completed: number;
  total: number;
  courseId?: string;
  courseName?: string;
  category?: ContentCategory;
  message: string;
}

export interface SyncJob {
  background?: boolean;
  id: string;
  status: SyncStatus;
  startedAt: string;
  finishedAt?: string;
  selection: SyncSelection;
  progress: SyncProgress;
  errors: Array<{ courseId?: string; category?: ContentCategory; message: string }>;
}

export interface CanvasConnectResult {
  connection: CanvasConnection;
  courses: Course[];
  initialSync: SyncJob | null;
  initialSyncError?: string;
}

export interface LocalArtifact {
  id: string;
  assignmentId?: string;
  courseId?: string;
  name: string;
  format: ArtifactFormat | "file";
  path: string;
  relativePath: string;
  size?: number;
  checksum?: string;
  revision: number;
  createdAt: string;
  source: "canvas" | "ai" | "user";
}

export interface CodexUsageWindow {
  label: string;
  remaining?: number;
  resetAt?: string | null;
}

export interface CodexAccount {
  authMode: "chatgpt" | "apiKey" | "none" | "unknown";
  email?: string | null;
  planType?: string | null;
  usage: CodexUsageWindow[];
  isAvailable: boolean;
  lastError?: string;
}

export interface LoginStart {
  kind: "browser" | "device";
  loginId: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface AssignmentBrief {
  assignmentId: string;
  deliverableType: string;
  wordOrPageLimit?: string;
  citationStyle?: string;
  requiredSections: string[];
  rubricCriteria: Array<{ criterion: string; points: number }>;
  formattingRules: string[];
  missingInformation: string[];
  safetyNotice?: string;
}

export interface DeliverableSpec {
  format: ArtifactFormat;
  title?: string;
  includeSourceLedger?: boolean;
}

export interface OutputArtifact extends LocalArtifact {
  format: ArtifactFormat;
}

export interface AiRun {
  allowedCourseIds?: string[];
  agents?: Array<{ role: string; status: "waiting" | "running" | "complete" | "failed" | "cancelled"; output?: string }>;
  indexedFiles?: number;
  qaReport?: string;
  id: string;
  assignmentId: string;
  status: "queued" | "running" | "awaiting_review" | "complete" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  workspacePath: string;
  brief: AssignmentBrief;
  progress: string[];
  output?: string;
  artifacts: OutputArtifact[];
  researchedSourcesEnabled: boolean;
  error?: string;
}

export interface AppBootstrap {
  connection: CanvasConnection | null;
  courses: Course[];
  assignments: Assignment[];
  activeSync: SyncJob | null;
  activeAiRun?: AiRun | null;
  codexAccount: CodexAccount;
  libraryPath: string;
}

export interface StudyFlowApi {
  appearance?: {
    setTheme(theme: import("./appearance").AppearanceTheme): Promise<void>;
  };
  appleCalendar: import("./apple-calendar").AppleCalendarApi;
  library: import("./library").LibraryApi;
  bootstrap(): Promise<AppBootstrap>;
  canvas: {
    connect(input: { baseUrl: string; token: string }): Promise<CanvasConnectResult>;
    disconnect(): Promise<void>;
    listCourses(includeArchived: boolean): Promise<Course[]>;
    startSync(selection: SyncSelection): Promise<SyncJob>;
    cancelSync(jobId: string): Promise<void>;
    getSync(jobId: string): Promise<SyncJob | null>;
    assignment(id: string): Promise<Assignment | null>;
    checkSubmission(id: string): Promise<Assignment>;
    checkPastSubmissions(): Promise<SubmissionCheckResult>;
    setLocalProgress(id: string, status: LocalAssignmentStatus): Promise<Assignment>;
  };
  codex: {
    account(): Promise<CodexAccount>;
    loginBrowser(): Promise<LoginStart>;
    loginDevice(): Promise<LoginStart>;
    logout(): Promise<void>;
  };
  ai: {
    history(assignmentId: string): Promise<AiRun[]>;
    start(input: { assignmentId: string; researchedSourcesEnabled: boolean; deliverables: DeliverableSpec[]; additionalCourseIds?: string[] }): Promise<AiRun>;
    cancel(runId: string): Promise<void>;
  };
  files: {
    open(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  onSync(listener: (job: SyncJob) => void): () => void;
  onAiRun(listener: (run: AiRun) => void): () => void;
}
