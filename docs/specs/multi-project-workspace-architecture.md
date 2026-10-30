# ĐẶC TẢ KIẾN TRÚC HỆ THỐNG TỰ ĐỘNG HÓA SỬA BUG ĐA DỰ ÁN (MULTI-PROJECT WORKSPACE ARCHITECTURE)

- **Phiên bản:** 2.0.0
- **Ngày cập nhật:** 2026-10-29
- **Trạng thái:** Approved / Implementation Phase
- **Mục tiêu:** Cho phép 1 tiến trình Master Worker duy nhất (`worker.js`) điều phối, quét và sửa lỗi tự động cho toàn bộ các dự án trong tổ chức (Microservices hoặc Monorepo), với cơ chế phân định dự án linh hoạt, khoá độc quyền theo Workspace và giám sát trực quan đa phiên trên Web Dashboard.

---

## 1. Bối cảnh & Vấn đề giải quyết

### 1.1. Hiện trạng trước nâng cấp
1. **Phụ thuộc nhãn thủ công:** Worker chỉ dựa vào nhãn `service:<name>` trong Jira ticket. Nếu QA/Dev quên gắn nhãn hoặc gắn sai, worker bị `abort`.
2. **Cấu hình phân mảnh:** `projects.json` chỉ chứa đường dẫn gốc của dự án, trong khi danh sách microservices lại nằm rải rác ở từng file `services.json` cục bộ.
3. **Tranh chấp tài nguyên:** Khi xử lý nhiều bug trong cùng 1 dự án (cùng repository / worktree), các lệnh `git checkout`, `git commit`, `mvnw`, `npm run build` dễ gây xung đột, khóa git (`index.lock`) hoặc đè cổng mạng.
4. **Giao diện đơn luồng:** Web Dashboard chỉ hiển thị trạng thái của 1 ticket duy nhất. Khi hệ thống xử lý song song nhiều dự án, thông tin bị ghi đè hỗn loạn.

### 1.2. Mục tiêu kiến trúc mới
- **Quản lý Workspace tập trung (`workspaces.json`):** Định nghĩa toàn bộ hệ thống dự án, danh sách service, mapping Jira (Project Key, Project Name, Components, Stack trace package prefix, Aliases).
- **Nhận diện Service thông minh (Smart Service Localization):** Tự động phát hiện service cần sửa dựa trên nhiều dấu hiệu: Label ➔ Jira Component ➔ Package Stacktrace ➔ Summary / Description keyword.
- **Kiểm soát Concurrency 2 tầng (Hierarchical Concurrency & Mutex Lock):**
  - **Tầng 1 (Toàn hệ thống):** Giới hạn tổng số luồng AI chạy đồng thời qua `MAX_CONCURRENT_JOBS` (mặc định 2-3 jobs) để tránh cạn kiệt CPU/RAM và quá tải API Jira/Git.
  - **Tầng 2 (Từng Workspace):** Trên cùng một Workspace/Dự án **CHỈ ĐƯỢC PHÉP CHẠY 1 JOB DUY NHẤT TẠI MỘT THỜI ĐIỂM** (Per-Workspace Concurrency Lock = 1). Các bug khác cùng dự án sẽ tự động xếp hàng đợi tuần tự.
  - **Chạy song song liên dự án:** Các dự án khác nhau (`PHUB`, `SHOP`, `CMS`) được xử lý song song độc lập hoàn toàn.
- **War Room Dashboard Đa Phiên (Multi-Session War Room):**
  - Cung cấp thanh ma trận tình trạng các Workspace (Workspace Matrix Bar).
  - Hỗ trợ xem song song các phiên xử lý (Multi-Pod View) hoặc lọc chi tiết theo từng dự án (Tab View).
  - Tách biệt luồng giao tiếp Leader ➔ Agent cho từng ticket/dự án riêng biệt.

---

## 2. Cấu trúc Cấu hình Workspace (`workspaces.json`)

Tệp cấu hình trung tâm đặt tại gốc worker: `workspaces.json`

```json
{
  "maxConcurrentJobs": 3,
  "workspaces": [
    {
      "id": "bankhub",
      "name": "PartnerHub Bank Platform",
      "workspaceRoot": "D:/Project/BankHub/services",
      "concurrencyLimit": 1,
      "jira": {
        "projectKeys": ["PHUB", "BANKHUB"],
        "projectNames": ["PartnerHub", "BankHub System"]
      },
      "services": [
        {
          "name": "bankhub-admin-be",
          "folder": "bankhub-admin-be",
          "gitRepo": "bankhub/bankhub-admin-be",
          "jiraMapping": {
            "components": ["Admin Backend", "BE", "admin-be"],
            "aliases": ["bankhub-admin-be", "admin-service"],
            "packagePrefix": "vn.bankhub.admin"
          },
          "testCmd": "mvnw.cmd -B clean test jacoco:report",
          "branches": {
            "dev": "dev-auto-bug",
            "target": "dev-auto-bug",
            "staging": "deploy/k8s-auto-bug",
            "source_target": "dev",
            "source_staging": "deploy/k8s",
            "prod": "main"
          }
        },
        {
          "name": "bankhub-admin-fe",
          "folder": "bankhub-admin-fe",
          "gitRepo": "bankhub/bankhub-admin-fe",
          "jiraMapping": {
            "components": ["Admin Frontend", "FE", "admin-fe"],
            "aliases": ["bankhub-admin-fe", "admin-ui"]
          },
          "testCmd": "npm run build",
          "branches": {
            "dev": "dev-auto-bug",
            "target": "dev-auto-bug",
            "staging": "deploy/k8s-auto-bug",
            "source_target": "dev",
            "source_staging": "deploy/k8s",
            "prod": "main"
          }
        }
      ]
    },
    {
      "id": "shop",
      "name": "E-Commerce System",
      "workspaceRoot": "D:/Project/BankHub/auto-fix-bug-jira/services",
      "concurrencyLimit": 1,
      "jira": {
        "projectKeys": ["SHOP"],
        "projectNames": ["Shop Project"]
      },
      "services": [
        {
          "name": "api",
          "folder": "shop-api",
          "gitRepo": "thanhpk6120/shop-api",
          "jiraMapping": {
            "components": ["Backend", "Shop API"],
            "packagePrefix": "com.poc"
          },
          "testCmd": "mvnw.cmd -B clean test jacoco:report",
          "branches": { "dev": "master", "target": "staging", "prod": "master" }
        },
        {
          "name": "web",
          "folder": "shop-web",
          "gitRepo": "thanhpk6120/shop-web",
          "jiraMapping": {
            "components": ["Frontend", "Shop Web"]
          },
          "testCmd": "npm run build",
          "branches": { "dev": "master", "target": "staging", "prod": "master" }
        }
      ]
    }
  ]
}
```

---

## 3. Quy trình Định tuyến & Khoá luồng (Routing & Concurrency Flow)

```text
       ┌─────────────────────────────────────────────────────────────┐
       │                JIRA POLLING DISPATCHER                      │
       │    (Định kỳ 15s duyệt qua danh sách workspace trong file)    │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
              Active Jobs < MAX_CONCURRENT_JOBS (VD: 3)?
                                 /          \
                            [NO]             [YES]
                             /                 \
                  Dừng chu kỳ quét      Duyệt từng Workspace W_i
                                               │
                           Workspace W_i đang có Lock (Active)?
                                          /          \
                                     [YES]            [NO]
                                      /                 \
                          Bỏ qua W_i chu kỳ này   Lấy Bug đầu tiên khớp JQL
                          (Đảm bảo 1 luồng/WS)           │
                                                  Claim Atomic Label
                                                "auto-fix-processing"
                                                         │
                                             ┌───────────┴───────────┐
                                             │ ACQUIRE WORKSPACE LOCK│
                                             │ activeWorkspaceLocks  │
                                             │ activeJobs++          │
                                             └───────────┬───────────┘
                                                         │
                                           ┌─────────────┴─────────────┐
                                           │  SPAWN INDEPENDENT POD    │
                                           │  (Leader + 4 Specialists) │
                                           └─────────────┬─────────────┘
                                                         │
                                               [Quá trình Auto-Fix]
                                                         │
                                           ┌─────────────┴─────────────┐
                                           │ RELEASE WORKSPACE LOCK    │
                                           │ activeWorkspaceLocks.del  │
                                           │ activeJobs--              │
                                           └───────────────────────────┘
```

---

## 4. Thuật toán Nhận diện Dịch vụ (Smart Localization Algorithm)

Hàm `resolveServiceForIssue(issue, workspaceConfig)`:
1. **Bước 1 (Explicit Label):** Quét các nhãn trong `issue.fields.labels`. Nếu có nhãn `service:<name>`, kiểm tra khớp với `service.name` hoặc `service.folder` trong workspace.
2. **Bước 2 (Jira Components):** Kiểm tra `issue.fields.components`. So khớp với danh sách `service.jiraMapping.components`.
3. **Bước 3 (Stack trace Inspection):** Quét text lỗi trong `description` hoặc file đính kèm. Nếu chứa chuỗi package prefix (ví dụ: `vn.bankhub.admin` hoặc `com.poc`), tự động chọn service tương ứng.
4. **Bước 4 (Keyword / Alias):** Kiểm tra các từ khóa trong `jiraMapping.aliases` xuất hiện trong tiêu đề (`summary`).
5. **Fail-Safe:** Nếu không tìm thấy, hệ thống ghi log chi tiết, gắn nhãn `auto-fix-failed` và gửi thông báo hướng dẫn bổ sung mapping về Telegram.

---

## 5. Mô hình Trạng thái Đa Phiên trên Dashboard (Multi-Session State Model)

File trạng thái realtime `evidences/agents_status.json`:
- Chứa thuộc tính `activeSessions: { [workspaceId]: sessionData }`.
- Mỗi `sessionData` gồm:
  - Thông tin Ticket (`ticketKey`, `summary`, `service`, `projectName`).
  - Tiến độ 5 bước (`progressStep`: 1 đến 5).
  - Trạng thái 5 Agent (`leader`, `analyzer`, `coder`, `tester`, `devops`).
  - Dòng hội thoại giao tiếp riêng biệt `communications: [...]`.
- Web Dashboard hiển thị thanh điều hướng phiên:
  - Cho phép người dùng chuyển đổi qua lại giữa các dự án đang xử lý.
  - Hiển thị bảng tổng hợp toàn bộ các Workspace để theo dõi tổng thể.
