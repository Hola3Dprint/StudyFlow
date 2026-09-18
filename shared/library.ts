export type MatchKind = "keyword" | "semantic" | "visual";
export type LinkKind = "explicit" | "membership" | "semantic" | "visual" | "manual";
export interface LibraryQuery { query: string; documentId?: string; courseIds?: string[]; module?: string; fileType?: string; kind?: "all" | "text" | "visual"; archived?: boolean; similarTo?: string; limit?: number }
export interface LibraryHit { id: string; documentId: string; revision: string; courseId: string; title: string; location: string; snippet: string; kind: MatchKind; score: number; visual: boolean; warning?: string; module?: string }
export interface LibraryLink { id: string; source: string; target: string; kind: LinkKind; reason: string; pinned: boolean; dismissed: boolean; sourceTitle?: string; targetTitle?: string }
export interface LibraryNode { id: string; title: string; courseId: string; kind: "course" | "module" | "assignment" | "document"; count?: number }
export interface LibraryGraph { nodes: LibraryNode[]; links: LibraryLink[]; truncated: boolean }
export interface LibraryStatus { state: "idle" | "indexing" | "paused" | "downloading" | "failed"; completed: number; total: number; filename?: string; error?: string; issues: string[]; modelsReady: boolean; descriptionsReady?: boolean; documents: number; passages: number; received?: number; bytes?: number }
export interface LibraryPreview { hit: LibraryHit; text: string; imageUrl?: string; links: LibraryLink[] }
export interface AssignmentMaterialSuggestion { hit: LibraryHit; reason: string }
export interface AssignmentMaterials { items: AssignmentMaterialSuggestion[]; query: string; indexedDocuments: number }
export interface LibraryApi {
  forAssignment(assignmentId: string): Promise<AssignmentMaterials>;
  search(query: LibraryQuery): Promise<LibraryHit[]>;
  status(): Promise<LibraryStatus>;
  control(action: "index" | "pause" | "resume" | "cancel" | "setup" | "setup-descriptions"): Promise<LibraryStatus>;
  preview(id: string): Promise<LibraryPreview>;
  graph(input: { courseIds?: string[]; expanded?: string[]; focus?: string; archived?: boolean }): Promise<LibraryGraph>;
  related(documentId: string): Promise<LibraryLink[]>;
  link(input: { source: string; target: string; kind: LinkKind; action: "pin" | "dismiss" | "restore" }): Promise<void>;
  open(id: string): Promise<void>;
}
