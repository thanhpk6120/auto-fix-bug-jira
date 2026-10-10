# PoC Autonomous Agent: Jira Bug Auto-Fix & Telegram On-Call

## 1. Mục tiêu & Luồng hoạt động (Level 3 Autonomous Agent)
1. **Gây lỗi & Ghi nhận (Event-Driven):** User kích hoạt lỗi từ Frontend React (`web/`) hoặc Backend Java (`api/`). Sentry SDK tự động bắt lỗi và đẩy về **GlitchTip v4.x** (Error Tracking & Triage).
2. **Tạo Ticket Tự động:** GlitchTip Alert Webhook bắn sự kiện sang **Jira Automation (Incoming Webhook)**. Jira tự động tạo Issue Bug với tiền tố `[AUTO-BUG]` và các thông tin stack trace (Jira làm Message Bus).
3. **Lắng nghe & Báo động (Telegram Alert 1):**
   - `worker.js` quét Jira định kỳ (mỗi 15s) qua JQL để tìm các ticket có nhãn `auto-fix` và tiền tố `[AUTO-BUG]`.
   - Khi phát hiện ticket mới: gửi cảnh báo vào Telegram On-call Group kèm log file `.txt` và stack trace.
4. **Tự sửa lỗi & Tự tạo PR (Claude Code Headless):**
   - Checkout từ `GIT_DEV_BRANCH` (nhánh DEV để tách worktree, vd: `develop`; fallback deprecated `GIT_BASE_BRANCH`) sang branch `hotfix/<JIRA-KEY>`.
   - Chạy `claude -p` với Model và Timeout cấu hình từ `.env`.
   - Claude đọc `CLAUDE.md` để biết sửa repo/service nào và quy ước commit.
   - **Xác thực commit:** `worker.js` kiểm tra `git rev-parse HEAD` trước và sau Claude chạy. Nếu AI chưa commit hoặc còn file uncommitted, worker tự động `git add .` và commit `fix(<ticket>): auto-fix by Claude Code`.
   - Hệ thống tự động push branch và gọi GitHub API **tự động tạo Pull Request** vào `GIT_TARGET_BRANCH`.
5. **Báo cáo kết quả & Xin duyệt (Telegram Alert 2 - Interactive):**
   - Gửi thông báo hoàn tất kèm link PR trên GitHub.
   - Gắn các nút Inline Keyboard:
     - **[🔀 Merge PR]**: Merge trực tiếp vào `GIT_TARGET_BRANCH`.
     - **[⏳ Lưu vào hàng đợi]**: Lưu PR vào danh sách chờ duyệt sau (`pending-prs.json`).
     - **[📋 Xem danh sách đợi Merge]**: Hiển thị tất cả PR đang pending.
6. **Xử lý Conflict bằng AI (Auto Conflict Resolution):**
   - Khi bấm Merge mà gặp conflict giữa nhánh hotfix và `GIT_TARGET_BRANCH`:
   - Trạng thái PR trên GitHub: **Giữ nguyên trạng thái Open**, không đóng/huỷ. GitHub tự đánh dấu `mergeable: false`.
   - Worker cập nhật tin nhắn Telegram: *"⚠️ PR #X có conflict, Claude đang resolve..."*.
   - `worker.js` fetch và merge `origin/${GIT_TARGET_BRANCH}` vào nhánh hotfix cục bộ.
   - Kích hoạt Claude giải quyết conflict giữa 2 nhánh, chạy test xác minh, commit và push commit mới lên nhánh `hotfix/<JIRA-KEY>`.
   - GitHub PR tự động cập nhật commit mới, khi đó `mergeable` chuyển thành `true`.
   - Worker tự động thực hiện lại lệnh Merge vào `GIT_TARGET_BRANCH`.
7. **Xử lý Timeout / AI Crash:**
   - Khi Claude vượt quá `CLAUDE_TIMEOUT_MS`: tiến trình bị kill ngay lập tức.
   - Worker abort các lệnh dang dở (`git merge --abort` / `git checkout ${GIT_DEV_BRANCH}`).
   - Gửi cảnh báo Telegram: *"❌ Timeout khi xử lý <ticket>. AI đã chạy quá <X> phút và bị dừng để ngắt chi phí."*
   - Jira ticket chuyển nhãn `auto-fix-failed` để không bị poller quét lại vô tận.
8. **Kiểm tra quyền hạn & Cô lập môi trường:**
   - Chỉ `TELEGRAM_ALLOWED_USER_IDS` mới bấm được nút duyệt Merge.
   - Toàn bộ token Jira, GitHub, Git identity (tên, email, token) được cấu hình riêng trong `.env`, không bị lẫn lộn giữa tài khoản cá nhân và tài khoản công ty trên cùng một máy tính.
   - Luồng nhánh DEV->TARGET->PROD (cấu hình qua `.env`, xem `.env.example`): `GIT_DEV_BRANCH` tách worktree fix bug → `GIT_TARGET_BRANCH` deploy dev/demo, verify sau fix → `GIT_PROD_BRANCH` chỉ tạo PR sau khi verify thành công, không push trực tiếp. Deprecated fallback: `GIT_BASE_BRANCH` (khi `GIT_DEV_BRANCH` trống), `GIT_PREPROD_BRANCH` (khi `GIT_TARGET_BRANCH` trống).

## 1b. Khai báo ip/domain từng service (`services.json`)
- File `services.json` tại root khai báo `deployUrl` + `healthPath` từng service (`api` dùng `/actuator/health`, `web` dùng `/`).
- Sửa `deployUrl` thành ip/domain thật của môi trường dev/demo (mặc định placeholder `http://dev-demo.local`).
- `PREPROD_HEALTH_URL` trong `.env` đã deprecated — ưu tiên `services.json`.

## 2. Quy ước Evidence & Telegram
- Bằng chứng (Evidence) cho mỗi ticket được lưu tại `evidence/<JIRA-KEY>/before/` và `evidence/<JIRA-KEY>/after/`.
- Định dạng bằng chứng: `.log`, `screenshot-*.png`, `meta.json`.
- Hàm helper quản lý bằng chứng và Telegram gom chung (`evidence.js`):
  - Alert lỗi: Gửi thông báo kèm log/evidence từ thư mục `before/`.
  - Báo done: Gửi thông báo PR thành công kèm chùm ảnh (MediaGroup) từ thư mục `after/`.

## 3. Cấu trúc thư mục PoC hiện tại
- `web/`: Frontend React (Vite).
- `api/`: Backend Java (Spring Boot Maven).
- `worker.js`: Script runner tổng quát, tái sử dụng cho bất kỳ repo/project nào.
- `CLAUDE.md`: Hướng dẫn cho AI Agent biết cấu trúc service, test command, và quy tắc commit.
- `.claude/hooks/pre-tool-use.js`: Hook bảo vệ đa nền tảng.
- `.env`: Cấu hình độc lập per-project.
