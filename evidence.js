const fs = require('fs');
const path = require('path');

const EVIDENCE_DIR = path.join(process.cwd(), 'evidence');

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
    ensureEvidenceDir,
    saveEvidence,
    sendEvidenceToTelegram
};
