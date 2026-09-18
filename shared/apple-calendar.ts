export interface AppleCalendarState {
  mode: "publish";
  connected: boolean;
  email: string | null;
  calendarName: string | null;
  assignmentCount: number;
  publishedCount: number;
  status: "disconnected" | "idle" | "syncing" | "waiting" | "error";
  lastSync: string | null;
  error: string | null;
  reminderMinutes: number[];
}

export const defaultCalendarReminders = () => [1440, 15];
export function normalizeCalendarReminders(minutes: number[]): number[] {
  if (!Array.isArray(minutes) || minutes.length > 2 || minutes.some(value => !Number.isInteger(value) || value < 0 || value > 43200)) throw new Error("Choose up to two reminders, between 0 and 43200 minutes before the deadline.");
  return [...new Set(minutes)].sort((a, b) => b - a);
}
export const emptyAppleCalendar = (): AppleCalendarState => ({ mode: "publish", connected: false, email: null, calendarName: null, assignmentCount: 0, publishedCount: 0, status: "disconnected", lastSync: null, error: null, reminderMinutes: defaultCalendarReminders() });

export interface AppleCalendarApi {
  state(): Promise<AppleCalendarState>;
  connect(input: { email: string; password: string }): Promise<AppleCalendarState>;
  disconnect(): Promise<AppleCalendarState>;
  refresh(): Promise<AppleCalendarState>;
  setReminders(minutes: number[]): Promise<AppleCalendarState>;
  help(): Promise<void>;
  subscribe(listener: (state: AppleCalendarState) => void): () => void;
}
