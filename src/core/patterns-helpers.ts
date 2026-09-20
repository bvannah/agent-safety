/**
 * Pure string-analysis helpers used by `targetCheck` / `escalate` predicates
 * on safety rules. All functions are deterministic and side-effect free so
 * they run inside the fast matcher and are trivially unit-testable.
 */

const DEVICE_PREFIX = /^\/(?:dev|sys|proc)\//;

/** Files whose accidental truncation or overwrite is dangerous. */
const PROTECTED_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.test",
  ".git",
  ".git-credentials",
  ".gitignore",
  ".htpasswd",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "authorized_keys",
  "credentials.json",
  "docker-compose.yml",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "yarn.lock",
];

const PROTECTED_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".p8",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
  ".otp",
  ".ovpn",
];

/**
 * Source-code extensions. Overwriting one of these with a redirect,
 * `open(...,"w")`, or `fs.writeFile` is treated as destructive. Common
 * *output* formats (.json, .md, .sql, .log, ...) are intentionally excluded.
 */
const SOURCE_CODE_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".jl",
  ".js",
  ".jsx",
  ".kt",
  ".m",
  ".php",
  ".pl",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
];

/** System directories redirected / moved / copied into are dangerous. */
const SYSTEM_DIR_PREFIXES = [
  "/bin/",
  "/boot/",
  "/etc/",
  "/opt/",
  "/proc/",
  "/root/",
  "/run/",
  "/srv/",
  "/sys/",
  "/usr/",
  "/var/",
];

const SYSTEM_BASE_DIRS = [
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/boot",
  "/srv",
  "/opt",
  "/sbin",
  "/lib",
  "/lib64",
  "/mnt",
  "/media",
  "/data",
];

const ROOT_NAMES = new Set([
  ".",
  "./",
  "..",
  "../",
  "~",
  "*",
  "/",
  "$HOME",
  "${HOME}",
  "/root",
  "/home",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/boot",
  "/srv",
  "/opt",
  "/sbin",
  "/lib",
  "/lib64",
]);

const SAFE_TEMP_PREFIXES = ["/tmp/", "/var/tmp/", "/dev/shm/"];

function stripQuotes(token: string): string {
  return token.replace(/^(["'])(?:\$)?/, "").replace(/['"]$/, "").trim();
}

/** Extract the first non-flag argument after `rm ... <flags>` (the target). */
export function rmTarget(cmd: string): string | null {
  const m = cmd.match(
    /\b(?:sudo\s+)?rm\b(?:(?:\s+-(?:-[a-zA-Z-]+|[a-zA-Z]+))*\s+(?:--\s+)?([^\s;|&>()]+))?/
  );
  if (!m?.[1]) return null;
  const raw = stripQuotes(m[1]);
  if (!raw || raw.startsWith("--")) return null;
  return raw;
}

/**
 * True when an `rm` target nukes a whole root / home / system directory,
 * including glob forms like `*` and `/var/*`, or is a device path.
 */
export function isRootRmTarget(target: string | null): boolean {
  if (!target) return false;
  if (ROOT_NAMES.has(target)) return true;
  // `./..`, `./.`, `././` … path-prefixed root forms resolve to parent/current.
  if (/^\.\/+/.test(target)) {
    const rest = target.replace(/^\.\/+/, "");
    if (rest === "" || rest === "." || rest === "..") return true;
  }
  if (/^\.{3,}$/.test(target)) return true;
  if (/^(\.?\/)?\*$|^\.\*$/.test(target)) return true;
  if (target.startsWith("/dev/") || target.startsWith("/sys/") || target.startsWith("/proc/")) return true;

  // `/var/*`, `$HOME/*`, `./*` … glob-of-contents on a system/root dir.
  const globMatch = target.match(/^(.+)\/\*$/);
  if (globMatch?.[1]) {
    const base = globMatch[1].replace(/\$\{?HOME\}?/, "/home");
    if (base === "." || base === "~" || base === "/") return true;
    if (SYSTEM_BASE_DIRS.some((d) => base === d || base.startsWith(d + "/"))) return true;
  }
  if (/^\.{2,}(\/\.\.)*(\/\*)?$/.test(target)) return true;
  return false;
}

/** True when the command contains `rm --no-preserve-root`. */
export function hasNoPreserveRoot(cmd: string): boolean {
  return /\brm\b[^\n|;]*--no-preserve-root/.test(cmd);
}

/** True when `dd of=` targets a device path. */
export function ddTargetsDevice(cmd: string): boolean {
  if (!/\bdd\b/.test(cmd)) return false;
  const of = cmd.match(/\bof\s*=\s*["']?([^\s"']+)/);
  return !!of?.[1] && DEVICE_PREFIX.test(stripQuotes(of[1]));
}

/** True when `mkfs.*` targets a block device. */
export function mkfsTargetsDevice(cmd: string): boolean {
  const m = cmd.match(/\bmkfs(?:\.[a-zA-Z0-9]+)?\s+["']?([^\s"']+)/);
  if (!m?.[1]) return false;
  const t = stripQuotes(m[1]);
  return DEVICE_PREFIX.test(t) || t === "/dev";
}

/**
 * Token immediately after a non-stderr overwrite redirect (`>`, not `>>`,
 * not `>&`), allowing whitespace between `>` and the target. `/dev/null` is
 * the safe null sink and is never treated as a dangerous target.
 */
export function redirectDest(cmd: string): string | null {
  const m = cmd.match(/(?<![0-9])>(?!>)(?!&)\s*([^\s;&|]+)/);
  if (!m?.[1]) return null;
  const dest = stripQuotes(m[1]);
  return dest === "/dev/null" ? null : dest;
}

/** True when an overwrite redirect targets a device path. */
export function redirectTargetsDevice(cmd: string): boolean {
  const dest = redirectDest(cmd);
  return dest !== null && (DEVICE_PREFIX.test(dest) || dest === "/dev");
}

/** Last non-flag token of a `mv` / `cp` command (the destination). */
export function moveOrCopyDest(cmd: string): string | null {
  if (!/\bmv\b/.test(cmd) && !/\bcp\b/.test(cmd)) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  let last: string | null = null;
  let inCommand = false;
  for (const t of tokens) {
    if (!inCommand) {
      if (t === "mv" || t === "cp") inCommand = true;
      continue;
    }
    if (t === "sudo") continue;
    if (t === "--") {
      last = null;
      continue;
    }
    if (t.startsWith("-")) continue;
    last = t;
  }
  return last ? stripQuotes(last) : null;
}

/** Whether a path token looks like a secret / config file. */
export function isProtectedPathToken(token: string | null): boolean {
  if (!token) return false;
  const t = token.toLowerCase().split(/[?#]/)[0] ?? token;
  const base = t.split("/").pop() ?? t;
  if (PROTECTED_FILE_NAMES.includes(base)) return true;
  if (PROTECTED_EXTENSIONS.some((e) => base.endsWith(e))) return true;
  if (t.endsWith("/.ssh/") || t.includes("/.ssh/") || t.includes("/.aws/")) return true;
  return false;
}

/** Whether a path token lives in a system directory. */
export function isSystemPathToken(token: string | null): boolean {
  if (!token) return false;
  const t = stripQuotes(token);
  if (t === "/") return true;
  return SYSTEM_DIR_PREFIXES.some((p) => t.startsWith(p));
}

function isInSafeTemp(token: string | null): boolean {
  if (!token) return false;
  return SAFE_TEMP_PREFIXES.some((p) => token.startsWith(p));
}

/** Whether the command references any secret / protected path token. */
export function commandReferencesProtected(cmd: string): boolean {
  const tokens = cmd.split(/\s+/);
  let inCommand = false;
  for (const t of tokens) {
    if (!inCommand) {
      if (t === "mv" || t === "cp" || t === "rm") inCommand = true;
      continue;
    }
    if (t === "sudo" || t.startsWith("-")) continue;
    if (isProtectedPathToken(stripQuotes(t))) return true;
  }
  return false;
}

function isRewritableTarget(token: string | null): boolean {
  return (
    isProtectedPathToken(token) ||
    isSystemPathToken(token) ||
    SOURCE_CODE_EXTENSIONS.some((e) => (token ?? "").toLowerCase().endsWith(e))
  );
}

/** Whether a `> dest` overwrite targets a device / protected / system / source file. */
export function redirectTargetsProtectedOrSystem(cmd: string): boolean {
  return redirectTargetsDevice(cmd) || isRewritableTarget(redirectDest(cmd));
}

/** Whether a `mv`/`cp` destination is protected or system (git mv/cp is fine). */
export function moveOrCopyTargetsProtectedOrSystem(cmd: string): boolean {
  if (/\bgit\s+(?:mv|cp)\b/.test(cmd)) return false;
  const dest = moveOrCopyDest(cmd);
  if (dest !== null && isInSafeTemp(dest) && !isProtectedPathToken(dest)) {
    // Moving into a temp dir is usually fine — unless the command is moving
    // or copying a secret in there (e.g. `cp secret.pem /tmp/private/`).
    return commandReferencesProtected(cmd);
  }
  return isProtectedPathToken(dest) || isSystemPathToken(dest);
}

/** Extract the string-literal file argument of a Python `open(...,"w")`. */
export function pyOpenWritePath(cmd: string): string | null {
  const m = cmd.match(/open\(\s*["']([^"']+)["']\s*,\s*["']w(?:b)?["']/);
  return m?.[1] ? stripQuotes(m[1]) : null;
}

/** Whether a Python `open(...,"w")` truncation targets a real path. */
export function pyOpenWritesProtected(cmd: string): boolean {
  const p = pyOpenWritePath(cmd);
  if (!p) return false;
  if (isInSafeTemp(p)) return false;
  return isRewritableTarget(p);
}

/** Whether a Node `fs.writeFile(Sync)` truncation targets a real path. */
export function jsWritesProtected(cmd: string): boolean {
  const m = cmd.match(/fs\.writeFile(?:Sync)?\(\s*["']([^"']+)["']/);
  if (!m?.[1]) return false;
  const p = stripQuotes(m[1]);
  if (isInSafeTemp(p)) return false;
  return isRewritableTarget(p);
}

/**
 * `DELETE FROM` without a real guard: it must have neither `WHERE`/`LIMIT`,
 * or a WHERE clause that is trivially true (`WHERE true`, `WHERE 1`, ...).
 */
export function isUnscopedDelete(cmd: string): boolean {
  if (!/\bdelete\s+from\b/i.test(cmd)) return false;
  if (/\blimit\b/i.test(cmd)) return false;
  const whereIdx = cmd.search(/\bwhere\b/i);
  if (whereIdx === -1) return true;
  const rest = cmd.slice(whereIdx + 5);
  return /^\s*(1|true)(?:\s*(?:=|==)\s*1)?\s*["';]?\s*$/i.test(rest);
}

/** Whether `git add`/`commit` touches secret-like paths. */
export function gitStagesProtected(cmd: string): boolean {
  if (!/\bgit\s+(?:add|commit)\b/i.test(cmd)) return false;
  return /(?:\.env(?:\.\w+)?|credentials\.json|\.pem|\.key|\.git-credentials|\.netrc|\.pgpass|\bid_rsa\b|\bid_ed25519\b)/i.test(cmd);
}

/** Whether the command runs a remote-exec pipe like `curl … | sh`. */
export function isRemotePipeToShell(cmd: string): boolean {
  return /(?:curl|wget|aria2c)\b[^\n|;]*\s\|\s*(?:sudo\s+)?(?:sh|bash|zsh|tcsh|fish)\b/.test(cmd);
}

/** `systemctl stop/disable/mask/kill` of a service. */
export function systemctlStopsCoreService(cmd: string): boolean {
  return /\bsystemctl\s+(?:stop|disable|mask|kill)\s+([\w@.:-]+)/i.test(cmd);
}

/** `service X stop|kill` of a named service. */
export function serviceStopsCore(cmd: string): boolean {
  return /\bservice\s+([\w@.:-]+)\s+(?:stop|kill)\b/i.test(cmd);
}

/** Whether a command text contains destructive SQL keywords. */
export function containsDestructiveSql(cmd: string): boolean {
  return /\b(drop|truncate)\s+(database|table|schema|view|role|user|sequence|index|trigger|procedure|function)\b/i.test(cmd);
}

/** Whether an rm target is a device or a protected/system path. */
export function rmTargetsDeviceOrProtected(cmd: string): boolean {
  const target = rmTarget(cmd);
  if (!target) return false;
  if (DEVICE_PREFIX.test(target) || target === "/dev") return true;
  return isProtectedPathToken(target) || isSystemPathToken(target);
}

/** Escape a rm target check for reused regexes on the whole command. */
export function hasDangerousRmFlags(cmd: string): boolean {
  return /\b(?:sudo\s+)?rm\b\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--(?:recursive|force|dir))\b/.test(cmd);
}

/**
 * Whether a transfer command (scp/rsync/sftp, or `curl -T`/`--upload-file`)
 * pushes a local key, credential, or secret file to a remote host.
 *
 * Deliberately narrow: it only fires when an upload form is present AND the
 * command names a sensitive artifact (SSH keys, cloud CLI credentials, dotenv,
 * tokens, passwords, vault data, private keys).
 */
export function uploadsSensitive(cmd: string): boolean {
  const uploadForm =
    /\bscp\b/.test(cmd) ||
    /\brsync(?:\s|$)/.test(cmd) ||
    /\bsftp\b/.test(cmd) ||
    /\bcurl\b[^\n|;]*(?:-T\b|--upload-file\b)/.test(cmd);
  if (!uploadForm) return false;
  return SENSITIVE_TRANSFER_PATTERN.test(cmd);
}

const SENSITIVE_TRANSFER_PATTERN = new RegExp(
  [
    "\\.(?:ssh[\\\\/]|aws(?:[\\\\/]|$)|kube(?:[\\\\/]|$)|netrc\\b|pgpass\\b|npmrc\\b|pypirc\\b|gitconfig\\b|env\\b)",
    "\\.(?:pem|key|kubeconfig)\\b",
    "\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b",
    "\\b(?:credentials|dockercfg|service-account|service_account|secret|token|password|vault)\\b",
  ].join("|"),
  "i",
);