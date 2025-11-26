const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store for active sessions and images
const sessions = new Map();
const generatedImages = new Map();

// Temp mail domains and API
const TEMP_MAIL_DOMAINS = ['1secmail.com', '1secmail.org', '1secmail.net'];

async function generateTempEmail() {
    const username = 'agent_' + Math.random().toString(36).substring(2, 10);
    const domain = TEMP_MAIL_DOMAINS[Math.floor(Math.random() * TEMP_MAIL_DOMAINS.length)];
    return `${username}@${domain}`;
}

async function checkEmailInbox(email) {
    const [username, domain] = email.split('@');
    try {
        const response = await fetch(
            `https://www.1secmail.com/api/v1/?action=getMessages&login=${username}&domain=${domain}`
        );
        return await response.json();
    } catch (e) {
        return [];
    }
}

async function getEmailContent(email, messageId) {
    const [username, domain] = email.split('@');
    try {
        const response = await fetch(
            `https://www.1secmail.com/api/v1/?action=readMessage&login=${username}&domain=${domain}&id=${messageId}`
        );
        return await response.json();
    } catch (e) {
        return null;
    }
}

// Process a single prompt with its own browser context
async function processPrompt(browser, prompt, promptIndex, sessionId, updateCallback) {
    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    
    let retries = 0;
    const maxRetries = 5;
    let success = false;
    let imageData = null;
    
    try {
        while (retries < maxRetries && !success) {
            try {
                updateCallback(promptIndex, 'creating_email', retries);
                const email = await generateTempEmail();
                
                updateCallback(promptIndex, 'navigating', retries);
                await page.goto('https://lmarena.ai/?mode=image', { 
                    waitUntil: 'networkidle2',
                    timeout: 60000 
                });
                
                // Wait for potential Cloudflare challenge
                updateCallback(promptIndex, 'cloudflare', retries);
                await page.waitForTimeout(5000);
                
                // Check if we need to handle Cloudflare
                const cfChallenge = await page.$('.cf-browser-verification');
                if (cfChallenge) {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                }
                
                updateCallback(promptIndex, 'logging_in', retries);
                
                // Look for login/signup button
                const loginBtn = await page.$('button:has-text("Sign"), a:has-text("Login"), button:has-text("Log")');
                if (loginBtn) {
                    await loginBtn.click();
                    await page.waitForTimeout(2000);
                }
                
                // Enter email
                const emailInput = await page.$('input[type="email"], input[name="email"]');
                if (emailInput) {
                    await emailInput.type(email, { delay: 50 });
                    
                    // Submit
                    const submitBtn = await page.$('button[type="submit"], button:has-text("Continue")');
                    if (submitBtn) await submitBtn.click();
                    
                    // Wait for verification email
                    await page.waitForTimeout(10000);
                    
                    // Check inbox for verification link
                    let verified = false;
                    for (let i = 0; i < 6; i++) {
                        const messages = await checkEmailInbox(email);
                        if (messages.length > 0) {
                            const content = await getEmailContent(email, messages[0].id);
                            if (content && content.body) {
                                // Extract verification link
                                const linkMatch = content.body.match(/https?:\/\/[^\s<>"]+/g);
                                if (linkMatch) {
                                    await page.goto(linkMatch[0], { waitUntil: 'networkidle2' });
                                    verified = true;
                                    break;
                                }
                            }
                        }
                        await page.waitForTimeout(5000);
                    }
                }
                
                updateCallback(promptIndex, 'selecting_model', retries);
                
                // Select model - look for dropdown or model selector
                const modelSelector = await page.$('[class*="model"], [class*="select"], select');
                if (modelSelector) {
                    await modelSelector.click();
                    await page.waitForTimeout(1000);
                    
                    // Look for Gemini option
                    const geminiOption = await page.$('text=/gemini/i, [value*="gemini"]');
                    if (geminiOption) await geminiOption.click();
                }
                
                updateCallback(promptIndex, 'generating', retries);
                
                // Find prompt input and enter text
                const promptInput = await page.$('textarea, input[type="text"][class*="prompt"]');
                if (promptInput) {
                    await promptInput.click();
                    await promptInput.type(prompt, { delay: 30 });
                    
                    // Find and click generate button
                    const generateBtn = await page.$('button:has-text("Generate"), button:has-text("Send"), button[type="submit"]');
                    if (generateBtn) await generateBtn.click();
                    
                    // Wait for image generation (up to 5 minutes)
                    updateCallback(promptIndex, 'waiting', retries);
                    
                    await page.waitForSelector('img[class*="generated"], img[class*="result"], [class*="image-result"] img', {
                        timeout: 300000
                    });
                    
                    await page.waitForTimeout(3000);
                    
                    updateCallback(promptIndex, 'downloading', retries);
                    
                    // Get the generated image
                    const imgElement = await page.$('img[class*="generated"], img[class*="result"], [class*="image-result"] img');
                    if (imgElement) {
                        const imgSrc = await imgElement.evaluate(el => el.src);
                        
                        if (imgSrc.startsWith('data:')) {
                            imageData = imgSrc;
                        } else {
                            // Download the image
                            const imgResponse = await page.goto(imgSrc);
                            const buffer = await imgResponse.buffer();
                            imageData = 'data:image/png;base64,' + buffer.toString('base64');
                        }
                        
                        success = true;
                    }
                }
                
            } catch (error) {
                console.error(`Prompt ${promptIndex} attempt ${retries + 1} failed:`, error.message);
                retries++;
                
                if (retries < maxRetries) {
                    updateCallback(promptIndex, 'retrying', retries);
                    await page.waitForTimeout(3000);
                }
            }
        }
        
    } finally {
        await context.close();
    }
    
    if (success) {
        updateCallback(promptIndex, 'success', retries);
        return { success: true, imageData, promptIndex, prompt };
    } else {
        updateCallback(promptIndex, 'dismissed', retries);
        return { success: false, promptIndex, prompt };
    }
}

// Main batch processing endpoint
app.post('/api/process-batch', async (req, res) => {
    const { prompts, batchSize = 30 } = req.body;
    const sessionId = uuidv4();
    
    sessions.set(sessionId, {
        status: 'starting',
        prompts: prompts,
        results: [],
        progress: {}
    });
    
    res.json({ sessionId, message: 'Batch processing started' });
    
    // Start processing in background
    (async () => {
        const browser = await puppeteer.launch({
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
        
        try {
            const session = sessions.get(sessionId);
            session.status = 'processing';
            
            // Process in batches
            for (let batchStart = 0; batchStart < prompts.length; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, prompts.length);
                const batchPrompts = prompts.slice(batchStart, batchEnd);
                
                session.currentBatch = Math.floor(batchStart / batchSize) + 1;
                session.totalBatches = Math.ceil(prompts.length / batchSize);
                
                // Process all prompts in batch concurrently
                const batchPromises = batchPrompts.map((prompt, i) => {
                    const globalIndex = batchStart + i;
                    return processPrompt(
                        browser,
                        prompt,
                        globalIndex,
                        sessionId,
                        (idx, status, retries) => {
                            session.progress[idx] = { status, retries };
                        }
                    );
                });
                
                const batchResults = await Promise.all(batchPromises);
                session.results.push(...batchResults);
                
                // Wait between batches
                if (batchEnd < prompts.length) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
            
            session.status = 'complete';
            
            // Store successful images
            const successfulImages = session.results.filter(r => r.success);
            generatedImages.set(sessionId, successfulImages);
            
        } catch (error) {
            console.error('Batch processing error:', error);
            sessions.get(sessionId).status = 'error';
            sessions.get(sessionId).error = error.message;
        } finally {
            await browser.close();
        }
    })();
});

// Get session status
app.get('/api/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
});

// Download images as ZIP
app.get('/api/download/:sessionId', async (req, res) => {
    const images = generatedImages.get(req.params.sessionId);
    if (!images || images.length === 0) {
        return res.status(404).json({ error: 'No images found' });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="ai-images-${req.params.sessionId}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    
    images.sort((a, b) => a.promptIndex - b.promptIndex).forEach((img, i) => {
        const base64Data = img.imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${String(i + 1).padStart(3, '0')}_${img.prompt.substring(0, 30).replace(/[^a-z0-9]/gi, '_')}.png`;
        archive.append(buffer, { name: filename });
    });
    
    // Add prompts manifest
    const manifest = images.map((img, i) => `${i + 1}. ${img.prompt}`).join('\n');
    archive.append(manifest, { name: 'prompts.txt' });
    
    await archive.finalize();
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 AI Image Agent Server running on port ${PORT}`);
    console.log(`📡 Connect your frontend to http://localhost:${PORT}`);
});
