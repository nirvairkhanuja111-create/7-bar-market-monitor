const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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

const emailCfg = config.email || {};
const emailTransporter = (emailCfg.user && emailCfg.pass)
    ? nodemailer.createTransport({ service: emailCfg.service || 'gmail', auth: { user: emailCfg.user, pass: emailCfg.pass } })
    : null;

function generateOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function sendOtpEmail(email, otp) {
    if (!emailTransporter) {
        // Dev mode — print to console
        console.log(`\n  🔑 OTP for ${email}: ${otp}  (no email config — dev mode)\n`);
        return;
    }
    await emailTransporter.sendMail({
        from: `"Market Monitor" <${emailCfg.user}>`,
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

        // Map Kite symbol to NSE index name
        const indexName = sym.replace('NSE:', '');
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
        stocks.push({
            symbol,
            lastPrice: String(q.last_price),
            pChange: String(pctChange.toFixed(2)),
            open: String(q.ohlc?.open || 0),
            dayHigh: String(q.ohlc?.high || q.last_price),
            dayLow: String(q.ohlc?.low || q.last_price),
            previousClose: String(prevClose),
            yearHigh: '0', // Not available from Kite quote
            yearLow: '0',
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

async function getCachedNSE(key, apiPath) {
    const now = Date.now();
    const ttl = isMarketHours() ? NSE_CACHE_TTL_MARKET : NSE_CACHE_TTL_OFFHOURS;

    if (nseCache[key] && (now - nseCache[key].timestamp) < ttl) {
        return { data: nseCache[key].data, cached: true };
    }

    try {
        const data = await fetchNSE(apiPath);
        nseCache[key] = { data, timestamp: now };

        // Auto-save Nifty 500 symbol list when NSE works
        if (key === 'nifty500' && data.data) {
            const symbols = data.data
                .filter(s => s.symbol && s.symbol !== 'NIFTY 500')
                .map(s => s.symbol);
            if (symbols.length > 400) saveNifty500Symbols(symbols);
        }

        return { data, cached: false };
    } catch (nseError) {
        // NSE failed — try Kite fallback
        if (kiteClient?.isAuthenticated()) {
            console.log(`  🔄 NSE failed for ${key}, trying Kite fallback...`);
            try {
                const kiteData = await fetchAllFromKite();
                if (kiteData) {
                    let data;
                    if (key === 'allIndices') {
                        data = kiteToNSEAllIndices(kiteData.allIndices, kiteData.nifty500);
                    } else if (key === 'nifty500' || apiPath.includes('equity-stockIndices')) {
                        data = kiteToNSEStocks(kiteData.nifty500);
                    } else {
                        throw nseError; // No Kite equivalent for this endpoint
                    }
                    if (data) {
                        nseCache[key] = { data, timestamp: now };
                        console.log(`  ✅ Kite fallback successful for ${key}`);
                        return { data, cached: false };
                    }
                }
            } catch (kiteError) {
                console.error(`  ❌ Kite fallback also failed for ${key}:`, kiteError.message);
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
// ===== USA NEWS & EARNINGS =====================================
// ================================================================

const USA_NEWS_FEEDS = [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EIXIC&region=US&lang=en-US',
    'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    'https://feeds.content.dowjones.io/public/rss/mw_topstories',
];

let usaNewsCache = { data: null, time: 0 };
const USA_NEWS_CACHE_TTL = 180000; // 3 minutes

async function getUSAMarketNews() {
    const now = Date.now();
    if (usaNewsCache.data && (now - usaNewsCache.time) < USA_NEWS_CACHE_TTL) return usaNewsCache.data;
    let allItems = [];
    for (const feedUrl of USA_NEWS_FEEDS) {
        try {
            const xml = await fetchUrl(feedUrl);
            const items = parseRSSItems(xml);
            items.forEach(item => {
                const t = (item.title || '').toLowerCase();
                if (t.includes('fed') || t.includes('rate') || t.includes('inflation') || t.includes('gdp')) item.tag = 'FED';
                else if (t.includes('nasdaq') || t.includes('s&p') || t.includes('dow') || t.includes('stock')) item.tag = 'MARKET';
                else if (t.includes('earning') || t.includes('profit') || t.includes('revenue')) item.tag = 'EARNINGS';
                else if (t.includes('tariff') || t.includes('trade') || t.includes('china')) item.tag = 'TRADE';
                else item.tag = 'US';
            });
            allItems = allItems.concat(items);
        } catch (e) {
            console.log('USA news feed error:', feedUrl, e.message);
        }
    }
    const seen = new Set();
    const unique = allItems.filter(item => {
        const key = (item.title || '').substring(0, 50).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    unique.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const result = { items: unique.slice(0, 10), source: 'live' };
    usaNewsCache.data = result;
    usaNewsCache.time = now;
    return result;
}

let usaEarningsCache = { data: null, time: 0 };
const USA_EARNINGS_CACHE_TTL = 3600000; // 1 hour

// ================================================================
// ===== INDIA EARNINGS CALENDAR ==================================
// ================================================================

let indiaEarningsCache = { data: null, time: 0 };
const INDIA_EARNINGS_CACHE_TTL = 1800000; // 30 min

async function getIndiaEarningsCalendar() {
    const now = Date.now();
    if (indiaEarningsCache.data && (now - indiaEarningsCache.time) < INDIA_EARNINGS_CACHE_TTL) return indiaEarningsCache.data;
    try {
        // Try board meetings endpoint first, then fall back to event calendar
        let events = [];
        try {
            events = await fetchNSE('/api/boardMeetings?status=upcoming');
            if (!Array.isArray(events)) events = events.data || [];
        } catch (e1) {
            try {
                const cal = await fetchNSE('/api/event-calendar');
                events = Array.isArray(cal) ? cal : [];
            } catch (e2) { events = []; }
        }

        const today = new Date();
        const earnings = events
            .filter(e => {
                // Accept financial results, board meetings, or any quarterly/annual event
                const subj = (e.subject || e.bm_desc || e.purpose || '').toLowerCase();
                return subj.includes('result') || subj.includes('dividend') ||
                       subj.includes('agm') || subj.includes('board') || subj.includes('financial');
            })
            .filter(e => {
                const dateStr = e.date || e.bm_date || '';
                if (!dateStr) return false;
                // NSE dates: "DD-MMM-YYYY" or "YYYY-MM-DD"
                const d = new Date(dateStr);
                if (isNaN(d)) return true; // include if can't parse
                const diff = (d - today) / 86400000;
                return diff >= -1 && diff <= 30;
            })
            .slice(0, 20)
            .map(e => ({
                symbol: e.symbol || '',
                companyName: e.company || e.companyName || e.symbol || '',
                date: e.date || e.bm_date || '',
                subject: e.subject || e.bm_desc || e.purpose || '',
                time: '--',
            }));
        const result = { earnings, source: earnings.length ? 'live' : 'fallback', timestamp: new Date().toISOString() };
        indiaEarningsCache.data = result;
        indiaEarningsCache.time = now;
        return result;
    } catch (e) {
        console.log('India earnings error:', e.message);
        return { earnings: [], source: 'fallback', error: e.message };
    }
}

async function getUSAEarningsCalendar() {
    const now = Date.now();
    if (usaEarningsCache.data && (now - usaEarningsCache.time) < USA_EARNINGS_CACHE_TTL) return usaEarningsCache.data;
    try {
        // Use NASDAQ public earnings calendar API — no auth needed
        const today = new Date().toISOString().slice(0, 10);
        const url = `https://api.nasdaq.com/api/calendar/earnings?date=${today}`;
        const raw = await fetchUrl(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' });
        const json = JSON.parse(raw);
        const rows = json.data?.rows || [];
        const earnings = rows.slice(0, 20).map(r => ({
            symbol: r.symbol || '',
            companyName: r.name || r.symbol || '',
            date: today,
            epsEstimate: r.lastYearEPS || null,
            time: r.time || '--',
        })).filter(e => e.symbol);
        const result = { earnings, source: earnings.length ? 'live' : 'fallback', timestamp: new Date().toISOString() };
        usaEarningsCache.data = result;
        usaEarningsCache.time = now;
        return result;
    } catch (e) {
        console.log('USA earnings error:', e.message);
        return { earnings: [], source: 'fallback', error: e.message };
    }
}

// NASDAQ 100 top symbols for ticker tape
const NDX100_SYMBOLS = [
    'AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AVGO','COST','AMD',
    'NFLX','ADBE','QCOM','INTC','INTU','AMAT','MU','LRCX','KLAC','MRVL',
    'PANW','SNPS','CDNS','FTNT','CRWD','MELI','ASML','ARM','ABNB','DXCM'
];

let ndx100Cache = { data: null, time: 0 };
const NDX100_CACHE_TTL = 60000; // 1 minute

async function fetchNDX100Ticker() {
    const now = Date.now();
    if (ndx100Cache.data && (now - ndx100Cache.time) < NDX100_CACHE_TTL) return ndx100Cache.data;
    try {
        // Use TradingView symbol-list scan — no auth needed
        const tickers = NDX100_SYMBOLS.map(s => `NASDAQ:${s}`);
        const raw = await postJson('https://scanner.tradingview.com/global/scan', {
            symbols: { tickers, query: { types: [] } },
            columns: ['close', 'change', 'volume', 'description']
        });
        const json = JSON.parse(raw);
        const stocks = (json.data || []).map(item => {
            const [close, change, volume, description] = item.d || [];
            return {
                symbol: (item.s || '').replace('NASDAQ:', ''),
                name: description || item.s || '',
                ltp: close || 0,
                change: change || 0,
            };
        }).filter(s => s.ltp > 0);
        const result = { stocks, source: stocks.length ? 'live' : 'fallback' };
        ndx100Cache.data = result;
        ndx100Cache.time = now;
        return result;
    } catch (e) {
        console.log('NDX100 ticker error:', e.message);
        return { stocks: [], source: 'fallback', error: e.message };
    }
}

// ================================================================
// ===== USA MARKET DATA ==========================================
// ================================================================

const usaCache = {};
const USA_CACHE_TTL = 30000; // 30s

// S&P 500 constituents (major stocks across all GICS sectors)
const SP500_SYMBOLS = new Set([
    // Technology
    'AAPL','MSFT','NVDA','AVGO','ORCL','CRM','ADBE','AMD','QCOM','TXN','INTC',
    'AMAT','MU','KLAC','LRCX','ADI','SNPS','CDNS','NXPI','MRVL','HPQ','STX',
    'WDC','NTAP','KEYS','ANSS','PTC','CTSH','ACN','GLW','TDY','ZBRA','TTWO',
    'EA','ATVI','RBLX','DDOG','MDB','SNOW','NOW','WDAY','VEEV','TEAM','ZM',
    'PANW','CRWD','FTNT','ZS','OKTA','NET','CYBR','S','PLTR','EPAM','GDDY',
    // Communication Services
    'META','GOOGL','GOOG','NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR',
    'PARA','FOX','FOXA','OMC','IPG','TTD','PINS','MTCH','LYV','NWSA',
    // Financials
    'JPM','BAC','WFC','GS','MS','C','BLK','SCHW','AXP','V','MA',
    'COF','USB','PNC','TFC','BK','STT','TROW','MCO','SPGI','ICE','CME',
    'CBOE','FIS','FI','NDAQ','MTB','CFG','FITB','HBAN','RF','KEY','SIVB',
    'AFL','MET','PRU','AIG','TRV','CB','ALL','HIG','CINF','LNC','GL',
    // Healthcare
    'UNH','JNJ','LLY','ABBV','MRK','PFE','ABT','AMGN','BMY','GILD',
    'VRTX','REGN','BIIB','ZTS','IDXX','CI','ELV','HUM','CNC','HCA',
    'ISRG','EW','SYK','MDT','BSX','BAX','BDX','DHR','A','DGX','LH',
    'IQV','MTD','ALGN','DXCM','HOLX','BIO','MOH','UHS','THC','ABC','CAH','MCK',
    // Consumer Discretionary
    'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TJX','ROST','TGT',
    'DG','DLTR','ORLY','AZO','CMG','YUM','MAR','HLT','BKNG','EXPE',
    'LVS','MGM','WYNN','F','GM','APTV','LEA','BWA','LEN','DHI','NVR',
    'PHM','TOL','BBY','RL','PVH','TPR','VFC','HAS','MAT','ULTA','AMZN',
    // Consumer Staples
    'WMT','COST','PG','KO','PEP','PM','MO','MDLZ','CL','KMB',
    'GIS','CAG','HRL','MKC','STZ','EL','SYY','KR','CVS','WBA',
    'TSN','K','CPB','SJM','CHD','CLX','HRL','MKC','MNST','TAP',
    // Energy
    'XOM','CVX','COP','SLB','EOG','PXD','PSX','VLO','MPC','OXY',
    'HAL','BKR','DVN','HES','KMI','OKE','WMB','TRGP','MRO','APA',
    'FANG','CVI','DKL','LNG','CQP','NFG',
    // Industrials
    'GE','CAT','UNP','LMT','RTX','NOC','HON','DE','MMM','GD','BA',
    'FDX','UPS','CSX','NSC','EMR','ETN','PH','ROK','ITW','FAST',
    'PCAR','CTAS','URI','CARR','OTIS','JCI','TT','HUBB','AME','PWR',
    'EXPD','CHRW','CPRT','XPO','JBHT','ODFL','SAIA','GXO','RXO',
    'GWW','MSC','FLS','IR','XYL','GNRC','WSO','AOS','MAS','SWK',
    // Materials
    'LIN','APD','ECL','DD','DOW','LYB','NUE','STLD','FCX','NEM',
    'ALB','CE','FMC','MLM','VMC','PKG','IP','PPG','SHW','RPM',
    'CF','MOS','SEE','BLL','CCK','AVY','ATI','ARNC',
    // Real Estate
    'AMT','PLD','CCI','EQIX','SPG','O','DLR','WELL','PSA','EXR',
    'AVB','EQR','VTR','BXP','KIM','ARE','WY','DEA','MPW','GLPI',
    // Utilities
    'NEE','DUK','SO','D','AEP','EXC','SRE','PEG','ES','EIX',
    'XEL','WEC','AES','PPL','CNP','AWK','LNT','PNW','NI','CMS','DTE',
    // Other notable S&P 500
    'BRK.B','UBER','LYFT','ABNB','PYPL','SQ','AFRM','SOFI',
    'MRNA','BNTX','SRPT','BMRN','ALNY','RARE',
    'AXON','LDOS','SAIC','BAH','CACI','MANT',
    'NVR','PHM','TPH','MDC','CCS'
]);

// USA indices via TradingView global scanner
async function fetchUSAIndices() {
    const now = Date.now();
    if (usaCache.indices && (now - usaCache.indices.time) < USA_CACHE_TTL) return usaCache.indices.data;
    const raw = await postJson('https://scanner.tradingview.com/global/scan', {
        symbols: { tickers: ['SP:SPX', 'NASDAQ:NDX', 'DJ:DJI', 'TVC:RUT', 'TVC:VIX', 'TVC:DXY'] },
        columns: ['close', 'change', 'change_abs', 'open', 'high', 'low']
    });
    const json = JSON.parse(raw);
    const nameMap = { 'SP:SPX': 'S&P 500', 'NASDAQ:NDX': 'Nasdaq 100', 'DJ:DJI': 'Dow Jones', 'TVC:RUT': 'Russell 2000', 'TVC:VIX': 'VIX', 'TVC:DXY': 'DXY' };
    const result = {};
    for (const item of (json.data || [])) {
        const [close, changePct, changeAbs, open, high, low] = item.d;
        result[item.s] = { name: nameMap[item.s] || item.s, price: close || 0, change: changePct || 0, open: open || 0, high: high || 0, low: low || 0 };
    }
    usaCache.indices = { data: result, time: now };
    return result;
}

// USA sectors via SPDR ETFs through TradingView
const US_SECTOR_ETFS = {
    'AMEX:XLK': { name: 'Tech', fullName: 'Technology' },
    'AMEX:XLV': { name: 'Health', fullName: 'Healthcare' },
    'AMEX:XLF': { name: 'Financials', fullName: 'Financials' },
    'AMEX:XLY': { name: 'Cons. Disc', fullName: 'Consumer Discretionary' },
    'AMEX:XLP': { name: 'Staples', fullName: 'Consumer Staples' },
    'AMEX:XLE': { name: 'Energy', fullName: 'Energy' },
    'AMEX:XLB': { name: 'Materials', fullName: 'Materials' },
    'AMEX:XLI': { name: 'Industrials', fullName: 'Industrials' },
    'AMEX:XLU': { name: 'Utilities', fullName: 'Utilities' },
    'AMEX:XLRE': { name: 'Real Estate', fullName: 'Real Estate' },
    'AMEX:XLC': { name: 'Comm. Svcs', fullName: 'Communication Services' },
};

async function fetchUSASectors() {
    const now = Date.now();
    if (usaCache.sectors && (now - usaCache.sectors.time) < USA_CACHE_TTL) return usaCache.sectors.data;
    const tickers = Object.keys(US_SECTOR_ETFS);
    const raw = await postJson('https://scanner.tradingview.com/global/scan', {
        symbols: { tickers },
        columns: ['close', 'change', 'change_abs', 'open', 'high', 'low']
    });
    const json = JSON.parse(raw);
    const sectors = [];
    for (const item of (json.data || [])) {
        const meta = US_SECTOR_ETFS[item.s];
        if (!meta) continue;
        const [close, changePct] = item.d;
        sectors.push({ name: meta.name, fullName: meta.fullName, change: changePct || 0, last: close || 0 });
    }
    sectors.sort((a, b) => b.change - a.change);
    usaCache.sectors = { data: sectors, time: now };
    return sectors;
}

// USA gainers/losers from S&P 500 via TradingView
async function fetchUSAGainersLosers() {
    const now = Date.now();
    if (usaCache.gl && (now - usaCache.gl.time) < USA_CACHE_TTL) return usaCache.gl.data;
    // Fetch top 200 by gain/loss, filter to NYSE/NASDAQ only (OTC foreign ADRs excluded)
    const [rawG, rawL] = await Promise.all([
        postJson('https://scanner.tradingview.com/america/scan', {
            filter: [{ left: 'market_cap_basic', operation: 'greater', right: 2000000000 }],
            columns: ['name', 'description', 'close', 'change', 'volume'],
            sort: { sortBy: 'change', sortOrder: 'desc' },
            range: [0, 200]
        }),
        postJson('https://scanner.tradingview.com/america/scan', {
            filter: [{ left: 'market_cap_basic', operation: 'greater', right: 2000000000 }],
            columns: ['name', 'description', 'close', 'change', 'volume'],
            sort: { sortBy: 'change', sortOrder: 'asc' },
            range: [0, 200]
        })
    ]);
    // Only keep NYSE/NASDAQ listed stocks, exclude preferred shares (symbol contains /)
    function parseUSStocks(raw) {
        return (JSON.parse(raw).data || [])
            .filter(item => /^(NYSE:|NASDAQ:|AMEX:)/.test(item.s || '') && !item.s.includes('/'))
            .map(item => {
                const [symbol, desc, close, change, volume] = item.d;
                return {
                    symbol: (item.s || '').replace(/^(NASDAQ:|NYSE:|AMEX:)/, ''),
                    name: desc || symbol || '',
                    ltp: close || 0, change: change || 0, volume: volume || 0
                };
            });
    }
    const gainers = parseUSStocks(rawG).filter(s => s.change > 0).slice(0, 10);
    const losers = parseUSStocks(rawL).filter(s => s.change < 0).slice(0, 10);
    const result = { gainers, losers };
    usaCache.gl = { data: result, time: now };
    return result;
}

// USA 7-bar stocks (near 52-week high, S&P 500 only)
async function fetchUSASevenBar() {
    const now = Date.now();
    if (usaCache.sevenBar && (now - usaCache.sevenBar.time) < USA_CACHE_TTL) return usaCache.sevenBar.data;
    const raw = await postJson('https://scanner.tradingview.com/america/scan', {
        filter: [{ left: 'market_cap_basic', operation: 'greater', right: 2000000000 }],
        columns: ['name', 'description', 'close', 'change', 'price_52_week_high', 'price_52_week_low', 'volume'],
        sort: { sortBy: 'name', sortOrder: 'asc' },
        range: [0, 600]
    });
    const json = JSON.parse(raw);
    const stocks = (json.data || [])
        .filter(item => /^(NYSE:|NASDAQ:|AMEX:)/.test(item.s || ''))
        .map(item => {
            const sym = (item.s || '').replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
            if (!SP500_SYMBOLS.has(sym)) return null;  // S&P 500 only
            const [symbol, desc, close, change, weekHigh] = item.d;
            if (!weekHigh || !close || weekHigh <= 0) return null;
            const distFromHigh = ((weekHigh - close) / weekHigh) * 100;
            return {
                symbol: sym,
                name: desc || symbol || '',
                ltp: close, change: change || 0,
                ath: weekHigh, distFromATH: parseFloat(distFromHigh.toFixed(2)),
                dayChange: (change || 0).toFixed(2)
            };
        })
        .filter(s => s && s.distFromATH >= 0 && s.distFromATH <= 5)
        .sort((a, b) => a.distFromATH - b.distFromATH)
        .slice(0, 15);
    usaCache.sevenBar = { data: { stocks, source: 'live' }, time: now };
    return usaCache.sevenBar.data;
}

// S&P 500 EMA status via Yahoo Finance historical data
async function getSPXEMAStatus() {
    const now = Date.now();
    if (usaCache.ema && (now - usaCache.ema.time) < 60 * 60 * 1000) return usaCache.ema.data;
    try {
        const raw = await fetchUrl('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=4mo');
        const json = JSON.parse(raw);
        const closes = (json.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
        if (closes.length < 50) throw new Error('Not enough data');
        function calcEMA(data, period) {
            const k = 2 / (period + 1);
            let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
            for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
            return ema;
        }
        const currentPrice = closes[closes.length - 1];
        const ema21 = calcEMA(closes, 21);
        const ema50 = calcEMA(closes, 50);
        let status;
        if (currentPrice > ema21) status = 'yes';
        else if (currentPrice > ema50) status = 'selective';
        else status = 'no';
        const result = { status, currentPrice: parseFloat(currentPrice.toFixed(2)), ema21: parseFloat(ema21.toFixed(2)), ema50: parseFloat(ema50.toFixed(2)), index: 'S&P 500' };
        usaCache.ema = { data: result, time: now };
        return result;
    } catch (e) {
        console.log('SPX EMA error:', e.message);
        return { status: 'no', currentPrice: 0, ema21: 0, ema50: 0, index: 'S&P 500' };
    }
}

// USA A/D ratio (computed from S&P 500 stocks via TradingView)
async function fetchUSAAdvDec() {
    const now = Date.now();
    if (usaCache.advDec && (now - usaCache.advDec.time) < USA_CACHE_TTL) return usaCache.advDec.data;
    try {
        const raw = await postJson('https://scanner.tradingview.com/america/scan', {
            filter: [
                { left: 'market_cap_basic', operation: 'greater', right: 2000000000 }
            ],
            columns: ['change'],
            range: [0, 503]
        });
        const json = JSON.parse(raw);
        let advancing = 0, declining = 0, unchanged = 0;
        for (const item of (json.data || [])) {
            const change = item.d[0] || 0;
            if (change > 0.01) advancing++;
            else if (change < -0.01) declining++;
            else unchanged++;
        }
        const result = { advancing, declining, unchanged };
        usaCache.advDec = { data: result, time: now };
        return result;
    } catch (e) {
        return { advancing: 0, declining: 0, unchanged: 0 };
    }
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
            const { data, cached } = await getCachedNSE(`sector-${sectorParam}`, `/api/equity-stockIndices?index=${encodeURIComponent(sectorParam)}`);
            const allStocks = (data.data || []).filter(s => s.symbol && s.symbol !== sectorParam);
            const sorted = allStocks
                .map(s => ({
                    symbol: s.symbol,
                    companyName: s.meta?.companyName || '',
                    ltp: parseFloat(s.lastPrice) || 0,
                    change: parseFloat(s.pChange) || 0,
                    open: parseFloat(s.open) || 0,
                    high: parseFloat(s.dayHigh) || 0,
                    low: parseFloat(s.dayLow) || 0,
                }))
                .sort((a, b) => b.change - a.change);
            sendJSON(res, 200, { source: 'nse', cached, stocks: sorted, timestamp: new Date().toISOString() });
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

    // ===== USA Market Data =====
    if (pathname === '/api/usa/market-data') {
        try {
            const [indices, emaStatus, advDec, sectors] = await Promise.allSettled([
                fetchUSAIndices(),
                getSPXEMAStatus(),
                fetchUSAAdvDec(),
                fetchUSASectors()
            ]);
            sendJSON(res, 200, {
                indices: indices.status === 'fulfilled' ? indices.value : {},
                emaStatus: emaStatus.status === 'fulfilled' ? emaStatus.value : { status: 'no', currentPrice: 0, ema21: 0, ema50: 0 },
                advancing: advDec.status === 'fulfilled' ? advDec.value.advancing : 0,
                declining: advDec.status === 'fulfilled' ? advDec.value.declining : 0,
                unchanged: advDec.status === 'fulfilled' ? advDec.value.unchanged : 0,
                sectors: sectors.status === 'fulfilled' ? sectors.value : [],
                timestamp: new Date().toISOString()
            });
        } catch (e) { sendJSON(res, 200, { error: e.message }); }
        return;
    }

    if (pathname === '/api/usa/gainers') {
        try {
            const { gainers } = await fetchUSAGainersLosers();
            sendJSON(res, 200, { source: 'live', stocks: gainers, timestamp: new Date().toISOString() });
        } catch (e) { sendJSON(res, 200, { error: e.message, stocks: [] }); }
        return;
    }

    if (pathname === '/api/usa/losers') {
        try {
            const { losers } = await fetchUSAGainersLosers();
            sendJSON(res, 200, { source: 'live', stocks: losers, timestamp: new Date().toISOString() });
        } catch (e) { sendJSON(res, 200, { error: e.message, stocks: [] }); }
        return;
    }

    if (pathname === '/api/usa/seven-bar') {
        try {
            sendJSON(res, 200, await fetchUSASevenBar());
        } catch (e) { sendJSON(res, 200, { error: e.message, stocks: [] }); }
        return;
    }

    if (pathname === '/api/usa/mbi-data') {
        try {
            const sheetUrl = 'https://docs.google.com/spreadsheets/d/1O6OhS7ciA8zwfycBfGPbP2fWJnR0pn2UUvFZVDP9jpE/export?format=csv&gid=1082103394';
            const csv = await fetchUrlWithHeaders(sheetUrl, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/csv,text/plain,*/*',
            });
            const lines = csv.trim().split('\n').filter(l => l.trim());
            // Parse header row — only keep first 7 columns (A through G)
            function parseCSVRow(line) {
                const result = [];
                let cur = '', inQuote = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (ch === '"') { inQuote = !inQuote; }
                    else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
                    else { cur += ch; }
                }
                result.push(cur.trim());
                return result;
            }
            // Row 0 is a section-title row (merged cells); row 1 has actual column headers
            const allHeaders = parseCSVRow(lines[1] || lines[0]).map(h => h.replace(/"/g, '').trim());
            const headers = allHeaders.slice(0, 7).filter(h => h);
            const rows = [];
            for (let i = 2; i < lines.length && rows.length < 30; i++) {
                const vals = parseCSVRow(lines[i]).map(v => v.replace(/"/g, '').trim());
                if (!vals[0]) continue;
                const row = {};
                headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
                rows.push(row);
            }
            sendJSON(res, 200, { source: 'live', rows, headers, total: rows.length, timestamp: new Date().toISOString() });
        } catch (e) {
            console.error('USA MBI error:', e.message);
            sendJSON(res, 200, { source: 'fallback', rows: [], error: e.message });
        }
        return;
    }

    if (pathname === '/api/stage-analysis') {
        const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
        const market = parsedUrl.searchParams.get('market') || 'india';
        if (!symbol) { sendJSON(res, 200, { error: 'No symbol provided' }); return; }
        try {
            const yhSymbol = market === 'india' ? `${symbol}.NS` : symbol;
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yhSymbol}?interval=1d&range=2y`;
            const raw = await fetchUrl(url);
            const json = JSON.parse(raw);
            const result = json.chart?.result?.[0];
            if (!result) throw new Error('No data returned');

            const rawCloses = result.indicators.quote[0].close;
            const rawVolumes = result.indicators.quote[0].volume;
            const closes = rawCloses.filter(Boolean);
            const volumes = rawVolumes.map(v => v || 0);

            if (closes.length < 100) throw new Error('Insufficient price history');

            const meta = result.meta || {};
            const name = meta.longName || meta.shortName || symbol;
            const ltp = closes[closes.length - 1];

            // Compute SMAs
            function sma(arr, period) {
                const out = [];
                for (let i = 0; i < arr.length; i++) {
                    if (i < period - 1) { out.push(null); continue; }
                    const slice = arr.slice(i - period + 1, i + 1);
                    out.push(slice.reduce((a, b) => a + b, 0) / period);
                }
                return out;
            }

            const sma150 = sma(closes, 150); // ~30 weeks
            const sma50  = sma(closes, 50);  // ~10 weeks
            const sma200 = sma(closes, 200); // 40 weeks

            const cur150 = sma150[sma150.length - 1];
            const cur50  = sma50[sma50.length - 1];
            const cur200 = sma200[sma200.length - 1];

            // Slope of 30W SMA over last 4 weeks (20 trading days)
            const prev150 = sma150[sma150.length - 21] || cur150;
            const slope150pct = ((cur150 - prev150) / prev150) * 100;

            // Volume: avg 50-day vs recent 10-day
            const vol50avg = volumes.slice(-50).reduce((a, b) => a + b, 0) / 50;
            const vol10avg = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
            const volRatio = vol50avg > 0 ? vol10avg / vol50avg : 1;

            // 52-week high/low
            const yearCloses = closes.slice(-252);
            const yearHigh = Math.max(...yearCloses);
            const yearLow  = Math.min(...yearCloses);
            const pctFrom52WH = ((ltp - yearHigh) / yearHigh) * 100;

            // Stage determination (Weinstein)
            const aboveSMA150 = ltp > cur150;
            const rising150   = slope150pct > 0.3;
            const flat150     = Math.abs(slope150pct) <= 0.3;
            const falling150  = slope150pct < -0.3;

            let stage, stageName, stageClass, stageAction, stageDesc;
            if (aboveSMA150 && rising150 && ltp > cur50) {
                stage = 2; stageName = 'STAGE 2'; stageClass = 'stage-2';
                stageAction = 'ADVANCING';
                stageDesc = 'Price is above a rising 30-week MA. Classic Mark-Up phase. Look for pullbacks to 10W MA for entry or VCP patterns near new highs.';
            } else if (aboveSMA150 && (flat150 || falling150)) {
                stage = 3; stageName = 'STAGE 3'; stageClass = 'stage-3';
                stageAction = 'TOPPING';
                stageDesc = 'Price near a flattening/declining 30-week MA after an advance. Distribution phase. Avoid new longs; reduce existing positions.';
            } else if (!aboveSMA150 && falling150) {
                stage = 4; stageName = 'STAGE 4'; stageClass = 'stage-4';
                stageAction = 'DECLINING';
                stageDesc = 'Price below a declining 30-week MA. Mark-Down phase. Do not buy — wait for Stage 1 base to form before considering.';
            } else {
                stage = 1; stageName = 'STAGE 1'; stageClass = 'stage-1';
                stageAction = 'BASING';
                stageDesc = 'Price consolidating near a flattening 30-week MA. Accumulation phase. Watch for a volume-backed breakout above the base to confirm Stage 2.';
            }

            sendJSON(res, 200, {
                symbol, name, market, ltp: parseFloat(ltp.toFixed(2)),
                stage, stageName, stageClass, stageAction, stageDesc,
                sma150: parseFloat((cur150 || 0).toFixed(2)),
                sma50:  parseFloat((cur50  || 0).toFixed(2)),
                sma200: parseFloat((cur200 || 0).toFixed(2)),
                slope30W: parseFloat(slope150pct.toFixed(2)),
                volRatio: parseFloat(volRatio.toFixed(2)),
                yearHigh: parseFloat(yearHigh.toFixed(2)),
                yearLow:  parseFloat(yearLow.toFixed(2)),
                pctFrom52WH: parseFloat(pctFrom52WH.toFixed(2)),
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            const suffix = market === 'india' ? ' (use NSE symbol e.g. RELIANCE, INFY)' : ' (use US ticker e.g. AAPL, NVDA)';
            sendJSON(res, 200, { error: `Could not fetch data for ${symbol}.${suffix}`, symbol });
        }
        return;
    }

    if (pathname === '/api/usa/analyse-stock') {
        const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
        if (!symbol) { sendJSON(res, 200, { error: 'No symbol provided' }); return; }
        try {
            // Fetch stock data from Yahoo Finance
            const [stockRaw, spxRaw] = await Promise.all([
                fetchUrl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`),
                fetchUrl('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y')
            ]);
            const stockJson = JSON.parse(stockRaw);
            const spxJson = JSON.parse(spxRaw);

            const result = stockJson.chart?.result?.[0];
            if (!result) { sendJSON(res, 200, { error: `${symbol} not found on Yahoo Finance` }); return; }

            const meta = result.meta || {};
            const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
            const volumes = (result.indicators?.quote?.[0]?.volume || []).filter(v => v != null);

            const ltp = meta.regularMarketPrice || closes[closes.length - 1] || 0;
            const prevClose = meta.regularMarketPreviousClose || 0;
            const open = meta.regularMarketOpen || 0;
            const high = meta.regularMarketDayHigh || 0;
            const low = meta.regularMarketDayLow || 0;
            const yearHigh = meta.fiftyTwoWeekHigh || 0;
            const yearLow = meta.fiftyTwoWeekLow || 0;
            const volume = meta.regularMarketVolume || 0;
            const avgVolume10d = meta.averageDailyVolume10Day || meta.averageDailyVolume3Month || 0;
            const companyName = meta.longName || meta.shortName || symbol;
            const pChange = prevClose ? ((ltp - prevClose) / prevClose * 100) : 0;

            // SPX data for relative strength
            const spxCloses = (spxJson.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
            const spxChange = spxCloses.length >= 63
                ? ((spxCloses[spxCloses.length - 1] - spxCloses[spxCloses.length - 63]) / spxCloses[spxCloses.length - 63] * 100)
                : 0;
            const stockChange3m = closes.length >= 63
                ? ((closes[closes.length - 1] - closes[closes.length - 63]) / closes[closes.length - 63] * 100)
                : 0;

            // Compute SMAs
            function sma(data, n) {
                if (data.length < n) return null;
                return data.slice(-n).reduce((a, b) => a + b, 0) / n;
            }
            const sma50 = sma(closes, 50);
            const sma150 = sma(closes, 150);
            const sma200 = sma(closes, Math.min(200, closes.length));

            const checks = [];
            let score = 0;

            // Check 1: Price above key SMAs (Trend Template)
            const aboveSma50 = sma50 && ltp > sma50;
            const aboveSma200 = sma200 && ltp > sma200;
            const sma50aboveSma200 = sma50 && sma200 && sma50 > sma200;
            const trendPass = aboveSma50 && aboveSma200 && sma50aboveSma200;
            const trendWeight = trendPass ? 20 : (aboveSma50 ? 8 : (aboveSma200 ? 4 : 0));
            checks.push({
                name: 'Trend Template (Price vs SMAs)',
                pass: trendPass,
                value: sma50 ? `Price $${ltp.toFixed(2)} | 50-SMA $${sma50.toFixed(2)} | 200-SMA $${sma200 ? sma200.toFixed(2) : 'N/A'}` : 'Insufficient history',
                detail: trendPass ? 'Price above 50 and 200-day SMA, 50 above 200 — full trend template satisfied'
                    : aboveSma50 ? 'Above 50-SMA but not all trend conditions met'
                    : 'Price below key moving averages — not in an uptrend',
                weight: trendWeight
            });
            score += trendWeight;

            // Check 2: 52-Week High Proximity
            const distFrom52WH = yearHigh > 0 ? ((yearHigh - ltp) / yearHigh * 100) : 100;
            const highPass = distFrom52WH <= 25;
            const highWeight = distFrom52WH <= 5 ? 20 : distFrom52WH <= 15 ? 15 : distFrom52WH <= 25 ? 8 : 0;
            checks.push({
                name: '52-Week High Proximity',
                pass: highPass,
                value: `$${ltp.toFixed(2)} | 52W High $${yearHigh.toFixed(2)} | ${distFrom52WH.toFixed(1)}% below high`,
                detail: distFrom52WH <= 5 ? 'Within 5% of 52-week high — ideal Minervini zone'
                    : distFrom52WH <= 15 ? 'Within 15% of 52-week high — acceptable range'
                    : distFrom52WH <= 25 ? 'Within 25% of 52-week high — watch for setup'
                    : 'Too far from 52-week high — stock is in decline',
                weight: highWeight
            });
            score += highWeight;

            // Check 3: Relative Strength vs S&P 500 (3-month)
            const rsPass = stockChange3m > spxChange;
            const rsWeight = stockChange3m > spxChange + 10 ? 20 : stockChange3m > spxChange ? 12 : stockChange3m > spxChange - 5 ? 5 : 0;
            checks.push({
                name: 'Relative Strength vs S&P 500',
                pass: rsPass,
                value: `Stock 3M: ${stockChange3m.toFixed(1)}% | S&P 500 3M: ${spxChange.toFixed(1)}%`,
                detail: rsPass
                    ? `Outperforming S&P 500 by ${(stockChange3m - spxChange).toFixed(1)}% — strong relative strength`
                    : `Underperforming S&P 500 by ${(spxChange - stockChange3m).toFixed(1)}% — weak RS`,
                weight: rsWeight
            });
            score += rsWeight;

            // Check 4: Volume (current vs 10-day avg)
            const volPass = avgVolume10d > 0 && volume > avgVolume10d * 0.8;
            const volWeight = volume > avgVolume10d * 1.5 ? 15 : volume > avgVolume10d ? 10 : volPass ? 5 : 0;
            checks.push({
                name: 'Volume Analysis',
                pass: volPass,
                value: `Vol: ${(volume / 1e6).toFixed(1)}M | 10-day avg: ${(avgVolume10d / 1e6).toFixed(1)}M`,
                detail: volume > avgVolume10d * 1.5 ? 'Volume significantly above average — strong institutional interest'
                    : volume > avgVolume10d ? 'Volume above average — healthy trading activity'
                    : 'Volume below average — limited institutional participation',
                weight: volWeight
            });
            score += volWeight;

            // Check 5: Stage Analysis (Weinstein)
            const aboveLow = yearLow > 0 ? ((ltp - yearLow) / (yearHigh - yearLow) * 100) : 0;
            let stage = 'Unknown';
            if (distFrom52WH <= 10 && aboveLow >= 50) stage = 'Stage 2 — Advancing';
            else if (distFrom52WH <= 25 && aboveLow >= 30) stage = 'Stage 2 — Early/Mid Advance';
            else if (distFrom52WH > 25 && distFrom52WH <= 50 && aboveLow >= 20) stage = 'Stage 1 — Basing (Watch for breakout)';
            else if (distFrom52WH > 50) stage = 'Stage 4 — Declining (AVOID)';
            else stage = 'Stage 3 — Topping / Distribution';
            const isStage2 = stage.includes('Stage 2');
            const stageWeight = isStage2 ? 15 : (stage.includes('Stage 1') ? 5 : 0);
            checks.push({
                name: 'Weinstein Stage Analysis',
                pass: isStage2,
                value: stage,
                detail: isStage2 ? 'Stock is in the ideal stage per Stan Weinstein'
                    : stage.includes('Stage 1') ? 'Building a base — not ready yet, add to watchlist'
                    : 'Not in the right zone — Minervini only trades Stage 2 stocks',
                weight: stageWeight
            });
            score += stageWeight;

            // Check 6: 52-week range position (breakout readiness)
            const rangePosition = yearHigh > yearLow ? ((ltp - yearLow) / (yearHigh - yearLow) * 100) : 50;
            const breakoutPass = rangePosition >= 70;
            const breakoutWeight = rangePosition >= 90 ? 10 : rangePosition >= 70 ? 7 : rangePosition >= 50 ? 3 : 0;
            checks.push({
                name: 'Breakout Readiness',
                pass: breakoutPass,
                value: `${rangePosition.toFixed(0)}% of 52-week range | 52W Low $${yearLow.toFixed(2)}`,
                detail: rangePosition >= 90 ? 'Near top of 52-week range — prime breakout territory'
                    : rangePosition >= 70 ? 'In upper half of range — well-positioned for breakout'
                    : 'Mid-range or below — not in breakout position',
                weight: breakoutWeight
            });
            score += breakoutWeight;

            // Overall verdict
            let verdict, verdictClass;
            if (score >= 70) { verdict = 'STRONG CANDIDATE'; verdictClass = 'strong-candidate'; }
            else if (score >= 50) { verdict = 'WATCHLIST — WAIT FOR SETUP'; verdictClass = 'watchlist'; }
            else if (score >= 30) { verdict = 'WEAK — NOT IDEAL FOR SWING'; verdictClass = 'weak'; }
            else { verdict = 'AVOID — DOES NOT MEET CRITERIA'; verdictClass = 'avoid'; }

            sendJSON(res, 200, {
                symbol, companyName, industry: meta.exchange || 'US Stock',
                ltp: parseFloat(ltp.toFixed(2)), pChange: parseFloat(pChange.toFixed(2)),
                open: parseFloat(open.toFixed(2)), high: parseFloat(high.toFixed(2)),
                low: parseFloat(low.toFixed(2)), prevClose: parseFloat(prevClose.toFixed(2)),
                yearHigh: parseFloat(yearHigh.toFixed(2)), yearLow: parseFloat(yearLow.toFixed(2)),
                score, verdict, verdictClass, checks,
                minerviniNote: score >= 50
                    ? 'This stock shows characteristics that Minervini looks for: proximity to new highs, relative strength, and proper stage positioning. Look for a VCP or tight consolidation near pivot for entry.'
                    : 'This stock currently does not meet Minervini\'s SEPA criteria. Either wait for it to set up properly or look for better candidates near 52-week highs with strong relative strength.',
                market: 'usa',
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            console.error('USA analyse-stock error:', e.message);
            sendJSON(res, 200, { error: `Could not fetch data for ${symbol}. Make sure it is a valid US ticker (e.g. AAPL, MSFT, NVDA).`, symbol });
        }
        return;
    }

    if (pathname === '/api/usa/news') {
        try { sendJSON(res, 200, await getUSAMarketNews()); }
        catch (e) { sendJSON(res, 200, { error: e.message, items: [] }); }
        return;
    }

    if (pathname === '/api/usa/earnings') {
        try { sendJSON(res, 200, await getUSAEarningsCalendar()); }
        catch (e) { sendJSON(res, 200, { error: e.message, earnings: [] }); }
        return;
    }

    if (pathname === '/api/india/earnings') {
        try { sendJSON(res, 200, await getIndiaEarningsCalendar()); }
        catch (e) { sendJSON(res, 200, { error: e.message, earnings: [] }); }
        return;
    }

    if (pathname === '/api/usa/ndx100') {
        try { sendJSON(res, 200, await fetchNDX100Ticker()); }
        catch (e) { sendJSON(res, 200, { stocks: [], error: e.message }); }
        return;
    }

    // ===== USA Top ETF Gainers =====
    if (pathname === '/api/usa/etf-gainers') {
        try {
            const now = Date.now();
            if (usaCache.etfGainers && (now - usaCache.etfGainers.time) < 60000) {
                sendJSON(res, 200, usaCache.etfGainers.data); return;
            }
            const raw = await postJson('https://scanner.tradingview.com/america/scan', {
                filter: [
                    { left: 'type',   operation: 'equal',   right: 'fund'  },
                    { left: 'volume', operation: 'greater', right: 500000  },
                    { left: 'close',  operation: 'greater', right: 5       }
                ],
                columns: ['name', 'description', 'close', 'change', 'volume', 'market_cap_basic'],
                sort: { sortBy: 'change', sortOrder: 'desc' },
                range: [0, 15]
            });
            const json = JSON.parse(raw);
            const etfs = (json.data || [])
                .filter(item => /^(NYSE:|NASDAQ:|AMEX:)/.test(item.s || ''))
                .map(item => {
                    const [sym, desc, close, change, vol] = item.d;
                    return {
                        symbol: (item.s || '').replace(/^(NASDAQ:|NYSE:|AMEX:)/, ''),
                        name: desc || '',
                        ltp: close || 0,
                        change: change || 0,
                        volume: vol || 0
                    };
                });
            const result = { source: 'live', etfs };
            usaCache.etfGainers = { data: result, time: now };
            sendJSON(res, 200, result);
        } catch (e) { sendJSON(res, 200, { error: e.message, etfs: [] }); }
        return;
    }

    // ===== USA Sector Stocks (for heatmap modal popup) =====
    if (pathname === '/api/usa/sector-stocks') {
        const sectorParam = (parsedUrl.searchParams.get('sector') || '').trim();
        if (!sectorParam) { sendJSON(res, 400, { error: 'No sector provided', stocks: [] }); return; }
        try {
            const cacheKey = `usa-sector-${sectorParam}`;
            const cached = usaCache[cacheKey];
            if (cached && (Date.now() - cached.time) < 60000) { sendJSON(res, 200, cached.data); return; }

            // TradingView uses FactSet sector classification (not GICS)
            // Map our SPDR ETF display names → TradingView sector strings (array = multiple TV sectors)
            const sectorTVMap = {
                'Technology':            ['Electronic Technology', 'Technology Services'],
                'Tech':                  ['Electronic Technology', 'Technology Services'],
                'Healthcare':            ['Health Technology', 'Health Services'],
                'Health':                ['Health Technology', 'Health Services'],
                'Financials':            ['Finance'],
                'Finance':               ['Finance'],
                'Consumer Staples':      ['Consumer Non-Durables'],
                'Staples':               ['Consumer Non-Durables'],
                'Consumer Discretionary':['Consumer Durables', 'Consumer Services', 'Retail Trade'],
                'Cons. Disc':            ['Consumer Durables', 'Consumer Services', 'Retail Trade'],
                'Energy':                ['Energy Minerals'],
                'Industrials':           ['Industrial Services', 'Producer Manufacturing', 'Transportation', 'Distribution Services', 'Commercial Services'],
                'Materials':             ['Process Industries', 'Non-Energy Minerals'],
                'Real Estate':           ['Real Estate'],
                'Utilities':             ['Utilities'],
                'Communication Services':['Communications', 'Technology Services'],
                'Comm. Svcs':            ['Communications', 'Technology Services'],
            };
            const tvSectors = sectorTVMap[sectorParam] || [sectorParam];

            // Real Estate: TradingView classifies all REITs under sector=Finance.
            // The industry filter isn't reliably supported by the scanner API.
            // Instead: query Finance sector broadly, then filter server-side to known S&P 500 REITs.
            const isRealEstate = (sectorParam === 'Real Estate');
            const SP500_REITS = new Set([
                'AMT','PLD','CCI','EQIX','SPG','O','DLR','WELL','PSA','EXR',
                'AVB','EQR','VTR','BXP','KIM','ARE','WY','IRM','ESS','VICI',
                'GLPI','UDR','CPT','NNN','FR','ELS','SUI','CUBE','REXR','HST'
            ]);
            const filterConditions = isRealEstate
                ? [
                    { left: 'sector', operation: 'in_range', right: ['Finance'] },
                    { left: 'market_cap_basic', operation: 'greater', right: 1000000000 }
                  ]
                : [
                    { left: 'sector', operation: 'in_range', right: tvSectors },
                    { left: 'market_cap_basic', operation: 'greater', right: 2000000000 }
                  ];

            const raw = await postJson('https://scanner.tradingview.com/america/scan', {
                filter: filterConditions,
                columns: ['name', 'description', 'close', 'change', 'market_cap_basic', 'volume'],
                sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
                range: [0, 100]  // wider range so we catch all REITs within Finance results
            });
            const json = JSON.parse(raw);
            const stocks = (json.data || [])
                .filter(item => {
                    const sym = (item.s || '').replace(/^(NASDAQ:|NYSE:|AMEX:)/, '');
                    if (isRealEstate) return SP500_REITS.has(sym);
                    return /^(NYSE:|NASDAQ:|AMEX:)/.test(item.s || '') && SP500_SYMBOLS.has(sym);
                })
                .map(item => {
                    const [sym, desc, close, change, mktCap, vol] = item.d;
                    return {
                        symbol: (item.s || '').replace(/^(NASDAQ:|NYSE:|AMEX:)/, ''),
                        companyName: desc || '',
                        ltp: close || 0, change: change || 0,
                        marketCap: mktCap || 0, volume: vol || 0
                    };
                });
            const result = { source: 'live', stocks };
            usaCache[cacheKey] = { data: result, time: Date.now() };
            sendJSON(res, 200, result);
        } catch (e) { sendJSON(res, 200, { error: e.message, stocks: [] }); }
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

    // ===== AUTH — Dev bypass (no email config only) =====
    if (pathname === '/auth/dev-token' && req.method === 'GET' && !emailTransporter) {
        const token = generateToken();
        sessionStore.set(token, { email: 'dev@preview.com', expiry: Date.now() + 24 * 60 * 60 * 1000 });
        sendJSON(res, 200, { token }); return;
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
                const existing = otpStore.get(email);
                if (existing && existing.expiry > Date.now() && existing.attempts >= 5) {
                    sendJSON(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' }); return;
                }
                const otp = generateOtp();
                otpStore.set(email, { otp, expiry: Date.now() + 10 * 60 * 1000, attempts: 0 });
                await sendOtpEmail(email, otp);
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
                // Dev bypass — always accept 000000 when no email is configured
                const isDev = !emailTransporter;
                if (record.otp !== String(otp).trim() && !(isDev && String(otp).trim() === '000000')) {
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
            // Redirect back to dashboard with success flag
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
