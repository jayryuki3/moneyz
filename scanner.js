/**
 * scanner.js — Market Discovery Engine
 * Fetches all active markets from Polymarket Gamma API,
 * extracts token data, and feeds it to strategy engines.
 */
import axios from 'axios';
import { insertLog } from './database.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE  = 'https://clob.polymarket.com';

// Rate-limit helper: wait ms between calls
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class MarketScanner {
  constructor() {
    this.markets = [];        // parsed market objects
    this.eventGroups = {};    // markets grouped by event slug
    this.lastScanTime = null;
    this.scanning = false;
  }

  /**
   * Fetch all active (non-closed) markets from Gamma API with pagination.
   * Returns normalized market objects with token IDs and outcomes.
   */
  async fetchMarkets(maxMarkets = 200) {
    const allMarkets = [];
    let offset = 0;
    const limit = 100; // Gamma API max per page

    try {
      while (allMarkets.length < maxMarkets) {
        const url = `${GAMMA_BASE}/markets?closed=false&limit=${limit}&offset=${offset}`;
        const { data } = await axios.get(url, { timeout: 15000 });

        if (!data || !Array.isArray(data) || data.length === 0) break;

        for (const m of data) {
          // Skip markets with no CLOB token IDs
          if (!m.clobTokenIds || m.clobTokenIds.length === 0) continue;

          // Parse token IDs — can be JSON string or array
          let tokenIds;
          try {
            tokenIds = typeof m.clobTokenIds === 'string'
              ? JSON.parse(m.clobTokenIds)
              : m.clobTokenIds;
          } catch {
            continue;
          }

          // Parse outcome prices if available
          let outcomePrices = [];
          try {
            outcomePrices = typeof m.outcomePrices === 'string'
              ? JSON.parse(m.outcomePrices)
              : (m.outcomePrices || []);
          } catch {
            outcomePrices = [];
          }

          // Parse outcomes
          let outcomes = [];
          try {
            outcomes = typeof m.outcomes === 'string'
              ? JSON.parse(m.outcomes)
              : (m.outcomes || []);
          } catch {
            outcomes = [];
          }

          allMarkets.push({
            id: m.id,
            conditionId: m.conditionId || m.condition_id || '',
            slug: m.slug || m.id,
            question: m.question || '',
            groupSlug: m.groupSlug || m.group_slug || '',
            eventSlug: m.eventSlug || '',
            outcomes,
            tokenIds,
            outcomePrices: outcomePrices.map(Number),
            volume: parseFloat(m.volume || m.volumeNum || 0),
            liquidity: parseFloat(m.liquidityNum || m.liquidity || 0),
            active: m.active !== false && m.closed !== true,
          });
        }

        offset += data.length;
        if (data.length < limit) break; // no more pages
        await sleep(300); // gentle rate limiting
      }
    } catch (err) {
      insertLog('ERROR', 'scanner', `Gamma API fetch failed: ${err.message}`);
    }

    return allMarkets;
  }

  /**
   * Fetch orderbook for a single token from CLOB API.
   * Returns { asks: [{price, size}], bids: [{price, size}] }
   */
  async fetchOrderbook(tokenId) {
    try {
      const { data } = await axios.get(`${CLOB_BASE}/book`, {
        params: { token_id: tokenId },
        timeout: 10000
      });
      return {
        asks: (data.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
        bids: (data.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      };
    } catch (err) {
      // Silently return empty — orderbooks fail often for illiquid markets
      return { asks: [], bids: [] };
    }
  }

  /**
   * Batch fetch orderbooks for multiple tokens with rate limiting.
   * Returns Map<tokenId, orderbook>
   */
  async fetchOrderbooks(tokenIds) {
    const books = new Map();
    for (const tid of tokenIds) {
      books.set(tid, await this.fetchOrderbook(tid));
      await sleep(150); // ~6 req/sec to avoid throttling
    }
    return books;
  }

  /**
   * Full scan: fetch markets, group by event, return enriched data.
   */
  async scan(maxMarkets = 200) {
    if (this.scanning) return this.markets;
    this.scanning = true;

    try {
      insertLog('INFO', 'scanner', `Starting market scan (max ${maxMarkets})...`);
      const markets = await this.fetchMarkets(maxMarkets);

      // Group by event for combinatorial strategy
      this.eventGroups = {};
      for (const m of markets) {
        const key = m.groupSlug || m.eventSlug || 'ungrouped';
        if (!this.eventGroups[key]) this.eventGroups[key] = [];
        this.eventGroups[key].push(m);
      }

      this.markets = markets;
      this.lastScanTime = new Date().toISOString();
      insertLog('INFO', 'scanner', `Scan complete: ${markets.length} active markets, ${Object.keys(this.eventGroups).length} event groups`);

      return markets;
    } catch (err) {
      insertLog('ERROR', 'scanner', `Scan failed: ${err.message}`);
      return this.markets; // return stale data
    } finally {
      this.scanning = false;
    }
  }
}

export default MarketScanner;
