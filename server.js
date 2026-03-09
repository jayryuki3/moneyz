import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDB, get, all, run } from './database.js';
import { PolymarketArbBot } from './bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new PolymarketArbBot();

// Endpoints
app.get('/api/status', async (req, res) => {
    try {
        const logs = await all('SELECT * FROM logs ORDER BY id DESC LIMIT 15');
        const settings = await get('SELECT paper_mode FROM settings WHERE id = 1');
        res.json({
            isRunning: bot.isRunning,
            paperMode: settings ? (settings.paper_mode === 1 || settings.paper_mode === 'true') : true,
            plannedActions: bot.plannedActions,
            logs: logs || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/trades', async (req, res) => {
    try {
        const trades = await all('SELECT * FROM trades ORDER BY id DESC LIMIT 50');
        res.json(trades || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const settings = await get('SELECT * FROM settings WHERE id = 1') || {};
        if (settings.api_key) settings.api_key = '****' + settings.api_key.slice(-4);
        if (settings.api_secret) settings.api_secret = '********';
        if (settings.private_key) settings.private_key = '********';
        if (settings.api_passphrase) settings.api_passphrase = '********';
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/settings', async (req, res) => {
    const { paper_mode, api_key, api_secret, api_passphrase, private_key } = req.body;
    try {
        const existing = await get('SELECT id FROM settings WHERE id = 1');
        const pMode = (paper_mode === true || paper_mode === 1 || paper_mode === 'true' || paper_mode === "1") ? 1 : 0;
        
        if (existing) {
            const updates = ['paper_mode = ?'];
            const values = [pMode];
            
            if (api_key && !api_key.includes('*')) {
                updates.push('api_key = ?'); values.push(api_key);
            }
            if (api_secret && api_secret !== '********') {
                updates.push('api_secret = ?'); values.push(api_secret);
            }
            if (api_passphrase && api_passphrase !== '********') {
                updates.push('api_passphrase = ?'); values.push(api_passphrase);
            }
            if (private_key && private_key !== '********') {
                updates.push('private_key = ?'); values.push(private_key);
            }
            
            values.push(1);
            await run(`UPDATE settings SET ${updates.join(', ')} WHERE id = ?`, values);
        } else {
            await run(
                `INSERT INTO settings (id, paper_mode, api_key, api_secret, api_passphrase, private_key) VALUES (?, ?, ?, ?, ?, ?)`,
                [1, pMode, api_key || '', api_secret || '', api_passphrase || '', private_key || '']
            );
        }
        
        await bot.loadConfig();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bot/start', async (req, res) => {
    if (!bot.isRunning) {
        // Default condition tokens for testing if none provided
        const defaultTokens = req.body.tokens || ['TOKEN_A_TEST', 'TOKEN_B_TEST'];
        bot.startScanning(5000, defaultTokens).catch(err => console.error("Scanner error:", err));
    }
    res.json({ success: true, isRunning: bot.isRunning });
});

app.post('/api/bot/stop', async (req, res) => {
    if (bot.isRunning) {
        bot.stopScanning();
    }
    res.json({ success: true, isRunning: false });
});

// Initialize database, load bot config, then start server
const PORT = process.env.PORT || 3000;
initializeDB()
    .then(() => bot.loadConfig())
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Moneyz Server listening on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize DB/Server:', err);
        process.exit(1);
    });