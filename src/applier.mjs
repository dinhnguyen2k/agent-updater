import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { assertSafeId, atomicWriteJson, atomicWriteText, readJsonSafe, resolveWithin, runSafeCommand } from "./security.mjs";
import { appendLog, BACKUPS_DIR, PENDING_DIR } from "./state.mjs";
import { applyChangesToWorkspace, createStagingWorkspace, removeStagingWorkspace, validateWorkspace } from "./staging.mjs";

function makeSlugId(prefix) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${ts}`;
}

function pruneOldBackups(maxBackups = 15) {
  if (!existsSync(BACKUPS_DIR)) return;
  const entries = readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const limit = Math.max(3, Number(maxBackups) || 15);
  while (entries.length > limit) {
    const oldest = entries.shift();
    if (oldest) {
      rmSync(resolveWithin(BACKUPS_DIR, oldest), { recursive: true, force: true });
    }
  }
}

export function createBackup(targetRepo, relPaths, meta = {}, maxBackups = 15) {
  const id = makeSlugId("bak");
  const dir = resolveWithin(BACKUPS_DIR, id);
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  const entries = [];
  for (const relPath of [...new Set(relPaths)]) {
    const src = resolveWithin(targetRepo, relPath);
    if (existsSync(src)) {
      const dst = resolveWithin(filesDir, relPath);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      cpSync(src, dst);
      entries.push({ path: relPath, existed: true });
    } else {
      entries.push({ path: relPath, existed: false });
    }
  }

  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    targetRepo,
    reason: meta.reason || "Sao lưu tự động trước khi áp dụng nâng cấp",
    title: meta.title || "Bản sao lưu hệ thống agent",
    entries,
  };
  atomicWriteJson(join(dir, "manifest.json"), manifest, 0o600);
  pruneOldBackups(maxBackups);
  return manifest;
}

export function restoreFromBackupManifest(backupDir, manifest) {
  const targetRepo = manifest.targetRepo;
  const filesDir = join(backupDir, "files");
  for (const entry of manifest.entries || []) {
    const targetPath = resolveWithin(targetRepo, entry.path);
    if (entry.existed) {
      const savedPath = resolveWithin(filesDir, entry.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(savedPath, targetPath);
    } else {
      rmSync(targetPath, { force: true });
    }
  }
  runSafeCommand("node", [".agent/scripts/validate-agent-system.mjs", "--write-catalog"], {
    cwd: targetRepo,
    timeoutMs: 30_000,
  });
  runSafeCommand("bash", [".agent/scripts/install-harness-wiring.sh"], {
    cwd: targetRepo,
    timeoutMs: 25_000,
  });
}

function syncTargetHarnessAndWorktrees(targetRepo) {
  const valRes = runSafeCommand("node", [".agent/scripts/validate-agent-system.mjs", "--write-catalog"], {
    cwd: targetRepo,
    timeoutMs: 35_000,
  });
  if (!valRes.ok) {
    return { ok: false, error: `Kiểm tra hệ thống thất bại: ${valRes.stderr || valRes.stdout}` };
  }

  const wireRes = runSafeCommand("bash", [".agent/scripts/install-harness-wiring.sh"], {
    cwd: targetRepo,
    timeoutMs: 25_000,
  });
  if (!wireRes.ok) {
    return { ok: false, error: `Đồng bộ liên kết công cụ thất bại: ${wireRes.stderr || wireRes.stdout}` };
  }

  const treehouseDir = join(homedir(), ".treehouse");
  const treehouseScript = resolveWithin(targetRepo, ".agent/scripts/treehouse_harness.py");
  if (existsSync(treehouseDir) && existsSync(treehouseScript)) {
    const thRes = runSafeCommand("python3", [".agent/scripts/treehouse_harness.py", "--all"], {
      cwd: targetRepo,
      timeoutMs: 30_000,
      env: { COGAIN_AGENT_ROLE: "maintainer" },
    });
    if (!thRes.ok) {
      appendLog("WARN", "Đồng bộ Treehouse báo cảnh báo", thRes.stderr || thRes.stdout);
    }
  }

  return { ok: true, validationOutput: valRes.stdout.trim() };
}

export function applyChangesAtomically(targetRepo, changes, options = {}) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: true, appliedCount: 0, backupId: null };
  }

  // Bước 1: Kiểm chứng trước trên bản sao sạch của targetRepo hiện tại để chắn 100% không hỏng repo thật
  const precheck = createStagingWorkspace(targetRepo, "preapply");
  try {
    applyChangesToWorkspace(precheck.stagingDir, changes);
    const check = validateWorkspace(precheck.stagingDir);
    if (!check.ok) {
      return {
        ok: false,
        error: `Từ chối áp dụng vì không vượt qua bước kiểm chứng cô lập (${check.step}):\n${check.output}`,
      };
    }
  } finally {
    removeStagingWorkspace(precheck.stagingDir);
  }

  // Bước 2: Chụp sao lưu nguyên trạng (kể cả .agent/SKILLS.md có thể đổi do --write-catalog)
  const affectedPaths = [...new Set([...changes.map((c) => c.path), ".agent/SKILLS.md"])];
  const backup = createBackup(
    targetRepo,
    affectedPaths,
    { reason: options.reason, title: options.title },
    options.maxBackups ?? 15
  );
  const backupDir = resolveWithin(BACKUPS_DIR, backup.id);

  // Bước 3: Ghi nguyên tử và đồng bộ wiring; nếu bất kỳ lệnh nào lỗi thì tự khôi phục ngay tức khắc
  try {
    for (const item of changes) {
      const dest = resolveWithin(targetRepo, item.path);
      if (item.kind === "deleted") {
        rmSync(dest, { force: true });
      } else {
        atomicWriteText(dest, item.content ?? "", 0o644);
      }
    }

    const syncRes = syncTargetHarnessAndWorktrees(targetRepo);
    if (!syncRes.ok) {
      restoreFromBackupManifest(backupDir, backup);
      appendLog("ERROR", "Phát hiện lỗi sau khi ghi, đã tự động khôi phục từ bản sao lưu", {
        backupId: backup.id,
        error: syncRes.error,
      });
      return { ok: false, rolledBack: true, backupId: backup.id, error: syncRes.error };
    }

    appendLog("INFO", `Áp dụng thành công ${changes.length} tệp (sao lưu: ${backup.id})`, {
      files: changes.map((c) => `${c.kind}:${c.path}`),
    });
    return {
      ok: true,
      appliedCount: changes.length,
      backupId: backup.id,
      validationOutput: syncRes.validationOutput,
    };
  } catch (err) {
    restoreFromBackupManifest(backupDir, backup);
    appendLog("ERROR", "Ngoại lệ khi áp dụng, đã tự động khôi phục nguyên trạng", {
      backupId: backup.id,
      error: err.message,
    });
    return { ok: false, rolledBack: true, backupId: backup.id, error: err.message };
  }
}

export function stagePendingApproval(changes, summary, signals) {
  const id = makeSlugId("pkg");
  const dir = resolveWithin(PENDING_DIR, id);
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  const combinedPatch = changes.map((c) => c.patch).filter(Boolean).join("\n");
  atomicWriteText(join(dir, "patch.diff"), combinedPatch || "(Không có diff văn bản)\n", 0o600);

  const manifestChanges = [];
  for (const item of changes) {
    if (item.kind !== "deleted") {
      const payloadFile = resolveWithin(filesDir, item.path);
      atomicWriteText(payloadFile, item.content ?? "", 0o600);
    }
    manifestChanges.push({
      path: item.path,
      kind: item.kind,
      zone: item.zone,
    });
  }

  const manifest = {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    title: summary?.title || "Đề xuất nâng cấp chạm tệp luật gốc / bảo vệ",
    highlights: Array.isArray(summary?.highlights) ? summary.highlights : [],
    sources: Array.isArray(summary?.sources) ? summary.sources : [],
    triggerReasons: signals?.reasons || [],
    changes: manifestChanges,
  };
  atomicWriteJson(join(dir, "manifest.json"), manifest, 0o600);
  appendLog("INFO", `Đã đóng gói bản nháp chờ duyệt '${id}' (${changes.length} tệp)`, {
    files: manifestChanges.map((c) => c.path),
  });
  return manifest;
}

export function getPendingDetails(pendingId) {
  const safeId = assertSafeId(pendingId, "pending-id");
  const dir = resolveWithin(PENDING_DIR, safeId);
  const manifest = readJsonSafe(join(dir, "manifest.json"), null);
  if (!manifest) throw new Error(`Không tìm thấy gói chờ duyệt '${safeId}'.`);
  const patchPath = join(dir, "patch.diff");
  const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  return { dir, manifest, patch };
}

export function approvePendingPackage(targetRepo, pendingId, maxBackups = 15) {
  const { dir, manifest } = getPendingDetails(pendingId);
  if (manifest.status !== "pending") {
    throw new Error(`Gói '${manifest.id}' đã ở trạng thái '${manifest.status}', không thể duyệt lại.`);
  }

  const filesDir = join(dir, "files");
  const hydratedChanges = manifest.changes.map((c) => ({
    path: c.path,
    kind: c.kind,
    zone: c.zone,
    content: c.kind === "deleted" ? null : readFileSync(resolveWithin(filesDir, c.path), "utf8"),
  }));

  const res = applyChangesAtomically(targetRepo, hydratedChanges, {
    title: `Duyệt gói ${manifest.id}: ${manifest.title}`,
    reason: `Người dùng phê duyệt gói ${manifest.id}`,
    maxBackups,
  });
  if (!res.ok) return res;

  manifest.status = "approved";
  manifest.approvedAt = new Date().toISOString();
  manifest.backupId = res.backupId;
  atomicWriteJson(join(dir, "manifest.json"), manifest, 0o600);
  return { ...res, manifest };
}

export function rejectPendingPackage(pendingId) {
  const { dir, manifest } = getPendingDetails(pendingId);
  manifest.status = "rejected";
  manifest.rejectedAt = new Date().toISOString();
  atomicWriteJson(join(dir, "manifest.json"), manifest, 0o600);
  appendLog("INFO", `Người dùng đã từ chối gói chờ duyệt '${manifest.id}'.`);
  return manifest;
}

export function listBackups() {
  if (!existsSync(BACKUPS_DIR)) return [];
  const items = [];
  for (const entry of readdirSync(BACKUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readJsonSafe(join(BACKUPS_DIR, entry.name, "manifest.json"), null);
    if (manifest) items.push(manifest);
  }
  return items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export function rollbackToBackup(backupId) {
  const list = listBackups();
  if (list.length === 0) throw new Error("Hiện chưa có bản sao lưu nào để hoàn tác.");
  const chosen = backupId ? list.find((b) => b.id === assertSafeId(backupId, "backup-id")) : list[0];
  if (!chosen) throw new Error(`Không tìm thấy bản sao lưu '${backupId}'.`);

  const dir = resolveWithin(BACKUPS_DIR, chosen.id);
  restoreFromBackupManifest(dir, chosen);
  appendLog("INFO", `Đã hoàn tác hệ thống agent về bản sao lưu '${chosen.id}'`);
  return chosen;
}
