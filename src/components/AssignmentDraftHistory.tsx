import { useEffect, useState } from "react";
import type { AiRun, StudyFlowApi } from "../../shared/types";

export function AssignmentDraftHistory({ api, assignmentId, compact = false }: { api: StudyFlowApi; assignmentId: string; compact?: boolean }) {
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const updates = new Map<string, AiRun>();
    setLoading(true); setError(undefined); setRuns([]); setSelected(undefined);
    const unsubscribe = api.onAiRun(run => {
      if (run.assignmentId !== assignmentId) return;
      updates.set(run.id, run);
      setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
    });
    void Promise.resolve().then(() => api.ai.history(assignmentId)).then(saved => {
      if (live) setRuns([...updates.values(), ...saved.filter(run => !updates.has(run.id))]);
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : "Could not load saved drafts."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; unsubscribe(); };
  }, [api, assignmentId, retry]);
  const run = runs.find(item => item.id === selected) ?? runs[0];
  const open = async (file: string, reveal = false) => {
    try { await (reveal ? api.files.reveal(file) : api.files.open(file)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The saved file could not be opened."); }
  };
  return <section className={compact ? "drawer-section" : "requirements-card"} aria-label="Saved AI drafts">
    <h3>Saved AI drafts</h3>
    {loading ? <p role="status">Loading saved drafts…</p> : null}
    {error ? <p role="alert">{error} <button className="soft-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : null}
    {!loading && !error && !runs.length ? <p>No drafts saved for this assignment yet.</p> : null}
    {run ? <>
      <label>Saved version <select aria-label="Saved draft version" value={run.id} onChange={event => setSelected(event.target.value)} style={{ maxWidth: "100%" }}>
        {runs.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {item.status.replaceAll("_", " ")} · {item.artifacts.length} files</option>)}
      </select></label>
      <p>{run.artifacts.length} saved files · {run.finishedAt ? "Finished " + new Date(run.finishedAt).toLocaleString() : "Started " + new Date(run.startedAt).toLocaleString()}</p>
      <div className="artifact-pills">{run.artifacts.map(artifact => <button className="soft-button" key={artifact.id} onClick={() => void open(artifact.path)}>Open {artifact.format.toUpperCase()}</button>)}
        <button className="soft-button" onClick={() => void open(run.workspacePath, true)}>Open saved workspace</button></div>
      {run.output ? <details><summary>Read saved draft</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{run.output}</pre></details> : null}
      {!compact ? <>{run.agents?.filter(agent => agent.output).map(agent => <details key={agent.role}><summary>{agent.role} handoff</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{agent.output}</pre></details>)}{run.qaReport ? <details><summary>Saved quality review</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{run.qaReport}</pre></details> : null}</> : null}
    </> : null}
  </section>;
}
