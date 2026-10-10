# Autonomous AI Worker (Level 3 Jira Auto-Fix)

Hệ thống điều phối tự động hoá phát hiện, phân tích, sửa lỗi và tạo Pull Request dựa trên Jira và Telegram On-call dành cho mọi loại dự án phần mềm (Microservices hoặc Monorepo).

---

## 1. Kiến trúc Hệ thống

```
      [App / User Runtime (React/Spring)]
                        │
                        ▼ (Sentry SDK catch exception)
              [GlitchTip v4.x]
                        │ (Webhook Alert)
                        ▼
       [Jira Automation Rule (Incoming Webhook)]
                        │ (Tạo Issue [AUTO-BUG])
                        ▼ (Polling JQL qua API)
                 ┌──────────────┐
                 │  worker.js   │ ◄─── Đọc CLAUDE.md (Services Map)
                 └──────┬───────┘
                        │
     ┌──────────────────┼──────────────────┐
     ▼                  ▼                  ▼
[Telegram On-Call] [Claude Code]     [GitHub REST API]
• Gửi log .txt     • Headless (-p)   • Tạo branch hotfix/
• Duyệt Merge PR   • Sửa mã nguồn    • Mở Pull Request
• Hàng đợi Pending • Auto test & fix • Auto Merge PR
• Phân quyền RBAC  • Gỡ Conflict     • Dọn PR đã đóng
```

---

## 2. Cấu trúc Thư mục

- `worker.js`: Script runner chính (quét Jira, kích hoạt AI, quản lý Telegram bot và GitHub API).
- `CLAUDE.md`: Bản đồ định nghĩa toàn bộ service, lệnh build test và quy tắc commit dành riêng cho AI.
- `.claude/skills/autofix-init-claude-md/`: Skill tự động tạo/cập nhật `CLAUDE.md` phục vụ riêng cho Auto-Fix Bug Worker khi có service mới.
- `.claude/hooks/pre-tool-use.js`: Hook chặn các lệnh shell nguy hiểm (`rm -rf`, can thiệp `.env`).
- `.env`: Cấu hình môi trường riêng biệt per-project.
- `services/`: Nơi chứa toàn bộ source code của các service/sub-project. Xem chi tiết tại [services/README.md](services/README.md).

---
> 💡 **GlitchTip Integration:** Hệ thống sử dụng GlitchTip làm trung tâm phân tích lỗi, Sentry SDK trên App, và Jira làm Message Bus điều phối ticket. Xem chi tiết tại [GLITCHTIP_GUIDE.md](GLITCHTIP_GUIDE.md).

---


## 3. Hướng dẫn Khởi tạo & Cài đặt

### Bước 1: Chuẩn bị file `.env`
Sao chép `.env.example` thành `.env`:
```bash
cp .env.example .env
```
Điền các giá trị:
- `GITHUB_*`: Token cá nhân (PAT có quyền `repo`), `GITHUB_REPO` (dạng `username/repo-name`).
- Luồng nhánh DEV->TARGET->PROD (cấu hình trong `.env`, xem `.env.example`):
  - `GIT_DEV_BRANCH`: nhánh DEV để tách worktree fix bug (ví dụ: `develop`).
  - `GIT_TARGET_BRANCH`: nhánh TARGET để deploy dev/demo, verify sau fix (ví dụ: `pre-prod`).
  - `GIT_PROD_BRANCH`: nhánh PROD quan trọng — chỉ tạo PR lên nhánh này sau khi đã verify thành công, không push trực tiếp.
  - Deprecated fallback: `GIT_BASE_BRANCH` (dùng khi `GIT_DEV_BRANCH` trống), `GIT_PREPROD_BRANCH` (dùng khi `GIT_TARGET_BRANCH` trống).
- `services.json` (tại root): khai báo ip/domain và health check từng service. Sửa `deployUrl` thành ip/domain thật của môi trường dev/demo, giữ `healthPath` (`api` dùng `/actuator/health`, `web` dùng `/`). `PREPROD_HEALTH_URL` trong `.env` đã deprecated — ưu tiên `services.json`.
- `TELEGRAM_*`: Bot Token từ `@BotFather`, ID chat nhóm on-call, và `TELEGRAM_ALLOWED_USER_IDS` để phân quyền duyệt.

### Bước 2: Tự động tạo `CLAUDE.md` bằng Skill
Khi bạn thêm service mới vào `services/`, chạy Claude Code để skill tự tạo/cập nhật file `CLAUDE.md`:
```bash
claude "Sử dụng skill autofix-init-claude-md để quét thư mục services/ và tạo file CLAUDE.md"
```

### Bước 3: Khởi động Worker
```bash
node worker.js
```

---

## 4. Các tính năng cốt lõi

### A. Chống rác danh sách PR trên Telegram (Anti-stale PR Sync)
- Danh sách PR đợi merge được lưu tại `pending-prs.json`.
- Mỗi khi bấm **[📋 Xem danh sách đợi Merge]**, worker tự động kết nối GitHub API để kiểm tra trạng thái từng PR.
- Những PR nào đã được Merge hoặc bị Closed sẽ **tự động bị xoá khỏi danh sách**, đảm bảo Telegram không bị rác.

### B. AI Tự Chịu Trách Nhiệm Commit (Không dùng Script Commit)
- Worker **không** tự ý chạy `git commit` thay thế.
- Nếu Claude Code sửa file nhưng quên commit, worker sẽ gọi lại Claude với prompt yêu cầu tự phân tích diff, xác định đúng tên service trong `services/`, và tự thực thi `git commit -m "fix(<service>): ..."` theo chuẩn Conventional Commits.

### C. Xử lý Timeout & Crash
- Mỗi bug được giới hạn thời gian qua `CLAUDE_TIMEOUT_MS` (mặc định 5 phút).
- Quá thời gian quy định, worker tự ngắt tiến trình để bảo vệ ngân sách API, gắn nhãn `auto-fix-failed` trên Jira để tránh vòng lặp quét lại, và gửi thông báo lỗi về Telegram.

### D. Tự động giải quyết Conflict
- Khi người dùng bấm **[🔀 Merge PR]** nhưng nhánh đích đã có thay đổi mới gây conflict:
- PR giữ nguyên trạng thái **Open**.
- Claude tự động kéo nhánh đích về, tìm và gỡ các marker `<<<<<<<`, chạy lại test và push bản gỡ lỗi lên nhánh hotfix.
- Worker tự động hoàn tất merge sau khi AI xử lý xong.

### E. Evidence Manager & Tự Động Báo Cáo Media
- Tự động quản lý bằng chứng (log, screenshot, meta) theo chuẩn `evidence/<JIRA-KEY>/before/` và `after/`.
- **Alert 1:** Khi có lỗi, báo cáo lỗi về Telegram kèm file log (từ `before/`).
- **Alert 2:** Khi fix xong, gom toàn bộ bằng chứng sau sửa đổi (hình ảnh từ `after/`) thành MediaGroup và gửi kèm link Pull Request về nhóm On-call.
