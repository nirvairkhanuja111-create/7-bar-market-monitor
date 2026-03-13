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

// ===== YAHOO FINANCE DATA LAYER =====

function fetchYahooFinance(symbol, range = '3mo', interval = '1d') {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json.chart?.result?.[0];
                    if (!result) { reject(new Error('No Yahoo data')); return; }
                    resolve(result);
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

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

async function getNiftyEMAStatus() {
    const now = Date.now();
    if (emaCache.data && (now - emaCache.time) < EMA_CACHE_TTL) return emaCache.data;
    try {
        const result = await fetchYahooFinance('^NSEI', '3mo', '1d');
        const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
        if (closes.length < 50) throw new Error('Not enough data');
        const currentPrice = closes[closes.length - 1];
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);
        let status = 'no'; // below 50 EMA
        if (currentPrice > ema50) status = 'selective'; // above 50 but below 21
        if (currentPrice > ema21) status = 'yes'; // above 21 EMA
        const data = { status, currentPrice, ema21, ema50 };
        emaCache = { data, time: now };
        return data;
    } catch (e) {
        console.error('Yahoo EMA error:', e.message);
        return { status: 'no', currentPrice: 0, ema21: 0, ema50: 0 };
    }
}

let yqCache = {};
const YQ_CACHE_TTL = 120000; // 2 min

async function fetchYahooQuote(symbol) {
    const now = Date.now();
    if (yqCache[symbol] && (now - yqCache[symbol].time) < YQ_CACHE_TTL) return yqCache[symbol].data;
    try {
        const result = await fetchYahooFinance(symbol, '2d', '1d');
        const meta = result.meta || {};
        const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
        const price = meta.regularMarketPrice || closes[closes.length - 1] || 0;
        const prevClose = meta.chartPreviousClose || (closes.length >= 2 ? closes[closes.length - 2] : price);
        const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
        const data = { price, prevClose, change };
        yqCache[symbol] = { data, time: now };
        return data;
    } catch (e) {
        console.error(`Yahoo quote error for ${symbol}:`, e.message);
        return { price: 0, prevClose: 0, change: 0 };
    }
}

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

let newsCache = { market: null, trump: null, usa: null, marketTime: 0, trumpTime: 0, usaTime: 0 };
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

async function getUSANews() {
    const now = Date.now();
    if (newsCache.usa && (now - newsCache.usaTime) < NEWS_CACHE_TTL) return newsCache.usa;
    const feeds = [
        'https://news.google.com/rss/search?q=US+stock+market+S%26P+500+nasdaq+today&hl=en&gl=US&ceid=US:en',
        'https://news.google.com/rss/search?q=Federal+Reserve+Fed+rate+inflation+economy&hl=en&gl=US&ceid=US:en',
    ];
    let allItems = [];
    for (const feedUrl of feeds) {
        try {
            const xml = await fetchUrl(feedUrl);
            const items = parseRSSItems(xml);
            items.forEach(item => {
                const t = item.title.toLowerCase();
                if (t.includes('fed') || t.includes('federal reserve') || t.includes('rate cut') || t.includes('rate hike')) item.tag = 'FED';
                else if (t.includes('s&p') || t.includes('dow') || t.includes('nasdaq') || t.includes('russell')) item.tag = 'INDEX';
                else if (t.includes('earnings') || t.includes('profit') || t.includes('revenue') || t.includes('eps')) item.tag = 'EARNINGS';
                else if (t.includes('inflation') || t.includes('cpi') || t.includes('gdp') || t.includes('jobs')) item.tag = 'MACRO';
                else if (t.includes('tech') || t.includes('ai') || t.includes('nvidia') || t.includes('apple')) item.tag = 'TECH';
                else item.tag = 'US MARKETS';
            });
            allItems = allItems.concat(items);
        } catch (e) { console.log('USA news feed error:', e.message); }
    }
    const seen = new Set();
    const unique = allItems.filter(item => { const key = item.title.substring(0, 50).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
    unique.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const result = { items: unique.slice(0, 10) };
    newsCache.usa = result; newsCache.usaTime = now;
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

            // Gold & USDINR from Yahoo Finance
            try {
                const [goldData, usdinrData] = await Promise.all([
                    fetchYahooQuote('GC=F'),
                    fetchYahooQuote('USDINR=X'),
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

            // If not in Nifty 500, fetch individual stock from NSE quote API
            if (!stock) {
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
                } catch (e) { /* individual quote failed */ }
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
                    ? 'Closing in upper half of range — buyers in control'
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
            if (distFrom52WH <= 10 && aboveLow >= 50) stage = 'Stage 2 — Advancing (BUY zone)';
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
                    ? 'Stock is in the ideal buying stage per Stan Weinstein'
                    : stage.includes('Stage 1') ? 'Building a base — not ready yet, add to watchlist' : 'Not in buying zone — Minervini only buys Stage 2 stocks',
                weight: isStage2 ? 15 : (stage.includes('Stage 1') ? 5 : 0),
            });
            score += checks[checks.length - 1].weight;

            // Overall verdict
            let verdict, verdictClass;
            if (score >= 70) { verdict = 'STRONG BUY CANDIDATE'; verdictClass = 'strong-buy'; }
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

    // ===== MBI (Market Breadth Index) from Google Sheet =====
    if (pathname === '/api/mbi-data') {
        try {
            const sheetUrl = 'https://docs.google.com/spreadsheets/d/1SkXCX1Ax3n_EUsa06rzqWSdoCrlbGDENuFUOrMFyErw/gviz/tq?tqx=out:csv&sheet=MBI%20mini';
            const csv = await fetchUrl(sheetUrl);
            // Parse CSV — columns: Date, EM, 52WL, 52WH, 4.5r, YEAR
            const lines = csv.trim().split('\n').filter(l => l.trim());
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
                if (vals.length >= 6 && vals[0]) {
                    const em = parseFloat(vals[1]);
                    rows.push({
                        date: vals[0],
                        em: isNaN(em) ? 0 : em,
                        wl52: parseFloat(vals[2]) || 0,
                        wh52: parseFloat(vals[3]) || 0,
                        r45: parseFloat(vals[4]) || 0,
                        year: vals[5],
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
});
