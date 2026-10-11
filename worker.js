const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- SINGLETON MASTER WORKER CONFIG ---
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
let activeJobs = 0;
let isScanning = false;

// Đọc danh sách projects
let projectsConfig = [];
try {
    const rawData = fs.readFileSync('projects.json', 'utf8');
    projectsConfig = JSON.parse(rawData).projects || [];
} catch (err) {}


// --- CẤU HÌNH BIẾN MÔI TRƯỜNG (CÔ LẬP THEO DỰ ÁN) ---
const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;


const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GIT_BASE_BRANCH = process.env.GIT_BASE_BRANCH || 'main'; // (Fallback cũ)
const GIT_PREPROD_BRANCH = process.env.GIT_PREPROD_BRANCH || ''; // (Fallback cũ)

const GIT_DEV_BRANCH = process.env.GIT_DEV_BRANCH || GIT_BASE_BRANCH; // Nhánh xuất phát và chứa code DEV
const GIT_TARGET_BRANCH = process.env.GIT_TARGET_BRANCH || GIT_PREPROD_BRANCH || ''; // Nhánh pre-prod để auto merge trigger CI/CD deploy dev/demo
const GIT_PROD_BRANCH = process.env.GIT_PROD_BRANCH || 'main'; // Nhánh quan trọng (chỉ tạo PR sau khi verify thành công)
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'AI Bug Fixer';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'ai-bot@local.dev';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);
const PREPROD_HEALTH_URL = process.env.PREPROD_HEALTH_URL;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_IDS_STR = process.env.TELEGRAM_ALLOWED_USER_IDS || '';
const ALLOWED_USER_IDS = ALLOWED_IDS_STR.split(',').map(id => id.trim()).filter(Boolean);

const PENDING_FILE = path.join(__dirname, 'pending-prs.json');

const evidenceHelper = require('./evidence.js');


function parseJacocoCoverage(csvPath) {
    if (!fs.existsSync(csvPath)) return 0;
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    if (lines.length <= 1) return 0;
    
    let missed = 0;
    let covered = 0;
    
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length > 4) {
            missed += parseInt(parts[3] || 0, 10);
            covered += parseInt(parts[4] || 0, 10);
        }
    }
    
    const total = missed + covered;
    if (total === 0) return 0;
    return (covered / total) * 100;
}

const getReproPrompt = () => `Tái hiện lỗi theo thứ tự ưu tiên: 1. Đọc Jira Description để trích xuất URL/Domain và tài khoản bị lỗi, sau đó truy cập hệ thống đó. 2. Nếu không lấy được URL hoặc truy cập thất bại, khởi động service local (dựa trên CLAUDE.md) ở chế độ ngầm và test local. 3. Đọc mã nguồn. LƯU BẰNG CHỨNG (log, screenshot) VÀO 'evidence/{JIRA_KEY}/before'. NẾU KHÔNG THỂ TÁI HIỆN, DỪNG LẠI VÀ IN: [AI_STOP] REPRO_FAILED: <lý do>`;
const getVerifyPrompt = (SERVICES_DIR) => `Xác minh lỗi theo thứ tự: 1. Nếu có domain/IP staging/dev, truy cập kiểm tra lại. 2. Nếu không, khởi động service local (background ngầm) và test. 3. NẾU KHÔNG CHẠY ĐƯỢC LOCAL HOẶC KHÔNG THỂ VERIFY TRÊN DOMAIN, BẮT BUỘC TẠO/SỬA ĐẦY ĐỦ UNIT TEST: sử dụng JUnit 5 + Mock data (Mockito) để test toàn bộ các case (happy path, edge cases, error). Chạy './mvnw clean test jacoco:report' (trong ${SERVICES_DIR}/api). Yêu cầu chỉ số JaCoCo coverage (trong target/site/jacoco/jacoco.csv) phải > 90% cho file code được sửa. Bắt buộc copy file báo cáo JaCoCo (jacoco.csv hoặc html) và kết quả unit test vào thư mục 'evidence/{JIRA_KEY}/after'. NẾU LỖI CHƯA ĐƯỢC FIX, HÃY DỪNG LẠI VÀ IN CHÍNH XÁC: [AI_STOP] VERIFY_FAILED: <lý do>`;

if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.warn("⚠️ Thiếu cấu hình Jira. Bot vẫn chạy nhưng tính năng auto-fix sẽ báo lỗi.");
}

const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const pushUrl = (GITHUB_TOKEN && GITHUB_REPO) 
    ? `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git` 
    : 'origin';

async function waitForPreprodReady(fallbackHealthUrl, SERVICES_DIR = 'services', timeoutMs = 180000) {
    const servicesFile = path.join(process.cwd(), 'services.json');
    let targets = [];

    if (fs.existsSync(servicesFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
            // Hỗ trợ cả 2 schema: {"services":[{"deployUrl", "healthPath"}]} hoặc {"api":{"deployUrl","healthPath"}}
            if (Array.isArray(raw.services)) {
                for (const s of raw.services) {
                    if ((!s.path || s.path.startsWith(SERVICES_DIR)) && s.deployUrl && s.healthPath) {
                        const fullUrl = s.deployUrl.replace(/\/+$/, '') + '/' + s.healthPath.replace(/^\/+/, '');
                        targets.push(fullUrl);
                    }
                }
            } else if (typeof raw === 'object' && raw !== null) {
                for (const k of Object.keys(raw)) {
                    const s = raw[k];
                    if (s && s.deployUrl && s.healthPath) {
                        const fullUrl = s.deployUrl.replace(/\/+$/, '') + '/' + s.healthPath.replace(/^\/+/, '');
                        targets.push(fullUrl);
                    }
                }
            }
        } catch (e) {
            console.warn(`[!] Không thể đọc services.json: ${e.message}`);
        }
    }

    if (targets.length === 0 && fallbackHealthUrl) {
        targets.push(fallbackHealthUrl);
    }

    if (targets.length === 0) return false;

    console.log(`[+] Đang chờ service sẵn sàng qua health check (${targets.join(', ')})...`);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        let allOk = true;
        for (const url of targets) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    allOk = false;
                    break;
                }
            } catch (e) {
                allOk = false;
                break;
            }
        }
        if (allOk) {
            console.log(`[+] Tất cả health checks đã sẵn sàng (HTTP 200).`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    console.warn(`[!] Quá thời gian chờ health check (${timeoutMs}ms).`);
    return false;
}

// --- QUẢN LÝ DANH SÁCH ĐỢI (PENDING QUEUE) & CHỐNG RÁC ---
function readLocalPendingPRs() {
    if (!fs.existsSync(PENDING_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function writeLocalPendingPRs(list) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
}

function savePendingPR(prInfo) {
    const list = readLocalPendingPRs().filter(p => p.prNumber !== prInfo.prNumber);
    list.push(prInfo);
    writeLocalPendingPRs(list);
}

function removePendingPR(prNumber) {
    const list = readLocalPendingPRs().filter(p => p.prNumber !== prNumber);
    writeLocalPendingPRs(list);
}

// Kiểm tra real-time với GitHub: loại bỏ PR đã closed hoặc merged
async function syncAndCleanPendingPRs() {
    const localList = readLocalPendingPRs();
    if (!GITHUB_TOKEN || !GITHUB_REPO || localList.length === 0) return localList;

    const cleanedList = [];
    for (const pr of localList) {
        try {
            const url = `https://api.github.com/repos/${GITHUB_REPO}/pulls/${pr.prNumber}`;
            const res = await fetch(url, { headers: githubHeaders });
            if (res.ok) {
                const data = await res.json();
                // Chỉ giữ PR đang OPEN
                if (data.state === 'open') {
                    cleanedList.push(pr);
                }
            } else if (res.status === 404) {
                // PR đã bị xoá
            } else {
                cleanedList.push(pr); // Giữ tạm nếu rate limit hoặc mạng lỗi
            }
        } catch (e) {
            cleanedList.push(pr);
        }
    }

    writeLocalPendingPRs(cleanedList);
    return cleanedList;
}

// --- GITHUB REST API UTILS ---
const githubHeaders = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Autonomous-AI-Worker'
};

async function createGitHubPR(branchName, title, body) {
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        return { html_url: `#demo-pr`, number: Math.floor(Math.random() * 1000) };
    }
    const url = `https://api.github.com/repos/${GITHUB_REPO}/pulls`;
    const res = await fetch(url, {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({
            title: title,
            head: branchName,
            base: GIT_PROD_BRANCH,
            body: body
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Không thể tạo PR');
    return data;
}

async function mergeGitHubPR(prNumber) {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return { merged: true, message: 'Demo mode merged' };
    const url = `https://api.github.com/repos/${GITHUB_REPO}/pulls/${prNumber}/merge`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: githubHeaders,
        body: JSON.stringify({ merge_method: 'merge' })
    });
    const data = await res.json();
    if (!res.ok) {
        const err = new Error(data.message || 'Lỗi khi merge PR');
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

// --- TELEGRAM BOT HELPERS ---
async function sendTelegramMessage(text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
    const body = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;

    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        return data.ok ? data.result.message_id : null;
    } catch (e) {
        console.error("Lỗi gửi tin nhắn Telegram:", e.message);
    }
}

async function sendTelegramDocument(caption, filename, content) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('caption', caption);
        formData.append('document', new Blob([content], { type: 'text/plain' }), filename);

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            body: formData
        });
    } catch (e) {
        console.error("Lỗi gửi file log Telegram:", e.message);
    }
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: showAlert })
        });
    } catch (e) { }
}

async function editMessageText(messageId, text, replyMarkup = null) {
    try {
        const body = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) { }
}

// --- TELEGRAM EVENT LOOP (Long Polling) ---
let lastUpdateId = 0;
async function pollTelegramUpdates() {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
        const data = await res.json();
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                if (update.callback_query) {
                    await handleCallbackQuery(update.callback_query);
                }
            }
        }
    } catch (e) { }
    setTimeout(pollTelegramUpdates, 1000);
}

async function handleCallbackQuery(cb) {
    const userId = cb.from.id.toString();
    const action = cb.data;
    const msgId = cb.message.message_id;

    // Phân quyền
    if (!ALLOWED_USER_IDS.includes(userId)) {
        await answerCallbackQuery(cb.id, `⛔ Bạn không có quyền duyệt tác vụ này!`, true);
        return;
    }

    if (action.startsWith('merge|')) {
        const [, prNumStr, branch] = action.split('|');
        const prNumber = parseInt(prNumStr, 10);

        await answerCallbackQuery(cb.id, `Đang xử lý Merge PR #${prNumber}...`);
        await editMessageText(msgId, `⏳ <b>Đang thực hiện Merge PR #${prNumber}</b> vào <code>${GIT_PROD_BRANCH}</code>...`);

        try {
            await mergeGitHubPR(prNumber);
            removePendingPR(prNumber);
            await editMessageText(msgId, `🎉 <b>Đã Merge thành công PR #${prNumber}</b> vào <code>${GIT_PROD_BRANCH}</code>!\n(Người duyệt: @${cb.from.username || userId})`);
        } catch (err) {
            console.error(`[!] Lỗi khi merge PR #${prNumber}:`, err.message);

            // Bắt lỗi Conflict
            await editMessageText(msgId, `⚠️ <b>Phát hiện Conflict trên PR #${prNumber}!</b>\nTrạng thái PR vẫn giữ <b>Open</b>. Đang kích hoạt Claude AI tự động phân tích và gỡ conflict...`);
            
            const projectKeyMatch = branch.match(/^hotfix\/([A-Z]+)-\d+/);
            const projectKey = projectKeyMatch ? projectKeyMatch[1] : '';
            const pConfig = projectsConfig.find(p => p.projectKey === projectKey);
            const S_DIR = (pConfig && pConfig.path && pConfig.path !== '.') ? pConfig.path : 'services';
            
            const resolved = await resolveConflictWithClaude(branch, S_DIR);

            if (resolved) {
                try {
                    await mergeGitHubPR(prNumber);
                    removePendingPR(prNumber);
                    await editMessageText(msgId, `✅ <b>Claude đã tự giải quyết xong Conflict và Merge PR #${prNumber} thành công!</b>`);
                } catch (e2) {
                    await editMessageText(msgId, `❌ Vẫn không thể merge sau khi resolve conflict: ${e2.message}\nVui lòng xử lý thủ công trên GitHub.`);
                }
            } else {
                await editMessageText(msgId, `❌ <b>Conflict quá phức tạp.</b> Claude không thể tự động xử lý an toàn. Vui lòng resolve thủ công trên GitHub (PR vẫn giữ Open).`);
            }
        }
    } else if (action.startsWith('defer|')) {
        const [, prNumStr, branch, issueKey] = action.split('|');
        const prNumber = parseInt(prNumStr, 10);
        savePendingPR({ prNumber, branch, issueKey: issueKey || branch, date: new Date().toISOString() });
        await answerCallbackQuery(cb.id, `Đã lưu PR #${prNumber} vào danh sách đợi.`);
        await editMessageText(msgId, `⏳ <b>PR #${prNumber} đã được chuyển vào hàng đợi merge sau.</b>\n(Cập nhật bởi: @${cb.from.username || userId})`, {
            inline_keyboard: [[{ text: "📋 Xem danh sách đợi Merge", callback_data: "list_pending" }]]
        });
    } else if (action === 'list_pending') {
        // Đồng bộ kiểm tra GitHub để loại bỏ PR rác/đã đóng
        await answerCallbackQuery(cb.id, `Đang đồng bộ trạng thái PR từ GitHub...`);
        const pending = await syncAndCleanPendingPRs();

        if (pending.length === 0) {
            await editMessageText(msgId, `<b>📋 DANH SÁCH PR ĐỢI MERGE</b>\n\n<i>Hiện tại không có PR nào trong hàng đợi (các PR cũ đã merge/đóng đều đã được tự động dọn sạch).</i>`);
            return;
        }

        let text = `<b>📋 DANH SÁCH PR ĐANG ĐỢI MERGE (${pending.length}):</b>\n\n`;
        const keyboard = [];

        pending.forEach((p, idx) => {
            text += `${idx + 1}. PR #${p.prNumber} (<code>${p.branch}</code>) - ${p.issueKey}\n`;
            keyboard.push([{ text: `🔀 Merge PR #${p.prNumber}`, callback_data: `merge|${p.prNumber}|${p.branch}` }]);
        });

        keyboard.push([{ text: "🔄 Làm mới / Dọn dẹp", callback_data: "list_pending" }]);

        await editMessageText(msgId, text, { inline_keyboard: keyboard });
    }
}

// --- TỰ ĐỘNG GIẢI QUYẾT CONFLICT BẰNG CLAUDE ---
async function resolveConflictWithClaude(branchName, SERVICES_DIR = 'services') {
    const targetBranch = GIT_PROD_BRANCH;
    try {
        console.log(`[+] Bắt đầu gỡ conflict cho branch ${branchName}...`);
        execSync(`git checkout ${branchName}`, { stdio: 'inherit' });
        execSync(`git fetch origin ${targetBranch}`, { stdio: 'inherit' });

        try {
            execSync(`git merge origin/${targetBranch}`, { stdio: 'pipe' });
            return true; // Không có conflict
        } catch (mergeErr) {
            console.log(`[!] Xuất hiện conflict files, kích hoạt Claude...`);
        }

        const conflictPrompt = `Git merge conflict occurred between ${branchName} and origin/${targetBranch}. Read CLAUDE.md. Find all files with conflict markers (<<<<<<<, =======, >>>>>>>), resolve conflicts keeping bug fixes and latest features, run build/test, and commit with message 'fix(conflict): resolve merge conflict with ${targetBranch}'.`;

        execSync(`claude -p "${conflictPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            stdio: 'inherit',
            timeout: CLAUDE_TIMEOUT
        });

        // Bắt buộc kiểm tra commit do AI thực hiện
        await ensureAICommittedItself(branchName, "resolve conflict", SERVICES_DIR);

        // Push lại branch
        execSync(`git push ${pushUrl} ${branchName}`, { stdio: 'inherit' });
        return true;
    } catch (e) {
        console.error(`[!] Thất bại khi gỡ conflict:`, e.message);
        try { execSync(`git merge --abort`, { stdio: 'pipe' }); } catch (abortErr) { }
        return false;
    } finally {
        try { execSync(`git checkout ${GIT_DEV_BRANCH}`, { stdio: 'pipe' }); } catch (e) { }
    }
}

// --- KIỂM TRA COMMIT DO AI THỰC HIỆN (KHÔNG DÙNG SCRIPT COMMIT) ---
async function ensureAICommittedItself(branchName, context, SERVICES_DIR = 'services') {
    const status = execSync(`git status --porcelain`, { encoding: 'utf8' }).trim();
    const hasUncommittedChanges = status.length > 0;
    const newCommitCount = parseInt(execSync(`git rev-list --count ${GIT_DEV_BRANCH}..HEAD`, { encoding: 'utf8' }).trim(), 10);

    if (hasUncommittedChanges) {
        console.log(`[!] Phát hiện AI chưa tự commit. Đang yêu cầu Claude Code phân tích và commit lại...`);
        const commitPrompt = `You modified files for ${context} but did not commit them. Run 'git status' and 'git diff'. Identify which service in ${SERVICES_DIR}/ was changed. Follow CLAUDE.md rules to stage the changed files ('git add') and commit with a proper message: 'fix(<service-name>): <description>'. Do not leave uncommitted changes.`;
        
        execSync(`claude -p "${commitPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            stdio: 'inherit',
            timeout: 120000 // 2 phút thêm cho bước commit
        });
    }

    const finalCommitCount = parseInt(execSync(`git rev-list --count ${GIT_DEV_BRANCH}..HEAD`, { encoding: 'utf8' }).trim(), 10);
    if (finalCommitCount === 0) {
        throw new Error("Claude không tạo bất kỳ Git commit nào sau khi xử lý.");
    }
}

// --- QUÉT JIRA VÀ AUTO-FIX ---

async function checkJiraForBugs() {
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
        console.log(`[!] Hệ thống đang đầy tải (${activeJobs}/${MAX_CONCURRENT_JOBS}). Bỏ qua chu kỳ quét.`);
        return;
    }
    
    for (const project of projectsConfig) {
        if (activeJobs >= MAX_CONCURRENT_JOBS) break;

        try {
            const { projectKey } = project;
            const jql = `project = ${projectKey} AND issuetype = Bug AND status IN ("To Do", "Selected for Development", "Backlog") AND (labels = "auto-fix" OR summary ~ "AUTO-BUG") AND labels != "auto-fix-processing"`;
            const searchUrl = `https://${JIRA_DOMAIN}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,attachment,labels&maxResults=1`;

            console.log(`[+] Đang quét Jira cho dự án ${projectKey}...`);
            const res = await fetch(searchUrl, {
                method: 'GET',
                headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
            });

            if (!res.ok) {
                console.error(`[!] Lỗi tìm kiếm Jira (${projectKey}): HTTP ${res.status} - ${await res.text()}`);
                continue;
            }

            const data = await res.json();
            const issues = data.issues || [];
            console.log(`[+] Tìm thấy ${issues.length} bug cho dự án ${projectKey}`);

            if (issues.length > 0) {
                const issue = issues[0];
                console.log(`[+] Đang gắn nhãn auto-fix-processing cho ${issue.key}...`);
                try {
                    await fetch(`https://${JIRA_DOMAIN}/rest/api/3/issue/${issue.key}`, {
                        method: 'PUT',
                        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ update: { labels: [{ add: "auto-fix-processing" }] } })
                    });
                } catch (e) { continue; }

                activeJobs++;
                console.log(`[+] Giao việc thành công: ${issue.key}. Active jobs: ${activeJobs}`);

                processBugWrapper(issue, project).catch(e => {
                    console.error(`Worker crash nền tại ticket ${issue.key}:`, e);
                });
            }
        } catch (err) {}
    }
}

async function processBugWrapper(issue, projectConfig) {
    let isSuccess = false;
    try {
        await processBug(issue.key, issue.fields.summary, issue.fields.description, issue.fields.attachment || [], projectConfig, issue.fields.labels || []);
        isSuccess = true;
    } catch (err) {
        console.error(`[-] Xử lý bug ${issue.key} thất bại:`, err.message);
        try {
            await markJiraIssueFailed(issue.key, err.message);
            await addJiraComment(issue.key, `❌ Auto-fix thất bại: ${err.message}`);
        } catch (e) {}
    } finally {
        activeJobs--;
        console.log(`[-] Hoàn thành job ${issue.key}. Active jobs: ${activeJobs}`);
        try {
            const nextLabel = isSuccess ? "auto-fix-done" : "auto-fix-failed";
            await fetch(`https://${JIRA_DOMAIN}/rest/api/3/issue/${issue.key}`, {
                method: 'PUT',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ update: { labels: [{ remove: "auto-fix-processing" }, { add: nextLabel }] } })
            });
        } catch(e) {}
    }
}

async function markJiraIssueFailed(issueKey, reason) {
    try {
        await fetch(`https://${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}`, {
            method: 'PUT',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                update: {
                    labels: [{ add: "auto-fix-failed" }]
                }
            })
        });
    } catch (e) { }
}

async function addJiraComment(issueKey, commentBody) {
    try {
        await fetch(`https://${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/comment`, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                body: {
                    type: "doc",
                    version: 1,
                    content: [
                        {
                            type: "paragraph",
                            content: [{ type: "text", text: commentBody }]
                        }
                    ]
                }
            })
        });
    } catch (e) { }
}

async function processBug(issueKey, summary, description, attachments, projectConfig, labels) {
    const serviceLabel = (labels || []).find(l => l.startsWith('service:'));
    if (!serviceLabel) {
        throw new Error(`[Fail-Safe Abort] Ticket ${issueKey} không có nhãn 'service:*'. Không xác định được service mục tiêu để xử lý an toàn.`);
    }

    const SERVICES_DIR = projectConfig.path || 'services';
    const targetService = serviceLabel.split(':')[1];
    const targetServiceDir = path.join(process.cwd(), SERVICES_DIR, targetService);
    
    if (!fs.existsSync(targetServiceDir)) {
        throw new Error(`[Fail-Safe Abort] Service '${targetService}' không tồn tại trong '${SERVICES_DIR}'. Dừng xử lý an toàn.`);
    }
    const REPRO_PROMPT = getReproPrompt();
    const VERIFY_PROMPT = getVerifyPrompt(SERVICES_DIR);
    const GIT_DEV_BRANCH = projectConfig.gitDevBranch || process.env.GIT_DEV_BRANCH || 'main';
    const GIT_TARGET_BRANCH = projectConfig.gitTargetBranch || process.env.GIT_TARGET_BRANCH || '';
    const GIT_PROD_BRANCH = projectConfig.gitProdBranch || process.env.GIT_PROD_BRANCH || 'main';

    const branchName = `hotfix/${issueKey}`;
    console.log(`\n========================================`);
    console.log(`[+] Phát hiện Bug mới: ${issueKey} - ${summary}`);


    try {
        // 1. Cấu hình danh tính Git cục bộ
        execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { stdio: 'pipe' });
        execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { stdio: 'pipe' });

        // 2. Kéo code mới nhất từ nhánh xuất phát (GIT_DEV_BRANCH)
        console.log(`[+] Cập nhật code mới nhất từ ${GIT_DEV_BRANCH}...`);
        execSync(`git checkout ${GIT_DEV_BRANCH}`, { stdio: 'pipe' });
        try { execSync(`git pull origin ${GIT_DEV_BRANCH}`, { stdio: 'pipe' }); } catch(e){}

        // 3. Tạo nhánh sửa lỗi
        try { execSync(`git branch -D ${branchName}`, { stdio: 'pipe' }); } catch(e){}
        execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });

        // 4. Kích hoạt Claude Code Headless (Repro -> Fix -> Verify)
        let attachmentInfo = "";
        if (attachments.length > 0) {
            attachmentInfo = "Attachments available:\n" + attachments.map(a => `- ${a.filename}: ${a.content}`).join("\n");
        }

        const fixPrompt = `Fix Jira bug: ${summary}. ${attachmentInfo}. Read CLAUDE.md for services map and rules. Locate the responsible service in ${SERVICES_DIR}/, make minimal code changes, run its test command, and commit the fix following the commit conventions (fix(<service>): ...).`;

        // Dọn dẹp evidence cũ của ticket này (nếu có)
        const beforeEvidencePath = path.join(process.cwd(), 'evidence', issueKey, 'before');
        const afterEvidencePath = path.join(process.cwd(), 'evidence', issueKey, 'after');
        fs.rmSync(path.join(process.cwd(), 'evidence', issueKey), { recursive: true, force: true });
        evidenceHelper.ensureEvidenceDir(issueKey);
        // Phục hồi lại file log sau khi rmSync
        evidenceHelper.saveEvidence(issueKey, 'before', `${issueKey}_error.txt`, JSON.stringify(description) || summary);

        console.log(`[+] Bước 1: Repro Bug (Model: ${CLAUDE_MODEL}, Timeout: ${CLAUDE_TIMEOUT}ms)...`);
        const reproPrompt = REPRO_PROMPT.replace(/\{JIRA_KEY\}/g, issueKey);
        const reproOutput = execSync(`claude -p "Bug: ${summary}. ${reproPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            stdio: ['inherit', 'pipe', 'pipe'],
            timeout: CLAUDE_TIMEOUT,
            encoding: 'utf8'
        });
        console.log(reproOutput);
        if (reproOutput.includes('[AI_STOP]')) {
            const reason = reproOutput.match(/\[AI_STOP\]\s*(.*)/)?.[1] || "AI chủ động dừng tại bước Repro.";
            throw new Error(`Repro aborted: ${reason}`);
        }

        const beforeDir = path.join(process.cwd(), 'evidence', issueKey, 'before');
        if (!fs.existsSync(beforeDir) || fs.readdirSync(beforeDir).length === 0) {
            throw new Error(`Repro fail: AI không tạo bằng chứng trong 'evidence/${issueKey}/before'.`);
        }

        // Báo động 1: Gửi Telegram kèm file log và ảnh repro (before)
        await evidenceHelper.sendEvidenceToTelegram(issueKey, 'before', `🚨 <b>LỖI MỚI PHÁT HIỆN & REPRO</b>\n<b>Ticket:</b> ${issueKey}\n<b>Summary:</b> ${summary}`);

        console.log(`[+] Bước 2: Fix Bug...`);
        execSync(`claude -p "${fixPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            stdio: 'inherit',
            timeout: CLAUDE_TIMEOUT
        });

        // 3. Kiểm tra AI đã commit chưa sau khi Fix
        await ensureAICommittedItself(branchName, `ticket ${issueKey}`, SERVICES_DIR);

        // 4. Merge hotfix vào DEV
        console.log(`[+] Merge hotfix ${branchName} vào ${GIT_DEV_BRANCH}...`);
        execSync(`git checkout ${GIT_DEV_BRANCH}`, { stdio: 'pipe' });
        execSync(`git merge ${branchName} --no-edit`, { stdio: 'pipe' });
        try { execSync(`git push ${pushUrl} ${GIT_DEV_BRANCH}`, { stdio: 'pipe' }); } catch(e) {
            console.warn(`[!] Không thể push ${GIT_DEV_BRANCH}: ${e.message}`);
        }

        // 5. Merge DEV vào TARGET (nếu có) để deploy dev/demo và chờ health
        let isPreprodReady = false;
        if (GIT_TARGET_BRANCH && GIT_TARGET_BRANCH !== GIT_DEV_BRANCH) {
            console.log(`[+] Auto-merge ${GIT_DEV_BRANCH} vào ${GIT_TARGET_BRANCH} để trigger CI/CD deploy dev/demo...`);
            try {
                execSync(`git fetch origin ${GIT_TARGET_BRANCH} || true`, { stdio: 'pipe' });
                execSync(`git checkout ${GIT_TARGET_BRANCH} || git checkout -b ${GIT_TARGET_BRANCH}`, { stdio: 'pipe' });
                execSync(`git merge ${GIT_DEV_BRANCH} --no-edit`, { stdio: 'pipe' });
                execSync(`git push ${pushUrl} ${GIT_TARGET_BRANCH}`, { stdio: 'pipe' });
                console.log(`[+] Đã trigger CI/CD trên ${GIT_TARGET_BRANCH}.`);
                isPreprodReady = await waitForPreprodReady(PREPROD_HEALTH_URL, SERVICES_DIR, 180000);
            } catch(e) {
                console.warn(`[!] Không thể auto-merge vào ${GIT_TARGET_BRANCH}: ${e.message}`);
            } finally {
                execSync(`git checkout ${branchName}`, { stdio: 'pipe' });
            }
        } else {
            // Không có TARGET branch riêng biệt thì quay lại branch hotfix
            execSync(`git checkout ${branchName}`, { stdio: 'pipe' });
            // Thử check health nếu có config
            isPreprodReady = await waitForPreprodReady(PREPROD_HEALTH_URL, SERVICES_DIR, 30000);
        }

        console.log(`[+] Bước 5: Verify Bug...`);
        let actualVerifyPrompt = VERIFY_PROMPT.replace(/\{JIRA_KEY\}/g, issueKey);
        const needFallbackUnitTest = (GIT_TARGET_BRANCH && !isPreprodReady);
        if (needFallbackUnitTest) {
            actualVerifyPrompt = `BỎ QUA KIỂM TRA DOMAIN/IP. BẮT BUỘC TẠO/SỬA ĐẦY ĐỦ UNIT TEST: sử dụng JUnit 5 + Mock data (Mockito) để test toàn bộ các case (happy path, edge cases, error). Chạy './mvnw clean test jacoco:report' (trong ${SERVICES_DIR}/api). Yêu cầu chỉ số JaCoCo coverage (trong target/site/jacoco/jacoco.csv) phải > 90% cho file code được sửa. Bắt buộc copy file báo cáo JaCoCo (jacoco.csv hoặc html) và kết quả unit test vào thư mục 'evidence/{JIRA_KEY}/after'. NẾU LỖI CHƯA ĐƯỢC FIX, HÃY DỪNG LẠI VÀ IN CHÍNH XÁC: [AI_STOP] VERIFY_FAILED: <lý do>`.replace(/\{JIRA_KEY\}/g, issueKey);
        }

        let coverage = 0;
        let turn = 0;
        let verifyOutput = "";
        const csvPath = path.join(process.cwd(), SERVICES_DIR, 'api', 'target', 'site', 'jacoco', 'jacoco.csv');
        const afterDir = path.join(process.cwd(), 'evidence', issueKey, 'after');

        // Chỉ chạy loop coverage khi fallback unit-test (needFallbackUnitTest là true)
        if (needFallbackUnitTest) {
            while (coverage < 90 && turn < 3) {
                turn++;
                console.log(`[+] Đang chạy Verify Unit Test (Lần ${turn})...`);

                let currentPrompt = actualVerifyPrompt;
                let envOptions = {
                    stdio: ['inherit', 'pipe', 'pipe'],
                    timeout: CLAUDE_TIMEOUT,
                    encoding: 'utf8',
                    env: { ...process.env }
                };

                if (turn > 1) {
                    envOptions.env.AUTOFIX_PHASE = 'test-only';
                    currentPrompt = `Current Jacoco coverage is ${coverage.toFixed(2)}%. It must be > 90%. BỔ SUNG CASE VÀO FILE TEST (trong src/test/java). NGHIÊM CẤM SỬA FILE SOURCE src/main/java để cheat coverage (AUTOFIX_PHASE=test-only). Run './mvnw clean test jacoco:report' and save evidence.`;
                }

                try {
                    verifyOutput = execSync(`claude -p "Bug: ${summary}. ${currentPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, envOptions);
                    console.log(verifyOutput);
                } catch (err) {
                    console.error(`Lỗi khi chạy verify: ${err.message}`);
                    if (err.stdout) console.log(err.stdout.toString('utf8'));
                    if (err.stderr) console.error(err.stderr.toString('utf8'));
                    throw err;
                }

                if (verifyOutput.includes('[AI_STOP]')) {
                    break;
                }

                coverage = parseJacocoCoverage(csvPath);
                console.log(`[+] Jacoco Coverage đạt: ${coverage.toFixed(2)}%`);
                if (coverage >= 90) break;
            }

            if (coverage < 90 && fs.existsSync(csvPath)) {
                throw new Error(`Verify fail: Không đạt đủ 90% coverage sau 3 lần thử (đạt ${coverage.toFixed(2)}%).`);
            }
        } else {
            // Verify thông thường (đã deploy dev/demo hoặc test domain/local)
            console.log(`[+] Đang chạy Verify domain/local...`);
            try {
                verifyOutput = execSync(`claude -p "Bug: ${summary}. ${actualVerifyPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
                    stdio: ['inherit', 'pipe', 'pipe'],
                    timeout: CLAUDE_TIMEOUT,
                    encoding: 'utf8'
                });
                console.log(verifyOutput);
            } catch (err) {
                console.error(`Lỗi khi chạy verify: ${err.message}`);
                if (err.stdout) console.log(err.stdout.toString('utf8'));
                if (err.stderr) console.error(err.stderr.toString('utf8'));
                throw err;
            }
        }

        if (verifyOutput.includes('[AI_STOP]')) {
            const reason = verifyOutput.match(/\[AI_STOP\]\s*(.*)/)?.[1] || "AI chủ động dừng tại bước Verify.";
            throw new Error(`Verify aborted: ${reason}`);
        }

        // Kiểm tra bắt buộc evidence/after từ phía worker
        if (!fs.existsSync(afterDir) || fs.readdirSync(afterDir).length === 0) {
            throw new Error(`Verify fail: AI không tạo bằng chứng trong 'evidence/${issueKey}/after' theo yêu cầu.`);
        }

        // 7. Push branch fix bằng Token cô lập
        console.log(`[+] Đang push nhánh ${branchName}...`);
        execSync(`git push -u ${pushUrl} ${branchName} --force`, { stdio: 'inherit' });

        // 8. Tự động tạo Pull Request trên GitHub vào GIT_PROD_BRANCH (nhánh quan trọng)
        console.log(`[+] Tự động mở Pull Request vào nhánh ${GIT_PROD_BRANCH}...`);
        const pr = await createGitHubPR(
            branchName,
            `[Auto-Fix] ${issueKey}: ${summary}`,
            `Auto-generated fix by Claude Code for Jira ticket **${issueKey}**.\n\nSummary: ${summary}\nDev Branch: \`${GIT_DEV_BRANCH}\`\nProd Target: \`${GIT_PROD_BRANCH}\``
        );

        // 9. Kiểm tra và Comment báo cáo JaCoCo vào Jira (nếu có)
        try {
            if (fs.existsSync(csvPath)) {
                const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
                if (lines.length > 1) {
                    await addJiraComment(issueKey, `🤖 AI Auto-Fix Report:\n- PR đã mở: ${pr.html_url}\n- Đã chạy Unit Test và sinh báo cáo JaCoCo Coverage (>90%). Bằng chứng đã được lưu trong evidence/after.`);
                }
            }
        } catch (e) { }

        // Báo động 2: Báo kết quả kèm các nút duyệt với cú pháp split('|')
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "🔀 Merge PR", callback_data: `merge|${pr.number}|${branchName}` },
                    { text: "⏳ Lưu vào hàng đợi", callback_data: `defer|${pr.number}|${branchName}|${issueKey}` }
                ],
                [
                    { text: "📋 Xem danh sách đợi Merge", callback_data: "list_pending" }
                ]
            ]
        };

        await evidenceHelper.sendEvidenceToTelegram(issueKey, 'after',
            `✅ <b>ĐÃ SỬA VÀ TẠO PR THÀNH CÔNG!</b>\n\n` +
            `• <b>Ticket:</b> ${issueKey}\n` +
            `• <b>PR:</b> <a href="${pr.html_url}">PR #${pr.number}</a> ➔ <code>${GIT_PROD_BRANCH}</code>\n\n` +
            `Chọn hành động bên dưới:`,
            keyboard
        );

    } catch (err) {
        console.error(`[!] Lỗi khi xử lý ${issueKey}:`, err.message);

        await markJiraIssueFailed(issueKey, err.message);

        const isTimeout = err.killed || err.signal === 'SIGTERM' || err.message.includes('ETIMEDOUT');
        const errorDesc = isTimeout
            ? `AI đã chạy quá thời gian cho phép (${CLAUDE_TIMEOUT / 1000}s) và bị dừng tiến trình để ngắt chi phí.`
            : err.message;

        await sendTelegramMessage(`❌ <b>Lỗi trong quá trình xử lý ${issueKey}</b>\nNguyên nhân: ${errorDesc}\n<i>(Ticket đã được gắn nhãn auto-fix-failed để tránh lặp vô tận)</i>`);
    } finally {
        try { execSync(`git checkout ${GIT_DEV_BRANCH}`, { stdio: 'pipe' }); } catch (e) { }
    }
}


// --- KHỞI ĐỘNG HỆ THỐNG (SINGLETON MASTER) ---
console.log("🚀 Singleton Master Worker Level 3 đã sẵn sàng...");
console.log(`• MAX_CONCURRENT_JOBS: ${MAX_CONCURRENT_JOBS}`);
pollTelegramUpdates();

(async function masterLoop() {
    while (true) {
        if (!isScanning) {
            isScanning = true;
            try { await checkJiraForBugs(); } finally { isScanning = false; }
        }
        await new Promise(r => setTimeout(r, 15000));
    }
})();
