import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, redactSecrets, resolveWithin, runSafeCommand } from "./security.mjs";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function countNonEmptyLines(filePath) {
  if (!existsSync(filePath)) return { count: 0, tail: [] };
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { count: lines.length, tail: lines.slice(-15).map((l) => redactSecrets(l).slice(0, 260)) };
}

function collectToolVersions(prevVersions = {}, forceChangelog = false) {
  const current = {};
  for (const bin of ["agy", "omp", "claude", "codex"]) {
    const res = runSafeCommand(bin, ["--version"], { timeoutMs: 8000 });
    if (res.ok) {
      current[bin] = res.stdout.trim().split(/\r?\n/)[0]?.trim() || "unknown";
    } else if (!res.missingBinary) {
      const fallback = (res.stdout || res.stderr || "").trim().split(/\r?\n/)[0]?.trim();
      if (fallback) current[bin] = fallback.slice(0, 80);
    }
  }

  const changedTools = [];
  for (const [bin, ver] of Object.entries(current)) {
    if (prevVersions[bin] && prevVersions[bin] !== ver) {
      changedTools.push({ tool: bin, previous: prevVersions[bin], current: ver });
    }
  }

  let agyChangelogExcerpt = "";
  const agyChanged = changedTools.some((item) => item.tool === "agy");
  if (current.agy && (agyChanged || forceChangelog)) {
    const chg = runSafeCommand("agy", ["changelog"], { timeoutMs: 10_000 });
    if (chg.ok && chg.stdout) {
      agyChangelogExcerpt = chg.stdout.split(/\r?\n/).slice(0, 45).join("\n");
    }
  }

  return { current, changedTools, agyChangelogExcerpt };
}

function collectStackSnapshot(targetRepo) {
  const trackedManifests = [
    "Directory.Packages.props",
    "backend/Directory.Packages.props",
    "backend/Directory.Build.props",
    "package.json",
    "frontend/shared/package.json",
    "frontend/erp/package.json",
  ];
  const found = {};
  const keyPackages = {};

  for (const rel of trackedManifests) {
    const full = resolveWithin(targetRepo, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf8");
    found[rel] = sha256(content).slice(0, 16);

    if (rel.endsWith("package.json")) {
      const pkg = readJsonSafe(full, {});
      const allDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
      for (const name of [
        "react",
        "react-dom",
        "@tanstack/react-query",
        "@tanstack/react-router",
        "@tanstack/react-table",
        "react-hook-form",
        "zod",
        "tailwindcss",
        "typescript",
        "vite",
        "vitest",
      ]) {
        if (allDeps[name]) keyPackages[name] = allDeps[name];
      }
    } else if (rel.endsWith(".props")) {
      const tfm = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
      if (tfm) keyPackages.dotnetTargetFramework = tfm[1].trim();
      for (const match of content.matchAll(/Include="(Microsoft\.EntityFrameworkCore|MassTransit|Grpc\.AspNetCore|FluentValidation)"[^>]*Version="([^"]+)"/g)) {
        keyPackages[match[1]] = match[2];
      }
    }
  }

  const combinedHash = sha256(JSON.stringify({ found, keyPackages }));
  return { combinedHash, manifests: found, keyPackages };
}

function collectGitDrift(targetRepo, lastGitHead) {
  const headRes = runSafeCommand("git", ["rev-parse", "HEAD"], { cwd: targetRepo, timeoutMs: 8000 });
  const currentHead = headRes.ok ? headRes.stdout.trim() : null;
  if (!currentHead || !lastGitHead || currentHead === lastGitHead) {
    return { currentHead, commits: [], exemplarTouches: [], sharedTouches: [] };
  }

  const verifyOld = runSafeCommand("git", ["cat-file", "-e", `${lastGitHead}^{commit}`], {
    cwd: targetRepo,
    timeoutMs: 5000,
  });
  if (!verifyOld.ok) {
    return { currentHead, commits: [], exemplarTouches: [], sharedTouches: [] };
  }

  const logRes = runSafeCommand("git", ["log", "--oneline", "-n", "25", `${lastGitHead}..${currentHead}`], {
    cwd: targetRepo,
    timeoutMs: 8000,
  });
  const commits = logRes.ok ? logRes.stdout.split(/\r?\n/).filter(Boolean) : [];

  const diffRes = runSafeCommand("git", ["diff", "--name-status", `${lastGitHead}..${currentHead}`], {
    cwd: targetRepo,
    timeoutMs: 10_000,
  });
  const changedLines = diffRes.ok ? diffRes.stdout.split(/\r?\n/).filter(Boolean) : [];

  const exemplarsJson = readJsonSafe(resolveWithin(targetRepo, ".agent/contracts/archetype-exemplars.json"), {});
  const exemplarSet = new Set([
    ...(exemplarsJson?.backend_exemplars || []),
    ...(exemplarsJson?.frontend_exemplars || []),
    ...Object.values(exemplarsJson?.archetypes || {}).flatMap((a) => [
      ...(a?.backend_exemplars || []),
      ...(a?.frontend_exemplars || []),
    ]),
  ]);

  const exemplarTouches = [];
  const sharedTouches = [];
  for (const line of changedLines) {
    const parts = line.split(/\t+/);
    const status = parts[0] || "";
    const file = parts.at(-1) || "";
    if (exemplarSet.has(file)) {
      exemplarTouches.push(`${status} ${file}`);
    } else if (
      /^frontend\/shared\/src\/(?:components|hooks|services|ui)\//.test(file) ||
      /^backend\/src\/BuildingBlocks\//.test(file)
    ) {
      sharedTouches.push(`${status} ${file}`);
    }
  }

  return {
    currentHead,
    commits: commits.slice(0, 20),
    exemplarTouches: exemplarTouches.slice(0, 25),
    sharedTouches: sharedTouches.slice(0, 25),
  };
}

export function collectSignals(config, state, options = {}) {
  const targetRepo = config.targetRepo;
  const frictionPath = resolveWithin(targetRepo, ".agent/reports/agent-friction.jsonl");
  const guardPath = resolveWithin(targetRepo, ".agent/reports/boundary-guard.log");
  const errorsMdPath = resolveWithin(targetRepo, ".planning/errors/ERRORS.md");

  const frictionRaw = countNonEmptyLines(frictionPath);
  const guardRaw = countNonEmptyLines(guardPath);

  const prevFriction = frictionRaw.count >= (state.lastFrictionLines || 0) ? state.lastFrictionLines || 0 : 0;
  const prevGuard = guardRaw.count >= (state.lastGuardLines || 0) ? state.lastGuardLines || 0 : 0;
  const frictionDelta = Math.max(0, frictionRaw.count - prevFriction);
  const guardDelta = Math.max(0, guardRaw.count - prevGuard);

  const summaryRes = runSafeCommand("node", [".agent/scripts/summarize-friction.mjs", "--json"], {
    cwd: targetRepo,
    timeoutMs: 15_000,
  });
  let frictionSummary = null;
  if (summaryRes.ok) {
    try {
      frictionSummary = JSON.parse(summaryRes.stdout);
    } catch {
      frictionSummary = null;
    }
  }

  const contextRes = runSafeCommand("node", [".agent/scripts/report-agent-context.mjs", "--json"], {
    cwd: targetRepo,
    timeoutMs: 15_000,
  });
  let contextBudget = null;
  if (contextRes.ok) {
    try {
      contextBudget = JSON.parse(contextRes.stdout);
    } catch {
      contextBudget = null;
    }
  }

  const validateRes = runSafeCommand("node", [".agent/scripts/validate-agent-system.mjs", "--show-warnings"], {
    cwd: targetRepo,
    timeoutMs: 25_000,
  });
  const validationErrors = (validateRes.stderr || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ERROR "))
    .slice(0, 20);
  const validationWarnings = (validateRes.stderr || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("WARN "))
    .slice(0, 20);

  let errorsMdHash = null;
  let errorsMdSize = 0;
  let errorsMdExcerpt = "";
  if (existsSync(errorsMdPath)) {
    const content = readFileSync(errorsMdPath, "utf8");
    errorsMdSize = statSync(errorsMdPath).size;
    errorsMdHash = sha256(content);
    if (state.lastErrorsMdHash && state.lastErrorsMdHash !== errorsMdHash && errorsMdSize >= (state.lastErrorsMdSize || 0)) {
      errorsMdExcerpt = redactSecrets(content.slice(-3000));
    }
  }
  const errorsMdChanged = Boolean(state.lastErrorsMdHash && errorsMdHash && state.lastErrorsMdHash !== errorsMdHash);

  const tools = collectToolVersions(state.lastToolVersions || {}, Boolean(options.force));
  const stack = collectStackSnapshot(targetRepo);
  const stackChanged = Boolean(state.lastStackHash && state.lastStackHash !== stack.combinedHash);
  const git = collectGitDrift(targetRepo, state.lastGitHead);

  const expiredCount = frictionSummary?.allowlist?.expired?.length || 0;
  const expiringCount = frictionSummary?.allowlist?.expiringSoon?.length || 0;
  const budgetExceeded = (contextBudget?.results || []).some((r) =>
    Object.values(r.within_budget || {}).some((ok) => ok === false)
  );

  const reasons = [];
  if (frictionDelta > 0) reasons.push(`Có ${frictionDelta} dòng ma sát mới trong agent-friction.jsonl`);
  if (guardDelta > 0) reasons.push(`Có ${guardDelta} lượt chặn mới trong boundary-guard.log`);
  if (errorsMdChanged) reasons.push("Tệp .planning/errors/ERRORS.md có ghi nhận lỗi mới");
  if (validationErrors.length > 0) reasons.push(`Hệ thống agent hiện có ${validationErrors.length} lỗi kiểm tra tĩnh`);
  if (expiredCount > 0 || expiringCount > 0) {
    reasons.push(`Allowlist có ${expiredCount} mục hết hạn và ${expiringCount} mục sắp hết hạn`);
  }
  if (budgetExceeded) reasons.push("Dung lượng ngữ cảnh vượt ngưỡng context-budget.json");
  if (git.exemplarTouches.length > 0) reasons.push(`Có ${git.exemplarTouches.length} tệp mẫu chuẩn vừa thay đổi trong Git`);
  if (git.sharedTouches.length >= 3) reasons.push(`Có ${git.sharedTouches.length} tệp dùng chung (shared/BuildingBlocks) vừa đổi`);
  if (tools.changedTools.length > 0) {
    reasons.push(`Công cụ AI vừa nâng phiên bản: ${tools.changedTools.map((t) => `${t.tool} (${t.previous} -> ${t.current})`).join(", ")}`);
  }
  if (stackChanged) reasons.push("Phiên bản thư viện trong dự án vừa thay đổi");

  return {
    collectedAt: new Date().toISOString(),
    initializedBefore: Boolean(state.initialized),
    reasons,
    watermarks: {
      gitHead: git.currentHead,
      errorsMdHash,
      errorsMdSize,
      frictionLines: frictionRaw.count,
      guardLines: guardRaw.count,
      toolVersions: tools.current,
      stackHash: stack.combinedHash,
    },
    internal: {
      frictionDelta,
      guardDelta,
      recentFrictionTail: frictionRaw.tail,
      recentGuardTail: guardRaw.tail,
      frictionSummary,
      validationOk: validateRes.ok,
      validationErrors,
      validationWarnings,
      contextBudget,
      errorsMdChanged,
      errorsMdExcerpt,
      git,
    },
    external: {
      tools,
      stack,
    },
  };
}

export function evaluateTriggerGate(signals, config, state, options = {}) {
  if (options.force) {
    return { shouldRun: true, reason: "Người dùng yêu cầu chạy cưỡng bức (--force)." };
  }

  const trigger = options.trigger || "manual";
  if (trigger === "watcher") {
    const combinedNew = signals.internal.frictionDelta + signals.internal.guardDelta + (signals.internal.errorsMdChanged ? 3 : 0);
    const threshold = Math.max(1, Number(config.frictionThreshold) || 5);
    if (combinedNew < threshold) {
      return {
        shouldRun: false,
        reason: `Chưa chạm ngưỡng chạy sớm (${combinedNew}/${threshold} tín hiệu lỗi mới).`,
      };
    }
    if (state.lastResearchAt) {
      const elapsedMin = (Date.now() - Date.parse(state.lastResearchAt)) / 60_000;
      const cooldown = Math.max(5, Number(config.minCooldownMinutes) || 120);
      if (Number.isFinite(elapsedMin) && elapsedMin < cooldown) {
        return {
          shouldRun: false,
          reason: `Đang trong thời gian nghỉ chống lặp (${Math.round(elapsedMin)}/${cooldown} phút).`,
        };
      }
    }
    return { shouldRun: true, reason: `Chạm ngưỡng lỗi phát sinh sớm (${combinedNew} >= ${threshold}).` };
  }

  if (!signals.initializedBefore && signals.reasons.length === 0) {
    return {
      shouldRun: false,
      initBaselineOnly: true,
      reason: "Khởi tạo mốc theo dõi ban đầu (hiện tại hệ thống sạch 0 lỗi, chưa cần tốn hạn mức AI).",
    };
  }

  if (signals.reasons.length === 0) {
    return {
      shouldRun: false,
      reason: "Không có ma sát mới, không có độ lệch mã nguồn hay bản cập nhật công cụ mới kể từ lần quét trước.",
    };
  }

  return { shouldRun: true, reason: signals.reasons.join("; ") };
}
