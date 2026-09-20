import { afterEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnReviewer } from "../src/subagent/pi-reviewer.js";

const STUB = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "stub-reviewer.mjs");
chmodSync(STUB, 0o755);

const ENOUGH_MS = 5000;
const TINY_MS = 300;

const allowEvent = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ verdict: "allow", reason: "stub says ok" }) }],
  },
});

function resetStubEnv() {
  delete process.env.STUB_EMIT;
  delete process.env.STUB_EXIT;
  delete process.env.STUB_SLEEP_MS;
}

function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-safety-reviewer-"));
  return dir;
}

afterEach(() => {
  resetStubEnv();
});

describe("spawnReviewer", () => {
  it("passes a user prompt arg and parses the streamed verdict", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = allowEvent;
    process.env.STUB_EXIT = "0";
    try {
      const r = await spawnReviewer({
        command: "touch foo",
        findings: "- fs.example: example finding.",
        cwd,
        timeoutMs: ENOUGH_MS,
        piBinary: STUB,
      });
      expect(r).toEqual({ verdict: "allow", reason: "stub says ok" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not forward a provider/model when unset", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = allowEvent;
    try {
      const r = await spawnReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        piBinary: STUB,
      });
      expect(r.verdict).toBe("allow");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes --provider and --model through when configured", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = allowEvent;
    try {
      const r = await spawnReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        piBinary: STUB,
        provider: "cline",
        model: "nvidia/x:free",
      });
      expect(r.verdict).toBe("allow");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed when the reviewer exits non-zero", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EXIT = "1";
    try {
      const r = await spawnReviewer({
        command: "touch foo",
        findings: "- fs.example: example finding.",
        cwd,
        timeoutMs: ENOUGH_MS,
        piBinary: STUB,
      });
      expect(r.verdict).toBe("block");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed on timeout", async () => {
    const cwd = tmpCwd();
    process.env.STUB_SLEEP_MS = "8000";
    try {
      const r = await spawnReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: TINY_MS,
        piBinary: STUB,
      });
      expect(r.verdict).toBe("block");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});