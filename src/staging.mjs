import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { matchesAnyGlob, readJsonSafe, resolveWithin, runSafeCommand, toRelPosix } from "./security.mjs";
import { WORKSPACES_DIR } from "./state.mjs";

const MUTABLE_ROOT_FILES = ["AI_RULES.md", "AGENTS.md", "OPINION.md"];
const SKIP_TOP_LEVEL_LINKS = new Set([
  ".agent",
  ".agents",
  ".claude",
  ".codex",
  ".omp",
  ".git",
  "node_modules",
  "AI_RULES.md",
  "AGENTS.md",
  "OPINION.md",
  "CLAUDE.md",
  "GEMINI.md",
  "ANTIGRAVITY.md",
]);
const IGNORED_AGENT_PREFIXES = [
  ".agent/scratch/",
  ".agent/reports/",
  ".agent/task-manifests/",
];

function hashBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function walkRealFiles(rootDir, subDir = "") {
  const absDir = subDir ? join(rootDir, subDir) : rootDir;
  if (!existsSync(absDir)) return [];
  const results = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name;
    if (IGNORED_AGENT_PREFIXES.some((prefix) => rel.startsWith(prefix) || `${rel}/` === prefix)) {
      continue;
    }
    const full = join(rootDir, rel);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...walkRealFiles(rootDir, rel));
    } else if (st.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

export function collectManagedFileMap(repoDir) {
  const map = new Map();
  for (const rootFile of MUTABLE_ROOT_FILES) {
    const full = join(repoDir, rootFile);
    if (existsSync(full) && !lstatSync(full).isSymbolicLink()) {
      const content = readFileSync(full);
      map.set(rootFile, { hash: hashBuffer(content), size: content.length });
    }
  }
  for (const rel of walkRealFiles(repoDir, ".agent")) {
    const full = join(repoDir, rel);
    const content = readFileSync(full);
    map.set(rel, { hash: hashBuffer(content), size: content.length });
  }
  return map;
}

export function createStagingWorkspace(targetRepo, label = "run") {
  const id = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const stagingDir = resolveWithin(WORKSPACES_DIR, id);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  cpSync(resolveWithin(targetRepo, ".agent"), join(stagingDir, ".agent"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(targetRepo, src).replace(/\\/g, "/");
      return !rel.startsWith(".agent/scratch/.runtime");
    },
  });

  for (const rootFile of MUTABLE_ROOT_FILES) {
    const src = resolveWithin(targetRepo, rootFile);
    if (existsSync(src)) {
      cpSync(src, join(stagingDir, rootFile));
    }
  }

  for (const entry of readdirSync(targetRepo, { withFileTypes: true })) {
    if (SKIP_TOP_LEVEL_LINKS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".planning") continue;
    if (entry.isDirectory()) {
      const realTarget = resolveWithin(targetRepo, entry.name);
      symlinkSync(realTarget, join(stagingDir, entry.name), "dir");
    }
  }

  const wiringRes = runSafeCommand("bash", [".agent/scripts/install-harness-wiring.sh"], {
    cwd: stagingDir,
    timeoutMs: 30_000,
  });
  if (!wiringRes.ok) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`Không thể dựng liên kết công cụ trong thư mục tạm: ${wiringRes.stderr || wiringRes.stdout}`);
  }

  return { id, stagingDir };
}

export function removeStagingWorkspace(stagingDir) {
  try {
    const safe = resolveWithin(WORKSPACES_DIR, toRelPosix(WORKSPACES_DIR, stagingDir));
    rmSync(safe, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function validateWorkspace(workspaceDir) {
  const catRes = runSafeCommand("node", [".agent/scripts/validate-agent-system.mjs", "--write-catalog"], {
    cwd: workspaceDir,
    timeoutMs: 35_000,
  });
  if (!catRes.ok) {
    return {
      ok: false,
      step: "validate-agent-system",
      output: `${catRes.stdout}\n${catRes.stderr}`.trim(),
    };
  }

  const syncRes = runSafeCommand("bash", [".agent/scripts/install-harness-wiring.sh"], {
    cwd: workspaceDir,
    timeoutMs: 25_000,
  });
  if (!syncRes.ok) {
    return {
      ok: false,
      step: "install-harness-wiring",
      output: `${syncRes.stdout}\n${syncRes.stderr}`.trim(),
    };
  }

  const checkRes = runSafeCommand("bash", [".agent/scripts/install-harness-wiring.sh", "--check"], {
    cwd: workspaceDir,
    timeoutMs: 20_000,
  });
  if (!checkRes.ok) {
    return {
      ok: false,
      step: "install-harness-wiring-check",
      output: `${checkRes.stdout}\n${checkRes.stderr}`.trim(),
    };
  }

  return {
    ok: true,
    output: catRes.stdout.trim(),
  };
}

export function loadProtectedGlobs(targetRepo, config) {
  const registry = readJsonSafe(resolveWithin(targetRepo, ".agent/contracts/agent-registry.json"), {});
  const fromRegistry = Array.isArray(registry?.protected_config_paths) ? registry.protected_config_paths : [];
  const fromConfig = Array.isArray(config?.protectedPatterns) ? config.protectedPatterns : [];
  return [...new Set([...fromRegistry, ...fromConfig])];
}

export function computeWorkspaceDiff(targetRepo, stagingDir, protectedGlobs) {
  const baseMap = collectManagedFileMap(targetRepo);
  const nextMap = collectManagedFileMap(stagingDir);
  const allPaths = [...new Set([...baseMap.keys(), ...nextMap.keys()])].sort();

  const changes = [];
  for (const relPath of allPaths) {
    const before = baseMap.get(relPath) || null;
    const after = nextMap.get(relPath) || null;
    if (before && after && before.hash === after.hash) continue;

    const kind = !before ? "added" : !after ? "deleted" : "modified";
    const isProtected = matchesAnyGlob(relPath, protectedGlobs);
    const content = after ? readFileSync(resolveWithin(stagingDir, relPath), "utf8") : null;

    let patch = "";
    const oldFile = before ? resolveWithin(targetRepo, relPath) : "/dev/null";
    const newFile = after ? resolveWithin(stagingDir, relPath) : "/dev/null";
    const diffRes = runSafeCommand(
      "diff",
      ["-u", "--label", `a/${relPath}`, "--label", `b/${relPath}`, oldFile, newFile],
      { timeoutMs: 8000 }
    );
    patch = diffRes.stdout || "";

    changes.push({
      path: relPath,
      kind,
      zone: isProtected ? "red" : "green",
      content,
      patch,
    });
  }
  return changes;
}

export function applyChangesToWorkspace(workspaceDir, changes) {
  for (const item of changes) {
    const dest = resolveWithin(workspaceDir, item.path);
    if (item.kind === "deleted") {
      rmSync(dest, { force: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, item.content ?? "", "utf8");
    }
  }
}

export function partitionChangesSafely(targetRepo, allChanges) {
  const green = allChanges.filter((c) => c.zone === "green");
  const red = allChanges.filter((c) => c.zone === "red");

  if (green.length === 0 || red.length === 0) {
    return { autoGreen: green, stagedRed: red, coupledGreenIntoRed: false };
  }

  const probe = createStagingWorkspace(targetRepo, "probe-green");
  try {
    applyChangesToWorkspace(probe.stagingDir, green);
    const validation = validateWorkspace(probe.stagingDir);
    if (validation.ok) {
      const refreshedGreen = computeWorkspaceDiff(targetRepo, probe.stagingDir, []);
      return { autoGreen: refreshedGreen, stagedRed: red, coupledGreenIntoRed: false };
    }
    return {
      autoGreen: [],
      stagedRed: allChanges,
      coupledGreenIntoRed: true,
    };
  } finally {
    removeStagingWorkspace(probe.stagingDir);
  }
}
