const fs = require('fs');
const path = require('path');

// Thư mục evidence nằm cạnh worker.js (không phụ thuộc CWD).
const EVIDENCE_DIR = path.join(__dirname, 'evidence');

function getTelegramConfig() {
    return {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };
}

const sentFilesCache = new Set();
/**
 * Đảm bảo cấu trúc thư mục cho một issue
 */
function ensureEvidenceDir(jiraKey) {
    const beforeDir = path.join(EVIDENCE_DIR, jiraKey, 'before');
    const afterDir = path.join(EVIDENCE_DIR, jiraKey, 'after');
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });

    // Xoá cache file đã gửi của ticket này để chu kỳ mới gửi đầy đủ
    for (const item of Array.from(sentFilesCache)) {
        if (item.startsWith(`${jiraKey}:`)) sentFilesCache.delete(item);
    }
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
    const { token, chatId } = getTelegramConfig();
    if (!token || !chatId) return;
    const targetDir = path.join(EVIDENCE_DIR, jiraKey, phase);
    fs.mkdirSync(targetDir, { recursive: true });

    // 1. Gửi tin nhắn text (với fallback plain text phòng trường hợp lỗi parse HTML)
    try {
        const msgFormData = new FormData();
        msgFormData.append('chat_id', chatId);
        msgFormData.append('text', message);
        msgFormData.append('parse_mode', 'HTML');
        if (keyboard) {
            msgFormData.append('reply_markup', JSON.stringify(keyboard));
        }
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body: msgFormData });
        const data = await res.json();
        if (!data.ok) {
            console.error(`[!] Lỗi gửi evidence Telegram HTML: ${data.description}. Đang thử fallback plain text...`);
            const fallbackData = new FormData();
            fallbackData.append('chat_id', chatId);
            fallbackData.append('text', message.replace(/<[^>]+>/g, ''));
            if (keyboard) {
                fallbackData.append('reply_markup', JSON.stringify(keyboard));
            }
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body: fallbackData });
        }
    } catch (e) {
        console.error(`[!] Lỗi gửi tin nhắn evidence: ${e.message}`);
    }

    const files = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];
    const photos = files.filter(f => f.startsWith('screenshot') && f.endsWith('.png'));
    const logs = files.filter(f => f.endsWith('.log') || f.endsWith('.txt') || f.endsWith('.json'));

    // 2. Gửi ảnh (Xử lý đúng chuẩn Telegram: 1 ảnh dùng sendPhoto, 2+ ảnh dùng sendMediaGroup)
    const unsentPhotos = photos.filter(p => !sentFilesCache.has(`${jiraKey}:${phase}:${p}`));
    if (unsentPhotos.length === 1) {
        try {
            const p = unsentPhotos[0];
            const buffer = fs.readFileSync(path.join(targetDir, p));
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('caption', `📷 [${jiraKey}] Bằng chứng (${phase}): ${p}`);
            formData.append('photo', new Blob([buffer], { type: 'image/png' }), p);
            const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.ok) sentFilesCache.add(`${jiraKey}:${phase}:${p}`);
        } catch (e) {
            console.error(`[!] Lỗi gửi photo evidence: ${e.message}`);
        }
    } else if (unsentPhotos.length >= 2) {
        for (let i = 0; i < unsentPhotos.length; i += 10) {
            const chunk = unsentPhotos.slice(i, i + 10);
            try {
                const formData = new FormData();
                formData.append('chat_id', chatId);
                const media = chunk.map((p, idx) => ({ type: 'photo', media: `attach://photo${idx}` }));
                formData.append('media', JSON.stringify(media));
                for (let idx = 0; idx < chunk.length; idx++) {
                    const p = chunk[idx];
                    const buffer = fs.readFileSync(path.join(targetDir, p));
                    formData.append(`photo${idx}`, new Blob([buffer], { type: 'image/png' }), p);
                }
                const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: formData });
                const data = await res.json();
                if (data.ok) {
                    chunk.forEach(p => sentFilesCache.add(`${jiraKey}:${phase}:${p}`));
                }
            } catch (e) {
                console.error(`[!] Lỗi gửi MediaGroup evidence: ${e.message}`);
            }
        }
    }

    // 3. Gửi file log/tài liệu đính kèm (không gửi lặp lại)
    for (const log of logs) {
        const cacheKey = `${jiraKey}:${phase}:${log}`;
        if (sentFilesCache.has(cacheKey)) continue;
        try {
            const buffer = fs.readFileSync(path.join(targetDir, log));
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('caption', `📄 [${jiraKey}] Log (${phase}): ${log}`);
            formData.append('document', new Blob([buffer], { type: 'text/plain' }), log);
            const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.ok) sentFilesCache.add(cacheKey);
        } catch (e) {
            console.error(`[!] Lỗi gửi document evidence ${log}: ${e.message}`);
        }
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
