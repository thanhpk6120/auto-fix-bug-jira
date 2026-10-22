const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Tự động nạp file .env từ thư mục gốc của worker
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
                if (!process.env[k]) process.env[k] = v;
            }
        }
    } catch (e) {
        console.warn(`[!] Không đọc được file .env: ${e.message}`);
    }
}

const domain = (env.JIRA_DOMAIN || 'localhost').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const isJiraCloud = domain.toLowerCase().includes('atlassian.net');
const jiraApiVer = isJiraCloud ? '3' : '2';
const jiraAuth = (env.JIRA_TOKEN && (env.JIRA_TOKEN.startsWith('Bearer ') || !isJiraCloud))
    ? (env.JIRA_TOKEN.startsWith('Bearer ') ? env.JIRA_TOKEN : `Bearer ${env.JIRA_TOKEN}`)
    : 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64');

// Helper tìm service name từ projectKey và projectSlug của GlitchTip
function resolveServiceLabel(projectKey, projectSlug, explicitService) {
    if (explicitService) {
        return `service:${explicitService}`;
    }

    try {
        const projectsFile = path.join(__dirname, 'projects.json');
        if (fs.existsSync(projectsFile)) {
            const projectsData = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
            const project = (projectsData.projects || []).find(p => p.projectKey === projectKey);
            if (project) {
                const root = project.root ? (path.isAbsolute(project.root) ? project.root : path.resolve(__dirname, project.root)) : __dirname;
                const projectDir = (project.path && path.isAbsolute(project.path)) ? project.path : path.resolve(root, project.path || '.');
                const servicesFile = path.join(projectDir, 'services.json');
                if (fs.existsSync(servicesFile)) {
                    const servicesData = JSON.parse(fs.readFileSync(servicesFile, 'utf8'));
                    const list = Array.isArray(servicesData.services) ? servicesData.services : Object.values(servicesData);
                    
                    // 1. Khớp chính xác tên service hoặc path
                    const matched = list.find(s => 
                        s.name === projectSlug || 
                        s.path === projectSlug || 
                        (s.path && s.path.endsWith(projectSlug)) ||
                        (s.gitRepo && s.gitRepo.endsWith(projectSlug))
                    );
                    if (matched) return `service:${matched.name}`;

                    // 2. Khớp mờ: slug chứa tên service
                    const fuzzy = list.find(s => projectSlug.includes(s.name) || s.name.includes(projectSlug));
                    if (fuzzy) return `service:${fuzzy.name}`;
                }
            }
        }
    } catch (e) {
        console.warn(`[Webhook Bridge] Không thể tra cứu services.json: ${e.message}`);
    }

    // Heuristics mặc định cho SHOP/CMS hoặc dự án chuẩn fe/be
    if (projectSlug.includes('-fe-') || projectSlug.endsWith('-fe') || projectSlug.includes('web')) {
        return 'service:web';
    }
    if (projectSlug.includes('-be-') || projectSlug.endsWith('-be') || projectSlug.includes('api')) {
        return 'service:api';
    }

    // Mặc định dùng chính slug làm tên service
    return `service:${projectSlug}`;
}

async function handleWebhook(req, res, parsedUrl) {
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    // Path: /webhook/:projectKey
    if (parts.length < 2 || parts[0] !== 'webhook') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found. Use POST /webhook/:projectKey' }));
    }

    const projectKey = parts[1];
    let bodyRaw = '';
    req.on('data', chunk => { bodyRaw += chunk; });
    req.on('end', async () => {
        let body = {};
        try {
            if (bodyRaw) body = JSON.parse(bodyRaw);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        }

        console.log(`\n[Webhook Bridge] Nhận webhook từ GlitchTip cho dự án ${projectKey}`);
        const issueTitle = body.issue ? body.issue.title : (body.title || 'Lỗi không xác định');
        const culprit = body.issue ? body.issue.culprit : (body.culprit || '');
        const webUrl = body.issue ? body.issue.web_url : (body.url || '');
        const projectSlug = body.project_name || body.project_slug || body.project || 'project';

        // Bộ lọc lỗi nghiệp vụ thông minh:
        // - Bỏ qua lỗi nhập liệu form / thiếu header / 404 thuần túy từ client.
        // - TUY NHIÊN: nếu lỗi 400 phát sinh từ tầng Service (logic nghiệp vụ) hoặc lỗi gọi sang đối tác ngân hàng (outbound) thì VẪN TẠO BUG!
        const tags = (body.issue && body.issue.tags) || (body.event && body.event.tags) || [];
        const isWhitelistedBug = tags.some(t => Array.isArray(t) && (t[0] === 'bug_category' || t[1] === 'service_logic_400' || t[1] === 'partner_outbound_error'));
        const fromServiceLayer = /\.service\.|\.client\.|\.process\./i.test(culprit);

        const pureClientErrorPattern = /MethodArgumentNotValid|MethodArgumentTypeMismatch|MissingServletRequestParameter|MissingRequestHeader|NoResourceFound|BadCredentials|AccessDenied/i;
        if (!isWhitelistedBug && !fromServiceLayer && pureClientErrorPattern.test(issueTitle)) {
            console.log(`[Webhook Bridge] ⏩ BỎ QUA sự kiện lỗi nhập liệu / client: "${issueTitle}". Không tạo bug trên Jira.`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ skipped: true, reason: 'Client validation/input error ignored' }));
        }

        const queryService = parsedUrl.query && parsedUrl.query.service;
        const serviceLabel = resolveServiceLabel(projectKey, projectSlug, queryService);
        console.log(`[Webhook Bridge] Map GlitchTip project '${projectSlug}' -> Label '${serviceLabel}'`);

        const descText = `Webhook từ GlitchTip\nProject: ${projectSlug}\nCulprit: ${culprit}\nLink GlitchTip: ${webUrl}`;
        const descriptionPayload = isJiraCloud
            ? {
                type: 'doc',
                version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: descText }] }]
            }
            : descText;

        const jiraPayload = {
            fields: {
                project: { key: projectKey },
                issuetype: { name: 'Bug' },
                summary: `[AUTO-BUG] ${issueTitle}`,
                description: descriptionPayload,
                labels: ['auto-fix', serviceLabel],
                ...(!isJiraCloud ? { customfield_10600: { value: 'Moderate' } } : {})
            }
        };

        try {
            const jiraRes = await fetch(`https://${domain}/rest/api/${jiraApiVer}/issue`, {
                method: 'POST',
                headers: {
                    'Authorization': jiraAuth,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jiraPayload)
            });

            const jiraData = await jiraRes.json();
            if (jiraRes.ok) {
                console.log(`[Webhook Bridge] Tạo thành công Jira Ticket: ${jiraData.key} (Nhãn: auto-fix, ${serviceLabel})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, issueKey: jiraData.key, serviceLabel }));
            } else {
                console.error(`[Webhook Bridge] Lỗi tạo Jira Ticket:`, JSON.stringify(jiraData));
                res.writeHead(jiraRes.status, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: jiraData }));
            }
        } catch (err) {
            console.error(`[Webhook Bridge] Lỗi kết nối Jira API:`, err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    if (req.method === 'POST' && parsedUrl.pathname && parsedUrl.pathname.startsWith('/webhook/')) {
        return handleWebhook(req, res, parsedUrl);
    }
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', domain }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`🚀 GlitchTip-to-Jira Webhook Bridge đang chạy tại http://localhost:${PORT}`);
    console.log(`👉 Webhook URL: http://<IP>:${PORT}/webhook/<PROJECT_KEY> (ví dụ /webhook/PHUB)`);
});
