import type { SyncJob } from "../../shared/types";

const bytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;

export function DownloadProgress({ sync }: { sync: SyncJob | null }) {
  if (!sync) return null;
  const active = sync.status === "queued" || sync.status === "syncing";
  const percent = sync.progress.total ? Math.round(sync.progress.completed / sync.progress.total * 100) : 0;
  const title = active ? "Downloading…" : sync.status === "complete" ? "Download complete" : sync.status === "cancelled" ? "Download cancelled" : "Downloads need attention";
  return <section className="download-progress" aria-label="Download progress">
    <h2 role="status">{title}</h2>
    <p>{sync.progress.completed} of {sync.progress.total} course categories processed · {percent}%</p>
    <progress aria-label="Overall download progress" max={100} value={percent} />
    <p>{active ? sync.progress.message : sync.errors.length ? `${sync.errors.length} issue(s). Retry the selected categories to resume.` : "Your local library is updated."}</p>
    <div className="live-transfers">{sync.progress.transfers?.map(file => <article key={file.id}>
      <strong>{file.name}</strong><small>{file.courseName} · {active && file.status === "downloading" ? "Downloading" : file.status === "complete" ? "Downloaded" : "Interrupted"}</small>
      <progress aria-label={`Download progress for ${file.name}`} max={file.total || 1} value={file.total ? Math.min(file.received, file.total) : undefined} />
      <small>{bytes(file.received)}{file.total ? ` / ${bytes(file.total)} · ${Math.min(100, Math.round(file.received / file.total * 100))}%` : " received · size unknown"}</small>
    </article>)}</div>
  </section>;
}
