/**
 * strategies/pairsTrading.js — Statistical Arbitrage / Pairs Trading
 *
 * Core idea: Two correlated stocks that historically move together
 * will occasionally diverge. When the spread (ratio) between them
 * deviates significantly from its mean (measured by z-score),
 * we bet on mean reversion:
 *
 * - z-score > +entry  → SELL the outperformer, BUY the underperformer
 * - z-score < -entry  → BUY the outperformer, SELL the underperformer
 * - |z-score| < exit  → close the position (spread reverted)
 *
 * Uses rolling price ratios and correlation to identify/validate pairs.
 */
import { insertLog } from '../database.js';

export class PairsTradingStrategy {
  constructor() {
    this.name = 'pairs_trading';
    this.pairs = []; // discovered pairs with their stats
  }

  /**
   * Compute Pearson correlation coefficient between two arrays.
   */
  correlation(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 5) return 0;

    const xs = x.slice(-n);
    const ys = y.slice(-n);

    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }

  /**
   * Compute the z-score of the current spread ratio relative to its history.
   */
  computeSpreadZScore(closesA, closesB) {
    const n = Math.min(closesA.length, closesB.length);
    if (n < 10) return { zscore: 0, mean: 0, std: 0, currentRatio: 0, ratios: [] };

    // Compute price ratio series
    const ratios = [];
    for (let i = 0; i < n; i++) {
      if (closesB[i] !== 0) {
        ratios.push(closesA[i] / closesB[i]);
      }
    }

    if (ratios.length < 10) return { zscore: 0, mean: 0, std: 0, currentRatio: 0, ratios: [] };

    // Mean and std of ratios
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;
    const std = Math.sqrt(variance);

    if (std === 0) return { zscore: 0, mean, std: 0, currentRatio: ratios[ratios.length - 1], ratios };

    const currentRatio = ratios[ratios.length - 1];
    const zscore = (currentRatio - mean) / std;

    return { zscore, mean, std, currentRatio, ratios };
  }

  /**
   * Simple cointegration test using Augmented Engle-Granger approach.
   * Returns a heuristic score 0-1 where higher = more cointegrated.
   *
   * Full ADF test requires more stats lib; this uses a practical proxy:
   * high correlation + low spread volatility relative to price volatility.
   */
  cointegrationScore(closesA, closesB) {
    const n = Math.min(closesA.length, closesB.length);
    if (n < 20) return 0;

    // Correlation of returns (not prices) — better for stationarity
    const returnsA = [];
    const returnsB = [];
    for (let i = 1; i < n; i++) {
      returnsA.push((closesA[i] - closesA[i - 1]) / closesA[i - 1]);
      returnsB.push((closesB[i] - closesB[i - 1]) / closesB[i - 1]);
    }

    const corr = this.correlation(returnsA, returnsB);

    // Spread residuals — how stationary is the ratio?
    const ratios = [];
    for (let i = 0; i < n; i++) {
      if (closesB[i] !== 0) ratios.push(closesA[i] / closesB[i]);
    }
    const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const ratioStd = Math.sqrt(ratios.reduce((s, r) => s + (r - meanRatio) ** 2, 0) / ratios.length);
    const coeffOfVar = meanRatio !== 0 ? ratioStd / Math.abs(meanRatio) : 1;

    // Score: high correlation + low ratio variance = good pair
    // Correlation > 0.7 and CV < 0.1 is ideal
    const corrScore = Math.max(0, (corr - 0.5) / 0.5); // 0 at corr=0.5, 1 at corr=1.0
    const cvScore = Math.max(0, 1 - coeffOfVar * 5);     // 0 at CV=0.2, 1 at CV=0

    return (corrScore * 0.6 + cvScore * 0.4);
  }

  /**
   * Discover valid pairs from the symbol data map.
   * Returns pairs sorted by cointegration score.
   */
  discoverPairs(symbolData, minCorrelation = 0.6) {
    const symbols = Array.from(symbolData.keys());
    const pairs = [];

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const symA = symbols[i];
        const symB = symbols[j];
        const dataA = symbolData.get(symA);
        const dataB = symbolData.get(symB);

        if (!dataA?.closes || !dataB?.closes || dataA.closes.length < 15 || dataB.closes.length < 15) continue;

        // Quick correlation check first (fast filter)
        const corr = this.correlation(dataA.closes, dataB.closes);
        if (Math.abs(corr) < minCorrelation) continue;

        // Full cointegration score
        const cointScore = this.cointegrationScore(dataA.closes, dataB.closes);
        if (cointScore < 0.3) continue;

        // Compute spread z-score
        const spread = this.computeSpreadZScore(dataA.closes, dataB.closes);

        pairs.push({
          symbolA: symA,
          symbolB: symB,
          correlation: corr,
          cointegration: cointScore,
          zscore: spread.zscore,
          mean: spread.mean,
          std: spread.std,
          currentRatio: spread.currentRatio,
          priceA: dataA.lastPrice,
          priceB: dataB.lastPrice
        });
      }
    }

    // Sort by cointegration score descending
    pairs.sort((a, b) => b.cointegration - a.cointegration);
    this.pairs = pairs;

    return pairs;
  }

  /**
   * Analyze all discovered pairs for trading signals.
   * Returns opportunity objects for pairs with z-score beyond threshold.
   */
  async analyze(symbolData, zscoreEntry = 2.0, zscoreExit = 0.5) {
    const opps = [];

    // Discover/refresh pairs
    const pairs = this.discoverPairs(symbolData);

    insertLog('INFO', 'pairs-trading',
      `Discovered ${pairs.length} correlated pairs from ${symbolData.size} symbols`);

    for (const pair of pairs) {
      const absZ = Math.abs(pair.zscore);

      // Skip pairs in the "dead zone" (not extreme enough)
      if (absZ < zscoreEntry) continue;

      // z > +entry: A is expensive relative to B → sell A, buy B
      // z < -entry: A is cheap relative to B → buy A, sell B
      const type = pair.zscore > 0 ? 'SELL_PAIR' : 'BUY_PAIR';
      const longSym = pair.zscore > 0 ? pair.symbolB : pair.symbolA;
      const shortSym = pair.zscore > 0 ? pair.symbolA : pair.symbolB;

      const opp = {
        strategy: this.name,
        type,
        symbol: pair.symbolA,
        symbolB: pair.symbolB,
        price: pair.priceA,
        priceB: pair.priceB,
        zscore: pair.zscore,
        spread: absZ, // use z-score as "spread" for display
        correlation: pair.correlation,
        cointegration: pair.cointegration,
        profitTarget: 0.02, // 2% expected on mean reversion
        market_slug: `${pair.symbolA}-${pair.symbolB}`,
        market_question: `PAIRS: long ${longSym} / short ${shortSym}`,
        description: `z=${pair.zscore.toFixed(2)} | corr=${pair.correlation.toFixed(2)} | coint=${pair.cointegration.toFixed(2)} | Long ${longSym} @ $${(pair.zscore > 0 ? pair.priceB : pair.priceA).toFixed(2)}, Short ${shortSym} @ $${(pair.zscore > 0 ? pair.priceA : pair.priceB).toFixed(2)}`
      };

      opps.push(opp);
    }

    // Sort by absolute z-score (strongest signals first)
    opps.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore));

    insertLog('INFO', 'pairs-trading',
      `Found ${opps.length} actionable pair signals (z-entry=${zscoreEntry})`);

    return opps;
  }
}

export default PairsTradingStrategy;
