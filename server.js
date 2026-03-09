/**
 * server.js — Express API + Static Dashboard Server
 *
 * Single entry point: `node server.js` starts everything:
 * - SQLite database (auto-created)
 * - Arbitrage bot (scanner + strategies + executor)
 * - REST API for the dashboard
 * - Static file serving for the UI
 *
 * Supports both Polymarket and Alpaca exchanges.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ArbBot } from './bot.js';
import {
  getSettings, updateSettings,
  getTrades, getOpportunities, getLogs,
  getStats, clearData, insertLog
} from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4173;
const app = express();
const bot = new ArbBot();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Status & Stats ──────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  try {
    res.json(bot.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const exchange = req.query.exchange || null;
    res.json(getStats(exchange));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bot Controls ────────────────────────────────────────────────────────────

app.post('/api/bot/start', (_req, res) => {
  if (!bot.running) {
    bot.start().catch(err => {
      insertLog('ERROR', 'server', `Bot crashed: ${err.message}`);
    });
    res.json({ success: true, running: true });
  } else {
    res.json({ success: false, message: 'Bot already running', running: true });
  }
});

app.post('/api/bot/stop', (_req, res) => {
  bot.stop();
  res.json({ success: true, running: false });
});

app.post('/api/bot/pause', (_req, res) => {
  bot.togglePause();
  res.json({ success: true, paused: bot.paused });
});

// ── Exchange Switching ──────────────────────────────────────────────────────

app.post('/api/exchange/:name', (req, res) => {
  try {
    const name = req.params.name;
    if (!['polymarket', 'alpaca'].includes(name)) {
      return res.status(400).json({ error: 'Invalid exchange. Use: polymarket, alpaca' });
    }
    updateSettings({ active_exchange: name });
    insertLog('INFO', 'server', `Exchange switched to: ${name.toUpperCase()}`);
    res.json({ success: true, active_exchange: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Alpaca API Proxy ────────────────────────────────────────────────────────

app.get('/api/alpaca/account', async (_req, res) => {
  try {
    const client = bot.getAlpacaClient();
    if (!client || !client.isConfigured) {
      return res.status(400).json({ error: 'Alpaca not configured. Add API keys in Settings.' });
    }
    const account = await client.getAccount();
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.get('/api/alpaca/positions', async (_req, res) => {
  try {
    const client = bot.getAlpacaClient();
    if (!client || !client.isConfigured) {
      return res.status(400).json({ error: 'Alpaca not configured' });
    }
    const positions = await client.getPositions();
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.get('/api/alpaca/orders', async (req, res) => {
  try {
    const client = bot.getAlpacaClient();
    if (!client || !client.isConfigured) {
      return res.status(400).json({ error: 'Alpaca not configured' });
    }
    const status = req.query.status || 'open';
    const orders = await client.getOrders(status);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/alpaca/close-all', async (_req, res) => {
  try {
    const client = bot.getAlpacaClient();
    if (!client || !client.isConfigured) {
      return res.status(400).json({ error: 'Alpaca not configured' });
    }
    const result = await client.closeAllPositions(true);
    insertLog('TRADE', 'server', 'Close-all positions requested via API');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/alpaca/close/:symbol', async (req, res) => {
  try {
    const client = bot.getAlpacaClient();
    if (!client || !client.isConfigured) {
      return res.status(400).json({ error: 'Alpaca not configured' });
    }
    const result = await client.closePosition(req.params.symbol);
    insertLog('TRADE', 'server', `Close position: ${req.params.symbol}`);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Opportunities ───────────────────────────────────────────────────────────

app.get('/api/opportunities', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const exchange = req.query.exchange || null;
    res.json(getOpportunities(limit, exchange));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trades ──────────────────────────────────────────────────────────────────

app.get('/api/trades', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const exchange = req.query.exchange || null;
    res.json(getTrades(limit, exchange));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logs ────────────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 80;
    res.json(getLogs(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  try {
    const s = getSettings();
    // Mask sensitive fields
    res.json({
      ...s,
      api_key: s.api_key ? '****' + s.api_key.slice(-4) : '',
      api_secret: s.api_secret ? '********' : '',
      api_passphrase: s.api_passphrase ? '********' : '',
      private_key: s.private_key ? '********' : '',
      alpaca_key_id: s.alpaca_key_id ? '****' + s.alpaca_key_id.slice(-4) : '',
      alpaca_secret_key: s.alpaca_secret_key ? '********' : '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updates = {};
    const body = req.body;

    // Boolean toggle
    if (body.paper_mode !== undefined) {
      updates.paper_mode = (body.paper_mode === true || body.paper_mode === 1 || body.paper_mode === 'true') ? 1 : 0;
    }

    // Exchange toggle
    if (body.active_exchange && ['polymarket', 'alpaca'].includes(body.active_exchange)) {
      updates.active_exchange = body.active_exchange;
    }

    // Numeric settings
    if (body.max_position_usd !== undefined) updates.max_position_usd = parseFloat(body.max_position_usd) || 10;
    if (body.scan_interval_sec !== undefined) updates.scan_interval_sec = parseInt(body.scan_interval_sec) || 30;
    if (body.min_spread_pct !== undefined) updates.min_spread_pct = parseFloat(body.min_spread_pct) || 0.5;
    if (body.max_markets !== undefined) updates.max_markets = parseInt(body.max_markets) || 200;

    // Alpaca numeric settings
    if (body.lookback_days !== undefined) updates.lookback_days = parseInt(body.lookback_days) || 30;
    if (body.zscore_entry !== undefined) updates.zscore_entry = parseFloat(body.zscore_entry) || 2.0;
    if (body.zscore_exit !== undefined) updates.zscore_exit = parseFloat(body.zscore_exit) || 0.5;

    // Alpaca string settings
    if (body.alpaca_symbols) updates.alpaca_symbols = body.alpaca_symbols;
    if (body.alpaca_base_url) updates.alpaca_base_url = body.alpaca_base_url;

    // Polymarket credential fields — only update if not masked
    if (body.api_key && !body.api_key.includes('****')) updates.api_key = body.api_key;
    if (body.api_secret && body.api_secret !== '********') updates.api_secret = body.api_secret;
    if (body.api_passphrase && body.api_passphrase !== '********') updates.api_passphrase = body.api_passphrase;
    if (body.private_key && body.private_key !== '********') updates.private_key = body.private_key;
    if (body.funder_address) updates.funder_address = body.funder_address;

    // Alpaca credential fields — only update if not masked
    if (body.alpaca_key_id && !body.alpaca_key_id.includes('****')) updates.alpaca_key_id = body.alpaca_key_id;
    if (body.alpaca_secret_key && body.alpaca_secret_key !== '********') updates.alpaca_secret_key = body.alpaca_secret_key;

    updateSettings(updates);
    insertLog('INFO', 'server', `Settings updated: ${Object.keys(updates).join(', ')}`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Data Management ─────────────────────────────────────────────────────────

app.post('/api/clear/:table', (req, res) => {
  try {
    clearData(req.params.table);
    insertLog('INFO', 'server', `Cleared table: ${req.params.table}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  const settings = getSettings();
  res.json({
    ok: true,
    mode: settings.paper_mode === 1 ? 'paper' : 'live',
    exchange: settings.active_exchange || 'polymarket',
    botRunning: bot.running,
    uptime: process.uptime()
  });
});

// ── SPA Fallback ────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const settings = getSettings();
  console.log(`\n  moneyz arbitrage bot`);
  console.log(`  Exchange:   ${(settings.active_exchange || 'polymarket').toUpperCase()}`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/health`);
  console.log();
  insertLog('INFO', 'server', `Server started on port ${PORT} — exchange: ${settings.active_exchange || 'polymarket'}`);
});
