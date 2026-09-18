import { createHash } from "node:crypto";
import { DAVClient, type DAVCalendarObject } from "tsdav";
import ICAL from "ical.js";
import type { Assignment } from "../../shared/types";
import { defaultCalendarReminders, normalizeCalendarReminders } from "../../shared/apple-calendar";

export interface AppleCredentials { email: string; password: string }
export interface CalendarSource { sourceId: string; canvasBaseUrl: string; assignments: Assignment[]; ready: boolean; reminderMinutes?: number[] }
export interface PublishResult { calendarName: string; publishedCount: number }
export type CalendarPublisher = (credentials: AppleCredentials, source: CalendarSource, signal: AbortSignal) => Promise<PublishResult>;
interface DesiredEvent { uid: string; filename: string; content: string; hash: string }

export function assertICloudUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !(url.hostname === "caldav.icloud.com" || /^p\d+-caldav\.icloud\.com$/.test(url.hostname))) throw new Error("Unexpected iCloud calendar server.");
  return url;
}

export function assignmentEvents(source: CalendarSource): DesiredEvent[] {
  if (!/^[a-f0-9-]{36}$/.test(source.sourceId)) throw new Error("Invalid StudyFlow calendar identity.");
  const baseUrl = new URL(source.canvasBaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) throw new Error("Invalid Canvas address.");
  const events = new Map<string, DesiredEvent>();
  const reminderMinutes = normalizeCalendarReminders(source.reminderMinutes ?? defaultCalendarReminders());
  for (const assignment of source.assignments) {
    if (!assignment.dueAt) continue;
    const due = new Date(assignment.dueAt);
    if (!Number.isFinite(due.getTime())) throw new Error("A StudyFlow assignment has an invalid due date.");
    const key = createHash("sha256").update(`${baseUrl.origin}|${assignment.courseId}|${assignment.canvasId}`).digest("hex");
    const uid = `${source.sourceId}-${key}@studyflow.local`;
    const url = new URL(`/courses/${encodeURIComponent(assignment.courseId.replace(/^course-/, ""))}/assignments/${encodeURIComponent(assignment.canvasId)}`, baseUrl).href;
    const progress = (assignment.localProgress?.status || "not_started").replace(/_/g, " ");
    const submission = assignment.canvasSubmission?.workflowState || "not checked";
    const description = `Assignment due in ${assignment.courseName}.\nStudyFlow progress: ${progress}. Canvas submission: ${submission}.\nManaged by StudyFlow; update the assignment in StudyFlow/Canvas.\n${url}`;
    const fields = { title: `${assignment.courseName}: ${assignment.title}`, due: due.toISOString(), url, description, reminderMinutes };
    const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const calendar = new ICAL.Component(["vcalendar", [], []]);
    calendar.updatePropertyWithValue("version", "2.0");
    calendar.updatePropertyWithValue("prodid", "-//StudyFlow//Assignment Calendar//EN");
    const component = new ICAL.Component("vevent");
    const event = new ICAL.Event(component);
    event.uid = uid;
    event.summary = fields.title;
    // Due times are zero-duration deadlines, not invented study sessions.
    event.startDate = ICAL.Time.fromJSDate(due, true);
    event.endDate = event.startDate.clone();
    event.description = description;
    component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
    component.updatePropertyWithValue("url", url);
    component.updatePropertyWithValue("transp", "TRANSPARENT");
    component.updatePropertyWithValue("x-studyflow-source", source.sourceId);
    component.updatePropertyWithValue("x-studyflow-hash", hash);
    for (const minutes of reminderMinutes) {
      const alarm = new ICAL.Component("valarm");
      alarm.updatePropertyWithValue("action", "DISPLAY");
      alarm.updatePropertyWithValue("description", fields.title);
      alarm.updatePropertyWithValue("trigger", ICAL.Duration.fromSeconds(-minutes * 60));
      component.addSubcomponent(alarm);
    }
    calendar.addSubcomponent(component);
    events.set(uid, { uid, filename: `${key}.ics`, content: `${calendar.toString()}\r\n`, hash });
  }
  return [...events.values()];
}

export const publishAppleCalendar: CalendarPublisher = async (credentials, source, signal) => {
  if (!source.ready) throw new Error("StudyFlow is waiting for Canvas sync to finish.");
  const desired = assignmentEvents(source);
  let destination: URL | null = null;
  const guardedFetch: typeof fetch = async (input, init) => {
    let url = assertICloudUrl(String(input));
    const method = (init?.method || "GET").toUpperCase();
    const canWrite = (target: URL) => destination && target.origin === destination.origin && !target.search && (method === "MKCALENDAR" ? target.href === destination.href : target.pathname.startsWith(destination.pathname) && /^[a-f0-9]{64}\.ics$/.test(target.pathname.slice(destination.pathname.length)));
    if (!["GET", "OPTIONS", "PROPFIND", "REPORT", "MKCALENDAR", "PUT", "DELETE"].includes(method)) throw new Error("Unsupported calendar operation.");
    const writing = ["MKCALENDAR", "PUT", "DELETE"].includes(method);
    for (let redirects = 0; redirects < 5; redirects++) {
      signal.throwIfAborted();
      if (writing && !canWrite(url)) throw new Error("Calendar writes must stay inside StudyFlow's dedicated calendar.");
      const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location"); await response.body?.cancel();
        if (!next) throw new Error("Invalid iCloud redirect.");
        url = assertICloudUrl(new URL(next, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new Error("Apple rejected the connection. Check your Apple Account email and app-specific password.");
        if (response.status === 412) throw new Error("An iCloud event changed during publishing. StudyFlow will retry safely.");
        throw new Error("iCloud publishing failed. StudyFlow will retry automatically.");
      }
      if (["PROPFIND", "REPORT"].includes(method) && !response.headers.get("content-type")?.toLowerCase().includes("xml")) {
        await response.body?.cancel(); throw new Error("Unreadable iCloud response.");
      }
      return response;
    }
    throw new Error("Too many iCloud redirects.");
  };
  const client = new DAVClient({ serverUrl: "https://caldav.icloud.com", credentials: { username: credentials.email, password: credentials.password }, authMethod: "Basic", defaultAccountType: "caldav", fetch: guardedFetch });
  await client.login();
  if (!client.account?.homeUrl) throw new Error("Missing iCloud calendar home.");
  const home = assertICloudUrl(client.account.homeUrl);
  destination = assertICloudUrl(new URL(`studyflow-${source.sourceId}/`, home.href.endsWith("/") ? home.href : `${home.href}/`).href);
  const marker = `StudyFlow managed calendar ${source.sourceId}`;
  const collections = await client.propfind({ url: home.href, depth: "1", props: { "d:resourcetype": {}, "d:displayname": {}, "c:calendar-description": {} } });
  if (collections.some(item => !item.ok)) throw new Error("Incomplete iCloud calendar discovery.");
  const existing = collections.find(item => item.href && new URL(item.href, home).href === destination!.href);
  if (existing) {
    if (existing.props?.calendarDescription !== marker || !Object.keys(existing.props?.resourcetype || {}).includes("calendar")) throw new Error("The StudyFlow destination could not be verified. No events were changed.");
  } else {
    const created = await client.makeCalendar({ url: destination.href, props: { "d:displayname": "StudyFlow", "c:calendar-description": marker, "ca:calendar-color": "#1769E8FF", "c:supported-calendar-component-set": { "c:comp": { _attributes: { name: "VEVENT" } } } } });
    if (created.some(item => !item.ok)) throw new Error("Could not create the StudyFlow calendar.");
  }
  // Read only this app-owned collection, never personal calendar event content.
  const reports = await client.calendarQuery({ url: destination.href, depth: "1", props: { "d:getetag": {}, "c:calendar-data": {} }, filters: [{ "comp-filter": { _attributes: { name: "VCALENDAR" }, "comp-filter": { _attributes: { name: "VEVENT" } } } }] });
  const owned = new Map<string, { object: DAVCalendarObject; hash: string }>();
  const occupied = new Set<string>();
  for (const report of reports) {
    if (!report.ok || !report.href) throw new Error("Incomplete iCloud event report.");
    const url = assertICloudUrl(new URL(report.href, destination).href);
    if (url.origin !== destination.origin || !url.pathname.startsWith(destination.pathname)) throw new Error("Unexpected event location.");
    // iCloud includes the collection itself (with an ETag but no event data),
    // even for an empty calendar. It is not an unreadable event resource.
    if (url.href === destination.href && report.props?.calendarData == null) continue;
    occupied.add(url.href);
    const data = report.props?.calendarData?._cdata ?? report.props?.calendarData;
    if (typeof data !== "string") throw new Error("Unreadable iCloud event.");
    const root = new ICAL.Component(ICAL.parse(data));
    const components = root.getAllSubcomponents("vevent");
    if (components.length !== 1) continue;
    const event = components[0];
    const uid = String(event.getFirstPropertyValue("uid") || "");
    const identity = uid.match(new RegExp(`^${source.sourceId}-([a-f0-9]{64})@studyflow\\.local$`));
    if (event.getFirstPropertyValue("x-studyflow-source") !== source.sourceId || !identity || url.href !== new URL(`${identity[1]}.ics`, destination).href) continue;
    if (!report.props?.getetag) throw new Error("iCloud did not provide event version information.");
    owned.set(uid, { object: { url: url.href, data, etag: String(report.props.getetag) }, hash: String(event.getFirstPropertyValue("x-studyflow-hash") || "") });
  }
  const desiredIds = new Set(desired.map(event => event.uid));
  for (const event of desired) {
    signal.throwIfAborted();
    const remote = owned.get(event.uid);
    if (remote?.hash === event.hash) continue;
    if (remote) await client.updateCalendarObject({ calendarObject: { ...remote.object, data: event.content } });
    else {
      if (occupied.has(new URL(event.filename, destination).href)) throw new Error("A different event occupies a StudyFlow event address. No overwrite was made.");
      await client.createCalendarObject({ calendar: { url: destination.href }, filename: event.filename, iCalString: event.content });
    }
  }
  // Remove only verified app-owned events absent from the current local calendar.
  for (const [uid, remote] of owned) {
    signal.throwIfAborted();
    if (!desiredIds.has(uid)) await client.deleteCalendarObject({ calendarObject: remote.object });
  }
  return { calendarName: typeof existing?.props?.displayname === "string" ? existing.props.displayname : "StudyFlow", publishedCount: desired.length };
};
