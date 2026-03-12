const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const KiteClient = require('./kite-client');

const PORT = 3000;
const ROOT = __dirname;

// ===== KITE CONNECT SETUP =====
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { console.log('⚠️  No config.json found, using defaults'); }

let kiteClient = null;
if (config.kite && config.kite.enabled && config.kite.apiKey) {
    kiteClient = new KiteClient(config.kite);
    console.log(`  🔗 Kite Connect enabled (API Key: ${config.kite.apiKey.substring(0, 6)}...)`);
    if (kiteClient.isAuthenticated()) {
        console.log('  ✅ Kite token found (valid for today)');
    } else {
        console.log('  ⚠️  Kite not authenticated — click "Login to Zerodha" on dashboard');
    }
} else {
    console.log('  ℹ️  Kite Connect disabled (set kite.enabled=true in config.json)');
}

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

// ===== UTILITY: Generic URL Fetcher =====

function fetchUrl(targetUrl) {
    return new Promise((resolve, reject) => {
        const lib = targetUrl.startsWith('https') ? https : http;
        const req = lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchUrl(res.headers.location).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
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

    const data = await fetchNSE(apiPath);
    nseCache[key] = { data, timestamp: now };
    return { data, cached: false };
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
    const { data, cached } = await getCachedNSE('allIndices', '/api/allIndices');

    // Extract NIFTY 500 advance/decline
    const nifty500 = data.data?.find(idx => idx.index === 'NIFTY 500') || {};
    const nifty50 = data.data?.find(idx => idx.index === 'NIFTY 50') || {};
    const advancing = nifty500.advances || 0;
    const declining = nifty500.declines || 0;
    const unchanged = nifty500.unchanged || 0;

    // Sentiment: Nifty 50 trend — use percentChange as proxy for 21 EMA position
    const niftyChange = parseFloat(nifty50.percentChange) || 0;
    const niftyLast = parseFloat(nifty50.last) || 0;
    const niftyOpen = parseFloat(nifty50.open) || 0;
    // Bullish if: positive change AND price above open (intraday strength)
    const niftyAbove21EMA = niftyChange > 0 && niftyLast > niftyOpen;

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
        niftyAbove21EMA,
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
        'https://news.google.com/rss/search?q=trump+tariff+india+trade+war&hl=en-IN&gl=IN&ceid=IN:en',
        'https://news.google.com/rss/search?q=trump+tariff+trade+policy+2025&hl=en&gl=US&ceid=US:en',
    ];
    let allItems = [];
    for (const feedUrl of feeds) {
        try {
            const xml = await fetchUrl(feedUrl);
            const items = parseRSSItems(xml);
            items.forEach(item => {
                const t = item.title.toLowerCase();
                if (t.includes('tariff')) item.tag = 'TARIFF';
                else if (t.includes('trade war') || t.includes('trade deal')) item.tag = 'TRADE';
                else if (t.includes('visa') || t.includes('h-1b')) item.tag = 'VISA';
                else if (t.includes('china')) item.tag = 'GEOPOLITICS';
                else if (t.includes('modi') || t.includes('diplomat')) item.tag = 'DIPLOMACY';
                else item.tag = 'POLICY';
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

    // ===== Static File Serving =====
    let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname.split('?')[0]);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2); });
            } else { res.writeHead(500); res.end('Server Error'); }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
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
    console.log(`     /api/trump-news        Trump & Trade War News`);
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
});
