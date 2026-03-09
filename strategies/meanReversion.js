/**
 * strategies/meanReversion.js — Mean Reversion Strategy
 *
 * Core idea: Stock prices oscillate around a moving average.
 * When price deviates significantly (measured by z-score),
 * it tends to revert back to the mean.
 *
 * Signals:
 * - z-score < -entry (oversold)  → BUY (price below lower Bollinger Band)
 * - z-score > +entry (overbought) → SELL (price above upper Bollinger Band)
 * - |z-score| < exit              → close position (reverted to mean)
 *
 * Uses SMA + standard deviation (Bollinger Bands) for confirmation.
 */
import { insertLog } from '../database.js';

export class MeanReversionStrategy {
  constructor() {
    this.name = 'mean_reversion';
  }

  /**
   * Compute Simple Moving Average over a window.
   */
  sma(values, window) {
    if (values.length < window) return null;
    const slice = values.slice(-window);
    return slice.reduce((a, b) => a + b, 0) / window;
  }

  /**
   * Compute rolling standard deviation over a window.
   */
  rollingStd(values, window) {
    if (values.length < window) return null;
    const slice = values.slice(-window);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window;
    return Math.sqrt(variance);
  }

  /**
   * Compute Bollinger Bands for a price series.
   */
  bollingerBands(closes, window = 20, numStd = 2) {
    const mean = this.sma(closes, window);
    const std = this.rollingStd(closes, window);

    if (mean === null || std === null) return null;

    return {
      upper: mean + numStd * std,
      middle: mean,
      lower: mean - numStd * std,
      std,
      bandwidth: std !== 0 ? (2 * numStd * std) / mean * 100 : 0 // as percentage
    };
  }

  /**
   * Compute z-score: how many standard deviations price is from the SMA.
   */
  computeZScore(closes, window) {
    if (!closes || closes.length < window) return null;

    const mean = this.sma(closes, window);
    const std = this.rollingStd(closes, window);
    const current = closes[closes.length - 1];

    if (!mean || !std || std === 0) return null;

    return (current - mean) / std;
  }

  /**
   * Compute RSI (Relative Strength Index) as additional confirmation.
   */
  computeRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50; // neutral default

    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Analyze a single symbol for mean reversion opportunities.
   */
  analyzeSymbol(symbolData, zscoreEntry = 2.0, lookbackDays = 30) {
    const { symbol, closes, lastPrice, avgVolume, volatility, bidAskSpread } = symbolData;

    if (!closes || closes.length < lookbackDays) return null;

    // Compute z-score
    const zscore = this.computeZScore(closes, lookbackDays);
    if (zscore === null) return null;

    // Bollinger Bands for confirmation
    const bb = this.bollingerBands(closes, Math.min(lookbackDays, 20));
    if (!bb) return null;

    // RSI for additional confirmation
    const rsi = this.computeRSI(closes);

    const absZ = Math.abs(zscore);

    // Skip if not extreme enough
    if (absZ < zscoreEntry) return null;

    // ─── Oversold: z < -entry AND price near/below lower BB AND RSI < 35 ──
    if (zscore < -zscoreEntry && lastPrice <= bb.lower * 1.02 && rsi < 35) {
      return {
        strategy: this.name,
        type: 'BUY',
        symbol,
        price: lastPrice,
        zscore,
        rsi,
        sma: bb.middle,
        upperBB: bb.upper,
        lowerBB: bb.lower,
        bandwidth: bb.bandwidth,
        spread: absZ, // z-score as spread metric
        avgVolume,
        volatility,
        profitTarget: Math.min(absZ * 0.01, 0.05), // scale with z-score, cap at 5%
        market_slug: symbol,
        market_question: `MREV BUY ${symbol}: oversold`,
        description: `BUY ${symbol} @ $${lastPrice.toFixed(2)} | z=${zscore.toFixed(2)} | RSI=${rsi.toFixed(0)} | SMA=$${bb.middle.toFixed(2)} | BB[$${bb.lower.toFixed(2)}-$${bb.upper.toFixed(2)}]`
      };
    }

    // ─── Overbought: z > +entry AND price near/above upper BB AND RSI > 65 ──
    if (zscore > zscoreEntry && lastPrice >= bb.upper * 0.98 && rsi > 65) {
      return {
        strategy: this.name,
        type: 'SELL',
        symbol,
        price: lastPrice,
        zscore,
        rsi,
        sma: bb.middle,
        upperBB: bb.upper,
        lowerBB: bb.lower,
        bandwidth: bb.bandwidth,
        spread: absZ,
        avgVolume,
        volatility,
        profitTarget: Math.min(absZ * 0.01, 0.05),
        market_slug: symbol,
        market_question: `MREV SELL ${symbol}: overbought`,
        description: `SELL ${symbol} @ $${lastPrice.toFixed(2)} | z=${zscore.toFixed(2)} | RSI=${rsi.toFixed(0)} | SMA=$${bb.middle.toFixed(2)} | BB[$${bb.lower.toFixed(2)}-$${bb.upper.toFixed(2)}]`
      };
    }

    return null;
  }

  /**
   * Run mean reversion analysis across all symbols.
   * Returns array of opportunity objects sorted by |z-score|.
   */
  async analyze(symbolData, zscoreEntry = 2.0, lookbackDays = 30) {
    const opps = [];
    let analyzed = 0;

    for (const [symbol, data] of symbolData) {
      try {
        const opp = this.analyzeSymbol(data, zscoreEntry, lookbackDays);
        if (opp) opps.push(opp);
        analyzed++;
      } catch (err) {
        // Skip individual symbol errors
      }
    }

    // Sort by absolute z-score (strongest signals first)
    opps.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore));

    insertLog('INFO', 'mean-reversion',
      `Analyzed ${analyzed} symbols, found ${opps.length} mean-reversion signals (z-entry=${zscoreEntry})`);

    return opps;
  }

  /**
   * Check existing positions for exit signals (z-score reverted).
   * Returns symbols that should be closed.
   */
  checkExits(symbolData, positions, zscoreExit = 0.5, lookbackDays = 30) {
    const exits = [];

    for (const pos of positions) {
      const sym = pos.symbol;
      const data = symbolData.get(sym);
      if (!data?.closes) continue;

      const zscore = this.computeZScore(data.closes, lookbackDays);
      if (zscore === null) continue;

      // If z-score has reverted to within the exit band, close position
      if (Math.abs(zscore) < zscoreExit) {
        exits.push({
          symbol: sym,
          zscore,
          reason: `Mean reverted: z=${zscore.toFixed(2)} (exit threshold: +/-${zscoreExit})`,
          currentPrice: data.lastPrice,
          unrealizedPnl: parseFloat(pos.unrealized_pl || 0)
        });
      }
    }

    if (exits.length > 0) {
      insertLog('INFO', 'mean-reversion',
        `${exits.length} positions ready for exit: ${exits.map(e => e.symbol).join(', ')}`);
    }

    return exits;
  }
}

export default MeanReversionStrategy;
