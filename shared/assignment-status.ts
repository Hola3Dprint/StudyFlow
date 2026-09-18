import type { Assignment } from "./types";

export function canvasSubmissionLabel(assignment: Assignment): string {
  const status = assignment.canvasSubmission;
  if (!status) return "Canvas: not checked";
  if (status.excused) return "Excused on Canvas";
  if (status.missing) return "Missing on Canvas";
  if (status.workflowState === "unsubmitted") return "Not submitted on Canvas";
  if (status.workflowState === "submitted" || status.workflowState === "pending_review" || status.submittedAt) {
    return status.late ? "Submitted late on Canvas" : "Submitted on Canvas";
  }
  // A teacher can enter a grade without a student submission.
  if (status.workflowState === "graded") return "Graded on Canvas; submission unconfirmed";
  return "Canvas submission unknown";
}

export function localProgressLabel(assignment: Assignment): string {
  if (assignment.localProgress?.status === "completed") return "Completed — marked by you";
  if (assignment.localProgress?.status === "submitted") return "Submitted — marked by you";
  return "Not marked complete";
}

/** True only when the latest Canvas check confirms that work still needs submitting. */
export function isUnsubmittedOnCanvas(assignment: Assignment): boolean {
  const status = assignment.canvasSubmission;
  return Boolean(status && !status.excused && (status.workflowState === "unsubmitted" || status.missing));
}

export function isPastAssignment(assignment: Assignment, now = Date.now()): boolean {
  return Boolean(assignment.dueAt && new Date(assignment.dueAt).getTime() < now);
}
