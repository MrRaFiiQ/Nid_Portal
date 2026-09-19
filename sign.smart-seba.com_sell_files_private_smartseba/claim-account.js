const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');
const { extractPdfImages } = require('./extract-pdf-images');
const BASE_URL = 'https://services.nidw.gov.bd';
const OCR_API_KEY = process.env.OCR_API_KEY || '';
const OCR_API_KEY = process.env.OCR_API_KEY || '';
const MAX_CAPTCHA_RETRIES = 3;
const MAX_VALIDATE_RETRIES = 50;
const CACHE_FILE = path.join(__dirname, 'address-cache.json');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const { ImapFlow } = require('imapflow');

const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER = process.env.IMAP_USER || '';
const IMAP_PASS = (process.env.IMAP_PASS || '').replace(/\s+/g, '');
const IMAP_FROM = process.env.IMAP_FROM || '';

/**
 * Read OTP from a Gmail inbox via IMAP.
 * Polls for a new unread email (optionally to a specific +alias address) within
 * the given window and extracts a 4-8 digit numeric OTP code from its body.
 *
 * Concurrency safety: every claim uses its own plus-alias
 * (smartseba500+<NID>@gmail.com). The `to` filter guarantees the OTP read for
 * one NID never picks up an OTP meant for another NID, even under heavy load.
 */
async function readOtpFromGmail({ sinceMs, otpSentAt, timeoutMs = 120000, pollIntervalMs = 3000, to = '' } = {}) {
  if (!IMAP_USER || !IMAP_PASS) {
    throw new Error('IMAP_USER / IMAP_PASS not configured (.env). Cannot auto-read OTP.');
  }
  const windowMs = sinceMs || 5 * 60 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const otp = await fetchLatestOtpFromGmail(windowMs, to, otpSentAt);
    if (otp) {
      console.log('  -> Auto OTP read from Gmail: ' + otp + (to ? ' (to ' + to + ')' : ''));
      return otp;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error('Timeout waiting for OTP email in Gmail (' + Math.round(timeoutMs / 1000) + 's)');
}

async function fetchLatestOtpFromGmail(windowMs, to, otpSentAt) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    connectionTimeout: 20000,
    socketTimeout: 30000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Look at emails in a window around the OTP send. NIDW sometimes
      // rate-limits/delays the actual email, so start a few minutes BEFORE the
      // send time to catch it, while still excluding old stale OTPs.
      const since = otpSentAt
        ? new Date(otpSentAt - 10 * 60 * 1000)
        : new Date(Date.now() - windowMs);
      const search = { since, seen: false };
      if (to) search.to = to;
      else if (IMAP_FROM) search.from = IMAP_FROM;
      const uids = await client.search(search);

      // Newest first, check a few most recent
      const recent = uids.slice(-5).reverse();
      for (const uid of recent) {
        const msg = await client.fetchOne(uid, { envelope: true, bodyParts: ['text'] });
        if (!msg || !msg.bodyParts) continue;
        const text = String(msg.bodyParts.get('text') || '');
        const subject = (msg.envelope && msg.envelope.subject) || '';
        const fromAddr = (msg.envelope && msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '';
        const toAddrs = (msg.envelope && msg.envelope.to || []).map(x => x.address).join(',');
        console.log('  -> Gmail candidate: from=' + fromAddr + ' to=' + toAddrs + ' subject=' + (subject || '').substring(0, 60));

        // Double safety: if a `to` filter was requested, only accept mail whose
        // To header actually contains that address.
        if (to && toAddrs.toLowerCase().indexOf(to.toLowerCase()) === -1) {
          console.log('  -> Skip (To does not match ' + to + ')');
          continue;
        }

        const otp = extractOtpFromText(text);
        if (otp) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          return otp;
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.log('  -> Gmail IMAP read error: ' + e.message);
  } finally {
    await client.logout().catch(() => {});
  }
  return null;
}

function extractOtpFromText(text) {
  text = String(text || '');
  if (!text) return null;
  // Prefer 6-digit codes (NIDW OTP), then 4-8 digit fallback
  const m6 = text.match(/\b(\d{6})\b/);
  if (m6) return m6[1];
  const m48 = text.match(/\b(\d{4,8})\b/);
  return m48 ? m48[1] : null;
}

const manualOtpSessions = new Map();

// OTP verification queue — serializes verify calls to NIDW to prevent race conditions
const otpVerifyQueue = [];
let otpVerifyBusy = false;
async function processOtpVerifyQueue() {
  if (otpVerifyBusy || !otpVerifyQueue.length) return;
  otpVerifyBusy = true;
  const entry = otpVerifyQueue.shift();
  try { entry.resolve(await entry.task()); }
  catch (e) { entry.reject(e); }
  finally {
    otpVerifyBusy = false;
    await new Promise(r => setTimeout(r, 500));
    processOtpVerifyQueue();
  }
}
function enqueueOtpVerify(task) {
  return new Promise((resolve, reject) => {
    otpVerifyQueue.push({ task, resolve, reject });
    if (!otpVerifyBusy) processOtpVerifyQueue();
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"';

class CookieJar {
  constructor() {
    this.cookies = {};
  }
  setFromHeaders(headers) {
    const setCookie = headers.getSetCookie?.() || [];
    for (const line of setCookie) {
      const parts = line.split(';');
      const first = parts[0].trim();
      const eqPos = first.indexOf('=');
      if (eqPos !== -1) {
        const name = first.substring(0, eqPos).trim();
        let value = first.substring(eqPos + 1).trim();
        value = value.replace(/^"(.*)"$/, '$1');
        this.cookies[name] = value;
      }
    }
  }
  getCookieString() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) { return this.cookies[name] || null; }
  getAll() { return { ...this.cookies }; }
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function extractCsrf(html, jar) {
  if (jar) {
    for (const name of ['XSRF-TOKEN', '__RequestVerificationToken', 'CSRF-TOKEN', 'csrf-token']) {
      if (jar.get(name)) return jar.get(name);
    }
  }
  if (!html) return '';
  let m = html.match(/<meta[^>]+name\s*=\s*["']_csrf["'][^>]+content\s*=\s*["']([^"']+)/si);
  if (m) return m[1];
  m = html.match(/<meta[^>]+name\s*=\s*["']csrf-token["'][^>]+content\s*=\s*["']([^"']+)/si);
  if (m) return m[1];
  m = html.match(/<input[^>]+name\s*=\s*["']_csrf["'][^>]+value\s*=\s*["']([^"']+)/si);
  if (m) return m[1];
  m = html.match(/"X-CSRF-TOKEN":"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/name="csrf"/);
  if (m) return '';
  return '';
}

async function request(url, jar, opts = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en-GB;q=0.9,en;q=0.8',
    ...(opts.headers || {}),
  };
  if (jar) headers['Cookie'] = jar.getCookieString();
  const res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body });
  if (jar) jar.setFromHeaders(res.headers);
  let body;
  let isBinary = false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('image/') || ct.includes('application/octet-stream') || opts.binary) {
    const ab = await res.arrayBuffer();
    body = Buffer.from(ab);
    isBinary = true;
  } else {
    body = await res.text();
  }
  return { code: res.status, body, headers: Object.fromEntries(res.headers), isBinary };
}

async function preprocessCaptcha(buf) {
  try {
    const img = await Jimp.read(buf);
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    // Step 1: threshold (exactly like PHP addWhiteBg)
    // PHP GD: alpha 0=opaque, 127=transparent; Jimp: alpha 0=transparent, 255=opaque
    // PHP condition: alpha < 127 (not fully transparent) && R < 120 && G < 120 && B < 120
    // In Jimp: alpha > 0 (any visible pixel) && R < 120 && G < 120 && B < 120
    const th = new Jimp({ width: w, height: h, color: 0xFFFFFFFF });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const r = img.bitmap.data[idx];
        const g = img.bitmap.data[idx + 1];
        const b = img.bitmap.data[idx + 2];
        const a = img.bitmap.data[idx + 3];
        if (a > 0 && r < 120 && g < 120 && b < 120) {
          const nIdx = (y * w + x) * 4;
          th.bitmap.data[nIdx] = 0;
          th.bitmap.data[nIdx + 1] = 0;
          th.bitmap.data[nIdx + 2] = 0;
          th.bitmap.data[nIdx + 3] = 255;
        }
      }
    }
    // Step 2: despeckle (keep black pixels with >= 3 black neighbors including self)
    const result = new Jimp({ width: w, height: h, color: 0xFFFFFFFF });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (th.bitmap.data[idx] === 0) {
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                if (th.bitmap.data[(ny * w + nx) * 4] === 0) count++;
              }
            }
          }
          if (count >= 3) {
            result.bitmap.data[idx] = 0;
            result.bitmap.data[idx + 1] = 0;
            result.bitmap.data[idx + 2] = 0;
            result.bitmap.data[idx + 3] = 255;
          }
        }
      }
    }
    const outBuf = await result.getBuffer('image/png');
    return outBuf;
  } catch (e) {
    console.log('  -> Preprocess error: ' + e.message);
    return buf;
  }
}

const OCR_KEYS = (process.env.OCR_API_KEY || 'K87174158888957')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

async function solveCaptcha(imageBuffer) {
  const processed = await preprocessCaptcha(imageBuffer);
  const b64 = processed.toString('base64');
  let lastOcrErr = '';
  // Try each OCR.space key (multiple keys via comma-separated OCR_API_KEY)
  // Retry up to 5 times per key to survive temporary throttle (E571)
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const key of OCR_KEYS) {
      try {
        const ocrResp = await fetch('https://api.ocr.space/parse/image', {
          method: 'POST',
          headers: { 'apikey': key },
          body: new URLSearchParams({
            base64Image: 'data:image/png;base64,' + b64,
            OCREngine: '2',
            isOverlayRequired: 'false',
            detectOrientation: 'true',
            scale: 'true',
          }),
        });
        const ocrJson = await ocrResp.json();
        if (ocrJson.ParsedResults?.[0]?.ParsedText) {
          let t = ocrJson.ParsedResults[0].ParsedText.trim();
          if (t) return t.replace(/[^a-zA-Z0-9]/g, '');
        }
        lastOcrErr = ocrJson?.ErrorMessage || 'empty result';
      } catch (e) {
        lastOcrErr = e.message;
      }
    }
    if (lastOcrErr) console.log('  -> OCR.space attempt ' + (attempt + 1) + ' failed: ' + lastOcrErr);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('OCR failed: ' + (lastOcrErr || 'empty result'));
}

async function fetchCaptcha(jar, referer) {
  const t = Date.now();
  const res = await fetch(`${BASE_URL}/nid-pub/captcha/?t=${t}`, {
    headers: { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en-GB;q=0.9,en;q=0.8', 'Cookie': jar.getCookieString(),
      'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'same-origin',
      'Referer': referer, 'sec-ch-ua': SEC_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    }
  });
  if (jar) jar.setFromHeaders(res.headers);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function parseOptions(html) {
  const opts = [];
  const re = /<option\s+value=["']([^"']+)["'][^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!m[1] || m[1] === '') continue;
    opts.push({ id: m[1].trim(), name: m[2].trim() });
  }
  return opts;
}

function parseJsonOptions(body) {
  const opts = [];
  try {
    const obj = JSON.parse(body);
    for (const [id, name] of Object.entries(obj)) {
      if (id) opts.push({ id: id.trim(), name: String(name).trim() });
    }
  } catch {}
  return opts;
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function extractFormAction(html) {
  if (!html) return '';
  const m = html.match(/<form[^>]+action\s*=\s*["']([^"']+)/si);
  return m ? m[1] : '';
}

function extractOtpFieldName(html) {
  if (!html) return 'otp';
  const m = html.match(/<input[^>]+name\s*=\s*["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : 'otp';
}

async function waitFrsStatus(mqtt, topic, timeoutMs, page) {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let client;
    try {
      client = mqtt.connect('wss://services.nidw.gov.bd:443/mqtt', {
        clientId: topic.split('/').pop(), keepalive: 25, protocolId: 'MQTT', protocolVersion: 4,
        clean: true, reconnectPeriod: 1000, connectTimeout: 30000,
        username: 'client', password: 'ba55f9a1a31a2b638585e74169c96976',
      });
    } catch (e) {
      done(null);
      return;
    }
    const safeEnd = () => { try { client.end(true); } catch (e) {} };
    const timeout = setTimeout(() => { safeEnd(); done(null); }, timeoutMs);
    client.on('connect', () => {
      try { client.subscribe(topic, { qos: 1 }); } catch (e) {}
      if (page && !page.isClosed()) {
        page.evaluate(() => {
          const el = document.getElementById('frs-status');
          if (el) el.textContent = '📡 MQTT connected, waiting for face verification...';
        }).catch(() => {});
      }
    });
    client.on('message', (t, msg) => {
      const status = msg.toString();
      console.log('  -> MQTT message: ' + status);
      if (page && !page.isClosed()) {
        page.evaluate((s) => {
          const el = document.getElementById('frs-status');
          if (el) el.textContent = s === 'PROCESSING' ? '⏳ প্রসেসিং...' : '✅ ফেস ভেরিফিকেশন সম্পন্ন: ' + s;
        }, status).catch(() => {});
      }
      if (status !== 'PROCESSING') {
        clearTimeout(timeout);
        safeEnd();
        done(status);
      }
    });
    // Any transient MQTT error/close/offline must NOT crash the worker —
    // just resolve null so the FRS retry loop can re-attempt.
    const onFail = () => { clearTimeout(timeout); safeEnd(); done(null); };
    client.on('error', onFail);
    client.on('close', () => { if (!settled) setTimeout(onFail, 500); });
    client.on('offline', () => {});
  });
}

/**
 * Verify a NIDW citizen wallet login by actually performing a login with the
 * given credentials. Returns true only when the credentials are confirmed to
 * work — so users are never handed invalid username/password pairs.
 */
async function verifyLogin(username, password) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const jar = new CookieJar();
    // Use the root page (it hosts the login form reliably); /nid-pub/login often 500s
    const pageRes = await request(BASE_URL + '/nid-pub/', jar, {
      headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (pageRes.code !== 200) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    const csrf = extractCsrf(pageRes.body, jar) || uuidv4();

    let capBuf = await fetchCaptcha(jar, BASE_URL + '/nid-pub/');
    let captchaText = '';
    for (let s = 1; s <= 3; s++) {
      try { captchaText = await solveCaptcha(capBuf); break; }
      catch (e) {
        if (s >= 3) break;
        await new Promise(r => setTimeout(r, 500));
        capBuf = await fetchCaptcha(jar, BASE_URL + '/nid-pub/');
      }
    }
    captchaText = captchaText.toLowerCase();
    if (!captchaText) continue;

    const loginRes = await request(BASE_URL + '/nid-pub/login', jar, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': '*/*', 'Origin': BASE_URL,
      },
      body: new URLSearchParams({ username, password, captcha: captchaText }),
      referer: BASE_URL + '/nid-pub/',
    });
    const body = loginRes.body.trim();
    let j;
    try { j = JSON.parse(body); } catch { j = null; }

    if (j && (j.status === 'OK' || j.status === 'SUCCESS')) return true;
    if (j && j.status === 'ERROR' && j.error && j.error.field === 'captcha') continue;
    if (j && j.status === 'ERROR') return false;
    if (loginRes.code === 302 || body.includes('citizen-home')) return true;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Set the wallet password through the real NIDW "সেট পাসওয়ার্ড" page using the
 * browser (works in headless mode too). It clicks the #add-password button to
 * reveal the username/password form, fills it, submits, then verifies the login
 * actually works. Returns verified credentials only.
 */
async function setWalletPasswordViaBrowser(page, nid) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const randLetters = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  const candidateUser = nid + randLetters(1);
  const candidatePass = nid + randLetters(1);

  try {
    if (!page || page.isClosed()) return { username: '', password: '', verified: false };

    await page.goto(BASE_URL + '/nid-pub/citizen-home/secure-account', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Click "সেট পাসওয়ার্ড" (#add-password) to reveal the form
    await page.waitForSelector('#add-password', { timeout: 15000 }).catch(() => {});
    const addBtn = await page.$('#add-password');
    if (addBtn) {
      console.log('  -> Clicking #add-password...');
      await addBtn.click().catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }

    // Wait for the username/password form
    await page.waitForSelector('input[name="username"]', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('input[name="password"]', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('input[name="retypePassword"]', { timeout: 15000 }).catch(() => {});

    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$('input[name="password"]');
    const retypeInput = await page.$('input[name="retypePassword"]');

    if (!usernameInput || !passwordInput || !retypeInput) {
      console.log('  -> Password form inputs not found');
      return { username: '', password: '', verified: false };
    }

    console.log('  -> Filling username: ' + candidateUser);
    await usernameInput.click({ clickCount: 3 }).catch(() => {});
    await usernameInput.type(candidateUser, { delay: 30 });
    await passwordInput.click({ clickCount: 3 }).catch(() => {});
    await passwordInput.type(candidatePass, { delay: 30 });
    await retypeInput.click({ clickCount: 3 }).catch(() => {});
    await retypeInput.type(candidatePass, { delay: 30 });
    await new Promise(r => setTimeout(r, 500));

    const updateBtn = await page.$('#update-password');
    if (updateBtn) {
      await updateBtn.click().catch(() => {});
      console.log('  -> Clicked #update-password');
    } else {
      const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (submitBtn) { await submitBtn.click().catch(() => {}); console.log('  -> Clicked submit'); }
      else { console.log('  -> No submit button found'); return { username: '', password: '', verified: false }; }
    }
    await new Promise(r => setTimeout(r, 3000));

    // Fast success check: the form submit should navigate away / show success.
    // (No slow login captcha verification — just confirm the form went through.)
    const currentUrl = page.url() || '';
    const success = currentUrl.includes('citizen-home') && !currentUrl.includes('secure-account')
      || (await page.$('#add-password').catch(() => null)) === null;
    console.log('  -> Set password submitted, url=' + currentUrl.substring(0, 80));
    if (success) return { username: candidateUser, password: candidatePass, verified: true };
  } catch (e) {
    console.log('  -> Set password browser error: ' + e.message);
  }
  return { username: '', password: '', verified: false };
}

/**
 * Read ONE candidate OTP from Gmail (the newest unseen email to the alias) and
 * mark it seen. Returns the OTP string or null.
 */
async function readOneOtpFromGmail({ sinceMs = 10 * 60 * 1000, otpSentAt, to = '' } = {}) {
  const since = otpSentAt
    ? new Date(otpSentAt - 10 * 60 * 1000)
    : new Date(Date.now() - sinceMs);
  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false, connectionTimeout: 20000, socketTimeout: 30000,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const search = { since, seen: false };
      if (to) search.to = to;
      else if (IMAP_FROM) search.from = IMAP_FROM;
      const uids = await client.search(search);
      const recent = uids.slice(-4).reverse();
      for (const uid of recent) {
        const msg = await client.fetchOne(uid, { envelope: true, bodyParts: ['text'] });
        if (!msg || !msg.bodyParts) continue;
        const text = String(msg.bodyParts.get('text') || '');
        const toAddrs = (msg.envelope && msg.envelope.to || []).map(x => x.address).join(',');
        if (to && toAddrs.toLowerCase().indexOf(to.toLowerCase()) === -1) continue;
        const otp = extractOtpFromText(text);
        if (otp) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          return otp;
        }
      }
    } finally { lock.release(); }
  } catch (e) {
    console.log('  -> Gmail IMAP read error: ' + e.message);
  } finally {
    await client.logout().catch(() => {});
  }
  return null;
}

/**
 * Verify a given OTP against NIDW and, on success, load the AFRS template and
 * save the QR code. Returns { ok, afrsHtml, jobId, qrImgSrc, qrSaved }.
 */
async function tryOtpVerify(jar, csrf, hdrs, ref, otp, outputDir, nid) {
  const verHtml = await request(BASE_URL + '/nid-pub/claim-account/partial-views/verification-code?t=' + Date.now(), jar, {
    headers: { 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': '*/*' },
    referer: ref,
  });
  const formAction = extractFormAction(verHtml.body);
  const otpField = extractOtpFieldName(verHtml.body);
  const verifyResp = await enqueueOtpVerify(() => request(BASE_URL + (formAction || '/nid-pub/claim-account/verify-otp'), jar, {
    method: 'POST', headers: hdrs,
    body: new URLSearchParams({ [otpField || 'otp']: otp, osDetails: 'unknown' }),
    referer: ref,
  }));
  let verifyJson;
  try { verifyJson = JSON.parse(verifyResp.body); } catch { verifyJson = null; }

  if (!verifyJson || verifyJson.status !== 'SUCCESS' || !verifyJson.success || !verifyJson.success.template) {
    const errMsg = (verifyJson && verifyJson.error && verifyJson.error.message) || 'OTP verification failed';
    return { ok: false, error: errMsg };
  }

  const templatePath = verifyJson.success.template;
  let afrsHtml = '';
  for (let retry = 0; retry < 3; retry++) {
    const afrsResp = await request(BASE_URL + '/nid-pub' + templatePath + '?t=' + Date.now(), jar, {
      headers: { 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': '*/*' },
      referer: ref,
    });
    afrsHtml = afrsResp.body || '';
    console.log('  -> AFRS partial (try ' + (retry + 1) + '): HTTP ' + afrsResp.code + ' (' + afrsHtml.length + ' bytes)');
    if (afrsResp.code === 200) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const qrMatch = afrsHtml.match(/<img[^>]+id="qr-img"[^>]+src="([^"]+)"/i);
  const qrImgSrc = qrMatch ? qrMatch[1] : '';
  const jobMatch = afrsHtml.match(/<input[^>]+id="job-id"[^>]+value="([^"]+)"/i);
  const jobId = jobMatch ? jobMatch[1] : '';
  let qrSaved = false;
  if (qrImgSrc) {
    for (let retry = 0; retry < 3; retry++) {
      const qrUrl = qrImgSrc.startsWith('http') ? qrImgSrc : BASE_URL + qrImgSrc;
      const qrResp = await request(qrUrl, jar, { binary: true });
      if (qrResp.code === 200 && qrResp.isBinary && qrResp.body.length > 1000) {
        const ct = qrResp.headers['content-type'] || '';
        const ext = ct.includes('png') ? '.png' : '.jpg';
        fs.writeFileSync(path.join(outputDir, nid + '-qr' + ext), qrResp.body);
        console.log('  -> QR saved to ' + path.join(outputDir, nid + '-qr' + ext) + ' (' + qrResp.body.length + ' bytes)');
        qrSaved = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { ok: true, afrsHtml, jobId, qrImgSrc, qrSaved };
}

const QR_AES_KEY = Buffer.from('fPAVeAfBuNFggJYJgo3sFA==', 'base64');

async function decryptNidToken(encryptedToken) {
  const crypto = require('crypto');
  const raw = Buffer.from(encryptedToken, 'base64');
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', QR_AES_KEY, iv);
  const authTag = ciphertext.subarray(-16);
  const data = ciphertext.subarray(0, -16);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

class AddressResolver {
  constructor(jar, commonHeaders, referer) {
    this.jar = jar;
    this.commonHeaders = commonHeaders;
    this.referer = referer;
    this.cache = loadCache();
    this._resolved = {};
    this.divisions = [];
    this.districts = {};
    this.upozilas = {};
  }

  async resolveAll(params) {
    const { division: div, district: dist, upozila: upo,
      perDivision: pDiv, perDistrict: pDist, perUpozila: pUpo } = params;
    this.divisions = this.cache?.divisions || [];
    this.districts = this.cache?.districts || {};
    this.upozilas = this.cache?.upozilas || {};

    if (!this.divisions.length) {
      console.log('  -> Divisions empty, fetching from API...');
      const fresh = await fetchAddressData(null, this.jar, this.commonHeaders, this.referer);
      this.divisions = fresh.divisions;
      this.districts = fresh.districts;
      this.upozilas = fresh.upozilas;
      console.log('  -> API returned ' + this.divisions.length + ' divisions');
      if (this.divisions.length > 0) console.log('  -> First div: ' + JSON.stringify(this.divisions[0]));
    }

    const result = {};
    const addrPairs = [
      ['division', 'district', 'upozila', div, dist, upo],
      ['perDivision', 'perDistrict', 'perUpozila', pDiv || div, pDist || dist, pUpo || upo],
    ];
    for (const [divKey, distKey, upoKey, divVal, distVal, upoVal] of addrPairs) {
      const divId = this._findId(this.divisions, divVal);
      if (!divId) throw new Error('Division not found: ' + divVal);
      const dists = this.districts[divId] || [];
      console.log('  -> Division ' + divId + ' has ' + dists.length + ' districts: ' + JSON.stringify(dists.map(d => d.id)));
      const distId = this._findId(dists, distVal);
      if (!distId) throw new Error('District not found in division ' + divId + ': ' + distVal + ' (available: ' + dists.length + ')');
      const upos = this.upozilas[distId] || [];
      const upoId = this._findId(upos, upoVal);
      if (!upoId) throw new Error('Upozila not found in district ' + distId + ': ' + upoVal);
      result[divKey] = divId;
      result[distKey] = distId;
      result[upoKey] = upoId;
      this._resolved[divKey] = this.divisions.find(d => d.id === divId)?.name;
    }
    return result;
  }

  _findId(list, value) {
    if (!value) return null;
    const sv = String(value).trim();
    for (const item of list) {
      if (item.id === sv || item.name === sv) return item.id;
    }
    return null;
  }
}

async function runBrowserFlow(page, debug, outputDir, params) {
  const { nid, day, month, year, email, mobile, contactType, faceUrl, gmailTimeout } = params;

  let ssIdx = 0;
  const ss = async (label) => {
    ssIdx++; const sp = path.join(outputDir, 'ss-' + nid + '-' + ssIdx + '-' + label + '.png');
    if (page) await page.screenshot({ path: sp, fullPage: true }).catch(() => {}); return sp;
  };

  let _step = '';
  const emitProgress = (step, percent, message) => {
    if (typeof params.onProgress === 'function') {
      try { params.onProgress(step, percent, message); } catch {}
    }
  };
  try {
  // ---- ALL STEPS via external API (no browser interaction) ----
  // Only browser is used at the end to display the QR code

  // Step 1: External captcha + NID validate
  _step = '[1/7]';
  emitProgress(1, 5, 'NID যাচাই করা হচ্ছে (captcha solve)...');
  console.log('[1/7] External captcha -> validate...');
  const jar = new CookieJar();
  await request(BASE_URL + '/nid-pub/', jar, {
    headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const caPage = await request(BASE_URL + '/nid-pub/claim-account', jar, {
    headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  let csrf = extractCsrf(caPage.body, jar);
  if (!csrf) csrf = uuidv4();

  let validated = false;
  for (let attempt = 1; attempt <= MAX_VALIDATE_RETRIES; attempt++) {
    let capBuf = await fetchCaptcha(jar, BASE_URL + '/nid-pub/claim-account');
    let captchaText = '';
    for (let s = 1; s <= MAX_CAPTCHA_RETRIES; s++) {
      if (s > 1) capBuf = await fetchCaptcha(jar, BASE_URL + '/nid-pub/claim-account');
      try { captchaText = await solveCaptcha(capBuf); break; }
      catch (e) { if (s >= MAX_CAPTCHA_RETRIES) throw e; await new Promise(r => setTimeout(r, 500)); }
    }
    captchaText = captchaText.toLowerCase();
    const val = await request(BASE_URL + '/nid-pub/claim-account/validate', jar, {
      method: 'POST',
      headers: { 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': SEC_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      },
      body: new URLSearchParams({ nid, day, month, year, captcha: captchaText }),
      referer: BASE_URL + '/nid-pub/claim-account',
    });
    const trimmed = val.body.trim();
    let vj;
    try { vj = JSON.parse(trimmed); } catch { vj = null; }
    if (vj && (vj.status === 'OK' || vj.status === 'SUCCESS')) { validated = true; break; }
    if (vj && vj.status === 'ERROR' && vj.error?.field === 'captcha') {
      if (attempt >= MAX_VALIDATE_RETRIES) throw new Error('Captcha wrong after ' + attempt + ' attempts');
      continue;
    }
    if (vj) throw new Error('Validate ERROR: ' + JSON.stringify(vj));
    if (val.code === 401) {
      const ca2 = await request(BASE_URL + '/nid-pub/claim-account', jar, {
        headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      csrf = extractCsrf(ca2.body, jar) || uuidv4();
      continue;
    }
    throw new Error('Unexpected: ' + trimmed.substring(0, 500));
  }
  if (!validated) throw new Error('Validation failed');
  console.log('  -> NID validated');
  emitProgress(2, 15, 'NID যাচাই সফল। Address খোঁজা হচ্ছে...');

  // Common API headers
  const hdrs = {
    'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': SEC_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
  };
  const ref = BASE_URL + '/nid-pub/claim-account';

  // Step 2: Address (self-healing — retry until validated, never skip on error)
  _step = '[2/7]';
  console.log('[2/7] Selecting address...');
  const resolver = new AddressResolver(jar, { 'X-CSRF-TOKEN': csrf }, ref);
  const ADDR_MAX_RETRIES = 3;
  let addrOk = false;
  for (let a = 1; a <= ADDR_MAX_RETRIES; a++) {
    const addrIds = await resolver.resolveAll(params);
    debug.addressResolved = { ...resolver._resolved, ids: addrIds };
    const addrResp = await request(BASE_URL + '/nid-pub/claim-account/validate-address', jar, {
      method: 'POST', headers: hdrs, body: new URLSearchParams(addrIds), referer: ref,
    });
    console.log('  -> Address (try ' + a + '): HTTP ' + addrResp.code + ' ' + (addrResp.body || '').substring(0, 150));
    let addrJson;
    try { addrJson = JSON.parse(addrResp.body); } catch { addrJson = null; }
    if (addrJson && (addrJson.status === 'SUCCESS' || addrJson.status === 'OK')) {
      addrOk = true;
      break;
    }
    if (addrJson && addrJson.status === 'ERROR' && addrJson.error && addrJson.error.field === 'captcha') {
      console.log('  -> Address rejected (session/captcha), refreshing session...');
      const ca2 = await request(BASE_URL + '/nid-pub/claim-account', jar, {
        headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      csrf = extractCsrf(ca2.body, jar) || uuidv4();
      hdrs['X-CSRF-TOKEN'] = csrf;
    }
    if (a < ADDR_MAX_RETRIES) await new Promise(r => setTimeout(r, 1500));
  }
  if (!addrOk) throw new Error('Address validation failed after ' + ADDR_MAX_RETRIES + ' attempts — not proceeding to next step');
  emitProgress(3, 25, 'Address নির্বাচন সফল। OTP পাঠানো হচ্ছে...');

  // Step 3: Switch to SMS (mobile) or email + send OTP
  _step = '[3/7]';
  const useSms = (!contactType || contactType === 'sms');
  console.log('[3/7] Sending OTP via ' + (useSms ? 'SMS (mobile)' : 'Email') + '...');
  if (useSms) {
    await request(BASE_URL + '/nid-pub/claim-account/change-mobile-email', jar, {
      method: 'POST', headers: hdrs, body: new URLSearchParams({ contactType: 'SMS' }), referer: ref,
    });
    await request(BASE_URL + '/nid-pub/claim-account/send-otp', jar, {
      method: 'POST', headers: hdrs,
      body: new URLSearchParams({ contactType: 'sms', email: '', mobile: mobile || '' }),
      referer: ref,
    });
  } else {
    await request(BASE_URL + '/nid-pub/claim-account/change-mobile-email', jar, {
      method: 'POST', headers: hdrs, body: new URLSearchParams({ contactType: 'EMAIL' }), referer: ref,
    });
    await request(BASE_URL + '/nid-pub/claim-account/send-otp', jar, {
      method: 'POST', headers: hdrs,
      body: new URLSearchParams({ contactType: 'email', email: email || '', mobile: '' }),
      referer: ref,
    });
  }
  // Wait for SMS status to confirm OTP sent (self-healing: retry, then fail hard)
  let otpFirstSendTime = 0;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 800));
    const sms = await request(BASE_URL + '/nid-pub/claim-account/send-sms/status', jar, {
      headers: { 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest', 'Accept': '*/*' },
      referer: ref,
    });
    if (sms.body.includes('SUCCESS')) { otpFirstSendTime = Date.now(); console.log('  -> OTP sent'); break; }
  }
  if (!otpFirstSendTime) throw new Error('OTP could not be sent (no confirmation) — not proceeding to next step');
  emitProgress(4, 40, 'OTP পাঠানো হয়েছে। Gmail থেকে OTP পড়া হচ্ছে...');

  // Step 4: Read OTP + verify
  _step = '[4/7]';
  let afrsHtml = '', jobId = '', qrImgSrc = '', qrSaved = false;

  if (params.manualOtpSessionId) {
    if (params.autoOtp) {
      // ---- AUTO OTP MODE: try multiple OTP candidates until one verifies ----
      console.log('[4/7] Auto-reading OTP from Gmail...');
      const OTP_MAX_TRIES = 6;
      let otpVerified = false;
      for (let t = 1; t <= OTP_MAX_TRIES; t++) {
        if (t > 1) await new Promise(r => setTimeout(r, 4000));
        const otp = await readOneOtpFromGmail({
          sinceMs: 10 * 60 * 1000,
          otpSentAt: otpFirstSendTime || Date.now(),
          to: params.otpTo || '',
        });
        if (!otp) {
          console.log('  -> No OTP candidate yet (try ' + t + '/' + OTP_MAX_TRIES + ')');
          if (t >= OTP_MAX_TRIES) throw new Error('No OTP email found in Gmail after ' + OTP_MAX_TRIES + ' tries');
          continue;
        }
        console.log('  -> Auto OTP candidate ' + t + ': ' + otp);
        const res = await tryOtpVerify(jar, csrf, hdrs, ref, otp, outputDir, nid);
        if (res.ok) {
          afrsHtml = res.afrsHtml;
          jobId = res.jobId;
          qrImgSrc = res.qrImgSrc;
          qrSaved = res.qrSaved;
          debug.otpResult = { otp };
          debug.verifyBody = '';
          emitProgress(5, 55, 'OTP যাচাই সফল। QR কোড তৈরি হচ্ছে...');
          console.log('  -> QR img src: ' + qrImgSrc);
          console.log('  -> Job ID: ' + jobId);
          otpVerified = true;
          break;
        }
        console.log('  -> OTP ' + otp + ' rejected (' + res.error + '), trying next...');
      }
      if (!otpVerified) throw new Error('OTP verification failed after ' + OTP_MAX_TRIES + ' attempts');
    } else {
      // ---- MANUAL OTP MODE ----
      console.log('[4/7] Waiting for manual OTP input (' + params.manualOtpSessionId + ')...');
      const sessionEntry = manualOtpSessions.get(params.manualOtpSessionId);
      if (!sessionEntry) throw new Error('Manual OTP session not found');

      const otp = await Promise.race([
        sessionEntry.otpDeferred.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('OTP input timeout')), gmailTimeout || 300000)),
      ]);
      console.log('  -> Manual OTP received: ' + otp);

      const res = await tryOtpVerify(jar, csrf, hdrs, ref, otp, outputDir, nid);
      if (!res.ok) throw new Error(res.error);
      afrsHtml = res.afrsHtml;
      jobId = res.jobId;
      qrImgSrc = res.qrImgSrc;
      qrSaved = res.qrSaved;
      debug.otpResult = { otp };
      debug.verifyBody = '';
      emitProgress(5, 55, 'OTP যাচাই সফল। QR কোড তৈরি হচ্ছে...');
      console.log('  -> QR img src: ' + qrImgSrc);
      console.log('  -> Job ID: ' + jobId);
    }
  } else {
    throw new Error('manualOtpSessionId is required. Use the manual claim flow (/manual-claim/start).');
  }

  // Decode QR content using Jimp + jsQR (handles both PNG and JPEG)
  let qrDecodedData = '', qrUploadUrl = '', qrFaceJobId = '', qrSavePath = '';
  if (qrSaved) {
    const pngPath = path.join(outputDir, nid + '-qr.png');
    const jpgPath = path.join(outputDir, nid + '-qr.jpg');
    qrSavePath = fs.existsSync(pngPath) ? pngPath : (fs.existsSync(jpgPath) ? jpgPath : '');
    if (qrSavePath) {
      try {
        const img = await Jimp.read(qrSavePath);
        const decoded = jsQR(new Uint8ClampedArray(img.bitmap.data.buffer), img.bitmap.width, img.bitmap.height);
        if (decoded) {
          qrDecodedData = decoded.data;
          console.log('  -> QR raw data: ' + qrDecodedData.substring(0, 200));
          let qrJson;
          try { qrJson = JSON.parse(qrDecodedData); } catch (e) { qrJson = null; }
          if (qrJson) {
            qrFaceJobId = qrJson.jobId || qrJson.job_id || '';
            qrUploadUrl = qrJson.url || qrJson.uploadUrl || '';
            console.log('  -> QR JSON: jobId=' + qrFaceJobId + ' url=' + qrUploadUrl.substring(0, 60));
          } else {
            try {
              const decrypted = await decryptNidToken(qrDecodedData);
              console.log('  -> QR decrypted: ' + decrypted.substring(0, 200));
              const decJson = JSON.parse(decrypted);
              qrFaceJobId = decJson.jobId || decJson.job_id || '';
              qrUploadUrl = decJson.url || decJson.uploadUrl || '';
              qrDecodedData = decrypted;
              console.log('  -> Decrypted QR: jobId=' + qrFaceJobId + ' url=' + qrUploadUrl.substring(0, 60));
            } catch (de) {
              console.log('  -> QR decrypt failed: ' + de.message);
            }
          }
        } else {
          console.log('  -> QR decode: no QR found in image');
        }
      } catch (e) {
        console.log('  -> QR decode error: ' + e.message);
      }
    }
  }
  debug.qrDecoded = qrDecodedData;
  debug.qrUploadUrl = qrUploadUrl;
  debug.qrFaceJobId = qrFaceJobId;

    // Step 5: Face verification — upload face image + commence AFRS
    let faceVerified = false;
    let faceError = '';
    emitProgress(6, 65, 'QR প্রস্তুত। ফেস ম্যাচ শুরু হচ্ছে...');
    // Random delay (1–5s) to desync concurrent FRS requests and reduce NIDW overload
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 4000));
    if (qrUploadUrl && qrFaceJobId && params.faceUrl) {
    _step = '[5/7]';
    console.log('[5/7] Face verification...');
    try {
      // Fetch face image from URL
      const faceResp = await fetch(params.faceUrl);
      if (!faceResp.ok) throw new Error('Face image fetch failed: ' + faceResp.status);
      const faceBuf = Buffer.from(await faceResp.arrayBuffer());
      console.log('  -> Face image: ' + faceBuf.length + ' bytes');

      // PUT face image to upload URL
      const putRes = await fetch(qrUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: faceBuf,
      });
      const putBody = await putRes.text();
      console.log('  -> PUT face: HTTP ' + putRes.status + ' ' + putBody.substring(0, 100));
      if (!putRes.ok) { faceError = 'Face upload failed: HTTP ' + putRes.status + ' ' + putBody.substring(0, 100); throw new Error(faceError); }

      // POST to commence
      const commenceUrl = 'https://prportal.nidw.gov.bd/nid-pub/afrs/v3/commence';
      const commenceRes = await fetch(commenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'jobId=' + encodeURIComponent(qrFaceJobId),
      });
      const commenceText = await commenceRes.text();
      console.log('  -> Commence: HTTP ' + commenceRes.status + ' ' + commenceText.substring(0, 200));
      if (!commenceRes.ok) { faceError = 'Commence failed: HTTP ' + commenceRes.status + ' ' + commenceText.substring(0, 200); throw new Error(faceError); }
      faceVerified = true;
      emitProgress(7, 75, 'ফেস ম্যাচ চলছে (সাধারণত ১০-৩০ সেকেন্ড)...');
    } catch (e) {
      console.log('  -> Face verify error: ' + e.message);
    }
  } else if (params.faceUrl) {
    faceError = 'QR upload URL or jobId missing';
    console.log('  -> Face URL provided but no QR upload URL or jobId');
  } else {
    console.log('  -> No face URL provided, skipping face verification');
  }
  debug.faceVerified = faceVerified;
  debug.faceError = faceError;

  // Early exit if face verification failed
  if (faceError && params.faceUrl) {
    console.log('  -> Face verification failed (' + faceError + '). Skipping browser/MQTT/profile. Returning partial data.');
    if (page && !page.isClosed()) { await page.close().catch(() => {}); page = null; }
    return { success: false, error: 'Face verification failed: ' + faceError, debug, qrDecodedData, frsFinalStatus: null };
  }

  // Step 6: Open browser immediately with QR, then listen for MQTT updates
  if (page && !params.headless) {
    _step = '[6/7]';
    console.log('[6/7] Opening browser...');
    let pageUpdated = false;

    if (fs.existsSync(qrSavePath) || qrSaved) {
      const qrFilePath = qrSavePath || path.join(outputDir, nid + '-qr.png');
      const qrBase64 = fs.readFileSync(qrFilePath).toString('base64');
      const dataUri = 'data:image/png;base64,' + qrBase64;
      const decodedHtml = qrDecodedData ? `<p style="font-size:12px;color:#999;word-break:break-all;max-width:400px;margin-top:8px">${qrDecodedData.substring(0,100)}</p>` : '';
      await page.setContent(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>NID Wallet QR</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f2f5;padding:20px}
.card{background:#fff;border-radius:16px;padding:48px 40px;box-shadow:0 8px 24px rgba(0,0,0,.12);text-align:center;max-width:480px;width:100%}
h2{color:#032559;font-size:24px;margin-bottom:4px}
.sub{color:#888;font-size:16px;margin-bottom:32px}
.qr-wrap{background:#fff;border:3px solid #e8e8e8;border-radius:12px;padding:16px;display:inline-block;margin-bottom:24px}
.qr-wrap img{display:block;width:280px;height:280px}
.note{color:#666;font-size:14px;margin-bottom:8px}
.status{color:#032559;font-size:14px;margin-top:12px}
</style></head>
<body>
<div class="card">
<h2>NID Wallet QR Code</h2>
<p class="sub">QR কোডটি স্ক্যান করুন এবং নির্দেশাবলী অনুসরণ করুন</p>
<div class="qr-wrap"><img src="${dataUri}" alt="QR"></div>
<p class="note">Scan with the NID Wallet app</p>
${decodedHtml}
<div class="status" id="frs-status">⏳ অপেক্ষা করুন... ফেস ভেরিফিকেশন চলছে</div>
</div>
</body></html>`);
      await ss('qr-displayed');
      console.log('  -> QR displayed in browser');
      pageUpdated = true;
    }

    if (!pageUpdated) {
      await page.setContent('<html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;"><h3>No QR data available</h3></body></html>');
    }
  }

  // Subscribe to MQTT and wait for FRS result (may update browser if open)
  console.log('  -> Subscribing to MQTT for FRS status...');
  let frsFinalStatus = null;
  let sigMain = null;
  let sigOfficer = null;
  let pin = null;
  let walletUsername = '', walletPassword = '';
  const mqtt = require('mqtt');
  if (jobId) {
    // FRS retry loop: on ERROR/FAILED, re-commence and listen again
    const FRS_MAX_RETRIES = 3;
    const topic = '/frs/job/' + jobId;
    for (let attempt = 1; attempt <= FRS_MAX_RETRIES; attempt++) {
      if (attempt > 1 && qrFaceJobId) {
        console.log('  -> FRS retry ' + attempt + '/' + FRS_MAX_RETRIES + ': re-commencing...');
        try {
          await fetch('https://prportal.nidw.gov.bd/nid-pub/afrs/v3/commence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'jobId=' + encodeURIComponent(qrFaceJobId),
          });
        } catch (e) {
          console.log('  -> Re-commence error: ' + e.message);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      emitProgress(7, 85, 'ফেস ম্যাচ সম্পন্ন হচ্ছে, ফলাফল যাচাই...');
      frsFinalStatus = await waitFrsStatus(mqtt, topic, 120000, page);
      console.log('  -> FRS attempt ' + attempt + ' result: ' + frsFinalStatus);
      if (!frsFinalStatus) break;
      if (frsFinalStatus === 'ERROR' || frsFinalStatus === 'FAILED') {
        if (attempt < FRS_MAX_RETRIES) continue;
        break;
      }
      break;
    }
  }

  // Step 7: If MQTT returned a final status, load v2-afrs-check for updated content
  if (frsFinalStatus && csrf) {
    _step = '[7/7]';
    emitProgress(6, 88, 'ফেস ম্যাচ ' + frsFinalStatus + ' ✓');
    console.log('[7/7] FRS completed: ' + frsFinalStatus + ', loading v2-afrs-check...');
    try {
      const v2Resp = await request(BASE_URL + '/nid-pub/claim-account/v2-afrs-check/' + frsFinalStatus, jar, {
        method: 'POST', headers: hdrs,
        body: new URLSearchParams({}), referer: ref,
      });
      if (v2Resp.code === 200) {
        const v2Html = v2Resp.body || '';
        console.log('  -> v2-afrs-check loaded: ' + v2Html.length + ' bytes');

        // Parse v2 response JSON for redirect/template (like site's handleSuccessStatus)
        let v2Json;
        try { v2Json = JSON.parse(v2Html); } catch (e) { v2Json = null; }
        if (v2Json && v2Json.status === 'SUCCESS' && v2Json.success) {
          if (v2Json.success.redirect) {
            const redirectUrl = '/nid-pub' + v2Json.success.redirect;
            console.log('  -> Redirect to: ' + redirectUrl);

            if (page && !page.isClosed()) {
              // Set validated cookies and navigate to the redirect URL
              const rawCookies = jar.getAll();
              const cookiePairs = Object.entries(rawCookies).map(([k, v]) => `${k}=${v}`);
              const allCookieStr = cookiePairs.join('; ');
              await page.setRequestInterception(true);
              page.on('request', (request) => {
                const headers = request.headers();
                headers['Cookie'] = allCookieStr;
                request.continue({ headers });
              });
              await page.goto(BASE_URL + redirectUrl, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
              if (rawCookies.JSESSIONID) {
                await page.setCookie({ name: 'JSESSIONID', value: rawCookies.JSESSIONID, url: BASE_URL, httpOnly: true, secure: true });
                await page.reload({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
              }
              // ===== Set wallet password through the real "সেট পাসওয়ার্ড" page =====
              // Works in headless mode too: click #add-password → fill form → submit.
              emitProgress(7, 90, 'ইউজার/পাসওয়ার্ড সেট করা হচ্ছে...');
              const PASSWORD_MAX_ATTEMPTS = 2;
              if (page && !page.isClosed()) {
                for (let p = 1; p <= PASSWORD_MAX_ATTEMPTS; p++) {
                  console.log('  -> Set password attempt ' + p + '/' + PASSWORD_MAX_ATTEMPTS + ' (browser)...');
                  const res = await setWalletPasswordViaBrowser(page, nid);
                  if (res.verified) {
                    walletUsername = res.username;
                    walletPassword = res.password;
                    break;
                  }
                  await new Promise(r => setTimeout(r, 1000));
                }
              }

              // Fallback: HTTP add-password if browser is unavailable
              if (!walletUsername) {
                console.log('  -> Browser set failed, trying HTTP add-password...');
                try {
                  const letters = 'abcdefghijklmnopqrstuvwxyz';
                  const randLetters = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
                  for (let p = 1; p <= PASSWORD_MAX_ATTEMPTS; p++) {
                    const candidateUser = nid + randLetters(1);
                    const candidatePass = nid + randLetters(1);
                    console.log('  -> Generated username: ' + candidateUser + ', password: ' + candidatePass);
                    const passResp = await request(BASE_URL + '/nid-pub/citizen-home/secure-account/add-password', jar, {
                      method: 'POST', headers: hdrs,
                      body: new URLSearchParams({ username: candidateUser, password: candidatePass, retypePassword: candidatePass }),
                      referer: BASE_URL + '/nid-pub/citizen-home/secure-account',
                    });
                    console.log('  -> Set password via HTTP (attempt ' + p + '): ' + passResp.code + ' body=' + (passResp.body || '').substring(0, 150));
                    walletUsername = candidateUser;
                    walletPassword = candidatePass;
                    break;
                  }
                } catch (e) {
                  console.log('  -> Set password HTTP error: ' + e.message);
                }
              }

              if (walletUsername) {
                emitProgress(7, 97, 'ইউজার/পাসওয়ার্ড সেট সম্পন্ন ✓');
              } else {
                console.log('  -> WARNING: could not set a working wallet password');
              }
            }

              // Save profile page HTML (with retry if empty data)
              emitProgress(8, 100, 'প্রোফাইল প্রস্তুত হচ্ছে...');
              try {
                let profileResp = await request(BASE_URL + '/nid-pub/citizen-home/profile', jar, {
                  headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
                });
                if (profileResp.code === 200 && profileResp.body) {
                  // Check if data looks valid; if empty names, retry once with delay
                  const hasNameLabels = /[\u0980-\u09FF]{1,10}\s*\(\s*(বাংলা|ইংরেজি)\s*\)/.test(profileResp.body);
                  if (!hasNameLabels) {
                    console.log('  -> Profile page data may be incomplete, retrying...');
                    await new Promise(r => setTimeout(r, 2000));
                    profileResp = await request(BASE_URL + '/nid-pub/citizen-home/profile', jar, {
                      headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
                    });
                  }
                  const profilePath = path.join(outputDir, nid + '-profile.html');
                  fs.writeFileSync(profilePath, profileResp.body);
                  console.log('  -> Profile page saved (' + profileResp.body.length + ' bytes)');
                  try {
                    const { extractProfile } = require('./extract-profile');
                    const jsonData = extractProfile(profileResp.body, nid);
                    // Validate: if names are empty, log HTML preview
                    if (!jsonData.nameEnglish && !jsonData.nameBangla) {
                      console.log('  -> WARNING: Profile extraction returned empty names. HTML preview: ' + (profileResp.body || '').replace(/\s+/g, ' ').substring(0, 300));
                      console.log('  -> Retrying extraction with page.goto fallback...');
                      await page.goto(BASE_URL + '/nid-pub/citizen-home/profile', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
                      await new Promise(r => setTimeout(r, 2000));
                      const retryResp = await request(BASE_URL + '/nid-pub/citizen-home/profile', jar, {
                        headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
                      });
                      if (retryResp.code === 200 && retryResp.body) {
                        fs.writeFileSync(profilePath, retryResp.body);
                        const retryData = extractProfile(retryResp.body, nid);
                        Object.assign(jsonData, retryData);
                        console.log('  -> Profile re-extracted after fallback');
                      }
                    }
                    // Download NIDW photo immediately (S3 pre-signed URL expires in 120s)
                    if (jsonData.photoUrl) {
                      try {
                        const photoResp = await fetch(jsonData.photoUrl);
                        if (photoResp.ok) {
                          const photoBuf = Buffer.from(await photoResp.arrayBuffer());
                          const photoExt = (jsonData.photoUrl.match(/\.(jpg|jpeg|png)/i) || [])[1] || 'jpg';
                          const photoPath = path.join(outputDir, nid + '-photo.' + photoExt);
                          fs.writeFileSync(photoPath, photoBuf);
                          jsonData.photoUrl = `https://sign.smart-seba.com/downloads/${nid}/${nid}-photo.${photoExt}`;
                          console.log('  -> Photo saved locally (' + photoBuf.length + ' bytes)');
                        }
                      } catch (e) {
                        console.log('  -> Photo download failed: ' + e.message);
                      }
                    }
                    if (walletUsername && walletPassword) {
                      jsonData.walletUsername = walletUsername;
                      jsonData.walletPassword = walletPassword;
                    }
                    const jsonPath = path.join(outputDir, 'profile.json');
                    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
                    console.log('  -> Profile JSON saved');
                  } catch (e) {
                    console.log('  -> Profile JSON extract error: ' + e.message);
                  }
                }
              } catch (e) {
                console.log('  -> Profile page error: ' + e.message);
              }

              // Download NID PDF via API + open in browser
              try {
                const pdfResp = await request(BASE_URL + '/nid-pub/citizen-home/nid/download', jar, {
                  headers: { 'Accept': 'text/html,application/pdf,*/*', 'User-Agent': UA, 'Referer': BASE_URL + '/nid-pub/citizen-home/' },
                });
                const ct = pdfResp.headers['content-type'] || '';
                if (pdfResp.code === 200 && pdfResp.body && pdfResp.body.length > 1000) {
                  const isPdf = (ct.includes('pdf') || ct.includes('octet-stream')) && pdfResp.isBinary;
                  if (isPdf) {
                    const pdfPath = path.join(outputDir, nid + '-nid.pdf');
                    fs.writeFileSync(pdfPath, pdfResp.body);
                    console.log('  -> NID PDF saved (' + pdfResp.body.length + ' bytes)');
                    // Extract images from the PDF
                    try {
                      const { extractPdfImages } = require('./extract-pdf-images');
                      const images = await extractPdfImages(pdfPath, outputDir);
                      const imgMap = {};
                      for (const img of images) imgMap[img.type + '-' + img.page + '-' + (img.index || '')] = img;
                      // Copy and name sig-main (img-3) and sig-officer (img-5)
                      if (imgMap['image-1-3']) {
                        const src = path.join(outputDir, 'page-1-img-3.png');
                        const dst = path.join(outputDir, 'sig-main.png');
                        fs.writeFileSync(dst, fs.readFileSync(src));
                        sigMain = '/downloads/' + nid + '/sig-main.png';
                      }
                      if (imgMap['image-1-5']) {
                        const src = path.join(outputDir, 'page-1-img-5.png');
                        const dst = path.join(outputDir, 'sig-officer.png');
                        fs.writeFileSync(dst, fs.readFileSync(src));
                        sigOfficer = '/downloads/' + nid + '/sig-officer.png';
                      }
                    } catch (piErr) {
                      console.log('  -> PDF image extraction error: ' + piErr.message);
                    }
                    // Extract PDF417 barcode from the PDF
                    try {
                      const { extractBarcodeFromPdf } = require('./extract-barcode');
                      const barcodeResult = await extractBarcodeFromPdf(pdfPath);
                      const pinMatch = barcodeResult.text.match(/<pin>([^<]+)<\/pin>/);
                      if (pinMatch) pin = pinMatch[1];
                      console.log('  -> Barcode decoded, pin: ' + (pin || 'not found'));
                    } catch (bcErr) {
                      console.log('  -> Barcode extraction error: ' + bcErr.message);
                    }
                    const pdfBase64 = pdfResp.body.toString('base64');
                    const pdfDataUri = 'data:application/pdf;base64,' + pdfBase64;
                    await page.evaluate((uri) => { window.open(uri, '_blank'); }, pdfDataUri).catch(() => {});
                  } else {
                    console.log('  -> NID PDF not available (response is ' + ct + ', ' + pdfResp.body.length + ' bytes)');
                    await page.goto(BASE_URL + '/nid-pub/citizen-home/nid/download', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
                    await ss('nid-page');
                  }
                } else {
                  console.log('  -> NID download: HTTP ' + pdfResp.code + ' (' + (pdfResp.body || '').length + ' bytes)');
                }
              } catch (e) {
                console.log('  -> NID download error: ' + e.message);
              }

              // Show profile page in browser (skip in headless mode)
              if (!params.headless) {
                try {
                  await page.goto(BASE_URL + '/nid-pub/citizen-home/profile', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
                  await new Promise(r => setTimeout(r, 1000));
                  await ss('profile-page');
                  console.log('  -> Profile page displayed in browser');
                } catch (e) {
                  console.log('  -> Profile page navigate error: ' + e.message);
                }
              }
          } else if (v2Json.success.template) {
            // Load template (like site's templateLoader)
            const templatePath = v2Json.success.template;
            console.log('  -> Template: ' + templatePath);
          }
        }
      }
    } catch (e) {
      console.log('  -> v2-afrs-check error: ' + e.message);
    }
  } else if (!qrSaved && qrImgSrc) {
    // Fallback: save QR directly if not already saved
    const qrUrl = qrImgSrc.startsWith('http') ? qrImgSrc : BASE_URL + qrImgSrc;
    const qrResp = await request(qrUrl, jar, { binary: true });
    if (qrResp.code === 200 && qrResp.isBinary && qrResp.body.length > 1000) {
      const fallbackPath = path.join(outputDir, nid + '-qr.jpg');
      fs.writeFileSync(fallbackPath, qrResp.body);
      console.log('  -> QR saved (fallback, ' + qrResp.body.length + ' bytes)');
    }
  }

  if (page && !page.isClosed()) {
    if (params.headless) {
      console.log('  -> Headless mode, closing browser.');
      await page.close();
    } else {
      await ss('ready');
      console.log('  => Browser ready. Close manually.');
      await new Promise(r => setTimeout(r, 300000));
      await page.close();
    }
  } else {
    console.log('  -> No browser.');
  }

  return { success: true, debug, qrDecodedData, frsFinalStatus, sigMain, sigOfficer, pin, walletUsername, walletPassword };
  } catch (e) {
    console.log('  -> ' + _step + ' ERROR: ' + e.message);
    debug.error = _step + ' ' + e.message;
    return { success: false, nid, error: _step + ' ' + e.message, debug };
  }
}

async function claimAccount(params) {
  const { nid, day, month, year, email, mobile, contactType, faceUrl, gmailTimeout, headless, autoOtp, otpTo, onProgress } = params;
  const debug = {};
  const outputDir = path.join(__dirname, 'downloads', nid);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let browser, page;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: headless === true ? true : false,
      args: headless
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : ['--start-maximized', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.on('dialog', d => d.dismiss());

    const flowResult = await runBrowserFlow(page, debug, outputDir, {
      nid, day, month, year, email, mobile, contactType, faceUrl, gmailTimeout, headless,
      division: params.division, district: params.district, upozila: params.upozila,
      perDivision: params.perDivision, perDistrict: params.perDistrict, perUpozila: params.perUpozila,
      manualOtpSessionId: params.manualOtpSessionId,
      autoOtp: params.autoOtp,
      otpTo: params.otpTo,
      onProgress,
    });
    return flowResult;
  } catch (err) {
    debug.error = err.message;
    console.log('  -> ERROR: ' + err.message);
    if (browser) {
      console.log('  => Browser stays open for inspection.');
      await new Promise(r => setTimeout(r, 300000)).catch(() => {});
      await browser.close().catch(() => {});
    }
    return { success: false, nid, error: err.message, debug };
  } finally {
    if (browser && headless) {
      await browser.close().catch(() => {});
    }
  }
}

async function fetchAddressData(nidOpts, jarParam, headersParam, refererParam) {
  const jar = jarParam || new CookieJar();
  const commonHeaders = {
    'Accept-Language': 'en-US,en-GB;q=0.9,en;q=0.8,fr;q=0.7,it;q=0.6',
    'sec-ch-ua': SEC_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'X-Requested-With': 'XMLHttpRequest',
    ...(headersParam || {}),
  };

  // Use provided CSRF, else try jar cookies, else generate uuid
  if (!commonHeaders['X-CSRF-TOKEN']) {
    let csrf = extractCsrf('', jar);
    if (!csrf) csrf = uuidv4();
    commonHeaders['X-CSRF-TOKEN'] = csrf;
  }

  const referer = refererParam || `${BASE_URL}/nid-pub/claim-account`;

  if (nidOpts && nidOpts.nid && nidOpts.day && nidOpts.month && nidOpts.year) {
    const { nid, day, month, year, captcha: manualCaptcha } = nidOpts;
    let validated = false;

    for (let attempt = 1; attempt <= MAX_VALIDATE_RETRIES; attempt++) {
      let cap = null;
      for (let c = 0; c < 3; c++) {
        cap = await fetchCaptcha(jar, referer);
        if (cap.length >= 20000 || c >= 2) break;
      }

      let captchaText = manualCaptcha || '';
      if (!captchaText) {
        for (let s = 1; s <= MAX_CAPTCHA_RETRIES; s++) {
          if (s > 1) cap = await fetchCaptcha(jar, referer);
          try { captchaText = await solveCaptcha(cap); break; }
          catch (e) {
            if (s >= MAX_CAPTCHA_RETRIES) throw e;
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }
      captchaText = captchaText.toLowerCase();

      const valBody = new URLSearchParams({ nid, day, month, year, captcha: captchaText });
      const val = await request(`${BASE_URL}/nid-pub/claim-account/validate`, jar, {
        method: 'POST',
        headers: {
          ...commonHeaders, 'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Origin': BASE_URL,
        },
        body: valBody, referer,
      });

      const bodyTrim = val.body.trim();
      let vj;
      try { vj = JSON.parse(bodyTrim); } catch { vj = null; }

      if (vj && (vj.status === 'OK' || vj.status === 'SUCCESS')) {
        validated = true;
        const newCsrf = extractCsrf(val.body, jar);
        if (newCsrf) csrf = newCsrf;
        commonHeaders['X-CSRF-TOKEN'] = csrf;
        break;
      }
      if (vj && vj.status === 'ERROR' && vj.error?.field === 'captcha') {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      if (vj && vj.status === 'ERROR') {
        throw new Error(`Validate ERROR: ${vj.error?.message || 'Unknown'}`);
      }
    }
    if (!validated) throw new Error('NID validation failed for address bootstrap');
  }

  const addr = await request(
    `${BASE_URL}/nid-pub/claim-account/partial-views/address?t=${Date.now()}`,
    jar, { headers: { ...commonHeaders, 'Accept': '*/*' }, referer }
  );
  const divisions = parseOptions(addr.body);

  const districts = {};
  for (const div of divisions) {
    const dist = await request(`${BASE_URL}/nid-pub/claim-account/partial-views/district`, jar, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': '*/*',
      },
      body: new URLSearchParams({ divisionId: div.id }),
      referer,
    });
    const parsed = parseJsonOptions(dist.body);
    districts[div.id] = parsed;
  }

  const upozilas = {};
  for (const distList of Object.values(districts)) {
    for (const dist of distList) {
      const upo = await request(`${BASE_URL}/nid-pub/claim-account/partial-views/upozila`, jar, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
        },
        body: new URLSearchParams({ districtId: dist.id }),
        referer,
      });
      upozilas[dist.id] = parseJsonOptions(upo.body);
    }
  }

  const data = { divisions, districts, upozilas, savedAt: new Date().toISOString() };
  saveCache(data);
  return data;
}

module.exports = { claimAccount, fetchAddressData, parseOptions, parseJsonOptions, loadCache, CACHE_FILE, solveCaptcha, fetchCaptcha, decryptNidToken, manualOtpSessions, deferred };
