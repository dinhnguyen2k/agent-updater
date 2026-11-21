import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonSafe, redactSecrets } from "./security.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(HERE, "..");
export const STATE_DIR = join(APP_ROOT, "state");
export const BACKUPS_DIR = join(APP_ROOT, "backups");
export const PENDING_DIR = join(APP_ROOT, "pending");
export const WORKSPACES_DIR = join(APP_ROOT, "workspaces");
export const LOGS_DIR = join(APP_ROOT, "logs");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const LOCK_FILE = join(STATE_DIR, "run.lock");
export const MAIN_LOG_FILE = join(LOGS_DIR, "updater.log");
export const LOCAL_CONFIG_FILE = join(APP_ROOT, "config.local.json");
export const DEFAULT_CONFIG_FILE = join(APP_ROOT, "config.default.json");

const SYSTEM_WIN_DIRS = new Set(["All Users", "Default", "Default User", "Public", "desktop.ini"]);

export function ensureAppDirs() {
  for (const dir of [STATE_DIR, BACKUPS_DIR, PENDING_DIR, WORKSPACES_DIR, LOGS_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function detectWindowsUserDir() {
  const mntUsers = "/mnt/c/Users";
  if (!existsSync(mntUsers)) return null;
  try {
    const candidates = readdirSync(mntUsers, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SYSTEM_WIN_DIRS.has(d.name) && !d.name.startsWith("."))
      .map((d) => join(mntUsers, d.name));
    return candidates[0] || null;
  } catch {
    return null;
  }
}

export function loadConfig() {
  const defaults = readJsonSafe(DEFAULT_CONFIG_FILE, {});
  const overrides = readJsonSafe(LOCAL_CONFIG_FILE, {});
  const merged = { ...defaults, ...overrides };

  if (process.env.AGENT_UPDATER_TARGET_REPO) {
    merged.targetRepo = resolve(process.env.AGENT_UPDATER_TARGET_REPO);
  } else if (!merged.targetRepo && existsSync(join(process.cwd(), ".agent", "scripts", "validate-agent-system.mjs"))) {
    merged.targetRepo = process.cwd();
  }

  if (merged.windowsUserDir === "auto") {
    merged.windowsUserDir = detectWindowsUserDir();
  }

  return merged;
}

export function saveLocalConfig(partial) {
  const current = readJsonSafe(LOCAL_CONFIG_FILE, {});
  const next = { ...current, ...partial };
  atomicWriteJson(LOCAL_CONFIG_FILE, next, 0o600);
  return next;
}

export function assertTargetRepoConfigured(config) {
  if (!config.targetRepo) {
    throw new Error(
      "Chưa cấu hình đường dẫn dự án mục tiêu. Hãy chạy: agent-updater init --target /duong/dan/du-an"
    );
  }
  const validator = join(resolve(config.targetRepo), ".agent", "scripts", "validate-agent-system.mjs");
  if (!existsSync(validator)) {
    throw new Error(
      `Thư mục mục tiêu '${config.targetRepo}' chưa có '.agent/scripts/validate-agent-system.mjs'. Hãy kiểm tra lại đường dẫn.`
    );
  }
  return resolve(config.targetRepo);
}

export function loadState() {
  ensureAppDirs();
  const base = {
    initialized: false,
    lastCheckAt: null,
    lastResearchAt: null,
    lastAutoApplyAt: null,
    lastGitHead: null,
    lastErrorsMdHash: null,
    lastErrorsMdSize: 0,
    lastFrictionLines: 0,
    lastGuardLines: 0,
    lastToolVersions: {},
    lastStackHash: null,
    history: [],
  };
  const loaded = readJsonSafe(STATE_FILE, null);
  return loaded ? { ...base, ...loaded, history: Array.isArray(loaded.history) ? loaded.history : [] } : base;
}

export function saveState(state) {
  ensureAppDirs();
  const trimmed = {
    ...state,
    history: (state.history || []).slice(-30),
  };
  atomicWriteJson(STATE_FILE, trimmed, 0o600);
}

export function appendLog(level, message, details = null) {
  ensureAppDirs();
  const suffix = details ? ` | ${redactSecrets(typeof details === "string" ? details : JSON.stringify(details))}` : "";
  const line = `${new Date().toISOString()} [${level}] ${redactSecrets(message)}${suffix}\n`;
  try {
    appendFileSync(MAIN_LOG_FILE, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* ignore logging error */
  }
}

export function countPendingItems() {
  if (!existsSync(PENDING_DIR)) return [];
  const items = [];
  for (const entry of readdirSync(PENDING_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PENDING_DIR, entry.name, "manifest.json");
    const manifest = readJsonSafe(manifestPath, null);
    if (manifest && manifest.status === "pending") {
      items.push(manifest);
    }
  }
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return items;
}

export function syncStatusIndicator(config, overrides = {}) {
  const pending = countPendingItems();
  const state = loadState();
  const lastRun = state.history.at(-1) || null;
  const payload = {
    updated_at: new Date().toISOString(),
    state: overrides.state || "idle",
    pending_count: pending.length,
    latest_pending_id: pending[0]?.id || null,
    latest_pending_title: pending[0]?.title || null,
    last_check_at: state.lastCheckAt,
    last_auto_apply_at: state.lastAutoApplyAt,
    last_result: overrides.lastResult || lastRun?.outcome || "none",
    message: overrides.message || (pending.length > 0 ? `Có ${pending.length} gói nâng cấp chờ duyệt` : "Hệ thống agent ổn định"),
  };

  const fileName = config.statusFileName || ".agent_updater_status.json";
  const linuxTarget = join(homedir(), fileName);
  try {
    atomicWriteJson(linuxTarget, payload, 0o644);
  } catch {
    /* ignore */
  }

  if (config.windowsUserDir && existsSync(config.windowsUserDir)) {
    try {
      const winTarget = join(config.windowsUserDir, fileName);
      atomicWriteJson(winTarget, payload, 0o644);
    } catch {
      /* ignore */
    }
  }
  return payload;
}

export function readRecentLogs(lineCount = 40) {
  if (!existsSync(MAIN_LOG_FILE)) return [];
  const lines = readFileSync(MAIN_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, Number(lineCount) || 40));
}
