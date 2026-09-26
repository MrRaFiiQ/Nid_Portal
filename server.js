require('dotenv').config();
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');
const path = require('path');
const { fork } = require('child_process');
const { claimAccount, fetchAddressData, loadCache, CACHE_FILE, decryptNidToken, manualOtpSessions, deferred } = require('./claim-account');
const { checkBalance, deductBalance, refundBalance, logRequest, getPensionApiStatus, testConnection, validateApiKey, readJSON, writeJSON, KEYS_FILE } = require('./db');

// Simple API queue — serializes external API calls to avoid rate limiting
const apiQueue = [];
let apiQueueBusy = false;
async function processApiQueue() {
  if (apiQueueBusy || !apiQueue.length) return;
  apiQueueBusy = true;
  const entry = apiQueue.shift();
  if (apiQueue.length) console.log('  -> Queue: ' + apiQueue.length + ' waiting');
  try {
    const res = await entry.task();
    entry.resolve(res);
  } catch (e) {
    entry.reject(e);
  } finally {
      apiQueueBusy = false;
      // Small delay before next queued item to de-risk API rate limits
      await new Promise(r => setTimeout(r, 1000));
      processApiQueue();
  }
}
function enqueueApi(task) {
  return new Promise((resolve, reject) => {
    apiQueue.push({ task, resolve, reject });
    if (!apiQueueBusy) processApiQueue();
  });
}

// Fork-based workers — each request gets its own process
const workerSessions = new Map(); // sessionId -> { worker, startTime, nid, apiKey, dob, resultDeferred, gen }
const activeNids = new Set(); // track NIDs with active sessions to prevent duplicate OTP invalidation
const nidGen = new Map(); // nid -> generation counter (to avoid stale cleanup)

// Queue for non-forked claim routes (/claim-account, /nid-info)
const legacyClaimQueue = [];
let legacyClaimBusy = false;
async function processLegacyClaimQueue() {
  if (legacyClaimBusy || !legacyClaimQueue.length) return;
  legacyClaimBusy = true;
  const entry = legacyClaimQueue.shift();
  try { entry.resolve(await entry.task()); } catch (e) { entry.reject(e); }
  finally { legacyClaimBusy = false; processLegacyClaimQueue(); }
}
function enqueueLegacyClaim(task) {
  return new Promise((resolve, reject) => {
    legacyClaimQueue.push({ task, resolve, reject });
    if (!legacyClaimBusy) processLegacyClaimQueue();
  });
}

const app = express();
const PORT = 3005;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Serve buy page at /buy
app.get('/buy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'buy.html'));
});

// Session middleware for admin
app.use(session({
  secret: 'nid-servercopy-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 },
}));

app.use(express.json({ limit: '50mb' }));

// Admin routes
const adminRoutes = require('./admin-routes');
app.use('/admin', adminRoutes);

// Balance check API for frontend
app.get('/api/check-balance', async (req, res) => {
  try {
    const key = req.query.key || req.headers['x-api-key'];
    if (!key) return res.json({ success: false, error: 'API Key required' });
    const result = await checkBalance(key);
    if (result.valid) {
      const user = await validateApiKey(key);
      res.json({ success: true, balance: result.balance, expire_date: result.expire_date, username: user?.username || '' });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Package list (prices come from .env API_RATE)
app.get('/api/packages', (req, res) => {
  res.json({ success: true, rate: API_RATE, packages: PACKAGES });
});

// --- bKash Auto Payment Gateway ---
const https = require('https');
const BkashPayment = {
  base_url: 'tokenized.pay.bka.sh',
  base_path: '/v1.2.0-beta',
  app_key: 'AVmTrdwap28k9GnyJ4AVUiZJtc',
  app_secret: 'RsPnOg4cK35ZjkRtDDSkVScXnR2T1WQUYG0gHewQDq4ECe4ETeME',
  username: '01977866765',
  password: 'v+H)Oe0ViA$',
  token_cache: null,
  token_expires: 0,

  _httpsPost(path, headers, bodyJson) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.base_url,
        path: this.base_path + path,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        timeout: 20000,
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(bodyJson);
      req.end();
    });
  },

  async grant() {
    if (this.token_cache && Date.now() < this.token_expires) return this.token_cache;
    const body = JSON.stringify({ app_key: this.app_key, app_secret: this.app_secret });
    const headers = { username: this.username, password: this.password };
    const j = await this._httpsPost('/tokenized/checkout/token/grant', headers, body);
    if (j && j.id_token) {
      this.token_cache = j.id_token;
      this.token_expires = Date.now() + 55 * 60 * 1000;
      return j.id_token;
    }
    throw new Error('bKash grant failed: ' + JSON.stringify(j));
  },

  async _authHeaders() {
    const token = await this.grant();
    return { 'Authorization': token, 'X-APP-Key': this.app_key };
  },

  async createPayment(amount, callbackURL, payerRef) {
    const headers = await this._authHeaders();
    const body = JSON.stringify({ mode: '0011', payerReference: String(payerRef), callbackURL, amount: String(amount), currency: 'BDT', intent: 'sale', merchantInvoiceNumber: 'Inv' + Math.random().toString(36).substring(2, 12).toUpperCase() });
    return this._httpsPost('/tokenized/checkout/create', headers, body);
  },

  async executePayment(paymentID) {
    const headers = await this._authHeaders();
    return this._httpsPost('/tokenized/checkout/execute', headers, JSON.stringify({ paymentID }));
  },
};

const API_RATE = parseFloat(process.env.API_RATE || '20'); // BDT per token
const PACKAGES = [
  { id: 1, name: 'বেসিক', tokens: 1, price: 1 * API_RATE },
  { id: 2, name: 'সিলভার', tokens: 5, price: 5 * API_RATE },
  { id: 3, name: 'গোল্ড', tokens: 10, price: 10 * API_RATE },
  { id: 4, name: 'প্লাটিনাম', tokens: 25, price: 25 * API_RATE },
  { id: 5, name: 'প্রিমিয়াম', tokens: 50, price: 50 * API_RATE },
  { id: 6, name: 'ডায়মন্ড', tokens: 100, price: 100 * API_RATE },
];

// Create bKash payment and prepare order
app.post('/api/bkash/create-payment', express.json(), async (req, res) => {
  try {
    const { packageId, phone } = req.body;
    if (!packageId || !phone) return res.json({ success: false, error: 'packageId এবং phone প্রদান করুন।' });
    const pkg = PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.json({ success: false, error: 'ভুল প্যাকেজ আইডি।' });

    // Create deposit record
    const deposits = readJSON('deposits.json');
    const depId = (deposits.reduce((m, d) => Math.max(m, d.id || 0), 0) || 0) + 1;
    const deposit = { id: depId, package_id: packageId, package_name: pkg.name, tokens: pkg.tokens, amount: pkg.price, phone, status: 0, paymentID: null, trxID: null, api_key: null, created_at: new Date().toISOString(), updated_at: null };
    deposits.push(deposit);
    writeJSON('deposits.json', deposits);

    // Create bKash payment
    const callbackURL = `https://sign.smart-seba.com/api/bkash/callback?depositId=${depId}`;
    console.log('Creating bKash payment for:', pkg.price, 'BDT, phone:', phone);
    const result = await BkashPayment.createPayment(pkg.price, callbackURL, phone);
    if (!result || !result.paymentID || !result.bkashURL) {
      console.log('bKash create failed:', JSON.stringify(result));
      return res.json({ success: false, error: 'bKash payment তৈরি ব্যর্থ হয়েছে।', details: result });
    }

    // Save paymentID
    deposit.paymentID = result.paymentID;
    const idx = deposits.findIndex(d => d.id === depId);
    if (idx !== -1) { deposits[idx].paymentID = result.paymentID; writeJSON('deposits.json', deposits); }

    console.log('bKash payment created ID:', result.paymentID, 'deposit:', depId);
    res.json({ success: true, bkashURL: result.bkashURL, paymentID: result.paymentID, depositId: depId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// bKash callback after user pays
app.get('/api/bkash/callback', async (req, res) => {
  try {
    const { paymentID, status, depositId } = req.query;
    if (!paymentID || !depositId) return res.send(`<script>window.location.href='/buy?error=invalid'</script>`);

    const deposits = readJSON('deposits.json');
    const depIdx = deposits.findIndex(d => d.id === Number(depositId));
    if (depIdx === -1) return res.send(`<script>window.location.href='/buy?error=notfound'</script>`);

    if (status === 'cancel' || status === 'failure') {
      deposits[depIdx].status = -1;
      writeJSON('deposits.json', deposits);
      return res.send(`<script>window.location.href='/buy?error=${status}'</script>`);
    }

    // Execute payment
    const result = await BkashPayment.executePayment(paymentID);
    if (!result || result.statusCode !== '0000') {
      console.log('bKash execute failed:', result);
      deposits[depIdx].status = -2;
      writeJSON('deposits.json', deposits);
      return res.send(`<script>window.location.href='/buy?error=execution_failed'</script>`);
    }

    // Generate API Key
    const apiKey = 'SBR_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const expireDate = new Date(); expireDate.setDate(expireDate.getDate() + 360);
    const keys = readJSON(KEYS_FILE);
    const maxId = keys.reduce((m, k) => Math.max(m, k.id || 0), 0);
    const newKey = { id: maxId + 1, api_key: apiKey, username: deposits[depIdx].phone, email: null, balance: deposits[depIdx].tokens, total_request_used: 0, last_ip: req.ip || '', created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), expire_date: expireDate.toISOString().slice(0, 10), total_renew: 0 };
    keys.push(newKey);
    writeJSON(KEYS_FILE, keys);

    // Update deposit
    deposits[depIdx].status = 1;
    deposits[depIdx].trxID = result.trxID || paymentID;
    deposits[depIdx].api_key = apiKey;
    deposits[depIdx].updated_at = new Date().toISOString();
    writeJSON('deposits.json', deposits);

    // Save to orders
    const orders = readJSON('pending_orders.json');
    orders.unshift({ id: orders.length + 1, trx_id: result.trxID || paymentID, phone: deposits[depIdx].phone, package_name: deposits[depIdx].package_name, tokens: deposits[depIdx].tokens, amount: deposits[depIdx].amount, api_key: apiKey, status: 'success', created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    writeJSON('pending_orders.json', orders);

    console.log('API Key created via bKash:', apiKey);

    // Show success page
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>পেমেন্ট সফল</title><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:linear-gradient(145deg,#eef2f7,#f8fafc);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:16px;padding:32px 28px;max-width:500px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}.icon{font-size:56px;color:#16a34a;margin-bottom:12px}h2{color:#1e293b;margin-bottom:4px}p{color:#64748b;font-size:14px;margin-bottom:20px}.key-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:8px;margin-bottom:12px;text-align:left}.key-box code{flex:1;font-size:13px;word-break:break-all;color:#1e293b}.key-box button{background:none;border:none;cursor:pointer;font-size:20px;color:#2563eb}.balance{font-size:28px;font-weight:800;color:#16a34a;margin-bottom:4px}.label{font-size:12px;color:#94a3b8;margin-bottom:12px}.btn{display:inline-flex;align-items:center;gap:8px;background:#2563eb;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px}.btn:hover{background:#1d4ed8}.expiry{font-size:13px;color:#64748b;margin-bottom:16px}.row{display:flex;gap:12px;margin-bottom:16px}.row>div{flex:1;background:#f8fafc;border-radius:10px;padding:10px;text-align:center}.row .val{font-weight:700;font-size:16px;color:#1e293b}.row .lbl{font-size:11px;color:#94a3b8}</style></head><body><div class="card"><div class="icon"><i class="fas fa-check-circle"></i></div><h2>✅ পেমেন্ট সফল!</h2><p>আপনার API Key তৈরি হয়েছে। নিচের তথ্য সংরক্ষণ করুন।</p><div class="key-box"><code id="apiKey">${apiKey}</code><button onclick="navigator.clipboard.writeText('${apiKey}').then(()=>{document.getElementById('copyMsg').textContent='✅ কপি!'})" title="কপি"><i class="fas fa-copy"></i></button></div><div id="copyMsg" style="font-size:12px;color:#16a34a;margin-bottom:12px;min-height:18px"></div><div class="row"><div><div class="val">${deposits[depIdx].tokens}</div><div class="lbl">টোকেন</div></div><div><div class="val">${deposits[depIdx].amount} টাকা</div><div class="lbl">মূল্য</div></div></div><div class="balance">${deposits[depIdx].tokens} টোকেন</div><div class="label">ব্যালেন্স</div><div class="expiry">📅 মেয়াদ: ${new Date(expireDate).toLocaleDateString('bn-BD',{year:'numeric',month:'long',day:'numeric'})}</div><a href="/manual-claim.html" class="btn"><i class="fas fa-arrow-right"></i> API ব্যবহার করতে যান</a></div></body></html>`);
  } catch (err) {
    console.log('bKash callback error:', err.message);
    res.send(`<script>window.location.href='/buy?error=callback_error'</script>`);
  }
});

app.post('/decode', async (req, res) => {
  try {
    const { image: base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    const matches = base64Image.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image format' });
    }

    const imageBuffer = Buffer.from(matches[2], 'base64');
    const image = await Jimp.read(imageBuffer);
    const { data, width, height } = image.bitmap;

    const code = jsQR(data, width, height);
    if (!code) {
      return res.status(400).json({ error: 'No QR code found in image' });
    }

    const result = decryptNidToken(code.data);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify', async (req, res) => {
  try {
    const { jobId, url, faceImage } = req.body;
    if (!jobId || !url) {
      return res.status(400).json({ error: 'jobId and url are required' });
    }

    const results = { put: null, commence: null };

    if (faceImage) {
      const matches = faceImage.match(/^data:image\/(jpeg|jpg);base64,(.+)$/);
      if (!matches) {
        return res.status(400).json({ error: 'Face image must be JPEG' });
      }
      const imageBuffer = Buffer.from(matches[2], 'base64');

      const putRes = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: imageBuffer,
      });

      const putBody = await putRes.text();
      results.put = {
        status: putRes.status,
        statusText: putRes.statusText,
        body: putBody,
      };
    }

    const formBody = `jobId=${encodeURIComponent(jobId)}`;
    const commenceUrl = 'https://prportal.nidw.gov.bd/nid-pub/afrs/v3/commence';

    const commenceRes = await fetch(commenceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });

    const commenceText = await commenceRes.text();
    results.commence = {
      status: commenceRes.status,
      statusText: commenceRes.statusText,
      body: commenceText,
    };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/claim-account', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { nid, day, month, year, email, mobile, contactType, faceUrl } = req.body;

    if (!nid || !day || !month || !year) {
      return res.status(400).json({ error: 'nid, day, month, year are required' });
    }

    const useSms = (!contactType || contactType === 'sms');
    const contactValue = useSms ? mobile : email;

    const dob = year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0');
    const sessionId = 'claim-' + nid + '-' + Date.now();

    console.log('');
    console.log('========================================');
    console.log('Claim Account Started: ' + sessionId);
    console.log('========================================');
    console.log('[1/3] NID: ' + nid + ', DOB: ' + dob + ', Contact: ' + (useSms ? 'SMS-' + mobile : (email || 'none')));

    const otpDeferred = deferred();
    const resultDeferred = deferred();
    const sessionEntry = { otpDeferred, resultDeferred, createdAt: Date.now(), nid };
    manualOtpSessions.set(sessionId, sessionEntry);

    enqueueLegacyClaim(() => claimAccount({
      nid, day, month, year,
      email: email || '',
      mobile: mobile || '',
      contactType: useSms ? 'sms' : 'email',
      faceUrl: faceUrl || '',
      manualOtpSessionId: sessionId,
      headless: true,
      gmailTimeout: 300000,
    })).then(result => {
      const entry = manualOtpSessions.get(sessionId);
      if (entry && entry.resultDeferred) entry.resultDeferred.resolve(result);
    }).catch(err => {
      const entry = manualOtpSessions.get(sessionId);
      if (entry && entry.resultDeferred) entry.resultDeferred.resolve({ success: false, error: err.message });
    });

    console.log('  -> Legacy claim queued. Queue waiters: ' + legacyClaimQueue.length);
    res.json({ success: true, sessionId, message: 'OTP পাঠানো হয়েছে। অনুগ্রহ করে OTP টি প্রবেশ করান।' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/claim-account/addresses', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    let data = refresh ? null : loadCache();

    if (!data) {
      const { nid, day, month, year, captcha } = req.body;
      const nidOpts = (nid && day && month && year)
        ? { nid, day, month, year, captcha: captcha || '' }
        : null;
      data = await fetchAddressData(nidOpts);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- NID+DOB Cache (reuse previous lookups so balance isn't deducted again) ---
const NID_CACHE_FILE = path.join(__dirname, 'data', 'nid_cache.json');

function setNidCache(nid, dob, data) {
  try {
    let cache = {};
    if (fs.existsSync(NID_CACHE_FILE)) {
      const raw = fs.readFileSync(NID_CACHE_FILE, 'utf8');
      if (raw && raw !== '[]') {
        cache = JSON.parse(raw);
      }
      if (Array.isArray(cache)) cache = {};
    }
    const key = nid + '|' + dob;
    cache[key] = data;
    const dir = path.dirname(NID_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NID_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    console.log('  -> Cache saved for NID: ' + nid + ', cache size: ' + Object.keys(cache).length + ' entries');
  } catch (err) {
    console.log('  -> Cache write error: ' + err.message);
  }
}

function getNidCache(nid, dob) {
  try {
    if (!fs.existsSync(NID_CACHE_FILE)) {
      return null;
    }
    let cache;
    try {
      const raw = fs.readFileSync(NID_CACHE_FILE, 'utf8');
      cache = JSON.parse(raw);
      if (Array.isArray(cache)) cache = {};
    } catch {
      cache = {};
    }
    const key = nid + '|' + dob;
    if (cache[key]) {
      console.log('  -> ✅ ক্যাশে পাওয়া গেছে (HIT) — NID: ' + nid);
      return cache[key];
    }
    console.log('  -> ❌ ক্যাশে নেই (MISS) — NID: ' + nid);
    return null;
  } catch (err) {
    console.log('  -> Cache read error: ' + err.message);
    return null;
  }
}

// --- Manual OTP Claim (user enters OTP manually) ---

const MANUAL_CLAIM_TIMEOUT = 480000; // 8 min (password set + login verify needs extra time)
const NID_API_URL = process.env.NID_API_URL || 'https://virtual-suport.com/sv.php';
const NID_API_KEY = process.env.NID_API_KEY || 'SBR_q92j97vdc5dm56kee03enc';

// Cleanup expired manual sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of manualOtpSessions) {
    if (now - session.createdAt > MANUAL_CLAIM_TIMEOUT + 60000) {
      manualOtpSessions.delete(id);
    }
  }
}, 120000);

app.post('/manual-claim/start', express.urlencoded({ extended: true }), async (req, res) => {
  let nid;
  try {
    const body = req.body;
    nid = body.nid;
    let day = body.day, month = body.month, year = body.year;
    let email = body.email || '', mobile = body.mobile || '', contactType = body.contactType || '';
    const { key, autoOtp } = body;

    // Auto-OTP mode: force OTP to our own Gmail using a per-NID plus-alias
    // (smartseba500+<NID>@gmail.com) so each claim's OTP is uniquely isolable
    // even under heavy concurrent load — no OTP can ever get mixed up.
    const autoOtpEnabled = autoOtp === true || autoOtp === 'true' || autoOtp === '1';
    let otpTo = '';
    if (autoOtpEnabled) {
      const imapUser = process.env.IMAP_USER || 'smartseba500@gmail.com';
      const userPart = imapUser.split('@')[0];
      const domainPart = imapUser.split('@')[1] || 'gmail.com';
      otpTo = userPart + '+' + nid + '@' + domainPart;
      email = otpTo;
      mobile = '';
      contactType = 'email';
    }

    const useSms = (!contactType || contactType === 'sms');
    const contactValue = useSms ? mobile : email;

    if (!nid || !day || !month || !year || !contactValue) {
      return res.status(400).json({ success: false, error: 'nid, day, month, year, and ' + (useSms ? 'mobile' : 'email') + ' are required' });
    }

    // API Key যাচাই
    if (!key) {
      return res.status(400).json({ success: false, error: 'API Key প্রদান করা হয়নি। একটি বৈধ API Key দিন।' });
    }

    const balanceCheck = await checkBalance(key);
    if (!balanceCheck.valid) {
      return res.status(403).json({ success: false, error: balanceCheck.error, balance: balanceCheck.balance || 0 });
    }

    // ⚡ Kill any old session for this NID before starting a new one
    for (const [sid, entry] of workerSessions) {
      if (entry.nid === nid) {
        console.log('  -> পুরনো সেশন বন্ধ করা হচ্ছে (NID: ' + nid + ')');
        try { entry.worker.kill(); } catch {}
        workerSessions.delete(sid);
        break;
      }
    }
    const gen = (nidGen.get(nid) || 0) + 1;
    nidGen.set(nid, gen);
    activeNids.add(nid);

    const dob = year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0');
    const sessionId = 'manual-' + nid + '-' + Date.now();
    const startTime = Date.now();

    console.log('');
    console.log('========================================');
    console.log('Manual Claim Started: ' + sessionId);
    console.log('========================================');
    console.log('[1/3] NID: ' + nid + ', DOB: ' + dob + ', Contact: ' + (useSms ? 'SMS-' + mobile : email) + ', Key: ' + key.substring(0, 8) + '...');

    // ⚡ Check cache — skip balance deduction & external API if already looked up
    const cachedData = getNidCache(nid, dob);
    let d, apiResponseTime, faceUrl, present, permanent, fromCache = false;

    if (cachedData) {
      console.log('  -> ✅ ক্যাশে থেকে ডাটা নেওয়া হচ্ছে (কোনো ব্যালেন্স কাটা হয়নি)');
      d = cachedData.d;
      apiResponseTime = '(cached)';
      faceUrl = cachedData.faceUrl;
      present = cachedData.present;
      permanent = cachedData.permanent;
      fromCache = true;
    } else {
      // ⚡ Balance deduct only on first lookup
      await deductBalance(key);
      console.log('  -> ✅ ব্যালেন্স কাটা হয়েছে (প্রথমবার লুকআপ) — কী: ' + key.substring(0, 8) + '...');

      // Log request as 'processing' immediately
      logRequest({
        apiKey: key, endpoint: 'manual-claim', nid,
        dob, status: 'processing',
        responseTime: 0, dataSource: 'manual_claim',
        userIp: req.ip || req.connection?.remoteAddress || '',
      }).catch(() => {});

      console.log('[2/3] Queued for external API...');
      const apiUrl = `${NID_API_URL}?key=${NID_API_KEY}&nid=${encodeURIComponent(nid)}&dob=${encodeURIComponent(dob)}`;
      const apiStart = Date.now();
      const apiData = await enqueueApi(() => {
        console.log('  -> External API call started for NID: ' + nid);
        return (async function retryApi(retries = 3) {
          for (let i = 0; i < retries; i++) {
            try {
              const r = await fetch(apiUrl);
              const j = await r.json();
              if (j.success && j['data-Info'] && (j['data-Info'].nameEnglish || j['data-Info'].nameBangla)) return j;
            } catch {}
            if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
          }
          const final = await fetch(apiUrl);
          return final.json();
        })();
      });
      apiResponseTime = ((Date.now() - apiStart) / 1000).toFixed(1);

      if (!apiData.success) {
        activeNids.delete(nid);
        await refundBalance(key).catch(() => {});
        console.log('  -> Refunded: external API failed for key: ' + key.substring(0, 8));
        return res.status(400).json({ success: false, error: apiData.message || 'External API failed', apiResponseTime: apiResponseTime + 's' });
      }

      d = apiData['data-Info'];
      if (!d || (!d.nameEnglish && !d.nameBangla)) {
        activeNids.delete(nid);
        await refundBalance(key).catch(() => {});
        console.log('  -> Refunded: incomplete data for key: ' + key.substring(0, 8));
        return res.status(400).json({ success: false, error: 'External API returned incomplete data. Check NID and DOB.', apiResponseTime: apiResponseTime + 's' });
      }

      console.log('  -> Name: ' + (d.nameEnglish || d.nameBangla || '') + ', Photo: ' + (d.photo || 'none'));
      faceUrl = d.photo || '';

      // Parse present & permanent addresses SEPARATELY from API data
      const preDiv = d.presentDivision || '';
      const preDist = d.presentDistrict || '';
      const preUpo = d.presentUpozila || '';

      const perDiv = d.permanentDivision || d.permanentDivision || '';
      const perDist = d.permanentDistrict || '';
      const perUpo = d.permanentUpozila || '';

      // Fallback: if one address is missing, use the other
      const div = preDiv || perDiv;
      const dist = preDist || perDist;
      const upo = preUpo || perUpo;

      const presentAddr = { division: preDiv, district: preDist, upozila: preUpo };
      const permanentAddr = { division: perDiv, district: perDist, upozila: perUpo };

      // Helper to resolve upozila from address line / cache
      function resolveAddress(addr, fallbackDiv, fallbackDist) {
        let div = addr.division || fallbackDiv;
        let dist = addr.district || fallbackDist;
        let upo = addr.upozila || '';

        if (!upo) {
          const addrLine = d.preAddress?.addressLine || d.perAddress?.addressLine || '';
          const upoPatterns = [/উপজেলা[:\s]+([^\s,]+)/, /থানা[:\s]+([^\s,]+)/, /থানাঃ[:\s]*([^\s,]+)/, /উপজেলাঃ[:\s]*([^\s,]+)/];
          for (const p of upoPatterns) {
            const m = addrLine.match(p);
            if (m && m[1] && m[1].trim() !== '-') { upo = m[1].trim(); break; }
          }
        }

        if (!upo) {
          try {
            const cache = require('./address-cache.json');
            let distId = '';
            for (const d0 of cache.divisions) {
              const dists = cache.districts[d0.id] || [];
              const found = dists.find(x => x.name === dist || x.id === dist);
              if (found) { distId = found.id; break; }
            }
            if (distId) {
              const distUpzos = cache.upozilas[distId] || [];
              const words = (d.preAddress?.addressLine || d.perAddress?.addressLine || '').match(/[\u0980-\u09FF]{2,}/g) || [];
              for (const word of words) {
                if (distUpzos.some(u => u.name === word)) { upo = word; break; }
              }
              if (!upo && d.voterArea) {
                const va = d.voterArea.replace(/\(.*\)/g, '').trim();
                if (va && distUpzos.some(u => u.name === va)) upo = va;
              }
            }
          } catch {}
        }

        return { division: div, district: dist, upozila: upo || dist };
      }

      present = resolveAddress(presentAddr, div, dist);
      permanent = resolveAddress(permanentAddr, div, dist);

      if (!present.upozila && !permanent.upozila) {
        activeNids.delete(nid);
        await refundBalance(key).catch(() => {});
        console.log('  -> Refunded: could not resolve upozila for key: ' + key.substring(0, 8));
        return res.status(400).json({ success: false, error: 'Could not determine upozila', apiResponseTime: apiResponseTime + 's' });
      }

      // Cache the resolved data for future retries
      setNidCache(nid, dob, { d, faceUrl, present, permanent });
    }

    console.log('  -> Present: division=' + present.division + ', district=' + present.district + ', upozila=' + present.upozila);
    console.log('  -> Permanent: division=' + permanent.division + ', district=' + permanent.district + ', upozila=' + permanent.upozila);

    console.log('[3/3] Starting claim account process (fork)...');

    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'worker-' + nid + '-' + Date.now() + '.log');
    const logFd = fs.openSync(logFile, 'a');
    const worker = fork('./worker.js', [], { stdio: ['pipe', logFd, logFd, 'ipc'] });
    console.log('  -> Worker PID ' + worker.pid + ' — log: logs/worker-' + nid + '-' + Date.now() + '.log');
    const resultDeferred = deferred();

    const workerTimeout = setTimeout(() => {
      worker.kill();
      if (nidGen.get(nid) === gen) { activeNids.delete(nid); nidGen.delete(nid); }
      resultDeferred.resolve({ success: false, error: 'Worker timeout' });
    }, MANUAL_CLAIM_TIMEOUT + 120000);

    worker.on('message', (workerMsg) => {
      if (workerMsg.type === 'session_created') {
        workerSessions.set(sessionId, { worker, startTime, nid, apiKey: key, dob, resultDeferred, gen, progress: null, resultReady: false, finalResult: null });
        const nidPreview = {
          nameBn: d?.nameBangla || '',
          nameEn: d?.nameEnglish || '',
          photo: d?.photo || '',
          presentAddress: {
            division: present?.division || d?.presentDivision || '',
            district: present?.district || d?.presentDistrict || '',
            upozila: present?.upozila || d?.presentUpozila || '',
          },
          permanentAddress: {
            division: permanent?.division || d?.permanentDivision || '',
            district: permanent?.district || d?.permanentDistrict || '',
            upozila: permanent?.upozila || d?.permanentUpozila || '',
          },
          voterArea: d?.voterArea || '',
        };
        res.json({
          success: true,
          sessionId,
          balance: balanceCheck.balance,
          fromCache: fromCache,
          nidPreview: nidPreview,
          message: fromCache
            ? '✅ ক্যাশে থেকে ডাটা নেওয়া হয়েছে। কোনো ব্যালেন্স কাটা হয়নি। OTP পাঠানো হয়েছে।'
            : 'OTP পাঠানো হয়েছে। অনুগ্রহ করে OTP টি প্রবেশ করান।',
        });
      } else if (workerMsg.type === 'progress') {
        const entry = workerSessions.get(workerMsg.sessionId);
        if (entry) {
          entry.progress = {
            step: workerMsg.step || 0,
            percent: workerMsg.percent || 0,
            message: workerMsg.message || '',
          };
        }
      } else if (workerMsg.type === 'result') {
        clearTimeout(workerTimeout);
        if (nidGen.get(nid) === gen) { activeNids.delete(nid); nidGen.delete(nid); }
        const entry = workerSessions.get(workerMsg.sessionId);
        if (entry) { entry.resultReady = true; entry.finalResult = workerMsg.result; }
        resultDeferred.resolve(workerMsg.result);
      }
    });

    worker.on('error', () => {
      clearTimeout(workerTimeout);
      if (nidGen.get(nid) === gen) { activeNids.delete(nid); nidGen.delete(nid); }
      resultDeferred.resolve({ success: false, error: 'Worker error' });
    });
    worker.on('exit', () => {
      clearTimeout(workerTimeout);
      if (nidGen.get(nid) === gen) { activeNids.delete(nid); nidGen.delete(nid); }
    });

    worker.send({ type: 'start', sessionId, nid, day, month, year, email, mobile, contactType: useSms ? 'sms' : 'email',
      faceUrl: faceUrl || d?.photo || '', gmailTimeout: MANUAL_CLAIM_TIMEOUT,
      division: present.division, district: present.district, upozila: present.upozila,
      perDivision: permanent.division, perDistrict: permanent.district, perUpozila: permanent.upozila,
      autoOtp: autoOtpEnabled,
      otpTo,
    });
  } catch (err) {
    if (nidGen.get(nid) === gen) { activeNids.delete(nid); nidGen.delete(nid); }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/manual-claim/verify', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { sessionId, otp } = req.body;
    if (!sessionId || !otp) {
      return res.status(400).json({ success: false, error: 'sessionId and otp are required' });
    }

    const sessionEntry = workerSessions.get(sessionId);
    if (!sessionEntry) {
      return res.status(400).json({ success: false, error: 'Session not found or expired. Start again.' });
    }

    console.log('  -> Manual OTP submitted for session: ' + sessionId);
    const claimStart = Date.now();

    sessionEntry.worker.send({ type: 'otp', sessionId, otp });

    const claimResult = await Promise.race([
      sessionEntry.resultDeferred.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Processing timeout after OTP')), MANUAL_CLAIM_TIMEOUT)),
    ]);

    const nid = sessionEntry.nid;
    const nidDir = path.join(__dirname, 'downloads', nid);
    workerSessions.delete(sessionId);

    let profile = null;
    const profileJsonPath = path.join(nidDir, 'profile.json');
    if (fs.existsSync(profileJsonPath)) {
      try { profile = JSON.parse(fs.readFileSync(profileJsonPath, 'utf8')); } catch {}
    }

    let nidPdf = 'NID PDF not found';
    const pdfPath = path.join(nidDir, nid + '-nid.pdf');
    if (fs.existsSync(pdfPath)) nidPdf = `https://sign.smart-seba.com/downloads/${nid}/${nid}-nid.pdf`;

    let sigMain = null, sigOfficer = null, pin = null;
    if (claimResult) {
      if (claimResult.sigMain) sigMain = `https://sign.smart-seba.com${claimResult.sigMain}`;
      if (claimResult.sigOfficer) sigOfficer = `https://sign.smart-seba.com${claimResult.sigOfficer}`;
      if (claimResult.pin) pin = claimResult.pin;
    }

    const claimTime = ((Date.now() - claimStart) / 1000).toFixed(1);
    const totalTime = ((Date.now() - sessionEntry.startTime) / 1000).toFixed(1);

    // Log final status (balance already deducted at start)
    if (sessionEntry.apiKey) {
      try {
        const profileJson = profile ? JSON.stringify(profile) : '';
        logRequest({
          apiKey: sessionEntry.apiKey,
          endpoint: 'manual-claim',
          nid,
          dob: sessionEntry.dob || '',
          status: claimResult.success ? 'success' : 'failed',
          nidPhoto: profile?.photoUrl || '',
          fullResponse: profileJson,
          responseTime: totalTime,
          dataSource: 'manual_claim',
          userIp: req.ip || req.connection?.remoteAddress || '',
        });
        if (claimResult.success) {
          console.log('  -> Request completed for key: ' + sessionEntry.apiKey.substring(0, 8) + '...');
        } else {
          console.log('  -> Request failed for key: ' + sessionEntry.apiKey.substring(0, 8) + '...');
        }
      } catch (err) {
        console.log('  -> Log error: ' + err.message);
      }
    }

    // Get remaining balance
    let remainingBalance = null;
    if (claimResult.success && sessionEntry.apiKey) {
      try {
        const { checkBalance } = require('./db');
        const bc = await checkBalance(sessionEntry.apiKey);
        if (bc.valid) remainingBalance = bc.balance;
      } catch {}
    }

    const rawResponse = {
      success: claimResult.success,
      nid,
      error: claimResult.success ? undefined : (claimResult.error || 'Something went wrong. Try again.'),
      profile,
      nidPdf,
      sigMain,
      sigOfficer,
      pin,
      walletUsername: claimResult.walletUsername || undefined,
      walletPassword: claimResult.walletPassword || undefined,
      balance: remainingBalance,
      timing: {
        apiResponse: '0s',
        claimProcess: claimTime + 's',
        total: totalTime + 's',
      },
    };

    // Save wallet credentials to profile.json
    if (claimResult.walletUsername && claimResult.walletPassword && profile) {
      try {
        profile.walletUsername = claimResult.walletUsername;
        profile.walletPassword = claimResult.walletPassword;
        const nidDir = path.join(__dirname, 'downloads', nid);
        const profileJsonPath = path.join(nidDir, 'profile.json');
        if (fs.existsSync(profileJsonPath)) {
          fs.writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2));
        }
      } catch (e) {
        console.log('  -> Save wallet creds error: ' + e.message);
      }
    }

    res.json(formatNidResponse(rawResponse));
  } catch (err) {
    const { sessionId } = req.body;
    if (sessionId) {
      const entry = workerSessions.get(sessionId);
      if (entry) {
        if (nidGen.get(entry.nid) === entry.gen) { activeNids.delete(entry.nid); nidGen.delete(entry.nid); }
      }
      workerSessions.delete(sessionId);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Auto-OTP status polling: returns the final result once the worker finishes ---
app.get('/manual-claim/status', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const sessionEntry = workerSessions.get(sessionId);
    if (!sessionEntry) {
      return res.json({ success: false, error: 'Session not found or expired. Start again.' });
    }

    if (!sessionEntry.resultReady || !sessionEntry.finalResult) {
      const progress = sessionEntry.progress || null;
      return res.json({ success: false, pending: true, message: 'Still processing...', progress });
    }
    const claimResult = sessionEntry.finalResult;

    const nid = sessionEntry.nid;
    const nidDir = path.join(__dirname, 'downloads', nid);
    workerSessions.delete(sessionId);

    let profile = null;
    const profileJsonPath = path.join(nidDir, 'profile.json');
    if (fs.existsSync(profileJsonPath)) {
      try { profile = JSON.parse(fs.readFileSync(profileJsonPath, 'utf8')); } catch {}
    }

    let nidPdf = 'NID PDF not found';
    const pdfPath = path.join(nidDir, nid + '-nid.pdf');
    if (fs.existsSync(pdfPath)) nidPdf = `https://sign.smart-seba.com/downloads/${nid}/${nid}-nid.pdf`;

    let sigMain = null, sigOfficer = null, pin = null;
    if (claimResult) {
      if (claimResult.sigMain) sigMain = `https://sign.smart-seba.com${claimResult.sigMain}`;
      if (claimResult.sigOfficer) sigOfficer = `https://sign.smart-seba.com${claimResult.sigOfficer}`;
      if (claimResult.pin) pin = claimResult.pin;
    }

    const totalTime = ((Date.now() - sessionEntry.startTime) / 1000).toFixed(1);

    // Log final status (balance already deducted at start)
    if (sessionEntry.apiKey) {
      try {
        const profileJson = profile ? JSON.stringify(profile) : '';
        logRequest({
          apiKey: sessionEntry.apiKey,
          endpoint: 'manual-claim',
          nid,
          dob: sessionEntry.dob || '',
          status: claimResult.success ? 'success' : 'failed',
          nidPhoto: profile?.photoUrl || '',
          fullResponse: profileJson,
          responseTime: totalTime,
          dataSource: 'manual_claim',
          userIp: req.ip || req.connection?.remoteAddress || '',
        });
      } catch (err) {
        console.log('  -> Log error: ' + err.message);
      }
    }

    // Get remaining balance
    let remainingBalance = null;
    if (claimResult.success && sessionEntry.apiKey) {
      try {
        const { checkBalance } = require('./db');
        const bc = await checkBalance(sessionEntry.apiKey);
        if (bc.valid) remainingBalance = bc.balance;
      } catch {}
    }

    const rawResponse = {
      success: claimResult.success,
      nid,
      error: claimResult.success ? undefined : (claimResult.error || 'Something went wrong. Try again.'),
      profile,
      nidPdf,
      sigMain,
      sigOfficer,
      pin,
      walletUsername: claimResult.walletUsername || undefined,
      walletPassword: claimResult.walletPassword || undefined,
      balance: remainingBalance,
      timing: {
        apiResponse: '0s',
        claimProcess: (parseFloat(totalTime) - parseFloat(((sessionEntry.startTime) ? 0 : 0))).toFixed(1) + 's',
        total: totalTime + 's',
      },
    };

    // Save wallet credentials to profile.json
    if (claimResult.walletUsername && claimResult.walletPassword && profile) {
      try {
        profile.walletUsername = claimResult.walletUsername;
        profile.walletPassword = claimResult.walletPassword;
        if (fs.existsSync(profileJsonPath)) {
          fs.writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2));
        }
      } catch (e) {
        console.log('  -> Save wallet creds error: ' + e.message);
      }
    }

    res.json(formatNidResponse(rawResponse));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- NID Info Lookup ---



// --- NID Info Card (HTML version matching servercopy design) ---

function formatNidResponse(data) {
  const p = data.profile || {};
  const personal = p.personal || {};
  const father = p.father || {};
  const mother = p.mother || {};
  const spouse = p.spouse || {};
  const other = p.other || {};
  const preAddr = p.presentAddress || {};
  const perAddr = p.permanentAddress || {};

  const resp = {
    success: data.success,
    nid: data.nid,
  };
  if (data.balance !== null && data.balance !== undefined) resp.balance = data.balance;
  if (data.pin) resp.pin = data.pin;
  if (personal.dob) resp.dob = personal.dob;
  if (personal.nameBn) resp.nameBn = personal.nameBn;
  if (personal.nameEn) resp.nameEn = personal.nameEn;
  if (personal.gender) resp.gender = personal.gender;
  if (personal.bloodGroup) resp.bloodGroup = personal.bloodGroup;
  if (personal.birthRegNo) resp.birthRegNo = personal.birthRegNo;
  if (other.education) resp.education = other.education;
  if (other.occupation) resp.occupation = other.occupation;
  if (other.religion) resp.religion = other.religion;
  if (spouse.maritalStatus) resp.maritalStatus = spouse.maritalStatus;
  if (spouse.nameBn) resp['spouse nameBn'] = spouse.nameBn;
  if (spouse.nameEn) resp['spouse nameEn'] = spouse.nameEn;
  if (other.mobile) resp.mobile = other.mobile;
  if (personal.placeOfBirth) resp.placeOfBirth = personal.placeOfBirth;
  if (p.voterArea) resp.voterArea = p.voterArea;
  if (father.nameBn) resp['father nameBn'] = father.nameBn;
  if (father.nid) resp['father nid'] = father.nid;
  if (mother.nameBn) resp['mother nameBn'] = mother.nameBn;
  if (mother.nid) resp['mother nid'] = mother.nid;
  

  const hasAddr = (a) => Object.values(a).some(v => v && v.toString().trim());
  if (hasAddr(preAddr)) resp.presentAddress = preAddr;
  if (hasAddr(perAddr)) resp.permanentAddress = perAddr;

  const fullAddr = addrToString(preAddr);
  if (fullAddr !== 'N/A') resp.preAddress = { addressLine: fullAddr };
  const fullPerAddr = addrToString(perAddr);
  if (fullPerAddr !== 'N/A') resp.perAddress = { addressLine: fullPerAddr };

  if (p.photoUrl) resp.photoUrl = p.photoUrl;
  if (data.sigMain) resp.signUrl = data.sigMain;
  if (data.nidPdf) resp.nidPdfDownloadUrl = data.nidPdf;
  if (data.walletUsername) resp.walletUsername = data.walletUsername;
  if (data.walletPassword) resp.walletPassword = data.walletPassword;
  if (data.timing) resp.timing = data.timing;

  return resp;
}

function addrToString(addr) {
  if (!addr) return 'N/A';
  const parts = [];
  if (addr.house) parts.push('বাসা/হোল্ডিংঃ ' + addr.house);
  if (addr.village) parts.push('গ্রাম/রাস্তাঃ ' + addr.village);
  if (addr.mouza) parts.push('মৌজা/মহল্লাঃ ' + addr.mouza);
  if (addr.union) parts.push('ইউনিয়নঃ ' + addr.union);
  if (addr.wardNo) parts.push('ওয়ার্ড নং-' + addr.wardNo);
  if (addr.postOffice) parts.push('ডাকঘরঃ ' + addr.postOffice + (addr.postCode ? ' - ' + addr.postCode : ''));
  if (addr.upozila) parts.push('উপজেলাঃ ' + addr.upozila);
  if (addr.district) parts.push('জেলাঃ ' + addr.district);
  if (addr.division) parts.push('বিভাগঃ ' + addr.division);
  return parts.length ? parts.join(', ') : 'N/A';
}

function computeAge(dobStr) {
  if (!dobStr) return 'N/A';
  const parts = dobStr.split('/');
  if (parts.length !== 3) return 'N/A';
  const d = new Date(parts[2], parts[1] - 1, parts[0]);
  if (isNaN(d)) return 'N/A';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age + ' বছর';
}

function computeBirthDay(dobStr) {
  if (!dobStr) return 'N/A';
  const parts = dobStr.split('/');
  if (parts.length !== 3) return 'N/A';
  const d = new Date(parts[2], parts[1] - 1, parts[0]);
  if (isNaN(d)) return 'N/A';
  const days = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
  return days[d.getDay()] || 'N/A';
}

app.get('/nid-card/:nid', async (req, res) => {
  try {
    const { nid } = req.params;
    const nidDir = path.join(__dirname, 'downloads', nid);
    const profilePath = path.join(nidDir, 'profile.json');

    if (!fs.existsSync(profilePath)) {
      return res.status(404).send('Profile not found. Claim account first.');
    }

    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const p = profile.personal || {};
    const f = profile.father || {};
    const m = profile.mother || {};
    const s = profile.spouse || {};
    const o = profile.other || {};
    const preAddr = profile.presentAddress || {};
    const perAddr = profile.permanentAddress || {};

    // Try to read PIN from barcode file
    let pin = 'N/A';
    const barcodePath = path.join(nidDir, nid + '-nid-barcode.txt');
    if (fs.existsSync(barcodePath)) {
      const bc = fs.readFileSync(barcodePath, 'utf8');
      const pm = bc.match(/<pin>([^<]+)<\/pin>/);
      if (pm) pin = pm[1];
    }
    const oldId = pin !== 'N/A' && pin.length > 4 ? pin.substring(4) : 'N/A';

    const nameBn = p.nameBn || 'N/A';
    const nameEn = p.nameEn || 'N/A';
    const dob = p.dob || 'N/A';
    const gender = p.gender || 'N/A';
    const religion = o.religion || 'N/A';
    const blood = p.bloodGroup || 'N/A';
    const occupation = o.occupation || 'N/A';
    const birthPlace = p.placeOfBirth || 'N/A';
    const mobile = o.mobile || 'N/A';
    const voterArea = profile.voterArea || 'N/A';
    const fatherName = f.nameBn || 'N/A';
    const motherName = m.nameBn || 'N/A';
    const photoUrl = profile.photoUrl || '';
    const present = addrToString(preAddr);
    const permanent = addrToString(perAddr);
    const age = computeAge(dob);
    const birthDay = computeBirthDay(dob);
    const today = new Date().toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${nameBn}</title>
<link href="https://fonts.googleapis.com/css2?family=Tiro+Bangla&display=swap" rel="stylesheet">
<style>
@page { size: A4; margin: auto; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { text-align: center; font-family: 'Tiro Bangla', serif; }
.background { position: relative; width: 750px; height: 1065px; margin: auto; }
.background img.bg { width: 100%; height: 100%; display: block; }
.abs { position: absolute; font-size: 14px; color: #070707; }
.b { font-weight: bold; }
.t-yellow { color: #ffb62f; }
.t-pink { color: #ff2fa1; }
.t-green { color: #087904; }
.t-blue { color: #0777b8; }
.t-red { color: #fc0000; }
.t-gray { color: #8f8f8f; }
@media print {
  html, body { width: 210mm; height: 297mm; background: #fff; }
  .no-print { display: none !important; }
}
</style>
</head>
<body onload="window.print()">
<div class="background">
  <img class="bg" src="/v1.png" alt="bg">

  <div class="abs" style="left:30%;top:8%;font-size:16px;color:#ffe000"><b>National Identity Registration Wing (NIDW)</b></div>
  <div class="abs" style="left:37%;top:11%;font-size:14px;color:#ff2fa1"><b>Select Your Search Category</b></div>
  <div class="abs" style="left:45%;top:12.8%;font-size:12px;color:#087904">Search By NID / Voter No.</div>
  <div class="abs" style="left:45%;top:14.3%;font-size:12px;color:#0777b8">Search By Form No.</div>
  <div class="abs" style="left:30%;top:16.9%;font-size:12px;color:#fc0000"><b>NID or Voter No*</b></div>
  <div class="abs" style="left:45%;top:16.9%;font-size:12px;color:#8f8f8f">NID</div>
  <div class="abs" style="left:62.9%;top:17.1%;font-size:11px;color:#fff">Submit</div>
  <div class="abs" style="left:89%;top:11.55%;font-size:11px;color:#fff">Home</div>

  <div class="abs" style="left:16%;top:25.7%;">
    <img src="${photoUrl}" alt="Photo" height="140" width="121" style="border-radius:10px" onerror="this.style.display='none'">
  </div>

  <div class="abs" style="left:37%;top:27%;font-size:16px"><b>জাতীয় পরিচিতি তথ্য</b></div>

  <div class="abs" style="left:37%;top:29.7%;font-size:13px">জাতীয় পরিচয় পত্র নম্বর</div>
  <div class="abs" style="left:55%;top:29.7%;font-size:14px">${nid}</div>

  <div class="abs" style="left:37%;top:32.5%;font-size:13px">পিন নম্বর</div>
  <div class="abs" style="left:55%;top:32.5%;font-size:14px">${pin}</div>

  <div class="abs" style="left:37%;top:35%;font-size:13px">পূর্ববর্তী পরিচয়পত্র নম্বর</div>
  <div class="abs" style="left:55%;top:35%;font-size:14px">${oldId}</div>

  <div class="abs" style="left:37%;top:37.5%;font-size:13px">ভোটার এলাকা</div>
  <div class="abs" style="left:55%;top:37.5%;font-size:14px">${voterArea}</div>

  <div class="abs" style="left:37%;top:40.2%;font-size:13px">জন্মস্থান</div>
  <div class="abs" style="left:55%;top:40.2%;font-size:14px">${birthPlace}</div>

  <div class="abs" style="left:37%;top:43%;font-size:16px"><b>ব্যক্তিগত তথ্য</b></div>

  <div class="abs" style="left:37%;top:45.6%;font-size:13px">নাম (বাংলা)</div>
  <div class="abs b" style="left:55%;top:45.6%;font-size:14px">${nameBn}</div>

  <div class="abs" style="left:37%;top:48.5%;font-size:13px">নাম (ইংরেজি)</div>
  <div class="abs" style="left:55%;top:48.5%;font-size:14px">${nameEn}</div>

  <div class="abs" style="left:37%;top:51%;font-size:13px">জন্ম তারিখ</div>
  <div class="abs" style="left:55%;top:51%;font-size:14px">${dob}</div>

  <div class="abs" style="left:37%;top:53.7%;font-size:13px">পিতার নাম</div>
  <div class="abs" style="left:55%;top:53.7%;font-size:14px">${fatherName}</div>

  <div class="abs" style="left:37%;top:56.2%;font-size:13px">মাতার নাম</div>
  <div class="abs" style="left:55%;top:56.2%;font-size:14px">${motherName}</div>

  <div class="abs" style="left:37%;top:59%;font-size:16px"><b>অন্যান্য তথ্য</b></div>

  <div class="abs" style="left:37%;top:62.2%;font-size:13px">লিঙ্গ</div>
  <div class="abs" style="left:55%;top:62.2%;font-size:14px">${gender}</div>

  <div class="abs" style="left:37%;top:64.8%;font-size:13px">ধর্ম</div>
  <div class="abs" style="left:55%;top:64.8%;font-size:14px">${religion}</div>

  <div class="abs" style="left:37%;top:67.5%;font-size:13px">জন্মবার</div>
  <div class="abs" style="left:55%;top:67.5%;font-size:14px">${birthDay}</div>

  <div class="abs" style="left:37%;top:70%;font-size:13px">বয়স</div>
  <div class="abs" style="left:55%;top:70%;font-size:14px">${age}</div>

  <div class="abs" style="left:37%;top:73%;font-size:16px"><b>বর্তমান ঠিকানা</b></div>
  <div id="presentAddr" class="abs" style="left:37%;top:75.5%;width:48%;font-size:12px;text-align:left">${present}</div>

  <div class="abs" style="left:37%;top:82%;font-size:16px"><b>স্থায়ী ঠিকানা</b></div>
  <div id="permanentAddr" class="abs" style="left:37%;top:84.5%;width:48%;font-size:12px;text-align:left">${permanent}</div>

  <div class="abs" style="left:15.5%;top:39.6%;height:32px;width:130px;font-size:13px;display:flex;align-items:center;justify-content:center;font-weight:bold">${nameEn}</div>

  <div class="abs" style="left:15.5%;top:44%;height:32px;width:130px">
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(nameEn + '⇋' + nid + '⇋' + (dob || ''))}" height="100" width="100" alt="QR">
  </div>

  <div class="abs" style="top:92%;width:100%;font-size:12px;color:#fc0000">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</div>
  <div class="abs" style="top:93.5%;width:100%;font-size:12px;color:#030303">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</div>
</div>
<script>
document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
</script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// --- NID Card V2 (Servercopy Download 2 - vv2 design) ---

app.get('/nid-card-v2/:nid', async (req, res) => {
  try {
    const { nid } = req.params;
    const nidDir = path.join(__dirname, 'downloads', nid);
    const profilePath = path.join(nidDir, 'profile.json');

    if (!fs.existsSync(profilePath)) {
      return res.status(404).send('Profile not found. Claim account first.');
    }

    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const p = profile.personal || {};
    const f = profile.father || {};
    const m = profile.mother || {};
    const s = profile.spouse || {};
    const o = profile.other || {};
    const preAddr = profile.presentAddress || {};
    const perAddr = profile.permanentAddress || {};

    let pin = 'N/A';
    const barcodePath = path.join(nidDir, nid + '-nid-barcode.txt');
    if (fs.existsSync(barcodePath)) {
      const bc = fs.readFileSync(barcodePath, 'utf8');
      const pm = bc.match(/<pin>([^<]+)<\/pin>/);
      if (pm) pin = pm[1];
    }

    const nameBn = p.nameBn || 'N/A';
    const nameEn = p.nameEn || 'N/A';
    const photoUrl = profile.photoUrl || '';
    const nationalId = nid;
    const formNumber = p.birthRegNooff || 'N/A';
    const voterNumber = p.birthRegNooff || 'N/A';
    const voterArea = profile.voterArea || 'N/A';
    const dateOfBirth = p.dob || 'N/A';
    const fatherName = f.nameBn || 'N/A';
    const motherName = m.nameBn || 'N/A';
    const spouseName = s.nameBn || 'N/A';
    const gender = p.gender || 'N/A';
    const religion = o.religion || 'N/A';
    const occupation = o.occupation || 'N/A';
    const birthPlace = p.placeOfBirth || 'N/A';
    const mobile = o.mobile || 'N/A';

    function addrLine(addr) {
      if (!addr) return 'N/A';
      const parts = [];
      if (addr.house) parts.push('বাসা/হোল্ডিংঃ ' + addr.house);
      if (addr.village) parts.push('গ্রাম/রাস্তাঃ ' + addr.village);
      if (addr.mouza) parts.push('মৌজা/মহল্লাঃ ' + addr.mouza);
      if (addr.union) parts.push('ইউনিয়নঃ ' + addr.union);
      if (addr.wardNo) parts.push('ওয়ার্ড নং-' + addr.wardNo);
      if (addr.postOffice) parts.push('ডাকঘরঃ ' + addr.postOffice + (addr.postCode ? ' - ' + addr.postCode : ''));
      if (addr.upozila) parts.push('উপজেলাঃ ' + addr.upozila);
      if (addr.district) parts.push('জেলাঃ ' + addr.district);
      if (addr.division) parts.push('বিভাগঃ ' + addr.division);
      return parts.length ? parts.join(', ') : 'N/A';
    }

    const presentAddress = addrLine(preAddr);
    const permanentAddress = addrLine(perAddr);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${nid}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
        }
        .container {
            position: relative;
        }
        .bgImg {
            width: 210mm;
            height: 297mm;
        }
        .avatar {
            width: 130px;
            height: 151px;
            position: absolute;
            top: 187px;
            left: 333px;
            background: red;
            border-radius: 16px;
        }
        p {
            font-size: 15px;
        }
        p.inLeft {
            position: absolute;
            left: 110px;
            opacity: 0.9;
        }
        p.relagionKey.inLeft {
            top: 790px;
        }
        p.mobileKey.inLeft {
            top: 817px;
        }
        p.inRight {
            max-height: 0.393in;
            max-width: 6.33in;
        }
        .inRight {
            position: absolute;
            left: 264px;
        }
        p.nid.inRight {
            top: 400px;
        }
        p.pin.inRight {
            top: 428px;
        }
        p.formNo.inRight {
            top: 457px;
        }
        p.VoterNo.inRight {
            top: 482px;
        }
        p.vArea.inRight {
            top: 510px;
        }
        p.nameBn.inRight {
            top: 567px;
            font-weight: bold;
        }
        p.nameEn.inRight {
            top: 595px;
        }
        p.dob.inRight {
            top: 623px;
        }
        p.fName.inRight {
            top: 649px;
        }
        p.mName.inRight {
            top: 677px;
        }
        p.husWif.inRight {
            top: 703px;
        }
        p.gender.inRight {
            top: 762px;
        }
        p.phone.inRight {
            top: 819px;
        }
        p.relagion.inRight {
            top: 791px;
        }
        p.birthPlace.inRight {
            top: 845px;
        }
        p.address {
            max-width: 575px;
            position: absolute;
            left: 110px;
            font-size: 12px;
            line-height: 18px;
        }
        .presentAddr {
            top: 902px;
        }
        .permanentAddr {
            top: 975px;
        }
        button.PrintBtn {
            width: 150px;
            background: #8a00ff;
            padding: 10px;
            font-weight: bold;
            cursor: pointer;
            display: block;
            margin: auto;
            margin-bottom: 100px;
            border-radius: 6px;
            color: #fff;
            font-size: 16px;
        }
        @media print {
            @page {
                size: A4;
                margin: 0;
            }
            button.PrintBtn {
                display: none;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <img class="bgImg" src="/vv2.png" alt="Background">
        <img src="${photoUrl}" alt="Avatar" class="avatar" onerror="this.style.display='none'">

        <p class="nid inRight">${nationalId}</p>
        <p class="pin inRight">${pin}</p>
        <p class="formNo inRight">${formNumber}</p>
        <p class="VoterNo inRight">${voterNumber}</p>
        <p class="vArea inRight">${voterArea}</p>

        <p class="nameBn inRight">${nameBn}</p>
        <p class="nameEn inRight">${nameEn}</p>
        <p class="dob inRight">${dateOfBirth}</p>
        <p class="fName inRight">${fatherName}</p>
        <p class="mName inRight">${motherName}</p>
        <p class="husWif inRight">${spouseName}</p>

        <p class="gender inRight">${gender}</p>
        <p class="relagion inRight">${religion}</p>
        <p class="phone inRight">${occupation}</p>
        <p class="birthPlace inRight">${birthPlace}</p>

        <p class="address presentAddr">${presentAddress}</p>
        <p class="address permanentAddr">${permanentAddress}</p>
    </div>

    <script>
        window.print();
        document.addEventListener('contextmenu', event => event.preventDefault());
        document.addEventListener('click', function() {
            window.print();
        });
    </script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, async () => {
  console.log(`NID QR Decoder running at https://sign.smart-seba.com`);
  console.log(`  Manual OTP claim only (auto Gmail OTP removed).`);
  const dbOk = await testConnection();
  if (!dbOk) {
    console.log('  WARNING: File-based storage failed. API key validation disabled.');
  }
});
