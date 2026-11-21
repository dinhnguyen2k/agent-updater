# Agent Auto-Updater (`agent-updater`)

Công cụ độc lập chạy ngầm giúp tự động nghiên cứu độ lệch nội bộ lẫn bản cập nhật công cụ AI bên ngoài (`omp`, `agy`, `claude`, `codex` và thư viện công nghệ), sau đó nâng cấp hệ thống `.agent/` theo hai tầng an toàn mà không cần nhớ mở phiên bảo trì thủ công.

---

## Cài đặt lại trên máy mới trong 1 lệnh

```bash
git clone https://github.com/dinhnguyen2k/agent-updater.git ~/.agent-updater
bash ~/.agent-updater/install.sh --target /duong/dan/du-an --zsh
```

*(Đảm bảo `~/.local/bin` đã nằm trong biến `PATH` của shell).*

Nếu bạn đổi sang thư mục dự án khác sau này, chỉ cần chạy:

```bash
agent-updater init --target /duong/dan/du-an-moi
```

---

## Cơ chế vận hành tự động

1. **Hẹn giờ kép không tốn tài nguyên (`systemd --user`)**:
   - `agent-updater.timer`: Chạy cố định mỗi ngày lúc `20:00` kèm `Persistent=true` (nếu đến giờ hẹn máy đang tắt hoặc đóng WSL, ngay lần đầu mở lại terminal hôm sau hệ thống sẽ tự chạy bù ở nền).
   - `agent-updater-watch.path`: Theo dõi trực tiếp thay đổi của `agent-friction.jsonl`, `boundary-guard.log` và `ERRORS.md` ở cấp nhân Linux (0% CPU); khi tích đủ từ 5 tín hiệu lỗi mới trở lên sẽ tự kích hoạt nghiên cứu sớm.
2. **Cổng lọc 0 tốn hạn mức AI**:
   - Trước khi gọi AI, công cụ kiểm tra ma sát mới, độ lệch Git trên các tệp mẫu chuẩn, lỗi kiểm tra tĩnh của `.agent/` và độ chênh phiên bản của `omp`, `agy`, `claude`, `codex` cùng các thư viện chính.
   - Nếu không có gì thay đổi kể từ mốc trước, công cụ dừng trong chưa đầy 1 giây mà không gọi AI.
3. **Phân tầng an toàn & Tự khôi phục**:
   - Phiên AI chỉ chạy trên bản sao tạm cô lập trong `workspaces/`, sau đó được kiểm định bằng `validate-agent-system.mjs --write-catalog` và `install-harness-wiring.sh --check`.
   - **Vùng Xanh** (kỹ năng, ví dụ mẫu, danh mục tài liệu): Tự chụp bản sao lưu vào `backups/`, ghi nguyên tử và đồng bộ sang toàn bộ công cụ AI; nếu bất kỳ bước kiểm tra nào lỗi thì tự khôi phục ngay lập tức.
   - **Vùng Đỏ** (chạm `AI_RULES.md`, `AGENTS.md`, `OPINION.md`, `agent-registry.json`, script hoặc hook bảo vệ): Đóng gói vào `pending/` và đồng bộ trạng thái ra `~/.agent_updater_status.json` (kèm đồng bộ sang thư mục người dùng Windows trên WSL cho thanh trạng thái WezTerm) để người dùng duyệt bằng 1 lệnh.

---

## Các lệnh thường dùng

| Lệnh | Công dụng |
| --- | --- |
| `agent-updater status` | Xem trạng thái bộ hẹn giờ, lịch sử nâng cấp và các gói chờ duyệt |
| `agent-updater check` | Quét thử toàn bộ tín hiệu hiện tại mà không gọi AI (0 tốn hạn mức) |
| `agent-updater run` | Chủ động chạy kiểm tra và nâng cấp ngay (`--force` để ép AI rà soát lại toàn diện, `--dry-run` để chỉ tạo gói nháp) |
| `agent-updater review [id]` | Xem tóm tắt Tiếng Việt và bảng so sánh màu (diff) của gói thay đổi nhạy cảm |
| `agent-updater approve [id\|--all]` | Phê duyệt và đồng bộ gói thay đổi nhạy cảm bằng 1 lệnh |
| `agent-updater reject [id\|--all]` | Từ chối và ẩn gói chờ duyệt |
| `agent-updater backups` | Liệt kê các bản sao lưu tự động |
| `agent-updater rollback [id]` | Hoàn tác hệ thống `.agent/` về bản sao lưu trước đó trong 1 giây |
| `agent-updater logs [-n 40]` | Xem nhật ký chạy nền |

---

## Tích hợp nhãn thông báo lên thanh trạng thái WezTerm (Tùy chọn)

Thêm đoạn ngắn sau vào `wezterm.lua` (trong hàm cập nhật `right_status` có sẵn hàm `read_json_file` và `make_solid_pill`):

```lua
local ag_up = read_json_file(".agent_updater_status.json")
if ag_up then
  if ag_up.state == "running" then
    append_elements(right_elems, make_solid_pill("󰚩", "Agent đang nâng cấp..", "#9ccfd8"))
  elseif (tonumber(ag_up.pending_count) or 0) > 0 then
    append_elements(right_elems, make_solid_pill("⚡", string.format("Agent +%d chờ duyệt", ag_up.pending_count), "#f6c177"))
  end
end
```
