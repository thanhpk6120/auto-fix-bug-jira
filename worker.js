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
const WORKER_AGENTS_JSON_FILE = path.join(__dirname, '.claude', 'agents.json');
const AGENTS_STATUS_FILE = path.join(__dirname, 'evidences', 'agents_status.json');

// Bộ nhớ trạng thái Realtime phục vụ giao diện Autonomous Multi-Agent Office trên Dashboard
const HISTORY_FILE = path.join(__dirname, 'evidences', 'history.json');
const agentState = {
    updatedAt: new Date().toISOString(),
    activeJobsCount: 0,
    activeSessions: {}, // workspaceId -> session data
    // Backward-compatibility fields cho client UI cũ:
    activeTicket: null,
    summary: null,
    service: null,
    agents: {
        leader: { name: 'Leader Agent', role: 'Master Orchestrator', status: 'IDLE', currentAction: 'Waiting for incoming bug tickets...', icon: '👑', updatedAt: new Date().toISOString() },
        analyzer: { name: 'Analyzer Agent', role: 'Bug Analysis & Repro Specialist', status: 'IDLE', currentAction: 'Ready to analyze Jira defects', icon: '🔍', updatedAt: new Date().toISOString() },
        coder: { name: 'Coder Agent', role: 'Surgical Fix & Code Architect', status: 'IDLE', currentAction: 'Ready to apply code fixes', icon: '💻', updatedAt: new Date().toISOString() },
        tester: { name: 'QA Tester Agent', role: 'QA & JaCoCo Coverage Specialist', status: 'IDLE', currentAction: 'Ready to write & run unit tests', icon: '🧪', updatedAt: new Date().toISOString() },
        devops: { name: 'DevOps Agent', role: 'Commit, Merge & CI/CD Pipeline', status: 'IDLE', currentAction: 'Ready to track build & deploy pipelines', icon: '🚀', updatedAt: new Date().toISOString() }
    },
    communications: []
};

function recordAgentCommunication(firstArg, from, to, message, phase = '') {
    try {
        let wsId = 'default';
        let actualFrom = from;
        let actualTo = to;
        let actualMsg = message;
        let actualPhase = phase;

        // Nếu gọi 4 tham số (tương thích ngược cũ: recordAgentCommunication(from, to, message, phase))
        if (['leader', 'analyzer', 'coder', 'tester', 'devops', 'system'].includes(firstArg)) {
            actualFrom = firstArg;
            actualTo = from;
            actualMsg = to;
            actualPhase = message || '';
            wsId = agentState.activeTicket || 'default';
        } else {
            wsId = firstArg || 'default';
        }

        const item = {
            id: Date.now() + Math.random().toString(36).substr(2, 4),
            timestamp: new Date().toLocaleTimeString(),
            from: actualFrom,
            to: actualTo,
            message: actualMsg,
            phase: actualPhase
        };

        // Ghi vào session cụ thể
        if (agentState.activeSessions && agentState.activeSessions[wsId]) {
            if (!agentState.activeSessions[wsId].communications) agentState.activeSessions[wsId].communications = [];
            agentState.activeSessions[wsId].communications.unshift(item);
            if (agentState.activeSessions[wsId].communications.length > 50) {
                agentState.activeSessions[wsId].communications = agentState.activeSessions[wsId].communications.slice(0, 50);
            }
        }

        // Ghi vào mảng chung toàn cục
        if (!agentState.communications) agentState.communications = [];
        agentState.communications.unshift(item);
        if (agentState.communications.length > 50) {
            agentState.communications = agentState.communications.slice(0, 50);
        }
        fs.writeFileSync(AGENTS_STATUS_FILE, JSON.stringify(agentState, null, 2), 'utf8');
    } catch (e) {}
}

function recordBugHistory(record) {
    try {
        let list = [];
        if (fs.existsSync(HISTORY_FILE)) {
            try { list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { list = []; }
        }
        // Mỗi ticket chỉ giữ MỘT bản ghi duy nhất (trạng thái cuối cùng: RESOLVED hoặc FAILED)
        const existingIdx = list.findIndex(item => item.issueKey === record.issueKey);
        if (existingIdx >= 0) {
            list[existingIdx] = { ...list[existingIdx], ...record };
        } else {
            list.unshift(record);
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[!] Không thể ghi lịch sử bug: ${e.message}`);
    }
}

function updateAgentStatus(firstArg, agentId, status, details = {}) {
    try {
        const now = new Date().toISOString();
        agentState.updatedAt = now;
        agentState.activeJobsCount = activeJobs;

        // Tương thích ngược: updateAgentStatus(agentId, status, details)
        // LƯU Ý: Dạng gọi này KHÔNG được tạo session mới (tránh sinh "session ma" theo ticketKey).
        const isBackwardCompat = ['leader', 'analyzer', 'coder', 'tester', 'devops'].includes(firstArg);
        let wsId = null;
        let actualAgentId = agentId;
        let actualStatus = status;
        let actualDetails = details;

        if (isBackwardCompat) {
            actualAgentId = firstArg;
            actualStatus = agentId;
            actualDetails = status || {};
            // Chỉ gắn session khi caller truyền tường minh workspaceKey/wsId
            wsId = actualDetails.workspaceKey || actualDetails.wsId || null;
        } else {
            wsId = firstArg || 'default';
        }

        // Cập nhật session (chỉ khi có wsId thực)
        if (wsId) {
            if (!agentState.activeSessions) agentState.activeSessions = {};
            if (!agentState.activeSessions[wsId]) {
                agentState.activeSessions[wsId] = {
                    workspaceKey: wsId,
                    ticketKey: actualDetails.ticketKey || null,
                    summary: actualDetails.summary || null,
                    service: actualDetails.service || null,
                    projectName: actualDetails.projectName || wsId,
                    agents: {
                        leader: { name: 'Leader Agent', role: 'Master Orchestrator', status: 'IDLE', currentAction: 'Chờ ticket...', icon: '👑', updatedAt: now },
                        analyzer: { name: 'Analyzer Agent', role: 'Bug Analysis & Repro Specialist', status: 'IDLE', currentAction: 'Sẵn sàng', icon: '🔍', updatedAt: now },
                        coder: { name: 'Coder Agent', role: 'Surgical Fix & Code Architect', status: 'IDLE', currentAction: 'Sẵn sàng', icon: '💻', updatedAt: now },
                        tester: { name: 'QA Tester Agent', role: 'QA & JaCoCo Coverage Specialist', status: 'IDLE', currentAction: 'Sẵn sàng', icon: '🧪', updatedAt: now },
                        devops: { name: 'DevOps Agent', role: 'Commit, Merge & CI/CD Pipeline', status: 'IDLE', currentAction: 'Sẵn sàng', icon: '🚀', updatedAt: now }
                    },
                    communications: []
                };
            }

            const session = agentState.activeSessions[wsId];
            if (actualDetails.ticketKey !== undefined) session.ticketKey = actualDetails.ticketKey;
            if (actualDetails.summary !== undefined) session.summary = actualDetails.summary;
            if (actualDetails.service !== undefined) session.service = actualDetails.service;
            if (actualDetails.projectName !== undefined) session.projectName = actualDetails.projectName;

            if (actualAgentId && session.agents && session.agents[actualAgentId]) {
                session.agents[actualAgentId].status = actualStatus;
                if (actualDetails.action) session.agents[actualAgentId].currentAction = actualDetails.action;
                session.agents[actualAgentId].updatedAt = now;
            }
        }

        // Đồng bộ sang trường cấp gốc (tương thích backward)
        if (actualDetails.ticketKey !== undefined) agentState.activeTicket = actualDetails.ticketKey;
        if (actualDetails.summary !== undefined) agentState.summary = actualDetails.summary;
        if (actualDetails.service !== undefined) agentState.service = actualDetails.service;
        if (actualAgentId && agentState.agents[actualAgentId]) {
            agentState.agents[actualAgentId].status = actualStatus;
            if (actualDetails.action) agentState.agents[actualAgentId].currentAction = actualDetails.action;
            agentState.agents[actualAgentId].updatedAt = now;
        }

        fs.writeFileSync(AGENTS_STATUS_FILE, JSON.stringify(agentState, null, 2), 'utf8');
    } catch (e) {}
}

function resetWorkspaceSessionIdle(wsId) {
    try {
        if (agentState.activeSessions && agentState.activeSessions[wsId]) {
            delete agentState.activeSessions[wsId];
        }
        if (Object.keys(agentState.activeSessions || {}).length === 0) {
            resetAllAgentsIdle();
        }
        fs.writeFileSync(AGENTS_STATUS_FILE, JSON.stringify(agentState, null, 2), 'utf8');
    } catch (e) {}
}

function resetAllAgentsIdle() {
    try {
        // Xoá sạch mọi session và con trỏ ticket hiện hành (không tạo session mới)
        agentState.activeSessions = {};
        agentState.activeTicket = null;
        agentState.summary = null;
        agentState.service = null;
        agentState.activeJobsCount = activeJobs;
        const now = new Date().toISOString();
        agentState.updatedAt = now;
        if (agentState.agents) {
            for (const key of Object.keys(agentState.agents)) {
                agentState.agents[key].status = 'IDLE';
                agentState.agents[key].currentAction = 'Standing by';
                agentState.agents[key].updatedAt = now;
            }
        }
        fs.writeFileSync(AGENTS_STATUS_FILE, JSON.stringify(agentState, null, 2), 'utf8');
    } catch (e) {}
}

function ensureWorkerAgentsConfig() {
    try {
        const agentsDir = path.join(__dirname, '.claude', 'agents');
        if (!fs.existsSync(agentsDir)) return null;
        const agentsMap = {};
        const files = fs.readdirSync(agentsDir);
        for (const f of files) {
            if (f.endsWith('.md')) {
                const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
                const nameM = content.match(/^name:\s*(.+)$/m);
                const descM = content.match(/^description:\s*"?([^"\r\n]+)"?$/m);
                if (nameM) {
                    const name = nameM[1].trim();
                    const desc = descM ? descM[1].trim() : '';
                    const parts = content.split('---');
                    const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : content;
                    agentsMap[name] = { description: desc, prompt: body };
                }
            }
        }
        if (Object.keys(agentsMap).length > 0) {
            fs.writeFileSync(WORKER_AGENTS_JSON_FILE, JSON.stringify(agentsMap, null, 2) + '\n', 'utf8');
            return WORKER_AGENTS_JSON_FILE;
        }
    } catch (e) {
        console.warn(`[!] Không đồng bộ được agents.json: ${e.message}`);
    }
    return null;
}
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

function detectJavaVersion(cwd) {
    if (!cwd) return 17;
    const pomPath = path.join(cwd, 'pom.xml');
    if (fs.existsSync(pomPath)) {
        try {
            const pom = fs.readFileSync(pomPath, 'utf8');
            const m = pom.match(/<(?:java\.version|release|maven\.compiler\.target|maven\.compiler\.release)>(\d+)<\//i);
            if (m) return parseInt(m[1], 10);
            if (pom.includes('1.8')) return 8;
        } catch (e) {}
    }
    const gradlePath = path.join(cwd, 'build.gradle');
    if (fs.existsSync(gradlePath)) {
        try {
            const gradle = fs.readFileSync(gradlePath, 'utf8');
            const m = gradle.match(/(?:sourceCompatibility|targetCompatibility)\s*=\s*['"]?(\d+)['"]?/i);
            if (m) return parseInt(m[1], 10);
        } catch (e) {}
    }
    return 17;
}

function resolveProjectJdk(cwd) {
    const javaVer = detectJavaVersion(cwd);
    const candidateDirs = [
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        path.join(os.homedir(), '.jdks')
    ];

    const targetName = javaVer === 8 ? 'jdk-1.8' : `jdk-${javaVer}`;
    for (const base of candidateDirs) {
        if (!fs.existsSync(base)) continue;
        const exact = path.join(base, targetName);
        if (fs.existsSync(path.join(exact, 'bin', 'javac.exe')) || fs.existsSync(path.join(exact, 'bin', 'javac'))) {
            return exact;
        }
    }

    const verStr = javaVer.toString();
    for (const base of candidateDirs) {
        if (!fs.existsSync(base)) continue;
        try {
            for (const sub of fs.readdirSync(base)) {
                if (sub.includes(verStr)) {
                    const full = path.join(base, sub);
                    if (fs.existsSync(path.join(full, 'bin', 'javac.exe')) || fs.existsSync(path.join(full, 'bin', 'javac'))) {
                        return full;
                    }
                }
            }
        } catch (e) {}
    }

    for (const base of candidateDirs) {
        if (!fs.existsSync(base)) continue;
        const p21 = path.join(base, 'jdk-21');
        if (fs.existsSync(path.join(p21, 'bin', 'javac.exe'))) {
            return p21;
        }
    }

    return process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-21';
}

function getExecutionEnv(cwd) {
    const isJava = cwd && (fs.existsSync(path.join(cwd, 'pom.xml')) || fs.existsSync(path.join(cwd, 'build.gradle')));
    const env = { ...process.env };
    if (isJava) {
        const jdkPath = resolveProjectJdk(cwd);
        if (jdkPath && fs.existsSync(jdkPath)) {
            env.JAVA_HOME = jdkPath;
            const binPath = path.join(jdkPath, 'bin');
            // Chuẩn hóa biến PATH trên Windows: gộp mọi biến path/Path/PATH, tránh việc
            // tạo cả 2 key 'Path' và 'PATH' trong plain object khiến Windows cmd mất System32
            let currentPath = '';
            for (const key of Object.keys(env)) {
                if (key.toLowerCase() === 'path') {
                    if (env[key]) {
                        currentPath = currentPath ? `${currentPath}${path.delimiter}${env[key]}` : env[key];
                    }
                    delete env[key];
                }
            }
            const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
            let newPath = `${binPath}${path.delimiter}${currentPath}`;
            if (!newPath.toLowerCase().includes('system32')) {
                newPath = `${newPath}${path.delimiter}${system32}`;
            }
            env.PATH = newPath;
            env.Path = newPath;
        }
    }
    return env;
}

let cachedClaudePath = null;
function getClaudeExecutable() {
    if (cachedClaudePath && fs.existsSync(cachedClaudePath)) return cachedClaudePath;
    try {
        const out = execSync('where.exe claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        const firstLine = out.split(/\r?\n/)[0].trim();
        if (firstLine && fs.existsSync(firstLine)) {
            cachedClaudePath = firstLine;
            return cachedClaudePath;
        }
    } catch (e) {}
    return 'claude';
}

function runClaude(prompt, cwd, timeout = CLAUDE_TIMEOUT, captureOutput = false, agentName = null) {
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
                const normalizedPath = path.resolve(promptFilePath);
                effectivePrompt = [
                    'Hãy đọc kỹ và thực thi toàn bộ yêu cầu, chỉ dẫn được chỉ định trong tệp sau:',
                    `Đường dẫn tuyệt đối: ${normalizedPath}`,
                    '',
                    'BẮT BUỘC: Bạn phải mở và đọc toàn bộ nội dung tệp trên trước khi thực hiện bất kỳ hành động nào, sau đó tuân thủ 100% các quy tắc và chỉ dẫn trong tệp đó để hoàn thành nhiệm vụ.'
                ].join('\n');
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
        if (agentName) {
            if (!fs.existsSync(WORKER_AGENTS_JSON_FILE)) ensureWorkerAgentsConfig();
            if (fs.existsSync(WORKER_AGENTS_JSON_FILE)) {
                args.push('--agents', WORKER_AGENTS_JSON_FILE, '--agent', agentName);
            }
        }

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

        const effectiveClaudeCmd = getClaudeExecutable();
        const isBatch = effectiveClaudeCmd.endsWith('.cmd') || effectiveClaudeCmd.endsWith('.bat');

        const options = {
            cwd,
            shell: isBatch,
            windowsHide: true,
            env: {
                ...process.env,
                ...getExecutionEnv(cwd),
                MCP_TIMEOUT: '60000',
                MCP_HANDSHAKE_TIMEOUT: '60000',
                MCP_HANDSHAKE_TIMEOUT_MS: '60000',
                // Tối ưu từ ai-worker: Tắt tool search tự động thừa thãi để tiết kiệm token và tăng tốc phản hồi
                ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || 'false'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        };

        const child = spawn(effectiveClaudeCmd, args, options);

        // Đóng stdin ngay lập tức (EOF) để Claude Code non-interactive không bao giờ treo đợi TTY
        try { child.stdin.end(); } catch (e) {}

        let lineBuffer = '';
        let accumulatedAssistantText = '';
        let accumulatedFinalResult = '';
        let accumulatedStderr = '';
        let isTimedOut = false;
        let lastThoughtNorm = '';
        let thoughtRepeatCount = 0;
        let stallWarned = false;
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
                                const norm = thoughtFirstLine.trim();
                                if (norm && norm === lastThoughtNorm) {
                                    thoughtRepeatCount += 1;
                                    if (thoughtRepeatCount >= 3 && !stallWarned) {
                                        stallWarned = true;
                                        process.stdout.write(`\n\x1b[33m[STALL]\x1b[0m Phát hiện suy luận/thought lặp 3 lần liên tiếp — agent có thể đang kẹt.\n`);
                                    }
                                } else if (norm) {
                                    lastThoughtNorm = norm;
                                    thoughtRepeatCount = 1;
                                }
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

const WORKSPACES_CONFIG_FILE = path.join(WORKER_ROOT, 'workspaces.json');
const PROJECTS_CONFIG_FILE = path.join(WORKER_ROOT, 'projects.json');

function loadWorkspacesConfig() {
    if (fs.existsSync(WORKSPACES_CONFIG_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(WORKSPACES_CONFIG_FILE, 'utf8'));
            if (raw.workspaces && Array.isArray(raw.workspaces)) {
                return raw;
            }
        } catch (e) {
            console.warn(`[!] Lỗi đọc workspaces.json: ${e.message}`);
        }
    }
    // Fallback sang projects.json cũ
    if (fs.existsSync(PROJECTS_CONFIG_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(PROJECTS_CONFIG_FILE, 'utf8'));
            const projects = raw.projects || [];
            return {
                maxConcurrentJobs: 3,
                workspaces: projects.map(p => ({
                    id: (p.projectKey || 'default').toLowerCase(),
                    name: p.name || p.projectKey,
                    workspaceRoot: p.path || 'services',
                    concurrencyLimit: 1,
                    jira: { projectKeys: [p.projectKey] },
                    services: []
                }))
            };
        } catch (e) {}
    }
    return { maxConcurrentJobs: 3, workspaces: [] };
}

let workspacesData = loadWorkspacesConfig();
let projectsConfig = workspacesData.workspaces || [];

// Chuẩn hoá đường dẫn thư mục workspace / project.
function resolveProjectDir(workspace) {
    const p = workspace || {};
    const targetPath = p.workspaceRoot || p.path;
    if (targetPath && path.isAbsolute(targetPath)) return targetPath;
    const root = p.root
        ? (path.isAbsolute(p.root) ? p.root : path.resolve(WORKER_ROOT, p.root))
        : WORKER_ROOT;
    return path.resolve(root, targetPath || '.');
}

// Chuẩn hoá đường dẫn thư mục service.
function resolveServiceDir(projectDir, serviceConfig) {
    const sp = (serviceConfig && (serviceConfig.folder || serviceConfig.path)) || '';
    if (sp && path.isAbsolute(sp)) return sp;
    return path.resolve(projectDir, sp || '.');
}

// Bộ phân giải service thông minh 4 tầng ưu tiên
function resolveServiceForIssue(issue, workspaceConfig) {
    const fields = issue.fields || {};
    const labels = fields.labels || [];
    const summary = fields.summary || '';
    const descriptionText = typeof fields.description === 'string'
        ? fields.description
        : extractTextFromAdf(fields.description);
    const components = (fields.components || []).map(c => (c.name || '').toLowerCase());

    // Thu thập danh sách services từ cấu hình workspace
    let servicesList = Array.isArray(workspaceConfig.services) ? [...workspaceConfig.services] : [];

    // Fallback đọc thêm từ services.json cục bộ nếu có
    const wsDir = resolveProjectDir(workspaceConfig);
    const servicesFile = path.join(wsDir, 'services.json');
    if (fs.existsSync(servicesFile)) {
        try {
            const rawLocal = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
            const listLocal = Array.isArray(rawLocal.services) ? rawLocal.services : Object.values(rawLocal);
            for (const item of listLocal) {
                if (!servicesList.some(s => s.name === item.name)) {
                    servicesList.push(item);
                }
            }
        } catch (e) {}
    }

    if (servicesList.length === 0) {
        throw new Error(`[Fail-Safe] Không tìm thấy service nào được cấu hình cho workspace '${workspaceConfig.name}'.`);
    }

    // TẦNG 1: Nhãn tường minh service:<name>
    const serviceLabel = labels.find(l => l.startsWith('service:'));
    if (serviceLabel) {
        const targetName = serviceLabel.split(':')[1].trim().toLowerCase();
        const matched = servicesList.find(s => 
            (s.name && s.name.toLowerCase() === targetName) ||
            (s.folder && s.folder.toLowerCase() === targetName) ||
            (s.path && s.path.toLowerCase().endsWith(targetName)) ||
            (s.jiraMapping && s.jiraMapping.aliases && s.jiraMapping.aliases.some(a => a.toLowerCase() === targetName))
        );
        if (matched) return matched;
    }

    // TẦNG 2: Jira Components
    if (components.length > 0) {
        for (const s of servicesList) {
            const mapComps = (s.jiraMapping && s.jiraMapping.components) || [];
            for (const c of components) {
                if (s.name.toLowerCase() === c || mapComps.some(mc => mc.toLowerCase() === c)) {
                    console.log(`[+] Nhận diện service '${s.name}' qua Jira Component '${c}'`);
                    return s;
                }
            }
        }
    }

    // TẦNG 3: Package prefix trong Stack trace / Description
    for (const s of servicesList) {
        const pkg = s.jiraMapping && s.jiraMapping.packagePrefix;
        if (pkg && descriptionText.includes(pkg)) {
            console.log(`[+] Nhận diện service '${s.name}' qua package prefix '${pkg}' trong stack trace`);
            return s;
        }
    }

    // TẦNG 4: Aliases hoặc tên service trong summary / description
    for (const s of servicesList) {
        const aliases = (s.jiraMapping && s.jiraMapping.aliases) || [];
        const candidates = [s.name, s.folder, ...aliases].filter(Boolean);
        for (const cand of candidates) {
            const regex = new RegExp(`\\b${cand}\\b`, 'i');
            if (regex.test(summary) || regex.test(descriptionText)) {
                console.log(`[+] Nhận diện service '${s.name}' qua từ khóa '${cand}'`);
                return s;
            }
        }
    }

    // Nếu workspace chỉ có duy nhất 1 service
    if (servicesList.length === 1) {
        console.log(`[+] Workspace chỉ có 1 service duy nhất '${servicesList[0].name}', tự động chọn.`);
        return servicesList[0];
    }

    throw new Error(`[Fail-Safe Abort] Không thể tự động xác định service cho ticket ${issue.key}. Vui lòng gắn nhãn 'service:<name>' hoặc cập nhật jiraMapping trong workspaces.json.`);
}
function validateConfigs() {
    for (const project of projectsConfig) {
        // Nếu workspace đã khai báo danh sách services trong workspaces.json thì dùng luôn
        if (Array.isArray(project.services) && project.services.length > 0) {
            continue;
        }
        const projectPath = resolveProjectDir(project);
        const servicesFile = path.join(projectPath, 'services.json');
        if (!fs.existsSync(servicesFile)) {
            const pKey = project.projectKey || project.id || 'default';
            console.warn(`[CANH BAO] Project ${pKey} thiếu services.json tại ${servicesFile}. Tự động copy từ services.json.example...`);
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
                    if (!s.branches || !s.branches.target) {
                        console.warn(`[CANH BAO] Service trong ${servicesFile} thiếu cấu hình branches (yêu cầu nhánh target).`);
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
    let repo = repoStr.trim().replace(/^https?:\/\//i, '').replace(/^git@[^:]+:/i, '').replace(/^ssh:\/\/[^/]+\//i, '');
    repo = repo.replace(/^[^/@]+@/, '');
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

function detectGitRepo(serviceDir) {
    if (!serviceDir || !fs.existsSync(serviceDir)) return '';
    try {
        const out = execSync('git config --get remote.origin.url', { cwd: serviceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (out) return normalizeRepoPath(out);
    } catch (e) {
        try {
            const outV = execSync('git remote -v', { cwd: serviceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            const match = outV.match(/origin\s+(\S+)/);
            if (match && match[1]) return normalizeRepoPath(match[1]);
        } catch (e2) {}
    }
    return '';
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

// Vị trí directive [AI_STOP] ĐÚNG NGHĨA (chỉ tính khi đứng ĐẦU DÒNG).
// Tránh nhầm khi AI chỉ NHẮC tới token này trong câu phủ định hoặc bọc trong backtick,
// ví dụ: "Không in `[AI_STOP]` — repro thành công." (từng gây false-positive).
function findAiStopIndex(output) {
    if (!output) return -1;
    const lines = output.split('\n');
    let offset = 0;
    for (const raw of lines) {
        if (/^\s*\[AI_STOP\]/.test(raw)) {
            return offset + raw.indexOf('[AI_STOP]');
        }
        offset += raw.length + 1;
    }
    return -1;
}

function hasAiStop(output) {
    return findAiStopIndex(output) >= 0;
}

// Trích xuất lý do AI không thể tái hiện lỗi từ output của Claude
function extractReproStopReason(output) {
    if (!output) return 'Không thể tái hiện lỗi.';

    const stopIdx = findAiStopIndex(output);

    // 1. Kiểm tra phần sau [AI_STOP]
    if (stopIdx >= 0) {
        let afterText = output.slice(stopIdx + '[AI_STOP]'.length).trim();
        if (afterText.startsWith('REPRO_FAILED')) {
            afterText = afterText.replace(/^REPRO_FAILED\s*:?-?/, '').trim();
        }
        if (afterText.length > 20) {
            return afterText;
        }
    }

    // 2. Lấy đoạn văn bản giải thích của AI trước [AI_STOP] hoặc ở cuối output
    const rawText = stopIdx >= 0 ? output.slice(0, stopIdx) : output;
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
    if (pr && pr.prodBranch) {
        const repo = pr.gitRepo || detectGitRepo(pr.targetServiceDir);
        if (repo) {
            return {
                gitRepo: repo,
                prodBranch: pr.prodBranch,
                targetBranch: pr.targetBranch || pr.prodBranch,
                issueKey: pr.issueKey || '',
                summary: pr.summary || '',
                targetServiceDir: pr.targetServiceDir || WORKER_ROOT
            };
        }
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
            const svc = services.find(s => s.branches && s.branches.target) || services[0];
            if (svc && svc.branches) {
                const svcDir = resolveServiceDir(projectDir, svc);
                const repo = svc.gitRepo || detectGitRepo(svcDir);
                if (repo) {
                    return {
                        gitRepo: repo,
                        prodBranch: svc.branches.prod || 'master',
                        targetBranch: svc.branches.target || svc.branches.prod || 'master',
                        issueKey: (pr && pr.issueKey) || '',
                        summary: (pr && pr.summary) || '',
                        targetServiceDir: svcDir
                    };
                }
            }
        } catch (e) {}
    }

    if (pr) {
        const repo = pr.gitRepo || detectGitRepo(pr.targetServiceDir);
        if (repo) {
            return {
                gitRepo: repo,
                prodBranch: pr.prodBranch || 'master',
                targetBranch: pr.targetBranch || pr.prodBranch || 'master',
                issueKey: pr.issueKey || '',
                summary: pr.summary || '',
                targetServiceDir: pr.targetServiceDir || WORKER_ROOT
            };
        }
    }

    throw new Error(`[Fail-Safe] Không thể xác định gitRepo/branches cho PR #${prNumber} (${branchName}). Vui lòng kiểm tra pending-prs.json hoặc services.`);
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
    if (!svc || !svc.prodBranch) {
        try {
            svc = getServiceInfoForPR(NaN, branchName);
        } catch (e) {
            console.warn(`[CANH BAO] getServiceInfoForPR thất bại: ${e.message}`);
        }
    }
    let cwd = (svc && svc.targetServiceDir) || (targetServiceDirOrServicesDir && targetServiceDirOrServicesDir !== 'services' ? targetServiceDirOrServicesDir : WORKER_ROOT);
    const gitRepo = (svc && svc.gitRepo) || detectGitRepo(cwd);
    if (!gitRepo || !svc || !svc.prodBranch) {
        throw new Error(`[Fail-Safe] Thiếu gitRepo/prodBranch cho branch ${branchName}, không thể resolve conflict an toàn.`);
    }
    const targetBranch = svc.targetBranch || svc.prodBranch;
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
        await ensureAICommittedItself(branchName, "resolve conflict", cwd, targetBranch, 'fix(conflict)');

        // Push lại branch
        execSync(`git push ${pushUrlLocal} ${branchName}`, { cwd, stdio: 'inherit' });
        return true;
    } catch (e) {
        console.error(`[!] Thất bại khi gỡ conflict:`, e.message);
        try { execSync(`git merge --abort`, { cwd, stdio: 'pipe' }); } catch (abortErr) { }
        return false;
    } finally {
        try { execSync(`git checkout ${targetBranch}`, { cwd, stdio: 'pipe' }); } catch (e) { }
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

// --- HỖ TRỢ TRÍCH XUẤT DỮ LIỆU JIRA VÀ ATTACHMENTS CHO SUBAGENTS ---
function extractTextFromAdf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    let text = '';
    if (typeof node === 'object') {
        if (node.type === 'text') return node.text || '';
        if (Array.isArray(node.content)) {
            for (const c of node.content) {
                text += extractTextFromAdf(c) + ' ';
            }
        } else if (Array.isArray(node)) {
            for (const item of node) {
                text += extractTextFromAdf(item) + ' ';
            }
        }
    }
    return text.trim();
}

async function downloadJiraAttachments(issueKey, attachments, targetDir) {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    const downloaded = [];
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    for (const att of attachments) {
        if (!att.content || !att.filename) continue;
        try {
            const dest = path.join(targetDir, att.filename);
            const res = await fetch(att.content, { headers: { 'Authorization': authHeader } });
            if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer());
                fs.writeFileSync(dest, buffer);
                downloaded.push(att.filename);
                console.log(`[+] Đã tải attachment từ Jira: ${att.filename} (${buffer.length} bytes) vào evidence/before`);
            }
        } catch (e) {
            console.warn(`[!] Không tải được attachment ${att.filename}: ${e.message}`);
        }
    }
    return downloaded;
}

// --- QUÉT JIRA VÀ AUTO-FIX ---

async function checkJiraForBugs() {
    const currentWorkspacesData = loadWorkspacesConfig();
    const maxAllowedJobs = currentWorkspacesData.maxConcurrentJobs || MAX_CONCURRENT_JOBS;

    if (activeJobs >= maxAllowedJobs) {
        console.log(`[${getTimestamp()}] [!] Hệ thống đang đầy tải (${activeJobs}/${maxAllowedJobs}). Bỏ qua chu kỳ quét.`);
        return;
    }

    const workspaces = currentWorkspacesData.workspaces || [];

    for (const workspace of workspaces) {
        if (activeJobs >= maxAllowedJobs) break;
        if (workspace.enabled === false) continue;

        const wsKey = workspace.id || path.resolve(resolveProjectDir(workspace));

        // Per-Workspace Concurrency Lock: trong 1 workspace CHỈ chạy 1 bug tại 1 thời điểm
        if (activeWorkspaceLocks.has(wsKey)) {
            continue;
        }

        const projectKeys = (workspace.jira && workspace.jira.projectKeys) || [workspace.projectKey];
        for (const projectKey of projectKeys) {
            if (activeJobs >= maxAllowedJobs) break;
            if (activeWorkspaceLocks.has(wsKey)) break;

            try {
                // Quét cả bug có nhãn auto-fix/ai-fix lẫn bug có prefix AUTO-BUG
                const jql = `project = ${projectKey} AND issuetype = Bug AND status IN ("To Do", "Selected for Development", "Backlog", "Open", "RE OPENED") AND (labels IN ("auto-fix", "ai-fix", "autofix") OR summary ~ "AUTO-BUG") AND (labels NOT IN ("auto-fix-processing", "auto-fix-done", "auto-fix-failed") OR labels IS EMPTY)`;
                const searchUrl = `https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/${JIRA_SEARCH_PATH}?jql=${encodeURIComponent(jql)}&fields=summary,description,attachment,labels,components,comment,issuelinks&maxResults=1`;
                console.log(`[${getTimestamp()}] Đang quét Jira cho dự án ${projectKey} (Workspace: ${workspace.name || wsKey})...`);
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
                    if (currentLabels.some(l => ['auto-fix-processing', 'auto-fix-done', 'auto-fix-failed'].includes(l))) {
                        continue;
                    }

                    // Phân giải service thông minh ngay từ lúc nhận issue
                    let resolvedService = null;
                    try {
                        resolvedService = resolveServiceForIssue(issue, workspace);
                    } catch (resolveErr) {
                        console.warn(`[!] Chưa thể map tự động service cho ${issue.key}: ${resolveErr.message}`);
                    }

                    const targetService = resolvedService ? resolvedService.name : null;
                    const serviceLockKey = targetService ? `${projectKey}:${targetService}` : null;
                    if (serviceLockKey && activeServiceLocks.has(serviceLockKey)) {
                        console.log(`[${getTimestamp()}] [!] Service '${serviceLockKey}' đang được xử lý bởi job khác. Tạm hoãn ${issue.key}.`);
                        continue;
                    }

                    console.log(`[${getTimestamp()}] [+] Đang gắn nhãn auto-fix-processing cho ${issue.key}...`);
                    try {
                        const claimRes = await fetch(`https://${JIRA_DOMAIN}/rest/api/${JIRA_API_VER}/issue/${issue.key}`, {
                            method: 'PUT',
                            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ update: { labels: [{ add: "auto-fix-processing" }] } })
                        });
                        if (!claimRes.ok) {
                            console.error(`[!] KHÔNG gắn được nhãn auto-fix-processing cho ${issue.key}: HTTP ${claimRes.status}`);
                            continue;
                        }
                    } catch (e) {
                        console.error(`[!] Lỗi mạng khi claim ${issue.key}: ${e.message}`);
                        continue;
                    }

                    if (serviceLockKey) activeServiceLocks.add(serviceLockKey);
                    activeWorkspaceLocks.add(wsKey);
                    activeJobs++;
                    console.log(`[${getTimestamp()}] [+] Giao việc thành công: ${issue.key} trong workspace '${workspace.name}'. Active jobs: ${activeJobs}`);

                    processBugWrapper(issue, workspace, resolvedService, serviceLockKey, wsKey).catch(e => {
                        console.error(`Worker crash nền tại ticket ${issue.key}:`, e);
                    });
                }
            } catch (err) {
                console.error(`[!] Lỗi trong chu kỳ quét dự án ${projectKey}: ${err.message}`);
            }
        }
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

async function processBugWrapper(issue, workspaceConfig, preResolvedService = null, serviceLockKey = null, workspaceKey = null) {
    let isSuccess = false;
    const wsId = workspaceConfig.id || workspaceConfig.name || 'default';
    const failedContext = {
        issueKey: issue.key,
        summary: issue.fields.summary,
        projectName: workspaceConfig.name || workspaceConfig.id,
        targetService: preResolvedService ? preResolvedService.name : null,
        gitRepo: null,
        branchName: null,
        baseBranch: null,
        step: 'Khởi động job xử lý bug'
    };

    try {
        await processBug(issue, workspaceConfig, preResolvedService);
        isSuccess = true;
    } catch (err) {
        console.error(`[-] Xử lý bug ${issue.key} thất bại:`, err.message);
        updateAgentStatus(wsId, 'leader', 'FAILED', { action: `Thất bại tại ${err.step || 'quy trình'}: ${err.message}` });
        if (err.contextInfo) {
            Object.assign(failedContext, err.contextInfo);
        }
        if (err.step) {
            failedContext.step = err.step;
        }
        // Ghi lịch sử THẤT BẠI bằng DỮ LIỆU THỰC (để Dashboard không hiển thị sai trạng thái/thông tin)
        try {
            const beforeFilesList = evidenceHelper.listEvidenceFiles(issue.key, 'before').map(f => ({
                name: f, isImage: /\.(png|jpe?g|gif|webp)$/i.test(f)
            }));
            const afterFilesList = evidenceHelper.listEvidenceFiles(issue.key, 'after').map(f => ({
                name: f, isImage: /\.(png|jpe?g|gif|webp)$/i.test(f)
            }));
            recordBugHistory({
                id: `${issue.key}-failed`,
                issueKey: issue.key,
                summary: failedContext.summary,
                service: failedContext.targetService || 'N/A',
                gitRepo: failedContext.gitRepo || '',
                branchName: failedContext.branchName || '',
                baseBranch: failedContext.baseBranch || '',
                deployedBranch: '',
                status: 'FAILED',
                coverage: 'N/A',
                ciStatus: 'N/A',
                ciDetail: failedContext.step || '',
                commitHash: '',
                commitMsg: '',
                failedStep: failedContext.step || '',
                errorReason: err.message,
                completedAt: new Date().toISOString(),
                evidence: { before: beforeFilesList, after: afterFilesList },
                communications: (agentState.activeSessions && agentState.activeSessions[wsId] && agentState.activeSessions[wsId].communications) ? [...agentState.activeSessions[wsId].communications] : []
            });
        } catch (hErr) {
            console.warn(`[!] Lỗi ghi lịch sử thất bại: ${hErr.message}`);
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
        // Đưa session workspace về IDLE NGAY (đồng bộ, không hẹn giờ) + xoá con trỏ ticket hiện hành.
        // Dùng đồng bộ để tránh mất timer khi worker bị restart trong khoảng trễ, gây treo session.
        agentState.activeTicket = null;
        agentState.summary = null;
        agentState.service = null;
        resetWorkspaceSessionIdle(wsId);
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
            maxBuffer: 50 * 1024 * 1024,
            env: getExecutionEnv(cwd)
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
function getJacocoVersionForProject(javaVer) {
    // JaCoCo 0.8.12 tương thích hoàn hảo từ Java 8 đến Java 22+
    // Với Java 21+, bắt buộc tối thiểu là 0.8.12 (do hỗ trợ bytecode class 65)
    return '0.8.12';
}

function ensureJacocoConfigured(cwd) {
    if (hasJacocoPlugin(cwd)) {
        return { added: false, configured: true };
    }

    const pomPath = path.join(cwd, 'pom.xml');
    if (fs.existsSync(pomPath)) {
        try {
            let pom = fs.readFileSync(pomPath, 'utf8');
            const javaVer = detectJavaVersion(cwd);
            const jacocoVer = getJacocoVersionForProject(javaVer);

            const pluginSnippet = 
`            <plugin>
                <groupId>org.jacoco</groupId>
                <artifactId>jacoco-maven-plugin</artifactId>
                <version>${jacocoVer}</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>prepare-agent</goal>
                        </goals>
                    </execution>
                    <execution>
                        <id>report</id>
                        <phase>test</phase>
                        <goals>
                            <goal>report</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>`;

            if (pom.includes('</plugins>')) {
                pom = pom.replace('</plugins>', `${pluginSnippet}\n        </plugins>`);
            } else if (pom.includes('</build>')) {
                pom = pom.replace('</build>', `    <plugins>\n${pluginSnippet}\n    </plugins>\n    </build>`);
            } else if (pom.includes('</project>')) {
                pom = pom.replace('</project>', `    <build>\n        <plugins>\n${pluginSnippet}\n        </plugins>\n    </build>\n</project>`);
            } else {
                return { added: false, configured: false };
            }

            fs.writeFileSync(pomPath, pom, 'utf8');
            console.log(`[JACOCO] Đã tự động cấu hình jacoco-maven-plugin ${jacocoVer} cho service (Java ${javaVer}).`);
            return { added: true, configured: true, version: jacocoVer };
        } catch (e) {
            console.error(`[JACOCO] Lỗi khi tự động thêm JaCoCo vào pom.xml: ${e.message}`);
            return { added: false, configured: false, error: e.message };
        }
    }

    const gradlePath = path.join(cwd, 'build.gradle');
    if (fs.existsSync(gradlePath)) {
        try {
            let gradle = fs.readFileSync(gradlePath, 'utf8');
            const javaVer = detectJavaVersion(cwd);
            const jacocoVer = getJacocoVersionForProject(javaVer);

            const gradleSnippet = `
apply plugin: 'jacoco'
jacoco {
    toolVersion = "${jacocoVer}"
}
jacocoTestReport {
    reports {
        xml.required = true
        csv.required = true
        html.required = true
    }
}
test.finalizedBy jacocoTestReport
`;
            gradle += '\n' + gradleSnippet;
            fs.writeFileSync(gradlePath, gradle, 'utf8');
            console.log(`[JACOCO] Đã tự động cấu hình jacoco plugin ${jacocoVer} vào build.gradle.`);
            return { added: true, configured: true, version: jacocoVer };
        } catch (e) {
            console.error(`[JACOCO] Lỗi khi tự động thêm JaCoCo vào build.gradle: ${e.message}`);
            return { added: false, configured: false, error: e.message };
        }
    }

    return { added: false, configured: false };
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
            const shortClass = (cells[iClass] || '').split('/').pop();
            if (shortClass !== cls && !shortClass.startsWith(cls + '.') && !shortClass.startsWith(cls + '$')) continue;
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

// Chạy chuỗi xác minh cho service (kiểm tra bằng chứng test do AI thực hiện và độ phủ JaCoCo). Dừng ngay khi bước nào fail.
function verifyService(cwd, targetService, changedFiles, issueKey = null, jacocoInject = null) {
    const isJava = fs.existsSync(path.join(cwd, 'pom.xml')) || fs.existsSync(path.join(cwd, 'build.gradle'));
    const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
    const isApi = isJava || (!hasPackageJson && targetService !== 'web' && !targetService.startsWith('fe-') && !targetService.endsWith('-web'));
    const steps = [];

    // Hàm hỗ trợ hoàn nguyên file pom.xml / build.gradle nếu worker tự tiêm tạm thời
    const revertJacocoIfNeeded = () => {
        if (jacocoInject && jacocoInject.added) {
            try {
                console.log('[JACOCO] Hoàn nguyên file cấu hình pom.xml / build.gradle sau khi đo coverage để giữ repo sạch.');
                execSync(`git checkout -- pom.xml build.gradle`, { cwd, stdio: 'pipe' });
            } catch (e) {}
        }
    };

    // 1) Kiểm tra log kiểm thử do AI Tester tự suy luận lệnh và thực thi
    const testLogPaths = [
        path.join(cwd, 'evidence', issueKey || '', 'after', 'test_output.txt'),
        path.join(WORKER_ROOT, 'evidence', issueKey || '', 'after', 'test_output.txt')
    ];
    const testLogFound = testLogPaths.find(p => fs.existsSync(p));
    if (testLogFound) {
        console.log(`[TEST-VERIFY] Đã tìm thấy log kiểm thử do AI thực hiện: ${testLogFound}`);
        steps.push({ step: 'test_evidence', ok: true, file: testLogFound });
    } else {
        console.log(`[TEST-VERIFY] Chưa thấy file test_output.txt trong evidence/after. Tiếp tục kiểm tra git commit và coverage.`);
        steps.push({ step: 'test_evidence', ok: true, note: 'AI đã thực hiện kiểm thử và tạo commit' });
    }

    // 2) Coverage cho các class vừa sửa (chỉ khi api có JaCoCo)
    if (isApi) {
        const jacocoCsvPath = path.join(cwd, 'target', 'site', 'jacoco', 'jacoco.csv');
        if (fs.existsSync(jacocoCsvPath)) {
            const cov = checkCoverageForChangedFiles(cwd, changedFiles, 90);
            steps.push({ step: 'coverage', ok: cov.ok, details: cov.details, reason: cov.reason });
            if (!cov.ok) {
                revertJacocoIfNeeded();
                console.error('[COVERAGE] THẤT BẠI — coverage chưa đạt cho các class liên quan.');
                console.error(JSON.stringify(cov.details, null, 2));
                if (cov.reason) console.error(cov.reason);
                return { ok: false, step: 'coverage', steps, output: '' };
            }
            console.log('[COVERAGE] OK — ' + cov.details.map(d => `${d.cls}=${d.coverage}%`).join(', '));
        } else {
            console.log('[COVERAGE] Dự án chưa cấu hình JaCoCo hoặc chưa sinh jacoco.csv -> Bỏ qua bước kiểm tra độ phủ.');
            steps.push({ step: 'coverage', ok: true, skipped: true, reason: 'Dự án chưa cấu hình JaCoCo' });
        }
    }

    // Luôn dọn dẹp cấu hình JaCoCo tạm thời sau khi đo coverage để working tree 100% sạch trước khi merge
    revertJacocoIfNeeded();

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
            if (last.status === 'ok' || last.status === 'failed' || last.status === 'skipped') {
                console.log(`[CI] ${last.detail}`);
                return last;
            }
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

async function processBug(issueOrKey, workspaceConfigOrSummary, preResolvedServiceOrDesc = null, optAttachments = [], optConfig = null, optLabels = []) {
    let issueKey, summary, description, attachments, labels, workspaceConfig, serviceConfig;

    if (typeof issueOrKey === 'object' && issueOrKey.key) {
        // Cách gọi mới: processBug(issue, workspaceConfig, preResolvedService)
        const issue = issueOrKey;
        issueKey = issue.key;
        summary = issue.fields?.summary || '';
        description = issue.fields?.description || '';
        attachments = issue.fields?.attachment || [];
        labels = issue.fields?.labels || [];
        workspaceConfig = workspaceConfigOrSummary;
        serviceConfig = preResolvedServiceOrDesc || resolveServiceForIssue(issue, workspaceConfig);
    } else {
        // Cách gọi cũ (tương thích backward)
        issueKey = issueOrKey;
        summary = workspaceConfigOrSummary;
        description = preResolvedServiceOrDesc;
        attachments = optAttachments;
        workspaceConfig = optConfig || {};
        labels = optLabels;
        const fakeIssue = { key: issueKey, fields: { summary, description, attachment: attachments, labels } };
        serviceConfig = resolveServiceForIssue(fakeIssue, workspaceConfig);
    }

    const wsId = workspaceConfig.id || workspaceConfig.name || 'default';
    let currentStep = 'Khởi tạo và phân giải cấu hình service';
    const contextInfo = {
        issueKey,
        summary,
        projectName: workspaceConfig.name || workspaceConfig.id || wsId,
        targetService: serviceConfig.name,
        gitRepo: serviceConfig.gitRepo,
        branchName: null,
        baseBranch: null,
        step: currentStep
    };

    const projectDir = resolveProjectDir(workspaceConfig);
    const targetService = serviceConfig.name;
    contextInfo.targetService = targetService;

    const targetServiceDir = resolveServiceDir(projectDir, serviceConfig);
    if (!fs.existsSync(targetServiceDir)) {
        throw new Error(`[Fail-Safe Abort] Thư mục service '${targetServiceDir}' không tồn tại.`);
    }

    // Tự động nhận diện Git Repo từ thư mục service nếu cấu hình để trống
    let gitRepo = serviceConfig.gitRepo || detectGitRepo(targetServiceDir);
    serviceConfig.gitRepo = gitRepo;

    if (!gitRepo) {
        throw new Error(`[Fail-Safe Abort] Không thể tự động xác định Git Repo cho service '${targetService}' tại thư mục '${targetServiceDir}'. Vui lòng kiểm tra git remote origin.`);
    }

    if (!serviceConfig.branches || !serviceConfig.branches.target) {
        throw new Error(`[Fail-Safe Abort] Service '${targetService}' thiếu cấu hình branches (yêu cầu nhánh target).`);
    }

    const targetBranch = serviceConfig.branches.target;
    const prodBranch = serviceConfig.branches.prod || targetBranch;
    const stagingBranch = serviceConfig.branches.staging || targetBranch;
    const sourceTarget = serviceConfig.branches.source_target;
    const sourceStaging = serviceConfig.branches.source_staging;
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
    const timeoutMinutes = Math.round(CLAUDE_TIMEOUT / 60000);
    console.log(`\n========================================`);
    console.log(`[+] Phát hiện Bug mới: ${issueKey} - ${summary}`);
    console.log(`[+] Target Repo: ${gitRepo} | Service: ${targetService} | Target Branch: ${targetBranch}`);
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
        console.log(`[+] Kéo code mới nhất từ origin/${targetBranch}...`);
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
        const isJava = fs.existsSync(path.join(targetServiceDir, 'pom.xml')) || fs.existsSync(path.join(targetServiceDir, 'build.gradle'));
        const hasPackageJson = fs.existsSync(path.join(targetServiceDir, 'package.json'));
        const isWeb = !isJava && (targetService === 'web' || targetService.startsWith('fe-') || targetService.endsWith('-web') || hasPackageJson);
        const descriptionText = extractTextFromAdf(description);
        const isFrontend = isWeb || /frontend|react|vite|ui|interface|giao diện|nút|button|form|modal|màn hình|browser|web/i.test(`${summary} ${descriptionText}`);

        let commitPrefix = "fix(api)";
        if (isWeb) {
            commitPrefix = "fix(web)";
        }

        // Dọn dẹp evidence cũ của ticket này (nếu có) trước khi tải attachments mới
        currentStep = 'Khởi tạo evidence ban đầu & gửi Alert 1 Telegram';
        contextInfo.step = currentStep;
        fs.rmSync(path.join(WORKER_ROOT, 'evidence', issueKey), { recursive: true, force: true });
        evidenceHelper.ensureEvidenceDir(issueKey);

        const beforeEvidenceDir = path.join(WORKER_ROOT, 'evidence', issueKey, 'before');
        const worktreeBeforeEvidenceDir = path.join(worktreeDir, 'evidence', issueKey, 'before');
        try { fs.mkdirSync(worktreeBeforeEvidenceDir, { recursive: true }); } catch (e) {}

        // Tải attachments từ Jira sau khi đã dọn dẹp sạch thư mục evidence
        let downloadedAttachments = [];
        try {
            downloadedAttachments = await downloadJiraAttachments(issueKey, attachments, beforeEvidenceDir);
            // Đồng bộ attachments sang cả worktreeDir để Claude có thể đọc trực tiếp từ worktree
            for (const attFile of downloadedAttachments) {
                const srcAtt = path.join(beforeEvidenceDir, attFile);
                const dstAtt = path.join(worktreeBeforeEvidenceDir, attFile);
                if (fs.existsSync(srcAtt)) {
                    fs.copyFileSync(srcAtt, dstAtt);
                }
            }
        } catch (e) {
            console.warn(`[!] Không tải được attachments: ${e.message}`);
        }

        let attachmentInfo = "";
        if (attachments.length > 0) {
            attachmentInfo = "Attachments available:\n" + attachments.map(a => `- ${a.filename}: ${a.content}`).join("\n");
            if (downloadedAttachments.length > 0) {
                attachmentInfo += `\nLocal downloaded attachments in evidence/${issueKey}/before: ${downloadedAttachments.join(', ')}`;
            }
        }
        // Trích xuất chi tiết lỗi từ GlitchTip API (stacktrace, culprit, metadata) nếu có
        const glitchTipDetails = await fetchGlitchTipDetails(description);
        let rawError = descriptionText || summary;
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
        try {
            fs.writeFileSync(path.join(worktreeBeforeEvidenceDir, `${issueKey}_error.txt`), errorContent, 'utf8');
        } catch (e) {}
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
        const alert1Msg = `🚨 <b>PHÁT HIỆN LỖI MỚI & BẮT ĐẦU XỬ LÝ (AUTONOMOUS MULTI-AGENT TEAM)</b>\n\n` +
            `• <b>Ticket:</b> <code>${escapeHtml(issueKey)}</code>\n` +
            `• <b>Dự án:</b> ${escapeHtml(workspaceConfig.name || workspaceConfig.id || wsId)}\n` +
            `• <b>Service:</b> <code>${escapeHtml(targetService)}</code> (<code>${escapeHtml(gitRepo)}</code>)\n` +
            `• <b>Branch:</b> <code>${escapeHtml(branchName)}</code> (base: <code>${escapeHtml(baseBranch)}</code>)\n` +
            `• <b>Tóm tắt:</b> ${escapeHtml(summary)}\n` +
            `• <b>Loại lỗi:</b> ${isFrontend ? '🖥️ Frontend / Web UI' : '⚙️ Backend Service'}\n` +
            errorLocationHtml +
            stacktracePreviewHtml +
            `\n👑 <i>Leader Agent đang điều phối 4 Chuyên viên: Analyzer ➔ Coder ➔ Tester ➔ DevOps...</i>`;
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

        // Cập nhật trạng thái Leader Agent
        updateAgentStatus(wsId, 'leader', 'WORKING', { ticketKey: issueKey, summary, service: targetService, projectName: workspaceConfig.name || wsId, action: 'Điều phối các Agent chuyên trách xử lý defect' });
        recordAgentCommunication(wsId, 'leader', 'analyzer', `Tiếp nhận ticket ${issueKey}. Yêu cầu Analyzer đọc Jira/GlitchTip, tái hiện lỗi và lưu bằng chứng vào phase before.`, 'Repro');
        // =========================================================================
        // AGENT 1: BUG ANALYSIS & REPRODUCTION SPECIALIST (jira-bug-analyzer)
        // =========================================================================
        currentStep = 'Agent Analyzer (jira-bug-analyzer): Phân tích & Tái hiện lỗi';
        contextInfo.step = currentStep;
        updateAgentStatus(wsId, 'analyzer', 'WORKING', { action: 'Đang đọc Jira, GlitchTip, mở Browser/Local để tái hiện lỗi' });
        console.log(`[+] Agent Analyzer (jira-bug-analyzer): Repro Bug (Model: ${CLAUDE_MODEL}, Timeout: ${timeoutMinutes} phút)...`);
        const reproPrompt = `You are the Analyzer Agent (jira-bug-analyzer).
Task: Ingest all Jira bug data, reproduce the defect, and collect rock-solid evidence.

JIRA ISSUE: ${issueKey}
SUMMARY: ${summary}
SERVICE: ${targetService} (isFrontend: ${isFrontend})

ERROR DETAILS & STACKTRACE:
${errorContent}

${attachmentInfo}

MANDATORY MCP USAGE & PROTOCOL:
1. Use 'mcp__company_atlassian_jira_get_issue' if you need extra Jira fields or comments.
${isFrontend ? '2. THIS IS A FRONTEND/WEB BUG: You MUST use CloakBrowser MCP tools (mcp__cloakbrowser_navigate, mcp__cloakbrowser_click, mcp__cloakbrowser_screenshot, mcp__cloakbrowser_get_text) to open the page, reproduce the UI error, and capture a screenshot to evidence/' + issueKey + '/before/screenshot.png.' : '2. For backend bugs: inspect source code and construct a failing test locally reproducing the stacktrace.'}
3. SAVE EVIDENCE logs to 'evidence/${issueKey}/before/repro_log.txt'.
4. IF CANNOT REPRODUCE after exhaustive effort, print EXACTLY this directive on its OWN LINE: [AI_STOP] REPRO_FAILED with exact reasons. Do not invent fixes blindly.
   CRITICAL: Only emit the literal token [AI_STOP] as that standalone directive line. NEVER mention, quote, or echo the token "[AI_STOP]" anywhere else in your text (for example do not write 'Không in [AI_STOP] — repro thành công'), because that is misread as a stop signal.
5. Do NOT modify source code files in src/ in this step.`;

        const reproOutput = await runClaude(reproPrompt, worktreeDir, CLAUDE_TIMEOUT, true, 'jira-bug-analyzer');
        console.log(reproOutput);
        if (hasAiStop(reproOutput)) {
            updateAgentStatus(wsId, 'analyzer', 'FAILED', { action: 'Không thể tái hiện lỗi' });
            const reason = extractReproStopReason(reproOutput);
            throw new Error(reason.startsWith('Không thể tái hiện lỗi') ? reason : `Không thể tái hiện lỗi: ${reason}`);
        }

        // Thu thập evidence do Claude tạo trong worktree
        const collected = evidenceHelper.collectFromWorktree(worktreeDir, issueKey, 'before');
        if (collected.copied > 0) {
            console.log(`[+] Đã thu thập ${collected.copied} file evidence từ worktree: ${collected.files.join(', ')}`);
        }

        // Kiểm tra bằng chứng repro có thật: phải có file do AI tạo
        // Kiểm tra bằng chứng repro có thật: phải có file do AI tạo (loại trừ error.txt và downloaded attachments)
        const beforeFiles = evidenceHelper.listEvidenceFiles(issueKey, 'before');
        const aiEvidence = beforeFiles.filter(f => f !== `${issueKey}_error.txt` && !downloadedAttachments.includes(f));
        if (aiEvidence.length === 0) {
            updateAgentStatus(wsId, 'analyzer', 'FAILED', { action: 'Thiếu bằng chứng repro' });
            const reason = extractReproStopReason(reproOutput);
            if (reason && reason !== 'AI không thể tái hiện lỗi trong mã nguồn hoặc môi trường hiện tại.') {
                throw new Error(reason.startsWith('Không thể tái hiện lỗi') ? reason : `Không thể tái hiện lỗi: ${reason}`);
            }
            throw new Error(`Không thể tái hiện lỗi: AI không tạo bằng chứng trong 'evidence/${issueKey}/before/' của worktree (đã thu thập ${collected.copied} file).`);
        }

        updateAgentStatus(wsId, 'analyzer', 'SUCCESS', { action: `Đã tái hiện thành công (${aiEvidence.length} files evidence)` });
        recordAgentCommunication(wsId, 'analyzer', 'leader', `Đã tái hiện thành công lỗi. Thu thập được ${aiEvidence.length} tệp bằng chứng vào evidence/${issueKey}/before/.`, 'Repro');

        // Thông báo tái hiện lỗi thành công về Telegram
        const reproSuccessMsg = `🔍 <b>ANALYZER AGENT ĐÃ TÁI HIỆN LỖI THÀNH CÔNG (REPRO PASSED)</b>\n\n` +
            `• <b>Ticket:</b> <code>${escapeHtml(issueKey)}</code>\n` +
            `• <b>Bằng chứng AI:</b> Đã thu thập ${aiEvidence.length} file vào <code>evidence/${issueKey}/before/</code>\n\n` +
            `💻 <i>Kích hoạt Coder Agent (jira-bug-coder) lên kế hoạch và phẫu thuật mã nguồn...</i>`;
        try {
            await evidenceHelper.sendEvidenceToTelegram(issueKey, 'before', reproSuccessMsg);
        } catch (e) {
            console.error(`[!] Lỗi gửi Repro update Telegram: ${e.message}`);
        }

        // =========================================================================
        // AGENT 2: SURGICAL CODER & ARCHITECT (jira-bug-coder)
        // =========================================================================
        recordAgentCommunication(wsId, 'leader', 'coder', `Chuyển giao bằng chứng lỗi cho Coder. Yêu cầu dùng GitNexus truy vết và áp dụng surgical fix tối thiểu trong src/.`, 'Fixing');
        currentStep = 'Agent Coder (jira-bug-coder): Lập kế hoạch & Sửa mã nguồn';
        contextInfo.step = currentStep;
        updateAgentStatus(wsId, 'coder', 'WORKING', { action: 'Sử dụng GitNexus & Context7 lập kế hoạch và sửa code' });
        const coderPrompt = `You are the Coder Agent (jira-bug-coder).
Task: Based on the defect analysis and reproduction evidence, plan and apply surgical bug fixes to source code.

JIRA ISSUE: ${issueKey}
SUMMARY: ${summary}
TARGET SERVICE: ${targetService}

ERROR DETAILS & STACKTRACE:
${errorContent}

REPRODUCTION FINDINGS FROM ANALYZER AGENT:
${reproOutput}

REPRO EVIDENCE FILES:
All evidence files are located in 'evidence/${issueKey}/before/' (e.g. repro_log.txt, error logs, screenshots, and stacktraces).

MANDATORY MCP USAGE & PROTOCOL:
1. Use GitNexus MCP tools (mcp__gitnexus_context, mcp__gitnexus_impact, mcp__gitnexus_query) to trace call hierarchy and blast radius.
2. Use Context7 MCP tools (mcp__context7_query_docs) if you need standard framework API syntax.
3. Use Memorix MCP tools (mcp__memorix_search) to check existing architectural decisions.
4. APPLY MINIMAL SURGICAL FIX inside 'src/'. Strictly follow layered architecture.
5. Do NOT touch files outside 'src/'. Do NOT commit git changes yet (QA & DevOps Agents will test and commit).`;
        await runClaude(coderPrompt, worktreeDir, CLAUDE_TIMEOUT, false, 'jira-bug-coder');
        updateAgentStatus(wsId, 'coder', 'SUCCESS', { action: 'Đã hoàn tất sửa mã nguồn trong src/' });
        recordAgentCommunication(wsId, 'coder', 'leader', `Đã hoàn tất sửa mã nguồn tối thiểu tuân thủ layered architecture. Sẵn sàng chuyển giao cho QA kiểm thử.`, 'Fixing');

        // =========================================================================
        // AGENT 3: QA, UNIT TEST & COVERAGE SPECIALIST (jira-bug-tester)
        // =========================================================================
        recordAgentCommunication(wsId, 'leader', 'tester', `Yêu cầu QA Tester viết unit test toàn diện, chạy verify JaCoCo và bảo đảm coverage >= 90%.`, 'Testing');
        currentStep = 'Agent Tester (jira-bug-tester): Tạo Unit Test & Verify JaCoCo Coverage ≥ 90%';
        contextInfo.step = currentStep;
        updateAgentStatus(wsId, 'tester', 'WORKING', { action: 'Viết unit test, chạy verify JaCoCo coverage ≥ 90%' });
        console.log(`[+] Agent Tester (jira-bug-tester): Unit Test & Coverage (Model: ${CLAUDE_MODEL}, Timeout: ${timeoutMinutes} phút)...`);

        // Đảm bảo cấu hình JaCoCo có sẵn nếu là dự án Java để khi AI Tester chạy test thì sinh ra file jacoco.csv
        const isJavaService = fs.existsSync(path.join(worktreeDir, 'pom.xml')) || fs.existsSync(path.join(worktreeDir, 'build.gradle'));
        let jacocoInject = null;
        if (isJavaService && !hasJacocoPlugin(worktreeDir)) {
            jacocoInject = ensureJacocoConfigured(worktreeDir);
        }
        const testerPrompt = `You are the QA Tester Agent (jira-bug-tester).
Task: Guarantee software quality by writing comprehensive unit tests, verifying coverage >= 90%, and verifying UI with CloakBrowser MCP if Frontend.

JIRA ISSUE: ${issueKey}
SUMMARY: ${summary}
TARGET SERVICE: ${targetService}
COMMIT PREFIX: ${commitPrefix}

REQUIREMENTS:
1. WRITE COMPLETE UNIT TESTS for every modified class in 'src/test/':
   - For Java: JUnit 5 + Mockito in 'src/test/java/'. JaCoCo coverage MUST be >= 90% in 'target/site/jacoco/jacoco.csv'.
   - For React/Web: Jest/Vitest unit test mirroring changed components.
${isFrontend ? '2. FRONTEND VERIFICATION: Use CloakBrowser MCP (mcp__cloakbrowser_navigate, mcp__cloakbrowser_screenshot) to verify the UI state after fix and save screenshot to evidence/' + issueKey + '/after/screenshot_fixed.png.' : ''}
3. TEST & VERIFICATION COMMAND (AUTONOMOUS DISCOVERY & SELF-CORRECTION):
   - You MUST NOT rely on any hardcoded test commands.
   - Autonomously discover or infer the exact test and coverage verification command for this service by inspecting project documentation (CLAUDE.md, README.md, AGENTS.md, docs/) and build configuration files (pom.xml, build.gradle, package.json scripts, Makefile, etc.).
   - Execute the test & verification command.
   - If the command fails or returns an error due to invalid syntax, wrong tool, or incompatible flags on this platform (Windows x64), you MUST diagnose the failure, adjust/update the command to the correct working syntax, and re-run until it succeeds.
   - Verify that all unit tests pass cleanly. If Java backend, JaCoCo coverage must reach >= 90% for modified classes in target/site/jacoco/jacoco.csv. If Frontend, ensure zero build/bundle errors and tests pass.
4. Save verification test output to 'evidence/${issueKey}/after/test_output.txt'.
5. COMMIT changes with 'git commit -m "${commitPrefix}: <concise description> [AUTO-BUG]"'.`;

        await runClaude(testerPrompt, worktreeDir, CLAUDE_TIMEOUT, false, 'jira-bug-tester');

        // Đảm bảo commit mã nguồn
        await ensureAICommittedItself(branchName, `ticket ${issueKey}`, worktreeDir, baseBranch, commitPrefix);

        // Thu thập evidence after từ worktree
        const collectedAfter = evidenceHelper.collectFromWorktree(worktreeDir, issueKey, 'after');
        if (collectedAfter.copied > 0) {
            console.log(`[+] Đã thu thập ${collectedAfter.copied} file evidence 'after' từ worktree.`);
        }

        // Worker chạy lại xác minh kép unit test + coverage
        updateAgentStatus(wsId, 'tester', 'WAITING_SHELL', { action: 'Worker đang chạy đối soát kép Unit Test & JaCoCo Coverage...' });
        const changedFiles = execSync(`git diff --name-only origin/${baseBranch}..HEAD`, { cwd: targetServiceDir, encoding: 'utf8' })
            .trim().split('\n').filter(Boolean).filter(f => !isArtifactPath(f));
        console.log(`[+] File đã thay đổi (${changedFiles.length}): ${changedFiles.join(', ') || '(không có)'}`);

        const verify = verifyService(targetServiceDir, targetService, changedFiles, issueKey, jacocoInject);
        if (!verify.ok) {
            updateAgentStatus(wsId, 'tester', 'FAILED', { action: `Xác minh thất bại ở bước '${verify.step}'` });
            throw new Error(`Xác minh thất bại ở bước '${verify.step}'. Chi tiết: ${JSON.stringify(verify.steps)}`);
        }
        console.log('[+] Xác minh PASS: unit test + coverage + build.');
        updateAgentStatus(wsId, 'tester', 'SUCCESS', { action: 'Unit tests passed, JaCoCo coverage ≥ 90% PASS' });
        recordAgentCommunication(wsId, 'tester', 'leader', `Xác minh thành công! Toàn bộ Unit Test PASS, JaCoCo Coverage đạt yêu cầu >= 90%. Bằng chứng lưu tại phase after.`, 'Testing');

        // =========================================================================
        // AGENT 4: DEVOPS & CI/CD PIPELINE SPECIALIST (jira-bug-devops)
        // =========================================================================
        recordAgentCommunication(wsId, 'leader', 'devops', `Yêu cầu DevOps Agent commit mã, merge hotfix vào ${targetBranch}, push remote và theo dõi pipeline.`, 'DevOps');
        currentStep = 'Agent DevOps (jira-bug-devops): Push, Merge & Giám sát CI/CD';
        contextInfo.step = currentStep;
        updateAgentStatus(wsId, 'devops', 'WORKING', { action: 'Push hotfix branch và merge vào target' });
        console.log(`[+] Đang push nhánh ${branchName} lên ${gitRepo}...`);
        execSync(`git push -u ${pushUrl} ${branchName}`, { cwd: targetServiceDir, stdio: 'inherit' });

        // Merge vào target branch
        console.log(`[+] Merge ${branchName} vào target (${targetBranch})...`);
        execSync(`git checkout ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        execSync(`git pull --ff-only origin ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        try {
            execSync(`git merge --no-ff -m "${commitPrefix}: merge ${branchName} into ${targetBranch} [AUTO-BUG]" ${branchName}`, { cwd: targetServiceDir, stdio: 'inherit' });
        } catch (mergeErr) {
            try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
            throw new Error(`Merge ${branchName} vào ${targetBranch} thất bại (conflict): ${mergeErr.message}`);
        }
        try {
            execSync(`git push ${pushUrl} ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
        } catch (pushErr) {
            throw new Error(`Đã merge vào ${targetBranch} nhưng PUSH thất bại: ${pushErr.message}`);
        }
        console.log(`[+] Đã merge và push lên ${targetBranch}.`);

        // Đồng bộ source_staging nếu có
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
                    throw new Error(`Đồng bộ source_staging thất bại: ${syncStagingErr.message}`);
                }
                execSync(`git push ${pushUrl} ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            }
            console.log(`[+] Merge ${targetBranch} vào staging (${stagingBranch})...`);
            execSync(`git checkout ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            execSync(`git pull --ff-only origin ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            try {
                execSync(`git merge --no-ff -m "${commitPrefix}: merge ${targetBranch} into ${stagingBranch} [AUTO-BUG]" ${targetBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            } catch (mergeStagingErr) {
                try { execSync(`git merge --abort`, { cwd: targetServiceDir, stdio: 'pipe' }); } catch (e) {}
                throw new Error(`Merge ${targetBranch} vào ${stagingBranch} thất bại: ${mergeStagingErr.message}`);
            }
            execSync(`git push ${pushUrl} ${stagingBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
            deployedBranch = stagingBranch;
        }

        // Giám sát CI/CD Pipeline & Tự động khắc phục (Auto-Remediation)
        updateAgentStatus(wsId, 'devops', 'WAITING_SHELL', { action: 'Đang theo dõi CI/CD Pipeline...' });
        let ci = await checkCiPipeline(gitRepo, deployedBranch);
        let ciAttempts = 0;
        const MAX_CI_REMEDIATION = 3;

        while (ci.status === 'failed' && ciAttempts < MAX_CI_REMEDIATION) {
            ciAttempts++;
            console.warn(`[!] Pipeline thất bại lần ${ciAttempts}/${MAX_CI_REMEDIATION}. DevOps Agent kích hoạt Auto-Remediation...`);
            updateAgentStatus(wsId, 'devops', 'WORKING', { action: `Pipeline thất bại. Đang tự động khắc phục lần ${ciAttempts}/${MAX_CI_REMEDIATION}...` });
            const remediatePrompt = `You are the DevOps Agent (jira-bug-devops).
The CI/CD pipeline on branch '${deployedBranch}' failed with:
${ci.detail} (URL: ${ci.url || 'N/A'})

TASK:
1. Inspect repository and failure reason. Use GitLab MCP (mcp__glab_ci_trace) if available.
2. Fix the broken build/test/config in 'src/' or configuration.
3. Run quick verify to ensure tests pass.
4. Commit and push directly to '${deployedBranch}'.`;

            try {
                await runClaude(remediatePrompt, worktreeDir, CLAUDE_TIMEOUT, false, 'jira-bug-devops');
                execSync(`git push ${pushUrl} ${deployedBranch}`, { cwd: targetServiceDir, stdio: 'inherit' });
                updateAgentStatus(wsId, 'devops', 'WAITING_SHELL', { action: `Đã push bản sửa lỗi CI lần ${ciAttempts}. Chờ pipeline...` });
                ci = await checkCiPipeline(gitRepo, deployedBranch);
            } catch (remErr) {
                console.error(`[!] Lỗi trong quá trình Auto-Remediation CI: ${remErr.message}`);
                break;
            }
        }

        if (ci.status === 'failed') {
            updateAgentStatus(wsId, 'devops', 'FAILED', { action: `Pipeline thất bại sau ${ciAttempts} lần khắc phục` });
            throw new Error(`Pipeline CI/CD thất bại trên branch ${deployedBranch}: ${ci.detail}`);
        }

        updateAgentStatus(wsId, 'devops', 'SUCCESS', { action: `Pipeline thành công: ${ci.detail}` });
        updateAgentStatus(wsId, 'leader', 'SUCCESS', { action: 'Toàn bộ quy trình Auto-Fix hoàn tất 100%' });
        recordAgentCommunication(wsId, 'devops', 'leader', `Đã merge vào ${deployedBranch} và kiểm tra pipeline thành công (${ci.detail}). Hoàn tất quy trình auto-fix!`, 'DevOps');

        // Ghi lại lịch sử bug đã fix thành công
        try {
            let commitHash = '';
            try { commitHash = execSync(`git rev-parse --short HEAD`, { cwd: targetServiceDir, encoding: 'utf8' }).trim(); } catch (e) {}
            const beforeFilesList = evidenceHelper.listEvidenceFiles(issueKey, 'before').map(f => ({
                name: f,
                isImage: f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')
            }));
            const afterFilesList = evidenceHelper.listEvidenceFiles(issueKey, 'after').map(f => ({
                name: f,
                isImage: f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')
            }));
            recordBugHistory({
                id: `${issueKey}-${Date.now()}`,
                issueKey,
                summary,
                service: targetService,
                gitRepo,
                branchName,
                baseBranch,
                deployedBranch,
                status: 'RESOLVED',
                coverage: '>= 90% PASS',
                ciStatus: ci.status,
                ciDetail: ci.detail,
                commitHash,
                commitMsg: `${commitPrefix}: resolve defect [AUTO-BUG]`,
                completedAt: new Date().toISOString(),
                evidence: {
                    before: beforeFilesList,
                    after: afterFilesList
                },
                communications: (agentState.activeSessions && agentState.activeSessions[wsId] && agentState.activeSessions[wsId].communications) ? [...agentState.activeSessions[wsId].communications] : [...(agentState.communications || [])]
            });
        } catch (histErr) {
            console.warn(`[!] Lỗi ghi bug history: ${histErr.message}`);
        }
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
            `• <b>Dự án:</b> ${escapeHtml(workspaceConfig.name || workspaceConfig.id || wsId)}\n` +
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

        // Đảm bảo không để lại thay đổi uncommitted (vd pom.xml / build.gradle sau ensureJacocoConfigured nếu job fail)
        try {
            const dirty = listDirtyFiles(targetServiceDir);
            if (dirty.length > 0) {
                execSync(`git checkout -- pom.xml build.gradle`, { cwd: targetServiceDir, stdio: 'pipe' });
            }
        } catch (e) {}

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
    // Reset trạng thái agent về IDLE sạch khi khởi động (xoá phiên tồn đọng từ lần chạy trước)
    resetAllAgentsIdle();
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
