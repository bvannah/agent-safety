/**
 * Pi adapter tests.
 *
 * We mock the Pi runtime (just `pi.on`) and the subagent reviewer, then drive
 * the registered `tool_call` handler directly to verify the guard's decision
 * logic end-to-end (block / review / cache / budget).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import createPiExtension from "../src/adapters/pi.js";
import { spawnReviewer } from "../src/subagent/pi-reviewer.js";
import type { Settings } from "../src/core/types.js";
import { DEFAULT_SETTINGS } from "../src/core/types.js";

vi.mock("../src/subagent/pi-reviewer.js");

const mockReviewer = vi.mocked(spawnReviewer);

function makeSettings(over: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...over };
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeHarness(settings: Settings) {
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as never as Parameters<typeof createPiExtension>[0];

  createPiExtension(pi, { getSettings: () => settings });

  const callBash = async (command: string, cwd = "/tmp/proj") => {
    const ctx = { cwd, hasUI: true, ui: { notify } };
    const handler = handlers.get("tool_call")!;
    return handler({ toolName: "bash", toolCallId: "1", input: { command } }, ctx) as Promise<
      { block?: boolean; reason?: string } | undefined
    >;
  };

  const runSessionStart = () => {
    const handler = handlers.get("session_start")!;
    return handler({}, {});
  };

  return { handlers, notify, callBash, runSessionStart };
}

describe("Pi adapter", () => {
  beforeEach(() => {
    mockReviewer.mockReset();
    mockReviewer.mockResolvedValue({ verdict: "allow", reason: "ok" });
  });

  it("does nothing for non-bash tools", async () => {
    const { handlers } = makeHarness(makeSettings());
    const handler = handlers.get("tool_call")!;
    const result = await handler({ toolName: "read", toolCallId: "2", input: { filePath: "x" } }, {
      cwd: "/tmp",
      hasUI: false,
      ui: { notify: vi.fn() },
    });
    expect(result).toBeUndefined();
  });

  it("allows benign commands without consulting the reviewer", async () => {
    const { callBash } = makeHarness(makeSettings());
    const result = await callBash("ls -la");
    expect(result).toBeUndefined();
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("is a no-op when the guard is disabled", async () => {
    const { callBash } = makeHarness(makeSettings({ enabled: false }));
    const result = await callBash("rm -rf /");
    expect(result).toBeUndefined();
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("blocks critical commands fail-closed without a reviewer", async () => {
    const { callBash, notify } = makeHarness(makeSettings());
    const result = await callBash("rm -rf /");
    expect(result?.block).toBe(true);
    expect(String(result?.reason)).toContain("agent-safety blocked");
    expect(mockReviewer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("routes critical commands through review when blockCritical=false", async () => {
    const settings = makeSettings({ blockCritical: false });
    const { callBash } = makeHarness(settings);

    mockReviewer.mockResolvedValueOnce({ verdict: "allow", reason: "context ok" });
    const allowed = await callBash("rm -rf /");
    expect(allowed).toBeUndefined();
    expect(mockReviewer).toHaveBeenCalledTimes(1);

    mockReviewer.mockResolvedValueOnce({ verdict: "block", reason: "no context" });
    const blocked = await callBash("rm -rf /tmp/critical");
    expect(blocked?.block).toBe(true);
  });

  it("allows needsReview commands the reviewer approves", async () => {
    const { callBash } = makeHarness(makeSettings());
    mockReviewer.mockResolvedValueOnce({ verdict: "allow", reason: "safe temp cleanup" });
    const result = await callBash("rm -rf /tmp/scratch");
    expect(result).toBeUndefined();
  });

  it("blocks needsReview commands the reviewer rejects", async () => {
    const { callBash, notify } = makeHarness(makeSettings());
    mockReviewer.mockResolvedValueOnce({ verdict: "block", reason: "deletes user data" });
    const result = await callBash("rm -rf ./node_modules");
    expect(result?.block).toBe(true);
    expect(String(result?.reason)).toContain("deletes user data");
    expect(notify).toHaveBeenCalled();
  });

  it("does not call the reviewer twice for the same command (cache)", async () => {
    const { callBash } = makeHarness(makeSettings());
    mockReviewer.mockResolvedValue({ verdict: "block", reason: "bad" });

    const first = await callBash("rm -f notes.txt");
    expect(first?.block).toBe(true);

    const second = await callBash("rm -f notes.txt");
    expect(second?.block).toBe(true);
    expect(mockReviewer).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-session review budget, reset by session_start", async () => {
    const settings = makeSettings({ maxSubagentReviewsPerSession: 1 });
    const { callBash, runSessionStart } = makeHarness(settings);

    mockReviewer.mockResolvedValue({ verdict: "allow", reason: "ok" });

    expect((await callBash("rm -f a.txt"))?.block).toBeUndefined();
    expect(mockReviewer).toHaveBeenCalledTimes(1);

    const second = await callBash("rm -f b.txt");
    expect(second?.block).toBe(true);
    expect(String(second?.reason)).toContain("budget");

    await runSessionStart();
    const third = await callBash("rm -f c.txt");
    expect(third).toBeUndefined();
    expect(mockReviewer).toHaveBeenCalledTimes(2);
  });

  it("never reviews merely informational hits", async () => {
    const { callBash } = makeHarness(makeSettings());
    const result = await callBash('eval "$USER_INPUT"');
    expect(result).toBeUndefined();
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("skips review when useSubagent is disabled", async () => {
    const { callBash } = makeHarness(makeSettings({ useSubagent: false }));
    const result = await callBash("rm -f notes.txt");
    expect(result).toBeUndefined();
    expect(mockReviewer).not.toHaveBeenCalled();
  });
});