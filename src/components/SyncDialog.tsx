import { useEffect, useState, type ReactElement } from "react";
import { DismissRegular, InfoRegular } from "@fluentui/react-icons";
import { CONTENT_CATEGORIES, type ContentCategory, type Course, type SyncSelection } from "../../shared/types";

interface SyncDialogProps {
  loadCourses: (includeArchived: boolean) => Promise<Course[]>;
  onCoursesLoaded: (courses: Course[]) => void;
  onOpenSettings: () => void;
  onClose: () => void;
  onConfirm: (selection: SyncSelection) => Promise<void>;
}

const categoryLabels: Record<ContentCategory, string> = {
  modules: "Modules and module items",
  files: "Course files",
  pages: "Pages",
  assignments: "Assignments and instructions",
  rubrics: "Rubrics",
  syllabus: "Syllabus",
  announcements: "Announcements",
  discussions: "Discussions",
  calendar: "Calendar and planner entries",
  quizzes: "Visible quiz metadata only",
  attachments: "Assignment attachments",
};

export function SyncDialog({ loadCourses, onCoursesLoaded, onOpenSettings, onClose, onConfirm }: SyncDialogProps): ReactElement {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(true);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ContentCategory[]>(() => [...CONTENT_CATEGORIES]);
  const [includeArchivedCourses, setIncludeArchivedCourses] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setRefreshing(true);
    setRefreshError(null);
    setError(null);
    void loadCourses(includeArchivedCourses).then(fresh => {
      if (!active) return;
      setCourses(fresh);
      setCourseIds(fresh.map(course => course.id));
      onCoursesLoaded(fresh);
    }).catch(issue => {
      if (!active) return;
      setCourses([]);
      setCourseIds([]);
      setRefreshError(issue instanceof Error ? issue.message : "Could not refresh Canvas favorites. Check your connection and retry.");
    }).finally(() => { if (active) setRefreshing(false); });
    return () => { active = false; };
  }, [includeArchivedCourses, refreshAttempt, loadCourses, onCoursesLoaded]);
  const toggleCourse = (id: string) => setCourseIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  const toggleCategory = (category: ContentCategory) => setCategories((current) => current.includes(category) ? current.filter((entry) => entry !== category) : [...current, category]);
  const submit = async () => {
    if (refreshing || refreshError || working || !courseIds.length || !categories.length) return;
    setWorking(true); setError(null);
    try { await onConfirm({ courseIds, categories, includeArchivedCourses }); onClose(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not start Canvas sync."); } finally { setWorking(false); }
  };
  return <div className="modal-backdrop" role="presentation"><section className="sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
    <header><div><h2 id="sync-dialog-title">Sync Canvas</h2><p>Choose exactly what StudyFlow should download. It lists only courses favorited in Canvas, uses your Canvas nickname when available, and never submits to Canvas.</p></div><button className="drawer-close" onClick={onClose} aria-label="Close sync checklist"><DismissRegular /></button></header>
    <div className="sync-dialog-body"><section aria-busy={refreshing}><div className="checklist-heading"><h3>Favorited courses</h3><button disabled={refreshing || working || Boolean(refreshError) || !courses.length} onClick={() => setCourseIds(courseIds.length === courses.length ? [] : courses.map((course) => course.id))}>{courseIds.length === courses.length ? "Clear all" : "Select all"}</button></div>
      {refreshing ? <p role="status">Refreshing favorites from Canvas…</p> : refreshError ? <p className="form-error" role="alert">{refreshError}</p> : courses.length ? <div className="check-list">{courses.map((course) => <label key={course.id}><input type="checkbox" disabled={working} checked={courseIds.includes(course.id)} onChange={() => toggleCourse(course.id)} /><span className="course-dot" style={{ background: course.color }} />{course.name}</label>)}</div> : <p role="status">No current favorites were returned by Canvas. Star the course in Canvas, then refresh favorites.</p>}
      <div className="settings-buttons"><button className="soft-button" disabled={refreshing || working} onClick={() => { setRefreshing(true); setRefreshAttempt(current => current + 1); }}>Refresh favorites</button>{refreshError || error ? <button className="soft-button" disabled={working} onClick={onOpenSettings}>Open Settings</button> : null}</div>
      <label className="archive-toggle"><input type="checkbox" disabled={refreshing || working} checked={includeArchivedCourses} onChange={(event) => { setRefreshing(true); setIncludeArchivedCourses(event.target.checked); }} /> Include archived favorites when checking Canvas</label></section>
      <section><div className="checklist-heading"><h3>Content to organize</h3><button onClick={() => setCategories(categories.length === CONTENT_CATEGORIES.length ? [] : [...CONTENT_CATEGORIES])}>{categories.length === CONTENT_CATEGORIES.length ? "Clear all" : "Select all"}</button></div><div className="category-check-grid">{CONTENT_CATEGORIES.map((category) => <label key={category}><input type="checkbox" checked={categories.includes(category)} onChange={() => toggleCategory(category)} />{categoryLabels[category]}</label>)}</div></section>
      <div className="sync-callout"><InfoRegular /><span>Downloads go to <strong>Documents\StudyFlow</strong>, organized by course and content type. Existing files are retained as safe revisions.</span></div>
      {error ? <p className="form-error" role="alert">{error} Refresh favorites before trying again.</p> : null}
    </div>
    <footer><button className="soft-button" onClick={onClose}>Cancel</button><button className="canvas-sync-button" disabled={refreshing || Boolean(refreshError) || Boolean(error) || working || !courseIds.length || !categories.length} onClick={submit}>{working ? "Starting…" : refreshing ? "Refreshing favorites…" : "Confirm and sync"}</button></footer>
  </section></div>;
}
