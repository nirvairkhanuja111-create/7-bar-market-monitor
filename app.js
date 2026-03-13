// ========================================================
// 7 BAR MARKET MONITOR v2.1 — Live NSE + TradingView
// ========================================================

// ===== TRADER QUOTES (50+) =====
const TRADER_QUOTES = [
    { text: "Superperformance stocks tend to consolidate in a specific way before they make their big move.", author: "Mark Minervini" },
    { text: "The key to trading success is emotional discipline. Making money has nothing to do with intelligence.", author: "Mark Minervini" },
    { text: "A pivot point is where a stock transitions from a consolidation to a new advance — that's where the magic is.", author: "Mark Minervini" },
    { text: "In every cycle, leaders emerge. Find them early and ride them hard.", author: "Mark Minervini" },
    { text: "I risk only a small amount on each trade. The secret is keeping losses small.", author: "Mark Minervini" },
    { text: "You can't control the market, but you can control your risk, your entries, and your exits.", author: "Mark Minervini" },
    { text: "Specific entry points, tight stops, and position sizing — that's how you build a track record.", author: "Mark Minervini" },
    { text: "Volatility contraction patterns precede explosive moves. Learn to spot them.", author: "Mark Minervini" },
    { text: "What seems too high and risky to the majority generally goes higher, and what seems low and cheap generally goes lower.", author: "William O'Neil" },
    { text: "Losses are part of the game. But big losses are unacceptable — always protect your capital.", author: "William O'Neil" },
    { text: "The biggest mistake traders make is trying to pick bottoms and tops.", author: "William O'Neil" },
    { text: "The whole secret to winning in the stock market is to lose the least amount possible when you're not right.", author: "William O'Neil" },
    { text: "90% of people in the stock market — pros and amateurs alike — simply haven't done enough homework.", author: "William O'Neil" },
    { text: "Buy stocks that are going up. When they stop going up, sell them.", author: "William O'Neil" },
    { text: "Three out of four stocks follow the general market trend. Trade in the direction of the market.", author: "William O'Neil" },
    { text: "I only buy stocks when I can find a precise setup. I never let the market come to me — I go to the market.", author: "Nicolas Darvas" },
    { text: "I never buy during a decline. I buy when the stock is going up, showing strength.", author: "Nicolas Darvas" },
    { text: "I keep a wall around my portfolio — a wall of stop losses.", author: "Nicolas Darvas" },
    { text: "I was never ashamed of losing. I was ashamed of not cutting losses short.", author: "Nicolas Darvas" },
    { text: "The stock doesn't know you own it. It does what it wants to do.", author: "Nicolas Darvas" },
    { text: "I developed my box theory: a stock moves within a series of frames or boxes.", author: "Nicolas Darvas" },
    { text: "I absolutely believe that price movement patterns are being repeated.", author: "Dan Zanger" },
    { text: "Trade what you see, not what you think. The market doesn't care about your opinion.", author: "Dan Zanger" },
    { text: "Charts don't lie. People do.", author: "Dan Zanger" },
    { text: "Volume is the fuel that drives stock prices. Without it, nothing moves.", author: "Dan Zanger" },
    { text: "The biggest winners come from breakouts of sound chart patterns with explosive volume.", author: "Dan Zanger" },
    { text: "When a stock breaks out of a bull flag on volume, you better be ready to pull the trigger.", author: "Dan Zanger" },
    { text: "Time is more important than price. When the time is right, the price will take care of itself.", author: "Jesse Livermore" },
    { text: "The market will tell you what to do if you listen.", author: "Jesse Livermore" },
    { text: "Cut your losses short and let your winners run.", author: "Jesse Livermore" },
    { text: "There is nothing new in Wall Street. Whatever happens today has happened before and will happen again.", author: "Jesse Livermore" },
    { text: "It never was my thinking that made big money. It was my sitting. My sitting tight.", author: "Jesse Livermore" },
    { text: "The trend is your friend until the end when it bends.", author: "Ed Seykota" },
    { text: "If you can't take a small loss, sooner or later you will take the mother of all losses.", author: "Ed Seykota" },
    { text: "Win or lose, everybody gets what they want from the market.", author: "Ed Seykota" },
    { text: "The elements of good trading are: cutting losses, cutting losses, and cutting losses.", author: "Ed Seykota" },
    { text: "The secret to being successful from a trading perspective is to have an indefatigable thirst for knowledge.", author: "Paul Tudor Jones" },
    { text: "Don't focus on making money; focus on protecting what you have.", author: "Paul Tudor Jones" },
    { text: "Never buy a stock in Stage 4 decline, no matter how cheap it seems.", author: "Stan Weinstein" },
    { text: "The best time to buy is when a stock breaks out of a Stage 1 base into Stage 2.", author: "Stan Weinstein" },
    { text: "Volume is the steam that makes the choo-choo go.", author: "Stan Weinstein" },
    { text: "The stock market is a device for transferring money from the impatient to the patient.", author: "Warren Buffett" },
    { text: "Risk comes from not knowing what you're doing.", author: "Warren Buffett" },
    { text: "Be fearful when others are greedy, and greedy when others are fearful.", author: "Warren Buffett" },
    { text: "I made my fortune by selling too soon.", author: "Bernard Baruch" },
    { text: "Markets can remain irrational longer than you can remain solvent.", author: "John Maynard Keynes" },
    { text: "The four most dangerous words in investing are: 'This time it's different.'", author: "Sir John Templeton" },
    { text: "In the short run, the market is a voting machine, but in the long run, it is a weighing machine.", author: "Benjamin Graham" },
];

// ===== FALLBACK DATA (used when NSE is unreachable) =====
const NIFTY_SECTORS = [
    { name: "IT", fullName: "Nifty IT" }, { name: "Bank", fullName: "Nifty Bank" },
    { name: "Pharma", fullName: "Nifty Pharma" }, { name: "Auto", fullName: "Nifty Auto" },
    { name: "FMCG", fullName: "Nifty FMCG" }, { name: "Metal", fullName: "Nifty Metal" },
    { name: "Realty", fullName: "Nifty Realty" }, { name: "Energy", fullName: "Nifty Energy" },
    { name: "Infra", fullName: "Nifty Infra" }, { name: "PSU Bank", fullName: "Nifty PSU Bank" },
    { name: "Media", fullName: "Nifty Media" }, { name: "FinServ", fullName: "Nifty Financial Services" },
];

function fallbackMarketData() {
    const advancing = Math.floor(180 + Math.random() * 200);
    return {
        source: 'fallback', advancing, declining: 500 - advancing, unchanged: Math.floor(Math.random() * 30),
        niftyAbove21EMA: Math.random() > 0.4,
        sectors: NIFTY_SECTORS.map(s => ({ ...s, change: (Math.random() - 0.4) * 4 })).sort((a, b) => b.change - a.change),
    };
}

function fallbackStocks(type) {
    const gainers = [
        { symbol: "TATAELXSI", name: "Tata Elxsi", ltp: 7285.50, change: 8.45 },
        { symbol: "ADANIENT", name: "Adani Enterprises", ltp: 2950.75, change: 6.32 },
        { symbol: "POLYCAB", name: "Polycab India", ltp: 5480.00, change: 5.87 },
        { symbol: "LTIM", name: "LTIMindtree", ltp: 5890.25, change: 5.21 },
        { symbol: "PAYTM", name: "One97 Communications", ltp: 890.40, change: 4.95 },
        { symbol: "TRENT", name: "Trent Ltd", ltp: 6850.25, change: 4.72 },
        { symbol: "SUZLON", name: "Suzlon Energy", ltp: 58.75, change: 4.55 },
        { symbol: "CUMMINSIND", name: "Cummins India", ltp: 3580.00, change: 4.12 },
        { symbol: "PERSISTENT", name: "Persistent Systems", ltp: 5890.50, change: 3.98 },
        { symbol: "COFORGE", name: "Coforge Ltd", ltp: 6120.80, change: 3.75 },
    ];
    const losers = [
        { symbol: "INDUSINDBK", name: "IndusInd Bank", ltp: 1085.30, change: -5.82 },
        { symbol: "TATAMOTORS", name: "Tata Motors", ltp: 625.40, change: -4.95 },
        { symbol: "HINDALCO", name: "Hindalco Industries", ltp: 520.75, change: -4.21 },
        { symbol: "JSWSTEEL", name: "JSW Steel", ltp: 825.60, change: -3.87 },
        { symbol: "VEDL", name: "Vedanta Ltd", ltp: 428.90, change: -3.65 },
        { symbol: "TATASTEEL", name: "Tata Steel", ltp: 128.45, change: -3.42 },
        { symbol: "BANKBARODA", name: "Bank of Baroda", ltp: 245.80, change: -3.18 },
        { symbol: "PNB", name: "Punjab National Bank", ltp: 108.25, change: -2.95 },
        { symbol: "SAIL", name: "Steel Authority", ltp: 112.60, change: -2.78 },
        { symbol: "NMDC", name: "NMDC Ltd", ltp: 225.40, change: -2.55 },
    ];
    const sevenBar = [
        { symbol: "TRENT", name: "Trent Ltd", ltp: 6850.25, ath: 6920.00, distFromATH: 1.01, dayChange: "2.35" },
        { symbol: "ZOMATO", name: "Zomato Ltd", ltp: 275.80, ath: 282.50, distFromATH: 2.37, dayChange: "1.10" },
        { symbol: "DIXON", name: "Dixon Technologies", ltp: 12450.00, ath: 12680.00, distFromATH: 1.81, dayChange: "0.85" },
        { symbol: "PERSISTENT", name: "Persistent Systems", ltp: 5890.50, ath: 5950.00, distFromATH: 1.00, dayChange: "1.50" },
        { symbol: "KAYNES", name: "Kaynes Technology", ltp: 4820.30, ath: 4900.00, distFromATH: 1.63, dayChange: "0.42" },
    ];
    if (type === 'gainers') return { source: 'fallback', stocks: gainers };
    if (type === 'losers') return { source: 'fallback', stocks: losers };
    return { source: 'fallback', stocks: sevenBar };
}

// ===== API FETCH WITH FALLBACK =====
async function fetchAPI(url, fallbackFn, timeoutMs = 10000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data;
    } catch (e) {
        console.warn(`API fetch failed for ${url}:`, e.message);
        return fallbackFn();
    }
}

// ===== SHIMMER LOADING HTML =====
function shimmerRows(count = 5) {
    return Array.from({ length: count }, () => `
        <div class="shimmer-row">
            <div class="shimmer-rank shimmer-pulse"></div>
            <div class="shimmer-info">
                <div class="shimmer-name shimmer-pulse"></div>
                <div class="shimmer-sub shimmer-pulse"></div>
            </div>
            <div class="shimmer-price">
                <div class="shimmer-num shimmer-pulse"></div>
                <div class="shimmer-pct shimmer-pulse"></div>
            </div>
        </div>
    `).join('');
}

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
    initQuotes();
    initClock();
    initMarketStatus();
    initAllTradingViewWidgets();
    initWatchlistTabs();
    initSidebarTabs();

    // Show shimmer loading in stock lists
    showShimmerLoading();

    // Check Kite Connect status
    checkKiteStatus();

    // Check for Kite login success redirect
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('kite') === 'success') {
        // Clean URL and refresh Kite status
        window.history.replaceState({}, document.title, '/');
        checkKiteStatus();
    }

    // Load all data in parallel
    loadAllData();

    // Auto-refresh
    setInterval(loadAllData, 60000);
    setInterval(rotateQuote, 20000);
    setInterval(checkKiteStatus, 30000); // Check kite status every 30s
});

function showShimmerLoading() {
    ['sevenBarList', 'gainersList', 'losersList'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = shimmerRows(6);
    });
}

async function loadAllData() {
    // Fire all fetches in parallel
    await Promise.all([
        loadMarketData(),
        loadStockColumns(),
        fetchLiveNews(),
    ]);

    document.getElementById("lastUpdated").textContent = new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
}

// ===== MARKET DATA (Advance/Decline, Sentiment, Sector Heatmap) =====
async function loadMarketData() {
    const data = await fetchAPI('/api/market-data', fallbackMarketData);
    const source = data.source || 'live';

    // Advance / Decline
    const total = data.advancing + data.declining;
    document.getElementById("advCount").textContent = data.advancing;
    document.getElementById("decCount").textContent = data.declining;
    if (total > 0) {
        document.getElementById("advBar").style.width = `${(data.advancing / total * 100).toFixed(1)}%`;
        document.getElementById("decBar").style.width = `${(data.declining / total * 100).toFixed(1)}%`;
    }
    document.getElementById("advDecRatio").textContent = `Ratio: ${data.declining > 0 ? (data.advancing / data.declining).toFixed(2) : '--'} | Unch: ${data.unchanged || 0}`;

    // Update source badge
    updateSourceBadge('advDecSource', source);

    // Sentiment
    const sentIcon = document.getElementById("sentimentIcon");
    const sentText = document.getElementById("sentimentText");
    const sentDetail = document.getElementById("sentimentDetail");
    const sentCard = document.getElementById("sentimentCard");

    if (data.niftyAbove21EMA) {
        sentIcon.className = "sentiment-icon bullish";
        sentText.textContent = "YES — BULLISH";
        sentText.className = "sentiment-text bullish";
        sentDetail.textContent = source === 'live'
            ? `Nifty ${data.niftyChange ? (data.niftyChange > 0 ? '+' : '') + data.niftyChange.toFixed(2) + '%' : ''} | Trend Positive`
            : "Nifty ABOVE 21 EMA | Breakouts favored";
        sentCard.style.borderColor = "rgba(0, 230, 118, 0.3)";
    } else {
        sentIcon.className = "sentiment-icon bearish";
        sentText.textContent = "NO — BEARISH";
        sentText.className = "sentiment-text bearish";
        sentDetail.textContent = source === 'live'
            ? `Nifty ${data.niftyChange ? (data.niftyChange > 0 ? '+' : '') + data.niftyChange.toFixed(2) + '%' : ''} | Trend Negative`
            : "Nifty BELOW 21 EMA | Breakouts likely to fail";
        sentCard.style.borderColor = "rgba(255, 82, 82, 0.3)";
    }
    updateSourceBadge('sentimentSource', source);

    // Sector heatmap
    if (data.sectors && data.sectors.length > 0) {
        renderSectorHeatmap(data.sectors);
    }
}

// ===== STOCK COLUMNS =====
async function loadStockColumns() {
    // Fetch all three in parallel
    const [sevenBarData, gainersData, losersData] = await Promise.all([
        fetchAPI('/api/seven-bar-stocks', () => fallbackStocks('sevenBar')),
        fetchAPI('/api/gainers', () => fallbackStocks('gainers')),
        fetchAPI('/api/losers', () => fallbackStocks('losers')),
    ]);

    renderSevenBarList(sevenBarData.stocks || [], sevenBarData.source);
    renderGainersList(gainersData.stocks || [], gainersData.source);
    renderLosersList(losersData.stocks || [], losersData.source);
}

function renderSevenBarList(stocks, source) {
    const container = document.getElementById("sevenBarList");
    if (!stocks.length) { container.innerHTML = '<div class="no-data">No stocks near ATH right now</div>'; return; }
    container.innerHTML = stocks.map((s, i) => `
        <div class="stock-item">
            <span class="stock-rank">${i + 1}</span>
            <div class="stock-info">
                <div class="stock-name">${s.symbol}</div>
                <div class="stock-fullname">${s.name}</div>
            </div>
            <div class="stock-price">
                <div class="stock-ltp">\u20B9${formatNumber(s.ltp)}</div>
                <div class="stock-pct near-ath">${s.distFromATH}% from ATH</div>
                <div class="ath-distance-bar"><div class="ath-distance-fill" style="width:${Math.max(5, 100 - s.distFromATH * 20)}%"></div></div>
            </div>
        </div>
    `).join("");
    updateSourceBadge('sevenBarSource', source);
}

function renderGainersList(stocks, source) {
    const container = document.getElementById("gainersList");
    if (!stocks.length) { container.innerHTML = '<div class="no-data">No data available</div>'; return; }
    container.innerHTML = stocks.map((s, i) => `
        <div class="stock-item">
            <span class="stock-rank">${i + 1}</span>
            <div class="stock-info">
                <div class="stock-name">${s.symbol}</div>
                <div class="stock-fullname">${s.name}</div>
            </div>
            <div class="stock-price">
                <div class="stock-ltp">\u20B9${formatNumber(s.ltp)}</div>
                <div class="stock-pct positive">+${parseFloat(s.change).toFixed(2)}%</div>
            </div>
        </div>
    `).join("");
    updateSourceBadge('gainersSource', source);
}

function renderLosersList(stocks, source) {
    const container = document.getElementById("losersList");
    if (!stocks.length) { container.innerHTML = '<div class="no-data">No data available</div>'; return; }
    container.innerHTML = stocks.map((s, i) => `
        <div class="stock-item">
            <span class="stock-rank">${i + 1}</span>
            <div class="stock-info">
                <div class="stock-name">${s.symbol}</div>
                <div class="stock-fullname">${s.name}</div>
            </div>
            <div class="stock-price">
                <div class="stock-ltp">\u20B9${formatNumber(s.ltp)}</div>
                <div class="stock-pct negative">${parseFloat(s.change).toFixed(2)}%</div>
            </div>
        </div>
    `).join("");
    updateSourceBadge('losersSource', source);
}

// ===== SOURCE BADGES =====
function updateSourceBadge(id, source) {
    const el = document.getElementById(id);
    if (!el) return;
    if (source === 'live') {
        el.className = 'source-badge live';
        el.innerHTML = '<span class="source-dot"></span> LIVE';
    } else if (source === 'cached') {
        el.className = 'source-badge cached';
        el.innerHTML = '<span class="source-dot"></span> CACHED';
    } else {
        el.className = 'source-badge offline';
        el.innerHTML = '<span class="source-dot"></span> OFFLINE';
    }
}

// ===== LIVE NEWS FETCHING =====
async function fetchLiveNews() {
    try {
        const newsRes = await fetch('/api/news');
        if (newsRes.ok) {
            const newsData = await newsRes.json();
            renderNewsList('marketNewsList', newsData.items || [], 'market');
        }
    } catch (e) { renderFallbackMarketNews(); }

    try {
        const trumpRes = await fetch('/api/trump-news');
        if (trumpRes.ok) {
            const trumpData = await trumpRes.json();
            renderNewsList('trumpNewsList', trumpData.items || [], 'trump');
        }
    } catch (e) { renderFallbackTrumpNews(); }
}

function renderNewsList(containerId, items, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!items.length) { if (type === 'market') renderFallbackMarketNews(); else renderFallbackTrumpNews(); return; }
    container.innerHTML = items.slice(0, 8).map((item, i) => `
        <a href="${item.link || '#'}" target="_blank" rel="noopener" class="news-item">
            <div class="news-item-header">
                <span class="news-number">${i + 1}</span>
                <span class="news-title">${escapeHtml(item.title)}</span>
            </div>
            <div class="news-meta">
                <span class="news-source">${escapeHtml(item.source || 'News')}</span>
                <span class="news-time">${item.timeAgo || ''}</span>
                ${item.tag ? `<span class="news-tag">${item.tag}</span>` : ''}
            </div>
        </a>
    `).join("");
}

function renderFallbackMarketNews() {
    renderNewsList('marketNewsList', [
        { title: "Indian market update: Nifty 50 and Sensex latest", source: "ET", timeAgo: "Live", tag: "MARKET" },
        { title: "FIIs turn net sellers; DIIs provide support", source: "Moneycontrol", timeAgo: "Today", tag: "FII/DII" },
        { title: "RBI monetary policy impact on banking stocks", source: "LiveMint", timeAgo: "Today", tag: "RBI" },
    ], 'fallback');
}

function renderFallbackTrumpNews() {
    renderNewsList('trumpNewsList', [
        { title: "Trump tariff impact on Indian goods", source: "Reuters", timeAgo: "Recent", tag: "TARIFF" },
        { title: "India-US trade talks: tariff exemptions", source: "Bloomberg", timeAgo: "Recent", tag: "TRADE" },
    ], 'fallback');
}

function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }

// ===== QUOTES =====
let currentQuoteIndex = 0;

function initQuotes() {
    for (let i = TRADER_QUOTES.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [TRADER_QUOTES[i], TRADER_QUOTES[j]] = [TRADER_QUOTES[j], TRADER_QUOTES[i]];
    }
    currentQuoteIndex = 0;
    displayQuote();
}

function rotateQuote() {
    const quoteBox = document.getElementById("quoteBox");
    quoteBox.style.opacity = "0";
    quoteBox.style.transform = "translateY(5px)";
    setTimeout(() => {
        currentQuoteIndex = (currentQuoteIndex + 1) % TRADER_QUOTES.length;
        displayQuote();
        quoteBox.style.opacity = "1";
        quoteBox.style.transform = "translateY(0)";
    }, 400);
}

function displayQuote() {
    const q = TRADER_QUOTES[currentQuoteIndex];
    document.getElementById("quoteText").textContent = q.text;
    document.getElementById("quoteAuthor").textContent = `\u2014 ${q.author}`;
}

// ===== CLOCK & MARKET STATUS =====
function initClock() { updateClock(); setInterval(updateClock, 1000); }

function updateClock() {
    document.getElementById("headerTime").textContent = new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }) + " IST";
}

function initMarketStatus() { updateMarketStatus(); setInterval(updateMarketStatus, 30000); }

function updateMarketStatus() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hour = ist.getHours(), min = ist.getMinutes(), day = ist.getDay();
    const timeNum = hour * 100 + min;
    const isOpen = day >= 1 && day <= 5 && timeNum >= 915 && timeNum <= 1530;
    const statusEl = document.getElementById("marketStatus");
    const textEl = statusEl.querySelector(".status-text");
    if (isOpen) { statusEl.classList.add("open"); textEl.textContent = "MARKET OPEN"; }
    else { statusEl.classList.remove("open"); textEl.textContent = day >= 1 && day <= 5 && timeNum >= 900 && timeNum < 915 ? "PRE-MARKET" : "MARKET CLOSED"; }
}

// ===== KITE TICKER (marquee) =====
async function initKiteTicker() {
    const container = document.getElementById('kite-ticker');
    if (!container) return;

    const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFC', 'WIPRO', 'LT', 'ASIANPAINT', 'MARUTI', 'HCLTECH', 'BAJAJFINSV'];

    try {
        const response = await fetch(`/api/kite/quote?symbols=${symbols.join(',')}`);
        if (!response.ok) throw new Error('Failed to fetch Kite quotes');
        const data = await response.json();

        let html = '<div class="kite-ticker-strip">';
        (data.quotes || []).forEach(quote => {
            const change = quote.change || 0;
            const changeClass = change >= 0 ? 'positive' : 'negative';
            html += `
                <div class="kite-ticker-item">
                    <span class="kite-ticker-symbol">${quote.symbol}</span>
                    <span class="kite-ticker-price">₹${quote.ltp || 0}</span>
                    <span class="kite-ticker-change ${changeClass}">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } catch (e) {
        console.warn('Kite ticker failed:', e.message);
        container.innerHTML = '<div class="ticker-placeholder">Loading Kite ticker...</div>';
    }
}

// ===== ALL TRADINGVIEW WIDGETS =====
function initAllTradingViewWidgets() {
    // 1. KITE TICKER (replaces TradingView ticker tape)
    initKiteTicker();

    // 2. KPI TICKERS
    injectTVWidget("tv-kpi-tickers", "embed-widget-tickers", {
        symbols: [
            { proName: "NSE:NIFTY", title: "NIFTY 50" }, { proName: "NSE:BANKNIFTY", title: "BANK NIFTY" },
            { proName: "BSE:SENSEX", title: "SENSEX" }, { proName: "NSE:CNXSMALLCAP", title: "SMALLCAP" },
            { proName: "TVC:GOLD", title: "GOLD" }, { proName: "FX_IDC:USDINR", title: "USD/INR" },
            { proName: "NYMEX:CL1!", title: "CRUDE OIL" }, { proName: "TVC:DXY", title: "DXY" },
        ],
        isTransparent: true, showSymbolLogo: true, colorTheme: "dark", locale: "en",
    });

    // 3. MAIN CHART
    injectTVWidget("tv-main-chart", "embed-widget-advanced-chart", {
        autosize: true, symbol: "BSE:SENSEX", interval: "D", timezone: "Asia/Kolkata",
        theme: "dark", style: "1", locale: "en", withdateranges: true, hide_side_toolbar: false,
        allow_symbol_change: true, details: true, hotlist: true, calendar: false,
        studies: ["STD;EMA"], show_popup_button: true, popup_width: "1000", popup_height: "650",
        support_host: "https://www.tradingview.com",
    });

    // 4. GLOBAL INDICES SIDEBAR
    injectTVWidget("tv-global-indices", "embed-widget-market-overview", {
        colorTheme: "dark", dateRange: "1D", showChart: true, locale: "en",
        width: "100%", height: "100%", largeChartUrl: "", isTransparent: true,
        showSymbolLogo: true, showFloatingTooltip: true,
        plotLineColorGrowing: "rgba(0, 230, 118, 1)", plotLineColorFalling: "rgba(255, 82, 82, 1)",
        gridLineColor: "rgba(42, 46, 57, 0)", scaleFontColor: "rgba(209, 212, 220, 1)",
        belowLineFillColorGrowing: "rgba(0, 230, 118, 0.05)", belowLineFillColorFalling: "rgba(255, 82, 82, 0.05)",
        belowLineFillColorGrowingBottom: "rgba(0, 230, 118, 0)", belowLineFillColorFallingBottom: "rgba(255, 82, 82, 0)",
        symbolActiveColor: "rgba(0, 230, 118, 0.12)",
        tabs: [
            { title: "Americas", symbols: [{ s: "SP:SPX", d: "S&P 500" }, { s: "NASDAQ:NDX", d: "NASDAQ 100" }, { s: "DJ:DJI", d: "Dow Jones" }, { s: "TVC:RUT", d: "Russell 2000" }], originalTitle: "Americas" },
            { title: "Europe", symbols: [{ s: "XETR:DAX", d: "DAX" }, { s: "FTSE:UKX", d: "FTSE 100" }, { s: "EURONEXT:PX1", d: "CAC 40" }], originalTitle: "Europe" },
            { title: "Asia", symbols: [{ s: "BSE:SENSEX", d: "SENSEX" }, { s: "NSE:NIFTY", d: "NIFTY 50" }, { s: "TVC:NI225", d: "Nikkei 225" }, { s: "HSI:HSI", d: "Hang Seng" }, { s: "SSE:000001", d: "Shanghai Comp" }], originalTitle: "Asia" },
        ],
    });

    // 5. COMMODITIES WATCHLIST
    injectTVWidget("tv-commodities-widget", "embed-widget-market-overview", {
        colorTheme: "dark", dateRange: "1D", showChart: true, locale: "en", width: "100%", height: "100%",
        largeChartUrl: "", isTransparent: true, showSymbolLogo: true, showFloatingTooltip: true,
        plotLineColorGrowing: "rgba(0, 230, 118, 1)", plotLineColorFalling: "rgba(255, 82, 82, 1)",
        gridLineColor: "rgba(42, 46, 57, 0)", scaleFontColor: "rgba(209, 212, 220, 1)",
        belowLineFillColorGrowing: "rgba(0, 230, 118, 0.05)", belowLineFillColorFalling: "rgba(255, 82, 82, 0.05)",
        belowLineFillColorGrowingBottom: "rgba(0, 230, 118, 0)", belowLineFillColorFallingBottom: "rgba(255, 82, 82, 0)",
        symbolActiveColor: "rgba(0, 230, 118, 0.12)",
        tabs: [{ title: "Commodities", symbols: [
            { s: "TVC:GOLD", d: "Gold" }, { s: "TVC:SILVER", d: "Silver" }, { s: "NYMEX:CL1!", d: "Crude Oil WTI" },
            { s: "NYMEX:NG1!", d: "Natural Gas" }, { s: "MCX:GOLD1!", d: "MCX Gold" }, { s: "MCX:SILVER1!", d: "MCX Silver" },
            { s: "MCX:CRUDEOIL1!", d: "MCX Crude" }, { s: "MCX:NATURALGAS1!", d: "MCX NatGas" },
            { s: "MCX:COPPER1!", d: "MCX Copper" }, { s: "COMEX:HG1!", d: "Copper (COMEX)" },
            { s: "CBOT:ZW1!", d: "Wheat" }, { s: "CBOT:ZC1!", d: "Corn" },
        ], originalTitle: "Commodities" }],
    });


    // 7. ECONOMIC CALENDAR
    injectTVWidget("tv-eco-calendar", "embed-widget-events", {
        colorTheme: "dark", isTransparent: true, width: "100%", height: "100%", locale: "en",
        importanceFilter: "-1,0,1", countryFilter: "in,us,cn,eu,jp,gb",
    });

    // 8. GLOBAL STOCK HEATMAP
    injectTVWidget("tv-global-heatmap", "embed-widget-stock-heatmap", {
        exchanges: [], dataSource: "SPX500", grouping: "sector", blockSize: "market_cap_basic",
        blockColor: "change", locale: "en", symbolUrl: "", colorTheme: "dark", hasTopBar: true,
        isDataSetEnabled: true, isZoomEnabled: true, hasSymbolTooltip: true, isMonoSize: false,
        width: "100%", height: "100%",
    });
}

// ===== TRADINGVIEW WIDGET INJECTOR =====
function injectTVWidget(containerId, widgetName, config) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const wrapper = document.createElement("div");
    wrapper.className = "tradingview-widget-container";
    wrapper.style.height = "100%"; wrapper.style.width = "100%";
    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    widgetDiv.style.height = "calc(100% - 32px)"; widgetDiv.style.width = "100%";
    const script = document.createElement("script");
    script.type = "text/javascript"; script.async = true;
    script.src = `https://s3.tradingview.com/external-embedding/${widgetName}.js`;
    script.textContent = JSON.stringify(config);
    wrapper.appendChild(widgetDiv); wrapper.appendChild(script);
    container.innerHTML = ""; container.appendChild(wrapper);
}

// ===== WATCHLIST TABS (removed - watchlist section deleted) =====
function initWatchlistTabs() {
    // Removed as watchlist section no longer exists
}

// ===== SIDEBAR WATCHLIST TABS =====
function initSidebarTabs() {
    const tabs = document.querySelectorAll(".sidebar-tab");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            const target = tab.getAttribute("data-tab");
            document.querySelectorAll(".sidebar-panel").forEach(p => p.classList.remove("active"));
            document.getElementById(`${target}-panel`).classList.add("active");
        });
    });
}

// ===== CUSTOM SECTOR HEATMAP =====
function renderSectorHeatmap(sectors) {
    const container = document.getElementById("customHeatmap");
    if (!container) return;
    container.innerHTML = sectors.map(s => {
        const change = s.change;
        const intensity = Math.min(Math.abs(change) / 4, 1);
        let bg;
        if (change >= 0) { bg = `rgb(${Math.round(10 - 10 * intensity)}, ${Math.round(40 + 120 * intensity)}, ${Math.round(30 + 30 * intensity)})`; }
        else { bg = `rgb(${Math.round(40 + 140 * intensity)}, ${Math.round(20 + 10 * intensity)}, ${Math.round(20 + 10 * intensity)})`; }
        return `
            <div class="heatmap-cell" style="background:${bg}; border-color: ${change >= 0 ? 'rgba(0,230,118,0.15)' : 'rgba(255,82,82,0.15)'}">
                <div class="heatmap-cell-name">${s.name}</div>
                <div class="heatmap-cell-change">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</div>
                <div class="heatmap-cell-fullname">${s.fullName}</div>
            </div>
        `;
    }).join('');
}

// ===== KITE CONNECT STATUS =====
async function checkKiteStatus() {
    try {
        const res = await fetch('/api/kite/status');
        if (!res.ok) return;
        const data = await res.json();
        const btn = document.getElementById('kiteLoginBtn');
        const text = document.getElementById('kiteStatusText');
        if (!btn || !text) return;

        if (!data.enabled) {
            btn.style.display = 'none';
            return;
        }

        btn.style.display = 'inline-flex';
        if (data.authenticated) {
            btn.classList.add('connected');
            btn.href = '#';
            text.textContent = 'Zerodha Connected';
            btn.querySelector('i').className = 'fas fa-check-circle';
        } else {
            btn.classList.remove('connected');
            btn.href = '/auth/kite';
            text.textContent = 'Login to Zerodha';
            btn.querySelector('i').className = 'fas fa-plug';
        }
    } catch (e) {
        // Silently fail — Kite status is not critical
    }
}

// ===== UTILS =====
function formatNumber(num) {
    const n = parseFloat(num);
    if (isNaN(n)) return num;
    return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
