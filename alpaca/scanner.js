/**
 * alpaca/scanner.js — Alpaca Market Scanner
 *
 * Fetches a configurable watchlist of stock symbols, pulls latest
 * quotes + historical bars from Alpaca Market Data API, computes
 * basic metrics (spread, volume, volatility), and feeds enriched
 * symbol data to the strategy engines.
 */
import { insertLog } from '../database.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class AlpacaScanner {
  constructor(client) {
    this.client = client;
    this.symbols = [];
    this.symbolData = new Map();   // symbol -> { bars, quote, metrics }
    this.lastScanTime = null;
    this.scanning = false;
  }

  /**
   * Parse the symbols watchlist string into an array.
   */
  parseSymbols(symbolsStr) {
    return symbolsStr
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0);
  }

  /**
   * Compute basic metrics from bar data.
   */
  computeMetrics(bars) {
    if (!bars || bars.length < 2) {
      return { avgVolume: 0, volatility: 0, avgClose: 0, returns: [] };
    }

    const closes = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);

    // Daily returns
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }

    // Average volume
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    // Average close
    const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;

    // Volatility (std dev of returns)
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
    const volatility = Math.sqrt(variance);

    return { avgVolume, volatility, avgClose, returns, closes };
  }

  /**
   * Full scan: fetch bars and quotes for all watchlist symbols.
   * Returns enriched symbol data map.
   */
  async scan(symbolsStr, lookbackDays = 30) {
    if (this.scanning) return this.symbolData;
    this.scanning = true;

    try {
      this.symbols = this.parseSymbols(symbolsStr);
      if (this.symbols.length === 0) {
        insertLog('WARN', 'alpaca-scanner', 'No symbols configured in watchlist');
        return this.symbolData;
      }

      insertLog('INFO', 'alpaca-scanner', `Scanning ${this.symbols.length} symbols: ${this.symbols.join(', ')}`);

      // Calculate date range for historical bars
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - lookbackDays);
      const startISO = start.toISOString().split('T')[0];
      const endISO = end.toISOString().split('T')[0];

      // Fetch bars in batches (Alpaca allows multi-symbol requests)
      const batchSize = 10;
      const allBars = {};

      for (let i = 0; i < this.symbols.length; i += batchSize) {
        const batch = this.symbols.slice(i, i + batchSize);
        try {
          const barsResult = await this.client.getBars(
            batch, '1Day', startISO, endISO, lookbackDays + 5
          );
          Object.assign(allBars, barsResult);
        } catch (err) {
          insertLog('WARN', 'alpaca-scanner', `Bars fetch failed for batch ${batch.join(',')}: ${err.message}`);
        }
        if (i + batchSize < this.symbols.length) await sleep(300);
      }

      // Fetch latest quotes
      let allQuotes = {};
      try {
        allQuotes = await this.client.getLatestQuotes(this.symbols);
      } catch (err) {
        insertLog('WARN', 'alpaca-scanner', `Quotes fetch failed: ${err.message}`);
      }

      // Fetch latest trades for current prices
      let allTrades = {};
      try {
        allTrades = await this.client.getLatestTrades(this.symbols);
      } catch (err) {
        insertLog('WARN', 'alpaca-scanner', `Trades fetch failed: ${err.message}`);
      }

      // Build enriched symbol data
      this.symbolData.clear();

      for (const sym of this.symbols) {
        const bars = allBars[sym] || [];
        const quote = allQuotes[sym] || null;
        const trade = allTrades[sym] || null;
        const metrics = this.computeMetrics(bars);

        const lastPrice = trade?.p || (bars.length > 0 ? bars[bars.length - 1].c : 0);
        const bidPrice = quote?.bp || 0;
        const askPrice = quote?.ap || 0;
        const bidAskSpread = askPrice > 0 && bidPrice > 0
          ? ((askPrice - bidPrice) / askPrice) * 100
          : 0;

        this.symbolData.set(sym, {
          symbol: sym,
          bars,
          quote,
          trade,
          lastPrice,
          bidPrice,
          askPrice,
          bidAskSpread,
          ...metrics
        });
      }

      this.lastScanTime = new Date().toISOString();
      insertLog('INFO', 'alpaca-scanner',
        `Scan complete: ${this.symbolData.size} symbols loaded, ${Object.values(allBars).reduce((s, b) => s + b.length, 0)} total bars`);

      return this.symbolData;

    } catch (err) {
      insertLog('ERROR', 'alpaca-scanner', `Scan failed: ${err.message}`);
      return this.symbolData;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Auto-discover high-volume tradeable stocks.
   * Fetches most active assets and returns top N by volume.
   */
  async discoverUniverse(topN = 20) {
    try {
      const assets = await this.client.getAssets('active', 'us_equity');
      const tradeable = assets
        .filter(a => a.tradable && a.fractionable && a.shortable)
        .slice(0, 200); // take first 200 tradeable

      if (tradeable.length === 0) return [];

      // Get snapshots to find highest volume
      const symbols = tradeable.map(a => a.symbol).slice(0, 50);
      const snapshots = await this.client.getSnapshots(symbols);

      const ranked = Object.entries(snapshots)
        .map(([sym, snap]) => ({
          symbol: sym,
          volume: snap.dailyBar?.v || 0,
          price: snap.latestTrade?.p || 0
        }))
        .filter(s => s.volume > 0 && s.price > 5) // skip penny stocks
        .sort((a, b) => b.volume - a.volume)
        .slice(0, topN);

      insertLog('INFO', 'alpaca-scanner', `Discovered ${ranked.length} high-volume symbols`);
      return ranked;

    } catch (err) {
      insertLog('ERROR', 'alpaca-scanner', `Universe discovery failed: ${err.message}`);
      return [];
    }
  }
}

export default AlpacaScanner;
