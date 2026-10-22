# SETUP_GUIDE — Hướng dẫn cài đặt & chạy Auto-Fix Worker (Level 3)

Tài liệu này là hướng dẫn **đầy đủ, tuần tự, copy-paste được** cho toàn bộ hệ thống:

```
[App FE/BE] --Sentry SDK--> [GlitchTip] --Webhook--> [Jira Automation Rule]
      --> [Jira Ticket [AUTO-BUG] + label auto-fix + label service:*]
      --> [worker.js (Singleton Master Worker)] --claude -p--> [fix + test + commit]
      --> [git checkout hotfix/<KEY>-<timestamp> trong repo service] --> [claude -p: sửa + viết unit test + commit]
      --> [worker tự verify: unit test -> coverage >= 90% -> build]  [fail = KHÔNG merge]
      --> [worker tự merge vào staging] --> [kiểm tra pipeline CI (bỏ qua nếu repo chưa có CI)]
      --> [báo Telegram + comment Jira]
```

Bốn hệ thống phải cấu hình: **GlitchTip → Jira → Telegram → Worker (+ 4 service repo)**.

> **Bắt buộc đọc trước:**
> - **Bước 0 (B.0):** `claude -p "ping"` **phải trả lời được** trước khi làm gì khác. Worker chạy headless qua Claude Code CLI — CLI hỏng thì mọi job auto-fix đều fail.
> - `worker.js` **không tự đọc `.env`**. Phải chạy bằng `node --env-file=.env worker.js` (file `start-worker.bat` đã làm sẵn). File `.env` mẫu **đã có sẵn ở root** — chỉ còn 3 secret phải điền tay (xem A.1).
> - 4 thư mục source service **đang bị `.gitignore` loại bỏ** (`.gitignore:27-30`) → clone repo này về **không có mã nguồn**, phải clone 4 repo service thủ công (Bước 2). **Hiện đã clone xong** (xem D). Dùng worker cho dự án **ngoài** thư mục worker → xem mục [G](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker).
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
| [G](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker) | **Dùng worker cho nhiều dự án** (service nằm ngoài thư mục worker) |
| [H](#h-bước-5--setup-telegram-az) | Bước 5: Setup Telegram (A→Z) |
| [I](#i-bước-6--setup-glitchtip-docker) | Bước 6: Setup GlitchTip (Docker) |
| [J](#j-bước-7--gắn-sentry-dsn-vào-4-service) | Bước 7: Gắn Sentry DSN vào 4 service |
| [K](#k-bước-8--setup-jira-project--automation-rule) | Bước 8: Setup Jira (project + Automation Rule) |
| [L](#l-bước-9--nối-alert-webhook-glitchtip--jira) | Bước 9: Nối Alert Webhook GlitchTip → Jira |
| [M](#m-bước-10--chạy-worker) | Bước 10: Chạy worker |
| [N](#n-bước-11--kiểm-thử-end-to-end) | Bước 11: Kiểm thử end-to-end |
| [O](#o-phụ-lục-a--bảng-đầy-đủ-biến-môi-trường) | Phụ lục A: Bảng biến môi trường |
| [P](#p-phụ-lục-b--bản-đồ-ticket--service--repo) | Phụ lục B: Bản đồ ticket → service → repo |
| [Q](#q-phụ-lục-c--xử-lý-sự-cố) | Phụ lục C: Xử lý sự cố |
| [R](#r-phụ-lục-d--gotcha-đã-kiểm-chứng) | Phụ lục D: Gotcha đã kiểm chứng |
| [S](#s-phụ-lục-e--claudemd--path-tương-đối-so-với-repo-service) | Phụ lục E: `CLAUDE.md` & path tương đối |
| [T](#t-phụ-lục-f--bảo-mật--rotate-secret) | Phụ lục F: Bảo mật & rotate secret |

---

## A. Bảng giá trị sẵn có (readymade)

Các giá trị dưới đây **đã có sẵn trong repo**, copy thẳng vào cấu hình. Riêng mục đánh dấu 🔒 là secret → lấy theo hướng dẫn tại nơi cấu hình, **không** ghi vào tài liệu.

### A.1. Danh tính dự án

| Mục | Giá trị | Nơi dùng |
|---|---|---|
| Jira domain | `thanhpk6120.atlassian.net` | `.env` → `JIRA_DOMAIN` — **đã điền sẵn** |
| Jira email | `thanhpk6120@gmail.com` | `.env` → `JIRA_EMAIL` — **đã điền sẵn** |
| Jira API token | 🔒 lấy tại `id.atlassian.com/manage-profile/security/api-tokens` | `.env` → `JIRA_TOKEN` — **còn trống, phải điền**. Để trống → worker **thoát ngay lúc khởi động** (`[LOI] Thiếu cấu hình bắt buộc` + exit 1), **không chạy im lặng** |
| GitHub user | `thanhpk6120` | `services.json` → `gitRepo` |
| GitHub PAT | 🔒 `github.com/settings/tokens` (scope `repo`) | `.env` → `GIT_TOKEN` — **còn trống, phải điền**. Để trống → worker **thoát ngay lúc khởi động** (`[LOI] Thiếu cấu hình bắt buộc` + exit 1) |
| Claude model | `claude-sonnet-5` | `.env` → `CLAUDE_MODEL` — **đã điền sẵn** |
| Claude timeout | `300000` (5 phút) | `.env` → `CLAUDE_TIMEOUT_MS` — **đã điền sẵn** |
| Số job AI song song | `2` | `.env` → `MAX_CONCURRENT_JOBS` — **đã điền sẵn** |
| `JAVA_HOME` (service Java) | `C:/Program Files/Java/jdk-21` | Biến môi trường của máy (không nằm trong `.env`) — **bắt buộc** cho service `api`. `shop-api` pom yêu cầu `java.version=21`; nếu `JAVA_HOME` trỏ JDK 11 (mặc định máy dev) → `mvnw.cmd` **fail** → bước verify unit test fail → job fail. Set: `set JAVA_HOME=C:/Program Files/Java/jdk-21` |

#### Trạng thái hiện tại (đã làm xong, không cần làm lại)

| Việc | Trạng thái |
|---|---|
| File `.env` ở root repo worker | ✅ **Đã tạo sẵn** — `JIRA_DOMAIN`, `JIRA_EMAIL`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`, `MAX_CONCURRENT_JOBS`, `GIT_HOST` đã điền |
| Clone 4 repo service | ✅ **Đã clone xong** — `services/shop-api`, `services/shop-web`, `services-2/cms-api`, `services-2/cms-web` (nhánh `master` + `staging` đều có). ⚠️ Cần **đồng bộ `staging` với `master`** cho từng repo trước khi chạy worker thật — worker merge thẳng vào `staging`, hiện `shop-api` đang lệch **2 commit** (`origin/staging` cũ hơn `origin/master`) |
| `projects.json` + 2 file `services.json` | ✅ **Đã cấu hình** (xem mục F) |

**3 secret còn phải điền thủ công vào `.env`:**

1. `JIRA_TOKEN` — lấy tại <https://id.atlassian.com/manage-profile/security/api-tokens> (bắt buộc, không có thì worker không quét được Jira).
2. `GIT_TOKEN` — PAT tại <https://github.com/settings/tokens>, tick `repo` (bắt buộc, không có thì không push/PR được).
3. `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + `TELEGRAM_ALLOWED_USER_IDS` — lấy ở **Bước 5 (mục G)**. Bỏ trống thì worker vẫn chạy, chỉ mất chức năng **báo cáo Telegram** (luồng duyệt Merge đã bị tắt tạm thời).

> Không có secret nào được ghi trong tài liệu này. Nếu file `.env` bị chia sẻ ra ngoài → rotate ngay (Phụ lục F).
> ⚠️ **Token để trống → worker KHÔNG chạy im lặng.** Thiếu `JIRA_DOMAIN` / `JIRA_EMAIL` / `JIRA_TOKEN` / `GIT_TOKEN` → worker in `[LOI] Thiếu cấu hình bắt buộc: ...` rồi `process.exit(1)` **ngay lúc khởi động** (`worker.js:200-213`). Token Jira sai (không rỗng) → worker gọi `GET /rest/api/3/myself` để xác thực, HTTP 401 → dừng với thông báo rõ ràng (xem mục **M.4.1**).

### A.2. Bản đồ 2 dự án (Jira) ↔ 4 service (Git) ↔ port

| Jira projectKey | Thư mục project | Service | Thư mục repo service | Repo Git (`owner/repo`) | Cổng local | Nhãn `service:*` |
|---|---|---|---|---|---|---|
| `SHOP` | `services/` | `api` | `services/shop-api` | `thanhpk6120/shop-api` | 8080 | `service:api` |
| `SHOP` | `services/` | `web` | `services/shop-web` | `thanhpk6120/shop-web` | 5173 | `service:web` |
| `CMS` | `services-2/` | `api` | `services-2/cms-api` | `thanhpk6120/cms-api` | 8081 | `service:api` |
| `CMS` | `services-2/` | `web` | `services-2/cms-web` | `thanhpk6120/cms-web` | 5174 | `service:web` |

> ⚠️ Path đúng là `services/shop-api` + `services/shop-web` + `services-2/cms-api` + `services-2/cms-web` — **không phải** `services/api` / `services/web` / `services-2/api` / `services-2/web` (path cũ đã sai và đã được sửa).

Nhánh Git cho **mọi** service: `dev = master`, `target = staging`, `prod = master`.
> ✅ **FLOW MỚI — WORKER TỰ VERIFY RỒI TỰ MERGE VÀO STAGING.** `branches.target` được **dùng thật** làm cả base lẫn nhánh đích. Worker **không** tạo Pull Request nữa, cũng **không** còn bước duyệt thủ công.
>
> **Flow đầy đủ:**
> ```text
> hotfix/<KEY>-<timestamp>  (tạo trực tiếp trong repo service, base = origin/staging)
>        ↓ (claude -p: sửa code + viết unit test + tự commit)
>   worker tự verify: unit test đầy đủ → coverage ≥ 90% (class đã sửa, chỉ api) → build
>        ↓ (bước nào fail → job fail → KHÔNG merge)
>   worker tự merge vào staging → push
>        ↓
>   kiểm tra pipeline CI (bỏ qua nếu repo chưa có CI) → báo Telegram + comment Jira
> ```
>
> - **Branch hotfix tạo trực tiếp trong repo service** (base = `origin/<target>`), Claude Code chạy với `cwd` = repo service đó (`worker.js:948-954`).
> - **Worker TỰ xác minh, không tin báo cáo của AI** (`verifyService`, `worker.js:811-859`): (1) unit test — api: `mvnw.cmd -B clean test jacoco:report`, web: `npm test -- --run` (nếu có script `test`) hoặc `npm run build`; (2) coverage — đọc `target/site/jacoco/jacoco.csv`, **đúng các class trong file `src/main/java/...` đã sửa** phải **≥ 90%**; (3) build — api: `mvnw.cmd -B -DskipTests package`, web: `npm run build`. **Dừng ngay khi bước nào fail** → job fail → **không merge**.
> - **Tự merge** (`worker.js:1096-1102`): `git checkout <target>` → `git pull --ff-only origin <target>` → `git merge --no-ff -m "fix(auto): merge <branch> into <target> [AUTO-BUG]" <branch>` → `git push <url> <target>`. **Không** có `push --force`. Cuối cùng worker `git checkout <target>` lại để repo sạch cho lần sau.
> - **Kiểm tra pipeline CI** (`checkCiPipeline`, `worker.js:861-900`): đọc GitHub Actions workflows + runs của branch. Nếu repo **không có workflow** → `status: 'skipped'` → **bỏ qua, không chặn**. Nếu có workflow: `ok` / `running` / `failed` (vẫn báo Telegram nhưng không chặn). Hiện 4 repo demo **không có CI nào** → luôn `skipped`.
> - **PR lên production: TẠM THỜI BỎ QUA.** Toàn bộ luồng tạo PR đã bị tắt (`createPR`, `promoteToProd`, `savePendingPR`, `syncAndCleanPendingPRs` đã xoá khỏi `worker.js`). Nút 🔀 Merge / ⏳ Lưu vào hàng đợi trên Telegram trả lời *"Tính năng ... tạm thời bị tắt"*. Telegram chỉ còn làm nơi **nhận báo cáo kết quả**.
>
> ⚠️ **Vận hành:** 4 repo hiện có `dev=master, target=staging, prod=master`. Riêng `shop-api` đang lệch — `origin/staging` **cũ hơn `origin/master` 2 commit**. Vì worker merge thẳng vào `staging`, code trên staging có thể **cũ hơn master** → cần **đồng bộ staging với master** trước khi dùng thật.

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
| `API Error: Connection refused (ECONNREFUSED)` | CLI trỏ vào relay nội bộ đã tắt | Xem cách xử lý bên dưới ↓ |
| `Invalid API key · Fix external API key` | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` là key của relay nội bộ, không phải key Anthropic thật | Dùng **Cách 1** ở trên (`claude` → `/login`). Xoá 2 biến `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` khỏi môi trường nếu chúng trỏ tới relay cũ. |
| `Not logged in · Please run /login` | Chưa đăng nhập Claude Code | Chạy `claude` (interactive) → gõ `/login` → đăng nhập → thử lại `claude -p "ping"`. |
| `command not found` | Chưa cài Claude Code | `npm i -g @anthropic-ai/claude-code` → kiểm tra `where claude`. |

**Cách xử lý lỗi `Connection refused`:**

1. **Cách 1 (khuyến nghị):** chạy `claude` (interactive) → gõ `/login` → đăng nhập bằng **OAuth** tài khoản Anthropic → thử lại `claude -p "ping"`.
2. **Cách 2:** đặt `ANTHROPIC_BASE_URL` trỏ tới **endpoint thật** rồi dùng API key thật của Anthropic.
3. **Cách 3:** khởi động lại app relay nội bộ đang phục vụ cổng đó.

> Xoá biến cũ (PowerShell, chỉ trong terminal hiện tại):

```powershell
$env:ANTHROPIC_BASE_URL=''; $env:ANTHROPIC_API_KEY=''; $env:ANTHROPIC_AUTH_TOKEN=''
```

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

> ✅ **Trạng thái hiện tại: ĐÃ CLONE XONG.** Cả 4 repo service đã nằm đúng path, đã có nhánh `master` + `staging`, remote trỏ đúng `https://github.com/thanhpk6120/<repo>.git`. Bạn **không cần clone lại** — chỉ cần `git fetch` khi worker chạy (worker tự `git fetch origin` mỗi job, `worker.js:866`).

`.gitignore` của repo worker loại bỏ 4 thư mục này (dòng 27–30):

```
services-2/cms-api/
services-2/cms-web/
services/shop-api/
services/shop-web/
```

→ Clone repo worker **không** kèm mã nguồn. Nếu thiếu, worker dừng ngay tại `worker.js:834`:
`[Fail-Safe Abort] Thư mục service '...' không tồn tại.`

> Dùng worker cho dự án **ngoài** thư mục worker thì 4 thư mục này không bắt buộc nằm trong repo worker — xem mục [G. Dùng worker cho nhiều dự án](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker).

### D.1. Clone đúng path theo `services.json` (đã xong — chỉ để tham khảo khi setup máy mới)

```cmd
cd /d I:\AI\auto-fix-bug-jira

git clone https://github.com/thanhpk6120/shop-api.git  services\shop-api
git clone https://github.com/thanhpk6120/shop-web.git  services\shop-web
git clone https://github.com/thanhpk6120/cms-api.git   services-2\cms-api
git clone https://github.com/thanhpk6120/cms-web.git   services-2\cms-web
```

> Nếu repo private: dùng PAT trong URL hoặc `git config --global credential.helper manager` rồi clone lại (Git Credential Manager sẽ hỏi user/token).

### D.2. Tạo nhánh `staging` (nhánh `target`) — đã xong

Các repo đã có `master`. Nếu chưa có `staging`:

```cmd
for %R in (services\shop-api services\shop-web services-2\cms-api services-2\cms-web) do git -C %R fetch origin && git -C %R push origin origin/master:staging
```

### D.3. Cấu hình remote có token (worker tự set-url, nhưng set sẵn cho chắc)

Worker tự làm `git remote set-url origin https://<TOKEN>@<host>/<repo>.git` (`worker.js:135-144`). Nếu muốn tự set:

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

> Bỏ trống `TELEGRAM_*` → worker **vẫn chạy**, chỉ mất chức năng **báo cáo Telegram** (luồng duyệt Merge đã bị tắt tạm thời nên không còn tính năng này).

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
      "root": ".",
      "path": "services",
      "name": "SHOP (Main Service)",
      "description": "services/shop-api (Spring Boot 8080) và services/shop-web (React Vite 5173)"
    },
    {
      "projectKey": "CMS",
      "root": ".",
      "path": "services-2",
      "name": "CMS (Service 2)",
      "description": "services-2/cms-api (Spring Boot 8081) và services-2/cms-web (React Vite 5174)"
    }
  ]
}
```

Quy tắc:

| Trường | Ý nghĩa |
|---|---|
| `projectKey` | Key Jira — phải khớp chính xác, nếu không JQL sẽ không ra ticket nào. |
| `root` | Thư mục gốc của dự án. TUYỆT ĐỐI (`"D:/work/acme"`) hoặc TƯƠNG ĐỐI so với thư mục worker (`"../acme"`). Bỏ trống = thư mục worker. |
| `path` | Thư mục chứa `services.json` + code service. TUYỆT ĐỐI (`"D:/work/acme"`) hoặc TƯƠNG ĐỐI so với `root` (`"services"`, `"src"` cho monorepo). |

> `projectKey` ở đây **không** phải `KANBAN`/`ECOM` như trong `projects.json.example` — phải khớp với key Jira thật (`SHOP`, `CMS`).
>
> Cơ chế `root` + `path` cho phép **dùng MỘT bản worker cho nhiều dự án**, kể cả khi service repo nằm ngoài thư mục worker → xem mục [G. Dùng worker cho nhiều dự án](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker).

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

## G. Dùng worker cho nhiều dự án (service nằm ngoài thư mục worker)

### G.1. Vấn đề

`worker.js` là **Singleton Master Worker**: một tiến trình duy nhất quản lý N dự án. Trước đây mọi dự án bắt buộc nằm trong thư mục worker (`services/`, `services-2/`), nên muốn dùng cho dự án khác thì phải copy cả repo worker sang máy mới.

Giờ `projects.json` hỗ trợ 2 trường mới: **`root`** + **`path`** → dùng **MỘT bản worker** cho nhiều dự án, kể cả khi service repo nằm ở thư mục **khác hoàn toàn**, thậm chí **ngoài thư mục worker** (VD `D:/work/acme`).

### G.2. Cơ chế: `root` + `path` trong `projects.json`

```json
{
  "projectKey": "ACME",
  "path": "D:/work/acme",
  "name": "ACME",
  "description": "Dự án ngoài thư mục worker"
}
```

| Trường | Quy tắc |
|---|---|
| `root` | Thư mục gốc dự án. **TUYỆT ĐỐI** (`"D:/work/acme"`) → dùng nguyên xi. **TƯƠNG ĐỐI** (`"../acme"`) → tính từ thư mục worker. **Bỏ trống** = thư mục worker. |
| `path` | Thư mục chứa `services.json`. **TUYỆT ĐỐI** (`"D:/work/acme"`) → dùng nguyên xi (bỏ qua `root`). **TƯƠNG ĐỐI** (`"services"`, `"src"`) → tính từ `root`. |

Hai hàm xử lý việc này nằm trong `worker.js`:

- `resolveProjectDir(project)` (`worker.js:43-53`) — chuẩn hoá `root` + `path` → thư mục project.
- `resolveServiceDir(projectDir, serviceConfig)` (`worker.js:55-60`) — chuẩn hoá `service.path` trong `services.json` → thư mục service.

Trong `services.json` của dự án, `service.path` cũng nhận **TUYỆT ĐỐI** (`"D:/work/acme/shop-api"`); nếu không thì coi là **TƯƠNG ĐỐI so với thư mục project**.

### G.3. Ví dụ đầy đủ cho 2 dự án

Một dự án **trong** thư mục worker + một dự án **ngoài** thư mục worker, cùng chạy trong 1 worker:

```json
{
  "projects": [
    {
      "projectKey": "SHOP",
      "root": ".",
      "path": "services",
      "name": "SHOP (Main Service)",
      "description": "services/shop-api (Spring Boot 8080) và services/shop-web (React Vite 5173)"
    },
    {
      "projectKey": "ACME",
      "path": "D:/work/acme",
      "name": "ACME",
      "description": "Dự án ngoài thư mục worker"
    }
  ]
}
```

`root: "."` + `path: "services"` → thư mục project = `<thư mục worker>/services`.
`path: "D:/work/acme"` (không có `root`) → thư mục project = `D:/work/acme`.

### G.4. Cấu trúc thư mục mong đợi của dự án ngoài worker

```
D:/work/acme/
├── services.json          ← bắt buộc: khai báo service + gitRepo + nhánh
├── shop-api/              ← repo git của service (đã clone)
└── shop-web/
```

`services.json` trong `D:/work/acme/`:

```json
{
  "services": [
    {
      "name": "api",
      "path": "shop-api",
      "gitRepo": "<ORG>/acme-shop-api",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    },
    {
      "name": "web",
      "path": "shop-web",
      "gitRepo": "<ORG>/acme-shop-web",
      "branches": { "dev": "master", "target": "staging", "prod": "master" }
    }
  ]
}
```

### G.5. "Mọi lệnh có phải `cd` vào thư mục dự án không?"

**CÓ — và đây là hành vi có chủ đích.**

Worker luôn chạy mọi lệnh trong **đúng thư mục đích** bằng tham số `cwd` của `execSync`/`spawnSync`:

| Lệnh | `cwd` |
|---|---|
| `git fetch` / `git checkout` / `git merge` / `git push` | `<thư mục service repo>` (đã checkout branch `hotfix/<KEY>-<timestamp>`) |
| `claude -p` (Claude Code) | `<thư mục service repo>` |
| `mvnw.cmd` / `npm` (bước verify của worker) | `<thư mục service repo>` |

> **Không dùng git worktree nữa.** Trước đây worker tạo thư mục riêng `.worktrees/hotfix/<KEY>` cho mỗi ticket; nay worker **checkout thẳng repo service**, tạo branch `hotfix/<KEY>-<YYYYMMDD-HHMMSS>` ngay trong repo đó (base = `origin/<target>` = staging) và chạy Claude Code với `cwd` = repo service đó. Hệ quả: **trong lúc worker đang xử lý, `git status` của repo service sẽ hiện branch hotfix** — đây là bình thường, không phải repo bẩn.

**Hệ quả:** Claude Code luôn đứng ở **gốc repo service cần sửa** → trong `CLAUDE.md` mọi đường dẫn phải là **TƯƠNG ĐỐI** (`src/main/java/...`, `src/...`), tuyệt đối không dùng `services/shop-api/...`.

> **Bạn KHÔNG cần `cd` thủ công khi chạy worker** — worker tự xử lý mọi thứ. Chỉ khi bạn chạy Claude Code **để debug tay** thì mới phải `cd` vào repo service (đúng nhánh hotfix):
>
> ```cmd
> cd /d D:\work\acme\shop-api
> git checkout hotfix/ACME-123-20260101-120000
> ```

### G.6. Quy trình thêm dự án mới

1. **Thêm entry vào `projects.json`** ở root repo worker (dùng `path` tuyệt đối nếu dự án nằm ngoài worker):

   ```json
   {
     "projectKey": "ACME",
     "path": "D:/work/acme",
     "name": "ACME",
     "description": "Dự án ngoài thư mục worker"
   }
   ```

2. **Tạo `services.json`** trong thư mục dự án (`D:/work/acme/services.json`) — khai báo `name`, `path`, `gitRepo`, `branches` cho từng service (xem mục G.4).

3. **Clone repo service** vào đúng path đã khai trong `services.json`:

   ```cmd
   cd /d D:\work\acme
   git clone https://github.com/<ORG>/acme-shop-api.git  shop-api
   git clone https://github.com/<ORG>/acme-shop-web.git  shop-web
   ```

4. **Tạo nhánh `staging`** (nhánh `target`) trong từng repo service:

   ```cmd
   for %R in (D:\work\acme\shop-api D:\work\acme\shop-web) do git -C %R fetch origin && git -C %R push origin origin/master:staging
   ```

5. **Tạo label trong Jira** cho project mới: `service:api` và `service:web` (worker dừng an toàn nếu ticket thiếu nhãn `service:*`).

6. **Tạo ticket test** với summary chứa `[AUTO-BUG]` + nhãn `auto-fix` + nhãn `service:*` + status `Backlog` → worker sẽ xử lý ở vòng quét kế tiếp.

> ⚠️ **Phải restart worker** sau khi sửa `projects.json` — xem mục G.7.

### G.7. Lưu ý bảo mật & vận hành

**Bảo mật:** Worker **KHÔNG ghi file nào vào repo của khách** (không copy `CLAUDE.md`, không tạo `.claude/` trong repo service). Context + guardrail được nạp **qua CLI args** khi worker gọi `claude -p`:

1. **Rules khoanh vùng bug** → `--append-system-prompt "<nội dung CLAUDE.md của worker>"` (`worker.js:39-42`).
2. **Hook guardrail** → `--settings <đường dẫn tuyệt đối tới .claude/settings.generated.json>` (`worker.js:34-38`) — file do worker **sinh lúc khởi động** (`ensureWorkerSettings`, `worker.js:14-30`), trong đó lệnh hook trỏ tới **đường dẫn tuyệt đối** của `.claude/hooks/pre-tool-use.js` (vì cwd của Claude Code là repo service của khách nên đường dẫn tương đối sẽ không tìm thấy).

**Hệ quả:** repo khách **hoàn toàn sạch** → commit của worker **không bao giờ** kèm file lạ (`CLAUDE.md`, `.claude/`), không rò rỉ rule nội bộ của worker. Worker cũng **không còn dùng `.git/info/exclude`** của repo khách nữa (trước đó nó dùng chung common git dir → có nguy cơ ẩn file untracked `evidence/` của user). Bộ lọc `isIgnored` trong `ensureAICommittedItself` (`worker.js:673-677`) **vẫn giữ** (thêm `CLAUDE.md`, `.claude/`) nhưng giờ chỉ là **lớp phòng thủ thứ 2**, không còn là lớp chính.

**Hook guardrail vẫn áp dụng cho mọi dự án:** hook được nạp qua `--settings` từ file **của worker** (đường dẫn tuyệt đối) → chạy được trong **bất kỳ repo service nào**, kể cả dự án nằm ngoài thư mục worker. Hook **không phụ thuộc dự án đích**, và repo đích không cần chứa bất kỳ file `.claude/` nào.

**Vận hành:** `projects.json` được đọc **đúng 1 lần lúc khởi động** (`worker.js:33-37`) → sửa config phải **restart worker** (`restart-worker.bat`). Không có cơ chế reload tự động.

**Không còn PR nào → không còn danh sách chờ PR.** Luồng tạo Pull Request đã bị **tắt tạm thời** (`createPR`, `promoteToProd`, `savePendingPR`, `removePendingPR`, `syncAndCleanPendingPRs` đã bị xoá khỏi `worker.js`). Vì vậy:
>
> - Không có file `pending-prs.json` được sinh ra nữa → **không còn danh sách chờ PR** (nút **📋 Xem danh sách đợi Merge** trả lời *"Danh sách chờ PR tạm thời bị tắt"*).
> - Nút **🔀 Merge** và **⏳ Lưu vào hàng đợi** trả lời *"Tính năng duyệt PR thủ công tạm thời bị tắt. Worker tự merge vào staging sau khi unit test + build pass."* → Telegram **chỉ còn làm nơi nhận báo cáo kết quả**.
> - Worker tự merge vào `staging` (`git checkout <target>` → `git pull --ff-only` → `git merge --no-ff` → `git push`) → không có PR nào để duyệt tay, không có PR promote `staging → prod`.
> - ⚠️ Vì worker merge thẳng vào `staging`, mọi thay đổi **đã vào nhánh staging** mà không qua bước duyệt PR → cần **đồng bộ staging với master** trước khi chạy thật (xem A.2 và Checklist).

---


## H. Bước 5 — Setup Telegram (A→Z)

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
- **không** có tin nhắn báo lỗi/timeout (xem mục M.5(a)).

→ Làm Bước 5 để bật.

### 4 điểm dễ sai

1. **`TELEGRAM_ALLOWED_USER_IDS` là user ID của người BẤM nút, KHÔNG phải chat ID.** Để trống → `ALLOWED_USER_IDS = []` → **mọi** nút bị chặn với `⛔ Bạn không có quyền duyệt tác vụ này!` (`worker.js:425-428`).
2. **`TELEGRAM_CHAT_ID` của nhóm/supergroup có dạng `-100...`** (chat riêng thì số dương). Bot **phải được add vào nhóm** mới nhận được tin.
3. **Worker CHỈ xử lý `callback_query`** (nút bấm inline) — `worker.js:410-412`. Tin nhắn text thường (`/start`, `/status`, gõ tay) **bị bỏ qua hoàn toàn**. Không có lệnh text nào.
4. **Chỉ 1 consumer được `getUpdates`.** Worker tự long-poll `getUpdates` (`worker.js:405`) → chạy 2 worker cùng token sẽ tranh nhau, mỗi bên nhận một phần update (bot im lặng với nút bấm). Lấy `chat_id` bằng `getUpdates` **trước khi** bật worker.
   > Không cần tắt privacy mode: worker chỉ gửi tin + nhận `callback_query`, không đọc message thường.

> Gửi ảnh evidence: chỉ file có prefix `screenshot` + đuôi `.png` mới được gửi (`evidence.js:41`). `sendMediaGroup` cần **2–10 ảnh** — Telegram trả lỗi 400 nếu chỉ có 1 ảnh (`evidence.js:55-65`).

### H.1. Tạo bot

1. Mở Telegram (desktop/mobile) → tìm `@BotFather` (bot chính thức, tick xanh) → **Start**.
2. Gõ `/newbot` → Enter.
3. Nhận **tên hiển thị** của bot, ví dụ: `SHOP AutoFix Bot`.
4. Nhận **username** của bot, bắt buộc kết thúc bằng `bot`, ví dụ: `shop_autofix_bot`.
5. BotFather trả về **HTTP API token**, dạng `1234567890:AAH1aV...r8sXk`
   → copy nguyên văn (giữ dấu `:`) → điền vào `TELEGRAM_BOT_TOKEN` trong `.env`.

### H.2. Tạo nhóm On-call (khuyến nghị) và lấy CHAT_ID

1. Tạo nhóm Telegram (ví dụ `SHOP On-call`), thêm **bot** vào nhóm (nên đặt quyền **Admin** để bot đọc được tin nhắn trong nhóm).
2. Trong nhóm, gửi một tin nhắn bất kỳ, ví dụ: `worker test`.
3. Mở terminal, dán (thay `<BOT_TOKEN>`):

```cmd
curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates?offset=-1"
```

4. Trong JSON trả về, tìm dòng có `"chat"` — ví dụ:

   `"chat": { "id": -1001234567890, "type": "supergroup", "title": "SHOP On-call" }`

   → `chat.id` (số âm với nhóm/supergroup, số dương với chat riêng) chính là `TELEGRAM_CHAT_ID`.

> Nếu kết quả `{"ok":true,"result":[]}` → bot chưa nhận được message nào. Nhắn thêm 1 tin trong nhóm rồi chạy lại lệnh (chờ vài giây).
> Nếu lỗi `409 Conflict` → bot đang được chạy ở nơi khác với cùng token (ví dụ worker cũ chưa tắt) → tắt hết rồi thử lại.
> **Chạy lệnh `getUpdates` này TRƯỚC khi bật worker.** Worker tự long-poll `getUpdates` (`worker.js:405`) — chạy song song 2 consumer sẽ tranh nhau queue, mỗi bên chỉ nhận được một phần update.

### H.3. Lấy USER ID của người được phép duyệt

1. Trong Telegram, mở `@userinfobot` → **Start** → bot trả về `Id: 123456789`, `First name: ...`.
2. Lấy `Id` đó → điền vào `TELEGRAM_ALLOWED_USER_IDS` (nhiều người thì phân cách bằng dấu phẩy, không khoảng trắng):

   `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321`

3. Kiểm tra danh sách bot trong nhóm: mở nhóm → member list → xác nhận bot đã vào.

> Chỉ user id nằm trong `TELEGRAM_ALLOWED_USER_IDS` mới bấm được nút Merge; user khác bấm sẽ nhận `⛔ Bạn không có quyền duyệt tác vụ này!` (`worker.js:425-428`).

### H.4. Kiểm tra bot sống (2 lệnh)

```cmd
curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"
```
Mong đợi: `{"ok":true,"result":{"id":...,"username":"shop_autofix_bot",...}}`

Gửi tin thử:
```cmd
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage" -H "Content-Type: application/json" -d "{\"chat_id\":<CHAT_ID>,\"text\":\"AutoFix worker test OK\"}"
```
Mong đợi: `{"ok":true,...}` và tin nhắn hiện trong nhóm.

### H.5. Cấu hình `.env` hoàn tất

```ini
TELEGRAM_BOT_TOKEN=1234567890:AAH1aV...r8sXk
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

### H.6. (Tuỳ chọn) Bot cần quyền đọc message trong nhóm

Nếu nhóm **đã bật** chế độ "Restricted" (chỉ admin thêm bot) → vào nhóm → quản trị nhóm → **Quyền admin** → bật **Đọc tin nhắn**. Nút inline vẫn hoạt động dù bot là thành viên thường.

---

## I. Bước 6 — Setup GlitchTip (Docker)

> Nếu hạ tầng đã có sẵn GlitchTip (VD trong môi trường nội bộ) → **bỏ qua Bước 6**, sang thẳng Bước 7 với host/DSN do admin cấp.

### I.1. Chuẩn bị thư mục + secret key

```bash
mkdir -p /opt/glitchtip && cd /opt/glitchtip
SECRET_KEY=$(openssl rand -hex 32)
echo "SECRET_KEY=${SECRET_KEY}" > .env
echo "GLITCHTIP_DOMAIN=http://<DOMAIN_OR_IP>:8000" >> .env
```

### I.2. Tạo `docker-compose.yml`

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

### I.3. Migrate + khởi động

```bash
docker compose run --rm web ./manage.py migrate
docker compose up -d
docker compose ps
```
Mong đợi: `postgres`, `redis`, `web`, `worker` đều `Up`.

### I.4. Tạo tài khoản + project (lấy DSN)

1. Mở `http://<DOMAIN_OR_IP>:8000` → **đăng ký** (tài khoản đầu tiên tự động là **superuser**).
2. Tạo **Organization**.
3. **Create Project** → chọn platform:
   - Backend Spring Boot → **Java / Spring Boot**
   - Frontend React → **JavaScript / React**
4. Đặt tên project theo quy ước slug để Automation Rule đọc được:
   - `SHOP-be` (backend shop), `SHOP-fe` (frontend shop)
   - `CMS-be`, `CMS-fe`
5. Sau khi tạo → copy **DSN**, dạng:

   `http://<PROJECT_KEY>@<GLITCHTIP_HOST>:8000/<PROJECT_ID>`

   ⚠️ **Không ghi DSN thật vào tài liệu** — điền vào cấu hình service ở Bước 7.

---

## J. Bước 7 — Gắn Sentry DSN vào 4 service

DSN lấy từ Bước 6 (hoặc do admin cấp). Mỗi project GlitchTip = 1 DSN riêng.

| Service | Loại | File cần sửa | Biến | Giá trị |
|---|---|---|---|---|
| `services/shop-api` | Spring Boot | `src/main/resources/application.properties` | `sentry.dsn` | `<DSN_PROJECT_SHOP_BE>` |
| `services/shop-web` | Vite React | `.env` (file `.env` của Vite, đã tồn tại) | `VITE_SENTRY_DSN` | `<DSN_PROJECT_SHOP_FE>` |
| `services-2/cms-api` | Spring Boot | `src/main/resources/application.properties` | `sentry.dsn` | `<DSN_PROJECT_CMS_BE>` |
| `services-2/cms-web` | Vite React | `src/main.jsx` — **chưa có file `.env`**, phải tạo | `VITE_SENTRY_DSN` | `<DSN_PROJECT_CMS_FE>` |

> Lưu ý: `cms-web` **không có** `application.properties` (đây là Vite React, không phải Spring Boot) và **không có** file `.env` sẵn → phải tạo `services-2/cms-web/.env`.
> Phiên bản SDK khác nhau: `shop-web` dùng `@sentry/react ^11.6.0`, `cms-web` dùng `@sentry/react ^8.34.0`. Cả hai đều hợp lệ — không cần đồng nhất.

### J.1. Backend Spring Boot (2 repo `api`)

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

### J.2. Frontend React (2 repo `web`)

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

### J.3. Kiểm tra DSN hoạt động

```cmd
cd services\shop-web
npm install
npm run dev
```
Mở `http://localhost:5173`, cố tình throw lỗi trong console (`throw new Error('DSN test')`) → vào GlitchTip, kiểm tra project có issue mới.

---

## K. Bước 8 — Setup Jira (project + Automation Rule)

### K.1. Project Jira

- Project `SHOP` (đã có, tên `P1-SHOP`) và `CMS` (`P2-CMS`).
- Issue type `Bug` phải tồn tại.
- Workflow hiện có các trạng thái: `Backlog`, `Selected for Development`, `In Progress`, `Done`.
  > Worker chỉ quét ticket ở trạng thái: `"To Do"`, `"Selected for Development"`, `"Backlog"` (`worker.js:636`).
  > Nếu workflow của bạn không có `To Do`, dùng `Backlog` hoặc `Selected for Development`.

### K.2. Tạo Automation Rule (nhận webhook từ GlitchTip)

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

### K.3. (Tuỳ chọn) Thay Jira Automation bằng `webhook_bridge.js`

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

## L. Bước 9 — Nối Alert Webhook GlitchTip → Jira

Trong GlitchTip: **Settings → Projects → chọn project → tab Alerts → Create Alert**

| Trường | Giá trị |
|---|---|
| Name | `Auto-Fix → Jira` |
| Conditions | `A new issue is created` (hoặc `An issue is seen more than X times` → X=1) |
| Action | `Webhook` |
| URL | **Webhook URL** đã copy ở K.2 bước 1 |
| Send initial data | bật (để có `issue.title`, `issue.culprit`, `issue.web_url`) |

Lặp lại cho từng project (SHOP-be, SHOP-fe, CMS-be, CMS-fe).

> Nếu dùng `webhook_bridge.js` thì URL điền `http://<HOST>:9000/webhook/<PROJECT_KEY>`.

---

## M. Bước 10 — Chạy worker

### M.1. Kiểm tra lần cuối trước khi chạy

```cmd
cd /d I:\AI\auto-fix-bug-jira
node --env-file=.env -e "console.log('domain',!!process.env.JIRA_DOMAIN,'| token',!!process.env.JIRA_TOKEN,'| git',!!(process.env.GIT_TOKEN||process.env.GITHUB_TOKEN),'| telegram',!!process.env.TELEGRAM_BOT_TOKEN,'| chat',!!process.env.TELEGRAM_CHAT_ID,'| users',!!process.env.TELEGRAM_ALLOWED_USER_IDS)"
```
Mong đợi tất cả là `true` (trừ `telegram`/`chat`/`users` nếu bạn cố ý bỏ Telegram — khi đó chỉ mất chức năng **báo cáo Telegram**; luồng duyệt Merge đã bị tắt tạm thời).
> `GIT_TOKEN` và `GITHUB_TOKEN` là hai tên cho cùng một giá trị; worker nhận cả hai (`worker.js:94`). Dùng `GIT_TOKEN` cho khớp `.env.example`.

Kiểm tra 4 thư mục service tồn tại:
```cmd
dir services\shop-api services\shop-web services-2\cms-api services-2\cms-web
```

### M.2. Chạy bằng script có sẵn (khuyến nghị)

```cmd
cd /d I:\AI\auto-fix-bug-jira
start-worker.bat
```
Script sẽ: `cd /d %~dp0` (đúng CWD) → `node --env-file=.env worker.js` → giữ cửa sổ mở để xem log.

### M.3. Log khởi động mong đợi

```
🚀 Singleton Master Worker Level 3 đã sẵn sàng...
• MAX_CONCURRENT_JOBS: 2
[+] Đang quét Jira cho dự án SHOP...
[+] Tìm thấy 0 bug cho dự án SHOP
[+] Đang quét Jira cho dự án CMS...
[+] Tìm thấy 0 bug cho dự án CMS
```
Lặp lại mỗi **15 giây** (`worker.js:957`).

### M.4. Restart / dừng worker

```cmd
restart-worker.bat
```
`restart-worker.bat` kill tiến trình `node worker.js` cũ rồi mở cửa sổ mới. Dừng: đóng cửa sổ CMD, hoặc:
```cmd
taskkill /F /FI "WINDOWTITLE eq Jira-AutoFix-Worker*" /T
```

> **Chỉ chạy 1 worker.** Hai worker cùng chạy sẽ tranh nhãn `auto-fix-processing` (may mắc, còn lại bỏ qua) — nhưng vẫn nên tránh.
> **Chạy worker ở CMD riêng**, không chạy từ trong phiên Claude Code (tránh kẹt process/hook).
> ⚠️ **Sửa `projects.json` / `services.json` phải restart worker.** Worker đọc `projects.json` **đúng 1 lần lúc khởi động** (`worker.js:33-37`) → không có cơ chế reload tự động. (`GLITCHTIP_GUIDE.md:258` nói ngược lại — tài liệu đó sai.)
>
> ✅ **Hook `.claude/hooks/pre-tool-use.js` ĐÃ CÓ HIỆU LỰC.** Worker **không copy gì** vào repo service; nó nạp hook + rules qua CLI args khi gọi `claude -p`:
>
> 1. Repo worker giữ hook `.claude/hooks/pre-tool-use.js`; worker **sinh `.claude/settings.generated.json`** lúc khởi động (`ensureWorkerSettings`, `worker.js:14-30`) — file này **đã gitignore** (chứa đường dẫn tuyệt đối của máy) — với lệnh hook trỏ tới **đường dẫn TUYỆT ĐỐI** `node "<abs>/.claude/hooks/pre-tool-use.js"` (khung `PreToolUse` matcher `*`).
> 2. Khi checkout branch hotfix trong repo service, worker **KHÔNG ghi bất kỳ file nào** (`.claude/`, `CLAUDE.md`) vào `<service-repo>/` (`worker.js:1000-1003`). Thay vào đó, lệnh `claude -p` được gọi với `--settings <đường dẫn tuyệt đối tới settings.generated.json>` (`worker.js:34-38`) và `--append-system-prompt "<nội dung CLAUDE.md của worker>"` (`worker.js:39-42`).
> 3. Vì `claude -p` được spawn với `cwd = <repo service>` nhưng `--settings` trỏ tới **file tuyệt đối của worker** → hook guardrail chạy thật trong phiên Claude Code do worker spawn, **không cần** `.claude/settings.json` trong repo service.
>
> → Bảo vệ chặn `rm -rf` / `git push --force` / `.env` / `worker.js` **đang bật** trong mọi job auto-fix (áp dụng cho lệnh do **Claude** tự chạy; worker **tự** push branch của nó nên không đi qua hook này). Repo khách **hoàn toàn sạch** → PR không bao giờ kèm file lạ.
>
> ⚠️ **Vì sao root repo KHÔNG có `.claude/settings.json`?** Hook chặn theo mẫu chuỗi `worker.js` / `.env` trong argv → bật ở root sẽ tự chặn chính phiên dev của bạn. Giờ root repo **hoàn toàn không có `settings.json`** và cũng **không cần** có: hook chỉ được nạp qua `--settings` trong phiên Claude Code do worker spawn, nên phiên dev của bạn không bị ảnh hưởng.
>
> 🔴 **Hook phải trả exit code `2` (blocking error) — KHÔNG được đổi thành `1`.** Claude Code coi exit code `1` là **non-blocking error** → tool **VẪN CHẠY** → guardrail vô hiệu. Hook dùng `process.exit(2)` (`pre-tool-use.js:19`). Đã kiểm chứng: khi có `--settings`, Claude Code thử đọc file `.env` trong repo service bị **chặn** (`is_error: true`); đối chứng không có `--settings` thì đọc `.env` thành công. ⚠️ Đừng sửa `process.exit(2)` → `process.exit(1)`.
>
> Lưu ý: hook chặn theo **mẫu chuỗi** trong argv + JSON của tool → cũng chặn nhầm khi AI đọc/ghi file có tên chứa `.env` (vd `.env.example`).

### M.4.1. Validate cấu hình lúc khởi động (worker **thoát ngay** nếu sai)

Worker **không chạy im lặng** khi cấu hình sai — nó dừng ngay lúc khởi động:

1. **Thiếu cấu hình bắt buộc** (`JIRA_DOMAIN` / `JIRA_EMAIL` / `JIRA_TOKEN` / `GIT_TOKEN`) → worker in:

   ```
   [LOI] Thiếu cấu hình bắt buộc: JIRA_TOKEN, GIT_TOKEN
   [LOI] Điền các biến này vào file .env (xem .env.example) rồi khởi động lại worker.
   ```

   rồi `process.exit(1)` **ngay lúc khởi động** (`worker.js:200-213`). `GIT_TOKEN` rỗng còn tệ hơn: `createGitHubPR` trả về số PR giả → báo "đã tạo PR" cho PR không tồn tại.

2. **Token Jira sai/rỗng** → worker gọi `GET /rest/api/3/myself` lúc khởi động để xác thực (`validateJiraAuth`, `worker.js:217-235`).

   **Vì sao phải dùng `/myself` mà không kiểm tra qua JQL?** `/rest/api/3/search/jql` trả **HTTP 200 + `{"issues":[]}`** khi token rỗng/sai → trước đây worker log *"Tìm thấy 0 bug"* **mỗi 15 giây một cách âm thầm**, người dùng tưởng hệ thống đang hoạt động bình thường. `/myself` trả **HTTP 401** khi token sai → worker dừng với thông báo rõ ràng:

   ```
   [LOI] Xác thực Jira thất bại: HTTP 401. Kiểm tra JIRA_DOMAIN / JIRA_EMAIL / JIRA_TOKEN trong .env.
   [LOI] Worker dừng. Nếu chạy tiếp, mỗi vòng 15s sẽ log "0 bug" giả.
   ```

   Thành công thì in `[+] Xác thực Jira thành công: <email>`. Kiểm tra thủ công (không cần chạy worker) → xem mục **E.4**.

### M.5. Worker đang làm gì mỗi vòng 15s

**JQL mà worker dùng** (`worker.js:661`):

```
project = <KEY> AND issuetype = Bug
  AND status IN ("To Do", "Selected for Development", "Backlog")
  AND (labels = "auto-fix" OR summary ~ "AUTO-BUG")
  AND labels != "auto-fix-processing" AND labels != "auto-fix-done" AND labels != "auto-fix-failed"
```

Các bước mỗi vòng 15 giây:

1. Với mỗi project trong `projects.json` → gọi JQL trên → lấy **tối đa 1 ticket / project / vòng**.
2. Gắn nhãn `auto-fix-processing` (khoá atomics) — **kiểm tra `res.ok`**, lỗi HTTP thì in rõ ràng và **bỏ qua ticket** (`worker.js:682-699`).
3. Đọc nhãn `service:*` → suy ra thư mục service qua `services.json` (path tuyệt đối hoặc tương đối — xem mục [G](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker)).
4. **Checkout branch hotfix trực tiếp trong repo service** (`hotfix/<ISSUE_KEY>-<YYYYMMDD-HHMMSS>`, base = `origin/<target>` = staging — `worker.js:948-954`, `:937`) → **không copy file nào vào repo service** (rules + hook nạp qua `--append-system-prompt` / `--settings`) → chạy Claude 2 vòng:
   - **Repro**: prompt = `Bug: ${summary}` + hướng dẫn repro (`worker.js:970`). Claude chạy trong repo service, nên evidence AI ghi nằm ở `<service>/evidence/...` → worker **copy ngược về** thư mục evidence của nó (`worker.js:1053`).
   - **Fix** (sửa code + **viết unit test đầy đủ** + chạy lệnh test + tự `git commit` theo Conventional Commits) → evidence `after` cũng được thu thập từ repo service (`worker.js:1003`).
5. Kiểm tra diff có thật sự đổi mã nguồn (`src/`, `.java`, `.js`, `.ts`, `.pom.xml`, `package.json`) → nếu không có thì **fail job**, không merge.
6. **Worker TỰ verify** (`verifyService`, `worker.js:811-859`) — **không tin báo cáo tự khai của AI**, **dừng ngay khi bước nào fail**:
   - **(a) Unit test đầy đủ** — api: `mvnw.cmd -B clean test jacoco:report`; web: `npm test -- --run` (nếu có script `test`), không thì `npm run build`.
   - **(b) Coverage** (chỉ api) — đọc `target/site/jacoco/jacoco.csv`, **đúng các class trong file `src/main/java/...` đã sửa** phải **≥ 90%**. Thiếu CSV / class không có trong CSV / coverage < 90% → **fail**.
   - **(c) Build** — api: `mvnw.cmd -B -DskipTests package`; web: `npm run build`.
   - → Bất kỳ bước nào fail ⇒ job fail ⇒ **KHÔNG merge**.
7. **Worker TỰ merge vào staging** (`worker.js:1096-1102`): `git checkout <target>` → `git pull --ff-only origin <target>` → `git merge --no-ff -m "fix(auto): merge <branch> into <target> [AUTO-BUG]" <branch>` → `git push <url> <target>` (**không** `push --force`) → cuối cùng `git checkout <target>` lại cho repo sạch.
8. **Kiểm tra pipeline CI** (`checkCiPipeline`, `worker.js:861-900`): nếu repo **chưa có** workflow GitHub Actions → `status: 'skipped'` → **bỏ qua, không chặn**. Nếu có workflow → `ok` / `running` / `failed` (vẫn báo Telegram nhưng không chặn).
9. Gửi Telegram: *"🚀 ĐÃ FIX & DEPLOY LÊN <target> THÀNH CÔNG!"* + ticket, service, summary, branch, dòng xác minh PASS, dòng đã merge, dòng pipeline (⏭️/✅/⏳/❌) + nút **🔗 Xem branch <branch>**; comment Jira tương tự (có ghi rõ *"Chưa tạo PR lên production (tạm thời bỏ qua)."*).
10. Gỡ nhãn `auto-fix-processing`, thêm `auto-fix-done` (thành công) hoặc `auto-fix-failed` (lỗi) — **retry 3 lần**, cách nhau 2s (`worker.js:730-746`).

> ⚠️ **Hai giới hạn thực tế cần biết trước khi vận hành:**
>
> **(a) Worker KHÔNG gửi Telegram khi job fail.**
> `processBugWrapper` (`worker.js:712-723`) chỉ gắn nhãn `auto-fix-failed` + comment trên Jira. **Không** có tin nhắn Telegram báo lỗi/timeout. Muốn biết job fail → xem nhãn trên Jira hoặc log terminal, **đừng chờ tin nhắn Telegram**.
>
> ⚠️ **Jira Description KHÔNG được truyền cho Claude.**
> Prompt chỉ chứa `summary` (`worker.js:970` cho repro, `worker.js:960` cho fix); description chỉ được ghi ra file `<KEY>_error.txt` ở thư mục evidence của worker (ngoài repo service → AI không đọc được).
> → **Đặt toàn bộ thông tin quan trọng vào SUMMARY của ticket**: endpoint bị lỗi, stack trace, service, URL. Không dựa vào Description.
>
> ✅ **Đã hết 2 known gap cũ:** check "repro phải có evidence" **không còn luôn pass** (đã thu thập từ repo service + bỏ qua file placeholder — `worker.js:1053`, `:1060-1061`), và `evidence/<KEY>/after/` **đã được điền** (`worker.js:1003`).

---

## N. Bước 11 — Kiểm thử end-to-end

### N.1. Tạo ticket thử (nhanh nhất, không qua GlitchTip)

Trong Jira, tạo issue:
- Project `SHOP`, type `Bug`
- Summary: `[AUTO-BUG] Divide by zero at GET /api/calculate — ArithmeticException: / by zero (service:api)` → **nhét hết thông tin lỗi vào Summary** (xem cảnh báo ở M.5)
- Labels: `auto-fix`, `service:api`
- Status: `Backlog` (hoặc `Selected for Development`)

> Dùng `summary ~ "AUTO-BUG"` cũng kích hoạt được, nhưng **vẫn phải có** nhãn `service:api`.
> ⚠️ **Phải tạo ticket MỚI.** Ticket cũ `SHOP-1`/`SHOP-2` đã mang nhãn `auto-fix-done` / `auto-fix-failed` → JQL loại trừ → worker **bỏ qua**. Nếu muốn chạy lại ticket cũ thì phải **xoá 3 nhãn** `auto-fix-processing`, `auto-fix-done`, `auto-fix-failed`.
> ⚠️ **Tên trạng thái phải khớp chính xác.** JQL lọc `status IN ("To Do", "Selected for Development", "Backlog")`. Workflow SHOP/CMS hiện có `Backlog`, `Selected for Development`, `In Progress`, `Done` — **không có `To Do`**. Nếu ticket nằm ở `In Progress`/`Done` → worker không thấy. Chuyển về `Backlog` trước khi test.
>
> 💡 Nếu "Tìm thấy 0 bug" mà bạn thấy rõ ticket trên UI → chạy lệnh kiểm tra JQL ở **Phụ lục D, mục D.30** để xem chính xác nguyên nhân (thiếu label? sai status? thiếu issuetype Bug?).

### N.2. Theo dõi

| Nơi | Mong đợi |
|---|---|
| CMD worker | `[+] Giao việc thành công: SHOP-x` → `Bước 1: Repro Bug` → `Bước 2: Fix Bug` → `[TEST] Chạy: mvnw.cmd -B clean test jacoco:report` → `[COVERAGE] OK — <Class>=100%` → `[BUILD]` OK → `[+] Xác minh PASS` → `[+] Đã merge vào staging` |
| Jira | Issue chuyển nhãn `auto-fix-processing` → `auto-fix-done`; có comment *"🚀 ĐÃ FIX & DEPLOY LÊN staging THÀNH CÔNG!"* kèm dòng xác minh + dòng pipeline + ghi rõ *"Chưa tạo PR lên production (tạm thời bỏ qua)."* |
| `evidence/<KEY>/before/` | Có `<KEY>_error.txt` (tự tạo từ Jira description) **+ các file do AI tạo** (worker copy ngược từ repo service, `worker.js:1053`). Nếu AI không tạo bằng chứng thật → job fail. |
| `evidence/<KEY>/after/` | Có kết quả test sau khi fix (thu thập từ repo service, `worker.js:1077`). Trước đây luôn rỗng. |
| Repo service (local) | Branch `hotfix/SHOP-x-<timestamp>` được tạo, commit của AI nằm trên đó; sau khi merge xong worker `git checkout staging` lại → repo sạch, chỉ còn nhánh hotfix trên remote. |
| Telegram | Báo cáo kết quả + nút **🔗 Xem branch <branch>**. **Không** có nút 🔀 Merge / ⏳ Lưu vào hàng đợi nữa (đã tắt tạm thời). |
| `pending-prs.json` | **Không còn** — luồng PR đã bị tắt, worker không tạo danh sách chờ PR nữa. |

### N.3. Kết quả trên Telegram (KHÔNG còn bước duyệt Merge)

**Luồng duyệt thủ công đã bị tắt tạm thời.** Worker **tự verify → tự merge vào staging** sau khi 3 bước xác minh đều pass:

1. **Không còn nút 🔀 Merge / 🔀 Merge vào staging / 🔀 Merge PR vào production.** Bấm các nút này (nếu còn sót từ tin nhắn cũ) → worker trả lời: *"Tính năng duyệt PR thủ công tạm thời bị tắt. Worker tự merge vào staging sau khi unit test + build pass."*
2. **Không còn nút ⏳ Lưu vào hàng đợi, không còn 📋 Xem danh sách đợi Merge.** Bấm → *"Danh sách chờ PR tạm thời bị tắt. Worker tự chạy unit test + coverage + build, sau đó tự merge branch hotfix vào nhánh target (staging) và báo cáo kết quả."*
3. **Telegram chỉ nhận BÁO CÁO KẾT QUẢ:** *"🚀 ĐÃ FIX & DEPLOY LÊN <target> THÀNH CÔNG!"* + ticket, service, summary, branch, dòng xác minh PASS, dòng đã merge, dòng trạng thái pipeline (⏭️ skipped / ✅ ok / ⏳ running / ❌ failed) + nút **🔗 Xem branch <branch>**.
4. **PR lên production: TẠM THỜI KHÔNG TẠO.** Không có PR nào mở ra nữa — kể cả PR vào `staging`. Comment trên Jira cũng ghi rõ *"Chưa tạo PR lên production (tạm thời bỏ qua)."*

**Nếu merge có conflict** → worker tự gọi Claude gỡ conflict (tìm marker `<<<<<<<`, chạy lại test, commit `fix(conflict): ...`) rồi merge lại (`worker.js:1096-1102`). Sau khi gỡ conflict, worker chạy lại bước verify trước khi merge.

### N.4. Test đầy đủ qua GlitchTip

1. Chạy `shop-api` (`8080`) và `shop-web` (`5173`).
2. Mở web → gọi endpoint lỗi (`http://localhost:8080/api/calculate`).
3. GlitchTip phải hiện issue mới (project tương ứng).
4. Alert webhook → Jira Automation → tạo ticket `[AUTO-BUG] ...` với nhãn `auto-fix` + `service:api`.
5. Worker tự xử lý như N.2.

---

## O. Phụ lục A — Bảng đầy đủ biến môi trường

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

## P. Phụ lục B — Bản đồ ticket → service → repo

| Nhãn `service:*` | `services.json` khớp theo | Thư mục | Repo | Lệnh test worker bảo AI chạy | Lệnh chạy được thực tế | Prefix commit AI phải dùng |
|---|---|---|---|---|---|---|
| `service:api` | `name === "api"` | `services/shop-api` | `thanhpk6120/shop-api` | `'mvnw.cmd -B clean test jacoco:report' or 'mvn -B clean test jacoco:report'` | `mvnw.cmd -B clean test jacoco:report` hoặc `mvn -B clean test jacoco:report` (Windows: `./mvnw` **không** chạy) | `fix(api):` |
| `service:web` | `name === "web"` | `services/shop-web` | `thanhpk6120/shop-web` | `'npm run build'` | `npm run build` — đã bỏ `npm test` vì `shop-web` không có script `test` | `fix(web):` |
| `service:api` (CMS) | `name === "api"` | `services-2/cms-api` | `thanhpk6120/cms-api` | `'mvnw.cmd -B clean test jacoco:report' or 'mvn -B clean test jacoco:report'` | `mvnw.cmd -B clean test jacoco:report` | `fix(api):` |
| `service:web` (CMS) | `name === "web"` | `services-2/cms-web` | `thanhpk6120/cms-web` | `'npm run build'` | `npm run build` | `fix(web):` |

Cơ chế khớp (`worker.js:822`): `s.name === targetService || s.path === targetService || s.path.endsWith(targetService)`.

> Lệnh test AI được bảo chạy lấy từ `worker.js:929-934` (chọn theo `targetService`). Prefix commit lấy từ `worker.js:931`/`:933` → `fix(api):` / `fix(web):`.
> ✅ Lệnh đã được sửa cho Windows: dùng `mvnw.cmd -B` (không phải `./mvnw`) và bỏ `npm test` cho web.

---

## Q. Phụ lục C — Xử lý sự cố

| Triệu chứng trong log | Nguyên nhân | Cách xử lý |
|---|---|---|
| `⚠️ Thiếu cấu hình Jira...` | Thiếu `JIRA_DOMAIN/EMAIL/TOKEN` trong `.env` | Chạy lại bằng `node --env-file=.env worker.js` (không dùng `node worker.js`) |
| `[+] Tìm thấy 0 bug cho dự án SHOP` mãi | Sai `projectKey` trong `projects.json`, hoặc ticket thiếu nhãn `auto-fix`, hoặc sai trạng thái | Chạy lệnh kiểm tra JQL ở **Phụ lục D, mục D.30**; sửa label/status |
| `[Fail-Safe Abort] Ticket ... không có nhãn 'service:*'` | Ticket thiếu nhãn `service:api`/`service:web` | Thêm nhãn trong Jira |
| `[Fail-Safe Abort] Thư mục service '...' không tồn tại` | Chưa clone repo service (Bước 2) | Clone đúng path trong `services.json` |
| `[Fail-Safe Abort] Service '...' thiếu gitRepo hoặc cấu hình branches` | `services.json` thiếu trường | Bổ sung `gitRepo`, `branches.dev`, `branches.prod` |
| `Claude exited with code ...` | Claude CLI chưa đăng nhập / relay nội bộ tắt / sai `ANTHROPIC_BASE_URL` | Làm **Bước 0** (B.0): `claude -p "ping"` phải trả lời được. Nếu OK mà worker vẫn lỗi → chạy worker từ CMD riêng có cùng biến môi trường |
| `Repro fail: AI không tạo bằng chứng trong 'evidence/<KEY>/before'` | AI không chạy lệnh lưu evidence | Xem log Claude trong terminal; sửa `CLAUDE.md` để rõ quy tắc evidence |
| `Diff rỗng hoặc chỉ chứa file rác/evidence` | AI sửa file ngoài `src/` hoặc không sửa gì | Xem diff trong repo service (`git diff origin/staging..HEAD`); sửa `CLAUDE.md` |
| `npm error Missing script: "test"` | `shop-web/package.json` **không có** script `test` | Dùng `npm run build` (đã build OK); hoặc thêm script `test` vào `package.json` |
| `Host <X> là git tự host, không hỗ trợ tự động merge` | `GIT_HOST` ≠ github.com | Merge thủ công trên Web UI, hoặc dùng GitHub |
| `409 Conflict` khi gọi `getUpdates` | Có tiến trình khác đang dùng cùng bot token | Tắt worker cũ (`restart-worker.bat`) rồi thử lại |
| Không có tin nhắn Telegram nào | Thiếu `TELEGRAM_BOT_TOKEN`/`CHAT_ID`, hoặc bot chưa vào nhóm | Làm lại Bước 5, test bằng `curl .../getMe` và `sendMessage` |
| `⛔ Bạn không có quyền duyệt tác vụ này!` | User id không có trong `TELEGRAM_ALLOWED_USER_IDS` | Thêm id (lấy từ `@userinfobot`) |
| `409 Conflict` khi gọi `getUpdates` | Có tiến trình khác đang dùng cùng bot token | Tắt worker cũ (`restart-worker.bat`) rồi thử lại |
| Repo service còn dính branch hotfix cũ (worker bị kill giữa chừng) | Worker bị kill trước kịp `git checkout <target>` lại | `git -C services\shop-api status` → xem branch hiện tại; `git -C services\shop-api checkout staging` để đưa repo về nhánh target |

---

## R. Phụ lục D — Gotcha đã kiểm chứng

| # | Gotcha | Bằng chứng | Xử lý |
|---|---|---|---|
| D.1 | `worker.js` **không** đọc `.env`; chạy `node worker.js` sẽ không có biến môi trường | Không có `require('dotenv')`; `start-worker.bat:21` dùng `node --env-file=.env` | Luôn dùng `start-worker.bat` (hoặc `node --env-file=.env worker.js`). **File `.env` mẫu đã có sẵn ở root** với `JIRA_DOMAIN` / `JIRA_EMAIL` / `CLAUDE_MODEL` / `CLAUDE_TIMEOUT_MS` / `MAX_CONCURRENT_JOBS` đã điền; các secret (`JIRA_TOKEN`, `GIT_TOKEN`, `TELEGRAM_*`) **để trống** → phải điền thủ công. Lưu ý: `JIRA_TOKEN`/`GIT_TOKEN` để trống → worker **thoát ngay lúc khởi động** (`[LOI] Thiếu cấu hình bắt buộc`, exit 1) chứ **không chạy im lặng** (xem M.4.1) |
| D.2 | ~~`projects.json` / `services.json` đọc theo CWD~~ → **ĐÃ SỬA**: worker dùng `__dirname` (`WORKER_ROOT`) nên **không còn phụ thuộc CWD**; `services.json` vẫn được tìm theo thư mục project | `worker.js:30` (`const WORKER_ROOT = __dirname`), `:35` (`readFileSync(path.join(WORKER_ROOT,'projects.json'))`), `resolveProjectDir` `:43-53` | Chạy worker từ **bất kỳ thư mục nào** cũng được. `services.json` vẫn phải nằm trong thư mục project (xem mục [G](#g-dùng-worker-cho-nhiều-dự-án-service-nằm-ngoài-thư-mục-worker)) |
| D.3 | ~~`evidence.js` ghi vào `process.cwd()/evidence`~~ → **ĐÃ SỬA**: ghi vào `__dirname/evidence` | `evidence.js:5` (`const EVIDENCE_DIR = path.join(__dirname, 'evidence')`) | Evidence luôn nằm cạnh `worker.js`, không phụ thuộc thư mục chạy |
| D.4 | Kiểm tra JQL thủ công (không cần chạy worker) | Script `jql-check.js` ở **mục D.30** | Dùng khi debug "0 bug" |
| D.5 | `shop-web` không có script `test` | `package.json` scripts = `dev`, `build` | Dùng `npm run build` |
| D.6 | `shop-api` không có actuator → không có `/actuator/health` | `pom.xml` không có `spring-boot-starter-actuator` | Health-check bằng endpoint thật hoặc check port |
| D.7 | Trên Windows, `./mvnw` không chạy; dùng `mvnw.cmd` hoặc `mvn` | `./mvnw.cmd` → *"is not recognized"*; `cmd /c mvnw.cmd` → OK | Sửa `CLAUDE.md` ghi rõ `mvnw.cmd -B clean test` |
| D.8 | ~~Worker chỉ tạo PR vào nhánh `prod`; `branches.target` được đọc nhưng không dùng để tạo PR~~ → **ĐÃ SỬA (flow mới)**: `branches.target` được dùng thật làm **base** tạo branch hotfix **và** làm nhánh đích **merge**, worker **tự verify → tự merge**, **không còn tạo PR nào** | `worker.js:952` (`baseBranch = targetBranch \|\| devBranch`), `worker.js:1096-1102` (tự merge: `checkout <target>` → `pull --ff-only` → `merge --no-ff` → `push`), `worker.js:1090-1093` (gọi `verifyService` trước khi merge) | **Không còn bước duyệt thủ công.** Worker tự merge vào `staging` sau khi unit test + coverage + build đều pass. PR lên production **tạm thời không tạo** |
| D.9 | ~~Phase `after` của evidence chưa được worker điền~~ → **ĐÃ SỬA**: giờ worker thu thập `after` từ repo service | `worker.js:1077` (thu thập evidence phase `after`; thư mục làm việc nay là chính repo service, `worker.js:913`) | Cả `before/` và `after/` đều có bằng chứng thật từ AI |
| D.10 | ~~Nhánh `hotfix/<KEY>` bị `git branch -D` mỗi lần → commit cũ trên remote bị ghi đè (`push --force`)~~ → **ĐÃ SỬA**: tên branch nay có **timestamp** (`hotfix/<KEY>-<YYYYMMDD-HHMMSS>`), **đã bỏ** `git branch -D`, **không còn** `push --force`, và thư mục làm việc nay là **chính repo service** (không còn thư mục riêng cho từng ticket) | `worker.js:948-949` (`runStamp` → `branchName = hotfix/${issueKey}-${runStamp}`), `worker.js:948-954` (tạo branch trực tiếp trong repo service, base = `origin/<target>`), `worker.js:994-998` (`git checkout -b`) | Mỗi lần retry tạo branch **RIÊNG** → không ghi đè lịch sử cũ trên remote. `--force-with-lease` chỉ là fallback, không ghi đè branch ai đó vừa push |
| D.11 | ~~`CLAUDE.md` mô tả path sai (`services/api`, `services/web`)~~ → **ĐÃ SỬA**: `CLAUDE.md` đã được viết lại, dùng path **TƯƠNG ĐỐI so với repo service** | `CLAUDE.md` (mục "Bối cảnh thư mục làm việc"); worker **nạp file này qua `--append-system-prompt`** khi gọi `claude -p` (`worker.js:39-42`) | Không còn sửa path thủ công — xem [Phụ lục E](#s-phụ-lục-e--claudemd--path-tương-đối-so-với-repo-service) |
| D.12 | ~~`services/shop-web/.env` đang được commit~~ → **ĐÃ XỬ LÝ**: `.env` không còn được track, DSN đã chuyển sang biến môi trường | `git -C services/shop-web ls-files` → không có `.env`; `shop-web/.gitignore` có `.env`; `main.jsx` chỉ dùng `import.meta.env.VITE_SENTRY_DSN`; `application.properties` dùng `sentry.dsn=${SENTRY_DSN:}` | Không cần làm gì thêm. Nếu thêm service mới → làm theo [Phụ lục F](#t-phụ-lục-f--bảo-mật--rotate-secret) |
| D.13 | `webhook_bridge.js` cần `express` nhưng repo root **không có** `package.json`/`node_modules` | `require('express')` → `MODULE_NOT_FOUND` | `npm install express` (tạo `package.json` ở root) hoặc bỏ bridge, dùng Jira Automation |
| D.14 | Worker **KHÔNG** gửi Telegram khi job fail — chỉ gắn nhãn `auto-fix-failed` + comment Jira | `worker.js:712-723` (`processBugWrapper`), `markJiraIssueFailed` (`:750-770`) không gọi Telegram | Theo dõi bằng nhãn Jira / log terminal, không chờ tin Telegram |
| D.15 | ~~Bước kiểm tra "repro phải có evidence" luôn pass~~ → **ĐÃ SỬA**: worker thu thập evidence từ repo service và **bỏ qua file placeholder** do chính worker sinh | `worker.js:1053` (thu thập evidence phase `before`), `worker.js:1060-1061` (`listEvidenceFiles` lọc bỏ `<KEY>_error.txt`) | Check giờ có ý nghĩa: thiếu bằng chứng thật → job fail đúng như thiết kế |
| D.16 | Jira **description** vẫn **không** được truyền cho Claude — chỉ `summary` (**đã kiểm tra lại, vẫn đúng**) | `worker.js:970` (`runClaude(\`Bug: ${summary}. ...\`)`) và `worker.js:960` (prompt fix cũng chỉ có `summary`); `description` chỉ được ghi vào file evidence `<KEY>_error.txt` (`worker.js:965`), nằm **ngoài** repo service nên Claude không đọc được | Nhét toàn bộ thông tin lỗi vào **Summary** của ticket |
| D.17 | ~~Worker **có** tự commit khi AI quên commit, với message `fix(auto): catch uncommitted changes after ...` — **không** theo convention `fix(api):`/`fix(web):`~~ → **ĐÃ SỬA**: `ensureAICommittedItself()` nay nhận thêm tham số `commitPrefix` và dùng **đúng convention** | `worker.js:757` (signature `commitPrefix = 'fix(api)'`), `worker.js:786` (message = `` `${commitPrefix}: commit các thay đổi còn sót lại sau ${context} [AUTO-BUG]` ``), `worker.js:1056-1059` (chọn `fix(api)` / `fix(web)` theo service), `worker.js:1100` (gọi từ `processBug`), `worker.js:740` (gọi từ `resolveConflictWithClaude` với `'fix(conflict)'`) | Message sinh ra giờ đúng `fix(api): …` / `fix(web): …` / `fix(conflict): …` + hậu tố `[AUTO-BUG]` để review phân biệt commit do worker tạo. Không cần sửa tay nữa |
| D.18 | `webhook_bridge.js` suy ra `service:*` từ slug project GlitchTip: `-fe` → web, `-be` → api, **mặc định `service:api`** | `webhook_bridge.js:24-30` | Đặt tên project rõ ràng (VD `SHOP-be`, `SHOP-fe`). Nên **dùng Jira Automation** (nhãn cứng) thay vì bridge |
| D.19 | Claim lock gắn nhãn `auto-fix-processing` **phải kiểm tra `res.ok`** — lỗi HTTP (401/403/400) bị nuốt im lặng sẽ khiến ticket bị xử lý trùng vô hạn mỗi vòng 15s | `worker.js:682-699` (kiểm tra `claimRes.ok` → in lỗi rõ ràng và **bỏ qua ticket**) | Đã xử lý trong code. Nếu thấy log *"KHÔNG gắn được nhãn auto-fix-processing"* → kiểm tra `JIRA_TOKEN` / quyền gắn nhãn trong project |
| D.20 | Cập nhật nhãn kết quả (`auto-fix-done`/`auto-fix-failed`) **có retry 3 lần**, mỗi lần cách nhau 2s — trước đây lỗi bị nuốt im lặng → nhãn `auto-fix-processing` kẹt vĩnh viễn, ticket không bao giờ được xử lý lại | `worker.js:730-746` (vòng `for (let attempt = 1; attempt <= 3; attempt++)`, `await new Promise(r => setTimeout(r, 2000))`) | Đã xử lý trong code. Nếu vẫn thấy nhãn `auto-fix-processing` kẹt → xem log lỗi cập nhật nhãn, gỡ tay trên Jira |
| D.21 | ~~`CLAUDE.md` và `.claude/` từng được worker đưa vào thư mục làm việc → phải bị chặn khỏi PR của repo khách, nếu không sẽ lộ rule nội bộ của worker~~ → **ĐÃ XỬ LÝ TRIỆT ĐỂ**: giờ worker **không đưa gì** vào repo service (rules qua `--append-system-prompt`, hook qua `--settings`) → nguy cơ rò rỉ rule nội bộ **được loại bỏ tận gốc**. Với flow mới thư mục làm việc là **chính repo service** → cũng không còn thư mục phụ `.worktrees/` | `worker.js:1000-1003` (không ghi file vào repo service) + `worker.js:14-30` (`ensureWorkerSettings` sinh settings.generated.json) + `worker.js:39-42` (`--append-system-prompt`); `isIgnored` (`worker.js:673-677`) **vẫn giữ** như **lớp phòng thủ thứ 2** | Không cần làm gì thêm. Repo khách luôn sạch → commit của worker không bao giờ kèm file lạ. Đừng xóa `isIgnored` — đó là lớp dự phòng |
| D.22 | ⚠️ `shop-api` có `origin/staging` **cũ hơn `origin/master` 2 commit** → worker merge thẳng vào `staging` nên code trên staging có thể **cũ hơn master** (đã verify trên code cũ, staging lại cũ hơn `master` đang chạy) | `git -C services/shop-api rev-list --count origin/staging..origin/master` → `2`; `rev-list --count origin/master..origin/staging` → `0` (3 repo còn lại đều = 0) | **Đồng bộ `staging` với `master`** trước khi dùng thật: `git -C services\shop-api push origin origin/master:staging`. Hoặc đặt `target` = nhánh release riêng, tách khỏi `master`. Vì worker merge **tự động** vào `staging`, việc staging cũ là rủi ro thật (không còn có bước duyệt PR để chặn) |
| D.23 | ⚠️ Mỗi lần retry tạo **branch hotfix MỚI** (tên có timestamp) → branch cũ vẫn còn trên remote (không bị đóng, không bị ghi đè) | `worker.js:948-949` (`branchName` có `runStamp`), `worker.js:1113-1120` (push branch mới) | Mỗi retry sinh 1 branch mới → **người vận hành nên dọn branch hotfix cũ thủ công** trên remote nếu không còn cần (đừng để lại nhiều branch hotfix cùng 1 ticket). Không còn PR nào mở ra nữa |
| D.24 | 🔴 **Filter file Java phải match path KHÔNG có leading slash** — `git diff --name-only` trả về `src/main/java/...` (không có `/` ở đầu) → dùng `includes('/src/main/java/')` sẽ **luôn false** → **gate coverage không bao giờ chạy thật** (mọi class đều bị coi như không sửa → bypass âm thầm) | `worker.js:760-763` — `git diff --name-only` trả path không có leading slash, nên phải match cả đầu chuỗi lẫn giữa chuỗi: dùng regex `/(^\|\/)src\/main\/java\//` **thay vì** `includes('/src/main/java/')` | **ĐÃ SỬA.** Dùng regex `/(^\|\/)src\/main\/java\//`. Khi thêm filter mới cho path, **luôn** kiểm tra path thật từ `git diff --name-only` — `startsWith`/`includes` với `/` ở đầu là **bẫy kinh điển** |
| D.25 | 🔴 `checkCoverageForChangedFiles` phải kiểm tra **danh sách class TRƯỚC**, thiếu `jacoco.csv` mới fail — nếu kiểm tra CSV trước thì repo **chưa từng chạy jacoco** sẽ **fail oan** dù không có file Java nào bị sửa | `worker.js:753-774` — `changedClasses.size === 0` → `ok: true` (bỏ qua check coverage); chỉ khi có class mới đòi `target/site/jacoco/jacoco.csv` | **ĐÃ SỬA.** Thứ tự đúng: (1) gom class từ file đã sửa → (2) nếu rỗng thì pass → (3) mới kiểm tra CSV tồn tại → (4) đối chiếu coverage từng class ≥ 90%. Thiếu CSV / class không có trong CSV / coverage < 90% → **fail** |
| D.26 | ⚠️ Một số repo **vô tình track `target/`** (artifact build) → danh sách file đã thay đổi lẫn file rác (`target/**`, `dist/**`, `node_modules/**`, `*.class`) → làm loãng kiểm tra coverage và gây nhiễu diff | `worker.js:1084-1088` — `isArtifact()` lọc `target/`, `/target/`, `dist/`, `/dist/`, `node_modules/`, `/node_modules/`, `*.class` trước khi tính `changedFiles` | **ĐÃ SỬA.** Luôn lọc artifact khỏi `changedFiles` trước khi truyền vào `verifyService` / `checkCoverageForChangedFiles`. Nếu repo có track artifact → cân nhắc thêm vào `.gitignore` của repo service |
| D.27 | 🔴 `shop-api` pom yêu cầu `java.version=21`, nhưng `JAVA_HOME` mặc định của máy dev là `C:\Program Files\Java\jdk-11` → `mvnw.cmd` **fail** → bước verify unit test fail → job fail (dù code AI đã đúng) | `services/shop-api/pom.xml` → `<java.version>21</java.version>`; `mvnw.cmd` với JDK 11 → lỗi compile/`release version 21 not supported` | Set `JAVA_HOME=C:/Program Files/Java/jdk-21` (đã cài tại `C:/Program Files/Java/jdk-21`) **trước khi chạy worker**. Kiểm tra: `echo %JAVA_HOME%` → phải trỏ JDK 21 |
| D.28 | ✅ **Kiểm tra pipeline CI bỏ qua nếu repo chưa có CI** — `checkCiPipeline(gitRepo, branchName)` đọc GitHub Actions workflows + runs; repo **không có workflow** → `status: 'skipped'` → **bỏ qua, không chặn** | `worker.js:861-900` (`checkCiPipeline`); hiện 4 repo demo **không có CI nào** → luôn `skipped` | Nếu repo có workflow: `ok` (conclusion=success) / `running` / `failed` — `failed` **vẫn báo Telegram nhưng không chặn** merge. Đừng viết logic chặn khi không có workflow — sẽ chặn oan toàn bộ job |
| D.29 | ⚠️ Worker **tự merge** vào `staging` → trong lúc xử lý, `git status` của repo service hiện branch hotfix (không phải repo bẩn) | `worker.js:954` (thư mục làm việc = repo service), `worker.js:994-998` (checkout branch hotfix), `worker.js:1096-1102` (merge xong → `git checkout <target>` lại) | **Bình thường.** Đừng `git checkout`/`git stash` trong repo service khi worker đang chạy — sẽ phá vỡ job. Sau khi job xong worker tự checkout lại nhánh target → repo sạch |

### D.30 — Kiểm tra JQL (khi worker báo "Tìm thấy 0 bug")

Tạo file `jql-check.js` ở thư mục gốc repo worker:

```js
const PROJECT_KEY = 'SHOP';   // đổi thành CMS nếu cần

const auth = 'Basic ' + Buffer.from(
  process.env.JIRA_EMAIL + ':' + process.env.JIRA_TOKEN
).toString('base64');

const jql = [
  `project = ${PROJECT_KEY}`,
  'issuetype = Bug',
  'status IN ("To Do", "Selected for Development", "Backlog")',
  '(labels = "auto-fix" OR summary ~ "AUTO-BUG")',
  'labels != "auto-fix-processing"',
  'labels != "auto-fix-done"',
  'labels != "auto-fix-failed"',
].join(' AND ');

const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/search/jql`
  + `?jql=${encodeURIComponent(jql)}`
  + '&fields=summary,labels,status';

fetch(url, { headers: { Authorization: auth } })
  .then(r => r.json())
  .then(j => console.log(JSON.stringify(j, null, 1)));
```

Chạy:

```cmd
node --env-file=.env jql-check.js
```

Nếu `issues` rỗng → xem lại: thiếu nhãn `auto-fix`/`service:*`, sai trạng thái, hoặc ticket đã có nhãn `auto-fix-done`/`-failed` (xem D.15).

---

## S. Phụ lục E — `CLAUDE.md` & path tương đối so với repo service

> ✅ **Đã sửa xong — KHÔNG còn cần sửa path thủ công.**

Worker **nạp `CLAUDE.md` qua `--append-system-prompt`** khi gọi `claude -p` (`worker.js:39-42`) → AI đọc rules này để biết sửa ở đâu. Vì Claude Code chạy với `cwd` = repo service (đã checkout branch hotfix), các đường dẫn trong `CLAUDE.md` phải là **TƯƠNG ĐỐI so với repo service**.

**Vì sao path trong `CLAUDE.md` phải là TƯƠNG ĐỐI?**

Worker spawn Claude Code với `cwd = <service-repo>` (`worker.js:954` — thư mục làm việc nay trỏ thẳng về `targetServiceDir`, tức là **chính repo service**) → Claude Code **luôn đứng ở gốc repo service cần sửa**, không phải ở thư mục worker. Vì vậy mọi đường dẫn trong `CLAUDE.md` phải viết theo góc nhìn **repo service**:

| ❌ Sai (path tuyệt đối từ thư mục worker) | ✅ Đúng (tương đối so với repo service) |
|---|---|
| `services/shop-api/src/main/java/` | `src/main/java/` |
| `services-2/cms-web/src/` | `src/` |
| `git add services/shop-api/src/...` | `git add src/...` |

**Trạng thái hiện tại của `CLAUDE.md`:**

- ✅ Services Map dùng đúng tên service thật: `SHOP`/`CMS` với path `shop-api` / `shop-web` / `cms-api` / `cms-web`.
- ✅ Có mục **"Bối cảnh thư mục làm việc"** giải thích rõ `cwd` = repo service → path phải tương đối.
- ✅ Mục **Bug Localization** dùng path tương đối (`src/main/java/`, `src/`).
- ✅ Mục **Commit Conventions** giữ `fix(api):` / `fix(web):` / `fix(conflict):`.
- ✅ Mục **Strict Guardrails** giữ nguyên + thêm `CLAUDE.md`.
- ✅ Có mục **Evidence** (lưu vào `evidence/{JIRA_KEY}/before/` — tương đối so với cwd) và mục **Quy trình 2 bước**.
- ✅ Lệnh test Windows: api → `mvnw.cmd -B clean test jacoco:report` hoặc `mvn -B clean test jacoco:report`; web → `npm run build` (bỏ `npm test` vì `shop-web` không có script `test`).

> ✅ **ĐÃ SỬA.** Worker vẫn tự commit phần AI quên commit, nhưng nay dùng **đúng convention**: `fix(api):` / `fix(web):` / `fix(conflict):` + hậu tố `[AUTO-BUG]` (`worker.js:757`, `:786`, `:740`, `:1100`). Sau khi có commit, **kiểm tra message commit** — nếu vẫn thấy `fix(auto):` thì đó là code cũ, cần cập nhật `worker.js`. (Lưu ý: commit **merge** của worker dùng message riêng: `fix(auto): merge <branch> into <target> [AUTO-BUG]` — `worker.js:1096-1102`.)

---

## T. Phụ lục F — Bảo mật & rotate secret

### T.1. Secret đang tồn tại trong hệ thống

| Secret | Nơi đang nằm | Rủi ro |
|---|---|---|
| `JIRA_TOKEN` | `.env` (gitignored ✅) | Lộ nếu chia sẻ file `.env` |
| `GIT_TOKEN` | `.env` + **URL remote của 4 service repo** | Lộ nếu push log/`git remote -v` bị chia sẻ |
| `TELEGRAM_BOT_TOKEN` | `.env` | Lộ nếu chia sẻ file `.env` |
| **DSN GlitchTip** | ✅ **Đã gỡ khỏi code**: `main.jsx` dùng `import.meta.env.VITE_SENTRY_DSN`, `application.properties` dùng `sentry.dsn=${SENTRY_DSN:}`, `shop-web/.env` **không còn được track** | DSN lộ → kẻ xấu gửi event giả vào project của bạn |

### T.2. Việc cần làm (khuyến nghị)

1. **DSN không phải secret nghiêm ngặt, nhưng nên hạn chế.** Với GlitchTip mới, dùng **DSN key** riêng cho từng project và thu hồi (rotate) được.
2. ~~Gỡ DSN khỏi code~~ → **ĐÃ XỬ LÝ**:
   - `services/shop-web/src/main.jsx` và `services-2/cms-web/src/main.jsx`: chỉ còn `import.meta.env.VITE_SENTRY_DSN` (không còn fallback hardcode).
   - `services/shop-api/src/main/resources/application.properties` và `services-2/cms-api/...`: đã dùng `sentry.dsn=${SENTRY_DSN:}`; khi chạy: `SENTRY_DSN=<DSN> java -jar ...`
3. ~~Gỡ `.env` khỏi tracking của repo `shop-web`~~ → **ĐÃ XỬ LÝ**: `.env` không còn được track (`git -C services/shop-web ls-files` không có `.env`) và đã có trong `shop-web/.gitignore`. **Khi thêm service mới, làm lại bước này.**
4. Nếu **tài liệu này** (hoặc `.env`) đã bị chia sẻ ra ngoài → **rotate ngay**:
   - Jira: <https://id.atlassian.com/manage-profile/security/api-tokens> → Revoke token cũ → tạo token mới → cập nhật `.env`.
   - GitHub: <https://github.com/settings/tokens> → Revoke PAT cũ → tạo PAT mới → cập nhật `.env` **và** URL remote của 4 repo.
   - Telegram: `/revoke` với `@BotFather` → nhận token mới → cập nhật `.env`.
   - GlitchTip: vào project → **Client Keys** → revoke key → tạo key mới → cập nhật DSN ở 4 service.

### T.3. Quy tắc chung

- Không bao giờ commit `.env`, DSN hay token vào repo worker.
- Token nằm trong URL remote của repo service → khi gửi log cho người khác, phải che `https://<TOKEN>@github.com/...` → `https://***@github.com/...`.
- `worker.js` in remote URL khi push (stdio `inherit`) → log worker có thể chứa token. Xem log worker như dữ liệu nhạy cảm.

---

## Checklist hoàn tất

- [ ] **B.0 `claude -p "ping"` phải trả lời được** (bắt buộc — nếu không, mọi job auto-fix đều fail) · B.1 Node ≥ 20.6 · B.2 Git · B.3 xác nhận lần 2 · B.4 Docker (nếu tự dựng GlitchTip) · B.5 Java 21 + Maven
- [ ] **Set `JAVA_HOME=C:/Program Files/Java/jdk-21`** cho service Java — `shop-api` pom yêu cầu `java.version=21`; nếu `JAVA_HOME` trỏ JDK 11 (mặc định máy dev) → `mvnw.cmd` fail → bước verify unit test fail → job fail. Kiểm tra: `echo %JAVA_HOME%`
- [x] C Clone repo worker
- [x] **D Clone 4 repo service** + tạo nhánh `staging` + xác minh branch — **đã clone xong**
- [ ] E **Điền 3 secret vào `.env`**: `JIRA_TOKEN`, `GIT_TOKEN`, `TELEGRAM_*` (file `.env` đã tạo sẵn) + E.3 nạp env OK + E.4 test token OK
- [x] F `projects.json` (SHOP/CMS, có `root` + `path`) + `services.json` x2 (gitRepo, branches dev/target/prod)
- [ ] **H Telegram**: @BotFather → token · chat id (nhóm) · user id (@userinfobot) · `getMe` OK · `sendMessage` OK
- [ ] I GlitchTip Docker: compose up + migrate + tạo 4 project + lấy 4 DSN
- [ ] J Gắn DSN vào 4 service + kiểm tra issue xuất hiện trên GlitchTip
- [ ] K Jira: Automation Rule (2 rule/project) với nhãn `auto-fix` + `service:*`
- [ ] L Alert Webhook GlitchTip → Jira
- [ ] M Chạy `start-worker.bat` (CMD riêng) — log "sẵn sàng" + quét 2 project
- [ ] N Test E2E: tạo ticket thử → dấu hiệu repro/fix → **worker tự verify (unit test → coverage ≥ 90% → build)** → **worker tự merge vào staging** → báo Telegram + comment Jira. **Không có bước duyệt Merge** (nút 🔀 Merge / ⏳ Lưu vào hàng đợi đã bị tắt tạm thời)
- [ ] **Đồng bộ nhánh `staging` với `master` cho từng service TRƯỚC khi chạy worker thật** — kiểm tra bằng `git -C <repo> rev-list --count origin/master..origin/staging` (số > 0 nghĩa là `staging` đang cũ hơn `master`; hiện `shop-api` lệch **2 commit**). Worker merge **tự động** vào `staging` nên không còn bước duyệt PR để chặn → staging cũ là rủi ro thật. Lệnh đồng bộ: `git -C services\shop-api push origin origin/master:staging`
- [ ] **G Dùng worker cho nhiều dự án** (tuỳ chọn): thêm entry `projects.json` + `services.json` + clone repo + tạo label + ticket test
- [x] S `CLAUDE.md` đã viết lại với path **tương đối** so với repo service — không còn sửa path thủ công
- [x] T DSN đã gỡ khỏi code + `.env` đã untrack — chỉ cần **rotate token** nếu đã lộ

---

## Phụ lục G — Bản HTML để xem offline / in

Tài liệu này còn có bản HTML tự chứa (CSS + syntax highlight nhúng thẳng, **không cần mạng**):

- `SETUP_GUIDE.html` — mở bằng trình duyệt, có sidebar mục lục bám theo heading đang xem, tự bật/tắt dark mode theo hệ điều hành, hỗ trợ in ra PDF.

Sinh lại sau khi sửa `SETUP_GUIDE.md`:

```cmd
pip install markdown-it-py pygments
python tools\build-doc-html.py
```

Script tự đọc `SETUP_GUIDE.md`, tạo `SETUP_GUIDE.html`, và có thể dùng lại cho file markdown khác:

```cmd
python tools\build-doc-html.py duong-dan\file.md duong-dan\file.html
```
