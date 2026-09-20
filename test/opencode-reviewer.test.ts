import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reviewerConfigContent,
  spawnOpenCodeReviewer,
} from "../src/subagent/opencode-reviewer.js";

const STUB = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "stub-opencode-reviewer.mjs");
chmodSync(STUB, 0o755);

const ENOUGH_MS = 5000;
const TINY_MS = 300;

function resetStubEnv() {
  delete process.env.STUB_EMIT;
  delete process.env.STUB_EXIT;
  delete process.env.STUB_PRE_MS;
  delete process.env.STUB_HOLD_MS;
  delete process.env.STUB_ARGCHECK_FILE;
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "agent-safety-oc-reviewer-"));
}

afterEach(() => {
  resetStubEnv();
});

describe("spawnOpenCodeReviewer", () => {
  it("locks the reviewer down: no bash tool, pure plugins off", () => {
    const parsed = JSON.parse(reviewerConfigContent()) as { tools: { bash: boolean } };
    expect(parsed.tools.bash).toBe(false);
  });

  it("parses an ALLOW verdict from text events on a clean exit", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = '{"type":"text","part":{"type":"text","text":"ALLOW: harmless op"}}';
    process.env.STUB_EXIT = "0";
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "- fs.example: example finding.",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r).toEqual({ verdict: "allow", reason: "ALLOW: harmless op" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("settles BLOCK as soon as it is streamed, without waiting for the child to exit", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = '{"type":"text","part":{"type":"text","text":"BLOCK: deletes user data"}}';
    process.env.STUB_HOLD_MS = "20000";
    const start = Date.now();
    try {
      const r = await spawnOpenCodeReviewer({
        command: "rm -rf ~/Downloads",
        findings: "- fs.destructive: rm -rf.",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("block");
      expect(String(r.reason)).toContain("deletes user data");
      expect(Date.now() - start).toBeLessThan(4000);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("forwards --model when configured", async () => {
    const cwd = tmpCwd();
    const argFile = join(cwd, "args.json");
    process.env.STUB_ARGCHECK_FILE = argFile;
    try {
      await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
        model: "deepseek/deepseek-v4-flash",
      });
      const { args } = JSON.parse(readFileSync(argFile, "utf8")) as { args: string[] };
      expect(args.slice(0, 4)).toEqual(["run", "--format", "json", "--pure"]);
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-flash");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not forward --model when unset", async () => {
    const cwd = tmpCwd();
    const argFile = join(cwd, "args.json");
    process.env.STUB_ARGCHECK_FILE = argFile;
    try {
      await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      const { args } = JSON.parse(readFileSync(argFile, "utf8")) as { args: string[] };
      expect(args).not.toContain("--model");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed when the reviewer exits non-zero", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EXIT = "1";
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "- fs.example: example finding.",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("block");
      expect(String(r.reason)).toContain("exited with code 1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed on timeout", async () => {
    const cwd = tmpCwd();
    process.env.STUB_PRE_MS = "8000";
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: TINY_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("block");
      expect(String(r.reason)).toContain("timed out");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed on an unparseable reply (no verdict words)", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = '{"type":"text","part":{"type":"text","text":"Let me think about this..."}}';
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("block");
      expect(String(r.reason)).toContain("unparseable");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fail-closed when no text event arrives at all", async () => {
    const cwd = tmpCwd();
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("block");
      expect(String(r.reason)).toContain("no usable verdict");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("verifies the child inherits a prompt message (regression guard)", async () => {
    const cwd = tmpCwd();
    process.env.STUB_EMIT = '{"type":"text","part":{"type":"text","text":"ALLOW: ok"}}';
    try {
      const r = await spawnOpenCodeReviewer({
        command: "touch foo",
        findings: "none",
        cwd,
        timeoutMs: ENOUGH_MS,
        opencodeBinary: STUB,
      });
      expect(r.verdict).toBe("allow");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});