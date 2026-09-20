/**
 * Dev CLI: print how a command scans.
 *
 *   npm run scan -- "rm -rf /"
 *
 * Useful to sanity-check what the guard flags before trusting it (or a rule)
 * in production. Also powering the README's limitation examples.
 */
import { scanCommand } from "../src/core/matcher.js";
import type { RuleMatch } from "../src/core/types.js";

const command = process.argv[2] ?? "";
if (!command) {
  process.stderr.write('usage: npm run scan -- "<command>"\n');
  process.exit(1);
}

const result = scanCommand(command, { cwd: process.cwd(), overrides: {} });

const line = (match: RuleMatch) => `  ${match.severity.padEnd(13)} ${match.rule.id}  ${match.rule.description}`;

let out = `command: ${command}\n`;
if (!result.hasHits) {
  out += "  -> no hits (would run un-reviewed)\n";
} else {
  for (const m of result.matches) out += `${line(m)}\n`;
}
process.stdout.write(out);