
// storage.js
// Generic JSON-file persistence for PPC module, following the same pattern
// already established for tokens.json: write to Railway Volume at /data if
// mounted, fall back to local ./data for dev.
//
// IMPORTANT: If you have not yet mounted a Railway Volume at /data, do that
// first (Settings > Volumes on the service). Without it, anything written
// here is wiped on every redeploy — same lesson learned from the tokens.json
// issue.

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

function readJSON(key, fallback) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (err) {
    console.error(`[ppc/storage] failed to parse ${key}.json, returning fallback`, err);
    return fallback;
  }
}

function writeJSON(key, data) {
  const fp = filePath(key);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp); // atomic-ish swap, avoids partial writes on crash
}

module.exports = { readJSON, writeJSON, DATA_DIR };
