const { fetchAddressData, loadCache, CACHE_FILE, solveCaptcha, fetchCaptcha } = require('./claim-account');
const fs = require('fs');
const path = require('path');

async function saveAllAddresses(nidOpts) {
  console.log('Fetching all address data from NID portal...');
  console.log('');

  const data = await fetchAddressData(nidOpts || null);
  const count = {
    divisions: (data.divisions || []).length,
    districts: Object.values(data.districts || {}).reduce((a, b) => a + b.length, 0),
    upozilas: Object.values(data.upozilas || {}).reduce((a, b) => a + b.length, 0),
  };

  console.log('');
  console.log('Saved:');
  console.log('  Divisions: ' + count.divisions);
  console.log('  Districts: ' + count.districts);
  console.log('  Upozilas:  ' + count.upozilas);
  console.log('  File:      ' + CACHE_FILE);
  return data;
}

function find(list, name) {
  const sv = String(name).trim();
  return list.find(item => item.id === sv || item.name === sv);
}

function listAll(list) {
  return list.map(item => item.id + ': ' + item.name);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  if (cmd === 'fetch' || cmd === 'save' || (cmd === 'help' && !args.length && process.argv[1])) {

    let nidOpts = null;
    const nid = args[1];
    const dob = args[2];

    if (nid && dob) {
      const [year, month, day] = dob.split('-');
      if (!day || !month || !year) {
        console.log('DOB must be YYYY-MM-DD format');
        process.exit(1);
      }
      nidOpts = { nid, day, month, year };
      console.log('Using NID ' + nid + ' for validation...');
    } else {
      console.log('No NID provided — trying without validation (may fail if session required)');
      console.log('Tip: pass NID and DOB as args: node resolve-address.js fetch <nid> <dob>');
      console.log('');
    }

    await saveAllAddresses(nidOpts);
    return;
  }

  const cache = loadCache() || { divisions: [], districts: {}, upozilas: {} };

  if (cmd === 'divisions') {
    console.log('Divisions:');
    console.log(listAll(cache.divisions).join('\n'));

  } else if (cmd === 'districts' || cmd === 'district') {
    const divName = args[1];
    if (!divName) {
      console.log('Usage: node resolve-address.js districts <division-name-or-id>');
      process.exit(1);
    }
    const div = find(cache.divisions, divName);
    if (!div) {
      console.log('Division not found: ' + divName);
      console.log('Available: ' + listAll(cache.divisions).join(', '));
      process.exit(1);
    }
    const dists = cache.districts[div.id] || [];
    console.log('Districts in ' + div.name + ' (' + div.id + '):');
    console.log(listAll(dists).join('\n'));

  } else if (cmd === 'upozilas' || cmd === 'upozila' || cmd === 'thana') {
    const distName = args[1];
    if (!distName) {
      console.log('Usage: node resolve-address.js upozilas <district-name-or-id>');
      process.exit(1);
    }
    let dist;
    for (const div of cache.divisions) {
      const dists = cache.districts[div.id] || [];
      dist = find(dists, distName);
      if (dist) break;
    }
    if (!dist) {
      console.log('District not found: ' + distName);
      process.exit(1);
    }
    const upos = cache.upozilas[dist.id] || [];
    console.log('Upozilas in ' + dist.name + ' (' + dist.id + '):');
    console.log(listAll(upos).join('\n'));

  } else if (cmd === 'resolve' || cmd === 'lookup') {
    const divName = args[1];
    const distName = args[2];
    const upoName = args[3];
    if (!divName) {
      console.log('Usage: node resolve-address.js resolve <division> [district] [upozila]');
      process.exit(1);
    }
    const div = find(cache.divisions, divName);
    if (!div) {
      console.log('Division not found: ' + divName);
      process.exit(1);
    }
    console.log('Division: ' + div.id + ' (' + div.name + ')');
    if (distName) {
      const dists = cache.districts[div.id] || [];
      const dist = find(dists, distName);
      if (!dist) {
        console.log('District not found in ' + div.name + ': ' + distName);
        process.exit(1);
      }
      console.log('District: ' + dist.id + ' (' + dist.name + ')');
      if (upoName) {
        const upos = cache.upozilas[dist.id] || [];
        const upo = find(upos, upoName);
        if (!upo) {
          console.log('Upozila not found in ' + dist.name + ': ' + upoName);
          process.exit(1);
        }
        console.log('Upozila: ' + upo.id + ' (' + upo.name + ')');
      }
    }

  } else {
    console.log('Address Lookup Tool');
    console.log('');
    console.log('Commands:');
    console.log('  node resolve-address.js fetch [nid] [dob]        Fetch & save all address data from portal');
    console.log('  node resolve-address.js divisions                List all divisions');
    console.log('  node resolve-address.js districts <div>          List districts in a division');
    console.log('  node resolve-address.js upozilas <dist>          List upozilas in a district');
    console.log('  node resolve-address.js resolve <div> [dist] [upo]   Resolve names to IDs');
    console.log('');
    console.log('Examples:');
    console.log('  node resolve-address.js fetch 3297004313 1985-10-06    Fetch all address data');
    console.log('  node resolve-address.js districts ঢাকা');
    console.log('  node resolve-address.js upozilas 26');
  }
}

main().catch(err => {
  console.error('Error: ' + err.message);
  process.exit(1);
});
