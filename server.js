const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Storage } = require('@google-cloud/storage');

const KiteClient = require('./kite-client');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ===== KITE CONNECT SETUP =====
// Config: reads from environment variables (Render) or config.json (local dev)
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { console.log('⚠️  No config.json found, using env vars'); }

// Environment variables override config.json
const kiteConfig = {
    enabled: process.env.KITE_ENABLED === 'true' || (config.kite && config.kite.enabled),
    apiKey: process.env.KITE_API_KEY || config.kite?.apiKey || '',
    apiSecret: process.env.KITE_API_SECRET || config.kite?.apiSecret || '',
    redirectUrl: process.env.KITE_REDIRECT_URL || config.kite?.redirectUrl || 'http://localhost:3000/auth/kite/callback',
    tokenFile: config.kite?.tokenFile || '.kite-token.json',
};

let kiteClient = null;
if (kiteConfig.enabled && kiteConfig.apiKey) {
    kiteClient = new KiteClient(kiteConfig);
    console.log(`  🔗 Kite Connect enabled (API Key: ${kiteConfig.apiKey.substring(0, 6)}...)`);
    if (kiteClient.isAuthenticated()) {
        console.log('  ✅ Kite token found (valid for today)');
    } else {
        console.log('  ⚠️  Kite not authenticated — click "Login to Zerodha" on dashboard');
    }
} else {
    console.log('  ℹ️  Kite Connect disabled (set KITE_ENABLED=true or kite.enabled=true in config.json)');
}

// ===== AUTH — OTP + SESSION =====
const otpStore = new Map();     // email -> { otp, expiry, attempts }
const sessionStore = new Map(); // token -> { email, expiry }

// Email config: env vars (production) override config.json (local dev)
// Supports Gmail (EMAIL_SERVICE=gmail) and Resend (EMAIL_HOST=smtp.resend.com)
const emailCfg = {
    host: process.env.EMAIL_HOST || config.email?.host || '',
    port: parseInt(process.env.EMAIL_PORT || config.email?.port || '0', 10),
    service: process.env.EMAIL_SERVICE || config.email?.service || '',
    user: process.env.EMAIL_USER || config.email?.user || '',
    pass: process.env.EMAIL_PASS || config.email?.pass || '',
    from: process.env.EMAIL_FROM || config.email?.from || '',
};
let emailTransporter = null;
if (emailCfg.user && emailCfg.pass) {
    if (emailCfg.host) {
        // SMTP host mode (Resend, SES, etc.)
        emailTransporter = nodemailer.createTransport({
            host: emailCfg.host,
            port: emailCfg.port || 465,
            secure: (emailCfg.port || 465) === 465,
            auth: { user: emailCfg.user, pass: emailCfg.pass },
        });
    } else {
        // Gmail service mode (legacy)
        emailTransporter = nodemailer.createTransport({
            service: emailCfg.service || 'gmail',
            auth: { user: emailCfg.user, pass: emailCfg.pass },
        });
    }
}

// Admin email — the only email that can access /admin dashboard
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || config.adminEmail || '').toLowerCase().trim();

// Shared secret for Cloud Scheduler → cron endpoints. Set as a Secret Manager
// secret + bound to CRON_SECRET env var on Cloud Run. If empty, cron endpoints
// return 401 — protects against public abuse of /admin/cron/*.
const CRON_SECRET = process.env.CRON_SECRET || '';

// Public URL used in email reminder links. Set in Cloud Run env to the canonical
// service URL (e.g. https://seven-bar-dashboard-266880062356.asia-south1.run.app).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// ===== EMAIL WHITELIST (GCS-backed in production, local file in dev) =====
const WHITELIST_FILE = path.join(__dirname, 'authorized-emails.json');
const GCS_BUCKET = process.env.GCS_BUCKET || '';
const GCS_WHITELIST_KEY = 'authorized-emails.json';
let emailWhitelist = new Set();
let gcsWhitelistFile = null;

if (GCS_BUCKET) {
    try {
        const storage = new Storage();
        gcsWhitelistFile = storage.bucket(GCS_BUCKET).file(GCS_WHITELIST_KEY);
        console.log(`  ☁️  GCS whitelist: gs://${GCS_BUCKET}/${GCS_WHITELIST_KEY}`);
    } catch (e) {
        console.error('  ❌ GCS init failed:', e.message, '— falling back to local file');
    }
}

async function loadWhitelist() {
    try {
        let data;
        if (gcsWhitelistFile) {
            const [contents] = await gcsWhitelistFile.download();
            data = JSON.parse(contents.toString());
            console.log(`  ✅ Loaded ${data.length} authorized emails from GCS`);
        } else {
            data = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
            console.log(`  ✅ Loaded ${data.length} authorized emails from local file`);
        }
        emailWhitelist = new Set(data.map(e => e.toLowerCase().trim()).filter(Boolean));
    } catch (e) {
        console.error('  ❌ Failed to load whitelist:', e.message);
        // Try local file as fallback if GCS fails
        try {
            const data = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
            emailWhitelist = new Set(data.map(e => e.toLowerCase().trim()).filter(Boolean));
            console.log(`  ⚠️  Fell back to local file (${emailWhitelist.size} emails)`);
        } catch (e2) {
            emailWhitelist = new Set();
        }
    }
}

async function saveWhitelist() {
    const sorted = [...emailWhitelist].sort();
    const json = JSON.stringify(sorted, null, 2);
    // Always save locally (backup + dev mode)
    fs.writeFileSync(WHITELIST_FILE, json);
    // Save to GCS if configured
    if (gcsWhitelistFile) {
        await gcsWhitelistFile.save(json, { contentType: 'application/json', resumable: false });
    }
}

// Load whitelist at startup (async — server starts after this resolves)
let whitelistReady = loadWhitelist().then(() => {
    if (ADMIN_EMAIL) emailWhitelist.add(ADMIN_EMAIL);
});

// ===== 52-WEEK HIGH/LOW CACHE (Kite Historical, daily refresh, GCS-backed) =====
// Kite /quote does not return 52W H/L. We compute it from 1y of daily candles
// via /instruments/historical, cache to GCS so it survives container restarts,
// and refresh in background once per day (IST). During refresh, requests are
// served from the previous day's cache so users never see empty data.
const GCS_52W_KEY = '52w-cache.json';
const GCS_KITE_TOKEN_KEY = 'kite-token.json';
const INSTRUMENTS_FILE = path.join(__dirname, '.kite-instruments.json');
let gcs52WFile = null;
let gcsKiteTokenFile = null;
if (GCS_BUCKET) {
    try {
        const _storage = new Storage();
        gcs52WFile = _storage.bucket(GCS_BUCKET).file(GCS_52W_KEY);
        gcsKiteTokenFile = _storage.bucket(GCS_BUCKET).file(GCS_KITE_TOKEN_KEY);
        console.log(`  ☁️  GCS 52W cache: gs://${GCS_BUCKET}/${GCS_52W_KEY}`);
        console.log(`  ☁️  GCS Kite token: gs://${GCS_BUCKET}/${GCS_KITE_TOKEN_KEY}`);
    } catch (e) { /* GCS already failed once for whitelist — silent here */ }
}

// Wire Kite token persistence to GCS so deploys (= new containers) don't kill
// the access token. saveToken auto-mirrors; loadTokenRemote hydrates at startup.
if (kiteClient && gcsKiteTokenFile) {
    kiteClient.remoteSave = async (json) => {
        await gcsKiteTokenFile.save(json, { contentType: 'application/json', resumable: false });
    };
    // Hydrate at startup — fire-and-forget, no await (server can start without it)
    kiteClient.loadTokenRemote(async () => {
        try {
            const [contents] = await gcsKiteTokenFile.download();
            return contents.toString();
        } catch (e) { return null; }
    }).catch(() => {});
}

let weekHighLow = {};           // { SYMBOL: { high, low } }
let weekHighLowAsOf = null;     // 'YYYY-MM-DD' (IST) when cache was built
let weekHighLowRefreshing = false;
let instrumentTokens = {};      // { SYMBOL: instrument_token }

function todayIST() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function load52WCache() {
    if (!gcs52WFile) return;
    try {
        const [contents] = await gcs52WFile.download();
        const parsed = JSON.parse(contents.toString());
        weekHighLow = parsed.data || {};
        weekHighLowAsOf = parsed.asOf || null;
        console.log(`  ✅ Loaded 52W cache from GCS (asOf=${weekHighLowAsOf}, ${Object.keys(weekHighLow).length} symbols)`);
    } catch (e) {
        console.log('  ℹ️  No 52W cache in GCS yet (first run)');
    }
}

async function save52WCache() {
    if (!gcs52WFile) return;
    try {
        await gcs52WFile.save(
            JSON.stringify({ asOf: weekHighLowAsOf, data: weekHighLow }),
            { contentType: 'application/json', resumable: false }
        );
    } catch (e) {
        console.error('  ❌ 52W cache save failed:', e.message);
    }
}

function loadInstrumentTokens() {
    try {
        if (fs.existsSync(INSTRUMENTS_FILE)) {
            instrumentTokens = JSON.parse(fs.readFileSync(INSTRUMENTS_FILE, 'utf8'));
            console.log(`  📋 Loaded ${Object.keys(instrumentTokens).length} Kite instrument tokens from cache`);
        }
    } catch (e) { /* missing file is fine */ }
}

async function fetchInstrumentTokens() {
    if (!kiteClient?.isAuthenticated()) return;
    try {
        const map = await kiteClient.getNSEEQInstruments();
        if (map && Object.keys(map).length > 0) {
            instrumentTokens = map;
            try { fs.writeFileSync(INSTRUMENTS_FILE, JSON.stringify(map)); } catch (e) {}
            console.log(`  💾 Cached ${Object.keys(map).length} Kite NSE EQ instrument tokens`);
        }
    } catch (e) {
        console.error('  ❌ Kite instruments fetch failed:', e.message);
    }
}

// Returns { success, missing, skipped: 'reason' } so cron caller can decide
// whether to alert/retry. success=0 with no error string still counts as failure.
async function refresh52WCache() {
    if (weekHighLowRefreshing) return { success: 0, missing: 0, skipped: 'already_refreshing' };
    if (!kiteClient?.isAuthenticated()) return { success: 0, missing: 0, skipped: 'kite_unauthed' };
    if (nifty500SymbolList.length === 0) return { success: 0, missing: 0, skipped: 'no_symbol_list' };

    weekHighLowRefreshing = true;
    const startTime = Date.now();
    console.log(`  🔄 Refreshing 52W cache for ${nifty500SymbolList.length} symbols (background, ~3 min)...`);

    try {
        if (Object.keys(instrumentTokens).length === 0) {
            await fetchInstrumentTokens();
        }

        const today = new Date();
        const from = new Date(today.getTime() - 380 * 86400 * 1000);
        const toStr = today.toISOString().slice(0, 10);
        const fromStr = from.toISOString().slice(0, 10);

        const newCache = {};
        let success = 0, missing = 0;

        // Kite historical rate limit: 3 req/sec → 350ms gap between calls
        for (const symbol of nifty500SymbolList) {
            const token = instrumentTokens[symbol];
            if (!token) { missing++; continue; }

            try {
                const data = await kiteClient.getHistoricalData(token, 'day', fromStr, toStr);
                if (data?.candles?.length) {
                    let high = 0, low = Infinity;
                    for (const c of data.candles) {
                        // candle = [timestamp, open, high, low, close, volume]
                        if (c[2] > high) high = c[2];
                        if (c[3] < low) low = c[3];
                    }
                    if (high > 0 && low < Infinity) {
                        newCache[symbol] = { high, low };
                        success++;
                    }
                }
            } catch (e) { /* skip failures, don't poison whole refresh */ }

            await new Promise(r => setTimeout(r, 350));
        }

        if (success > 0) {
            weekHighLow = newCache;
            weekHighLowAsOf = todayIST();
            await save52WCache();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  ✅ 52W cache refreshed: ${success} symbols in ${elapsed}s (${missing} missing tokens)`);
        } else {
            console.error('  ❌ 52W refresh produced no data — keeping previous cache');
        }
        return { success, missing };
    } finally {
        weekHighLowRefreshing = false;
    }
}

// Fire-and-forget: trigger refresh if cache is stale and not already refreshing.
// Cache is considered fresh if asOf == today's IST date.
function maybeRefresh52W() {
    if (weekHighLowAsOf === todayIST()) return;
    if (weekHighLowRefreshing) return;
    refresh52WCache(); // no await — runs in background
}

// Load cache + instrument tokens at startup (parallel with whitelist load)
loadInstrumentTokens();
load52WCache();

// ===== SECTOR CONSTITUENTS (NSE archive CSVs — static, no auth, stable) =====
// NSE deprecated /api/equity-stockIndices but still publishes daily constituent
// lists at archives.nseindia.com. We use those for the sector list, then fetch
// live quotes for each constituent from Kite. 24h in-memory cache (constituents
// rarely change intraday).
const SECTOR_CSV_MAP = {
    'NIFTY IT': 'ind_niftyitlist.csv',
    'NIFTY BANK': 'ind_niftybanklist.csv',
    'NIFTY PHARMA': 'ind_niftypharmalist.csv',
    'NIFTY AUTO': 'ind_niftyautolist.csv',
    'NIFTY FMCG': 'ind_niftyfmcglist.csv',
    'NIFTY METAL': 'ind_niftymetallist.csv',
    'NIFTY REALTY': 'ind_niftyrealtylist.csv',
    'NIFTY ENERGY': 'ind_niftyenergylist.csv',
    'NIFTY INFRASTRUCTURE': 'ind_niftyinfralist.csv',
    'NIFTY PSU BANK': 'ind_niftypsubanklist.csv',
    'NIFTY MEDIA': 'ind_niftymedialist.csv',
    'NIFTY FINANCIAL SERVICES': 'ind_niftyfinancelist.csv',
    'NIFTY HEALTHCARE INDEX': 'ind_niftyhealthcarelist.csv',
    'NIFTY CONSUMER DURABLES': 'ind_niftyconsumerdurableslist.csv',
    'NIFTY OIL & GAS': 'ind_niftyoilgaslist.csv',
    'NIFTY SMALLCAP 250': 'ind_niftysmallcap250list.csv',
    'NIFTY 500': 'ind_nifty500list.csv',
};

const sectorConstituentsCache = {}; // { sector: { symbols, time } }
const SECTOR_CONSTITUENTS_TTL = 24 * 3600 * 1000; // 24h

async function getSectorConstituents(sector) {
    const cached = sectorConstituentsCache[sector];
    if (cached && (Date.now() - cached.time) < SECTOR_CONSTITUENTS_TTL) return cached.symbols;
    const file = SECTOR_CSV_MAP[sector];
    if (!file) return null;
    try {
        const csv = await fetchUrlWithHeaders(
            `https://archives.nseindia.com/content/indices/${file}`,
            { 'User-Agent': 'Mozilla/5.0' }
        );
        const lines = csv.split('\n');
        if (lines.length < 2) return null;
        const header = lines[0].split(',');
        const symIdx = header.findIndex(h => h.trim() === 'Symbol');
        if (symIdx < 0) return null;
        const symbols = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const s = cols[symIdx]?.trim();
            if (s) symbols.push(s);
        }
        sectorConstituentsCache[sector] = { symbols, time: Date.now() };
        console.log(`  📋 Loaded ${symbols.length} constituents for ${sector} from NSE archive`);
        return symbols;
    } catch (e) {
        console.error(`  ❌ Sector CSV fetch failed for ${sector}: ${e.message}`);
        return null;
    }
}

function generateOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function sendOtpEmail(email, otp) {
    if (!emailTransporter) {
        // Dev mode — print to console
        console.log(`\n  🔑 OTP for ${email}: ${otp}  (no email config — dev mode)\n`);
        return;
    }
    await emailTransporter.sendMail({
        from: emailCfg.from || `"Market Monitor" <${emailCfg.user}>`,
        to: email,
        subject: 'Your Market Monitor Access Code',
        html: `
            <div style="font-family:Inter,sans-serif;background:#0a0e1a;color:#e0e0e0;padding:40px;border-radius:12px;max-width:480px;margin:0 auto">
                <h2 style="color:#00e676;margin:0 0 8px">Market Monitor</h2>
                <p style="color:#888;margin:0 0 32px;font-size:13px">Indian Market Intelligence Dashboard</p>
                <p style="margin:0 0 16px">Your one-time access code is:</p>
                <div style="background:#141824;border:1px solid #00e676;border-radius:8px;padding:24px;text-align:center;letter-spacing:12px;font-size:36px;font-weight:700;color:#00e676;font-family:monospace">
                    ${otp}
                </div>
                <p style="color:#888;font-size:12px;margin:24px 0 0">This code expires in 10 minutes. Do not share it with anyone.</p>
            </div>
        `
    });
}

// ===== KITE AUTH REMINDER (admin-only) =====
// Hardcoded recipient — never sends to any other address. If you need to change
// the admin, edit this constant + the Cloud Run ADMIN_EMAIL secret together.
const AUTH_REMINDER_RECIPIENT = 'nirvairkhanuja111@gmail.com';

async function sendAuthReminder() {
    if (!emailTransporter) { console.log('  ⚠️  No email transport — skipping auth reminder'); return; }
    if (kiteClient?.isAuthenticated()) {
        console.log('  ℹ️  Kite already authenticated today — skipping reminder');
        return;
    }
    const loginUrl = PUBLIC_URL ? `${PUBLIC_URL}/auth/kite` : '/auth/kite';
    try {
        await emailTransporter.sendMail({
            from: emailCfg.from || `"Market Monitor" <${emailCfg.user}>`,
            to: AUTH_REMINDER_RECIPIENT,
            subject: 'Market Monitor — Kite re-auth needed before market open',
            html: `
                <div style="font-family:Inter,sans-serif;background:#0a0e1a;color:#e0e0e0;padding:40px;border-radius:12px;max-width:520px;margin:0 auto">
                    <h2 style="color:#00e676;margin:0 0 8px">Market Monitor</h2>
                    <p style="color:#888;margin:0 0 24px;font-size:13px">Kite Connect session expired at ~06:00 IST today.</p>
                    <p style="margin:0 0 24px">Without re-auth: Top Stocks, Gainers, Losers, sector drilldowns and Stock Analyser will be empty for users today.</p>
                    <a href="${loginUrl}" style="display:inline-block;background:#00e676;color:#0a0e1a;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Re-auth with Zerodha →</a>
                    <p style="color:#888;font-size:12px;margin:24px 0 0">Takes ~15 seconds. After login, the 52W cache auto-refreshes in the background.</p>
                </div>
            `
        });
        console.log(`  ✉️  Auth reminder sent to ${AUTH_REMINDER_RECIPIENT}`);
    } catch (e) {
        console.error(`  ❌ Auth reminder email failed: ${e.message}`);
    }
}

// Cron endpoint auth — shared secret in X-Cron-Secret header.
// Cloud Scheduler sets the header; public callers without it get 401.
function cronAuth(req) {
    if (!CRON_SECRET) return false;
    return (req.headers['x-cron-secret'] || '') === CRON_SECRET;
}

// Email the hardcoded admin recipient when an automated job fails (Gap 1).
// Always goes to AUTH_REMINDER_RECIPIENT, never anyone else.
async function sendAdminAlert(subject, body) {
    if (!emailTransporter) { console.log(`  ⚠️  Alert (no email transport): ${subject}`); return; }
    const loginUrl = PUBLIC_URL ? `${PUBLIC_URL}/auth/kite` : '/auth/kite';
    try {
        await emailTransporter.sendMail({
            from: emailCfg.from || `"Market Monitor" <${emailCfg.user}>`,
            to: AUTH_REMINDER_RECIPIENT,
            subject: `Market Monitor — ${subject}`,
            html: `
                <div style="font-family:Inter,sans-serif;background:#0a0e1a;color:#e0e0e0;padding:40px;border-radius:12px;max-width:520px;margin:0 auto">
                    <h2 style="color:#ff5252;margin:0 0 8px">⚠️ Job alert</h2>
                    <p style="margin:0 0 16px">${body}</p>
                    <a href="${loginUrl}" style="display:inline-block;background:#00e676;color:#0a0e1a;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Re-auth with Zerodha →</a>
                    <p style="color:#888;font-size:12px;margin:24px 0 0">${new Date().toISOString()}</p>
                </div>
            `
        });
        console.log(`  ✉️  Admin alert sent: ${subject}`);
    } catch (e) {
        console.error(`  ❌ Admin alert email failed: ${e.message}`);
    }
}

// ===== MIME TYPES =====
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// ===== COMMODITIES & FOREX DATA LAYER =====

let commodityCache = {};
const COMMODITY_CACHE_TTL = 120000; // 2 min

// POST helper for TradingView scanner API
function postJson(targetUrl, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const urlObj = new URL(targetUrl);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://www.tradingview.com',
                'Referer': 'https://www.tradingview.com/'
            }
        };
        const req = https.request(options, (res) => {
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(payload);
        req.end();
    });
}

// Fetch Gold + USDINR in one shot from TradingView scanner
// Uses a shared in-flight promise so concurrent calls share one HTTP request
let _tvInFlight = null;
let _tvCacheTime = 0;
const TV_CACHE_TTL = 90000; // 90s — slightly less than commodity TTL

async function fetchFromTradingView() {
    const now = Date.now();
    // Return cached result if fresh
    if (_tvInFlight === null && commodityCache._tv && (now - _tvCacheTime) < TV_CACHE_TTL) {
        return commodityCache._tv;
    }
    // If a request is already in flight, wait for it rather than firing another
    if (_tvInFlight) return _tvInFlight;

    _tvInFlight = (async () => {
        try {
            const raw = await postJson('https://scanner.tradingview.com/global/scan', {
                symbols: { tickers: ['TVC:GOLD', 'FX_IDC:USDINR'] },
                columns: ['close', 'change', 'change_abs', 'open', 'high', 'low']
            });
            const json = JSON.parse(raw);
            const result = {};
            for (const item of (json.data || [])) {
                const [close, changePct, changeAbs] = item.d;
                const prevClose = (close || 0) - (changeAbs || 0);
                result[item.s] = { price: close, prevClose, change: changePct || 0 };
            }
            commodityCache._tv = result;
            _tvCacheTime = Date.now();
            return result;
        } finally {
            _tvInFlight = null;
        }
    })();

    return _tvInFlight;
}

async function fetchGoldPrice() {
    const now = Date.now();
    if (commodityCache.gold && (now - commodityCache.gold.time) < COMMODITY_CACHE_TTL) return commodityCache.gold.data;

    // 1. TradingView scanner (TVC:GOLD spot USD/oz) — primary, also populates USDINR cache
    try {
        const tv = await fetchFromTradingView();
        if (tv['TVC:GOLD']?.price) {
            commodityCache.gold = { data: tv['TVC:GOLD'], time: now };
            if (tv['FX_IDC:USDINR']?.price) commodityCache.usdinr = { data: tv['FX_IDC:USDINR'], time: now };
            return tv['TVC:GOLD'];
        }
    } catch (e) { console.log('TradingView gold fallback:', e.message); }

    // 2. Kite Connect (MCX Gold — most accurate for INR price, requires auth)
    if (kiteClient?.isAuthenticated()) {
        try {
            const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
            const d = new Date();
            const yy = String(d.getFullYear()).slice(-2);
            const sym = `MCX:GOLDM${yy}${months[d.getMonth()]}FUT`;
            const quote = await kiteClient.getQuote([sym]);
            if (quote && quote[sym]) {
                const q = quote[sym];
                const price = q.last_price;
                const prevClose = q.ohlc?.close || price;
                const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
                const data = { price, prevClose, change };
                commodityCache.gold = { data, time: now };
                return data;
            }
        } catch (e) { console.log('Kite gold fallback:', e.message); }
    }

    // 3. metals.live (free, no key required)
    try {
        const raw = await fetchUrl('https://api.metals.live/v1/spot');
        const arr = JSON.parse(raw);
        const price = Array.isArray(arr) ? arr.find(x => x.gold)?.gold : arr.gold;
        if (price) {
            const prev = commodityCache['gold_prev']?.price || price;
            const change = prev ? ((price - prev) / prev * 100) : 0;
            const data = { price, prevClose: prev, change };
            commodityCache.gold = { data, time: now };
            if (!commodityCache['gold_prev']) commodityCache['gold_prev'] = { price };
            return data;
        }
    } catch (e) { console.log('metals.live gold fallback:', e.message); }

    // 4. gold-api.com (last resort)
    try {
        const raw = await fetchUrl('https://api.gold-api.com/price/XAU');
        const json = JSON.parse(raw);
        const price = json.price || 0;
        const prev = commodityCache['gold_prev']?.price || price;
        const change = prev ? ((price - prev) / prev * 100) : 0;
        const data = { price, prevClose: prev, change };
        commodityCache.gold = { data, time: now };
        if (!commodityCache['gold_prev']) commodityCache['gold_prev'] = { price };
        return data;
    } catch (e) {
        console.error('Gold price error (all sources failed):', e.message);
        return { price: 0, prevClose: 0, change: 0 };
    }
}

async function fetchUSDINRRate() {
    const now = Date.now();
    if (commodityCache.usdinr && (now - commodityCache.usdinr.time) < COMMODITY_CACHE_TTL) return commodityCache.usdinr.data;

    // 1. TradingView scanner (FX_IDC:USDINR) — primary, also populates Gold cache
    try {
        const tv = await fetchFromTradingView();
        if (tv['FX_IDC:USDINR']?.price) {
            commodityCache.usdinr = { data: tv['FX_IDC:USDINR'], time: now };
            if (tv['TVC:GOLD']?.price) commodityCache.gold = { data: tv['TVC:GOLD'], time: now };
            return tv['FX_IDC:USDINR'];
        }
    } catch (e) { console.log('TradingView USDINR fallback:', e.message); }

    // 2. Kite Connect (CDS USDINR futures — most accurate, requires auth)
    if (kiteClient?.isAuthenticated()) {
        try {
            const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
            const d = new Date();
            const yy = String(d.getFullYear()).slice(-2);
            const sym = `CDS:USDINR${yy}${months[d.getMonth()]}FUT`;
            const quote = await kiteClient.getQuote([sym]);
            if (quote && quote[sym]) {
                const q = quote[sym];
                const price = q.last_price;
                const prevClose = q.ohlc?.close || price;
                const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
                const data = { price, prevClose, change };
                commodityCache.usdinr = { data, time: now };
                return data;
            }
        } catch (e) { console.log('Kite USDINR fallback:', e.message); }
    }

    // 3. Frankfurter (ECB data — reliable, updates daily)
    try {
        const raw = await fetchUrl('https://api.frankfurter.app/latest?from=USD&to=INR');
        const json = JSON.parse(raw);
        const price = json.rates?.INR || 0;
        const prev = commodityCache['usdinr_prev']?.price || price;
        const change = prev ? ((price - prev) / prev * 100) : 0;
        const data = { price, prevClose: prev, change };
        commodityCache.usdinr = { data, time: now };
        if (!commodityCache['usdinr_prev']) commodityCache['usdinr_prev'] = { price };
        return data;
    } catch (e) { console.log('Frankfurter USDINR fallback:', e.message); }

    // 4. open.er-api (last resort)
    try {
        const raw = await fetchUrl('https://open.er-api.com/v6/latest/USD');
        const json = JSON.parse(raw);
        const price = json.rates?.INR || 0;
        const prev = commodityCache['usdinr_prev']?.price || price;
        const change = prev ? ((price - prev) / prev * 100) : 0;
        const data = { price, prevClose: prev, change };
        commodityCache.usdinr = { data, time: now };
        if (!commodityCache['usdinr_prev']) commodityCache['usdinr_prev'] = { price };
        return data;
    } catch (e) {
        console.error('USDINR error (all sources failed):', e.message);
        return { price: 0, prevClose: 0, change: 0 };
    }
}

// ===== NIFTY EMA CALCULATION (real EMA from historical data) =====

function calculateEMA(closes, period) {
    if (closes.length < period) return null;
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
}

let emaCache = { data: null, time: 0 };
const EMA_CACHE_TTL = 300000; // 5 min
const NIFTY_50_INSTRUMENT_TOKEN = 256265;

// Fetch Nifty 50 daily close prices from our Market Breadth Google Sheet (no Yahoo dependency)
async function fetchNiftyDailyCloses() {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1NVZd8aZbmKXhHYnfgfOLjlLiyoWfZnKy9v3MWT5jT68/export?format=csv&gid=190844943';
    const csv = await fetchUrlWithHeaders(sheetUrl, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
    });
    const lines = csv.trim().split('\n').filter(l => l.trim());
    const closes = [];
    // Skip header (row 0), data is newest-first
    for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.replace(/"/g, '').replace('%', '').trim());
        const niftyClose = parseFloat(vals[15]); // Column 16 = Nifty close
        if (!isNaN(niftyClose) && niftyClose > 0) closes.push(niftyClose);
    }
    // Reverse to chronological order (oldest first) for EMA calculation
    closes.reverse();
    if (closes.length >= 50) {
        console.log(`  ✅ EMA: Got ${closes.length} daily closes from Google Sheet`);
        return closes;
    }
    throw new Error(`Insufficient sheet data: only ${closes.length} closes`);
}

async function getNiftyEMAStatus() {
    const now = Date.now();
    if (emaCache.data && (now - emaCache.time) < EMA_CACHE_TTL) return emaCache.data;

    let closes = null;

    // Method 1: Kite historical data (works when authenticated)
    if (kiteClient?.isAuthenticated()) {
        try {
            const to = new Date().toISOString().split('T')[0];
            const fromDate = new Date(Date.now() - 100 * 86400000).toISOString().split('T')[0];
            const hist = await kiteClient.getHistoricalData(NIFTY_50_INSTRUMENT_TOKEN, 'day', fromDate, to);
            if (hist && hist.candles && hist.candles.length >= 50) {
                closes = hist.candles.map(c => c[4]); // [timestamp, O, H, L, C, V]
                console.log(`  ✅ EMA: Got ${closes.length} daily closes from Kite`);
            }
        } catch (e) { console.log('  ⚠️  Kite EMA failed:', e.message); }
    }

    // Method 2: Google Sheet daily closes (works globally, no auth needed)
    if (!closes) {
        try {
            closes = await fetchNiftyDailyCloses();
        } catch (e) { console.log('  ⚠️  Sheet EMA failed:', e.message); }
    }

    // Calculate EMAs from real data
    if (closes && closes.length >= 50) {
        const currentPrice = closes[closes.length - 1];
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);

        let status = 'no'; // Default: below 50 EMA
        if (currentPrice > ema50) status = 'selective'; // Above 50 EMA but below 21
        if (currentPrice > ema21) status = 'yes'; // Above 21 EMA

        console.log(`  📊 EMA Status: Nifty=${currentPrice.toFixed(0)} | 21EMA=${ema21?.toFixed(0)} | 50EMA=${ema50?.toFixed(0)} → ${status}`);

        const result = { status, currentPrice, ema21, ema50 };
        emaCache = { data: result, time: now };
        return result;
    }

    // Absolute last resort: get current price from NSE allIndices but mark EMA as unknown
    try {
        const { data } = await getCachedNSE('allIndices', '/api/allIndices');
        const nifty50 = data.data?.find(idx => idx.index === 'NIFTY 50');
        if (nifty50) {
            const niftyLast = parseFloat(nifty50.last) || 0;
            console.log(`  ⚠️  EMA: No historical data available. Nifty=${niftyLast}. Defaulting to 'no' (cannot calculate EMAs)`);
            const result = { status: 'no', currentPrice: niftyLast, ema21: 0, ema50: 0, noHistory: true };
            emaCache = { data: result, time: now };
            return result;
        }
    } catch (e) { /* NSE also failed */ }

    console.log('  ❌ EMA: All data sources failed');
    return { status: 'no', currentPrice: 0, ema21: 0, ema50: 0, noHistory: true };
}

// ===== UTILITY: Generic URL Fetcher =====

function fetchUrl(targetUrl) {
    return fetchUrlWithHeaders(targetUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
}

function fetchUrlWithHeaders(targetUrl, headers = {}, _redirects = 0) {
    return new Promise((resolve, reject) => {
        if (_redirects > 5) return reject(new Error('Too many redirects'));
        const lib = targetUrl.startsWith('https') ? https : http;
        const req = lib.get(targetUrl, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, targetUrl).href;
                fetchUrlWithHeaders(next, headers, _redirects + 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode >= 400) {
                return reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ===== NIFTY 500 SYMBOL LIST PERSISTENCE =====
// Saves symbol list when NSE works (India), reads from file when NSE fails (Render)

const NIFTY500_SYMBOLS_FILE = path.join(__dirname, 'nifty500-symbols.json');
let nifty500SymbolList = [];

function loadNifty500Symbols() {
    try {
        if (fs.existsSync(NIFTY500_SYMBOLS_FILE)) {
            nifty500SymbolList = JSON.parse(fs.readFileSync(NIFTY500_SYMBOLS_FILE, 'utf8'));
            console.log(`  📋 Loaded ${nifty500SymbolList.length} Nifty 500 symbols from cache`);
        }
    } catch (e) { console.log('  ⚠️  No cached Nifty 500 symbol list'); }
}

function saveNifty500Symbols(symbols) {
    if (symbols.length < 400) return; // sanity check
    nifty500SymbolList = symbols;
    try {
        fs.writeFileSync(NIFTY500_SYMBOLS_FILE, JSON.stringify(symbols));
        console.log(`  💾 Saved ${symbols.length} Nifty 500 symbols`);
    } catch (e) { /* might fail on read-only filesystem */ }
}

loadNifty500Symbols();

// ===== KITE DATA FALLBACK LAYER =====
// When NSE API fails (geo-blocked overseas), use Kite Connect as data source

const KITE_INDEX_SYMBOLS = [
    'NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY SMLCAP 250',
    'NSE:NIFTY IT', 'NSE:NIFTY PHARMA', 'NSE:NIFTY AUTO',
    'NSE:NIFTY FMCG', 'NSE:NIFTY METAL', 'NSE:NIFTY REALTY',
    'NSE:NIFTY ENERGY', 'NSE:NIFTY INFRA', 'NSE:NIFTY PSU BANK',
    'NSE:NIFTY MEDIA', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY HEALTHCARE',
    'NSE:NIFTY CONSR DURBL', 'NSE:NIFTY OIL AND GAS',
];

const KITE_SECTOR_MAP = {
    'NSE:NIFTY IT': { name: 'IT', fullName: 'Nifty IT' },
    'NSE:NIFTY BANK': { name: 'Bank', fullName: 'Nifty Bank' },
    'NSE:NIFTY PHARMA': { name: 'Pharma', fullName: 'Nifty Pharma' },
    'NSE:NIFTY AUTO': { name: 'Auto', fullName: 'Nifty Auto' },
    'NSE:NIFTY FMCG': { name: 'FMCG', fullName: 'Nifty FMCG' },
    'NSE:NIFTY METAL': { name: 'Metal', fullName: 'Nifty Metal' },
    'NSE:NIFTY REALTY': { name: 'Realty', fullName: 'Nifty Realty' },
    'NSE:NIFTY ENERGY': { name: 'Energy', fullName: 'Nifty Energy' },
    'NSE:NIFTY INFRA': { name: 'Infra', fullName: 'Nifty Infra' },
    'NSE:NIFTY PSU BANK': { name: 'PSU Bank', fullName: 'Nifty PSU Bank' },
    'NSE:NIFTY MEDIA': { name: 'Media', fullName: 'Nifty Media' },
    'NSE:NIFTY FIN SERVICE': { name: 'FinServ', fullName: 'Nifty Financial Services' },
    'NSE:NIFTY HEALTHCARE': { name: 'Healthcare', fullName: 'Nifty Healthcare' },
    'NSE:NIFTY CONSR DURBL': { name: 'Consumer', fullName: 'Nifty Consumer Durables' },
    'NSE:NIFTY OIL AND GAS': { name: 'Oil & Gas', fullName: 'Nifty Oil & Gas' },
};

// Reverse map: Kite symbol → NSE canonical index name.
// Required because Kite abbreviates names (SMLCAP, INFRA, CONSR DURBL) but
// downstream consumers (SECTOR_INDEX_MAP, dashboard KPI lookups) match by
// NSE's full names. Without this, sectors silently drop from heatmap and
// the SMALLCAP KPI shows '--'.
const KITE_TO_NSE_INDEX = {
    'NSE:NIFTY 50': 'NIFTY 50',
    'NSE:NIFTY BANK': 'NIFTY BANK',
    'NSE:NIFTY SMLCAP 250': 'NIFTY SMALLCAP 250',
    'NSE:NIFTY IT': 'NIFTY IT',
    'NSE:NIFTY PHARMA': 'NIFTY PHARMA',
    'NSE:NIFTY AUTO': 'NIFTY AUTO',
    'NSE:NIFTY FMCG': 'NIFTY FMCG',
    'NSE:NIFTY METAL': 'NIFTY METAL',
    'NSE:NIFTY REALTY': 'NIFTY REALTY',
    'NSE:NIFTY ENERGY': 'NIFTY ENERGY',
    'NSE:NIFTY INFRA': 'NIFTY INFRASTRUCTURE',
    'NSE:NIFTY PSU BANK': 'NIFTY PSU BANK',
    'NSE:NIFTY MEDIA': 'NIFTY MEDIA',
    'NSE:NIFTY FIN SERVICE': 'NIFTY FINANCIAL SERVICES',
    'NSE:NIFTY HEALTHCARE': 'NIFTY HEALTHCARE INDEX',
    'NSE:NIFTY CONSR DURBL': 'NIFTY CONSUMER DURABLES',
    'NSE:NIFTY OIL AND GAS': 'NIFTY OIL & GAS',
};

let kiteDataCache = { allIndices: null, nifty500: null, time: 0 };
const KITE_DATA_CACHE_TTL = 30000; // 30s

async function fetchAllFromKite() {
    const now = Date.now();
    if (kiteDataCache.allIndices && (now - kiteDataCache.time) < KITE_DATA_CACHE_TTL) return kiteDataCache;
    if (!kiteClient?.isAuthenticated()) return null;

    try {
        // Fetch index quotes
        const indexQuotes = await kiteClient.getQuote(KITE_INDEX_SYMBOLS);
        if (!indexQuotes) return null;

        // Fetch Nifty 500 stock quotes (if we have the symbol list)
        let stockQuotes = null;
        if (nifty500SymbolList.length > 0) {
            const kiteSymbols = nifty500SymbolList.map(s => `NSE:${s}`);
            stockQuotes = await kiteClient.getQuoteBatched(kiteSymbols);
        }

        kiteDataCache = { allIndices: indexQuotes, nifty500: stockQuotes, time: now };
        return kiteDataCache;
    } catch (e) {
        console.error('  ❌ Kite bulk fetch error:', e.message);
        return null;
    }
}

// Transform Kite index quotes into NSE allIndices format
function kiteToNSEAllIndices(kiteIndices, kiteStocks) {
    const result = [];
    for (const [sym, q] of Object.entries(kiteIndices || {})) {
        if (!q || !q.last_price) continue;
        const prevClose = q.ohlc?.close || q.last_price;
        const pctChange = prevClose ? ((q.last_price - prevClose) / prevClose * 100) : 0;

        // Map Kite symbol to NSE canonical index name (e.g., SMLCAP → SMALLCAP)
        const indexName = KITE_TO_NSE_INDEX[sym] || sym.replace('NSE:', '');
        let advances = 0, declines = 0, unchanged = 0;

        // Compute advance/decline for NIFTY 500 from stock quotes
        if (indexName === 'NIFTY 50' && kiteStocks) {
            for (const [, sq] of Object.entries(kiteStocks)) {
                if (!sq || !sq.last_price) continue;
                const sPrev = sq.ohlc?.close || sq.last_price;
                const sChg = sq.last_price - sPrev;
                if (sChg > 0) advances++;
                else if (sChg < 0) declines++;
                else unchanged++;
            }
        }

        result.push({
            index: indexName,
            last: String(q.last_price),
            percentChange: String(pctChange.toFixed(2)),
            open: String(q.ohlc?.open || 0),
            previousClose: String(prevClose),
            advances, declines, unchanged,
        });
    }

    // Add NIFTY 500 entry with advance/decline totals
    if (kiteStocks) {
        let adv = 0, dec = 0, unch = 0;
        for (const [, sq] of Object.entries(kiteStocks)) {
            if (!sq || !sq.last_price) continue;
            const sPrev = sq.ohlc?.close || sq.last_price;
            const sChg = sq.last_price - sPrev;
            if (sChg > 0) adv++;
            else if (sChg < 0) dec++;
            else unch++;
        }
        result.push({
            index: 'NIFTY 500',
            last: '0', percentChange: '0',
            open: '0', previousClose: '0',
            advances: adv, declines: dec, unchanged: unch,
        });
    }

    return { data: result };
}

// Transform Kite stock quotes into NSE equity-stockIndices format
function kiteToNSEStocks(kiteStocks) {
    if (!kiteStocks) return { data: [] };
    const stocks = [];
    for (const [sym, q] of Object.entries(kiteStocks)) {
        if (!q || !q.last_price) continue;
        const symbol = sym.replace('NSE:', '');
        const prevClose = q.ohlc?.close || q.last_price;
        const pctChange = prevClose ? ((q.last_price - prevClose) / prevClose * 100) : 0;
        const wHL = weekHighLow[symbol];
        stocks.push({
            symbol,
            lastPrice: String(q.last_price),
            pChange: String(pctChange.toFixed(2)),
            open: String(q.ohlc?.open || 0),
            dayHigh: String(q.ohlc?.high || q.last_price),
            dayLow: String(q.ohlc?.low || q.last_price),
            previousClose: String(prevClose),
            // 52W H/L injected from daily-refreshed cache (server.js 52W layer).
            // Kite /quote does not return these; cache is built from /historical.
            yearHigh: String(wHL?.high || 0),
            yearLow: String(wHL?.low || 0),
            totalTradedVolume: String(q.volume || 0),
            totalTradedValue: '0',
            meta: { companyName: '' },
        });
    }
    return { data: [{ symbol: 'NIFTY 500', index: 'NIFTY 500' }, ...stocks] };
}

// ================================================================
// ===== NSE INDIA DATA LAYER ====================================
// ================================================================

// --- NSE Cookie/Session Manager ---
let nseCookies = '';
let nseCookieExpiry = 0;
const NSE_COOKIE_TTL = 80000; // 80 seconds (NSE cookies expire ~90-120s)
const NSE_BASE = 'https://www.nseindia.com';
const NSE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function refreshNSESession() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'www.nseindia.com',
            path: '/',
            method: 'GET',
            headers: {
                'User-Agent': NSE_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive',
            },
        };

        const req = https.get(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const setCookies = res.headers['set-cookie'] || [];
                const cookieParts = setCookies.map(c => c.split(';')[0]);
                nseCookies = cookieParts.join('; ');
                nseCookieExpiry = Date.now() + NSE_COOKIE_TTL;
                console.log(`  🍪 NSE cookies refreshed (${cookieParts.length} cookies)`);
                resolve(nseCookies);
            });
        });
        req.on('error', (e) => {
            console.error('  ❌ NSE cookie refresh failed:', e.message);
            reject(e);
        });
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('NSE cookie timeout')); });
    });
}

async function getNSECookies() {
    if (nseCookies && Date.now() < nseCookieExpiry) {
        return nseCookies;
    }
    return await refreshNSESession();
}

// --- NSE API Fetcher (with cookie management) ---
function fetchNSE(apiPath, retryCount = 0) {
    return new Promise(async (resolve, reject) => {
        try {
            const cookies = await getNSECookies();
            const options = {
                hostname: 'www.nseindia.com',
                path: apiPath,
                method: 'GET',
                headers: {
                    'User-Agent': NSE_USER_AGENT,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'identity',
                    'Referer': 'https://www.nseindia.com/',
                    'Cookie': cookies,
                    'Connection': 'keep-alive',
                },
            };

            const req = https.get(options, (res) => {
                // Handle 401/403 by refreshing cookies and retrying
                if ((res.statusCode === 401 || res.statusCode === 403) && retryCount < 2) {
                    console.log(`  ⚠️  NSE ${res.statusCode} on ${apiPath}, refreshing cookies (retry ${retryCount + 1})`);
                    nseCookies = '';
                    nseCookieExpiry = 0;
                    setTimeout(() => {
                        fetchNSE(apiPath, retryCount + 1).then(resolve).catch(reject);
                    }, 1000 + retryCount * 2000);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`NSE HTTP ${res.statusCode} for ${apiPath}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`NSE JSON parse error for ${apiPath}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(12000, () => { req.destroy(); reject(new Error(`NSE timeout for ${apiPath}`)); });
        } catch (e) {
            reject(e);
        }
    });
}

// --- NSE Data Cache ---
const nseCache = {};
const NSE_CACHE_TTL_MARKET = 30000;   // 30 seconds during market hours
const NSE_CACHE_TTL_OFFHOURS = 300000; // 5 minutes outside market hours

function isMarketHours() {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    const h = ist.getHours();
    const m = ist.getMinutes();
    const t = h * 100 + m;
    return day >= 1 && day <= 5 && t >= 915 && t <= 1535;
}

// Kite-primary, NSE-fallback for keys Kite covers (allIndices, nifty500).
// NSE deprecated /api/equity-stockIndices in May 2026, so Kite is now the
// reliable source. Sector-XXX keys have no Kite equivalent — NSE-only.
async function getCachedNSE(key, apiPath) {
    const now = Date.now();
    const ttl = isMarketHours() ? NSE_CACHE_TTL_MARKET : NSE_CACHE_TTL_OFFHOURS;

    if (nseCache[key] && (now - nseCache[key].timestamp) < ttl) {
        return { data: nseCache[key].data, cached: true };
    }

    const kiteCovers = key === 'allIndices' || key === 'nifty500';

    const fromKite = async () => {
        const kiteData = await fetchAllFromKite();
        if (!kiteData) return null;
        if (key === 'allIndices') return kiteToNSEAllIndices(kiteData.allIndices, kiteData.nifty500);
        if (key === 'nifty500') return kiteToNSEStocks(kiteData.nifty500);
        return null;
    };

    const persistSymbols = (data) => {
        if (key !== 'nifty500' || !data?.data) return;
        const symbols = data.data
            .filter(s => s.symbol && s.symbol !== 'NIFTY 500')
            .map(s => s.symbol);
        if (symbols.length > 400) saveNifty500Symbols(symbols);
    };

    // PRIMARY: Kite when covered + authed
    if (kiteCovers && kiteClient?.isAuthenticated()) {
        try {
            const data = await fromKite();
            if (data) {
                nseCache[key] = { data, timestamp: now };
                persistSymbols(data);
                // Trigger 52W refresh check whenever nifty500 is served from Kite.
                // Fire-and-forget — only runs if cache is stale (once/day).
                if (key === 'nifty500') maybeRefresh52W();
                return { data, cached: false };
            }
        } catch (kiteError) {
            console.log(`  ⚠️  Kite primary failed for ${key}: ${kiteError.message}, trying NSE`);
        }
    }

    // FALLBACK (or primary if Kite unavailable): NSE
    try {
        const data = await fetchNSE(apiPath);
        nseCache[key] = { data, timestamp: now };
        persistSymbols(data);
        return { data, cached: false };
    } catch (nseError) {
        // Last chance: if Kite covers but wasn't authed at entry, retry now
        if (kiteCovers && kiteClient?.isAuthenticated()) {
            try {
                const data = await fromKite();
                if (data) {
                    nseCache[key] = { data, timestamp: now };
                    persistSymbols(data);
                    console.log(`  ✅ Kite recovered ${key} after NSE failure`);
                    return { data, cached: false };
                }
            } catch (e) {
                console.error(`  ❌ Kite recovery also failed for ${key}: ${e.message}`);
            }
        }
        throw nseError;
    }
}

// --- Sector index name mapping ---
const SECTOR_INDEX_MAP = {
    'NIFTY IT': { name: 'IT', fullName: 'Nifty IT' },
    'NIFTY BANK': { name: 'Bank', fullName: 'Nifty Bank' },
    'NIFTY PHARMA': { name: 'Pharma', fullName: 'Nifty Pharma' },
    'NIFTY AUTO': { name: 'Auto', fullName: 'Nifty Auto' },
    'NIFTY FMCG': { name: 'FMCG', fullName: 'Nifty FMCG' },
    'NIFTY METAL': { name: 'Metal', fullName: 'Nifty Metal' },
    'NIFTY REALTY': { name: 'Realty', fullName: 'Nifty Realty' },
    'NIFTY ENERGY': { name: 'Energy', fullName: 'Nifty Energy' },
    'NIFTY INFRASTRUCTURE': { name: 'Infra', fullName: 'Nifty Infra' },
    'NIFTY PSU BANK': { name: 'PSU Bank', fullName: 'Nifty PSU Bank' },
    'NIFTY MEDIA': { name: 'Media', fullName: 'Nifty Media' },
    'NIFTY FINANCIAL SERVICES': { name: 'FinServ', fullName: 'Nifty Financial Services' },
    'NIFTY HEALTHCARE INDEX': { name: 'Healthcare', fullName: 'Nifty Healthcare' },
    'NIFTY CONSUMER DURABLES': { name: 'Consumer', fullName: 'Nifty Consumer Durables' },
    'NIFTY OIL & GAS': { name: 'Oil & Gas', fullName: 'Nifty Oil & Gas' },
};

// ===== NSE API ENDPOINT HANDLERS =====

async function getMarketData() {
    const [{ data, cached }, emaStatus] = await Promise.all([
        getCachedNSE('allIndices', '/api/allIndices'),
        getNiftyEMAStatus().catch(() => ({ status: 'no', currentPrice: 0, ema21: 0, ema50: 0 })),
    ]);

    // Extract NIFTY 500 advance/decline
    const nifty500 = data.data?.find(idx => idx.index === 'NIFTY 500') || {};
    const nifty50 = data.data?.find(idx => idx.index === 'NIFTY 50') || {};
    const advancing = nifty500.advances || 0;
    const declining = nifty500.declines || 0;
    const unchanged = nifty500.unchanged || 0;

    const niftyChange = parseFloat(nifty50.percentChange) || 0;
    const niftyLast = parseFloat(nifty50.last) || 0;

    // Extract sector performance
    const sectors = [];
    for (const idx of (data.data || [])) {
        const mapping = SECTOR_INDEX_MAP[idx.index];
        if (mapping) {
            sectors.push({
                name: mapping.name,
                fullName: mapping.fullName,
                change: parseFloat(idx.percentChange) || 0,
                last: parseFloat(idx.last) || 0,
                open: parseFloat(idx.open) || 0,
            });
        }
    }
    sectors.sort((a, b) => b.change - a.change);

    return {
        source: 'live',
        cached,
        advancing,
        declining,
        unchanged,
        niftyEMAStatus: emaStatus.status, // 'yes' | 'selective' | 'no'
        ema21: emaStatus.ema21,
        ema50: emaStatus.ema50,
        niftyLast,
        niftyChange,
        sectors,
        timestamp: new Date().toISOString(),
    };
}

function extractStocksFromNSEVariations(data) {
    // NSE variations endpoint can return data in multiple formats
    // Try all known keys
    let arr = null;
    if (Array.isArray(data)) { arr = data; }
    else if (data.NIFTY500 && Array.isArray(data.NIFTY500)) { arr = data.NIFTY500; }
    else if (data.data && Array.isArray(data.data)) { arr = data.data; }
    else {
        // Try to find the first array in the response
        for (const key of Object.keys(data)) {
            if (Array.isArray(data[key]) && data[key].length > 0) {
                arr = data[key];
                break;
            }
        }
    }
    if (!arr) {
        console.log('  ⚠️  NSE variations response keys:', Object.keys(data));
        console.log('  ⚠️  First 200 chars:', JSON.stringify(data).substring(0, 200));
        return [];
    }
    return arr.slice(0, 10).map(s => ({
        symbol: s.symbol || s.Symbol || s.SYMBOL || '',
        name: s.meta?.companyName || s.symbol_info || s.companyName || s.COMPANY || '',
        ltp: parseFloat(s.lastPrice || s.ltp || s.last_price || s.LTP || 0),
        change: parseFloat(s.pChange || s.perChange || s.per_change || s.PCHANGE || 0),
        previousClose: parseFloat(s.previousClose || 0),
        open: parseFloat(s.open || 0),
        high: parseFloat(s.dayHigh || s.high || 0),
        low: parseFloat(s.dayLow || s.low || 0),
    }));
}

async function getGainers() {
    // Use Nifty 500 data and sort by pChange descending
    const { data, cached } = await getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500');
    const allStocks = (data.data || []).filter(s => s.symbol && s.symbol !== 'NIFTY 500');
    const sorted = allStocks
        .map(s => ({
            symbol: s.symbol,
            name: s.meta?.companyName || '',
            ltp: parseFloat(s.lastPrice) || 0,
            change: parseFloat(s.pChange) || 0,
            open: parseFloat(s.open) || 0,
            high: parseFloat(s.dayHigh) || 0,
            low: parseFloat(s.dayLow) || 0,
        }))
        .filter(s => s.change > 0)
        .sort((a, b) => b.change - a.change)
        .slice(0, 10);
    return { source: sorted.length > 0 ? 'live' : 'fallback', cached, stocks: sorted, timestamp: new Date().toISOString() };
}

async function getLosers() {
    // Use Nifty 500 data and sort by pChange ascending
    const { data, cached } = await getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500');
    const allStocks = (data.data || []).filter(s => s.symbol && s.symbol !== 'NIFTY 500');
    const sorted = allStocks
        .map(s => ({
            symbol: s.symbol,
            name: s.meta?.companyName || '',
            ltp: parseFloat(s.lastPrice) || 0,
            change: parseFloat(s.pChange) || 0,
            open: parseFloat(s.open) || 0,
            high: parseFloat(s.dayHigh) || 0,
            low: parseFloat(s.dayLow) || 0,
        }))
        .filter(s => s.change < 0)
        .sort((a, b) => a.change - b.change)
        .slice(0, 10);
    return { source: sorted.length > 0 ? 'live' : 'fallback', cached, stocks: sorted, timestamp: new Date().toISOString() };
}

async function getSevenBarStocks() {
    const { data, cached } = await getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500');
    const allStocks = data.data || [];

    // Filter stocks within 0-5% of their 52-week high
    const nearHigh = allStocks
        .filter(s => s.symbol && s.symbol !== 'NIFTY 500') // Skip index row
        .map(s => {
            const ltp = parseFloat(s.lastPrice) || 0;
            const yearHigh = parseFloat(s.yearHigh) || 0;
            if (yearHigh <= 0 || ltp <= 0) return null;
            const distFromHigh = ((yearHigh - ltp) / yearHigh) * 100;
            return {
                symbol: s.symbol,
                name: s.meta?.companyName || s.companyName || '',
                ltp,
                ath: yearHigh,
                distFromATH: parseFloat(distFromHigh.toFixed(2)),
                dayChange: parseFloat(s.pChange || 0).toFixed(2),
            };
        })
        .filter(s => s && s.distFromATH >= 0 && s.distFromATH <= 5)
        .sort((a, b) => a.distFromATH - b.distFromATH)
        .slice(0, 15);

    return {
        source: 'live',
        cached,
        stocks: nearHigh,
        note: 'Based on 52-week high (Nifty 500)',
        timestamp: new Date().toISOString(),
    };
}

function getHealthStatus() {
    const cacheStatus = {};
    for (const key of Object.keys(nseCache)) {
        const age = Date.now() - (nseCache[key]?.timestamp || 0);
        cacheStatus[key] = {
            ageMs: age,
            ageStr: age < 60000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60000)}m`,
            fresh: age < (isMarketHours() ? NSE_CACHE_TTL_MARKET : NSE_CACHE_TTL_OFFHOURS),
        };
    }
    return {
        status: 'ok',
        marketOpen: isMarketHours(),
        nseCookiesValid: Date.now() < nseCookieExpiry,
        nseCookiesAgeMs: Date.now() - (nseCookieExpiry - NSE_COOKIE_TTL),
        cache: cacheStatus,
        timestamp: new Date().toISOString(),
    };
}


// ================================================================
// ===== RSS NEWS FETCHING (existing) =============================
// ================================================================

function parseRSSItems(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        const title = extractTag(itemXml, 'title');
        const link = extractTag(itemXml, 'link');
        const pubDate = extractTag(itemXml, 'pubDate');
        const source = extractTag(itemXml, 'source') || extractSourceFromTitle(title);
        items.push({ title: cleanHtml(title), link, pubDate, timeAgo: timeAgo(pubDate), source });
    }
    return items;
}

function extractTag(xml, tag) {
    const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 'is');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
}

function extractSourceFromTitle(title) {
    const dashMatch = title.match(/ - ([^-]+)$/);
    return dashMatch ? dashMatch[1].trim() : 'News';
}

function cleanHtml(text) {
    return text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    } catch { return ''; }
}

let newsCache = { market: null, trump: null, marketTime: 0, trumpTime: 0 };
const NEWS_CACHE_TTL = 180000;

async function getMarketNews() {
    const now = Date.now();
    if (newsCache.market && (now - newsCache.marketTime) < NEWS_CACHE_TTL) return newsCache.market;
    const feeds = [
        'https://news.google.com/rss/search?q=indian+stock+market+nifty+sensex&hl=en-IN&gl=IN&ceid=IN:en',
        'https://news.google.com/rss/search?q=india+market+today+nse+bse&hl=en-IN&gl=IN&ceid=IN:en',
    ];
    let allItems = [];
    for (const feedUrl of feeds) {
        try { const xml = await fetchUrl(feedUrl); allItems = allItems.concat(parseRSSItems(xml)); } catch (e) { console.log('Feed fetch error:', e.message); }
    }
    const seen = new Set();
    const unique = allItems.filter(item => { const key = item.title.substring(0, 50).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
    unique.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const result = { items: unique.slice(0, 10) };
    newsCache.market = result; newsCache.marketTime = now;
    return result;
}

async function getTrumpNews() {
    const now = Date.now();
    if (newsCache.trump && (now - newsCache.trumpTime) < NEWS_CACHE_TTL) return newsCache.trump;
    const feeds = [
        'https://news.google.com/rss/search?q=Donald+Trump+White+House+latest+news&hl=en&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=Trump+executive+order+policy+2025&hl=en&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=Trump+iran+russia+china+nato+military&hl=en&gl=US&ceid=US:en',
    ];
    let allItems = [];
    for (const feedUrl of feeds) {
        try {
            const xml = await fetchUrl(feedUrl);
            const items = parseRSSItems(xml);
            items.forEach(item => {
                const t = item.title.toLowerCase();
                if (t.includes('tariff') || t.includes('trade war') || t.includes('trade deal') || t.includes('trade')) item.tag = 'TARIFF';
                else if (t.includes('iran') || t.includes('war') || t.includes('military') || t.includes('strike') || t.includes('nuclear')) item.tag = 'WAR';
                else if (t.includes('china') || t.includes('russia') || t.includes('nato') || t.includes('ukraine') || t.includes('korea')) item.tag = 'GEOPOLITICS';
                else if (t.includes('visa') || t.includes('h-1b') || t.includes('immigra') || t.includes('border') || t.includes('deport')) item.tag = 'IMMIGRATION';
                else if (t.includes('modi') || t.includes('india') || t.includes('diplomat') || t.includes('zelensky') || t.includes('summit')) item.tag = 'DIPLOMACY';
                else if (t.includes('market') || t.includes('stock') || t.includes('fed') || t.includes('economy') || t.includes('debt')) item.tag = 'ECONOMY';
                else if (t.includes('elon') || t.includes('musk') || t.includes('doge') || t.includes('spending')) item.tag = 'DOGE';
                else if (t.includes('executive') || t.includes('order') || t.includes('sign') || t.includes('white house')) item.tag = 'POLICY';
                else item.tag = 'TRUMP';
            });
            allItems = allItems.concat(items);
        } catch (e) { console.log('Trump feed fetch error:', e.message); }
    }
    const seen = new Set();
    const unique = allItems.filter(item => { const key = item.title.substring(0, 50).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
    unique.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const result = { items: unique.slice(0, 8) };
    newsCache.trump = result; newsCache.trumpTime = now;
    return result;
}


// ================================================================
// ===== HTTP SERVER ==============================================
// ================================================================

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ===== Combined Dashboard Endpoint (single request for all data) =====
    if (pathname === '/api/dashboard') {
        try {
            const [marketData, gainers, losers, sevenBar, indexQuotes, news, trumpNews] = await Promise.allSettled([
                getMarketData(),
                getGainers(),
                getLosers(),
                getSevenBarStocks(),
                (async () => {
                    const { data, cached } = await getCachedNSE('allIndices', '/api/allIndices');
                    const allIdx = data.data || [];
                    const indices = {};
                    for (const idx of allIdx) {
                        if (idx.index === 'NIFTY 50') indices.nifty = { name: 'NIFTY 50', last: parseFloat(idx.last), change: parseFloat(idx.percentChange), pointChange: parseFloat(idx.previousClose) - parseFloat(idx.last) ? parseFloat((parseFloat(idx.last) - parseFloat(idx.previousClose)).toFixed(2)) : 0 };
                        else if (idx.index === 'NIFTY BANK') indices.banknifty = { name: 'NIFTY BANK', last: parseFloat(idx.last), change: parseFloat(idx.percentChange), pointChange: parseFloat((parseFloat(idx.last) - parseFloat(idx.previousClose)).toFixed(2)) };
                        else if (idx.index === 'NIFTY SMALLCAP 250') indices.smallcap = { name: 'NIFTY SMALLCAP 250', last: parseFloat(idx.last), change: parseFloat(idx.percentChange), pointChange: parseFloat((parseFloat(idx.last) - parseFloat(idx.previousClose)).toFixed(2)) };
                    }
                    try {
                        const [goldData, usdinrData] = await Promise.all([fetchGoldPrice(), fetchUSDINRRate()]);
                        if (goldData && goldData.price) { const g = goldData.price - goldData.prevClose; indices.gold = { name: 'Gold $/oz', last: goldData.price, change: goldData.change, pointChange: parseFloat(g.toFixed(2)) }; }
                        if (usdinrData && usdinrData.price) { const u = usdinrData.price - usdinrData.prevClose; indices.usdinr = { name: 'USD/INR', last: usdinrData.price, change: usdinrData.change, pointChange: parseFloat(u.toFixed(4)) }; }
                    } catch (e) {}
                    return { indices };
                })(),
                getMarketNews(),
                getTrumpNews(),
            ]);
            sendJSON(res, 200, {
                marketData: marketData.status === 'fulfilled' ? marketData.value : null,
                gainers: gainers.status === 'fulfilled' ? gainers.value : { stocks: [] },
                losers: losers.status === 'fulfilled' ? losers.value : { stocks: [] },
                sevenBar: sevenBar.status === 'fulfilled' ? sevenBar.value : { stocks: [] },
                indexQuotes: indexQuotes.status === 'fulfilled' ? indexQuotes.value : { indices: {} },
                news: news.status === 'fulfilled' ? news.value : { items: [] },
                trumpNews: trumpNews.status === 'fulfilled' ? trumpNews.value : { items: [] },
                timestamp: new Date().toISOString(),
            });
        } catch (e) {
            sendJSON(res, 200, { error: e.message });
        }
        return;
    }

    // ===== NSE Market Data Endpoints =====

    if (pathname === '/api/market-data') {
        try {
            const data = await getMarketData();
            sendJSON(res, 200, data);
        } catch (e) {
            console.error('❌ /api/market-data error:', e.message);
            sendJSON(res, 200, { source: 'fallback', error: e.message, advancing: 250, declining: 220, unchanged: 30, niftyAbove21EMA: false, sectors: [], timestamp: new Date().toISOString() });
        }
        return;
    }

    if (pathname === '/api/gainers') {
        try {
            const data = await getGainers();
            sendJSON(res, 200, data);
        } catch (e) {
            console.error('❌ /api/gainers error:', e.message);
            sendJSON(res, 200, { source: 'fallback', error: e.message, stocks: [], timestamp: new Date().toISOString() });
        }
        return;
    }

    if (pathname === '/api/losers') {
        try {
            const data = await getLosers();
            sendJSON(res, 200, data);
        } catch (e) {
            console.error('❌ /api/losers error:', e.message);
            sendJSON(res, 200, { source: 'fallback', error: e.message, stocks: [], timestamp: new Date().toISOString() });
        }
        return;
    }

    if (pathname === '/api/seven-bar-stocks') {
        try {
            const data = await getSevenBarStocks();
            sendJSON(res, 200, data);
        } catch (e) {
            console.error('❌ /api/seven-bar-stocks error:', e.message);
            sendJSON(res, 200, { source: 'fallback', error: e.message, stocks: [], timestamp: new Date().toISOString() });
        }
        return;
    }

    if (pathname === '/api/health') {
        sendJSON(res, 200, getHealthStatus());
        return;
    }

    // ===== Index KPIs (replaces broken TradingView tickers) =====
    if (pathname === '/api/index-quotes') {
        try {
            const { data, cached } = await getCachedNSE('allIndices', '/api/allIndices');
            const allIdx = data.data || [];

            // Helper to find index by partial match
            const findIdx = (patterns) => {
                for (const p of patterns) {
                    const found = allIdx.find(i => i.index && i.index.toUpperCase().includes(p.toUpperCase()));
                    if (found) return found;
                }
                return null;
            };

            const makeEntry = (raw) => {
                if (!raw) return null;
                // NSE returns change as string like "-829.29" (point change) and percentChange as "-1.08"
                const last = parseFloat(raw.last) || parseFloat(raw.lastPrice) || 0;
                const pctChange = parseFloat(raw.percentChange) || parseFloat(raw.pChange) || 0;
                const ptChange = parseFloat(raw.variation) || parseFloat(raw.change) || 0;
                return { name: raw.index, last, change: pctChange, pointChange: ptChange };
            };

            const indices = {};
            const niftyRaw = findIdx(['NIFTY 50']);
            const bankRaw = findIdx(['NIFTY BANK']);
            const smallRaw = findIdx(['NIFTY SMALLCAP 250', 'SMALLCAP 250', 'SMALLCAP 100']);

            if (niftyRaw) indices.nifty = makeEntry(niftyRaw);
            if (bankRaw) indices.banknifty = makeEntry(bankRaw);
            if (smallRaw) indices.smallcap = makeEntry(smallRaw);

            // Gold & USDINR from Kite/free APIs
            try {
                const [goldData, usdinrData] = await Promise.all([
                    fetchGoldPrice(),
                    fetchUSDINRRate(),
                ]);
                if (goldData && goldData.price) {
                    const gPtChg = goldData.price - goldData.prevClose;
                    indices.gold = { name: 'Gold $/oz', last: goldData.price, change: goldData.change, pointChange: parseFloat(gPtChg.toFixed(2)) };
                }
                if (usdinrData && usdinrData.price) {
                    const uPtChg = usdinrData.price - usdinrData.prevClose;
                    indices.usdinr = { name: 'USD/INR', last: usdinrData.price, change: usdinrData.change, pointChange: parseFloat(uPtChg.toFixed(4)) };
                }
            } catch (e) { console.warn('  ⚠️  Gold/USDINR fetch failed:', e.message); }

            // SENSEX is BSE — not in NSE allIndices. Fetch from BSE or use TradingView for display.
            // For now, calculate from Nifty as proxy or leave for TradingView widget.
            // Gold & USD/INR: also not in NSE equity indices — handled by TradingView KPI widgets.

            // Debug: log available index names on first call
            if (!global._indexNamesLogged) {
                global._indexNamesLogged = true;
                console.log('  📊 Available NSE indices:', allIdx.map(i => i.index).join(', '));
            }

            sendJSON(res, 200, { source: cached ? 'cached' : 'live', indices, availableCount: allIdx.length, timestamp: new Date().toISOString() });
        } catch (e) {
            console.error('❌ /api/index-quotes error:', e.message);
            sendJSON(res, 200, { source: 'fallback', indices: {}, error: e.message });
        }
        return;
    }

    // ===== Ticker Data (CNBC-style marquee) =====
    // Returns ALL Nifty 500 stocks for scrolling ticker
    if (pathname === '/api/ticker-data') {
        try {
            const { data, cached } = await getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500');
            const allStocks = (data.data || []).filter(s => s.symbol && s.symbol !== 'NIFTY 500');

            const stocks = allStocks
                .map(s => ({
                    symbol: s.symbol,
                    ltp: parseFloat(s.lastPrice) || 0,
                    change: parseFloat(s.pChange) || 0,
                }))
                .filter(s => s.ltp > 0);

            sendJSON(res, 200, { source: cached ? 'cached' : 'live', stocks, count: stocks.length, timestamp: new Date().toISOString() });
        } catch (e) {
            console.error('❌ /api/ticker-data error:', e.message);
            sendJSON(res, 200, { source: 'fallback', stocks: [], error: e.message });
        }
        return;
    }

    if (pathname === '/api/sector-stocks') {
        try {
            const sectorParam = parsedUrl.searchParams.get('sector');
            if (!sectorParam) {
                sendJSON(res, 200, { error: 'No sector provided', stocks: [] });
                return;
            }
            // NSE /api/equity-stockIndices is dead (404). Use NSE archive CSVs
            // for the constituent list, then fetch live quotes from Kite.
            const constituents = await getSectorConstituents(sectorParam);
            if (!constituents || constituents.length === 0) {
                sendJSON(res, 200, { error: 'Sector not in archive', stocks: [], source: 'archive-miss' });
                return;
            }
            if (!kiteClient?.isAuthenticated()) {
                sendJSON(res, 200, { error: 'Kite not authenticated', stocks: [], source: 'kite-unauthed' });
                return;
            }
            const quotes = await kiteClient.getQuoteBatched(constituents.map(s => `NSE:${s}`));
            const stocks = [];
            for (const [sym, q] of Object.entries(quotes || {})) {
                if (!q || !q.last_price) continue;
                const symbol = sym.replace('NSE:', '');
                const prevClose = q.ohlc?.close || q.last_price;
                const pct = prevClose ? ((q.last_price - prevClose) / prevClose * 100) : 0;
                stocks.push({
                    symbol,
                    companyName: '',
                    ltp: q.last_price,
                    change: pct,
                    open: q.ohlc?.open || 0,
                    high: q.ohlc?.high || q.last_price,
                    low: q.ohlc?.low || q.last_price,
                });
            }
            stocks.sort((a, b) => b.change - a.change);
            sendJSON(res, 200, { source: 'kite+archive', stocks, count: stocks.length, timestamp: new Date().toISOString() });
        } catch (e) {
            console.error('❌ /api/sector-stocks error:', e.message);
            sendJSON(res, 200, { error: e.message, stocks: [], source: 'fallback' });
        }
        return;
    }

    // ===== Stock Analyser (Minervini SEPA) =====
    if (pathname === '/api/analyse-stock') {
        const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
        if (!symbol) {
            sendJSON(res, 200, { error: 'No symbol provided' });
            return;
        }
        try {
            // Try Nifty 500 first, then fall back to individual NSE quote
            const { data: n500Data } = await getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500');
            const allStocks = n500Data.data || [];
            let stock = allStocks.find(s => s.symbol === symbol);

            // If not in Nifty 500, fetch individual stock from NSE quote API or Kite
            if (!stock) {
                // Try NSE first
                try {
                    const quoteData = await fetchNSE(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
                    if (quoteData && quoteData.priceInfo) {
                        const pi = quoteData.priceInfo;
                        const ind = quoteData.industryInfo || {};
                        stock = {
                            symbol: symbol,
                            lastPrice: pi.lastPrice,
                            open: pi.open,
                            dayHigh: pi.intraDayHighLow?.max || pi.lastPrice,
                            dayLow: pi.intraDayHighLow?.min || pi.lastPrice,
                            previousClose: pi.previousClose,
                            pChange: pi.pChange,
                            yearHigh: pi.weekHighLow?.max || pi.lastPrice,
                            yearLow: pi.weekHighLow?.min || pi.lastPrice,
                            totalTradedVolume: quoteData.securityWiseDP?.quantityTraded || 0,
                            totalTradedValue: quoteData.securityWiseDP?.tradedValue || 0,
                            meta: {
                                companyName: quoteData.info?.companyName || '',
                                industry: ind.basicIndustry || ind.industry || '',
                            },
                        };
                    }
                } catch (e) {
                    // NSE failed — try Kite fallback
                    if (kiteClient?.isAuthenticated()) {
                        try {
                            const kq = await kiteClient.getQuote([`NSE:${symbol}`]);
                            const q = kq?.[`NSE:${symbol}`];
                            if (q && q.last_price) {
                                const prevClose = q.ohlc?.close || q.last_price;
                                const pctChange = prevClose ? ((q.last_price - prevClose) / prevClose * 100) : 0;
                                stock = {
                                    symbol, lastPrice: String(q.last_price),
                                    open: String(q.ohlc?.open || 0),
                                    dayHigh: String(q.ohlc?.high || q.last_price),
                                    dayLow: String(q.ohlc?.low || q.last_price),
                                    previousClose: String(prevClose),
                                    pChange: String(pctChange.toFixed(2)),
                                    yearHigh: '0', yearLow: '0',
                                    totalTradedVolume: String(q.volume || 0),
                                    totalTradedValue: '0',
                                    meta: { companyName: '', industry: '' },
                                };
                            }
                        } catch (ke) { /* Kite also failed */ }
                    }
                }
            }

            if (!stock) {
                sendJSON(res, 200, { error: `${symbol} not found on NSE — check the ticker (e.g. TRENT, not TRENT.NS)`, symbol });
                return;
            }

            // Get Nifty 500 index change for relative strength comparison
            const { data: allIdxData } = await getCachedNSE('allIndices', '/api/allIndices');
            const nifty500Idx = (allIdxData.data || []).find(i => i.index === 'NIFTY 500');
            const niftyChange = parseFloat(nifty500Idx?.percentChange) || 0;

            const ltp = parseFloat(stock.lastPrice) || 0;
            const open = parseFloat(stock.open) || 0;
            const high = parseFloat(stock.dayHigh) || 0;
            const low = parseFloat(stock.dayLow) || 0;
            const prevClose = parseFloat(stock.previousClose) || 0;
            const pChange = parseFloat(stock.pChange) || 0;
            const yearHigh = parseFloat(stock.yearHigh) || 0;
            const yearLow = parseFloat(stock.yearLow) || 0;
            const totalTradedVolume = parseFloat(stock.totalTradedVolume) || 0;
            const totalTradedValue = parseFloat(stock.totalTradedValue) || 0;
            const companyName = stock.meta?.companyName || '';
            const industry = stock.meta?.industry || '';

            // ===== MINERVINI SEPA CRITERIA =====
            const checks = [];
            let score = 0;

            // 1. Distance from 52-week high (should be within 25%)
            const distFrom52WH = yearHigh > 0 ? ((yearHigh - ltp) / yearHigh * 100) : 100;
            const near52WH = distFrom52WH <= 25;
            checks.push({
                name: '52-Week High Proximity',
                pass: near52WH,
                value: `${distFrom52WH.toFixed(1)}% below 52WH (₹${yearHigh.toLocaleString('en-IN')})`,
                detail: near52WH
                    ? distFrom52WH <= 5 ? 'Excellent — within striking distance of highs' : distFrom52WH <= 15 ? 'Good — stock is in upper range' : 'Acceptable — still within 25% of highs'
                    : 'Fail — stock is too far from highs, not in Stage 2 uptrend',
                weight: near52WH ? (distFrom52WH <= 5 ? 20 : distFrom52WH <= 15 ? 15 : 10) : 0,
            });
            score += checks[checks.length - 1].weight;

            // 2. Distance from 52-week low (should be >30% above)
            const aboveLow = yearLow > 0 ? ((ltp - yearLow) / yearLow * 100) : 0;
            const above52WL = aboveLow >= 30;
            checks.push({
                name: '52-Week Low Distance',
                pass: above52WL,
                value: `${aboveLow.toFixed(1)}% above 52WL (₹${yearLow.toLocaleString('en-IN')})`,
                detail: above52WL
                    ? aboveLow >= 100 ? 'Strong — stock has doubled from lows, powerful uptrend' : 'Good — stock well above lows'
                    : 'Fail — stock too close to 52-week lows, potential Stage 4 decline',
                weight: above52WL ? (aboveLow >= 100 ? 15 : 10) : 0,
            });
            score += checks[checks.length - 1].weight;

            // 3. Relative Strength vs Nifty 500 (stock should outperform broad market)
            // If Nifty 500 is -1% and stock is -0.8%, RS = +0.2% → relatively stronger
            const rsVsNifty = pChange - niftyChange;
            const rsPositive = rsVsNifty > 0;
            checks.push({
                name: 'Relative Strength vs Nifty 500',
                pass: rsPositive,
                value: `Stock ${pChange >= 0 ? '+' : ''}${pChange.toFixed(2)}% vs Nifty 500 ${niftyChange >= 0 ? '+' : ''}${niftyChange.toFixed(2)}% (RS: ${rsVsNifty >= 0 ? '+' : ''}${rsVsNifty.toFixed(2)}%)`,
                detail: rsPositive
                    ? rsVsNifty >= 2 ? 'Excellent — significantly outperforming the broad market' : 'Good — holding up better than Nifty 500'
                    : `Weak — underperforming Nifty 500 by ${Math.abs(rsVsNifty).toFixed(2)}%`,
                weight: rsPositive ? (rsVsNifty >= 2 ? 15 : 10) : 0,
            });
            score += checks[checks.length - 1].weight;

            // 4. Price action today (bullish candle pattern)
            const bodyRange = Math.abs(ltp - open);
            const totalRange = high - low;
            const bullishCandle = ltp > open;
            const closeInUpperHalf = totalRange > 0 ? ((ltp - low) / totalRange) > 0.6 : false;
            checks.push({
                name: 'Intraday Price Action',
                pass: closeInUpperHalf,
                value: bullishCandle ? `Bullish candle (O:₹${open.toLocaleString('en-IN')} → C:₹${ltp.toLocaleString('en-IN')})` : `Bearish candle (O:₹${open.toLocaleString('en-IN')} → C:₹${ltp.toLocaleString('en-IN')})`,
                detail: closeInUpperHalf
                    ? 'Closing in upper half of range — demand in control'
                    : 'Closing in lower half — sellers dominant today',
                weight: closeInUpperHalf ? 10 : 0,
            });
            score += checks[checks.length - 1].weight;

            // 5. Volatility Contraction (narrow range today = potential VCP)
            const dayRangePct = prevClose > 0 ? (totalRange / prevClose * 100) : 0;
            const tightRange = dayRangePct < 3;
            checks.push({
                name: 'Volatility Contraction (VCP Signal)',
                pass: tightRange,
                value: `Day range: ${dayRangePct.toFixed(2)}% (₹${low.toLocaleString('en-IN')} – ₹${high.toLocaleString('en-IN')})`,
                detail: tightRange
                    ? 'Tight range — possible volatility contraction before breakout'
                    : dayRangePct > 5 ? 'Wide range — volatile, wait for contraction' : 'Moderate range — monitor for tightening',
                weight: tightRange ? 10 : (dayRangePct <= 5 ? 5 : 0),
            });
            score += checks[checks.length - 1].weight;

            // 6. Volume analysis
            const avgTurnover = totalTradedValue > 0;
            const liquidEnough = totalTradedValue >= 100000000; // 10 Cr min
            checks.push({
                name: 'Liquidity & Volume',
                pass: liquidEnough,
                value: `Turnover: ₹${(totalTradedValue / 10000000).toFixed(1)} Cr | Vol: ${(totalTradedVolume / 100000).toFixed(1)}L`,
                detail: liquidEnough
                    ? totalTradedValue >= 500000000 ? 'Excellent liquidity — institutional interest' : 'Adequate liquidity for swing trades'
                    : 'Low liquidity — risky for larger positions, slippage likely',
                weight: liquidEnough ? (totalTradedValue >= 500000000 ? 15 : 10) : 0,
            });
            score += checks[checks.length - 1].weight;

            // 7. Stage Analysis (simplified)
            let stage = 'Unknown';
            if (distFrom52WH <= 10 && aboveLow >= 50) stage = 'Stage 2 — Advancing';
            else if (distFrom52WH <= 25 && aboveLow >= 30) stage = 'Stage 2 — Early/Mid Advance';
            else if (distFrom52WH > 25 && distFrom52WH <= 50 && aboveLow >= 20) stage = 'Stage 1 — Basing (Watch for breakout)';
            else if (distFrom52WH > 50) stage = 'Stage 4 — Declining (AVOID)';
            else stage = 'Stage 3 — Topping / Distribution';

            const isStage2 = stage.includes('Stage 2');
            checks.push({
                name: 'Weinstein Stage Analysis',
                pass: isStage2,
                value: stage,
                detail: isStage2
                    ? 'Stock is in the ideal stage per Stan Weinstein'
                    : stage.includes('Stage 1') ? 'Building a base — not ready yet, add to watchlist' : 'Not in the right zone — Minervini only trades Stage 2 stocks',
                weight: isStage2 ? 15 : (stage.includes('Stage 1') ? 5 : 0),
            });
            score += checks[checks.length - 1].weight;

            // Overall verdict
            let verdict, verdictClass;
            if (score >= 70) { verdict = 'STRONG CANDIDATE'; verdictClass = 'strong-candidate'; }
            else if (score >= 50) { verdict = 'WATCHLIST — WAIT FOR SETUP'; verdictClass = 'watchlist'; }
            else if (score >= 30) { verdict = 'WEAK — NOT IDEAL FOR SWING'; verdictClass = 'weak'; }
            else { verdict = 'AVOID — DOES NOT MEET CRITERIA'; verdictClass = 'avoid'; }

            sendJSON(res, 200, {
                symbol, companyName, industry, ltp, pChange, open, high, low,
                prevClose, yearHigh, yearLow,
                score, verdict, verdictClass,
                checks,
                minerviniNote: score >= 50
                    ? 'This stock shows characteristics that Minervini looks for: proximity to new highs, relative strength, and proper stage positioning. Look for a VCP or tight consolidation near pivot for entry.'
                    : 'This stock currently does not meet Minervini\'s SEPA criteria. Either wait for it to set up properly or look for better candidates near 52-week highs with strong relative strength.',
                timestamp: new Date().toISOString(),
            });
        } catch (e) {
            console.error('❌ /api/analyse-stock error:', e.message);
            sendJSON(res, 200, { error: e.message, symbol });
        }
        return;
    }

    // ===== Market Breadth from Google Sheet =====
    if (pathname === '/api/mbi-data') {
        try {
            // Use /export format — more reliable from cloud servers than gviz
            const sheetUrl = 'https://docs.google.com/spreadsheets/d/1NVZd8aZbmKXhHYnfgfOLjlLiyoWfZnKy9v3MWT5jT68/export?format=csv&gid=190844943';
            const csv = await fetchUrlWithHeaders(sheetUrl, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/csv,text/plain,*/*',
            });
            console.log(`  📊 MBI CSV length: ${csv.length}, first 100: ${csv.substring(0, 100)}`);
            // Parse CSV — columns: Date, Day, Advances, Declines, Up4%, Down4%, Up25%M, Down25%M, Up50%M, Down50%M, %Above10DMA, %Above20DMA, %Above40DMA, %10>20DMA, %20>40DMA, Nifty, NiftyChg%
            const lines = csv.trim().split('\n').filter(l => l.trim());
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.replace(/"/g, '').replace('%', '').trim());
                if (vals.length >= 17 && vals[0]) {
                    rows.push({
                        date: vals[0],
                        day: vals[1],
                        advances: parseInt(vals[2]) || 0,
                        declines: parseInt(vals[3]) || 0,
                        up4d: parseInt(vals[4]) || 0,
                        down4d: parseInt(vals[5]) || 0,
                        up25m: parseInt(vals[6]) || 0,
                        down25m: parseInt(vals[7]) || 0,
                        up50m: parseInt(vals[8]) || 0,
                        down50m: parseInt(vals[9]) || 0,
                        abv10dma: parseFloat(vals[10]) || 0,
                        abv20dma: parseFloat(vals[11]) || 0,
                        abv40dma: parseFloat(vals[12]) || 0,
                        dma10gt20: parseFloat(vals[13]) || 0,
                        dma20gt40: parseFloat(vals[14]) || 0,
                        nifty: parseFloat(vals[15]) || 0,
                        niftyChg: parseFloat(vals[16]) || 0,
                    });
                }
            }
            // Sheet has newest rows at the top — take first 30
            const recent = rows.slice(0, 30);
            sendJSON(res, 200, { source: 'live', rows: recent, total: rows.length, timestamp: new Date().toISOString() });
        } catch (e) {
            console.error('❌ /api/mbi-data error:', e.message);
            sendJSON(res, 200, { source: 'fallback', rows: [], error: e.message });
        }
        return;
    }

    // ===== News Endpoints =====

    if (pathname === '/api/news') {
        try { sendJSON(res, 200, await getMarketNews()); }
        catch (e) { sendJSON(res, 200, { error: e.message, items: [] }); }
        return;
    }

    if (pathname === '/api/trump-news') {
        try { sendJSON(res, 200, await getTrumpNews()); }
        catch (e) { sendJSON(res, 200, { error: e.message, items: [] }); }
        return;
    }

    // ===== AUTH — Request OTP =====
    if (pathname === '/auth/request-otp' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const { email } = JSON.parse(body);
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    sendJSON(res, 400, { error: 'Invalid email address' }); return;
                }
                const normalizedEmail = email.toLowerCase().trim();
                if (!emailWhitelist.has(normalizedEmail)) {
                    sendJSON(res, 403, { error: 'This email is not authorized to access Market Monitor. Contact support for access.' }); return;
                }
                const existing = otpStore.get(normalizedEmail);
                if (existing && existing.expiry > Date.now() && existing.attempts >= 5) {
                    sendJSON(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' }); return;
                }
                const otp = generateOtp();
                otpStore.set(normalizedEmail, { otp, expiry: Date.now() + 10 * 60 * 1000, attempts: 0 });
                await sendOtpEmail(normalizedEmail, otp);
                sendJSON(res, 200, { success: true, message: 'Code sent to your email' });
            } catch (e) {
                console.error('OTP send error:', e.message);
                sendJSON(res, 500, { error: 'Failed to send email. Check server email config.' });
            }
        });
        return;
    }

    // ===== AUTH — Verify OTP =====
    if (pathname === '/auth/verify-otp' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { email, otp } = JSON.parse(body);
                const record = otpStore.get(email);
                if (!record) { sendJSON(res, 401, { error: 'No code requested for this email' }); return; }
                if (Date.now() > record.expiry) { otpStore.delete(email); sendJSON(res, 401, { error: 'Code expired. Request a new one.' }); return; }
                record.attempts++;
                if (record.otp !== String(otp).trim()) {
                    sendJSON(res, 401, { error: `Incorrect code. ${5 - record.attempts} attempts left.` }); return;
                }
                otpStore.delete(email);
                const token = generateToken();
                sessionStore.set(token, { email, expiry: Date.now() + 24 * 60 * 60 * 1000 });
                sendJSON(res, 200, { success: true, token, email });
            } catch (e) {
                sendJSON(res, 400, { error: 'Invalid request' });
            }
        });
        return;
    }

    // ===== AUTH — Check Session =====
    if (pathname === '/auth/check') {
        const token = (req.headers['authorization'] || '').replace('Bearer ', '');
        const session = sessionStore.get(token);
        if (session && session.expiry > Date.now()) {
            sendJSON(res, 200, { valid: true, email: session.email });
        } else {
            if (token) sessionStore.delete(token);
            sendJSON(res, 401, { valid: false });
        }
        return;
    }

    // ===== CRON — Cloud Scheduler trigger endpoints (X-Cron-Secret header auth) =====
    // Refresh 52W cache. Schedule daily at 18:30 UTC = 00:00 IST.
    // Awaits result so Cloud Scheduler sees true success/failure status,
    // retries on 5xx, and admin gets emailed on failure (Gap 1 + Gap 5).
    if (pathname === '/admin/cron/refresh-52w') {
        if (!cronAuth(req)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
        try {
            if (!kiteClient?.isAuthenticated()) {
                await sendAdminAlert(
                    'Scheduled 52W refresh skipped — Kite re-auth needed',
                    'The 00:00 IST refresh job ran but Kite Connect is not authenticated. Cached 52-week data will go stale until you re-auth. Click below to fix:'
                );
                sendJSON(res, 500, { error: 'kite_unauthed', alerted: true });
                return;
            }
            if (Object.keys(instrumentTokens).length === 0) await fetchInstrumentTokens();
            const result = await refresh52WCache();
            if (!result || result.success === 0) {
                await sendAdminAlert(
                    'Scheduled 52W refresh produced no data',
                    `The refresh job completed but stored 0 symbols. Reason: ${result?.skipped || 'all symbols failed'}. Dashboard is serving previous-day cache. Re-auth Kite if asked:`
                );
                sendJSON(res, 500, { error: 'no_data', ...result, alerted: true });
                return;
            }
            sendJSON(res, 200, { ok: true, ...result });
        } catch (e) {
            await sendAdminAlert('Scheduled 52W refresh threw an error', `Error: ${e.message}. Check Cloud Run logs for stack trace.`);
            sendJSON(res, 500, { error: e.message, alerted: true });
        }
        return;
    }

    // Send Kite re-auth reminder. Schedule daily at 03:00 UTC = 08:30 IST.
    // Only fires email if Kite is currently UNauthenticated (idempotent).
    if (pathname === '/admin/cron/auth-reminder') {
        if (!cronAuth(req)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
        sendJSON(res, 202, { ok: true, scheduled: true });
        setImmediate(() => sendAuthReminder().catch(e => console.error('  ❌ Cron reminder failed:', e.message)));
        return;
    }

    // ===== ADMIN — Email whitelist management =====
    // Admin dashboard page
    if (pathname === '/admin') {
        const token = parsedUrl.searchParams.get('token') || '';
        const session = sessionStore.get(token);
        if (!session || session.expiry < Date.now() || session.email !== ADMIN_EMAIL) {
            // Serve admin login page
            try {
                const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
                res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
                res.end(html);
            } catch (e) {
                sendJSON(res, 404, { error: 'Admin page not found' });
            }
            return;
        }
        // Authenticated admin — serve dashboard with token embedded
        try {
            let html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(html);
        } catch (e) {
            sendJSON(res, 404, { error: 'Admin page not found' });
        }
        return;
    }

    // Admin API — check if session is admin
    if (pathname.startsWith('/admin/api/')) {
        const token = (req.headers['authorization'] || '').replace('Bearer ', '');
        const session = sessionStore.get(token);
        if (!session || session.expiry < Date.now() || session.email !== ADMIN_EMAIL) {
            sendJSON(res, 401, { error: 'Unauthorized' });
            return;
        }

        // GET /admin/api/emails — list all authorized emails
        if (pathname === '/admin/api/emails' && req.method === 'GET') {
            const search = parsedUrl.searchParams.get('q') || '';
            let emails = [...emailWhitelist].sort();
            if (search) {
                const q = search.toLowerCase();
                emails = emails.filter(e => e.includes(q));
            }
            sendJSON(res, 200, { total: emailWhitelist.size, filtered: emails.length, emails });
            return;
        }

        // POST /admin/api/emails — add email
        if (pathname === '/admin/api/emails' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { email } = JSON.parse(body);
                    const normalized = (email || '').toLowerCase().trim();
                    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
                        sendJSON(res, 400, { error: 'Invalid email address' }); return;
                    }
                    if (emailWhitelist.has(normalized)) {
                        sendJSON(res, 409, { error: 'Email already authorized' }); return;
                    }
                    emailWhitelist.add(normalized);
                    await saveWhitelist();
                    sendJSON(res, 200, { success: true, email: normalized, total: emailWhitelist.size });
                } catch (e) {
                    sendJSON(res, 400, { error: 'Invalid request' });
                }
            });
            return;
        }

        // DELETE /admin/api/emails — remove email
        if (pathname === '/admin/api/emails' && req.method === 'DELETE') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { email } = JSON.parse(body);
                    const normalized = (email || '').toLowerCase().trim();
                    if (normalized === ADMIN_EMAIL) {
                        sendJSON(res, 400, { error: 'Cannot remove admin email' }); return;
                    }
                    if (!emailWhitelist.has(normalized)) {
                        sendJSON(res, 404, { error: 'Email not found' }); return;
                    }
                    emailWhitelist.delete(normalized);
                    await saveWhitelist();
                    sendJSON(res, 200, { success: true, removed: normalized, total: emailWhitelist.size });
                } catch (e) {
                    sendJSON(res, 400, { error: 'Invalid request' });
                }
            });
            return;
        }

        // POST /admin/api/emails/bulk-preview — parse CSV, return what would change
        if (pathname === '/admin/api/emails/bulk-preview' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', () => {
                try {
                    const { csv, action } = JSON.parse(body);
                    if (!csv || !action || (action !== 'add' && action !== 'remove')) {
                        sendJSON(res, 400, { error: 'Invalid request. Provide csv and action (add/remove).' }); return;
                    }
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    const lines = csv.split(/[\n\r]+/).map(l => l.trim().toLowerCase()).filter(Boolean);
                    const parsed = [];
                    const invalid = [];
                    for (const line of lines) {
                        const email = line.replace(/^["']|["']$/g, '').replace(/,+$/, '').trim();
                        if (!email || email === 'email') continue;
                        if (emailRegex.test(email)) parsed.push(email);
                        else invalid.push(email);
                    }
                    const unique = [...new Set(parsed)];

                    if (action === 'add') {
                        const alreadyExists = unique.filter(e => emailWhitelist.has(e));
                        const toAdd = unique.filter(e => !emailWhitelist.has(e));
                        sendJSON(res, 200, {
                            action: 'add',
                            total_parsed: unique.length,
                            to_add: toAdd.length,
                            already_exists: alreadyExists.length,
                            invalid: invalid.length,
                            preview_add: toAdd,
                            preview_duplicate: alreadyExists,
                            preview_invalid: invalid,
                        });
                    } else {
                        const toRemove = unique.filter(e => emailWhitelist.has(e) && e !== ADMIN_EMAIL);
                        const notFound = unique.filter(e => !emailWhitelist.has(e));
                        const protectedEmails = unique.filter(e => e === ADMIN_EMAIL);
                        sendJSON(res, 200, {
                            action: 'remove',
                            total_parsed: unique.length,
                            to_remove: toRemove.length,
                            not_found: notFound.length,
                            protected: protectedEmails.length,
                            invalid: invalid.length,
                            preview_remove: toRemove,
                            preview_not_found: notFound,
                            preview_protected: protectedEmails,
                            preview_invalid: invalid,
                        });
                    }
                } catch (e) {
                    sendJSON(res, 400, { error: 'Failed to parse request' });
                }
            });
            return;
        }

        // POST /admin/api/emails/bulk-execute — atomically apply bulk add/remove
        if (pathname === '/admin/api/emails/bulk-execute' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { emails, action } = JSON.parse(body);
                    if (!Array.isArray(emails) || !action || (action !== 'add' && action !== 'remove')) {
                        sendJSON(res, 400, { error: 'Invalid request' }); return;
                    }
                    // Snapshot current state for rollback
                    const snapshot = new Set(emailWhitelist);
                    let applied = 0;
                    try {
                        if (action === 'add') {
                            for (const email of emails) {
                                const normalized = email.toLowerCase().trim();
                                if (normalized && !emailWhitelist.has(normalized)) {
                                    emailWhitelist.add(normalized);
                                    applied++;
                                }
                            }
                        } else {
                            for (const email of emails) {
                                const normalized = email.toLowerCase().trim();
                                if (normalized && normalized !== ADMIN_EMAIL && emailWhitelist.has(normalized)) {
                                    emailWhitelist.delete(normalized);
                                    applied++;
                                }
                            }
                        }
                        await saveWhitelist();
                        sendJSON(res, 200, { success: true, action, applied, total: emailWhitelist.size });
                    } catch (writeErr) {
                        // Rollback on save failure
                        emailWhitelist = snapshot;
                        try { await saveWhitelist(); } catch (e) { /* snapshot restore best-effort */ }
                        sendJSON(res, 500, { error: 'Failed to save changes. Rolled back to previous state. Please retry.' });
                    }
                } catch (e) {
                    sendJSON(res, 400, { error: 'Invalid request' });
                }
            });
            return;
        }

        sendJSON(res, 404, { error: 'Not found' });
        return;
    }

    // ===== Kite Connect OAuth & API =====

    // Redirect to Zerodha login page
    if (pathname === '/auth/kite') {
        if (!kiteClient) {
            sendJSON(res, 400, { error: 'Kite Connect not configured. Set kite.enabled=true in config.json' });
            return;
        }
        const loginUrl = kiteClient.getLoginUrl();
        res.writeHead(302, { Location: loginUrl });
        res.end();
        return;
    }

    // OAuth callback — Zerodha redirects here with request_token
    if (pathname === '/auth/kite/callback') {
        if (!kiteClient) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Kite Connect not configured</h2><p>Set kite.enabled=true in config.json and restart.</p></body></html>');
            return;
        }
        const requestToken = parsedUrl.searchParams.get('request_token');
        if (!requestToken) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Error</h2><p>No request_token received from Zerodha. Please try again.</p><a href="/">Back to Dashboard</a></body></html>');
            return;
        }
        try {
            const tokenData = await kiteClient.exchangeToken(requestToken);
            console.log('  ✅ Kite login successful!');
            // Kick off cold-start jobs in background — user gets dashboard immediately.
            // Instrument tokens (one-time, ~5MB CSV) and 52W cache (~3 min full refresh).
            (async () => {
                if (Object.keys(instrumentTokens).length === 0) await fetchInstrumentTokens();
                maybeRefresh52W();
            })().catch(e => console.error('  ❌ Post-OAuth init failed:', e.message));
            res.writeHead(302, { Location: '/?kite=success' });
            res.end();
        } catch (e) {
            console.error('  ❌ Kite token exchange failed:', e.message);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h2>Login Failed</h2><p>${e.message}</p><p>This might happen if the request_token expired. Please try again.</p><a href="/auth/kite">Retry Login</a> | <a href="/">Dashboard</a></body></html>`);
        }
        return;
    }

    // Kite status API
    if (pathname === '/api/kite/status') {
        if (!kiteClient) {
            sendJSON(res, 200, { enabled: false, authenticated: false });
            return;
        }
        sendJSON(res, 200, {
            enabled: true,
            authenticated: kiteClient.isAuthenticated(),
            apiKey: config.kite.apiKey ? config.kite.apiKey.substring(0, 6) + '...' : '',
        });
        return;
    }

    // Kite portfolio — holdings
    if (pathname === '/api/kite/holdings') {
        if (!kiteClient || !kiteClient.isAuthenticated()) {
            sendJSON(res, 200, { error: 'Not authenticated', holdings: [] });
            return;
        }
        try {
            const holdings = await kiteClient.getHoldings();
            sendJSON(res, 200, { source: 'kite', holdings: holdings || [] });
        } catch (e) {
            sendJSON(res, 200, { error: e.message, holdings: [] });
        }
        return;
    }

    // Kite portfolio — positions
    if (pathname === '/api/kite/positions') {
        if (!kiteClient || !kiteClient.isAuthenticated()) {
            sendJSON(res, 200, { error: 'Not authenticated', positions: [] });
            return;
        }
        try {
            const positions = await kiteClient.getPositions();
            sendJSON(res, 200, { source: 'kite', positions: positions || [] });
        } catch (e) {
            sendJSON(res, 200, { error: e.message, positions: [] });
        }
        return;
    }

    // Kite profile
    if (pathname === '/api/kite/profile') {
        if (!kiteClient || !kiteClient.isAuthenticated()) {
            sendJSON(res, 200, { error: 'Not authenticated' });
            return;
        }
        try {
            const profile = await kiteClient.getProfile();
            sendJSON(res, 200, { source: 'kite', profile: profile || {} });
        } catch (e) {
            sendJSON(res, 200, { error: e.message });
        }
        return;
    }

    // Kite quote — get LTP for multiple symbols
    if (pathname === '/api/kite/quote') {
        if (!kiteClient || !kiteClient.isAuthenticated()) {
            sendJSON(res, 200, { error: 'Not authenticated', quotes: [] });
            return;
        }
        const symbolsParam = parsedUrl.searchParams.get('symbols');
        if (!symbolsParam) {
            sendJSON(res, 200, { error: 'No symbols provided', quotes: [] });
            return;
        }
        try {
            const symbols = symbolsParam.split(',').map(s => `NSE:${s.trim()}`);
            const quotes = await kiteClient.getLTP(symbols);
            sendJSON(res, 200, { source: 'kite', quotes: quotes || [] });
        } catch (e) {
            sendJSON(res, 200, { error: e.message, quotes: [] });
        }
        return;
    }

    // Kite logout (clear token)
    if (pathname === '/api/kite/logout') {
        if (kiteClient) {
            kiteClient.accessToken = null;
            try { fs.unlinkSync(kiteClient.tokenFile); } catch (e) {}
            console.log('  🔒 Kite token cleared');
        }
        sendJSON(res, 200, { success: true, message: 'Logged out from Kite' });
        return;
    }

    // ===== Static File Serving (with gzip + cache headers) =====
    let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname.split('?')[0]);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const compressible = ['.html', '.css', '.js', '.json', '.svg', '.xml'].includes(ext);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2); });
            } else { res.writeHead(500); res.end('Server Error'); }
        } else {
            const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
            const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
            if (compressible && acceptGzip && data.length > 1024) {
                zlib.gzip(data, (err2, compressed) => {
                    if (err2) { res.writeHead(200, headers); res.end(data); return; }
                    headers['Content-Encoding'] = 'gzip';
                    headers['Vary'] = 'Accept-Encoding';
                    res.writeHead(200, headers);
                    res.end(compressed);
                });
            } else {
                res.writeHead(200, headers);
                res.end(data);
            }
        }
    });
});

// Wait for whitelist to load from GCS/file before accepting requests
whitelistReady.then(() => {
server.listen(PORT, () => {
    console.log(`\n  🟢  7 Bar Market Monitor v2.1 running at http://localhost:${PORT}`);
    console.log(`\n  📊 NSE Endpoints:`);
    console.log(`     /api/market-data       Advance/Decline, Sectors, Sentiment`);
    console.log(`     /api/gainers           Top 10 Gainers (Nifty 500)`);
    console.log(`     /api/losers            Top 10 Losers (Nifty 500)`);
    console.log(`     /api/seven-bar-stocks  Stocks near 52-week high`);
    console.log(`     /api/health            Server health status`);
    console.log(`\n  📰 News Endpoints:`);
    console.log(`     /api/news              Indian Market News`);
    console.log(`     /api/trump-news        Trumpometer News`);
    if (kiteClient) {
        console.log(`\n  🔗 Kite Connect:`);
        console.log(`     /auth/kite             Login to Zerodha`);
        console.log(`     /auth/kite/callback    OAuth callback`);
        console.log(`     /api/kite/status       Auth status`);
        console.log(`     /api/kite/holdings     Portfolio holdings`);
        console.log(`     /api/kite/positions    Open positions`);
        console.log(`     /api/kite/profile      User profile`);
    }
    console.log('');

    // Pre-warm NSE cache on startup so first visitor gets instant data
    console.log('  ⏳ Pre-warming NSE cache...');
    Promise.allSettled([
        getCachedNSE('allIndices', '/api/allIndices'),
        getCachedNSE('nifty500', '/api/equity-stockIndices?index=NIFTY%20500'),
        getNiftyEMAStatus(),
        fetchGoldPrice(),
        fetchUSDINRRate(),
    ]).then(() => console.log('  ✅ Cache pre-warmed — ready for visitors'));

    // Keep-alive self-ping to prevent Render free tier spin-down
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        setInterval(() => {
            https.get(RENDER_URL + '/api/health', () => {}).on('error', () => {});
            console.log('  🏓 Keep-alive ping sent');
        }, 14 * 60 * 1000); // every 14 minutes
    }
});
}); // end whitelistReady.then
