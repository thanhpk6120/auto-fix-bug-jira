# BÁO CÁO KẾT QUẢ KIỂM THỬ E2E TỰ ĐỘNG (AUTONOMOUS AGENT LEVEL 3)

- **Ngày thực hiện:** 2026-10-12
- **Môi trường:** Local Dev Machine (Windows x64)
- **Model sử dụng:** `claude-sonnet-5` (Claude Code 2.1.296)

---

## 1. Mục tiêu kiểm thử
Chứng minh hệ thống tự động hóa Level 3 hoạt động độc lập và hoàn chỉnh:
1. Phát sinh lỗi runtime trên Web Application (Frontend / Backend).
2. Sentry SDK tự động bắt lỗi và gửi về **GlitchTip** tại `http://10.30.1.200:8000/`.
3. Lỗi kích hoạt Webhook tự động tạo ticket `[AUTO-BUG]` trên bảng Jira tương ứng (`P1-SHOP`, `P2-CMS`).
4. **Singleton Master Worker (`worker.js`)** định kỳ quét Jira, bốc ticket theo đúng dự án qua `projects.json`, chuyển trạng thái khóa `auto-fix-processing`.
5. Worker kích hoạt **Claude Code** (`claude-sonnet-5`) ở chế độ Headless:
   - **Tái hiện lỗi (Repro):** Lưu bằng chứng log vào `evidence/SHOP-1/before/`.
   - **Sửa mã nguồn (Fix):** Tìm đúng service trong `services/api`, sửa bug chia cho 0.
   - **Viết kiểm thử (Unit Test):** Tạo `BugControllerTest.java` với độ phủ coverage JaCoCo > 90%.
   - **Commit Git:** Tự tạo commit tuân thủ Conventional Commits `fix(api): ...`.
6. Tích hợp code đã sửa vào `master`, chạy kiểm thử xác nhận `BUILD SUCCESS` (9/9 tests passed).

---

## 2. Bằng chứng kiểm thử trong thư mục `evidences/`

| File | Mô tả bằng chứng | Trạng thái |
|---|---|---|
| `01-frontend-trigger-error.png` | Ảnh chụp màn hình Frontend React (port 5173) khi bấm nút kích hoạt lỗi BE | ĐÃ CHỤP |
| `02-glitchtip-issue-caught.png` | Ảnh chụp giao diện GlitchTip bắt thành công `ArithmeticException: / by zero` trong project `project-1-be-1` | ĐÃ CHỤP |
| `03-jira-ticket-created.png` | Ảnh chụp bảng Kanban Jira SHOP hiển thị ticket `SHOP-1 [AUTO-BUG]` | ĐÃ CHỤP |
| `SHOP-1_error.txt` | Nội dung stack trace chi tiết do Sentry gửi về và worker lưu lại | ĐÃ LƯU |
| `repro.log` | Log tiến trình Claude Code chạy tái hiện lỗi độc lập | ĐÃ LƯU |
| `services/api/.../BugController.java` | Mã nguồn thực tế đã được AI sửa (xử lý `divisor == 0`) | ĐÃ SỬA |
| `services/api/.../BugControllerTest.java` | 9 unit test cases do AI sinh ra tự động để đạt coverage | ĐÃ TẠO |

---

## 3. Kết quả chạy Unit Test sau khi sửa lỗi
```text
[INFO] Results:
[INFO] Tests run: 9, Failures: 0, Errors: 0, Skipped: 0
[INFO] 
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
```

---

## 4. Git Commits sinh ra trong quá trình Auto-Fix
```text
9a20df2 fix(api): add more test coverage for calculate endpoint [AUTO-BUG]
1ef9ce9 fix(api): handle divide by zero in calculate endpoint [AUTO-BUG]
6d51a4a fix(worker): remove illegal escape in Jira JQL and support Backlog status
a0ee9bd chore: add log to checkJiraForBugs
05ef423 chore: setup SHOP and CMS configs with search/jql endpoint for Jira
```

---

## 5. Kết luận
Worker và toàn bộ chuỗi mắt xích tự động hoá:
**Web App -> GlitchTip -> Jira -> Master Worker -> Claude Code (claude-sonnet-5) -> Fix -> Unit Test -> Git Commit**
đã hoạt động trơn tru, độc lập và chính xác theo đúng kiến trúc đề ra.
