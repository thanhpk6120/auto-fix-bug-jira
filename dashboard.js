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
const DASHBOARD_LOG_FILE = path.join(__dirname, 'evidences', 'dashboard.log');

// Đảm bảo thư mục evidences/ tồn tại
if (!fs.existsSync(path.join(__dirname, 'evidences'))) {
    try { fs.mkdirSync(path.join(__dirname, 'evidences'), { recursive: true }); } catch (e) {}
}

try {
    fs.writeFileSync(DASHBOARD_PID_FILE, process.pid.toString(), 'utf8');
} catch (e) {}

const cleanDashboardPid = () => {
    try {
        if (fs.existsSync(DASHBOARD_PID_FILE)) {
            const currentSaved = fs.readFileSync(DASHBOARD_PID_FILE, 'utf8').trim();
            if (currentSaved === process.pid.toString()) {
                fs.unlinkSync(DASHBOARD_PID_FILE);
            }
        }
    } catch (e) {}
};
process.on('exit', cleanDashboardPid);
process.on('SIGINT', () => { cleanDashboardPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanDashboardPid(); process.exit(0); });

try {
    const dashLogStream = fs.createWriteStream(DASHBOARD_LOG_FILE, { flags: 'a' });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = function (chunk, encoding, callback) {
        try { dashLogStream.write(chunk); } catch (e) {}
        return origStdoutWrite(chunk, encoding, callback);
    };
    process.stderr.write = function (chunk, encoding, callback) {
        try { dashLogStream.write(chunk); } catch (e) {}
        return origStderrWrite(chunk, encoding, callback);
    };
} catch (e) {}
let workerProcess = null;

// Hàm kiểm tra tiến trình worker có đang sống trên OS không
function getRunningWorkerInfo() {
    let pidToCheck = null;

    // 1. Kiểm tra qua workerProcess của dashboard nếu tự spawn
    if (workerProcess && !workerProcess.killed && workerProcess.exitCode === null) {
        pidToCheck = workerProcess.pid;
    } else if (fs.existsSync(PID_FILE)) {
        try {
            const savedPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (!isNaN(savedPid)) pidToCheck = savedPid;
        } catch (e) {}
    }

    // 2. Xác thực PID có đúng là tiến trình node chạy worker.js hay không
    if (pidToCheck) {
        try {
            if (process.platform === 'win32') {
                const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pidToCheck}\\" | Select-Object -ExpandProperty CommandLine"`;
                const cmdLine = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim();
                if (cmdLine.includes('worker.js') && !cmdLine.includes('dashboard.js')) {
                    return { running: true, pid: pidToCheck, source: 'verified_pid' };
                }
            } else {
                process.kill(pidToCheck, 0);
                return { running: true, pid: pidToCheck, source: 'posix_pid' };
            }
        } catch (e) {}
        // PID không còn sống hoặc không phải worker -> dọn dẹp file PID cũ
        if (fs.existsSync(PID_FILE)) try { fs.unlinkSync(PID_FILE); } catch (e) {}
    }

    // 3. Quét hệ thống tìm tiến trình node đang chạy worker.js nếu chưa có PID file
    if (process.platform === 'win32') {
        try {
            const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*worker.js*' } | Select-Object -ExpandProperty ProcessId"`;
            const output = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim();
            const firstPid = parseInt(output.split(/\r?\n/)[0], 10);
            if (!isNaN(firstPid)) {
                fs.writeFileSync(PID_FILE, firstPid.toString(), 'utf8');
                return { running: true, pid: firstPid, source: 'os_scan' };
            }
        } catch (e) {}
    }

    return { running: false, pid: null };
}

// Hàm khởi động worker
function startWorker() {
    const info = getRunningWorkerInfo();
    if (info.running) {
        return { success: false, message: `Worker đang chạy với PID: ${info.pid}`, pid: info.pid };
    }

    const nodeExecutable = process.execPath;

    workerProcess = spawn(nodeExecutable, ['--env-file=.env', 'worker.js'], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
    });

    fs.writeFileSync(PID_FILE, workerProcess.pid.toString(), 'utf8');

    workerProcess.on('exit', (code, signal) => {
        const exitMsg = `\n[WORKER EXITED] Mã thoát: ${code}, Tín hiệu: ${signal} tại ${new Date().toLocaleString('vi-VN')}\n`;
        try { fs.appendFileSync(LOG_FILE, exitMsg, 'utf8'); } catch (e) {}
        if (fs.existsSync(PID_FILE)) {
            try { fs.unlinkSync(PID_FILE); } catch (e) {}
        }
        workerProcess = null;
    });

    workerProcess.unref();

    return { success: true, message: `Đã khởi động Worker thành công với PID: ${workerProcess.pid}`, pid: workerProcess.pid };
}

// Hàm dừng worker
function stopWorker() {
    const info = getRunningWorkerInfo();
    if (!info.running) {
        if (fs.existsSync(PID_FILE)) try { fs.unlinkSync(PID_FILE); } catch (e) {}
        return { success: false, message: 'Worker hiện đang không chạy' };
    }

    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /PID ${info.pid} /T`, { stdio: 'ignore' });
        } else {
            process.kill(info.pid, 'SIGTERM');
        }
    } catch (e) {
        try { process.kill(info.pid, 'SIGKILL'); } catch (e2) {}
    }

    if (fs.existsSync(PID_FILE)) {
        try { fs.unlinkSync(PID_FILE); } catch (e) {}
    }
    workerProcess = null;

    const stopMsg = `\n[WORKER STOPPED] Đã dừng tiến trình PID ${info.pid} tại ${new Date().toLocaleString('vi-VN')}\n`;
    try { fs.appendFileSync(LOG_FILE, stopMsg, 'utf8'); } catch (e) {}

    return { success: true, message: `Đã dừng thành công Worker (PID: ${info.pid})` };
}

// Hàm đọc log
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

// HTML Dashboard UI
function renderDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous AI Worker Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .title { font-size: 24px; font-weight: 700; display: flex; align-items: center; gap: 12px; }
    .badge { padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-running { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-stopped { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .grid { display: grid; grid-template-columns: 1fr 2fr; gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .card-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .btn-group { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
    .btn { padding: 12px 18px; border-radius: 8px; font-weight: 600; font-size: 14px; border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-danger { background: var(--danger); color: white; }
    .btn-danger:hover { background: #dc2626; }
    .btn-secondary { background: var(--border); color: var(--text); }
    .btn-secondary:hover { background: #475569; }
    .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(51, 65, 85, 0.5); font-size: 13px; }
    .info-label { color: var(--text-muted); }
    .info-val { font-weight: 500; font-family: monospace; }
    .console-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .console-box { background: #090d16; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; height: 550px; overflow-y: auto; font-family: "Cascadia Code", Consolas, monospace; font-size: 12.5px; line-height: 1.5; color: #e2e8f0; white-space: pre-wrap; word-break: break-all; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #1e293b; border: 1px solid var(--primary); color: white; padding: 12px 20px; border-radius: 8px; font-size: 14px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); display: none; z-index: 100; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">
        <span>🤖 Autonomous AI Worker Level 3</span>
        <span id="statusBadge" class="badge badge-stopped">Đang kiểm tra...</span>
      </div>
      <div>
        <label style="font-size: 13px; color: var(--text-muted); cursor: pointer;">
          <input type="checkbox" id="autoRefresh" checked> Tự động cập nhật log (2s)
        </label>
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="card" style="margin-bottom: 20px;">
          <div class="card-title">Điều Khiển Tiến Trình Worker</div>
          <div class="btn-group">
            <button id="btnStart" class="btn btn-primary" onclick="controlWorker('start')">▶️ Bật Worker</button>
            <button id="btnStop" class="btn btn-danger" onclick="controlWorker('stop')">⏹️ Tắt Worker</button>
            <button id="btnRestart" class="btn btn-secondary" onclick="controlWorker('restart')">🔄 Khởi Động Lại</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Thông Tin Cấu Hình & Hệ Thống</div>
          <div class="info-item"><span class="info-label">PID Worker:</span><span id="infoPid" class="info-val">--</span></div>
          <div class="info-item"><span class="info-label">Jira Domain:</span><span id="infoJiraDomain" class="info-val">Loading...</span></div>
          <div class="info-item"><span class="info-label">Jira User:</span><span id="infoJiraEmail" class="info-val">Loading...</span></div>
          <div class="info-item"><span class="info-label">Cổng Dashboard:</span><span class="info-val">${PORT}</span></div>
          <div class="info-item"><span class="info-label">GlitchTip Server:</span><span class="info-val">localhost:8000</span></div>
          <div class="info-item"><span class="info-label">Webhook Bridge (K8s):</span><span class="info-val">10.30.1.136:30950</span></div>
        </div>
      </div>

      <div class="card">
        <div class="console-header">
          <div style="font-weight: 600; font-size: 15px;">Console Log Thời Gian Thực</div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 12.5px; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; user-select: none; margin-right: 4px;">
              <input type="checkbox" id="chkAutoScroll" checked onchange="toggleAutoScroll(this.checked)">
              <span>Tự động cuộn</span>
            </label>
            <button id="btnScrollBottom" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; display: none;" onclick="scrollToBottom()" title="Cuộn xuống cuối log">⬇️ Xuống cuối</button>
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px; display: inline-flex;" onclick="clearLogs()">🧹 Xóa Log</button>
          </div>
        </div>
        <div id="consoleBox" class="console-box">Đang tải dữ liệu log...</div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let isAutoScroll = true;

    function initAutoScrollSetting() {
      try {
        const saved = localStorage.getItem('worker_auto_scroll');
        if (saved !== null) {
          isAutoScroll = saved === 'true';
          const chk = document.getElementById('chkAutoScroll');
          if (chk) chk.checked = isAutoScroll;
        }
      } catch (e) {}
      updateScrollBottomBtn();
    }

    function toggleAutoScroll(enabled) {
      isAutoScroll = !!enabled;
      try {
        localStorage.setItem('worker_auto_scroll', isAutoScroll ? 'true' : 'false');
      } catch (e) {}
      updateScrollBottomBtn();
      if (isAutoScroll) {
        scrollToBottom();
      }
    }

    function scrollToBottom() {
      const box = document.getElementById('consoleBox');
      if (box) box.scrollTop = box.scrollHeight;
    }

    function updateScrollBottomBtn() {
      const btn = document.getElementById('btnScrollBottom');
      if (btn) btn.style.display = isAutoScroll ? 'none' : 'inline-flex';
    }
    function showToast(msg, isError = false) {
      const toast = document.getElementById('toast');
      toast.style.borderColor = isError ? 'var(--danger)' : 'var(--primary)';
      toast.innerText = msg;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        const badge = document.getElementById('statusBadge');
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        const infoPid = document.getElementById('infoPid');
        
        if (data.running) {
          badge.className = 'badge badge-running';
          badge.innerText = '🟢 RUNNING (PID: ' + data.pid + ')';
          infoPid.innerText = data.pid;
          btnStart.disabled = true;
          btnStart.style.opacity = '0.5';
          btnStop.disabled = false;
          btnStop.style.opacity = '1';
        } else {
          badge.className = 'badge badge-stopped';
          badge.innerText = '🔴 STOPPED';
          infoPid.innerText = 'Chưa chạy';
          btnStart.disabled = false;
          btnStart.style.opacity = '1';
          btnStop.disabled = true;
          btnStop.style.opacity = '0.5';
        }

        document.getElementById('infoJiraDomain').innerText = data.jiraDomain || '--';
        document.getElementById('infoJiraEmail').innerText = data.jiraEmail || '--';
      } catch (e) {
        console.error(e);
      }
    }

    async function fetchLogs() {
      try {
        const res = await fetch('/api/logs');
        const text = await res.text();
        const box = document.getElementById('consoleBox');
        if (!box) return;
        if (box.textContent !== text) {
          const prevScrollTop = box.scrollTop;
          box.textContent = text;
          if (isAutoScroll) {
            box.scrollTop = box.scrollHeight;
          } else {
            box.scrollTop = prevScrollTop;
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function controlWorker(action) {
      try {
        const res = await fetch('/api/' + action, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, !data.success);
        await fetchStatus();
        await fetchLogs();
      } catch (e) {
        showToast('Lỗi gửi lệnh: ' + e.message, true);
      }
    }

    async function clearLogs() {
      if (!confirm('Bạn có chắc muốn xóa sạch file log?')) return;
      try {
        const res = await fetch('/api/clear-log', { method: 'POST' });
        const data = await res.json();
        showToast(data.message);
        document.getElementById('consoleBox').textContent = '';
      } catch (e) {
        showToast('Lỗi xóa log: ' + e.message, true);
      }
    }

    // Polling định kỳ
    initAutoScrollSetting();
    fetchStatus();
    fetchLogs();
    setInterval(() => {
      fetchStatus();
      if (document.getElementById('autoRefresh').checked) {
        fetchLogs();
      }
    }, 2000);
  </script>
</body>
</html>`;
}

// 2. HTTP Server Router
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // GET / -> Web Dashboard UI
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderDashboardHtml());
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
            res.end(JSON.stringify(result));
        }, 1000);
        return;
    }

    // POST /api/clear-log -> Xóa log
    if (req.method === 'POST' && url.pathname === '/api/clear-log') {
        try {
            fs.writeFileSync(LOG_FILE, '', 'utf8');
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
    console.log(`🚀 Worker Web Dashboard đang chạy tại: http://localhost:${PORT}`);
    console.log(`👉 Truy cập qua mạng LAN: http://10.30.1.207:${PORT}`);
    console.log(`================================================================`);
});

// GlitchTip LAN & Local Proxy (10.30.1.207:8000 & 127.0.0.1:8000 -> WSL GlitchTip 8000)
const net = require('net');
function getWslIp() {
    try {
        const out = execSync('wsl hostname -I', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\s+/)[0];
        if (out) return out;
    } catch (e) {}
    return '127.0.0.1';
}

const glitchTipProxy = net.createServer((client) => {
    const upstreamHost = getWslIp();
    const upstream = net.connect(8000, upstreamHost);
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
});

glitchTipProxy.listen(8000, '0.0.0.0', () => {
    console.log(`[PROXY] GlitchTip LAN & Local proxy ready at: http://10.30.1.207:8000 & http://localhost:8000`);
}).on('error', (err) => {
    console.log('[PROXY] 0.0.0.0 bind notice, fallback to 10.30.1.207:', err.message);
    try {
        glitchTipProxy.listen(8000, '10.30.1.207');
    } catch (e) {}
});
