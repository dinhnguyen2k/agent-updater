import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,80}$/;

const TRUSTED_BIN_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".local", "share", "pnpm"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

const ALLOWED_COMMANDS = new Set([
  "node",
  "bash",
  "python3",
  "git",
  "diff",
  "agy",
  "omp",
  "claude",
  "codex",
  "systemctl",
]);

const SECRET_PATTERNS = [
  /\b(postgres(?:ql)?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
  /\b(password\s*=\s*)[^\s;"']+/gi,
  /\b(PGPASSWORD\s*=\s*)[^\s;&|]+/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{16,})\b/g,
];

export function assertSafeId(value, label = "id") {
  const text = String(value ?? "").trim();
  if (!SAFE_ID_RE.test(text) || text === "." || text === "..") {
    throw new Error(`Giá trị ${label} không hợp lệ: '${text}'`);
  }
  return text;
}

export function resolveWithin(baseDir, subPath) {
  const root = resolve(baseDir);
  const raw = String(subPath ?? "");
  if (!raw || raw.includes("\0")) {
    throw new Error("Đường dẫn con rỗng hoặc chứa ký tự không hợp lệ.");
  }
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Từ chối truy cập đường dẫn vượt ngoài phạm vi cho phép: '${raw}'`);
  }
  return candidate;
}

export function toRelPosix(baseDir, targetPath) {
  const root = resolve(baseDir);
  const abs = resolveWithin(root, targetPath);
  return relative(root, abs).split(sep).join("/");
}

export function redactSecrets(input) {
  let text = String(input ?? "");
  text = text.replace(SECRET_PATTERNS[0], "$1[REDACTED]$2");
  text = text.replace(SECRET_PATTERNS[1], "$1[REDACTED]");
  text = text.replace(SECRET_PATTERNS[2], "$1[REDACTED]");
  text = text.replace(SECRET_PATTERNS[3], "$1[REDACTED]");
  for (let i = 4; i < SECRET_PATTERNS.length; i += 1) {
    text = text.replace(SECRET_PATTERNS[i], "[REDACTED]");
  }
  return text;
}

export function resolveTrustedBinary(commandName) {
  if (!ALLOWED_COMMANDS.has(commandName)) {
    throw new Error(`Lệnh thực thi không nằm trong danh sách cho phép: '${commandName}'`);
  }
  if (commandName === "node" && isAbsolute(process.execPath) && existsSync(process.execPath)) {
    return process.execPath;
  }
  for (const dir of TRUSTED_BIN_DIRS) {
    const full = join(dir, commandName);
    if (existsSync(full)) return full;
  }
  return null;
}

export function runSafeCommand(commandName, args = [], options = {}) {
  const binPath = resolveTrustedBinary(commandName);
  if (!binPath) {
    return {
      ok: false,
      status: 127,
      stdout: "",
      stderr: `Không tìm thấy công cụ '${commandName}' trong các thư mục tin cậy.`,
      missingBinary: true,
    };
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new Error(`Danh sách tham số của '${commandName}' phải là mảng chuỗi.`);
  }

  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const timeout = options.timeoutMs ?? 60_000;
  const env = {
    ...process.env,
    PATH: [...TRUSTED_BIN_DIRS, process.env.PATH || ""].filter(Boolean).join(":"),
    ...(options.env || {}),
  };

  const res = spawnSync(binPath, args, {
    cwd,
    env,
    shell: false,
    encoding: "utf8",
    timeout,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    input: options.input,
  });

  const timedOut = res.error?.code === "ETIMEDOUT";
  const status = typeof res.status === "number" ? res.status : timedOut ? 124 : 1;
  return {
    ok: status === 0 && !res.error,
    status,
    timedOut,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? res.error.message : ""),
  };
}

export function atomicWriteText(filePath, content, mode = 0o600) {
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  renameSync(tmp, target);
}

export function atomicWriteJson(filePath, data, mode = 0o600) {
  atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`, mode);
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireRunLock(lockPath) {
  const resolvedLock = resolve(lockPath);
  mkdirSync(dirname(resolvedLock), { recursive: true, mode: 0o700 });

  const tryCreate = () => {
    const fd = openSync(resolvedLock, "wx", 0o600);
    const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    writeSync(fd, payload);
    closeSync(fd);
  };

  try {
    tryCreate();
    return () => releaseRunLock(resolvedLock);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    const existing = readJsonSafe(resolvedLock, {});
    const startedMs = Date.parse(existing?.startedAt || "");
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
    if (!isPidAlive(existing?.pid) || ageMs > 45 * 60 * 1000) {
      rmSync(resolvedLock, { force: true });
      tryCreate();
      return () => releaseRunLock(resolvedLock);
    }
    return null;
  }
}

export function releaseRunLock(lockPath) {
  try {
    const resolvedLock = resolve(lockPath);
    if (!existsSync(resolvedLock)) return;
    const existing = readJsonSafe(resolvedLock, {});
    if (!existing?.pid || existing.pid === process.pid) {
      unlinkSync(resolvedLock);
    }
  } catch {
    /* ignore */
  }
}

export function globToRegExp(globPattern) {
  let out = "";
  const norm = String(globPattern).replace(/\\/g, "/");
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (norm[i + 1] === "/") {
          out = `${out.slice(0, -2)}(?:.+/)?`;
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(relPosixPath, globs = []) {
  return globs.some((pattern) => globToRegExp(pattern).test(relPosixPath));
}
