---
name: autofix-init-claude-md
description: Tự động phân tích các service trong services/ để tạo hoặc cập nhật file CLAUDE.md phục vụ riêng cho Autonomous Bug-Fixing Worker (worker.js). Định nghĩa Services Map, quy tắc khoanh vùng bug, lệnh build/test và commit convention cho AI sửa lỗi tự động.
---

# Auto-Fix CLAUDE.md Initializer Skill

Nhiệm vụ của skill này là quét thư mục `services/` và tự động sinh file `CLAUDE.md` chuẩn hoá, phục vụ riêng cho tiến trình **Auto-Fix Bug (Level 3 Autonomous Agent)** của `worker.js`.

## Quy trình thực hiện

1. **Quét các service trong hệ thống:**
   - Quét tất cả thư mục con trong `services/`.
   - Đọc từng file `README.md` của từng service (`services/<service-name>/README.md`).
   - Trích xuất: Tên service, stack công nghệ, build tool (Maven, Gradle, npm, etc.), lệnh test và build.

2. **Xác định mô hình Git:**
   - Kiểm tra `services/<service-name>/.git` xem là monorepo hay multi-repo độc lập.

3. **Sinh nội dung `CLAUDE.md` chuẩn Auto-Fix:**
   Tạo file `CLAUDE.md` ở root với cấu trúc:
   - **Services Map:** Bảng ánh xạ service ➔ thư mục ➔ stack ➔ lệnh test.
   - **Bug Localization Rules:** Hướng dẫn AI cách dựa vào stack trace/log lỗi của Jira để khoanh vùng đúng service cần sửa.
   - **Commit Conventions:** Quy chuẩn commit bắt buộc AI phải tự thực hiện (`fix(<service-name>): ...`).
   - **Strict Guardrails:** Cấm can thiệp `worker.js`, `.env`, `.claude/`, cấm `git push -f`, cấm `rm -rf`.

4. **Nguyên tắc:**
   - Không hardcode tĩnh danh sách service; luôn phát hiện tự động từ `services/`.
   - Chạy lại skill này bất cứ khi nào thêm/bớt service hoặc thay đổi lệnh test.
