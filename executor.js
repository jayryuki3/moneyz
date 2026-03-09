/**
 * executor.js — Trade Execution Engine
 *
 * Handles both paper and live trade execution.
 * Paper mode: simulates fills based on orderbook prices, tracks virtual PnL.
 * Live mode: constructs signed orders via Polymarket CLOB API (L2 HMAC auth).
 */
import crypto from 'crypto';
import axios from 'axios';
import { insertTrade, insertLog, getSettings } from './database.js';

const CLOB_BASE = 'https://clob.polymarket.com';

export class Executor {
  constructor() {
    this.totalExecuted = 0;
  }

  /**
   * Generate a unique trade ID
   */
  generateTradeId(strategy) {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    return `${strategy}_${ts}_${rand}`;
  }

  /**
   * Execute a paper trade — log simulated fill at detected prices.
   */
  executePaperTrade(opportunity) {
    const settings = getSettings();
    const maxUsd = settings.max_position_usd || 10;

    // Calculate how many shares we can buy within budget
    const costPerShare = opportunity.costPerShare || 1;
    const shares = Math.min(
      Math.floor(maxUsd / costPerShare),
      opportunity.maxShares || 100
    );

    if (shares <= 0) {
      insertLog('WARN', 'executor', `Skipping paper trade: insufficient depth or budget for ${opportunity.market_slug}`);
      return null;
    }

    const totalCost = shares * costPerShare;
    const expectedProfit = shares * (opportunity.profitPerShare || 0);
    const tradeId = this.generateTradeId('paper');

    const trade = {
      trade_id: tradeId,
      strategy: opportunity.strategy,
      market_slug: opportunity.market_slug || '',
      market_question: opportunity.market_question || '',
      tokens: JSON.stringify(opportunity.tokens || []),
      side: opportunity.type || 'BUY_ALL',
      size: shares,
      cost: Math.round(totalCost * 10000) / 10000,
      expected_profit: Math.round(expectedProfit * 10000) / 10000,
      actual_pnl: Math.round(expectedProfit * 10000) / 10000, // paper = expected
      status: 'paper_filled',
      timestamp: new Date().toISOString()
    };

    insertTrade(trade);
    this.totalExecuted++;

    insertLog('TRADE', 'executor',
      `PAPER ${trade.side}: ${shares} shares @ $${costPerShare.toFixed(4)} = $${totalCost.toFixed(4)} cost, $${expectedProfit.toFixed(4)} expected profit | ${opportunity.market_question?.slice(0, 80)}`);

    return trade;
  }

  /**
   * Build L2 HMAC auth headers for Polymarket CLOB API.
   */
  buildAuthHeaders(apiKey, apiSecret, apiPassphrase, timestamp, method, path, body = '') {
    const message = timestamp + method + path + body;
    const hmac = crypto.createHmac('sha256', Buffer.from(apiSecret, 'base64'));
    hmac.update(message);
    const signature = hmac.digest('base64');

    return {
      'POLY_ADDRESS': apiKey,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_PASSPHRASE': apiPassphrase,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Execute a live trade via Polymarket CLOB API.
   * Places limit orders for each token in the opportunity.
   */
  async executeLiveTrade(opportunity) {
    const settings = getSettings();

    if (!settings.api_key || !settings.api_secret || !settings.api_passphrase) {
      insertLog('ERROR', 'executor', 'Live trade failed: API credentials not configured');
      return null;
    }

    const maxUsd = settings.max_position_usd || 10;
    const costPerShare = opportunity.costPerShare || 1;
    const shares = Math.min(
      Math.floor(maxUsd / costPerShare),
      opportunity.maxShares || 100
    );

    if (shares <= 0) {
      insertLog('WARN', 'executor', `Skipping live trade: insufficient depth or budget for ${opportunity.market_slug}`);
      return null;
    }

    const tradeId = this.generateTradeId('live');
    let allOrdersPlaced = true;

    try {
      // For BUY_ALL strategy: place a buy order for each outcome token
      if (opportunity.type === 'BUY_ALL' && opportunity.details) {
        for (const detail of opportunity.details) {
          const orderPayload = {
            tokenID: detail.token,
            price: detail.price.toString(),
            size: shares.toString(),
            side: 'BUY',
            feeRateBps: '0',
            nonce: Date.now().toString(),
            expiration: '0' // GTC
          };

          const timestamp = Math.floor(Date.now() / 1000).toString();
          const bodyStr = JSON.stringify(orderPayload);
          const headers = this.buildAuthHeaders(
            settings.api_key, settings.api_secret,
            settings.api_passphrase, timestamp, 'POST', '/order', bodyStr
          );

          const response = await axios.post(`${CLOB_BASE}/order`, orderPayload, { headers, timeout: 15000 });

          if (!response.data || response.data.error) {
            insertLog('ERROR', 'executor', `Order failed for token ${detail.token}: ${JSON.stringify(response.data)}`);
            allOrdersPlaced = false;
          } else {
            insertLog('INFO', 'executor', `Order placed: BUY ${shares} of ${detail.outcome} @ $${detail.price}`);
          }
        }
      }

      // For SELL_ALL: place sell orders
      if (opportunity.type === 'SELL_ALL' && opportunity.details) {
        for (const detail of opportunity.details) {
          const orderPayload = {
            tokenID: detail.token,
            price: detail.price.toString(),
            size: shares.toString(),
            side: 'SELL',
            feeRateBps: '0',
            nonce: Date.now().toString(),
            expiration: '0'
          };

          const timestamp = Math.floor(Date.now() / 1000).toString();
          const bodyStr = JSON.stringify(orderPayload);
          const headers = this.buildAuthHeaders(
            settings.api_key, settings.api_secret,
            settings.api_passphrase, timestamp, 'POST', '/order', bodyStr
          );

          const response = await axios.post(`${CLOB_BASE}/order`, orderPayload, { headers, timeout: 15000 });

          if (!response.data || response.data.error) {
            insertLog('ERROR', 'executor', `Sell order failed for token ${detail.token}: ${JSON.stringify(response.data)}`);
            allOrdersPlaced = false;
          } else {
            insertLog('INFO', 'executor', `Order placed: SELL ${shares} of ${detail.outcome} @ $${detail.price}`);
          }
        }
      }

      const totalCost = shares * costPerShare;
      const expectedProfit = shares * (opportunity.profitPerShare || 0);

      const trade = {
        trade_id: tradeId,
        strategy: opportunity.strategy,
        market_slug: opportunity.market_slug || '',
        market_question: opportunity.market_question || '',
        tokens: JSON.stringify(opportunity.tokens || []),
        side: opportunity.type || 'BUY_ALL',
        size: shares,
        cost: Math.round(totalCost * 10000) / 10000,
        expected_profit: Math.round(expectedProfit * 10000) / 10000,
        actual_pnl: null, // unknown until resolution
        status: allOrdersPlaced ? 'live_placed' : 'partial_fill',
        timestamp: new Date().toISOString()
      };

      insertTrade(trade);
      this.totalExecuted++;

      insertLog('TRADE', 'executor',
        `LIVE ${trade.side}: ${shares} shares, $${totalCost.toFixed(4)} cost, $${expectedProfit.toFixed(4)} expected | ${opportunity.market_question?.slice(0, 80)}`);

      return trade;

    } catch (err) {
      insertLog('ERROR', 'executor', `Live trade error: ${err.message}`);
      return null;
    }
  }

  /**
   * Main execution entry point — routes to paper or live based on settings.
   */
  async execute(opportunity) {
    const settings = getSettings();
    const isPaper = settings.paper_mode === 1;

    if (isPaper) {
      return this.executePaperTrade(opportunity);
    } else {
      return await this.executeLiveTrade(opportunity);
    }
  }
}

export default Executor;
