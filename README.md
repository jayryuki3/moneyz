# moneyz - Polymarket Arbitrage Bot

A standalone arbitrage bot + dashboard for [Polymarket](https://polymarket.com) prediction markets. Scans for pricing inefficiencies and executes trades automatically.

## Strategies

### Market Rebalancing
Detects when the sum of all outcome prices in a single market deviates from $1.00:
- **Sum of asks < $1.00** -> Buy all outcomes, guaranteed profit on resolution
- **Sum of bids > $1.00** -> Sell all outcomes for instant profit

### Combinatorial / Cross-Market
Compares related markets within the same event group:
- Sub-market probabilities that should sum to 100% but don't
- Price divergences between logically related markets
- Pairwise inconsistency detection

## Quick Start

```bash
# Install dependencies
npm install

# Start everything (bot + dashboard + API)
npm start

# Or with auto-reload for development
npm run dev
```

Open **http://localhost:4173** to access the dashboard.

## Architecture

Everything runs as a single Node.js process:

```
server.js          Express API + static dashboard
  bot.js           Main orchestrator loop
    scanner.js     Fetches markets from Gamma API
    strategies/
      rebalancing.js    Single-market arb detection
      combinatorial.js  Cross-market arb detection
    executor.js    Paper + live trade execution
  database.js      SQLite via better-sqlite3
  public/
    index.html     Dashboard UI (dark theme)
```

## Dashboard Features

- **Stats Bar** - Total PnL, trades today, win rate, markets scanned, active opportunities
- **Live Opportunities** - Real-time arb opportunities with spread percentages
- **Trade History** - Full log of paper and live trades
- **Activity Log** - Color-coded event log from all subsystems
- **Settings Panel** - Paper/live mode toggle, API keys, bot parameters

## Configuration

All settings are managed through the dashboard UI under the Settings tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Paper Mode | ON | Simulates trades without real money |
| Max Position (USD) | $10 | Maximum trade size per opportunity |
| Scan Interval | 30s | How often to scan for new opportunities |
| Min Spread % | 0.5% | Minimum arbitrage spread to act on |
| Max Markets | 200 | Maximum markets to scan per cycle |

## API Keys (for Live Trading)

To trade live on Polymarket, you need CLOB API credentials:

1. Go to [polymarket.com](https://polymarket.com) and create an account
2. Generate API credentials from your account settings
3. Enter them in the dashboard Settings tab:
   - **API Key** - Your CLOB API key
   - **API Secret** - Your CLOB API secret
   - **API Passphrase** - Your CLOB passphrase
   - **Private Key** - Your Ethereum wallet private key (for order signing)

> **Warning**: Start with paper trading to validate the bot's strategy before using real funds. Never risk more than you can afford to lose.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Bot status, stats, recent opportunities |
| `/api/trades` | GET | Trade history |
| `/api/opportunities` | GET | Detected opportunities |
| `/api/logs` | GET | Activity logs |
| `/api/settings` | GET/POST | View/update configuration |
| `/api/bot/start` | POST | Start the bot |
| `/api/bot/stop` | POST | Stop the bot |
| `/api/bot/pause` | POST | Pause/resume scanning |
| `/api/health` | GET | Health check |

## Data Storage

Uses SQLite (via `better-sqlite3`) stored as `moneyz.db` in the project root. The database is auto-created on first run with all required tables. No external database server needed.

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Server**: Express
- **Database**: SQLite (better-sqlite3)
- **APIs**: Polymarket Gamma API (markets), CLOB API (orderbooks/trading)
- **Frontend**: Vanilla HTML/CSS/JS (zero build step)
- **Auth**: HMAC-SHA256 L2 signing for live trades

## License

MIT
