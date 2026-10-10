// Cross-platform pre-tool-use hook in Node.js (Windows-compatible)
const fs = require('fs');

const args = process.argv.slice(2).join(' ');

// Danh sách các mẫu lệnh cấm
const dangerousPatterns = [
  /rm\s+-rf/i,
  /git\s+push.*--force/i,
  /git\s+push.*-f/i,
  /\.env/i,
  /worker\.js/i,
];

function block(msg) {
  console.error('[HOOK ERROR] ' + msg + ' Blocked.');
  process.exit(1);
}

// Đọc stdin (JSON từ Claude Code). Windows-safe: không treo khi không có pipe.
let rawStdin = '';
try {
  if (!process.stdin.isTTY) {
    rawStdin = fs.readFileSync(0, 'utf8');
  }
} catch (e) {
  rawStdin = '';
}

// Check dangerous trên argv + JSON string
const haystack = args + '\n' + (rawStdin || '');
for (const pattern of dangerousPatterns) {
  if (pattern.test(haystack)) {
    block('Dangerous action detected: "' + args + '".');
  }
}

// stdin rỗng/không JSON thì không chặn trừ dangerous argv
if (!rawStdin || !rawStdin.trim()) {
  process.exit(0);
}

let data;
try {
  data = JSON.parse(rawStdin);
} catch (e) {
  process.exit(0);
}

const toolName = data.tool_name || data.toolName || data.tool || '';
const toolInput =
  data.tool_input || data.toolInput || data.input || data.params || {};

// Phase gate: test-only chỉ cho sửa test, chặn src/main
if (process.env.AUTOFIX_PHASE === 'test-only') {
  const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  if (editTools.indexOf(toolName) !== -1) {
    const candidates = [
      toolInput.file_path,
      toolInput.filePath,
      toolInput.path,
      toolInput.filename,
      toolInput.file,
      toolInput.command,
      toolInput.cmd,
    ];
    // Gom thêm mọi string trong tool_input để bắt field lạ / mảng edits
    let extra = '';
    try {
      extra = JSON.stringify(toolInput) || '';
    } catch (e) {
      extra = '';
    }
    const pool = [];
    for (const c of candidates) {
      if (typeof c === 'string' && c) pool.push(c);
    }
    if (extra) pool.push(extra);
    const normalized = pool.join('\n').replace(/\\/g, '/');
    if (normalized.indexOf('/src/main/') !== -1) {
      block(
        'AUTOFIX_PHASE=test-only: editing /src/main/ is forbidden (tool=' +
          toolName +
          '). Only /src/test/ is allowed.'
      );
    }
    // chứa /src/test/ thì cho qua, file khác cũng cho qua
    process.exit(0);
  }
}

process.exit(0);
