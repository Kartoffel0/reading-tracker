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
  // The preload's `setTheme` helper reads `window.electronAPI` from its own
  // isolated world, where it is undefined, so call updateSettings directly.
  window.electronAPI?.updateSettings?.('theme', themeName);
}

function changeTheme(themeName) {
  setTheme(themeName);
}

// Daily goal state (persisted via settings)
let currentGoal = { unit: 'minutes', value: 60 };

// Load saved settings (theme + daily goal) before the first render, so the
// goal card and the reading stats card use the persisted goal unit on startup.
const settingsReady = (async () => {
  try {
    const settings = await window.electronAPI.getSettings();
    const savedTheme = settings.theme || 'theme-wave';
    if (THEMES.includes(savedTheme)) {
      setTheme(savedTheme);
      document.getElementById('themeSelect').value = savedTheme;
    }
    currentGoal = {
      unit: settings.goalUnit === 'characters' ? 'characters' : 'minutes',
      value: Number(settings.goalValue) > 0 ? Number(settings.goalValue) : 60,
    };
  } catch (err) {
    console.error('Failed to load settings, using defaults:', err);
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

// Date keys are built from local year/month/day. Using toISOString() would
// shift the date across the UTC boundary (e.g. 21:00 local in UTC-3 belongs to
// tomorrow in UTC), which made the goal gauge read an empty day.
function getDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ===== SHARED TOOLTIP FORMATTING =====
// Every card tooltip (activity map, goal calendar, reading stats) is built from
// these helpers so they all read the same way:
//   YYYY MM DD · HHh MMm
//   N,NNN chars
//   N sessions        (activity map only)
function formatTooltipDate(dateKey) {
  return dateKey.replace(/-/g, ' ');
}

function formatTooltipDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

function formatTooltipChars(chars) {
  return `${Math.round(chars).toLocaleString()} chars`;
}

function formatTooltipSessions(count) {
  return `${count} session${count === 1 ? '' : 's'}`;
}

// Pass sessions as null to leave the sessions line out.
function tooltipLines(dateLabel, minutes, chars, sessions) {
  const lines = [
    `${dateLabel} · ${formatTooltipDuration(minutes)}`,
    formatTooltipChars(chars),
  ];
  if (sessions !== null && sessions !== undefined) {
    lines.push(formatTooltipSessions(sessions));
  }
  return lines;
}

// Sums minutes/chars/sessions straight from the day's session list.
function dayTotals(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return {
    minutes: list.reduce((sum, s) => sum + sessionMinutes(s), 0),
    chars: list.reduce((sum, s) => sum + (s.characters || 0), 0),
    sessions: list.length,
  };
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
  const todayStr = getDateKey(today);
  const selectedStr = getDateKey(dpSelectedDate);

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
  // The goal unit/value must be loaded before the first render, otherwise the
  // goal card and reading stats render with the default "minutes" goal.
  await settingsReady;
  await updateAll();
});

// Re-compute the square cell size whenever the window is resized.
window.addEventListener('resize', () => {
  const grid = document.getElementById('streakGrid');
  if (grid) sizeStreakGrid(grid);
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
    renderGoalCard(data);
    renderRecentlyRead(data);
    renderReadingTime(data);
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

// Keeps the activity-map cells square with an identical gap on every side:
// computes the largest square that fits the card, then widens the gap evenly
// using whatever space is left over on both axes.
function sizeStreakGrid(grid) {
  const rows = parseInt(grid.dataset.rows || '5', 10);
  const labelRowHeight = 18;
  const minGap = 4;
  const maxGap = 8;

  const panel = grid.closest('.streak-panel');
  const availWidth = grid.clientWidth || (panel ? panel.clientWidth - 40 : 240);
  const availHeight =
    grid.clientHeight || (panel ? panel.clientHeight - 90 : 200);

  const cellSize = Math.max(
    12,
    Math.min(
      (availWidth - minGap * 6) / 7,
      (availHeight - labelRowHeight - minGap * rows) / rows,
    ),
  );

  // Extra room on each axis if we grow the gap by the same amount everywhere.
  const slackX = (availWidth - cellSize * 7 - minGap * 6) / 6;
  const slackY =
    (availHeight - labelRowHeight - cellSize * rows - minGap * rows) / rows;
  const gap = Math.min(maxGap, minGap + Math.max(0, Math.min(slackX, slackY)));

  grid.style.setProperty('--cell-size', `${cellSize}px`);
  grid.style.setProperty('--gap', `${gap}px`);
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
  document.getElementById('currentMonthLabel').textContent =
    `${monthNames[currentMonth]} ${currentYear}`;

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

  // Build every grid slot: leading days from the previous month, this month's
  // days, and trailing days from the next month, so the grid is always a full
  // rectangle and both edges are rendered the same way.
  const prevMonth = new Date(currentYear, currentMonth, 0);
  const prevMonthLastDay = prevMonth.getDate();
  const gridCells = [];

  for (let i = 0; i < startDayOfWeek; i++) {
    const day = prevMonthLastDay - startDayOfWeek + 1 + i;
    gridCells.push({
      date: new Date(currentYear, currentMonth - 1, day),
      outOfMonth: true,
    });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    gridCells.push({
      date: new Date(currentYear, currentMonth, day),
      outOfMonth: false,
    });
  }

  const trailingDays = (7 - ((startDayOfWeek + daysInMonth) % 7)) % 7;
  for (let day = 1; day <= trailingDays; day++) {
    gridCells.push({
      date: new Date(currentYear, currentMonth + 1, day),
      outOfMonth: true,
    });
  }

  // Square cells that always fit inside the card: derive the largest square
  // that fits the available space, then let the leftover become the spacing.
  const rows = Math.ceil(gridCells.length / 7);
  grid.dataset.rows = rows;
  sizeStreakGrid(grid);

  // Calculate max hours across the visible grid for relative levels. Named
  // `dayHours` so it does not shadow the global `dayTotals` helper used by the
  // tooltips below.
  const dayHours = {};
  let maxHours = 0;
  for (const { date } of gridCells) {
    const dateKey = getDateKey(date);
    const totalHours = await calculateDayTotal(dateKey);
    dayHours[dateKey] = totalHours;
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

  const todayStr = today.toDateString();

  for (const { date, outOfMonth } of gridCells) {
    const dateKey = getDateKey(date);
    const level = getRelativeLevel(dayHours[dateKey]);
    const cell = document.createElement('div');
    cell.className = outOfMonth
      ? `day-cell level-${level} out-of-month`
      : `day-cell level-${level}`;

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

    const totals = dayTotals(data[dateKey]);
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.innerHTML = tooltipLines(
      formatTooltipDate(dateKey),
      totals.minutes,
      totals.chars,
      totals.sessions,
    ).join('<br>');
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

// ===== Dashboard Cards =====

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function sessionMinutes(s) {
  return s.unit === 'minutes' ? s.duration : s.duration * 60;
}

function formatHours(hours) {
  return hours >= 100 ? hours.toFixed(0) : hours.toFixed(1);
}

// "6h 36m" style duration from a minute count.
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatSpeed(charsPerHour) {
  return charsPerHour >= 10000
    ? `${(charsPerHour / 1000).toFixed(1)}k`
    : Math.round(charsPerHour).toLocaleString();
}

// Total value read on a given day, measured in the unit of the current goal.
function dayGoalValue(sessions, goalUnit) {
  if (!Array.isArray(sessions)) return 0;
  return goalUnit === 'characters'
    ? sessions.reduce((sum, s) => sum + (s.characters || 0), 0)
    : sessions.reduce((sum, s) => sum + sessionMinutes(s), 0);
}

// Goal-based streaks: a day only counts when the daily goal is actually met.
function computeGoalStats(data) {
  const goalUnit = currentGoal.unit;
  const goalValue = currentGoal.value;
  const met = new Set();
  let daysMet = 0;
  let bestValue = 0;
  let bestDate = '';

  for (const [dateKey, sessions] of Object.entries(data)) {
    const value = dayGoalValue(sessions, goalUnit);
    if (value <= 0) continue;
    if (value >= goalValue) {
      met.add(dateKey);
      daysMet++;
    }
    if (value > bestValue) {
      bestValue = value;
      bestDate = dateKey;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!met.has(getDateKey(today))) {
    today.setDate(today.getDate() - 1);
  }

  let current = 0;
  while (met.has(getDateKey(today))) {
    current++;
    today.setDate(today.getDate() - 1);
  }

  // Longest run of consecutive met days: walk the met dates in order and count
  // how many days in a row each one follows the previous. The day arithmetic is
  // done in UTC so it is never shifted by the local timezone.
  const nextDayKey = (key) => {
    const day = new Date(
      Date.UTC(
        Number(key.slice(0, 4)),
        Number(key.slice(5, 7)) - 1, // Date.UTC takes a 0-based month
        Number(key.slice(8, 10)),
      ),
    );
    day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
  };

  const metDates = [...met].sort();
  let longest = 0;
  let runLength = 0;
  let previousKey = null;

  for (const dateKey of metDates) {
    runLength =
      previousKey !== null && nextDayKey(previousKey) === dateKey
        ? runLength + 1
        : 1;
    previousKey = dateKey;
    if (runLength > longest) longest = runLength;
  }

  return { current, longest, daysMet, bestValue, bestDate };
}

function formatGoalValue(value, goalUnit) {
  return goalUnit === 'characters'
    ? Math.round(value).toLocaleString()
    : formatHours(value / 60);
}

async function renderGoalCard(data) {
  const card = document.getElementById('goalCard');
  if (!card) return;

  const gauge = document.getElementById('goalGauge');
  const todayKey = getDateKey(new Date());
  const sessions = data[todayKey] || [];

  const goalUnit = currentGoal.unit;
  const goalValue = currentGoal.value;

  let progress = 0;
  let readValue = 0;
  let readDisplay = '';
  let goalDisplay = '';
  let readUnit = '';
  let goalUnitLabel = '';

  if (goalUnit === 'characters') {
    readValue = sessions.reduce((sum, s) => sum + (s.characters || 0), 0);
    progress = goalValue > 0 ? Math.min(100, (readValue / goalValue) * 100) : 0;
    readDisplay = readValue.toLocaleString();
    goalDisplay = goalValue.toLocaleString();
    readUnit = 'characters';
    goalUnitLabel = 'character goal';
  } else {
    readValue = sessions.reduce((sum, s) => sum + sessionMinutes(s), 0);
    progress = goalValue > 0 ? Math.min(100, (readValue / goalValue) * 100) : 0;
    readDisplay = `${Math.round(readValue)}`;
    goalDisplay = `${goalValue}`;
    readUnit = 'minutes';
    goalUnitLabel = 'minute goal';
  }

  // The gauge is a circular arc (not an ellipse) spanning the full width of the
  // card. A true circle keeps the curve even and the ends angled outward instead
  // of plunging straight down, which is what makes it read as a gauge.
  // The apex is placed at the very top of the viewBox (sagitta == chordY - 5,
  // the 5 being half the 10px stroke) so the arc fills its box instead of
  // leaving an empty band above it.
  const VB_W = 400;
  const halfChord = 190; // horizontal distance from the center to each endpoint
  const chordY = 140; // the endpoints sit on this line, at the bottom of the viewBox
  const sagitta = 135; // how far the arc rises above the chord
  // Radius of the circle that produces that chord and sagitta.
  const radius = (halfChord * halfChord + sagitta * sagitta) / (2 * sagitta);
  // Actual arc length of that circular segment.
  const arcLength = 2 * radius * Math.asin(halfChord / radius);
  const dash = (progress / 100) * arcLength;
  const arcPath = `M ${VB_W / 2 - halfChord} ${chordY} A ${radius} ${radius} 0 0 1 ${VB_W / 2 + halfChord} ${chordY}`;

  if (gauge) {
    // The arc is only drawn when there is progress, so a 0% gauge shows no
    // stray round cap at the start of the track.
    const arc =
      progress > 0
        ? `<path class="goal-arc" d="${arcPath}" fill="none" stroke-linecap="round" stroke-dasharray="${dash} ${arcLength}"/>`
        : '';

    gauge.innerHTML = `
      <svg class="goal-gauge-svg" viewBox="0 0 ${VB_W} ${chordY + 5}">
        <path class="goal-track" d="${arcPath}" fill="none" stroke-linecap="round"/>
        ${arc}
        <text class="goal-today" x="200" y="66">Today</text>
        <text class="goal-big" x="200" y="100">${readDisplay}</text>
        <text class="goal-sub" x="200" y="118">${Math.round(readValue).toLocaleString()} ${readUnit}</text>
        <text class="goal-goal" x="200" y="130">/ ${goalDisplay} ${goalUnitLabel}</text>
      </svg>
    `;
  }

  const stats = computeGoalStats(data);
  const streakEl = document.getElementById('goalStreak');
  const longestEl = document.getElementById('goalLongestStreak');
  const daysEl = document.getElementById('goalDaysMet');
  const bestEl = document.getElementById('goalBestDay');
  const bestLabelEl = document.getElementById('goalBestDayLabel');

  if (streakEl) streakEl.textContent = stats.current;
  if (longestEl) longestEl.textContent = stats.longest;
  if (daysEl) daysEl.textContent = stats.daysMet;
  if (bestEl) {
    bestEl.textContent = formatGoalValue(stats.bestValue, goalUnit);
    bestEl.title = stats.bestDate
      ? `${stats.bestDate} · ${Math.round(stats.bestValue).toLocaleString()} ${goalUnit}`
      : 'No reading recorded yet';
  }
  if (bestLabelEl) {
    bestLabelEl.textContent =
      goalUnit === 'characters' ? 'BEST DAY (CHARS)' : 'BEST DAY (HRS)';
  }

  renderGoalCalendar(data);
}

// GitHub-style contribution calendar: 7 rows (Mon-Sun) x one column per week,
// starting on the Monday of the week that holds the first recorded session and
// growing by one column every day. It opens scrolled to the current week.
const GC_CELL = 12;
const GC_GAP = 3;
const GC_STEP = GC_CELL + GC_GAP;

// Width of the grid content (including the 8px side padding). Used to scroll
// to the far end without relying on scrollWidth, which is still 0 while the
// grid is being laid out.
function calendarContentWidth(weeks) {
  return 16 + weeks * GC_CELL + (weeks - 1) * GC_GAP;
}

// Earliest date that actually has a session recorded.
function firstRecordedDate(data) {
  let first = null;
  for (const [dateKey, sessions] of Object.entries(data)) {
    if (!Array.isArray(sessions) || sessions.length === 0) continue;
    if (first === null || dateKey < first) first = dateKey;
  }
  return first;
}

function renderGoalCalendar(data) {
  const cal = document.getElementById('goalCalendar');
  if (!cal) return;

  cal.innerHTML = '';

  const goalUnit = currentGoal.unit;
  const goalValue = currentGoal.value;

  // All dates are built from local year/month/day so weekday alignment is
  // never shifted by UTC parsing.
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const firstKey = firstRecordedDate(data);
  // 'T00:00:00' (no Z) is parsed as local time, so weekday alignment is safe.
  const start = firstKey ? new Date(firstKey + 'T00:00:00') : new Date(today);

  // First column = Monday of the week that contains the first recorded day.
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  // One column per week from that Monday up to the current week, so the grid
  // gains a column every day. With no data it is just the current week.
  // Rounding the day difference removes any DST drift before dividing by 7.
  const dayDiff = Math.round((today.getTime() - start.getTime()) / 86400000);
  const weeks = Math.max(1, Math.floor(dayDiff / 7) + 1);

  cal.style.setProperty('--gc-weeks', String(weeks));
  cal.dataset.weeks = String(weeks);

  for (let week = 0; week < weeks; week++) {
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + week * 7 + i);

      // Days after today are not rendered, so the last column ends on today.
      if (day > today) continue;

      const dateKey = getDateKey(day);
      const value = dayGoalValue(data[dateKey], goalUnit);
      const cell = document.createElement('div');

      // Explicit placement keeps every weekday in its own row even though
      // future days are skipped, so the grid never shifts sideways.
      cell.style.gridRow = String(i + 1);
      cell.style.gridColumn = String(week + 1);

      let state = 'gc-empty';
      if (value >= goalValue) {
        state = 'gc-met';
      } else if (value > 0) {
        state = 'gc-partial';
      }

      cell.className = `gc-cell ${state}`;

      if (day.getTime() === today.getTime()) {
        cell.classList.add('gc-today');
      }

      cell.addEventListener('click', () => openDaySessions(dateKey));

      const totals = dayTotals(data[dateKey]);
      const tooltip = document.createElement('div');
      tooltip.className = 'tooltip';
      tooltip.innerHTML = tooltipLines(
        formatTooltipDate(dateKey),
        totals.minutes,
        totals.chars,
        null,
      ).join('<br>');
      cell.appendChild(tooltip);

      // A centered tooltip is clipped by the scroll box for cells at either
      // edge of the viewport, so flip it to whichever side has room.
      cell.addEventListener('mouseenter', () =>
        alignTooltip(cal, cell, tooltip),
      );

      cal.appendChild(cell);
    }
  }

  // Always land on the current week; history is reachable by scrolling left.
  // Any value past the end is clamped by the browser, and scrollWidth is still
  // 0 while the grid is being laid out, so compute the width instead.
  cal.scrollLeft = calendarContentWidth(weeks);
  attachGoalCalendarWheel();
}

// Keeps a tooltip inside the scroll viewport when its cell sits at an edge.
// The clip boundary is the scroll box's padding box, i.e. 8px inside its
// border box, matching the 8px side padding on .goal-calendar.
const GC_SIDE_PADDING = 8;
const GC_HOVER_SCALE = 1.15;

function alignTooltip(cal, cell, tooltip) {
  tooltip.classList.remove('tip-left', 'tip-right');

  const calRect = cal.getBoundingClientRect();
  const clipLeft = calRect.left + GC_SIDE_PADDING;
  const clipRight = calRect.right - GC_SIDE_PADDING;

  // The tooltip is display:none until hover, so force it visible just long
  // enough to measure its layout width. offsetWidth is unaffected by the hover
  // transform, so scale it up to match what is actually painted.
  tooltip.style.display = 'block';
  const halfWidth = (tooltip.offsetWidth * GC_HOVER_SCALE) / 2;
  tooltip.style.display = '';

  // Scaling is centered on the element, so the cell's center is the same
  // whether or not the hover transform has finished.
  const cellRect = cell.getBoundingClientRect();
  const center = cellRect.left + cellRect.width / 2;

  const leftOverflow = clipLeft - (center - halfWidth);
  const rightOverflow = center + halfWidth - clipRight;

  if (leftOverflow > 0 && rightOverflow <= 0) {
    tooltip.classList.add('tip-left');
  } else if (rightOverflow > 0 && leftOverflow <= 0) {
    tooltip.classList.add('tip-right');
  } else if (leftOverflow > 0 && rightOverflow > 0) {
    // Wider than the viewport itself: align to whichever side has more room.
    tooltip.classList.add(
      center - clipLeft >= clipRight - center ? 'tip-left' : 'tip-right',
    );
  }
}

// Arrow buttons in the legend move the calendar by a page of weeks.
function scrollGoalCalendar(direction) {
  const cal = document.getElementById('goalCalendar');
  if (!cal) return;
  const weeks = Number(cal.dataset.weeks) || 1;
  const page = Math.min(10, weeks) * GC_STEP;
  cal.scrollLeft += direction * page;
}

// A normal vertical mouse wheel anywhere over the goal card scrolls the
// calendar sideways, since the grid only scrolls horizontally. It is wired to
// the card rather than the grid because the grid itself ignores pointer
// events.
function attachGoalCalendarWheel() {
  const cal = document.getElementById('goalCalendar');
  const card = document.querySelector('.goal-card');
  if (!cal || !card || card.dataset.wired) return;
  card.dataset.wired = '1';
  card.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      cal.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
}

// ===== Book Covers =====
// Covers are resolved and cached in the main process. This map only mirrors the
// results for the current session so the renderer never asks twice for the same
// title; anything already on disk is returned by the main process without a
// network request.
const coverCache = new Map();

// Resolve covers for titles that are not yet known locally. Titles already in
// the cache are skipped, so re-rendering the card costs nothing.
async function ensureCovers(entries) {
  const pending = entries.filter((e) => e.title && !coverCache.has(e.title));
  if (pending.length === 0) return;
  try {
    const results = await window.electronAPI.ensureCovers(pending);
    for (const [title, info] of Object.entries(results || {})) {
      coverCache.set(title, info || { status: 'missing', url: null });
    }
  } catch (err) {
    console.error('Cover lookup failed:', err.message);
  }
}

async function uploadCoverFor(title) {
  const result = await window.electronAPI.uploadCover(title);
  if (result?.success) {
    coverCache.set(title, { status: 'manual', url: result.url });
    showToast('✓ Cover added');
    renderRecentlyRead(await getData());
  } else if (!result?.canceled) {
    showToast(`Cover upload failed: ${result?.error || 'unknown error'}`);
  }
}

function coverMarkup(title) {
  const cover = coverCache.get(title);
  if (cover?.url) {
    return `<img class="recent-cover" src="${cover.url}" alt="${escapeHtml(title)} cover" />`;
  }
  const initial = escapeHtml((title.trim() || '?')[0]);
  return `
    <div class="recent-cover-placeholder">
      <span class="cover-initial">${initial}</span>
      <button class="cover-upload-btn" data-cover-title="${escapeHtml(title)}" title="Upload a cover image" aria-label="Upload a cover image">+</button>
    </div>
  `;
}

async function renderRecentlyRead(data) {
  const list = document.getElementById('recentlyReadList');
  if (!list) return;

  const byTitle = {};
  for (const [dateKey, sessions] of Object.entries(data)) {
    if (!Array.isArray(sessions)) continue;
    for (const s of sessions) {
      const title = s.title || 'Untitled';
      if (!byTitle[title]) {
        byTitle[title] = {
          lastDate: '',
          totalChars: 0,
          totalMinutes: 0,
          language: s.language,
        };
      }
      const entry = byTitle[title];
      if (dateKey > entry.lastDate) entry.lastDate = dateKey;
      entry.totalChars += s.characters || 0;
      entry.totalMinutes += sessionMinutes(s);
      if (!entry.language && s.language) entry.language = s.language;
    }
  }

  const books = Object.entries(byTitle).sort((a, b) =>
    b[1].lastDate.localeCompare(a[1].lastDate),
  );

  if (books.length === 0) {
    list.innerHTML =
      '<div class="empty-state"><p>No books tracked yet. Start reading!</p></div>';
    return;
  }

  const shown = books.slice(0, 5);
  await ensureCovers(
    shown.map(([title, entry]) => ({ title, language: entry.language })),
  );

  list.innerHTML = shown
    .map(([title, entry]) => {
      const hours = entry.totalMinutes / 60;
      const speed = hours > 0 ? entry.totalChars / hours : 0;
      return `
        <div class="recent-book">
          ${coverMarkup(title)}
          <div class="recent-info">
            <span class="recent-title"><span class="recent-title-text">${escapeHtml(title)}</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Characters Read</span> <span class="recent-stat-value recent-stat-chars">${entry.totalChars.toLocaleString()}</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Reading Speed</span> <span class="recent-stat-value">${Math.round(speed).toLocaleString()}/h</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Total Time</span> <span class="recent-stat-value">${formatDuration(entry.totalMinutes)}</span></span>
          </div>
        </div>
      `;
    })
    .join('');

  for (const btn of list.querySelectorAll('.cover-upload-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      uploadCoverFor(btn.dataset.coverTitle);
    });
  }

  // Titles too long for one line scroll only while the row is hovered.
  // The overflow is measured on hover, not at render time, because cover images
  // load asynchronously and would otherwise make the title column look wider
  // than it really is (so only the first row would ever qualify).
  for (const titleEl of list.querySelectorAll('.recent-title')) {
    const inner = titleEl.querySelector('.recent-title-text');
    const row = titleEl.closest('.recent-book');
    if (!inner || !row) continue;

    row.addEventListener('mouseenter', () => {
      if (inner.dataset.marqueeReady) return;

      const textWidth = inner.offsetWidth;
      const visibleWidth = titleEl.offsetWidth;
      if (textWidth <= visibleWidth) return;

      // Duplicate the text so the cycle ends exactly where it started,
      // giving a seamless one-direction scroll instead of a bounce.
      const gap = 24;
      const cycle = textWidth + gap;
      const text = inner.textContent;

      inner.innerHTML = `${escapeHtml(text)}<span class="marquee-gap"></span>${escapeHtml(text)}`;
      inner.style.setProperty('--marquee-cycle', `${cycle}px`);
      // Keep a steady ~40px/s so long titles don't scroll frantically
      inner.style.setProperty(
        '--marquee-duration',
        `${Math.max(4, cycle / 40).toFixed(2)}s`,
      );
      inner.dataset.marqueeReady = '1';
      inner.classList.add('marquee');
    });
  }
}

// Reading time state
let rtActivePeriod = 'week';
const RT_TABS = [
  { key: 'week', label: 'W', word: 'week' },
  { key: 'month', label: 'M', word: 'month' },
  { key: 'year', label: 'Y', word: 'year' },
  { key: 'all', label: 'A', word: 'all time' },
];

function rtFormatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function rtFormatAxis(minutes) {
  return minutes >= 60
    ? `${Math.round(minutes / 60)}h`
    : `${Math.round(minutes)}m`;
}

function rtNiceCeil(minutes) {
  if (minutes <= 0) return 60;
  if (minutes >= 60) return Math.ceil(minutes / 60) * 60;
  return Math.ceil(minutes / 15) * 15;
}

// Same idea as rtNiceCeil, but for character counts.
function rtNiceCeilChars(value) {
  if (value <= 0) return 100;
  if (value >= 1000) return Math.ceil(value / 1000) * 1000;
  if (value >= 100) return Math.ceil(value / 100) * 100;
  return Math.ceil(value / 10) * 10;
}

function rtFormatChars(value) {
  const n = Math.round(value);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function rtFormatAxisChars(value) {
  return value >= 10000
    ? `${Math.round(value / 1000)}k`
    : Math.round(value).toLocaleString();
}

const MONTH_SHORT = [
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

function rtShortDate(d) {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

// Tooltip date labels follow the shared "YYYY MM DD" convention. The year and
// all-time tabs bucket by month and year, so they use the shortened period
// label ("2026 10" / "2026") instead of a single day.
function rtTooltipLabel(bucketKey) {
  const now = new Date();
  if (rtActivePeriod === 'week') {
    const d = new Date(now);
    d.setDate(now.getDate() - ((now.getDay() - bucketKey + 7) % 7));
    return formatTooltipDate(getDateKey(d));
  } else if (rtActivePeriod === 'month') {
    return `${now.getFullYear()} ${String(now.getMonth() + 1).padStart(2, '0')} ${String(bucketKey).padStart(2, '0')}`;
  } else if (rtActivePeriod === 'year') {
    return `${now.getFullYear()} ${String(bucketKey + 1).padStart(2, '0')}`;
  }
  return String(bucketKey);
}

async function renderReadingTime(data) {
  const body = document.getElementById('readingTimeBody');
  const tabs = document.getElementById('readingTimeTabs');
  if (!body || !tabs) return;

  const now = new Date();
  const todayKey = getDateKey(now);

  let start = null;
  let prevStart = null;
  let prevEnd = null;
  if (rtActivePeriod === 'week') {
    start = new Date(now);
    start.setDate(start.getDate() - 6);
    prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - 7);
    prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
  } else if (rtActivePeriod === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (rtActivePeriod === 'year') {
    start = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    prevEnd = new Date(now.getFullYear(), 0, 0);
  }

  const startKey = start === null ? null : getDateKey(start);
  const prevStartKey = prevStart === null ? null : getDateKey(prevStart);
  const prevEndKey = prevEnd === null ? null : getDateKey(prevEnd);

  // The chart mirrors the daily goal unit: characters when the goal is set in
  // characters, time otherwise. The stats rows below always show both.
  const useChars = currentGoal.unit === 'characters';

  let totalMinutes = 0;
  let totalChars = 0;
  let prevMetric = 0;
  const buckets = new Map();

  for (const [dateKey, sessions] of Object.entries(data)) {
    if (!Array.isArray(sessions)) continue;
    for (const s of sessions) {
      const mins = sessionMinutes(s);
      const chars = s.characters || 0;
      const metric = useChars ? chars : mins;
      const inActive =
        startKey === null || (dateKey >= startKey && dateKey <= todayKey);
      if (inActive) {
        totalMinutes += mins;
        totalChars += chars;
        const d = new Date(dateKey + 'T00:00:00');
        let bucketKey;
        let label;
        if (rtActivePeriod === 'week') {
          bucketKey = d.getDay();
          label = 'SMTWTFS'[bucketKey];
        } else if (rtActivePeriod === 'month') {
          bucketKey = d.getDate();
          label = String(bucketKey);
        } else if (rtActivePeriod === 'year') {
          bucketKey = d.getMonth();
          label = 'JFMAMJJASOND'[bucketKey];
        } else {
          bucketKey = d.getFullYear();
          label = String(bucketKey);
        }
        const entry = buckets.get(bucketKey) || { minutes: 0, chars: 0, label };
        entry.minutes += mins;
        entry.chars += chars;
        buckets.set(bucketKey, entry);
      } else if (
        prevStartKey !== null &&
        dateKey >= prevStartKey &&
        dateKey <= prevEndKey
      ) {
        prevMetric += metric;
      }
    }
  }

  if (rtActivePeriod === 'week') {
    for (let i = 0; i < 7; i++) {
      if (!buckets.has(i)) {
        buckets.set(i, { minutes: 0, chars: 0, label: 'SMTWTFS'[i] });
      }
    }
  } else if (rtActivePeriod === 'month') {
    for (let d = 1; d <= now.getDate(); d++) {
      if (!buckets.has(d)) {
        buckets.set(d, { minutes: 0, chars: 0, label: String(d) });
      }
    }
  } else if (rtActivePeriod === 'year') {
    for (let m = 0; m < 12; m++) {
      if (!buckets.has(m)) {
        buckets.set(m, { minutes: 0, chars: 0, label: 'JFMAMJJASOND'[m] });
      }
    }
  }

  const sorted = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, v]) => ({ key, ...v }));

  const metricOf = (b) => (useChars ? b.chars : b.minutes);
  const maxMetric = Math.max(...sorted.map(metricOf), 1);
  const niceMax = useChars ? rtNiceCeilChars(maxMetric) : rtNiceCeil(maxMetric);

  const nonEmpty = sorted.filter((b) => metricOf(b) > 0);
  const avgMetric = nonEmpty.length
    ? nonEmpty.reduce((s, b) => s + metricOf(b), 0) / nonEmpty.length
    : 0;
  const avgTop = 100 - (avgMetric / niceMax) * 100;

  const totalMetric = useChars ? totalChars : totalMinutes;
  const periodWord = RT_TABS.find((t) => t.key === rtActivePeriod).word;
  let deltaText = '';
  if (prevStartKey !== null && prevMetric > 0) {
    const pct = Math.round(((totalMetric - prevMetric) / prevMetric) * 100);
    const arrow = pct >= 0 ? '↗' : '↘';
    deltaText = `${arrow} ${Math.abs(pct)}% from previous ${periodWord}`;
  }

  let rangeLabel;
  if (start === null) {
    rangeLabel = 'All time';
  } else {
    rangeLabel = `${rtShortDate(start)} – ${rtShortDate(now)}`;
  }

  const gridlines = [0, 25, 50, 75, 100]
    .map((p) => `<div class="rt-gridline" style="top: ${100 - p}%"></div>`)
    .join('');

  const bars = sorted
    .map((b) => {
      const value = metricOf(b);
      const h = Math.max(2, (value / niceMax) * 100);
      // The bar tooltip is plain text (rendered with content: attr()), so the
      // lines are joined with real newlines and shown via white-space: pre-line.
      const tooltip = tooltipLines(
        rtTooltipLabel(b.key),
        b.minutes,
        b.chars,
        null,
      ).join('\n');
      return `
        <div class="rt-bar-group">
          <div class="rt-bar" data-tooltip="${tooltip}" style="height: ${h}%"></div>
        </div>
      `;
    })
    .join('');

  const xLabels = sorted.map((b) => `<span>${b.label}</span>`).join('');

  const speed = totalMinutes > 0 ? totalChars / (totalMinutes / 60) : 0;

  body.innerHTML = `
    <div class="rt-caption">
      <span class="rt-range">${rangeLabel} Average</span>
      <span class="rt-delta">${deltaText}</span>
    </div>
    <div class="rt-big">${
      useChars
        ? `${rtFormatChars(avgMetric)} chars`
        : rtFormatDuration(avgMetric)
    }</div>
    <div class="rt-chart">
      <div class="rt-plot">
        <div class="rt-gridlines">${gridlines}</div>
        <div class="rt-avg-line" style="top: ${avgTop}%"><span class="rt-avg-label">avg</span></div>
        <span class="rt-y-label" style="top: 0%">${
          useChars ? rtFormatAxisChars(niceMax) : rtFormatAxis(niceMax)
        }</span>
        <span class="rt-y-label" style="top: 100%">0</span>
        <div class="rt-bars">${bars}</div>
      </div>
      <div class="rt-x-axis">${xLabels}</div>
    </div>
    <div class="rt-stats">
      <div class="rt-stat-row">
        <span class="rt-stat-label">Characters Read</span>
        <span class="rt-stat-value">${totalChars.toLocaleString()}</span>
      </div>
      <div class="rt-stat-row">
        <span class="rt-stat-label">Reading Speed</span>
        <span class="rt-stat-value">${formatSpeed(speed)}/h</span>
      </div>
      <div class="rt-stat-row">
        <span class="rt-stat-label">Total Time</span>
        <span class="rt-stat-value">${rtFormatDuration(totalMinutes)}</span>
      </div>
    </div>
  `;

  tabs.querySelectorAll('.rt-tab').forEach((el) => el.remove());
  for (const t of RT_TABS) {
    const tab = document.createElement('div');
    tab.className = 'rt-tab' + (t.key === rtActivePeriod ? ' active' : '');
    tab.dataset.key = t.key;
    tab.textContent = t.label;
    tabs.appendChild(tab);
  }
  const indicator = document.getElementById('rtTabIndicator');
  const activeTab = tabs.querySelector('.rt-tab.active');
  if (indicator && activeTab) {
    const tabsRect = tabs.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    indicator.style.left = `${tabRect.left - tabsRect.left + tabRect.width / 2 - 5}px`;
  }
}

// Card interactions: click a tab to switch, or scroll/drag the card to cycle
(function () {
  const card = document.getElementById('readingTimeCard');
  if (!card) return;

  function cycle(delta) {
    const idx = RT_TABS.findIndex((t) => t.key === rtActivePeriod);
    if (idx < 0) return;
    rtActivePeriod =
      RT_TABS[(idx + delta + RT_TABS.length) % RT_TABS.length].key;
    getData().then(renderReadingTime);
  }

  card.addEventListener('click', (e) => {
    const tab = e.target.closest('.rt-tab');
    if (!tab) return;
    const target = RT_TABS.find((t) => t.key === tab.dataset.key);
    if (target && target.key !== rtActivePeriod) {
      rtActivePeriod = target.key;
      getData().then(renderReadingTime);
    }
  });

  // The whole card is a valid scroll target, not just the chart, so the wheel
  // is captured here and the page scroll is suppressed.
  card.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      cycle(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );

  let dragStartY = null;
  card.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY;
  });
  card.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dy) >= 40) {
      cycle(dy > 0 ? 1 : -1);
      dragStartY = e.clientY;
    }
  });
  card.addEventListener('pointerup', () => {
    dragStartY = null;
  });
})();

// Activity map: scroll or drag the card to move between months,
// mirroring the reading time card's interactions.
(function () {
  const card = document.querySelector('.streak-panel');
  if (!card) return;

  let dragged = false;

  card.addEventListener('wheel', (e) => {
    e.preventDefault();
    changeMonth(e.deltaY > 0 ? 1 : -1);
  });

  let dragStartY = null;
  card.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY;
  });
  card.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dy) >= 40) {
      dragged = true;
      changeMonth(dy > 0 ? 1 : -1);
      dragStartY = e.clientY;
    }
  });
  card.addEventListener('pointerup', () => {
    dragStartY = null;
  });

  // A drag should not also open a day's session modal.
  card.addEventListener(
    'click',
    (e) => {
      if (dragged) {
        e.stopPropagation();
        dragged = false;
      }
    },
    true,
  );
})();

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
                                <span class="session-detail-label">Reading Speed</span>
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
                        <div class="day-summary-label">Reading Speed</div>
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
  await renderGoalCard(data);
  await renderRecentlyRead(data);
  await renderReadingTime(data);
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
  document.getElementById('goalUnitSelect').value =
    settings.goalUnit === 'characters' ? 'characters' : 'minutes';
  document.getElementById('goalValue').value = settings.goalValue || 60;
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
      goalUnit: document.getElementById('goalUnitSelect').value,
      goalValue: document.getElementById('goalValue').value,
    };
    const result = await window.electronAPI.saveSettings(data);
    if (result.success) {
      currentGoal = {
        unit: data.goalUnit === 'characters' ? 'characters' : 'minutes',
        value: Number(data.goalValue) > 0 ? Number(data.goalValue) : 60,
      };
      closeSettingsModal();
      showToast('Settings saved!');
      // Re-render everything so the goal card and the reading stats card both
      // pick up the new goal unit immediately.
      await updateAll();
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
