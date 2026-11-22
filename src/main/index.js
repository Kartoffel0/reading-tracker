const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { readAudiobookMeta, findAudiobooks, findSubtitles } = require('./mp4');

let mainWindow;
let db = null;
const audioMetaCache = new Map();

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
    // Epoch ms of a stopwatch that is still running, or null. Persisted so a
    // restart doesn't lose a session in progress.
    stopwatchStartedAt: settings.stopwatch?.startedAt ?? null,
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
    // `theme`, `timezone` and `stopwatch` are top-level settings; anything else
    // belongs to the kindle block.
    if (key === 'theme' || key === 'timezone' || key === 'stopwatch') {
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

  // A stored entry names its own file: manual uploads keep the picked
  // extension (.png/.jpeg/...), so building a hard-coded .jpg path here would
  // miss them and re-download the original cover over the user's replacement.
  if (entry && entry.file) {
    const stored = path.join(COVERS_DIR, path.basename(entry.file));
    if (fs.existsSync(stored)) {
      return { key, status: entry.status, url: pathToFileURL(stored).href };
    }
  }

  const file = coverPathFor(key);

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

  // Additive, idempotent migrations. Every database opened here goes through
  // them — a fresh file, the live file after Restore swapped it for an older
  // backup, or a data.db dropped in by hand. A row without times keeps NULL
  // timestamps and is filed by its date alone.
  const sessionColumns = new Set(
    db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name),
  );
  const addSessionColumn = (name, definition) => {
    if (!sessionColumns.has(name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
    }
  };
  addSessionColumn('media', "TEXT NOT NULL DEFAULT 'book'");
  addSessionColumn('start_at', 'TEXT');
  addSessionColumn('end_at', 'TEXT');

  // The first pass after this stored a bare date plus two wall-clock times, which
  // left a session spanning midnight indistinguishable from one that merely
  // ended early. Fold those columns into real timestamps (the date column holds
  // the END day, so a start later than the end means the day before), then drop
  // them: two sources of truth for the same moment is how they drift apart.
  if (sessionColumns.has('start_time') || sessionColumns.has('end_time')) {
    const legacy = db
      .prepare('SELECT id, date, start_time, end_time FROM sessions')
      .all();
    const update = db.prepare(
      'UPDATE sessions SET start_at = ?, end_at = ? WHERE id = ?',
    );
    db.transaction(() => {
      for (const row of legacy) {
        if (!row.start_time || !row.end_time || !row.date) continue;
        const [year, month, day] = row.date.split('-').map(Number);
        const start = new Date(year, month - 1, day);
        if (row.start_time > row.end_time) start.setDate(start.getDate() - 1);
        const startDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
        update.run(
          `${startDate}T${row.start_time}`,
          `${row.date}T${row.end_time}`,
          row.id,
        );
      }
    })();
    if (sessionColumns.has('start_time'))
      db.exec('ALTER TABLE sessions DROP COLUMN start_time');
    if (sessionColumns.has('end_time'))
      db.exec('ALTER TABLE sessions DROP COLUMN end_time');
  }
  // migration_flag guarded a one-shot data migration that no longer exists in
  // the app, so the table is dead weight that also trips off every backup: drop
  // it on sight, which scrubs it out of older backups when they get restored.
  db.exec('DROP TABLE IF EXISTS migration_flag;');

  // ===== Books =====
  //
  // One row per title, keyed exactly like sessions so nothing has to be joined
  // through a foreign key. Sessions keep working if a books row goes missing, so
  // this table is additive: it exists so a book can be owned before it is read.
  //
  // `kind` is the shelf axis (book | vn). Audiobook is NOT a kind: an audiobook
  // is still the same book, just a copy you can listen to, and the flag matters
  // only to the audiobook player. A title logged as voicing therefore keeps
  // kind='book' and carries is_audio=1.
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      title      TEXT PRIMARY KEY,
      kind       TEXT NOT NULL DEFAULT 'book',
      -- 1 once a human picked the shelf with the LN/VN selector; derivation
      -- stops touching it from then on.
      kind_manual INTEGER NOT NULL DEFAULT 0,
      is_audio   INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'reading',
      added_at   TEXT NOT NULL,
      author     TEXT,
      series     TEXT,
      audio_path TEXT,
      position   REAL DEFAULT 0,
      rate       REAL DEFAULT 1.0
    );
  `);

  // Covers already have a home: covers/covers.json plus the image files, both
  // keyed by title and reachable from the renderer. A column here would be a
  // second copy of the same fact, so a books table that grew one loses it.
  if (
    db.prepare('PRAGMA table_info(books)').all().some((c) => c.name === 'cover')
  ) {
    db.exec('ALTER TABLE books DROP COLUMN cover');
  }

  // Author and series are never derived — the session log has no field for them
  // and KOReader's sidecar does not carry them — so they arrive only when the
  // user types them into the book sheet.
  const bookColumns = new Set(
    db.prepare('PRAGMA table_info(books)').all().map((column) => column.name),
  );
  if (!bookColumns.has('author'))
    db.exec('ALTER TABLE books ADD COLUMN author TEXT');
  if (!bookColumns.has('kind_manual'))
    db.exec('ALTER TABLE books ADD COLUMN kind_manual INTEGER NOT NULL DEFAULT 0');
  if (!bookColumns.has('series'))
    db.exec('ALTER TABLE books ADD COLUMN series TEXT');
  // Runtime, read out of the file's own `mvhd` at import. It is the one fact the
  // shelf needs on every render that would otherwise require opening every
  // book: `position` is meaningless as a percentage without it.
  if (!bookColumns.has('audio_duration'))
    db.exec('ALTER TABLE books ADD COLUMN audio_duration REAL');
  // Where this book's current listening session began, as a position inside the
  // file. The session lasts until it is logged (or reset), and a session is a
  // stretch of the book rather than a stretch of the day, so the value survives
  // restarts and is only moved by LOG SESSION or an explicit reset.
  if (!bookColumns.has('session_start'))
    db.exec('ALTER TABLE books ADD COLUMN session_start REAL');
  // When that session began, in epoch milliseconds. A session is a stopwatch,
  // not a stretch of audio: it runs on the wall clock and survives a restart,
  // so both halves — where in the book, and when — belong on the row.
  if (!bookColumns.has('session_started_at'))
    db.exec('ALTER TABLE books ADD COLUMN session_started_at INTEGER');


  // The shelf has exactly three states, and they name what you are doing with
  // the book: reading it, done with it, or off it. The first schema guess
  // (active / paused / done) was bookkeeping vocabulary; fold it on.
  db.exec("UPDATE books SET status = 'reading' WHERE status IN ('active', 'paused')");
  db.exec("UPDATE books SET status = 'read' WHERE status = 'done'");

  // Backfill is idempotent rather than a one-shot: a fresh file, an old backup
  // restored over the live one, and a data.db dropped in by hand all arrive with
  // sessions but no books rows. Titles already owned are left alone, so a
  // manually added book never gets its kind overwritten by its first session.
  db.exec(`
    INSERT INTO books (title, kind, is_audio, added_at)
    SELECT title,
           CASE WHEN SUM(media = 'vn') > 0 THEN 'vn' ELSE 'book' END,
           CASE WHEN SUM(media = 'audiobook') > 0 THEN 1 ELSE 0 END,
           MIN(date)
      FROM sessions
     WHERE title NOT IN (SELECT title FROM books) AND title IS NOT NULL AND title <> ''
     GROUP BY title;
  `);

  return db;
}

// Keeps a session's title known to the library. Called from every path that
// writes a session, so the table cannot drift from the sessions it describes.
// kind only ever escalates to 'vn' and the audio flag only ever turns on: a
// session cannot prove a book is *not* an audiobook, only that it is.
// A shelf someone picked by hand is never rewritten: the sessions guessed once,
// the human knows.
function recordBookForSession(title, media, date) {
  if (!title) return;
  const kind = media === 'vn' ? 'vn' : 'book';
  const isAudio = media === 'audiobook' ? 1 : 0;
  db.prepare(
    `INSERT INTO books (title, kind, is_audio, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(title) DO UPDATE SET
       kind     = CASE WHEN books.kind_manual = 1 THEN books.kind
                       WHEN excluded.kind = 'vn' THEN 'vn'
                       ELSE books.kind END,
       is_audio = MAX(books.is_audio, excluded.is_audio),
       added_at = MIN(books.added_at, excluded.added_at)`,
  ).run(title, kind, isAudio, date || new Date().toISOString().slice(0, 10));
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
    width: 1680,
    height: 1260,
    minWidth: 1680,
    minHeight: 1260,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
        'INSERT INTO sessions (id, date, title, language, characters, duration, unit, start_at, end_at, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      stmt.run(
        session.id,
        session.date,
        session.title,
        session.language,
        session.characters,
        session.duration,
        session.unit,
        session.start_at || null,
        session.end_at || null,
        session.media || 'book',
      );
      recordBookForSession(session.title, session.media, session.date);
      return { success: true, duplicated: false };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Bulk insert sessions from CSV data
  ipcMain.handle('bulk-insert-sessions', (_, sessions) => {
    const stmt = db.prepare(
      'INSERT INTO sessions (id, date, title, language, characters, duration, unit, start_at, end_at, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
            session.start_at || null,
            session.end_at || null,
            session.media || 'book',
          );
          recordBookForSession(session.title, session.media, session.date);
          successCount++;
        } catch (err) {
          errors.push({ row: session, error: err.message });
        }
      }
      return { successCount, errors };
    });
    return insertMany(sessions);
  });

  // Deleted by id, not by date: a session counted under the previous session day
  // lives in a different bucket than the date it was recorded with.
  ipcMain.handle('delete-session', (_, _dateKey, sessionId) => {
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
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

  // ===== Books =====
  // The book sheet reads one row and writes back only what a human can type:
  // status, author, series. Everything else on the row is derived from sessions
  // (added_at, is_audio, kind) or belongs to a later phase (audio_path, position,
  // rate), so it is deliberately not writable from here.
  ipcMain.handle('get-book', (_, title) => {
    return db.prepare('SELECT * FROM books WHERE title = ?').get(title) || null;
  });

  const BOOK_STATUSES = new Set(['reading', 'read', 'dropped']);
  const BOOK_KINDS = new Set(['book', 'vn']);

  ipcMain.handle('update-book', (_, title, patch = {}) => {
    const fields = [];
    const values = [];
    if (BOOK_STATUSES.has(patch.status)) {
      fields.push('status = ?');
      values.push(patch.status);
    }
    // The selector says LN or VN; the column stays the shelf vocabulary the rest
    // of the code reads (book | vn), so nothing downstream has to learn a third
    // word for the same thing.
    if (BOOK_KINDS.has(patch.kind)) {
      fields.push('kind = ?', 'kind_manual = 1');
      values.push(patch.kind);
    }
    for (const key of ['author', 'series']) {
      if (typeof patch[key] !== 'string') continue;
      fields.push(`${key} = ?`);
      // An emptied field is stored as NULL, so "not filled in yet" has one
      // representation instead of two.
      values.push(patch[key].trim() || null);
    }
    if (!fields.length) return null;
    // A backup restored from before the books table, or a title that arrived by
    // hand, can be missing here; an UPDATE would then do nothing at all. Own the
    // title first, then write to it.
    if (!db.prepare('SELECT 1 FROM books WHERE title = ?').get(title)) {
      db.prepare(
        "INSERT INTO books (title, status, added_at) VALUES (?, 'reading', ?)",
      ).run(title, new Date().toISOString().slice(0, 10));
    }
    values.push(title);
    db.prepare(`UPDATE books SET ${fields.join(', ')} WHERE title = ?`).run(
      ...values,
    );
    return db.prepare('SELECT * FROM books WHERE title = ?').get(title) || null;
  });

  // The library grid needs every book in one answer, cover already resolved:
  // N IPC calls to paint N covers would be N round trips for data the main
  // process holds anyway. Sorted by recency of use — last session day, then the
  // day the title was added — so a book with no sessions still lands in place.
  ipcMain.handle('list-books', () => {
    const rows = db
      .prepare(
        `SELECT b.title, b.kind, b.is_audio, b.audio_path, b.status, b.added_at, b.author, b.series,
                (SELECT s.language FROM sessions s WHERE s.title = b.title
                  ORDER BY s.date DESC LIMIT 1) AS language,
                (SELECT MAX(s.date) FROM sessions s WHERE s.title = b.title) AS last_read
           FROM books b
          ORDER BY COALESCE((SELECT MAX(s.date) FROM sessions s WHERE s.title = b.title), b.added_at) DESC,
                   b.title COLLATE NOCASE`,
      )
      .all();
    return rows.map((row) => ({ ...row, cover: getCoverUrl(row.title) }));
  });

  // A book can exist before it is read: the grid's add tile writes the title and
  // the book sheet that opens next is where author, shelf and cover get filled
  // in. An existing title comes back as it is instead of erroring, so adding the
  // same book twice opens the one that is already there.
  ipcMain.handle('add-book', (_, title) => {
    const clean = typeof title === 'string' ? title.trim() : '';
    if (!clean) return null;
    let row = db.prepare('SELECT * FROM books WHERE title = ?').get(clean);
    if (!row) {
      // kind_manual: a person decided this book exists, so no session-derived
      // guess gets to move its shelf later. status is named instead of left to
      // the column default, because a table created before the shelf lost its
      // bookkeeping vocabulary still carries DEFAULT 'active'.
      db.prepare(
        "INSERT INTO books (title, kind, kind_manual, status, added_at) VALUES (?, 'book', 1, 'reading', ?)",
      ).run(clean, new Date().toISOString().slice(0, 10));
      row = db.prepare('SELECT * FROM books WHERE title = ?').get(clean);
    }
    return { ...row, cover: getCoverUrl(clean) };
  });

  // ─── Audiobooks ──────────────────────────────────────────────────────────
  //
  // An import is a folder scan, not a file manager: every .m4b under the picked
  // directory becomes a book row, with the runtime, chapter list, tags and cover
  // read from the file's own atoms. The shelf is the books table, so an imported
  // audiobook shows up next to everything else instead of in a private list.

  // Titles arrive as "[author] title [ASIN].m4b" more often than not; the
  // bracketed bookkeeping is not part of the name anyone searches for.
  function titleFromAudioFile(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const cleaned = base
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || base.trim();
  }

  function storeCoverArt(title, cover) {
    if (!cover || !cover.bytes || !cover.bytes.length) return;
    const key = coverKey(title);
    if (!key) return;
    const index = loadCoverIndex();
    const existing = index[key];
    // A manual upload outranks the art inside the file: the user replaced it on
    // purpose, and re-importing the folder must not paint over that.
    if (existing && existing.file && fs.existsSync(path.join(COVERS_DIR, existing.file))) return;
    ensureCoversDir();
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    const file = path.join(COVERS_DIR, `${hash}${cover.ext}`);
    fs.writeFileSync(file, cover.bytes);
    index[key] = {
      status: 'found',
      file: path.basename(file),
      source: 'm4b',
      fetchedAt: new Date().toISOString(),
    };
    saveCoverIndex();
  }

  ipcMain.handle('audio:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an audiobook folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Imports every audiobook under a folder. Rows that already exist keep their
  // placement and their cover; only the file facts are refreshed, so importing
  // the same folder twice is a no-op rather than a duplicate shelf.
  ipcMain.handle('audio:import-folder', (_, folder) => {
    const dir = typeof folder === 'string' ? folder.trim() : '';
    if (!dir || !fs.existsSync(dir)) return { success: false, error: 'folder not found' };
    const files = findAudiobooks(dir);
    if (!files.length) return { success: true, imported: [], folder: dir };

    const select = db.prepare('SELECT * FROM books WHERE title = ?');
    const insert = db.prepare(
      `INSERT INTO books (title, kind, kind_manual, is_audio, status, added_at, author, audio_path, audio_duration, position, rate)
       VALUES (?, 'book', 1, 1, 'reading', ?, ?, ?, ?, 0, 1.0)`,
    );
    const refresh = db.prepare(
      `UPDATE books SET is_audio = 1, audio_path = ?, audio_duration = ?,
                        author = COALESCE(author, ?)
        WHERE title = ?`,
    );

    const imported = [];
    const run = db.transaction(() => {
      for (const file of files) {
        const meta = readAudiobookMeta(file);
        const title = meta.title || meta.album || titleFromAudioFile(file);
        if (!title) continue;
        const existing = select.get(title);
        if (existing) refresh.run(file, meta.duration || null, meta.artist || null, title);
        else
          insert.run(
            title,
            new Date().toISOString().slice(0, 10),
            meta.artist || null,
            file,
            meta.duration || null,
          );
        storeCoverArt(title, meta.cover);
        imported.push({ title, path: file, duration: meta.duration, chapters: meta.chapters.length });
      }
    });
    run();
    audioMetaCache.clear();
    return { success: true, imported, folder: dir };
  });

  // The shelf of audiobooks only: books with a file, ordered by what you were
  // last listening to. `position` and `rate` ride along so the player can resume
  // without a second round trip.
  ipcMain.handle('audio:list', () => {
    const rows = db
      .prepare(
        `SELECT title, author, audio_path, audio_duration, position, rate,
                session_start, session_started_at, status,
                (SELECT MAX(date) FROM sessions WHERE sessions.title = books.title) AS last_read
           FROM books
          WHERE is_audio = 1 AND audio_path IS NOT NULL
          ORDER BY COALESCE(position, 0) > 0 DESC, COALESCE(last_read, added_at) DESC,
                   title COLLATE NOCASE`,
      )
      .all();
    return rows.map((row) => ({
      ...row,
      url: fs.existsSync(row.audio_path) ? pathToFileURL(row.audio_path).href : null,
      cover: getCoverUrl(row.title),
    }));
  });

  // Resume position and speed, written while playing. Nothing else in the books
  // table is touched: `update-book` deliberately refuses these columns, since a
  // form has no business rewriting playback state.
  ipcMain.handle('audio:progress', (_, title, patch = {}) => {
    if (!title) return { success: false };
    const fields = [];
    const values = [];
    if (Number.isFinite(patch.position)) {
      fields.push('position = ?');
      values.push(Math.max(0, patch.position));
    }
    if (Number.isFinite(patch.rate)) {
      fields.push('rate = ?');
      values.push(Math.min(2, Math.max(0.5, patch.rate)));
    }
    // The session start is a position, not a duration: it moves only when a
    // session is logged or reset, never while playing.
    if (Number.isFinite(patch.sessionStart)) {
      fields.push('session_start = ?');
      values.push(Math.max(0, patch.sessionStart));
    }
    // null ends a session; any finite number starts one.
    if (patch.sessionStartedAt === null) {
      fields.push('session_started_at = NULL');
    } else if (Number.isFinite(patch.sessionStartedAt)) {
      fields.push('session_started_at = ?');
      values.push(patch.sessionStartedAt);
    }
    if (!fields.length) return { success: false };
    values.push(title);
    db.prepare(`UPDATE books SET ${fields.join(', ')} WHERE title = ?`).run(...values);
    return { success: true };
  });

  // Chapters are read from the file on demand rather than stored: the atom list
  // is the truth, and re-reading it costs one moov (a few MB) per open. The cache
  // is keyed by path, so re-importing a file invalidates nothing stale.
  ipcMain.handle('audio:chapters', (_, title) => {
    const row = db.prepare('SELECT audio_path FROM books WHERE title = ?').get(title);
    if (!row || !row.audio_path) return [];
    if (audioMetaCache.has(row.audio_path)) return audioMetaCache.get(row.audio_path).chapters;
    const meta = readAudiobookMeta(row.audio_path);
    audioMetaCache.set(row.audio_path, meta);
    return meta.chapters;
  });

  // Subtitles go through main because a renderer cannot read a file:// URL: the
  // SRT is parsed there, but the bytes arrive here. 8,456 cues is ~700 KB, so it
  // is one round trip and nothing streams.
  ipcMain.handle('audio:subtitles', (_, title) => {
    const row = db.prepare('SELECT audio_path FROM books WHERE title = ?').get(title);
    if (!row || !row.audio_path) return null;
    let srtPath = null;
    try {
      srtPath = findSubtitles(row.audio_path);
    } catch {
      return null;
    }
    if (!srtPath) return null;
    try {
      return { name: path.basename(srtPath), text: fs.readFileSync(srtPath, 'utf8') };
    } catch {
      return null;
    }
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

  ipcMain.handle('window-minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window-close', () => {
    mainWindow.close();
  });

  // ─── Kindle Sync ───────────────────────────────────────────────────────────

  const DEFAULT_HOST = '192.168.15.244';
  const DEFAULT_USER = 'root';
  const DEFAULT_PASSWORD = 'kindle';

  // Packaged: extraFiles copies resources/python to <install>/resources/python,
  // which is exactly process.resourcesPath. Dev: the same source directory,
  // reached from src/main up to the project root.
  function getPythonResourcesDir() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'python')
      : path.join(__dirname, '..', '..', 'resources', 'python');
  }

  function buildPythonEnv(pythonCmd, resourcesDir) {
    const env = { ...process.env };
    // Always use Lib/site-packages/ since extraFiles copies resources/python/Lib
    const sitePackages = path.join(resourcesDir, 'Lib', 'site-packages');
    if (fs.existsSync(sitePackages)) {
      env.PYTHONPATH = sitePackages;
    }
    return env;
  }

  function getCacheDir() {
    return path.join(app.getPath('appData'), 'reading-tracker', 'kindle-cache');
  }

  ipcMain.handle('sync-kindle', async (_event, options = {}) => {
    return new Promise((resolve) => {
      const force = Boolean(options?.force);
      const resourcesDir = getPythonResourcesDir();
      const syncScript = path.join(resourcesDir, 'sync_kindle.py');
      const sitePackages = path.join(resourcesDir, 'Lib', 'site-packages');

      // Verify site-packages exists
      if (!fs.existsSync(sitePackages)) {
        mainWindow?.webContents.send('sync-complete', {
          success: false,
          error:
            'Python site-packages not found — reinstall app or run: pip install -r resources/python/requirements.txt --target <site-packages-dir>',
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

      const child = spawn(
        pythonCmd,
        force ? [syncScript, '--force'] : [syncScript],
        { env },
      );
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

      // The extractor hands back timezone-adjusted ISO datetimes
      // (2026-11-21T00:48:13-0300). Keep the wall clock it computed and drop the
      // offset: the date column already means "local day", and mixing zones in
      // one column is how a session lands on the wrong day.
      function localTimestamp(value) {
        if (!value) return null;
        const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
        return match ? `${match[1]}T${match[2]}:${match[3]}` : null;
      }

      function handleSyncResult(result) {
        // Normalize field names from Python script to DB schema
        // Python columns: session_date, start_date, end_date, book_title,
        //                 language, char_count, session_duration
        // DB columns:     date, start_at, end_at, title, language,
        //                 characters, duration, unit, media
        const normalizedSessions = (result.sessions || []).map((s) => {
          const startAt = localTimestamp(s.start_date);
          const endAt = localTimestamp(s.end_date);
          return {
            // The date column holds the END day; the day boundary is applied when
            // statistics aggregate, so the extractor's own session_date is not
            // reused here (that would shift twice).
            date: endAt ? endAt.slice(0, 10) : s.session_date || s.date || null,
            title: s.book_title || s.title || 'Untitled',
            language: resolveLanguage(s.language),
            characters: s.char_count != null ? parseInt(s.char_count, 10) : 0,
            duration:
              s.session_duration != null ? parseFloat(s.session_duration) : 0,
            unit: s.unit || 'minutes',
            start_at: startAt,
            end_at: endAt,
            media: 'book',
          };
        });

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
      'INSERT INTO sessions (id, date, title, language, characters, duration, unit, start_at, end_at, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // A re-sync of the same sidecar reproduces the same start timestamp, so that
    // is the strongest duplicate signal. Rows recorded without times fall back to
    // the old tuple, which keeps earlier imports from re-inserting themselves.
    const checkByTime = db.prepare(
      'SELECT 1 FROM sessions WHERE title = ? AND start_at = ?',
    );
    const checkExisting = db.prepare(
      'SELECT 1 FROM sessions WHERE title = ? AND characters = ? AND date = ? AND duration = ? AND language = ?',
    );
    let inserted = 0;
    let skipped = 0;
    for (const session of sessions) {
      const existing = session.start_at
        ? checkByTime.get(session.title, session.start_at)
        : checkExisting.get(
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
          session.start_at || null,
          session.end_at || null,
          session.media || 'book',
        );
        recordBookForSession(session.title, session.media, session.date);
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
