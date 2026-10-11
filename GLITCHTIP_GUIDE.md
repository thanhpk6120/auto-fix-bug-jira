# Hướng dẫn tích hợp GlitchTip & Jira Automation (Event-Driven)

Tài liệu này hướng dẫn chi tiết từng bước (step-by-step) cách đưa GlitchTip vào mô hình thiết kế hệ thống Auto-Fix Bug để làm Error Tracking & Triage trung tâm, Jira làm Message Bus, và loại bỏ hoàn toàn Dispatcher trung gian (App không còn gọi trực tiếp Jira API).

Luồng xử lý Event-Driven (Singleton Master Worker):
`[Apps: FE/BE] -> [Sentry SDK] -> [GlitchTip v4.x] -> [Webhook Alert] -> [Jira Automation Rule] -> [Jira Ticket [AUTO-BUG] + service:*] -> [worker.js (duy nhất)]`
---

## Phần 1: Cài đặt GlitchTip bằng Docker Compose

Yêu cầu hệ thống: Docker và Docker Compose (trên VPS hoặc Local).
Sử dụng cấu hình: GlitchTip v4.x, PostgreSQL 16, Redis 7.

### Bước 1.1: Tạo thư mục và sinh khóa bí mật (Secret Key)
Mở Terminal (hoặc SSH vào VPS). Các lệnh dưới đây sẽ tự động tạo thư mục, sinh một chuỗi mật khẩu ngẫu nhiên và ghi thẳng vào file cấu hình `.env` mà không cần mở file. 
Copy toàn bộ khối lệnh sau và dán (paste) vào Terminal (chuột phải hoặc `Ctrl+Shift+V`), sau đó nhấn `Enter`:

```bash
# 1. Tạo thư mục chứa dữ liệu GlitchTip
mkdir -p /opt/glitchtip && cd /opt/glitchtip

# 2. Sinh một chuỗi ngẫu nhiên làm SECRET_KEY an toàn
SECRET_KEY=$(openssl rand -hex 32)
echo "SECRET_KEY=${SECRET_KEY}" > .env
echo "GLITCHTIP_DOMAIN=http://localhost:8000" >> .env # Thay bằng IP/Domain VPS của bạn nếu cần
```

### Bước 1.2: Tạo file `docker-compose.yml`
Để tránh lỗi thiếu trình soạn thảo (`nano: command not found`), chạy khối lệnh sau (copy toàn bộ từ `cat` đến dòng `EOF` cuối cùng rồi dán vào Terminal, sau đó nhấn `Enter`):

```bash
cat > docker-compose.yml << 'EOF'
version: '3.8'

x-environment: &default-environment
  DATABASE_URL: postgres://glitchtip:glitchtip_password@postgres:5432/glitchtip
  REDIS_URL: redis://redis:6379/0
  SECRET_KEY: ${SECRET_KEY}
  PORT: 8000
  GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN} # Thay bằng domain thực tế nếu deploy
  DEFAULT_FROM_EMAIL: alerts@yourdomain.com
  EMAIL_URL: consolemail:// # Không cần SMTP, in email ra log container
  CELERY_WORKER_AUTOSCALE: "1,3"

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: glitchtip
      POSTGRES_PASSWORD: glitchtip_password
      POSTGRES_DB: glitchtip
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7
    restart: unless-stopped

  web:
    image: glitchtip/glitchtip:v4.0
    depends_on:
      - postgres
      - redis
    ports:
      - "8000:8000"
    environment: *default-environment
    command: ./bin/run-web.sh
    restart: unless-stopped

  worker:
    image: glitchtip/glitchtip:v4.0
    depends_on:
      - postgres
      - redis
    environment: *default-environment
    command: ./bin/run-celery-with-beat.sh
    restart: unless-stopped

volumes:
  postgres-data:
EOF
```
### Bước 1.3: Chạy Database Migration và Khởi động hệ thống
Chạy lần lượt 2 lệnh sau:

```bash
# 1. Khởi tạo cơ sở dữ liệu (Migration) - Lệnh này sẽ chạy và tự thoát khi xong
docker compose run --rm web ./manage.py migrate

# 2. Khởi động toàn bộ hệ thống chạy ngầm
docker compose up -d

# 3. Kiểm tra trạng thái các container (Tất cả phải là 'Up')
docker compose ps
```
Truy cập `http://localhost:8000` (hoặc IP VPS) để đăng ký tài khoản. **Tài khoản đăng ký đầu tiên sẽ tự động được cấp quyền Superuser (Admin)**.

### Tùy chọn: Dùng PostgreSQL và Redis cài sẵn (không dùng container kèm theo)
Nếu bạn đã có sẵn PostgreSQL và Redis trên máy chủ, chạy khối lệnh sau để ghi đè file `docker-compose.yml`:

```bash
cat > docker-compose.yml << 'EOF'
version: '3.8'

x-environment: &default-environment
  DATABASE_URL: postgres://<user_thật>:<password_thật>@<host_thật>:5432/<db_thật>
  REDIS_URL: redis://<host_thật>:6379/0
  SECRET_KEY: ${SECRET_KEY}
  PORT: 8000
  GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN}

services:
  web:
    image: glitchtip/glitchtip:v4.0
    ports:
      - "8000:8000"
    environment: *default-environment
    command: ./bin/run-web.sh
    restart: unless-stopped

  worker:
    image: glitchtip/glitchtip:v4.0
    environment: *default-environment
    command: ./bin/run-celery-with-beat.sh
    restart: unless-stopped
EOF
```
*(Sửa các thông tin `<user_thật>`, `<password_thật>`, `<host_thật>` trước khi dán nếu cần)*
---

## Phần 2: Cấu hình Project & Lấy DSN trên GlitchTip

1. Đăng nhập vào GlitchTip.
2. Tạo Organization mới (nếu chưa có).
3. Bấm **Create Project**.
4. Chọn nền tảng (Platform): 
   - Với Backend: Chọn **Java / Spring Boot**.
   - Với Frontend: Chọn **JavaScript / React**.
5. Nhập tên dự án và bấm **Create Project**.
6. Tại màn hình tiếp theo, copy chuỗi **DSN** (Data Source Name). DSN có định dạng: `http://<key>@localhost:8000/<project-id>`.

---

## Phần 3: Tích hợp Sentry SDK vào Ứng dụng

GlitchTip hoàn toàn tương thích với Sentry SDK. Sử dụng SDK mới nhất (v7/v8).

### 3.1. Frontend React (services/web)

Cài đặt Sentry SDK:
```bash
npm install @sentry/react @sentry/tracing
```

Trong file `index.jsx` hoặc `App.jsx` (càng sớm càng tốt):
```javascript
import React from "react";
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "YOUR_GLITCHTIP_DSN_HERE",
  tracesSampleRate: 1.0, // Cấu hình rate cho production
  environment: "development",
});

// Sử dụng Error Boundary cho React
const App = () => {
  return (
    <Sentry.ErrorBoundary fallback={<p>Đã xảy ra lỗi.</p>}>
      <YourAppComponents />
    </Sentry.ErrorBoundary>
  );
};
```

### 3.2. Backend Spring Boot (services/api)

Thêm dependency vào `pom.xml`:
```xml
<dependency>
    <groupId>io.sentry</groupId>
    <artifactId>sentry-spring-boot-starter-jakarta</artifactId>
    <version>7.3.0</version>
</dependency>
```

Cấu hình trong `application.yml` hoặc `application.properties`:
```yaml
sentry:
  dsn: YOUR_GLITCHTIP_DSN_HERE
  traces-sample-rate: 1.0
  environment: development
  exception-resolver-order: -2147483647 # Đảm bảo Sentry bắt lỗi trước các handler khác
```

---

## Phần 4: Cấu hình Jira Automation

Tạo Rule trên Jira Cloud để tự động nhận lỗi từ GlitchTip Webhook, tạo Issue và định tuyến.

1. Truy cập **Project Settings** > **Automation** > **Rules** > **Create rule**.
2. **Trigger:** Chọn **Incoming Webhook**.
   - Copy **Webhook URL**.
   - Trạng thái: Chọn "No issue provided" hoặc tuỳ cấu hình của Jira Cloud.
3. **Action:** Chọn **Create issue**.
4. Thiết lập thông số Issue với **Smart Values**:
   - **Project:** Chọn dự án hiện tại (vd: KANBAN hoặc ECOM).
   - **Issue Type:** Bug.
   - **Summary:** `[AUTO-BUG] {{webhookData.data.issue.title}}`
   - **Description:** 
     ```
     *Môi trường:* {{webhookData.data.issue.environment}}
     *Dự án:* {{webhookData.data.issue.project.name}}
     
     *Chi tiết lỗi:*
     {code}
     {{webhookData.data.issue.culprit}}
     {code}
     
     *Link chi tiết (GlitchTip):* {{webhookData.data.issue.web_url}}
     ```
   - **Labels:** Gắn cứng nhãn `auto-fix`, và tự động trích xuất service thông qua biến `service:{{webhookData.data.issue.project.name}}` (ví dụ `service:api`).
5. Lưu Rule, đặt tên (vd: `GlitchTip Auto-Fix Routing`) và bật **Turn it on**.
---

## Phần 5: Cấu hình Alert Webhook trên GlitchTip

1. Trở lại trang GlitchTip, vào **Settings** > **Projects** > Chọn project của bạn.
2. Chuyển sang tab **Alerts**.
3. Bấm **Create Alert**.
4. **Conditions:** Cấu hình khi nào thì báo động (vd: `A new issue is created` hoặc `An issue is seen more than X times`).
5. **Action:** Chọn **Webhook**.
6. Dán **Jira Webhook URL** (đã copy ở Phần 4) vào ô URL.
7. Bấm **Save**.

---

## Phần 6: Quy trình thêm dự án mới (Zero Code Change & Bốn tầng phòng thủ)

Hệ thống áp dụng kiến trúc **Singleton Master Worker**: bạn chỉ chạy **DUY NHẤT 1 file `worker.js`** phục vụ N dự án. Khi có service/dự án mới, tuyệt đối không tạo thêm worker riêng.

Quy trình 4 tầng phòng thủ an toàn:
1. **Tầng 1 (GlitchTip)**: Tạo Project mới (lấy DSN), lỗi định danh theo slug môi trường và project.
2. **Tầng 2 (Jira Automation)**: Tạo Alert Webhook trỏ vào Jira Webhook. Automation rule phân loại slug sang nhãn `service:*` (ví dụ: `service:api` hoặc `service:web`).
3. **Tầng 3 (Singleton Worker Mapping)**: Bổ sung cấu hình vào file `projects.json` gốc:
   ```json
   {
     "projects": [
       { "projectKey": "KANBAN", "path": "." },
       { "projectKey": "ECOM", "path": "services-2" }
     ]
   }
   ```
4. **Tầng 4 (Worktree Isolation & Fail-Safe Abort)**: Dựa vào `projectKey` -> `path` (từ `projects.json`) và nhãn `service:*` (từ Jira), Worker suy luận ra thư mục đích (vd: `services-2/api`). Nếu thiếu nhãn hoặc cấu hình thư mục sai lệch, **Worker sẽ Fail-Safe Abort** (huỷ bỏ ticket an toàn), tuyệt đối không sửa nhầm mã nguồn chéo repo.

*(Không cần khởi động lại worker, `projects.json` được reload tự động vào RAM).*

## Phần 7: Kiểm thử end-to-end (Test flow) & Quản trị tài nguyên

1. **Cấu hình Concurrency:** Cài biến môi trường `MAX_CONCURRENT_JOBS=2` (trong `.env`).
2. Mở ứng dụng, tạo ra một Exception chủ động (vd: throw Error).
3. Kiểm tra **GlitchTip**: Lỗi mới xuất hiện trong *Issues*.
4. Kiểm tra **Jira**: Issue tạo mới có tiền tố `[AUTO-BUG]` và các nhãn (VD: `auto-fix`, `service:web`). Ticket ở cột *To Do*.
5. Kiểm tra **Terminal**: Script `worker.js` (Singleton) phát hiện ticket, gửi Telegram alert, atomic claim ticket bằng nhãn `auto-fix-processing` (ticket chuyển *In Progress* / Lock). Worker (nếu `activeJobs < MAX_CONCURRENT_JOBS`) tự trích xuất thư mục target, nhánh cô lập (`hotfix/<JIRA-KEY>`) và sửa lỗi. Nếu đầy tải, vòng lặp Async Polling bỏ qua ticket chờ chu kỳ sau. Hoàn thành ticket, gỡ `processing`, gắn `auto-fix-done` (ticket chuyển *In Review*).
