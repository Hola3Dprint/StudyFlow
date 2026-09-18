import { app, BrowserWindow, ipcMain, safeStorage, shell, session, dialog, powerMonitor, nativeTheme } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Assignment, CanvasConnectResult, CodexAccount, DeliverableSpec, SyncSelection } from "../shared/types";
import { CONTENT_CATEGORIES } from "../shared/types";
import { AssignmentAiService } from "./services/ai";
import { CodexAppServer } from "./services/app-server";
import { CanvasSyncService } from "./services/canvas";
import { StudyFlowDatabase } from "./services/database";
import { resolveInside, redactSecrets } from "./services/utils";
import { LibraryService, libraryQuerySchema } from "./services/library";
import { AppleCalendarService } from "./services/apple-calendar";
import { StartupRefresh } from "./services/startup-refresh";
import type { AppleCredentials } from "./services/apple-calendar-provider";
import { APPEARANCE_THEMES, nativeAppearanceFor, windowBackgroundFor, type AppearanceTheme } from "../shared/appearance";

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

// Keep credentials and settings in the same location for batch, portable and
// installed launches, independent of Electron's inferred application name.
app.setPath("userData", path.join(app.getPath("appData"), "studyflow-desktop"));

class AppServices {
  readonly database: StudyFlowDatabase;
  readonly libraryPath: string;
  readonly canvas: CanvasSyncService;
  readonly codex: CodexAppServer;
  readonly ai: AssignmentAiService;
  readonly search: LibraryService;
  readonly appleCalendar: AppleCalendarService;
  readonly startupRefresh: StartupRefresh;
  private readonly tokenFile: string;
  private codexAccount: CodexAccount = { authMode: "unknown", usage: [], isAvailable: true };

  constructor() {
    const appData = app.getPath("userData");
    this.libraryPath = path.join(app.getPath("documents"), "StudyFlow Desktop");
    this.tokenFile = path.join(appData, "canvas-token.dpapi");
    this.database = new StudyFlowDatabase(path.join(appData, "studyflow.sqlite"));
    this.database.recoverInterruptedSyncs();
    const calendarSourceId = this.database.getSetting("apple.publish.sourceId") || randomUUID();
    this.database.setSetting("apple.publish.sourceId", calendarSourceId);
    const appleCredentialPath = path.join(appData, "apple-calendar.dpapi");
    this.appleCalendar = new AppleCalendarService({
      readCredentials: () => {
        try { return JSON.parse(safeStorage.decryptString(readFileSync(appleCredentialPath))) as AppleCredentials; }
        catch { return null; }
      },
      saveCredentials: credentials => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable. Apple credentials were not saved.");
        writeFileSync(`${appleCredentialPath}.tmp`, safeStorage.encryptString(JSON.stringify(credentials)));
        renameSync(`${appleCredentialPath}.tmp`, appleCredentialPath);
      },
      clearCredentials: () => { rmSync(appleCredentialPath, { force: true }); rmSync(`${appleCredentialPath}.tmp`, { force: true }); },
      readCache: () => { try { return JSON.parse(this.database.getSetting("apple.calendar") || "null"); } catch { return null; } },
      saveCache: state => this.database.setSetting("apple.calendar", JSON.stringify(state)),
      clearCache: () => this.database.deleteSetting("apple.calendar"),
      readReminders: () => JSON.parse(this.database.getSetting("apple.calendar.reminders") || "null"),
      saveReminders: minutes => this.database.setSetting("apple.calendar.reminders", JSON.stringify(minutes)),
    }, state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("studyflow:apple:updated", state); }, () => {
      const connection = JSON.parse(this.database.getSetting("canvas.connection") || "null");
      const courses = new Map(this.database.courses().filter(course => course.isFavorite === true).map(course => [course.id, course]));
      return { sourceId: calendarSourceId, canvasBaseUrl: connection?.baseUrl || "https://canvas.invalid", ready: Boolean(connection) && !this.database.activeSyncJob(), assignments: this.database.assignments().filter(assignment => courses.has(assignment.courseId)).map(assignment => ({ ...assignment, courseId: courses.get(assignment.courseId)!.canvasId, courseName: courses.get(assignment.courseId)!.name })) };
    });
    this.database.onCalendarChange(() => this.appleCalendar.sourceChanged());
    this.codex = new CodexAppServer(path.join(appData, "codex-app-server"));
    this.search = new LibraryService(path.join(appData,"search"),this.libraryPath,() => {});
    this.canvas = new CanvasSyncService({ database: this.database, libraryPath: this.libraryPath, getToken: () => this.readCanvasToken(), onUpdate: (job) => { mainWindow?.webContents.send("studyflow:sync", job); if (["complete","partial"].includes(job.status)) void this.refreshSearch(); } });
    this.startupRefresh = new StartupRefresh(signal => this.canvas.refreshInBackground(signal));
    this.ai = new AssignmentAiService({ database: this.database, appServer: this.codex, libraryPath: this.libraryPath, search: this.search, onUpdate: (run) => mainWindow?.webContents.send("studyflow:ai", run) });
  }

  async prepare(): Promise<void> {
    await mkdir(this.libraryPath, { recursive: true });
    void this.refreshSearch();
  }
  async refreshSearch() { try { await this.search.update({courses:this.database.courses(),assignments:this.database.assignments()}); } catch { /* Worker status exposes recoverable errors. */ } }

  async storeCanvasToken(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable. StudyFlow will not save Canvas tokens in plaintext.");
    await writeFile(this.tokenFile, safeStorage.encryptString(token));
  }

  readCanvasToken(): string | null {
    try {
      if (!existsSync(this.tokenFile) || !safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(readFileSync(this.tokenFile));
    } catch {
      return null;
    }
  }

  async clearCanvasToken(): Promise<void> {
    await import("node:fs/promises").then((fs) => fs.rm(this.tokenFile, { force: true }));
  }

  async bootstrap() {
    const rawConnection = this.database.getSetting("canvas.connection");
    // Records created before favorites-only support have no favorite marker. Hide
    // them until Canvas has refreshed the user's current dashboard favorites.
    const courses = this.database.courses().filter((course) => course.isFavorite === true);
    const courseIds = new Set(courses.map((course) => course.id));
    return {
      connection: rawConnection ? { ...JSON.parse(rawConnection), hasStoredToken: Boolean(this.readCanvasToken()) } : null,
      courses,
      assignments: this.database.assignments().filter((assignment) => courseIds.has(assignment.courseId)),
      activeSync: this.database.activeSyncJob()?.background ? null : this.database.activeSyncJob(),
      activeAiRun: this.ai.activeRun(),
      // Calendar/downloads must not wait for the separate AI runtime or network.
      // AI Workspace and Settings already refresh the managed account on entry.
      codexAccount: this.codexAccount,
      libraryPath: this.libraryPath,
    };
  }

  async readCodexAccount(): Promise<CodexAccount> {
    this.codexAccount = await this.codex.account();
    return this.codexAccount;
  }

  async logoutCodex(): Promise<void> {
    await this.codex.logout();
    this.codexAccount = { authMode: "none", usage: [], isAvailable: true };
  }

  close(): void {
    this.startupRefresh.stop();
    this.canvas.close();
    this.appleCalendar.stop();
    this.search.close();
    this.database.close();
    void this.codex.stop();
  }
}

const connectionSchema = z.object({ baseUrl: z.string().min(1), token: z.string().min(8).max(4096) });
const selectionSchema = z.object({
  courseIds: z.array(z.string().min(1)).min(1),
  categories: z.array(z.enum(CONTENT_CATEGORIES)).min(1),
  includeArchivedCourses: z.boolean(),
});
const aiInputSchema = z.object({
  additionalCourseIds: z.array(z.string().min(1)).max(100).optional(),
  assignmentId: z.string().min(1),
  researchedSourcesEnabled: z.boolean(),
  deliverables: z.array(z.object({ format: z.enum(["docx", "pdf", "pptx", "xlsx", "csv", "md", "txt", "tex", "zip"]), title: z.string().optional(), includeSourceLedger: z.boolean().optional() })).min(1).max(9),
});
const pathSchema = z.string().min(1).max(32_000);
const appearanceThemeSchema = z.enum(APPEARANCE_THEMES);

function savedAppearanceTheme(): AppearanceTheme {
  return "rainbow";
}

function applyNativeAppearance(theme: AppearanceTheme): void {
  nativeTheme.themeSource = nativeAppearanceFor(theme);
  mainWindow?.setBackgroundColor(windowBackgroundFor(theme));
}

function getServices(): AppServices {
  if (!services) throw new Error("StudyFlow services are not ready.");
  return services;
}

function requireAssignment(id: string): Assignment {
  const assignment = getServices().database.assignment(id);
  if (!assignment) throw new Error("This assignment is not in the local StudyFlow library. Sync it from Canvas first.");
  return assignment;
}

function isLibraryPath(value: string): boolean {
  try {
    resolveInside(getServices().libraryPath, path.relative(getServices().libraryPath, value));
    return path.resolve(value).startsWith(path.resolve(getServices().libraryPath));
  } catch {
    return false;
  }
}

function registerIpc(): void {
  ipcMain.handle("studyflow:appearance:set-theme", (_event, input: unknown) => {
    appearanceThemeSchema.parse(input);
    const theme: AppearanceTheme = "rainbow";
    getServices().database.setSetting("appearance.theme", theme);
    applyNativeAppearance(theme);
  });
  const appleInput = z.object({ email: z.email().max(320), password: z.string().regex(/^[a-z]{4}(-[a-z]{4}){3}$/i, "Use an Apple app-specific password.") });
  ipcMain.handle("studyflow:apple:state", () => getServices().appleCalendar.snapshot());
  ipcMain.handle("studyflow:apple:connect", (_event, input) => getServices().appleCalendar.connect(appleInput.parse(input)));
  ipcMain.handle("studyflow:apple:disconnect", () => getServices().appleCalendar.disconnect());
  ipcMain.handle("studyflow:apple:refresh", () => getServices().appleCalendar.refresh());
  ipcMain.handle("studyflow:apple:reminders", (_event, input) => getServices().appleCalendar.setReminders(z.array(z.number().int().min(0).max(43200)).max(2).parse(input)));
  ipcMain.handle("studyflow:apple:help", () => shell.openExternal("https://support.apple.com/en-us/102654"));
  ipcMain.handle("studyflow:library:search",(_event,input) => getServices().search.call("search",libraryQuerySchema.parse(input)));
  ipcMain.handle("studyflow:library:status",() => getServices().search.call("status"));
  ipcMain.handle("studyflow:library:assignment", (_event, id) => {
    const assignment = getServices().database.assignment(z.string().min(1).max(200).parse(id));
    if (!assignment) throw new Error("Assignment is not available locally. Sync Canvas first.");
    return getServices().search.call("assignment-materials", assignment);
  });
  ipcMain.handle("studyflow:library:control",(_event,input) => { const action = z.enum(["index","pause","resume","cancel","setup","setup-descriptions"]).parse(input); return getServices().search.call(action === "setup-descriptions" ? action : "control", action); });
  ipcMain.handle("studyflow:library:preview",(_event,id) => getServices().search.call("preview",{id:z.string().max(200).parse(id)}));
  ipcMain.handle("studyflow:library:related",(_event,id) => getServices().search.call("related",{id:z.string().max(200).parse(id)}));
  ipcMain.handle("studyflow:library:graph",(_event,input) => getServices().search.call("graph",z.object({courseIds:z.array(z.string()).max(100).optional(),expanded:z.array(z.string()).max(100).optional(),focus:z.string().max(200).optional(),archived:z.boolean().optional()}).parse(input)));
  ipcMain.handle("studyflow:library:link",(_event,input) => getServices().search.call("link",z.object({source:z.string().max(200),target:z.string().max(200),kind:z.enum(["explicit","membership","semantic","visual","manual"]),action:z.enum(["pin","dismiss","restore"])}).parse(input)));
  ipcMain.handle("studyflow:library:open",async (_event,id) => { const source = await getServices().search.call<string>("source",{id:z.string().max(200).parse(id)}); const error = await shell.openPath(source); if (error) throw new Error(error); });
  ipcMain.handle("studyflow:bootstrap", () => getServices().bootstrap());
  ipcMain.handle("studyflow:canvas:connect", async (_event, input) => {
    const validated = connectionSchema.parse(input);
    const connection = await getServices().canvas.testConnection(validated);
    await getServices().storeCanvasToken(validated.token.trim());
    getServices().database.setSetting("canvas.connection", JSON.stringify(connection));
    try {
      const initial = await getServices().canvas.startInitialSync();
      return { connection, courses: initial.courses, initialSync: initial.job } satisfies CanvasConnectResult;
    } catch (error) {
      return {
        connection,
        courses: [],
        initialSync: null,
        initialSyncError: error instanceof Error ? error.message : "StudyFlow could not start the initial Canvas sync.",
      } satisfies CanvasConnectResult;
    }
  });
  ipcMain.handle("studyflow:canvas:disconnect", async () => {
    await getServices().clearCanvasToken();
    getServices().database.deleteSetting("canvas.connection");
  });
  ipcMain.handle("studyflow:canvas:list-courses", async (_event, includeArchived: unknown) => getServices().canvas.listCourses(Boolean(includeArchived)));
  ipcMain.handle("studyflow:canvas:sync", (_event, input) => getServices().canvas.startSync(selectionSchema.parse(input) as SyncSelection));
  ipcMain.handle("studyflow:canvas:cancel", (_event, jobId: unknown) => getServices().canvas.cancel(z.string().min(1).parse(jobId)));
  ipcMain.handle("studyflow:canvas:job", (_event, jobId: unknown) => getServices().canvas.getJob(z.string().min(1).parse(jobId)));
  ipcMain.handle("studyflow:canvas:assignment", (_event, id: unknown) => getServices().database.assignment(z.string().min(1).parse(id)));
  ipcMain.handle("studyflow:canvas:check-submission", (_event, id: unknown) => getServices().canvas.checkSubmission(z.string().min(1).max(200).parse(id)));
  ipcMain.handle("studyflow:canvas:check-past-submissions", () => getServices().canvas.checkPastSubmissions());
  ipcMain.handle("studyflow:canvas:local-progress", (_event, input: unknown) => {
    const value = z.object({ id: z.string().min(1).max(200), status: z.enum(["not_started", "completed", "submitted"]) }).parse(input);
    return getServices().database.setAssignmentProgress(value.id, value.status);
  });
  ipcMain.handle("studyflow:codex:account", () => getServices().readCodexAccount());
  ipcMain.handle("studyflow:codex:login-browser", async () => {
    const login = await getServices().codex.login("browser");
    if (!login.authUrl) throw new Error("Codex did not provide a browser sign-in address.");
    await shell.openExternal(login.authUrl);
    return login;
  });
  ipcMain.handle("studyflow:codex:login-device", async () => {
    const login = await getServices().codex.login("device");
    if (login.verificationUrl?.startsWith("https://auth.openai.com/")) await shell.openExternal(login.verificationUrl);
    return login;
  });
  ipcMain.handle("studyflow:codex:logout", () => getServices().logoutCodex());
  ipcMain.handle("studyflow:ai:start", (_event, input) => {
    const validated = aiInputSchema.parse(input);
    const courses = new Set(getServices().database.courses().filter(c => c.isFavorite && !c.isArchived).map(c => c.id));
    if (validated.additionalCourseIds?.some(id => !courses.has(id))) throw new Error("Additional context must come from a current downloaded course.");
    return getServices().ai.start({ assignment: requireAssignment(validated.assignmentId), researchedSourcesEnabled: validated.researchedSourcesEnabled, deliverables: validated.deliverables as DeliverableSpec[], additionalCourseIds: validated.additionalCourseIds });
  });
  ipcMain.handle("studyflow:ai:cancel", (_event, runId: unknown) => getServices().ai.cancel(z.string().min(1).parse(runId)));
  ipcMain.handle("studyflow:ai:history", (_event, assignmentId: unknown) => getServices().database.aiRunsForAssignment(z.string().min(1).parse(assignmentId)));
  ipcMain.handle("studyflow:files:open", async (_event, rawPath: unknown) => {
    const value = pathSchema.parse(rawPath);
    if (!isLibraryPath(value)) throw new Error("StudyFlow can only open files in its local library.");
    await shell.openPath(value);
  });
  ipcMain.handle("studyflow:files:reveal", (_event, rawPath: unknown) => {
    const value = pathSchema.parse(rawPath);
    if (!isLibraryPath(value)) throw new Error("StudyFlow can only reveal files in its local library.");
    shell.showItemInFolder(value);
  });
}

async function createWindow(): Promise<void> {
  const appearanceTheme = savedAppearanceTheme();
  applyNativeAppearance(appearanceTheme);
  mainWindow = new BrowserWindow({
    width: 1536,
    height: 1024,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: windowBackgroundFor(appearanceTheme),
    title: "StudyFlow",
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { services?.startupRefresh.stop(); services?.appleCalendar.stop(); mainWindow = null; });
  services?.startupRefresh.start();
  services?.appleCalendar.start();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = url.startsWith("https://chatgpt.com/") || url.startsWith("https://auth.openai.com/") || url.startsWith("https://help.openai.com/");
    if (allowed) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:") && !url.startsWith("http://127.0.0.1:")) event.preventDefault();
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(import.meta.dirname, "../dist/index.html"));
}

function startupFailed(error: unknown): void {
  const message=redactSecrets(error instanceof Error ? error.message : "Unknown startup failure.");
  console.error(`StudyFlow startup failed: ${message}`);
  dialog.showErrorBox("StudyFlow could not start", `${message}\n\nClose StudyFlow and run Run-StudyFlow.bat again. Your saved keys and downloaded materials have not been removed.`);
  app.exit(1);
}

function startAutomaticUpdates(): void {
  // Development and unpacked builds have no GitHub release metadata.
  // Installed Windows releases check the public release feed in the background.
  if (!app.isPackaged || process.platform !== "win32") return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", error => console.warn(`StudyFlow update check failed: ${redactSecrets(error.message)}`));
  autoUpdater.on("update-downloaded", async info => {
    const result = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart and install", "Install when I close StudyFlow"],
      defaultId: 0,
      cancelId: 1,
      title: "StudyFlow update ready",
      message: `StudyFlow ${info.version} has been downloaded.`,
      detail: "Restart now to install it, or it will install automatically when you close StudyFlow.",
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
  void autoUpdater.checkForUpdates();
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.whenReady().then(async () => {
  app.setAppUserModelId("com.studyflow.desktop.companion");
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  services = new AppServices();
  await services.prepare();
  registerIpc();
  await createWindow();
  startAutomaticUpdates();
  powerMonitor.on("resume", () => { void services?.startupRefresh.refresh(); void services?.appleCalendar.refresh(); });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(startupFailed); });
}).catch(startupFailed);
app.on("second-instance", () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.show(); mainWindow?.focus(); });

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => services?.close());
