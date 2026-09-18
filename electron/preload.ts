import { contextBridge, ipcRenderer } from "electron";
import type { StudyFlowApi } from "../shared/types";

const api: StudyFlowApi = {
  appearance: {
    setTheme: theme => ipcRenderer.invoke("studyflow:appearance:set-theme", theme),
  },
  appleCalendar: {
    state: () => ipcRenderer.invoke("studyflow:apple:state"),
    connect: input => ipcRenderer.invoke("studyflow:apple:connect", input),
    disconnect: () => ipcRenderer.invoke("studyflow:apple:disconnect"),
    refresh: () => ipcRenderer.invoke("studyflow:apple:refresh"),
    setReminders: minutes => ipcRenderer.invoke("studyflow:apple:reminders", minutes),
    help: () => ipcRenderer.invoke("studyflow:apple:help"),
    subscribe: listener => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on("studyflow:apple:updated", handler);
      return () => ipcRenderer.removeListener("studyflow:apple:updated", handler);
    },
  },
  library: {
    forAssignment: assignmentId => ipcRenderer.invoke("studyflow:library:assignment", assignmentId),
    search: input => ipcRenderer.invoke("studyflow:library:search", input),
    status: () => ipcRenderer.invoke("studyflow:library:status"),
    control: input => ipcRenderer.invoke("studyflow:library:control",input),
    preview: id => ipcRenderer.invoke("studyflow:library:preview",id),
    related: id => ipcRenderer.invoke("studyflow:library:related",id),
    graph: input => ipcRenderer.invoke("studyflow:library:graph",input),
    link: input => ipcRenderer.invoke("studyflow:library:link",input),
    open: id => ipcRenderer.invoke("studyflow:library:open",id),
  },
  bootstrap: () => ipcRenderer.invoke("studyflow:bootstrap"),
  canvas: {
    connect: (input) => ipcRenderer.invoke("studyflow:canvas:connect", input),
    disconnect: () => ipcRenderer.invoke("studyflow:canvas:disconnect"),
    listCourses: (includeArchived) => ipcRenderer.invoke("studyflow:canvas:list-courses", includeArchived),
    startSync: (selection) => ipcRenderer.invoke("studyflow:canvas:sync", selection),
    cancelSync: (jobId) => ipcRenderer.invoke("studyflow:canvas:cancel", jobId),
    getSync: (jobId) => ipcRenderer.invoke("studyflow:canvas:job", jobId),
    assignment: (id) => ipcRenderer.invoke("studyflow:canvas:assignment", id),
    checkSubmission: id => ipcRenderer.invoke("studyflow:canvas:check-submission", id),
    checkPastSubmissions: () => ipcRenderer.invoke("studyflow:canvas:check-past-submissions"),
    setLocalProgress: (id, status) => ipcRenderer.invoke("studyflow:canvas:local-progress", { id, status }),
  },
  codex: {
    account: () => ipcRenderer.invoke("studyflow:codex:account"),
    loginBrowser: () => ipcRenderer.invoke("studyflow:codex:login-browser"),
    loginDevice: () => ipcRenderer.invoke("studyflow:codex:login-device"),
    logout: () => ipcRenderer.invoke("studyflow:codex:logout"),
  },
  ai: {
    history: (assignmentId) => ipcRenderer.invoke("studyflow:ai:history", assignmentId),
    start: (input) => ipcRenderer.invoke("studyflow:ai:start", input),
    cancel: (runId) => ipcRenderer.invoke("studyflow:ai:cancel", runId),
  },
  files: {
    open: (targetPath) => ipcRenderer.invoke("studyflow:files:open", targetPath),
    reveal: (targetPath) => ipcRenderer.invoke("studyflow:files:reveal", targetPath),
  },
  onSync: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: Parameters<typeof listener>[0]) => listener(job);
    ipcRenderer.on("studyflow:sync", handler);
    return () => ipcRenderer.removeListener("studyflow:sync", handler);
  },
  onAiRun: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, run: Parameters<typeof listener>[0]) => listener(run);
    ipcRenderer.on("studyflow:ai", handler);
    return () => ipcRenderer.removeListener("studyflow:ai", handler);
  },
};

contextBridge.exposeInMainWorld("studyflow", api);
