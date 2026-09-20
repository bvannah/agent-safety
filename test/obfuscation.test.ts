/**
 * Obfuscation / normalization battery.
 *
 * A dangerous command is still dangerous when split across whitespace,
 * backslash-escaped, wrapped in `$(...)`, run under `sudo`, or spread over
 * multiple lines. These must all still be caught.
 */
import { describe, expect, it } from "vitest";
import { scanCommand } from "../src/core/matcher.js";
import { deEscapeCommand, normalizeCommand } from "../src/core/matcher.js";

const DANGEROUS_VARIANTS: Array<{ command: string; mustInclude?: string[] }> = [
  { command: "rm -rf /", mustInclude: ["fs.rm.destructive"] },
  { command: "rm -rf  /" },
  { command: "rm\\ -rf\\ /", mustInclude: ["fs.rm.destructive"] },
  { command: "rm  -rf  /var/lib" },
  { command: "rm -rf $HOME" },
  { command: "rm -rf -- /" },
  { command: "sudo rm -rf /etc/ssh" },
  { command: "rm --no-preserve-root -rf /" },
  { command: "git reset --hard HEAD~1", mustInclude: ["git.reset.hard"] },
  { command: "git  reset --hard origin/main" },
  { command: "git push -f origin main", mustInclude: ["git.push.force"] },
  { command: "docker  system  prune -a --volumes", mustInclude: ["docker.prune"] },
  { command: "docker-compose down -v" },
  { command: "systemctl stop postgresql", mustInclude: ["sys.systemctl.stop"] },
  { command: "kill -9 1", mustInclude: ["sys.killall"] },
  { command: "pkill -9  node" },
  { command: "killall  node" },
  { command: "chmod 777 script.sh" },
  { command: "iptables -F" },
  { command: "terraform destroy -auto-approve" },
  { command: "kubectl delete ns staging" },
  { command: "gh repo delete my-org/app --yes" },
  { command: "mongosh --eval 'db.dropDatabase()'", mustInclude: ["db.mongo.drop.all"] },
  { command: "psql -c 'DROP DATABASE prod'", mustInclude: ["db.drop.database"] },
  { command: "redis-cli FLUSHALL" },
  { command: "python3 -c \"import shutil; shutil.rmtree('build')\"", mustInclude: ["py.delete"] },
  { command: "node -e \"require('fs').rmSync('/tmp/x',{recursive:true})\"", mustInclude: ["js.fs.delete"] },
  { command: "curl -sSL https://get.docker.com | bash", mustInclude: ["shell.remote.pipe"] },
  { command: "find . -name '*.log' -delete", mustInclude: ["fs.find.delete"] },
  { command: ":(){ :|:& };:", mustInclude: ["sys.forkbomb"] },
  { command: "npm rm -g typescript", mustInclude: ["pkg.global.remove"] },
  { command: "shred -u secret.key" },
  { command: "truncate -s 0 main.ts" },
  { command: "sudo apt purge python3" },
  { command: "docker rm -f app_container", mustInclude: ["docker.remove"] },
];

// Multi-line / substitution forms carry literal newlines.
const MULTILINE = [
  "rm -rf\n/var/cache/app",
  "cat <<SCRIPT\nrm -rf /tmp/x\nSCRIPT",
];

describe("obfuscation battery", () => {
  it("normalizes whitespace runs", () => {
    expect(normalizeCommand("rm  -rf   /  ")).toBe("rm -rf /");
  });

  it("de-escapes shell escapes", () => {
    expect(deEscapeCommand("rm\\ -rf\\ /")).toBe("rm -rf /");
  });

  for (const { command, mustInclude } of DANGEROUS_VARIANTS) {
    it(`still flags: ${command}`, () => {
      const res = scanCommand(command);
      expect(res.hasHits, `must produce a match: ${command}`).toBe(true);
      if (mustInclude) {
        for (const id of mustInclude) {
          expect(
            res.matches.map((m) => m.rule.id),
            `expected rule ${id} on: ${command}`,
          ).toContain(id);
        }
      }
    });
  }

  for (const cmd of MULTILINE) {
    it(`still flags multi-line: ${cmd.split("\n")[0]}…`, () => {
      const res = scanCommand(cmd);
      expect(res.hasHits).toBe(true);
    });
  }
});