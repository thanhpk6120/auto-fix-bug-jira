# Project Architecture & Guidelines for Autonomous Agent

Tài liệu này định nghĩa cấu trúc repo và quy tắc để Claude Code tự động xác định phạm vi cần sửa, chạy test và thực hiện git commit chuẩn mực.

---

## 1. Kiến trúc Singleton Master Worker & Bản đồ Dịch vụ

Hệ thống áp dụng kiến trúc **Singleton Master Worker**: một tiến trình `worker.js` duy nhất quản lý N dự án thông qua cấu hình trong file `projects.json`.
- Số lượng job AI chạy song song được khống chế bởi biến môi trường `MAX_CONCURRENT_JOBS` (khai báo trong `.env`).
- Worker sử dụng nhãn JQL `auto-fix-processing` làm cơ chế khoá (Atomic Lock) để tránh xử lý trùng lặp ticket.

### Services Map (Bản đồ Dịch vụ)

| Dự án / Tên (Project Key) | Thư mục mã nguồn (`path`) | Ngôn ngữ / Framework | Lệnh Build & Test | Cổng local |
| :--- | :--- | :--- | :--- | :--- |
| **KANBAN (Kanban Board)** | `.` (Dự án hiện tại: `services/api`, `services/web`) | Java 17/21+ (Spring Boot), React 18 (Vite) | `./mvnw clean test jacoco:report` / `npm test` | 8080 / 5173 |
| **ECOM (E-Commerce)** | `services-2/` (`services-2/api`, `services-2/web`) | Java 17/21+ (Spring Boot), React 18 (Vite) | `./mvnw clean test jacoco:report` / `npm test` | 8081 / 5174 |

> **Lưu ý Sentry:** Cả frontend và backend đều đã tích hợp Sentry SDK (`@sentry/react` và `sentry-spring-boot-starter-jakarta`). Lỗi sẽ tự động được gửi về GlitchTip qua `SENTRY_DSN`, không dùng Jira API thủ công.
---


## 2. Quy tắc Điều hướng & Khoanh vùng lỗi (Bug Localization)
Khi nhận mô tả lỗi hoặc stack trace từ Jira:
1. **Lỗi Java / Spring Boot (BE):**
   - Dấu hiệu: Có package name `com.poc...`, exception Java (`NullPointerException`, `ArithmeticException`, v.v.), hoặc liên quan đến API endpoint `/api/...`.
   - **Thao tác:** Chỉ can thiệp vào mã nguồn trong thư mục api của dự án tương ứng (ví dụ: `services/api/src/main/java/` hoặc `services-2/api/src/main/java/`).
   - **Xác minh:** Chạy `./mvnw clean test` trong thư mục api trước khi kết luận.
   - **Quy tắc Unit Test (Fallback):** Nếu không thể chạy service local để verify, BẮT BUỘC tạo/sửa file Unit Test (JUnit 5 + Mockito). Phải mock data, test toàn bộ case (success, fail, edge cases). Chỉ số JaCoCo coverage (xem trong `target/site/jacoco/jacoco.csv`) phải > 90% cho code liên quan.
2. **Lỗi React / UI (FE):**
   - Dấu hiệu: Lỗi Javascript (`TypeError`, `ReferenceError`, JSX render, DOM error).
   - **Thao tác:** Chỉ can thiệp vào mã nguồn trong thư mục web của dự án tương ứng (ví dụ: `services/web/src/` hoặc `services-2/web/src/`).
   - **Xác minh:** Chạy `npm run build` trong thư mục web để đảm bảo không lỗi cú pháp và bundle thành công.

---

## 3. Quy tắc Git Commit (Commit Conventions)
Claude **BẮT BUỘC** phải tự commit mã sau khi sửa xong và test thành công theo chuẩn Conventional Commits. Worker script **KHÔNG ĐƯỢC PHÉP** tự ý commit thay cho Claude:
- Lỗi Backend: `fix(api): <mô tả ngắn gọn lỗi đã sửa>`
- Lỗi Frontend: `fix(web): <mô tả ngắn gọn lỗi đã sửa>`
- Gỡ xung đột: `fix(conflict): resolve merge conflict with base branch`

Ví dụ:
```bash
git add services/api/src/... # Hoặc services-2/api/src/...
git commit -m "fix(api): handle divide by zero in calculate endpoint [AUTO-BUG]"
```

---

## 4. Các luật bất di bất dịch (Strict Guardrails)
- ❌ **TUYỆT ĐỐI KHÔNG** sửa đổi hoặc xoá file `worker.js`, `.env`, `.env.example`, `README.md`.
- ❌ **TUYỆT ĐỐI KHÔNG** can thiệp vào thư mục `.claude/`.
- ❌ **TUYỆT ĐỐI KHÔNG** chạy các lệnh phá hoại: `git push --force`, `rm -rf`, xoá database.
- ❌ **CẤM CHEAT TEST:** 
  - TUYỆT ĐỐI KHÔNG sửa mã nguồn (`src/main/java` hoặc code nghiệp vụ) để cố tình pass test (như xoá logic nghiệp vụ, return hardcode, skip execution).
  - TUYỆT ĐỐI KHÔNG sửa test để pass (nếu test hỏng do nghiệp vụ, phải sửa nghiệp vụ).
  - TUYỆT ĐỐI KHÔNG viết các assertion rỗng hoặc không có ý nghĩa (vd: `assertTrue(true)`) chỉ để qua mặt coverage. Test phải xác minh đúng hành vi thực tế.
- ⚡ **Tiêu chí:** Minimal change — Chỉ sửa đúng dòng code gây lỗi trong service tương ứng, không can thiệp qua các service khác.
