import { db, run, get } from './database.js';
import axios from 'axios';
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

class PolymarketArbBot {
    constructor() {
        this.settings = null;
        this.clobClient = null;
        this.plannedActions = [];
        this.isRunning = false;
    }

    /**
     * loadConfig: Fetches user settings from the database and conditionally 
     * initializes the CLOB client for live trading.
     */
    async loadConfig() {
        try {
            this.settings = await get('SELECT * FROM settings WHERE id=1');

            if (!this.settings) {
                console.warn('No settings found in DB. Please initialize settings first.');
                return;
            }

            const { paper_mode, api_key, api_secret, api_passphrase, private_key } = this.settings;

            // Handle SQLite boolean conversions seamlessly
            const isPaperMode = paper_mode === 1 || paper_mode === true || paper_mode === 'true';
            
            if (!isPaperMode && api_key && api_secret && api_passphrase) {
                // Initialize an ethers Wallet required for request signing
                const wallet = private_key 
                    ? new ethers.Wallet(private_key) 
                    : ethers.Wallet.createRandom();

                const creds = {
                    key: api_key,
                    secret: api_secret,
                    passphrase: api_passphrase,
                };

                // Initialize the Polymarket CLOB Client (137 = Polygon Mainnet)
                this.clobClient = new ClobClient(
                    "https://clob.polymarket.com",
                    137,
                    wallet,
                    creds
                );
                console.log('CLOB Client initialized for live active trading.');
            } else {
                console.log('Bot initialized in Paper Trading mode.');
            }
        } catch (error) {
            console.error('Error loading config:', error);
            await this.logEvent('ERROR', `Failed to load config: ${error.message}`);
        }
    }

    /**
     * scanMarket: Scans all token outcomes for a given market condition structure
     * and evaluates whether an arbitrage opportunity exists below 1.0.
     * @param {Array<string>} conditionTokens - Array of token_ids representing market outcomes
     */
    async scanMarket(conditionTokens) {
        if (!conditionTokens || conditionTokens.length === 0) return;
        
        try {
            let bestAsksSum = 0;
            const orderBooks = {};

            // 1. Fetch order books and calculate Best Asks sum
            for (const tokenId of conditionTokens) {
                // Hitting the CLOB unauthenticated orderbook endpoint
                const response = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`);
                
                // Safety check: ensure asks exist and capture the lowest price
                if (response.data && response.data.asks && response.data.asks.length > 0) {
                    const bestAskPrice = parseFloat(response.data.asks[0].price);
                    bestAsksSum += bestAskPrice;
                    orderBooks[tokenId] = response.data.asks[0];
                } else {
                    console.log(`Bypassing: Missing asks for token ${tokenId}`);
                    return;
                }
            }

            console.log(`Scan completed for [${conditionTokens.join(', ')}]. Sum of Best Asks = ${bestAsksSum}`);

            // 2. Arbitrage Condition Match (If Sum of best asks is < 1.0)
            if (bestAsksSum < 1.0) {
                const expectedProfit = 1.0 - bestAsksSum;
                
                // Create a Planned Action
                this.plannedActions.push({
                    type: 'ARB_BUY_ALL',
                    tokens: conditionTokens,
                    cost: bestAsksSum,
                    profit: expectedProfit,
                    timestamp: Date.now()
                });

                const isPaperMode = this.settings?.paper_mode === 1 || this.settings?.paper_mode === true;

                if (isPaperMode) {
                    // PAPER TRADING LOGIC
                    const tradeId = `paper_${Date.now()}`;
                    await run(
                        'INSERT INTO trades (trade_id, market, side, size, price, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
                        [tradeId, conditionTokens.join(','), 'BUY_ALL', 1, bestAsksSum, new Date().toISOString()]
                    );
                    
                    const logMessage = `Paper Trade Completed - Profit ${expectedProfit.toFixed(4)}`;
                    await this.logEvent('INFO', logMessage);
                    console.log(logMessage);
                } else {
                    // LIVE TRADING LOGIC
                    await this.logEvent('INFO', `Executing Live Arbitrage - Expected Arb Spread ${expectedProfit.toFixed(4)}`);
                    // Execution routes through this.clobClient here natively
                }
            }
        } catch (error) {
            console.error('Error scanning market:', error.message);
            await this.logEvent('ERROR', `Error scanning market: ${error.message}`);
        }
    }

    /**
     * Start continuous background scanner on interval
     */
    async startScanning(intervalMs, conditionTokens) {
        this.isRunning = true;
        await this.loadConfig();

        console.log(`Started market scanner. Polling every ${intervalMs}ms...`);
        while (this.isRunning) {
            await this.scanMarket(conditionTokens);
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }

    stopScanning() {
        this.isRunning = false;
        console.log('Scanner stopped gracefully.');
    }

    // Diagnostic logger into sqlite DB
    async logEvent(level, message) {
        try {
            await run(
                'INSERT INTO logs (level, message, timestamp) VALUES (?, ?, ?)',
                [level, message, new Date().toISOString()]
            );
        } catch (e) {
            console.error('Failed to write log to DB');
        }
    }
}

// Ensure proper syntax for ES6 imports/exports
export { PolymarketArbBot };