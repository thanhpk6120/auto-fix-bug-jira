const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// 1. Nạp biến môi trường từ .env
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const eqIdx = trimmed.indexOf('=');
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                env[k] = v;
                process.env[k] = v;
            }
        }
    } catch (e) {
        console.warn(`[!] Không đọc được file .env: ${e.message}`);
    }
}

const PORT = parseInt(process.env.DASHBOARD_PORT || '8880', 10);
const PID_FILE = path.join(__dirname, 'evidences', 'worker.pid');
const LOG_FILE = path.join(__dirname, 'evidences', 'worker.log');
const DASHBOARD_PID_FILE = path.join(__dirname, 'evidences', 'dashboard.pid');
const HISTORY_FILE = path.join(__dirname, 'evidences', 'history.json');
const HIDDEN_BUGS_FILE = path.join(__dirname, 'evidences', 'hidden_bugs.json');
const AGENTS_STATUS_FILE = path.join(__dirname, 'evidences', 'agents_status.json');
const WORKSPACES_FILE = path.join(__dirname, 'workspaces.json');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

function getHiddenBugs() {
    if (!fs.existsSync(HIDDEN_BUGS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(HIDDEN_BUGS_FILE, 'utf8')); } catch (e) { return []; }
}

try {
    const evDir = path.join(__dirname, 'evidences');
    if (!fs.existsSync(evDir)) fs.mkdirSync(evDir, { recursive: true });
} catch (e) {}

function getRunningWorkerInfo() {
    if (!fs.existsSync(PID_FILE)) {
        return { running: false, pid: null, memory: null, cpu: null, uptime: null };
    }
    const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
        return { running: false, pid: null, memory: null, cpu: null, uptime: null };
    }

    try {
        const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (output && output.includes(pid.toString())) {
            let mem = 'Đang tính';
            const parts = output.split(',');
            if (parts.length >= 5) {
                mem = parts[4].replace(/"/g, '').trim();
            }
            return { running: true, pid, memory: mem, uptime: 'Đang hoạt động' };
        } else {
            return { running: false, pid: null, memory: null, uptime: null };
        }
    } catch (e) {
        return { running: false, pid: null, memory: null, uptime: null };
    }
}

function startWorker() {
    const status = getRunningWorkerInfo();
    if (status.running) {
        return { success: false, message: `Worker đang chạy với PID: ${status.pid}` };
    }

    try {
        const outLog = fs.openSync(LOG_FILE, 'a');
        const child = spawn('node', ['worker.js'], {
            detached: true,
            stdio: ['ignore', outLog, outLog],
            windowsHide: true,
            cwd: __dirname
        });
        child.unref();

        fs.writeFileSync(PID_FILE, child.pid.toString(), 'utf8');
        return { success: true, message: `Đã khởi động Worker thành công (PID: ${child.pid})`, pid: child.pid };
    } catch (e) {
        return { success: false, message: `Lỗi khởi động Worker: ${e.message}` };
    }
}

function stopWorker() {
    const status = getRunningWorkerInfo();
    if (!status.running) {
        if (fs.existsSync(PID_FILE)) {
            try { fs.unlinkSync(PID_FILE); } catch (e) {}
        }
        return { success: true, message: 'Worker không chạy.' };
    }

    try {
        execSync(`taskkill /F /T /PID ${status.pid}`, { stdio: 'ignore' });
    } catch (e) {}

    if (fs.existsSync(PID_FILE)) {
        try { fs.unlinkSync(PID_FILE); } catch (e) {}
    }
    return { success: true, message: `Đã dừng Worker (PID: ${status.pid})` };
}

function getLogs(maxLines = 150) {
    if (!fs.existsSync(LOG_FILE)) {
        return 'Chưa có dữ liệu log. Hãy khởi động Worker để xem log.';
    }
    try {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split(/\r?\n/);
        return lines.slice(-maxLines).join('\n');
    } catch (e) {
        return `Lỗi đọc log: ${e.message}`;
    }
}

function resolveProjectDir(workspace) {
    const root = workspace.workspaceRoot || workspace.path || 'services';
    return path.isAbsolute(root) ? root : path.join(__dirname, root);
}

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

function getWorkspacesConfig() {
    let cfg = { maxConcurrentJobs: 3, workspaces: [] };
    if (fs.existsSync(WORKSPACES_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
            if (raw.workspaces && Array.isArray(raw.workspaces)) {
                cfg = raw;
            }
        } catch (e) {}
    } else if (fs.existsSync(PROJECTS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
            const projects = raw.projects || [];
            cfg = {
                maxConcurrentJobs: 3,
                workspaces: projects.map(p => ({
                    id: (p.projectKey || 'default').toLowerCase(),
                    name: p.name || p.projectKey,
                    workspaceRoot: p.path || 'services',
                    concurrencyLimit: 1,
                    enabled: true,
                    jira: { projectKeys: [p.projectKey] },
                    services: []
                }))
            };
        } catch (e) {}
    }
    // Tự động nhận diện Git Repo cho các service nếu chưa có
    for (const ws of cfg.workspaces || []) {
        const wsRoot = resolveProjectDir(ws);
        for (const s of ws.services || []) {
            if (!s.gitRepo && wsRoot) {
                const sDir = path.resolve(wsRoot, s.folder || s.path || s.name);
                const detected = detectGitRepo(sDir);
                if (detected) s.gitRepo = detected;
            }
        }
    }
    return cfg;
}

function saveWorkspacesConfig(newConfig) {
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
}

function getFixedBugsList() {
    const hidden = getHiddenBugs();
    let list = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            list = [];
        }
    }
    list = list.filter(item => !hidden.includes(item.issueKey) && !hidden.includes(item.id));

    const scannedDirs = [];
    for (const bDir of [path.join(__dirname, 'evidences'), path.join(__dirname, 'evidence')]) {
        if (fs.existsSync(bDir)) {
            const subs = fs.readdirSync(bDir).filter(s => {
                const sp = path.join(bDir, s);
                return fs.statSync(sp).isDirectory() && /^[A-Z0-9]+-[0-9]+$/i.test(s);
            });
            for (const s of subs) {
                if (!scannedDirs.includes(s)) scannedDirs.push(s);
            }
        }
    }

    for (const ticketKey of scannedDirs) {
        if (hidden.includes(ticketKey)) continue;
        if (!list.some(item => item.issueKey === ticketKey)) {
            let beforeCount = 0;
            let afterCount = 0;
            for (const bDir of [path.join(__dirname, 'evidences'), path.join(__dirname, 'evidence')]) {
                const bP = path.join(bDir, ticketKey, 'before');
                const aP = path.join(bDir, ticketKey, 'after');
                if (fs.existsSync(bP)) beforeCount += fs.readdirSync(bP).length;
                if (fs.existsSync(aP)) afterCount += fs.readdirSync(aP).length;
            }

            // Fallback TRUNG THỰC: chỉ còn thư mục bằng chứng, KHÔNG có hồ sơ xử lý thành công.
            list.push({
                id: `${ticketKey}-evidence-only`,
                issueKey: ticketKey,
                summary: `Bản ghi bằng chứng (${ticketKey}) — không có hồ sơ xử lý hoàn tất`,
                service: '',
                gitRepo: '',
                branchName: '',
                baseBranch: '',
                deployedBranch: '',
                status: 'FAILED',
                coverage: '',
                ciStatus: '',
                ciDetail: 'Chỉ còn thư mục bằng chứng, không có hồ sơ xử lý thành công',
                commitHash: '',
                commitMsg: '',
                completedAt: null,
                evidenceCount: { before: beforeCount, after: afterCount },
                communications: []
            });
        }
    }

    return list;
}

function getBugDetail(ticketKey) {
    const list = getFixedBugsList();
    const item = list.find(b => b.issueKey === ticketKey || b.id === ticketKey) || {
        issueKey: ticketKey,
        summary: `Chi tiết lỗi ticket ${ticketKey}`,
        service: 'N/A',
        status: 'UNKNOWN',
        coverage: 'N/A',
        ciStatus: 'N/A',
        completedAt: new Date().toISOString(),
        communications: []
    };

    const evidence = { before: [], after: [] };
    const textSnippets = {};

    for (const bDir of [path.join(__dirname, 'evidences'), path.join(__dirname, 'evidence')]) {
        const ticketDir = path.join(bDir, ticketKey);
        if (fs.existsSync(ticketDir)) {
            for (const phase of ['before', 'after']) {
                const pDir = path.join(ticketDir, phase);
                if (fs.existsSync(pDir)) {
                    const files = fs.readdirSync(pDir);
                    for (const f of files) {
                        const fp = path.join(pDir, f);
                        const stat = fs.statSync(fp);
                        const isImg = /\.(png|jpe?g|gif|webp)$/i.test(f);
                        if (!evidence[phase].some(e => e.name === f)) {
                            evidence[phase].push({
                                name: f,
                                size: stat.size,
                                isImage: isImg
                            });
                        }
                        if (!isImg && stat.size < 500000) {
                            try {
                                textSnippets[`${phase}/${f}`] = fs.readFileSync(fp, 'utf8');
                            } catch (e) {}
                        }
                    }
                }
            }
        }
    }

    return {
        ...item,
        evidence,
        textSnippets
    };
}

// HTML Dashboard UI
function renderDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous Multi-Agent War Room & Multi-Workspace Hub</title>
  <style>
    :root {
      --bg: #0b0f19;
      --bg-secondary: #111827;
      --card: #151d30;
      --card-hover: #1e293b;
      --border: #23314d;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --accent-glow: rgba(59, 130, 246, 0.35);
      --code-bg: #0d1322;
      --terminal-bg: #070a12;
      --office-floor: #0e1628;
      --modal-bg: rgba(11, 15, 25, 0.85);
      --pulse-line: #3b82f6;
      --mesh-bg: rgba(30, 41, 59, 0.4);
    }

    body.light-theme {
      --bg: #f1f5f9;
      --bg-secondary: #e2e8f0;
      --card: #ffffff;
      --card-hover: #f8fafc;
      --border: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #059669;
      --danger: #dc2626;
      --warning: #d97706;
      --accent-glow: rgba(37, 99, 235, 0.15);
      --code-bg: #f8fafc;
      --terminal-bg: #1e293b;
      --office-floor: #f8fafc;
      --modal-bg: rgba(241, 245, 249, 0.9);
      --pulse-line: #2563eb;
      --mesh-bg: rgba(203, 213, 225, 0.5);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; transition: background-color 0.25s ease, border-color 0.25s ease, color 0.25s ease; }
    body { background: var(--bg); color: var(--text); padding: 20px; min-height: 100vh; }
    .container { max-width: 1440px; margin: 0 auto; }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .title-area { display: flex; align-items: center; gap: 14px; }
    .title-logo { font-size: 32px; filter: drop-shadow(0 0 10px var(--primary)); }
    .title-text h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; }
    .title-badge { font-size: 11px; background: rgba(59, 130, 246, 0.2); color: var(--primary); padding: 3px 8px; border-radius: 12px; border: 1px solid var(--primary); font-weight: 600; }
    .subtitle { font-size: 12.5px; color: var(--text-muted); margin-top: 3px; }

    .header-actions { display: flex; gap: 10px; align-items: center; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-outline:hover { background: var(--card-hover); border-color: var(--primary); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .btn-theme { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 7px 12px; }

    /* Navigation Tabs */
    .nav-tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .nav-tab { padding: 9px 18px; border-radius: 8px 8px 0 0; background: transparent; border: 1px solid transparent; color: var(--text-muted); font-size: 13.5px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; }
    .nav-tab.active { background: var(--card); color: var(--primary); border: 1px solid var(--border); border-bottom-color: var(--card); margin-bottom: -5px; }

    /* Workspace Matrix Bar */
    .workspace-matrix-bar { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; }
    .ws-matrix-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .ws-cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .ws-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px; transition: all 0.2s; cursor: pointer; position: relative; }
    .ws-card:hover { border-color: var(--primary); }
    .ws-card.active-session { border-color: var(--primary); box-shadow: 0 0 12px var(--accent-glow); background: linear-gradient(180deg, var(--bg), var(--bg-secondary)); }
    .ws-card.disabled-ws { opacity: 0.6; filter: grayscale(0.4); }
    .ws-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .ws-card-name { font-size: 13px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
    .ws-lock-tag { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .lock-FREE { background: rgba(16, 185, 129, 0.15); color: var(--success); }
    .lock-BUSY { background: rgba(59, 130, 246, 0.25); color: #60a5fa; border: 1px solid var(--primary); animation: pulseGlow 1.5s infinite; }
    .lock-DISABLED { background: rgba(148, 163, 184, 0.2); color: var(--text-muted); }
    .ws-card-desc { font-size: 11px; color: var(--text-muted); line-height: 1.3; margin-top: 4px; }
    .ws-card-meta { display: flex; gap: 8px; font-size: 10px; color: var(--text-muted); margin-top: 8px; flex-wrap: wrap; }

    /* Session Selector Tabs */
    .session-selector-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
    .session-tab-btn { padding: 6px 14px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); color: var(--text-muted); font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px; }
    .session-tab-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); box-shadow: 0 0 10px var(--accent-glow); }

    /* Pipeline Workflow Bar */
    .workflow-bar { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; }
    .workflow-title { font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 10px; display: flex; justify-content: space-between; }
    .workflow-steps { display: flex; align-items: center; justify-content: space-between; position: relative; }
    .workflow-steps::before { content: ""; position: absolute; top: 18px; left: 30px; right: 30px; height: 3px; background: var(--border); z-index: 1; }
    .wf-step { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 18%; }
    .wf-circle { width: 36px; height: 36px; border-radius: 50%; background: var(--bg-secondary); border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; transition: all 0.3s; }
    .wf-name { font-size: 11.5px; font-weight: 700; text-align: center; }
    .wf-role { font-size: 10px; color: var(--text-muted); text-align: center; }

    .wf-step.active .wf-circle { background: var(--primary); border-color: #60a5fa; color: #fff; box-shadow: 0 0 15px var(--primary); animation: pulseGlow 1.5s infinite; }
    .wf-step.success .wf-circle { background: var(--success); border-color: #34d399; color: #fff; }
    .wf-step.failed .wf-circle { background: var(--danger); border-color: #f87171; color: #fff; }

    @keyframes pulseGlow {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
      70% { transform: scale(1.08); box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
    }

    /* Multi-Agent Command Center & Communication Mesh */
    .office-view { display: grid; grid-template-columns: 1fr 380px; gap: 20px; margin-bottom: 20px; }
    @media (max-width: 1024px) {
      .office-view { grid-template-columns: 1fr; }
    }

    .mesh-container { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; position: relative; overflow: hidden; }
    .mesh-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .mesh-title { font-size: 15px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block; box-shadow: 0 0 8px var(--success); animation: blink 1.2s infinite; }

    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

    .mesh-topology { position: relative; min-height: 480px; background: var(--office-floor); border-radius: 12px; border: 1px dashed var(--border); padding: 20px; display: flex; flex-direction: column; justify-content: space-between; }
    .svg-connections { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }

    .leader-row { display: flex; justify-content: center; position: relative; z-index: 2; margin-bottom: 30px; }
    .agents-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; position: relative; z-index: 2; }
    @media (max-width: 860px) {
      .agents-grid { grid-template-columns: repeat(2, 1fr); }
    }

    /* Agent Cards */
    .agent-card { background: var(--card); border: 2px solid var(--border); border-radius: 12px; padding: 14px; transition: all 0.3s; position: relative; }
    .agent-card:hover { border-color: var(--primary); transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.15); }
    .agent-card.leader-card { max-width: 480px; width: 100%; border-color: #6366f1; background: linear-gradient(180deg, var(--card), var(--bg-secondary)); }

    .agent-card.status-WORKING { border-color: var(--primary); box-shadow: 0 0 20px var(--accent-glow); }
    .agent-card.status-WAITING_SHELL { border-color: var(--warning); box-shadow: 0 0 20px rgba(245, 158, 11, 0.35); }
    .agent-card.status-SUCCESS { border-color: var(--success); box-shadow: 0 0 20px rgba(16, 185, 129, 0.35); }
    .agent-card.status-FAILED { border-color: var(--danger); box-shadow: 0 0 20px rgba(239, 68, 68, 0.35); }

    .agent-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .agent-badge-role { display: flex; align-items: center; gap: 8px; }
    .agent-avatar { font-size: 24px; }
    .agent-meta h3 { font-size: 13.5px; font-weight: 800; line-height: 1.2; }
    .agent-role-label { font-size: 10.5px; color: var(--text-muted); font-weight: 600; }

    .status-tag { font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; }
    .tag-IDLE { background: rgba(148, 163, 184, 0.2); color: var(--text-muted); }
    .tag-WORKING { background: rgba(59, 130, 246, 0.25); color: #60a5fa; border: 1px solid var(--primary); animation: pulseGlow 1.5s infinite; }
    .tag-WAITING_SHELL { background: rgba(245, 158, 11, 0.25); color: #fbbf24; border: 1px solid var(--warning); }
    .tag-SUCCESS { background: rgba(16, 185, 129, 0.25); color: #34d399; border: 1px solid var(--success); }
    .tag-FAILED { background: rgba(239, 68, 68, 0.25); color: #f87171; border: 1px solid var(--danger); }

    .agent-action-box { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 11px; margin-top: 8px; min-height: 48px; color: var(--text); line-height: 1.4; display: flex; align-items: center; }
    .agent-tools { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
    .tool-chip { font-size: 9.5px; background: var(--bg-secondary); border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; color: var(--text-muted); font-weight: 600; }

    /* Communication Live Feed */
    .comm-feed-container { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; max-height: 570px; }
    .comm-feed-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .comm-feed-header h3 { font-size: 14px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
    .comm-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
    .comm-item { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; position: relative; }
    .comm-meta { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; }
    .comm-nodes { display: flex; align-items: center; gap: 4px; font-weight: 700; color: var(--primary); }
    .comm-content { line-height: 1.4; word-break: break-word; }

    /* Fixed Bugs History View */
    .history-view { display: none; }
    .history-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
    .history-search { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .input-search { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 8px; font-size: 13px; width: 260px; outline: none; }
    .input-search:focus { border-color: var(--primary); }

    .bugs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
    .bug-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; transition: all 0.25s; display: flex; flex-direction: column; justify-content: space-between; }
    .bug-card:hover { border-color: var(--primary); transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.15); }
    .bug-card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
    .bug-key-badge { font-size: 13px; font-weight: 800; color: var(--primary); background: rgba(59, 130, 246, 0.15); padding: 3px 8px; border-radius: 6px; }
    .bug-summary { font-size: 13px; font-weight: 700; line-height: 1.4; margin-bottom: 12px; color: var(--text); }
    .bug-details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px; background: var(--bg); padding: 10px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 14px; }
    .bug-detail-row { display: flex; flex-direction: column; }
    .bug-detail-lbl { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
    .bug-detail-val { font-weight: 700; color: var(--text); margin-top: 1px; word-break: break-all; }
    .bug-card-actions { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid var(--border); }

    /* Console View */
    .console-view { display: none; }
    .terminal-window { background: var(--terminal-bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
    .terminal-bar { background: var(--card); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; }
    .terminal-dots { display: flex; gap: 6px; }
    .t-dot { width: 11px; height: 11px; border-radius: 50%; }
    .t-red { background: #ef4444; } .t-yellow { background: #f59e0b; } .t-green { background: #10b981; }
    .terminal-title { font-size: 12px; font-weight: 700; color: var(--text-muted); }
    .terminal-body { padding: 16px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; line-height: 1.5; color: #a5f3fc; height: 480px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }

    /* Modals */
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--modal-bg); backdrop-filter: blur(6px); display: none; justify-content: center; align-items: center; z-index: 1000; padding: 20px; }
    .modal-content { background: var(--card); border: 1px solid var(--border); border-radius: 14px; width: 100%; max-width: 960px; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 22px; border-bottom: 1px solid var(--border); }
    .modal-title { font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
    .btn-close { background: transparent; border: none; font-size: 20px; color: var(--text-muted); cursor: pointer; }
    .modal-body { padding: 20px; }

    .modal-subtabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .modal-subtab { padding: 6px 14px; border-radius: 6px; background: transparent; border: 1px solid transparent; color: var(--text-muted); font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .modal-subtab.active { background: var(--primary); color: #fff; }

    .evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; margin-top: 10px; }
    .evidence-thumb { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .evidence-thumb:hover { border-color: var(--primary); transform: scale(1.03); }
    .evidence-thumb img { width: 100%; height: 90px; object-fit: cover; border-radius: 4px; margin-bottom: 6px; }

    .code-snippet-box { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11.5px; line-height: 1.4; max-height: 250px; overflow-y: auto; margin-top: 8px; white-space: pre-wrap; }

    /* Form Styles */
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--text); }
    .form-input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text); font-size: 13px; outline: none; }
    .form-input:focus { border-color: var(--primary); }
    .ws-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12.5px; }
    .ws-table th, .ws-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
    .ws-table th { background: var(--bg); color: var(--text-muted); font-size: 11px; text-transform: uppercase; font-weight: 700; }

    /* Visual Services Builder */
    .svc-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .svc-card:hover { border-color: var(--primary); }
    .svc-main-info h4 { font-size: 13px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
    .svc-meta-line { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

    /* Tooltip styles */
    .field-hint {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 700;
      cursor: help;
      margin-left: 5px;
      position: relative;
      vertical-align: middle;
      user-select: none;
    }
    .field-hint:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .field-hint .tooltip-text {
      visibility: hidden;
      opacity: 0;
      width: 250px;
      background: #0f172a;
      color: #e2e8f0;
      text-align: left;
      border-radius: 6px;
      padding: 8px 10px;
      position: absolute;
      z-index: 1000;
      bottom: 140%;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      font-weight: 400;
      line-height: 1.4;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      border: 1px solid var(--border);
      transition: opacity 0.2s, visibility 0.2s;
      pointer-events: none;
      white-space: normal;
    }
    .field-hint .tooltip-text::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      margin-left: -5px;
      border-width: 5px;
      border-style: solid;
      border-color: #0f172a transparent transparent transparent;
    }
    .field-hint:hover .tooltip-text {
      visibility: visible;
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="title-area">
        <div class="title-logo">🤖</div>
        <div class="title-text">
          <h1>Autonomous Multi-Agent War Room <span class="title-badge">MULTI-WORKSPACE</span></h1>
          <div class="subtitle">Điều phối tự động chuyên trách: Leader Agent & 4 Chuyên viên AI độc lập giải quyết Jira Bug trên toàn bộ dự án</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn btn-theme" onclick="toggleTheme()" id="themeBtn">🌙 Chế độ Tối</button>
        <button class="btn btn-danger" onclick="clearGlitchTipData()" title="Xóa toàn bộ issue cũ trên GlitchTip">🧹 Xóa GlitchTip</button>
        <button class="btn btn-primary" onclick="controlWorker('restart')">🔄 Restart Worker</button>
      </div>
    </header>

    <div class="nav-tabs">
      <button class="nav-tab active" id="tabOffice" onclick="switchMainTab('office')">🏢 Phòng Điều Hành Agent</button>
      <button class="nav-tab" id="tabHistory" onclick="switchMainTab('history')">🐞 Lịch Sử Bug Đã Sửa (<span id="fixedBugCountBadge">0</span>)</button>
      <button class="nav-tab" id="tabConsole" onclick="switchMainTab('console')">📋 Console Logs</button>
    </div>

    <!-- TAB 1: PHÒNG ĐIỀU HÀNH AGENT -->
    <div id="officeViewSection">
      <!-- Workspace Matrix Bar -->
      <div class="workspace-matrix-bar">
        <div class="ws-matrix-head">
          <div style="font-size: 13px; font-weight: 800; display: flex; align-items: center; gap: 8px;">
            🌐 Ma Trận Dự Án & Trạng Thái Luồng Song Song (1 Luồng / Workspace)
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <div style="font-size: 11.5px; color: var(--text-muted);" id="concurrencySummary">Đang tải thông tin...</div>
            <button class="btn btn-outline" style="padding: 5px 12px; font-size: 12px;" onclick="openWsManagerModal()">⚙️ Quản Lý Workspaces</button>
          </div>
        </div>
        <div class="ws-cards-grid" id="wsMatrixContainer"></div>
      </div>

      <!-- Active Sessions Selector -->
      <div class="session-selector-bar" id="sessionSelectorBar">
        <span style="font-size: 12px; font-weight: 700; color: var(--text-muted); display: flex; align-items: center; gap: 4px;">
          ⚡ Phiên Đang Chạy:
        </span>
        <div id="sessionTabsList" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
      </div>

      <!-- Workflow Progress Bar -->
      <div class="workflow-bar">
        <div class="workflow-title">
          <span id="currentSessionTitle">Quy Trình 5 Bước Giải Quyết Defect Khép Kín</span>
          <span id="activeServiceText" style="color: var(--primary); text-transform: none;">Chờ tiếp nhận...</span>
        </div>
        <div class="workflow-steps">
          <div class="wf-step" id="wfStep1">
            <div class="wf-circle">1</div>
            <div class="wf-name">Leader Dispatch</div>
            <div class="wf-role">Tiếp nhận & Chỉ đạo</div>
          </div>
          <div class="wf-step" id="wfStep2">
            <div class="wf-circle">2</div>
            <div class="wf-name">Analyzer & Repro</div>
            <div class="wf-role">Tái hiện & Thu thập log</div>
          </div>
          <div class="wf-step" id="wfStep3">
            <div class="wf-circle">3</div>
            <div class="wf-name">Surgical Coder</div>
            <div class="wf-role">GitNexus & Vá lỗi src/</div>
          </div>
          <div class="wf-step" id="wfStep4">
            <div class="wf-circle">4</div>
            <div class="wf-name">QA & Coverage</div>
            <div class="wf-role">JaCoCo Target ≥ 90%</div>
          </div>
          <div class="wf-step" id="wfStep5">
            <div class="wf-circle">5</div>
            <div class="wf-name">DevOps CI/CD</div>
            <div class="wf-role">Merge & Pipeline Monitor</div>
          </div>
        </div>
      </div>

      <div class="office-view">
        <div class="mesh-container">
          <div class="mesh-header">
            <div class="mesh-title"><span class="live-dot"></span> Sơ Đồ Mạng Giao Tiếp & Điều Phối Agent</div>
            <div style="font-size: 11px; color: var(--text-muted);" id="lastSyncTime">Cập nhật: --:--:--</div>
          </div>

          <div class="mesh-topology">
            <svg class="svg-connections" id="svgConnections" viewBox="0 0 800 460" preserveAspectRatio="none">
              <path id="lineLeaderToAnalyzer" d="M 400 90 L 100 280" stroke="var(--border)" stroke-width="2" stroke-dasharray="6,6" fill="none" />
              <path id="lineLeaderToCoder" d="M 400 90 L 300 280" stroke="var(--border)" stroke-width="2" stroke-dasharray="6,6" fill="none" />
              <path id="lineLeaderToTester" d="M 400 90 L 500 280" stroke="var(--border)" stroke-width="2" stroke-dasharray="6,6" fill="none" />
              <path id="lineLeaderToDevops" d="M 400 90 L 700 280" stroke="var(--border)" stroke-width="2" stroke-dasharray="6,6" fill="none" />
            </svg>

            <div class="leader-row">
              <div class="agent-card leader-card" id="cardLeader">
                <div class="agent-head">
                  <div class="agent-badge-role">
                    <div class="agent-avatar">👑</div>
                    <div class="agent-meta">
                      <h3>Leader Agent</h3>
                      <div class="agent-role-label">Master Orchestrator & Gatekeeper</div>
                    </div>
                  </div>
                  <span class="status-tag tag-IDLE" id="tagLeader">IDLE</span>
                </div>
                <div class="agent-action-box" id="actionLeader">Đang quét Jira để tiếp nhận ticket...</div>
                <div class="agent-tools">
                  <span class="tool-chip">Atlassian MCP</span>
                  <span class="tool-chip">Telegram Gateway</span>
                  <span class="tool-chip">Quality Gatekeeper</span>
                </div>
              </div>
            </div>

            <div class="agents-grid">
              <div class="agent-card" id="cardAnalyzer">
                <div class="agent-head">
                  <div class="agent-badge-role">
                    <div class="agent-avatar">🔍</div>
                    <div class="agent-meta">
                      <h3>Analyzer Agent</h3>
                      <div class="agent-role-label">Bug Analysis & Repro</div>
                    </div>
                  </div>
                  <span class="status-tag tag-IDLE" id="tagAnalyzer">IDLE</span>
                </div>
                <div class="agent-action-box" id="actionAnalyzer">Sẵn sàng phân tích stacktrace</div>
                <div class="agent-tools">
                  <span class="tool-chip">CloakBrowser</span>
                  <span class="tool-chip">GlitchTip API</span>
                </div>
              </div>

              <div class="agent-card" id="cardCoder">
                <div class="agent-head">
                  <div class="agent-badge-role">
                    <div class="agent-avatar">💻</div>
                    <div class="agent-meta">
                      <h3>Coder Agent</h3>
                      <div class="agent-role-label">Surgical Fix & Architect</div>
                    </div>
                  </div>
                  <span class="status-tag tag-IDLE" id="tagCoder">IDLE</span>
                </div>
                <div class="agent-action-box" id="actionCoder">Sẵn sàng lập kế hoạch sửa code</div>
                <div class="agent-tools">
                  <span class="tool-chip">GitNexus Graph</span>
                  <span class="tool-chip">Context7 Docs</span>
                </div>
              </div>

              <div class="agent-card" id="cardTester">
                <div class="agent-head">
                  <div class="agent-badge-role">
                    <div class="agent-avatar">🧪</div>
                    <div class="agent-meta">
                      <h3>QA Tester Agent</h3>
                      <div class="agent-role-label">QA & JaCoCo Coverage</div>
                    </div>
                  </div>
                  <span class="status-tag tag-IDLE" id="tagTester">IDLE</span>
                </div>
                <div class="agent-action-box" id="actionTester">Sẵn sàng viết unit test JUnit/Vitest</div>
                <div class="agent-tools">
                  <span class="tool-chip">JaCoCo ≥ 90%</span>
                  <span class="tool-chip">Mockito Runner</span>
                </div>
              </div>

              <div class="agent-card" id="cardDevops">
                <div class="agent-head">
                  <div class="agent-badge-role">
                    <div class="agent-avatar">🚀</div>
                    <div class="agent-meta">
                      <h3>DevOps Agent</h3>
                      <div class="agent-role-label">Commit, Merge & CI/CD</div>
                    </div>
                  </div>
                  <span class="status-tag tag-IDLE" id="tagDevops">IDLE</span>
                </div>
                <div class="agent-action-box" id="actionDevops">Sẵn sàng theo dõi CI/CD pipeline</div>
                <div class="agent-tools">
                  <span class="tool-chip">GitLab MCP</span>
                  <span class="tool-chip">Auto-Remediation</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="comm-feed-container">
          <div class="comm-feed-header">
            <h3>💬 Luồng Giao Tiếp Realtime</h3>
            <span style="font-size: 11px; color: var(--text-muted);" id="commCountText">0 bản tin</span>
          </div>
          <div class="comm-list" id="commList">
            <div style="color: var(--text-muted); text-align: center; margin-top: 40px; font-size: 12px;">
              Chưa có thông điệp giao tiếp nào. Khi phát hiện defect, các trao đổi giữa Leader và Agent sẽ xuất hiện tại đây.
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: LỊCH SỬ BUG ĐÃ SỬA (FIXED BUGS AUDIT) -->
    <div id="historyViewSection" class="history-view">
      <div class="history-header">
        <div>
          <h2 style="font-size: 18px; font-weight: 800;">Lịch Sử Bug Đã Xử Lý & Bằng Chứng Toàn Diện</h2>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
            Hồ sơ lưu trữ đầy đủ các ticket: Stack trace, file bằng chứng before/after, JaCoCo coverage %, Git commit và Pipeline.
          </div>
        </div>
        <div class="history-search">
          <input type="text" class="input-search" id="searchBugInput" placeholder="Tìm theo ticket (vd: SHOP-1, api)..." oninput="filterBugsList()">
          <button class="btn btn-danger" style="padding: 7px 12px; font-size: 12px;" onclick="clearAllBugHistory()" title="Xóa toàn bộ bản ghi lịch sử">🗑️ Xóa Tất Cả</button>
          <button class="btn btn-outline" style="padding: 7px 12px; font-size: 12px;" onclick="restoreHiddenBugs()" title="Khôi phục các ticket đã ẩn">↩️ Khôi Phục</button>
          <button class="btn btn-outline" style="padding: 7px 12px; font-size: 12px;" onclick="loadFixedBugs()">🔄 Tải Lại</button>
        </div>
      </div>

      <div class="bugs-grid" id="bugsListContainer">
        <div style="color: var(--text-muted); text-align: center; grid-column: 1/-1; padding: 40px;">Đang tải danh sách bug...</div>
      </div>
    </div>

    <!-- TAB 3: CONSOLE LOGS -->
    <div id="consoleViewSection" class="console-view">
      <div class="terminal-window">
        <div class="terminal-bar">
          <div class="terminal-dots">
            <div class="t-dot t-red"></div>
            <div class="t-dot t-yellow"></div>
            <div class="t-dot t-green"></div>
          </div>
          <div class="terminal-title">worker.log — Autonomous Master Process Output</div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <label style="font-size: 11px; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-muted);">
              <input type="checkbox" id="autoScroll" checked> Auto-Scroll
            </label>
            <button class="btn btn-outline" style="padding: 4px 10px; font-size: 11px;" onclick="fetchLogs()">Làm mới</button>
            <button class="btn btn-danger" style="padding: 4px 10px; font-size: 11px;" onclick="clearLogs()">Xóa log</button>
          </div>
        </div>
        <div class="terminal-body" id="terminalLogs">Đang kết nối tới stream log...</div>
      </div>
    </div>
  </div>

  <!-- MODAL 1: EVIDENCE FILES & BUG DETAIL AUDIT REPORT -->
  <div class="modal-overlay" id="detailModal">
    <div class="modal-content">
      <div class="modal-head">
        <div class="modal-title" id="modalTitle">🔍 Báo Cáo Chi Tiết Xử Lý Bug</div>
        <button class="btn-close" onclick="closeDetailModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-subtabs">
          <button class="modal-subtab active" id="subtabOverview" onclick="switchModalSubtab('overview')">📋 Thông Tin Kỹ Thuật</button>
          <button class="modal-subtab" id="subtabComm" onclick="switchModalSubtab('comm')">💬 Dòng Giao Tiếp Agent</button>
          <button class="modal-subtab" id="subtabBefore" onclick="switchModalSubtab('before')">🔍 Bằng Chứng Tái Hiện (Before)</button>
          <button class="modal-subtab" id="subtabAfter" onclick="switchModalSubtab('after')">✅ Bằng Chứng Sau Fix (After)</button>
        </div>

        <div id="modalSecOverview">
          <div class="bug-details-grid" id="modalMetaGrid"></div>
          <div style="font-weight: 700; margin-top: 14px; font-size: 13px;">Tóm tắt nội dung lỗi:</div>
          <div class="code-snippet-box" id="modalSummaryBox">...</div>
        </div>

        <div id="modalSecComm" style="display: none;">
          <div class="comm-list" id="modalCommList" style="max-height: 380px;"></div>
        </div>

        <div id="modalSecBefore" style="display: none;">
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
            Các tệp log, stack trace và ảnh chụp màn hình ghi nhận khi Agent Analyzer tái hiện lỗi:
          </div>
          <div class="evidence-grid" id="modalBeforeGrid"></div>
          <div id="modalBeforeSnippets"></div>
        </div>

        <div id="modalSecAfter" style="display: none;">
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
            Các tệp kết quả chạy test JaCoCo coverage, verify build và ảnh giao diện sau khi khắc phục:
          </div>
          <div class="evidence-grid" id="modalAfterGrid"></div>
          <div id="modalAfterSnippets"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL 2: WORKSPACE MANAGER WITH VISUAL SERVICES BUILDER -->
  <div class="modal-overlay" id="wsManagerModal">
    <div class="modal-content" style="max-width: 1100px;">
      <div class="modal-head">
        <div class="modal-title">⚙️ Quản Lý Cấu Hình Workspaces & Services</div>
        <button class="btn-close" onclick="closeWsManagerModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-subtabs">
          <button class="modal-subtab active" id="wsSubtabList" onclick="switchWsSubtab('list')">📋 Danh Sách & Chỉnh Sửa</button>
          <button class="modal-subtab" id="wsSubtabJson" onclick="switchWsSubtab('json')">📝 Sửa File JSON Trực Tiếp</button>
        </div>

        <!-- Tab 1: Danh Sách & Form Thêm/Sửa -->
        <div id="wsTabSecList">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 12.5px; color: var(--text-muted);">
              Mỗi workspace đại diện cho 1 dự án (monorepo hoặc microservices). Trên cùng 1 workspace chỉ chạy 1 luồng cùng lúc.
            </div>
            <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="showNewWorkspaceForm()">➕ Thêm Workspace Mới</button>
          </div>

          <table class="ws-table">
            <thead>
              <tr>
                <th>Trạng Thái</th>
                <th>Mã / Tên Workspace</th>
                <th>Thư Mục Local (Root)</th>
                <th>Dự Án Jira</th>
                <th>Số Services</th>
                <th>Thao Tác</th>
              </tr>
            </thead>
            <tbody id="wsTableBody"></tbody>
          </table>

          <!-- Form Thêm / Sửa Workspace -->
          <div id="wsEditFormContainer" style="display: none; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-top: 18px;">
            <h3 style="font-size: 14px; font-weight: 800; margin-bottom: 14px; color: var(--primary);" id="wsFormTitle">➕ Thêm Workspace Mới</h3>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label class="form-label">ID Workspace (duy nhất, vd: bankhub, shop):</label>
                <input type="text" class="form-input" id="inpWsId" placeholder="bankhub">
              </div>
              <div class="form-group">
                <label class="form-label">Tên hiển thị dự án:</label>
                <input type="text" class="form-input" id="inpWsName" placeholder="PartnerHub Bank Platform">
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px;">
              <div class="form-group">
                <label class="form-label">Đường dẫn thư mục Local (workspaceRoot):</label>
                <input type="text" class="form-input" id="inpWsRoot" placeholder="D:/Project/BankHub/services hoặc services">
              </div>
              <div class="form-group">
                <label class="form-label">Mã dự án Jira (vd: PHUB, BANKHUB):</label>
                <input type="text" class="form-input" id="inpWsJiraKeys" placeholder="PHUB">
              </div>
            </div>

            <!-- Visual Services Builder Section -->
            <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div>
                  <h4 style="font-size: 13px; font-weight: 800; display: flex; align-items: center; gap: 6px;">
                    🧩 Cấu Hình Danh Sách Services (<span id="svcCountText">0</span>)
                  </h4>
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                    Cấu hình từng microservice trực quan với Git Repo, Lệnh Test và Mapping Jira.
                  </div>
                </div>
                <div style="display: flex; gap: 8px;">
                  <button class="btn btn-outline" style="padding: 4px 10px; font-size: 11px;" onclick="toggleServiceMode()" id="btnToggleSvcMode">📝 Chuyển sang JSON</button>
                  <button class="btn btn-primary" style="padding: 4px 10px; font-size: 11px;" onclick="showAddServiceForm()">➕ Thêm Service</button>
                </div>
              </div>

              <!-- Visual Services Cards List -->
              <div id="visualServicesListContainer"></div>

              <!-- Inline Service Edit Form (Sub-form) -->
              <div id="serviceEditForm" style="display: none; background: var(--card); border: 2px solid var(--primary); border-radius: 8px; padding: 14px; margin-bottom: 14px;">
                <h5 style="font-size: 12.5px; font-weight: 800; color: var(--primary); margin-bottom: 10px;" id="svcFormTitle">➕ Thêm / Chỉnh Sửa Service</h5>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                  <div class="form-group">
                    <label class="form-label">Tên Service (*):
                      <span class="field-hint" title="Tên định danh chuẩn của service (vd: bankhub-admin-be). Dùng để khớp với nhãn service: trên Jira.">?
                        <span class="tooltip-text"><b>Tên Service</b>: Khớp với nhãn <code>service:&lt;tên&gt;</code> trên Jira và định danh module cho AI.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcName" placeholder="bankhub-admin-be" title="Tên định danh chuẩn của service (khớp nhãn Jira)">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Thư mục con (folder):
                      <span class="field-hint" title="Thư mục chứa mã nguồn service trong workspaceRoot (vd: bankhub-admin-be). Git Repo sẽ tự động được nhận diện từ remote của thư mục này.">?
                        <span class="tooltip-text"><b>Thư mục mã nguồn</b>: Đường dẫn tương đối từ workspaceRoot. Git Repo sẽ tự động nhận diện từ thư mục này.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcFolder" placeholder="bankhub-admin-be" title="Thư mục con chứa source code (Git repo tự động xác định)">
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                  <div class="form-group">
                    <label class="form-label">Nhánh target (*):
                      <span class="field-hint" title="Nhánh đích mà AI sẽ tạo nhánh hotfix/ từ đó và mở Pull Request merge vào (vd: dev-auto-bug hoặc staging).">?
                        <span class="tooltip-text"><b>Nhánh Target</b>: AI sẽ tạo nhánh <code>hotfix/</code> từ nhánh này và gửi Pull Request về đây.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcBranchTarget" placeholder="dev-auto-bug (hoặc staging)" title="Nhánh đích nhận PR của AI">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Nhánh staging:
                      <span class="field-hint" title="Nhánh triển khai kiểm thử môi trường Staging/K8s tự động (vd: deploy/k8s-auto-bug).">?
                        <span class="tooltip-text"><b>Nhánh Staging</b>: Dùng cho pipeline CI/CD deploy tự động lên K8s/Staging.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcBranchStaging" placeholder="deploy/k8s-auto-bug" title="Nhánh deploy staging K8s">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Nhánh prod:
                      <span class="field-hint" title="Nhánh Production chính thức của sản phẩm (vd: main hoặc master).">?
                        <span class="tooltip-text"><b>Nhánh Prod</b>: Nhánh chính thức phục vụ người dùng cuối (đối chiếu phiên bản).</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcBranchProd" placeholder="main (hoặc master)" title="Nhánh production chính">
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                  <div class="form-group">
                    <label class="form-label">Nhánh source_target (tùy chọn, vd: dev):
                      <span class="field-hint" title="Nhánh nguồn gốc để worker tự động pull/sync code mới nhất vào nhánh target trước khi sửa.">?
                        <span class="tooltip-text"><b>Nhánh Nguồn Target</b>: Tự động đồng bộ code mới nhất từ nhánh này vào nhánh <code>target</code> để tránh conflict.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcBranchSourceTarget" placeholder="dev" title="Nhánh nguồn đồng bộ vào target">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Nhánh source_staging (tùy chọn, vd: deploy/k8s):
                      <span class="field-hint" title="Nhánh nguồn gốc để worker đồng bộ cấu hình K8s/Deploy vào nhánh staging.">?
                        <span class="tooltip-text"><b>Nhánh Nguồn Staging</b>: Tự động đồng bộ cấu hình deployment/k8s từ nhánh này sang nhánh <code>staging</code>.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcBranchSourceStaging" placeholder="deploy/k8s" title="Nhánh nguồn đồng bộ vào staging">
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                  <div class="form-group">
                    <label class="form-label">Jira Components:
                      <span class="field-hint" title="Tên các Component trên Jira thuộc service này, cách nhau bởi dấu phẩy.">?
                        <span class="tooltip-text"><b>Jira Components</b>: Danh sách Component trên Jira (vd: <code>Admin Backend, BE</code>) giúp AI tự nhận diện service khi thiếu label.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcComponents" placeholder="Admin Backend, BE" title="Danh sách Jira Component (ngăn cách dấu phẩy)">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Package Prefix (Stacktrace):
                      <span class="field-hint" title="Tiền tố package code Java/FE (vd: vn.bankhub.admin) để nhận diện service từ stacktrace lỗi Sentry.">?
                        <span class="tooltip-text"><b>Package Prefix</b>: Quét log/stacktrace Sentry để tự động ánh xạ lỗi về đúng service này (vd: <code>vn.bankhub.admin</code>).</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcPkgPrefix" placeholder="vn.bankhub.admin" title="Tiền tố package mã nguồn để bắt lỗi từ stacktrace">
                  </div>
                  <div class="form-group">
                    <label class="form-label">Aliases (Từ khóa gợi nhớ):
                      <span class="field-hint" title="Các tên gọi phụ hoặc từ khóa xuất hiện trong Summary/Description của ticket Jira để AI tìm đúng service.">?
                        <span class="tooltip-text"><b>Từ khóa gợi nhớ</b>: Các tên gọi khác (vd: <code>admin-be, admin-service</code>) giúp AI khớp ticket kể cả khi không có nhãn hoặc component.</span>
                      </span>
                    </label>
                    <input type="text" class="form-input" id="inpSvcAliases" placeholder="admin-be, admin-service" title="Từ khóa gợi nhớ phụ trong tiêu đề hoặc mô tả Jira">
                  </div>
                </div>

                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
                  <button class="btn btn-outline" style="padding: 5px 12px; font-size: 11.5px;" onclick="cancelServiceEdit()">Hủy Bỏ</button>
                  <button class="btn btn-primary" style="padding: 5px 12px; font-size: 11.5px;" onclick="saveSingleService()">Lưu Service Này</button>
                </div>
              </div>

              <!-- Raw Services Textarea (Ẩn khi ở Visual Mode) -->
              <div id="rawServicesJsonContainer" style="display: none;">
                <textarea class="form-input" id="inpWsServicesJson" style="height: 140px; font-family: monospace; font-size: 11.5px;" oninput="syncJsonToVisualServices()"></textarea>
              </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);">
              <button class="btn btn-outline" onclick="cancelWsEdit()">Đóng Form</button>
              <button class="btn btn-primary" onclick="saveWorkspaceForm()">💾 Lưu Toàn Bộ Workspace</button>
            </div>
          </div>
        </div>

        <!-- Tab 2: Sửa JSON trực tiếp -->
        <div id="wsTabSecJson" style="display: none;">
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
            Chỉnh sửa trực tiếp file <code>workspaces.json</code>. Cấu hình sẽ được validate cú pháp JSON trước khi lưu.
          </div>
          <textarea id="rawWsJsonTextarea" style="width: 100%; height: 380px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; color: #a5f3fc; font-family: monospace; font-size: 12px; padding: 12px; line-height: 1.4; outline: none;"></textarea>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
            <div style="font-size: 11px; color: var(--text-muted);">Thay đổi sẽ có hiệu lực ngay trong chu kỳ quét Jira kế tiếp.</div>
            <button class="btn btn-primary" onclick="saveRawWorkspacesJson()">💾 Lưu Cấu Hình JSON</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let allFixedBugs = [];
    let currentBugDetail = null;
    let allWorkspaces = [];
    let currentSelectedSessionWsId = null;
    let rawWorkspacesData = null;

    let currentEditingServices = [];
    let currentEditingServiceIndex = -1;
    let isServiceJsonMode = false;

    function initTheme() {
      const saved = localStorage.getItem('dashboard_theme') || 'dark';
      if (saved === 'light') {
        document.body.classList.add('light-theme');
        document.getElementById('themeBtn').innerHTML = '☀️ Chế độ Sáng';
      } else {
        document.body.classList.remove('light-theme');
        document.getElementById('themeBtn').innerHTML = '🌙 Chế độ Tối';
      }
    }

    function toggleTheme() {
      if (document.body.classList.contains('light-theme')) {
        document.body.classList.remove('light-theme');
        localStorage.setItem('dashboard_theme', 'dark');
        document.getElementById('themeBtn').innerHTML = '🌙 Chế độ Tối';
      } else {
        document.body.classList.add('light-theme');
        localStorage.setItem('dashboard_theme', 'light');
        document.getElementById('themeBtn').innerHTML = '☀️ Chế độ Sáng';
      }
    }

    function switchMainTab(tab) {
      document.getElementById('tabOffice').classList.remove('active');
      document.getElementById('tabHistory').classList.remove('active');
      document.getElementById('tabConsole').classList.remove('active');

      document.getElementById('officeViewSection').style.display = 'none';
      document.getElementById('historyViewSection').style.display = 'none';
      document.getElementById('consoleViewSection').style.display = 'none';

      if (tab === 'office') {
        document.getElementById('tabOffice').classList.add('active');
        document.getElementById('officeViewSection').style.display = 'block';
      } else if (tab === 'history') {
        document.getElementById('tabHistory').classList.add('active');
        document.getElementById('historyViewSection').style.display = 'block';
        loadFixedBugs();
      } else if (tab === 'console') {
        document.getElementById('tabConsole').classList.add('active');
        document.getElementById('consoleViewSection').style.display = 'block';
        fetchLogs();
      }
    }

    async function loadWorkspaces() {
      try {
        const res = await fetch('/api/workspaces');
        const data = await res.json();
        rawWorkspacesData = data;
        allWorkspaces = data.workspaces || [];
        document.getElementById('concurrencySummary').innerText = 'Tối đa ' + (data.maxConcurrentJobs || 3) + ' luồng song song | ' + allWorkspaces.length + ' Workspaces';
        renderWorkspaceMatrix(allWorkspaces, {});
      } catch (e) {}
    }

    function renderWorkspaceMatrix(workspaces, activeSessions) {
      const container = document.getElementById('wsMatrixContainer');
      if (!workspaces || workspaces.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px;">Chưa cấu hình workspace nào. Bấm [⚙️ Quản Lý Workspaces] để thêm.</div>';
        return;
      }

      let html = '';
      for (const ws of workspaces) {
        const wsKey = ws.id;
        const isEnabled = ws.enabled !== false;
        const session = activeSessions[wsKey] || Object.values(activeSessions).find(s => s.workspaceKey === wsKey);
        const isBusy = !!session && session.ticketKey;

        let lockClass = 'lock-FREE';
        let lockText = 'SẴN SÀNG (FREE)';
        if (!isEnabled) {
          lockClass = 'lock-DISABLED';
          lockText = 'TẠM DỪNG (OFF)';
        } else if (isBusy) {
          lockClass = 'lock-BUSY';
          lockText = 'ĐANG FIX: ' + session.ticketKey;
        }

        const cardActive = (currentSelectedSessionWsId === wsKey) ? ' active-session' : '';
        const disabledClass = !isEnabled ? ' disabled-ws' : '';
        const keysStr = ((ws.jira && ws.jira.projectKeys) || []).join(', ') || 'N/A';
        const svcCount = (ws.services || []).length;

        html += '<div class="ws-card' + cardActive + disabledClass + '" data-wsid="' + escapeHtml(wsKey) + '" onclick="onSelectWsClick(this)">' +
          '<div class="ws-card-top">' +
            '<div class="ws-card-name">🏢 ' + escapeHtml(ws.name || wsKey) + '</div>' +
            '<span class="ws-lock-tag ' + lockClass + '">' + lockText + '</span>' +
          '</div>' +
          '<div class="ws-card-desc">' + escapeHtml(ws.workspaceRoot || '') + '</div>' +
          '<div class="ws-card-meta">' +
            '<span>Jira: <b>' + keysStr + '</b></span>' +
            '<span>Services: <b>' + svcCount + '</b></span>' +
            (isBusy ? '<span style="color:#60a5fa">Service: <b>' + escapeHtml(session.service || '') + '</b></span>' : '') +
          '</div>' +
        '</div>';
      }
      container.innerHTML = html;
    }

    function onSelectWsClick(el) {
      const wsId = el.getAttribute('data-wsid');
      if (wsId) selectWorkspaceSession(wsId);
    }

    function selectWorkspaceSession(wsId) {
      currentSelectedSessionWsId = wsId;
      pollAgentsStatus();
    }

    async function pollAgentsStatus() {
      try {
        const res = await fetch('/api/agents-status');
        const data = await res.json();

        document.getElementById('lastSyncTime').innerText = 'Cập nhật: ' + new Date().toLocaleTimeString();

        const activeSessions = data.activeSessions || {};
        const sessionKeys = Object.keys(activeSessions);

        renderWorkspaceMatrix(allWorkspaces, activeSessions);

        const sessionTabsContainer = document.getElementById('sessionTabsList');
        if (sessionKeys.length > 0) {
          document.getElementById('sessionSelectorBar').style.display = 'flex';
          let sTabsHtml = '';
          for (const k of sessionKeys) {
            const sess = activeSessions[k];
            const isSel = (currentSelectedSessionWsId === k) || (!currentSelectedSessionWsId && k === sessionKeys[0]);
            if (isSel && !currentSelectedSessionWsId) currentSelectedSessionWsId = k;
            const actClass = isSel ? ' active' : '';
            sTabsHtml += '<button class="session-tab-btn' + actClass + '" data-wsid="' + escapeHtml(k) + '" onclick="onSelectWsClick(this)">' +
              '⚡ ' + escapeHtml(sess.projectName || k) + ': <b>' + escapeHtml(sess.ticketKey || '') + '</b>' +
            '</button>';
          }
          sessionTabsContainer.innerHTML = sTabsHtml;
        } else {
          document.getElementById('sessionSelectorBar').style.display = 'none';
        }

        let displayData = data;
        if (currentSelectedSessionWsId && activeSessions[currentSelectedSessionWsId]) {
          displayData = activeSessions[currentSelectedSessionWsId];
        }

        if (displayData.ticketKey || displayData.activeTicket) {
          const tKey = displayData.ticketKey || displayData.activeTicket;
          document.getElementById('activeServiceText').innerText = (displayData.projectName ? '[' + displayData.projectName + '] ' : '') + 'Service: ' + (displayData.service || 'N/A') + ' — ' + (displayData.summary || '');
          document.getElementById('currentSessionTitle').innerHTML = 'Quy Trình Xử Lý Ticket: <b style="color:var(--primary);">' + tKey + '</b>';
        } else {
          document.getElementById('activeServiceText').innerText = 'Chờ Jira defect mới trên các Workspace...';
          document.getElementById('currentSessionTitle').innerText = 'Quy Trình 5 Bước Giải Quyết Defect Khép Kín';
        }

        const agents = displayData.agents || {};
        updateSingleAgentUI('Leader', agents.leader);
        updateSingleAgentUI('Analyzer', agents.analyzer);
        updateSingleAgentUI('Coder', agents.coder);
        updateSingleAgentUI('Tester', agents.tester);
        updateSingleAgentUI('Devops', agents.devops);

        updateSvgBus(agents);
        updateWorkflowSteps(agents);
        updateCommFeed(displayData.communications || data.communications || []);

      } catch (e) {}
    }

    function updateSingleAgentUI(key, agent) {
      if (!agent) return;
      const card = document.getElementById('card' + key);
      const tag = document.getElementById('tag' + key);
      const action = document.getElementById('action' + key);

      const st = agent.status || 'IDLE';

      if (card) {
        card.className = 'agent-card' + (key === 'Leader' ? ' leader-card' : '') + ' status-' + st;
      }
      if (tag) {
        tag.className = 'status-tag tag-' + st;
        tag.innerText = st;
      }
      if (action) {
        action.innerText = agent.currentAction || 'Sẵn sàng';
      }
    }

    function updateSvgBus(agents) {
      setLineActive('lineLeaderToAnalyzer', agents.analyzer && agents.analyzer.status === 'WORKING');
      setLineActive('lineLeaderToCoder', agents.coder && agents.coder.status === 'WORKING');
      setLineActive('lineLeaderToTester', agents.tester && agents.tester.status === 'WORKING');
      setLineActive('lineLeaderToDevops', agents.devops && agents.devops.status === 'WORKING');
    }

    function setLineActive(lineId, isActive) {
      const line = document.getElementById(lineId);
      if (!line) return;
      if (isActive) {
        line.setAttribute('stroke', '#3b82f6');
        line.setAttribute('stroke-width', '3');
        line.setAttribute('stroke-dasharray', '8,4');
      } else {
        line.setAttribute('stroke', 'var(--border)');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '6,6');
      }
    }

    function updateWorkflowSteps(agents) {
      setWfStep('wfStep1', agents.leader ? agents.leader.status : 'IDLE');
      setWfStep('wfStep2', agents.analyzer ? agents.analyzer.status : 'IDLE');
      setWfStep('wfStep3', agents.coder ? agents.coder.status : 'IDLE');
      setWfStep('wfStep4', agents.tester ? agents.tester.status : 'IDLE');
      setWfStep('wfStep5', agents.devops ? agents.devops.status : 'IDLE');
    }

    function setWfStep(stepId, status) {
      const el = document.getElementById(stepId);
      if (!el) return;
      el.className = 'wf-step';
      if (status === 'WORKING' || status === 'WAITING_SHELL') el.classList.add('active');
      else if (status === 'SUCCESS') el.classList.add('success');
      else if (status === 'FAILED') el.classList.add('failed');
    }

    function updateCommFeed(items) {
      const listEl = document.getElementById('commList');
      document.getElementById('commCountText').innerText = items.length + ' bản tin';
      if (!items || items.length === 0) return;

      let html = '';
      for (const item of items) {
        const fromIcon = getAgentIcon(item.from);
        const toIcon = getAgentIcon(item.to);
        const fromName = getAgentName(item.from);
        const toName = getAgentName(item.to);

        html += '<div class="comm-item">' +
          '<div class="comm-meta">' +
            '<div class="comm-nodes">' + fromIcon + ' ' + fromName + ' ➔ ' + toIcon + ' ' + toName + '</div>' +
            '<div>' + (item.timestamp || '') + ' ' + (item.phase ? '<span style="color:var(--primary)">[' + item.phase + ']</span>' : '') + '</div>' +
          '</div>' +
          '<div class="comm-content">' + escapeHtml(item.message) + '</div>' +
        '</div>';
      }
      listEl.innerHTML = html;
    }

    function getAgentIcon(role) {
      if (role === 'leader') return '👑';
      if (role === 'analyzer') return '🔍';
      if (role === 'coder') return '💻';
      if (role === 'tester') return '🧪';
      if (role === 'devops') return '🚀';
      return '🤖';
    }

    function getAgentName(role) {
      if (role === 'leader') return 'Leader';
      if (role === 'analyzer') return 'Analyzer';
      if (role === 'coder') return 'Coder';
      if (role === 'tester') return 'QA Tester';
      if (role === 'devops') return 'DevOps';
      return role || 'System';
    }

    // Fixed Bugs History
    async function loadFixedBugs() {
      try {
        const res = await fetch('/api/fixed-bugs');
        allFixedBugs = await res.json();
        document.getElementById('fixedBugCountBadge').innerText = allFixedBugs.length;
        renderBugsList(allFixedBugs);
      } catch (e) {
        document.getElementById('bugsListContainer').innerHTML = '<div style="color:var(--danger); text-align:center; grid-column:1/-1;">Lỗi tải lịch sử bug: ' + e.message + '</div>';
      }
    }

    function filterBugsList() {
      const q = (document.getElementById('searchBugInput').value || '').toLowerCase().trim();
      if (!q) {
        renderBugsList(allFixedBugs);
        return;
      }
      const filtered = allFixedBugs.filter(b => 
        (b.issueKey && b.issueKey.toLowerCase().includes(q)) ||
        (b.summary && b.summary.toLowerCase().includes(q)) ||
        (b.service && b.service.toLowerCase().includes(q)) ||
        (b.status && b.status.toLowerCase().includes(q))
      );
      renderBugsList(filtered);
    }

    function renderBugsList(bugs) {
      const container = document.getElementById('bugsListContainer');
      if (!bugs || bugs.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; grid-column:1/-1; padding: 40px;">Không tìm thấy bug nào phù hợp.</div>';
        return;
      }

      let html = '';
      for (const b of bugs) {
        const isOk = b.status === 'RESOLVED';
        const isUnknown = b.status === 'UNKNOWN';
        const stClass = isOk ? 'tag-SUCCESS' : (isUnknown ? 'tag-IDLE' : 'tag-FAILED');
        const stText = isOk ? 'ĐÃ FIX & MERGE' : (isUnknown ? 'KHÔNG XÁC ĐỊNH' : 'THẤT BẠI');

        html += '<div class="bug-card">' +
          '<div>' +
            '<div class="bug-card-top">' +
              '<span class="bug-key-badge">' + escapeHtml(b.issueKey) + '</span>' +
              '<span class="status-tag ' + stClass + '">' + stText + '</span>' +
            '</div>' +
            '<div class="bug-summary">' + escapeHtml(b.summary || 'Không có tóm tắt') + '</div>' +
            '<div class="bug-details-grid">' +
              '<div class="bug-detail-row"><span class="bug-detail-lbl">Dịch Vụ</span><span class="bug-detail-val">' + escapeHtml(b.service || 'N/A') + '</span></div>' +
              '<div class="bug-detail-row"><span class="bug-detail-lbl">Coverage</span><span class="bug-detail-val">' + escapeHtml(b.coverage || 'N/A') + '</span></div>' +
              '<div class="bug-detail-row"><span class="bug-detail-lbl">Branch Merge</span><span class="bug-detail-val">' + escapeHtml(b.deployedBranch || b.baseBranch || 'N/A') + '</span></div>' +
              '<div class="bug-detail-row"><span class="bug-detail-lbl">Pipeline</span><span class="bug-detail-val">' + escapeHtml(b.ciStatus || 'N/A') + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="bug-card-actions">' +
            '<div style="font-size: 11px; color: var(--text-muted);">' + (b.completedAt ? new Date(b.completedAt).toLocaleString() : '') + '</div>' +
            '<div style="display: flex; gap: 6px;">' +
              '<button class="btn btn-outline" style="padding: 6px 12px; font-size: 11.5px;" data-ticket="' + escapeHtml(b.issueKey) + '" onclick="onViewBugClick(this)">🔍 Chi Tiết</button>' +
              '<button class="btn btn-danger" style="padding: 6px 10px; font-size: 11.5px;" data-ticket="' + escapeHtml(b.issueKey) + '" onclick="onDeleteBugClick(this)" title="Ẩn/Xóa ticket này khỏi lịch sử">🗑️</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }
      container.innerHTML = html;
    }

    function onViewBugClick(btn) {
      const ticket = btn.getAttribute('data-ticket');
      if (ticket) viewBugDetail(ticket);
    }

    async function onDeleteBugClick(btn) {
      const ticket = btn.getAttribute('data-ticket');
      if (!ticket) return;
      if (!confirm('Bạn có chắc chắn muốn ẩn/xóa ticket ' + ticket + ' khỏi danh sách lịch sử không?')) return;
      try {
        const res = await fetch('/api/delete-bug-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: ticket })
        });
        const data = await res.json();
        loadFixedBugs();
      } catch (e) {
        alert('Lỗi xóa ticket: ' + e.message);
      }
    }

    async function clearAllBugHistory() {
      if (!confirm('Bạn có chắc chắn muốn xóa/ẩn TOÀN BỘ lịch sử các bug đã fix không?')) return;
      try {
        const res = await fetch('/api/delete-bug-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true })
        });
        const data = await res.json();
        loadFixedBugs();
      } catch (e) {
        alert('Lỗi xóa lịch sử: ' + e.message);
      }
    }

    async function restoreHiddenBugs() {
      if (!confirm('Khôi phục lại tất cả các ticket đã bị ẩn/xóa?')) return;
      try {
        const res = await fetch('/api/restore-bug-history', { method: 'POST' });
        const data = await res.json();
        alert(data.message);
        loadFixedBugs();
      } catch (e) {
        alert('Lỗi khôi phục: ' + e.message);
      }
    }

    async function viewBugDetail(ticketKey) {
      try {
        const res = await fetch('/api/bug-detail?ticket=' + encodeURIComponent(ticketKey));
        currentBugDetail = await res.json();

        document.getElementById('modalTitle').innerHTML = '🔍 Báo Cáo Chi Tiết: <span style="color:var(--primary); margin-left:6px;">' + escapeHtml(currentBugDetail.issueKey) + '</span>';
        document.getElementById('modalSummaryBox').innerText = currentBugDetail.summary || 'Không có tóm tắt';

        const metaGrid = document.getElementById('modalMetaGrid');
        const stOk = currentBugDetail.status === 'RESOLVED';
        const stColor = stOk ? 'var(--success)' : 'var(--danger)';
        const stLabel = stOk ? 'ĐÃ FIX & MERGE' : 'THẤT BẠI';
        let metaHtml =
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Trạng Thái</span><span class="bug-detail-val" style="color:' + stColor + '; font-weight:700;">' + stLabel + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Jira Issue</span><span class="bug-detail-val"><a href="' + (currentBugDetail.jiraUrl || 'https://jira.cybertech.vn/browse/' + currentBugDetail.issueKey) + '" target="_blank" style="color:var(--primary)">' + escapeHtml(currentBugDetail.issueKey) + ' ↗</a></span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Dịch Vụ</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.service || 'N/A') + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Git Repository</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.gitRepo || 'N/A') + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Hotfix Branch</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.branchName || 'N/A') + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Branch Merge</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.deployedBranch || currentBugDetail.baseBranch || 'N/A') + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">JaCoCo Coverage</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.coverage || 'N/A') + '</span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">Commit Hash</span><span class="bug-detail-val"><code>' + escapeHtml(currentBugDetail.commitHash || 'N/A') + '</code></span></div>' +
          '<div class="bug-detail-row"><span class="bug-detail-lbl">CI/CD Pipeline</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.ciStatus || 'N/A') + '</span></div>';
        if (!stOk && (currentBugDetail.failedStep || currentBugDetail.errorReason)) {
          metaHtml +=
            '<div class="bug-detail-row" style="grid-column:1/-1;"><span class="bug-detail-lbl">Bước thất bại</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.failedStep || 'N/A') + '</span></div>' +
            '<div class="bug-detail-row" style="grid-column:1/-1;"><span class="bug-detail-lbl">Lý do</span><span class="bug-detail-val">' + escapeHtml(currentBugDetail.errorReason || 'N/A') + '</span></div>';
        }
        metaGrid.innerHTML = metaHtml;

        const commList = document.getElementById('modalCommList');
        if (currentBugDetail.communications && currentBugDetail.communications.length > 0) {
          let cHtml = '';
          for (const item of currentBugDetail.communications) {
            cHtml += '<div class="comm-item">' +
              '<div class="comm-meta">' +
                '<div class="comm-nodes">' + getAgentIcon(item.from) + ' ' + getAgentName(item.from) + ' ➔ ' + getAgentIcon(item.to) + ' ' + getAgentName(item.to) + '</div>' +
                '<div>' + (item.timestamp || '') + ' ' + (item.phase ? '[' + item.phase + ']' : '') + '</div>' +
              '</div>' +
              '<div class="comm-content">' + escapeHtml(item.message) + '</div>' +
            '</div>';
          }
          commList.innerHTML = cHtml;
        } else {
          commList.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px;">Không có ghi nhận đối thoại riêng cho ticket này.</div>';
        }

        renderPhaseEvidence('before', currentBugDetail.evidence ? currentBugDetail.evidence.before : [], currentBugDetail.textSnippets || {});
        renderPhaseEvidence('after', currentBugDetail.evidence ? currentBugDetail.evidence.after : [], currentBugDetail.textSnippets || {});

        switchModalSubtab('overview');
        document.getElementById('detailModal').style.display = 'flex';
      } catch (e) {
        alert('Lỗi mở chi tiết bug: ' + e.message);
      }
    }

    function renderPhaseEvidence(phase, files, snippets) {
      const grid = document.getElementById(phase === 'before' ? 'modalBeforeGrid' : 'modalAfterGrid');
      const snip = document.getElementById(phase === 'before' ? 'modalBeforeSnippets' : 'modalAfterSnippets');

      grid.innerHTML = '';
      snip.innerHTML = '';

      if (!files || files.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-muted); padding:10px;">Không có tệp bằng chứng nào ở phase này.</div>';
        return;
      }

      for (const f of files) {
        const fileUrl = '/api/evidence-file?ticket=' + encodeURIComponent(currentBugDetail.issueKey) + '&phase=' + phase + '&file=' + encodeURIComponent(f.name);
        const card = document.createElement('div');
        card.className = 'evidence-thumb';
        card.setAttribute('data-url', fileUrl);
        card.onclick = function() { window.open(this.getAttribute('data-url'), '_blank'); };

        if (f.isImage) {
          card.innerHTML = '<img src="' + fileUrl + '" alt="' + f.name + '"><div style="font-size:11px; word-break:break-all;">' + f.name + '</div>';
        } else {
          const icon = phase === 'before' ? '📄' : '📊';
          card.innerHTML = '<div style="font-size:32px; margin: 10px 0;">' + icon + '</div><div style="font-size:11px; word-break:break-all;">' + f.name + '</div><div style="font-size:10px; color:var(--text-muted);">' + (f.size/1024).toFixed(1) + ' KB</div>';
        }
        grid.appendChild(card);

        const snipKey = phase + '/' + f.name;
        if (snippets[snipKey]) {
          const sBox = document.createElement('div');
          sBox.style.marginTop = '14px';
          sBox.innerHTML = '<div style="font-weight:700; font-size:12px; color:var(--primary); margin-bottom:4px;">Nội dung ' + f.name + ':</div><div class="code-snippet-box">' + escapeHtml(snippets[snipKey]) + '</div>';
          snip.appendChild(sBox);
        }
      }
    }

    function switchModalSubtab(sub) {
      document.getElementById('subtabOverview').classList.remove('active');
      document.getElementById('subtabComm').classList.remove('active');
      document.getElementById('subtabBefore').classList.remove('active');
      document.getElementById('subtabAfter').classList.remove('active');

      document.getElementById('modalSecOverview').style.display = 'none';
      document.getElementById('modalSecComm').style.display = 'none';
      document.getElementById('modalSecBefore').style.display = 'none';
      document.getElementById('modalSecAfter').style.display = 'none';

      if (sub === 'overview') {
        document.getElementById('subtabOverview').classList.add('active');
        document.getElementById('modalSecOverview').style.display = 'block';
      } else if (sub === 'comm') {
        document.getElementById('subtabComm').classList.add('active');
        document.getElementById('modalSecComm').style.display = 'block';
      } else if (sub === 'before') {
        document.getElementById('subtabBefore').classList.add('active');
        document.getElementById('modalSecBefore').style.display = 'block';
      } else if (sub === 'after') {
        document.getElementById('subtabAfter').classList.add('active');
        document.getElementById('modalSecAfter').style.display = 'block';
      }
    }

    function closeDetailModal() {
      document.getElementById('detailModal').style.display = 'none';
    }

    // ========================================================
    // WORKSPACE MANAGER & VISUAL SERVICES BUILDER LOGIC
    // ========================================================
    function openWsManagerModal() {
      document.getElementById('wsManagerModal').style.display = 'flex';
      switchWsSubtab('list');
      renderWsTable();
      document.getElementById('rawWsJsonTextarea').value = JSON.stringify(rawWorkspacesData || { maxConcurrentJobs: 3, workspaces: allWorkspaces }, null, 2);
    }

    function closeWsManagerModal() {
      document.getElementById('wsManagerModal').style.display = 'none';
    }

    function switchWsSubtab(tab) {
      document.getElementById('wsSubtabList').classList.remove('active');
      document.getElementById('wsSubtabJson').classList.remove('active');
      document.getElementById('wsTabSecList').style.display = 'none';
      document.getElementById('wsTabSecJson').style.display = 'none';

      if (tab === 'list') {
        document.getElementById('wsSubtabList').classList.add('active');
        document.getElementById('wsTabSecList').style.display = 'block';
        renderWsTable();
      } else if (tab === 'json') {
        document.getElementById('wsSubtabJson').classList.add('active');
        document.getElementById('wsTabSecJson').style.display = 'block';
        document.getElementById('rawWsJsonTextarea').value = JSON.stringify(rawWorkspacesData || { maxConcurrentJobs: 3, workspaces: allWorkspaces }, null, 2);
      }
    }

    function renderWsTable() {
      const tbody = document.getElementById('wsTableBody');
      if (!allWorkspaces || allWorkspaces.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">Chưa có workspace nào.</td></tr>';
        return;
      }

      let html = '';
      for (const ws of allWorkspaces) {
        const isEnabled = ws.enabled !== false;
        const toggleBtnText = isEnabled ? '🟢 Đang Bật' : '⚪ Đang Tắt';
        const toggleBtnClass = isEnabled ? 'btn-outline' : 'btn-danger';
        const keysStr = ((ws.jira && ws.jira.projectKeys) || []).join(', ') || 'N/A';
        const svcCount = (ws.services || []).length;

        html += '<tr>' +
          '<td><button class="btn ' + toggleBtnClass + '" style="padding:4px 8px; font-size:11px;" data-wsid="' + escapeHtml(ws.id) + '" data-enabled="' + (!isEnabled) + '" onclick="onToggleWsClick(this)">' + toggleBtnText + '</button></td>' +
          '<td><b>' + escapeHtml(ws.name || ws.id) + '</b><br><span style="font-size:10px; color:var(--text-muted);">ID: ' + escapeHtml(ws.id) + '</span></td>' +
          '<td><code style="font-size:11px;">' + escapeHtml(ws.workspaceRoot || '') + '</code></td>' +
          '<td><span class="bug-key-badge" style="font-size:11px;">' + escapeHtml(keysStr) + '</span></td>' +
          '<td>' + svcCount + ' services</td>' +
          '<td>' +
            '<div style="display:flex; gap:6px;">' +
              '<button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" data-wsid="' + escapeHtml(ws.id) + '" onclick="onEditWsClick(this)">✏️ Sửa</button>' +
              '<button class="btn btn-danger" style="padding:4px 8px; font-size:11px;" data-wsid="' + escapeHtml(ws.id) + '" onclick="onDeleteWsClick(this)">🗑️ Xóa</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }
      tbody.innerHTML = html;
    }

    function onToggleWsClick(btn) {
      const wsId = btn.getAttribute('data-wsid');
      const nextState = btn.getAttribute('data-enabled') === 'true';
      toggleWorkspace(wsId, nextState);
    }

    async function toggleWorkspace(wsId, enabled) {
      try {
        const res = await fetch('/api/workspaces/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: wsId, enabled: enabled })
        });
        const data = await res.json();
        await loadWorkspaces();
        renderWsTable();
        pollAgentsStatus();
      } catch (e) {
        alert('Lỗi toggle: ' + e.message);
      }
    }

    function onDeleteWsClick(btn) {
      const wsId = btn.getAttribute('data-wsid');
      if (wsId) deleteWorkspace(wsId);
    }

    async function deleteWorkspace(wsId) {
      if (!confirm('Bạn có chắc chắn muốn xóa workspace [' + wsId + '] không?')) return;
      try {
        const res = await fetch('/api/workspaces/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: wsId })
        });
        const data = await res.json();
        alert(data.message);
        await loadWorkspaces();
        renderWsTable();
        pollAgentsStatus();
      } catch (e) {
        alert('Lỗi xóa: ' + e.message);
      }
    }

    function showNewWorkspaceForm() {
      document.getElementById('wsFormTitle').innerText = '➕ Thêm Workspace Mới';
      document.getElementById('inpWsId').value = '';
      document.getElementById('inpWsId').disabled = false;
      document.getElementById('inpWsName').value = '';
      document.getElementById('inpWsRoot').value = '';
      document.getElementById('inpWsJiraKeys').value = '';
      
      currentEditingServices = [];
      renderVisualServices();
      cancelServiceEdit();

      document.getElementById('wsEditFormContainer').style.display = 'block';
    }

    function onEditWsClick(btn) {
      const wsId = btn.getAttribute('data-wsid');
      const ws = allWorkspaces.find(w => w.id === wsId);
      if (!ws) return;

      document.getElementById('wsFormTitle').innerText = '✏️ Chỉnh Sửa Workspace: ' + ws.name;
      document.getElementById('inpWsId').value = ws.id;
      document.getElementById('inpWsId').disabled = true;
      document.getElementById('inpWsName').value = ws.name || '';
      document.getElementById('inpWsRoot').value = ws.workspaceRoot || '';
      document.getElementById('inpWsJiraKeys').value = ((ws.jira && ws.jira.projectKeys) || []).join(', ');
      
      currentEditingServices = JSON.parse(JSON.stringify(ws.services || []));
      renderVisualServices();
      cancelServiceEdit();

      document.getElementById('wsEditFormContainer').style.display = 'block';
    }

    function cancelWsEdit() {
      document.getElementById('wsEditFormContainer').style.display = 'none';
      cancelServiceEdit();
    }

    // ==========================================
    // VISUAL SERVICES BUILDER FUNCTIONS
    // ==========================================
    function renderVisualServices() {
      const container = document.getElementById('visualServicesListContainer');
      document.getElementById('svcCountText').innerText = currentEditingServices.length;
      document.getElementById('inpWsServicesJson').value = JSON.stringify(currentEditingServices, null, 2);

      if (!currentEditingServices || currentEditingServices.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:10px 0;">Chưa có service nào. Bấm <b>[➕ Thêm Service]</b> để thêm.</div>';
        return;
      }

      let html = '';
      currentEditingServices.forEach((s, idx) => {
        const comps = (s.jiraMapping && s.jiraMapping.components) ? s.jiraMapping.components.join(', ') : 'N/A';
        const targetBranch = (s.branches && s.branches.target) || 'master';
        const repoDisplay = s.gitRepo || '(Tự động nhận diện từ folder)';

        html += '<div class="svc-card">' +
          '<div class="svc-main-info">' +
            '<h4>📦 ' + escapeHtml(s.name) + ' <span style="font-size:11px; font-weight:normal; color:var(--text-muted);">(' + escapeHtml(s.folder || s.path || s.name) + ')</span></h4>' +
            '<div class="svc-meta-line">' +
              'Repo: <code>' + escapeHtml(repoDisplay) + '</code> | Branch Target: <b>' + escapeHtml(targetBranch) + '</b> | Components: <i>' + escapeHtml(comps) + '</i>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex; gap:6px;">' +
            '<button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="editSingleService(' + idx + ')">✏️ Sửa</button>' +
            '<button class="btn btn-danger" style="padding:4px 8px; font-size:11px;" onclick="deleteSingleService(' + idx + ')">🗑️</button>' +
          '</div>' +
        '</div>';
      });
      container.innerHTML = html;
    }

    function showAddServiceForm() {
      currentEditingServiceIndex = -1;
      document.getElementById('svcFormTitle').innerText = '➕ Thêm Service Mới';
      document.getElementById('inpSvcName').value = '';
      document.getElementById('inpSvcFolder').value = '';
      document.getElementById('inpSvcBranchTarget').value = 'dev-auto-bug';
      document.getElementById('inpSvcBranchStaging').value = 'deploy/k8s-auto-bug';
      document.getElementById('inpSvcBranchProd').value = 'main';
      document.getElementById('inpSvcBranchSourceTarget').value = '';
      document.getElementById('inpSvcBranchSourceStaging').value = '';
      document.getElementById('inpSvcComponents').value = '';
      document.getElementById('inpSvcPkgPrefix').value = '';
      document.getElementById('inpSvcAliases').value = '';
      document.getElementById('serviceEditForm').style.display = 'block';
    }

    function editSingleService(idx) {
      if (idx < 0 || idx >= currentEditingServices.length) return;
      currentEditingServiceIndex = idx;
      const s = currentEditingServices[idx];

      document.getElementById('svcFormTitle').innerText = '✏️ Chỉnh Sửa Service: ' + s.name;
      document.getElementById('inpSvcName').value = s.name || '';
      document.getElementById('inpSvcFolder').value = s.folder || s.path || '';

      const b = s.branches || {};
      document.getElementById('inpSvcBranchTarget').value = b.target || '';
      document.getElementById('inpSvcBranchStaging').value = b.staging || '';
      document.getElementById('inpSvcBranchProd').value = b.prod || '';
      document.getElementById('inpSvcBranchSourceTarget').value = b.source_target || '';
      document.getElementById('inpSvcBranchSourceStaging').value = b.source_staging || '';
      const jm = s.jiraMapping || {};
      document.getElementById('inpSvcComponents').value = (jm.components || []).join(', ');
      document.getElementById('inpSvcPkgPrefix').value = jm.packagePrefix || '';
      document.getElementById('inpSvcAliases').value = (jm.aliases || []).join(', ');

      document.getElementById('serviceEditForm').style.display = 'block';
    }

    function cancelServiceEdit() {
      document.getElementById('serviceEditForm').style.display = 'none';
      currentEditingServiceIndex = -1;
    }

    function saveSingleService() {
      const name = document.getElementById('inpSvcName').value.trim();
      const folder = document.getElementById('inpSvcFolder').value.trim() || name;

      if (!name) {
        alert('Vui lòng nhập Tên Service!');
        return;
      }

      const prev = currentEditingServiceIndex >= 0 ? (currentEditingServices[currentEditingServiceIndex] || {}) : {};
      const prevBranches = prev.branches || {};

      const branches = {
        ...prevBranches,
        target: document.getElementById('inpSvcBranchTarget').value.trim() || prevBranches.target || 'master',
        staging: document.getElementById('inpSvcBranchStaging').value.trim() || prevBranches.staging || 'staging',
        prod: document.getElementById('inpSvcBranchProd').value.trim() || prevBranches.prod || 'master'
      };
      delete branches.dev;

      const srcTarget = document.getElementById('inpSvcBranchSourceTarget').value.trim();
      if (srcTarget) branches.source_target = srcTarget;
      else delete branches.source_target;

      const srcStaging = document.getElementById('inpSvcBranchSourceStaging').value.trim();
      if (srcStaging) branches.source_staging = srcStaging;
      else delete branches.source_staging;

      const comps = document.getElementById('inpSvcComponents').value.split(',').map(s => s.trim()).filter(Boolean);
      const pkg = document.getElementById('inpSvcPkgPrefix').value.trim();
      const aliases = document.getElementById('inpSvcAliases').value.split(',').map(s => s.trim()).filter(Boolean);

      const svcObj = {
        ...prev,
        name,
        folder,
        branches,
        jiraMapping: {
          ...(prev.jiraMapping || {}),
          components: comps,
          packagePrefix: pkg,
          aliases: aliases
        }
      };
      delete svcObj.testCmd;
      delete svcObj.gitRepo;
      if (currentEditingServiceIndex >= 0) {
        currentEditingServices[currentEditingServiceIndex] = svcObj;
      } else {
        currentEditingServices.push(svcObj);
      }

      cancelServiceEdit();
      renderVisualServices();
    }

    function deleteSingleService(idx) {
      if (idx < 0 || idx >= currentEditingServices.length) return;
      if (!confirm('Xóa service [' + currentEditingServices[idx].name + '] khỏi workspace này?')) return;
      currentEditingServices.splice(idx, 1);
      cancelServiceEdit();
      renderVisualServices();
    }

    function toggleServiceMode() {
      isServiceJsonMode = !isServiceJsonMode;
      const visualBox = document.getElementById('visualServicesListContainer');
      const rawBox = document.getElementById('rawServicesJsonContainer');
      const btn = document.getElementById('btnToggleSvcMode');

      if (isServiceJsonMode) {
        btn.innerText = '🖥️ Chuyển sang Trực Quan';
        visualBox.style.display = 'none';
        rawBox.style.display = 'block';
        document.getElementById('inpWsServicesJson').value = JSON.stringify(currentEditingServices, null, 2);
      } else {
        btn.innerText = '📝 Chuyển sang JSON';
        syncJsonToVisualServices();
        visualBox.style.display = 'block';
        rawBox.style.display = 'none';
      }
    }

    function syncJsonToVisualServices() {
      const raw = document.getElementById('inpWsServicesJson').value.trim();
      try {
        currentEditingServices = raw ? JSON.parse(raw) : [];
        renderVisualServices();
      } catch (e) {}
    }

    async function saveWorkspaceForm() {
      const id = document.getElementById('inpWsId').value.trim();
      const name = document.getElementById('inpWsName').value.trim();
      const workspaceRoot = document.getElementById('inpWsRoot').value.trim();
      const keysRaw = document.getElementById('inpWsJiraKeys').value.trim();

      if (!id || !name || !workspaceRoot || !keysRaw) {
        alert('Vui lòng nhập đầy đủ: ID, Tên dự án, Thư mục Local và Mã Jira!');
        return;
      }

      const projectKeys = keysRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

      // Bảo toàn trạng thái enabled cũ nếu đang sửa workspace đã có
      const existing = allWorkspaces.find(w => w.id === id);
      const isEnabled = existing ? (existing.enabled !== false) : true;

      const wsPayload = {
        id,
        name,
        workspaceRoot,
        concurrencyLimit: 1,
        enabled: isEnabled,
        jira: {
          projectKeys: projectKeys,
          projectNames: [name]
        },
        services: currentEditingServices
      };

      try {
        const res = await fetch('/api/workspaces/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: wsPayload })
        });
        const data = await res.json();
        alert(data.message);
        cancelWsEdit();
        await loadWorkspaces();
        renderWsTable();
        pollAgentsStatus();
      } catch (e) {
        alert('Lỗi lưu: ' + e.message);
      }
    }

    async function saveRawWorkspacesJson() {
      const text = document.getElementById('rawWsJsonTextarea').value;
      let parsed;
      try {
        parsed = JSON.parse(text);
        if (!parsed.workspaces || !Array.isArray(parsed.workspaces)) {
          throw new Error('JSON bắt buộc phải có thuộc tính "workspaces" là một mảng.');
        }
      } catch (e) {
        alert('Lỗi cú pháp JSON: ' + e.message);
        return;
      }

      try {
        const res = await fetch('/api/workspaces/save-raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed)
        });
        const data = await res.json();
        alert(data.message);
        await loadWorkspaces();
        switchWsSubtab('list');
        pollAgentsStatus();
      } catch (e) {
        alert('Lỗi lưu raw JSON: ' + e.message);
      }
    }

    async function clearGlitchTipData() {
      if (!confirm('Bạn có chắc chắn muốn xóa sạch toàn bộ issues trên GlitchTip để bắt đầu kiểm thử lại không?')) return;
      try {
        const res = await fetch('/api/clear-glitchtip', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Đã xóa dữ liệu GlitchTip!');
      } catch (e) {
        alert('Lỗi: ' + e.message);
      }
    }

    async function controlWorker(action) {
      try {
        const res = await fetch('/api/' + action, { method: 'POST' });
        const data = await res.json();
        alert(data.message);
      } catch (e) {
        alert('Lỗi: ' + e.message);
      }
    }

    async function fetchLogs() {
      try {
        const res = await fetch('/api/logs');
        const text = await res.text();
        const el = document.getElementById('terminalLogs');
        el.innerText = text;
        if (document.getElementById('autoScroll').checked) {
          el.scrollTop = el.scrollHeight;
        }
      } catch (e) {}
    }

    async function clearLogs() {
      if (!confirm('Bạn có muốn xóa trắng tệp worker.log không?')) return;
      try {
        await fetch('/api/clear-logs', { method: 'POST' });
        fetchLogs();
      } catch (e) {}
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    initTheme();
    loadWorkspaces();
    pollAgentsStatus();
    loadFixedBugs();

    setInterval(() => {
      pollAgentsStatus();
      const consoleView = document.getElementById('consoleViewSection');
      if (consoleView && consoleView.style.display === 'block') {
        fetchLogs();
      }
    }, 2000);
  </script>
</body>
</html>`;
}

// 2. HTTP SERVER ROUTER
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // GET / -> Web Dashboard UI
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderDashboardHtml());
    }

    // GET /api/workspaces -> Danh sách các workspace
    if (req.method === 'GET' && url.pathname === '/api/workspaces') {
        const cfg = getWorkspacesConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(cfg));
    }

    // POST /api/workspaces/save -> Lưu 1 workspace (Thêm / Sửa)
    if (req.method === 'POST' && url.pathname === '/api/workspaces/save') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const targetWs = data.workspace;
                if (!targetWs || !targetWs.id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Missing workspace data or id' }));
                }

                const cfg = getWorkspacesConfig();
                const existingIdx = cfg.workspaces.findIndex(w => w.id === targetWs.id);
                if (existingIdx >= 0) {
                    cfg.workspaces[existingIdx] = { ...cfg.workspaces[existingIdx], ...targetWs };
                } else {
                    cfg.workspaces.push(targetWs);
                }
                saveWorkspacesConfig(cfg);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: true, message: `Đã lưu cấu hình workspace [${targetWs.id}] thành công!` }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // POST /api/workspaces/save-raw -> Lưu toàn bộ cấu hình workspaces.json
    if (req.method === 'POST' && url.pathname === '/api/workspaces/save-raw') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                if (!data.workspaces || !Array.isArray(data.workspaces)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid workspaces array' }));
                }
                saveWorkspacesConfig(data);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: true, message: 'Đã lưu toàn bộ tệp workspaces.json thành công!' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // POST /api/workspaces/toggle -> Bật/tắt quét Jira cho workspace
    if (req.method === 'POST' && url.pathname === '/api/workspaces/toggle') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const cfg = getWorkspacesConfig();
                const target = cfg.workspaces.find(w => w.id === data.id);
                if (target) {
                    target.enabled = (data.enabled !== false);
                    saveWorkspacesConfig(cfg);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: true, message: `Đã ${target.enabled ? 'kích hoạt' : 'tạm dừng'} quét Jira cho workspace [${data.id}].` }));
                }
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Workspace not found' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // POST /api/workspaces/delete -> Xóa workspace
    if (req.method === 'POST' && url.pathname === '/api/workspaces/delete') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const cfg = getWorkspacesConfig();
                const initialLen = cfg.workspaces.length;
                cfg.workspaces = cfg.workspaces.filter(w => w.id !== data.id);
                if (cfg.workspaces.length < initialLen) {
                    saveWorkspacesConfig(cfg);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: true, message: `Đã xóa workspace [${data.id}] thành công!` }));
                }
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Workspace not found' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // GET /api/agents-status -> Trạng thái realtime đa phiên
    if (req.method === 'GET' && url.pathname === '/api/agents-status') {
        const workerInfo = getRunningWorkerInfo();
        let data = null;
        if (workerInfo.running && fs.existsSync(AGENTS_STATUS_FILE)) {
            try {
                data = JSON.parse(fs.readFileSync(AGENTS_STATUS_FILE, 'utf8'));
            } catch (e) {}
        }
        if (!data) {
            data = {
                updatedAt: new Date().toISOString(),
                activeJobsCount: 0,
                activeSessions: {},
                activeTicket: null,
                summary: null,
                service: null,
                agents: {
                    leader: { name: 'Leader Agent', role: 'Master Orchestrator', status: 'IDLE', currentAction: 'Waiting for incoming bug tickets...', icon: '👑' },
                    analyzer: { name: 'Analyzer Agent', role: 'Bug Analysis & Repro Specialist', status: 'IDLE', currentAction: 'Ready to analyze Jira defects', icon: '🔍' },
                    coder: { name: 'Coder Agent', role: 'Surgical Fix & Code Architect', status: 'IDLE', currentAction: 'Ready to apply code fixes', icon: '💻' },
                    tester: { name: 'QA Tester Agent', role: 'QA & JaCoCo Coverage Specialist', status: 'IDLE', currentAction: 'Ready to write & run unit tests', icon: '🧪' },
                    devops: { name: 'DevOps Agent', role: 'Commit, Merge & CI/CD Pipeline', status: 'IDLE', currentAction: 'Ready to track build & deploy pipelines', icon: '🚀' }
                },
                communications: []
            };
        }
        if (!data.activeSessions) data.activeSessions = {};
        if (!data.communications) data.communications = [];

        // Nếu Worker KHÔNG chạy, hoặc không còn phiên nào đang xử lý -> đưa toàn bộ về IDLE.
        // Tránh hiển thị "Phiên Đang Chạy" hoặc trạng thái FAILED tồn đọng của job đã kết thúc.
        const hasActiveSession = Object.keys(data.activeSessions).length > 0;
        if (!workerInfo.running || !hasActiveSession) {
            data.activeSessions = {};
            data.activeJobsCount = 0;
            data.activeTicket = null;
            data.summary = null;
            data.service = null;
            if (data.agents) {
                for (const k of Object.keys(data.agents)) {
                    data.agents[k].status = 'IDLE';
                    data.agents[k].currentAction = workerInfo.running ? 'Chờ ticket...' : 'Worker không chạy';
                }
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(data));
    }

    // GET /api/fixed-bugs -> Danh sách bug đã fix
    if (req.method === 'GET' && url.pathname === '/api/fixed-bugs') {
        const list = getFixedBugsList();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(list));
    }

    // GET /api/bug-detail -> Chi tiết toàn diện 1 bug
    if (req.method === 'GET' && url.pathname === '/api/bug-detail') {
        const ticketKey = url.searchParams.get('ticket');
        if (!ticketKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing ticket param' }));
        }
        const detail = getBugDetail(ticketKey);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(detail));
    }

    // POST /api/delete-bug-history -> Xóa/ẩn 1 hoặc tất cả bug khỏi lịch sử
    if (req.method === 'POST' && url.pathname === '/api/delete-bug-history') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const hidden = getHiddenBugs();
                if (data.all) {
                    const currentList = getFixedBugsList();
                    for (const b of currentList) {
                        if (b.issueKey && !hidden.includes(b.issueKey)) hidden.push(b.issueKey);
                    }
                    fs.writeFileSync(HIDDEN_BUGS_FILE, JSON.stringify(hidden, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: true, message: 'Đã ẩn toàn bộ danh sách bug khỏi lịch sử.' }));
                } else if (data.ticket) {
                    if (!hidden.includes(data.ticket)) hidden.push(data.ticket);
                    fs.writeFileSync(HIDDEN_BUGS_FILE, JSON.stringify(hidden, null, 2), 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({ success: true, message: `Đã ẩn ticket ${data.ticket} khỏi lịch sử.` }));
                }
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Missing ticket param or all flag' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // POST /api/restore-bug-history -> Khôi phục các bug đã ẩn
    if (req.method === 'POST' && url.pathname === '/api/restore-bug-history') {
        if (fs.existsSync(HIDDEN_BUGS_FILE)) {
            try { fs.unlinkSync(HIDDEN_BUGS_FILE); } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, message: 'Đã khôi phục thành công các bug đã ẩn!' }));
    }

    // POST /api/clear-glitchtip -> Xóa sạch issue trên GlitchTip
    if (req.method === 'POST' && url.pathname === '/api/clear-glitchtip') {
        try {
            const base = 'http://10.30.1.207:8000/api/0';
            const headers = {
                'Authorization': `Bearer ${process.env.GLITCHTIP_API_TOKEN || '2d80da1416547825f38cc064ea3667614e38bfd44c0862d4d560281dbafe24c6'}`,
                'Content-Type': 'application/json'
            };
            const orgRes = await fetch(`${base}/organizations/`, { headers });
            const orgs = await orgRes.json();
            let count = 0;
            for (const org of orgs) {
                const issRes = await fetch(`${base}/organizations/${org.slug}/issues/?query=`, { headers });
                const issues = await issRes.json();
                for (const iss of issues) {
                    await fetch(`${base}/issues/${iss.id}/`, { method: 'DELETE', headers });
                    count++;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: `Đã xóa sạch thành công ${count} issue trên GlitchTip` }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: e.message }));
        }
    }

    // GET /api/evidence-file -> Stream ảnh hoặc text bằng chứng
    if (req.method === 'GET' && url.pathname === '/api/evidence-file') {
        const ticket = url.searchParams.get('ticket');
        const phase = url.searchParams.get('phase') || 'before';
        const filename = url.searchParams.get('file');
        if (!ticket || !filename) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing ticket or file param');
        }

        let filePath = null;
        for (const bDir of [path.join(__dirname, 'evidences'), path.join(__dirname, 'evidence')]) {
            const candidate = path.join(bDir, ticket, phase, filename);
            if (fs.existsSync(candidate)) {
                filePath = candidate;
                break;
            }
        }

        if (!filePath) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Evidence file not found');
        }

        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.txt': 'text/plain; charset=utf-8',
            '.json': 'application/json; charset=utf-8'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        const stream = fs.createReadStream(filePath);
        return stream.pipe(res);
    }

    // GET /api/status -> Trạng thái worker
    if (req.method === 'GET' && url.pathname === '/api/status') {
        const info = getRunningWorkerInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            ...info,
            jiraDomain: process.env.JIRA_DOMAIN || 'https://jira.cybertech.vn',
            jiraEmail: process.env.JIRA_EMAIL || 'thanhpk@cybertech.vn'
        }));
    }

    // GET /api/logs -> Đọc log
    if (req.method === 'GET' && url.pathname === '/api/logs') {
        const logs = getLogs();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(logs);
    }

    // POST /api/start -> Bật worker
    if (req.method === 'POST' && url.pathname === '/api/start') {
        const result = startWorker();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
    }

    // POST /api/stop -> Tắt worker
    if (req.method === 'POST' && url.pathname === '/api/stop') {
        const result = stopWorker();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
    }

    // POST /api/restart -> Khởi động lại worker
    if (req.method === 'POST' && url.pathname === '/api/restart') {
        stopWorker();
        setTimeout(() => {
            const result = startWorker();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Đã khởi động lại Worker thành công!', pid: result.pid }));
        }, 1000);
        return;
    }

    // POST /api/clear-logs -> Xóa file log
    if (req.method === 'POST' && url.pathname === '/api/clear-logs') {
        try {
            if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Đã xóa trắng log' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: e.message }));
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`[RUN] Autonomous Multi-Agent Dashboard đang chạy tại: http://localhost:${PORT}`);
    console.log(`      Truy cập qua mạng LAN: http://10.30.1.207:${PORT}`);
    console.log(`================================================================`);
});

const net = require('net');
function getWslIp() {
    try {
        const out = execSync('wsl -d Ubuntu hostname -I', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        const ip = out.split(' ')[0];
        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch (e) {}
    return '127.0.0.1';
}

const glitchtipProxy = net.createServer((clientSocket) => {
    const wslIp = getWslIp();
    const serverSocket = net.connect(8000, wslIp);
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
    clientSocket.on('error', () => {});
    serverSocket.on('error', () => {});
});

glitchtipProxy.listen(8000, '0.0.0.0', () => {
    console.log(`[PROXY] GlitchTip Port Proxy 8000 (0.0.0.0 -> WSL:8000) đã kích hoạt.`);
}).on('error', (err) => {
    try {
        glitchtipProxy.listen(8000, '10.30.1.207');
    } catch (e) {}
});
