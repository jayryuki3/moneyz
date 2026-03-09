/**
 * strategies/combinatorial.js — Cross-Market / Combinatorial Arbitrage
 *
 * Core idea: Related markets within the same event should be logically
 * consistent. When they aren't, there's an arbitrage opportunity.
 *
 * Examples:
 * - "Will X win the election?" at 60% but "Will X win State Y?" at 80%
 *   when State Y is necessary → inconsistency
 * - Multiple sub-markets in an event whose probabilities should sum to 100%
 *   but actually sum to more or less
 *
 * Strategy: Group markets by event, check probability consistency,
 * flag mismatches above threshold.
 */
import { insertLog } from '../database.js';

export class CombinatorialStrategy {
  constructor(scanner) {
    this.scanner = scanner;
    this.name = 'combinatorial';
  }

  /**
   * Analyze an event group (multiple related markets under same event).
   * Checks if sub-market probabilities are logically consistent.
   */
  analyzeEventGroup(groupSlug, markets, minSpreadPct = 0.5) {
    const opps = [];

    // Skip groups with only 1 market (nothing to cross-reference)
    if (markets.length < 2) return opps;

    // ─── Strategy 1: Sub-market probability sum check ─────────────────
    // For events with multiple sub-markets that represent exhaustive outcomes
    // (e.g., "Who will win?" broken into per-candidate markets),
    // the sum of "Yes" probabilities across all sub-markets should = ~1.0

    const yesProbs = [];
    const marketInfo = [];

    for (const m of markets) {
      if (m.outcomePrices && m.outcomePrices.length >= 1) {
        // outcomePrices[0] is typically the "Yes" price
        const yesPrice = m.outcomePrices[0];
        if (yesPrice > 0 && yesPrice < 1) {
          yesProbs.push(yesPrice);
          marketInfo.push({
            slug: m.slug,
            question: m.question,
            yesPrice,
            outcomes: m.outcomes,
            tokenIds: m.tokenIds
          });
        }
      }
    }

    if (yesProbs.length >= 2) {
      const sumYes = yesProbs.reduce((a, b) => a + b, 0);

      // If sum of all "Yes" prices < 1.0 → buy all "Yes" outcomes
      if (sumYes < 1.0) {
        const spread = (1.0 - sumYes) * 100;
        if (spread >= minSpreadPct) {
          opps.push({
            strategy: this.name,
            type: 'CROSS_BUY_YES',
            market_slug: groupSlug,
            market_question: `Event group: ${groupSlug} (${markets.length} sub-markets)`,
            tokens: marketInfo.flatMap(m => m.tokenIds),
            outcomes: marketInfo.map(m => m.question),
            sumYes,
            spread,
            costPerShare: sumYes,
            profitPerShare: 1.0 - sumYes,
            maxShares: 0, // would need orderbook depth check
            details: marketInfo,
            description: `CROSS BUY YES: ${marketInfo.length} markets in "${groupSlug}" sum to $${sumYes.toFixed(4)} (spread ${spread.toFixed(2)}%)`
          });
        }
      }

      // If sum of all "Yes" prices > 1.0 → sell/short all "Yes" outcomes
      if (sumYes > 1.0) {
        const spread = (sumYes - 1.0) * 100;
        if (spread >= minSpreadPct) {
          opps.push({
            strategy: this.name,
            type: 'CROSS_SELL_YES',
            market_slug: groupSlug,
            market_question: `Event group: ${groupSlug} (${markets.length} sub-markets)`,
            tokens: marketInfo.flatMap(m => m.tokenIds),
            outcomes: marketInfo.map(m => m.question),
            sumYes,
            spread,
            costPerShare: 1.0,
            profitPerShare: sumYes - 1.0,
            maxShares: 0,
            details: marketInfo,
            description: `CROSS SELL YES: ${marketInfo.length} markets in "${groupSlug}" sum to $${sumYes.toFixed(4)} (spread ${spread.toFixed(2)}%)`
          });
        }
      }
    }

    // ─── Strategy 2: Pairwise implication check ───────────────────────
    // Check for logical inconsistencies between pairs of related markets.
    // E.g., if market A implies market B, but B's price is lower than A's.

    for (let i = 0; i < marketInfo.length; i++) {
      for (let j = i + 1; j < marketInfo.length; j++) {
        const a = marketInfo[i];
        const b = marketInfo[j];

        // Check if one question is a subset condition of the other
        // (heuristic: if one question contains the other's key terms)
        const priceDiff = Math.abs(a.yesPrice - b.yesPrice);

        // Flag large price divergences in same event group
        // This is a softer signal — not guaranteed arb but worth monitoring
        if (priceDiff > 0.30) {
          opps.push({
            strategy: this.name,
            type: 'PAIR_DIVERGENCE',
            market_slug: groupSlug,
            market_question: `Divergence in "${groupSlug}"`,
            tokens: [...a.tokenIds, ...b.tokenIds],
            outcomes: [a.question, b.question],
            spread: priceDiff * 100,
            costPerShare: 0,
            profitPerShare: 0,
            maxShares: 0,
            details: [
              { market: a.question, price: a.yesPrice },
              { market: b.question, price: b.yesPrice }
            ],
            description: `DIVERGENCE: "${a.question.slice(0, 60)}" at ${(a.yesPrice * 100).toFixed(1)}% vs "${b.question.slice(0, 60)}" at ${(b.yesPrice * 100).toFixed(1)}% (${(priceDiff * 100).toFixed(1)}% gap)`
          });
        }
      }
    }

    return opps;
  }

  /**
   * Run combinatorial analysis across all event groups.
   */
  async analyze(eventGroups, minSpreadPct = 0.5) {
    const opps = [];
    let groupsAnalyzed = 0;

    for (const [groupSlug, markets] of Object.entries(eventGroups)) {
      try {
        const groupOpps = this.analyzeEventGroup(groupSlug, markets, minSpreadPct);
        opps.push(...groupOpps);
        groupsAnalyzed++;
      } catch (err) {
        // Skip group errors
      }
    }

    opps.sort((a, b) => b.spread - a.spread);

    insertLog('INFO', 'combinatorial', `Analyzed ${groupsAnalyzed} event groups, found ${opps.length} cross-market opportunities`);
    return opps;
  }
}

export default CombinatorialStrategy;
