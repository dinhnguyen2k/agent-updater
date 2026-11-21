#!/usr/bin/env node
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { acquireRunLock } from "./security.mjs";
import {
  appendLog,
  assertTargetRepoConfigured,
  bootstrapAppHomeIfNeeded,
  countPendingItems,
  loadConfig,
  loadState,
  LOCK_FILE,
  readRecentLogs,
  saveLocalConfig,
  saveState,
  syncStatusIndicator,
} from "./state.mjs";
import { collectSignals, evaluateTriggerGate } from "./collector.mjs";
import {
  computeWorkspaceDiff,
  createStagingWorkspace,
  loadProtectedGlobs,
  partitionChangesSafely,
  removeStagingWorkspace,
  validateWorkspace,
} from "./staging.mjs";
import { runAiResearchSession } from "./ai-runner.mjs";
import {
  applyChangesAtomically,
  approvePendingPackage,
  getPendingDetails,
  listBackups,
  rejectPendingPackage,
  rollbackToBackup,
  stagePendingApproval,
} from "./applier.mjs";
import { installCliAndSystemd, querySystemdStatus, setupZshPromptIfNeeded, uninstallSystemd } from "./systemd.mjs";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function colorDiff(patchText) {
  return patchText
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return `${C.bold}${line}${C.reset}`;
      if (line.startsWith("@@")) return `${C.cyan}${line}${C.reset}`;
      if (line.startsWith("+")) return `${C.green}${line}${C.reset}`;
      if (line.startsWith("-")) return `${C.red}${line}${C.reset}`;
      return line;
    })
    .join("\n");
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg === "-n") {
      flags.nextIsLines = true;
    } else if (flags.nextIsLines) {
      flags.lines = Number(arg) || 40;
      delete flags.nextIsLines;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function advanceWatermarks(state, signals) {
  state.initialized = true;
  state.lastCheckAt = signals.collectedAt;
  if (signals.watermarks.gitHead) state.lastGitHead = signals.watermarks.gitHead;
  if (signals.watermarks.errorsMdHash) {
    state.lastErrorsMdHash = signals.watermarks.errorsMdHash;
    state.lastErrorsMdSize = signals.watermarks.errorsMdSize;
  }
  state.lastFrictionLines = signals.watermarks.frictionLines;
  state.lastGuardLines = signals.watermarks.guardLines;
  state.lastToolVersions = signals.watermarks.toolVersions;
  state.lastStackHash = signals.watermarks.stackHash;
}

function cmdStatus(config) {
  const state = loadState();
  const pending = countPendingItems();
  const backups = listBackups();
  const sys = querySystemdStatus();

  console.log(`${C.bold}${C.cyan}=== Trạng thái Agent Auto-Updater ===${C.reset}`);
  console.log(`Kho mục tiêu         : ${config.targetRepo || "(chưa cấu hình - chạy: agent-updater init --target <đường-dẫn>)"}`);
  console.log(
    `Hẹn giờ định kỳ      : ${sys.timerActive === "active" ? `${C.green}đang bật${C.reset}` : `${C.yellow}${sys.timerActive}${C.reset}`} (lần kế: ${sys.nextRun})`
  );
  console.log(
    `Canh ngưỡng lỗi sớm  : ${sys.watcherActive === "active" ? `${C.green}đang bật${C.reset}` : `${C.yellow}${sys.watcherActive}${C.reset}`} (ngưỡng >= ${config.frictionThreshold} lỗi mới)`
  );
  console.log(`Lần kiểm tra gần nhất: ${state.lastCheckAt || "chưa chạy"}`);
  console.log(`Lần tự nâng cấp gần  : ${state.lastAutoApplyAt || "chưa có"}`);
  console.log(`Số bản sao lưu sẵn   : ${backups.length} (mới nhất: ${backups[0]?.id || "chưa có"})`);

  if (pending.length > 0) {
    console.log(`\n${C.bold}${C.yellow}⚡ Có ${pending.length} gói chạm tệp luật gốc/bảo vệ đang chờ bạn duyệt:${C.reset}`);
    for (const item of pending) {
      console.log(`  - ${C.bold}${item.id}${C.reset} (${item.createdAt}): ${item.title}`);
      console.log(`    Tệp chạm: ${item.changes.map((c) => `${c.path} [${c.kind}]`).join(", ")}`);
    }
    console.log(`\n  Xem chi tiết: ${C.cyan}agent-updater review${C.reset}`);
    console.log(`  Áp dụng ngay: ${C.green}agent-updater approve${C.reset}`);
  } else {
    console.log(`\n${C.green}✔ Không có gói nào tồn đọng chờ duyệt.${C.reset}`);
  }

  const recent = state.history.slice(-5).reverse();
  if (recent.length > 0) {
    console.log(`\n${C.bold}Lịch sử các đợt chạy gần đây:${C.reset}`);
    for (const h of recent) {
      console.log(`  - [${h.at}] (${h.trigger}) ${h.outcome}: ${h.note}`);
    }
  }
}

function cmdCheck(config) {
  assertTargetRepoConfigured(config);
  const state = loadState();
  const signals = collectSignals(config, state, { force: false });
  const gate = evaluateTriggerGate(signals, config, state, { trigger: "manual" });

  console.log(`${C.bold}${C.cyan}=== Kiểm tra tín hiệu (0 tốn hạn mức AI) ===${C.reset}`);
  console.log(`Công cụ AI hiện tại : ${JSON.stringify(signals.external.tools.current)}`);
  console.log(`Ma sát mới          : +${signals.internal.frictionDelta} dòng friction, +${signals.internal.guardDelta} lượt chặn guard`);
  console.log(`ERRORS.md thay đổi  : ${signals.internal.errorsMdChanged ? "Có" : "Không"}`);
  console.log(
    `Kiểm tra tĩnh .agent: ${signals.internal.validationOk ? `${C.green}Sạch 0 lỗi${C.reset}` : `${C.red}${signals.internal.validationErrors.length} lỗi${C.reset}`} (${signals.internal.validationWarnings.length} cảnh báo)`
  );
  console.log(`Git commit mới      : ${signals.internal.git.commits.length} commit (${signals.internal.git.exemplarTouches.length} chạm tệp mẫu chuẩn)`);
  console.log(`\nKết luận kích hoạt  : ${gate.shouldRun ? `${C.yellow}CẦN CHẠY NGHIÊN CỨU AI${C.reset}` : `${C.green}KHÔNG CẦN GỌI AI${C.reset}`}`);
  console.log(`Lý do               : ${gate.reason}`);
}

function cmdRun(config, flags) {
  assertTargetRepoConfigured(config);
  const release = acquireRunLock(LOCK_FILE);
  if (!release) {
    console.log(`${C.yellow}Đang có một tiến trình agent-updater khác chạy nền, bỏ qua lượt gọi trùng.${C.reset}`);
    return;
  }

  const trigger = String(flags.trigger || "manual");
  const force = Boolean(flags.force);
  const dryRun = Boolean(flags["dry-run"]);

  try {
    const state = loadState();
    const signals = collectSignals(config, state, { force });
    const gate = evaluateTriggerGate(signals, config, state, { trigger, force });

    if (!gate.shouldRun) {
      state.lastCheckAt = signals.collectedAt;
      if (gate.initBaselineOnly) {
        advanceWatermarks(state, signals);
        state.history.push({ at: signals.collectedAt, trigger, outcome: "init-baseline", note: gate.reason });
        appendLog("INFO", gate.reason);
      } else if (trigger !== "watcher") {
        // Cập nhật mốc Git/check nhẹ khi không có thay đổi hành động
        if (signals.watermarks.gitHead) state.lastGitHead = signals.watermarks.gitHead;
        state.history.push({ at: signals.collectedAt, trigger, outcome: "no-signal", note: gate.reason });
        appendLog("INFO", `Bỏ qua gọi AI (${trigger}): ${gate.reason}`);
      }
      saveState(state);
      syncStatusIndicator(config, { state: "idle" });
      if (trigger === "manual") {
        console.log(`${C.green}✔ ${gate.reason}${C.reset}`);
      }
      return;
    }

    console.log(`${C.cyan}▶ Phát hiện tín hiệu cần nghiên cứu (${trigger}): ${gate.reason}${C.reset}`);
    syncStatusIndicator(config, { state: "running", message: "Agent đang nghiên cứu nâng cấp..." });

    const aiRes = runAiResearchSession(
      signals,
      (label) => createStagingWorkspace(config.targetRepo, label),
      removeStagingWorkspace,
      config
    );
    const stagingDir = aiRes.stagingDir;
    try {
      if (!aiRes.ok || !stagingDir) {
        state.lastCheckAt = signals.collectedAt;
        state.history.push({ at: new Date().toISOString(), trigger, outcome: "ai-failed", note: aiRes.error.slice(0, 180) });
        saveState(state);
        syncStatusIndicator(config, { state: "idle", lastResult: "ai-failed" });
        console.error(`${C.red}✖ Phiên nghiên cứu AI không thành công: ${aiRes.error}${C.reset}`);
        process.exitCode = 1;
        return;
      }

      const stagingCheck = validateWorkspace(stagingDir);
      if (!stagingCheck.ok) {
        appendLog("ERROR", "Bản sửa do AI đề xuất không vượt qua kiểm tra hệ thống, đã hủy bỏ an toàn.", stagingCheck.output);
        state.lastCheckAt = signals.collectedAt;
        state.lastResearchAt = new Date().toISOString();
        state.history.push({
          at: state.lastResearchAt,
          trigger,
          outcome: "rejected-by-validator",
          note: `Bản nháp vi phạm ${stagingCheck.step}, giữ nguyên hệ thống gốc`,
        });
        saveState(state);
        syncStatusIndicator(config, { state: "idle", lastResult: "rejected-by-validator" });
        console.error(`${C.red}✖ Đã chặn bản nháp AI vì không qua bước kiểm tra '${stagingCheck.step}':\n${stagingCheck.output}${C.reset}`);
        process.exitCode = 1;
        return;
      }

      const protectedGlobs = loadProtectedGlobs(config.targetRepo, config);
      const allChanges = computeWorkspaceDiff(config.targetRepo, stagingDir, protectedGlobs);

      if (allChanges.length === 0) {
        advanceWatermarks(state, signals);
        state.lastResearchAt = new Date().toISOString();
        const note = aiRes.summary?.no_change_reason || "Đã rà soát xong, cấu hình hiện tại đã khớp chuẩn.";
        state.history.push({ at: state.lastResearchAt, trigger, outcome: "verified-clean", note });
        saveState(state);
        syncStatusIndicator(config, { state: "idle", lastResult: "verified-clean" });
        console.log(`${C.green}✔ Nghiên cứu hoàn tất (${aiRes.runner}): ${note}${C.reset}`);
        return;
      }

      if (dryRun) {
        const staged = stagePendingApproval(allChanges, { ...aiRes.summary, title: `[Dry-Run] ${aiRes.summary?.title || "Bản nháp thử nghiệm"}` }, signals);
        syncStatusIndicator(config, { state: "idle", lastResult: "staged-dry-run" });
        console.log(`${C.yellow}⚡ Chế độ --dry-run: Đã lưu toàn bộ ${allChanges.length} tệp vào gói chờ duyệt '${staged.id}'.${C.reset}`);
        return;
      }

      const { autoGreen, stagedRed, coupledGreenIntoRed } = partitionChangesSafely(config.targetRepo, allChanges);
      const outcomeParts = [];

      if (autoGreen.length > 0) {
        const applyRes = applyChangesAtomically(config.targetRepo, autoGreen, {
          title: aiRes.summary?.title || "Tự động nâng cấp vùng an toàn",
          reason: `Tự động áp dụng vùng xanh (${trigger})`,
          maxBackups: config.maxBackups,
        });
        if (!applyRes.ok) {
          state.lastCheckAt = signals.collectedAt;
          state.lastResearchAt = new Date().toISOString();
          state.history.push({ at: state.lastResearchAt, trigger, outcome: "rollback-safe", note: applyRes.error.slice(0, 180) });
          saveState(state);
          syncStatusIndicator(config, { state: "idle", lastResult: "rollback-safe" });
          console.error(`${C.red}✖ Lỗi khi áp dụng vùng xanh (đã khôi phục nguyên trạng): ${applyRes.error}${C.reset}`);
          process.exitCode = 1;
          return;
        }
        state.lastAutoApplyAt = new Date().toISOString();
        outcomeParts.push(`tự áp dụng ${autoGreen.length} tệp an toàn (sao lưu ${applyRes.backupId})`);
        console.log(`${C.green}✔ Đã tự động áp dụng ${autoGreen.length} tệp an toàn (bản sao lưu: ${applyRes.backupId}).${C.reset}`);
      }

      if (stagedRed.length > 0) {
        const pkg = stagePendingApproval(stagedRed, aiRes.summary, signals);
        const extra = coupledGreenIntoRed ? " (gộp chung tệp phụ thuộc)" : "";
        outcomeParts.push(`đóng gói chờ duyệt ${stagedRed.length} tệp nhạy cảm vào ${pkg.id}${extra}`);
        console.log(`${C.yellow}⚡ Có ${stagedRed.length} tệp chạm luật gốc/bảo vệ đã lưu vào gói '${pkg.id}'. Gõ 'agent-updater review' hoặc 'agent-updater approve' để duyệt.${C.reset}`);
      }

      advanceWatermarks(state, signals);
      state.lastResearchAt = new Date().toISOString();
      state.history.push({
        at: state.lastResearchAt,
        trigger,
        outcome: stagedRed.length > 0 ? "partial-staged" : "auto-applied",
        note: `${aiRes.summary?.title || "Nâng cấp"}: ${outcomeParts.join("; ")}`,
      });
      saveState(state);
      syncStatusIndicator(config, {
        state: "idle",
        lastResult: stagedRed.length > 0 ? "pending-approval" : "auto-applied",
      });
    } finally {
      if (stagingDir) removeStagingWorkspace(stagingDir);
    }
  } finally {
    release();
  }
}

function cmdReview(flags) {
  const pending = countPendingItems();
  if (pending.length === 0 && !flags._[1]) {
    console.log(`${C.green}Hiện không có gói nâng cấp nào đang chờ duyệt.${C.reset}`);
    return;
  }
  const targetId = flags._[1] || pending[0].id;
  const { manifest, patch } = getPendingDetails(targetId);

  console.log(`${C.bold}${C.yellow}=== Gói nâng cấp chờ duyệt: ${manifest.id} ===${C.reset}`);
  console.log(`Tiêu đề   : ${C.bold}${manifest.title}${C.reset}`);
  console.log(`Tạo lúc   : ${manifest.createdAt}`);
  console.log(`Trạng thái: ${manifest.status}`);
  if (manifest.triggerReasons?.length) {
    console.log(`Lý do quét: ${manifest.triggerReasons.join("; ")}`);
  }
  if (manifest.highlights?.length) {
    console.log(`\n${C.bold}Tóm tắt điểm thay đổi:${C.reset}`);
    for (const h of manifest.highlights) console.log(`  • ${h}`);
  }
  if (manifest.sources?.length) {
    console.log(`\n${C.bold}Nguồn đối chiếu:${C.reset} ${manifest.sources.join(", ")}`);
  }
  console.log(`\n${C.bold}Danh sách tệp (${manifest.changes.length}):${C.reset}`);
  for (const c of manifest.changes) {
    console.log(`  - [${c.zone.toUpperCase()}] ${c.kind}: ${c.path}`);
  }
  console.log(`\n${C.bold}Chi tiết thay đổi (Diff):${C.reset}\n${colorDiff(patch)}`);
  if (manifest.status === "pending") {
    console.log(`\n👉 Để áp dụng ngay: ${C.green}agent-updater approve ${manifest.id}${C.reset}`);
    console.log(`👉 Để bỏ qua gói  : ${C.red}agent-updater reject ${manifest.id}${C.reset}`);
  }
}

function cmdApprove(config, flags) {
  assertTargetRepoConfigured(config);
  const pending = countPendingItems();
  if (pending.length === 0 && !flags._[1]) {
    console.log(`${C.green}Không có gói nào đang chờ duyệt.${C.reset}`);
    return;
  }
  const targets = flags.all ? pending.map((p) => p.id) : [flags._[1] || pending[0].id];
  for (const id of targets) {
    const res = approvePendingPackage(config.targetRepo, id, config.maxBackups);
    if (!res.ok) {
      console.error(`${C.red}✖ Không thể áp dụng gói '${id}': ${res.error}${C.reset}`);
      process.exitCode = 1;
      break;
    }
    const state = loadState();
    state.lastAutoApplyAt = new Date().toISOString();
    state.history.push({
      at: state.lastAutoApplyAt,
      trigger: "approve",
      outcome: "approved",
      note: `Đã duyệt gói ${id} (sao lưu ${res.backupId})`,
    });
    saveState(state);
    console.log(`${C.green}✔ Đã duyệt và đồng bộ thành công gói '${id}' (bản sao lưu hoàn tác: ${res.backupId}).${C.reset}`);
  }
  syncStatusIndicator(config, { state: "idle" });
}

function cmdReject(config, flags) {
  const pending = countPendingItems();
  if (pending.length === 0 && !flags._[1]) {
    console.log(`${C.green}Không có gói nào đang chờ duyệt.${C.reset}`);
    return;
  }
  const targets = flags.all ? pending.map((p) => p.id) : [flags._[1] || pending[0].id];
  for (const id of targets) {
    rejectPendingPackage(id);
    console.log(`${C.yellow}Đã từ chối và ẩn gói '${id}'.${C.reset}`);
  }
  syncStatusIndicator(config, { state: "idle" });
}

function cmdBackups() {
  const list = listBackups();
  if (list.length === 0) {
    console.log("Chưa có bản sao lưu nào.");
    return;
  }
  console.log(`${C.bold}${C.cyan}=== Danh sách bản sao lưu (${list.length}) ===${C.reset}`);
  for (const b of list) {
    console.log(`  - ${C.bold}${b.id}${C.reset} (${b.createdAt}) - ${b.title} [${b.entries?.length || 0} tệp]`);
  }
  console.log(`\nHoàn tác bằng lệnh: ${C.cyan}agent-updater rollback <mã-sao-lưu>${C.reset}`);
}

function cmdRollback(config, flags) {
  const targetId = flags._[1] || null;
  const restored = rollbackToBackup(targetId);
  const state = loadState();
  state.history.push({
    at: new Date().toISOString(),
    trigger: "rollback",
    outcome: "rolled-back",
    note: `Khôi phục về ${restored.id}`,
  });
  saveState(state);
  syncStatusIndicator(config, { state: "idle", lastResult: "rolled-back" });
  console.log(`${C.green}✔ Đã khôi phục nguyên trạng hệ thống agent về '${restored.id}' và đồng bộ lại toàn bộ liên kết.${C.reset}`);
}

function cmdInit(flags) {
  const rawTarget =
    typeof flags.target === "string"
      ? flags.target
      : flags._[1] ||
        (existsSync(resolve(process.cwd(), ".agent", "scripts", "validate-agent-system.mjs"))
          ? process.cwd()
          : null);
  if (!rawTarget) {
    throw new Error(
      "Thiếu đường dẫn dự án. Hãy chỉ định --target hoặc chạy lệnh ngay trong thư mục dự án có .agent/. Ví dụ: agent-updater init --target ~/my-project"
    );
  }
  const absTarget = resolve(rawTarget);
  assertTargetRepoConfigured({ targetRepo: absTarget });
  bootstrapAppHomeIfNeeded();
  saveLocalConfig({ targetRepo: absTarget });
  const freshConfig = loadConfig();
  const res = installCliAndSystemd(freshConfig);
  const zshAdded = setupZshPromptIfNeeded();
  syncStatusIndicator(freshConfig, { state: "idle" });
  console.log(`${C.green}✔ Đã cấu hình kho mục tiêu '${absTarget}', cài đặt lệnh '${res.binLink}' và bật bộ hẹn giờ chạy ngầm systemd.${C.reset}`);
  if (zshAdded) {
    console.log(`${C.cyan}✔ Đã bổ sung dòng nhắc thông báo tự động vào ~/.zshrc.${C.reset}`);
  }
}

function printHelp() {
  console.log(`${C.bold}${C.cyan}agent-updater - Công cụ tự động nghiên cứu & nâng cấp hệ thống Agent${C.reset}

Các lệnh sử dụng:
  ${C.bold}agent-updater init --target <path>${C.reset} Gắn dự án mục tiêu và bật bộ hẹn giờ chạy ngầm trong 1 bước
  ${C.bold}agent-updater status${C.reset}              Xem trạng thái hẹn giờ, lần nâng cấp gần nhất và gói chờ duyệt
  ${C.bold}agent-updater check${C.reset}               Quét thử toàn bộ tín hiệu nội bộ & bên ngoài (0 tốn hạn mức AI)
  ${C.bold}agent-updater run [--force]${C.reset}       Chạy phiên nghiên cứu & nâng cấp ngay (--dry-run để chỉ tạo nháp)
  ${C.bold}agent-updater review [id]${C.reset}         Xem tóm tắt và diff màu của gói thay đổi nhạy cảm đang chờ duyệt
  ${C.bold}agent-updater approve [id|--all]${C.reset}  Duyệt và áp dụng gói thay đổi nhạy cảm chỉ bằng 1 lệnh
  ${C.bold}agent-updater reject [id|--all]${C.reset}   Bỏ qua gói chờ duyệt
  ${C.bold}agent-updater backups${C.reset}             Xem danh sách các bản sao lưu tự động
  ${C.bold}agent-updater rollback [id]${C.reset}       Hoàn tác ngay về bản sao lưu trước đó (mặc định bản mới nhất)
  ${C.bold}agent-updater logs [-n 40]${C.reset}        Xem nhật ký hoạt động chạy ngầm
  ${C.bold}agent-updater install-service${C.reset}     Cài đặt/cập nhật lệnh ~/.local/bin và bộ hẹn giờ systemd --user
  ${C.bold}agent-updater uninstall-service${C.reset}   Tắt và gỡ bộ hẹn giờ chạy ngầm
`);
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || flags.h || flags._[0] === "help") {
    printHelp();
    return;
  }
  const config = loadConfig();
  const sub = flags._[0] || "status";

  switch (sub) {
    case "init":
      cmdInit(flags);
      break;
    case "status":
      cmdStatus(config);
      break;
    case "check":
      cmdCheck(config);
      break;
    case "run":
      cmdRun(config, flags);
      break;
    case "review":
      cmdReview(flags);
      break;
    case "approve":
      cmdApprove(config, flags);
      break;
    case "reject":
      cmdReject(config, flags);
      break;
    case "backups":
      cmdBackups();
      break;
    case "rollback":
      cmdRollback(config, flags);
      break;
    case "logs": {
      const lines = readRecentLogs(flags.lines || 40);
      console.log(lines.length ? lines.join("\n") : "(Chưa có nhật ký)");
      break;
    }
    case "install-service": {
      assertTargetRepoConfigured(config);
      const res = installCliAndSystemd(config);
      syncStatusIndicator(config, { state: "idle" });
      console.log(`${C.green}✔ Đã gắn lệnh '${res.binLink}' và kích hoạt bộ hẹn giờ chạy ngầm systemd.${C.reset}`);
      if (!res.systemdOk && res.details) {
        console.warn(`${C.yellow}Lưu ý systemd: ${res.details}${C.reset}`);
      }
      break;
    }
    case "uninstall-service":
      uninstallSystemd();
      console.log(`${C.yellow}Đã tắt và gỡ bộ hẹn giờ chạy ngầm systemd.${C.reset}`);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`${C.red}Lệnh không hợp lệ: '${sub}'.${C.reset}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  appendLog("ERROR", "Lỗi thực thi CLI", err.stack || err.message);
  console.error(`${C.red}✖ Lỗi: ${err.message}${C.reset}`);
  process.exitCode = 1;
}
