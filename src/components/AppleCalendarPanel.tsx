import { useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from "@fluentui/react-components";
import type { AppleCalendarApi, AppleCalendarState } from "../../shared/apple-calendar";

const reminderOptions: Array<[number, string]> = [[0, "At the deadline"], [5, "5 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [120, "2 hours before"], [1440, "1 day before"], [2880, "2 days before"], [10080, "1 week before"]];

export function AppleCalendarPanel({ api, state, open, onClose }: { api: AppleCalendarApi; state: AppleCalendarState; open: boolean; onClose(): void }) {
  const [email, setEmail] = useState(state.email || "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (issue) { setError(issue instanceof Error ? issue.message : "Calendar action failed."); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}><DialogSurface className="apple-calendar-dialog"><DialogBody>
    <DialogTitle>StudyFlow on your iPhone</DialogTitle>
    <DialogContent>
      <p className="apple-publish-direction">StudyFlow → iCloud → Apple Calendar</p>
      <p>Your assignment deadlines appear in a separate <strong>StudyFlow</strong> calendar on your iPhone. Changes publish automatically while this PC app is open, including when minimized.</p>
      <p><strong>{state.assignmentCount} dated assignment{state.assignmentCount === 1 ? "" : "s"}</strong> from the courses shown in StudyFlow are ready to share. All months are included.</p>
      <p className="apple-calendar-note">Closing StudyFlow pauses updates. Existing events remain on your iPhone. Reopening catches up; offline changes retry automatically. Your iPhone receives updates through iCloud, so Apple’s delivery timing can vary.</p>
      <ol className="apple-phone-steps"><li>Connect the same Apple Account you use on your iPhone.</li><li>On your iPhone, enable iCloud Calendar in Settings.</li><li>Open Apple Calendar → Calendars and check <strong>StudyFlow</strong>.</li></ol>
      <fieldset className="apple-reminder-settings" disabled={busy}>
        <legend>Assignment reminders</legend>
        <p className="apple-calendar-note">Apply to every published assignment. Changes save automatically and update existing events. Enable Calendar notifications on your iPhone to receive alerts.</p>
        {[0, 1].map(index => <label key={index}>Reminder {index + 1}<select value={state.reminderMinutes[index] ?? "off"} onChange={event => {
          const next: Array<number | undefined> = [state.reminderMinutes[0], state.reminderMinutes[1]];
          next[index] = event.target.value === "off" ? undefined : Number(event.target.value);
          void perform(() => api.setReminders(next.filter((value): value is number => value !== undefined)));
        }}><option value="off">Off</option>{reminderOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}
      </fieldset>
      {state.connected && <section className="apple-connection-summary">
        <strong>{state.email}</strong>
        <p role="status">{state.status === "syncing" ? "Publishing StudyFlow changes…" : state.status === "waiting" ? "Waiting for Canvas sync…" : state.lastSync ? `${state.publishedCount} assignment${state.publishedCount === 1 ? "" : "s"} published to ${state.calendarName || "StudyFlow"}. Last synced ${new Date(state.lastSync).toLocaleString()}` : state.status === "error" ? "Publishing failed. Your connection details are saved; StudyFlow will retry." : "Connection saved. Waiting for the first successful publish."}</p>
        <div className="apple-calendar-actions"><Button disabled={busy || state.status === "syncing"} onClick={() => void perform(() => api.refresh())}>Sync now</Button><Button disabled={busy} onClick={() => void perform(() => api.disconnect())}>Disconnect</Button></div>
        <p className="apple-calendar-note">Disconnect stops publishing and removes the saved credential. Published events stay in iCloud. You can remove the StudyFlow calendar on your iPhone when you no longer need it.</p>
      </section>}
      {(!state.connected || state.status === "error") && <form className="apple-connect-form" onSubmit={event => {
        event.preventDefault();
        const input = { email: email.trim(), password: password.trim() };
        setPassword("");
        void perform(() => api.connect(input));
      }}>
        <label>Apple Account email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>App-specific password<input type="password" autoComplete="off" required pattern="[a-zA-Z]{4}(-[a-zA-Z]{4}){3}" placeholder="xxxx-xxxx-xxxx-xxxx" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <p className="apple-calendar-note">Use an app-specific password, never your normal Apple password. Credentials are encrypted on this Windows PC. Connecting creates a StudyFlow calendar and publishes assignment titles, deadlines, course names, progress, and Canvas links.</p>
        <Button type="button" appearance="subtle" onClick={() => void perform(() => api.help())}>How to create an app-specific password</Button>
        <Button type="submit" appearance="primary" disabled={busy}>{busy ? "Publishing…" : state.connected ? "Reconnect and publish" : "Connect and publish"}</Button>
      </form>}
      <p className="apple-calendar-note">StudyFlow manages its own published events. Other Apple calendars remain unchanged. Update assignments in StudyFlow/Canvas; iPhone edits do not flow back into StudyFlow.</p>
      {(error || state.error) && <p role="alert" className="apple-calendar-error">{error || state.error}</p>}
    </DialogContent>
    <DialogActions><Button onClick={onClose}>Done</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
