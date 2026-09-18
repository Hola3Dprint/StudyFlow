import type { CanvasSubmissionStatus } from "../../shared/types";

export function parseSubmission(input: unknown, checkedAt = new Date().toISOString()): CanvasSubmissionStatus {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const state = data.workflow_state;
  return {
    workflowState: state === "unsubmitted" || state === "submitted" || state === "pending_review" || state === "graded" ? state : "unknown",
    submittedAt: typeof data.submitted_at === "string" && Number.isFinite(Date.parse(data.submitted_at)) ? data.submitted_at : null,
    missing: data.missing === true,
    late: data.late === true,
    excused: data.excused === true,
    checkedAt,
  };
}
