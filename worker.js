const cp = require('child_process');
const origExecSync = cp.execSync;
const execSync = (cmd, options = {}) => origExecSync(cmd, { windowsHide: true, ...options });
const { spawnSync, spawn } = cp;
const fs = require('fs');
const path = require('path');
const os = require('os');
// Tự động nạp file .env từ thư mục gốc của worker (chạy an toàn cả khi không dùng cờ --env-file)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const eqIdx = trimmed.indexOf('=');
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (!process.env[k]) process.env[k] = v;
            }
        }
    } catch (e) {
        console.warn(`[!] Không đọc được file .env: ${e.message}`);
    }
}

// Ghi nhận PID và Mirror log ra file evidences/worker.log để Dashboard theo dõi
const PID_FILE = path.join(__dirname, 'evidences', 'worker.pid');
const LOG_FILE = path.join(__dirname, 'evidences', 'worker.log');
try {
    fs.mkdirSync(path.join(__dirname, 'evidences'), { recursive: true });
    fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf8');
} catch (e) {}

const cleanPidFile = () => {
    try {
        if (fs.existsSync(PID_FILE)) {
            const currentSaved = fs.readFileSync(PID_FILE, 'utf8').trim();
            if (currentSaved === process.pid.toString()) {
                fs.unlinkSync(PID_FILE);
            }
        }
    } catch (e) {}
};
process.on('exit', cleanPidFile);
process.on('SIGINT', () => { cleanPidFile(); process.exit(0); });
process.on('SIGTERM', () => { cleanPidFile(); process.exit(0); });

try {
    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = function (chunk, encoding, callback) {
        try { logStream.write(chunk); } catch (e) {}
        return origStdoutWrite(chunk, encoding, callback);
    };
    process.stderr.write = function (chunk, encoding, callback) {
        try { logStream.write(chunk); } catch (e) {}
        return origStderrWrite(chunk, encoding, callback);
    };
} catch (e) {
    console.warn(`[!] Không khởi tạo được log stream: ${e.message}`);
}

function getTimestamp() {
    const d = new Date();
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// File settings do WORKER sở hữu, nằm ngoài repo service.
// Claude Code nạp chúng qua --settings / --append-system-prompt → KHÔNG cần ghi
// file nào vào repo của khách (không để lại CLAUDE.md / .claude/ lạ trong PR).
const WORKER_RULES_FILE = path.join(__dirname, 'CLAUDE.md');
const WORKER_HOOK_FILE = path.join(__dirname, '.claude', 'hooks', 'pre-tool-use.js');
const WORKER_SETTINGS_FILE = path.join(__dirname, '.claude', 'settings.generated.json');
const WORKER_MCP_FILE = path.join(__dirname, '.claude', 'mcp.generated.json');

// Sinh cấu hình MCP sạch (chuẩn ai-worker): gọi thẳng binary node / .exe,
// không gọi qua file .cmd / batch wrapper để triệt tiêu 100% cửa sổ popup cmd/conhost.
function ensureWorkerMcpConfig() {
    try {
        const homeMcpPath = path.join(os.homedir(), '.claude.json');
        let atlassianEnv = {};
        if (fs.existsSync(homeMcpPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(homeMcpPath, 'utf8'));
                if (raw.mcpServers && raw.mcpServers['company-atlassian'] && raw.mcpServers['company-atlassian'].env) {
                    atlassianEnv = raw.mcpServers['company-atlassian'].env;
                }
            } catch (err) {}
        }
        const mcpConfig = {
            mcpServers: {
                gitnexus: {
                    command: 'node',
                    args: ['C:/Users/Admin/AppData/Roaming/npm/node_modules/gitnexus/dist/cli/index.js', 'mcp']
                },
                'company-atlassian': {
                    command: 'C:/Users/Admin/.local/bin/mcp-atlassian.exe',
                    args: [],
                    env: atlassianEnv
                },
                context7: {
                    command: 'node',
                    args: ['C:/Users/Admin/AppData/Roaming/npm/node_modules/@upstash/context7-mcp/dist/index.js']
                },
                glab: {
                    command: 'C:/Users/Admin/AppData/Local/Programs/glab/glab.exe',
                    args: ['mcp', 'serve']
                },
                memorix: {
                    command: 'node',
                    args: ['C:/Users/Admin/AppData/Roaming/npm/node_modules/memorix/dist/cli/index.js', 'serve', '--mode', 'lite']
                },
                cloakbrowser: {
                    command: 'node',
                    args: ['D:/mcp-servers/cloakbrowser/mcp-server-full.mjs']
                }
            }
        };
        fs.mkdirSync(path.dirname(WORKER_MCP_FILE), { recursive: true });
        fs.writeFileSync(WORKER_MCP_FILE, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
        return WORKER_MCP_FILE;
    } catch (e) {
        console.warn(`[!] Không ghi được ${WORKER_MCP_FILE}: ${e.message}`);
        return null;
    }
}
// Sinh settings.json với đường dẫn hook TUYỆT ĐỐI (hook chạy ở cwd của Claude = repo service
// của repo khách nên đường dẫn tương đối sẽ không tìm thấy). Ghi 1 lần lúc khởi động.
function ensureWorkerSettings() {
    if (!fs.existsSync(WORKER_HOOK_FILE)) return null;
    const settings = {
        hooks: {
            PreToolUse: [
                { matcher: '*', hooks: [{ type: 'command', command: `node "${WORKER_HOOK_FILE}"` }] }
            ]
        }
    };
    try {
        fs.writeFileSync(WORKER_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
        return WORKER_SETTINGS_FILE;
    } catch (e) {
        console.warn(`[!] Không ghi được ${WORKER_SETTINGS_FILE}: ${e.message}`);
        return null;
    }
}

function normalizeTimeoutMs(val, defaultMs = 3600000) {
    if (!val) return defaultMs;
    const str = String(val).trim().toLowerCase();
    if (str.endsWith('h') || str.endsWith('hr') || str.endsWith('hour') || str.endsWith('hours')) {
        return Math.round(parseFloat(str) * 3600 * 1000);
    }
    if (str.endsWith('m') || str.endsWith('min') || str.endsWith('mins') || str.endsWith('minute') || str.endsWith('minutes')) {
        return Math.round(parseFloat(str) * 60 * 1000);
    }
    if (str.endsWith('s') || str.endsWith('sec') || str.endsWith('secs') || str.endsWith('second') || str.endsWith('seconds')) {
        return Math.round(parseFloat(str) * 1000);
    }
    const num = parseFloat(str);
    if (isNaN(num) || num <= 0) return defaultMs;
    if (num <= 120) return Math.round(num * 60 * 1000); // 1 - 120 coi là phút (vd 60 -> 60 phút = 1 tiếng)
    if (num < 10000) return Math.round(num * 1000);     // 120 - 10000 coi là giây (vd 3600 -> 1 tiếng)
    return Math.round(num);                             // >= 10000 coi là ms
}

function runClaude(prompt, cwd, timeout = CLAUDE_TIMEOUT, captureOutput = false) {
    return new Promise((resolve, reject) => {
        let promptFilePath = null;
        let effectivePrompt = prompt;

        // Kỹ thuật từ ai-worker: Nếu prompt dài > 4000 ký tự, dispatch qua file trung gian
        // để tránh tràn độ dài dòng lệnh Windows CLI (giới hạn 32,767 ký tự)
        if (prompt.length > 4000) {
            try {
                const tmpDir = path.join(WORKER_ROOT, '.claude');
                fs.mkdirSync(tmpDir, { recursive: true });
                promptFilePath = path.join(tmpDir, `tmp_prompt_${Date.now()}.md`);
                fs.writeFileSync(promptFilePath, prompt, 'utf8');
                effectivePrompt = `Đọc kỹ và thực thi toàn bộ yêu cầu trong file sau: "${promptFilePath}". Tuân thủ chính xác từng bước.`;
            } catch (e) {
                console.warn(`[!] Không tạo được dispatch prompt file, fallback prompt inline: ${e.message}`);
                effectivePrompt = prompt;
            }
        }

        // CÁC CỜ BẢO VỆ TỐI THƯỢNG (HỌC HỎI TỪ ai-worker):
        // 1. `--mcp-config`: Nạp đầy đủ 6 MCP Server sạch (chạy thẳng node/.exe, triệt tiêu popup terminal)
        // 2. `--strict-mcp-config`: Chỉ nạp MCP từ file config sạch này, bỏ qua các batch script .cmd ngoài máy
        // 3. `--no-session-persistence`: KHÔNG lưu session vào ~/.claude/projects/ -> KHÔNG CHIẾM / ĐÈ SESSION CỦA DEV TRONG CÙNG FOLDER
        // 4. `--output-format stream-json --verbose`: STREAM TOÀN BỘ SUY LUẬN VÀ TOOL CALL THEO THỜI GIAN THỰC RA CONSOLE/LOG
        if (!fs.existsSync(WORKER_MCP_FILE)) ensureWorkerMcpConfig();

        const args = [
            '-p', effectivePrompt,
            '--verbose',
            '--output-format', 'stream-json',
            '--no-session-persistence',
            '--model', CLAUDE_MODEL,
            '--dangerously-skip-permissions'
        ];

        if (fs.existsSync(WORKER_MCP_FILE)) {
            args.push('--mcp-config', WORKER_MCP_FILE, '--strict-mcp-config');
        }

        // Guardrail hook: nạp qua --settings (đường dẫn tuyệt đối, file của worker).
        if (!fs.existsSync(WORKER_SETTINGS_FILE)) ensureWorkerSettings();
        if (fs.existsSync(WORKER_SETTINGS_FILE)) {
            args.push('--settings', WORKER_SETTINGS_FILE);
        }
        // Rules khoanh vùng bug: nạp như system prompt bổ sung.
        if (fs.existsSync(WORKER_RULES_FILE)) {
            args.push('--append-system-prompt', fs.readFileSync(WORKER_RULES_FILE, 'utf8'));
        }

        const options = {
            cwd,
            shell: false,
            windowsHide: true,
            env: {
                ...process.env,
                MCP_TIMEOUT: '60000',
                MCP_HANDSHAKE_TIMEOUT: '60000',
                MCP_HANDSHAKE_TIMEOUT_MS: '60000',
                ENABLE_TOOL_SEARCH: 'true'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        };

        const child = spawn('claude', args, options);

        // Đóng stdin ngay lập tức (EOF) để Claude Code non-interactive không bao giờ treo đợi TTY
        try { child.stdin.end(); } catch (e) {}

        let lineBuffer = '';
        let accumulatedAssistantText = '';
        let accumulatedFinalResult = '';
        let accumulatedStderr = '';
        let isTimedOut = false;

        // Watchdog timer với Safe Tree-Kill trên Windows
        const timer = setTimeout(() => {
            isTimedOut = true;
            console.error(`\n[!] Claude execution timed out after ${timeout}ms. Đang giải phóng cây tiến trình (tree-kill)...`);
            if (process.platform === 'win32') {
                try {
                    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
                } catch (e) {}
            } else {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (e) {
                    try { child.kill('SIGKILL'); } catch (e2) {}
                }
            }
        }, timeout);

        // Real-time streaming parser cho stream-json (chuẩn ai-worker):
        // Bóc tách [AGENT THOUGHT], [TOOL CALL], [TOOL RESULT] và câu trả lời theo thời gian thực
        child.stdout.on('data', (chunk) => {
            lineBuffer += chunk.toString('utf8');
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop(); // Giữ lại phần dư chưa hết dòng

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const obj = JSON.parse(trimmed);
                    const t = obj.type;

                    if (t === 'assistant') {
                        const msg = obj.message || {};
                        for (const c of msg.content || []) {
                            if (c.type === 'text' && c.text) {
                                accumulatedAssistantText += (accumulatedAssistantText ? '\n' : '') + c.text;
                                process.stdout.write(c.text);
                            } else if (c.type === 'tool_use') {
                                const toolName = c.name || 'tool';
                                const inputPreview = JSON.stringify(c.input || {}).slice(0, 160);
                                process.stdout.write(`\x1b[35m[TOOL CALL]\x1b[0m ${toolName} ${inputPreview}\n`);
                            } else if (c.type === 'thinking' && c.thinking) {
                                const thoughtFirstLine = c.thinking.trim().split('\n')[0].slice(0, 140);
                                process.stdout.write(`\x1b[36m[AGENT THOUGHT]\x1b[0m ${thoughtFirstLine}...\n`);
                            }
                        }
                    } else if (t === 'user') {
                        const msg = obj.message || {};
                        for (const c of msg.content || []) {
                            if (c.type === 'tool_result') {
                                const resStr = (typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '')).trim();
                                const firstLine = resStr.split('\n')[0].slice(0, 140);
                                if (firstLine) {
                                    process.stdout.write(`\x1b[90m[TOOL RESULT]\x1b[0m ${firstLine}...\n`);
                                }
                            }
                        }
                    } else if (t === 'result' && obj.result) {
                        accumulatedFinalResult = obj.result;
                    }
                } catch (e) {
                    // Non-JSON chunk (vd: banner khởi động hoặc thông báo)
                    process.stdout.write(trimmed + '\n');
                }
            }
        });

        // Real-time streaming stderr
        child.stderr.on('data', (chunk) => {
            const str = chunk.toString('utf8');
            accumulatedStderr += str;
            process.stderr.write(chunk);
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            if (promptFilePath && fs.existsSync(promptFilePath)) {
                try { fs.unlinkSync(promptFilePath); } catch (e) {}
            }
            reject(err);
        });

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (promptFilePath && fs.existsSync(promptFilePath)) {
                try { fs.unlinkSync(promptFilePath); } catch (e) {}
            }

            if (lineBuffer && lineBuffer.trim()) {
                try {
                    const obj = JSON.parse(lineBuffer.trim());
                    if (obj.result) accumulatedFinalResult = obj.result;
                } catch (e) {}
            }

            if (isTimedOut) {
                return reject(new Error(`spawn claude ETIMEDOUT (${timeout}ms)`));
            }

            if (code !== 0 && code !== null) {
                const errText = (accumulatedStderr || accumulatedFinalResult || accumulatedAssistantText || '').slice(-1000);
                return reject(new Error(`Claude exited with code ${code}: ${errText}`));
            }

            let finalOutput = accumulatedAssistantText.trim();
            if (accumulatedFinalResult && !finalOutput.includes(accumulatedFinalResult.trim())) {
                finalOutput = finalOutput ? `${finalOutput}\n${accumulatedFinalResult.trim()}` : accumulatedFinalResult.trim();
            }
            if (!finalOutput) finalOutput = accumulatedFinalResult || '';
            resolve(finalOutput);
        });
    });
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-7-sonnet';
const CLAUDE_TIMEOUT = normalizeTimeoutMs(
    process.env.CLAUDE_TIMEOUT || process.env.CLAUDE_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MINUTES,
    3600000 // Mặc định 1 tiếng = 3,600,000ms
);

// --- SINGLETON MASTER WORKER CONFIG ---
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
let activeJobs = 0;
const activeWorkspaceLocks = new Set(); // Khoá theo workspace (projectDir): đảm bảo trong 1 workspace chỉ thực thi lần lượt từng bug 1
const activeServiceLocks = new Set(); // Khoá theo "projectKey:targetService" tránh 2 job mutate cùng repo
let isScanning = false;
// Thư mục gốc của worker: nơi chứa projects.json, .env, evidence/, pending-prs.json.
// Dùng __dirname để worker KHÔNG phụ thuộc CWD — chạy được từ bất kỳ thư mục nào.
const WORKER_ROOT = __dirname;

// Đọc danh sách projects
let projectsConfig = [];
try {
    const rawData = fs.readFileSync(path.join(WORKER_ROOT, 'projects.json'), 'utf8');
    projectsConfig = JSON.parse(rawData).projects || [];
} catch (err) {}

// Chuẩn hoá đường dẫn thư mục project.
// - project.path là đường dẫn TƯƠNG ĐỐI so với project.root (mặc định root = WORKER_ROOT).
// - project.path là đường dẫn TUYỆT ĐỐI (C:\... hoặc D:/...) thì dùng nguyên xi.
// Nhờ vậy worker dùng được cho dự án có service nằm ngoài thư mục worker.
function resolveProjectDir(project) {
    const p = project || {};
    if (p.path && path.isAbsolute(p.path)) return p.path;
    const root = p.root
        ? (path.isAbsolute(p.root) ? p.root : path.resolve(WORKER_ROOT, p.root))
        : WORKER_ROOT;
    return path.resolve(root, p.path || '.');
}

// Chuẩn hoá đường dẫn thư mục service trong services.json.
// - service.path là đường dẫn TUYỆT ĐỐI thì dùng nguyên xi.
// - ngược lại là TƯƠNG ĐỐI so với thư mục project.
function resolveServiceDir(projectDir, serviceConfig) {
    const sp = (serviceConfig && serviceConfig.path) || '';
    if (sp && path.isAbsolute(sp)) return sp;
    return path.resolve(projectDir, sp || '.');
}

function validateConfigs() {
    for (const project of projectsConfig) {
        const projectPath = resolveProjectDir(project);
        const servicesFile = path.join(projectPath, 'services.json');
        if (!fs.existsSync(servicesFile)) {
            console.warn(`[CANH BAO] Project ${project.projectKey} thiếu services.json tại ${servicesFile}. Tự động copy từ services.json.example...`);
            try {
                fs.copyFileSync(path.join(WORKER_ROOT, 'services.json.example'), servicesFile);
                console.log(`[+] Đã tạo ${servicesFile}. Vui lòng cấu hình lại các trường.`);
            } catch (err) {
                console.error(`[LOI] Không thể copy services.json.example sang ${servicesFile}: ${err.message}`);
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
const JIRA_DOMAIN = (process.env.JIRA_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_TOKEN || '').trim();

// Tự động nhận diện Jira Cloud (atlassian.net) vs Jira Server / Data Center tự host
const isJiraCloud = JIRA_DOMAIN.toLowerCase().includes('atlassian.net');
const JIRA_API_VER = isJiraCloud ? '3' : '2';
const JIRA_SEARCH_PATH = isJiraCloud ? 'search/jql' : 'search';


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
    const rawHost = (process.env.GIT_HOST || '').toLowerCase();
    const isLocalOrHttp = host.startsWith('10.') || host.startsWith('192.168.') || host.includes(':') || rawHost.startsWith('http://');
    const scheme = isLocalOrHttp ? 'http' : 'https';
    if (GIT_TOKEN) {
        if (isGitHubHost()) {
            return `https://${GIT_TOKEN}@${host}/${cleanRepo}.git`;
        }
        // GitLab / Gitea tự host qua HTTP/HTTPS: dùng oauth2:<token>
        return `${scheme}://oauth2:${GIT_TOKEN}@${host}/${cleanRepo}.git`;
    }
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
// Thời gian chờ pipeline CI/CD kết thúc (poll).
const CI_POLL_MAX = parseInt(process.env.CI_POLL_MAX || '20', 10);
const CI_POLL_INTERVAL_MS = parseInt(process.env.CI_POLL_INTERVAL_MS || '15000', 10);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_IDS_STR = process.env.TELEGRAM_ALLOWED_USER_IDS || '';
const ALLOWED_USER_IDS = ALLOWED_IDS_STR.split(',').map(id => id.trim()).filter(Boolean);

const PENDING_FILE = path.join(__dirname, 'pending-prs.json');

const evidenceHelper = require('./evidence.js');


const getReproPrompt = () => "Reproduce the bug. STRICT SCOPE & FOCUS RULES:\n" +
    "1. Stay 100% inside your current working directory (the service repo: 'src/main' and 'src/test'). DO NOT search or access parent directory ('..'), do not inspect other repos, do not check 'worker.js', do not read shell history.\n" +
    "2. Locate the class/method/file causing the error mentioned in the bug title/stack trace by directly searching inside 'src/'.\n" +
    "3. Reproduce the failure by writing a targeted test case or running local verification, and SAVE real EVIDENCE logs into 'evidence/{JIRA_KEY}/before' (stack trace, test output, error details).\n" +
    "4. Clean up any temporary repro files before proceeding so working tree stays clean.\n" +
    "5. IF CANNOT REPRODUCE after inspecting the codebase, explain clearly in Vietnamese why the bug cannot be reproduced (e.g. synthetic test event, error string not found in codebase, all tests pass), and STOP by printing: [AI_STOP] <Detailed explanation in Vietnamese>";

// Trích xuất lý do AI không thể tái hiện lỗi từ output của Claude
function extractReproStopReason(output) {
    if (!output) return 'Không thể tái hiện lỗi.';

    // 1. Kiểm tra phần sau [AI_STOP]
    if (output.includes('[AI_STOP]')) {
        const afterMatch = output.match(/\[AI_STOP\]\s*([\s\S]*)/);
        let afterText = afterMatch ? afterMatch[1].trim() : '';
        if (afterText.startsWith('REPRO_FAILED')) {
            afterText = afterText.replace(/^REPRO_FAILED\s*:?-?/, '').trim();
        }
        if (afterText.length > 20) {
            return afterText;
        }
    }

    // 2. Lấy đoạn văn bản giải thích của AI trước [AI_STOP] hoặc ở cuối output
    const rawText = output.includes('[AI_STOP]') ? output.split(/\[AI_STOP\]/)[0] : output;
    const lines = rawText.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('[TOOL CALL]') && !l.startsWith('[TOOL RESULT]') && !l.startsWith('[AGENT THOUGHT]') && !l.startsWith('[Pre-flight]'));

    if (lines.length > 0) {
        const candidates = [];
        for (let i = lines.length - 1; i >= 0 && candidates.length < 8; i--) {
            const line = lines[i];
            if (line.includes('---') && candidates.length > 0) break;
            candidates.unshift(line);
        }
        const explanation = candidates.join('\n').trim();
        if (explanation.length > 15) {
            return explanation;
        }
    }

    return 'AI không thể tái hiện lỗi trong mã nguồn hoặc môi trường hiện tại.';
}
// Thiếu cấu hình bắt buộc → phải chết NGAY lúc khởi động.
// Trước đây chỉ console.warn rồi vẫn chạy: Jira trả HTTP 200 + issues rỗng khi token sai
// → worker log "Tìm thấy 0 bug" mỗi 15s, người dùng tưởng hệ thống ổn.
// GIT_TOKEN rỗng còn tệ hơn: createGitHubPR trả về số PR giả → báo "đã tạo PR" cho PR không tồn tại.
const MISSING_CONFIG = [];
if (!JIRA_DOMAIN) MISSING_CONFIG.push('JIRA_DOMAIN');
if (!JIRA_EMAIL) MISSING_CONFIG.push('JIRA_EMAIL');
if (!JIRA_TOKEN) MISSING_CONFIG.push('JIRA_TOKEN');
if (!GIT_TOKEN) MISSING_CONFIG.push('GIT_TOKEN');
if (MISSING_CONFIG.length > 0) {
    console.error(`[LOI] Thiếu cấu hình bắt buộc: ${MISSING_CONFIG.join(', ')}`);
    console.error('[LOI] Điền các biến này vào file .env (xem .env.example) rồi khởi động lại worker.');
    process.exit(1);
}

// Auth: Jira Server PAT dùng Bearer, Jira Cloud dùng Basic base64(email:token)
const authHeader = (JIRA_TOKEN.startsWith('Bearer ') || !isJiraCloud)
    ? (JIRA_TOKEN.startsWith('Bearer ') ? JIRA_TOKEN : `Bearer ${JIRA_TOKEN}`)
    : 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// Xác thực token Jira lúc khởi động. /rest/api/3/myself trả 401 khi token sai/rỗng,
// còn /search/jql vẫn trả 200 với issues rỗng → không kiểm tra thì không bao giờ biết mình sai.
async function validateJiraAuth() {
    try {
        const res = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/myself`, {
            headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
        });
        if (!res.ok) {
            console.error(`[LOI] Xác thực Jira thất bại: HTTP ${res.status}. Kiểm tra JIRA_DOMAIN / JIRA_EMAIL / JIRA_TOKEN trong .env.`);
            console.error('[LOI] Worker dừng. Nếu chạy tiếp, mỗi vòng 15s sẽ log "0 bug" giả.');
            process.exit(1);
        }
        const me = await res.json();
        console.log(`[+] Xác thực Jira thành công: ${me.emailAddress || me.displayName || JIRA_EMAIL}`);
    } catch (e) {
        console.error(`[LOI] Không kết nối được Jira (${JIRA_DOMAIN}): ${e.message}`);
        process.exit(1);
    }
}

function getServiceInfoForPR(prNumber, branchName) {
    const localList = readLocalPendingPRs();
    const pr = localList.find(p => p.prNumber === prNumber || (branchName && p.branch === branchName));
    if (pr && pr.gitRepo && pr.prodBranch) {
        return {
            gitRepo: pr.gitRepo,
            prodBranch: pr.prodBranch,
            devBranch: pr.devBranch || 'master',
            // Nhánh PR đang mở (staging nếu có gate, nếu không thì prod).
            targetBranch: pr.targetBranch || pr.prodBranch,
            issueKey: pr.issueKey || '',
            summary: pr.summary || '',
            targetServiceDir: pr.targetServiceDir || WORKER_ROOT
        };
    }

    const projectKeyMatch = (branchName || (pr && pr.branch) || '').match(/^hotfix\/([A-Z]+)-\d+/);
    const projectKey = projectKeyMatch ? projectKeyMatch[1] : '';
    const pConfig = projectsConfig.find(p => p.projectKey === projectKey);
    const projectDir = pConfig ? resolveProjectDir(pConfig) : path.join(WORKER_ROOT, 'services');
    const servicesJsonPath = path.join(projectDir, 'services.json');

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
                    targetBranch: svc.branches.target || svc.branches.prod || 'master',
                    issueKey: (pr && pr.issueKey) || '',
                    summary: (pr && pr.summary) || '',
                    targetServiceDir: resolveServiceDir(projectDir, svc)
                };
            }
        } catch (e) {}
    }

    if (pr && pr.gitRepo) {
        return {
            gitRepo: pr.gitRepo,
            prodBranch: pr.prodBranch || 'master',
            devBranch: pr.devBranch || 'master',
            targetBranch: pr.targetBranch || pr.prodBranch || 'master',
            issueKey: pr.issueKey || '',
            summary: pr.summary || '',
            targetServiceDir: pr.targetServiceDir || WORKER_ROOT
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

// --- GITHUB REST API UTILS ---
const githubHeaders = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Autonomous-AI-Worker'
};

// --- TELEGRAM BOT HELPERS ---
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(text, replyMarkup = null) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return null;

    let safeText = text;
    if (safeText.length > 4000) {
        safeText = safeText.slice(0, 3950) + '\n... (nội dung quá dài, đã rút gọn)';
    }

    const body = { chat_id: chatId, text: safeText, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;

    try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.ok) return data.result.message_id;

        console.error(`[!] Lỗi gửi tin Telegram HTML: ${data.description}. Đang thử fallback plain text...`);
        const plainBody = { chat_id: chatId, text: safeText.replace(/<[^>]+>/g, '') };
        if (replyMarkup) plainBody.reply_markup = replyMarkup;
        const plainRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(plainBody)
        });
        const plainData = await plainRes.json();
        return plainData.ok ? plainData.result.message_id : null;
    } catch (e) {
        console.error("Lỗi gửi tin nhắn Telegram:", e.message);
        return null;
    }
}

async function sendTelegramDocument(caption, filename, content) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        if (caption) formData.append('caption', caption);
        formData.append('document', new Blob([content], { type: 'text/plain' }), filename);

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (!data.ok) {
            console.error(`[!] Lỗi gửi file log Telegram (${filename}): ${data.description}`);
        }
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
        // TẠM THỜI BỎ QUA: worker tự merge vào nhánh target (staging) sau khi
        // unit test + coverage + build đều pass. Luồng tạo PR và duyệt merge
        // thủ công sang production tạm thời không dùng.
        await answerCallbackQuery(cb.id, `Tính năng duyệt PR thủ công tạm thời bị tắt. Worker tự merge vào staging sau khi unit test + build pass.`, true);
        return;
    }

    if (action.startsWith('defer|')) {
        // TẠM THỜI BỎ QUA: không còn danh sách chờ vì worker tự merge vào staging.
        await answerCallbackQuery(cb.id, `Tính năng lưu vào hàng đợi tạm thời bị tắt.`, true);
        return;
    }

    if (action === 'list_pending') {
        // TẠM THỜI BỎ QUA: không còn danh sách chờ PR (worker tự merge vào staging).
        await answerCallbackQuery(cb.id, `Danh sách chờ PR tạm thời bị tắt. Worker tự merge vào staging sau khi xác minh pass.`);
        await editMessageText(msgId,
            `<b>📋 DANH SÁCH PR ĐỢI MERGE</b>\n\n` +
            `<i>Tạm thời không dùng danh sách chờ. Worker tự chạy unit test + coverage + build, ` +
            `sau đó tự merge branch hotfix vào nhánh target (staging) và báo cáo kết quả.</i>`);
    }
}

// --- TỰ ĐỘNG GIẢI QUYẾT CONFLICT BẰNG CLAUDE ---
async function resolveConflictWithClaude(branchName, targetServiceDirOrServicesDir = null, serviceInfoParam = null) {
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
    // Nhánh PR đang mở: staging nếu có gate staging, nếu không thì prod.
    // Trước đây luôn dùng prodBranch → với gate staging thì phải merge vào staging.
    const targetBranch = svc.targetBranch || svc.prodBranch;
    const devBranch = svc.devBranch || 'master';
    const gitRepo = svc.gitRepo;
    let cwd = svc.targetServiceDir || WORKER_ROOT;
    if (targetServiceDirOrServicesDir && targetServiceDirOrServicesDir !== 'services') {
        cwd = targetServiceDirOrServicesDir;
    }
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

        await runClaude(conflictPrompt, cwd, CLAUDE_TIMEOUT, false);

        // Bắt buộc kiểm tra commit do AI thực hiện
        await ensureAICommittedItself(branchName, "resolve conflict", cwd, devBranch, 'fix(conflict)');

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
// commitPrefix: 'fix(api)' | 'fix(web)' | 'fix(conflict)' — BẮT BUỘC theo convention trong CLAUDE.md.
// Trước đây commit tự động dùng prefix 'fix(auto)' → vi phạm convention.
async function ensureAICommittedItself(branchName, context, worktreeDir, baseBranch = null, commitPrefix = 'fix(api)') {
    const cwd = worktreeDir || WORKER_ROOT;
    // Đảm bảo không add evidence/ vào commit rác
    const diffStatus = execSync(`git status --porcelain`, { cwd }).toString().trim();
    if (diffStatus !== "") {
        console.warn(`[!] CẢNH BÁO: Claude AI đã để lại file chưa commit sau khi ${context} tại ${cwd}!`);
        
        // Chỉ add các file không phải evidence/build artifact (parse porcelain robust)
        const lines = diffStatus.split('\n');
        let hasNonEvidence = false;
        const isIgnored = (f) => {
            const p = f.replace(/^"|"$/g, '');
            // CLAUDE.md và .claude/ không bao giờ được đưa vào commit của repo khách.
            if (p === 'CLAUDE.md' || p.startsWith('.claude/') || p.includes('/.claude/')) return true;
            // File secret (.env, .env.*, key, cert) — TUYỆT ĐỐI không commit.
            if (isSecretPath(p)) return true;
            return p.startsWith('evidence/') || p.includes('/evidence/') || p.startsWith('target/') || p.includes('/target/') || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.endsWith('.class');
        };
        for (const line of lines) {
            const m = line.match(/^.{2}\s+(.+)$/);
            if (!m) continue;
            const status = m[0].slice(0, 2);
            let file = m[1].trim().replace(/^"|"$/g, '');
            if (file.includes(' -> ')) file = file.split(' -> ').pop().trim().replace(/^"|"$/g, '');
            if (!file || isIgnored(file)) continue;
            // File UNTRACKED (??) chỉ được add nếu nằm trong src/ (mã nguồn + test do AI tạo).
            // File untracked ngoài src/ là của user (config, script...) → KHÔNG commit.
            if (status === '??') {
                const norm = file.replace(/\\/g, '/');
                if (!norm.startsWith('src/') && !norm.includes('/src/')) {
                    console.warn(`[!] Bỏ qua file untracked ngoài src/: ${file}`);
                    continue;
                }
            }
            execSync(`git add -- "${file}"`, { cwd });
            hasNonEvidence = true;
        };
        
        if (hasNonEvidence) {
            // Dùng ĐÚNG prefix convention (fix(api) / fix(web)) thay vì 'fix(auto)'.
            // Kèm [AUTO-BUG] để người review nhận ra commit do worker tạo, không phải AI tự viết.
            const msg = `${commitPrefix}: commit các thay đổi còn sót lại sau ${context} [AUTO-BUG]`;
            execSync(`git commit -m "${msg}"`, { cwd });
            console.log(`[+] Đã tự động commit các thay đổi còn sót lại (loại trừ evidence). Message: ${msg}`);
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
            /(^|\/)src\//.test(f) || f.endsWith('.java') || f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.jsx') || f.endsWith('.tsx') || f.endsWith('pom.xml') || f.endsWith('package.json')
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
        console.log(`[${getTimestamp()}] [!] Hệ thống đang đầy tải (${activeJobs}/${MAX_CONCURRENT_JOBS}). Bỏ qua chu kỳ quét.`);
        return;
    }

    for (const project of projectsConfig) {
        if (activeJobs >= MAX_CONCURRENT_JOBS) break;

        try {
            const { projectKey } = project;
            const projectDir = resolveProjectDir(project);
            const workspaceKey = path.resolve(projectDir);

            // Tuần tự theo Workspace: trong 1 workspace chỉ chạy lần lượt từng bug 1
            if (activeWorkspaceLocks.has(workspaceKey)) {
                continue;
            }

            const jql = `project = ${projectKey} AND issuetype = Bug AND status IN ("To Do", "Selected for Development", "Backlog", "Open", "RE OPENED") AND (labels = "auto-fix" OR summary ~ "AUTO-BUG") AND (labels NOT IN ("auto-fix-processing", "auto-fix-done", "auto-fix-failed") OR labels IS EMPTY)`;
            const searchUrl = `https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/${JIRA_SEARCH_PATH}?jql=${encodeURIComponent(jql)}&fields=summary,description,attachment,labels&maxResults=1`;
            console.log(`[${getTimestamp()}] Đang quét Jira cho dự án ${projectKey}...`);
            const res = await fetch(searchUrl, {
                method: 'GET',
                headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
            });

            if (!res.ok) {
                console.error(`[${getTimestamp()}] [!] Lỗi tìm kiếm Jira (${projectKey}): HTTP ${res.status} - ${await res.text()}`);
                continue;
            }

            const data = await res.json();
            const issues = data.issues || [];
            console.log(`[${getTimestamp()}] Tìm thấy ${issues.length} bug cho dự án ${projectKey}`);
            if (issues.length > 0) {
                const issue = issues[0];
                const currentLabels = issue.fields.labels || [];
                // Phòng thủ nhiều tầng: bỏ qua nếu ticket đã chứa nhãn kết quả/đang xử lý
                if (currentLabels.some(l => ['auto-fix-processing', 'auto-fix-done', 'auto-fix-failed'].includes(l))) {
                    continue;
                }

                const serviceLabel = currentLabels.find(l => l.startsWith('service:'));
                const targetService = serviceLabel ? serviceLabel.split(':')[1] : null;
                const serviceLockKey = targetService ? `${projectKey}:${targetService}` : null;
                // Per-service lock: tránh 2 job cùng mutate một repo service khi MAX_CONCURRENT_JOBS > 1
                if (serviceLockKey && activeServiceLocks.has(serviceLockKey)) {
                    console.log(`[${getTimestamp()}] [!] Service '${serviceLockKey}' đang được xử lý bởi job khác. Tạm hoãn ${issue.key} sang chu kỳ sau.`);
                    continue;
                }

                console.log(`[${getTimestamp()}] [+] Đang gắn nhãn auto-fix-processing cho ${issue.key}...`);
                // fetch chỉ throw khi lỗi mạng, HTTP 401/403/400 sẽ bị nuốt im lặng
                // và ticket tiếp tục khớp JQL ở vòng 15s sau → xử lý trùng vô hạn.
                try {
                    const claimRes = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/issue/${issue.key}`, {
                        method: 'PUT',
                        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ update: { labels: [{ add: "auto-fix-processing" }] } })
                    });
                    if (!claimRes.ok) {
                        console.error(`[!] KHÔNG gắn được nhãn auto-fix-processing cho ${issue.key}: HTTP ${claimRes.status} - ${await claimRes.text()}`);
                        console.error(`[!] Bỏ qua ticket ${issue.key}. Kiểm tra JIRA_TOKEN / quyền gắn nhãn trong project ${projectKey}.`);
                        continue;
                    }
                } catch (e) {
                    console.error(`[!] Lỗi mạng khi claim ${issue.key}: ${e.message}. Bỏ qua.`);
                    continue;
                }

                if (serviceLockKey) activeServiceLocks.add(serviceLockKey);
                activeWorkspaceLocks.add(workspaceKey);
                activeJobs++;
                console.log(`[${getTimestamp()}] [+] Giao việc thành công: ${issue.key} trong workspace '${projectKey}'. Active jobs: ${activeJobs}`);

                processBugWrapper(issue, project, serviceLockKey, workspaceKey).catch(e => {
                    console.error(`Worker crash nền tại ticket ${issue.key}:`, e);
                });
            }
        } catch (err) {}
    }
}

function buildDetailedJiraFailComment(ctx, err) {
    const cleanReason = (err.message || 'Lỗi không xác định').trim();
    const stepLine = ctx.step ? `*Bước gặp sự cố:* ${ctx.step}\n\n` : '';
    return `❌ *[Auto-Fix Bot] Không thể tự động sửa lỗi*\n\n` +
        stepLine +
        `*Lý do:*\n` +
        `${cleanReason}`;
}

async function sendTelegramFailureAlert(ctx, err) {
    const serviceStr = ctx.targetService ? `${escapeHtml(ctx.targetService)}` : 'Chưa xác định';
    const repoStr = ctx.gitRepo ? ` (<code>${escapeHtml(ctx.gitRepo)}</code>)` : '';
    const branchStr = ctx.branchName ? `<code>${escapeHtml(ctx.branchName)}</code>` : 'Chưa tạo';
    let cleanErr = err.message || 'Lỗi không xác định';
    if (cleanErr.length > 2500) {
        cleanErr = cleanErr.slice(0, 2500) + '\n... (chi tiết xem file log / Jira)';
    }

    const text = `❌ <b>AUTO-FIX THẤT BẠI — CẦN CAN THIỆP THỦ CÔNG</b>\n\n` +
        `• <b>Ticket:</b> <code>${escapeHtml(ctx.issueKey)}</code>\n` +
        `• <b>Dự án:</b> ${escapeHtml(ctx.projectName)}\n` +
        `• <b>Service:</b> <code>${serviceStr}</code>${repoStr}\n` +
        `• <b>Branch:</b> ${branchStr}\n` +
        `• <b>Tóm tắt:</b> ${escapeHtml(ctx.summary)}\n` +
        `• <b>Bước thất bại:</b> ⚠️ <b>${escapeHtml(ctx.step)}</b>\n` +
        `• <b>Chi tiết lỗi:</b>\n` +
        `<pre>${escapeHtml(cleanErr)}</pre>\n\n` +
        `👉 <i>Ticket đã được gắn nhãn <code>auto-fix-failed</code> để tránh quét lại. Vui lòng kiểm tra log và xử lý thủ công.</i>`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: `🎫 Xem Jira Ticket`, url: `https://${JIRA_DOMAIN}/browse/${ctx.issueKey}` }
            ]
        ]
    };
    if (ctx.gitRepo && ctx.branchName) {
        try {
            keyboard.inline_keyboard[0].push({
                text: `🔗 Xem branch`,
                url: buildWebUrl(ctx.gitRepo, ctx.branchName)
            });
        } catch (e) {}
    }

    await sendTelegramMessage(text, keyboard);
}

async function processBugWrapper(issue, projectConfig, serviceLockKey = null, workspaceKey = null) {
    let isSuccess = false;
    const failedContext = {
        issueKey: issue.key,
        summary: issue.fields.summary,
        projectName: projectConfig.name || projectConfig.projectKey,
        targetService: null,
        gitRepo: null,
        branchName: null,
        baseBranch: null,
        step: 'Khởi động job xử lý bug'
    };

    try {
        await processBug(issue.key, issue.fields.summary, issue.fields.description, issue.fields.attachment || [], projectConfig, issue.fields.labels || []);
        isSuccess = true;
    } catch (err) {
        console.error(`[-] Xử lý bug ${issue.key} thất bại:`, err.message);
        if (err.contextInfo) {
            Object.assign(failedContext, err.contextInfo);
        }
        if (err.step) {
            failedContext.step = err.step;
        }
        try {
            await markJiraIssueFailed(issue.key, err.message);
        } catch (e) {
            console.error(`[!] Lỗi markJiraIssueFailed: ${e.message}`);
        }
        try {
            const detailedComment = buildDetailedJiraFailComment(failedContext, err);
            await addJiraComment(issue.key, detailedComment);
        } catch (e) {
            console.error(`[!] Lỗi addJiraComment chi tiết: ${e.message}`);
        }
        try {
            await sendTelegramFailureAlert(failedContext, err);
        } catch (e) {
            console.error(`[!] Lỗi gửi Telegram failure alert: ${e.message}`);
        }
    } finally {
        activeJobs--;
        if (serviceLockKey) activeServiceLocks.delete(serviceLockKey);
        if (workspaceKey) activeWorkspaceLocks.delete(workspaceKey);
        console.log(`[-] Hoàn thành job ${issue.key}. Active jobs: ${activeJobs}`);
        // Gỡ nhãn auto-fix-processing + gắn nhãn kết quả.
        // Nếu PUT lỗi, nhãn processing VẪN còn → ticket kẹt vĩnh viễn, JQL loại trừ nó
        // nên không bao giờ được xử lý lại. Phải kiểm tra res.ok và báo lỗi rõ ràng.
        const nextLabel = isSuccess ? "auto-fix-done" : "auto-fix-failed";
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const labelRes = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/issue/${issue.key}`, {
                    method: 'PUT',
                    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ update: { labels: [{ remove: "auto-fix-processing" }, { add: nextLabel }] } })
                });
                if (labelRes.ok) {
                    if (attempt > 1) console.log(`[+] Đã cập nhật nhãn ${issue.key} sau ${attempt} lần thử.`);
                    break;
                }
                console.error(`[!] Cập nhật nhãn ${issue.key} thất bại (lần ${attempt}/3): HTTP ${labelRes.status} - ${await labelRes.text()}`);
            } catch (e) {
                console.error(`[!] Lỗi mạng cập nhật nhãn ${issue.key} (lần ${attempt}/3): ${e.message}`);
            }
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function markJiraIssueFailed(issueKey, reason) {
    try {
        const res = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/issue/${issueKey}`, {
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
        if (!res.ok) {
            console.error(`[!] Không gắn được nhãn auto-fix-failed cho ${issueKey}: HTTP ${res.status}`);
        }
    } catch (e) {
        console.error(`[!] Lỗi gắn nhãn auto-fix-failed cho ${issueKey}: ${e.message}`);
    }
}

async function addJiraComment(issueKey, commentBody) {
    try {
        const bodyPayload = isJiraCloud
            ? {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: commentBody }] }]
            }
            : commentBody;

        const res = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/issue/${issueKey}/comment`, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body: bodyPayload })
        });
        if (!res.ok) {
            console.error(`[!] Không thêm được comment cho ${issueKey}: HTTP ${res.status}`);
        }
    } catch (e) {
        console.error(`[!] Lỗi thêm comment cho ${issueKey}: ${e.message}`);
    }
}

// --- PHÂN LOẠI FILE ---
// Artifact build: không tính là thay đổi thật (một số repo vô tình track chúng).
function isArtifactPath(f) {
    const p = f.replace(/\\/g, '/');
    return p.startsWith('target/') || p.includes('/target/') ||
        p.startsWith('dist/') || p.includes('/dist/') ||
        p.startsWith('node_modules/') || p.includes('/node_modules/') ||
        p.endsWith('.class') || p.endsWith('.jar') ||
        // evidence/ do worker tạo trong repo service → phải dọn, không tính là thay đổi của user.
        p.startsWith('evidence/') || p.includes('/evidence/');
}

// File secret: TUYỆT ĐỐI không được đưa vào commit của repo khách.
// `.env.example` / `.env.sample` là file MẪU (chỉ chứa key trống) — commit vào repo là chuẩn.
function isSecretPath(f) {
    const p = f.replace(/\\/g, '/');
    const base = p.split('/').pop();
    if (base === '.env.example' || base === '.env.sample' || base === '.env.template') return false;
    return base === '.env' || base.startsWith('.env.') ||
        p.endsWith('.pem') || p.endsWith('.key') || p.endsWith('.p12') || p.endsWith('.jks');
}

// Liệt kê thay đổi chưa commit trong repo (bỏ qua artifact build).
// Dùng để dirty-guard: nếu repo service bẩn thì thay đổi sẽ đi theo khi checkout -B
// và có thể bị commit + push lên nhánh target. Phải abort trước khi điều đó xảy ra.
function listDirtyFiles(cwd) {
    let out = '';
    try {
        out = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
    } catch (e) {
        return [];
    }
    return out.split('\n').map(l => l.trimEnd()).filter(Boolean)
        .map(l => {
            const file = l.slice(3).trim();
            const arrow = file.indexOf(' -> ');
            return (arrow >= 0 ? file.slice(arrow + 4) : file).replace(/^"|"$/g, '');
        })
        .filter(f => f && !isArtifactPath(f));
}

// --- CHẠY TEST + BUILD (worker tự chạy, không phụ thuộc AI tự báo) ---
function runCommand(cwd, cmd, timeoutMs = 15 * 60 * 1000) {
    try {
        const out = execSync(cmd, {
            cwd,
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 50 * 1024 * 1024
        });
        return { ok: true, output: out || '' };
    } catch (e) {
        const stdout = e.stdout ? e.stdout.toString() : '';
        const stderr = e.stderr ? e.stderr.toString() : '';
        return { ok: false, output: (stdout + '\n' + stderr).trim() };
    }
}
function hasJacocoPlugin(cwd) {
    const pomPath = path.join(cwd, 'pom.xml');
    if (fs.existsSync(pomPath)) {
        try {
            const pom = fs.readFileSync(pomPath, 'utf8');
            return pom.toLowerCase().includes('jacoco');
        } catch (e) {}
    }
    const gradlePath = path.join(cwd, 'build.gradle');
    if (fs.existsSync(gradlePath)) {
        try {
            const gradle = fs.readFileSync(gradlePath, 'utf8');
            return gradle.toLowerCase().includes('jacoco');
        } catch (e) {}
    }
    return false;
}

// Kiểm tra coverage JaCoCo cho đúng các class liên quan tới file vừa sửa.
// Đọc target/site/jacoco/jacoco.csv: CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED
function checkCoverageForChangedFiles(cwd, changedFiles, minCoverage = 90) {
    // Gom tên class đã sửa: src/main/java/com/poc/Calc.java -> Calc
    // Kiểm tra DANH SÁCH class TRƯỚC: nếu không có file .java nào bị sửa thì không cần
    // jacoco.csv (kiểm tra CSV trước sẽ fail oan khi repo chưa từng chạy jacoco).
    const changedClasses = new Set();
    for (const f of changedFiles) {
        const norm = f.replace(/\\/g, '/');
        // `git diff --name-only` trả path KHÔNG có leading slash (vd 'src/main/java/...'),
        // nên phải match cả đầu chuỗi lẫn giữa chuỗi — dùng includes('/src/main/java/')
        // sẽ luôn false và bỏ qua toàn bộ class đã sửa.
        if (!/(^|\/)src\/main\/java\//.test(norm)) continue;
        const base = norm.split('/').pop().replace(/\.java$/, '');
        if (base) changedClasses.add(base);
    }
    if (changedClasses.size === 0) {
        return { ok: true, reason: 'Không có file .java trong src/main/java bị sửa (bỏ qua check coverage)', details: [] };
    }

    const csvPath = path.join(cwd, 'target', 'site', 'jacoco', 'jacoco.csv');
    if (!fs.existsSync(csvPath)) {
        return { ok: false, reason: 'Không tìm thấy target/site/jacoco/jacoco.csv (chưa chạy jacoco:report?)', details: [] };
    }

    const csv = fs.readFileSync(csvPath, 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0].split(',');
    const iClass = header.indexOf('CLASS');
    const iMissed = header.indexOf('INSTRUCTION_MISSED');
    const iCovered = header.indexOf('INSTRUCTION_COVERED');
    if (iClass < 0 || iMissed < 0 || iCovered < 0) {
        return { ok: false, reason: 'jacoco.csv thiếu cột CLASS/INSTRUCTION_MISSED/INSTRUCTION_COVERED', details: [] };
    }

    const details = [];
    let allOk = true;
    for (const cls of changedClasses) {
        let missed = 0, covered = 0, found = false;
        for (const line of lines.slice(1)) {
            const cells = line.split(',');
            if (cells[iClass] !== cls) continue;
            found = true;
            missed += parseInt(cells[iMissed] || '0', 10);
            covered += parseInt(cells[iCovered] || '0', 10);
        }
        if (!found) {
            details.push({ cls, coverage: null, note: 'không tìm thấy trong jacoco.csv' });
            allOk = false;
            continue;
        }
        const total = missed + covered;
        const pct = total > 0 ? Math.round((covered / total) * 1000) / 10 : 0;
        details.push({ cls, coverage: pct, missed, covered });
        if (pct < minCoverage) allOk = false;
    }
    return { ok: allOk, details, minCoverage };
}

// Chạy chuỗi xác minh cho service. Dừng ngay khi bước nào fail.
function verifyService(cwd, targetService, changedFiles) {
    const isJava = fs.existsSync(path.join(cwd, 'pom.xml')) || fs.existsSync(path.join(cwd, 'build.gradle'));
    const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
    const isApi = isJava || (!hasPackageJson && targetService !== 'web' && !targetService.startsWith('fe-') && !targetService.endsWith('-web'));
    const hasJacoco = isJava && hasJacocoPlugin(cwd);
    const steps = [];

    // 1) Unit test đầy đủ (+ jacoco report nếu api có tích hợp JaCoCo)
    //    Web: nếu có test runner (vitest/jest) → chạy npm test -- --run.
    //    Nếu web chưa cấu hình test runner (như shop-web/cms-web chuẩn Vite FE) → chạy npm run build
    //    để xác minh cú pháp JSX và bundle, tuân thủ đúng quy định trong CLAUDE.md.
    const pkgPath = path.join(cwd, 'package.json');
    const pkgContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
    const hasTestScript = /"test"\s*:/.test(pkgContent);
    const hasTestRunner = /(vitest|jest|mocha|@testing-library|ava|tape)/.test(pkgContent);

    let testCmd = '';
    if (isApi) {
        testCmd = hasJacoco
            ? 'mvnw.cmd -B test jacoco:report'
            : 'mvnw.cmd -B test';
    } else if (hasTestScript && hasTestRunner) {
        testCmd = 'npm test -- --run';
    } else {
        console.log('[TEST] Service web chưa cấu hình test runner riêng. Xác minh cú pháp và bundle qua "npm run build" (theo CLAUDE.md).');
        testCmd = 'npm run build';
    }

    console.log(`[TEST] Chạy: ${testCmd}`);
    const testRes = runCommand(cwd, testCmd);
    steps.push({ step: 'test', cmd: testCmd, ok: testRes.ok });
    if (!testRes.ok) {
        console.error('[TEST] THẤT BẠI — không merge.');
        console.error(testRes.output.slice(-4000));
        return { ok: false, step: 'test', steps, output: testRes.output };
    }

    // 2) Coverage cho các class vừa sửa (chỉ khi api có JaCoCo)
    if (isApi) {
        if (hasJacoco) {
            const cov = checkCoverageForChangedFiles(cwd, changedFiles, 90);
            steps.push({ step: 'coverage', ok: cov.ok, details: cov.details, reason: cov.reason });
            if (!cov.ok) {
                console.error('[COVERAGE] THẤT BẠI — coverage chưa đạt cho các class liên quan.');
                console.error(JSON.stringify(cov.details, null, 2));
                if (cov.reason) console.error(cov.reason);
                return { ok: false, step: 'coverage', steps, output: '' };
            }
            console.log('[COVERAGE] OK — ' + cov.details.map(d => `${d.cls}=${d.coverage}%`).join(', '));
        } else {
            console.log('[COVERAGE] Dự án chưa cấu hình JaCoCo -> Bỏ qua bước kiểm tra độ phủ.');
            steps.push({ step: 'coverage', ok: true, skipped: true, reason: 'Dự án chưa cấu hình JaCoCo' });
        }
    }
    // 3) Build — bắt lỗi biên dịch
    const buildCmd = isApi
        ? 'mvnw.cmd -B -DskipTests package'
        : (testCmd === 'npm run build' ? null : 'npm run build');

    if (buildCmd) {
        console.log(`[BUILD] Chạy: ${buildCmd}`);
        const buildRes = runCommand(cwd, buildCmd);
        steps.push({ step: 'build', cmd: buildCmd, ok: buildRes.ok });
        if (!buildRes.ok) {
            console.error('[BUILD] THẤT BẠI — không merge.');
            console.error(buildRes.output.slice(-4000));
            return { ok: false, step: 'build', steps, output: buildRes.output };
        }
    } else {
        steps.push({ step: 'build', cmd: 'npm run build (đã kiểm tra ở bước test)', ok: true });
    }

    return { ok: true, step: 'done', steps, output: '' };
}

// Dựng URL web để mở branch trên Git host hiện tại (github.com / gitlab tự host).
function buildWebUrl(gitRepo, branchName) {
    const host = normalizeGitHost(GIT_HOST);
    const scheme = host.startsWith('10.') || host.startsWith('192.168.') || host.includes(':') ? 'http' : 'https';
    const repoPath = normalizeRepoPath(gitRepo);
    if (host.toLowerCase() === 'github.com') {
        return `https://github.com/${repoPath}/tree/${branchName}`;
    }
    // GitLab: /<namespace>/<project>/-/tree/<branch>
    return `${scheme}://${host}/${repoPath}/-/tree/${branchName}`;
}

// --- KIỂM TRA PIPELINE CI/CD (nếu repo có) ---
// Trả về { status: 'ok'|'skipped'|'failed'|'running', detail }
// Trả về trạng thái pipeline mới nhất của branch:
//   { status: 'ok'|'failed'|'running'|'timeout'|'skipped', detail, url }
async function getPipelineOnce(gitRepo, branchName) {
    if (isGitHubHost()) {
        if (!GITHUB_TOKEN) {
            return { status: 'skipped', detail: 'Thiếu GITHUB_TOKEN — bỏ qua bước kiểm tra pipeline.' };
        }
        const wfRes = await fetch(`https://api.github.com/repos/${gitRepo}/actions/workflows`, { headers: githubHeaders });
        if (!wfRes.ok) {
            return { status: 'skipped', detail: `Repo không có GitHub Actions (HTTP ${wfRes.status}) — bỏ qua bước kiểm tra pipeline.` };
        }
        const wfData = await wfRes.json();
        if ((wfData.workflows || []).length === 0) {
            return { status: 'skipped', detail: 'Repo không có workflow CI nào — bỏ qua bước kiểm tra pipeline.' };
        }
        const runsRes = await fetch(
            `https://api.github.com/repos/${gitRepo}/actions/runs?branch=${encodeURIComponent(branchName)}&per_page=10`,
            { headers: githubHeaders }
        );
        if (!runsRes.ok) {
            return { status: 'skipped', detail: `Không đọc được danh sách run (HTTP ${runsRes.status}).` };
        }
        const runs = (await runsRes.json()).workflow_runs || [];
        if (runs.length === 0) {
            return { status: 'running', detail: `Chưa có workflow run nào cho branch ${branchName} — đang chờ CI khởi tạo.` };
        }
        const run = runs[0];
        if (run.status !== 'completed') {
            return { status: 'running', detail: `Pipeline #${run.id} đang ${run.status}.`, url: run.html_url };
        }
        if (run.conclusion === 'success') {
            return { status: 'ok', detail: `Pipeline #${run.id} thành công.`, url: run.html_url };
        }
        return { status: 'failed', detail: `Pipeline #${run.id} kết thúc với ${run.conclusion}.`, url: run.html_url };
    }

    // GitLab CI (self-hosted hoặc gitlab.com)
    if (!GIT_TOKEN) {
        return { status: 'skipped', detail: 'Thiếu GIT_TOKEN — bỏ qua bước kiểm tra pipeline.' };
    }
    const scheme = normalizeGitHost(GIT_HOST).startsWith('10.') || normalizeGitHost(GIT_HOST).includes(':') ? 'http' : 'https';
    const projectId = encodeURIComponent(gitRepo);
    const url = `${scheme}://${GIT_HOST}/api/v4/projects/${projectId}/pipelines?ref=${encodeURIComponent(branchName)}&per_page=5`;
    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': GIT_TOKEN } });
    if (res.status === 404) {
        return { status: 'skipped', detail: `Không tìm thấy project '${gitRepo}' trên ${GIT_HOST} — bỏ qua bước kiểm tra pipeline.` };
    }
    if (!res.ok) {
        return { status: 'skipped', detail: `Không đọc được pipeline GitLab (HTTP ${res.status}) — bỏ qua.` };
    }
    const pipelines = await res.json();
    if (!Array.isArray(pipelines) || pipelines.length === 0) {
        return { status: 'running', detail: `Chưa có pipeline nào cho branch ${branchName} trên ${GIT_HOST} — đang chờ CI khởi tạo.` };
    }
    const pl = pipelines[0];
    const plUrl = pl.web_url;
    if (pl.status === 'success') {
        return { status: 'ok', detail: `Pipeline #${pl.id} thành công.`, url: plUrl };
    }
    if (pl.status === 'failed' || pl.status === 'canceled') {
        return { status: 'failed', detail: `Pipeline #${pl.id} kết thúc với ${pl.status}.`, url: plUrl };
    }
    return { status: 'running', detail: `Pipeline #${pl.id} đang ${pl.status}.`, url: plUrl };
}

// Kiểm tra pipeline CI/CD. Nếu repo chưa có CI → status 'skipped' và KHÔNG chặn.
// Nếu có CI → poll chờ tối đa CI_POLL_MAX lần, mỗi lần CI_POLL_INTERVAL_MS.
async function checkCiPipeline(gitRepo, branchName) {
    try {
        let last = { status: 'skipped', detail: 'Không xác định được trạng thái pipeline.' };
        for (let attempt = 1; attempt <= CI_POLL_MAX; attempt++) {
            last = await getPipelineOnce(gitRepo, branchName);
            if (last.status === 'ok' || last.status === 'failed' || last.status === 'skipped') return last;
            if (attempt < CI_POLL_MAX) {
                console.log(`[CI] ${last.detail} (lần ${attempt}/${CI_POLL_MAX}) — chờ ${CI_POLL_INTERVAL_MS / 1000}s...`);
                await new Promise(r => setTimeout(r, CI_POLL_INTERVAL_MS));
            }
        }
        return {
            status: 'timeout',
            detail: `Pipeline chưa kết thúc sau ${CI_POLL_MAX} lần kiểm tra (${Math.round((CI_POLL_MAX * CI_POLL_INTERVAL_MS) / 60000)} phút). ${last.detail || ''}`,
            url: last.url
        };
    } catch (e) {
        return { status: 'skipped', detail: `Lỗi khi kiểm tra pipeline: ${e.message} — bỏ qua.` };
    }
}

const GLITCHTIP_API_URL = (process.env.GLITCHTIP_API_URL || 'http://10.30.1.207:8000').trim().replace(/\/+$/, '');
const GLITCHTIP_API_TOKEN = (process.env.GLITCHTIP_API_TOKEN || '2d80da1416547825f38cc064ea3667614e38bfd44c0862d4d560281dbafe24c6').trim();

async function fetchGlitchTipDetails(issueUrlOrText) {
    if (!issueUrlOrText || !GLITCHTIP_API_TOKEN) return null;
    const str = typeof issueUrlOrText === 'string' ? issueUrlOrText : JSON.stringify(issueUrlOrText);
    const m = str.match(/\/issues\/(\d+)/);
    if (!m) return null;
    const issueId = m[1];
    const url = `${GLITCHTIP_API_URL}/api/0/issues/${issueId}/events/latest/`;
    try {
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${GLITCHTIP_API_TOKEN}` }
        });
        if (!res.ok) return null;
        const data = await res.json();

        let stacktrace = '';
        let exceptionType = '';
        let exceptionValue = '';
        const culprit = data.culprit || '';
        const metadata = data.metadata || {};

        for (const entry of (data.entries || [])) {
            if (entry.type === 'exception') {
                for (const val of (entry.data?.values || [])) {
                    exceptionType = val.type || '';
                    exceptionValue = val.value || '';
                    stacktrace += `${exceptionType}: ${exceptionValue}\n`;
                    const frames = val.stacktrace?.frames || [];
                    for (const f of frames) {
                        const filePart = f.filename ? `${f.filename}:${f.lineNo || ''}` : '';
                        const funcPart = f.function ? `.${f.function}` : '';
                        stacktrace += `    at ${f.module || ''}${funcPart}(${filePart})\n`;
                    }
                }
            }
        }

        return {
            issueId,
            title: data.title || '',
            culprit,
            metadata,
            exceptionType: exceptionType || metadata.type || '',
            exceptionValue: exceptionValue || metadata.value || '',
            filename: metadata.filename || '',
            functionName: metadata.function || '',
            stacktrace: stacktrace.trim()
        };
    } catch (e) {
        return null;
    }
}

async function processBug(issueKey, summary, description, attachments, projectConfig, labels) {
    let currentStep = 'Khởi tạo và phân giải cấu hình service';
    const contextInfo = {
        issueKey,
        summary,
        projectName: projectConfig.name || projectConfig.projectKey,
        targetService: null,
        gitRepo: null,
        branchName: null,
        baseBranch: null,
        step: currentStep
    };

    const serviceLabel = (labels || []).find(l => l.startsWith('service:'));
    if (!serviceLabel) {
        throw new Error(`[Fail-Safe Abort] Ticket ${issueKey} không có nhãn 'service:*'. Không xác định được service mục tiêu để xử lý an toàn.`);
    }

    const projectDir = resolveProjectDir(projectConfig);
    const targetService = serviceLabel.split(':')[1];
    contextInfo.targetService = targetService;

    // Đọc services.json tại project
    const servicesJsonPath = path.join(projectDir, 'services.json');


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

    const targetServiceDir = resolveServiceDir(projectDir, serviceConfig);
    if (!fs.existsSync(targetServiceDir)) {
        throw new Error(`[Fail-Safe Abort] Thư mục service '${targetServiceDir}' không tồn tại.`);
    }

    const devBranch = serviceConfig.branches.dev;
    const prodBranch = serviceConfig.branches.prod;
    const targetBranch = serviceConfig.branches.target || serviceConfig.branches.dev || 'master';
    const stagingBranch = serviceConfig.branches.staging || targetBranch;
    const sourceTarget = serviceConfig.branches.source_target;
    const sourceStaging = serviceConfig.branches.source_staging;
    const gitRepo = serviceConfig.gitRepo;
    const pushUrl = buildRemoteUrl(gitRepo);
    contextInfo.gitRepo = gitRepo;
    contextInfo.baseBranch = targetBranch;

    // Tên branch có timestamp để mỗi lần retry tạo branch MỚI, không ghi đè lịch sử cũ trên remote.
    // Định dạng: hotfix/<KEY>-<YYYYMMDD-HHMMSS>
    const runStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const branchName = `hotfix/${issueKey}-${runStamp}`;
    contextInfo.branchName = branchName;
    // Base của branch = nhánh target — sửa code TRÊN nhánh target.
    const baseBranch = targetBranch;
    const worktreeDir = targetServiceDir;
    console.log(`\n========================================`);
    console.log(`[+] Phát hiện Bug mới: ${issueKey} - ${summary}`);
    console.log(`[+] Target Repo: ${gitRepo} | Service: ${targetService} | Dev Branch: ${devBranch}`);
    // Nhánh user đang làm việc — phải restore lại sau khi xử lý xong (khai báo ngoài try để finally luôn thấy).
    let originalBranch = '';
    try {
        currentStep = 'Kiểm tra trạng thái Git & chuẩn bị repo service';
        contextInfo.step = currentStep;
        try {
            execSync(`git worktree remove --force .worktrees/${branchName}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch(e) {}
        try { execSync(`git worktree prune`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch(err) {}

        // 2. Cấu hình danh tính Git trong repo service
        execSync(`git config user.name "${GIT_AUTHOR_NAME}"`, { cwd: targetServiceDir, stdio: 'pipe' });
        execSync(`git config user.email "${GIT_AUTHOR_EMAIL}"`, { cwd: targetServiceDir, stdio: 'pipe' });

        try {
            originalBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: targetServiceDir, encoding: 'utf8' }).trim();
        } catch (e) {}

        // 3. Kéo code mới nhất từ remote
        console.log(`[+] Kéo code mới nhất từ origin/${devBranch}...`);
        ensureRemoteOrigin(targetServiceDir, gitRepo);
        execSync(`git fetch origin`, { cwd: targetServiceDir, stdio: 'pipe' });

        // 3b. DIRTY-GUARD: repo service phải SẠCH trước khi tạo branch.
        // Nếu không: `git checkout -B` sẽ mang thay đổi chưa commit sang branch hotfix,
        // rồi ensureAICommittedItself git add + commit → push thẳng lên nhánh target.
        // Đặc biệt nguy hiểm với file .env (secret lọt lên remote).
        const dirty = listDirtyFiles(targetServiceDir);
        if (dirty.length > 0) {
            const secrets = dirty.filter(isSecretPath);
            const hint = secrets.length > 0
                ? `\n⛔ Có file SECRET (${secrets.join(', ')}) — KHÔNG được commit. Hãy thêm vào .gitignore hoặc xoá khỏi index (git rm --cached).`
                : '';
            throw new Error(
                `Repo service '${targetServiceDir}' có ${dirty.length} thay đổi chưa commit: ${dirty.join(', ')}.\n` +
                `Worker cần repo sạch để tạo branch hotfix — nếu không, thay đổi đó sẽ bị commit và push lên nhánh target.${hint}`
            );
        }

        // 4a. ĐỒNG BỘ SOURCE_TARGET VÀO TARGET (nếu có cấu hình source_target):
        // Trước khi phân tích và fix bug thì phải pull code mới ở cả target và source_target
        // rồi merge từ source_target vào target trước để cập nhật code mới nhất.
        if (sourceTarget && targetBranch) {
            currentStep = 'Đồng bộ nhánh source_target vào target trước khi fix';
            contextInfo.step = currentStep;
            execSync(`git fetch origin ${targetBranch}`, { cwd: targetServiceDir, stdio: 'pipe' });
            execSync(`git fetch origin ${sourceTarget}`, { cwd: targetServiceDir, stdio: 'pipe' });
            execSync(`git checkout ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            execSync(`git pull --ff-only origin ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            try {
                execSync(`git merge origin/${sourceTarget} -m "sync: merge origin/${sourceTarget} into ${targetBranch} before fix"`, { cwd: targetServiceDir, stdio: 'inherit' });
            } catch (syncTargetErr) {
                try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
                throw new Error(`Đồng bộ source_target thất bại (conflict khi merge origin/${sourceTarget} vào ${targetBranch}): ${syncTargetErr.message}`);
            }
            execSync(`git push ${pushUrl} ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            execSync(`git fetch origin ${targetBranch}`, { cwd: targetServiceDir, stdio: 'pipe' });
            console.log(`[+] Đã đồng bộ ${sourceTarget} vào ${targetBranch} và push lên remote.`);
        }

        // 4b. Tạo branch hotfix TRỰC TIẾP trong repo service, base = origin/<target>.
        // KHÔNG xoá branch cũ: tên branch có timestamp nên mỗi lần chạy là một branch riêng.
        currentStep = `Tạo branch hotfix ${branchName} từ origin/${baseBranch}`;
        contextInfo.step = currentStep;
        console.log(`[+] Tạo branch ${branchName} từ origin/${baseBranch}...`);
        try {
            execSync(`git branch -D ${branchName}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch(e) {}
        execSync(`git checkout -B ${branchName} origin/${baseBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });

        // 4b. Claude Code chạy với cwd = repo service (đã checkout branch hotfix).
        // Rules nạp qua --append-system-prompt, guardrail hook nạp qua --settings →
        // không ghi file nào vào repo khách.
        console.log(`[+] Context nạp qua --append-system-prompt + --settings (không ghi file vào repo).`);
        let attachmentInfo = "";
        if (attachments.length > 0) {
            attachmentInfo = "Attachments available:\n" + attachments.map(a => `- ${a.filename}: ${a.content}`).join("\n");
        }

        const isJava = fs.existsSync(path.join(targetServiceDir, 'pom.xml')) || fs.existsSync(path.join(targetServiceDir, 'build.gradle'));
        const hasPackageJson = fs.existsSync(path.join(targetServiceDir, 'package.json'));
        const isWeb = !isJava && (targetService === 'web' || targetService.startsWith('fe-') || targetService.endsWith('-web') || hasPackageJson);
        const hasJacoco = isJava && hasJacocoPlugin(targetServiceDir);
        let serviceTestCmd = hasJacoco
            ? "'mvnw.cmd -B test jacoco:report' or 'mvn -B test jacoco:report'"
            : "'mvnw.cmd -B test' or 'mvn -B test'";
        let commitPrefix = "fix(api)";
        if (isWeb) {
            const pkgPath = path.join(targetServiceDir, 'package.json');
            const pkgStr = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
            const hasWebTest = /"test"\s*:/.test(pkgStr) && /(vitest|jest|mocha)/.test(pkgStr);
            serviceTestCmd = hasWebTest ? "'npm test'" : "'npm run build'";
            commitPrefix = "fix(web)";
        }
        // Dọn dẹp evidence cũ của ticket này (nếu có)
        currentStep = 'Khởi tạo evidence ban đầu & gửi Alert 1 Telegram';
        contextInfo.step = currentStep;
        fs.rmSync(path.join(WORKER_ROOT, 'evidence', issueKey), { recursive: true, force: true });
        evidenceHelper.ensureEvidenceDir(issueKey);

        // Trích xuất chi tiết lỗi từ GlitchTip API (stacktrace, culprit, metadata) nếu có
        const glitchTipDetails = await fetchGlitchTipDetails(description);
        let rawError = typeof description === 'string' ? description : (JSON.stringify(description) || summary);
        rawError = rawError.replace(/10\.30\.1\.200:8000/g, '10.30.1.207:8000');
        let errorContent = rawError;

        if (glitchTipDetails && glitchTipDetails.stacktrace) {
            errorContent = `[GLITCHTIP EXCEPTION DETAILS]\n` +
                `Type: ${glitchTipDetails.exceptionType}\n` +
                `Value: ${glitchTipDetails.exceptionValue}\n` +
                `Culprit: ${glitchTipDetails.culprit}\n` +
                (glitchTipDetails.filename ? `Source: ${glitchTipDetails.filename}:${glitchTipDetails.functionName}\n` : '') +
                `\n[STACKTRACE]\n${glitchTipDetails.stacktrace}\n\n` +
                `[ORIGINAL JIRA DESCRIPTION]\n${rawError}`;

            // Đồng bộ bổ sung stack trace vào Jira comment nếu Jira description chưa có stack trace
            if (!String(description).includes('at ')) {
                try {
                    await addJiraComment(
                        issueKey,
                        `📋 *[GlitchTip Stack Trace Chi Tiết]*\n` +
                        `- *Lỗi:* ${glitchTipDetails.exceptionType}: ${glitchTipDetails.exceptionValue}\n` +
                        `- *Culprit:* ${glitchTipDetails.culprit}\n` +
                        (glitchTipDetails.filename ? `- *Vị trí:* ${glitchTipDetails.filename} (${glitchTipDetails.functionName})\n\n` : '\n') +
                        `*Stack Trace:*\n` +
                        `{code:java}\n` +
                        `${glitchTipDetails.stacktrace}\n` +
                        `{code}`
                    );
                } catch (e) {
                    console.warn(`[!] Không thêm được comment stacktrace vào Jira: ${e.message}`);
                }
            }
        }

        evidenceHelper.saveEvidence(issueKey, 'before', `${issueKey}_error.txt`, errorContent);

        const fixPrompt = `Fix bug: ${summary}.

ERROR DETAILS & STACKTRACE:
${errorContent}

${attachmentInfo}

STEPS (follow strictly, in order):
1. LOCATE the bug by reading the source code and the error details above. The service is '${targetService}'.
2. FIX it with minimal changes inside the 'src' directory. Do not touch unrelated files.
3. WRITE COMPLETE UNIT TESTS for every class/method/function you changed or that directly depends on the change:
   - Cover ALL relevant cases: success, edge cases, boundary values, invalid input, null/empty, exceptions.
   - For Java: JUnit 5 + Mockito, one test class per changed class, name the test class <Class>Test.java under src/test/java mirroring the main package.
   - For JavaScript/TypeScript: a test file mirroring the source file.
   - Do NOT write empty/trivial assertions (e.g. assertTrue(true)) to inflate coverage. Every assertion must verify real behaviour.
${hasJacoco ? '   - For Java the coverage of every class you changed MUST be >= 90% (the worker reads the report at target/site/jacoco/jacoco.csv and rejects the fix otherwise). Write enough test cases to reach that — do not weaken assertions to fit.\n' : ''}   - Do NOT weaken or delete existing tests.
4. SAVE the verification output into 'evidence/${issueKey}/after' (relative to your current working directory).
   - You MAY run a quick targeted test to check your own work, but DO NOT run the full
     build/test suite: the worker runs '${serviceTestCmd}' itself after you finish.
5. COMMIT your changes with 'git commit -m "${commitPrefix}: ..."' using the required conventional-commit prefix.
   - DO NOT commit anything from the 'evidence' folder.
   - Only ONE commit for the whole fix.

Do not fail. Do not ask questions. Make sure the tests you wrote are complete and correct, then commit and stop.`;


        let errorLocationHtml = '';
        let stacktracePreviewHtml = '';
        if (glitchTipDetails) {
            if (glitchTipDetails.filename) {
                errorLocationHtml = `• <b>Vị trí:</b> <code>${escapeHtml(glitchTipDetails.filename)}</code> (${escapeHtml(glitchTipDetails.functionName || '')})\n`;
            } else if (glitchTipDetails.culprit) {
                errorLocationHtml = `• <b>Endpoint/Culprit:</b> <code>${escapeHtml(glitchTipDetails.culprit)}</code>\n`;
            }
            if (glitchTipDetails.stacktrace) {
                const previewLines = glitchTipDetails.stacktrace.split('\n').slice(0, 6).join('\n');
                stacktracePreviewHtml = `\n📋 <b>Stack Trace:</b>\n<pre>${escapeHtml(previewLines)}</pre>\n`;
            }
        } else if (typeof description === 'string' && description.includes('{code}')) {
            const m = description.match(/\{code(?::\w+)?\}([\s\S]*?)\{code\}/);
            if (m && m[1].trim()) {
                const previewLines = m[1].trim().split('\n').slice(0, 6).join('\n');
                stacktracePreviewHtml = `\n📋 <b>Log lỗi:</b>\n<pre>${escapeHtml(previewLines)}</pre>\n`;
            }
        }

        // ALERT 1: Gửi thông báo phát hiện lỗi & đang xử lý kèm file log lỗi ban đầu về Telegram
        const alert1Msg = `🚨 <b>PHÁT HIỆN LỖI MỚI & BẮT ĐẦU XỬ LÝ (LEVEL 3)</b>\n\n` +
            `• <b>Ticket:</b> <code>${escapeHtml(issueKey)}</code>\n` +
            `• <b>Dự án:</b> ${escapeHtml(projectConfig.name || projectConfig.projectKey)}\n` +
            `• <b>Service:</b> <code>${escapeHtml(targetService)}</code> (<code>${escapeHtml(gitRepo)}</code>)\n` +
            `• <b>Branch:</b> <code>${escapeHtml(branchName)}</code> (base: <code>${escapeHtml(baseBranch)}</code>)\n` +
            `• <b>Tóm tắt:</b> ${escapeHtml(summary)}\n` +
            errorLocationHtml +
            stacktracePreviewHtml +
            `\n⏳ <i>Đang tiến hành tái hiện lỗi (Repro Bug) và phân tích mã nguồn...</i>`;
        const alert1Keyboard = {
            inline_keyboard: [
                [
                    { text: `🎫 Xem Jira Ticket`, url: `https://${JIRA_DOMAIN}/browse/${issueKey}` }
                ]
            ]
        };

        try {
            await evidenceHelper.sendEvidenceToTelegram(issueKey, 'before', alert1Msg, alert1Keyboard);
        } catch (e) {
            console.error(`[!] Lỗi gửi Alert 1 Telegram: ${e.message}`);
        }

        // 6. Bước 1: Repro Bug
        currentStep = 'Bước 1: Tái hiện lỗi (Repro Bug)';
        contextInfo.step = currentStep;
        const timeoutMinutes = Math.round(CLAUDE_TIMEOUT / 60000);
        console.log(`[+] Bước 1: Repro Bug (Model: ${CLAUDE_MODEL}, Timeout: ${timeoutMinutes} phút / ${CLAUDE_TIMEOUT}ms)...`);
        const reproPrompt = getReproPrompt().replace(/\{JIRA_KEY\}/g, issueKey);
        const reproFullPrompt = `Bug: ${summary}\n\nERROR DETAILS & STACKTRACE:\n${errorContent}\n\n${reproPrompt}`;
        const reproOutput = await runClaude(reproFullPrompt, worktreeDir, CLAUDE_TIMEOUT, true);
        console.log(reproOutput);
        if (reproOutput.includes('[AI_STOP]')) {
            const reason = extractReproStopReason(reproOutput);
            throw new Error(reason.startsWith('Không thể tái hiện lỗi') ? reason : `Không thể tái hiện lỗi: ${reason}`);
        }

        // Thu thập evidence do Claude tạo trong worktree (cwd của Claude = worktree).
        const collected = evidenceHelper.collectFromWorktree(worktreeDir, issueKey, 'before');
        if (collected.copied > 0) {
            console.log(`[+] Đã thu thập ${collected.copied} file evidence từ worktree: ${collected.files.join(', ')}`);
        }

        // Kiểm tra bằng chứng repro có thật: phải có file do AI tạo
        const beforeFiles = evidenceHelper.listEvidenceFiles(issueKey, 'before');
        const aiEvidence = beforeFiles.filter(f => f !== `${issueKey}_error.txt`);
        if (aiEvidence.length === 0) {
            const reason = extractReproStopReason(reproOutput);
            if (reason && reason !== 'AI không thể tái hiện lỗi trong mã nguồn hoặc môi trường hiện tại.') {
                throw new Error(reason.startsWith('Không thể tái hiện lỗi') ? reason : `Không thể tái hiện lỗi: ${reason}`);
            }
            throw new Error(`Không thể tái hiện lỗi: AI không tạo bằng chứng trong 'evidence/${issueKey}/before/' của worktree (đã thu thập ${collected.copied} file).`);
        }

        // Thông báo tái hiện lỗi thành công
        const reproSuccessMsg = `🔍 <b>ĐÃ TÁI HIỆN LỖI THÀNH CÔNG (REPRO PASSED)</b>\n\n` +
            `• <b>Ticket:</b> <code>${escapeHtml(issueKey)}</code>\n` +
            `• <b>Bằng chứng AI:</b> Đã thu thập ${aiEvidence.length} file vào <code>evidence/${issueKey}/before/</code>\n\n` +
            `🛠️ <i>Đang kích hoạt Claude Code tiến hành sửa lỗi & viết Unit Test...</i>`;
        try {
            await evidenceHelper.sendEvidenceToTelegram(issueKey, 'before', reproSuccessMsg);
        } catch (e) {
            console.error(`[!] Lỗi gửi Repro update Telegram: ${e.message}`);
        }

        // 7. Bước 2: Fix Bug
        currentStep = 'Bước 2: Sửa mã nguồn (Fix Bug)';
        contextInfo.step = currentStep;
        // 7. Bước 2: Fix Bug
        console.log(`[+] Bước 2: Fix Bug (Model: ${CLAUDE_MODEL}, Timeout: ${timeoutMinutes} phút / ${CLAUDE_TIMEOUT}ms)...`);
        await runClaude(fixPrompt, worktreeDir, CLAUDE_TIMEOUT, false);

        // 8. Đảm bảo AI đã tự commit
        currentStep = 'Bước 3: Xác minh AI commit mã nguồn';
        contextInfo.step = currentStep;
        await ensureAICommittedItself(branchName, `ticket ${issueKey}`, worktreeDir, baseBranch, commitPrefix);

        // 8b. Thu thập evidence "after" (kết quả test sau khi fix) từ worktree.
        currentStep = 'Bước 4: Thu thập bằng chứng sau sửa (Evidence After)';
        contextInfo.step = currentStep;

        // 8b. Thu thập evidence "after" (kết quả test sau khi fix) từ worktree.
        // Trước đây phase after không bao giờ được điền — chỉ có 'before'.
        const collectedAfter = evidenceHelper.collectFromWorktree(worktreeDir, issueKey, 'after');
        if (collectedAfter.copied > 0) {
            console.log(`[+] Đã thu thập ${collectedAfter.copied} file evidence 'after' từ worktree.`);
        }

        // 9. Worker TỰ chạy unit test + coverage + build.
        currentStep = 'Bước 5: Xác minh Unit Test & Coverage (≥90%) & Build';
        contextInfo.step = currentStep;
        // Lọc bỏ artifact build (target/, dist/, node_modules/) — một số repo vô tình track
        // chúng, nếu không lọc thì danh sách file rác làm loãng kiểm tra coverage.
        const changedFiles = execSync(`git diff --name-only origin/${baseBranch}..HEAD`, { cwd: targetServiceDir, encoding: 'utf8' })
            .trim().split('\n').filter(Boolean).filter(f => !isArtifactPath(f));
        console.log(`[+] File đã thay đổi (${changedFiles.length}): ${changedFiles.join(', ') || '(không có)'}`);

        const verify = verifyService(targetServiceDir, targetService, changedFiles);
        if (!verify.ok) {
            throw new Error(`Xác minh thất bại ở bước '${verify.step}'. Chi tiết: ${JSON.stringify(verify.steps)}`);
        }
        console.log('[+] Xác minh PASS: unit test + coverage + build.');

        // 10a. Push branch hotfix lên remote TRƯỚC khi merge.
        // Cần cho: link Telegram không 404, và có dấu vết fix trên remote.
        console.log(`[+] Đang push nhánh ${branchName} lên ${gitRepo}...`);
        execSync(`git push -u ${pushUrl} ${branchName}`, { cwd: targetServiceDir, stdio: 'inherit' });

        // 10b. Merge branch hotfix vào nhánh target rồi push.
        currentStep = `Bước 6: Merge ${branchName} vào target (${targetBranch})`;
        contextInfo.step = currentStep;
        console.log(`[+] Merge ${branchName} vào target (${targetBranch})...`);
        execSync(`git checkout ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        execSync(`git pull --ff-only origin ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        try {
            execSync(`git merge --no-ff -m "${commitPrefix}: merge ${branchName} into ${targetBranch} [AUTO-BUG]" ${branchName}`, { cwd: targetServiceDir, stdio: 'inherit' });
        } catch (mergeErr) {
            // Conflict → abort để repo KHÔNG kẹt ở trạng thái MERGING.
            try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
            throw new Error(`Merge ${branchName} vào ${targetBranch} thất bại (conflict): ${mergeErr.message}`);
        }
        try {
            execSync(`git push ${pushUrl} ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        } catch (pushErr) {
            // Không được báo 'THÀNH CÔNG' khi push thất bại (vd non-fast-forward).
            throw new Error(`Đã merge vào ${targetBranch} nhưng PUSH thất bại: ${pushErr.message}`);
        }
        console.log(`[+] Đã merge và push lên ${targetBranch}.`);

        // 10c. ĐỒNG BỘ SOURCE_STAGING VÀ MERGE TARGET VÀO STAGING (nếu có staging khác target hoặc source_staging):
        // Tương tự, trước khi merge từ target vào staging thì phải pull code mới của staging và source_staging
        // và merge từ source_staging vào staging trước để cập nhật code mới nhất.
        let deployedBranch = targetBranch;
        if (stagingBranch && stagingBranch !== targetBranch) {
            if (sourceStaging) {
                console.log(`[+] Đồng bộ source_staging: fetch ${stagingBranch} & ${sourceStaging}, merge ${sourceStaging} -> ${stagingBranch}...`);
                execSync(`git fetch origin ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'pipe' });
                execSync(`git fetch origin ${sourceStaging}`, { cwd: targetServiceDir, stdio: 'pipe' });
                execSync(`git checkout ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
                execSync(`git pull --ff-only origin ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
                try {
                    execSync(`git merge origin/${sourceStaging} -m "sync: merge origin/${sourceStaging} into ${stagingBranch} before deploy"`, { cwd: targetServiceDir, stdio: 'inherit' });
                } catch (syncStagingErr) {
                    try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
                    throw new Error(`Đồng bộ source_staging thất bại (conflict khi merge origin/${sourceStaging} vào ${stagingBranch}): ${syncStagingErr.message}`);
                }
                execSync(`git push ${pushUrl} ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
                console.log(`[+] Đã đồng bộ ${sourceStaging} vào ${stagingBranch} và push lên remote.`);
            }

            // Merge từ targetBranch vào stagingBranch:
            console.log(`[+] Merge ${targetBranch} vào staging (${stagingBranch})...`);
            execSync(`git checkout ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            execSync(`git pull --ff-only origin ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            try {
                execSync(`git merge --no-ff -m "${commitPrefix}: merge ${targetBranch} into ${stagingBranch} [AUTO-BUG]" ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            } catch (mergeStagingErr) {
                try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
                throw new Error(`Merge ${targetBranch} vào ${stagingBranch} thất bại (conflict): ${mergeStagingErr.message}`);
            }
            try {
                execSync(`git push ${pushUrl} ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            } catch (pushStagingErr) {
                throw new Error(`Đã merge vào ${stagingBranch} nhưng PUSH thất bại: ${pushStagingErr.message}`);
            }
            console.log(`[+] Đã merge từ ${targetBranch} vào ${stagingBranch} và push lên remote.`);
            deployedBranch = stagingBranch;
        }

        // 11. Kiểm tra pipeline CI/CD để xác nhận deploy staging.
        currentStep = 'Bước 7: Kiểm tra Pipeline CI/CD';
        contextInfo.step = currentStep;
        const ci = await checkCiPipeline(gitRepo, deployedBranch);
        if (ci.status === 'failed') {
            console.warn('[!] Pipeline thất bại — vẫn báo Telegram để người duyệt xử lý.');
        }

        // 12. Báo cáo Telegram. KHÔNG tạo PR lên prod (tạm thời bỏ qua).
        const ciDetailSafe = escapeHtml(ci.detail);
        const ciLine = ci.status === 'skipped'
            ? `⏭️ <b>Pipeline:</b> Bỏ qua (repo chưa có file CI/CD)`
            : ci.status === 'ok'
                ? `✅ <b>Pipeline:</b> PASS (${ciDetailSafe})`
                : ci.status === 'running'
                    ? `⏳ <b>Pipeline:</b> Đang chạy (${ciDetailSafe})`
                    : ci.status === 'timeout'
                        ? `⏱️ <b>Pipeline:</b> ${ciDetailSafe}`
                        : `❌ <b>Pipeline:</b> ${ciDetailSafe}`;

        const title = ci.status === 'ok'
            ? `🚀 <b>ĐÃ FIX & DEPLOY LÊN ${escapeHtml(deployedBranch)} THÀNH CÔNG!</b>`
            : ci.status === 'skipped'
                ? `✅ <b>ĐÃ FIX & MERGE LÊN ${escapeHtml(deployedBranch)} (không có CI/CD để xác nhận deploy)</b>`
                : ci.status === 'running' || ci.status === 'timeout'
                    ? `🟡 <b>ĐÃ FIX & MERGE LÊN ${escapeHtml(deployedBranch)} — CI chưa xác nhận deploy xong</b>`
                    : `⚠️ <b>ĐÃ FIX & MERGE LÊN ${escapeHtml(deployedBranch)} — NHƯNG PIPELINE THẤT BẠI</b>`;

        const successMsg = `${title}\n\n` +
            `• <b>Ticket:</b> <code>${escapeHtml(issueKey)}</code>\n` +
            `• <b>Dự án:</b> ${escapeHtml(projectConfig.name || projectConfig.projectKey)}\n` +
            `• <b>Service:</b> <code>${escapeHtml(targetService)}</code> (${escapeHtml(gitRepo)})\n` +
            `• <b>Summary:</b> ${escapeHtml(summary)}\n` +
            `• <b>Branch đã sửa:</b> <code>${escapeHtml(branchName)}</code> (base: <code>${escapeHtml(baseBranch)}</code>)\n` +
            `• <b>Xác minh:</b> unit test + coverage + build đều PASS\n` +
            `• <b>Đã merge:</b> <code>${escapeHtml(deployedBranch)}</code>\n` +
            `${ciLine}\n\n` +
            `<i>Chưa tạo PR lên production (tạm thời bỏ qua theo yêu cầu).</i>`;

        const successKeyboard = {
            inline_keyboard: [
                [
                    { text: `🔗 Xem branch ${branchName}`, url: buildWebUrl(gitRepo, branchName) },
                    { text: `🎫 Xem Jira Ticket`, url: `https://${JIRA_DOMAIN}/browse/${issueKey}` }
                ]
            ]
        };

        // ALERT 2: Gửi thông báo hoàn thành kèm toàn bộ bằng chứng sau sửa đổi (hình ảnh, test log từ after/)
        try {
            await evidenceHelper.sendEvidenceToTelegram(issueKey, 'after', successMsg, successKeyboard);
        } catch (e) {
            console.error(`[!] Lỗi gửi Alert 2 Telegram: ${e.message}`);
            await sendTelegramMessage(successMsg, successKeyboard);
        }

        // 13. Cập nhật Jira
        await addJiraComment(
            issueKey,
            `✅ *[Auto-Fix Bot] Đã sửa lỗi và deploy lên ${deployedBranch} thành công!*\n\n` +
            `- *Repository:* ${gitRepo}\n` +
            `- *Branch:* ${branchName} -> đã merge vào ${baseBranch}\n` +
            `- *Xác minh:* unit test + coverage + build đều PASS\n` +
            `- *Pipeline:* ${ci.status} — ${ci.detail}\n` +
            `- Chưa tạo PR lên production (tạm thời bỏ qua).`
        );
    } catch (err) {
        err.step = currentStep;
        err.contextInfo = contextInfo;
        throw err;
    } finally {
        // Dọn evidence/ do AI tạo trong repo service (đã copy sang WORKER_ROOT).
        // Nếu để lại → untracked → dirty-guard chặn mọi job sau.
        try {
            fs.rmSync(path.join(targetServiceDir, 'evidence', issueKey), { recursive: true, force: true });
        } catch (e) { console.warn(`[!] Không dọn được evidence/: ${e.message}`); }
        // Restore ĐÚNG branch user đang làm việc (không phải baseBranch).
        try {
            const restore = originalBranch && originalBranch !== 'HEAD' ? originalBranch : baseBranch;
            execSync(`git checkout ${restore}`, { cwd: targetServiceDir, stdio: 'pipe' });
        } catch (e) { console.warn(`[!] Không checkout lại branch gốc: ${e.message}`); }
    }
}

// --- KHỞI ĐỘNG HỆ THỐNG (SINGLETON MASTER) ---
// Xác thực Jira TRƯỚC khi vào vòng lặp: token sai → /search/jql vẫn trả 200 + issues rỗng
// → worker sẽ log "Tìm thấy 0 bug" mỗi 15s một cách âm thầm.
(async function bootstrap() {
    await validateJiraAuth();
    console.log("🚀 Singleton Master Worker Level 3 đã sẵn sàng...");
    console.log(`• MAX_CONCURRENT_JOBS: ${MAX_CONCURRENT_JOBS}`);
    pollTelegramUpdates();

    while (true) {
        if (!isScanning) {
            isScanning = true;
            try { await checkJiraForBugs(); } finally { isScanning = false; }
        }
        await new Promise(r => setTimeout(r, 15000));
    }
})();
