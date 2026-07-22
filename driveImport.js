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
    ? `${DRIVE_API}/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`
    : `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download failed for ${file.name}: ${res.status}`);
  return res.text();
}

// deps: { getGoogleDriveToken, GOOGLE_DRIVE_FOLDER_ID }
// Diagnostic: checks the folder ID DIRECTLY (files.get on the folder
// itself, not its children) — this distinguishes a wrong/inaccessible
// folder ID (this call fails) from a correct folder that simply doesn't
// contain the expected files yet (this call succeeds, listing still empty).
// Also lists everything the authorized account can see, unfiltered by
// folder, so you can spot where the files actually are if the folder
// check fails.
export async function debugDriveAccess(deps) {
  if (!deps.getGoogleDriveToken || !deps.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error('Google Drive deps not wired into app.locals yet (getGoogleDriveToken, GOOGLE_DRIVE_FOLDER_ID).');
  }
  const token = await deps.getGoogleDriveToken();
  const result = { folder_id_configured: deps.GOOGLE_DRIVE_FOLDER_ID };

  // Step 1: does this folder ID exist and is it accessible to this account?
  try {
    const folderRes = await fetch(
      `${DRIVE_API}/files/${deps.GOOGLE_DRIVE_FOLDER_ID}?fields=id,name,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (folderRes.ok) {
      const folderData = await folderRes.json();
      result.folder_accessible = true;
      result.folder_name = folderData.name;
      result.folder_mime_type = folderData.mimeType;
      if (folderData.mimeType !== 'application/vnd.google-apps.folder') {
        result.warning = 'This ID does not point to a folder — double check you copied the folder ID, not a file ID.';
      }
    } else {
      result.folder_accessible = false;
      result.folder_error_status = folderRes.status;
      result.folder_error_hint = folderRes.status === 404
        ? 'Folder ID not found, OR not shared with the account authorized at /auth/google-drive.'
        : folderRes.status === 403
        ? 'Folder exists but access is denied — confirm it is shared with the authorized account.'
        : `Unexpected status ${folderRes.status}.`;
    }
  } catch (err) {
    result.folder_accessible = false;
    result.folder_error_hint = err.message;
  }

  // Step 2: everything this account can see, unfiltered — helps locate the
  // files if the configured folder check above failed.
  try {
    const allRes = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent("trashed = false and (name contains 'Menu' or name contains 'Bar Items' or name contains 'Prepared Items')")}&fields=${encodeURIComponent('files(id,name,parents,mimeType)')}&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (allRes.ok) {
      const allData = await allRes.json();
      result.matching_files_visible_to_account = allData.files || [];
    }
  } catch (err) {
    result.search_error = err.message;
  }

  return result;
}

export async function importAllFromDrive(deps) {
  if (!deps.getGoogleDriveToken || !deps.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error('Google Drive deps not wired into app.locals yet (getGoogleDriveToken, GOOGLE_DRIVE_FOLDER_ID).');
  }
  const token = await deps.getGoogleDriveToken();

  // supportsAllDrives + includeItemsFromAllDrives: WITHOUT these, Drive's
  // API silently returns an empty file list (no error at all) if the
  // target folder is a Shared Drive rather than a personal "My Drive"
  // folder — safe to include unconditionally, works for both cases.
  // CONFIRMED via /drive-debug: the 4 CSVs genuinely have this folder ID as
  // their parent, but a plain 'X in parents' query alone was returning 0
  // results — supportsAllDrives/includeItemsFromAllDrives enable ACCESS to
  // Shared Drive items but do NOT guarantee they're included in a parents
  // search; Google's API requires corpora=drive&driveId=X explicitly for
  // reliably listing a Shared Drive's own top-level contents. Folder IDs
  // starting with "0A" are Google's Shared Drive root convention.
  const isSharedDrive = /^0A/.test(deps.GOOGLE_DRIVE_FOLDER_ID);
  const corporaParams = isSharedDrive
    ? `&corpora=drive&driveId=${encodeURIComponent(deps.GOOGLE_DRIVE_FOLDER_ID)}`
    : '';
  const listUrl = `${DRIVE_API}/files?q=${encodeURIComponent(`'${deps.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`)}&fields=${encodeURIComponent('files(id,name,mimeType,modifiedTime)')}&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true${corporaParams}`;
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
