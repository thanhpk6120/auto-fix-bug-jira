# PoC Autonomous Agent: Jira Bug Auto-Fix & Telegram On-Call

## 1. Kiến trúc Tổng thể (Singleton Master Worker)

Thay vì chạy nhiều tiến trình worker rời rạc cho từng dự án, hệ thống áp dụng kiến trúc **Singleton Master Worker**: một tiến trình `worker.js` duy nhất quản lý N dự án, kết hợp với **Bộ giới hạn Song song (Concurrency Limiter)** và sử dụng trực tiếp **Jira làm Message Queue**.

| Tiêu chí | Multi-Worker (Cũ) | Singleton Master Worker (Mới) |
|---|---|---|
| **Kiến trúc** | Mỗi repo chạy một script `worker.js` riêng biệt. | Một tiến trình `worker.js` duy nhất quản lý N repo tập trung. |
| **Cấu hình** | Sửa code, .env hoặc path từng repo riêng rẽ. | Khai báo tập trung qua `projects.json` (mẫu `KANBAN -> .`, `ECOM -> services-2`). |
| **Tài nguyên** | Không kiểm soát được. N worker có thể spawn 10 Claude AI cùng lúc gây treo máy/API Limit. | Khống chế qua `MAX_CONCURRENT_JOBS` (mặc định = 2) kết hợp semaphore `activeJobs`. |
| **Queue** | Xung đột file cục bộ, dội JQL hoặc tranh chấp ticket giữa các repo. | Lập lịch (async polling 15s), atomic claim qua Jira (nhãn `auto-fix-processing`), luồng To Do / In Progress / In Review. |

```text
      [App / User Runtime (React/Spring) của N Dự án]
                        │
                        ▼ (Sentry SDK catch exception)
           [GlitchTip v4.x Error Tracking]
                        │ (Webhook Alert)
                        ▼
       [Jira Automation Rule (Incoming Webhook)]
                        │ (Tạo Issue [AUTO-BUG])
                        ▼
    ┌───────────────────────────────────────────────┐
    │                JIRA MESSAGE QUEUE             │
    │ (Không lưu queue trong RAM, dùng Atomic Lock) │
    └───────────────────────┬───────────────────────┘
                            │ (Polling JQL)
                            ▼
    ┌───────────────────────────────────────────────┐
    │            SINGLETON MASTER WORKER            │
    │  Semaphore: activeJobs & MAX_CONCURRENT_JOBS  │
    └───────────────────────┬───────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
[Dự án A (Worktree A)] [Dự án B (Worktree B)] [Dự án C (Worktree C)]
```

### 1.1. Concurrency Limiter (Bảo vệ CPU/RAM)
- Sử dụng biến môi trường `MAX_CONCURRENT_JOBS` (mặc định = 2) để giới hạn số lượng tiến trình AI chạy song song.
- Dùng biến đếm `activeJobs` trong `worker.js`. Nếu `activeJobs >= MAX_CONCURRENT_JOBS`, vòng lặp quét sẽ báo log `INFO: Đầy tải` và tự động bỏ qua việc lấy thêm bug mới, giúp bảo vệ tài nguyên máy host khỏi tình trạng quá tải (đặc biệt khi Node/Maven/Claude Code ngốn nhiều RAM/CPU).
- Khi xử lý xong 1 bug, tự động nhả slot bằng cách `activeJobs--`.

### 1.2. Jira as a Queue (Hàng đợi & Distributed Lock)
- **Không lưu queue trong RAM** để tránh rủi ro mất trạng thái khi worker bị crash/restart.
- **Vòng lặp Async Polling (Chống overlap):** Sử dụng vòng lặp `async/await` quét liên tục với chu kỳ 15 giây (`setTimeout(15000)`) kết hợp cờ khoá vòng lặp `isScanning` để ngăn ngừa dội lệnh hoặc chồng chéo chu kỳ quét.
- **Trạng thái Jira-as-Queue:**
  - **To Do**: Bug mới phát hiện (gắn nhãn `auto-fix` hoặc summary chứa `[AUTO-BUG]`).
  - **In Progress**: Ticket đang được worker xử lý (gắn nhãn khoá `auto-fix-processing`).
  - **In Review**: Ticket đã được tạo PR hoàn tất (gỡ `auto-fix-processing`, gắn nhãn kết quả `auto-fix-done` hoặc `auto-fix-failed`).
- **Atomic Claim (Tranh chấp & Khoá Job):** Ngay khi worker phát hiện ticket hợp lệ, nó gọi API Jira gắn ngay nhãn `auto-fix-processing`:
  ```json
  { "update": { "labels": [{ "add": "auto-fix-processing" }] } }
  ```
- **JQL Quét Ticket:** Loại trừ ticket đang xử lý để tránh lấy trùng lặp:
  ```sql
  project = ${projectKey} AND issuetype = Bug AND status = "To Do" AND (labels = "auto-fix" OR summary ~ "\\[AUTO-BUG\\]") AND labels != "auto-fix-processing"
  ```
- Khi job hoàn tất thành công hoặc thất bại, worker gỡ nhãn `auto-fix-processing`, đồng thời gắn nhãn `auto-fix-done` hoặc `auto-fix-failed` và hoàn trả slot (`activeJobs--`).

### 1.3. Bốn Tầng Phòng Thủ An Toàn (4-Tier Safety Defense) & Fail-Safe Abort
Hệ thống đảm bảo worker tuyệt đối không can thiệp nhầm code hoặc phá hỏng dự án chéo qua 4 lớp:
1. **Tầng 1 - GlitchTip Slug:** Lỗi được GlitchTip phân loại chính xác bằng slug theo môi trường và tên project/service.
2. **Tầng 2 - Jira label `service:*`:** Webhook của Jira Automation phân tích slug và tự động gắn nhãn định danh service (vd: `service:api` hoặc `service:web`).
3. **Tầng 3 - `projects.json` mapper:** Ánh xạ từ Jira Project Key sang đường dẫn làm việc (`path`) cô lập của từng repo tương ứng (vd: `KANBAN` -> `.`, `ECOM` -> `services-2`).
4. **Tầng 4 - Git Worktree Isolation & Fail-Safe Abort:** AI tạo worktree/nhánh độc lập (`hotfix/<JIRA-KEY>`). **Fail-Safe Abort**: Nếu không tìm thấy dự án trong `projects.json`, hoặc ticket thiếu nhãn `service:*`, hoặc không định vị được thư mục thực thi, worker lập tức dừng xử lý (abort) một cách an toàn, ghi log và trả slot, tuyệt đối không can thiệp sai thư mục.
## 2. Luồng hoạt động (Level 3 Autonomous Agent)
1. **Gây lỗi & Ghi nhận (Event-Driven):** User kích hoạt lỗi từ Frontend React (`web/`) hoặc Backend Java (`api/`). Sentry SDK tự động bắt lỗi và đẩy về **GlitchTip v4.x** (Error Tracking & Triage).
2. **Tạo Ticket Tự động:** GlitchTip Alert Webhook bắn sự kiện sang **Jira Automation (Incoming Webhook)**. Jira tự động tạo Issue Bug thuộc đúng Project với tiền tố `[AUTO-BUG]` và các thông tin stack trace.
3. **Lắng nghe, Khoá Ticket & Báo động (Telegram Alert 1):**
   - `worker.js` (Singleton) liên tục quét luân phiên các dự án được cấu hình trong `projects.json`.
   - Khi phát hiện ticket mới (chưa có nhãn processing/done/failed) và `activeJobs < MAX_CONCURRENT_JOBS`:
     - Lập tức **khoá ticket** bằng cách gắn nhãn `auto-fix-processing` (Atomic Lock).
     - Tăng `activeJobs++`.
     - Gửi cảnh báo vào Telegram On-call Group kèm log file `.txt` và stack trace.
4. **Tự sửa lỗi & Tự tạo PR (Claude Code Headless):**
   - Worker đối chiếu `projectKey` qua `projects.json` để xác định thư mục `path` (hoặc `localPath`) thực thi.
   - Checkout sang nhánh `hotfix/<JIRA-KEY>` trong môi trường cô lập.
   - Chạy `claude -p` với Model và Timeout cấu hình từ `.env`.
   - Claude đọc `CLAUDE.md` nội bộ của dự án đó để biết sửa repo/service nào và quy ước commit.
   - **Xác thực commit:** `worker.js` kiểm tra và tự commit nếu cần.
   - Worker tự động push branch, mở Pull Request trên GitHub API.
   - Cuối cùng gỡ nhãn `auto-fix-processing`, gắn nhãn kết quả (`auto-fix-done` hoặc `auto-fix-failed`) và hoàn trả slot (`activeJobs--`).
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
## 2b. Cấu trúc `projects.json` & Khai báo Service
- **`projects.json`**: Cấu hình tập trung danh sách các dự án mà Singleton Master Worker quản lý:
  ```json
  {
    "projects": [
      {
        "projectKey": "KANBAN",
        "path": "."
      },
      {
        "projectKey": "ECOM",
        "path": "services-2"
      }
    ]
  }
  ```
- **Định vị thư mục:** Worker lấy `path` (hoặc `localPath`) từ `projects.json` kết hợp với nhãn `service:*` (ví dụ `service:api`) để xác định chính xác thư mục thực thi (ví dụ `services-2/api` hoặc `./api`). Nếu không định vị được, kích hoạt cơ chế **Fail-Safe Abort**.
- File `services.json` (tại thư mục root của mỗi dự án, ví dụ `services/services.json`) khai báo `deployUrl` + `healthPath` từng service (`api` dùng `/actuator/health`, `web` dùng `/`).

## 2. Quy ước Evidence & Telegram
- Bằng chứng (Evidence) cho mỗi ticket được lưu tại `evidence/<JIRA-KEY>/before/` và `evidence/<JIRA-KEY>/after/`.
- Định dạng bằng chứng: `.log`, `screenshot-*.png`, `meta.json`.
- Hàm helper quản lý bằng chứng và Telegram gom chung (`evidence.js`):
  - Alert lỗi: Gửi thông báo kèm log/evidence từ thư mục `before/`.
  - Báo done: Gửi thông báo PR thành công kèm chùm ảnh (MediaGroup) từ thư mục `after/`.

## 4. Cấu trúc thư mục PoC hiện tại
- `worker.js`: Script runner (Singleton Master Worker) duy nhất, vòng lặp `isScanning` async polling quét Jira và quản lý queue chung N dự án.
- `projects.json`: Cấu hình danh sách các dự án (`projectKey` -> `path` thư mục).
- `.env`: Cấu hình token hệ thống, định mức `MAX_CONCURRENT_JOBS` (mặc định = 2).
- `services/` (Dự án A), `services-2/` (Dự án B): Chứa mã nguồn thực tế. Mỗi dự án chứa `CLAUDE.md` nội bộ riêng biệt.
- `.claude/hooks/pre-tool-use.js`: Hook bảo vệ đa nền tảng.
