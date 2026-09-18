import type { ComponentType, ReactElement } from "react";
import { AddRegular, ArrowDownloadRegular, BookOpenRegular, CalendarLtrRegular, ChevronDoubleLeftRegular, SettingsRegular, SparkleRegular } from "@fluentui/react-icons";
import type { Course, SyncJob } from "../../shared/types";

export type AppView = "calendar" | "courses" | "downloads" | "library" | "ai" | "settings";
export type AppTheme = "rainbow";

interface SidebarProps {
  view: AppView;
  setView: (view: AppView) => void;
  courses: Course[];
  sync: SyncJob | null;
  collapsed: boolean;
  onToggle: () => void;
}

const navItems: Array<{ id: AppView; label: string; Icon: ComponentType<{ className?: string }> }> = [
  { id: "calendar", label: "Calendar", Icon: CalendarLtrRegular },
  { id: "courses", label: "Courses", Icon: BookOpenRegular },
  { id: "downloads", label: "Downloads", Icon: ArrowDownloadRegular },
  { id: "library", label: "Library", Icon: BookOpenRegular },
  { id: "ai", label: "AI Workspace", Icon: SparkleRegular },
  { id: "settings", label: "Settings", Icon: SettingsRegular },
];

function SyncStatus({ course, sync }: { course: Course; sync: SyncJob | null }): ReactElement {
  const state = sync?.status === "syncing" && sync.selection.courseIds.includes(course.id) ? "Syncing…" : course.lastSyncedAt ? "Synced" : "";
  return <div className="sync-course-row"><span className="course-dot" style={{ background: course.color }} /><span>{course.name}</span><span className={state === "Synced" ? "status-good" : "status-sync"}>{state}</span></div>;
}

export function Sidebar({ view, setView, courses, sync, collapsed, onToggle }: SidebarProps): ReactElement {
  const progress = sync && sync.progress.total > 0 ? Math.round((sync.progress.completed / sync.progress.total) * 100) : 0;
  const syncing = sync?.status === "syncing" || sync?.status === "queued";
  return <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`} aria-label="StudyFlow navigation">
    <div className="wordmark-row"><span className="wordmark">StudyFlow</span><button className="sidebar-collapse" onClick={onToggle} aria-label="Collapse sidebar"><ChevronDoubleLeftRegular /></button></div>
    <nav className="primary-nav">
      {navItems.map(({ id, label, Icon }) => <button key={id} className={`nav-item ${view === id ? "nav-selected" : ""}`} onClick={() => setView(id)} title={collapsed ? label : undefined} aria-label={label}><Icon /><span>{label}</span></button>)}
    </nav>
    <section className="courses-rail">
      <div className="rail-heading"><span>My Courses</span><button className="tiny-icon" aria-label="Add course"><AddRegular /></button></div>
      <div className="course-list">
        {courses.map((course, index) => <button className={`course-row ${index === 0 ? "course-row-selected" : ""}`} key={course.id} onClick={() => setView("courses")}><span className="course-dot" style={{ background: course.color }} /><span>{course.name}</span></button>)}
      </div>
    </section>
    <section className="sync-card" aria-live="polite">
      <div className="sync-card-heading"><span>{syncing ? "Downloading from Canvas" : sync ? `Sync ${sync.status}` : "Ready to download"}</span><small>{sync ? `${progress}%` : ""}</small></div>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      {syncing ? <p className="sync-current-file">{sync?.progress.transfers?.filter(file => file.status === "downloading").map(file => file.name).join(" · ") || sync?.progress.message}</p> : null}
      <div className="sync-course-list">{courses.slice(0, 5).map(course => <SyncStatus key={course.id} course={course} sync={sync} />)}</div>
    </section>
    <section className="theme-picker rainbow-only" aria-label="Appearance"><span className="theme-picker-label">Appearance</span><strong>Rainbow</strong></section>
    <button className="bottom-collapse" onClick={onToggle} aria-label="Collapse sidebar"><ChevronDoubleLeftRegular /></button>
  </aside>;
}
