const express = require('express');
const fs = require('fs');
const path = require('path');

// Đọc env
const env = Object.fromEntries(
    fs.readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
        .map(l => {
            const i = l.indexOf('=');
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
);

const domain = (env.JIRA_DOMAIN || 'localhost').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const isJiraCloud = domain.toLowerCase().includes('atlassian.net');
const jiraApiVer = isJiraCloud ? '3' : '2';
const jiraAuth = (env.JIRA_TOKEN && (env.JIRA_TOKEN.startsWith('Bearer ') || !isJiraCloud))
    ? (env.JIRA_TOKEN.startsWith('Bearer ') ? env.JIRA_TOKEN : `Bearer ${env.JIRA_TOKEN}`)
    : 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64');
const app = express();
app.use(express.json());

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
                const projectDir = path.resolve(root, project.path || '.');
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

    // Mặc định dùng chính slug làm tên service (phù hợp với microservices như bidv-hub-service)
    return `service:${projectSlug}`;
}

app.post('/webhook/:projectKey', async (req, res) => {
    const projectKey = req.params.projectKey;
    const body = req.body;
    console.log(`\n[Webhook Bridge] Nhận webhook từ GlitchTip cho dự án ${projectKey}`);

    // Trích xuất dữ liệu từ GlitchTip Webhook payload
    const issueTitle = body.issue ? body.issue.title : (body.title || 'Lỗi không xác định');
    const culprit = body.issue ? body.issue.culprit : (body.culprit || '');
    const webUrl = body.issue ? body.issue.web_url : (body.url || '');
    const projectSlug = body.project_name || body.project_slug || body.project || 'project';

    const explicitService = req.query.service || null;
    const serviceLabel = resolveServiceLabel(projectKey, projectSlug, explicitService);
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
            return res.status(200).json({ success: true, issueKey: jiraData.key, serviceLabel });
        } else {
            console.error(`[Webhook Bridge] Lỗi tạo Jira Ticket:`, JSON.stringify(jiraData));
            return res.status(jiraRes.status).json({ success: false, error: jiraData });
        }
    } catch (err) {
        console.error(`[Webhook Bridge] Lỗi kết nối Jira API:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GlitchTip-to-Jira Webhook Bridge đang chạy tại http://localhost:${PORT}`);
    console.log(`👉 Webhook URL mẫu: http://<IP>:${PORT}/webhook/<PROJECT_KEY> (ví dụ /webhook/BANKHUB?service=bidv-hub-service)`);
});
