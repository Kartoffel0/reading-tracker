// Theme management
const THEMES = [
  'theme-dark-jp',
  'theme-classic',
  'theme-rising-sun',
  'theme-wave',
  'theme-sakura-dark',
  'theme-sakura-light',
];
const THEME_NAMES = {
  'theme-dark-jp': 'Dark Japanese',
  'theme-classic': 'Classic Red & White',
  'theme-rising-sun': 'Rising Sun',
  'theme-wave': 'Great Wave (波)',
  'theme-sakura-dark': 'Sakura Dark (桜)',
  'theme-sakura-light': 'Sakura Light (桜)',
};

function setTheme(themeName) {
  document.body.className = themeName;
  document.documentElement.className = themeName;
  window.electronAPI.setTheme(themeName);
}

function changeTheme(themeName) {
  setTheme(themeName);
}

// Load saved theme from settings
(async () => {
  const settings = await window.electronAPI.getSettings();
  const savedTheme = settings.theme || 'theme-wave';
  if (THEMES.includes(savedTheme)) {
    setTheme(savedTheme);
    document.getElementById('themeSelect').value = savedTheme;
  }
})();

// Floating Kanji Background
const kanjiChars = [
  '読',
  '書',
  '学',
  '文',
  '道',
  '魂',
  '力',
  '夢',
  '光',
  '風',
  '雷',
  '空',
  '海',
  '山',
  '火',
  '水',
  '木',
  '金',
  '土',
  '心',
  '愛',
  '勇',
  '忍',
  '命',
  '時',
  '空',
  '風',
  '花',
  '月',
  '星',
];
const kanjiBg = document.getElementById('kanjiBg');

function createKanji() {
  const kanji = document.createElement('div');
  kanji.className = 'kanji';
  kanji.textContent = kanjiChars[Math.floor(Math.random() * kanjiChars.length)];

  const size = Math.random() * 60 + 30;
  const left = Math.random() * 100;
  const duration = Math.random() * 20 + 15;
  const delay = Math.random() * 10;

  kanji.style.fontSize = size + 'px';
  kanji.style.left = left + '%';
  kanji.style.animationDuration = duration + 's';
  kanji.style.animationDelay = delay + 's';

  kanjiBg.appendChild(kanji);

  setTimeout(
    () => {
      kanji.remove();
    },
    (duration + delay) * 1000,
  );
}

// Create initial kanji immediately on page load
for (let i = 0; i < 15; i++) {
  createKanji();
}

// Continuously create kanji
setInterval(createKanji, 2000);

// App Logic
// Use SQLite via Electron IPC when available

function migrateData(parsed) {
  // Ensure data structure compatibility - add default fields if missing
  const migrated = {};
  for (const [dateKey, sessions] of Object.entries(parsed)) {
    if (Array.isArray(sessions)) {
      migrated[dateKey] = sessions.map((s) => ({
        ...s,
        language: s.language || 'Unknown',
        characters: s.characters || 0,
        unit: s.unit || 'minutes',
      }));
    }
  }
  return migrated;
}

async function getData() {
  const rows = await window.electronAPI.getAllSessions();
  const data = {};
  for (const row of rows) {
    if (!data[row.date]) {
      data[row.date] = [];
    }
    data[row.date].push({
      id: row.id,
      title: row.title,
      language: row.language,
      characters: row.characters,
      duration: row.duration,
      unit: row.unit,
    });
  }
  return data;
}

async function saveSession(session) {
  await window.electronAPI.insertSession(session);
}

async function removeSession(dateKey, sessionId) {
  await window.electronAPI.deleteSession(dateKey, sessionId);
}

function getDateKey(date) {
  return date.toISOString().split('T')[0];
}

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

// Custom Date Picker State
let dpCurrentDate = new Date();
let dpSelectedDate = new Date();
let dpIsOpen = false;

const dpMonthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function initDatePicker() {
  dpSelectedDate = new Date();
  dpCurrentDate = new Date();
  updateDatePickerDisplay();
  renderDatePickerDays();
}

function toggleDatePicker() {
  dpIsOpen = !dpIsOpen;
  const dropdown = document.getElementById('datePickerDropdown');
  if (dpIsOpen) {
    dpCurrentDate = new Date(dpSelectedDate);
    dropdown.classList.add('active');
  } else {
    dropdown.classList.remove('active');
  }
}

function dpPrevMonth() {
  dpCurrentDate.setMonth(dpCurrentDate.getMonth() - 1);
  renderDatePickerDays();
}

function dpNextMonth() {
  dpCurrentDate.setMonth(dpCurrentDate.getMonth() + 1);
  renderDatePickerDays();
}

function updateDatePickerDisplay() {
  const display = document.getElementById('datePickerValue');
  if (dpSelectedDate) {
    const year = dpSelectedDate.getFullYear();
    const month = String(dpSelectedDate.getMonth() + 1).padStart(2, '0');
    const day = String(dpSelectedDate.getDate()).padStart(2, '0');
    display.textContent = `${year}-${month}-${day}`;
  }
}

function renderDatePickerDays() {
  const year = dpCurrentDate.getFullYear();
  const month = dpCurrentDate.getMonth();

  const monthYearEl = document.getElementById('dpMonthYear');
  monthYearEl.textContent = `${dpMonthNames[month]} ${year}`;

  const daysContainer = document.getElementById('dpDays');
  daysContainer.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const selectedStr = dpSelectedDate.toISOString().split('T')[0];

  // Previous month days
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayEl = document.createElement('div');
    dayEl.className = 'dp-day other-month';
    dayEl.textContent = daysInPrevMonth - i;
    daysContainer.appendChild(dayEl);
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEl = document.createElement('div');
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    dayEl.classList.add('dp-day', 'current-month');

    if (dateStr === selectedStr) {
      dayEl.classList.add('selected');
    }
    if (dateStr === todayStr) {
      dayEl.classList.add('today');
    }

    dayEl.textContent = day;
    dayEl.addEventListener('click', () => {
      dpSelectedDate = new Date(year, month, day);
      updateDatePickerDisplay();
      renderDatePickerDays();
      dpIsOpen = false;
      document.getElementById('datePickerDropdown').classList.remove('active');
    });
    daysContainer.appendChild(dayEl);
  }

  // Next month days
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let day = 1; day <= remaining; day++) {
    const dayEl = document.createElement('div');
    dayEl.className = 'dp-day other-month';
    dayEl.textContent = day;
    daysContainer.appendChild(dayEl);
  }
}

function getSelectedDateKey() {
  if (!dpSelectedDate || isNaN(dpSelectedDate.getTime())) return null;
  const year = dpSelectedDate.getFullYear();
  const month = String(dpSelectedDate.getMonth() + 1).padStart(2, '0');
  const day = String(dpSelectedDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date();
  dpSelectedDate = new Date(today);
  dpCurrentDate = new Date(today);
  initDatePicker();
  await updateAll();
});

// Close date picker when clicking outside
document.addEventListener('click', (e) => {
  const datePicker = document.getElementById('datePicker');
  if (dpIsOpen && datePicker && !datePicker.contains(e.target)) {
    dpIsOpen = false;
    document.getElementById('datePickerDropdown').classList.remove('active');
  }
});

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

async function testKindleConnection() {
  showToast('Testing SSH connection...');
  try {
    const result = await window.electronAPI?.testKindleSshConnection?.();
    if (result?.success) {
      showToast('✓ SSH connection successful!');
    } else {
      showToast(`✗ Connection failed: ${result?.message || 'Unknown error'}`);
    }
  } catch (err) {
    showToast(`✗ Connection error: ${err.message}`);
  }
}

async function logReading() {
  const dateKey = getSelectedDateKey();
  const titleInput = document.getElementById('sessionTitle');
  const langSelect = document.getElementById('sessionLanguage');
  const charsInput = document.getElementById('sessionCharacters');
  const durationInput = document.getElementById('sessionDuration');
  const unitSelect = document.getElementById('durationUnit');

  if (!dateKey) {
    showToast('Select a date');
    return;
  }

  const duration = parseFloat(durationInput.value);
  if (isNaN(duration) || duration <= 0) {
    showToast('Enter valid duration');
    return;
  }

  const session = {
    id: Date.now(),
    date: dateKey,
    title: titleInput.value || 'Untitled',
    language: langSelect.value,
    characters: parseInt(charsInput.value) || 0,
    duration: duration,
    unit: unitSelect.value,
  };

  await saveSession(session);

  titleInput.value = '';
  charsInput.value = '';
  durationInput.value = '';
  unitSelect.value = 'minutes';

  await updateAll();
  showToast('✓ Session logged');
}

async function deleteSession(dateKey, sessionId) {
  await removeSession(dateKey, sessionId);
  await updateAll();
  await openDaySessions(dateKey);
  showToast('Session deleted');
}

function calculateStreaks(data) {
  const dates = Object.keys(data).sort();
  if (dates.length === 0) return { current: 0, best: 0 };

  let currentStreak = 0;
  let checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);

  const todayKey = getDateKey(checkDate);
  if (
    !data[todayKey] ||
    !Array.isArray(data[todayKey]) ||
    data[todayKey].length === 0
  ) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const key = getDateKey(checkDate);
    if (data[key] && Array.isArray(data[key]) && data[key].length > 0) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  let bestStreak = 0;
  let tempStreak = 0;
  const sortedDates = dates
    .filter((d) => data[d] && Array.isArray(data[d]) && data[d].length > 0)
    .sort();

  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      tempStreak = 1;
    } else {
      const prev = new Date(sortedDates[i - 1]);
      const curr = new Date(sortedDates[i]);
      const diff = (curr - prev) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
    }
    bestStreak = Math.max(bestStreak, tempStreak);
  }

  return { current: currentStreak, best: bestStreak };
}

async function calculateDayTotal(dateKey) {
  const totalMinutes = await window.electronAPI.getDayTotal(dateKey);
  return totalMinutes / 60;
}

async function updateStats(data) {
  const dates = Object.keys(data);
  let totalDays = 0;
  let totalMinutes = 0;

  dates.forEach((dateKey) => {
    const sessions = data[dateKey];
    if (sessions && Array.isArray(sessions) && sessions.length > 0) {
      totalDays += 1;
      sessions.forEach((s) => {
        totalMinutes += s.unit === 'minutes' ? s.duration : s.duration * 60;
      });
    }
  });

  const totalHours = totalMinutes / 60;
  const { current, best } = calculateStreaks(data);

  document.getElementById('currentStreak').textContent = current;
  document.getElementById('totalDays').textContent = totalDays;
  document.getElementById('totalHours').textContent = totalHours.toFixed(1);
  document.getElementById('bestStreak').textContent = best;
}

function fetchAllData() {
  return getData().then((data) => {
    updateStats(data);
    renderStreakMap();
    renderEntries();
  });
}

function getHoursLevel(hours) {
  if (hours === 0) return 0;
  if (hours < 0.25) return 1;
  if (hours < 0.5) return 2;
  if (hours < 1) return 3;
  if (hours < 2) return 4;
  return 5;
}

async function renderStreakMap() {
  const grid = document.getElementById('streakGrid');
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  document.getElementById('currentMonth').textContent =
    monthNames[currentMonth];
  document.getElementById('currentYear').textContent = currentYear;

  const data = await getData();
  grid.innerHTML = '';

  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => {
    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = d;
    grid.appendChild(label);
  });

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Calculate max hours in the month for relative levels
  const monthDates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    monthDates.push(new Date(currentYear, currentMonth, day));
  }

  const prevMonth = new Date(currentYear, currentMonth, 0);
  const prevMonthDaysInGrid = startDayOfWeek;
  const prevMonthLastDay = prevMonth.getDate();
  for (let i = 0; i < prevMonthDaysInGrid; i++) {
    const day = prevMonthLastDay - prevMonthDaysInGrid + 1 + i;
    monthDates.push(new Date(currentYear, currentMonth - 1, day));
  }

  const dayTotals = {};
  let maxHours = 0;
  for (const date of monthDates) {
    const dateKey = getDateKey(date);
    const totalHours = await calculateDayTotal(dateKey);
    dayTotals[dateKey] = totalHours;
    if (totalHours > maxHours) maxHours = totalHours;
  }

  function getRelativeLevel(hours) {
    if (hours === 0 || maxHours === 0) return 0;
    const percentage = hours / maxHours;
    if (percentage <= 0.2) return 1;
    if (percentage <= 0.4) return 2;
    if (percentage <= 0.6) return 3;
    if (percentage <= 0.8) return 4;
    return 5;
  }

  // Show last 30 days of activity + current month
  for (let i = 0; i < prevMonthDaysInGrid; i++) {
    const day = prevMonthLastDay - prevMonthDaysInGrid + 1 + i;
    const date = new Date(currentYear, currentMonth - 1, day);
    const dateKey = getDateKey(date);
    const cell = document.createElement('div');
    const totalHours = dayTotals[dateKey];
    const level = getRelativeLevel(totalHours);
    cell.className = `day-cell level-${level} prev-month`;

    const todayStr = today.toDateString();
    const dateStr = date.toDateString();

    if (dateStr === todayStr) {
      cell.classList.add('today');
    } else if (date > today) {
      cell.classList.add('future');
    } else {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => {
        openDaySessions(dateKey);
      });
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    if (totalHours > 0) {
      const sessions = data[dateKey];
      const sessionCount = sessions ? sessions.length : 0;
      tooltip.innerHTML = `${dateKey}<br>${totalHours.toFixed(1)}h · ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
    } else {
      tooltip.innerHTML = `${dateKey}<br>No reading`;
    }
    cell.appendChild(tooltip);

    grid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(currentYear, currentMonth, day);
    const dateKey = getDateKey(date);
    const cell = document.createElement('div');
    const totalHours = dayTotals[dateKey];
    const level = getRelativeLevel(totalHours);
    cell.className = `day-cell level-${level}`;

    const todayStr = today.toDateString();
    const dateStr = date.toDateString();

    if (dateStr === todayStr) {
      cell.classList.add('today');
    } else if (date > today) {
      cell.classList.add('future');
    }

    if (date > today) {
      cell.style.cursor = 'not-allowed';
    } else {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => {
        openDaySessions(dateKey);
      });
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    if (totalHours > 0) {
      const sessions = data[dateKey];
      const sessionCount = sessions ? sessions.length : 0;
      tooltip.innerHTML = `${dateKey}<br>${totalHours.toFixed(1)}h · ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
    } else {
      tooltip.innerHTML = `${dateKey}<br>No reading`;
    }
    cell.appendChild(tooltip);

    grid.appendChild(cell);
  }
}

function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 11) {
    currentMonth = 0;
    currentYear++;
  } else if (currentMonth < 0) {
    currentMonth = 11;
    currentYear--;
  }
  renderStreakMap();
}

async function openDaySessions(dateKey) {
  const data = await getData();
  const sessions = data[dateKey];
  const modal = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const footerSummary = document.getElementById('modalFooterSummaryDiv');

  modalTitle.textContent = `Sessions - ${dateKey}`;

  if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
    modalBody.innerHTML =
      '<div class="empty-state">No sessions recorded for this date.</div>';
    footerSummary.innerHTML = '';
    modal.classList.add('active');
    return;
  }

  let totalMinutes = 0;
  let totalChars = 0;

  const sessionsHtml = sessions
    .map((session) => {
      // Calculate reading speed for this session (characters per hour)
      const durationHours =
        session.unit === 'minutes' ? session.duration / 60 : session.duration;
      const speed =
        durationHours > 0
          ? Math.round((session.characters || 0) / durationHours)
          : 0;

      // Reverse language map: full name -> ISO 639 code
      const LANG_REVERSE = {
        Japanese: 'ja',
        English: 'en',
        Portuguese: 'pt',
        Spanish: 'es',
        Korean: 'ko',
        Chinese: 'zh',
        German: 'de',
        French: 'fr',
        Italian: 'it',
        Russian: 'ru',
        Dutch: 'nl',
        Swedish: 'sv',
        Danish: 'da',
        Norwegian: 'no',
        Finnish: 'fi',
        Polish: 'pl',
        Czech: 'cs',
        Hungarian: 'hu',
        Romanian: 'ro',
        Croatian: 'hr',
        Slovak: 'sk',
        Bulgarian: 'bg',
        Greek: 'el',
        Turkish: 'tr',
        Hebrew: 'he',
        Arabic: 'ar',
        Hindi: 'hi',
        Thai: 'th',
        Vietnamese: 'vi',
        Indonesian: 'id',
        Malay: 'ms',
        Filipino: 'tl',
        Ukrainian: 'uk',
      };
      const langCode =
        LANG_REVERSE[session.language] ||
        session.language?.substring(0, 2).toLowerCase() ||
        '??';

      const durationDisplay =
        session.unit === 'minutes'
          ? `${session.duration}m`
          : `${session.duration}h`;
      totalMinutes +=
        session.unit === 'minutes' ? session.duration : session.duration * 60;
      totalChars += session.characters || 0;

      return `
                    <div class="session-card">
                        <div class="session-card-header">
                            <span class="session-title">${session.title}</span>
                            <span class="session-badge lang-badge">${langCode.toUpperCase()}</span>
                            <button class="modal-close-btn" onclick="deleteSession('${dateKey}', ${session.id})">&times;</button>
                        </div>
                        <div class="session-details">
                            <div class="session-detail-item">
                                <span class="session-detail-label">Duration</span>
                                <span class="session-detail-value">${durationDisplay}</span>
                            </div>
                            <div class="session-detail-item">
                                <span class="session-detail-label">Characters</span>
                                <span class="session-detail-value">${(session.characters || 0).toLocaleString()}</span>
                            </div>
                            <div class="session-detail-item">
                                <span class="session-detail-label">Avg Speed</span>
                                <span class="session-detail-value">${speed.toLocaleString().replace(/\s/g, '')}/h</span>
                            </div>
                        </div>
                    </div>
                `;
    })
    .join('');

  const totalHours = (totalMinutes / 60).toFixed(1);
  const avgMinutes = totalMinutes / sessions.length;
  const avgDurationDisplay =
    avgMinutes >= 60
      ? `${(avgMinutes / 60).toFixed(1)}h`
      : `${Math.round(avgMinutes)}m`;

  // Calculate average reading speed (total characters / total hours)
  const totalHoursSession = totalMinutes / 60;
  const avgSpeed =
    totalHoursSession > 0 ? Math.round(totalChars / totalHoursSession) : 0;
  const avgSpeedDisplay =
    avgSpeed >= 1000 ? `${(avgSpeed / 1000).toFixed(1)}k` : `${avgSpeed}`;

  const summaryHtml = `
                <div class="day-summary">
                    <div class="day-summary-item">
                        <div class="day-summary-value">${sessions.length}</div>
                        <div class="day-summary-label">Sessions</div>
                    </div>
                    <div class="day-summary-item">
                        <div class="day-summary-value">${totalHours}h</div>
                        <div class="day-summary-label">Total Time</div>
                    </div>
                    <div class="day-summary-item">
                        <div class="day-summary-value">${totalChars.toLocaleString()}</div>
                        <div class="day-summary-label">Characters</div>
                    </div>
                    <div class="day-summary-item">
                        <div class="day-summary-value">${avgSpeedDisplay.replace(/\s/g, '')}/h</div>
                        <div class="day-summary-label">Avg Speed</div>
                    </div>
                </div>
            `;

  modalBody.innerHTML = sessionsHtml;
  footerSummary.innerHTML = summaryHtml;

  modal.classList.add('active');
}

function closeModal(event) {
  if (!event || event.target.id === 'modalOverlay') {
    document.getElementById('modalOverlay').classList.remove('active');
  }
}

// Unified ESC keydown for ALL modals
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (
    document.getElementById('importModalOverlay')?.classList.contains('active')
  )
    return closeBulkImportModal();
  if (
    document
      .getElementById('settingsModalOverlay')
      ?.classList.contains('active')
  )
    return closeSettingsModal();
  if (document.getElementById('modalOverlay')?.classList.contains('active'))
    return closeModal();
  if (document.getElementById('syncModalOverlay')?.classList.contains('active'))
    return closeKindleSyncModal();
});

async function renderEntries() {
  const data = await getData();
  const entryList = document.getElementById('entryList');
  const dates = Object.keys(data).sort((a, b) => b.localeCompare(a));

  let totalSessions = 0;
  dates.forEach((d) => {
    if (data[d] && Array.isArray(data[d])) {
      totalSessions += data[d].length;
    }
  });

  document.getElementById('entryCount').textContent =
    `${totalSessions} session${totalSessions !== 1 ? 's' : ''}`;

  if (dates.length === 0) {
    entryList.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">読</div><p>No entries yet. Start reading!</p></div>';
    return;
  }

  entryList.innerHTML = dates
    .slice(0, 50)
    .map((dateKey) => {
      const sessions = data[dateKey];
      const date = new Date(dateKey + 'T00:00:00');
      const formatted = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const sessionCount =
        sessions && Array.isArray(sessions) ? sessions.length : 0;
      const totalMinutes = sessions
        ? sessions.reduce(
            (sum, s) =>
              sum + (s.unit === 'minutes' ? s.duration : s.duration * 60),
            0,
          )
        : 0;
      const totalHours = (totalMinutes / 60).toFixed(1);

      return `
          <div class="entry-item">
            <span class="entry-date">${formatted}</span>
            <span class="entry-hours">${totalHours}h (${sessionCount} session${sessionCount !== 1 ? 's' : ''})</span>
            <div class="entry-btns">
                <button class="entry-btn view-btn" onclick="openDaySessions('${dateKey}')">View Sessions</button>
            </div>
          </div>
        `;
    })
    .join('');
}

async function updateAll() {
  const data = await getData();
  updateStats(data);
  await renderStreakMap();
  await renderEntries();
}

// Update duration unit labels dynamically
function updateDurationUnit() {
  const select = document.getElementById('durationUnit');
  const currentValue = select.value;
  // Unit toggle is handled by onchange
}

document.getElementById('sessionDuration').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') logReading();
});

async function backupDatabase() {
  const result = await window.electronAPI.showSaveDialog({
    title: 'Backup Reading Database',
    defaultPath: 'reading-tracker.db',
    filters: [
      { name: 'SQLite Database', extensions: ['db', 'sqlite'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePath) {
    try {
      await window.electronAPI.backupDatabase(result.filePath);
      showToast('✓ Database backed up successfully');
    } catch (e) {
      showToast('Backup failed: ' + e.message);
    }
  }
}

async function restoreDatabase() {
  const result = await window.electronAPI.showOpenDialog({
    title: 'Restore Reading Database',
    defaultPath: await window.electronAPI.getDocumentsPath(),
    properties: ['openFile'],
    filters: [
      { name: 'SQLite Database', extensions: ['db', 'sqlite'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      await window.electronAPI.restoreDatabase(result.filePaths[0]);
      showToast('✓ Database restored successfully');
      updateAll();
    } catch (e) {
      showToast('Restore failed: ' + e.message);
    }
  }
}

// ===== Bulk Import =====

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function openBulkImportModal() {
  // Show modal
  const overlay = document.getElementById('importModalOverlay');
  overlay.classList.add('active');

  // Create file input
  const modalBody = document.getElementById('importModalBody');
  // Clear previous preview but keep the format help
  let existingFileArea = document.getElementById('importFileArea');
  if (existingFileArea) existingFileArea.remove();

  const fileArea = document.createElement('div');
  fileArea.id = 'importFileArea';
  fileArea.style.marginTop = '16px';
  fileArea.innerHTML = `
    <div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-secondary); margin-bottom: 8px;">Select CSV File</label>
      <input type="file" id="importFileInput" class="file-input" accept=".csv,.tsv,.txt" onchange="handleFileSelect(event)">
    </div>
    <div id="importPreview"></div>
    <div id="importActions" style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px;">
      <button class="btn-cancel" onclick="closeBulkImportModal()" style="padding: 10px 24px; background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 8px; font-family: 'Inter', sans-serif; font-size: 0.8rem; cursor: pointer;">Cancel</button>
      <button id="importConfirmBtn" onclick="confirmBulkImport()" style="padding: 10px 24px; background: var(--accent-primary); color: white; border: none; border-radius: 8px; font-family: 'Inter', sans-serif; font-size: 0.8rem; font-weight: 600; cursor: pointer;" disabled>Import</button>
    </div>
  `;
  modalBody.appendChild(fileArea);
}

function closeBulkImportModal() {
  const overlay = document.getElementById('importModalOverlay');
  overlay.classList.remove('active');
  const fileArea = document.getElementById('importFileArea');
  if (fileArea) fileArea.remove();
}

// Close on overlay click
document.addEventListener('click', (e) => {
  const overlay = document.getElementById('importModalOverlay');
  if (overlay && e.target === overlay) {
    closeBulkImportModal();
  }
});

let parsedImportData = [];

async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });

    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      document.getElementById('importPreview').innerHTML =
        '<div class="error" style="color: var(--accent-primary); font-size: 0.75rem; margin-top: 8px;">File must contain at least a header row and one data row.</div>';
      return;
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    parsedImportData = [];

    // Try to detect column indices
    const idx = {
      date: headers.findIndex((h) => ['date', 'datum', 'data'].includes(h)),
      title: headers.findIndex((h) =>
        ['title', 'work', 'book', 'titulo'].includes(h),
      ),
      language: headers.findIndex((h) =>
        ['language', 'lang', 'idoma'].includes(h),
      ),
      characters: headers.findIndex((h) =>
        ['characters', 'chars', 'kanji', 'characters_read', '文字数'].includes(
          h,
        ),
      ),
      duration: headers.findIndex((h) =>
        ['duration', 'time', 'minutes', 'hours', 'duração', 'tempo'].includes(
          h,
        ),
      ),
      unit: headers.findIndex((h) =>
        ['unit', 'units', 'unidade', 'measure'].includes(h),
      ),
    };

    // Parse data rows
    const parsedRows = [];
    const errors = [];
    const warnings = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length === 0 || fields.every((f) => f === '')) continue;

      const row = {};

      // Map by header
      if (idx.date >= 0) row.date = fields[idx.date];
      if (idx.title >= 0) row.title = fields[idx.title] || 'Untitled';
      if (idx.language >= 0) row.language = fields[idx.language] || 'Unknown';
      if (idx.characters >= 0)
        row.characters = parseInt(fields[idx.characters]) || 0;
      if (idx.duration >= 0)
        row.duration = parseFloat(fields[idx.duration]) || 0;
      if (idx.unit >= 0) row.unit = fields[idx.unit] || 'minutes';

      // Fallback: positional (date, title, language, characters, duration, unit)
      if (idx.date < 0) row.date = fields[0];
      if (idx.title < 0) row.title = fields[1] || 'Untitled';
      if (idx.language < 0) row.language = fields[2] || 'Unknown';
      if (idx.characters < 0) row.characters = parseInt(fields[3]) || 0;
      if (idx.duration < 0) row.duration = parseFloat(fields[4]) || 0;
      if (idx.unit < 0) row.unit = fields[5] || 'minutes';

      // Validate
      if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
        errors.push(
          `Row ${i + 1}: Invalid or missing date "${row.date}" (expected YYYY-MM-DD)`,
        );
        continue;
      }
      if (!row.duration || row.duration <= 0) {
        warnings.push(`Row ${i + 1}: Duration is 0 or negative, skipped.`);
        continue;
      }

      // Normalize unit
      if (row.unit && row.unit.toLowerCase().startsWith('hour')) {
        row.duration = row.duration * 60;
        row.unit = 'minutes';
      }

      row.id = Date.now() + Math.floor(Math.random() * 100000) + i;
      parsedImportData.push(row);
    }

    // Render preview
    const preview = document.getElementById('importPreview');
    let html = `<div style="margin-bottom: 8px; font-size: 0.75rem; color: var(--text-secondary);"><strong>${parsedImportData.length}</strong> valid rows ready to import</div>`;
    html += `<div class="import-preview"><table><thead><tr>`;
    const displayHeaders = [
      'Date',
      'Title',
      'Language',
      'Characters',
      'Duration',
      'Unit',
    ];
    for (const h of displayHeaders) {
      html += `<th>${h}</th>`;
    }
    html += `</tr></thead><tbody>`;

    const previewRows = parsedImportData.slice(0, 50);
    for (const row of previewRows) {
      html += `<tr>`;
      html += `<td>${row.date}</td>`;
      html += `<td>${row.title}</td>`;
      html += `<td>${row.language}</td>`;
      html += `<td>${row.characters}</td>`;
      html += `<td>${row.unit === 'minutes' ? row.duration + 'm' : row.duration / 60 + 'h'}</td>`;
      html += `<td>${row.unit}</td>`;
      html += `</tr>`;
    }
    if (parsedImportData.length > 50) {
      html += `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">... and ${parsedImportData.length - 50} more rows</td></tr>`;
    }
    html += `</tbody></table></div>`;

    if (warnings.length > 0) {
      html += `<div style="margin-top: 8px; font-size: 0.7rem; color: var(--accent-secondary);">⚠ ${warnings.length} warning(s)</div>`;
    }

    preview.innerHTML = html;

    // Enable import button
    document.getElementById('importConfirmBtn').disabled =
      parsedImportData.length === 0;
  } catch (err) {
    document.getElementById('importPreview').innerHTML =
      `<div style="color: var(--accent-primary); font-size: 0.75rem; margin-top: 8px;">Error reading file: ${err.message}</div>`;
  }
}

async function confirmBulkImport() {
  const confirmBtn = document.getElementById('importConfirmBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Importing...';

  try {
    const result =
      await window.electronAPI.bulkInsertSessions(parsedImportData);

    const resultsDiv = document.getElementById('bulkImportResults');
    let html = `<div class="import-results">`;
    html += `<span class="success">✓ Imported ${result.successCount} session(s) successfully.</span>`;

    if (result.errors && result.errors.length > 0) {
      html += `<br><span class="warning">⚠ ${result.errors.length} error(s):</span><br>`;
      for (const err of result.errors.slice(0, 5)) {
        html += `<span class="error">  - ${err.row ? err.row.date : '?'}: ${err.error}</span><br>`;
      }
      if (result.errors.length > 5) {
        html += `<span class="warning">  ... and ${result.errors.length - 5} more</span>`;
      }
    }
    html += `</div>`;
    resultsDiv.innerHTML = html;

    // Refresh all data
    await updateAll();

    // Close modal
    closeBulkImportModal();
    showToast(`✓ Imported ${result.successCount} sessions`);
  } catch (err) {
    const resultsDiv = document.getElementById('bulkImportResults');
    resultsDiv.innerHTML = `<div class="import-results"><span class="error">Import failed: ${err.message}</span></div>`;
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Import';
  }
}

// ===== Settings Modal Logic =====

async function openSettingsModal() {
  const settings = await window.electronAPI.getSettings();
  document.getElementById('kindle-host').value = settings.host;
  document.getElementById('kindle-user').value = settings.user;
  document.getElementById('kindle-password').value = settings.password || '';
  document.getElementById('themeSelect').value = settings.theme || 'theme-wave';
  document.getElementById('timezoneSelect').value = settings.timezone || '-3';
  document.getElementById('settingsModalOverlay')?.classList.add('active');
}

function togglePasswordVisibility() {
  const passwordInput = document.getElementById('kindle-password');
  const eyeIcon = document.getElementById('eye-icon');
  if (passwordInput.type === 'password') {
    passwordInput.type = 'text';
    eyeIcon.innerHTML =
      '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
  } else {
    passwordInput.type = 'password';
    eyeIcon.innerHTML =
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
  }
}

function closeSettingsModal(event) {
  if (!event || event.target.id === 'settingsModalOverlay') {
    document.getElementById('settingsModalOverlay')?.classList.remove('active');
  }
}

// Save settings
document
  .getElementById('settings-form')
  ?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      host: document.getElementById('kindle-host').value,
      user: document.getElementById('kindle-user').value,
      password: document.getElementById('kindle-password').value,
      theme: document.getElementById('themeSelect').value,
      timezone: document.getElementById('timezoneSelect').value,
    };
    const result = await window.electronAPI.saveSettings(data);
    if (result.success) {
      closeSettingsModal();
      showToast('Settings saved!');
    } else {
      alert('Failed to save settings: ' + result.error);
    }
  });

// ===== Kindle Sync Modal Logic =====

const syncModalOverlay = document.getElementById('syncModalOverlay');
const syncModalBody = document.getElementById('syncModalBody');
const syncModalWaiting = document.getElementById('syncModalWaiting');
const syncModalStatus = document.getElementById('syncModalStatus');
const syncModalStartBtn = document.getElementById('syncModalStartBtn');

let isSyncing = false;

async function openKindleSyncModal() {
  if (isSyncing) return;
  syncModalOverlay?.classList.add('active');
  syncModalWaiting.classList.remove('hidden');
  syncModalStatus?.classList.add('hidden');
  syncModalStartBtn?.classList.remove('hidden');
  syncModalStartBtn?.removeAttribute('disabled');
  syncModalStartBtn.textContent = 'Start Sync';
}

function closeKindleSyncModal(event) {
  if (!event || event.target.id === 'syncModalOverlay') {
    syncModalOverlay?.classList.remove('active');
  }
}

// Close on overlay click
document.addEventListener('click', (e) => {
  if (syncModalOverlay && e.target === syncModalOverlay) {
    closeKindleSyncModal();
  }
});

function addSyncLogMessage(message, type = 'status') {
  // Ensure the status container is visible
  if (syncModalStatus?.classList.contains('hidden')) {
    syncModalStatus.classList.remove('hidden');
  }

  // Wait for next tick so DOM updates before we scroll
  requestAnimationFrame(() => {
    let logContainer = syncModalStatus?.querySelector('.sync-log');
    if (!logContainer) {
      logContainer = document.createElement('div');
      logContainer.className = 'sync-log';
      syncModalStatus?.appendChild(logContainer);
    }

    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = message;
    logContainer.appendChild(line);

    // Cap log lines to prevent unbounded growth
    const maxLines = 200;
    while (logContainer.children.length > maxLines) {
      logContainer.removeChild(logContainer.firstChild);
    }

    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
  });
}

function clearSyncLog() {
  if (syncModalStatus) {
    syncModalStatus.innerHTML = '';
  }
}

async function insertSessionsIntoDB(sessions) {
  if (!window.electronAPI || !Array.isArray(sessions) || sessions.length === 0)
    return 0;

  let inserted = 0;
  for (const session of sessions) {
    try {
      await window.electronAPI.insertSession(session);
      inserted++;
    } catch (e) {
      addSyncLogMessage(
        `  ⚠ Failed to insert session: ${e.message}`,
        'warning',
      );
    }
  }
  return inserted;
}

async function startKindleSync() {
  if (isSyncing) return;
  isSyncing = true;

  syncModalStartBtn?.setAttribute('disabled', '');
  syncModalStartBtn.textContent = 'Syncing...';
  syncModalWaiting?.classList.add('hidden');
  clearSyncLog();
  addSyncLogMessage('⏳ Initializing Kindle sync...', 'status');

  try {
    // Listen for status updates
    const statusUnsub = window.electronAPI?.onSyncStatus?.((data) => {
      addSyncLogMessage(data.message, 'status');
    });

    // Listen for completion
    const completeUnsub = window.electronAPI?.onSyncComplete?.((data) => {
      try {
        isSyncing = false;
        syncModalStartBtn?.removeAttribute('disabled');
        syncModalStartBtn.textContent = 'Start Sync';

        // Clean up subscriptions immediately - backend sends only ONE event now
        statusUnsub?.();
        completeUnsub?.();

        if (data.success) {
          const totalFound = data.stats?.sessionsExtracted || 0;
          const newCount = data.stats?.sessionsInserted || 0;
          const skipped = data.stats?.sessionsSkipped || 0;

          addSyncLogMessage('━'.repeat(40), 'divider');
          addSyncLogMessage(`✓ Sync complete!`, 'success');
          addSyncLogMessage(`  Sessions extracted: ${totalFound}`, 'success');
          addSyncLogMessage(`  New sessions inserted: ${newCount}`, 'success');
          addSyncLogMessage(`  Duplicates skipped: ${skipped}`, 'warning');

          // Show result card with backend stats (dedup-aware counts)
          // Backend already inserted sessions via insertSessionsWithDedup
          showSyncResult(newCount, skipped, totalFound, data.sessions || []);

          // Always refresh the UI (stats, streak map, entries)
          updateAll();

          showToast(
            `✓ Sync complete! ${totalFound} found, ${newCount} new session${newCount !== 1 ? 's' : ''}`,
          );
        } else {
          addSyncLogMessage('━'.repeat(40), 'divider');
          addSyncLogMessage(`✗ Sync failed: ${data.error}`, 'error');
        }
      } catch (innerErr) {
        addSyncLogMessage(
          `✗ Error during sync completion: ${innerErr.message}`,
          'error',
        );
      }
    });

    // Trigger sync
    await window.electronAPI?.triggerKindleSync?.();
  } catch (err) {
    isSyncing = false;
    syncModalStartBtn?.removeAttribute('disabled');
    syncModalStartBtn.textContent = 'Start Sync';
    addSyncLogMessage(`✗ Sync error: ${err.message}`, 'error');
  }
}

function showSyncResult(newCount, skipped, totalFound, sessions) {
  let statsContainer = syncModalStatus?.querySelector('.sync-stats');
  if (!statsContainer) {
    statsContainer = document.createElement('div');
    statsContainer.className = 'sync-stats';
    syncModalStatus?.appendChild(statsContainer);
  }

  statsContainer.innerHTML = '';

  const stats = [
    { value: totalFound, label: 'Extracted' },
    { value: newCount, label: 'Inserted' },
    { value: skipped, label: 'Skipped' },
  ];

  for (const stat of stats) {
    const card = document.createElement('div');
    card.className = 'sync-stat-card';
    card.innerHTML = `
      <span class="stat-value">${stat.value}</span>
      <span class="stat-label">${stat.label}</span>
    `;
    statsContainer.appendChild(card);
  }
}
