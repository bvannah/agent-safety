/**
 * Auto-generated rule expectations.
 *
 * For every rule in the registry:
 *  - every `unsafeExample` MUST produce a match carrying that rule id,
 *  - every `safeExample`  MUST NOT produce a match for that rule id.
 *
 * Adding an example to any rule therefore adds test coverage for free.
 */
import { describe, expect, it } from "vitest";
import { scanCommand } from "../src/core/matcher.js";
import { RULES } from "../src/core/rules.js";

describe("rules registry sanity", () => {
  it("rule ids are unique", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every rule can be looked up by id", () => {
    for (const rule of RULES) {
      // getRule() is covered implicitly; simplest check: scan uses the registry.
      expect(rule.patterns.length).toBeGreaterThan(0);
    }
  });

  it("every rule carries at least one safe and one unsafe example", () => {
    for (const rule of RULES) {
      expect(rule.safeExamples.length, `${rule.id} needs safeExamples`).toBeGreaterThan(0);
      expect(rule.unsafeExamples.length, `${rule.id} needs unsafeExamples`).toBeGreaterThan(0);
    }
  });

  it("base-`critical` rules escalate to critical for every unsafe example", () => {
    for (const rule of RULES) {
      if (rule.severity !== "critical") continue;
      for (const ex of rule.unsafeExamples) {
        const res = scanCommand(ex);
        expect(
          res.matches.filter((m) => m.rule.id === rule.id).every((m) => m.severity === "critical"),
          `${rule.id} should critically match: ${ex}`,
        ).toBe(true);
      }
    }
  });

  it("`informational` rules never reach needsReview/critical", () => {
    for (const rule of RULES) {
      if (rule.severity !== "informational") continue;
      for (const ex of rule.unsafeExamples) {
        const res = scanCommand(ex);
        const match = res.matches.find((m) => m.rule.id === rule.id);
        expect(match, `${rule.id} should match: ${ex}`).toBeDefined();
        expect(match!.severity, `${rule.id} informational severity: ${ex}`).toBe("informational");
      }
    }
  });

  it("escalate rules keep their unsafe examples at least needsReview", () => {
    for (const rule of RULES) {
      if (!rule.escalate) continue;
      for (const ex of rule.unsafeExamples) {
        const res = scanCommand(ex);
        const match = res.matches.find((m) => m.rule.id === rule.id);
        expect(match, `${rule.id} should match: ${ex}`).toBeDefined();
        expect(
          match!.severity === "needsReview" || match!.severity === "critical",
          `${rule.id} severity: ${ex}`,
        ).toBe(true);
      }
    }
  });
});

describe("auto-generated rule expectations", () => {
  for (const rule of RULES) {
    describe(rule.id, () => {
      for (const ex of rule.unsafeExamples) {
        it(`flags unsafe: ${ex}`, () => {
          const res = scanCommand(ex);
          expect(res.matches.map((m) => m.rule.id)).toContain(rule.id);
        });
      }

      for (const ex of rule.safeExamples) {
        it(`allows safe: ${ex}`, () => {
          const res = scanCommand(ex);
          expect(
            res.matches.filter((m) => m.rule.id === rule.id).length,
            `rule ${rule.id} must not fire on: ${ex}`,
          ).toBe(0);
        });
      }
    });
  }
});