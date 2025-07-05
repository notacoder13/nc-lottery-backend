// NC Lottery Backend Server
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Data storage
let lotteryData = {
    scratchOffs: [],
    drawGames: [],
    lastUpdated: null
};

// Cache file path
const CACHE_FILE = path.join(__dirname, 'lottery_cache.json');

// NC Lottery URLs
const NC_LOTTERY_URLS = {
    scratchOffs: 'https://nclottery.com/Scratch-Offs',
    prizesRemaining: 'https://nclottery.com/Scratch-Off-Prizes-Remaining',
    drawGames: 'https://nclottery.com/Draw-Games',
    powerball: 'https://nclottery.com/Powerball',
    megaMillions: 'https://nclottery.com/Mega-Millions'
};

// Helper function to parse price from string
function parsePrice(priceStr) {
    const match = priceStr.match(/\$?(\d+(?:\.\d{2})?)/);
    return match ? parseFloat(match[1]) : 0;
}

// Helper function to parse odds
function parseOdds(oddsStr) {
    if (!oddsStr) return null;
    const match = oddsStr.match(/1\s*in\s*([\d,]+(?:\.\d+)?)/i);
    return match ? `1 in ${match[1]}` : oddsStr;
}

// Helper function to parse prize amounts
function parsePrizeAmount(prizeStr) {
    if (!prizeStr) return 0;
    const cleanStr = prizeStr.replace(/[\$,]/g, '');
    const match = cleanStr.match(/(\d+(?:\.\d{2})?)/);
    return match ? parseFloat(match[1]) : 0;
}

// Scrape scratch-off games
async function scrapeScratchOffs() {
    try {
        console.log('🔍 Scraping scratch-off games...');
        
        const response = await axios.get(NC_LOTTERY_URLS.scratchOffs, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const games = [];
        
        // Look for game containers (adjust selectors based on actual HTML structure)
        $('.game-tile, .scratch-game, .game-card, .game-item').each((index, element) => {
            const $element = $(element);
            
            // Extract game information
            const name = $element.find('.game-name, .title, h3, h4').first().text().trim();
            const priceText = $element.find('.price, .cost, .game-price').first().text().trim();
            const oddsText = $element.find('.odds, .overall-odds').first().text().trim();
            const topPrizeText = $element.find('.top-prize, .max-prize').first().text().trim();
            
            if (name && priceText) {
                const game = {
                    id: `scratch_${index + 1}`,
                    name: name,
                    type: 'scratch-off',
                    price: parsePrice(priceText),
                    overallOdds: parseOdds(oddsText) || '1 in 4.0',
                    topPrize: parsePrizeAmount(topPrizeText) || 0,
                    topPrizeRemaining: 0, // Will be updated from prizes remaining page
                    expectedValue: 0.5, // Default, will calculate later
                    prizes: [],
                    gameNumber: $element.find('.game-number').text().trim() || '',
                    lastUpdated: new Date().toISOString()
                };
                
                games.push(game);
            }
        });
        
        // If no games found with specific selectors, try broader search
        if (games.length === 0) {
            $('table tr, .row, .game-row').each((index, element) => {
                const $element = $(element);
                const cells = $element.find('td, .cell, .col');
                
                if (cells.length >= 2) {
                    const name = cells.eq(0).text().trim();
                    const priceText = cells.eq(1).text().trim();
                    const oddsText = cells.eq(2).text().trim();
                    
                    if (name && priceText && name.length > 3) {
                        games.push({
                            id: `scratch_${index + 1}`,
                            name: name,
                            type: 'scratch-off',
                            price: parsePrice(priceText),
                            overallOdds: parseOdds(oddsText) || '1 in 4.0',
                            topPrize: 0,
                            topPrizeRemaining: 0,
                            expectedValue: 0.5,
                            prizes: [],
                            lastUpdated: new Date().toISOString()
                        });
                    }
                }
            });
        }
        
        console.log(`✅ Found ${games.length} scratch-off games`);
        return games;
        
    } catch (error) {
        console.error('❌ Error scraping scratch-offs:', error.message);
        return [];
    }
}

// Scrape prizes remaining data
async function scrapePrizesRemaining() {
    try {
        console.log('🔍 Scraping prizes remaining...');
        
        const response = await axios.get(NC_LOTTERY_URLS.prizesRemaining, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        const prizesData = {};
        
        // Look for prize tables
        $('table tbody tr, .prize-row').each((index, element) => {
            const $element = $(element);
            const cells = $element.find('td, .cell');
            
            if (cells.length >= 4) {
                const gameNumber = cells.eq(0).text().trim();
                const gameName = cells.eq(1).text().trim();
                const prizeAmount = cells.eq(2).text().trim();
                const remaining = cells.eq(3).text().trim();
                
                if (gameNumber && gameName) {
                    if (!prizesData[gameNumber]) {
                        prizesData[gameNumber] = {
                            name: gameName,
                            prizes: []
                        };
                    }
                    
                    prizesData[gameNumber].prizes.push({
                        amount: parsePrizeAmount(prizeAmount),
                        remaining: parseInt(remaining) || 0
                    });
                }
            }
        });
        
        console.log(`✅ Found prize data for ${Object.keys(prizesData).length} games`);
        return prizesData;
        
    } catch (error) {
        console.error('❌ Error scraping prizes remaining:', error.message);
        return {};
    }
}

// Scrape draw games
async function scrapeDrawGames() {
    try {
        console.log('🔍 Scraping draw games...');
        
        const games = [];
        
        // Scrape Powerball
        try {
            const powResponse = await axios.get(NC_LOTTERY_URLS.powerball, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            const $pow = cheerio.load(powResponse.data);
            const jackpotText = $pow('.jackpot-amount, .current-jackpot, .prize-amount').first().text().trim();
            
            games.push({
                id: 'powerball',
                name: 'Powerball',
                type: 'draw',
                price: 2,
                overallOdds: '1 in 24.9',
                topPrize: parsePrizeAmount(jackpotText) || 20000000,
                topPrizeRemaining: 1,
                expectedValue: 0.3,
                prizes: [
                    { amount: parsePrizeAmount(jackpotText) || 20000000, remaining: 1 },
                    { amount: 1000000, remaining: 1 },
                    { amount: 50000, remaining: 1 },
                    { amount: 100, remaining: 1 }
                ],
                lastUpdated: new Date().toISOString()
            });
        } catch (error) {
            console.warn('Could not fetch Powerball data:', error.message);
        }
        
        // Scrape Mega Millions
        try {
            const megResponse = await axios.get(NC_LOTTERY_URLS.megaMillions, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            const $meg = cheerio.load(megResponse.data);
            const jackpotText = $meg('.jackpot-amount, .current-jackpot, .prize-amount').first().text().trim();
            
            games.push({
                id: 'megamillions',
                name: 'Mega Millions',
                type: 'draw',
                price: 2,
                overallOdds: '1 in 24.0',
                topPrize: parsePrizeAmount(jackpotText) || 20000000,
                topPrizeRemaining: 1,
                expectedValue: 0.28,
                prizes: [
                    { amount: parsePrizeAmount(jackpotText) || 20000000, remaining: 1 },
                    { amount: 1000000, remaining: 1 },
                    { amount: 10000, remaining: 1 },
                    { amount: 200, remaining: 1 }
                ],
                lastUpdated: new Date().toISOString()
            });
        } catch (error) {
            console.warn('Could not fetch Mega Millions data:', error.message);
        }
        
        console.log(`✅ Found ${games.length} draw games`);
        return games;
        
    } catch (error) {
        console.error('❌ Error scraping draw games:', error.message);
        return [];
    }
}

// Calculate expected value for games
function calculateExpectedValue(game) {
    if (!game.prizes || game.prizes.length === 0) return 0.5;
    
    let totalValue = 0;
    let totalTickets = 0;
    
    game.prizes.forEach(prize => {
        totalValue += prize.amount * prize.remaining;
        totalTickets += prize.remaining;
    });
    
    // Add losing tickets (estimated based on odds)
    const oddsMatch = game.overallOdds.match(/1\s*in\s*([\d,]+(?:\.\d+)?)/i);
    if (oddsMatch) {
        const odds = parseFloat(oddsMatch[1].replace(/,/g, ''));
        const losingTickets = Math.max(0, totalTickets * (odds - 1));
        totalTickets += losingTickets;
    }
    
    return totalTickets > 0 ? (totalValue / totalTickets) / game.price : 0.5;
}

// Update lottery data
async function updateLotteryData() {
    try {
        console.log('🔄 Updating lottery data...');
        
        // Scrape all data
        const [scratchOffs, prizesRemaining, drawGames] = await Promise.all([
            scrapeScratchOffs(),
            scrapePrizesRemaining(),
            scrapeDrawGames()
        ]);
        
        // Merge scratch-off data with prizes remaining
        const updatedScratchOffs = scratchOffs.map(game => {
            const gameNumber = game.gameNumber;
            const prizeData = prizesRemaining[gameNumber];
            
            if (prizeData) {
                game.prizes = prizeData.prizes.sort((a, b) => b.amount - a.amount);
                game.topPrize = game.prizes[0]?.amount || 0;
                game.topPrizeRemaining = game.prizes[0]?.remaining || 0;
            }
            
            // Calculate expected value
            game.expectedValue = calculateExpectedValue(game);
            
            return game;
        });
        
        // Update global data
        lotteryData = {
            scratchOffs: updatedScratchOffs,
            drawGames: drawGames,
            lastUpdated: new Date().toISOString()
        };
        
        // Cache the data
        await fs.writeFile(CACHE_FILE, JSON.stringify(lotteryData, null, 2));
        
        console.log(`✅ Updated lottery data: ${updatedScratchOffs.length} scratch-offs, ${drawGames.length} draw games`);
        
    } catch (error) {
        console.error('❌ Error updating lottery data:', error.message);
    }
}

// Load cached data on startup
async function loadCachedData() {
    try {
        const cachedData = await fs.readFile(CACHE_FILE, 'utf8');
        lotteryData = JSON.parse(cachedData);
        console.log('📂 Loaded cached lottery data');
    } catch (error) {
        console.log('📂 No cached data found, will fetch fresh data');
        await updateLotteryData();
    }
}

// API Routes
app.get('/api/games', (req, res) => {
    const allGames = [...lotteryData.scratchOffs, ...lotteryData.drawGames];
    res.json({
        games: allGames,
        lastUpdated: lotteryData.lastUpdated,
        total: allGames.length
    });
});

app.get('/api/games/scratch-offs', (req, res) => {
    res.json({
        games: lotteryData.scratchOffs,
        lastUpdated: lotteryData.lastUpdated,
        total: lotteryData.scratchOffs.length
    });
});

app.get('/api/games/draw-games', (req, res) => {
    res.json({
        games: lotteryData.drawGames,
        lastUpdated: lotteryData.lastUpdated,
        total: lotteryData.drawGames.length
    });
});

app.get('/api/refresh', async (req, res) => {
    try {
        await updateLotteryData();
        res.json({
            success: true,
            message: 'Data refreshed successfully',
            lastUpdated: lotteryData.lastUpdated
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to refresh data',
            error: error.message
        });
    }
});

app.get('/api/stats', (req, res) => {
    const allGames = [...lotteryData.scratchOffs, ...lotteryData.drawGames];
    
    if (allGames.length === 0) {
        return res.json({
            totalGames: 0,
            bestOdds: null,
            biggestPrize: 0,
            bestValue: 0
        });
    }
    
    const bestOddsGame = allGames.reduce((best, game) => {
        const currentOdds = parseFloat(game.overallOdds.match(/[\d.]+/)?.[0] || '999');
        const bestOdds = parseFloat(best.overallOdds.match(/[\d.]+/)?.[0] || '999');
        return currentOdds < bestOdds ? game : best;
    });
    
    const biggestPrizeGame = allGames.reduce((biggest, game) => 
        game.topPrize > biggest.topPrize ? game : biggest
    );
    
    const bestValueGame = allGames.reduce((best, game) => 
        game.expectedValue > best.expectedValue ? game : best
    );
    
    res.json({
        totalGames: allGames.length,
        bestOdds: bestOddsGame.overallOdds,
        biggestPrize: biggestPrizeGame.topPrize,
        bestValue: bestValueGame.expectedValue
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        dataAge: lotteryData.lastUpdated
    });
});

// Schedule data updates every 30 minutes
cron.schedule('*/30 * * * *', () => {
    console.log('⏰ Scheduled data update...');
    updateLotteryData();
});

// Initialize server
async function startServer() {
    try {
        await loadCachedData();
        
        app.listen(PORT, () => {
            console.log(`🚀 NC Lottery Backend Server running on port ${PORT}`);
            console.log(`📊 API endpoints available at http://localhost:${PORT}/api/`);
            console.log(`🔄 Data updates every 30 minutes`);
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
    }
}

startServer();
