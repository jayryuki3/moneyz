/**
 * strategies/rebalancing.js — Market Rebalancing Arbitrage
 *
 * Core idea: In a binary/multi-outcome market, the sum of all outcome
 * prices should equal $1.00. When it doesn't, there's an arb opportunity:
 *
 * - Sum of best ASKS < 1.00 → Buy all outcomes, guaranteed profit on resolution
 * - Sum of best BIDS > 1.00 → Sell/short all outcomes, guaranteed profit
 *
 * We also check orderbook DEPTH to ensure we can actually fill at those prices.
 */
import { insertLog } from '../database.js';

export class RebalancingStrategy {
  constructor(scanner) {
    this.scanner = scanner;
    this.name = 'rebalancing';
  }

  /**
   * Analyze a single market for rebalancing arbitrage.
   * Returns opportunity object or null.
   */
  async analyzeMarket(market, minSpreadPct = 0.5) {
    const { tokenIds, question, slug, outcomes } = market;

    // Need at least 2 outcomes
    if (!tokenIds || tokenIds.length < 2) return null;

    // Fetch orderbooks for all tokens in this market
    const books = await this.scanner.fetchOrderbooks(tokenIds);

    // ─── Check BUY-ALL Arb (sum of best asks < 1.0) ───────────────────
    let askSum = 0;
    let minAskDepth = Infinity;
    let allAsksExist = true;
    const askDetails = [];

    for (let i = 0; i < tokenIds.length; i++) {
      const book = books.get(tokenIds[i]);
      if (!book || book.asks.length === 0) {
        allAsksExist = false;
        break;
      }
      const bestAsk = book.asks[0];
      askSum += bestAsk.price;
      minAskDepth = Math.min(minAskDepth, bestAsk.size);
      askDetails.push({
        token: tokenIds[i],
        outcome: outcomes[i] || `Outcome ${i}`,
        price: bestAsk.price,
        size: bestAsk.size
      });
    }

    if (allAsksExist && askSum < 1.0) {
      const spread = (1.0 - askSum) * 100; // as percentage
      if (spread >= minSpreadPct) {
        const costPer = askSum;
        const profitPer = 1.0 - askSum;

        return {
          strategy: this.name,
          type: 'BUY_ALL',
          market_slug: slug,
          market_question: question,
          tokens: tokenIds,
          outcomes,
          askSum,
          spread,
          costPerShare: costPer,
          profitPerShare: profitPer,
          maxShares: Math.floor(minAskDepth), // limited by thinnest book
          details: askDetails,
          description: `BUY ALL: ${outcomes.join(' + ')} = $${askSum.toFixed(4)} (spread ${spread.toFixed(2)}%, profit $${profitPer.toFixed(4)}/share)`
        };
      }
    }

    // ─── Check SELL-ALL Arb (sum of best bids > 1.0) ──────────────────
    let bidSum = 0;
    let minBidDepth = Infinity;
    let allBidsExist = true;
    const bidDetails = [];

    for (let i = 0; i < tokenIds.length; i++) {
      const book = books.get(tokenIds[i]);
      if (!book || book.bids.length === 0) {
        allBidsExist = false;
        break;
      }
      const bestBid = book.bids[0];
      bidSum += bestBid.price;
      minBidDepth = Math.min(minBidDepth, bestBid.size);
      bidDetails.push({
        token: tokenIds[i],
        outcome: outcomes[i] || `Outcome ${i}`,
        price: bestBid.price,
        size: bestBid.size
      });
    }

    if (allBidsExist && bidSum > 1.0) {
      const spread = (bidSum - 1.0) * 100;
      if (spread >= minSpreadPct) {
        const profitPer = bidSum - 1.0;

        return {
          strategy: this.name,
          type: 'SELL_ALL',
          market_slug: slug,
          market_question: question,
          tokens: tokenIds,
          outcomes,
          bidSum,
          spread,
          costPerShare: 1.0,
          profitPerShare: profitPer,
          maxShares: Math.floor(minBidDepth),
          details: bidDetails,
          description: `SELL ALL: ${outcomes.join(' + ')} bids = $${bidSum.toFixed(4)} (spread ${spread.toFixed(2)}%, profit $${profitPer.toFixed(4)}/share)`
        };
      }
    }

    return null;
  }

  /**
   * Run rebalancing analysis across all scanned markets.
   * Returns array of opportunity objects sorted by spread (best first).
   */
  async analyze(markets, minSpreadPct = 0.5) {
    const opps = [];
    let analyzed = 0;

    for (const market of markets) {
      try {
        const opp = await this.analyzeMarket(market, minSpreadPct);
        if (opp) opps.push(opp);
        analyzed++;
      } catch (err) {
        // Skip individual market errors silently
      }
    }

    // Sort by spread descending (best opportunities first)
    opps.sort((a, b) => b.spread - a.spread);

    insertLog('INFO', 'rebalancing', `Analyzed ${analyzed} markets, found ${opps.length} opportunities`);
    return opps;
  }
}

export default RebalancingStrategy;
