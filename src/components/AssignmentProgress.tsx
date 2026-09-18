import { useState } from "react";
import type { Assignment, LocalAssignmentStatus } from "../../shared/types";
import { canvasSubmissionLabel, localProgressLabel } from "../../shared/assignment-status";

export function AssignmentStatusBadges({ assignment }: { assignment: Assignment }) {
  const marked = assignment.localProgress && assignment.localProgress.status !== "not_started";
  if (!assignment.canvasSubmission && !marked) return null;
  return <span className="assignment-status-badges">
    {assignment.canvasSubmission && <span className={`status-badge ${assignment.canvasSubmission.missing ? "status-missing" : ""}`}>{canvasSubmissionLabel(assignment)}</span>}
    {marked && <span className="status-badge status-local">{localProgressLabel(assignment)}</span>}
  </span>;
}

export function AssignmentProgress({ assignment, onCheck, onMark }: {
  assignment: Assignment;
  onCheck: (id: string) => Promise<void>;
  onMark: (id: string, status: LocalAssignmentStatus) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"check" | "mark" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "check" | "mark", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind); setError(null);
    try { await action(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Could not update assignment status."); } finally { setBusy(null); }
  };
  const status = assignment.canvasSubmission;
  return <section className="assignment-progress" aria-label="Assignment progress">
    <h3>Submission & completion</h3>
    <strong>{canvasSubmissionLabel(assignment)}</strong>
    {status && <small>Checked {new Date(status.checkedAt).toLocaleString()}{status.workflowState === "graded" ? " · Graded" : status.workflowState === "pending_review" ? " · Pending review" : ""}</small>}
    {status?.submittedAt && <small>Canvas submission time: {new Date(status.submittedAt).toLocaleString()}</small>}
    <button className="soft-button" disabled={busy !== null} onClick={() => void run("check", () => onCheck(assignment.id))}>{busy === "check" ? "Checking Canvas…" : "Check submission on Canvas"}</button>
    <label>Your local mark<select aria-label="Your local assignment status" disabled={busy !== null} value={assignment.localProgress?.status ?? "not_started"} onChange={event => { const next = event.target.value as LocalAssignmentStatus; void run("mark", () => onMark(assignment.id, next)); }}>
      <option value="not_started">Not marked complete</option><option value="completed">Completed — marked by me</option><option value="submitted">Submitted — marked by me</option>
    </select></label>
    <small role="status">{busy === "mark" ? "Saving your mark…" : localProgressLabel(assignment)}</small>
    <p>Your mark is saved only in StudyFlow. It does not submit work or confirm receipt on Canvas.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
