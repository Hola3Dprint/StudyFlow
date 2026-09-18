import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AiRun, Assignment, Course, LocalArtifact, LocalAssignmentStatus, SyncJob } from "../../shared/types";

type JsonRow = { payload: string };
type AssignmentRow = JsonRow & { local_status?: LocalAssignmentStatus; local_updated_at?: string };
function readAssignment(row: AssignmentRow): Assignment {
  const assignment = JSON.parse(row.payload) as Assignment;
  delete assignment.localProgress;
  if (row.local_status && row.local_updated_at) assignment.localProgress = { status: row.local_status, updatedAt: row.local_updated_at };
  return assignment;
}

export class StudyFlowDatabase {
  private readonly database: Database.Database;
  private calendarChangeListener: (() => void) | null = null;

  onCalendarChange(listener: () => void): void { this.calendarChangeListener = listener; }

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, due_at TEXT, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assignments_due_at ON assignments(due_at);
      CREATE TABLE IF NOT EXISTS assignment_progress (assignment_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('not_started','completed','submitted')), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, assignment_id TEXT, course_id TEXT, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_runs_assignment ON ai_runs(assignment_id, updated_at DESC);
    `);
  }

  close(): void {
    this.calendarChangeListener = null;
    this.database.close();
  }

  getSetting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.database.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    if (key === "canvas.connection") this.calendarChangeListener?.();
  }

  deleteSetting(key: string): void {
    this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
    if (key === "canvas.connection") this.calendarChangeListener?.();
  }

  upsertCourse(course: Course): void {
    this.database.prepare("INSERT INTO courses(id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(course.id, JSON.stringify(course), new Date().toISOString());
    this.calendarChangeListener?.();
  }

  courses(): Course[] {
    return (this.database.prepare("SELECT payload FROM courses ORDER BY updated_at DESC").all() as JsonRow[]).map((row) => JSON.parse(row.payload) as Course);
  }

  markCoursesNotFavorite(favoriteCourseIds: Iterable<string>): void {
    const favorites = new Set(favoriteCourseIds);
    for (const course of this.courses()) {
      const isFavorite = favorites.has(course.id);
      if (course.isFavorite === isFavorite) continue;
      this.upsertCourse({ ...course, isFavorite });
    }
  }

  upsertAssignment(assignment: Assignment): void {
    const stored = { ...assignment };
    delete stored.localProgress;
    const previous = this.assignment(assignment.id)?.canvasSubmission;
    if (previous && (!stored.canvasSubmission || previous.checkedAt > stored.canvasSubmission.checkedAt)) stored.canvasSubmission = previous;
    this.database.prepare("INSERT INTO assignments(id, course_id, due_at, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id, due_at = excluded.due_at, payload = excluded.payload, updated_at = excluded.updated_at")
      .run(assignment.id, assignment.courseId, assignment.dueAt ?? null, JSON.stringify(stored), new Date().toISOString());
    this.calendarChangeListener?.();
  }

  assignments(): Assignment[] {
    return (this.database.prepare("SELECT a.payload, p.status AS local_status, p.updated_at AS local_updated_at FROM assignments a LEFT JOIN assignment_progress p ON p.assignment_id = a.id ORDER BY a.due_at IS NULL, a.due_at ASC").all() as AssignmentRow[]).map(readAssignment).filter(item => !item.canvasRemoved);
  }

  reconcileAssignments(courseId: string, assignments: Assignment[]): void {
    const listener = this.calendarChangeListener;
    this.calendarChangeListener = null;
    try {
      this.database.transaction(() => {
        const ids = new Set(assignments.map(item => item.id));
        for (const old of this.assignments().filter(item => item.courseId === courseId && !ids.has(item.id))) this.upsertAssignment({ ...old, canvasRemoved: true });
        for (const item of assignments) this.upsertAssignment({ ...item, canvasRemoved: false });
      })();
    } finally { this.calendarChangeListener = listener; }
    listener?.();
  }

  recoverInterruptedSyncs(): void {
    for (const row of this.database.prepare("SELECT payload FROM sync_jobs").all() as JsonRow[]) {
      const job = JSON.parse(row.payload) as SyncJob;
      if (["queued", "syncing"].includes(job.status)) this.upsertSyncJob({ ...job, status: "cancelled", finishedAt: new Date().toISOString() });
    }
  }

  assignment(id: string): Assignment | null {
    const row = this.database.prepare("SELECT a.payload, p.status AS local_status, p.updated_at AS local_updated_at FROM assignments a LEFT JOIN assignment_progress p ON p.assignment_id = a.id WHERE a.id = ?").get(id) as AssignmentRow | undefined;
    return row ? readAssignment(row) : null;
  }

  setAssignmentProgress(id: string, status: LocalAssignmentStatus): Assignment {
    if (!this.assignment(id)) throw new Error("Assignment not found. Sync Canvas first.");
    this.database.prepare("INSERT INTO assignment_progress(assignment_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(assignment_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").run(id, status, new Date().toISOString());
    this.calendarChangeListener?.();
    return this.assignment(id)!;
  }

  upsertArtifact(artifact: LocalArtifact): void {
    this.database.prepare("INSERT INTO artifacts(id, assignment_id, course_id, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(artifact.id, artifact.assignmentId ?? null, artifact.courseId ?? null, JSON.stringify(artifact), new Date().toISOString());
  }

  artifactsForAssignment(assignmentId: string): LocalArtifact[] {
    return (this.database.prepare("SELECT payload FROM artifacts WHERE assignment_id = ? ORDER BY updated_at DESC").all(assignmentId) as JsonRow[])
      .map((row) => JSON.parse(row.payload) as LocalArtifact);
  }

  upsertSyncJob(job: SyncJob): void {
    this.database.prepare("INSERT INTO sync_jobs(id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(job.id, JSON.stringify(job), new Date().toISOString());
    if (job.status === "queued" || ["complete", "partial", "failed", "cancelled"].includes(job.status)) this.calendarChangeListener?.();
  }

  syncJob(id: string): SyncJob | null {
    const row = this.database.prepare("SELECT payload FROM sync_jobs WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.payload) as SyncJob : null;
  }

  activeSyncJob(): SyncJob | null {
    const rows = this.database.prepare("SELECT payload FROM sync_jobs ORDER BY updated_at DESC LIMIT 6").all() as JsonRow[];
    return rows.map((row) => JSON.parse(row.payload) as SyncJob).find((job) => job.status === "queued" || job.status === "syncing") ?? null;
  }

  upsertAiRun(run: AiRun): void {
    this.database.prepare("INSERT INTO ai_runs(id, assignment_id, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
      .run(run.id, run.assignmentId, JSON.stringify(run), new Date().toISOString());
  }
  aiRunsForAssignment(assignmentId: string): AiRun[] {
    return (this.database.prepare("SELECT payload FROM ai_runs WHERE assignment_id = ? ORDER BY updated_at DESC, id DESC").all(assignmentId) as JsonRow[])
      .map(row => JSON.parse(row.payload) as AiRun);
  }
}
