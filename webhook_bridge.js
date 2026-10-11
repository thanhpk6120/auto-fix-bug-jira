const express = require('express');
const fs = require('fs');

// Đọc env
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>l&&!l.trim().startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const auth = Buffer.from(env.JIRA_EMAIL+':'+env.JIRA_TOKEN).toString('base64');
const domain = env.JIRA_DOMAIN;

const app = express();
app.use(express.json());

app.post('/webhook/:projectKey', async (req, res) => {
    const projectKey = req.params.projectKey;
    const body = req.body;
    console.log(`\n[Webhook Bridge] Nhận webhook từ GlitchTip cho dự án ${projectKey}`);
    
    // Giả lập Jira Automation Rule
    // Trích xuất dữ liệu từ GlitchTip Webhook payload
    const issueTitle = body.issue ? body.issue.title : 'Lỗi không xác định';
    const culprit = body.issue ? body.issue.culprit : '';
    const webUrl = body.issue ? body.issue.web_url : '';
    const projectSlug = body.project_name || 'project';
    
    // Logic xác định service label (Giả lập Smart values {{webhookData...}})
    let serviceLabel = 'service:api';
    if (projectSlug.includes('-fe-') || projectSlug.endsWith('-fe')) {
        serviceLabel = 'service:web';
    } else if (projectSlug.includes('-be-') || projectSlug.endsWith('-be')) {
        serviceLabel = 'service:api';
    }

    const jiraPayload = {
        fields: {
            project: { key: projectKey },
            issuetype: { name: 'Bug' },
            summary: `[AUTO-BUG] ${issueTitle}`,
            description: {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Webhook từ GlitchTip\n' },
                            { type: 'text', text: 'Dự án: ' + projectSlug + '\n' },
                            { type: 'text', text: 'Culprit: ' + culprit + '\n' },
                            { type: 'text', text: 'Link GlitchTip: ' + webUrl + '\n' }
                        ]
                    }
                ]
            },
            labels: ['auto-fix', serviceLabel]
        }
    };

    console.log('[Webhook Bridge] Gửi request tạo Jira issue...');
    try {
        const r = await fetch(`https://${domain}/rest/api/3/issue`, {
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(jiraPayload)
        });
        const resp = await r.json();
        if (r.ok) {
            console.log(`[Webhook Bridge] => Đã tạo thành công ticket ${resp.key}`);
            res.json({ success: true, key: resp.key });
        } else {
            console.error(`[Webhook Bridge] => Lỗi tạo ticket:`, resp);
            res.status(500).json(resp);
        }
    } catch (e) {
        console.error(`[Webhook Bridge] => Exception:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(9000, () => {
    console.log('[Webhook Bridge] Đang lắng nghe Webhook GlitchTip tại http://127.0.0.1:9000/webhook/:projectKey');
    // Ghi log để agent khác biết đã ready
    fs.writeFileSync('.webhook_bridge_ready', 'true');
});
