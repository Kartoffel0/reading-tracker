const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Session operations
  insertSession: (session) => ipcRenderer.invoke('insert-session', session),
  deleteSession: (dateKey, sessionId) =>
    ipcRenderer.invoke('delete-session', dateKey, sessionId),
  getSessionsByDate: (dateKey) =>
    ipcRenderer.invoke('get-sessions-by-date', dateKey),
  getAllSessions: () => ipcRenderer.invoke('get-all-sessions'),

  // Data queries
  getDates: () => ipcRenderer.invoke('get-dates'),
  getDayTotal: (dateKey) => ipcRenderer.invoke('get-day-total', dateKey),
  getActiveDates: () => ipcRenderer.invoke('get-active-dates'),
  getSessionCounts: () => ipcRenderer.invoke('get-session-counts'),

  // Bulk import
  bulkInsertSessions: (sessions) =>
    ipcRenderer.invoke('bulk-insert-sessions', sessions),

  // Database management
  backupDatabase: (targetPath) =>
    ipcRenderer.invoke('backup-database', targetPath),
  restoreDatabase: (sourcePath) =>
    ipcRenderer.invoke('restore-database', sourcePath),
  getDbPath: () => ipcRenderer.invoke('get-db-path'),

  // Theme persistence (via settings stored in %APPDATA%)
  getTheme: () =>
    window.electronAPI.getSettings().then((s) => s.theme || 'theme-wave'),
  setTheme: (themeName) =>
    window.electronAPI.updateSettings('theme', themeName),

  // Dialogs
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  getDocumentsPath: () => ipcRenderer.invoke('get-docs-path'),

  // App lifecycle
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  updateSettings: (key, value) =>
    ipcRenderer.invoke('update-settings', key, value),

  // Kindle Sync
  triggerKindleSync: () => ipcRenderer.invoke('sync-kindle'),
  testKindleSshConnection: () => ipcRenderer.invoke('test-ssh-connection'),
  onSyncStatus: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('sync-status', subscription);
    return () => ipcRenderer.off('sync-status', subscription);
  },
  onSyncComplete: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('sync-complete', subscription);
    return () => ipcRenderer.off('sync-complete', subscription);
  },
});
