/**
 * OpenCode adapter tests.
 *
 * We mock the OpenCode subagent reviewer, create the plugin with an injected
 * settings source, then drive the returned hooks directly to verify the
 * guard's decision logic end-to-end (block via throw / review / cache / budget).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opencodeAgentSafetyPlugin } from "../src/adapters/opencode.js";
import { spawnOpenCodeReviewer } from "../src/subagent/opencode-reviewer.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/types.js";

vi.mock("../src/subagent/opencode-reviewer.js");

const mockReviewer = vi.mocked(spawnOpenCodeReviewer);

function makeSettings(over: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...over };
}

type BeforeHook = (input: unknown, output: unknown) => Promise<void>;
type EventHook = (input: unknown) => Promise<void>;

async function makeHarness(settings: Settings) {
  const hooks: {
    before?: BeforeHook;
    event?: EventHook;
  } = {};
  const plugin = await opencodeAgentSafetyPlugin(
    { directory: "/tmp/proj", worktree: "/tmp/proj" } as never,
    { loadSettings: () => settings }
  );
  hooks.before = plugin["tool.execute.before"] as BeforeHook;
  hooks.event = plugin.event as EventHook;

  const callBash = async (command: string) => {
    let error: unknown;
    try {
      await hooks.before!(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command } }
      );
    } catch (e) {
      error = e;
    }
    return { threw: error instanceof Error, reason: error instanceof Error ? error.message : undefined };
  };

  const runSessionCreated = () => hooks.event!({ event: { type: "session.created" } });

  return { hooks, callBash, runSessionCreated };
}

describe("opencodeAgentSafetyPlugin", () => {
  beforeEach(() => {
    mockReviewer.mockReset();
    mockReviewer.mockResolvedValue({ verdict: "allow", reason: "ok" });
  });

  it("does nothing for non-bash tools", async () => {
    const { hooks } = await makeHarness(makeSettings());
    let result: unknown = "unset";
    await hooks.before!(
      { tool: "read", sessionID: "s1", callID: "c2" },
      { args: {} }
    ).catch((e) => (result = e));
    expect(result).toBe("unset");
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("allows benign commands without consulting the reviewer", async () => {
    const { callBash } = await makeHarness(makeSettings());
    const r = await callBash("ls -la");
    expect(r.threw).toBe(false);
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("is a no-op when the guard is disabled", async () => {
    const { callBash } = await makeHarness(makeSettings({ enabled: false }));
    const r = await callBash("rm -rf /");
    expect(r.threw).toBe(false);
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("blocks critical commands fail-closed by throwing, without a reviewer", async () => {
    const { callBash } = await makeHarness(makeSettings());
    const r = await callBash("rm -rf /");
    expect(r.threw).toBe(true);
    expect(String(r.reason)).toContain("agent-safety blocked");
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("routes critical commands through review when blockCritical=false", async () => {
    const { callBash } = await makeHarness(makeSettings({ blockCritical: false }));

    mockReviewer.mockResolvedValueOnce({ verdict: "allow", reason: "context ok" });
    const allowed = await callBash("rm -rf /");
    expect(allowed.threw).toBe(false);
    expect(mockReviewer).toHaveBeenCalledTimes(1);

    mockReviewer.mockResolvedValueOnce({ verdict: "block", reason: "no context" });
    const blocked = await callBash("rm -rf /tmp/critical");
    expect(blocked.threw).toBe(true);
    expect(String(blocked.reason)).toContain("no context");
  });

  it("allows needsReview commands the reviewer approves", async () => {
    const { callBash } = await makeHarness(makeSettings());
    mockReviewer.mockResolvedValueOnce({ verdict: "allow", reason: "safe temp cleanup" });
    const r = await callBash("rm -rf /tmp/scratch");
    expect(r.threw).toBe(false);
  });

  it("blocks needsReview commands the reviewer rejects", async () => {
    const { callBash } = await makeHarness(makeSettings());
    mockReviewer.mockResolvedValueOnce({ verdict: "block", reason: "deletes user data" });
    const r = await callBash("rm -rf ./node_modules");
    expect(r.threw).toBe(true);
    expect(String(r.reason)).toContain("deletes user data");
  });

  it("does not call the reviewer twice for the same command (cache)", async () => {
    const { callBash } = await makeHarness(makeSettings());
    mockReviewer.mockResolvedValue({ verdict: "block", reason: "bad" });

    const first = await callBash("rm -f notes.txt");
    expect(first.threw).toBe(true);

    const second = await callBash("rm -f notes.txt");
    expect(second.threw).toBe(true);
    expect(mockReviewer).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-session review budget, reset by session.created", async () => {
    const settings = makeSettings({ maxSubagentReviewsPerSession: 1 });
    const { callBash, runSessionCreated } = await makeHarness(settings);

    mockReviewer.mockResolvedValue({ verdict: "allow", reason: "ok" });

    expect((await callBash("rm -f a.txt")).threw).toBe(false);
    expect(mockReviewer).toHaveBeenCalledTimes(1);

    const second = await callBash("rm -f b.txt");
    expect(second.threw).toBe(true);
    expect(String(second.reason)).toContain("budget");

    await runSessionCreated();
    const third = await callBash("rm -f c.txt");
    expect(third.threw).toBe(false);
    expect(mockReviewer).toHaveBeenCalledTimes(2);
  });

  it("never reviews merely informational hits", async () => {
    const { callBash } = await makeHarness(makeSettings());
    const r = await callBash('eval "$USER_INPUT"');
    expect(r.threw).toBe(false);
    expect(mockReviewer).not.toHaveBeenCalled();
  });

  it("skips review when useSubagent is disabled", async () => {
    const { callBash } = await makeHarness(makeSettings({ useSubagent: false }));
    const r = await callBash("rm -f notes.txt");
    expect(r.threw).toBe(false);
    expect(mockReviewer).not.toHaveBeenCalled();
  });
});