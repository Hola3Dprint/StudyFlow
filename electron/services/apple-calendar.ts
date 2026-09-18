import { defaultCalendarReminders, normalizeCalendarReminders, emptyAppleCalendar, type AppleCalendarState } from "../../shared/apple-calendar";
import { publishAppleCalendar, type AppleCredentials, type CalendarPublisher, type CalendarSource } from "./apple-calendar-provider";

export interface CalendarStorage {
  readCredentials(): AppleCredentials | null;
  saveCredentials(credentials: AppleCredentials): void;
  clearCredentials(): void;
  readCache(): AppleCalendarState | null;
  saveCache(state: AppleCalendarState): void;
  clearCache(): void;
  readReminders(): number[] | null;
  saveReminders(minutes: number[]): void;
}

export class AppleCalendarService {
  private state: AppleCalendarState;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<AppleCalendarState>;
  private generation = 0;
  private failures = 0;
  private reminderMinutes: number[];

  constructor(private storage: CalendarStorage, private notify: (state: AppleCalendarState) => void, private getSource: () => CalendarSource, private publisher: CalendarPublisher = publishAppleCalendar) {
    const credentials = storage.readCredentials();
    const cache = storage.readCache();
    this.reminderMinutes = normalizeCalendarReminders(storage.readReminders() ?? defaultCalendarReminders());
    // Prior import connections never authorize outbound writes automatically.
    this.state = credentials && cache?.mode === "publish" && cache.connected ? { ...cache, email: credentials.email, status: "idle", error: null } : emptyAppleCalendar();
  }
  snapshot(): AppleCalendarState { return { ...structuredClone(this.state), reminderMinutes: [...this.reminderMinutes], assignmentCount: this.getSource().assignments.filter(item => item.dueAt && Number.isFinite(Date.parse(item.dueAt))).length }; }
  setReminders(minutes: number[]): AppleCalendarState {
    const next = normalizeCalendarReminders(minutes);
    this.storage.saveReminders(next);
    this.reminderMinutes = next;
    this.publish();
    this.sourceChanged();
    return this.snapshot();
  }
  private publish() { this.notify(this.snapshot()); }
  private cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.pending = undefined;
  }
  start() { if (this.active) return; this.active = true; void this.refresh(); }
  stop() { this.active = false; this.cancel(); this.state.status = this.state.connected ? "idle" : "disconnected"; }
  sourceChanged() {
    if (!this.active) return;
    this.publish();
    if (!this.state.connected) return;
    this.cancel();
    this.state.status = "syncing";
    this.publish();
    // Combine a burst of local changes, without waiting for the retry timer.
    this.timer = setTimeout(() => { void this.refresh(); }, 500);
  }
  async connect(credentials: AppleCredentials): Promise<AppleCalendarState> {
    if (!this.active) throw new Error("Open StudyFlow to publish your calendar.");
    this.storage.saveCredentials(credentials);
    this.cancel();
    this.state = { ...emptyAppleCalendar(), connected: true, email: credentials.email };
    this.storage.saveCache(this.state);
    this.failures = 0;
    return this.refresh();
  }
  disconnect(): AppleCalendarState {
    this.cancel();
    this.storage.clearCredentials();
    this.storage.clearCache();
    this.state = emptyAppleCalendar();
    this.publish();
    return this.snapshot();
  }
  refresh(): Promise<AppleCalendarState> {
    if (this.pending) return this.pending;
    if (!this.active || !this.state.connected) return Promise.resolve(this.snapshot());
    clearTimeout(this.timer);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.state.status = "syncing";
    this.publish();
    this.pending = this.run(controller, generation).finally(() => {
      if (generation !== this.generation) return;
      this.pending = undefined;
      if (this.active && this.state.connected) this.timer = setTimeout(() => { void this.refresh(); }, Math.min(60_000 * 2 ** this.failures, 900_000));
    });
    return this.pending;
  }
  private async run(controller: AbortController, generation: number): Promise<AppleCalendarState> {
    try {
      const credentials = this.storage.readCredentials();
      if (!credentials) throw new Error("Saved Apple credentials are unavailable. Reconnect your calendar.");
      const source = { ...this.getSource(), reminderMinutes: [...this.reminderMinutes] };
      if (!source.ready) {
        this.state = { ...this.state, status: "waiting", error: "Waiting for Canvas to finish syncing. Published iPhone events are unchanged." };
        this.publish();
        return this.snapshot();
      }
      const result = await this.publisher(credentials, source, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return this.snapshot();
      const next: AppleCalendarState = { ...this.state, ...result, lastSync: new Date().toISOString(), status: "idle", error: null };
      this.storage.saveCache(next);
      this.state = next;
      this.failures = 0;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return this.snapshot();
      this.failures++;
      // Never surface transport messages, which can contain credentials or event data.
      const message = error instanceof Error ? error.message : "";
      this.state = { ...this.state, status: "error", error: message.startsWith("Apple rejected") || message.startsWith("Saved Apple credentials") ? message : "Could not finish publishing to iCloud. Changes are saved in StudyFlow and will retry automatically while the app is open." };
    }
    this.publish();
    return this.snapshot();
  }
}
