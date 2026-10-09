const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

let mainWindow;
let db = null;

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_DIR = path.join(app.getPath('appData'), 'reading-tracker');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function ensureSettingsDir() {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

function loadSettings() {
  ensureSettingsDir();
  if (fs.existsSync(SETTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
  return {
    kindle: {
      host: '192.168.15.244',
      user: 'root',
      password: '',
      sshKey: '',
      sessionDayEnd: '04:00',
    },
    theme: 'theme-wave',
    timezone: '-3',
    goal: { unit: 'minutes', value: 60 },
  };
}

function saveSettings(settings) {
  ensureSettingsDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ─── Settings IPC Handlers ───────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  const settings = loadSettings();
  return {
    host: settings.kindle?.host || '192.168.15.244',
    user: settings.kindle?.user || 'root',
    password: settings.kindle?.password || '',
    sshKey: settings.kindle?.sshKey || '',
    theme: settings.theme || 'theme-wave',
    timezone: settings.timezone || '-3',
    goalUnit: settings.goal?.unit || 'minutes',
    goalValue: settings.goal?.value || 60,
    sessionDayEnd: settings.kindle?.sessionDayEnd || '04:00',
  };
});

ipcMain.handle('save-settings', async (event, data) => {
  try {
    const settings = loadSettings();
    settings.kindle = {
      host: data.host,
      user: data.user,
      password: data.password || '',
      sshKey: '',
      sessionDayEnd: data.sessionDayEnd || '04:00',
    };
    settings.theme = data.theme || 'theme-wave';
    settings.timezone = data.timezone || '-3';
    if (data.goalUnit || data.goalValue !== undefined) {
      settings.goal = {
        unit: data.goalUnit || 'minutes',
        value:
          data.goalValue !== undefined &&
          data.goalValue !== '' &&
          Number(data.goalValue) > 0
            ? Number(data.goalValue)
            : 60,
      };
    }
    saveSettings(settings);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-settings', async (event, key, value) => {
  try {
    const settings = loadSettings();
    // `theme` and `timezone` are top-level settings; anything else belongs to
    // the kindle block.
    if (key === 'theme' || key === 'timezone') {
      settings[key] = value;
    } else {
      if (!settings.kindle) settings.kindle = {};
      settings.kindle[key] = value;
    }
    saveSettings(settings);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Book Covers ─────────────────────────────────────────────────────────────
// Covers are resolved once per title through the OpenLibrary search API and
// stored on disk, so the recently-read card never re-downloads them and the
// app never piles up requests against the API's rate limit.
const COVERS_DIR = path.join(SETTINGS_DIR, 'covers');
const COVERS_INDEX_FILE = path.join(COVERS_DIR, 'covers.json');

// Session language names -> OpenLibrary's 3-letter ISO 639-3 codes.
const LANG_3 = {
  Japanese: 'jpn',
  English: 'eng',
  Portuguese: 'por',
  Spanish: 'spa',
  Korean: 'kor',
  Chinese: 'chi',
  German: 'ger',
  French: 'fre',
  Italian: 'ita',
  Russian: 'rus',
};

// Requests are spaced out so a bulk sync of new titles cannot burst the limit.
const REQUEST_GAP_MS = 500;
let lastRequestAt = 0;

let coverIndex = null;

function ensureCoversDir() {
  if (!fs.existsSync(COVERS_DIR)) {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  }
}

function loadCoverIndex() {
  if (coverIndex) return coverIndex;
  try {
    if (fs.existsSync(COVERS_INDEX_FILE)) {
      coverIndex = JSON.parse(fs.readFileSync(COVERS_INDEX_FILE, 'utf8'));
    }
  } catch (err) {
    console.error(
      '[covers] Could not read cover index, starting fresh:',
      err.message,
    );
  }
  if (!coverIndex || typeof coverIndex !== 'object') coverIndex = {};
  return coverIndex;
}

function saveCoverIndex() {
  ensureCoversDir();
  fs.writeFileSync(
    COVERS_INDEX_FILE,
    JSON.stringify(coverIndex, null, 2),
    'utf8',
  );
}

// OpenLibrary matches on the bare title, so the trailing publisher/imprint in
// parentheses (" (MFブックス)") is dropped. Parentheses elsewhere are kept.
function normalizeTitle(title) {
  let t = String(title || '').trim();
  t = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  t = t.replace(/\s+/g, ' ');
  return t;
}

function coverKey(title) {
  return normalizeTitle(title).toLowerCase();
}

function coverPathFor(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(COVERS_DIR, `${hash}.jpg`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spacedFetch(url) {
  const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Reading-Tracker/1.0 (personal reading log)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// Returns the first search hit that actually has a cover id.
async function searchOpenLibrary(query, language) {
  const params = new URLSearchParams({ q: query });
  if (language) params.set('language', language);
  const res = await spacedFetch(
    `https://openlibrary.org/search.json?${params.toString()}`,
  );
  const data = await res.json();
  const docs = Array.isArray(data.docs) ? data.docs : [];
  return docs.find((doc) => doc.cover_i) || null;
}

async function downloadCover(coverId, outPath) {
  const res = await spacedFetch(
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`,
  );
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('cover image is empty');
  // The covers directory may not exist yet on the very first fetch, so create
  // it immediately before writing.
  ensureCoversDir();
  fs.writeFileSync(outPath, buf);
}

// Resolve one title: cached hit -> OpenLibrary with language -> OpenLibrary
// without language -> recorded as missing.
async function resolveCover(title, language) {
  const key = coverKey(title);
  const index = loadCoverIndex();
  const entry = index[key];
  const file = coverPathFor(key);

  if (entry && entry.file && fs.existsSync(file)) {
    return { key, status: entry.status, url: pathToFileURL(file).href };
  }

  const normalized = normalizeTitle(title);
  if (!normalized) {
    return { key, status: 'missing', url: null };
  }

  let doc = null;
  try {
    doc = await searchOpenLibrary(normalized, LANG_3[language] || null);
    if (!doc) {
      // Retry without the language filter before giving up.
      doc = await searchOpenLibrary(normalized, null);
    }
  } catch (err) {
    console.error(`[covers] Search failed for "${normalized}":`, err.message);
    return { key, status: 'error', url: null };
  }

  if (doc && doc.cover_i) {
    try {
      await downloadCover(doc.cover_i, file);
      index[key] = {
        status: 'found',
        file: path.basename(file),
        coverId: doc.cover_i,
        title: doc.title || normalized,
        fetchedAt: new Date().toISOString(),
      };
      saveCoverIndex();
      return { key, status: 'found', url: pathToFileURL(file).href };
    } catch (err) {
      console.error(
        `[covers] Download failed for cover ${doc.cover_i}:`,
        err.message,
      );
    }
  }

  index[key] = {
    status: 'missing',
    file: null,
    fetchedAt: new Date().toISOString(),
  };
  saveCoverIndex();
  return { key, status: 'missing', url: null };
}

function getCoverUrl(title) {
  const key = coverKey(title);
  const entry = loadCoverIndex()[key];
  if (!entry || !entry.file) return null;
  const file = path.join(COVERS_DIR, entry.file);
  return fs.existsSync(file) ? pathToFileURL(file).href : null;
}

function getDbPath() {
  const dataPath = path.join(
    app.getPath('appData'),
    'reading-tracker',
    'data.db',
  );
  return dataPath;
}

function openDatabase() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      language TEXT NOT NULL,
      characters INTEGER NOT NULL DEFAULT 0,
      duration REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'minutes'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
  `);
  // migration_flag guarded a one-shot data migration that no longer exists in
  // the app, so the table is dead weight that also trips off every backup: drop
  // it on sight, which scrubs it out of older backups when they get restored.
  db.exec('DROP TABLE IF EXISTS migration_flag;');

  return db;
}

// ─── Automatic database backups ──────────────────────────────────────────────
//
// Snapshots live beside the live database, under the app-data folder, and their
// names carry date, hour, minute, and seconds so the folder lists as a timeline.
// Only files this code names are ever rotated; a manual export keeps whatever
// name and place the user chose.
const BACKUPS_DIR = path.join(path.dirname(getDbPath()), 'backups');
const AUTO_BACKUP_KEEP = 10;
const AUTO_BACKUP_NAME = /^data-\d{4}-\d{2}-\d{2}-\d{2}(?:-\d{2}){0,2}\.db$/;

// Two digits, zero padded: names sort the same way they read.
const pad2 = (n) => String(n).padStart(2, '0');

function backupStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}`;
}

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  return BACKUPS_DIR;
}

// Newest first. The names are chronological, so sorting names is sorting time,
// and the pattern test keeps a user-placed file out of the pruning list.
function listAutoBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => AUTO_BACKUP_NAME.test(name))
    .sort((a, b) => (a < b ? 1 : -1))
    .map((name) => path.join(BACKUPS_DIR, name));
}

// Opening a WAL-mode database leaves a -wal plus a fixed-size -shm beside the
// file. When that -wal holds no records the pair is bookkeeping only, so a file
// this code merely read is left without one; a -wal with records stays, because
// those records belong to that file.
function removeEmptyWalPair(file) {
  const wal = `${file}-wal`;
  if (!fs.existsSync(wal) || fs.statSync(wal).size !== 0) return;
  for (const sidecar of [wal, `${file}-shm`])
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}

// data-2026-10-09-19-38-05.db: day and hour first for reading the folder as a
// timeline, minutes and seconds after so a snapshot never reuses a name.
function autoBackupFile(date) {
  return path.join(
    ensureBackupsDir(),
    `data-${backupStamp(date)}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}.db`,
  );
}

// Content fingerprint: declared schema plus every row in a fixed order. Raw file
// bytes churn for reasons unrelated to the data (page counts, free-list
// pointers), so the rows are what gets compared. Hex digest because two Buffers
// compare by identity.
function fingerprint(database) {
  const hash = crypto.createHash('sha256');
  const shapes = database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence'")
    .all();
  for (const shape of shapes) hash.update(`${shape.type} ${shape.name} ${shape.sql ?? ''}`);
  for (const shape of shapes) {
    if (shape.type !== 'table') continue;
    const rows = database.prepare(`SELECT * FROM "${shape.name}"`).all();
    rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    for (const row of rows) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

// Called once per app start: write a snapshot only when the live database differs
// from the newest one on disk. Returns the written file, or null when nothing
// changed.
async function snapshotIfNeeded() {
  const previous = listAutoBackups()[0];
  if (previous) {
    const last = new Database(previous, { readonly: true, fileMustExist: true });
    const unchanged = fingerprint(last) === fingerprint(db);
    last.close();
    removeEmptyWalPair(previous);
    if (unchanged) return null;
  }

  // The export is written in pages asynchronously, so awaiting is what leaves a
  // complete file before anything reads it back.
  const target = autoBackupFile(new Date());
  await db.backup(target);

  for (const stale of listAutoBackups().slice(AUTO_BACKUP_KEEP)) fs.unlinkSync(stale);
  return target;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1300,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadFile('index.html');

  // Open DevTools in development for debugging
  // Triggered by: npm run dev (passes --dev flag)
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  db = openDatabase();

  // Snapshot on open: a session that changed nothing writes no file, so the
  // rotating set only ever holds distinct states of the database. The export
  // runs beside startup: a failed snapshot only logs.
  snapshotIfNeeded()
    .then((snapshot) => {
      if (snapshot) console.info('[reading-tracker] wrote auto-backup ' + snapshot);
    })
    .catch((err) => console.error('[reading-tracker] auto-backup skipped: ' + err.message));

  createWindow();

  // ===== IPC Handlers =====

  // Session CRUD
  ipcMain.handle('insert-session', async (_, session) => {
    try {
      // Deduplication check
      const existing = db
        .prepare(
          'SELECT id FROM sessions WHERE title = ? AND characters = ? AND date = ? AND duration = ? AND language = ?',
        )
        .get(
          session.title,
          session.characters,
          session.date,
          session.duration,
          session.language,
        );

      if (existing) {
        return { success: true, duplicated: true };
      }

      const stmt = db.prepare(
        'INSERT INTO sessions (id, date, title, language, characters, duration, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      stmt.run(
        session.id,
        session.date,
        session.title,
        session.language,
        session.characters,
        session.duration,
        session.unit,
      );
      return { success: true, duplicated: false };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Bulk insert sessions from CSV data
  ipcMain.handle('bulk-insert-sessions', (_, sessions) => {
    const stmt = db.prepare(
      'INSERT INTO sessions (id, date, title, language, characters, duration, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMany = db.transaction((rows) => {
      let successCount = 0;
      const errors = [];
      for (const session of rows) {
        try {
          const result = stmt.run(
            session.id,
            session.date,
            session.title,
            session.language,
            session.characters,
            session.duration,
            session.unit,
          );
          successCount++;
        } catch (err) {
          errors.push({ row: session, error: err.message });
        }
      }
      return { successCount, errors };
    });
    return insertMany(sessions);
  });

  ipcMain.handle('delete-session', (_, dateKey, sessionId) => {
    return db
      .prepare('DELETE FROM sessions WHERE date = ? AND id = ?')
      .run(dateKey, sessionId);
  });

  // Get sessions for a specific date
  ipcMain.handle('get-sessions-by-date', (_, dateKey) => {
    return db
      .prepare('SELECT * FROM sessions WHERE date = ? ORDER BY id')
      .all(dateKey);
  });

  // Get all sessions
  ipcMain.handle('get-all-sessions', () => {
    return db
      .prepare('SELECT * FROM sessions ORDER BY date DESC, id DESC')
      .all();
  });

  // Get distinct dates with sessions
  ipcMain.handle('get-dates', () => {
    return db
      .prepare('SELECT DISTINCT date FROM sessions ORDER BY date DESC')
      .all();
  });

  // Get total minutes for a date
  ipcMain.handle('get-day-total', (_, dateKey) => {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN unit = 'minutes' THEN duration ELSE duration * 60 END), 0) as total FROM sessions WHERE date = ?",
      )
      .get(dateKey);
    return row ? row.total : 0;
  });

  // Get all dates for streak calculation
  ipcMain.handle('get-active-dates', () => {
    return db
      .prepare(
        'SELECT DISTINCT date FROM sessions WHERE (SELECT COUNT(*) FROM sessions s2 WHERE s2.date = sessions.date) > 0 ORDER BY date',
      )
      .all();
  });

  // Get session count by date
  ipcMain.handle('get-session-counts', () => {
    return db
      .prepare('SELECT date, COUNT(*) as count FROM sessions GROUP BY date')
      .all();
  });

  // Covers: resolve missing covers for a list of titles, read a cached one, or
  // attach a user-provided image.
  ipcMain.handle('ensure-covers', async (_, requests) => {
    const results = {};
    if (!Array.isArray(requests)) return results;
    for (const req of requests) {
      if (!req || !req.title) continue;
      results[req.title] = await resolveCover(req.title, req.language);
    }
    return results;
  });

  ipcMain.handle('get-cover-url', (_, title) => {
    return getCoverUrl(title);
  });

  ipcMain.handle('upload-cover', async (_, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a cover image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const source = result.filePaths[0];
    const key = coverKey(title);
    const ext = path.extname(source).toLowerCase() || '.jpg';
    const target = path.join(
      COVERS_DIR,
      `${crypto.createHash('sha1').update(key).digest('hex')}${ext}`,
    );

    try {
      ensureCoversDir();
      // Remove a previously stored cover if it used a different extension.
      const previous = loadCoverIndex()[key]?.file;
      if (previous) {
        const oldPath = path.join(COVERS_DIR, previous);
        if (oldPath !== target && fs.existsSync(oldPath))
          fs.unlinkSync(oldPath);
      }
      fs.copyFileSync(source, target);
      loadCoverIndex()[key] = {
        status: 'manual',
        file: path.basename(target),
        title: normalizeTitle(title),
        fetchedAt: new Date().toISOString(),
      };
      saveCoverIndex();
      return { success: true, url: pathToFileURL(target).href };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Backup: write the entire live database (every table, index, and row) into a
  // single self-contained file — the same layout restore-database reads back.
  ipcMain.handle('backup-database', async (_, targetPath) => {
    if (!db) throw new Error('No database connected');
    // better-sqlite3 exports asynchronously: awaiting is what guarantees the
    // whole database is on disk before the UI reports success.
    await db.backup(targetPath);
    return targetPath;
  });

  // Restore: swap the live database file for a backup .sqlite file
  ipcMain.handle('restore-database', async (_, sourcePath) => {
    const dbPath = getDbPath();

    // Validate the backup before clobbering anything: readonly + fileMustExist
    // means a bad path or a non-SQLite file fails without creating a db, and
    // requiring a sessions table rejects databases from other apps (the file
    // picker accepts any .db).
    const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const hasSessions = sourceDb
      .prepare("SELECT 'sessions' FROM sqlite_master WHERE name = 'sessions'")
      .get();
    sourceDb.close();

    if (!hasSessions)
      throw new Error('Not a reading-tracker backup: no sessions table in that file.');

    // That validation open left a WAL pair beside the picked file; drop it when it
    // is only bookkeeping.
    removeEmptyWalPair(sourcePath);

    if (db) db.close();
    db = null;

    // copyFileSync truncates the destination first, so a self-restore must no-op.
    if (path.resolve(sourcePath) !== path.resolve(dbPath)) fs.copyFileSync(sourcePath, dbPath);

    // WAL sidecars describe the database we just replaced; left in place, SQLite
    // replays their records onto the freshly copied file.
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`])
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);

    db = openDatabase();
    return true;
  });

  // Get database path for info
  ipcMain.handle('get-db-path', () => {
    return getDbPath();
  });

  // Folder holding the automatic snapshots, so the Restore dialog can open it
  ipcMain.handle('get-backups-path', () => {
    return ensureBackupsDir();
  });

  // Dialogs
  ipcMain.handle('show-save-dialog', (_, options) => {
    return dialog.showSaveDialog(mainWindow, options);
  });

  ipcMain.handle('show-open-dialog', (_, options) => {
    return dialog.showOpenDialog(mainWindow, options);
  });

  ipcMain.handle('get-docs-path', () => {
    return app.getPath('documents');
  });

  ipcMain.handle('quit-app', () => {
    app.quit();
  });

  // ─── Kindle Sync ───────────────────────────────────────────────────────────

  const DEFAULT_HOST = '192.168.15.244';
  const DEFAULT_USER = 'root';
  const DEFAULT_PASSWORD = 'kindle';

  function getPythonResourcesDir() {
    // Production: extraFiles extracts to resources/python/ relative to the executable
    // Check this FIRST — it's the canonical location in built apps
    const extraResourcesPath = path.join(
      path.dirname(process.execPath),
      'resources',
      'python',
    );
    if (fs.existsSync(path.join(extraResourcesPath, 'Lib', 'site-packages'))) {
      return extraResourcesPath;
    }
    // Development: python-bundle/python/
    const devPath = path.join(__dirname, 'python-bundle', 'python');
    if (fs.existsSync(path.join(devPath, 'Lib', 'site-packages'))) {
      return devPath;
    }
    // Fallback: resources/ relative to asar
    return path.join(__dirname, 'resources', 'python');
  }

  function buildPythonEnv(pythonCmd, resourcesDir) {
    const env = { ...process.env };
    // Always use Lib/site-packages/ since extraFiles copies python-bundle/python/Lib
    const sitePackages = path.join(resourcesDir, 'Lib', 'site-packages');
    if (fs.existsSync(sitePackages)) {
      env.PYTHONPATH = sitePackages;
    }
    return env;
  }

  function getCacheDir() {
    return path.join(app.getPath('appData'), 'reading-tracker', 'kindle-cache');
  }

  ipcMain.handle('sync-kindle', async () => {
    return new Promise((resolve) => {
      const resourcesDir = getPythonResourcesDir();
      const syncScript = path.join(resourcesDir, 'sync_kindle.py');
      const sitePackages = path.join(resourcesDir, 'Lib', 'site-packages');

      // Verify site-packages exists
      if (!fs.existsSync(sitePackages)) {
        mainWindow?.webContents.send('sync-complete', {
          success: false,
          error:
            'Python site-packages not found — reinstall app or run: pip install -r python-bundle/requirements.txt --target <site-packages-dir>',
          sessions: [],
          stats: {},
        });
        return resolve({ success: false });
      }

      // Load settings
      const settings = loadSettings();

      // Build environment — use system Python with PYTHONPATH
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const env = buildPythonEnv(pythonCmd, resourcesDir);
      env.KINDLE_HOST = settings.kindle?.host || DEFAULT_HOST;
      env.KINDLE_USER = settings.kindle?.user || DEFAULT_USER;
      env.KINDLE_PW = settings.kindle?.password || DEFAULT_PASSWORD;
      env.KINDLE_SSH_KEY = settings.kindle?.sshKey || '';
      env.CACHE_DIR = getCacheDir();
      env.KINDLE_TIMEZONE = settings.timezone || '-3';
      env.KINDLE_SESSION_DAY_END = settings.kindle?.sessionDayEnd || '04:00';

      const child = spawn(pythonCmd, [syncScript], { env });
      let resultJson = '';
      let resultParsed = false;
      let statusLines = [];
      let pastResultMarker = false;

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('__RESULT__')) {
            pastResultMarker = true;
            continue;
          }

          // Only accumulate JSON that appears AFTER the __RESULT__ marker
          if (
            pastResultMarker &&
            (trimmed.startsWith('{') || trimmed.startsWith('['))
          ) {
            resultJson += trimmed;
            if (!resultParsed) {
              try {
                const result = JSON.parse(resultJson);
                resultParsed = true;
                console.log(
                  '[sync] Parsed JSON:',
                  JSON.stringify(result).substring(0, 200),
                );
                handleSyncResult(result);
              } catch (e) {
                console.log(
                  '[sync] JSON parse pending, accumulated so far:',
                  resultJson.substring(0, 200),
                );
              }
            }
          } else if (!pastResultMarker) {
            // Lines before __RESULT__ are status/debug output
            statusLines.push(trimmed);
            mainWindow?.webContents.send('sync-status', { message: trimmed });
          }
        }
      });

      // ISO 639 language code -> full name mapping
      const LANG_MAP = {
        ja: 'Japanese',
        en: 'English',
        pt: 'Portuguese',
        es: 'Spanish',
        ko: 'Korean',
        zh: 'Chinese',
        de: 'German',
        fr: 'French',
        it: 'Italian',
        ru: 'Russian',
        nl: 'Dutch',
        sv: 'Swedish',
        da: 'Danish',
        no: 'Norwegian',
        fi: 'Finnish',
        pl: 'Polish',
        cs: 'Czech',
        hu: 'Hungarian',
        ro: 'Romanian',
        hr: 'Croatian',
        sk: 'Slovak',
        bg: 'Bulgarian',
        el: 'Greek',
        tr: 'Turkish',
        he: 'Hebrew',
        ar: 'Arabic',
        hi: 'Hindi',
        th: 'Thai',
        vi: 'Vietnamese',
        id: 'Indonesian',
        ms: 'Malay',
        tl: 'Filipino',
        uk: 'Ukrainian',
      };

      function resolveLanguage(code) {
        if (!code) return null;
        const key = String(code).trim().toLowerCase();
        if (LANG_MAP[key]) return LANG_MAP[key];
        // If already a full name, return as-is
        if (/^[A-Z][a-z]/.test(key)) return key;
        return key; // Fallback: return raw code
      }

      function handleSyncResult(result) {
        // Normalize field names from Python script to DB schema
        // Python columns: session_date, book_title, language, char_count, session_duration
        // DB columns:     date,        title,      language, characters, duration, unit
        const normalizedSessions = (result.sessions || []).map((s) => ({
          date: s.session_date || s.date || null,
          title: s.book_title || s.title || 'Untitled',
          language: resolveLanguage(s.language),
          characters: s.char_count != null ? parseInt(s.char_count, 10) : 0,
          duration:
            s.session_duration != null ? parseFloat(s.session_duration) : 0,
          unit: s.unit || 'minutes',
        }));

        // Insert sessions into SQLite with proper deduplication FIRST
        let syncStats = {
          sessionsExtracted: 0,
          sessionsInserted: 0,
          sessionsSkipped: 0,
        };
        if (normalizedSessions.length > 0) {
          const result = insertSessionsWithDedup(normalizedSessions);
          syncStats.sessionsInserted = result.inserted;
          syncStats.sessionsSkipped = result.skipped;
          syncStats.sessionsExtracted = result.total;
          console.log(
            '[sync] Inserted %d new, skipped %d duplicates',
            result.inserted,
            result.skipped,
          );
        } else {
          console.log('[sync] No sessions to insert');
        }

        // Send ONLY ONE completion event with the correct (post-dedup) stats
        mainWindow?.webContents.send('sync-complete', {
          success: true,
          sessions: normalizedSessions,
          stats: syncStats,
          statusHistory: [...statusLines],
        });

        resolve({ success: true });
      }

      child.stderr.on('data', (data) => {
        mainWindow?.webContents.send('sync-status', {
          message: `stderr: ${data.toString().trim()}`,
        });
      });

      child.on('close', (code) => {
        if (code !== 0 && !resultParsed) {
          mainWindow?.webContents.send('sync-complete', {
            success: false,
            error: `Python process exited with code ${code}`,
            sessions: [],
            stats: {},
          });
          resolve({ success: false, error: `Exit code ${code}` });
        }
      });
    });
  });

  // ─── SSH Connection Test ───────────────────────────────────────────────────

  ipcMain.handle('test-ssh-connection', async () => {
    return new Promise((resolve) => {
      const resourcesDir = getPythonResourcesDir();
      const syncScript = path.join(resourcesDir, 'sync_kindle.py');
      const sitePackages = path.join(resourcesDir, 'Lib', 'site-packages');

      if (!fs.existsSync(sitePackages)) {
        return resolve({
          success: false,
          message: 'Python site-packages not found',
        });
      }

      const settings = loadSettings();
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const env = buildPythonEnv(pythonCmd, resourcesDir);
      env.KINDLE_HOST = settings.kindle?.host || DEFAULT_HOST;
      env.KINDLE_USER = settings.kindle?.user || DEFAULT_USER;
      env.KINDLE_PW = settings.kindle?.password || DEFAULT_PASSWORD;
      env.KINDLE_SSH_KEY = settings.kindle?.sshKey || '';
      env.CACHE_DIR = getCacheDir();
      env.KINDLE_TIMEZONE = settings.timezone || '-3';

      const child = spawn(pythonCmd, [syncScript, '--test-ssh'], { env });
      let stdoutBuf = '';
      let testResult = null;

      child.stdout.on('data', (data) => {
        stdoutBuf += data.toString();
      });

      child.stderr.on('data', (data) => {
        const stderrMsg = data.toString().trim();
        if (stderrMsg) {
          stdoutBuf += stderrMsg;
        }
      });

      child.on('close', (code) => {
        const combined = stdoutBuf;
        // Parse __SSH_TEST_RESULT__: true/false
        const match = combined.match(/__SSH_TEST_RESULT__:\s*(true|false)/);
        if (match) {
          const success = match[1] === 'true';
          // Collect any stderr/error lines for the message
          const errorLines = combined
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('__SSH_TEST_RESULT__'))
            .join('\n');
          resolve({
            success,
            message: success
              ? 'SSH connection successful!'
              : errorLines || 'Connection test failed.',
          });
        } else {
          console.log('[sync] SSH test result not found in output:', combined);
          resolve({
            success: false,
            message: `Python exited with code ${code}`,
          });
        }
      });
    });
  });

  function insertSessionsWithDedup(sessions) {
    const insertOne = db.prepare(
      'INSERT INTO sessions (id, date, title, language, characters, duration, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const checkExisting = db.prepare(
      'SELECT 1 FROM sessions WHERE title = ? AND characters = ? AND date = ? AND duration = ? AND language = ?',
    );
    let inserted = 0;
    let skipped = 0;
    for (const session of sessions) {
      const existing = checkExisting.get(
        session.title,
        session.characters,
        session.date,
        session.duration,
        session.language,
      );
      if (existing) {
        skipped++;
        continue;
      }
      try {
        insertOne.run(
          session.id,
          session.date,
          session.title,
          session.language || null,
          session.characters || 0,
          session.duration || 0,
          session.unit || 'minutes',
        );
        inserted++;
      } catch (e) {
        skipped++;
      }
    }
    console.log(
      '[sync] insertSessionsWithDedup: found=%d inserted=%d skipped=%d',
      sessions.length,
      inserted,
      skipped,
    );
    return { total: sessions.length, inserted, skipped };
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (db) db.close();
  app.quit();
});
