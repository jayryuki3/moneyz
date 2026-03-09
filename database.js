import sqlite3 from 'sqlite3';
const sqlite3Verbose = sqlite3.verbose();
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = path.join(__dirname, 'bot.db');
const db = new sqlite3Verbose.Database(dbPath);

const run = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const get = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const all = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const initializeDB = async () => {
    await run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        paper_mode BOOLEAN,
        api_key TEXT,
        api_secret TEXT,
        api_passphrase TEXT,
        wallet_address TEXT,
        private_key TEXT
    )`);

    await run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        trade_id TEXT,
        market TEXT,
        side TEXT,
        size REAL,
        price REAL,
        timestamp TEXT
    )`);

    await run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY,
        level TEXT,
        message TEXT,
        timestamp TEXT
    )`);
};

export { db, run, get, all, initializeDB };