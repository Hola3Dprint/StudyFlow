import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment, Assignment, CanvasConnection, ContentCategory, Course, SubmissionCheckResult, SyncJob, SyncSelection } from "../../shared/types";
import { isPastAssignment } from "../../shared/assignment-status";
import { parseSubmission } from "./submission-status";
import { CONTENT_CATEGORIES } from "../../shared/types";
import { canvasFileLinks } from "./canvas-links";
import { StudyFlowDatabase } from "./database";
import { assertEnoughDiskSpace, createId, ensureDirectory, fileExists, markdownFromHtml, resolveInside, sanitizeCanvasHtml, sanitizeFileName, sha256File } from "./utils";

export interface CanvasHeaders {
  get(name: string): string | null;
}

export interface CanvasResponse {
  body?: ReadableStream<Uint8Array> | null;
  ok: boolean;
  status: number;
  headers: CanvasHeaders;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type CanvasFetcher = (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } ) => Promise<CanvasResponse>;
type Sleep = (milliseconds: number) => Promise<void>;

const delay: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const COURSE_COLORS = ["#1769e8", "#13a6a5", "#7a5ce6", "#f18b38", "#f3c945", "#dd5d78"];

export function initialSyncSelection(courses: Array<Pick<Course, "id">>): SyncSelection {
  return {
    courseIds: courses.map((course) => course.id),
    categories: [...CONTENT_CATEGORIES],
    includeArchivedCourses: false,
  };
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const entry of header.split(/,\s*(?=<)/)) {
    const urlMatch = entry.match(/<([^>]+)>/);
    if (urlMatch && /rel\s*=\s*"?next"?/i.test(entry)) return urlMatch[1];
  }
  return null;
}

function retryAfterMilliseconds(response: CanvasResponse, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 750 * 2 ** attempt);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Sync was cancelled", "AbortError");
}

export function normalizeCanvasOrigin(input: string, allowHttpForTests = false): string {
  const normalized = input.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowHttpForTests && isLocal)) {
    throw new Error("Canvas must use a secure HTTPS address.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Enter the Canvas domain only, without a path or embedded credentials.");
  }
  return url.origin;
}

export class CanvasHttpClient {
  readonly origin: string;
  private readonly fetcher: CanvasFetcher;
  private readonly token: string;
  private readonly sleep: Sleep;
  private requestCost = 0;

  constructor(origin: string, token: string, fetcher: CanvasFetcher = globalThis.fetch as unknown as CanvasFetcher, sleep: Sleep = delay) {
    this.origin = origin;
    this.fetcher = fetcher;
    this.token = token;
    this.sleep = sleep;
  }

  get lastRequestCost(): number {
    return this.requestCost;
  }

  private trustedUrl(urlOrPath: string): string {
    const resolved = new URL(urlOrPath, this.origin);
    if (resolved.origin !== this.origin) throw new Error("Canvas returned an unexpected pagination host.");
    return resolved.toString();
  }

  async get(urlOrPath: string, signal?: AbortSignal, options: { accept?: string; headers?: Record<string, string> } = {}): Promise<CanvasResponse> {
    const url = this.trustedUrl(urlOrPath);
    let lastError = "Canvas did not return a response.";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      abortIfNeeded(signal);
      const response = await this.fetcher(url, {
        method: "GET",
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: options.accept ?? "application/json",
          "User-Agent": "StudyFlow/0.1 (read-only Canvas mirror)",
          ...options.headers,
        },
      });
      const cost = Number(response.headers.get("x-request-cost"));
      if (Number.isFinite(cost)) this.requestCost = cost;
      if (response.status === 429 || response.status >= 500) {
        lastError = `Canvas returned ${response.status}.`;
        if (attempt < 4) {
          await this.sleep(retryAfterMilliseconds(response, attempt));
          continue;
        }
      }
      if (!response.ok) {
        if (response.status === 401) throw new Error("Canvas rejected your API key (401 Unauthorized). Open Settings and replace your personal access token, then sync again. Your local downloads are safe.");
        if (response.status === 403) throw new Error("Canvas denied access (403 Forbidden). Check your course access and token permissions in Canvas. Your local downloads are safe.");
        throw new Error(`Canvas returned HTTP ${response.status}. Try again or check your Canvas connection in Settings.`);
      }
      return response;
    }
    throw new Error(lastError);
  }

  async json<T>(urlOrPath: string, signal?: AbortSignal): Promise<T> {
    return (await this.get(urlOrPath, signal)).json() as Promise<T>;
  }

  async paginate<T>(urlOrPath: string, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    let next: string | null = urlOrPath;
    const seen = new Set<string>();
    while (next) {
      abortIfNeeded(signal);
      const absolute = this.trustedUrl(next);
      if (seen.has(absolute)) throw new Error("Canvas pagination loop detected.");
      seen.add(absolute);
      const response = await this.get(next, signal);
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error("Canvas returned an unexpected paginated response.");
      result.push(...page as T[]);
      next = parseLinkHeader(response.headers.get("link"));
    }
    return result;
  }
}

interface CanvasCourse {
  id: number | string;
  name: string;
  original_name?: string;
  course_code?: string;
  workflow_state?: string;
  start_at?: string | null;
  end_at?: string | null;
}

interface CanvasAttachment {
  id?: number | string;
  display_name?: string;
  filename?: string;
  content_type?: string;
  "content-type"?: string;
  updated_at?: string;
  locked_for_user?: boolean;
  hidden_for_user?: boolean;
  size?: number;
  url?: string;
}

/** Exclude recordings regardless of whether they appear as files or attachments. */
export function isVideoAttachment(attachment: CanvasAttachment): boolean {
  if (/^video\//i.test((attachment["content-type"] ?? attachment.content_type)?.trim() ?? "")) return true;
  const names = [attachment.display_name, attachment.filename];
  if (attachment.url) {
    try { names.push(decodeURIComponent(new URL(attachment.url).pathname)); } catch { /* Metadata names remain usable. */ }
  }
  return names.some(name => /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpg|mpeg|mpe|ogv|flv|f4v|3gp|3g2|mts|m2ts|vob|m3u8|mpd)$/i.test(name?.trim() ?? ""));
}

interface CanvasAssignment {
  submission?: unknown;
  id: number | string;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  rubric?: Array<{ id?: string | number; description?: string; long_description?: string; points?: number; ratings?: Array<{ description?: string; points?: number }> }>;
  attachments?: CanvasAttachment[];
  locked_for_user?: boolean;
  quiz_id?: string | number | null;
  updated_at?: string | null;
}

interface RunningSync {
  controller: AbortController;
  job: SyncJob;
}

export class CanvasSyncService {
  private background?: Promise<boolean>;
  private closed = false;
  private readonly running = new Map<string, RunningSync>();
  private readonly fileDownloads = new Map<string, Map<string, Promise<Attachment>>>();
  private readonly database: StudyFlowDatabase;
  private readonly libraryPath: string;
  private readonly getToken: () => string | null;
  private readonly onUpdate: (job: SyncJob) => void;
  private readonly fetcher?: CanvasFetcher;

  constructor(options: { database: StudyFlowDatabase; libraryPath: string; getToken: () => string | null; onUpdate: (job: SyncJob) => void; fetcher?: CanvasFetcher }) {
    this.database = options.database;
    this.libraryPath = options.libraryPath;
    this.getToken = options.getToken;
    this.onUpdate = options.onUpdate;
    this.fetcher = options.fetcher;
  }

  async testConnection(input: { baseUrl: string; token: string }): Promise<CanvasConnection> {
    const baseUrl = normalizeCanvasOrigin(input.baseUrl, process.env.NODE_ENV === "test");
    if (input.token.trim().length < 8) throw new Error("Enter a valid Canvas personal access token.");
    const client = new CanvasHttpClient(baseUrl, input.token.trim());
    const user = await client.json<{ id?: string | number; name?: string }>("/api/v1/users/self");
    if (!user.id) throw new Error("Canvas did not return a user profile.");
    return { baseUrl, accountId: String(user.id), accountName: user.name ?? "Canvas user", connectedAt: new Date().toISOString(), hasStoredToken: true };
  }

  async listCourses(includeArchived: boolean, signal?: AbortSignal): Promise<Course[]> {
    const connection = this.connection();
    const client = this.client(connection.baseUrl);
    const courses = await client.paginate<CanvasCourse>("/api/v1/users/self/favorites/courses?per_page=100", signal);
    abortIfNeeded(signal);
    const existing = new Map(this.database.courses().map(course => [course.id, course]));
    const mapped = courses.map((course, index) => ({
      ...this.mapCourse(course, index),
      lastSyncedAt: existing.get(String(course.id))?.lastSyncedAt,
      color: existing.get(String(course.id))?.color ?? COURSE_COLORS[index % COURSE_COLORS.length],
    }));
    mapped.forEach((course) => this.database.upsertCourse(course));
    this.database.markCoursesNotFavorite(mapped.map((course) => course.id));
    return includeArchived ? mapped : mapped.filter(course => !course.isArchived);
  }

  async startInitialSync(): Promise<{ courses: Course[]; job: SyncJob | null }> {
    const courses = await this.listCourses(false);
    if (!courses.length) return { courses, job: null };
    return { courses, job: await this.startSync(initialSyncSelection(courses)) };
  }

  refreshInBackground(signal: AbortSignal): Promise<boolean> {
    if (this.background) return this.background;
    if (this.closed || !this.database.getSetting("canvas.connection")) return Promise.resolve(true);
    if (this.running.size) return Promise.resolve(false);
    // Persist the barrier before favorites discovery or any metadata changes.
    const job: SyncJob = { id: createId("sync"), background: true, status: "syncing", startedAt: new Date().toISOString(), selection: { courseIds: [], categories: ["assignments"], includeArchivedCourses: true }, progress: { completed: 0, total: 0, message: "Refreshing Canvas assignments" }, errors: [] };
    const controller = new AbortController();
    const boundedSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]);
    this.running.set(job.id, { controller, job });
    this.persist(job);
    this.background = this.refreshMetadata(job, boundedSignal).finally(() => { this.running.delete(job.id); this.background = undefined; });
    return this.background;
  }

  private async refreshMetadata(job: SyncJob, signal: AbortSignal): Promise<boolean> {
    try {
      const courses = await this.listCourses(true, signal);
      job.selection.courseIds = courses.map(course => course.id);
      job.progress.total = courses.length;
      const client = this.client(this.connection().baseUrl);
      await mapWithConcurrency(courses, 2, async course => {
        try {
          const items = await client.paginate<CanvasAssignment>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/assignments?include[]=submission&include[]=rubric&include[]=assignment_visibility&per_page=100`, signal);
          abortIfNeeded(signal);
          const checkedAt = new Date().toISOString();
          const assignments = items.map(item => {
            if (!item || item.id == null || typeof item.name !== "string" || (item.due_at != null && !Number.isFinite(Date.parse(item.due_at)))) throw new Error("Canvas returned incomplete assignment metadata; previous assignments were kept.");
            const id = `${course.canvasId}:${item.id}`;
            const existing = this.database.assignment(id);
            const html = sanitizeCanvasHtml(item.description ?? "");
            return { ...existing, id, canvasId: String(item.id), courseId: course.id, courseName: course.name, courseColor: course.color, title: item.name, dueAt: item.due_at ?? null, pointsPossible: item.points_possible ?? null, submissionTypes: item.submission_types ?? [], descriptionHtml: html, descriptionMarkdown: markdownFromHtml(html), rubric: (item.rubric ?? []).map(criterion => ({ id: String(criterion.id ?? createId("criterion")), description: criterion.description ?? "Rubric criterion", longDescription: criterion.long_description, points: criterion.points ?? 0, ratings: criterion.ratings?.map(rating => ({ description: rating.description ?? "Rating", points: rating.points ?? 0 })) })), canvasSubmission: parseSubmission(item.submission, checkedAt), attachments: existing?.attachments ?? [], status: existing?.status ?? "pending", lockedForUser: item.locked_for_user === true, isQuiz: Boolean(item.quiz_id), updatedAt: item.updated_at ?? null } satisfies Assignment;
          });
          // Only reconcile a course after every page and item has been validated.
          this.database.reconcileAssignments(course.id, assignments);
        } catch (error) {
          abortIfNeeded(signal);
          job.errors.push({ courseId: course.id, category: "assignments", message: error instanceof Error ? error.message : "Canvas refresh failed." });
        }
        job.progress.completed++;
      }, signal);
      job.status = job.errors.length ? "partial" : "complete";
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      if (!signal.aborted) job.errors.push({ message: error instanceof Error ? error.message : "Canvas refresh failed." });
    }
    job.finishedAt = new Date().toISOString();
    this.persist(job);
    return job.status === "complete";
  }

  close(): void {
    for (const { controller, job } of this.running.values()) {
      controller.abort();
      this.persist({ ...job, status: "cancelled", finishedAt: new Date().toISOString() });
    }
    this.closed = true;
  }

  async checkSubmission(id: string): Promise<Assignment> {
    const assignment = this.database.assignment(id);
    const course = this.database.courses().find(course => course.id === assignment?.courseId && course.isFavorite === true);
    if (!assignment || !course) throw new Error("Choose an assignment from your synced Canvas favorites.");
    const item = await this.client(this.connection().baseUrl).json<CanvasAssignment>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/assignments/${encodeURIComponent(assignment.canvasId)}?include[]=submission`);
    if (String(item.id) !== assignment.canvasId) throw new Error("Canvas returned a different assignment. No status was changed.");
    const latest = this.database.assignment(id)!;
    this.database.upsertAssignment({ ...latest, canvasSubmission: parseSubmission(item.submission) });
    return this.database.assignment(id)!;
  }

  async checkPastSubmissions(): Promise<SubmissionCheckResult> {
    const courses = await this.listCourses(false);
    const past = this.database.assignments().filter(assignment => isPastAssignment(assignment));
    const result: SubmissionCheckResult = { assignments: [], errors: [] };
    const client = this.client(this.connection().baseUrl);
    await mapWithConcurrency(courses, 2, async course => {
      const wanted = past.filter(assignment => assignment.courseId === course.id);
      if (!wanted.length) return;
      try {
        // No bucket filter: include previously submitted and graded assignments too.
        // Only the current user's submission metadata is included, never answers.
        const items = await client.paginate<CanvasAssignment>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/assignments?include[]=submission&per_page=100`);
        const byId = new Map(items.map(item => [String(item.id), item]));
        const checkedAt = new Date().toISOString();
        for (const assignment of wanted) {
          const item = byId.get(assignment.canvasId);
          if (!item) {
            result.errors.push({ courseId: course.id, message: `${course.name}: ${assignment.title} was not returned by Canvas; its previous status was kept.` });
            continue;
          }
          const latest = this.database.assignment(assignment.id)!;
          this.database.upsertAssignment({ ...latest, canvasSubmission: parseSubmission(item.submission, checkedAt) });
          result.assignments.push(this.database.assignment(assignment.id)!);
        }
      } catch (error) {
        result.errors.push({ courseId: course.id, message: `${course.name}: ${error instanceof Error ? error.message : "Could not check submissions."}` });
      }
    }, new AbortController().signal);
    return result;
  }

  async startSync(selection: SyncSelection): Promise<SyncJob> {
    if (this.background) await this.background;
    const safeSelection: SyncSelection = {
      courseIds: [...new Set(selection.courseIds)],
      categories: CONTENT_CATEGORIES.filter((category) => selection.categories.includes(category)),
      includeArchivedCourses: selection.includeArchivedCourses,
    };
    if (!safeSelection.courseIds.length || !safeSelection.categories.length) throw new Error("Choose at least one course and one content type.");
    // Revalidate at confirmation: favorites or token permissions may have changed
    // while the checklist was open. Never start from a cached favorite flag.
    const favoriteCourseIds = new Set((await this.listCourses(safeSelection.includeArchivedCourses)).map((course) => course.id));
    if (!safeSelection.courseIds.every((courseId) => favoriteCourseIds.has(courseId))) {
      throw new Error("StudyFlow syncs only courses currently favorited in Canvas. Refresh the favorite course list and try again.");
    }
    const job: SyncJob = {
      id: createId("sync"),
      status: "queued",
      startedAt: new Date().toISOString(),
      selection: safeSelection,
      progress: { completed: 0, total: safeSelection.courseIds.length * safeSelection.categories.length, message: "Preparing secure read-only sync…" },
      errors: [],
    };
    const controller = new AbortController();
    this.running.set(job.id, { controller, job });
    this.persist(job);
    void this.run(job.id);
    return job;
  }

  cancel(jobId: string): void {
    const current = this.running.get(jobId);
    if (!current) return;
    current.controller.abort();
  }

  getJob(jobId: string): SyncJob | null {
    return this.running.get(jobId)?.job ?? this.database.syncJob(jobId);
  }

  private connection(): CanvasConnection {
    const raw = this.database.getSetting("canvas.connection");
    if (!raw) throw new Error("Connect Canvas before syncing.");
    return JSON.parse(raw) as CanvasConnection;
  }

  private client(baseUrl: string): CanvasHttpClient {
    const token = this.getToken();
    if (!token) throw new Error("The Canvas token is unavailable. Reconnect Canvas to continue.");
    return new CanvasHttpClient(baseUrl, token.trim(), this.fetcher);
  }

  private mapCourse(course: CanvasCourse, index: number): Course {
    const workflow = course.workflow_state === "completed" ? "completed" : course.workflow_state === "unpublished" ? "unpublished" : "available";
    const nickname = course.original_name && course.name !== course.original_name ? course.name : undefined;
    return {
      id: String(course.id),
      canvasId: String(course.id),
      name: course.name,
      originalName: course.original_name ?? course.name,
      nickname,
      code: course.course_code || course.name,
      color: COURSE_COLORS[index % COURSE_COLORS.length],
      workflowState: workflow,
      startAt: course.start_at ?? null,
      endAt: course.end_at ?? null,
      isArchived: workflow === "completed",
      isFavorite: true,
    };
  }

  private update(job: SyncJob, patch: Partial<SyncJob>): void {
    Object.assign(job, patch);
    this.persist(job);
  }

  private persist(job: SyncJob): void {
    if (this.closed) return;
    this.database.upsertSyncJob(job);
    this.onUpdate(structuredClone(job));
  }

  private tick(job: SyncJob, course: Course, category: ContentCategory, message: string): void {
    job.progress = { ...job.progress, completed: Math.min(job.progress.total, job.progress.completed + 1), courseId: course.id, courseName: course.name, category, message };
    this.persist(job);
  }

  private async run(jobId: string): Promise<void> {
    const running = this.running.get(jobId);
    if (!running) return;
    const { controller, job } = running;
    try {
      job.status = "syncing";
      this.persist(job);
      const connection = this.connection();
      const client = this.client(connection.baseUrl);
      let courses = this.database.courses().filter((course) => course.isFavorite === true && job.selection.courseIds.includes(course.id));
      if (courses.length !== job.selection.courseIds.length) {
        const fresh = await this.listCourses(job.selection.includeArchivedCourses);
        courses = fresh.filter((course) => job.selection.courseIds.includes(course.id));
      }
      if (!courses.length) throw new Error("The selected Canvas courses are no longer available.");
      await mapWithConcurrency(courses, 2, async (course) => {
        const assignmentKinds = ["assignments", "rubrics", "attachments"] as const;
        const assignmentCategories: ContentCategory[] = assignmentKinds.filter((category) => job.selection.categories.includes(category));
        if (assignmentCategories.length) {
          abortIfNeeded(controller.signal);
          try {
            await this.syncAssignments(client, course, controller.signal, job);
            assignmentCategories.forEach((category) => this.tick(job, course, category, `${course.name}: ${category} downloaded`));
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            assignmentCategories.forEach((category) => {
              job.errors.push({ courseId: course.id, category, message: error instanceof Error ? error.message : "Unknown sync error" });
              this.tick(job, course, category, `${course.name}: ${category} needs attention`);
            });
          }
        }
        for (const category of job.selection.categories.filter((category) => !assignmentCategories.includes(category))) {
          abortIfNeeded(controller.signal);
          try {
            await this.syncCategory(client, course, category, controller.signal, job);
            this.tick(job, course, category, `${course.name}: ${category} downloaded`);
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            job.errors.push({ courseId: course.id, category, message: error instanceof Error ? error.message : "Unknown sync error" });
            this.tick(job, course, category, `${course.name}: ${category} needs attention`);
          }
        }
        course.lastSyncedAt = new Date().toISOString();
        this.database.upsertCourse(course);
      }, controller.signal);
      job.status = job.errors.length ? "partial" : "complete";
      job.finishedAt = new Date().toISOString();
      this.persist(job);
    } catch (error) {
      job.status = error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
      job.finishedAt = new Date().toISOString();
      if (job.status === "failed") job.errors.push({ message: error instanceof Error ? error.message : "Sync failed." });
      this.persist(job);
    } finally {
      this.running.delete(job.id);
      this.fileDownloads.delete(job.id);
    }
  }

  private async syncCategory(client: CanvasHttpClient, course: Course, category: ContentCategory, signal: AbortSignal, job: SyncJob): Promise<void> {
    if (category === "assignments" || category === "rubrics" || category === "attachments") return;
    if (category === "quizzes") {
      // Canvas only returns visible metadata here; no question banks or answers are requested.
      await this.syncJsonCollection(client, course, category, `/api/v1/courses/${encodeURIComponent(course.canvasId)}/quizzes?per_page=100`, signal, job);
      return;
    }
    const endpoints: Record<Exclude<ContentCategory, "assignments" | "rubrics" | "attachments" | "quizzes">, string> = {
      modules: `/api/v1/courses/${encodeURIComponent(course.canvasId)}/modules?include[]=items&per_page=100`,
      files: `/api/v1/courses/${encodeURIComponent(course.canvasId)}/files?per_page=100`,
      pages: `/api/v1/courses/${encodeURIComponent(course.canvasId)}/pages?per_page=100`,
      syllabus: `/api/v1/courses/${encodeURIComponent(course.canvasId)}?include[]=syllabus_body`,
      announcements: `/api/v1/announcements?context_codes[]=course_${encodeURIComponent(course.canvasId)}&per_page=100`,
      discussions: `/api/v1/courses/${encodeURIComponent(course.canvasId)}/discussion_topics?per_page=100`,
      calendar: `/api/v1/calendar_events?context_codes[]=course_${encodeURIComponent(course.canvasId)}&all_events=true&per_page=100`,
    };
    await this.syncJsonCollection(client, course, category, endpoints[category], signal, job);
  }

  private async syncJsonCollection(client: CanvasHttpClient, course: Course, category: ContentCategory, endpoint: string, signal: AbortSignal, job: SyncJob): Promise<void> {
    job.progress.message = `Reading ${course.name}: ${category}…`;
    this.persist(job);
    const data = endpoint.includes("?include[]=syllabus_body") ? await client.json<unknown>(endpoint, signal) : await client.paginate<unknown>(endpoint, signal);
    const courseFolder = resolveInside(this.libraryPath, sanitizeFileName(course.name));
    const categoryFolder = resolveInside(courseFolder, category);
    await ensureDirectory(categoryFolder);
    const body = JSON.stringify(data, null, 2);
    await writeFile(resolveInside(categoryFolder, "index.json"), body, "utf8");
    if (category === "files" && Array.isArray(data)) {
      const downloaded: Attachment[] = [];
      await mapWithConcurrency(data.filter((entry): entry is CanvasAttachment => Boolean(entry && typeof entry === "object")), 2, async (entry) => { downloaded.push(await this.syncFile(client, categoryFolder, entry, signal, job, course)); }, signal);
      await writeFile(resolveInside(categoryFolder, "manifest.json"), JSON.stringify(downloaded, null, 2), "utf8");
    }
    if (category === "pages" || category === "discussions" || category === "syllabus") {
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        let html = typeof record.body === "string" ? record.body : typeof record.syllabus_body === "string" ? record.syllabus_body : null;
        if (category === "pages" && !html && typeof record.url === "string") {
          const page = await client.json<Record<string, unknown>>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/pages/${encodeURIComponent(record.url)}`, signal);
          html = typeof page.body === "string" ? page.body : null;
        }
        if (!html) continue;
        const baseName = sanitizeFileName(String(record.title ?? record.name ?? record.url ?? "content"));
        await writeFile(resolveInside(categoryFolder, `${baseName}.html`), sanitizeCanvasHtml(html), "utf8");
        await writeFile(resolveInside(categoryFolder, `${baseName}.md`), markdownFromHtml(html), "utf8");
      }
    }
  }

  private async syncAssignments(client: CanvasHttpClient, course: Course, signal: AbortSignal, job: SyncJob): Promise<void> {
    job.progress.message = `Reading ${course.name}: assignments…`;
    this.persist(job);
    const items = await client.paginate<CanvasAssignment>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/assignments?include[]=rubric&include[]=assignment_visibility&include[]=submission&per_page=100`, signal);
    const submissionCheckedAt = new Date().toISOString();
    for (const item of items) {
      abortIfNeeded(signal);
      const html = sanitizeCanvasHtml(item.description ?? "");
      const folder = resolveInside(this.libraryPath, sanitizeFileName(course.name), "Assignments", sanitizeFileName(item.name));
      await ensureDirectory(folder);
      const attachments: Attachment[] = [];
      const candidates = new Map<string, { file: CanvasAttachment; sourceUrl?: string }>();
      for (const file of item.attachments ?? []) candidates.set(String(file.id ?? file.url ?? file.filename), { file });
      // Read the raw HTML before sanitization removes Canvas's data-api-endpoint attribute.
      for (const link of canvasFileLinks(item.description ?? "", client.origin, course.canvasId)) {
        const existing = candidates.get(link.id);
        candidates.set(link.id, { file: existing?.file ?? { id: link.id }, sourceUrl: link.url });
      }
      await mapWithConcurrency([...candidates.values()], 2, async ({ file, sourceUrl }) => {
        try {
          if (sourceUrl) {
            job.progress.message = `Finding linked file ${file.id} for ${item.name}…`;
            this.persist(job);
            const metadata = await client.json<CanvasAttachment>(`/api/v1/courses/${encodeURIComponent(course.canvasId)}/files/${file.id}`, signal);
            if (String(metadata.id) !== String(file.id)) throw new Error("Canvas returned a different file ID.");
            file = metadata;
          }
          const attachment = await this.syncFile(client, folder, file, signal, job, course);
          attachments.push({ ...attachment, ...(sourceUrl ? { source: "description" as const, sourceUrl } : {}) });
        } catch {
          abortIfNeeded(signal);
          const message = `Could not download ${file.display_name ?? file.filename ?? `linked file ${file.id}`} for ${item.name}. Check Canvas access and retry sync.`;
          attachments.push({ id: String(file.id ?? file.filename), name: file.display_name ?? file.filename ?? `Canvas file ${file.id}`, source: sourceUrl ? "description" : undefined, sourceUrl, downloaded: false, downloadError: message });
          job.errors.push({ courseId: course.id, category: "attachments", message });
          this.persist(job);
        }
      }, signal);
      const assignment: Assignment = {
        canvasSubmission: parseSubmission(item.submission, submissionCheckedAt),
        id: `${course.canvasId}:${item.id}`,
        canvasId: String(item.id),
        courseId: course.id,
        courseName: course.name,
        courseColor: course.color,
        title: item.name,
        dueAt: item.due_at ?? null,
        pointsPossible: item.points_possible ?? null,
        submissionTypes: item.submission_types ?? [],
        descriptionHtml: html,
        descriptionMarkdown: markdownFromHtml(html),
        rubric: (item.rubric ?? []).map((criterion) => ({
          id: String(criterion.id ?? createId("criterion")),
          description: criterion.description ?? "Rubric criterion",
          longDescription: criterion.long_description,
          points: criterion.points ?? 0,
          ratings: criterion.ratings?.map((rating) => ({ description: rating.description ?? "Rating", points: rating.points ?? 0 })),
        })),
        attachments,
        localFolder: folder,
        status: attachments.some(attachment => attachment.downloadError) ? "pending" : "downloaded",
        lockedForUser: item.locked_for_user === true,
        isQuiz: Boolean(item.quiz_id),
        updatedAt: item.updated_at ?? null,
      };
      await writeFile(resolveInside(folder, "instructions.html"), assignment.descriptionHtml, "utf8");
      await writeFile(resolveInside(folder, "instructions.md"), assignment.descriptionMarkdown, "utf8");
      await writeFile(resolveInside(folder, "manifest.json"), JSON.stringify({ canvas: { courseId: course.canvasId, assignmentId: item.id, updatedAt: item.updated_at }, attachments }, null, 2), "utf8");
      this.database.upsertAssignment(assignment);
    }
  }

  /** One identity-based copy shared by Files and every assignment that links to it. */
  private async syncFile(client: CanvasHttpClient, fallbackFolder: string, file: CanvasAttachment, signal: AbortSignal, job: SyncJob, course: Course): Promise<Attachment> {
    abortIfNeeded(signal);
    if (file.locked_for_user || file.hidden_for_user) throw new Error("This file is not accessible to the current Canvas user.");
    const normalized = { ...file, content_type: file["content-type"] ?? file.content_type };
    // Canvas may advertise a CDN URL. Start at its authenticated download endpoint
    // instead; native fetch follows the redirect without forwarding cross-origin auth.
    if (file.id !== undefined && /^\d+$/.test(String(file.id)) && normalized.url && new URL(normalized.url, client.origin).origin !== client.origin) {
      normalized.url = `/courses/${encodeURIComponent(course.canvasId)}/files/${file.id}/download`;
    }
    if (file.id === undefined || !/^\d+$/.test(String(file.id))) return this.downloadAttachment(client, fallbackFolder, normalized, signal, job, course);
    let cache = this.fileDownloads.get(job.id);
    if (!cache) { cache = new Map(); this.fileDownloads.set(job.id, cache); }
    const key = `${course.id}:${file.id}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const download = (async () => {
      const folder = resolveInside(this.libraryPath, sanitizeFileName(course.name), "files", String(file.id));
      const recordPath = resolveInside(folder, "manifest.json");
      if (file.updated_at && !isVideoAttachment(file)) {
        try {
          const saved = JSON.parse(await readFile(recordPath, "utf8")) as { updatedAt?: string; checksum?: string; artifact: Attachment };
          const savedPath = saved.artifact.localPath;
          const relative = savedPath ? path.relative(folder, savedPath) : "..";
          if (saved.updatedAt === file.updated_at && saved.artifact.downloaded && savedPath && !relative.startsWith("..") && !path.isAbsolute(relative) && saved.checksum === await sha256File(savedPath)) {
            job.progress.message = `Using downloaded file: ${saved.artifact.name}`;
            this.persist(job);
            return saved.artifact;
          }
        } catch { /* Missing, changed, or damaged local files are downloaded again. */ }
      }
      if (!normalized.url && !isVideoAttachment(normalized)) throw new Error("Canvas did not provide a file download URL.");
      const artifact = await this.downloadAttachment(client, folder, normalized, signal, job, course);
      await ensureDirectory(folder);
      await writeFile(recordPath, JSON.stringify({ updatedAt: file.updated_at, checksum: artifact.localPath ? await sha256File(artifact.localPath) : undefined, artifact }, null, 2), "utf8");
      return artifact;
    })();
    cache.set(key, download);
    try { return await download; } catch (error) { cache.delete(key); throw error; }
  }

  private async downloadAttachment(client: CanvasHttpClient, destinationFolder: string, attachment: CanvasAttachment, signal: AbortSignal, job: SyncJob, course: Course): Promise<Attachment> {
    const name = sanitizeFileName(attachment.display_name || attachment.filename || `attachment-${attachment.id ?? "file"}`);
    const skippedVideo = (): Attachment => ({ id: String(attachment.id ?? name), name, contentType: attachment.content_type, size: attachment.size, url: attachment.url, downloaded: false, skippedReason: "video" });
    if (isVideoAttachment(attachment)) return skippedVideo();
    const localPath = resolveInside(destinationFolder, "Attachments", name);
    await ensureDirectory(path.dirname(localPath));
    if (!attachment.url) return { id: String(attachment.id ?? name), name, contentType: attachment.content_type, size: attachment.size, downloaded: false };
    const partialPath = `${localPath}.partial`;
    const partialSize = await stat(partialPath).then((info) => info.size).catch(() => 0);
    const transfer = { id: createId("download"), name, courseName: course.name, received: 0, total: attachment.size, status: "downloading" as "downloading" | "complete" | "failed" };
    job.progress.transfers = [...(job.progress.transfers ?? []).filter(item => item.status === "downloading" || item.status === "failed").slice(-30), transfer];
    job.progress.message = `Downloading ${name}`;
    this.persist(job);
    try {
    const response = await client.get(attachment.url, signal, { accept: "application/octet-stream", headers: partialSize ? { Range: `bytes=${partialSize}-` } : {} });
    if (isVideoAttachment({ content_type: response.headers.get("content-type") ?? undefined })) {
      await response.body?.cancel();
      job.progress.transfers = job.progress.transfers?.filter(item => item.id !== transfer.id);
      job.progress.message = `Skipped video: ${name}`;
      this.persist(job);
      return skippedVideo();
    }
    const append = partialSize > 0 && response.status === 206;
    const contentLength = response.headers.get("content-length");
    const responseSize = contentLength === null ? undefined : Number(contentLength);
    const expectedSize = responseSize !== undefined && Number.isFinite(responseSize)
      ? (append ? partialSize : 0) + responseSize
      : attachment.size ?? 0;
    if (Number.isFinite(expectedSize) && expectedSize > 250 * 1024 * 1024) throw new Error(`${name} is larger than StudyFlow's 250 MB attachment safety limit.`);
    await assertEnoughDiskSpace(destinationFolder, Number.isFinite(expectedSize) ? expectedSize * 2 : 0);
    transfer.received = append ? partialSize : 0;
    transfer.total = expectedSize || undefined;
    const handle = await open(partialPath, append ? "a" : "w");
    let lastUpdate = 0;
    const writeChunk = async (chunk: Uint8Array) => {
      abortIfNeeded(signal);
      if (transfer.received + chunk.byteLength > 250 * 1024 * 1024) throw new Error(`${name} exceeds the 250 MB safety limit.`);
      await handle.writeFile(chunk);
      transfer.received += chunk.byteLength;
      if (Date.now() - lastUpdate >= 150) { this.onUpdate(structuredClone(job)); lastUpdate = Date.now(); }
    };
    try {
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; await writeChunk(value); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } else await writeChunk(new Uint8Array(await response.arrayBuffer()));
    } finally { await handle.close(); }
    abortIfNeeded(signal);
    if (transfer.total && transfer.received !== transfer.total) throw new Error(`${name} download was interrupted; retry to resume.`);
    const checksum = await sha256File(partialPath);
    let finalPath = localPath;
    if (await fileExists(localPath)) {
      const existingChecksum = await sha256File(localPath);
      if (existingChecksum === checksum) {
        await rm(partialPath, { force: true });
      } else {
        const extension = path.extname(name);
        finalPath = resolveInside(destinationFolder, "Attachments", `${path.basename(name, extension)}-rev-${Date.now()}${extension}`);
        await rename(partialPath, finalPath);
      }
    } else {
      await rename(partialPath, finalPath);
    }
    const finalStat = await stat(finalPath);
    transfer.status = "complete";
    this.persist(job);
    return { id: String(attachment.id ?? name), name: path.basename(finalPath), contentType: attachment.content_type, size: finalStat.size, url: attachment.url, localPath: finalPath, downloaded: true };
    } catch (error) { transfer.status = "failed"; this.persist(job); throw error; }
  }
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let index = 0;
  const run = async (): Promise<void> => {
    while (index < items.length) {
      abortIfNeeded(signal);
      const current = items[index];
      index += 1;
      await worker(current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
