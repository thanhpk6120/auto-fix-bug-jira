const fs = require('fs');
const path = require('path');

// Thư mục evidence nằm cạnh worker.js (không phụ thuộc CWD).
const EVIDENCE_DIR = path.join(__dirname, 'evidence');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Đảm bảo cấu trúc thư mục cho một issue
 */
function ensureEvidenceDir(jiraKey) {
    const beforeDir = path.join(EVIDENCE_DIR, jiraKey, 'before');
    const afterDir = path.join(EVIDENCE_DIR, jiraKey, 'after');
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });
    return { beforeDir, afterDir };
}

/**
 * Lưu file evidence
 */
function saveEvidence(jiraKey, phase, filename, content) {
    if (!['before', 'after'].includes(phase)) throw new Error('Phase must be before or after');
    const targetDir = path.join(EVIDENCE_DIR, jiraKey, phase);
    fs.mkdirSync(targetDir, { recursive: true });
    const filepath = path.join(targetDir, filename);
    fs.writeFileSync(filepath, content);
    return filepath;
}

/**
 * Thu thập evidence do Claude Code tạo trong git worktree của service repo
 * vào thư mục evidence của worker.
 *
 * Claude chạy với cwd = worktree nên nó lưu bằng chứng vào
 * <worktree>/evidence/<JIRA_KEY>/before/. Worker phải copy ngược lại
 * thì mới đọc được — nếu không, check "repro có evidence" luôn pass
 * (vì worker tự tạo file riêng) và bằng chứng của AI bị bỏ rơi.
 */
function collectFromWorktree(worktreeDir, jiraKey, phase) {
    const srcDir = path.join(worktreeDir, 'evidence', jiraKey, phase);
    if (!fs.existsSync(srcDir)) return { copied: 0, files: [] };

    const destDir = path.join(EVIDENCE_DIR, jiraKey, phase);
    fs.mkdirSync(destDir, { recursive: true });

    const copied = [];
    for (const name of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, name);
        if (!fs.statSync(src).isFile()) continue;
        const dest = path.join(destDir, name);
        fs.copyFileSync(src, dest);
        copied.push(name);
    }
    return { copied: copied.length, files: copied };
}

/**
 * Liệt kê file evidence của 1 phase (dùng để kiểm tra repro có bằng chứng thật)
 */
function listEvidenceFiles(jiraKey, phase) {
    const targetDir = path.join(EVIDENCE_DIR, jiraKey, phase);
    if (!fs.existsSync(targetDir)) return [];
    return fs.readdirSync(targetDir).filter(f => fs.statSync(path.join(targetDir, f)).isFile());
}

/**
 * Gửi toàn bộ evidence của 1 phase lên Telegram
 */
async function sendEvidenceToTelegram(jiraKey, phase, message, keyboard = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const targetDir = path.join(EVIDENCE_DIR, jiraKey, phase);
    if (!fs.existsSync(targetDir)) return;

    const files = fs.readdirSync(targetDir);
    const photos = files.filter(f => f.startsWith('screenshot') && f.endsWith('.png'));
    const logs = files.filter(f => f.endsWith('.log') || f.endsWith('.txt') || f.endsWith('.json'));

    // Gửi tin nhắn text
    const msgFormData = new FormData();
    msgFormData.append('chat_id', TELEGRAM_CHAT_ID);
    msgFormData.append('text', message);
    msgFormData.append('parse_mode', 'HTML');
    if (keyboard) {
        msgFormData.append('reply_markup', JSON.stringify(keyboard));
    }
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', body: msgFormData });

    // Gửi ảnh (MediaGroup)
    if (photos.length > 0) {
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        const media = photos.map((p, i) => ({ type: 'photo', media: `attach://photo${i}` }));
        formData.append('media', JSON.stringify(media));
        for (let i = 0; i < photos.length; i++) {
            const buffer = fs.readFileSync(path.join(targetDir, photos[i]));
            formData.append(`photo${i}`, new Blob([buffer], { type: 'image/png' }), photos[i]);
        }
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: 'POST', body: formData });
    }

    // Gửi log files
    for (const log of logs) {
        const buffer = fs.readFileSync(path.join(targetDir, log));
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', new Blob([buffer], { type: 'text/plain' }), log);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
    }
}

module.exports = {
    EVIDENCE_DIR,
    ensureEvidenceDir,
    saveEvidence,
    collectFromWorktree,
    listEvidenceFiles,
    sendEvidenceToTelegram
};
