/**
 * bot.js — Main Bot Orchestrator
 *
 * Ties together the scanner, strategies, and executor into a single
 * continuous loop. Exposes start/stop/status for the server API.
 */
import { MarketScanner } from './scanner.js';
import { RebalancingStrategy } from './strategies/rebalancing.js';
import { CombinatorialStrategy } from './strategies/combinatorial.js';
import { Executor } from './executor.js';
import { getSettings, insertOpportunity, insertLog, getStats } from './database.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class ArbBot {
  constructor() {
    this.scanner = new MarketScanner();
    this.rebalancing = new RebalancingStrategy(this.scanner);
    this.combinatorial = new CombinatorialStrategy(this.scanner);
    this.executor = new Executor();

    this.running = false;
    this.paused = false;
    this.loopHandle = null;
    this.cycleCount = 0;
    this.lastCycleTime = null;
    this.recentOpportunities = [];
  }

  /**
   * One full scan-analyze-execute cycle.
   */
  async runCycle() {
    const settings = getSettings();
    const minSpread = settings.min_spread_pct || 0.5;
    const maxMarkets = settings.max_markets || 200;

    try {
      // 1. Scan markets
      const markets = await this.scanner.scan(maxMarkets);
      if (markets.length === 0) {
        insertLog('WARN', 'bot', 'No markets found in scan — check API connectivity');
        return;
      }

      // 2. Run rebalancing strategy (orderbook-based, slower)
      //    Only check top markets by volume/liquidity to manage API calls
      const topMarkets = markets
        .filter(m => m.liquidity > 1000) // skip illiquid markets
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 50); // top 50 by volume

      const rebalOpps = await this.rebalancing.analyze(topMarkets, minSpread);

      // 3. Run combinatorial strategy (price-based, fast)
      const combiOpps = await this.combinatorial.analyze(this.scanner.eventGroups, minSpread);

      // 4. Merge and deduplicate opportunities
      const allOpps = [...rebalOpps, ...combiOpps];
      this.recentOpportunities = allOpps.slice(0, 20); // keep top 20 for dashboard

      // 5. Log opportunities to DB
      for (const opp of allOpps) {
        insertOpportunity({
          strategy: opp.strategy,
          market_slug: opp.market_slug || '',
          market_question: opp.market_question || '',
          description: opp.description || '',
          spread: opp.spread || 0,
          tokens: JSON.stringify(opp.tokens || []),
          timestamp: new Date().toISOString(),
          acted_on: 0
        });
      }

      // 6. Execute on actionable opportunities (rebalancing only — these are guaranteed arbs)
      //    Combinatorial PAIR_DIVERGENCE are informational only
      const actionable = allOpps.filter(o =>
        ['BUY_ALL', 'SELL_ALL', 'CROSS_BUY_YES', 'CROSS_SELL_YES'].includes(o.type) &&
        o.profitPerShare > 0 &&
        o.maxShares > 0
      );

      if (actionable.length > 0) {
        insertLog('INFO', 'bot', `Found ${actionable.length} actionable opportunities this cycle`);

        for (const opp of actionable) {
          const trade = await this.executor.execute(opp);
          if (trade) {
            // Mark opportunity as acted on
            opp.acted_on = 1;
          }
        }
      }

      this.cycleCount++;
      this.lastCycleTime = new Date().toISOString();

      const mode = settings.paper_mode === 1 ? 'PAPER' : 'LIVE';
      insertLog('INFO', 'bot',
        `Cycle #${this.cycleCount} complete [${mode}]: ${markets.length} markets scanned, ${allOpps.length} opps found, ${actionable.length} acted on`);

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
    const intervalSec = settings.scan_interval_sec || 30;

    insertLog('INFO', 'bot', `Bot started — scanning every ${intervalSec}s in ${settings.paper_mode === 1 ? 'PAPER' : 'LIVE'} mode`);

    // Main loop
    while (this.running) {
      if (!this.paused) {
        await this.runCycle();
      }
      // Re-read interval each cycle in case user changed it
      const currentSettings = getSettings();
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
    const stats = getStats();

    return {
      running: this.running,
      paused: this.paused,
      paperMode: settings.paper_mode === 1,
      cycleCount: this.cycleCount,
      lastCycleTime: this.lastCycleTime,
      lastScanTime: this.scanner.lastScanTime,
      marketsLoaded: this.scanner.markets.length,
      eventGroups: Object.keys(this.scanner.eventGroups).length,
      recentOpportunities: this.recentOpportunities,
      scanInterval: settings.scan_interval_sec,
      ...stats
    };
  }
}

export default ArbBot;
