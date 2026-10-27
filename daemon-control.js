/**
 * daemon-control.js
 * Quản lý khởi động / dừng / khởi động lại / kiểm tra trạng thái Worker và Dashboard
 * Chạy ngầm hoàn toàn độc lập (WMI Win32_Process.Create với ShowWindow = 0)
 * Tách rời hoàn toàn khỏi shell / terminal cha, đóng cửa sổ console không ảnh hưởng.
 * 
 * Cách dùng:
 *   node daemon-control.js start [worker|dashboard|all]
 *   node daemon-control.js stop [worker|dashboard|all]
 *   node daemon-control.js restart [worker|dashboard|all]
 *   node daemon-control.js status [worker|dashboard|all]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync, execSync } = require('child_process');

const ROOT = __dirname;
const EVIDENCES_DIR = path.join(ROOT, 'evidences');
if (!fs.existsSync(EVIDENCES_DIR)) {
    try { fs.mkdirSync(EVIDENCES_DIR, { recursive: true }); } catch (e) {}
}

const WORKER_PID_FILE = path.join(EVIDENCES_DIR, 'worker.pid');
const WORKER_LOG_FILE = path.join(EVIDENCES_DIR, 'worker.log');
const DASHBOARD_PID_FILE = path.join(EVIDENCES_DIR, 'dashboard.pid');
const DASHBOARD_LOG_FILE = path.join(EVIDENCES_DIR, 'dashboard.log');

// Nạp port dashboard từ .env nếu có
let DASHBOARD_PORT = 8880;
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
    try {
        const text = fs.readFileSync(envPath, 'utf8');
        const m = text.match(/DASHBOARD_PORT\s*=\s*(\d+)/);
        if (m) DASHBOARD_PORT = parseInt(m[1], 10);
    } catch (e) {}
}

function findNode() {
    if (process.execPath && fs.existsSync(process.execPath)) {
        return process.execPath;
    }
    try {
        const out = execSync('where.exe node', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        const first = out.split(/\r?\n/)[0].trim();
        if (first && fs.existsSync(first)) return first;
    } catch (e) {}
    return 'node';
}

function readPid(pidFile) {
    if (!fs.existsSync(pidFile)) return null;
    try {
        const val = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        return Number.isInteger(val) && val > 0 ? val : null;
    } catch (e) {
        return null;
    }
}

function writePid(pidFile, pid) {
    try {
        fs.writeFileSync(pidFile, String(pid), 'utf8');
    } catch (e) {}
}

function clearPid(pidFile) {
    try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch (e) {}
}

function isAlive(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // Đang chạy nhưng không có quyền signal
    }
}

function pidByPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (!out) return null;
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (Number.isInteger(pid) && pid > 0) return pid;
        }
    } catch (e) {}
    return null;
}

function findProcessPidByScript(scriptName) {
    try {
        const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${scriptName}*' -and $_.Name -like '*node*' } | Select-Object -ExpandProperty ProcessId`;
        const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (!out) return null;
        const lines = out.split(/\r?\n/).map(l => parseInt(l.trim(), 10)).filter(p => Number.isInteger(p) && p > 0);
        return lines.length > 0 ? lines[0] : null;
    } catch (e) {}
    return null;
}

function checkHttp(port, path = '/') {
    return new Promise((resolve) => {
        const req = http.get({
            hostname: '127.0.0.1',
            port,
            path,
            timeout: 2000
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, code: res.statusCode, body: data }));
        });
        req.on('error', (err) => resolve({ ok: false, code: 0, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 0, error: 'timeout' }); });
    });
}

/**
 * Tạo tiến trình ngầm qua WMI Win32_Process.Create với ShowWindow = 0
 * Hoàn toàn ẩn cửa sổ và độc lập với terminal hiện tại.
 */
function spawnHiddenWmi(commandLine) {
    const psScript = [
        `$ErrorActionPreference='Stop'`,
        `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0 }`,
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${ROOT.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
        `Write-Output $r.ProcessId`
    ].join('; ');

    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim().split(/\r?\n/).filter(Boolean);
        const pid = parseInt(out[out.length - 1], 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (e) {
        return null;
    }
}

// ==================== WORKER CONTROLS ====================

async function startWorker() {
    let pid = readPid(WORKER_PID_FILE);
    if (isAlive(pid)) {
        console.log(`[WORKER] Đang chạy ngầm sẵn với PID: ${pid}. Không cần start thêm.`);
        return { success: true, pid };
    }
    const detectedPid = findProcessPidByScript('worker.js');
    if (detectedPid && isAlive(detectedPid)) {
        writePid(WORKER_PID_FILE, detectedPid);
        console.log(`[WORKER] Phát hiện Worker đang chạy với PID: ${detectedPid} -> Đã cập nhật worker.pid.`);
        return { success: true, pid: detectedPid };
    }

    const node = findNode();
    console.log(`[WORKER] Đang khởi động Singleton Master Worker ở chế độ ẩn ngầm...`);
    const cmdLine = `cmd.exe /c ""${node}"" --env-file=.env worker.js`;
    const wrapperPid = spawnHiddenWmi(cmdLine);

    if (!wrapperPid) {
        console.error(`[WORKER] Lỗi: Không khởi động được tiến trình qua WMI.`);
        return { success: false };
    }

    // Chờ tối đa 5 giây để tìm PID Node thật
    let realPid = null;
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        realPid = readPid(WORKER_PID_FILE) || findProcessPidByScript('worker.js');
        if (realPid && isAlive(realPid)) {
            writePid(WORKER_PID_FILE, realPid);
            break;
        }
    }

    const finalPid = realPid || wrapperPid;
    writePid(WORKER_PID_FILE, finalPid);
    console.log(`[WORKER] Khởi động thành công! Đang chạy ngầm với PID: ${finalPid}`);
    console.log(`  Log file: evidences/worker.log`);
    return { success: true, pid: finalPid };
}

function stopWorker() {
    const pid = readPid(WORKER_PID_FILE) || findProcessPidByScript('worker.js');
    if (!pid || !isAlive(pid)) {
        clearPid(WORKER_PID_FILE);
        console.log(`[WORKER] Hiện không chạy.`);
        return { success: true };
    }

    console.log(`[WORKER] Đang dừng tiến trình PID: ${pid} và toàn bộ cây tiến trình con...`);
    try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch (e) {}

    // Dọn dẹp bổ sung nếu còn tiến trình worker.js sót lại
    try {
        const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*worker.js*' -and $_.Name -like '*node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
    } catch (e) {}

    clearPid(WORKER_PID_FILE);
    console.log(`[WORKER] Đã dừng hoàn toàn.`);
    return { success: true };
}

// ==================== DASHBOARD CONTROLS ====================

async function startDashboard() {
    let pid = readPid(DASHBOARD_PID_FILE);
    if (isAlive(pid)) {
        const res = await checkHttp(DASHBOARD_PORT, '/api/status');
        if (res.ok) {
            console.log(`[DASHBOARD] Đang chạy ngầm sẵn với PID: ${pid} tại port ${DASHBOARD_PORT}.`);
            console.log(`  Truy cập: http://localhost:${DASHBOARD_PORT}`);
            return { success: true, pid };
        }
    }

    const portPid = pidByPort(DASHBOARD_PORT);
    if (portPid && isAlive(portPid)) {
        writePid(DASHBOARD_PID_FILE, portPid);
        console.log(`[DASHBOARD] Đã chạy trên port ${DASHBOARD_PORT} (PID ${portPid}) -> Đã cập nhật dashboard.pid.`);
        console.log(`  Truy cập: http://localhost:${DASHBOARD_PORT}`);
        return { success: true, pid: portPid };
    }

    const node = findNode();
    console.log(`[DASHBOARD] Đang khởi động Web Dashboard ở chế độ ẩn ngầm...`);
    const cmdLine = `cmd.exe /c ""${node}"" --env-file=.env dashboard.js`;
    const wrapperPid = spawnHiddenWmi(cmdLine);

    if (!wrapperPid) {
        console.error(`[DASHBOARD] Lỗi: Không khởi động được tiến trình qua WMI.`);
        return { success: false };
    }

    // Chờ port 8880 sẵn sàng
    let activePid = null;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        activePid = pidByPort(DASHBOARD_PORT) || readPid(DASHBOARD_PID_FILE) || findProcessPidByScript('dashboard.js');
        if (activePid && isAlive(activePid)) {
            const h = await checkHttp(DASHBOARD_PORT, '/');
            if (h.ok) {
                writePid(DASHBOARD_PID_FILE, activePid);
                break;
            }
        }
    }

    const finalPid = activePid || wrapperPid;
    writePid(DASHBOARD_PID_FILE, finalPid);
    console.log(`[DASHBOARD] Khởi động thành công! Đang chạy ngầm với PID: ${finalPid}`);
    console.log(`  Truy cập: http://localhost:${DASHBOARD_PORT} hoặc http://10.30.1.207:${DASHBOARD_PORT}`);
    console.log(`  Log file: evidences/dashboard.log`);
    return { success: true, pid: finalPid };
}

function stopDashboard() {
    const pid = readPid(DASHBOARD_PID_FILE) || pidByPort(DASHBOARD_PORT) || findProcessPidByScript('dashboard.js');
    if (!pid || !isAlive(pid)) {
        clearPid(DASHBOARD_PID_FILE);
        console.log(`[DASHBOARD] Hiện không chạy.`);
        return { success: true };
    }

    console.log(`[DASHBOARD] Đang dừng tiến trình PID: ${pid} và giải phóng port ${DASHBOARD_PORT}...`);
    try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch (e) {}

    // Dọn dẹp triệt để nếu còn sót
    try {
        const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dashboard.js*' -and $_.Name -like '*node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
        execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
    } catch (e) {}

    clearPid(DASHBOARD_PID_FILE);
    console.log(`[DASHBOARD] Đã dừng hoàn toàn.`);
    return { success: true };
}

// ==================== STATUS CHECK ====================

async function checkStatus() {
    console.log(`\n================= JIRA AUTO-FIX SYSTEM STATUS =================`);
    
    // 1. Worker
    const wPid = readPid(WORKER_PID_FILE) || findProcessPidByScript('worker.js');
    const wAlive = isAlive(wPid);
    console.log(`[WORKER]`);
    console.log(`  Trạng thái : ${wAlive ? '✅ ĐANG CHẠY NGẦM' : '❌ ĐÃ DỪNG'}`);
    console.log(`  PID        : ${wAlive ? wPid : 'N/A'}`);
    console.log(`  Log file   : evidences/worker.log`);

    // 2. Dashboard
    const dPid = readPid(DASHBOARD_PID_FILE) || pidByPort(DASHBOARD_PORT) || findProcessPidByScript('dashboard.js');
    const dAlive = isAlive(dPid);
    const dHttp = await checkHttp(DASHBOARD_PORT, '/api/status');
    console.log(`\n[DASHBOARD]`);
    console.log(`  Trạng thái : ${dAlive ? '✅ ĐANG CHẠY NGẦM' : '❌ ĐÃ DỪNG'}`);
    console.log(`  Cổng HTTP  : ${DASHBOARD_PORT} (${dHttp.ok ? 'HTTP 200 OK' : 'Chưa phản hồi'})`);
    console.log(`  PID        : ${dAlive ? dPid : 'N/A'}`);
    console.log(`  Địa chỉ    : http://localhost:${DASHBOARD_PORT} hoặc http://10.30.1.207:${DASHBOARD_PORT}`);
    console.log(`  Log file   : evidences/dashboard.log`);
    console.log(`===============================================================\n`);
    return { worker: wAlive, dashboard: dAlive };
}

// ==================== MAIN ROUTER ====================

async function main() {
    const action = (process.argv[2] || 'status').toLowerCase();
    const target = (process.argv[3] || 'all').toLowerCase();

    if (action === 'start') {
        if (target === 'worker') await startWorker();
        else if (target === 'dashboard') await startDashboard();
        else {
            await startDashboard();
            await startWorker();
        }
    } else if (action === 'stop') {
        if (target === 'worker') stopWorker();
        else if (target === 'dashboard') stopDashboard();
        else {
            stopWorker();
            stopDashboard();
        }
    } else if (action === 'restart') {
        if (target === 'worker') {
            stopWorker();
            await new Promise(r => setTimeout(r, 1000));
            await startWorker();
        } else if (target === 'dashboard') {
            stopDashboard();
            await new Promise(r => setTimeout(r, 1000));
            await startDashboard();
        } else {
            stopWorker();
            stopDashboard();
            await new Promise(r => setTimeout(r, 1000));
            await startDashboard();
            await startWorker();
        }
    } else if (action === 'status') {
        await checkStatus();
    } else {
        console.log(`Cách dùng: node daemon-control.js <start|stop|restart|status> [worker|dashboard|all]`);
    }
}

main().catch(err => {
    console.error('Lỗi thực thi:', err.message);
    process.exit(1);
});
