import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { readJsonSafe, redactSecrets, runSafeCommand } from "./security.mjs";
import { appendLog } from "./state.mjs";

export function buildResearchPrompt(signals, targetRepo = "") {
  const repoName = targetRepo ? basename(targetRepo) : "dự án mục tiêu";
  const compactSignals = {
    reasons: signals.reasons,
    frictionSummary: signals.internal.frictionSummary,
    recentFrictionTail: signals.internal.recentFrictionTail.slice(-10),
    recentGuardTail: signals.internal.recentGuardTail.slice(-10),
    validationErrors: signals.internal.validationErrors,
    validationWarnings: signals.internal.validationWarnings,
    errorsMdChanged: signals.internal.errorsMdChanged,
    errorsMdExcerpt: signals.internal.errorsMdExcerpt ? signals.internal.errorsMdExcerpt.slice(-2000) : "",
    gitDrift: signals.internal.git,
    changedTools: signals.external.tools.changedTools,
    currentTools: signals.external.tools.current,
    agyChangelogExcerpt: signals.external.tools.agyChangelogExcerpt,
    keyStackPackages: signals.external.stack.keyPackages,
  };

  return [
    `Bạn đang chạy trong KHÔNG GIAN NÂNG CẤP CÔ LẬP của công cụ tự động \`agent-updater\` dành cho dự án \`${repoName}\`.`,
    "Mục tiêu: thực hiện quy trình bảo trì theo `.agent/workflows/upgrade-agent.md` và `.agent/knowledge/skill-governance.json`.",
    "",
    "### Tín hiệu thu thập tự động trong đợt chạy này",
    "```json",
    JSON.stringify(compactSignals, null, 2),
    "```",
    "",
    "### Quy tắc thực thi bắt buộc",
    "1. CHỈ được đọc đối chiếu mã nguồn ứng dụng và `.planning/**` (đang nối liên kết chỉ đọc); TUYỆT ĐỐI KHÔNG sửa bất kỳ tệp mã nguồn ứng dụng nào bên ngoài `.agent/**`.",
    "2. Mọi chỉnh sửa chỉ nằm trong `.agent/**` (trừ `.agent/scratch/**`, `.agent/reports/**`) và khi thật sự cần thiết mới đề xuất vào `AI_RULES.md`, `AGENTS.md`, `OPINION.md`, `.agent/contracts/agent-registry.json`, `.agent/scripts/**`, `.agent/harness/**` (các tệp nhạy cảm này sẽ được `agent-updater` tự tách sang hàng đợi chờ người dùng duyệt 1 lệnh).",
    "3. Nghiên cứu nội bộ & ngoại sinh:",
    "   - Nếu có ma sát lặp lại, lỗi mới trong `ERRORS.md` hoặc đường dẫn/mẫu chuẩn trong `.agent/skills/**` hay `.agent/contracts/archetype-exemplars.json` bị lệch so với mã nguồn thật: đối chiếu mã nguồn thật rồi cập nhật chuẩn xác.",
    "   - Nếu có công cụ AI (`agy`, `omp`, `claude`, `codex`) hoặc thư viện chính đổi phiên bản: tra cứu changelog/tài liệu chính thức (ưu tiên T0 -> T1 theo `skill-governance.json`) để cập nhật hướng dẫn tương ứng khi thực sự có thay đổi ảnh hưởng cách làm việc.",
    "   - Nếu bổ sung kiểm tra tĩnh `R10` vào `agent-registry.json`, bắt buộc thêm cặp mẫu `allow` và `deny` vào `.agent/evals/guard-fixtures.json`.",
    "   - Giữ văn bản ngắn gọn, tỉa bỏ đoạn trùng lặp để nằm dưới trần `.agent/contracts/context-budget.json`. Không dùng dấu gạch ngang dài (em dash), dùng dấu `-` thường.",
    "4. Tự kiểm chứng ngay trong thư mục hiện tại trước khi kết thúc:",
    "   - Chạy `node .agent/scripts/validate-agent-system.mjs --write-catalog` và đảm bảo kết quả `0 error(s)`.",
    "5. Trước khi kết thúc, hãy ghi tệp `UPGRADE_SUMMARY.json` ngay tại thư mục gốc hiện tại (công cụ sẽ đọc rồi tự dọn tệp này, không sao chép vào repo) theo cấu trúc:",
    "   `{\"title\": \"Tiêu đề ngắn Tiếng Việt có dấu\", \"highlights\": [\"Ý chính 1\", \"Ý chính 2\"], \"sources\": [\"Nguồn đối chiếu\"], \"no_change_reason\": \"Điền nếu sau khi kiểm tra thấy không cần sửa gì\"}`.",
  ].join("\n");
}

function invokeSingleRunner(runner, prompt, stagingDir, timeoutMs) {
  const env = {
    COGAIN_AGENT_ROLE: "maintainer",
  };

  if (runner === "agy") {
    return runSafeCommand(
      "agy",
      [
        "--print",
        prompt,
        "--dangerously-skip-permissions",
        "--mode",
        "accept-edits",
        "--print-timeout",
        `${Math.max(60, Math.floor(timeoutMs / 1000))}s`,
      ],
      { cwd: stagingDir, timeoutMs: timeoutMs + 15_000, env }
    );
  }

  if (runner === "omp") {
    return runSafeCommand("omp", ["--print", "--no-session", "--cwd", stagingDir, prompt], {
      cwd: stagingDir,
      timeoutMs: timeoutMs + 15_000,
      env,
    });
  }

  return { ok: false, status: 1, stdout: "", stderr: `Runner không được hỗ trợ: ${runner}` };
}

export function runAiResearchSession(signals, createWorkspaceFn, removeWorkspaceFn, config) {
  const prompt = buildResearchPrompt(signals, config.targetRepo);
  const runners = Array.isArray(config.aiRunners) && config.aiRunners.length > 0 ? config.aiRunners : ["omp", "agy"];
  const timeoutMs = Math.max(120_000, Number(config.aiTimeoutMs) || 480_000);
  const errors = [];

  for (const runner of runners) {
    const { stagingDir } = createWorkspaceFn(`research-${runner}`);
    appendLog("INFO", `Bắt đầu phiên nghiên cứu AI bằng '${runner}'`, { stagingDir });
    const res = invokeSingleRunner(runner, prompt, stagingDir, timeoutMs);
    const summaryPath = join(stagingDir, "UPGRADE_SUMMARY.json");
    const summary = existsSync(summaryPath) ? readJsonSafe(summaryPath, null) : null;
    if (existsSync(summaryPath)) {
      rmSync(summaryPath, { force: true });
    }

    if (res.ok) {
      appendLog("INFO", `Phiên nghiên cứu '${runner}' hoàn tất.`);
      return {
        ok: true,
        runner,
        stagingDir,
        summary: summary || {
          title: "Cập nhật tự động hệ thống agent",
          highlights: (res.stdout || "")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 5),
          sources: [],
        },
        rawOutput: redactSecrets(res.stdout).slice(-4000),
      };
    }

    removeWorkspaceFn(stagingDir);
    const reason = redactSecrets(`${res.stderr || ""}\n${res.stdout || ""}`).trim().slice(0, 500);
    appendLog("WARN", `Runner '${runner}' thất bại (mã thoát ${res.status}), chuyển sang phương án dự phòng nếu có.`, reason);
    errors.push(`${runner}: ${reason || `exit ${res.status}`}`);
  }

  return {
    ok: false,
    stagingDir: null,
    error: errors.join(" | "),
  };
}
