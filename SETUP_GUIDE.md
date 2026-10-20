# SETUP_GUIDE — Hướng dẫn cài đặt & chạy Auto-Fix Worker (Level 3)

Tài liệu này là hướng dẫn **đầy đủ, tuần tự, copy-paste được** cho toàn bộ hệ thống:

```
[App FE/BE] --Sentry SDK--> [GlitchTip] --Webhook--> [Jira Automation Rule]
      --> [Jira Ticket [AUTO-BUG] + label auto-fix + label service:*]
      --> [worker.js (Singleton Master Worker)] --claude -p--> [fix + test + commit]
      --> [git push hotfix/<KEY>] --> [Pull Request] --> [Telegram duyệt Merge]
```

Bốn hệ thống phải cấu hình: **GlitchTip → Jira → Telegram → Worker (+ 4 service repo)**.

> **Bắt buộc đọc trước:**
> - **Bước 0 (B.0):** `claude -p "ping"` **phải trả lời được** trước khi làm gì khác. Worker chạy headless qua Claude Code CLI — CLI hỏng thì mọi job auto-fix đều fail.
> - `worker.js` **không tự đọc `.env`**. Phải chạy bằng `node --env-file=.env worker.js` (file `start-worker.bat` đã làm sẵn).
> - 4 thư mục source service **đang bị `.gitignore` loại bỏ** (`.gitignore:27-30`) → clone repo này về **không có mã nguồn**, phải clone 4 repo service thủ công (Bước 2).
> - Mọi secret trong tài liệu này để dạng `<PLACEHOLDER>`. **Không ghi token thật vào file hướng dẫn.** Nếu file này bị chia sẻ ra ngoài, hãy rotate token (Phụ lục F).

---

## Mục lục

| Phần | Nội dung |
|---|---|
| [A](#a-bảng-giá-trị-sẵn-có-readymade) | Bảng giá trị sẵn có (readymade) |
| [B](#b-preflight--kiểm-tra-môi-trường-trước-khi-cài) | Preflight — kiểm tra môi trường (**B.0 = Bước 0 bắt buộc: `claude -p "ping"`**) |
| [C](#c-bước-1--clone-repo-worker) | Bước 1: Clone repo worker |
| [D](#d-bước-2--clone-4-repo-service-bắt-buộc) | Bước 2: Clone 4 repo service (bắt buộc) |
| [E](#e-bước-3--tạo-file-env) | Bước 3: Tạo file `.env` |
| [F](#f-bước-4--cấu-hình-projectsjson--servicesjson) | Bước 4: Cấu hình `projects.json` + `services.json` |
| [G](#g-bước-5--setup-telegram-az) | Bước 5: Setup Telegram (A→Z) |
| [H](#h-bước-6--setup-glitchtip-docker) | Bước 6: Setup GlitchTip (Docker) |
| [I](#i-bước-7--gắn-sentry-dsn-vào-4-service) | Bước 7: Gắn Sentry DSN vào 4 service |
| [J](#j-bước-8--setup-jira-project--automation-rule) | Bước 8: Setup Jira (project + Automation Rule) |
| [K](#k-bước-9--nối-alert-webhook-glitchtip--jira) | Bước 9: Nối Alert Webhook GlitchTip → Jira |
| [L](#l-bước-10--chạy-worker) | Bước 10: Chạy worker |
| [M](#m-bước-11--kiểm-thử-end-to-end) | Bước 11: Kiểm thử end-to-end |
| [N](#n-phụ-lục-a--bảng-đầy-đủ-biến-môi-trường) | Phụ lục A: Bảng biến môi trường |
| [O](#o-phụ-lục-b--bản-đồ-ticket--service--repo) | Phụ lục B: Bản đồ ticket → service → repo |
| [P](#p-phụ-lục-c--xử-lý-sự-cố) | Phụ lục C: Xử lý sự cố |
| [Q](#q-phụ-lục-d--gotcha-đã-kiểm-chứng) | Phụ lục D: Gotcha đã kiểm chứng |
| [R](#r-phụ-lục-e--sửa-claudemd-cho-khớp-path-thật) | Phụ lục E: Sửa `CLAUDE.md` cho khớp path |
| [S](#s-phụ-lục-f--bảo-mật--rotate-secret) | Phụ lục F: Bảo mật & rotate secret |

---

## A. Bảng giá trị sẵn có (readymade)

Các giá trị dưới đây **đã có sẵn trong repo**, copy thẳng vào cấu hình. Riêng mục đánh dấu 🔒 là secret → lấy theo hướng dẫn tại nơi cấu hình, **không** ghi vào tài liệu.

### A.1. Danh tính dự án

| Mục | Giá trị | Nơi dùng |
|---|---|---|
| Jira domain | `thanhpk6120.atlassian.net` | `.env` → `JIRA_DOMAIN` |
| Jira email | `thanhpk6120@gmail.com` | `.env` → `JIRA_EMAIL` |
| Jira API token | 🔒 lấy tại `id.atlassian.com/manage-profile/security/api-tokens` | `.env` → `JIRA_TOKEN` |
| GitHub user | `thanhpk6120` | `services.json` → `gitRepo` |
| GitHub PAT | 🔒 `github.com/settings/tokens` (scope `repo`) | `.env` → `GIT_TOKEN` |
| Claude model | `claude-sonnet-5` | `.env` → `CLAUDE_MODEL` |
| Claude timeout | `300000` (5 phút) | `.env` → `CLAUDE_TIMEOUT_MS` |
| Số job AI song song | `2` | `.env` → `MAX_CONCURRENT_JOBS` |

### A.2. Bản đồ 2 dự án (Jira) ↔ 4 service (Git) ↔ port

| Jira projectKey | Thư mục trong repo | Service | Repo Git (`owner/repo`) | Cổng local | Nhãn `service:*` |
|---|---|---|---|---|---|
| `SHOP` | `services/` | `api` | `thanhpk6120/shop-api` | 8080 | `service:api` |
| `SHOP` | `services/` | `web` | `thanhpk6120/shop-web` | 5173 | `service:web` |
| `CMS` | `services-2/` | `api` | `thanhpk6120/cms-api` | 8081 | `service:api` |
| `CMS` | `services-2/` | `web` | `thanhpk6120/cms-web` | 5174 | `service:web` |

Nhánh Git cho **mọi** service: `dev = master`, `target = staging`, `prod = master`.
> **Không có bước verify trên staging.** `branches.target` được đọc vào biến (`worker.js:782`) rồi **bỏ không dùng**; PR được mở và merge thẳng vào `prod` = `master` (`worker.js:876-882`, `mergePR` dùng `prodBranch`). Không có gate an toàn kiểu "fix → staging → test → promote". Nếu cần gate, phải tự thêm ngoài worker.

### A.3. Port trong hệ thống

| Port | Dịch vụ |
|---|---|
| `8000` | GlitchTip (web) |
| `9000` | `webhook_bridge.js` (tuỳ chọn, thay cho Jira Automation Rule) |
| `8080` | shop-api (Spring Boot) |
| `8081` | cms-api (Spring Boot) |
| `5173` | shop-web (Vite) |
| `5174` | cms-web (Vite) |

---

## B. Preflight — kiểm tra môi trường trước khi cài

Chạy **từ CMD/PowerShell**, không phải trong phiên Claude Code đang mở (tránh xung đột process).

### B.0 — BƯỚC 0 (BẮT BUỘC): Claude Code CLI phải trả lời được

Worker chạy headless qua Claude Code CLI. **Nếu CLI chưa hoạt động thì toàn bộ chức năng auto-fix sẽ fail** — mọi job đều kết thúc với `Claude exited with code ...` và ticket bị gắn nhãn `auto-fix-failed`.

Chạy **trong CMD/PowerShell riêng** (không chạy từ trong phiên Claude Code đang mở):

```cmd
claude --version
claude -p "ping"
```

**Kết quả mong đợi:** lệnh trả về câu trả lời trong vài giây (ví dụ `PONG`). Nếu có → sang phần tiếp theo.

Nếu **không** trả lời, xử lý theo thông báo lỗi:

| Thông báo lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` | Endpoint của Claude CLI đang trỏ vào **relay nội bộ đã tắt** (thường qua biến `ANTHROPIC_BASE_URL=http://localhost:<port>/v1`) | **Cách 1 (khuyến nghị):** chạy `claude` (interactive) → gõ `/login` → đăng nhập bằng **OAuth** tài khoản Anthropic → thử lại `claude -p "ping"`. <br> **Cách 2:** đặt `ANTHROPIC_BASE_URL` trỏ tới **endpoint thật** rồi dùng API key thật của Anthropic. <br> **Cách 3:** khởi động lại app relay nội bộ đang phục vụ cổng đó. |
| `Invalid API key · Fix external API key` | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` là key của relay nội bộ, không phải key Anthropic thật | Dùng **Cách 1** ở trên (`claude` → `/login`). Xoá 2 biến `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` khỏi môi trường nếu chúng trỏ tới relay cũ. |
| `Not logged in · Please run /login` | Chưa đăng nhập Claude Code | Chạy `claude` (interactive) → gõ `/login` → đăng nhập → thử lại `claude -p "ping"`. |
| `command not found` | Chưa cài Claude Code | `npm i -g @anthropic-ai/claude-code` → kiểm tra `where claude`. |

> Xoá biến cũ (PowerShell, chỉ trong terminal hiện tại):
> ```powershell
> $env:ANTHROPIC_BASE_URL=''; $env:ANTHROPIC_API_KEY=''; $env:ANTHROPIC_AUTH_TOKEN=''
> ```
> Hoặc xoá vĩnh viễn: `setx ANTHROPIC_BASE_URL ""` (Windows → System Properties → Environment Variables).
>
> Sau khi đăng nhập OAuth, **worker chạy ở CMD riêng** sẽ dùng đúng credential đó. Không chạy worker từ trong phiên Claude Code đang mở (tránh kẹt process và hook).

---


### B.1. Node.js ≥ 20.6 (bắt buộc có `--env-file`)

```cmd
node -v
```
Kết quả mong đợi: `v20.6.0` trở lên (máy này: `v24.18.0`).
Nếu thấp hơn → cài Node 22 LTS: <https://nodejs.org/en/download>

### B.2. Git

```cmd
git --version
```
Kết quả mong đợi: `git version 2.4x` trở lên.

### B.3. Claude Code CLI — xác nhận lần 2

```cmd
claude --version
claude -p "Reply with exactly: PING_OK"
```

**Kết quả mong đợi:** in ra `PING_OK` trong vài giây.

> `worker.js` gọi `claude -p <prompt> --model <CLAUDE_MODEL> --dangerously-skip-permissions` (`worker.js:4`), nên **không** cần duyệt quyền thủ công khi chạy headless.

### B.4. Docker (chỉ cần nếu tự dựng GlitchTip)

```cmd
docker --version
docker compose version
```
Nếu không có → cài Docker Desktop: <https://docs.docker.com/desktop/install/windows-install/>
(Nếu dùng GlitchTip có sẵn ở hạ tầng nội bộ thì **bỏ qua** Bước 6.)

### B.5. Java + Maven (cho service Java)

```cmd
java -version
mvn -v
```
Kết quả mong đợi: Java 21 (Spring Boot 3.x yêu cầu ≥17), Maven ≥ 3.8.
Nếu thiếu Maven: `choco install maven` hoặc tải <https://maven.apache.org/download.cgi>
> Repo có sẵn `mvnw.cmd` nên **không bắt buộc** cài Maven toàn cục.

---

## C. Bước 1 — Clone repo worker

```cmd
cd /d I:\AI
git clone https://github.com/<ORG>/auto-fix-bug-jira.git
cd auto-fix-bug-jira
```

Kiểm tra:

```cmd
dir
```
Phải thấy: `worker.js`, `projects.json`, `projects.json.example`, `services.json.example`, `.env.example`, `CLAUDE.md`, `start-worker.bat`, `restart-worker.bat`, `evidence.js`, `webhook_bridge.js`, `GLITCHTIP_GUIDE.md`.

---

## D. Bước 2 — Clone 4 repo service (BẮT BUỘC)

`.gitignore` của repo worker loại bỏ 4 thư mục này (dòng 27–30):

```
services-2/cms-api/
services-2/cms-web/
services/shop-api/
services/shop-web/
```

→ Clone repo worker **không** kèm mã nguồn. Nếu thiếu, worker dừng ngay tại `worker.js:776-778`:
`[Fail-Safe Abort] Thư mục service '...' không tồn tại.`

### D.1. Clone đúng path theo `services.json`

```cmd
cd /d I:\AI\auto-fix-bug-jira

git clone https://github.com/thanhpk6120/shop-api.git  services\shop-api
git clone https://github.com/thanhpk6120/shop-web.git  services\shop-web
git clone https://github.com/thanhpk6120/cms-api.git   services-2\cms-api
git clone https://github.com/thanhpk6120/cms-web.git   services-2\cms-web
```

> Nếu repo private: dùng PAT trong URL hoặc `git config --global credential.helper manager` rồi clone lại (Git Credential Manager sẽ hỏi user/token).

### D.2. Tạo nhánh `staging` (nhánh `target`)

Các repo đã có `master`. Nếu chưa có `staging`:

```cmd
for %R in (services\shop-api services\shop-web services-2\cms-api services-2\cms-web) do git -C %R fetch origin && git -C %R push origin origin/master:staging
```

### D.3. Cấu hình remote có token (worker tự set-url, nhưng set sẵn cho chắc)

Worker tự làm `git remote set-url origin https://<TOKEN>@<host>/<repo>.git` (`worker.js:110-115`). Nếu muốn tự set:

```cmd
git -C services\shop-api remote set-url origin https://<GITHUB_TOKEN>@github.com/thanhpk6120/shop-api.git
```

### D.4. Xác minh đủ 4 repo + đúng branch

```cmd
for %R in (services\shop-api services\shop-web services-2\cms-api services-2\cms-web) do @echo === %R === & git -C %R remote -v & git -C %R branch -a
```
Mong đợi mỗi repo có: `origin/...`, `master`, `staging`.

---

## E. Bước 3 — Tạo file `.env`

`.env` **đã được gitignore** (`.gitignore:2`) → an toàn chứa secret.

```cmd
cd /d I:\AI\auto-fix-bug-jira
copy .env.example .env
notepad .env
```

### E.1. Nội dung `.env` đầy đủ (copy & điền)

```ini
# --- JIRA CONFIG ---
JIRA_DOMAIN=thanhpk6120.atlassian.net
JIRA_EMAIL=thanhpk6120@gmail.com
JIRA_TOKEN=<JIRA_API_TOKEN>

# --- CONCURRENCY CONFIG ---
MAX_CONCURRENT_JOBS=2

# --- GIT HOST CONFIG ---
GIT_HOST=github.com
GIT_TOKEN=<GITHUB_PAT>
# GIT_API_BASE_URL=          # bỏ trống nếu dùng GitHub API; điền nếu dùng GitLab/Gitea

# --- CLAUDE CONFIG ---
CLAUDE_MODEL=claude-sonnet-5
CLAUDE_TIMEOUT_MS=300000
GIT_AUTHOR_NAME=AI Bug Fixer
GIT_AUTHOR_EMAIL=ai-bot@local.dev

# --- TELEGRAM CONFIG ---
TELEGRAM_BOT_TOKEN=<BOT_TOKEN>
TELEGRAM_CHAT_ID=<CHAT_ID>
TELEGRAM_ALLOWED_USER_IDS=<USER_ID_1>,<USER_ID_2>
```

### E.2. Lấy từng giá trị ở đâu

| Biến | Cách lấy |
|---|---|
| `JIRA_TOKEN` | <https://id.atlassian.com/manage-profile/security/api-tokens> → **Create API token** → copy (dạng `ATATT3x...`). Cần email + token để Basic Auth. |
| `GIT_TOKEN` | <https://github.com/settings/tokens> → **Generate new token (classic)** → tick `repo` + `workflow` → copy (`ghp_...`). Token này **còn** được nhúng vào URL remote của 4 service repo (xem D.3) → coi như secret. |
| `TELEGRAM_BOT_TOKEN` | Làm ở **Bước 5** → sinh sau. |
| `TELEGRAM_CHAT_ID` | Làm ở **Bước 5** → sinh sau. |
| `TELEGRAM_ALLOWED_USER_IDS` | Làm ở **Bước 5** → sinh sau. |

> Bỏ trống `TELEGRAM_*` → worker **vẫn chạy**, chỉ mất chức năng duyệt Merge & báo cáo. Telegram là bắt buộc nếu muốn duyệt PR bằng nút bấm.

### E.3. Kiểm tra `.env` đã nạp đúng

```cmd
node --env-file=.env -e "console.log('domain=',process.env.JIRA_DOMAIN,'| jobs=',process.env.MAX_CONCURRENT_JOBS,'| model=',process.env.CLAUDE_MODEL,'| telegram=',!!process.env.TELEGRAM_BOT_TOKEN)"
```
Mong đợi: `domain= thanhpk6120.atlassian.net | jobs= 2 | model= claude-sonnet-5 | telegram= true`

> **Không** kiểm tra bằng `node -e` (không có `--env-file`) — sẽ ra `undefined` và tưởng sai.

### E.4. Test token trước khi chạy worker

```cmd
node --env-file=.env -e "const a='Basic '+Buffer.from(process.env.JIRA_EMAIL+':'+process.env.JIRA_TOKEN).toString('base64');fetch('https://'+process.env.JIRA_DOMAIN+'/rest/api/3/myself',{headers:{Authorization:a}}).then(async r=>{console.log('Jira HTTP',r.status, r.ok?(await r.json()).emailAddress:await r.text())})"
```
Mong đợi: `Jira HTTP 200 thanhpk6120@gmail.com`

```cmd
node --env-file=.env -e "const t=process.env.GIT_TOKEN||process.env.GITHUB_TOKEN;fetch('https://api.github.com/user',{headers:{Authorization:'Bearer '+t,'User-Agent':'x'}}).then(async r=>{console.log('GitHub HTTP',r.status, r.ok?(await r.json()).login:await r.text())})"
```
Mong đợi: `GitHub HTTP 200 thanhpk6120`
> `GIT_TOKEN || GITHUB_TOKEN` — worker nhận cả hai tên (`worker.js:94`). `.env` hiện tại chỉ có `GITHUB_TOKEN`, nên nếu chỉ đọc `GIT_TOKEN` sẽ ra 401 dù token hoàn toàn hợp lệ.

---

## F. Bước 4 — Cấu hình `projects.json` + `services.json`

### F.1. `projects.json` (ở root repo worker)

Nội dung hiện tại đã đúng — kiểm tra lại:

```json
{
  "projects": [
    {
      "projectKey": "SHOP",
      "path": "services",
      "name": "SHOP (Main Service)",
      "description": "services/shop-api (Spring Boot 8080) và services/shop-web (React Vite 5173)"
    },
    {
      "projectKey": "CMS",
      "path": "services-2",
      "name": "CMS (Service 2)",
      "description": "services-2/cms-api (Spring Boot 8081) và services-2/cms-web (React Vite 5174)"
    }
  ]
}
```

Quy tắc: `projectKey` = key Jira, `path` = thư mục chứa `services.json` + code service.
> `projectKey` ở đây **không** phải `KANBAN`/`ECOM` như trong `projects.json.example` — phải khớp với key Jira thật (`SHOP`, `CMS`), nếu không JQL sẽ không ra ticket nào.

### F.2. `services/services.json`

```json
{
  "services": [
    {
      "name": "api",
      "path": "shop-api",
      "gitRepo": "thanhpk6120/shop-api",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    },
    {
      "name": "web",
      "path": "shop-web",
      "gitRepo": "thanhpk6120/shop-web",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    }
  ]
}
```

### F.3. `services-2/services.json`

```json
{
  "services": [
    {
      "name": "api",
      "path": "cms-api",
      "gitRepo": "thanhpk6120/cms-api",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    },
    {
      "name": "web",
      "path": "cms-web",
      "gitRepo": "thanhpk6120/cms-web",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    }
  ]
}
```

Ràng buộc bắt buộc (worker kiểm tra và **Fail-Safe Abort** nếu sai — `worker.js:771-773`):
- `gitRepo` phải có (định dạng `owner/repo`).
- `branches.dev` và `branches.prod` phải có.
- `path` phải khớp đúng thư mục đã clone ở Bước 2.

### F.4. Kiểm tra nhanh

```cmd
node -e "const fs=require('fs');for(const p of ['projects.json','services/services.json','services-2/services.json']){JSON.parse(fs.readFileSync(p,'utf8'));console.log('OK',p)}"
```

---

## G. Bước 5 — Setup Telegram (A→Z)

**Code Telegram đã có sẵn trong `worker.js`** (không cần sửa code):

| Chức năng | Hàm | Dòng |
|---|---|---|
| Gửi tin nhắn text (HTML) | `sendTelegramMessage` | `worker.js:343` |
| Gửi file log (evidence) | `sendTelegramDocument` | `worker.js:361` *(dead code — không được gọi ở đâu)* |
| Gửi ảnh (MediaGroup) | `sendEvidenceToTelegram` trong `evidence.js` | `evidence.js:35` |
| Sửa nội dung message (nút bấm) | `editMessageText` | `worker.js:388` |
| Phản hồi callback (toast) | `answerCallbackQuery` | `worker.js:378` |
| Long-polling nhận nút bấm | `pollTelegramUpdates` | `worker.js:402` |
| Nút **🔀 Merge PR** | `merge\|<pr>\|<branch>` | `worker.js:430` |
| Nút **⏳ Lưu vào hàng đợi** | `defer\|<pr>\|<branch>\|<issue>` | `worker.js:472` |
| Nút **📋 Xem danh sách đợi Merge** | `list_pending` | `worker.js:493` |
| Phân quyền người duyệt | `TELEGRAM_ALLOWED_USER_IDS` | `worker.js:425` |

### ⚠️ Trạng thái hiện tại: Telegram **đang TẮT**

File `.env` hiện tại **không có** biến `TELEGRAM_*` → `pollTelegramUpdates()` return ngay (`worker.js:403`) và `sendTelegramMessage()` trả `null` (`worker.js:344`). Worker vẫn chạy và vẫn tự fix lỗi, nhưng:
- **không** có tin nhắn báo "PR đã tạo" → không có nút Merge → **PR phải mở thủ công** trên GitHub;
- **không** có tin nhắn báo lỗi/timeout (xem mục L.5(a)).

→ Làm Bước 5 để bật.

### 4 điểm dễ sai

1. **`TELEGRAM_ALLOWED_USER_IDS` là user ID của người BẤM nút, KHÔNG phải chat ID.** Để trống → `ALLOWED_USER_IDS = []` → **mọi** nút bị chặn với `⛔ Bạn không có quyền duyệt tác vụ này!` (`worker.js:425-428`).
2. **`TELEGRAM_CHAT_ID` của nhóm/supergroup có dạng `-100...`** (chat riêng thì số dương). Bot **phải được add vào nhóm** mới nhận được tin.
3. **Worker CHỈ xử lý `callback_query`** (nút bấm inline) — `worker.js:410-412`. Tin nhắn text thường (`/start`, `/status`, gõ tay) **bị bỏ qua hoàn toàn**. Không có lệnh text nào.
4. **Chỉ 1 consumer được `getUpdates`.** Worker tự long-poll `getUpdates` (`worker.js:405`) → chạy 2 worker cùng token sẽ tranh nhau, mỗi bên nhận một phần update (bot im lặng với nút bấm). Lấy `chat_id` bằng `getUpdates` **trước khi** bật worker.
   > Không cần tắt privacy mode: worker chỉ gửi tin + nhận `callback_query`, không đọc message thường.

> Gửi ảnh evidence: chỉ file có prefix `screenshot` + đuôi `.png` mới được gửi (`evidence.js:41`). `sendMediaGroup` cần **2–10 ảnh** — Telegram trả lỗi 400 nếu chỉ có 1 ảnh (`evidence.js:55-65`).

### G.1. Tạo bot

1. Mở Telegram (desktop/mobile) → tìm `@BotFather` (bot chính thức, tick xanh) → **Start**.
2. Gõ `/newbot` → Enter.
3. Nhận **tên hiển thị** của bot, ví dụ: `SHOP AutoFix Bot`.
4. Nhận **username** của bot, bắt buộc kết thúc bằng `bot`, ví dụ: `shop_autofix_bot`.
5. BotFather trả về **HTTP API token**, dạng:
   ```
   1234567890:AAH1aV...r8sXk
   ```
   → copy nguyên văn (giữ dấu `:`) → điền vào `TELEGRAM_BOT_TOKEN` trong `.env`.

### G.2. Tạo nhóm On-call (khuyến nghị) và lấy CHAT_ID

1. Tạo nhóm Telegram (ví dụ `SHOP On-call`), thêm **bot** vào nhóm (nên đặt quyền **Admin** để bot đọc được tin nhắn trong nhóm).
2. Trong nhóm, gửi một tin nhắn bất kỳ, ví dụ: `worker test`.
3. Mở terminal, dán (thay `<BOT_TOKEN>`):

```cmd
curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates?offset=-1"
```

4. Trong JSON trả về, tìm:
   ```json
   "chat": { "id": -1001234567890, "type": "supergroup", "title": "SHOP On-call" }
   ```
   → `chat.id` (số âm với nhóm/supergroup, số dương với chat riêng) chính là `TELEGRAM_CHAT_ID`.

> Nếu kết quả `{"ok":true,"result":[]}` → bot chưa nhận được message nào. Nhắn thêm 1 tin trong nhóm rồi chạy lại lệnh (chờ vài giây).
> Nếu lỗi `409 Conflict` → bot đang được chạy ở nơi khác với cùng token (ví dụ worker cũ chưa tắt) → tắt hết rồi thử lại.
> **Chạy lệnh `getUpdates` này TRƯỚC khi bật worker.** Worker tự long-poll `getUpdates` (`worker.js:405`) — chạy song song 2 consumer sẽ tranh nhau queue, mỗi bên chỉ nhận được một phần update.

### G.3. Lấy USER ID của người được phép duyệt

1. Trong Telegram, mở `@userinfobot` → **Start** → bot trả về `Id: 123456789`, `First name: ...`.
2. Lấy `Id` đó → điền vào `TELEGRAM_ALLOWED_USER_IDS` (nhiều người thì phân cách bằng dấu phẩy, không khoảng trắng):
   ```ini
   TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
   ```
3. Kiểm tra danh sách bot trong nhóm: mở nhóm → member list → xác nhận bot đã vào.

> Chỉ user id nằm trong `TELEGRAM_ALLOWED_USER_IDS` mới bấm được nút Merge; user khác bấm sẽ nhận `⛔ Bạn không có quyền duyệt tác vụ này!` (`worker.js:425-428`).

### G.4. Kiểm tra bot sống (2 lệnh)

```cmd
curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"
```
Mong đợi: `{"ok":true,"result":{"id":...,"username":"shop_autofix_bot",...}}`

Gửi tin thử:
```cmd
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage" -H "Content-Type: application/json" -d "{\"chat_id\":<CHAT_ID>,\"text\":\"AutoFix worker test OK\"}"
```
Mong đợi: `{"ok":true,...}` và tin nhắn hiện trong nhóm.

### G.5. Cấu hình `.env` hoàn tất

```ini
TELEGRAM_BOT_TOKEN=1234567890:AAH1aV...r8sXk
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

### G.6. (Tuỳ chọn) Bot cần quyền đọc message trong nhóm

Nếu nhóm **đã bật** chế độ "Restricted" (chỉ admin thêm bot) → vào nhóm → quản trị nhóm → **Quyền admin** → bật **Đọc tin nhắn**. Nút inline vẫn hoạt động dù bot là thành viên thường.

---

## H. Bước 6 — Setup GlitchTip (Docker)

> Nếu hạ tầng đã có sẵn GlitchTip (VD trong môi trường nội bộ) → **bỏ qua Bước 6**, sang thẳng Bước 7 với host/DSN do admin cấp.

### H.1. Chuẩn bị thư mục + secret key

```bash
mkdir -p /opt/glitchtip && cd /opt/glitchtip
SECRET_KEY=$(openssl rand -hex 32)
echo "SECRET_KEY=${SECRET_KEY}" > .env
echo "GLITCHTIP_DOMAIN=http://<DOMAIN_OR_IP>:8000" >> .env
```

### H.2. Tạo `docker-compose.yml`

```bash
cat > docker-compose.yml << 'EOF'
version: '3.8'

x-environment: &default-environment
  DATABASE_URL: postgres://glitchtip:glitchtip_password@postgres:5432/glitchtip
  REDIS_URL: redis://redis:6379/0
  SECRET_KEY: ${SECRET_KEY}
  PORT: 8000
  GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN}
  DEFAULT_FROM_EMAIL: alerts@yourdomain.com
  EMAIL_URL: consolemail://
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

### H.3. Migrate + khởi động

```bash
docker compose run --rm web ./manage.py migrate
docker compose up -d
docker compose ps
```
Mong đợi: `postgres`, `redis`, `web`, `worker` đều `Up`.

### H.4. Tạo tài khoản + project (lấy DSN)

1. Mở `http://<DOMAIN_OR_IP>:8000` → **đăng ký** (tài khoản đầu tiên tự động là **superuser**).
2. Tạo **Organization**.
3. **Create Project** → chọn platform:
   - Backend Spring Boot → **Java / Spring Boot**
   - Frontend React → **JavaScript / React**
4. Đặt tên project theo quy ước slug để Automation Rule đọc được:
   - `SHOP-be` (backend shop), `SHOP-fe` (frontend shop)
   - `CMS-be`, `CMS-fe`
5. Sau khi tạo → copy **DSN**, dạng:
   ```
   http://<PROJECT_KEY>@<GLITCHTIP_HOST>:8000/<PROJECT_ID>
   ```
   ⚠️ **Không ghi DSN thật vào tài liệu** — điền vào cấu hình service ở Bước 7.

---

## I. Bước 7 — Gắn Sentry DSN vào 4 service

DSN lấy từ Bước 6 (hoặc do admin cấp). Mỗi project GlitchTip = 1 DSN riêng.

| Service | Loại | File cần sửa | Biến | Giá trị |
|---|---|---|---|---|
| `services/shop-api` | Spring Boot | `src/main/resources/application.properties` | `sentry.dsn` | `<DSN_PROJECT_SHOP_BE>` |
| `services/shop-web` | Vite React | `.env` (file `.env` của Vite, đã tồn tại) | `VITE_SENTRY_DSN` | `<DSN_PROJECT_SHOP_FE>` |
| `services-2/cms-api` | Spring Boot | `src/main/resources/application.properties` | `sentry.dsn` | `<DSN_PROJECT_CMS_BE>` |
| `services-2/cms-web` | Vite React | `src/main.jsx` — **chưa có file `.env`**, phải tạo | `VITE_SENTRY_DSN` | `<DSN_PROJECT_CMS_FE>` |

> Lưu ý: `cms-web` **không có** `application.properties` (đây là Vite React, không phải Spring Boot) và **không có** file `.env` sẵn → phải tạo `services-2/cms-web/.env`.
> Phiên bản SDK khác nhau: `shop-web` dùng `@sentry/react ^11.6.0`, `cms-web` dùng `@sentry/react ^8.34.0`. Cả hai đều hợp lệ — không cần đồng nhất.

### I.1. Backend Spring Boot (2 repo `api`)

**a) Dependency** — kiểm tra `pom.xml` đã có chưa:

```xml
<dependency>
    <groupId>io.sentry</groupId>
    <artifactId>sentry-spring-boot-starter-jakarta</artifactId>
    <version>7.14.0</version>
</dependency>
```
Nếu thiếu → thêm vào `<dependencies>`.

**b) `application.properties`**

```properties
server.port=8080
server.forward-headers-strategy=framework
spring.application.name=poc-backend-service
sentry.dsn=<DSN_PROJECT_SHOP_BE>
```

> `shop-api` không có dependency `spring-boot-starter-actuator` → **không** dùng `/actuator/health` để health-check. Dùng `GET /api/calculate` hoặc port check.

### I.2. Frontend React (2 repo `web`)

**a) Dependency** — kiểm tra `package.json` đã có chưa (giữ nguyên version sẵn có của từng repo):

```json
// services/shop-web/package.json
"@sentry/react": "^11.6.0"
// services-2/cms-web/package.json
"@sentry/react": "^8.34.0"
```

**b) Khởi tạo Sentry** — `src/main.jsx` (cả 2 repo):

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/react'
import App from './App.jsx'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,   // KHÔNG hardcode fallback trong code
  environment: 'development',
})
```
> **Bỏ** chuỗi DSN fallback hardcode sẵn có trong `main.jsx` (dạng `|| "http://...@...:8000/2"` ở `shop-web`, `/4` ở `cms-web`). DSN là thông tin định danh dự án — để trong code là lộ DSN qua bundle. Chuyển hết sang biến môi trường (xem Phụ lục F).
>
> `cms-web` hiện còn có `Sentry.browserTracingIntegration()` + `Sentry.replayIntegration()` + `tracesSampleRate: 1.0`. Giữ nguyên nếu muốn có tracing/replay; chỉ sửa dòng `dsn`.

**c) File `.env` của Vite**

`services/shop-web/.env` — **đã tồn tại**, sửa lại:

```ini
VITE_SENTRY_DSN=<DSN_PROJECT_SHOP_FE>
```

`services-2/cms-web/.env` — **chưa tồn tại**, tạo mới:

```cmd
type nul > services-2\cms-web\.env
notepad services-2\cms-web\.env
```

```ini
VITE_SENTRY_DSN=<DSN_PROJECT_CMS_FE>
```

> `.env` của Vite **phải** nằm ở thư mục gốc của từng repo web (cạnh `package.json`), không phải ở root repo worker.

### I.3. Kiểm tra DSN hoạt động

```cmd
cd services\shop-web
npm install
npm run dev
```
Mở `http://localhost:5173`, cố tình throw lỗi trong console (`throw new Error('DSN test')`) → vào GlitchTip, kiểm tra project có issue mới.

---

## J. Bước 8 — Setup Jira (project + Automation Rule)

### J.1. Project Jira

- Project `SHOP` (đã có, tên `P1-SHOP`) và `CMS` (`P2-CMS`).
- Issue type `Bug` phải tồn tại.
- Workflow hiện có các trạng thái: `Backlog`, `Selected for Development`, `In Progress`, `Done`.
  > Worker chỉ quét ticket ở trạng thái: `"To Do"`, `"Selected for Development"`, `"Backlog"` (`worker.js:636`).
  > Nếu workflow của bạn không có `To Do`, dùng `Backlog` hoặc `Selected for Development`.

### J.2. Tạo Automation Rule (nhận webhook từ GlitchTip)

Vào **Project Settings → Automation → Rules → Create rule**:

1. **Trigger:** `Incoming Webhook` → copy **Webhook URL** (dạng `https://<domain>.atlassian.net/automation/...`) → lưu lại, sẽ dán vào GlitchTip ở Bước 9.
2. **Action:** `Create issue`.
3. Thông số issue bằng **Smart Values**:

| Trường | Giá trị |
|---|---|
| Project | `SHOP` (hoặc `CMS`) |
| Issue Type | `Bug` |
| Summary | `[AUTO-BUG] {{webhookData.data.issue.title}}` |
| Description | xem bên dưới |
| **Labels** | `auto-fix` + `service:api` hoặc `service:web` (xem bên dưới) |

**Description** (copy nguyên):

```
*Môi trường:* {{webhookData.data.issue.environment}}
*Dự án:* {{webhookData.data.issue.project.name}}

*Chi tiết lỗi:*
{code}
{{webhookData.data.issue.culprit}}
{code}

*Link chi tiết (GlitchTip):* {{webhookData.data.issue.web_url}}
```

4. **Labels — quan trọng nhất.** Worker dùng 2 nhãn:
   - `auto-fix` → đánh dấu "ticket này dành cho bot" (JQL cũng chấp nhận `summary ~ "AUTO-BUG"`).
   - `service:api` hoặc `service:web` → **bắt buộc**, dùng để định tuyến tới đúng thư mục mã nguồn.
     Thiếu nhãn này → worker dừng: `[Fail-Safe Abort] Ticket ... không có nhãn 'service:*'` (`worker.js:744-746`).

   Smart Values có thể tự trích `service:{{...}}`, nhưng dễ sai. **Khuyến nghị tạo 2 rule riêng** (mỗi rule 1 nhãn cứng) cho mỗi project:
   - Rule `SHOP Backend` → labels `auto-fix`, `service:api`
   - Rule `SHOP Frontend` → labels `auto-fix`, `service:web`
   - Tương tự cho `CMS`.

5. **Bật rule:** nút trên cùng → *Turn it on*.

### J.3. (Tuỳ chọn) Thay Jira Automation bằng `webhook_bridge.js`

Repo có sẵn bridge tự tạo ticket (dành cho ai không dùng được Jira Automation):

```cmd
cd /d I:\AI\auto-fix-bug-jira
npm install express
node --env-file=.env webhook_bridge.js
```
- Lắng nghe `http://127.0.0.1:9000/webhook/:projectKey` (VD `.../webhook/SHOP`).
- Tự suy luận `service:*` từ tên project GlitchTip: slug chứa `-fe` → `service:web`, chứa `-be` → `service:api` (`webhook_bridge.js:24-30`).
- Trong GlitchTip, đặt URL webhook là `http://<HOST_CỦA_BRIDGE>:9000/webhook/SHOP`.
- Ưu điểm: không cần Jira Automation. Nhược điểm: bridge phải chạy 24/7 và chỉ chạy trong mạng nội bộ.

---

## K. Bước 9 — Nối Alert Webhook GlitchTip → Jira

Trong GlitchTip: **Settings → Projects → chọn project → tab Alerts → Create Alert**

| Trường | Giá trị |
|---|---|
| Name | `Auto-Fix → Jira` |
| Conditions | `A new issue is created` (hoặc `An issue is seen more than X times` → X=1) |
| Action | `Webhook` |
| URL | **Webhook URL** đã copy ở J.2 bước 1 |
| Send initial data | bật (để có `issue.title`, `issue.culprit`, `issue.web_url`) |

Lặp lại cho từng project (SHOP-be, SHOP-fe, CMS-be, CMS-fe).

> Nếu dùng `webhook_bridge.js` thì URL điền `http://<HOST>:9000/webhook/<PROJECT_KEY>`.

---

## L. Bước 10 — Chạy worker

### L.1. Kiểm tra lần cuối trước khi chạy

```cmd
cd /d I:\AI\auto-fix-bug-jira
node --env-file=.env -e "console.log('domain',!!process.env.JIRA_DOMAIN,'| token',!!process.env.JIRA_TOKEN,'| git',!!(process.env.GIT_TOKEN||process.env.GITHUB_TOKEN),'| telegram',!!process.env.TELEGRAM_BOT_TOKEN,'| chat',!!process.env.TELEGRAM_CHAT_ID,'| users',!!process.env.TELEGRAM_ALLOWED_USER_IDS)"
```
Mong đợi tất cả là `true` (trừ `telegram`/`chat`/`users` nếu bạn cố ý bỏ Telegram — khi đó tính năng duyệt Merge sẽ không dùng được).
> `GIT_TOKEN` và `GITHUB_TOKEN` là hai tên cho cùng một giá trị; worker nhận cả hai (`worker.js:94`). Dùng `GIT_TOKEN` cho khớp `.env.example`.

Kiểm tra 4 thư mục service tồn tại:
```cmd
dir services\shop-api services\shop-web services-2\cms-api services-2\cms-web
```

### L.2. Chạy bằng script có sẵn (khuyến nghị)

```cmd
cd /d I:\AI\auto-fix-bug-jira
start-worker.bat
```
Script sẽ: `cd /d %~dp0` (đúng CWD) → `node --env-file=.env worker.js` → giữ cửa sổ mở để xem log.

### L.3. Log khởi động mong đợi

```
🚀 Singleton Master Worker Level 3 đã sẵn sàng...
• MAX_CONCURRENT_JOBS: 2
[+] Đang quét Jira cho dự án SHOP...
[+] Tìm thấy 0 bug cho dự án SHOP
[+] Đang quét Jira cho dự án CMS...
[+] Tìm thấy 0 bug cho dự án CMS
```
Lặp lại mỗi **15 giây** (`worker.js:957`).

### L.4. Restart / dừng worker

```cmd
restart-worker.bat
```
`restart-worker.bat` kill tiến trình `node worker.js` cũ rồi mở cửa sổ mới. Dừng: đóng cửa sổ CMD, hoặc:
```cmd
taskkill /F /FI "WINDOWTITLE eq Jira-AutoFix-Worker*" /T
```

> **Chỉ chạy 1 worker.** Hai worker cùng chạy sẽ tranh nhãn `auto-fix-processing` (may mắc, còn lại bỏ qua) — nhưng vẫn nên tránh.
> **Chạy worker ở CMD riêng**, không chạy từ trong phiên Claude Code (tránh kẹt process/hook).
> ⚠️ **Sửa `projects.json` / `services.json` phải restart worker.** Worker đọc `projects.json` **đúng 1 lần lúc khởi động** (`worker.js:31-34`) → không có cơ chế reload tự động. (`GLITCHTIP_GUIDE.md:258` nói ngược lại — tài liệu đó sai.)
> ⚠️ **Hook `.claude/hooks/pre-tool-use.js` hiện KHÔNG có hiệu lực.** Hook chỉ chạy khi được đăng ký trong `.claude/settings.json`, mà repo worker **chưa có** file này. Tức là bảo vệ chặn `rm -rf` / `.env` / `worker.js` **đang tắt**. Muốn bật, tạo `.claude/settings.json`:
> ```json
> {
>   "hooks": {
>     "PreToolUse": [
>       { "matcher": "*", "hooks": [{ "type": "command", "command": "node .claude/hooks/pre-tool-use.js" }] }
>     ]
>   }
> }
> ```
> Lưu ý: hook chặn theo **mẫu chuỗi** trong argv + JSON của tool → cũng chặn nhầm khi AI đọc/ghi file có tên chứa `.env` (vd `.env.example`).

### L.5. Worker đang làm gì mỗi vòng 15s

1. Với mỗi project trong `projects.json` → gọi Jira JQL (`worker.js:636`):
   ```
   project = <KEY> AND issuetype = Bug
     AND status IN ("To Do", "Selected for Development", "Backlog")
     AND (labels = "auto-fix" OR summary ~ "AUTO-BUG")
     AND labels != "auto-fix-processing" AND labels != "auto-fix-done" AND labels != "auto-fix-failed"
   ```
   → lấy **tối đa 1 ticket / project / vòng**.
2. Gắn nhãn `auto-fix-processing` (khoá atomics).
3. Đọc nhãn `service:*` → suy ra thư mục service qua `services.json`.
4. Tạo git worktree `.worktrees/hotfix/<ISSUE_KEY>` từ `origin/<dev>` → copy `CLAUDE.md` vào → chạy Claude 2 vòng:
   - **Repro**: prompt = `Bug: ${summary}` + hướng dẫn repro (`worker.js:849`). Claude chạy trong worktree, nên evidence AI ghi nằm ở `<service>/.worktrees/hotfix/<KEY>/evidence/...` — **không** phải thư mục evidence của worker, và bị xoá khi worktree được dọn.
   - **Fix** (sửa code + chạy lệnh test + tự `git commit` theo Conventional Commits).
5. Kiểm tra diff có thật sự đổi mã nguồn (`src/`, `.java`, `.js`, `.ts`, `.pom.xml`, `package.json`) → nếu không có thì **không** tạo PR rác.
6. `git push -u <remote> hotfix/<KEY> --force` → mở PR vào nhánh `prod` (`master`).
7. Gửi Telegram kèm nút **🔀 Merge PR** / **⏳ Lưu vào hàng đợi** + link PR; ghi vào `pending-prs.json`; comment lên Jira.
8. Gỡ nhãn `auto-fix-processing`, thêm `auto-fix-done` (thành công) hoặc `auto-fix-failed` (lỗi).

> ⚠️ **Hai giới hạn thực tế cần biết trước khi vận hành:**
>
> **(a) Worker KHÔNG gửi Telegram khi job fail.** `processBugWrapper` (`worker.js:681-686`) chỉ gắn nhãn `auto-fix-failed` + comment trên Jira. **Không** có tin nhắn Telegram báo lỗi/timeout. Muốn biết job fail → xem nhãn trên Jira hoặc log terminal, **đừng chờ tin nhắn Telegram**.
>
> **(b) Bước kiểm tra "repro phải có evidence" luôn pass.** Worker tự tạo sẵn `evidence/<KEY>/before/<KEY>_error.txt` từ Jira description **trước** khi gọi Claude (`worker.js:842-844`), rồi kiểm tra chính thư mục đó khác rỗng (`worker.js:856-859`) → luôn đạt. Đây là **known gap**, không phải cơ chế chặn repro. Lệnh thực sự có tác dụng là dừng khi AI in ra `[AI_STOP] REPRO_FAILED` (`worker.js:851-854`).
>
> **(c) `evidence/<KEY>/after/` luôn rỗng.** Worker chỉ gọi `sendEvidenceToTelegram(...,'before',...)` một lần (`worker.js:861`). Không có "Alert 2: gửi evidence sau khi fix" như mô tả trong `README.md` — đó là tài liệu cũ, không phải hành vi hiện tại.

> ⚠️ **Jira Description KHÔNG được truyền cho Claude.** Prompt chỉ chứa `summary` (`worker.js:849`); description chỉ được ghi ra file `<KEY>_error.txt` ở thư mục evidence của worker (ngoài worktree → AI không đọc được).
> → **Đặt toàn bộ thông tin quan trọng vào SUMMARY của ticket**: endpoint bị lỗi, stack trace, service, URL. Không dựa vào Description.

---

## M. Bước 11 — Kiểm thử end-to-end

### M.1. Tạo ticket thử (nhanh nhất, không qua GlitchTip)

Trong Jira, tạo issue:
- Project `SHOP`, type `Bug`
- Summary: `[AUTO-BUG] Divide by zero at GET /api/calculate — ArithmeticException: / by zero (service:api)` → **nhét hết thông tin lỗi vào Summary** (xem cảnh báo ở L.5)
- Labels: `auto-fix`, `service:api`
- Status: `Backlog` (hoặc `Selected for Development`)

> Dùng `summary ~ "AUTO-BUG"` cũng kích hoạt được, nhưng **vẫn phải có** nhãn `service:api`.
> ⚠️ **Phải tạo ticket MỚI.** Ticket cũ `SHOP-1`/`SHOP-2` đã mang nhãn `auto-fix-done` / `auto-fix-failed` → JQL loại trừ → worker **bỏ qua**. Nếu muốn chạy lại ticket cũ thì phải **xoá 3 nhãn** `auto-fix-processing`, `auto-fix-done`, `auto-fix-failed`.
> ⚠️ **Tên trạng thái phải khớp chính xác.** JQL lọc `status IN ("To Do", "Selected for Development", "Backlog")`. Workflow SHOP/CMS hiện có `Backlog`, `Selected for Development`, `In Progress`, `Done` — **không có `To Do`**. Nếu ticket nằm ở `In Progress`/`Done` → worker không thấy. Chuyển về `Backlog` trước khi test.
>
> 💡 Nếu "Tìm thấy 0 bug" mà bạn thấy rõ ticket trên UI → chạy lệnh kiểm tra JQL ở Phụ lục D mục D.4 để xem chính xác nguyên nhân (thiếu label? sai status? thiếu issuetype Bug?).

### M.2. Theo dõi

| Nơi | Mong đợi |
|---|---|
| CMD worker | `[+] Giao việc thành công: SHOP-x` → `Bước 1: Repro Bug` → `Bước 2: Fix Bug` → `Đã tự động mở Pull Request` |
| Jira | Issue chuyển nhãn `auto-fix-processing` → `auto-fix-done`; có comment "✅ [Auto-Fix Bot] Đã tạo Pull Request…" |
| Telegram | Tin "🚨 LỖI MỚI PHÁT HIỆN & REPRO" (kèm log) rồi "🚀 ĐÃ FIX & TẠO PR THÀNH CÔNG!" kèm 2 nút |
| `evidence/<KEY>/before/` | Có `<KEY>_error.txt` (tự tạo từ Jira description). Evidence do AI ghi nằm ở `<service>/.worktrees/hotfix/<KEY>/evidence/` và bị xoá khi dọn worktree. Thư mục `after/` luôn rỗng. |
| GitHub | PR `[Auto-Fix] SHOP-x: ...` từ `hotfix/SHOP-x` → `master` |
| `pending-prs.json` | Thêm entry PR mới |

### M.3. Duyệt Merge từ Telegram

Bấm **🔀 Merge PR** → worker gọi GitHub API merge (`worker.js:316-341`) → thông báo "🎉 Đã Merge thành công PR #n".
Nếu PR có **conflict** → worker tự gọi Claude gỡ conflict rồi merge lại (`worker.js:518-560`).
Bấm **⏳ Lưu vào hàng đợi** → lưu vào `pending-prs.json`, sau đó bấm **📋 Xem danh sách đợi Merge** để merge từ danh sách.

### M.4. Test đầy đủ qua GlitchTip

1. Chạy `shop-api` (`8080`) và `shop-web` (`5173`).
2. Mở web → gọi endpoint lỗi (`http://localhost:8080/api/calculate`).
3. GlitchTip phải hiện issue mới (project tương ứng).
4. Alert webhook → Jira Automation → tạo ticket `[AUTO-BUG] ...` với nhãn `auto-fix` + `service:api`.
5. Worker tự xử lý như M.2.

---

## N. Phụ lục A — Bảng đầy đủ biến môi trường

Biến nào worker thực sự đọc (đã kiểm tra trong `worker.js`):

| Biến | Bắt buộc | Mặc định | Dòng | Vai trò |
|---|---|---|---|---|
| `JIRA_DOMAIN` | ✅ | — | 67 | Domain Jira Cloud |
| `JIRA_EMAIL` | ✅ | — | 68 | Email đăng nhập Jira |
| `JIRA_TOKEN` | ✅ | — | 69 | API token Jira (Basic Auth) |
| `MAX_CONCURRENT_JOBS` | | `2` | 25 | Số job AI chạy song song |
| `GIT_HOST` | | `github.com` | 93 | Git host (github.com / git tự host) |
| `GIT_TOKEN` | ✅ | fallback `GITHUB_TOKEN` | 94 | PAT — cần cho push + tạo PR |
| `GITHUB_TOKEN` | | — | 94→95 | Tên cũ, vẫn dùng được |
| `GIT_API_BASE_URL` | | rỗng | 96 | API tạo MR cho GitLab/Gitea, có `{repo}` |
| `GIT_AUTHOR_NAME` | | `AI Bug Fixer` | 121 | Tên author commit |
| `GIT_AUTHOR_EMAIL` | | `ai-bot@local.dev` | 122 | Email author commit |
| `CLAUDE_MODEL` | | `claude-3-7-sonnet` | 123 | Model truyền cho `claude -p --model` |
| `CLAUDE_TIMEOUT_MS` | | `300000` | 124 | Timeout mỗi lượt Claude (ms) |
| `TELEGRAM_BOT_TOKEN` | (khuyến nghị) | — | 126 | Token bot; thiếu → tắt Telegram |
| `TELEGRAM_CHAT_ID` | (khuyến nghị) | — | 127 | Chat nhận tin; thiếu → không gửi được |
| `TELEGRAM_ALLOWED_USER_IDS` | (khuyến nghị) | rỗng → **chặn mọi người** | 128 | Danh sách user id được duyệt Merge |

> ⚠️ `TELEGRAM_ALLOWED_USER_IDS` để trống ⇒ `ALLOWED_USER_IDS = []` ⇒ **không ai** bấm được nút Merge (`worker.js:425`).
> ⚠️ Biến `GIT_DEV_BRANCH`, `GIT_TARGET_BRANCH`, `GIT_PROD_BRANCH`, `GIT_BASE_BRANCH`, `PREPROD_HEALTH_URL`, `GITHUB_REPO` có trong `README.md` cũ **không còn được worker đọc** — nhánh lấy từ `services.json`. Có thể bỏ qua các dòng đó.

---

## O. Phụ lục B — Bản đồ ticket → service → repo

| Nhãn `service:*` | `services.json` khớp theo | Thư mục | Repo | Lệnh test worker bảo AI chạy | Lệnh chạy được thực tế | Prefix commit AI phải dùng |
|---|---|---|---|---|---|---|
| `service:api` | `name === "api"` | `services/shop-api` | `thanhpk6120/shop-api` | `'./mvnw clean test' or 'mvn clean test'` | `mvnw.cmd -B clean test` hoặc `mvn -B clean test` (Windows: `./mvnw` **không** chạy) | `fix(api):` |
| `service:web` | `name === "web"` | `services/shop-web` | `thanhpk6120/shop-web` | `'npm test' or 'npm run build'` | `npm run build` — `npm test` **lỗi** vì `shop-web` không có script `test` | `fix(web):` |
| `service:api` (CMS) | `name === "api"` | `services-2/cms-api` | `thanhpk6120/cms-api` | `'./mvnw clean test' or 'mvn clean test'` | `mvnw.cmd -B clean test` | `fix(api):` |
| `service:web` (CMS) | `name === "web"` | `services-2/cms-web` | `thanhpk6120/cms-web` | `'npm test' or 'npm run build'` | `npm run build` (`cms-web` có script `test` nhưng nó chỉ echo, không kiểm tra gì) | `fix(web):` |

Cơ chế khớp (`worker.js:765`): `s.name === targetService || s.path === targetService || s.path.endsWith(targetService)`.

> Lệnh test AI được bảo chạy lấy từ `worker.js:833-838` (chọn theo `targetService`).
> ⚠️ Vì prompt AI hardcode `npm test` cho web nhưng `shop-web` không có script đó → AI sẽ báo lỗi test. Sửa `CLAUDE.md` (Phụ lục E) để chỉ định `npm run build` cho web là cách nhanh nhất.

---

## P. Phụ lục C — Xử lý sự cố

| Triệu chứng trong log | Nguyên nhân | Cách xử lý |
|---|---|---|
| `⚠️ Thiếu cấu hình Jira...` | Thiếu `JIRA_DOMAIN/EMAIL/TOKEN` trong `.env` | Chạy lại bằng `node --env-file=.env worker.js` (không dùng `node worker.js`) |
| `[+] Tìm thấy 0 bug cho dự án SHOP` mãi | Sai `projectKey` trong `projects.json`, hoặc ticket thiếu nhãn `auto-fix`, hoặc sai trạng thái | Chạy lệnh kiểm tra JQL ở Phụ lục D mục D.4; sửa label/status |
| `[Fail-Safe Abort] Ticket ... không có nhãn 'service:*'` | Ticket thiếu nhãn `service:api`/`service:web` | Thêm nhãn trong Jira |
| `[Fail-Safe Abort] Thư mục service '...' không tồn tại` | Chưa clone repo service (Bước 2) | Clone đúng path trong `services.json` |
| `[Fail-Safe Abort] Service '...' thiếu gitRepo hoặc cấu hình branches` | `services.json` thiếu trường | Bổ sung `gitRepo`, `branches.dev`, `branches.prod` |
| `Claude exited with code ...` | Claude CLI chưa đăng nhập / relay nội bộ tắt / sai `ANTHROPIC_BASE_URL` | Làm **Bước 0** (B.0): `claude -p "ping"` phải trả lời được. Nếu OK mà worker vẫn lỗi → chạy worker từ CMD riêng có cùng biến môi trường |
| `Repro fail: AI không tạo bằng chứng trong 'evidence/<KEY>/before'` | AI không chạy lệnh lưu evidence | Xem log Claude trong terminal; sửa `CLAUDE.md` để rõ quy tắc evidence |
| `PR rỗng hoặc chỉ chứa file rác/evidence` | AI sửa file ngoài `src/` hoặc không sửa gì | Xem diff trong worktree; sửa `CLAUDE.md` |
| `npm error Missing script: "test"` | `shop-web/package.json` **không có** script `test` | Dùng `npm run build` (đã build OK); hoặc thêm script `test` vào `package.json` |
| `Host <X> là git tự host, không hỗ trợ tự động merge` | `GIT_HOST` ≠ github.com | Merge thủ công trên Web UI, hoặc dùng GitHub |
| `Giả lập mở PR thành công: #demo-pr` | Thiếu `GIT_TOKEN` | Điền `GIT_TOKEN` vào `.env` |
| Không có tin nhắn Telegram nào | Thiếu `TELEGRAM_BOT_TOKEN`/`CHAT_ID`, hoặc bot chưa vào nhóm | Làm lại Bước 5, test bằng `curl .../getMe` và `sendMessage` |
| `⛔ Bạn không có quyền duyệt tác vụ này!` | User id không có trong `TELEGRAM_ALLOWED_USER_IDS` | Thêm id (lấy từ `@userinfobot`) |
| `409 Conflict` khi gọi `getUpdates` | Có tiến trình khác đang dùng cùng bot token | Tắt worker cũ (`restart-worker.bat`) rồi thử lại |
| Worktree sót lại | Worker bị kill giữa chừng | `git -C services\shop-api worktree list` → `git worktree remove --force .worktrees/hotfix/<KEY>` + `git worktree prune` |

---

## Q. Phụ lục D — Gotcha đã kiểm chứng

| # | Gotcha | Bằng chứng | Xử lý |
|---|---|---|---|
| D.1 | `worker.js` **không** đọc `.env`; chạy `node worker.js` sẽ không có biến môi trường | Không có `require('dotenv')`; `start-worker.bat:21` dùng `node --env-file=.env` | Luôn dùng `start-worker.bat` |
| D.2 | `projects.json` và `services.json` được đọc theo **CWD**, không theo `__dirname` | `worker.js:32` (`readFileSync('projects.json')`), `worker.js:752` | Luôn `cd` vào root repo trước khi chạy |
| D.3 | `evidence.js` ghi vào `process.cwd()/evidence` | `evidence.js:6` | Chạy worker ở root repo |
| D.4 | Kiểm tra JQL thủ công (không cần chạy worker) | xem lệnh bên dưới | Dùng khi debug "0 bug" |
| D.5 | `shop-web` không có script `test` | `package.json` scripts = `dev`, `build` | Dùng `npm run build` |
| D.6 | `shop-api` không có actuator → không có `/actuator/health` | `pom.xml` không có `spring-boot-starter-actuator` | Health-check bằng endpoint thật hoặc check port |
| D.7 | Trên Windows, `./mvnw` không chạy; dùng `mvnw.cmd` hoặc `mvn` | `./mvnw.cmd` → *"is not recognized"*; `cmd /c mvnw.cmd` → OK | Sửa `CLAUDE.md` ghi rõ `mvnw.cmd -B clean test` |
| D.8 | Worker chỉ tạo PR vào nhánh `prod`; `branches.target` được đọc nhưng không dùng để tạo PR | `worker.js:782` (gán), `worker.js:876-882` (dùng `prodBranch`) | Không kỳ vọng PR vào `staging` |
| D.9 | Phase `after` của evidence **chưa** được worker điền (chỉ `before`) | `worker.js` chỉ gọi `saveEvidence(...,'before',...)` và `sendEvidenceToTelegram(...,'before',...)` | Chấp nhận hiện trạng; muốn đủ thì thêm bước ghi evidence sau fix |
| D.10 | Nhánh `hotfix/<KEY>` bị `git branch -D` + `worktree add -B` mỗi lần → commit cũ trên remote bị ghi đè (`push --force`) | `worker.js:813-816`, `worker.js:872` | Cân nhắc đổi sang `hotfix/<KEY>-<timestamp>` nếu cần lịch sử |
| D.11 | `CLAUDE.md` mô tả path `services/api`, `services/web` nhưng code nằm ở `services/shop-api`, `services/shop-web` | `CLAUDE.md:17-18,28,33,46` vs `services.json` | Sửa theo Phụ lục E — **quan trọng**, AI sửa nhầm path sẽ hỏng |
| D.12 | `services/shop-web/.env` đang được **commit** trong repo `shop-web` (chứa DSN) | `git -C services/shop-web ls-files` → có `.env` | `git rm --cached .env` + thêm `.env` vào `.gitignore` của repo web (Phụ lục F) |
| D.13 | `webhook_bridge.js` cần `express` nhưng repo root **không có** `package.json`/`node_modules` | `require('express')` → `MODULE_NOT_FOUND` | `npm install express` (tạo `package.json` ở root) hoặc bỏ bridge, dùng Jira Automation |
| D.14 | Worker **KHÔNG** gửi Telegram khi job fail — chỉ gắn nhãn `auto-fix-failed` + comment Jira | `worker.js:681-686` (`processBugWrapper`), `markJiraIssueFailed` (`:701-717`) không gọi Telegram | Theo dõi bằng nhãn Jira / log terminal, không chờ tin Telegram |
| D.15 | Bước kiểm tra "repro phải có evidence" **luôn pass** (worker tự tạo file evidence trước rồi kiểm tra chính nó) | `worker.js:842-844` tạo file → `:856-859` kiểm tra cùng thư mục đó | Coi là known gap; chỉ `[AI_STOP] REPRO_FAILED` mới thực sự dừng (`:851-854`) |
| D.16 | Jira **description** không được truyền cho Claude — chỉ `summary` | `worker.js:849` (`Bug: ${summary}`); description chỉ nằm trong file evidence ngoài worktree | Nhét toàn bộ thông tin lỗi vào **Summary** của ticket |
| D.17 | Worker **có** tự commit khi AI quên commit, với message `fix(auto): catch uncommitted changes after ...` — **không** theo convention `fix(api):`/`fix(web):` | `worker.js:598` (README mục B nói "worker không tự commit" — sai) | Sau khi có PR, kiểm tra message commit; sửa tay nếu sai convention |
| D.18 | `webhook_bridge.js` suy ra `service:*` từ slug project GlitchTip: chứa `-fe` → `service:web`, chứa `-be` → `service:api`, **mặc định `service:api`** | `webhook_bridge.js:24-30` | Đặt tên project GlitchTip theo slug rõ ràng (VD `SHOP-be`, `SHOP-fe`). Slug kiểu `project-1-be-1` vẫn ra `api` — nhưng frontend có `-fe` mới ra `web`. Nên **dùng Jira Automation** (nhãn cứng) thay vì bridge |

### D.4 — Lệnh kiểm tra JQL (dán vào CMD, đổi `<PROJECT_KEY>`)

```cmd
node --env-file=.env -e "const a='Basic '+Buffer.from(process.env.JIRA_EMAIL+':'+process.env.JIRA_TOKEN).toString('base64');const jql='project = SHOP AND issuetype = Bug AND status IN (\"To Do\", \"Selected for Development\", \"Backlog\") AND (labels = \"auto-fix\" OR summary ~ \"AUTO-BUG\") AND labels != \"auto-fix-processing\" AND labels != \"auto-fix-done\" AND labels != \"auto-fix-failed\"';fetch('https://'+process.env.JIRA_DOMAIN+'/rest/api/3/search/jql?jql='+encodeURIComponent(jql)+'&fields=summary,labels,status',{headers:{Authorization:a}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```

---

## R. Phụ lục E — Sửa `CLAUDE.md` cho khớp path thật

`CLAUDE.md` được worker **copy vào worktree** trước khi gọi Claude (`worker.js:818-826`) → AI đọc file này để biết sửa ở đâu. Hiện nó trỏ tới path không tồn tại:

| Dòng | Đang ghi | Sửa thành |
|---|---|---|
| 17 | `services/api`, `services/web` | `services/shop-api`, `services/shop-web` |
| 18 | `services-2/api`, `services-2/web` | `services-2/cms-api`, `services-2/cms-web` |
| 28 | `services/api/src/main/java/`, `services-2/api/src/main/java/` | `services/shop-api/src/main/java/`, `services-2/cms-api/src/main/java/` |
| 33 | `services/web/src/`, `services-2/web/src/` | `services/shop-web/src/`, `services-2/cms-web/src/` |
| 46 | `git add services/api/src/...` | `git add services/shop-api/src/...` |

Thêm vào phần Services Map các dòng ghi chú sau:

```md
> **Lưu ý Windows:** dùng `mvnw.cmd -B clean test` (hoặc `mvn -B clean test`) — `./mvnw` không chạy được trên Windows.
> **Lưu ý frontend:** `shop-web` không có script `test`; dùng `npm run build` để verify.
> **Commit convention:** `fix(api): ...` cho service `api`, `fix(web): ...` cho service `web`. TUYỆT ĐỐI không dùng prefix khác.
> **Evidence:** lưu bằng chứng repro vào `evidence/{JIRA_KEY}/before/` (thư mục này nằm trong repo service đang làm việc).
```

Cũng nên sửa tên project trong Services Map cho khớp `projects.json` (`SHOP` / `CMS` thay cho `KANBAN` / `ECOM`).

> ⚠️ Worker có thể tự commit phần AI quên commit với message `fix(auto): catch uncommitted changes after ...` (`worker.js:598`) — vi phạm convention trên. Sau khi có PR, **kiểm tra message commit** và sửa tay nếu cần.

---

## S. Phụ lục F — Bảo mật & rotate secret

### S.1. Secret đang tồn tại trong hệ thống

| Secret | Nơi đang nằm | Rủi ro |
|---|---|---|
| `JIRA_TOKEN` | `.env` (gitignored ✅) | Lộ nếu chia sẻ file `.env` |
| `GIT_TOKEN` | `.env` + **URL remote của 4 service repo** | Lộ nếu push log/`git remote -v` bị chia sẻ |
| `TELEGRAM_BOT_TOKEN` | `.env` | Lộ nếu chia sẻ file `.env` |
| **DSN GlitchTip** | `services/shop-web/.env` (**đang commit** ❌), `main.jsx` fallback hardcode ❌, `application.properties` của 2 api ❌ | DSN lộ → kẻ xấu gửi event giả vào project của bạn |

### S.2. Việc cần làm (khuyến nghị)

1. **DSN không phải secret nghiêm ngặt, nhưng nên hạn chế.** Với GlitchTip mới, dùng **DSN key** riêng cho từng project và thu hồi (rotate) được.
2. Gỡ DSN khỏi code:
   - `services/shop-web/src/main.jsx`: xoá phần `|| "http://...@...:8000/2"` → chỉ còn `import.meta.env.VITE_SENTRY_DSN`.
   - `services-2/cms-web/src/main.jsx`: tương tự.
   - `services/shop-api/src/main/resources/application.properties` và `services-2/cms-api/...`: chuyển sang biến môi trường:
     ```properties
     sentry.dsn=${SENTRY_DSN}
     ```
     và truyền khi chạy: `SENTRY_DSN=<DSN> java -jar ...`
3. Gỡ `.env` khỏi tracking của repo `shop-web`:
   ```cmd
   git -C services\shop-web rm --cached .env
   echo .env >> services\shop-web\.gitignore
   git -C services\shop-web commit -m "chore: untrack .env (contains Sentry DSN)"
   ```
4. Nếu **tài liệu này** (hoặc `.env`) đã bị chia sẻ ra ngoài → **rotate ngay**:
   - Jira: <https://id.atlassian.com/manage-profile/security/api-tokens> → Revoke token cũ → tạo token mới → cập nhật `.env`.
   - GitHub: <https://github.com/settings/tokens> → Revoke PAT cũ → tạo PAT mới → cập nhật `.env` **và** URL remote của 4 repo.
   - Telegram: `/revoke` với `@BotFather` → nhận token mới → cập nhật `.env`.
   - GlitchTip: vào project → **Client Keys** → revoke key → tạo key mới → cập nhật DSN ở 4 service.

### S.3. Quy tắc chung

- Không bao giờ commit `.env`, DSN hay token vào repo worker.
- Token nằm trong URL remote của repo service → khi gửi log cho người khác, phải che `https://<TOKEN>@github.com/...` → `https://***@github.com/...`.
- `worker.js` in remote URL khi push (stdio `inherit`) → log worker có thể chứa token. Xem log worker như dữ liệu nhạy cảm.

---

## Checklist hoàn tất

- [ ] **B.0 `claude -p "ping"` phải trả lời được** (bắt buộc — nếu không, mọi job auto-fix đều fail) · B.1 Node ≥ 20.6 · B.2 Git · B.3 xác nhận lần 2 · B.4 Docker (nếu tự dựng GlitchTip) · B.5 Java 21 + Maven
- [ ] C Clone repo worker
- [ ] **D Clone 4 repo service** + tạo nhánh `staging` + xác minh branch
- [ ] E Tạo `.env` (Jira token, Git token) + E.3 nạp env OK + E.4 test token OK
- [ ] F `projects.json` (SHOP/CMS) + `services.json` x2 (gitRepo, branches dev/prod)
- [ ] **G Telegram**: @BotFather → token · chat id (nhóm) · user id (@userinfobot) · `getMe` OK · `sendMessage` OK
- [ ] H GlitchTip Docker: compose up + migrate + tạo 4 project + lấy 4 DSN
- [ ] I Gắn DSN vào 4 service + kiểm tra issue xuất hiện trên GlitchTip
- [ ] J Jira: Automation Rule (2 rule/project) với nhãn `auto-fix` + `service:*`
- [ ] K Alert Webhook GlitchTip → Jira
- [ ] L Chạy `start-worker.bat` (CMD riêng) — log "sẵn sàng" + quét 2 project
- [ ] M Test E2E: tạo ticket thử → dấu hiệu repro/fix/PR → duyệt Merge trên Telegram
- [ ] R Sửa `CLAUDE.md` path (khuyến nghị mạnh)
- [ ] S Dọn DSN/token khỏi code + rotate nếu đã lộ
