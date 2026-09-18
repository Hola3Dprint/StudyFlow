import { CalendarRegular, DismissRegular, DocumentRegular, FolderOpenRegular, InfoRegular, SparkleRegular } from "@fluentui/react-icons";
import type { ReactElement } from "react";
import type { Assignment, LocalAssignmentStatus } from "../../shared/types";
import { AssignmentProgress } from "./AssignmentProgress";
import { AssignmentDraftHistory } from "./AssignmentDraftHistory";
import { RelatedCourseMaterials } from "./RelatedCourseMaterials";
import type { StudyFlowApi } from "../../shared/types";

interface AssignmentDrawerProps {
  api: StudyFlowApi;
  assignment: Assignment | null;
  onClose: () => void;
  onOpenMaterials: (assignment: Assignment) => void;
  onStartAi: (assignment: Assignment) => void;
  onCheckSubmission: (id: string) => Promise<void>;
  onMarkProgress: (id: string, status: LocalAssignmentStatus) => Promise<void>;
}

function fileSize(size?: number): string {
  if (!size) return "";
  return `${Math.max(1, Math.round(size / 1_000))} KB`;
}

export function AssignmentDrawer({ api, assignment, onClose, onOpenMaterials, onStartAi, onCheckSubmission, onMarkProgress }: AssignmentDrawerProps): ReactElement {
  if (!assignment) return <aside className="assignment-drawer empty-drawer"><div className="empty-drawer-content"><SparkleRegular /><h2>Select an assignment</h2><p>Click any calendar item to see its instructions, materials, and reviewable AI workspace.</p></div></aside>;
  const description = assignment.descriptionMarkdown.split(/\n{2,}/).filter(Boolean);
  return <aside className="assignment-drawer" aria-label="Assignment preview">
    <header className="drawer-topline"><span className="course-indicator"><i style={{ background: assignment.courseColor }} />{assignment.courseName}</span><button className="drawer-close" onClick={onClose} aria-label="Close assignment preview"><DismissRegular /></button></header>
    <h2>{assignment.title}</h2>
    <div className="assignment-meta"><div><CalendarRegular /><span>Due {assignment.dueAt ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(assignment.dueAt)) : "No due date"}</span></div><div><span className="meta-points">▣</span><span>{assignment.pointsPossible ?? "—"} points</span></div><div><DocumentRegular /><span>{assignment.submissionTypes.includes("online_upload") ? "Written Assignment" : assignment.submissionTypes.includes("online_quiz") ? "Quiz metadata" : "Assignment"}</span></div></div>
    <div className="drawer-rule" />
    <AssignmentProgress key={assignment.id} assignment={assignment} onCheck={onCheckSubmission} onMark={onMarkProgress} />
    <RelatedCourseMaterials key={`related-${assignment.id}`} api={api} assignment={assignment} />
    <AssignmentDraftHistory key={`drafts-${assignment.id}`} api={api} assignmentId={assignment.id} compact />
    <section className="drawer-section"><h3>Description</h3>{description.length ? description.map((paragraph) => <p key={paragraph}>{paragraph}</p>) : <p>Instructions are not available locally yet. Sync this assignment from Canvas.</p>}</section>
    <div className="drawer-rule" />
    <section className="drawer-section attachments-section"><h3>Attachments</h3><div className="attachment-list">{assignment.attachments.length ? assignment.attachments.map((attachment) => <div className="attachment-row" key={attachment.id}><DocumentRegular /><span><strong>{attachment.name}</strong><small>{attachment.contentType ?? "File"}{attachment.size ? ` • ${fileSize(attachment.size)}` : ""}</small></span><span className={attachment.downloaded ? "downloaded-label" : "not-downloaded-label"}>{attachment.skippedReason === "video" ? "Video skipped" : attachment.downloaded ? "⌄ Downloaded" : "Pending"}</span></div>) : <p className="empty-attachments">No files were attached to this assignment.</p>}</div></section>
    <div className="ai-disclaimer"><InfoRegular /><span>AI-generated content can be inaccurate.<br />Review all output and verify sources.</span></div>
    <div className="drawer-actions"><button className="open-materials" onClick={() => onOpenMaterials(assignment)}><FolderOpenRegular /> Open materials</button><button className="start-ai" onClick={() => onStartAi(assignment)} disabled={assignment.isQuiz || assignment.lockedForUser}><SparkleRegular /> {assignment.isQuiz || assignment.lockedForUser ? "Quiz assistance unavailable" : "Start AI workspace"}</button></div>
  </aside>;
}
