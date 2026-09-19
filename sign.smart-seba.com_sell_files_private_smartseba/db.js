const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');

function readJSON(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function writeJSON(file, data) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

let nextLogId = 309;
const LOG_FILE = 'request_logs.json';
const KEYS_FILE = 'api_keys.json';
const ADMINS_FILE = 'admins.json';
const SETTINGS_FILE = 'settings.json';

async function validateApiKey(key) {
  const keys = readJSON(KEYS_FILE);
  return keys.find(k => k.api_key === key) || null;
}

async function checkBalance(key) {
  const keys = readJSON(KEYS_FILE);
  const user = keys.find(k => k.api_key === key);
  if (!user) return { valid: false, error: 'Invalid API Key' };
  if (user.expire_date && new Date() > new Date(user.expire_date)) {
    return { valid: false, error: 'API Key মেয়াদ উত্তীর্ণ হয়ে গেছে। দয়া করে রিনিউ করুন।' };
  }
  if (user.balance <= 0) {
    return { valid: false, error: 'আপনার ব্যালেন্স শেষ! দয়া করে রিচার্জ করুন।', balance: 0 };
  }
  return { valid: true, balance: user.balance, expire_date: user.expire_date };
}

async function deductBalance(key) {
  const keys = readJSON(KEYS_FILE);
  const idx = keys.findIndex(k => k.api_key === key);
  if (idx === -1 || keys[idx].balance <= 0) return false;
  keys[idx].balance -= 1;
  keys[idx].total_request_used = (keys[idx].total_request_used || 0) + 1;
  writeJSON(KEYS_FILE, keys);
  return true;
}

async function refundBalance(key) {
  const keys = readJSON(KEYS_FILE);
  const idx = keys.findIndex(k => k.api_key === key);
  if (idx === -1) return false;
  keys[idx].balance += 1;
  keys[idx].total_request_used = Math.max(0, (keys[idx].total_request_used || 0) - 1);
  writeJSON(KEYS_FILE, keys);
  return true;
}

async function logRequest(data) {
  const logs = readJSON(LOG_FILE);
  const entry = {
    id: nextLogId++,
    api_key: data.apiKey || '',
    endpoint: data.endpoint || 'manual-claim',
    nid: data.nid || '',
    dob: data.dob || '',
    nid_photo: data.nidPhoto || '',
    full_response_json: data.fullResponse || '',
    status: data.status || 'success',
    error_message: data.errorMessage || '',
    response_time: data.responseTime || 0,
    user_ip: data.userIp || '',
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    pin_status: data.pinStatus || null,
    main_status: data.mainStatus || null,
    pin_response_time: data.pinResponseTime || null,
    main_response_time: data.mainResponseTime || null,
    data_source: data.dataSource || 'manual_claim',
  };
  logs.unshift(entry);
  writeJSON(LOG_FILE, logs);
  return entry.id;
}

async function getPensionApiStatus() {
  try {
    const settings = readJSON(SETTINGS_FILE);
    return settings.enable_pension_api === 'true';
  } catch { return false; }
}

async function setPensionApiStatus(status) {
  const settings = readJSON(SETTINGS_FILE);
  settings.enable_pension_api = status ? 'true' : 'false';
  writeJSON(SETTINGS_FILE, settings);
}

async function testConnection() {
  try {
    const keys = readJSON(KEYS_FILE);
    console.log('  -> File-based storage ready (' + keys.length + ' API keys loaded)');
    return true;
  } catch (err) {
    console.log('  -> File-based storage failed: ' + err.message);
    return false;
  }
}

module.exports = {
  readJSON,
  writeJSON,
  validateApiKey,
  checkBalance,
  deductBalance,
  refundBalance,
  logRequest,
  getPensionApiStatus,
  setPensionApiStatus,
  testConnection,
  DATA_DIR,
  KEYS_FILE,
  ADMINS_FILE,
  LOG_FILE,
  SETTINGS_FILE,
};
