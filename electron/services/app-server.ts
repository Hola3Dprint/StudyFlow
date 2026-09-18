import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { CodexAccount, LoginStart } from "../../shared/types";

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
}

export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private counter = 0;
  private readonly pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private readonly completedTurns = new Map<string, Record<string, unknown>>();
  private readonly dataHome: string;
  private readonly toolHandlers = new Map<string, (tool: string, args: unknown) => Promise<Record<string, unknown>>>();

  registerTools(threadId: string, handler: (tool: string, args: unknown) => Promise<Record<string, unknown>>): () => void {
    this.toolHandlers.set(threadId, handler);
    return () => { this.toolHandlers.delete(threadId); };
  }

  constructor(dataHome: string) {
    super();
    this.dataHome = dataHome;
  }

  private locate(): { executable: string; args: string[]; environment: NodeJS.ProcessEnv } {
    const custom = process.env.STUDYFLOW_CODEX_BIN;
    if (custom) return { executable: custom, args: ["app-server"], environment: process.env };
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("@openai/codex/package.json");
    const packageDirectory = path.dirname(packagePath);
    if (process.platform === "win32") {
      const platformRequire = createRequire(packagePath);
      const platformPackage = platformRequire.resolve(`@openai/codex-win32-${process.arch}/package.json`);
      const target = process.arch === "arm64" ? "aarch64" : "x86_64";
      const executable = path.join(path.dirname(platformPackage), "vendor", `${target}-pc-windows-msvc`, "bin", "codex.exe");
      if (!existsSync(executable)) throw new Error("The bundled Codex executable is missing. Restore StudyFlow dependencies and restart.");
      return { executable, args: ["app-server"], environment: process.env };
    }
    const candidates = [path.join(packageDirectory, "bin", "codex.js"), path.join(packageDirectory, "dist", "cli.js")];
    const script = candidates.find(existsSync);
    if (!script) throw new Error("The bundled Codex runtime was not found. Reinstall StudyFlow or set STUDYFLOW_CODEX_BIN.");
    return { executable: process.execPath, args: [script, "app-server"], environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed) return;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async launch(): Promise<void> {
    await mkdir(this.dataHome, { recursive: true });
    const runtime = this.locate();
    this.child = spawn(runtime.executable, runtime.args, {
      cwd: this.dataHome,
      stdio: "pipe",
      windowsHide: true,
      env: { ...runtime.environment, CODEX_HOME: this.dataHome, CODEX_DISABLE_AUTO_UPDATE: "1" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("diagnostic", chunk.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")));
    const child = this.child;
    const disconnected = (error: Error) => {
      if (this.child !== child) return;
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
      this.child = null;
      this.emit("disconnected", error);
    };
    child.once("error", disconnected);
    child.once("exit", () => disconnected(new Error("Codex app-server stopped. Restart StudyFlow and retry.")));
    try {
      await this.request("initialize", { clientInfo: { name: "StudyFlow", title: "StudyFlow", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      this.notify("initialized", {});
    } catch (error) { await this.stop(); throw error; }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (message.id !== undefined && message.method) {
            const handler = message.method === "item/tool/call" ? this.toolHandlers.get(String(message.params?.threadId)) : undefined;
            if (handler) {
              const child = this.child;
              void handler(String(message.params?.tool), message.params?.arguments).then(result => child?.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`)).catch(() => child?.stdin.write(`${JSON.stringify({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "The assignment tool failed." }] } })}\n`));
              boundary = this.buffer.indexOf("\n");
              continue;
            }
            // Never silently leave server-initiated approval/input requests pending.
            this.child?.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "StudyFlow cannot approve this request. Continue within the existing permissions or report missing information." } })}\n`);
            boundary = this.buffer.indexOf("\n");
            continue;
          }
          if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (pending) {
              if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server error."));
              else pending.resolve(message.result ?? {});
            }
          } else if (message.method) {
            if (message.method === "turn/completed" && message.params?.turn) {
              const turn = message.params.turn as Record<string, unknown>;
              this.completedTurns.set(String(turn.id), turn);
              if (this.completedTurns.size > 100) this.completedTurns.delete(this.completedTurns.keys().next().value!);
            }
            this.emit("notification", { method: message.method, params: message.params } satisfies JsonRpcNotification);
          }
        } catch {
          this.emit("diagnostic", "Codex emitted a non-JSON diagnostic line.");
        }
      }
      boundary = this.buffer.indexOf("\n");
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.start();
    return this.request(method, params);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.counter;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out. Stop and retry the workspace.`)); }, 90000);
      this.pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child?.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.child) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");
  }

  async waitForTurn(turnId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new DOMException("AI run cancelled", "AbortError");
    const cached = this.completedTurns.get(turnId);
    if (cached) {
      this.completedTurns.delete(turnId);
      if (cached.status !== "completed") throw new Error((cached.error as { message?: string } | undefined)?.message ?? `Codex turn ${String(cached.status)}.`);
      return cached;
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const complete = (notification: JsonRpcNotification) => {
        const candidate = notification.params?.turn;
        if (!candidate || typeof candidate !== "object") return;
        const turn = candidate as Record<string, unknown>;
        if (notification.method !== "turn/completed" || String(turn.id ?? "") !== turnId) return;
        cleanup();
        const status = String(turn.status ?? "failed");
        if (status === "completed") resolve(turn);
        else reject(new Error(typeof (turn.error as { message?: unknown } | undefined)?.message === "string" ? (turn.error as { message: string }).message : `Codex turn ${status}.`));
      };
      const abort = () => { cleanup(); reject(new DOMException("AI run cancelled", "AbortError")); };
      const disconnected = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        this.off("notification", complete);
        this.off("disconnected", disconnected);
        signal?.removeEventListener("abort", abort);
      };
      this.on("notification", complete);
      this.once("disconnected", disconnected);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async ensureSandbox(signal?: AbortSignal): Promise<void> {
    if (process.platform !== "win32") return;
    if (signal?.aborted) throw new DOMException("AI run cancelled", "AbortError");
    const readiness = await this.call("windowsSandbox/readiness");
    if (readiness.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.off("notification", completed); this.off("disconnected", finish); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
      const abort = () => finish(new DOMException("AI run cancelled", "AbortError"));
      const completed = (notification: JsonRpcNotification) => {
        if (notification.method !== "windowsSandbox/setupCompleted" || notification.params?.mode !== "elevated") return;
        finish(notification.params.success ? undefined : new Error(`Windows sandbox setup failed: ${String(notification.params.error ?? "unknown error")}`));
      };
      const timer = setTimeout(() => finish(new Error("Windows sandbox setup timed out. Check the Windows permission prompt and retry.")), 120000);
      this.on("notification", completed);
      this.once("disconnected", finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void this.call("windowsSandbox/setupStart", { mode: "elevated" }).then(result => { if (!result.started) finish(new Error("Windows sandbox setup did not start. Close other StudyFlow windows and retry.")); }, finish);
    });
  }

  async account(): Promise<CodexAccount> {
    try {
      const response = await this.call("account/read");
      const details = (response.account ?? response) as Record<string, unknown>;
      const mode = details.type ?? details.authMode;
      const authMode = mode === "chatgpt" ? "chatgpt" : mode === "apiKey" ? "apiKey" : "none";
      const limits: Record<string, unknown> = await this.call("account/rateLimits/read").catch(() => ({}));
      const buckets = limits.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === "object"
        ? Object.values(limits.rateLimitsByLimitId) as Array<Record<string, unknown>>
        : limits.rateLimits && typeof limits.rateLimits === "object" ? [limits.rateLimits as Record<string, unknown>] : [];
      const usage = buckets.flatMap(bucket => ["primary", "secondary"].flatMap(key => {
        const window = bucket[key] as { usedPercent?: number; resetsAt?: number; windowDurationMins?: number } | null;
        if (!window) return [];
        return [{ label: `${String(bucket.limitName ?? bucket.limitId ?? "Codex")} · ${window.windowDurationMins ? `${window.windowDurationMins / 60}h` : key}`, remaining: typeof window.usedPercent === "number" ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : undefined, resetAt: typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000).toISOString() : null }];
      }));
      return {
        authMode,
        email: typeof details.email === "string" ? details.email : null,
        planType: typeof details.planType === "string" ? details.planType : null,
        usage,
        isAvailable: true,
      };
    } catch (error) {
      return { authMode: "unknown", usage: [], isAvailable: false, lastError: error instanceof Error ? error.message : "Codex is unavailable." };
    }
  }

  async login(kind: "browser" | "device"): Promise<LoginStart> {
    const response = await this.call("account/login/start", kind === "browser"
      ? { type: "chatgpt", useHostedLoginSuccessPage: false }
      : { type: "chatgptDeviceCode" });
    const loginId = String(response.loginId ?? "");
    if (!loginId) throw new Error("Codex did not return a login identifier.");
    if (kind === "browser") return { kind, loginId, authUrl: String(response.authUrl ?? "") };
    return { kind, loginId, verificationUrl: String(response.verificationUrl ?? ""), userCode: String(response.userCode ?? "") };
  }

  async logout(): Promise<void> {
    await this.call("account/logout");
  }

  async stop(): Promise<void> {
    const error = new Error("Codex app-server stopped.");
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
    this.emit("disconnected", error);
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.buffer = "";
    this.completedTurns.clear();
    this.toolHandlers.clear();
  }
}
