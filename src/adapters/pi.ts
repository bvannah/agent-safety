/**
 * Pi coding agent extension adapter.
 *
 * Thin wiring of the shared {@link Guard} into Pi's `tool_call` pre-execution
 * hook. Only the `bash` tool is scanned. The shared guard decides whether to
 * block (critical fail-closed), ask a tool-less Pi subagent for a verdict
 * (cached per command), or allow. This file only supplies the Pi-flavoured
 * pieces: settings loading, the Pi subagent reviewer, and UI notifications.
 *
 * Import spec: the installed package is `@earendil-works/pi-coding-agent`.
 * Relative imports use the `.js` extension (jiti maps `.js` → `.ts`).
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Guard } from "../core/guard.js";
import { loadSettings } from "../core/settings.js";
import type { Settings } from "../core/types.js";
import { spawnReviewer } from "../subagent/pi-reviewer.js";

export { SettingsCache, VerdictCache } from "../core/guard.js";

/**
 * Local narrowing guard: `toolName === "bash"` at runtime is just a string
 * check; its TS type-guard semantics mirror the package's `isToolCallEventType`
 * for the bash tool. Implementing it here keeps the installed extension free
 * of a runtime dependency on the pi package.
 */
function isBashToolCall(event: ToolCallEvent): event is ToolCallEvent & { input: { command: string } } {
  return event.toolName === "bash";
}

interface PiExtensionOptions {
  /** External settings source (tests, embedding). Defaults to the loader. */
  getSettings?: (cwd: string) => Settings;
}

export default function createPiExtension(pi: ExtensionAPI, opts: PiExtensionOptions = {}): void {
  const load = opts.getSettings ?? loadSettings;

  const guard = new Guard({
    loadSettings: (cwd) => load(cwd),
    review: async ({ command, findings, cwd }) => {
      const settings = load(cwd);
      return spawnReviewer({
        command,
        findings,
        cwd,
        timeoutMs: settings.subagentTimeoutMs,
        model: settings.reviewerModel,
        provider: settings.reviewerProvider,
      });
    },
  });

  // A fresh session restarts the subagent review budget.
  pi.on("session_start", () => {
    guard.resetSession();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isBashToolCall(event)) return undefined;
    const result = await guard.handle({
      command: event.input.command,
      cwd: ctx.cwd,
      notify: (type, text) => {
        if (ctx.hasUI) ctx.ui.notify(text, type);
      },
    });
    return result;
  });
}