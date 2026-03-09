/**
 * bot.js — Main Bot Orchestrator
 *
 * Ties together the scanner, strategies, and executor into a single
 * continuous loop. Supports two exchanges:
 *   - 'polymarket' → MarketScanner + Rebalancing/Combinatorial + Polymarket Executor
 *   - 'alpaca'     → AlpacaScanner + PairsTrading/MeanReversion + Alpaca Executor
 *
 * Reads `active_exchange` from settings to choose the right pipeline.
 * Exposes start/stop/status for the server API.
 */
import { MarketScanner } from './scanner.js';
import { RebalancingStrategy } from './strategies/rebalancing.js';
import { CombinatorialStrategy } from './strategies/combinatorial.js';
import { Executor } from './executor.js';
import { AlpacaClient } from './alpaca/alpacaClient.js';
import { AlpacaScanner } from './alpaca/scanner.js';
import { PairsTradingStrategy } from './strategies/pairsTrading.js';
import { MeanReversionStrategy } from './strategies/meanReversion.js';
import { AlpacaExecutor } from './alpaca/executor.js';
import { getSettings, insertOpportunity, insertLog, getStats } from './database.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class ArbBot {
  constructor() {
    // Polymarket components
    this.scanner = new MarketScanner();
    this.rebalancing = new RebalancingStrategy(this.scanner);
    this.combinatorial = new CombinatorialStrategy(this.scanner);
    this.executor = new Executor();

    // Alpaca components (initialized on demand)
    this.alpacaClient = null;
    this.alpacaScanner = null;
    this.pairsTrading = null;
    this.meanReversion = null;
    this.alpacaExecutor = null;

    this.running = false;
    this.paused = false;
    this.cycleCount = 0;
    this.lastCycleTime = null;
    this.recentOpportunities = [];
    this.activeExchange = 'polymarket';
  }

  /**
   * Initialize or reinitialize Alpaca components from current settings.
   */
  initAlpaca(settings) {
    const keyId = settings.alpaca_key_id || '';
    const secret = settings.alpaca_secret_key || '';
    const baseUrl = settings.alpaca_base_url || 'https://paper-api.alpaca.markets';

    if (!keyId || !secret) {
      insertLog('WARN', 'bot', 'Alpaca API credentials not configured — set them in Settings');
      return false;
    }

    this.alpacaClient = new AlpacaClient(keyId, secret, baseUrl);
    this.alpacaScanner = new AlpacaScanner(this.alpacaClient);
    this.pairsTrading = new PairsTradingStrategy();
    this.meanReversion = new MeanReversionStrategy();
    this.alpacaExecutor = new AlpacaExecutor(this.alpacaClient);

    insertLog('INFO', 'bot', `Alpaca initialized — ${this.alpacaClient.isPaper ? 'PAPER' : 'LIVE'} mode`);
    return true;
  }

  /**
   * One full scan-analyze-execute cycle for Polymarket.
   */
  async runPolymarketCycle(settings) {
    const minSpread = settings.min_spread_pct || 0.5;
    const maxMarkets = settings.max_markets || 200;

    // 1. Scan markets
    const markets = await this.scanner.scan(maxMarkets);
    if (markets.length === 0) {
      insertLog('WARN', 'bot', 'No markets found in scan — check API connectivity');
      return;
    }

    // 2. Run rebalancing strategy
    const topMarkets = markets
      .filter(m => m.liquidity > 1000)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 50);
    const rebalOpps = await this.rebalancing.analyze(topMarkets, minSpread);

    // 3. Run combinatorial strategy
    const combiOpps = await this.combinatorial.analyze(this.scanner.eventGroups, minSpread);

    // 4. Merge opportunities
    const allOpps = [...rebalOpps, ...combiOpps];
    this.recentOpportunities = allOpps.slice(0, 20);

    // 5. Log to DB
    for (const opp of allOpps) {
      insertOpportunity({
        strategy: opp.strategy,
        exchange: 'polymarket',
        symbol: '',
        market_slug: opp.market_slug || '',
        market_question: opp.market_question || '',
        description: opp.description || '',
        spread: opp.spread || 0,
        zscore: null,
        tokens: JSON.stringify(opp.tokens || []),
        timestamp: new Date().toISOString(),
        acted_on: 0
      });
    }

    // 6. Execute actionable opportunities
    const actionable = allOpps.filter(o =>
      ['BUY_ALL', 'SELL_ALL', 'CROSS_BUY_YES', 'CROSS_SELL_YES'].includes(o.type) &&
      o.profitPerShare > 0 &&
      o.maxShares > 0
    );

    if (actionable.length > 0) {
      insertLog('INFO', 'bot', `Found ${actionable.length} actionable Polymarket opportunities`);
      for (const opp of actionable) {
        await this.executor.execute(opp);
      }
    }

    const mode = settings.paper_mode === 1 ? 'PAPER' : 'LIVE';
    insertLog('INFO', 'bot',
      `Polymarket cycle #${this.cycleCount + 1} [${mode}]: ${markets.length} markets, ${allOpps.length} opps, ${actionable.length} executed`);
  }

  /**
   * One full scan-analyze-execute cycle for Alpaca.
   */
  async runAlpacaCycle(settings) {
    // Ensure Alpaca is initialized
    if (!this.alpacaClient || !this.alpacaClient.isConfigured) {
      if (!this.initAlpaca(settings)) return;
    }

    const symbolsStr = settings.alpaca_symbols || 'AAPL,MSFT,GOOGL';
    const lookback = settings.lookback_days || 30;
    const zEntry = settings.zscore_entry || 2.0;
    const zExit = settings.zscore_exit || 0.5;

    try {
      // 1. Scan: fetch bars + quotes for all watchlist symbols
      const symbolData = await this.alpacaScanner.scan(symbolsStr, lookback);
      if (symbolData.size === 0) {
        insertLog('WARN', 'bot', 'Alpaca scan returned no symbol data');
        return;
      }

      // 2. Run pairs trading strategy
      const pairsOpps = await this.pairsTrading.analyze(symbolData, zEntry, zExit);

      // 3. Run mean reversion strategy
      const mrevOpps = await this.meanReversion.analyze(symbolData, zEntry, lookback);

      // 4. Check for exit signals on existing positions
      let exitSignals = [];
      try {
        const positions = await this.alpacaClient.getPositions();
        if (positions.length > 0) {
          exitSignals = this.meanReversion.checkExits(symbolData, positions, zExit, lookback);
          // Execute exits
          for (const exit of exitSignals) {
            await this.alpacaExecutor.closePosition(exit.symbol, exit.reason);
            insertLog('TRADE', 'bot', `Exit: ${exit.symbol} — ${exit.reason}`);
          }
        }
      } catch (err) {
        insertLog('WARN', 'bot', `Position check failed: ${err.message}`);
      }

      // 5. Merge all opportunities
      const allOpps = [...pairsOpps, ...mrevOpps];
      this.recentOpportunities = allOpps.slice(0, 20);

      // 6. Log opportunities to DB
      for (const opp of allOpps) {
        insertOpportunity({
          strategy: opp.strategy,
          exchange: 'alpaca',
          symbol: opp.symbol || '',
          market_slug: opp.market_slug || opp.symbol || '',
          market_question: opp.market_question || opp.description || '',
          description: opp.description || '',
          spread: opp.spread || 0,
          zscore: opp.zscore || null,
          tokens: JSON.stringify(opp.tokens || []),
          timestamp: new Date().toISOString(),
          acted_on: 0
        });
      }

      // 7. Execute on actionable opportunities
      const actionable = allOpps.filter(o =>
        ['BUY', 'SELL', 'BUY_PAIR', 'SELL_PAIR'].includes(o.type) &&
        Math.abs(o.zscore || 0) >= zEntry
      );

      if (actionable.length > 0) {
        insertLog('INFO', 'bot', `Found ${actionable.length} actionable Alpaca signals`);
        // Limit to top 3 per cycle to manage risk
        for (const opp of actionable.slice(0, 3)) {
          const trade = await this.alpacaExecutor.execute(opp);
          if (trade) opp.acted_on = 1;
        }
      }

      const mode = this.alpacaClient.isPaper ? 'PAPER' : 'LIVE';
      insertLog('INFO', 'bot',
        `Alpaca cycle #${this.cycleCount + 1} [${mode}]: ${symbolData.size} symbols, ${allOpps.length} opps (${pairsOpps.length} pairs + ${mrevOpps.length} mrev), ${actionable.length} signals, ${exitSignals.length} exits`);

    } catch (err) {
      insertLog('ERROR', 'bot', `Alpaca cycle error: ${err.message}`);
    }
  }

  /**
   * One full scan-analyze-execute cycle (routes to active exchange).
   */
  async runCycle() {
    const settings = getSettings();
    this.activeExchange = settings.active_exchange || 'polymarket';

    try {
      if (this.activeExchange === 'alpaca') {
        await this.runAlpacaCycle(settings);
      } else {
        await this.runPolymarketCycle(settings);
      }

      this.cycleCount++;
      this.lastCycleTime = new Date().toISOString();

    } catch (err) {
      insertLog('ERROR', 'bot', `Cycle error: ${err.message}`);
    }
  }

  /**
   * Start the bot loop.
   */
  async start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;

    const settings = getSettings();
    this.activeExchange = settings.active_exchange || 'polymarket';
    const intervalSec = settings.scan_interval_sec || 30;

    // Pre-initialize Alpaca if that's the active exchange
    if (this.activeExchange === 'alpaca') {
      this.initAlpaca(settings);
    }

    insertLog('INFO', 'bot',
      `Bot started — ${this.activeExchange.toUpperCase()} mode, scanning every ${intervalSec}s [${settings.paper_mode === 1 ? 'PAPER' : 'LIVE'}]`);

    while (this.running) {
      if (!this.paused) {
        await this.runCycle();
      }
      const currentSettings = getSettings();

      // Check if exchange changed mid-run
      const newExchange = currentSettings.active_exchange || 'polymarket';
      if (newExchange !== this.activeExchange) {
        this.activeExchange = newExchange;
        if (newExchange === 'alpaca') this.initAlpaca(currentSettings);
        insertLog('INFO', 'bot', `Switched to ${newExchange.toUpperCase()} exchange`);
      }

      const waitMs = (currentSettings.scan_interval_sec || 30) * 1000;
      await sleep(waitMs);
    }

    insertLog('INFO', 'bot', 'Bot stopped');
  }

  /**
   * Stop the bot loop.
   */
  stop() {
    this.running = false;
    insertLog('INFO', 'bot', 'Bot stop requested');
  }

  /**
   * Pause/resume without full stop.
   */
  togglePause() {
    this.paused = !this.paused;
    insertLog('INFO', 'bot', `Bot ${this.paused ? 'paused' : 'resumed'}`);
  }

  /**
   * Get current bot status for the dashboard.
   */
  getStatus() {
    const settings = getSettings();
    const stats = getStats(this.activeExchange);

    const base = {
      running: this.running,
      paused: this.paused,
      paperMode: settings.paper_mode === 1,
      activeExchange: this.activeExchange,
      cycleCount: this.cycleCount,
      lastCycleTime: this.lastCycleTime,
      scanInterval: settings.scan_interval_sec,
      recentOpportunities: this.recentOpportunities,
      ...stats
    };

    if (this.activeExchange === 'alpaca') {
      base.alpacaConfigured = this.alpacaClient?.isConfigured || false;
      base.alpacaPaper = this.alpacaClient?.isPaper ?? true;
      base.symbolCount = this.alpacaScanner?.symbolData?.size || 0;
      base.pairsFound = this.pairsTrading?.pairs?.length || 0;
      base.lastScanTime = this.alpacaScanner?.lastScanTime || null;
    } else {
      base.lastScanTime = this.scanner.lastScanTime;
      base.marketsLoaded = this.scanner.markets.length;
      base.eventGroups = Object.keys(this.scanner.eventGroups).length;
    }

    return base;
  }

  /**
   * Get the Alpaca client (for server API proxy calls).
   */
  getAlpacaClient() {
    if (!this.alpacaClient) {
      const settings = getSettings();
      this.initAlpaca(settings);
    }
    return this.alpacaClient;
  }
}

export default ArbBot;
