#!/usr/bin/env node
// gh-branch.js — Create a GitHub branch and deploy files to it
// Usage: node gh-branch.js <branch-name> "commit message"

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const { token, owner, repo } = cfg.github;
const targetBranch = process.argv[2] || 'auth-setup';
const commitMessage = process.argv[3] || `Update dashboard — ${new Date().toISOString().slice(0,16).replace('T',' ')}`;

const FILES_TO_DEPLOY = [
    'server.js', 'app.js', 'styles.css', 'index.html',
    'SUMMARY.md', 'nifty500-symbols.json', 'package.json',
    'gh-deploy.js', 'gh-branch.js'
];

function api(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'api.github.com',
            path: apiPath, method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': '7-bar-monitor',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
                catch { resolve({ status: res.statusCode, body: d }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

async function ensureBranch() {
    // Check if branch exists
    const check = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
    if (check.status === 200) {
        console.log(`  Branch "${targetBranch}" already exists`);
        return;
    }
    // Get master SHA
    const master = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/master`);
    if (master.status !== 200) throw new Error('Could not get master SHA: ' + master.status);
    const sha = master.body.object.sha;
    // Create branch
    const create = await api('POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${targetBranch}`, sha
    });
    if (create.status === 201) console.log(`  Created branch "${targetBranch}" from master`);
    else throw new Error('Failed to create branch: ' + JSON.stringify(create.body));
}

async function deployFile(filePath) {
    const fullPath = path.join(ROOT, filePath);
    if (!fs.existsSync(fullPath)) { console.log(`  skipped (not found): ${filePath}`); return; }

    const content = fs.readFileSync(fullPath);
    const encoded = content.toString('base64');

    const getRes = await api('GET', `/repos/${owner}/${repo}/contents/${filePath}?ref=${targetBranch}`);
    const body = { message: commitMessage, content: encoded, branch: targetBranch };

    if (getRes.status === 200 && getRes.body.sha) {
        const remote = Buffer.from(getRes.body.content.replace(/\n/g, ''), 'base64');
        if (remote.equals(content)) { console.log(`  unchanged: ${filePath}`); return; }
        body.sha = getRes.body.sha;
    } else if (getRes.status !== 404) {
        console.log(`  warning getting ${filePath}: HTTP ${getRes.status}`);
    }

    const putRes = await api('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, body);
    if (putRes.status === 200 || putRes.status === 201) console.log(`  pushed: ${filePath}`);
    else console.log(`  FAILED ${filePath}: HTTP ${putRes.status} — ${JSON.stringify(putRes.body?.message)}`);
}

(async () => {
    console.log(`\nDeploying to ${owner}/${repo} @ ${targetBranch}`);
    console.log(`Commit: "${commitMessage}"\n`);
    await ensureBranch();
    for (const file of FILES_TO_DEPLOY) await deployFile(file);
    console.log(`\nDone. PR at: https://github.com/${owner}/${repo}/compare/${targetBranch}\n`);
})();
