/** Window-scoped refresh: run on opening/resume, retry failures quietly. */
export class StartupRefresh {
  private active = false;
  private pending?: Promise<void>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  constructor(private refreshSource: (signal: AbortSignal) => Promise<boolean>) {}
  start(): void { if (this.active) return; this.active = true; void this.refresh(); }
  stop(): void { this.active = false; clearTimeout(this.timer); this.controller?.abort(); }
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.refreshSource(controller.signal).catch(() => false).then(success => {
      this.failures = success ? 0 : this.failures + 1;
      if (this.active && !controller.signal.aborted && !success) this.timer = setTimeout(() => { void this.refresh(); }, Math.min(60_000 * 2 ** (this.failures - 1), 900_000));
    }).finally(() => {
      this.pending = undefined;
      // A window can reopen before cancellation of the previous attempt settles.
      if (this.active && controller.signal.aborted) void this.refresh();
    });
    return this.pending;
  }
}
