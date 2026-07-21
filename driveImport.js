// driveImport.js
// Pulls the 4 MarginEdge CSV exports directly from a shared Google Drive
// folder, using a service account (no OAuth login flow, no user-in-the-loop
// re-auth to expire — service account credentials don't rotate the way
// QuickBooks/TripleSeat's do).
//
// SETUP (one-time, done in Google Cloud Console + Google Drive — not code):
//   1. Create/select a Google Cloud project. Enable the "Google Drive API".
//   2. Create a Service Account (IAM & Admin > Service Accounts > Create).
//   3. Create a JSON key for that service account, download it.
//   4. In Google Drive, share the target folder (the one you save the 4
//      MarginEdge CSVs to) with the service account's email address
//      (looks like xxxx@yyyy.iam.gserviceaccount.com, found in the JSON
//      key's "client_email" field) — Viewer access is enough, read-only.
//   5. Get the folder's ID from its URL:
//      https://drive.google.com/drive/folders/<THIS_PART_IS_THE_ID>
//   6. In Railway's Variables tab, add:
//        GOOGLE_SERVICE_ACCOUNT_KEY = <paste the full JSON key file content>
//        GOOGLE_DRIVE_FOLDER_ID     = <the folder ID from step 5>
//   7. Add "googleapis" to package.json dependencies (Railway's build step
//      runs npm install automatically, no manual install needed beyond
//      having it listed).
//
// This module reads those two env vars directly (same pattern as
// MARGINEDGE_API_KEY etc. in server.js) rather than needing app.locals
// wiring, since there's no existing server.js function to reuse here.

import { google } from 'googleapis';
import {
  importMenuItemCostsCSV,
  importMenuAnalysisCSV,
} from './menuEngineering.js';

function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!keyJson || !folderId) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY and/or GOOGLE_DRIVE_FOLDER_ID not set in Railway variables — see driveImport.js header for setup steps.');
  }
  let credentials;
  try {
    credentials = JSON.parse(keyJson);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON — paste the entire downloaded key file content, unmodified.');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return { drive: google.drive({ version: 'v3', auth }), folderId };
}

// Downloads a file's content as text, handling both a plain uploaded CSV
// and a Google Sheet (in case someone converts it) via export.
async function downloadFileText(drive, file) {
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({ fileId: file.id, mimeType: 'text/csv' }, { responseType: 'text' });
    return res.data;
  }
  const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
  return res.data;
}

// Matches a Drive filename to which importer it should go through. Checked
// in this order because "Menu Analysis" and "Menu Items" both contain
// "Menu" — the more specific match must be checked first.
function classifyFile(name) {
  const n = name.toLowerCase();
  if (n.includes('menu analysis')) return 'menu_analysis';
  if (n.includes('bar items')) return 'bar_items';
  if (n.includes('prepared items')) return 'prepared_items';
  if (n.includes('menu items')) return 'menu_items';
  return null;
}

// Lists the folder, matches each of the 4 expected files, downloads and
// imports each one. Returns a per-file result so partial failures (e.g.
// one file missing from the folder) are visible rather than silent.
export async function importAllFromDrive() {
  const { drive, folderId } = getDriveClient();

  const listRes = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
    orderBy: 'modifiedTime desc',
  });
  const files = listRes.data.files || [];

  const results = {};
  const matchedTypes = new Set();

  for (const file of files) {
    const type = classifyFile(file.name);
    if (!type || matchedTypes.has(type)) continue; // skip unrecognized files, and older duplicates (list is sorted newest-first)
    matchedTypes.add(type);

    try {
      const csvText = await downloadFileText(drive, file);
      let importResult;
      if (type === 'menu_analysis') importResult = importMenuAnalysisCSV(csvText);
      else importResult = importMenuItemCostsCSV(csvText, type);

      results[type] = { file_name: file.name, modified_time: file.modifiedTime, ...importResult };
    } catch (err) {
      results[type] = { file_name: file.name, error: err.message };
    }
  }

  const expectedTypes = ['menu_items', 'bar_items', 'prepared_items', 'menu_analysis'];
  const missing = expectedTypes.filter((t) => !matchedTypes.has(t));

  return {
    imported_at: new Date().toISOString(),
    results,
    missing_files: missing, // expected file types not found in the folder — worth checking naming/upload
    total_files_in_folder: files.length,
  };
}
