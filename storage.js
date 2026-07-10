// storage.js
// Generic JSON-file persistence for the PPC module. Follows the same pattern
// as your existing tokens.json approach: write to a Railway Volume at /data
// if mounted, fall back to local ./data for dev.
//
// IMPORTANT: If you haven't mounted a Railway Volume at /data, do that first
// (Settings > Volumes on the service). Without it, anything written here is
// wiped on every redeploy.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

export function readJSON(key, fallback) {
  const fp = filePath(key);
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (err) {
    console.error(`[ppc/storage] failed to parse ${key}.json, returning fallback`, err);
    return fallback;
  }
}

export function writeJSON(key, data) {
  const fp = filePath(key);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp); // atomic-ish swap, avoids partial writes on crash
}

export { DATA_DIR };
