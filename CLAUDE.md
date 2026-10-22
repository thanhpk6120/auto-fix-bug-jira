# Project Architecture & Guidelines for Autonomous Agent

Tài liệu này định nghĩa cấu trúc repo và quy tắc để Claude Code tự động xác định phạm vi cần sửa, chạy test và thực hiện git commit chuẩn mực.

---

## 1. Kiến trúc Singleton Master Worker & Bản đồ Dịch vụ

Hệ thống áp dụng kiến trúc **Singleton Master Worker**: một tiến trình `worker.js` duy nhất quản lý N dự án thông qua cấu hình trong file `projects.json`.
- Số lượng job AI chạy song song được khống chế bởi biến môi trường `MAX_CONCURRENT_JOBS` (khai báo trong `.env`).
- Worker sử dụng nhãn JQL `auto-fix-processing` làm cơ chế khoá (Atomic Lock) để tránh xử lý trùng lặp ticket.

### Services Map (Bản đồ Dịch vụ)

| Project Key | Thư mục project trong workspace | Service | Repo Git | Stack | Port | Lệnh test |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `SHOP` | `services/` | `api` | `thanhpk6120/shop-api` | Java 17/21+ (Spring Boot) | 8080 | `mvnw.cmd -B clean test jacoco:report` |
| `SHOP` | `services/` | `web` | `thanhpk6120/shop-web` | React 18 (Vite) | 5173 | `npm run build` (repo này KHÔNG có script `test`) |
| `CMS` | `services-2/` | `api` | `thanhpk6120/cms-api` | Java 17/21+ (Spring Boot) | 8081 | `mvnw.cmd -B clean test jacoco:report` |
| `CMS` | `services-2/` | `web` | `thanhpk6120/cms-web` | React 18 (Vite) | 5174 | `npm run build` (repo này KHÔNG có script `test`) |

**Ánh xạ nhãn Jira → service:** ticket bắt buộc có nhãn `service:api` hoặc `service:web`. Thiếu nhãn thì worker abort — không được tự đoán service.

**Quy tắc nhánh Git (áp dụng cho cả 4 service):** `dev` → `master`, `target` → `staging`, `prod` → `master`.

> **Lưu ý Sentry:** Cả frontend và backend đều đã tích hợp Sentry SDK (`@sentry/react` và `sentry-spring-boot-starter-jakarta`). Lỗi sẽ tự động được gửi về GlitchTip qua `SENTRY_DSN`, không dùng Jira API thủ công.

---

### Bối cảnh thư mục làm việc (Working Directory Context) — ĐỌC KỸ TRƯỚC KHI SỬA FILE

Worker checkout repo của service cần sửa, tạo branch `hotfix/<JIRA_KEY>-<timestamp>` **trực tiếp trong repo đó** (base = nhánh `target`/staging), rồi chạy Claude Code với `cwd` = repo service đó. Rules bạn đang đọc được nạp qua `--append-system-prompt`; guardrail hook được nạp qua `--settings`. Worker **không ghi file nào** (`CLAUDE.md`, `.claude/`) vào repo của bạn.

Hệ quả bắt buộc:

1. **Bạn đang đứng ở GỐC REPO CỦA SERVICE CẦN SỬA** (ví dụ repo `shop-api`, `shop-web`, `cms-api`, `cms-web`) — không phải ở workspace worker. Mọi lệnh `git`, `npm`, `mvnw.cmd` chạy tại thư mục này.
2. **Mọi đường dẫn sửa file phải TƯƠNG ĐỐI so với repo hiện tại:**
   - service `api` → `src/main/java/...`, test ở `src/test/java/...`
   - service `web` → `src/...`
3. **TUYỆT ĐỐI KHÔNG dùng đường dẫn dạng `services/shop-api/...` hay `services-2/cms-api/...`** (và tương tự cho `web`). Những path đó chỉ đúng ở góc nhìn của workspace worker, KHÔNG đúng trong repo hiện tại — dùng sai sẽ tạo file sai chỗ hoặc báo "path not found".
4. **Repo của bạn không có `CLAUDE.md` hay `.claude/` nào từ worker.** Đừng tìm chúng, đừng tạo chúng.
5. **Bạn đang ở trên branch `hotfix/<JIRA_KEY>-<timestamp>`** (base = nhánh `target`). Worker sẽ tự merge branch này vào `target` sau khi xác minh pass. Đừng tự merge, đừng tự push, đừng đổi branch.

---

## 2. Quy tắc Điều hướng & Khoanh vùng lỗi (Bug Localization)

Khi nhận mô tả lỗi hoặc stack trace từ Jira:

1. **Lỗi Java / Spring Boot (BE):**
   - Dấu hiệu: Có package name `com.poc...`, exception Java (`NullPointerException`, `ArithmeticException`, v.v.), hoặc liên quan đến API endpoint `/api/...`.
   - **Thao tác:** Chỉ can thiệp vào mã nguồn trong `src/main/java/` của repo service `api` hiện tại (đường dẫn tương đối so với gốc repo, xem mục 1).
   - **Xác minh:** Chạy `mvnw.cmd -B clean test jacoco:report` (trên Windows: `./mvnw` KHÔNG chạy — phải dùng `mvnw.cmd` hoặc `mvn -B clean test jacoco:report`) trước khi kết luận.
   - **Quy tắc Unit Test (Fallback):** Nếu không thể chạy service local để verify, BẮT BUỘC tạo/sửa file Unit Test (JUnit 5 + Mockito) trong `src/test/java/`. Phải mock data, test toàn bộ case (success, fail, edge cases). Chỉ số JaCoCo coverage (đọc trong `target/site/jacoco/jacoco.csv`) phải > 90% cho code liên quan.
2. **Lỗi React / UI (FE):**
   - Dấu hiệu: Lỗi Javascript (`TypeError`, `ReferenceError`, JSX render, DOM error).
   - **Thao tác:** Chỉ can thiệp vào mã nguồn trong `src/` của repo service `web` hiện tại (đường dẫn tương đối so với gốc repo, xem mục 1).
   - **Xác minh:** Chạy `npm run build` (repo `shop-web` KHÔNG có script `test`) để đảm bảo không lỗi cú pháp và bundle thành công.

**Giới hạn phạm vi chỉnh sửa (bắt buộc):**
- Chỉ được sửa file mã nguồn trong `src/` (bao gồm file test `src/test/...`). Không sửa file ngoài `src/`.
- Không được sửa/xoá file nào trong `evidence/` (chỉ được TẠO file bằng chứng mới — xem mục 5).
- Không được chạm `CLAUDE.md` và `.claude/`.

---

## 3. Quy tắc Git Commit (Commit Conventions)

Claude **BẮT BUỘC** tự commit mã sau khi sửa xong và verify thành công theo chuẩn Conventional Commits. Worker script **KHÔNG ĐƯỢC PHÉP** tự ý commit thay cho Claude:

- Lỗi Backend (service `api`): `fix(api): <mô tả ngắn gọn lỗi đã sửa>`
- Lỗi Frontend (service `web`): `fix(web): <mô tả ngắn gọn lỗi đã sửa>`
- Gỡ xung đột: `fix(conflict): resolve merge conflict with base branch`

**Prefix là BẮT BUỘC** — không được dùng prefix khác (`fix:`, `feat:`, `chore:`, `hotfix:` …). Chọn `api` hay `web` theo service đang sửa, không theo ticket.

> **Ghi chú:** Worker có thể tự commit phần AI quên commit, dùng message dạng `fix(auto): ...`. Nếu thấy commit có prefix `fix(auto):` thì cần sửa lại đúng convention ở trên.

Ví dụ (đường dẫn tương đối so với gốc repo hiện tại):
```bash
git add src/main/java/...
git commit -m "fix(api): handle divide by zero in calculate endpoint [AUTO-BUG]"
```

---

## 4. Các luật bất di bất dịch (Strict Guardrails)

- ❌ **TUYỆT ĐỐI KHÔNG** sửa đổi hoặc xoá file `worker.js`, `.env`, `.env.example`, `README.md`.
- ❌ **TUYỆT ĐỐI KHÔNG** can thiệp vào thư mục `.claude/` (và cũng không sửa `CLAUDE.md`).
- ❌ **TUYỆT ĐỐI KHÔNG** chạy các lệnh phá hoại: `git push --force`, `rm -rf`, xoá database.
- ❌ **CẤM CHEAT TEST:**
  - TUYỆT ĐỐI KHÔNG sửa mã nguồn (`src/main/java` hoặc code nghiệp vụ) để cố tình pass test (như xoá logic nghiệp vụ, return hardcode, skip execution).
  - TUYỆT ĐỐI KHÔNG sửa test để pass (nếu test hỏng do nghiệp vụ, phải sửa nghiệp vụ).
  - TUYỆT ĐỐI KHÔNG viết các assertion rỗng hoặc không có ý nghĩa (vd: `assertTrue(true)`) chỉ để qua mặt coverage. Test phải xác minh đúng hành vi thực tế.
- ⚡ **Tiêu chí:** Minimal change — Chỉ sửa đúng dòng code gây lỗi trong service tương ứng, không can thiệp qua các service khác.

---

## 5. Evidence (Bằng chứng repro)

- Bằng chứng repro lưu vào `evidence/{JIRA_KEY}/before/`.
- **LƯU Ý ĐƯỜNG DẪN:** `evidence/` là đường dẫn tương đối so với thư mục gốc worker. Trong repo hiện tại, hãy tạo `evidence/{JIRA_KEY}/before/` **tại gốc repo service đang làm việc** — worker sẽ thu thập từ đó.
- **TUYỆT ĐỐI KHÔNG commit file trong `evidence/`** (không `git add evidence/`, không đưa vào commit message).

---

## 6. Quy trình của worker

Worker chạy Claude Code 2 lần cho mỗi ticket:

1. **Bước 1 — Repro:** Tái hiện lỗi và tạo bằng chứng trong `evidence/{JIRA_KEY}/before/`. Nếu **không tái hiện được** lỗi, phải in ra đúng chuỗi `[AI_STOP] REPRO_FAILED` để worker dừng — không được sửa code đoán mò.
2. **Bước 2 — Fix:** Sửa code tối thiểu, **viết unit test đầy đủ cho mọi class/hàm liên quan**, chạy lệnh verify, lưu output vào `evidence/{JIRA_KEY}/after/`, rồi **tự commit** theo mục 3.

### 6.1. Yêu cầu unit test (BẮT BUỘC — worker tự kiểm tra lại)

Worker sẽ tự chạy lại lệnh verify và **TỰ KIỂM TRA COVERAGE** của các class bạn đã sửa. Nếu không đạt, job fail và không merge.

- **Java:** viết test JUnit 5 + Mockito cho **mọi** class bạn sửa hoặc phụ thuộc trực tiếp vào thay đổi. Tên test class = `<TênClass>Test.java`, đặt trong `src/test/java` đúng package.
- **Coverage:** mỗi class bạn sửa phải có **coverage ≥ 90%** (báo cáo: `target/site/jacoco/jacoco.csv`). Worker đọc chính file này để kiểm tra.
- **Phải bao phủ TẤT CẢ case liên quan:** success, edge case, giá trị biên, input không hợp lệ, null/rỗng, exception.
- **TUYỆT ĐỐI KHÔNG** viết assertion rỗng (vd `assertTrue(true)`) để đẩy coverage lên.
- **TUYỆT ĐỐI KHÔNG** làm yếu hoặc xoá test có sẵn. Test fail thì sửa **nguyên nhân**, không sửa test cho pass.
- **Chỉ 1 commit** cho toàn bộ fix.

> **Bạn phải tự commit** — không được để worker tự commit thay.
>
> Worker sẽ tự merge branch của bạn vào nhánh `target` (staging) **chỉ khi** unit test + coverage + build đều pass. Bạn không cần (và không được) tự merge/push.
