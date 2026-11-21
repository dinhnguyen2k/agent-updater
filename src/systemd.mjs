import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, resolveTrustedBinary, resolveWithin, runSafeCommand } from "./security.mjs";
import { APP_ROOT } from "./state.mjs";

const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const LOCAL_BIN_DIR = join(homedir(), ".local", "bin");

export function installCliAndSystemd(config) {
  const binSrc = join(APP_ROOT, "bin", "agent-updater");
  chmodSync(binSrc, 0o755);

  mkdirSync(LOCAL_BIN_DIR, { recursive: true });
  const binLink = join(LOCAL_BIN_DIR, "agent-updater");
  if (existsSync(binLink) || (() => { try { return Boolean(lstatSync(binLink)); } catch { return false; } })()) {
    try {
      if (!lstatSync(binLink).isSymbolicLink() || readlinkSync(binLink) !== binSrc) {
        rmSync(binLink, { force: true });
        symlinkSync(binSrc, binLink);
      }
    } catch {
      rmSync(binLink, { force: true });
      symlinkSync(binSrc, binLink);
    }
  } else {
    symlinkSync(binSrc, binLink);
  }

  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  const nodeBin = resolveTrustedBinary("node") || process.execPath;
  const cliEntry = join(APP_ROOT, "src", "cli.mjs");
  const calendar = config.scheduleCalendar || "*-*-* 20:00:00";
  const targetRepo = config.targetRepo;

  // Đảm bảo tệp theo dõi tồn tại sẵn để systemd PathChanged hoạt động mượt ngay từ đầu
  const frictionFile = resolveWithin(targetRepo, ".agent/reports/agent-friction.jsonl");
  const guardFile = resolveWithin(targetRepo, ".agent/reports/boundary-guard.log");
  const errorsFile = resolveWithin(targetRepo, ".planning/errors/ERRORS.md");
  for (const f of [frictionFile, guardFile]) {
    if (!existsSync(f)) atomicWriteText(f, "", 0o600);
  }

  const envPath = `${LOCAL_BIN_DIR}:${join(homedir(), ".local", "share", "pnpm")}:/usr/local/bin:/usr/bin:/bin`;

  const mainService = `[Unit]
Description=AI Agent Auto-Research & Safe Updater (Scheduled)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${APP_ROOT}
Environment="PATH=${envPath}"
Environment="NODE_OPTIONS=--dns-result-order=ipv4first"
Nice=10
ExecStart=${nodeBin} ${cliEntry} run --trigger=timer
`;

  const mainTimer = `[Unit]
Description=Daily Timer for AI Agent Auto-Updater

[Timer]
OnCalendar=${calendar}
Persistent=true
RandomizedDelaySec=5m
Unit=agent-updater.service

[Install]
WantedBy=timers.target
`;

  const watchService = `[Unit]
Description=AI Agent Auto-Updater Early Friction Trigger

[Service]
Type=oneshot
WorkingDirectory=${APP_ROOT}
Environment="PATH=${envPath}"
Environment="NODE_OPTIONS=--dns-result-order=ipv4first"
Nice=10
ExecStart=${nodeBin} ${cliEntry} run --trigger=watcher
`;

  const watchPathLines = [
    "[Unit]",
    "Description=Watch Agent Friction & Error Logs for Early Auto-Upgrade",
    "",
    "[Path]",
    `PathChanged=${frictionFile}`,
    `PathChanged=${guardFile}`,
    ...(existsSync(errorsFile) ? [`PathChanged=${errorsFile}`] : []),
    "Unit=agent-updater-watch.service",
    "",
    "[Install]",
    "WantedBy=paths.target",
    "WantedBy=default.target",
    "",
  ].join("\n");

  atomicWriteText(join(SYSTEMD_USER_DIR, "agent-updater.service"), mainService, 0o644);
  atomicWriteText(join(SYSTEMD_USER_DIR, "agent-updater.timer"), mainTimer, 0o644);
  atomicWriteText(join(SYSTEMD_USER_DIR, "agent-updater-watch.service"), watchService, 0o644);
  atomicWriteText(join(SYSTEMD_USER_DIR, "agent-updater-watch.path"), watchPathLines, 0o644);

  const reload = runSafeCommand("systemctl", ["--user", "daemon-reload"], { timeoutMs: 10_000 });
  const enableTimer = runSafeCommand("systemctl", ["--user", "enable", "--now", "agent-updater.timer"], {
    timeoutMs: 10_000,
  });
  const enablePath = runSafeCommand("systemctl", ["--user", "enable", "--now", "agent-updater-watch.path"], {
    timeoutMs: 10_000,
  });
  runSafeCommand("systemctl", ["--user", "restart", "agent-updater-watch.path"], { timeoutMs: 10_000 });
  runSafeCommand("systemctl", ["--user", "restart", "agent-updater.timer"], { timeoutMs: 10_000 });

  return {
    binLink,
    systemdOk: reload.ok && enableTimer.ok && enablePath.ok,
    details: [reload.stderr, enableTimer.stderr, enablePath.stderr].filter(Boolean).join(" | "),
  };
}

export function uninstallSystemd() {
  runSafeCommand("systemctl", ["--user", "disable", "--now", "agent-updater.timer", "agent-updater-watch.path"], {
    timeoutMs: 10_000,
  });
  for (const unit of [
    "agent-updater.service",
    "agent-updater.timer",
    "agent-updater-watch.service",
    "agent-updater-watch.path",
  ]) {
    rmSync(join(SYSTEMD_USER_DIR, unit), { force: true });
  }
  runSafeCommand("systemctl", ["--user", "daemon-reload"], { timeoutMs: 10_000 });
}

export function setupZshPromptIfNeeded() {
  const zshrc = join(homedir(), ".zshrc");
  if (!existsSync(zshrc)) return false;
  try {
    const content = readFileSync(zshrc, "utf8");
    if (content.includes(".agent_updater_status.json")) return false;
    const snippet = `
# Nhắc gọn 1 dòng nếu có gói nâng cấp Agent nhạy cảm đang chờ duyệt
if [[ -o interactive && -f "$HOME/.agent_updater_status.json" ]]; then
  __ag_pending=$(grep -o '"pending_count":[[:space:]]*[0-9]*' "$HOME/.agent_updater_status.json" 2>/dev/null | grep -o '[0-9]*' || echo 0)
  if [[ -n "$__ag_pending" && "$__ag_pending" -gt 0 ]]; then
    printf '\\033[1;33m⚡ [agent-updater] Có %s gói nâng cấp luật gốc đang chờ duyệt -> gõ: agent-updater review\\033[0m\\n' "$__ag_pending"
  fi
  unset __ag_pending
fi
`;
    appendFileSync(zshrc, snippet, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function querySystemdStatus() {
  const timerActive = runSafeCommand("systemctl", ["--user", "is-active", "agent-updater.timer"], { timeoutMs: 5000 });
  const pathActive = runSafeCommand("systemctl", ["--user", "is-active", "agent-updater-watch.path"], { timeoutMs: 5000 });
  const nextRunRes = runSafeCommand(
    "systemctl",
    ["--user", "show", "agent-updater.timer", "--property=NextElapseUSecRealtime", "--value"],
    { timeoutMs: 5000 }
  );
  return {
    timerActive: timerActive.stdout.trim() || "inactive",
    watcherActive: pathActive.stdout.trim() || "inactive",
    nextRun: nextRunRes.stdout.trim() || "chưa rõ",
  };
}
