#!/usr/bin/env node
// gh-deploy.js — Push changed files directly to GitHub via API (no git required)
// Usage: node gh-deploy.js "optional commit message"

const https = require('https');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { token, owner, repo, branch } = cfg.github;

const FILES_TO_DEPLOY = [
    'server.js',
    'app.js',
    'styles.css',
    'index.html',
    'SUMMARY.md',
    'nifty500-symbols.json',
    'package.json',
    'gh-deploy.js',
    'kill-ports.ps1',
    'deploy.ps1'
];

const commitMessage = process.argv[2] || `Update dashboard — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

function apiRequest(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repo}/contents/${endpoint}`,
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': '7-bar-monitor-deploy',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

async function deployFile(filePath) {
    const fullPath = path.join(__dirname, filePath);
    if (!fs.existsSync(fullPath)) {
        console.log(`  skipped (not found): ${filePath}`);
        return;
    }

    const content = fs.readFileSync(fullPath);
    const encoded = content.toString('base64');

    // Get current SHA from GitHub (needed to update existing files)
    const getRes = await apiRequest('GET', `${filePath}?ref=${branch}`);

    const body = {
        message: commitMessage,
        content: encoded,
        branch
    };

    if (getRes.status === 200 && getRes.body.sha) {
        // File exists — check if content actually changed
        const remoteContent = Buffer.from(getRes.body.content.replace(/\n/g, ''), 'base64');
        if (remoteContent.equals(content)) {
            console.log(`  unchanged: ${filePath}`);
            return;
        }
        body.sha = getRes.body.sha; // required for update
    } else if (getRes.status !== 404) {
        console.log(`  warning getting ${filePath}: HTTP ${getRes.status}`);
    }

    const putRes = await apiRequest('PUT', filePath, body);
    if (putRes.status === 200 || putRes.status === 201) {
        console.log(`  pushed: ${filePath}`);
    } else {
        console.log(`  FAILED ${filePath}: HTTP ${putRes.status} — ${JSON.stringify(putRes.body?.message || putRes.body)}`);
    }
}

(async () => {
    console.log(`\nDeploying to ${owner}/${repo} @ ${branch}`);
    console.log(`Commit: "${commitMessage}"\n`);

    for (const file of FILES_TO_DEPLOY) {
        await deployFile(file);
    }

    console.log('\nDone. Render will auto-deploy in ~2-3 minutes.\n');
})();
