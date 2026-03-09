import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'moneyz.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    paper_mode        INTEGER NOT NULL DEFAULT 1,
    active_exchange   TEXT NOT NULL DEFAULT 'polymarket',

    /* Polymarket credentials */
    api_key           TEXT NOT NULL DEFAULT '',
    api_secret        TEXT NOT NULL DEFAULT '',
    api_passphrase    TEXT NOT NULL DEFAULT '',
    private_key       TEXT NOT NULL DEFAULT '',
    funder_address    TEXT NOT NULL DEFAULT '',

    /* Alpaca credentials */
    alpaca_key_id     TEXT NOT NULL DEFAULT '',
    alpaca_secret_key TEXT NOT NULL DEFAULT '',
    alpaca_base_url   TEXT NOT NULL DEFAULT 'https://paper-api.alpaca.markets',

    /* Alpaca strategy config */
    alpaca_symbols    TEXT NOT NULL DEFAULT 'AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,JPM,BAC,GS',
    lookback_days     INTEGER NOT NULL DEFAULT 30,
    zscore_entry      REAL NOT NULL DEFAULT 2.0,
    zscore_exit       REAL NOT NULL DEFAULT 0.5,

    /* Shared bot parameters */
    max_position_usd  REAL NOT NULL DEFAULT 10.0,
    scan_interval_sec INTEGER NOT NULL DEFAULT 30,
    min_spread_pct    REAL NOT NULL DEFAULT 0.5,
    max_markets       INTEGER NOT NULL DEFAULT 200
  );

  CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id        TEXT UNIQUE NOT NULL,
    strategy        TEXT NOT NULL,
    exchange        TEXT NOT NULL DEFAULT 'polymarket',
    symbol          TEXT NOT NULL DEFAULT '',
    market_slug     TEXT NOT NULL DEFAULT '',
    market_question TEXT NOT NULL DEFAULT '',
    tokens          TEXT NOT NULL DEFAULT '[]',
    side            TEXT NOT NULL,
    size            REAL NOT NULL DEFAULT 0,
    price           REAL NOT NULL DEFAULT 0,
    cost            REAL NOT NULL DEFAULT 0,
    expected_profit REAL NOT NULL DEFAULT 0,
    actual_pnl      REAL DEFAULT NULL,
    status          TEXT NOT NULL DEFAULT 'executed',
    timestamp       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opportunities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy        TEXT NOT NULL,
    exchange        TEXT NOT NULL DEFAULT 'polymarket',
    symbol          TEXT NOT NULL DEFAULT '',
    market_slug     TEXT NOT NULL DEFAULT '',
    market_question TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    spread          REAL NOT NULL DEFAULT 0,
    zscore          REAL DEFAULT NULL,
    tokens          TEXT NOT NULL DEFAULT '[]',
    timestamp       TEXT NOT NULL,
    acted_on        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    level     TEXT NOT NULL DEFAULT 'INFO',
    source    TEXT NOT NULL DEFAULT 'system',
    message   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
`);

// ── Auto-migration: add columns if upgrading from old schema ────────────────

function addColumnIfMissing(table, column, type, defaultVal) {
  try {
    db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
  } catch {
    const def = defaultVal !== undefined
      ? ` DEFAULT ${typeof defaultVal === 'string' ? `'${defaultVal}'` : defaultVal}`
      : '';
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} NOT NULL${def}`);
  }
}

addColumnIfMissing('settings', 'active_exchange', 'TEXT', 'polymarket');
addColumnIfMissing('settings', 'alpaca_key_id', 'TEXT', '');
addColumnIfMissing('settings', 'alpaca_secret_key', 'TEXT', '');
addColumnIfMissing('settings', 'alpaca_base_url', 'TEXT', 'https://paper-api.alpaca.markets');
addColumnIfMissing('settings', 'alpaca_symbols', 'TEXT', 'AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,JPM,BAC,GS');
addColumnIfMissing('settings', 'lookback_days', 'INTEGER', 30);
addColumnIfMissing('settings', 'zscore_entry', 'REAL', 2.0);
addColumnIfMissing('settings', 'zscore_exit', 'REAL', 0.5);
addColumnIfMissing('trades', 'exchange', 'TEXT', 'polymarket');
addColumnIfMissing('trades', 'symbol', 'TEXT', '');
addColumnIfMissing('trades', 'price', 'REAL', 0);
addColumnIfMissing('opportunities', 'exchange', 'TEXT', 'polymarket');
addColumnIfMissing('opportunities', 'symbol', 'TEXT', '');
addColumnIfMissing('opportunities', 'zscore', 'REAL', 0);

// Seed default settings row if missing
db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();

// ── Helpers ─────────────────────────────────────────────────────────────────

const stmtCache = new Map();

function prepare(sql) {
  if (!stmtCache.has(sql)) stmtCache.set(sql, db.prepare(sql));
  return stmtCache.get(sql);
}

export function getSettings() {
  return prepare('SELECT * FROM settings WHERE id = 1').get();
}

export function updateSettings(fields) {
  const allowed = [
    'paper_mode', 'active_exchange',
    'api_key', 'api_secret', 'api_passphrase', 'private_key', 'funder_address',
    'alpaca_key_id', 'alpaca_secret_key', 'alpaca_base_url',
    'alpaca_symbols', 'lookback_days', 'zscore_entry', 'zscore_exit',
    'max_position_usd', 'scan_interval_sec', 'min_spread_pct', 'max_markets'
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  vals.push(1);
  db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertTrade(trade) {
  return prepare(`
    INSERT INTO trades (trade_id, strategy, exchange, symbol, market_slug, market_question, tokens, side, size, price, cost, expected_profit, actual_pnl, status, timestamp)
    VALUES (@trade_id, @strategy, @exchange, @symbol, @market_slug, @market_question, @tokens, @side, @size, @price, @cost, @expected_profit, @actual_pnl, @status, @timestamp)
  `).run(trade);
}

export function getTrades(limit = 50, exchange = null) {
  if (exchange) {
    return prepare('SELECT * FROM trades WHERE exchange = ? ORDER BY id DESC LIMIT ?').all(exchange, limit);
  }
  return prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
}

export function insertOpportunity(opp) {
  return prepare(`
    INSERT INTO opportunities (strategy, exchange, symbol, market_slug, market_question, description, spread, zscore, tokens, timestamp, acted_on)
    VALUES (@strategy, @exchange, @symbol, @market_slug, @market_question, @description, @spread, @zscore, @tokens, @timestamp, @acted_on)
  `).run(opp);
}

export function getOpportunities(limit = 30, exchange = null) {
  if (exchange) {
    return prepare('SELECT * FROM opportunities WHERE exchange = ? ORDER BY id DESC LIMIT ?').all(exchange, limit);
  }
  return prepare('SELECT * FROM opportunities ORDER BY id DESC LIMIT ?').all(limit);
}

export function insertLog(level, source, message) {
  return prepare(`
    INSERT INTO logs (level, source, message, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(level, source, message, new Date().toISOString());
}

export function getLogs(limit = 80) {
  return prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

export function getStats(exchange = null) {
  const exWhere = exchange ? `WHERE exchange = '${exchange}'` : '';
  const exAnd = exchange ? `AND exchange = '${exchange}'` : '';

  const totalTrades = prepare(`SELECT COUNT(*) as cnt FROM trades ${exWhere}`).get().cnt;
  const totalPnl = prepare(`SELECT COALESCE(SUM(expected_profit), 0) as total FROM trades ${exWhere}`).get().total;
  const wins = prepare(`SELECT COUNT(*) as cnt FROM trades ${exWhere} ${exWhere ? 'AND' : 'WHERE'} expected_profit > 0`).get().cnt;
  const tradesToday = prepare(`SELECT COUNT(*) as cnt FROM trades WHERE timestamp >= date('now') ${exAnd}`).get().cnt;
  const marketsScanned = prepare(`SELECT COUNT(DISTINCT CASE WHEN symbol != '' THEN symbol ELSE market_slug END) as cnt FROM opportunities WHERE timestamp >= datetime("now", "-1 hour") ${exAnd}`).get().cnt;
  const activeOpps = prepare(`SELECT COUNT(*) as cnt FROM opportunities WHERE timestamp >= datetime("now", "-5 minutes") AND acted_on = 0 ${exAnd}`).get().cnt;

  return {
    totalTrades,
    totalPnl: Math.round(totalPnl * 10000) / 10000,
    winRate: totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0,
    tradesToday,
    marketsScanned,
    activeOpps
  };
}

export function clearData(table) {
  const allowed = ['trades', 'opportunities', 'logs'];
  if (allowed.includes(table)) db.exec(`DELETE FROM ${table}`);
}

export default db;
