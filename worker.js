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

function validateConfigs() {
    for (const project of projectsConfig) {
        const projectPath = project.path || '.';
        const servicesFile = path.join(projectPath, 'services.json');
        if (!fs.existsSync(servicesFile)) {
            console.warn(`[CANH BAO] Project ${project.projectKey} thiếu services.json tại ${servicesFile}. Tự động copy từ services.json.example...`);
            try {
                fs.copyFileSync('services.json.example', servicesFile);
                console.log(`[+] Đã tạo ${servicesFile}. Vui lòng cấu hình lại các trường.`);
            } catch (err) {
                console.error(`[LOI] Không thể copy services.json.example sang ${servicesFile}:`, err.message);
            }
        } else {
            try {
                const raw = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
                const services = Array.isArray(raw.services) ? raw.services : Object.values(raw);
                for (const s of services) {
                    if (!s.gitRepo || !s.branches) {
                        console.warn(`[CANH BAO] Service trong ${servicesFile} thiếu gitRepo hoặc branches.`);
                    }
                }
            } catch (e) {
                console.warn(`[CANH BAO] Lỗi đọc ${servicesFile}: ${e.message}`);
            }
        }
    }
}
validateConfigs();


// --- CẤU HÌNH BIẾN MÔI TRƯỜNG (CÔ LẬP THEO DỰ ÁN) ---
const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;


// --- GIT REPO / HOST HELPERS ---
function normalizeGitHost(hostStr) {
    if (!hostStr) return 'github.com';
    let host = hostStr.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (host.toLowerCase().endsWith('.git')) host = host.slice(0, -4);
    return host || 'github.com';
}
function normalizeRepoPath(repoStr) {
    if (!repoStr) return '';
    let repo = repoStr.trim().replace(/^https?:\/\//i, '');
    const host = normalizeGitHost(process.env.GIT_HOST || 'github.com');
    if (repo.toLowerCase().startsWith(host.toLowerCase() + '/')) {
        repo = repo.slice(host.length + 1);
    } else if (repo.toLowerCase().startsWith('github.com/')) {
        repo = repo.slice('github.com/'.length);
    }
    repo = repo.replace(/^\/+/, '');
    if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
    return repo;
}

const GIT_HOST = normalizeGitHost(process.env.GIT_HOST || 'github.com');
const GIT_TOKEN = process.env.GIT_TOKEN || process.env.GITHUB_TOKEN || '';
const GITHUB_TOKEN = GIT_TOKEN; // Backward compat
const GIT_API_BASE_URL = (process.env.GIT_API_BASE_URL || '').trim();

function buildRemoteUrl(gitRepo) {
    const cleanRepo = normalizeRepoPath(gitRepo);
    if (!cleanRepo) return 'origin';
    const host = normalizeGitHost(GIT_HOST);
    if (GIT_TOKEN) return `https://${GIT_TOKEN}@${host}/${cleanRepo}.git`;
    return 'origin';
}

function isGitHubHost() {
    return normalizeGitHost(GIT_HOST).toLowerCase() === 'github.com';
}

function ensureRemoteOrigin(cwd, gitRepo) {
    const remoteUrl = buildRemoteUrl(gitRepo);
    if (remoteUrl && remoteUrl !== 'origin') {
        try { execSync(`git remote set-url origin ${remoteUrl}`, { cwd, stdio: 'pipe' }); }
        catch (e) {
            try { execSync(`git remote add origin ${remoteUrl}`, { cwd, stdio: 'pipe' }); }
            catch (e2) {}
        }
    }
}

const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'AI Bug Fixer';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'ai-bot@local.dev';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);

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

function getServiceInfoForPR(prNumber, branchName) {
    const localList = readLocalPendingPRs();
    const pr = localList.find(p => p.prNumber === prNumber || (branchName && p.branch === branchName));
    if (pr && pr.gitRepo && pr.prodBranch) {
        return {
            gitRepo: pr.gitRepo,
            prodBranch: pr.prodBranch,
            devBranch: pr.devBranch || 'master',
            targetServiceDir: pr.targetServiceDir || process.cwd()
        };
    }

    const projectKeyMatch = (branchName || (pr && pr.branch) || '').match(/^hotfix\/([A-Z]+)-\d+/);
    const projectKey = projectKeyMatch ? projectKeyMatch[1] : '';
    const pConfig = projectsConfig.find(p => p.projectKey === projectKey);
    const projectPath = (pConfig && pConfig.path && pConfig.path !== '.') ? pConfig.path : 'services';
    const servicesJsonPath = path.join(process.cwd(), projectPath, 'services.json');

    if (fs.existsSync(servicesJsonPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(servicesJsonPath, 'utf8'));
            const services = Array.isArray(raw.services) ? raw.services : Object.values(raw);
            const svc = services.find(s => s.gitRepo && s.branches) || services[0];
            if (svc && svc.gitRepo && svc.branches) {
                return {
                    gitRepo: svc.gitRepo,
                    prodBranch: svc.branches.prod || 'master',
                    devBranch: svc.branches.dev || 'master',
                    targetServiceDir: path.join(process.cwd(), projectPath, svc.path || '')
                };
            }
        } catch (e) {}
    }

    if (pr && pr.gitRepo) {
        return {
            gitRepo: pr.gitRepo,
            prodBranch: pr.prodBranch || 'master',
            devBranch: pr.devBranch || 'master',
            targetServiceDir: pr.targetServiceDir || process.cwd()
        };
    }

    throw new Error(`[Fail-Safe] Không thể xác định gitRepo/branches cho PR #${prNumber} (${branchName}). Vui lòng kiểm tra pending-prs.json hoặc services.json.`);
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
    if (!localList.length) return localList;
    if (!isGitHubHost() || !GIT_TOKEN) return localList;

    const cleanedList = [];
    for (const pr of localList) {
        if (!pr.gitRepo) { cleanedList.push(pr); continue; }
        try {
            const url = `https://api.github.com/repos/${pr.gitRepo}/pulls/${pr.prNumber}`;
            const res = await fetch(url, { headers: githubHeaders });
            if (res.ok) {
                const data = await res.json();
                if (data.state === 'open') cleanedList.push(pr);
            } else if (res.status === 404) {
                // PR đã bị xoá
            } else {
                cleanedList.push(pr);
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

async function createPR(gitRepo, targetBranch, branchName, title, body) {
    if (isGitHubHost()) return await createGitHubPR(gitRepo, targetBranch, branchName, title, body);

    console.warn(`\n[CANH BAO] Đang sử dụng Git Host doanh nghiệp tự host: ${GIT_HOST}`);
    console.warn(`[!] API tạo Pull Request của ${GIT_HOST} khác với GitHub API.`);

    if (GIT_API_BASE_URL) {
        console.log(`[+] Phát hiện GIT_API_BASE_URL: ${GIT_API_BASE_URL}. Đang gửi request tạo PR/MR...`);
        try {
            const cleanRepo = normalizeRepoPath(gitRepo);
            const apiUrl = GIT_API_BASE_URL.replace('{repo}', encodeURIComponent(cleanRepo)).replace('{rawRepo}', cleanRepo);
            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GIT_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Autonomous-AI-Worker' },
                body: JSON.stringify({ title: title, source_branch: branchName, target_branch: targetBranch, description: body, head: branchName, base: targetBranch })
            });
            if (res.ok) {
                const data = await res.json();
                console.log(`[+] Đã tạo PR/MR thành công qua Generic API: ${data.web_url || data.html_url || data.url || JSON.stringify(data)}`);
                return { html_url: data.web_url || data.html_url || data.url || `https://${GIT_HOST}/${cleanRepo}`, number: data.iid || data.id || data.number || Math.floor(Math.random() * 1000) };
            } else {
                console.warn(`[!] Gọi GIT_API_BASE_URL thất bại (HTTP ${res.status}): ${await res.text()}`);
            }
        } catch (apiErr) {
            console.warn(`[!] Lỗi khi gọi GIT_API_BASE_URL: ${apiErr.message}`);
        }
    }

    const cleanRepo = normalizeRepoPath(gitRepo);
    const manualMrUrl = `https://${GIT_HOST}/${cleanRepo}`;
    console.warn(`[!] Nhánh '${branchName}' đã push thành công lên ${GIT_HOST}.`);
    console.warn(`[!] HƯỚNG DẪN: Vui lòng truy cập ${manualMrUrl} để tạo Merge Request / Pull Request thủ công từ nhánh '${branchName}' vào '${targetBranch}'.`);

    return { html_url: manualMrUrl + ' (Cần tạo MR thủ công)', number: Math.floor(Math.random() * 1000) };
}

async function createGitHubPR(gitRepo, targetBranch, branchName, title, body) {
    if (!GITHUB_TOKEN || !gitRepo) {
        console.log(`[!] Không có GITHUB_TOKEN hoặc gitRepo. Giả lập mở PR thành công: #demo-pr`);
        return {
            html_url: `https://github.com/${gitRepo || 'mock-repo'}/pull/${Math.floor(Math.random() * 1000)}`,
            number: Math.floor(Math.random() * 1000)
        };
    }

    const url = `https://api.github.com/repos/${gitRepo}/pulls`;
    const res = await fetch(url, {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({
            title: title,
            head: branchName,
            base: targetBranch || 'main',
            body: body
        })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.message || 'Không thể tạo PR');
    }
    return data;
}

async function mergePR(gitRepo, prNumber) {
    if (!isGitHubHost()) {
        console.warn(`[!] Host ${GIT_HOST} là git tự host, không hỗ trợ auto-merge qua GitHub API. Vui lòng merge thủ công trên Web UI.`);
        throw new Error(`Host ${GIT_HOST} là git tự host, không hỗ trợ tự động merge qua API. Vui lòng duyệt merge thủ công trên Web UI.`);
    }
    return await mergeGitHubPR(gitRepo, prNumber);
}

async function mergeGitHubPR(gitRepo, prNumber) {
    if (!GITHUB_TOKEN || !gitRepo) return { merged: true, message: 'Demo mode merged' };
    const url = `https://api.github.com/repos/${gitRepo}/pulls/${prNumber}/merge`;
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

        let serviceInfo;
        try {
            serviceInfo = getServiceInfoForPR(prNumber, branch);
        } catch (e) {
            console.error(`[!] Lỗi tìm serviceInfo cho PR #${prNumber}:`, e.message);
            await answerCallbackQuery(cb.id, `❌ Lỗi: ${e.message}`, true);
            return;
        }

        const { gitRepo, prodBranch, targetServiceDir } = serviceInfo;

        await answerCallbackQuery(cb.id, `Đang xử lý Merge PR #${prNumber}...`);
        await editMessageText(msgId, `⏳ <b>Đang thực hiện Merge PR #${prNumber}</b> vào <code>${prodBranch}</code>...`);

        try {
            await mergePR(gitRepo, prNumber);
            removePendingPR(prNumber);
            await editMessageText(msgId, `🎉 <b>Đã Merge thành công PR #${prNumber}</b> vào <code>${prodBranch}</code>!\n(Người duyệt: @${cb.from.username || userId})`);
        } catch (err) {
            console.error(`[!] Lỗi khi merge PR #${prNumber}:`, err.message);

            // Bắt lỗi Conflict
            await editMessageText(msgId, `⚠️ <b>Phát hiện Conflict trên PR #${prNumber}!</b>\nTrạng thái PR vẫn giữ <b>Open</b>. Đang kích hoạt Claude AI tự động phân tích và gỡ conflict...`);

            const resolved = await resolveConflictWithClaude(branch, targetServiceDir, serviceInfo);

            if (resolved) {
                try {
                    await mergePR(gitRepo, prNumber);
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
        let extraInfo = {};
        try {
            extraInfo = getServiceInfoForPR(prNumber, branch);
        } catch (e) {}
        savePendingPR({
            prNumber,
            branch,
            issueKey: issueKey || branch,
            gitRepo: extraInfo.gitRepo,
            prodBranch: extraInfo.prodBranch,
            devBranch: extraInfo.devBranch,
            targetServiceDir: extraInfo.targetServiceDir,
            date: new Date().toISOString()
        });
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
async function resolveConflictWithClaude(branchName, targetServiceDirOrServicesDir = 'services', serviceInfoParam = null) {
    let svc = serviceInfoParam;
    if (!svc || !svc.gitRepo || !svc.prodBranch) {
        try {
            svc = getServiceInfoForPR(NaN, branchName);
        } catch (e) {
            throw new Error(`[Fail-Safe] Không xác định được gitRepo/branches cho branch ${branchName}: ${e.message}`);
        }
    }
    if (!svc || !svc.gitRepo || !svc.prodBranch) {
        throw new Error(`[Fail-Safe] Thiếu gitRepo/prodBranch cho branch ${branchName}, không thể resolve conflict an toàn.`);
    }
    const targetBranch = svc.prodBranch;
    const devBranch = svc.devBranch || 'master';
    const gitRepo = svc.gitRepo;
    let cwd = svc.targetServiceDir || targetServiceDirOrServicesDir;
    try {
        if (targetServiceDirOrServicesDir && targetServiceDirOrServicesDir !== 'services') {
            cwd = targetServiceDirOrServicesDir;
        }
    } catch (e) {}
    const pushUrlLocal = buildRemoteUrl(gitRepo);
    ensureRemoteOrigin(cwd, gitRepo);
    try {
        console.log(`[+] Bắt đầu gỡ conflict cho branch ${branchName}...`);
        execSync(`git checkout ${branchName}`, { cwd, stdio: 'inherit' });
        execSync(`git fetch origin ${targetBranch}`, { cwd, stdio: 'inherit' });

        try {
            execSync(`git merge origin/${targetBranch}`, { cwd, stdio: 'pipe' });
            return true; // Không có conflict
        } catch (mergeErr) {
            console.log(`[!] Xuất hiện conflict files, kích hoạt Claude...`);
        }

        const conflictPrompt = `Git merge conflict occurred between ${branchName} and origin/${targetBranch}. Read CLAUDE.md. Find all files with conflict markers (<<<<<<<, =======, >>>>>>>), resolve conflicts keeping bug fixes and latest features, run build/test, and commit with message 'fix(conflict): resolve merge conflict with ${targetBranch}'.`;

        execSync(`claude -p "${conflictPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            cwd,
            stdio: 'inherit',
            timeout: CLAUDE_TIMEOUT
        });

        // Bắt buộc kiểm tra commit do AI thực hiện
        await ensureAICommittedItself(branchName, "resolve conflict", cwd, devBranch);

        // Push lại branch
        execSync(`git push ${pushUrlLocal} ${branchName}`, { cwd, stdio: 'inherit' });
        return true;
    } catch (e) {
        console.error(`[!] Thất bại khi gỡ conflict:`, e.message);
        try { execSync(`git merge --abort`, { cwd, stdio: 'pipe' }); } catch (abortErr) { }
        return false;
    } finally {
        try { execSync(`git checkout ${devBranch}`, { cwd, stdio: 'pipe' }); } catch (e) { }
    }
}

// --- KIỂM TRA COMMIT DO AI THỰC HIỆN (KHÔNG DÙNG SCRIPT COMMIT) ---
async function ensureAICommittedItself(branchName, context, worktreeDir, baseBranch = null) {
    const cwd = worktreeDir || process.cwd();
    // Đảm bảo không add evidence/ vào commit rác
    const diffStatus = execSync(`git status --porcelain`, { cwd }).toString().trim();
    if (diffStatus !== "") {
        console.warn(`[!] CẢNH BÁO: Claude AI đã để lại file chưa commit sau khi ${context} tại ${cwd}!`);
        
        // Chỉ add các file không phải evidence/build artifact (parse porcelain robust)
        const lines = diffStatus.split('\n');
        let hasNonEvidence = false;
        const isIgnored = (f) => {
            const p = f.replace(/^"|"$/g, '');
            return p.startsWith('evidence/') || p.startsWith('target/') || p.includes('/target/') || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.endsWith('.class');
        };
        for (const line of lines) {
            const m = line.match(/^.{2}\s+(.+)$/);
            if (!m) continue;
            let file = m[1].trim().replace(/^"|"$/g, '');
            if (file.includes(' -> ')) file = file.split(' -> ').pop().trim().replace(/^"|"$/g, '');
            if (!file || isIgnored(file)) continue;
            execSync(`git add -- "${file}"`, { cwd });
            hasNonEvidence = true;
        };
        
        if (hasNonEvidence) {
            execSync(`git commit -m "fix(auto): catch uncommitted changes after ${context}"`, { cwd });
            console.log(`[+] Đã tự động commit các thay đổi rác (loại trừ evidence).`);
        }
    }

    if (baseBranch) {
        const revTarget = branchName ? `origin/${baseBranch}..${branchName}` : `origin/${baseBranch}..HEAD`;
        const finalCommitCount = parseInt(execSync(`git rev-list --count ${revTarget}`, { cwd, encoding: 'utf8' }).trim(), 10);
        if (finalCommitCount === 0) {
            throw new Error("Claude không tạo bất kỳ Git commit nào sau khi xử lý.");
        }
        
        // Kiểm tra bắt buộc phải có thay đổi trong source code (bỏ qua file evidence, md, json cấu hình không quan trọng nếu chỉ có 1 mình nó)
        const changedFiles = execSync(`git diff --name-only ${revTarget}`, { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        const hasSrcChanges = changedFiles.some(f => 
            f.includes('/src/') || f.endsWith('.java') || f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.jsx') || f.endsWith('.tsx') || f.endsWith('pom.xml') || f.endsWith('package.json')
        );
        
        if (!hasSrcChanges) {
            console.warn(`[!] Các file đã sửa:`, changedFiles);
            throw new Error("PR rỗng hoặc chỉ chứa file rác/evidence. Không có thay đổi nào trong mã nguồn (src). AI đã bỏ cuộc hoặc lách luật.");
        }
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
            const jql = `project = ${projectKey} AND issuetype = Bug AND status IN ("To Do", "Selected for Development", "Backlog") AND (labels = "auto-fix" OR summary ~ "AUTO-BUG") AND labels != "auto-fix-processing" AND labels != "auto-fix-done" AND labels != "auto-fix-failed"`;
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

    const projectPath = projectConfig.path || '.';
    const targetService = serviceLabel.split(':')[1];

    // Đọc services.json tại project
    const servicesJsonPath = path.join(projectPath, 'services.json');
    if (!fs.existsSync(servicesJsonPath)) {
        throw new Error(`[Fail-Safe Abort] Project ${projectConfig.projectKey} thiếu file ${servicesJsonPath}.`);
    }

    let servicesData;
    try {
        servicesData = JSON.parse(fs.readFileSync(servicesJsonPath, 'utf8'));
    } catch (e) {
        throw new Error(`[Fail-Safe Abort] Không thể đọc JSON từ ${servicesJsonPath}: ${e.message}`);
    }

    const servicesList = Array.isArray(servicesData.services) ? servicesData.services : Object.values(servicesData);
    const serviceConfig = servicesList.find(s => s.name === targetService || s.path === targetService || (s.path && s.path.endsWith(targetService)));

    if (!serviceConfig) {
        throw new Error(`[Fail-Safe Abort] Không tìm thấy service '${targetService}' trong ${servicesJsonPath}.`);
    }

    if (!serviceConfig.gitRepo || !serviceConfig.branches || !serviceConfig.branches.dev || !serviceConfig.branches.prod) {
        throw new Error(`[Fail-Safe Abort] Service '${targetService}' thiếu gitRepo hoặc cấu hình branches (dev, prod) trong ${servicesJsonPath}.`);
    }

    const targetServiceDir = path.join(process.cwd(), projectPath, serviceConfig.path || targetService);
    if (!fs.existsSync(targetServiceDir)) {
        throw new Error(`[Fail-Safe Abort] Thư mục service '${targetServiceDir}' không tồn tại.`);
    }

    const devBranch = serviceConfig.branches.dev;
    const prodBranch = serviceConfig.branches.prod;
    const targetBranch = serviceConfig.branches.target || '';
    const gitRepo = serviceConfig.gitRepo;
    const pushUrl = buildRemoteUrl(gitRepo);

    const branchName = `hotfix/${issueKey}`;
    const worktreeDir = path.join(targetServiceDir, '.worktrees', branchName);

    console.log(`\n========================================`);
    console.log(`[+] Phát hiện Bug mới: ${issueKey} - ${summary}`);
    console.log(`[+] Target Repo: ${gitRepo} | Service: ${targetService} | Dev Branch: ${devBranch}`);

    try {
        // 1. Dọn dẹp worktree cũ nếu bị kẹt
        try {
            execSync(`git worktree remove --force .worktrees/${branchName}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch(e) {}

        // 2. Cấu hình danh tính Git trong repo service
        execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: targetServiceDir, stdio: 'pipe' });
        execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: targetServiceDir, stdio: 'pipe' });

        // 3. Kéo code mới nhất từ remote
        console.log(`[+] Kéo code mới nhất từ origin/${devBranch}...`);
        ensureRemoteOrigin(targetServiceDir, gitRepo);
        execSync(`git fetch origin`, { cwd: targetServiceDir, stdio: 'pipe' });

        // 4. Tạo Git Worktree độc lập
        try {
            execSync(`git branch -D ${branchName}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch(e) {}
        console.log(`[+] Tạo git worktree tại .worktrees/${branchName}...`);
        execSync(`git worktree add -b ${branchName} .worktrees/${branchName} origin/${devBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });

        // 4b. Copy CLAUDE.md context vào worktree để Claude Code có rules
        try {
            const rootClaudeMd = path.join(process.cwd(), 'CLAUDE.md');
            const worktreeClaudeMd = path.join(worktreeDir, 'CLAUDE.md');
            if (fs.existsSync(rootClaudeMd) && !fs.existsSync(worktreeClaudeMd)) {
                fs.copyFileSync(rootClaudeMd, worktreeClaudeMd);
                console.log(`[+] Đã copy CLAUDE.md vào worktree.`);
            }
        } catch(e) { console.warn(`[!] Không thể copy CLAUDE.md: ${e.message}`); }
        // 5. Chuẩn bị prompt và thư mục evidence
        let attachmentInfo = "";
        if (attachments.length > 0) {
            attachmentInfo = "Attachments available:\n" + attachments.map(a => `- ${a.filename}: ${a.content}`).join("\n");
        }

        let serviceTestCmd = "'./mvnw clean test' or 'mvn clean test'";
        let commitPrefix = "fix(api)";
        if (targetService === 'web') {
            serviceTestCmd = "'npm test' or 'npm run build'";
            commitPrefix = "fix(web)";
        }
        const fixPrompt = `Fix bug: ${summary}. ${attachmentInfo}. Locate the bug, modify the source code with minimal changes in the 'src' directory, run verification command ${serviceTestCmd}, ensure it passes, commit the fix using 'git commit -m "${commitPrefix}: ..."' following conventional commits. DO NOT commit any files from the 'evidence' folder. Do not fail.`;

        // Dọn dẹp evidence cũ của ticket này (nếu có)
        fs.rmSync(path.join(process.cwd(), 'evidence', issueKey), { recursive: true, force: true });
        evidenceHelper.ensureEvidenceDir(issueKey);
        evidenceHelper.saveEvidence(issueKey, 'before', `${issueKey}_error.txt`, JSON.stringify(description) || summary);

        // 6. Bước 1: Repro Bug trong worktree
        console.log(`[+] Bước 1: Repro Bug (Model: ${CLAUDE_MODEL}, Timeout: ${CLAUDE_TIMEOUT}ms)...`);
        const reproPrompt = getReproPrompt().replace(/\{JIRA_KEY\}/g, issueKey);
        const reproOutput = execSync(`claude -p "Bug: ${summary}. ${reproPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            cwd: worktreeDir,
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

        await evidenceHelper.sendEvidenceToTelegram(issueKey, 'before', `🚨 <b>LỖI MỚI PHÁT HIỆN & REPRO</b>\n<b>Ticket:</b> ${issueKey}\n<b>Summary:</b> ${summary}`);

        // 7. Bước 2: Fix Bug trong worktree
        console.log(`[+] Bước 2: Fix Bug trong worktree...`);
        execSync(`claude -p "${fixPrompt}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions`, {
            cwd: worktreeDir,
            stdio: 'inherit',
            timeout: CLAUDE_TIMEOUT
        });

        // 8. Đảm bảo AI đã tự commit
        await ensureAICommittedItself(branchName, `ticket ${issueKey}`, worktreeDir, devBranch);

        // 9. Push branch hotfix lên gitRepo tương ứng
        console.log(`[+] Đang push nhánh ${branchName} lên ${gitRepo}...`);
        execSync(`git push -u ${pushUrl} ${branchName} --force`, { cwd: targetServiceDir, stdio: 'inherit' });

        // 10. Tạo PR trên GitHub vào prodBranch của service
        console.log(`[+] Tự động mở Pull Request vào ${prodBranch} trên ${gitRepo}...`);
        const pr = await createPR(
            gitRepo,
            prodBranch,
            branchName,
            `[Auto-Fix] ${issueKey}: ${summary}`,
            `Auto-generated fix by Claude Code for Jira ticket **${issueKey}**.\n\nSummary: ${summary}\nDev Branch: \`${devBranch}\`\nProd Target: \`${prodBranch}\``
        );

        // Lưu PR info vào danh sách chờ
        savePendingPR({
            prNumber: pr.number,
            branch: branchName,
            issueKey: issueKey,
            gitRepo: gitRepo,
            devBranch: devBranch,
            prodBranch: prodBranch,
            targetServiceDir: targetServiceDir,
            date: new Date().toISOString()
        });

        // 11. Báo cáo Telegram kèm nút duyệt Merge
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "🔀 Merge PR", callback_data: `merge|${pr.number}|${branchName}` },
                    { text: "⏳ Lưu vào hàng đợi", callback_data: `defer|${pr.number}|${branchName}|${issueKey}` }
                ],
                [
                    { text: isGitHubHost() ? "🔗 Xem PR trên GitHub" : "🔗 Xem PR/MR trên Git Host", url: pr.html_url }
                ]
            ]
        };

        await sendTelegramMessage(
            `🚀 <b>ĐÃ FIX & TẠO PR THÀNH CÔNG!</b>\n\n` +
            `• <b>Ticket:</b> <code>${issueKey}</code>\n` +
            `• <b>Service:</b> <code>${targetService}</code> (${gitRepo})\n` +
            `• <b>Summary:</b> ${summary}\n` +
            `• <b>Branch:</b> <code>${branchName}</code> -> <code>${prodBranch}</code>\n` +
            `• <b>Pull Request:</b> <a href="${pr.html_url}">#${pr.number}</a>\n\n` +
            `<i>Chọn hành động bên dưới:</i>`,
            keyboard
        );

        // 12. Cập nhật Jira
        await addJiraComment(
            issueKey,
            `✅ [Auto-Fix Bot] Đã tạo Pull Request sửa lỗi thành công!\n\n` +
            `- Repository: ${gitRepo}\n` +
            `- PR: ${pr.html_url}\n` +
            `- Branch: ${branchName} -> ${prodBranch}\n` +
            `- Chờ review và duyệt merge vào production.`
        );

    } finally {
        // Luôn dọn dẹp worktree sau khi xử lý xong
        console.log(`[+] Dọn dẹp Git Worktree .worktrees/${branchName}...`);
        try {
            execSync(`git worktree remove --force .worktrees/${branchName}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch(e) {
            console.warn(`[!] Không thể xóa worktree .worktrees/${branchName}: ${e.message}`);
        }
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
