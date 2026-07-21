// driveImport.js
// Pulls the 4 MarginEdge CSV exports directly from a shared Google Drive
// folder.
//
// Uses OAuth (same pattern as QuickBooks/TripleSeat in server.js) rather
// than a service account — this account's Google Cloud org policy blocks
// service account KEY CREATION (iam.disableServiceAccountKeyCreation),
// confirmed blocked. OAuth via a normal Client ID (Google Cloud Console >
// Credentials, a different mechanism, unaffected by that policy) sidesteps
// it entirely.
//
// Uses plain fetch() against Drive's REST API v3 directly — NO googleapis
// SDK dependency, so nothing needs adding to package.json for this file.
//
// deps required (wired via app.locals in server.js):
//   getGoogleDriveToken — returns a valid access token, refreshing if needed
//   GOOGLE_DRIVE_FOLDER_ID — the target Drive folder's ID

import {
  importMenuItemCostsCSV,
  importMenuAnalysisCSV,
} from './menuEngineering.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

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

async function downloadFileText(token, file) {
  const url = file.mimeType === 'application/vnd.google-apps.spreadsheet'
    ? `${DRIVE_API}/files/${file.id}/export?mimeType=text/csv`
    : `${DRIVE_API}/files/${file.id}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download failed for ${file.name}: ${res.status}`);
  return res.text();
}

// deps: { getGoogleDriveToken, GOOGLE_DRIVE_FOLDER_ID }
export async function importAllFromDrive(deps) {
  if (!deps.getGoogleDriveToken || !deps.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error('Google Drive deps not wired into app.locals yet (getGoogleDriveToken, GOOGLE_DRIVE_FOLDER_ID).');
  }
  const token = await deps.getGoogleDriveToken();

  const listUrl = `${DRIVE_API}/files?q=${encodeURIComponent(`'${deps.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`)}&fields=${encodeURIComponent('files(id,name,mimeType,modifiedTime)')}&orderBy=modifiedTime desc`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listRes.ok) throw new Error(`Drive folder listing failed: ${listRes.status} — confirm the folder is shared with the account you authorized at /auth/google-drive, and that GOOGLE_DRIVE_FOLDER_ID is correct.`);
  const listData = await listRes.json();
  const files = listData.files || [];

  const results = {};
  const matchedTypes = new Set();

  for (const file of files) {
    const type = classifyFile(file.name);
    if (!type || matchedTypes.has(type)) continue; // skip unrecognized files, and older duplicates (list is newest-first)
    matchedTypes.add(type);

    try {
      const csvText = await downloadFileText(token, file);
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
    missing_files: missing, // expected file types not found in the folder — check naming/upload if any show up here
    total_files_in_folder: files.length,
  };
}
