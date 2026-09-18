import { useMemo, useState, type ReactElement } from "react";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { ArrowSyncRegular, ChevronDownRegular, ChevronLeftRegular, ChevronRightRegular, SearchRegular } from "@fluentui/react-icons";
import type { AppleCalendarApi, AppleCalendarState } from "../../shared/apple-calendar";
import { AppleCalendarPanel } from "./AppleCalendarPanel";
import type { Assignment, Course, SyncJob } from "../../shared/types";

interface CalendarViewProps {
  appleApi?: AppleCalendarApi;
  appleState?: AppleCalendarState;
  month: Date;
  onChangeMonth: (month: Date) => void;
  assignments: Assignment[];
  courses: Course[];
  selectedAssignmentId: string | null;
  onSelectAssignment: (assignment: Assignment) => void;
  onOpenSync: () => void;
  search: string;
  setSearch: (value: string) => void;
  sync: SyncJob | null; onLibrarySearch?: () => void;
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dueDate(assignment: Assignment): Date | null {
  return assignment.dueAt ? new Date(assignment.dueAt) : null;
}

function AssignmentEvent({ assignment, selected, onClick }: { assignment: Assignment; selected: boolean; onClick: () => void }): ReactElement {
  const date = dueDate(assignment);
  return <button className={`calendar-event ${selected ? "event-selected" : ""}`} onClick={onClick} aria-label={`Open ${assignment.title}`} title={`${assignment.courseName}: ${assignment.title}`}>
    <span className="event-dot" style={{ background: assignment.courseColor }} />
    <span className="event-copy"><strong>{assignment.title}</strong><small>{date ? format(date, "h:mm a") : ""}</small></span>
  </button>;
}

export function CalendarView({ appleApi, appleState, month, onChangeMonth, assignments, selectedAssignmentId, onSelectAssignment, onOpenSync, search, setSearch, sync, onLibrarySearch }: CalendarViewProps): ReactElement {
  const [appleOpen, setAppleOpen] = useState(false);
  const days = useMemo(() => eachDayOfInterval({ start: startOfWeek(startOfMonth(month), { weekStartsOn: 0 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 0 }) }), [month]);
  const dayAssignments = useMemo(() => {
    const grouped = new Map<string, Assignment[]>();
    const query = search.toLowerCase();
    for (const assignment of assignments) {
      if (!assignment.title.toLowerCase().includes(query) && !assignment.courseName.toLowerCase().includes(query)) continue;
      const due = dueDate(assignment);
      if (!due || !Number.isFinite(due.getTime())) continue;
      const key = format(due, "yyyy-MM-dd");
      const entries = grouped.get(key) ?? [];
      entries.push(assignment);
      grouped.set(key, entries);
    }
    for (const entries of grouped.values()) entries.sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime() || a.title.localeCompare(b.title));
    return grouped;
  }, [assignments, search]);
  const isSyncing = sync?.status === "syncing" || sync?.status === "queued";
  return <main className="calendar-main">
    <header className="calendar-toolbar">
      <div className="month-controls"><button className="soft-button" onClick={() => onChangeMonth(new Date())}>Today</button><button className="icon-control" onClick={() => onChangeMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeftRegular /></button><button className="icon-control" onClick={() => onChangeMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRightRegular /></button><h1>{format(month, "MMMM yyyy")}</h1></div>
      <div className="toolbar-actions">{appleApi && <button className="soft-button apple-calendar-button" onClick={() => setAppleOpen(true)}><span>Sync to iPhone</span><small>{appleState?.status === "syncing" ? "Publishing…" : appleState?.status === "error" ? "Needs attention" : appleState?.status === "waiting" ? "Waiting for Canvas" : appleState?.connected ? "Live sync on" : "Set up iCloud"}</small></button>}<label className="search-box"><SearchRegular /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")onLibrarySearch?.();}} placeholder="Search · Enter for library" aria-label="Search assignments" /><kbd>Ctrl K</kbd></label><button className="sync-select"><ArrowSyncRegular className={isSyncing ? "spin" : ""} /><span>{isSyncing ? "Syncing…" : "Ready to sync"}</span><ChevronDownRegular /></button><button className="canvas-sync-button" onClick={onOpenSync}><ArrowSyncRegular /> Sync Canvas</button></div>
    </header>
    <section className="calendar-grid" aria-label={`${format(month, "MMMM yyyy")} calendar`}>
      {weekdayLabels.map((weekday) => <div className="weekday" key={weekday}>{weekday}</div>)}
      {days.map((day) => {
        const dayKey = format(day, "yyyy-MM-dd");
        const entries = dayAssignments.get(dayKey) ?? [];
        const isCurrent = isSameMonth(day, month);
        const hasSelected = entries.some((assignment) => assignment.id === selectedAssignmentId);
        return <div key={dayKey} data-date={dayKey} role="group" aria-label={`${format(day, "EEEE, MMMM d, yyyy")}: ${entries.length} assignments`} className={`calendar-day ${isCurrent ? "" : "outside-month"} ${hasSelected ? "day-has-selection" : ""}`}>
          <span className={`day-number ${hasSelected ? "day-active" : ""}`}>{format(day, "d")}</span>
          <div className="event-stack">{entries.map((assignment) => <AssignmentEvent key={assignment.id} assignment={assignment} selected={assignment.id === selectedAssignmentId} onClick={() => onSelectAssignment(assignment)} />)}</div>
        </div>;
      })}
    </section>
    {appleApi && appleState && <AppleCalendarPanel open={appleOpen} api={appleApi} state={appleState} onClose={() => setAppleOpen(false)} />}
  </main>;
}
