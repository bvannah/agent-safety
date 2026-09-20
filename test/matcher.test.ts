/**
 * Matcher core unit tests: normalization, de-escaping, override semantics,
 * escalation floor, and the needle fast-path.
 */
import { describe, expect, it } from "vitest";
import { deEscapeCommand, normalizeCommand, scanCommand } from "../src/core/matcher.js";
import { RULES } from "../src/core/rules.js";
import type { RuleOverride } from "../src/core/types.js";

describe("scanCommand basics", () => {
  it("returns no hits for an empty command", () => {
    const res = scanCommand("");
    expect(res.hasHits).toBe(false);
    expect(res.matches).toEqual([]);
  });

  it("bucketizes by effective severity", () => {
    const res = scanCommand("rm -rf /");
    expect(res.critical.some((m) => m.rule.id === "fs.rm.destructive")).toBe(true);
    expect(res.hasHits).toBe(true);
    expect(res.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("sorts critical before needsReview before informational", () => {
    const res = scanCommand("rm -rf / && eval \u0024x");
    const order = res.matches.map((m) => m.severity);
    const weights = { critical: 3, needsReview: 2, informational: 1 } as const;
    for (let i = 1; i < order.length; i++) {
      expect(weights[order[i - 1]!]).toBeGreaterThanOrEqual(weights[order[i]!]);
    }
  });

  it("catches backslash-escaped commands", () => {
    const res = scanCommand("rm\\ -rf\\ /");
    expect(res.critical.some((m) => m.rule.id === "fs.rm.destructive")).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    const a = scanCommand("git reset --hard");
    const b = scanCommand("git reset --hard");
    expect(a.matches.map((m) => m.rule.id)).toEqual(b.matches.map((m) => m.rule.id));
  });
});

describe("overrides", () => {
  const overrideOff: Record<string, RuleOverride> = Object.fromEntries(
  RULES.map((r) => [r.id, "off" as const]),
) as Record<string, RuleOverride>;

  it("'off' disables every rule", () => {
    const res = scanCommand("rm -rf /", { overrides: overrideOff });
    expect(res.hasHits).toBe(false);
  });

  it("critical severity is a fail-closed floor (escalation beats override)", () => {
    const res = scanCommand("rm -rf /", {
      overrides: { ...overrideOff, "fs.rm.plain": "needsReview", "fs.rm.destructive": "informational" },
    });
    // fs.rm.destructive escalates to critical even though overridden to informational.
    expect(res.matches.find((m) => m.rule.id === "fs.rm.destructive")?.severity).toBe("critical");
  });

  it("override cannot downgrade an escalated hit below needsReview", () => {
    const res = scanCommand("dd if=/dev/zero of=/dev/sda bs=1M count=1", {
      overrides: { ...overrideOff, "fs.dd": "informational" },
    });
    const dd = res.matches.find((m) => m.rule.id === "fs.dd");
    expect(dd).toBeDefined();
    expect(dd!.severity).toBe("critical");
  });
});

describe("normalizeCommand / deEscapeCommand", () => {
  it("collapses tabs and newlines to single spaces", () => {
    expect(normalizeCommand("a\tb\nc\rd")).toBe("a b c d");
  });
  it("leaves already-normalized strings alone", () => {
    expect(normalizeCommand("ls -la")).toBe("ls -la");
  });
  it("de-escapes only metacharacters, not letter escapes", () => {
    expect(deEscapeCommand("rm\\ -rf\\ /tmp\\ x")).toBe("rm -rf /tmp x");
  });
});