/**
 * Settings loader tests: precedence, merging, invalid-file resilience, env var.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, afterAll, describe, expect, it } from "vitest";
import { loadSettings } from "../src/core/settings.js";
import { DEFAULT_SETTINGS } from "../src/core/types.js";

let dir: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-safety-settings-"));
  // Isolate from the user's real ~/.pi/agent/safety.json so "defaults" is
  // deterministic regardless of what the installed config contains.
  process.env.HOME = mkdtempSync(join(tmpdir(), "agent-safety-home-"));
  delete process.env.AGENT_SAFETY_CONFIG;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(process.env.HOME!, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
});

describe("loadSettings", () => {
  it("returns defaults when no config exists", () => {
    const s = loadSettings(dir);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("reads a project safety.json", () => {
    writeFileSync(join(dir, "safety.json"), JSON.stringify({ blockCritical: false }));
    const s = loadSettings(dir);
    expect(s.blockCritical).toBe(false);
    expect(s.enabled).toBe(true); // untouched
  });

  it("merges overrides per-key across sources (project wins)", () => {
    writeFileSync(join(dir, "safety.json"), JSON.stringify({
      overrides: { "fs.rm.plain": "informational", "fs.dd": "off" },
    }));
    const s = loadSettings(dir);
    expect(s.overrides["fs.rm.plain"]).toBe("informational");
    expect(s.overrides["fs.dd"]).toBe("off");
  });

  it("skips invalid JSON files", () => {
    writeFileSync(join(dir, "safety.json"), "{not json!!!");
    const s = loadSettings(dir);
    expect(s.enabled).toBe(true);
  });

  it("honours AGENT_SAFETY_CONFIG as highest-precedence explicit file", () => {
    const explicit = join(dir, "explicit.json");
    writeFileSync(explicit, JSON.stringify({ useSubagent: false }));
    process.env.AGENT_SAFETY_CONFIG = explicit;

    // Also write a project file with a conflicting value; explicit wins.
    writeFileSync(join(dir, "safety.json"), JSON.stringify({ useSubagent: true }));
    const s = loadSettings(dir);
    expect(s.useSubagent).toBe(false);
  });

  it("ignores invalid override values", () => {
    writeFileSync(join(dir, "safety.json"), JSON.stringify({
      overrides: { "fs.rm.plain": "banana", "fs.dd": "off" },
    }));
    const s = loadSettings(dir);
    expect(s.overrides["fs.rm.plain"]).toBeUndefined();
    expect(s.overrides["fs.dd"]).toBe("off");
  });
});