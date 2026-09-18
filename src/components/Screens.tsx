import { DownloadProgress } from "./DownloadProgress";
import { AssignmentStatusBadges } from "./AssignmentProgress";
import { isPastAssignment, isUnsubmittedOnCanvas } from "../../shared/assignment-status";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowDownloadRegular, BookOpenRegular, DismissRegular, DocumentRegular, FolderOpenRegular, InfoRegular, OpenRegular, PreviewLinkRegular, SparkleRegular } from "@fluentui/react-icons";
import type { AiRun, Assignment, CanvasConnection, CanvasConnectResult, CodexAccount, Course, DeliverableSpec, StudyFlowApi, SubmissionCheckResult, SyncJob } from "../../shared/types";

export function CoursesScreen({ courses, assignments, onSelectAssignment, onCheckPastSubmissions }: { courses: Course[]; assignments: Assignment[]; onSelectAssignment: (assignment: Assignment) => void; onCheckPastSubmissions: () => Promise<SubmissionCheckResult> }): ReactElement {
  const [pastOnly, setPastOnly] = useState(false);
  const [unsubmittedOnly, setUnsubmittedOnly] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const check = async () => {
    setChecking(true); setNotice(null); setErrors([]);
    try {
      const result = await onCheckPastSubmissions();
      setNotice(`Checked ${result.assignments.length} past assignment${result.assignments.length === 1 ? "" : "s"}. No work was submitted to Canvas.`);
      setErrors(result.errors.map(error => error.message));
    } catch (issue) { setErrors([issue instanceof Error ? issue.message : "Could not check Canvas submissions."]); } finally { setChecking(false); }
  };
  return <section className="simple-screen"><header className="screen-header"><h1>Courses</h1><p>Your locally organized Canvas favorites. Choose an assignment to review its downloaded materials.</p></header>
    <section className="past-submission-controls" aria-label="Assignment filters and past submission checks"><div><button className="canvas-sync-button" disabled={checking || !assignments.some(assignment => isPastAssignment(assignment))} onClick={() => void check()}>{checking ? "Checking past submissions…" : "Check past submissions on Canvas"}</button><label><input type="checkbox" checked={pastOnly} onChange={event => setPastOnly(event.target.checked)} /> Show past assignments only</label><label><input type="checkbox" checked={unsubmittedOnly} onChange={event => setUnsubmittedOnly(event.target.checked)} /> Show unsubmitted assignments only</label></div><p>{unsubmittedOnly ? "Shows assignments Canvas has most recently reported as unsubmitted or missing. Run a Canvas check to refresh this status." : "Checks downloaded assignments with past due dates in your current Canvas favorites, without downloading files."}</p>{notice && <p role="status">{notice}</p>}{errors.length > 0 && <div className="form-error" role="alert">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}</section>
    <div className="course-cards">{courses.map((course) => {
      const courseAssignments = assignments.filter((assignment) => assignment.courseId === course.id && (!pastOnly || isPastAssignment(assignment)) && (!unsubmittedOnly || isUnsubmittedOnCanvas(assignment)));
      return <article className="course-card" key={course.id}><div className="course-card-top"><i style={{ background: course.color }} /><div><h2>{course.name}</h2><p>{course.code}</p></div></div><div className="course-assignment-list">{courseAssignments.map((assignment) => <button key={assignment.id} onClick={() => onSelectAssignment(assignment)}><DocumentRegular /><span>{assignment.title}<AssignmentStatusBadges assignment={assignment} /></span><small>{assignment.dueAt ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(assignment.dueAt)) : "No due date"}</small></button>)}{unsubmittedOnly && courseAssignments.length === 0 ? <p className="empty-course-assignments">No unsubmitted assignments reported by Canvas.</p> : null}</div></article>;
    })}</div></section>;
}

function formatAttachmentSize(size?: number): string {
  if (!size) return "Size unavailable";
  return size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1_000))} KB`;
}

export function DownloadsScreen({ assignments, onOpenSync, sync }: { sync: SyncJob | null; assignments: Assignment[]; onOpenSync: () => void }): ReactElement {
  const [preview, setPreview] = useState<Assignment | null>(null);
  const totalFiles = assignments.reduce((sum, assignment) => sum + assignment.attachments.filter((attachment) => attachment.downloaded).length, 0);
  return <section className="simple-screen downloads-screen"><header className="screen-header"><div><h1>Downloads</h1><p>Choose courses and individual content categories, or select all to download everything available.</p><p>{totalFiles} assignment attachment{totalFiles === 1 ? "" : "s"} downloaded locally.</p></div><button className="canvas-sync-button" onClick={onOpenSync} disabled={sync?.status === "syncing" || sync?.status === "queued"}><ArrowDownloadRegular />{sync?.status === "syncing" || sync?.status === "queued" ? "Downloading…" : "Download course materials"}</button></header><DownloadProgress sync={sync} />
    <div className={`downloads-body${preview ? " with-preview" : ""}`}><div className="download-table"><div className="download-header"><span>Assignment</span><span>Local files</span><span>Preview</span></div>{assignments.filter((assignment) => assignment.attachments.length).map((assignment) => <div className="download-row" key={assignment.id}><span><DocumentRegular />{assignment.title}</span><span>{assignment.attachments.filter((attachment) => attachment.downloaded).length} downloaded</span><button type="button" aria-pressed={preview?.id === assignment.id} onClick={() => setPreview(assignment)}><PreviewLinkRegular /> Preview</button></div>)}</div>
      {preview ? <aside className="download-preview" aria-label="Download preview"><div className="download-preview-header"><span>Preview</span><button type="button" aria-label="Close preview" onClick={() => setPreview(null)}><DismissRegular /></button></div><div className="download-preview-content"><span className="course-indicator"><i style={{ background: preview.courseColor }} />{preview.courseName}</span><h2>{preview.title}</h2><dl className="download-preview-meta"><div><dt>Files</dt><dd>{preview.attachments.filter((attachment) => attachment.downloaded).length} downloaded</dd></div><div><dt>Due</dt><dd>{preview.dueAt ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(preview.dueAt)) : "No due date"}</dd></div></dl><section><h3>Assignment overview</h3><p>{preview.descriptionMarkdown || "No assignment instructions were downloaded."}</p></section><section><h3>Local files</h3><ul className="download-preview-files">{preview.attachments.map((attachment) => <li key={attachment.id}><DocumentRegular /><span><strong>{attachment.name}</strong><small>{attachment.downloaded ? "Downloaded locally" : "Not downloaded"} · {attachment.contentType ?? "File"} · {formatAttachmentSize(attachment.size)}</small></span></li>)}</ul></section>{preview.rubric.length ? <section><h3>Rubric</h3><ul className="download-preview-rubric">{preview.rubric.map((criterion) => <li key={criterion.id}><span>{criterion.description}</span><strong>{criterion.points} pts</strong></li>)}</ul></section> : null}</div></aside> : null}</div></section>;
}

function requirementsFor(assignment: Assignment): Array<[string, string]> {
  const limits = assignment.descriptionMarkdown.match(/\b\d{2,5}\s*(?:to|-|–)\s*\d{2,5}\s*(?:words|pages)\b/i)?.[0] ?? "Confirm from Canvas instructions";
  return [["Deliverable", assignment.submissionTypes.includes("online_upload") ? "Uploaded document" : "Text entry"], ["Length", limits], ["Citations", /apa/i.test(assignment.descriptionMarkdown) ? "APA" : "Confirm with course materials"], ["Rubric", assignment.rubric.length ? `${assignment.rubric.length} criteria linked` : "No rubric downloaded"]];
}

export function AiWorkspaceScreen({ api, assignment, account, onAccountChange, latestRun, onRunChange, draftStarting, onStartDraft, courses=[] }: { api: StudyFlowApi; assignment: Assignment | null; account: CodexAccount; onAccountChange: (account: CodexAccount) => void; latestRun: AiRun | null; onRunChange: (run: AiRun) => void; draftStarting: boolean; onStartDraft: StudyFlowApi["ai"]["start"]; courses?:Course[] }): ReactElement {
  const [context,setContext] = useState<Record<string,string[]>>({});
  const [research, setResearch] = useState(false);
  const [formats, setFormats] = useState<Record<string, boolean>>({ docx: true, pdf: true, md: true, tex: false, pptx: false, xlsx: false, csv: false, txt: false, zip: false });
  const [status, setStatus] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const currentRun = latestRun?.assignmentId === assignment?.id ? latestRun : null;
  const working = starting || draftStarting || latestRun?.status === "queued" || latestRun?.status === "running";
  const otherDraftWorking = working && !currentRun && !starting;
  const activeRole = currentRun?.agents?.find(agent => agent.status === "running")?.role;
  const specs = useMemo(() => Object.entries(formats).filter(([, selected]) => selected).map(([format]) => ({ format }) as DeliverableSpec), [formats]);
  useEffect(() => {
    if (account.authMode === "chatgpt") return;
    const timer = window.setInterval(() => { void api.codex.account().then(onAccountChange).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [api, account.authMode, onAccountChange]);
  useEffect(() => { const unsubscribe = api.onAiRun(onRunChange); return unsubscribe; }, [api, onRunChange]);
  if (!assignment) return <section className="simple-screen ai-empty"><SparkleRegular /><h1>AI Workspace</h1><p>Select a downloaded assignment from the calendar to prepare a requirements sheet and editable draft.</p></section>;
  const begin = async () => {
    if (working) return;
    setStarting(true);
    setStatus(null);
    try {
      if (account.authMode !== "chatgpt") {
        await api.codex.loginBrowser();
        const updated = await api.codex.account();
        onAccountChange(updated);
        setStatus("Your sign-in browser was opened. Return here after completing login, then start the workspace.");
        return;
      }
      await onStartDraft({ assignmentId: assignment.id, researchedSourcesEnabled: research, deliverables: specs, additionalCourseIds:context[assignment.id]??[] });
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not start the workspace."); }
    finally { setStarting(false); }
  };
  return <section className="ai-screen"><header className="screen-header"><div><span className="course-indicator"><i style={{ background: assignment.courseColor }} />{assignment.courseName}</span><h1>{assignment.title}</h1><p>Isolated local workspace. Nothing is submitted to Canvas.</p></div><button className="open-workspace" onClick={() => assignment.localFolder && api.files.reveal(assignment.localFolder)}><OpenRegular /> Open assignment folder</button></header>
    <details className="requirements-card"><summary>Course context · {assignment.courseName} by default</summary><p>Agents search only this course unless you select additional course materials below. Selected source revisions stay fixed for this run.</p>{courses.filter(c=>c.id!==assignment.courseId).map(c=><label key={c.id} className="research-option"><input type="checkbox" disabled={working} checked={context[assignment.id]?.includes(c.id)??false} onChange={e=>setContext(current=>({...current,[assignment.id]:e.target.checked?[...current[assignment.id]??[],c.id]:(current[assignment.id]??[]).filter(id=>id!==c.id)}))}/>{c.name}</label>)}</details>
    {otherDraftWorking ? <div className="workspace-safety" role="status"><InfoRegular /><span>Another draft is preparing or running. Only one draft can run at a time. Wait for it to finish or stop the active team.</span>{latestRun?.status === "running" ? <button className="soft-button" onClick={() => api.ai.cancel(latestRun.id)}>Stop active team</button> : null}</div> : null}
    <div className="ai-workspace-grid"><section className="requirements-card"><h2>Requirements sheet</h2><div className="requirement-grid">{requirementsFor(assignment).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><h3>Rubric coverage</h3>{assignment.rubric.length ? <ul className="rubric-list">{assignment.rubric.map((criterion) => <li key={criterion.id}><span>{criterion.description}</span><strong>{criterion.points} pts</strong></li>)}</ul> : <p>No rubric was available in the current sync.</p>}<div className="workspace-safety"><InfoRegular /><span>The draft will show its assumptions, evidence, citations, formulas, and intermediate calculations when relevant. It will not expose private model reasoning.</span></div></section>
      <section className="generation-card"><h2>Build reviewable files</h2><p>StudyFlow chooses clean, natural formatting from your requirements. You can also choose each output type.</p><div className="format-checks">{Object.keys(formats).map((format) => <label key={format}><input type="checkbox" checked={formats[format]} onChange={() => setFormats((current) => ({ ...current, [format]: !current[format] }))} />{format.toUpperCase()}</label>)}</div><label className="research-option"><input type="checkbox" checked={research} onChange={(event) => setResearch(event.target.checked)} /><span><strong>Allow researched sources</strong><small>Network access stays disabled unless you opt in for this run. Every source is tracked.</small></span></label><button className="ai-primary" onClick={begin} aria-busy={working} disabled={working || !specs.length || assignment.isQuiz || assignment.lockedForUser}><SparkleRegular className={working ? "spin" : undefined} />{starting ? "Preparing workspace…" : working ? `Working…${activeRole ? ` ${activeRole}` : ""}` : account.authMode === "chatgpt" ? currentRun?.status === "failed" ? "Retry draft" : "Create reviewable draft" : "Connect ChatGPT plan"}</button>{status ? <p className="form-note">{status}</p> : null}</section>
    </div>
    <section className="requirements-card"><h2>Your assignment team</h2><p>Course preparation → Solver → Formatter → Quality analyst. Review feedback returns to the solver and formatter for one correction pass.</p><p>{latestRun?.assignmentId === assignment.id && latestRun.indexedFiles !== undefined ? `${latestRun.indexedFiles} source revisions available in this run’s frozen library snapshot.` : "Downloaded course materials are indexed once and updated after sync. Agents search the saved index and include relevant source revisions; instructions, rubric and linked attachments are always included."}</p><div className="requirement-grid">{["Course preparation", "Solver", "Formatter", "Quality analyst"].map(role => { const member = latestRun?.assignmentId === assignment.id ? latestRun.agents?.find(agent => agent.role === role) : undefined; return <div key={role}><strong>{role}</strong><span>{member?.status ?? "waiting"}</span>{member?.output ? <details><summary>Read handoff</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{member.output}</pre></details> : null}</div>; })}</div>{latestRun?.assignmentId === assignment.id && latestRun.status === "running" ? <button className="soft-button" onClick={() => api.ai.cancel(latestRun.id)}>Stop team</button> : null}{latestRun?.assignmentId === assignment.id && latestRun.qaReport ? <details><summary>Quality review</summary><pre style={{ whiteSpace: "pre-wrap" }}>{latestRun.qaReport}</pre></details> : null}{latestRun?.assignmentId === assignment.id ? latestRun.artifacts.map(artifact => <button className="soft-button" key={artifact.id} onClick={() => api.files.open(artifact.path)}>Open {artifact.format.toUpperCase()}</button>) : null}</section>
    {latestRun && latestRun.assignmentId === assignment.id ? <section className={`run-card run-${latestRun.status}`}><div><span className="run-status">{latestRun.status.replace("_", " ")}</span><h2>{latestRun.status === "failed" ? "Draft could not be completed" : latestRun.status === "cancelled" ? "Workspace stopped" : ["awaiting_review", "complete"].includes(latestRun.status) ? "Draft ready for review" : "AI workspace in progress"}</h2><p>{latestRun.progress.at(-1)}</p></div>{latestRun.artifacts.length ? <div className="artifact-pills">{latestRun.artifacts.map((artifact) => <span key={artifact.id}>{artifact.format.toUpperCase()}</span>)}</div> : null}</section> : null}
  </section>;
}

export function SettingsScreen({ api, account, onAccountChange, connection, onConnectionChange, onCanvasConnected, libraryPath }: { api: StudyFlowApi; account: CodexAccount; onAccountChange: (account: CodexAccount) => void; connection: CanvasConnection | null; onConnectionChange: (value: CanvasConnection | null) => void; onCanvasConnected: (result: CanvasConnectResult) => void; libraryPath: string }): ReactElement {
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "https://your-school.instructure.com");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "remove" | null>(null);
  const [removeKeyPrompt, setRemoveKeyPrompt] = useState(false);
  const canvasConnected = Boolean(connection?.hasStoredToken);
  useEffect(() => {
    if (account.authMode === "chatgpt") return;
    const timer = window.setInterval(() => { void api.codex.account().then(onAccountChange).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [api, account.authMode, onAccountChange]);
  useEffect(() => { if (connection?.baseUrl) setBaseUrl(connection.baseUrl); }, [connection?.baseUrl]);
  const connectCanvas = async () => {
    setBusy("connect");
    try {
      const result = await api.canvas.connect({ baseUrl, token });
      onCanvasConnected(result);
      setToken("");
      setRemoveKeyPrompt(false);
      setNotice(result.initialSync
        ? `Canvas key was validated. Initial read-only sync of ${result.courses.length} Canvas favorite${result.courses.length === 1 ? "" : "s"} started automatically.`
        : result.initialSyncError
          ? `Canvas key was saved, but automatic sync could not start: ${result.initialSyncError} Use Sync Canvas to retry.`
          : "Canvas key was validated. No active Canvas favorites were available to sync.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save the Canvas access key.");
    } finally {
      setBusy(null);
    }
  };
  const removeCanvasKey = async () => {
    setBusy("remove");
    try {
      await api.canvas.disconnect();
      onConnectionChange(null);
      setToken("");
      setRemoveKeyPrompt(false);
      setNotice("The saved Canvas access key and connection details were removed from this device. Local course files were kept.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove the saved Canvas access key.");
    } finally {
      setBusy(null);
    }
  };
  const login = async () => { try { await api.codex.loginBrowser(); onAccountChange(await api.codex.account()); setNotice("Sign-in opened in your browser. Return here after it completes."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not begin ChatGPT sign-in."); } };
  const loginDevice = async () => { try { const loginResult = await api.codex.loginDevice(); setNotice(loginResult.userCode ? `Device code: ${loginResult.userCode}` : "Device code sign-in was started."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not start device-code sign-in."); } };
  return <section className="settings-screen"><header className="screen-header"><h1>Settings</h1><p>Connections remain local to this Windows device. Canvas is read-only.</p></header><div className="settings-grid"><section className="settings-card credential-card"><div className="settings-card-icon"><BookOpenRegular /></div><h2>Canvas API key</h2><p>Add, replace, or remove your Canvas personal access token here. After a valid key is saved, StudyFlow immediately begins a read-only sync of your Canvas favorites and uses their Canvas nicknames when available.</p><div className={`credential-state ${canvasConnected ? "credential-state-connected" : ""}`} role="status"><strong>{canvasConnected ? "Canvas key saved for future launches" : "No Canvas key stored"}</strong><span>{canvasConnected ? `${connection?.accountName ?? "Canvas account"} · ${connection?.baseUrl}` : "Add a key to validate your Canvas account and start the initial sync."}</span></div><label>Institution Canvas URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://school.instructure.com" inputMode="url" /></label><label>{canvasConnected ? "Replace personal access token" : "Personal access token"}<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" placeholder={canvasConnected ? "Saved securely — enter a token only to replace it" : "Paste token locally"} /></label><div className="settings-buttons"><button type="button" className="canvas-sync-button" onClick={connectCanvas} disabled={!token.trim() || busy !== null}>{busy === "connect" ? "Validating and syncing…" : canvasConnected ? "Replace key & sync courses" : "Add key & sync courses"}</button>{canvasConnected && !removeKeyPrompt ? <button type="button" className="danger-button" onClick={() => setRemoveKeyPrompt(true)} disabled={busy !== null}>Remove saved key</button> : null}</div>{removeKeyPrompt ? <div className="credential-confirmation" role="alert"><span>Remove the encrypted key and saved Canvas connection? Your downloaded course files stay on this computer.</span><div><button type="button" className="soft-button" onClick={() => setRemoveKeyPrompt(false)} disabled={busy !== null}>Keep key</button><button type="button" className="danger-button" onClick={removeCanvasKey} disabled={busy !== null}>{busy === "remove" ? "Removing…" : "Remove key"}</button></div></div> : null}</section>
    <section className="settings-card"><div className="settings-card-icon"><SparkleRegular /></div><h2>ChatGPT plan</h2><p>StudyFlow uses Codex’s managed ChatGPT browser sign-in, not a manually entered OpenAI API key or ordinary API billing.</p><div className="account-state"><strong>{account.authMode === "chatgpt" ? `${account.planType ?? "ChatGPT"} connected` : "Not connected"}</strong><span>{account.email ?? "Use your eligible ChatGPT plan through the secure browser flow."}</span>{account.usage.map((limit) => <small key={limit.label}>{limit.label}: {limit.remaining ?? "Available"}</small>)}</div><div className="settings-buttons">{account.authMode === "chatgpt" ? <button type="button" className="soft-button" onClick={() => api.codex.logout().then(async () => onAccountChange(await api.codex.account())).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not log out of ChatGPT."))}>Log out</button> : <button type="button" className="ai-primary" onClick={login}><SparkleRegular /> Connect ChatGPT</button>}<button type="button" className="soft-button" onClick={loginDevice}>Use device code</button></div></section>
    <section className="settings-card library-card"><div className="settings-card-icon"><ArrowDownloadRegular /></div><h2>Local library</h2><p>Documents\StudyFlow stores canonical course files, source metadata, revisions, and isolated AI workspaces. Uninstalling StudyFlow preserves this library.</p><button type="button" className="soft-button" disabled={!libraryPath} onClick={() => api.files.open(libraryPath).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not open the StudyFlow library."))}><FolderOpenRegular /> Open StudyFlow library</button></section></div>{notice ? <p className="settings-notice" role="status">{notice}</p> : null}</section>;
}
