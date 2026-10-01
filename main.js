const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
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
    kindle: { host: '192.168.15.244', user: 'root', password: '', sshKey: '' },
    theme: 'theme-wave',
    timezone: '-3',
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
  };
});

ipcMain.handle('save-settings', async (event, data) => {
  try {
    const settings = loadSettings();
    settings.kindle = {
      host: data.host,
      user: data.user,
      password: data.password || '',
      sshKey: data.sshKey || '',
    };
    settings.theme = data.theme || 'theme-wave';
    settings.timezone = data.timezone || '-3';
    saveSettings(settings);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-settings', async (event, key, value) => {
  try {
    const settings = loadSettings();
    if (!settings.kindle) settings.kindle = {};
    settings.kindle[key] = value;
    saveSettings(settings);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

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

  return db;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1300,
    minWidth: 800,
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

  // Backup: export database to file
  ipcMain.handle('backup-database', async (_, targetPath) => {
    if (!db) throw new Error('No database connected');
    db.backup(targetPath);
    return targetPath;
  });

  // Restore: load from a .sqlite file
  ipcMain.handle('restore-database', async (_, sourcePath) => {
    // Close current db before restoring
    if (db) db.close();
    const sourceDb = new Database(sourcePath);
    const destDb = new Database(getDbPath());
    destDb.exec('DROP TABLE IF EXISTS sessions;');
    // Copy tables from source to dest using SQL
    const tables = sourceDb
      .prepare(
        "SELECT * FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'",
      )
      .all()
      .filter((t) => t.type === 'table');
    for (const table of tables) {
      destDb.exec(table.sql);
      const rows = sourceDb.prepare(`SELECT * FROM "${table.name}"`).all();
      if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const insertSql = `INSERT INTO "${table.name}" (${columns.map((c) => '"' + c + '"').join(', ')}) VALUES (${placeholders})`;
        const insertStmt = destDb.prepare(insertSql);
        for (const row of rows) {
          insertStmt.run(...columns.map((c) => row[c]));
        }
      }
    }
    sourceDb.close();
    destDb.close();
    // Reopen our main db
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    return true;
  });

  // Get database path for info
  ipcMain.handle('get-db-path', () => {
    return getDbPath();
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
