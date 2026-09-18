import { useEffect, useState } from "react";
import type { Assignment, StudyFlowApi } from "../../shared/types";
import type { AssignmentMaterials, LibraryPreview } from "../../shared/library";

export function RelatedCourseMaterials({ api, assignment }: { api: StudyFlowApi; assignment: Assignment }) {
  const [result, setResult] = useState<AssignmentMaterials>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<LibraryPreview>();
  const [previewing, setPreviewing] = useState<string>();
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError(undefined);
      void Promise.resolve().then(() => api.library.forAssignment(assignment.id)).then(value => { if (live) setResult(value); })
        .catch(() => { if (live) setError("Local suggestions aren’t available right now. You can retry after indexing."); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [api, assignment, retry]);
  const choose = async (id: string) => {
    if (previewing) return;
    setPreviewing(id); setError(undefined);
    try { setPreview(await api.library.preview(id)); }
    catch { setError("This source could not be previewed. Refresh suggestions and try again."); }
    finally { setPreviewing(undefined); }
  };
  return <details className="related-materials">
    <summary><span>Related course material<small>{loading ? "Searching locally…" : result?.items.length ? `${result.items.length} suggestion${result.items.length === 1 ? "" : "s"} · optional` : "Explore local sources · optional"}</small></span></summary>
    <div className="related-materials-body">
      <p className="related-materials-note">From this class only, using assignment context and the local index. Suggestions—not required reading.</p>
      {error ? <p role="status">{error}</p> : null}
      {!loading && !error && !result?.items.length ? <p>{result?.indexedDocuments ? "No strong matches yet. More assignment detail or indexed attachments may help." : "No indexed material for this course yet. Download it and refresh the Library index."}</p> : null}
      {result?.items.map(({ hit, reason }) => <article key={hit.documentId}>
        <button className="related-material-title" disabled={Boolean(previewing)} onClick={() => void choose(hit.id)}>{hit.title}</button>
        <small>{hit.location} · {reason}</small>
        <p className="related-material-snippet">{hit.snippet}</p>
      </article>)}
      {previewing ? <p role="status">Opening source preview…</p> : null}
      {preview ? <div className="related-source-preview" aria-label="Related material preview"><strong>{preview.hit.title} · {preview.hit.location}</strong>{preview.imageUrl ? <img src={preview.imageUrl} alt={`Original ${preview.hit.location} of ${preview.hit.title}`} /> : null}<p>{preview.text}</p>{preview.hit.warning ? <small>{preview.hit.warning}</small> : null}<div><button className="soft-button" onClick={() => void api.library.open(preview.hit.id).catch(() => setError("The original file could not be opened."))}>Open original</button><button className="soft-button" onClick={() => setPreview(undefined)}>Close source preview</button></div></div> : null}
      <button className="related-refresh" disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh suggestions</button>
    </div>
  </details>;
}
