// ========================================================
// KITE CONNECT CLIENT — Skeleton for Zerodha Integration
// ========================================================
// This module is INACTIVE until config.json has kite.enabled = true
// and valid apiKey + apiSecret are provided.
//
// Setup Guide:
// 1. Register at https://kite.trade/
// 2. Create an app (Type: Connect)
// 3. Set redirect URL: http://localhost:3000/auth/kite/callback
// 4. Copy apiKey + apiSecret into config.json
// 5. Set kite.enabled = true in config.json
// 6. Restart server — click "Login to Zerodha" on dashboard
//
// Tokens expire daily (~6 AM IST). User must re-login each morning.
// ========================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class KiteClient {
    constructor(config) {
        this.apiKey = config.apiKey || '';
        this.apiSecret = config.apiSecret || '';
        this.redirectUrl = config.redirectUrl || 'http://localhost:3000/auth/kite/callback';
        this.tokenFile = path.resolve(config.tokenFile || '.kite-token.json');
        this.accessToken = null;
        this.loadToken();
    }

    // --- Token Management ---

    loadToken() {
        try {
            if (fs.existsSync(this.tokenFile)) {
                const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
                // Check if token was created today (tokens expire daily)
                const tokenDate = new Date(data.timestamp).toDateString();
                const today = new Date().toDateString();
                if (tokenDate === today && data.accessToken) {
                    this.accessToken = data.accessToken;
                    console.log('  🔑 Kite token loaded (valid for today)');
                    return true;
                }
            }
        } catch (e) {
            console.log('  ⚠️  No valid Kite token found');
        }
        this.accessToken = null;
        return false;
    }

    saveToken(accessToken) {
        this.accessToken = accessToken;
        const data = { accessToken, timestamp: new Date().toISOString() };
        fs.writeFileSync(this.tokenFile, JSON.stringify(data, null, 2));
        console.log('  ✅ Kite token saved');
    }

    isAuthenticated() {
        return !!this.accessToken;
    }

    getLoginUrl() {
        return `https://kite.zerodha.com/connect/login?v=3&api_key=${this.apiKey}`;
    }

    // --- Exchange request_token for access_token ---
    async exchangeToken(requestToken) {
        const checksum = crypto
            .createHash('sha256')
            .update(this.apiKey + requestToken + this.apiSecret)
            .digest('hex');

        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                api_key: this.apiKey,
                request_token: requestToken,
                checksum: checksum,
            });

            const options = {
                hostname: 'api.kite.trade',
                path: '/session/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'X-Kite-Version': '3',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.data && parsed.data.access_token) {
                            this.saveToken(parsed.data.access_token);
                            resolve(parsed.data);
                        } else {
                            reject(new Error(parsed.message || 'Token exchange failed'));
                        }
                    } catch (e) {
                        reject(new Error('Invalid response from Kite'));
                    }
                });
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    // --- API Calls (stubs — activate when authenticated) ---

    async apiCall(endpoint) {
        if (!this.accessToken) return null;

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.kite.trade',
                path: endpoint,
                method: 'GET',
                headers: {
                    'X-Kite-Version': '3',
                    'Authorization': `token ${this.apiKey}:${this.accessToken}`,
                },
            };

            const req = https.get(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.data || parsed);
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(8000, () => { req.destroy(); resolve(null); });
        });
    }

    async getHoldings() { return this.apiCall('/portfolio/holdings'); }
    async getPositions() { return this.apiCall('/portfolio/positions'); }
    async getProfile() { return this.apiCall('/user/profile'); }

    async getQuote(symbols) {
        // symbols: array like ["NSE:RELIANCE", "NSE:TCS"]
        if (!this.accessToken || !symbols.length) return null;
        const query = symbols.map(s => `i=${s}`).join('&');
        return this.apiCall(`/quote?${query}`);
    }

    async getLTP(symbols) {
        if (!this.accessToken || !symbols.length) return null;
        const query = symbols.map(s => `i=${s}`).join('&');
        return this.apiCall(`/quote/ltp?${query}`);
    }
}

module.exports = KiteClient;
