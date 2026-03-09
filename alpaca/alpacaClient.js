/**
 * alpaca/alpacaClient.js — Shared Alpaca API Client
 *
 * Handles authentication, base URL switching (paper vs live),
 * and wraps core Trading + Market Data API endpoints.
 */
import axios from 'axios';
import { insertLog } from '../database.js';

const DATA_BASE = 'https://data.alpaca.markets';

export class AlpacaClient {
  constructor(keyId, secretKey, baseUrl = 'https://paper-api.alpaca.markets') {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');

    this.trading = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json'
      }
    });

    this.data = axios.create({
      baseURL: DATA_BASE,
      timeout: 15000,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey
      }
    });
  }

  get isConfigured() {
    return Boolean(this.keyId && this.secretKey);
  }

  get isPaper() {
    return this.baseUrl.includes('paper');
  }

  // ── Account ─────────────────────────────────────────────────────────────

  async getAccount() {
    const { data } = await this.trading.get('/v2/account');
    return data;
  }

  // ── Positions ───────────────────────────────────────────────────────────

  async getPositions() {
    const { data } = await this.trading.get('/v2/positions');
    return data;
  }

  async getPosition(symbol) {
    try {
      const { data } = await this.trading.get(`/v2/positions/${encodeURIComponent(symbol)}`);
      return data;
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  async closePosition(symbol, qty = null) {
    const params = qty ? { qty: String(qty) } : { percentage: '100' };
    const { data } = await this.trading.delete(`/v2/positions/${encodeURIComponent(symbol)}`, { params });
    return data;
  }

  async closeAllPositions(cancelOrders = true) {
    const { data } = await this.trading.delete('/v2/positions', {
      params: { cancel_orders: cancelOrders }
    });
    return data;
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  async placeOrder({ symbol, qty, notional, side, type = 'market', time_in_force = 'day', limit_price, stop_price }) {
    const payload = {
      symbol,
      side,
      type,
      time_in_force
    };

    if (notional) {
      payload.notional = String(notional);
    } else {
      payload.qty = String(qty);
    }

    if (type === 'limit' && limit_price) payload.limit_price = String(limit_price);
    if (type === 'stop' && stop_price) payload.stop_price = String(stop_price);
    if (type === 'stop_limit') {
      if (limit_price) payload.limit_price = String(limit_price);
      if (stop_price) payload.stop_price = String(stop_price);
    }

    const { data } = await this.trading.post('/v2/orders', payload);
    return data;
  }

  async getOrders(status = 'open', limit = 50) {
    const { data } = await this.trading.get('/v2/orders', {
      params: { status, limit }
    });
    return data;
  }

  async cancelOrder(orderId) {
    await this.trading.delete(`/v2/orders/${orderId}`);
  }

  async cancelAllOrders() {
    const { data } = await this.trading.delete('/v2/orders');
    return data;
  }

  // ── Assets ──────────────────────────────────────────────────────────────

  async getAsset(symbol) {
    const { data } = await this.trading.get(`/v2/assets/${encodeURIComponent(symbol)}`);
    return data;
  }

  async getAssets(status = 'active', assetClass = 'us_equity') {
    const { data } = await this.trading.get('/v2/assets', {
      params: { status, asset_class: assetClass }
    });
    return data;
  }

  // ── Market Data: Bars (historical OHLCV) ────────────────────────────────

  async getBars(symbols, timeframe = '1Day', start, end, limit = 1000) {
    const params = {
      symbols: Array.isArray(symbols) ? symbols.join(',') : symbols,
      timeframe,
      limit
    };
    if (start) params.start = start;
    if (end) params.end = end;

    const { data } = await this.data.get('/v2/stocks/bars', { params });
    return data.bars || {};
  }

  async getBarsSingle(symbol, timeframe = '1Day', start, end, limit = 1000) {
    const params = { timeframe, limit };
    if (start) params.start = start;
    if (end) params.end = end;

    const { data } = await this.data.get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, { params });
    return data.bars || [];
  }

  // ── Market Data: Latest Quotes ──────────────────────────────────────────

  async getLatestQuotes(symbols) {
    const syms = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const { data } = await this.data.get('/v2/stocks/quotes/latest', {
      params: { symbols: syms }
    });
    return data.quotes || {};
  }

  async getLatestTrades(symbols) {
    const syms = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const { data } = await this.data.get('/v2/stocks/trades/latest', {
      params: { symbols: syms }
    });
    return data.trades || {};
  }

  // ── Market Data: Snapshots ──────────────────────────────────────────────

  async getSnapshots(symbols) {
    const syms = Array.isArray(symbols) ? symbols.join(',') : symbols;
    const { data } = await this.data.get('/v2/stocks/snapshots', {
      params: { symbols: syms }
    });
    return data;
  }
}

export default AlpacaClient;
