/**
 * alpaca/executor.js — Alpaca Trade Executor
 *
 * Handles order placement via Alpaca Trading API.
 * Paper mode uses Alpaca's built-in paper trading endpoint.
 * Supports market/limit orders, fractional shares, position sizing.
 */
import crypto from 'crypto';
import { insertTrade, insertLog, getSettings } from '../database.js';

export class AlpacaExecutor {
  constructor(client) {
    this.client = client;
    this.totalExecuted = 0;
  }

  /**
   * Generate a unique trade ID.
   */
  generateTradeId(strategy) {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    return `alp_${strategy}_${ts}_${rand}`;
  }

  /**
   * Calculate position size based on max_position_usd and current price.
   */
  calculatePositionSize(price, maxUsd) {
    if (!price || price <= 0) return { qty: 0, notional: 0 };
    const notional = Math.min(maxUsd, 10000); // hard cap at $10k
    const qty = Math.floor((notional / price) * 1000) / 1000; // 3 decimal fractional
    return { qty, notional: Math.round(notional * 100) / 100 };
  }

  /**
   * Execute a trade based on an opportunity signal.
   *
   * Opportunity shape:
   * {
   *   strategy: 'pairs_trading' | 'mean_reversion',
   *   type: 'BUY' | 'SELL' | 'BUY_PAIR' | 'SELL_PAIR',
   *   symbol: 'AAPL',
   *   symbolB: 'MSFT',       // only for pairs
   *   price: 150.25,
   *   priceB: 320.50,        // only for pairs
   *   zscore: 2.5,
   *   spread: 1.2,
   *   description: '...',
   *   profitTarget: 0.02,
   * }
   */
  async execute(opportunity) {
    const settings = getSettings();
    const maxUsd = settings.max_position_usd || 10;

    try {
      // Route based on strategy type
      if (opportunity.type === 'BUY_PAIR' || opportunity.type === 'SELL_PAIR') {
        return await this.executePairsTrade(opportunity, maxUsd);
      } else {
        return await this.executeSingleTrade(opportunity, maxUsd);
      }
    } catch (err) {
      insertLog('ERROR', 'alpaca-executor', `Trade execution failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Execute a single-symbol trade (mean reversion).
   */
  async executeSingleTrade(opp, maxUsd) {
    const side = opp.type === 'BUY' ? 'buy' : 'sell';
    const { notional } = this.calculatePositionSize(opp.price, maxUsd);

    if (notional < 1) {
      insertLog('WARN', 'alpaca-executor', `Skipping ${opp.symbol}: notional $${notional} too small`);
      return null;
    }

    // Check if we already have a position (avoid doubling up)
    try {
      const existing = await this.client.getPosition(opp.symbol);
      if (existing) {
        const existingSide = parseFloat(existing.qty) > 0 ? 'buy' : 'sell';
        if (existingSide === side) {
          insertLog('INFO', 'alpaca-executor', `Already have ${side} position in ${opp.symbol}, skipping`);
          return null;
        }
      }
    } catch {
      // No position — good to proceed
    }

    let order = null;
    const tradeId = this.generateTradeId(opp.strategy);

    try {
      order = await this.client.placeOrder({
        symbol: opp.symbol,
        notional,
        side,
        type: 'market',
        time_in_force: 'day'
      });

      insertLog('TRADE', 'alpaca-executor',
        `${side.toUpperCase()} $${notional} of ${opp.symbol} @ ~$${opp.price.toFixed(2)} | z=${opp.zscore?.toFixed(2) || 'N/A'} | order=${order.id}`);

    } catch (err) {
      insertLog('ERROR', 'alpaca-executor',
        `Order failed for ${opp.symbol}: ${err.response?.data?.message || err.message}`);
      return null;
    }

    const trade = {
      trade_id: tradeId,
      strategy: opp.strategy,
      exchange: 'alpaca',
      symbol: opp.symbol,
      market_slug: opp.symbol,
      market_question: opp.description || `${side.toUpperCase()} ${opp.symbol}`,
      tokens: JSON.stringify({ order_id: order.id }),
      side: side.toUpperCase(),
      size: parseFloat(order.qty || order.notional || notional),
      price: opp.price,
      cost: notional,
      expected_profit: Math.round(notional * (opp.profitTarget || 0.02) * 10000) / 10000,
      actual_pnl: null,
      status: this.client.isPaper ? 'paper_placed' : 'live_placed',
      timestamp: new Date().toISOString()
    };

    insertTrade(trade);
    this.totalExecuted++;
    return trade;
  }

  /**
   * Execute a pairs trade (buy one, sell/short the other).
   */
  async executePairsTrade(opp, maxUsd) {
    // Split budget between the two legs
    const legBudget = maxUsd / 2;
    const tradeId = this.generateTradeId('pairs');
    const trades = [];

    // Leg A: the symbol we BUY
    const buySymbol = opp.type === 'BUY_PAIR' ? opp.symbol : opp.symbolB;
    const sellSymbol = opp.type === 'BUY_PAIR' ? opp.symbolB : opp.symbol;
    const buyPrice = opp.type === 'BUY_PAIR' ? opp.price : opp.priceB;
    const sellPrice = opp.type === 'BUY_PAIR' ? opp.priceB : opp.price;

    // Leg A: BUY
    const { notional: buyNotional } = this.calculatePositionSize(buyPrice, legBudget);
    if (buyNotional >= 1) {
      try {
        const buyOrder = await this.client.placeOrder({
          symbol: buySymbol,
          notional: buyNotional,
          side: 'buy',
          type: 'market',
          time_in_force: 'day'
        });
        insertLog('TRADE', 'alpaca-executor',
          `PAIRS BUY: $${buyNotional} of ${buySymbol} @ ~$${buyPrice.toFixed(2)} | order=${buyOrder.id}`);
        trades.push({ symbol: buySymbol, side: 'BUY', order_id: buyOrder.id });
      } catch (err) {
        insertLog('ERROR', 'alpaca-executor', `Pairs BUY leg failed for ${buySymbol}: ${err.response?.data?.message || err.message}`);
      }
    }

    // Leg B: SELL (short)
    const { notional: sellNotional } = this.calculatePositionSize(sellPrice, legBudget);
    if (sellNotional >= 1) {
      try {
        const sellOrder = await this.client.placeOrder({
          symbol: sellSymbol,
          notional: sellNotional,
          side: 'sell',
          type: 'market',
          time_in_force: 'day'
        });
        insertLog('TRADE', 'alpaca-executor',
          `PAIRS SELL: $${sellNotional} of ${sellSymbol} @ ~$${sellPrice.toFixed(2)} | order=${sellOrder.id}`);
        trades.push({ symbol: sellSymbol, side: 'SELL', order_id: sellOrder.id });
      } catch (err) {
        insertLog('ERROR', 'alpaca-executor', `Pairs SELL leg failed for ${sellSymbol}: ${err.response?.data?.message || err.message}`);
      }
    }

    if (trades.length === 0) return null;

    const totalCost = buyNotional + sellNotional;
    const trade = {
      trade_id: tradeId,
      strategy: 'pairs_trading',
      exchange: 'alpaca',
      symbol: `${buySymbol}/${sellSymbol}`,
      market_slug: `${buySymbol}-${sellSymbol}`,
      market_question: opp.description || `PAIRS: long ${buySymbol} / short ${sellSymbol}`,
      tokens: JSON.stringify(trades),
      side: opp.type,
      size: totalCost,
      price: 0,
      cost: totalCost,
      expected_profit: Math.round(totalCost * (opp.profitTarget || 0.02) * 10000) / 10000,
      actual_pnl: null,
      status: this.client.isPaper ? 'paper_placed' : 'live_placed',
      timestamp: new Date().toISOString()
    };

    insertTrade(trade);
    this.totalExecuted++;
    return trade;
  }

  /**
   * Close an existing position (for profit-taking or stop-loss).
   */
  async closePosition(symbol, reason = 'manual') {
    try {
      const result = await this.client.closePosition(symbol);
      insertLog('TRADE', 'alpaca-executor', `Closed position in ${symbol} (${reason}): order=${result.id}`);
      return result;
    } catch (err) {
      insertLog('ERROR', 'alpaca-executor', `Failed to close ${symbol}: ${err.response?.data?.message || err.message}`);
      return null;
    }
  }

  /**
   * Close all positions (emergency or end-of-day).
   */
  async closeAll() {
    try {
      const result = await this.client.closeAllPositions(true);
      insertLog('TRADE', 'alpaca-executor', `Close-all executed: ${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      insertLog('ERROR', 'alpaca-executor', `Close-all failed: ${err.message}`);
      return null;
    }
  }
}

export default AlpacaExecutor;
