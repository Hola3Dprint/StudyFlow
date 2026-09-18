import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import type { AiRun, AppBootstrap, Assignment, CanvasConnection, CanvasConnectResult, CodexAccount, Course, SyncJob, SyncSelection } from "../shared/types";
import { AssignmentDrawer } from "./components/AssignmentDrawer";
import { CalendarView } from "./components/CalendarView";
import { CoursesScreen, DownloadsScreen, AiWorkspaceScreen, SettingsScreen } from "./components/Screens";
import { Sidebar, type AppTheme, type AppView } from "./components/Sidebar";
import { SyncDialog } from "./components/SyncDialog";
import { mockApi } from "./mock-api";
import { SAMPLE_ASSIGNMENTS } from "./sample-data";
import { useAppleCalendar } from "./use-apple-calendar";
import { LibraryScreen } from "./components/LibraryScreen";
import { AssignmentDraftHistory } from "./components/AssignmentDraftHistory";

const isDesktopRenderer = /\bElectron\//.test(navigator.userAgent);
const api = window.studyflow ?? mockApi;
const THEME_STORAGE_KEY = "studyflow-color-theme";

function getSavedTheme(): AppTheme {
  return "rainbow";
}

function InitialLoading(): ReactElement {
  return <div className="startup-screen"><span className="startup-logo">StudyFlow</span><div className="startup-line" /></div>;
}

function DesktopBridgeUnavailable({ theme }: { theme: AppTheme }): ReactElement {
  return <main className="desktop-bridge-error" data-theme={theme} role="alert"><span className="startup-logo">StudyFlow</span><h1>Desktop service unavailable</h1><p>StudyFlow could not connect to its local Canvas service, so no demo courses are shown. Close this window and start the app with <strong>Run-StudyFlow.bat</strong>.</p></main>;
}

function StudyFlowApp({ theme }: { theme: AppTheme }): ReactElement {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [view, setView] = useState<AppView>("calendar");
  const [month, setMonth] = useState(() => new Date());
  const appleCalendar = useAppleCalendar(api.appleCalendar);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("research-methods-literature-review");
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [sync, setSync] = useState<SyncJob | null>(null);
  const [latestRun, setLatestRun] = useState<AiRun | null>(null);
  const [draftStarting, setDraftStarting] = useState(false);
  const draftStartLock = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { const handler = (event:KeyboardEvent) => { if ((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k") {event.preventDefault();setView("library");} }; window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler); },[]);

  useEffect(() => {
    let subscribed = true;
    const refreshLibrary = () => api.bootstrap().then((data) => {
      if (!subscribed) return;
      setBootstrap(data);
      setSync(current => data.activeSync ?? current);
      setLatestRun(current => current ?? data.activeAiRun ?? null);
      setSelectedId((current) => data.assignments.some((assignment) => assignment.id === current) ? current : data.assignments[0]?.id ?? current);
    }).catch((error) => setToast(error instanceof Error ? error.message : "StudyFlow could not load its local library."));
    void refreshLibrary();
    const removeSync = api.onSync((job) => {
      if (!subscribed) return;
      if (!job.background) setSync(job);
      if (["complete", "partial", "failed", "cancelled"].includes(job.status)) void refreshLibrary();
    });
    const removeRun = api.onAiRun(setLatestRun);
    return () => { subscribed = false; removeSync(); removeRun(); };
  }, []);

  const courses = useMemo(() => bootstrap?.courses?.length ? bootstrap.courses : [], [bootstrap]);
  const assignments = useMemo(() => {
    const known = bootstrap?.assignments?.length ? bootstrap.assignments : window.studyflow ? [] : SAMPLE_ASSIGNMENTS;
    const favoriteIds = new Set(courses.map(course => course.id));
    return known.filter(assignment => favoriteIds.has(assignment.courseId));
  }, [bootstrap, courses]);
  const selected = assignments.find((assignment) => assignment.id === selectedId) ?? null;
  const account = useMemo(() => bootstrap?.codexAccount ?? { authMode: "none", usage: [], isAvailable: true } as CodexAccount, [bootstrap]);
  const connection = useMemo(() => bootstrap?.connection ?? null, [bootstrap]);
  const selectAssignment = useCallback((assignment: Assignment) => { setSelectedId(assignment.id); setDrawerOpen(true); }, []);
  const beginSync = useCallback(async (selection: SyncSelection) => { const job = await api.canvas.startSync(selection); setSync(job); setToast("Canvas sync started with your selected courses and content."); }, []);
  const applyFavoriteCourses = useCallback((fresh: Course[]) => {
    setBootstrap(current => current ? { ...current, courses: fresh } : current);
  }, []);
  const applyAssignments = useCallback((updated: Assignment[]) => {
    const byId = new Map(updated.map(assignment => [assignment.id, assignment]));
    setBootstrap(current => current ? { ...current, assignments: current.assignments.map(assignment => byId.get(assignment.id) ?? assignment) } : current);
  }, []);
  const checkSubmission = useCallback(async (id: string) => { applyAssignments([await api.canvas.checkSubmission(id)]); }, [applyAssignments]);
  const markProgress = useCallback(async (id: string, status: Parameters<typeof api.canvas.setLocalProgress>[1]) => { applyAssignments([await api.canvas.setLocalProgress(id, status)]); }, [applyAssignments]);
  const checkPastSubmissions = useCallback(async () => {
    const result = await api.canvas.checkPastSubmissions();
    applyAssignments(result.assignments);
    return result;
  }, [applyAssignments]);
  const openMaterials = useCallback((assignment: Assignment) => { if (assignment.localFolder) void api.files.reveal(assignment.localFolder); else setToast("These demo materials will appear in Documents\\StudyFlow after a real Canvas sync."); }, []);
  const startAi = useCallback((assignment: Assignment) => { setSelectedId(assignment.id); setView("ai"); setDrawerOpen(false); }, []);
  const beginDraft = useCallback(async (input: Parameters<typeof api.ai.start>[0]) => {
    if (draftStartLock.current || latestRun?.status === "queued" || latestRun?.status === "running") throw new Error("A draft is already preparing or running. Wait for it to finish or stop it first.");
    draftStartLock.current = true;
    setDraftStarting(true);
    try { const run = await api.ai.start(input); setLatestRun(run); return run; }
    finally { draftStartLock.current = false; setDraftStarting(false); }
  }, [latestRun]);
  const changeAccount = useCallback((next: CodexAccount) => setBootstrap((current) => current ? { ...current, codexAccount: next } : current), []);
  const changeConnection = useCallback((next: CanvasConnection | null) => setBootstrap((current) => current ? { ...current, connection: next } : current), []);
  const applyCanvasConnection = useCallback((result: CanvasConnectResult) => {
    setBootstrap((current) => current ? { ...current, connection: result.connection, courses: result.courses, activeSync: result.initialSync } : current);
    setSync(result.initialSync);
  }, []);
  let content: ReactElement;
  if (view === "library") content = <LibraryScreen api={api} courses={courses} initialQuery={search}/>;
  else if (view === "courses") content = <CoursesScreen courses={courses} assignments={assignments} onCheckPastSubmissions={checkPastSubmissions} onSelectAssignment={(assignment) => { selectAssignment(assignment); setView("calendar"); }} />;
  else if (view === "downloads") content = <DownloadsScreen sync={sync} assignments={assignments} onOpenSync={() => setSyncDialogOpen(true)} />;
  else if (view === "ai") content = <div className="ai-history-layout"><section className="requirements-card"><label>Assignment <select aria-label="AI workspace assignment" value={selectedId} onChange={event => setSelectedId(event.target.value)} style={{ maxWidth: "100%" }}>{assignments.map(assignment => <option key={assignment.id} value={assignment.id}>{assignment.courseName} · {assignment.title}</option>)}</select></label></section>{selected ? <AssignmentDraftHistory key={selected.id} api={api} assignmentId={selected.id} /> : null}<AiWorkspaceScreen api={api} courses={courses} assignment={selected} account={account} onAccountChange={changeAccount} latestRun={latestRun} onRunChange={setLatestRun} draftStarting={draftStarting} onStartDraft={beginDraft} /></div>;
  else if (view === "settings") content = <SettingsScreen api={api} account={account} onAccountChange={changeAccount} connection={connection} onConnectionChange={changeConnection} onCanvasConnected={applyCanvasConnection} libraryPath={bootstrap?.libraryPath ?? ""} />;
  else content = <CalendarView appleApi={api.appleCalendar} appleState={appleCalendar} month={month} onChangeMonth={setMonth} assignments={assignments} courses={courses} selectedAssignmentId={selectedId} onSelectAssignment={selectAssignment} onOpenSync={() => setSyncDialogOpen(true)} search={search} setSearch={setSearch} sync={sync} onLibrarySearch={()=>setView("library")} />;
  if (!bootstrap && isDesktopRenderer) return <InitialLoading />;
  return <div className={`app-shell ${sidebarCollapsed ? "shell-collapsed" : ""} ${drawerOpen && selected ? "drawer-visible" : "drawer-hidden"}`} data-theme={theme}>
    <Sidebar view={view} setView={setView} courses={courses} sync={sync} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((current) => !current)} />
    {content}
    {view === "calendar" ? <AssignmentDrawer api={api} assignment={drawerOpen ? selected : null} onClose={() => setDrawerOpen(false)} onOpenMaterials={openMaterials} onStartAi={startAi} onCheckSubmission={checkSubmission} onMarkProgress={markProgress} /> : <aside className="screen-side-rail" />}
    {syncDialogOpen ? <SyncDialog loadCourses={api.canvas.listCourses} onCoursesLoaded={applyFavoriteCourses} onOpenSettings={() => { setSyncDialogOpen(false); setView("settings"); }} onClose={() => setSyncDialogOpen(false)} onConfirm={beginSync} /> : null}
    {toast ? <button className="toast" onClick={() => setToast(null)}>{toast}</button> : null}
  </div>;
}

export default function App(): ReactElement {
  const theme = getSavedTheme();
  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = "light";
    void api.appearance?.setTheme(theme);
  }, [theme]);

  return <FluentProvider theme={webLightTheme}>
    {isDesktopRenderer && !window.studyflow ? <DesktopBridgeUnavailable theme={theme} /> : <StudyFlowApp theme={theme} />}
  </FluentProvider>;
}
