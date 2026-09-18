export function assignmentPermissions(workspace: string, networkEnabled: boolean) {
  return {
    permissions: "studyflow-assignment",
    config: {
      web_search: networkEnabled ? "live" : "disabled",
      ...(process.platform === "win32" ? { "windows.sandbox": "elevated" } : {}),
      "permissions.studyflow-assignment": {
        filesystem: { ":root": "deny", ":minimal": "read", [workspace]: "write" },
        network: { enabled: networkEnabled },
      },
    },
  };
}

export function explainAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The AI run failed.";
  if (/specified module could not be found|os error 126|helper.*(?:not found|740)/i.test(message)) {
    return "Windows could not launch the Codex sandbox helper. Close all StudyFlow windows, reopen Run-StudyFlow.bat, and retry the sandbox setup. If Windows still reports a missing module, repair StudyFlow's bundled Codex runtime. Agents were not run with unrestricted access.";
  }
  if (/orchestrator_helper_launch_canceled|ShellExecuteExW.*1223/i.test(message)) {
    return "Windows sandbox setup was cancelled or blocked. Click Retry draft and approve the Windows permission prompt for the bundled Codex sandbox setup. StudyFlow will not run the agents without their sandbox.";
  }
  if (/cannot enforce split filesystem read restrictions/i.test(message)) {
    return "The Windows restricted-read sandbox is unavailable. Restart StudyFlow and retry to set up the supported Windows sandbox. File access restrictions have not been relaxed.";
  }
  return message;
}
