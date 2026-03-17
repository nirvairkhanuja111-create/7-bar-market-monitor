# 7 Bar Market Monitor — Full Technical Reference

> AI Agent Prompt: This document is a complete technical reference for the 7 Bar Market Monitor codebase. Use it to understand all data flows, APIs, UI components, and architecture before making any changes. Every file, route, function, and data source is documented here.

---

## Project Overview

**Name:** 7 Bar Market Monitor v2.1
**Purpose:** Real-time Indian stock market intelligence dashboard for public use
**Audience:** Indian retail traders using Minervini/O'Neil growth investing methodology
**Stack:** Pure Node.js (no frameworks) + Vanilla JS frontend
**Hosting:** Render (free tier) at `https://seven-bar-market-monitor.onrender.com`
**GitHub:** `https://github.com/nirvairkhanuja111-create/7-bar-market-monitor`
**Active Branch:** `market-breadth-ema-fix` (PR #2 open → merges to `master`)

---

## File Structure

```
/
├── server.js              # Core backend — all API routes, data fetching, HTTP server
├── app.js                 # Frontend JS — all UI rendering, data display, auto-refresh
├── index.html             # Single-page HTML skeleton
├── styles.css             # All CSS — dark theme, component styles
├── kite-client.js         # Zerodha Kite Connect API client class
├── nifty500-symbols.json  # Cached list of 500 NSE stock symbols (auto-updated)
├── Dockerfile             # For Fly.io Chennai deployment (Indian IP, NSE-friendly)
├── config.json            # LOCAL ONLY — gitignored — Kite API credentials
├── .kite-token.json       # LOCAL ONLY — gitignored — Kite daily OAuth token
├── .gitignore             # Ignores config.json, .kite-token.json, node_modules
└── SUMMARY.md             # This file
```

---

## Backend: server.js

### Startup Sequence
1. Load `config.json` (local dev) or env vars (Render deployment)
2. Initialize `KiteClient` if `KITE_ENABLED=true`
3. Load `nifty500-symbols.json` from disk into memory
4. Start HTTP server on `PORT` (env var, default 3000)
5. Pre-warm NSE cache: fetch allIndices, Nifty 500, EMA, Gold, USD/INR in parallel
6. If `RENDER_EXTERNAL_URL` env var exists, start keep-alive ping every 14 minutes

### Environment Variables (Render)
| Variable | Purpose |
|---|---|
| `PORT` | Server port (Render sets automatically) |
| `RENDER_EXTERNAL_URL` | Full URL of Render deployment — enables keep-alive pings |
| `KITE_ENABLED` | `"true"` to enable Kite Connect |
| `KITE_API_KEY` | Zerodha Kite API key |
| `KITE_API_SECRET` | Zerodha Kite API secret |
| `KITE_REDIRECT_URL` | OAuth callback URL |

### Local Config (config.json — gitignored)
```json
{
  "kite": {
    "enabled": true,
    "apiKey": "ub3scozivbsq3b5s",
    "apiSecret": "ygzacdwmtz96pu8gayes94g6810k1143",
    "redirectUrl": "http://localhost:3000/auth/kite/callback",
    "tokenFile": ".kite-token.json"
  }
}
```

---

## Data Sources

### 1. NSE India (Primary — Indian IP required)
- **Base URL:** `https://www.nseindia.com`
- **Problem:** NSE geo-blocks non-Indian IPs. Render (overseas) gets 401/403.
- **Session handling:** Must first GET `https://www.nseindia.com/` to get cookies. Cookies valid for ~80 seconds. Auto-refreshed by `refreshNSESession()`.
- **Retry logic:** On 401/403, cookies are cleared and retried up to 2 times with 1-3s delays.
- **Cache TTL:** 30s during market hours (9:15–15:35 IST weekdays), 5 minutes off-hours.

NSE endpoints used:
| NSE Path | Used For |
|---|---|
| `/api/allIndices` | All index data (Nifty 50, Bank Nifty, sector indices, NIFTY 500 adv/dec) |
| `/api/equity-stockIndices?index=NIFTY%20500` | All 500 stocks with price/change/52WH/52WL/volume |
| `/api/quote-equity?symbol=SYMBOL` | Individual stock quote for Stock Analyser |

### 2. Kite Connect / Zerodha (Fallback when NSE fails)
- **API base:** `https://api.kite.trade`
- **Auth:** OAuth. User visits `/auth/kite` → redirected to Zerodha → returns to `/auth/kite/callback` with `request_token` → exchanged for `access_token`.
- **Token lifetime:** Daily. Expires ~6 AM IST. Token saved to `.kite-token.json`.
- **Key limitation:** Requires daily manual re-login (not suitable for fully public use without Indian IP).
- **Used for:** EMA historical data, Gold (MCX), USD/INR (CDS futures), index/stock quotes when NSE fails.

Kite endpoints used:
| Kite Path | Used For |
|---|---|
| `/quote?i=NSE:SYMBOL` | Real-time quotes for indices and stocks |
| `/quote/ohlc?i=NSE:SYMBOL` | OHLC quotes |
| `/quote/ltp?i=NSE:SYMBOL` | Last traded price |
| `/instruments/historical/256265/day?from=X&to=Y` | Nifty 50 daily candles for EMA (token: 256265) |
| `/portfolio/holdings` | User holdings |
| `/portfolio/positions` | User positions |
| `/user/profile` | User profile |
| `/session/token` | Exchange request_token for access_token |

### 3. Gold Price (Free API — global)
- **Primary:** `https://api.gold-api.com/price/XAU`
- **Format:** `{ price: 3050.45, ... }` — USD per troy oz
- **Cache TTL:** 2 minutes
- **Kite override:** Uses MCX GOLDM futures if authenticated

### 4. USD/INR Exchange Rate (Free API — global)
- **Primary:** `https://open.er-api.com/v6/latest/USD`
- **Format:** `{ rates: { INR: 84.2, ... } }`
- **Cache TTL:** 2 minutes
- **Kite override:** Uses CDS USDINR futures if authenticated

### 5. Nifty EMA Data (Google Sheets — global)
- **Sheet URL:** `https://docs.google.com/spreadsheets/d/1NVZd8aZbmKXhHYnfgfOLjlLiyoWfZnKy9v3MWT5jT68/export?format=csv&gid=190844943`
- **Column 16 (index 15):** Nifty daily close prices
- **Used to calculate:** 21 EMA and 50 EMA for the Breakout Card
- **Cache TTL:** 5 minutes
- **Priority:** Kite historical API (if authenticated) → Google Sheet → NSE allIndices current price (fallback, no EMA)

### 6. Market Breadth (Google Sheets — global, same sheet)
- **Same sheet as EMA:** `gid=190844943`
- **CSV columns (0-indexed):**
  - 0: Date, 1: Day, 2: Advances, 3: Declines, 4: Up4%, 5: Down4%
  - 6: Up25%M, 7: Down25%M, 8: Up50%M, 9: Down50%M
  - 10: %Above10DMA, 11: %Above20DMA, 12: %Above40DMA
  - 13: %10>20DMA, 14: %20>40DMA, 15: Nifty, 16: NiftyChg%
- **Note:** Sheet newest rows are at top. Takes first 30 rows.
- **Fetch method:** `/export?format=csv` (not gviz — gviz fails from cloud servers)

### 7. Market News (Google RSS — global)
- **Indian market news feeds:**
  - `https://news.google.com/rss/search?q=indian+stock+market+nifty+sensex&hl=en-IN&gl=IN&ceid=IN:en`
  - `https://news.google.com/rss/search?q=india+market+today+nse+bse&hl=en-IN&gl=IN&ceid=IN:en`
- **Cache TTL:** 3 minutes
- **Returns:** Top 10 deduplicated items sorted by date

### 8. Trumpometer News (Google RSS — global)
- **Trump news feeds (3 feeds):**
  - White House/executive actions
  - Trade/tariff news
  - Geopolitics (Iran, Russia, China, NATO)
- **Tagging:** Each item tagged: `TARIFF | WAR | GEOPOLITICS | IMMIGRATION | DIPLOMACY | ECONOMY | DOGE | POLICY | TRUMP`
- **Cache TTL:** 3 minutes
- **Returns:** Top 8 deduplicated items

---

## API Routes

### Main Endpoints

| Method | Route | Description | Key Data |
|---|---|---|---|
| GET | `/api/dashboard` | **Combined endpoint** — all data in one request | marketData, gainers, losers, sevenBar, indexQuotes, news, trumpNews |
| GET | `/api/market-data` | Advance/Decline, EMA sentiment, sectors | advancing, declining, niftyEMAStatus, ema21, ema50, sectors[] |
| GET | `/api/gainers` | Top 10 Nifty 500 gainers | stocks[]: {symbol, name, ltp, change} |
| GET | `/api/losers` | Top 10 Nifty 500 losers | stocks[]: {symbol, name, ltp, change} |
| GET | `/api/seven-bar-stocks` | Stocks within 5% of 52-week high | stocks[]: {symbol, ltp, distFromATH} |
| GET | `/api/index-quotes` | Nifty 50, Bank Nifty, Smallcap, Gold, USD/INR | indices: {nifty, banknifty, smallcap, gold, usdinr} |
| GET | `/api/ticker-data` | All Nifty 500 stocks for scrolling ticker | stocks[]: {symbol, ltp, change} |
| GET | `/api/sector-stocks?sector=NIFTY%20IT` | All stocks in a sector | stocks[] sorted by change |
| GET | `/api/analyse-stock?symbol=TRENT` | Minervini SEPA analysis for one stock | score, verdict, checks[], minerviniNote |
| GET | `/api/mbi-data` | Market Breadth from Google Sheet | rows[]: 30 days of breadth data |
| GET | `/api/news` | Indian market news | items[]: {title, link, timeAgo, source} |
| GET | `/api/trump-news` | Trump/geopolitics news | items[]: {title, link, timeAgo, tag} |
| GET | `/api/health` | Server health check | marketOpen, nseCookiesValid, cache ages |

### Kite Connect Routes

| Method | Route | Description |
|---|---|---|
| GET | `/auth/kite` | Redirect to Zerodha login |
| GET | `/auth/kite/callback?request_token=X` | OAuth callback — exchange token |
| GET | `/api/kite/status` | Check if authenticated |
| GET | `/api/kite/holdings` | Portfolio holdings |
| GET | `/api/kite/positions` | Open positions |
| GET | `/api/kite/profile` | User profile |
| GET | `/api/kite/quote?symbols=TRENT,ZOMATO` | LTP quotes via Kite |
| GET | `/api/kite/logout` | Clear access token |

---

## EMA Logic (Breakout Sentiment Card)

```
Function: getNiftyEMAStatus()
Cache TTL: 5 minutes

Data priority:
1. Kite historical data (if authenticated) — instrument token 256265, interval: 'day'
2. Google Sheet column 16 (Nifty daily closes) — reversed to chronological
3. NSE allIndices current price only (no EMA calculable)

EMA calculation:
- calculateEMA(closes, 21) → 21-day EMA
- calculateEMA(closes, 50) → 50-day EMA
- Uses exponential smoothing: k = 2/(period+1), seeds from SMA of first N periods

3-state output:
- 'yes'        → currentPrice > ema21    (display: YES — ABOVE 21 EMA, green)
- 'selective'  → currentPrice > ema50    (display: SELECTIVE — ABOVE 50 EMA, yellow)
- 'no'         → currentPrice <= ema50   (display: NO — BELOW 50 EMA, red)
```

---

## Minervini SEPA Stock Analyser

**Route:** `/api/analyse-stock?symbol=TRENT`
**Input:** NSE ticker symbol only (e.g. `TRENT`, not `TRENT.NS`)
**Data source:** Nifty 500 cache → NSE individual quote API → Kite fallback

### 7 Scoring Criteria

| # | Criterion | Pass Condition | Max Score |
|---|---|---|---|
| 1 | 52-Week High Proximity | Within 25% of yearHigh | 20 pts |
| 2 | 52-Week Low Distance | >30% above yearLow | 15 pts |
| 3 | Relative Strength vs Nifty 500 | Stock pChange > Nifty500 pChange | 15 pts |
| 4 | Intraday Price Action | Closing in upper 60% of day's range | 10 pts |
| 5 | Volatility Contraction (VCP) | Day range < 3% of prev close | 10 pts |
| 6 | Liquidity & Volume | Traded value ≥ ₹10 Cr | 15 pts |
| 7 | Weinstein Stage Analysis | Stage 2 (Advancing) | 15 pts |

### Verdicts
| Score | Verdict |
|---|---|
| ≥70 | STRONG BUY CANDIDATE |
| 50–69 | WATCHLIST — WAIT FOR SETUP |
| 30–49 | WEAK — NOT IDEAL FOR SWING |
| <30 | AVOID — DOES NOT MEET CRITERIA |

---

## Nifty 500 Symbol List Persistence

- **File:** `nifty500-symbols.json`
- **Purpose:** When deployed overseas (Render), NSE fails. The Kite fallback needs to know which 500 symbols to fetch.
- **Auto-save:** When NSE succeeds for the `nifty500` endpoint and returns >400 symbols, saves to file.
- **Auto-load:** On server startup, loads from file.
- **Used by:** `fetchAllFromKite()` to fetch `NSE:SYMBOL` format via Kite bulk quote.

---

## Frontend: app.js

### Data Flow
```
DOMContentLoaded
  └── loadAllData() [immediately + setInterval every 60s]
        ├── fetch('/api/dashboard')       [single combined request]
        │     ├── processMarketData()     → ADV/DEC numbers, EMA card, sector heatmap
        │     ├── renderIndexCard()       → 5 KPI cards (Nifty, BankNifty, Smallcap, Gold, USD/INR)
        │     ├── renderSevenBarList()    → 7 Bar Top Stocks column
        │     ├── renderGainersList()     → Top Gainers column
        │     ├── renderLosersList()      → Top Losers column
        │     └── renderNewsList()        → Market News + Trumpometer
        │
        └── [on combined fetch failure, falls back to individual API calls]

  └── loadMBIData() [separate, after combined fetch]
        └── fetch('/api/mbi-data') → renderMBITable()

  └── refreshTicker() [immediately + setInterval every 30s]
        └── fetch('/api/ticker-data') → updates ticker prices in-place (no DOM rebuild)

setInterval(rotateQuote, 20000)    → rotates 50+ trader quotes
setInterval(updateMarketStatus, 30000) → MARKET OPEN/CLOSED badge
setInterval(updateClock, 1000)     → IST clock
```

### Key Functions

| Function | Purpose |
|---|---|
| `loadAllData()` | Master fetch — combined dashboard endpoint + fallback |
| `processMarketData(data)` | Renders ADV/DEC numbers, EMA sentiment card, sector heatmap |
| `renderIndexCard(id, data)` | Updates one KPI card (Nifty, BankNifty, etc.) |
| `renderSevenBarList(stocks)` | Renders 7 Bar Top Stocks list |
| `renderGainersList(stocks)` | Renders gainers list |
| `renderLosersList(stocks)` | Renders losers list |
| `renderNewsList(id, items, type)` | Renders news items with time-ago and tags |
| `renderSectorHeatmap(sectors)` | Renders clickable color-coded sector cells |
| `openSectorModal(sector)` | Fetches + shows all stocks in a sector |
| `refreshTicker()` | Updates ticker prices in-place (30s interval) |
| `loadMBIData()` | Fetches + renders Market Breadth table |
| `analyseStock(symbol)` | Calls `/api/analyse-stock`, renders SEPA scorecard |
| `fetchAPI(url, fallback, timeout)` | Generic fetch with timeout + fallback |
| `updateSourceBadge(id, source)` | Shows LIVE/CACHED/OFFLINE badge |
| `formatNumber(n)` | Indian number formatting (e.g. 1,23,456.78) |
| `isMarketOpen()` | Returns true 9:15–15:35 IST Mon–Fri |

### Auto-Refresh Intervals
| What | Interval |
|---|---|
| All dashboard data | 60 seconds |
| Ticker prices | 30 seconds |
| Market status badge | 30 seconds |
| Trader quote rotation | 20 seconds |
| Clock | 1 second |

---

## Frontend: index.html

### Page Sections (top to bottom)
1. **Header** — Logo, market open/closed badge, IST clock, rotating trader quote
2. **Ticker Tape** — Scrolling marquee of all Nifty 500 stocks (`#kite-ticker`)
3. **KPI Strip** — Nifty 50, Bank Nifty, Smallcap, Gold $/oz, USD/INR cards
4. **Advance/Decline Card** — Green number / Red number + ratio (`#advCount`, `#decCount`)
5. **Breakout Sentiment Card** — EMA-based 3-state signal (`#sentimentCard`)
6. **Three Columns** — 7 Bar Top Stocks | Top 10 Gainers | Top 10 Losers
7. **Bottom Row** — Top Market News | Sector Heatmap | Trumpometer
8. **Market Breadth** — 30-day table from Google Sheet (`#mbiTableWrapper`)
9. **Stock Analyser** — Minervini SEPA input + scorecard (`#analyserSection`)
10. **Footer** — Version + last updated timestamp

### Important Element IDs
```
advCount, decCount, advDecRatio, advDecSource
sentimentCard, sentimentIcon, sentimentText, sentimentDetail, sentimentSource
kpi-nifty, kpi-banknifty, kpi-smallcap, kpi-gold, kpi-usdinr
sevenBarList, gainersList, losersList
marketNewsList, trumpNewsList
customHeatmap
mbiTableWrapper
analyserTicker, analyserBtn, analyserResult
headerTime, marketStatus, lastUpdated, quoteBox, quoteText, quoteAuthor
kite-ticker (ticker tape strip)
```

---

## Frontend: styles.css

- **Theme:** Dark (#0a0e1a background, #1a2035 cards, green #00e676, red #ff5252)
- **Fonts:** Inter (UI), JetBrains Mono (prices/numbers)
- **Key CSS variables:** `--bg-primary`, `--bg-secondary`, `--green`, `--red`, `--green-dim`, `--red-dim`, `--text-primary`, `--text-muted`, `--font-mono`
- **Notable classes:** `.adv-num` (green), `.dec-num` (red), `.sentiment-icon.bullish/bearish/selective`, `.heatmap-cell`, `.stock-item`, `.mbi-table`, `.analyser-card`, `.source-badge`

---

## kite-client.js

**Class:** `KiteClient`

```javascript
constructor(config)          // config: { apiKey, apiSecret, redirectUrl, tokenFile }
loadToken()                  // Reads .kite-token.json, checks if created today
saveToken(accessToken)       // Writes to .kite-token.json with timestamp
isAuthenticated()            // Returns true if accessToken exists
getLoginUrl()                // Returns Zerodha OAuth URL
exchangeToken(requestToken)  // POST to /session/token → saves access token
apiCall(endpoint)            // GET authenticated request to api.kite.trade
getQuote(symbols[])          // Full quote data — { last_price, ohlc, volume, ... }
getOHLC(symbols[])           // OHLC only
getLTP(symbols[])            // Last traded price only
getHistoricalData(token, interval, from, to)  // Daily candles
getQuoteBatched(symbols[], batchSize=500)     // Bulk quote with batching
```

**Symbol format:** `"NSE:RELIANCE"`, `"MCX:GOLDM25JANFUT"`, `"CDS:USDINR25JANFUT"`

---

## Dockerfile (Fly.io deployment)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production 2>/dev/null || true
COPY . .
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
```

**Target region:** `maa` (Chennai) — Indian IP, NSE works natively without auth
**Deploy command:** `fly launch --region maa --name seven-bar-market-monitor`

---

## Known Issues & Architecture Decisions

### NSE Geo-blocking
NSE blocks non-Indian IPs. Render servers are overseas → NSE returns 401/403. Solution: Deploy on Fly.io Chennai region (`maa`). The Kite fallback layer was added as a bridge but requires daily auth.

### Combined Dashboard Endpoint
`/api/dashboard` runs all 7 data fetches in parallel using `Promise.allSettled()`. Each failure is graceful — returns empty/null for that section. The frontend falls back to individual endpoint calls if this fails.

### Advance/Decline Values as Strings
NSE API returns advancing/declining counts as **strings** (e.g. `"275"`). Frontend uses `parseInt()` before arithmetic. Always use `parseInt()` when doing math on these values.

### Google Sheet EMA Source
EMA data comes from column 16 (Nifty close) of the Market Breadth sheet. Rows are newest-first in the sheet, so they are `.reverse()`d to chronological before EMA calculation. Needs minimum 50 rows to compute 50 EMA.

### Ticker Tape
Uses `refreshTicker()` every 30s which updates prices in-place without rebuilding DOM — prevents scroll reset. The ticker builds one long strip, clones it, and uses CSS animation for infinite scroll.

### Cache-busting
`app.js?v=2` and `styles.css?v=2` query params force browsers to reload updated files. Increment `v` number when deploying significant JS/CSS changes.

---

## How to Run Locally

```bash
cd "7 Bar Market Monitor 2"
node server.js
# Open http://localhost:3000
```

With Kite (optional):
1. Set `kite.enabled: true` in `config.json`
2. Add `apiKey` and `apiSecret`
3. Go to `http://localhost:3000/auth/kite` and login with Zerodha

---

## Deployment

### Render (current)
- Repo: `nirvairkhanuja111-create/7-bar-market-monitor`
- Branch: `master`
- Build command: *(none)*
- Start command: `node server.js`
- Set env var `RENDER_EXTERNAL_URL` = `https://seven-bar-market-monitor.onrender.com`
- Free tier spins down after 15min inactivity — keep-alive ping every 14min mitigates this

### Fly.io (preferred — Indian IP)
```bash
fly launch --region maa --name seven-bar-market-monitor
fly deploy
```
Gives URL: `https://seven-bar-market-monitor.fly.dev`
NSE works natively from Chennai region. No Kite auth needed for market data.
