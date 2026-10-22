# Autonomous AI Worker (Level 3 Jira Auto-Fix)

Hệ thống điều phối tự động hoá phát hiện, phân tích, sửa lỗi và **tự xác minh + tự merge** dựa trên Jira và Telegram On-call dành cho mọi loại dự án phần mềm (Microservices hoặc Monorepo).

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
[Telegram On-Call] [Claude Code]     [Git (local repo)]
• Gửi log .txt     • Headless (-p)   • Tạo branch hotfix/<KEY>-<ts>
• Báo cáo kết quả  • Sửa mã nguồn    • Worker tự verify
• Phân quyền RBAC  • Viết unit test  • Merge vào staging
```

> **NHÁNH HOTFIX CÓ TIMESTAMP.** `hotfix/<KEY>-<YYYYMMDD-HHMMSS>` → mỗi lần retry tạo branch RIÊNG, không ghi đè lịch sử cũ trên remote. Branch được tạo **trực tiếp trong repo service** (base = `origin/<target>` = staging) — **không còn dùng git worktree**.

> **WORKER TỰ XÁC MINH — KHÔNG TIN BÁO CÁO CỦA AI.** Sau khi AI sửa + commit, worker tự chạy 3 bước và **dừng ngay khi bước nào fail** (fail → job fail → **không** merge): (1) unit test đầy đủ, (2) coverage **≥ 90%** cho đúng các class đã sửa (chỉ service api), (3) build. Chỉ khi cả 3 pass → worker **tự merge** branch hotfix vào nhánh `target` (staging). Sau đó worker kiểm tra pipeline CI (nếu repo **chưa có** CI → bỏ qua, không chặn) rồi báo Telegram + comment Jira.

> **TẠM THỜI KHÔNG TẠO PR LÊN PRODUCTION.** Luồng tạo Pull Request (kể cả PR lên `staging`) đã bị **tắt tạm thời**: worker tự merge vào staging sau khi verify pass, nút duyệt Merge trên Telegram không còn dùng để merge. PR lên production sẽ bật lại sau.

---

## 2. Luồng xử lý 1 ticket (5 bước)

```text
1. Claim ticket     → worker gắn nhãn `auto-fix-processing` (khoá atomics, chống xử lý trùng)
2. Tạo branch       → hotfix/<KEY>-<YYYYMMDD-HHMMSS> TRỰC TIẾP trong repo service (base = origin/staging)
3. Claude sửa bug   → sửa mã nguồn + VIẾT UNIT TEST (JUnit 5 + Mockito) + tự commit (Conventional Commits)
4. Worker tự verify → unit test đầy đủ → coverage ≥ 90% (api) → build   [dừng ngay khi fail]
5. Worker tự merge  → merge vào staging → kiểm tra pipeline CI (bỏ qua nếu repo chưa có CI) → báo Telegram + Jira
```

> **Không có bước duyệt thủ công.** Worker tự merge vào staging sau khi 3 bước verify đều pass. PR lên production **tạm thời không tạo**.

---

## 3. Cấu trúc Thư mục

- `worker.js`: Script runner chính (quét Jira, kích hoạt AI, quản lý Telegram bot và thao tác Git trong repo service).
- `CLAUDE.md`: Bản đồ định nghĩa toàn bộ service, lệnh build test và quy tắc commit dành riêng cho AI.
- `.claude/skills/autofix-init-claude-md/`: Skill tự động tạo/cập nhật `CLAUDE.md` phục vụ riêng cho Auto-Fix Bug Worker khi có service mới.
- `.claude/hooks/pre-tool-use.js`: Hook chặn các lệnh shell nguy hiểm (`rm -rf`, can thiệp `.env`).
- `.claude/settings.generated.json`: **Sinh lúc chạy** (đã gitignore) — worker tạo file này lúc khởi động để đăng ký hook guardrail, với lệnh hook trỏ tới **đường dẫn tuyệt đối** `.claude/hooks/pre-tool-use.js`.
- Worker **không ghi file nào vào repo service**: rules khoanh vùng bug được nạp qua `--append-system-prompt` (từ `CLAUDE.md` của worker), hook guardrail qua `--settings` (từ file trên) → repo khách luôn sạch, không kèm `CLAUDE.md` / `.claude/` lạ.
- `.env`: Cấu hình môi trường riêng biệt per-project.
- `services/`: Nơi chứa toàn bộ source code của các service/sub-project. Xem chi tiết tại [services/README.md](services/README.md).
- `SETUP_GUIDE.md`: Hướng dẫn đầy đủ, step-by-step để cài đặt & chạy hệ thống (GlitchTip → Jira → Telegram → Worker). Xem bản HTML tại [SETUP_GUIDE.html](SETUP_GUIDE.html).
- `tools/build-doc-html.py`: Script sinh `SETUP_GUIDE.html` từ `SETUP_GUIDE.md` (tự chứa, không cần mạng). Chạy: `python tools/build-doc-html.py`.
- **Thư mục làm việc = chính repo service**: worker **checkout thẳng repo service**, tạo branch `hotfix/<KEY>-<timestamp>` ngay trong repo đó (base = `origin/<target>` = staging) và chạy Claude Code với `cwd` = repo service đó. Hệ quả: trong lúc xử lý, `git status` của repo service hiện branch hotfix.

> 💡 **Dùng worker cho nhiều dự án:** mỗi entry trong `projects.json` có thêm 2 trường `root` + `path` — `root` là thư mục gốc dự án, `path` là thư mục chứa `services.json`. Cả hai nhận đường dẫn TUYỆT ĐỐI (`"D:/work/acme"`) hoặc TƯƠNG ĐỐI so với thư mục worker (`"../acme"`), nên service repo **không cần nằm trong thư mục worker**. Chi tiết + câu trả lời "mọi lệnh có phải `cd` vào thư mục dự án không?" → [SETUP_GUIDE.md — Dùng worker cho nhiều dự án](SETUP_GUIDE.md#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker).

---
> 💡 **GlitchTip Integration:** Hệ thống sử dụng GlitchTip làm trung tâm phân tích lỗi, Sentry SDK trên App, và Jira làm Message Bus điều phối ticket. Xem chi tiết tại [GLITCHTIP_GUIDE.md](GLITCHTIP_GUIDE.md).

---


## 4. Hướng dẫn Khởi tạo & Cài đặt

### Bước 1: Chuẩn bị file `.env`
Sao chép `.env.example` thành `.env`:
```bash
cp .env.example .env
```
Điền các giá trị:
- `GITHUB_*`: Token cá nhân (PAT có quyền `repo`), `GITHUB_REPO` (dạng `username/repo-name`).
- Luồng nhánh DEV->TARGET->PROD (cấu hình trong `.env`, xem `.env.example`):
  - `GIT_DEV_BRANCH`: nhánh DEV (fallback khi service không khai báo `branches.target`) — ví dụ: `develop`.
  - `GIT_TARGET_BRANCH`: nhánh TARGET — worker tạo branch hotfix từ đây và **tự merge vào đây** sau khi verify pass (ví dụ: `staging`).
  - `GIT_PROD_BRANCH`: nhánh PROD — hiện **tạm thời không tạo PR lên nhánh này** (luồng PR đã bị tắt).
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
node --env-file=.env worker.js
```
> `worker.js` **không tự đọc `.env`** → bắt buộc dùng `node --env-file=.env worker.js`, hoặc chạy `start-worker.bat` (script đã làm sẵn).
>
> Worker **không phụ thuộc CWD**: mọi đường dẫn nội bộ (`projects.json`, `evidence/`, `CLAUDE.md`, `.claude/`) được resolve từ `__dirname` (`WORKER_ROOT`) nên có thể chạy từ bất kỳ thư mục nào. Các lệnh `git` / `claude -p` thì **luôn** chạy trong đúng thư mục đích (repo service đã checkout branch hotfix) — xem [SETUP_GUIDE.md — Dùng worker cho nhiều dự án](SETUP_GUIDE.md#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker).

---

## 5. Các tính năng cốt lõi

### A. Worker tự xác minh & tự merge (không còn danh sách PR chờ)
- Sau khi AI sửa + commit, worker tự chạy **unit test → coverage (≥ 90% cho class đã sửa, chỉ api) → build**, **dừng ngay khi bước nào fail** → fail = job fail, **không merge**.
- Pass hết → worker **tự merge** branch hotfix vào nhánh `target` (staging) rồi push, không cần người duyệt bấm nút.
- Danh sách PR chờ merge (`pending-prs.json`) và các nút 🔀 Merge / ⏳ Lưu vào hàng đợi **đã bị tắt tạm thời** → Telegram chỉ nhận **báo cáo kết quả**.

### B. AI Tự Chịu Trách Nhiệm Commit (Không dùng Script Commit)
- Worker **không** tự ý chạy `git commit` thay thế.
- Nếu Claude Code sửa file nhưng quên commit, worker sẽ gọi lại Claude với prompt yêu cầu tự phân tích diff, xác định đúng tên service trong `services/`, và tự thực thi `git commit -m "fix(<service>): ..."` theo chuẩn Conventional Commits.

### C. Xử lý Timeout & Crash
- Mỗi bug được giới hạn thời gian qua `CLAUDE_TIMEOUT_MS` (mặc định 5 phút).
- Quá thời gian quy định, worker tự ngắt tiến trình để bảo vệ ngân sách API, gắn nhãn `auto-fix-failed` trên Jira để tránh vòng lặp quét lại, và gửi thông báo lỗi về Telegram.

### D. Tự động giải quyết Conflict
- Khi worker tự merge branch hotfix vào nhánh đích mà nhánh đích đã có thay đổi mới gây conflict:
- Claude tự động kéo nhánh đích về, tìm và gỡ các marker `<<<<<<<`, chạy lại test và commit bản gỡ lỗi lên nhánh hotfix.
- Worker tự động hoàn tất merge sau khi AI xử lý xong.

### E. Evidence Manager & Tự Động Báo Cáo Media
- Tự động quản lý bằng chứng (log, screenshot, meta) theo chuẩn `evidence/<JIRA-KEY>/before/` và `after/`.
- **Alert 1:** Khi có lỗi, báo cáo lỗi về Telegram kèm file log (từ `before/`).
- **Alert 2:** Khi fix xong, gom toàn bộ bằng chứng sau sửa đổi (hình ảnh từ `after/`) thành MediaGroup và gửi kèm thông báo kết quả (ticket, service, branch, xác minh) về nhóm On-call.
