const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { readJSON, writeJSON, DATA_DIR, KEYS_FILE, ADMINS_FILE, LOG_FILE, SETTINGS_FILE } = require('./db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminLoggedIn) return next();
  if (req.path === '/login' || req.path === '/login/submit') return next();
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  res.redirect('/admin/login');
}

router.use(requireAdmin);

router.get('/login', (req, res) => {
  if (req.session?.adminLoggedIn) return res.redirect('/admin');
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Login</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body{background:#000;color:#0f0;font-family:'Courier New',monospace}.login-container{max-width:400px;margin:100px auto;padding:20px;border:2px solid #0f0;border-radius:10px;background:#111;box-shadow:0 4px 10px rgba(0,255,0,0.2)}.btn-primary{background:#0f0;border:1px solid #0f0;color:#000}.btn-primary:hover{background:#00cc00}</style>
</head><body><div class="login-container">
<h3 class="text-center">Admin Login</h3>
<div id="error" class="alert alert-danger d-none"></div>
<form id="loginForm" method="POST" action="/admin/login/submit">
<div class="mb-3"><label class="form-label">Username</label><input type="text" class="form-control" name="username" required></div>
<div class="mb-3"><label class="form-label">Password</label><input type="password" class="form-control" name="password" required></div>
<button type="submit" class="btn btn-primary w-100">Login</button>
</form></div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/js/bootstrap.bundle.min.js"></script>
<script>document.getElementById('loginForm').addEventListener('submit',async function(e){e.preventDefault();const f=new FormData(this);const r=await fetch('/admin/login/submit',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f)});const d=await r.json();if(d.success){window.location.href='/admin'}else{document.getElementById('error').textContent=d.error;document.getElementById('error').classList.remove('d-none')}})</script>
</body></html>`);
});

router.post('/login/submit', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { username, password } = req.body;
    const md5pass = crypto.createHash('md5').update(password).digest('hex');
    const admins = readJSON(ADMINS_FILE);
    const admin = admins.find(a => a.username === username && a.password === md5pass);
    if (admin) {
      req.session.adminLoggedIn = true;
      req.session.adminUsername = admin.username;
      return res.json({ success: true });
    }
    res.json({ success: false, error: 'Invalid username or password' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

router.get(['/', '/dashboard'], async (req, res) => {
  try {
    const keys = readJSON(KEYS_FILE);

    let totalBalance = 0, totalRequests = 0, activeCount = 0;
    for (const k of keys) {
      totalBalance += Number(k.balance || 0);
      totalRequests += Number(k.total_request_used || 0);
      if (k.expire_date && new Date(k.expire_date) > new Date()) activeCount++;
    }

    const logs = readJSON(LOG_FILE);
    const pendingOrders = readJSON('pending_orders.json');
    const pendingCount = pendingOrders.filter(o => o.status === 'pending').length;

    res.send(renderAdminPage(keys, {
      totalKeys: keys.length,
      activeKeys: activeCount,
      totalRequests,
      totalBalance,
      totalLogs: logs.length,
      pendingOrders: pendingCount,
    }));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/add-key', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { api_key, username, balance, expire_days } = req.body;
    if (!api_key || !username || balance === undefined) {
      return res.json({ success: false, error: 'api_key, username, balance required' });
    }
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + (parseInt(expire_days) || 360));

    const keys = readJSON(KEYS_FILE);
    const maxId = keys.reduce((m, k) => Math.max(m, k.id || 0), 0);
    const newKey = {
      id: maxId + 1,
      api_key,
      username,
      email: null,
      balance: parseFloat(balance),
      total_request_used: 0,
      last_ip: null,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      expire_date: expireDate.toISOString().slice(0, 10),
      total_renew: 0,
    };
    keys.push(newKey);
    writeJSON(KEYS_FILE, keys);

    res.json({
      success: true, api_key, username, balance,
      expire_date: expireDate.toISOString().slice(0, 10),
      api_urls: {
        json_api: 'https://sign.smart-seba.com/manual-claim.html',
        balance_api: '01325998241',
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/update-balance', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { id, balance } = req.body;
    const keys = readJSON(KEYS_FILE);
    const idx = keys.findIndex(k => k.id === parseInt(id));
    if (idx !== -1) {
      keys[idx].balance = parseFloat(balance);
      writeJSON(KEYS_FILE, keys);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/renew-key', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { id, expire_days } = req.body;
    const days = parseInt(expire_days) || 360;
    const keys = readJSON(KEYS_FILE);
    const idx = keys.findIndex(k => k.id === parseInt(id));
    if (idx !== -1) {
      const current = keys[idx].expire_date ? new Date(keys[idx].expire_date) : new Date();
      current.setDate(current.getDate() + days);
      keys[idx].expire_date = current.toISOString().slice(0, 10);
      keys[idx].total_renew = (keys[idx].total_renew || 0) + 1;
      writeJSON(KEYS_FILE, keys);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/delete-key', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { id } = req.body;
    let keys = readJSON(KEYS_FILE);
    keys = keys.filter(k => k.id !== parseInt(id));
    writeJSON(KEYS_FILE, keys);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const keys = readJSON(KEYS_FILE);
    const filtered = keys.filter(k =>
      k.api_key.includes(q) || k.username.includes(q)
    );
    res.json({ success: true, keys: filtered });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const logs = readJSON(LOG_FILE);
    const keys = readJSON(KEYS_FILE);
    const enriched = logs.slice(0, 200).map(l => {
      const key = keys.find(k => k.api_key === l.api_key);
      return { ...l, username: key?.username || '', key_balance: key?.balance || 0 };
    });
    res.json({ success: true, logs: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const orders = readJSON('pending_orders.json');
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, orders: orders.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/toggle-pension', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const status = req.body.status === 'true' ? 'true' : 'false';
    const settings = readJSON(SETTINGS_FILE);
    settings.enable_pension_api = status;
    writeJSON(SETTINGS_FILE, settings);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/reset-logs', async (req, res) => {
  try {
    writeJSON(LOG_FILE, []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/clear-cache', async (req, res) => {
  try {
    writeJSON('nid_cache.json', []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function renderAdminPage(keys, stats) {
  const rows = keys.map(k => {
    const isExpired = k.expire_date && new Date(k.expire_date) < new Date();
    const expiresSoon = !isExpired && k.expire_date && (new Date(k.expire_date) - new Date()) < 7 * 86400000;
    const statusBadge = isExpired ? '<span class="badge bg-danger">Expired</span>'
      : expiresSoon ? '<span class="badge bg-warning text-dark">Soon</span>'
      : '<span class="badge bg-success">Active</span>';
    const balanceBadge = Number(k.balance) <= 0 ? 'bg-danger' : 'bg-info';
    return `<tr>
      <td>${k.id}</td>
      <td><code>${k.api_key}</code></td>
      <td><a href="https://wa.me/${k.username.replace(/[^0-9]/g, '')}" target="_blank" class="text-success text-decoration-none">${k.username || 'N/A'}</a></td>
      <td>${statusBadge}</td>
      <td>
        <form class="d-flex balance-form" data-id="${k.id}">
          <input type="number" class="form-control form-control-sm me-1" style="width:80px" value="${k.balance}" name="balance" min="0" step="1">
          <button type="submit" class="btn btn-sm btn-success"><i class="bi bi-check"></i></button>
        </form>
      </td>
      <td>${k.total_request_used || 0}</td>
      <td><small>${k.last_ip || '-'}</small></td>
      <td><small>${k.created_at ? new Date(k.created_at).toLocaleDateString() : '-'}</small></td>
      <td><small>${k.expire_date ? new Date(k.expire_date).toLocaleDateString() : '-'}</small></td>
      <td>
        <button class="btn btn-sm btn-info renew-btn" data-id="${k.id}" data-expires="${k.expire_date || ''}"><i class="bi bi-arrow-repeat"></i></button>
        <button class="btn btn-sm btn-danger delete-btn" data-id="${k.id}"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Panel - NID ServerCopy</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
<style>
body{background:#0f172a;color:#fff;font-family:'Segoe UI',sans-serif;padding:20px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;margin-bottom:16px}
.card-header{background:#0f172a;border-bottom:1px solid #334155;color:#fff}
.table{color:#fff;margin-bottom:0}
.table th{background:#0f172a;border-color:#334155;color:#94a3b8}
.table td{border-color:#334155;vertical-align:middle}
.form-control,.form-select{background:#0f172a;border:1px solid #334155;color:#fff}
.form-control:focus{background:#1e293b;border-color:#3b82f6;color:#fff;box-shadow:0 0 0 0.2rem rgba(59,130,246,0.25)}
.btn-primary{background:#3b82f6;border-color:#3b82f6}
.btn-success{background:#22c55e;border-color:#22c55e}
.btn-warning{background:#f59e0b;border-color:#f59e0b;color:#000}
.btn-danger{background:#ef4444;border-color:#ef4444}
.btn-info{background:#06b6d4;border-color:#06b6d4}
.stat-card{padding:20px;text-align:center;border-radius:12px}
.stat-card h2{margin:0;font-size:28px;font-weight:700}
.stat-card small{color:#94a3b8}
.modal-content{background:#1e293b;color:#fff;border:1px solid #334155}
.modal-header{border-bottom:1px solid #334155}
.modal-footer{border-top:1px solid #334155}
code{color:#fbbf24;font-size:12px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0f172a}
::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}
.toast-container{position:fixed;top:20px;right:20px;z-index:9999}
</style>
</head><body>
<div class="toast-container" id="toastContainer"></div>

<div class="d-flex justify-content-between align-items-center mb-3">
  <h3><i class="bi bi-server text-success"></i> NID ServerCopy Admin</h3>
  <div>
    <a href="/admin/logout" class="btn btn-outline-danger btn-sm"><i class="bi bi-box-arrow-right"></i> Logout</a>
  </div>
</div>

<div class="row g-2 mb-3">
  <div class="col-md-2"><div class="stat-card bg-primary"><h2>${stats.totalKeys}</h2><small>Total Keys</small></div></div>
  <div class="col-md-2"><div class="stat-card bg-success"><h2>${stats.activeKeys}</h2><small>Active</small></div></div>
  <div class="col-md-2"><div class="stat-card bg-info"><h2>${stats.totalRequests}</h2><small>Requests</small></div></div>
  <div class="col-md-2"><div class="stat-card bg-warning text-dark"><h2>${stats.totalBalance}</h2><small>Total Balance</small></div></div>
  <div class="col-md-2"><div class="stat-card bg-secondary"><h2>${stats.totalLogs}</h2><small>Logs</small></div></div>
  <div class="col-md-2"><div class="stat-card" style="background:#dc2626"><h2>${stats.pendingOrders}</h2><small>Pending Orders</small></div></div>
</div>

<div class="card">
  <div class="card-header d-flex justify-content-between align-items-center">
    <h5 class="mb-0"><i class="bi bi-key"></i> API Key Management</h5>
    <button class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#addKeyModal"><i class="bi bi-plus-lg"></i> Add Key</button>
  </div>
  <div class="card-body p-0">
    <div class="table-responsive">
      <table class="table table-hover mb-0">
        <thead><tr>
          <th>ID</th><th>API Key</th><th>WhatsApp</th><th>Status</th><th>Balance</th><th>Used</th><th>Last IP</th><th>Created</th><th>Expires</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="10" class="text-center text-muted py-4">No keys found</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>

<!-- Add Key Modal -->
<div class="modal fade" id="addKeyModal" tabindex="-1">
  <div class="modal-dialog modal-lg">
   <div class="modal-content">
  <div class="modal-header">
    <h5 class="modal-title">Add New API Key</h5>
    <button class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
  </div>

  <div class="modal-body">
    <form id="addKeyForm">
      <div class="row g-2">

        <div class="col-md-6">
          <label class="form-label">API Key</label>
          <input type="text" class="form-control" id="newApiKeyInput" name="api_key" required>
        </div>

        <div class="col-md-6">
          <label class="form-label">WhatsApp Number</label>
          <input type="text" class="form-control" id="whatsappInput" name="username" required>
        </div>
        
            <div class="col-md-4">
              <label class="form-label">Balance (Tokens)</label>
              <input type="number" class="form-control" name="balance" min="0" value="10" required>
            </div>
            <div class="col-md-4">
              <label class="form-label">Expire Days</label>
              <input type="number" class="form-control" name="expire_days" min="1" value="360" required>
            </div>
            <div class="col-md-4 d-flex align-items-end">
              <button type="submit" class="btn btn-primary w-100"><i class="bi bi-plus-circle"></i> Generate Key</button>
            </div>
          </div>
        </form>
        <div id="keyResult" class="mt-3 d-none">
          <hr>
          <div class="alert alert-success" id="keyResultMsg"></div>
          <div id="keyUrls" class="small"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Renew Modal -->
<div class="modal fade" id="renewModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Renew API Key</h5><button class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <form id="renewForm">
          <input type="hidden" name="id" id="renewId">
          <div class="mb-3"><label class="form-label">Current Expires</label><input type="text" class="form-control" id="renewCurrentExpire" readonly></div>
          <div class="mb-3"><label class="form-label">Extend by (days)</label><input type="number" class="form-control" name="expire_days" min="1" value="360"></div>
          <button type="submit" class="btn btn-success w-100"><i class="bi bi-arrow-repeat"></i> Renew</button>
        </form>
      </div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/js/bootstrap.bundle.min.js"></script>
<script>
document.getElementById('newApiKeyInput')?.addEventListener('focus', function() {
  if (!this.value) {
    this.value = 'SBR_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
});

document.getElementById('addKeyForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const fd = new FormData(this);
  const r = await fetch('/admin/add-key', { method:'POST', body: new URLSearchParams(fd) });
  const d = await r.json();
  if (d.success) {
    document.getElementById('keyResult').classList.remove('d-none');
    document.getElementById('keyResultMsg').innerHTML = '<strong>✅ Key Created!</strong>';
    const urls = document.getElementById('keyUrls');
    urls.innerHTML = '<pre class="mt-2">🔑 Key: ' + d.api_key + '\\n📊 Balance: ' + d.balance + '\\n📅 Expires: ' + d.expire_date + '\\n\\n🔗 JSON API:\\n' + d.api_urls.json_api + '\\n\\n🔗 WhatsApp Number:\\n' + d.api_urls.balance_api + '</pre>';
    setTimeout(() => location.reload(), 20000);
  } else {
    alert('Error: ' + d.error);
  }
});

document.querySelectorAll('.balance-form').forEach(f => {
  f.addEventListener('submit', async function(e) {
    e.preventDefault();
    const fd = new FormData(this);
    fd.set('id', this.dataset.id);
    await fetch('/admin/update-balance', { method:'POST', body: new URLSearchParams(fd) });
    showToast('Balance updated!', 'success');
  });
});

document.querySelectorAll('.delete-btn').forEach(b => {
  b.addEventListener('click', async function() {
    if (!confirm('Delete this key?')) return;
    await fetch('/admin/delete-key', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: 'id=' + this.dataset.id });
    this.closest('tr').remove();
    showToast('Key deleted!', 'danger');
  });
});

document.querySelectorAll('.renew-btn').forEach(b => {
  b.addEventListener('click', function() {
    document.getElementById('renewId').value = this.dataset.id;
    document.getElementById('renewCurrentExpire').value = this.dataset.expires || 'N/A';
    new bootstrap.Modal(document.getElementById('renewModal')).show();
  });
});
document.getElementById('renewForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const fd = new FormData(this);
  const r = await fetch('/admin/renew-key', { method:'POST', body: new URLSearchParams(fd) });
  const d = await r.json();
  if (d.success) {
    bootstrap.Modal.getInstance(document.getElementById('renewModal')).hide();
    showToast('Key renewed!', 'success');
    setTimeout(() => location.reload(), 1000);
  }
});

function showToast(msg, type) {
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'alert alert-' + type + ' alert-dismissible fade show py-2 px-3 mb-1';
  t.innerHTML = msg + '<button class="btn-close btn-close-white" data-bs-dismiss="alert"></button>';
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
</script>
</body></html>`;
}

module.exports = router;
