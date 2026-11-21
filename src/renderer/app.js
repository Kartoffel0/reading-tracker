// Theme management
const THEMES = [
  'theme-classic',
  'theme-rising-sun',
  'theme-wave',
  'theme-sakura-dark',
  'theme-sakura-light',
];
const THEME_NAMES = {
  'theme-classic': 'Red & White',
  'theme-rising-sun': 'Rising Sun',
  'theme-wave': 'Great Wave',
  'theme-sakura-dark': 'Sakura Dark',
  'theme-sakura-light': 'Sakura Light',
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

// Session-day boundary hour (persisted via settings): a session that ends
// after midnight but before this hour belongs to the previous calendar day, so
// the UI anchors its "today" on that previous day during those early hours.
// 0 disables the shift; mirrors parse_session_day_end_hour in sync_kindle.py.
const DEFAULT_SESSION_DAY_END_HOUR = 4;
let sessionDayEndHour = DEFAULT_SESSION_DAY_END_HOUR;

function parseSessionDayEndHour(value) {
  const hour = parseInt(String(value ?? '').trim().split(':')[0], 10);
  return hour >= 0 && hour <= 23 ? hour : DEFAULT_SESSION_DAY_END_HOUR;
}

// Load saved settings (theme, daily goal, session-day boundary) before the
// first render: the goal/reading-stats cards use the persisted goal unit, and
// every card's "today" anchor uses the persisted session-day boundary.
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
    sessionDayEndHour = parseSessionDayEndHour(settings.sessionDayEnd);
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
      start_at: row.start_at || null,
      end_at: row.end_at || null,
      // Clock strings are a display convenience derived from the timestamps; the
      // timestamps are the truth once a session crosses midnight.
      start_time: row.start_at ? row.start_at.slice(11, 16) : null,
      end_time: row.end_at ? row.end_at.slice(11, 16) : null,
      media: row.media || 'book',
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

// The session day the UI treats as "today", floored to local midnight: during
// the hours after midnight that precede the session-day boundary, that is the
// previous calendar day. Every card (date picker, activity map, goal card,
// reading stats) anchors its highlight, ranges and streaks on this, so the
// dates shown always match the day the sessions are filed under.
function sessionDayDate() {
  const day = new Date();
  if (sessionDayEndHour > 0 && day.getHours() < sessionDayEndHour) {
    day.setDate(day.getDate() - 1);
  }
  day.setHours(0, 0, 0, 0);
  return day;
}

function sessionDayKey() {
  return getDateKey(sessionDayDate());
}

// A session is recorded under the calendar day it ended on — that is what the
// date column holds and what the entries list shows. Statistics file it under
// the session day instead: anything ending before the session-day boundary
// belongs to the previous day (a session stopped at 00:48 counts for yesterday).
// Rows without a timestamp cannot be judged and stay where they are.
function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(year, month - 1, day);
  shifted.setDate(shifted.getDate() + days);
  return getDateKey(shifted);
}

function sessionDayForDate(dateKey, endAt) {
  const boundary = sessionDayEndHour * 60;
  if (boundary <= 0 || !dateKey) return dateKey;
  if (!endAt || endAt.length < 16) return dateKey;

  const endDate = endAt.slice(0, 10);
  const end = clockToMinutes(endAt.slice(11, 16));
  if (end === null || end >= boundary) return endDate;
  return shiftDateKey(endDate, -1);
}

// The same rows, keyed by session day. Every statistic reads this; the entries
// list and the book cards keep using the raw dates so a row shows the day it
// was actually recorded on.
async function getStatsData() {
  const raw = await getData();
  const byDay = {};
  for (const [dateKey, sessions] of Object.entries(raw)) {
    for (const session of sessions) {
      const dayKey = sessionDayForDate(dateKey, session.end_at);
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(session);
    }
  }
  return byDay;
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

// Points the date picker at a calendar day (not a session day) and repaints it.
function selectCalendarDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  dpSelectedDate = day;
  dpCurrentDate = new Date(day);
  updateDatePickerDisplay();
  renderDatePickerDays();
}

// The date picker opens on the current *calendar* day: with start/end times on
// every session, the day a session is filed under is derived at save time
// (sessionDayKeyFor), so the picker no longer has to lie about the date. The
// activity map still starts on the month the current session day belongs to.
// Called on startup once the settings are known, and again if the session-day
// boundary is changed.
function alignToSessionDay() {
  const today = sessionDayDate();
  currentMonth = today.getMonth();
  currentYear = today.getFullYear();

  const calendarDay = new Date();
  calendarDay.setHours(0, 0, 0, 0);
  selectCalendarDay(calendarDay);
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
  // The picker is about calendar days now, so its "today" ring marks the real
  // today; the session-day boundary only affects where stats file the row.
  const todayStr = getDateKey(new Date());
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
  // Settings load first: the persisted session-day boundary decides which day
  // the date picker and every card anchor their "today" on.
  await settingsReady;
  alignToSessionDay();
  await updateAll();
  // A stopwatch restored from settings must start ticking with the app, not
  // only after the first click.
  initClock();
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
  const mediaSelect = document.getElementById('sessionMedia');
  const startInput = document.getElementById('sessionStart');
  const endInput = document.getElementById('sessionEnd');
  const charsInput = document.getElementById('sessionCharacters');
  const durationInput = document.getElementById('sessionDuration');
  const unitSelect = document.getElementById('durationUnit');

  if (!dateKey) {
    showToast('Select a date');
    return;
  }

  const duration = durationValue();
  if (duration === null) {
    showToast('Enter valid duration');
    return;
  }

  // The picker holds the end day; the timestamps carry the wall clock, so a
  // session spanning midnight is recorded exactly instead of being guessed from
  // two bare times.
  const startTime = timeFieldValue('sessionStart');
  const endTime = timeFieldValue('sessionEnd');
  let startAt = null;
  let endAt = null;
  if (startTime && endTime) {
    endAt = `${dateKey}T${endTime}`;
    const startDate = startTime > endTime ? shiftDateKey(dateKey, -1) : dateKey;
    startAt = `${startDate}T${startTime}`;
  }

  const session = {
    id: Date.now(),
    date: dateKey,
    title: titleInput.value || 'Untitled',
    // Language is no longer asked for: this tracker is Japanese-only, and the
    // column stays because cover lookup and dedupe read it.
    language: 'Japanese',
    characters: parseInt(charsInput.value) || 0,
    duration: duration,
    unit: unitSelect.value,
    start_at: startAt,
    end_at: endAt,
    media: mediaSelect.value || 'book',
  };

  await saveSession(session);

  titleInput.value = '';
  charsInput.value = '';
  setDurationValue('', false);
  setTimeValue('sessionStart', '');
  setTimeValue('sessionEnd', '');
  unitSelect.value = 'minutes';

  await updateAll();
  showToast('✓ Session logged');
}

// ─── Title Suggestions ─────────────────────────────────────────────────────
// A panel below the TITLE field shows only while that field holds focus:
// empty it lists the three most recently read titles; once text is typed it
// lists existing titles containing that text, the exact match dropped. Rows
// are NOT a dropdown — the field stays a plain text input — but they are
// painted like the branded picker so the panel reads as its twin. Pressing
// a row fills the field with the exact title. The row binds mousedown, not
// click: clicking anywhere blurs this field BEFORE its own click event
// hit-tests the (now hidden) row, but a mousedown listener fires BEFORE
// that blur (observed order ["md","blur"]) — so blur may hide in sync.
let titleFieldFocused = false;
let renderedSignature = null;

function clearTitleSuggestions() {
  const box = document.getElementById('titleSuggestions');
  if (!box) return;
  box.querySelectorAll(':scope > .title-suggestion').forEach((node) => node.remove());
  box.classList.remove('active');
}

async function refreshTitleSuggestions() {
  if (!titleFieldFocused) {
    clearTitleSuggestions();
    renderedSignature = null;
    return;
  }
  const box = document.getElementById('titleSuggestions');
  const typed = document.getElementById('sessionTitle').value.trim();
  const data = await getData();

  // Latest session date per title; ISO date keys sort lexicographically.
  const latest = new Map();
  for (const [dateKey, sessions] of Object.entries(data)) {
    for (const session of sessions || []) {
      if (!session.title) continue;
      const seen = latest.get(session.title);
      if (!seen || seen < dateKey) latest.set(session.title, dateKey);
    }
  }

  let pool = [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1]));
  if (typed) {
    const needle = typed.toLowerCase();
    pool = pool.filter(
      (entry) => entry[0].toLowerCase().includes(needle) && entry[0] !== typed,
    );
  }
  const picks = pool.slice(0, 3).map(([title]) => title);

  // Never touch the DOM across the await: clearing before getData() would
  // repaint an EMPTY panel every keystroke — the flicker. So the swap is
  // synchronous (clear right here, rows right below) and a keystroke that
  // would not change the visible rows is skipped outright.
  const signature = picks.join('\u0000');
  if (signature === renderedSignature) {
    if (box.children.length) box.classList.add('active');
    return;
  }
  renderedSignature = signature;
  clearTitleSuggestions();
  for (const title of picks) {
    const row = document.createElement('div');
    row.className = 'title-suggestion';
    const text = document.createElement('span');
    text.className = 'title-suggestion-text';
    text.innerText = title;
    row.appendChild(text);
    row.addEventListener('mousedown', () => {
      document.getElementById('sessionTitle').value = title;
      void refreshTitleSuggestions();
    });
    box.appendChild(row);
  }
  if (box.children.length) box.classList.add('active');
  attachTitleMarquee(box);
}

document.getElementById('sessionTitle').addEventListener('input', () => {
  void refreshTitleSuggestions();
});
document.getElementById('sessionTitle').addEventListener('focus', () => {
  titleFieldFocused = true;
  void refreshTitleSuggestions();
});
document.getElementById('sessionTitle').addEventListener('blur', () => {
  titleFieldFocused = false;
  const box = document.getElementById('titleSuggestions');
  if (box) box.classList.remove('active');
});

// openModal keeps the day's session modal refreshed after a delete from the
// modal itself. The entries card passes false so deleting a line never pops a
// modal open.
async function deleteSession(dateKey, sessionId, openModal = true) {
  await removeSession(dateKey, sessionId);
  await updateAll();
  if (openModal) await openDaySessions(dateKey);
  showToast('Session deleted');
}

function calculateStreaks(data) {
  const dates = Object.keys(data).sort();
  if (dates.length === 0) return { current: 0, best: 0 };

  let currentStreak = 0;
  let checkDate = sessionDayDate();

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
  return getStatsData().then((stats) => {
    updateStats(stats);
    renderEntries();
    renderGoalCard(stats);
    getData().then(renderRecentlyRead);
    renderReadingTime(stats);
  });
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

  const today = sessionDayDate();
  if (!met.has(getDateKey(today))) {
    today.setDate(today.getDate() - 1);
  }

  // Walk the run backwards; the first key is its end, the last one its start.
  let current = 0;
  let currentStart = '';
  let currentEnd = '';
  while (met.has(getDateKey(today))) {
    if (!currentEnd) currentEnd = getDateKey(today);
    currentStart = getDateKey(today);
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
  let runStart = '';
  let longestStart = '';
  let longestEnd = '';
  let previousKey = null;

  for (const dateKey of metDates) {
    if (previousKey !== null && nextDayKey(previousKey) === dateKey) {
      runLength++;
    } else {
      runLength = 1;
      runStart = dateKey;
    }
    previousKey = dateKey;
    if (runLength > longest) {
      longest = runLength;
      longestStart = runStart;
      longestEnd = dateKey;
    }
  }

  const bestWeek = computeBestWeek(data, goalUnit);
  const fastest = computeFastestDay(data);

  return {
    current,
    currentStart,
    currentEnd,
    longest,
    longestStart,
    longestEnd,
    daysMet,
    // First and last day that reached the goal, for the tooltip range.
    daysMetFirst: metDates[0] || '',
    daysMetLast: metDates[metDates.length - 1] || '',
    bestValue,
    bestDate,
    bestWeek: bestWeek.value,
    bestWeekStart: bestWeek.key,
    bestWeekEnd: bestWeek.end,
    fastestDay: fastest.value,
    fastestDate: fastest.key,
  };
}

// Sums the goal metric per Monday-start week and returns the biggest.
function computeBestWeek(data, goalUnit) {
  const weeks = new Map();
  for (const [dateKey, sessions] of Object.entries(data)) {
    const value = dayGoalValue(sessions, goalUnit);
    if (value <= 0) continue;
    const day = new Date(dateKey + 'T00:00:00');
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    const weekKey = getDateKey(day);
    weeks.set(weekKey, (weeks.get(weekKey) || 0) + value);
  }
  let bestKey = '';
  let best = 0;
  for (const [key, value] of weeks.entries()) {
    if (value > best) {
      best = value;
      bestKey = key;
    }
  }
  // The Sunday that closes the winning week, for the tooltip range.
  const end = new Date(bestKey + 'T00:00:00');
  end.setDate(end.getDate() + 6);
  return { value: best, key: bestKey, end: bestKey ? getDateKey(end) : '' };
}

// Characters per hour on the fastest day that had any time in it.
function computeFastestDay(data) {
  let fastest = 0;
  let fastestKey = '';
  for (const [dateKey, sessions] of Object.entries(data)) {
    const chars = sessions.reduce((sum, s) => sum + (s.characters || 0), 0);
    const minutes = sessions.reduce((sum, s) => sum + sessionMinutes(s), 0);
    if (minutes <= 0 || chars <= 0) continue;
    const speed = chars / (minutes / 60);
    if (speed > fastest) {
      fastest = speed;
      fastestKey = dateKey;
    }
  }
  return { value: fastest, key: fastestKey };
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
  const todayKey = sessionDayKey();
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
  const bestWeekEl = document.getElementById('goalBestWeek');
  const bestWeekLabelEl = document.getElementById('goalBestWeekLabel');
  const fastestDayEl = document.getElementById('goalFastestDay');

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
  if (bestWeekEl) bestWeekEl.textContent = formatGoalValue(stats.bestWeek, goalUnit);
  if (bestWeekLabelEl) {
    bestWeekLabelEl.textContent =
      goalUnit === 'characters' ? 'BEST WEEK (CHARS)' : 'BEST WEEK (HRS)';
  }
  if (fastestDayEl) {
    fastestDayEl.textContent = `${Math.round(stats.fastestDay).toLocaleString()}/h`;
  }

  renderStatHints(stats, goalUnit);
  renderGoalCalendar(data);
}

// Each stat says which day (or week) its number came from. Hints are real
// .tooltip elements, so they inherit the shared look; the card clips its top
// edge, so the CSS anchors them below the stat.
function renderStatHints(stats, goalUnit) {
  const date = (key) => formatTooltipDate(key);
  const range = (start, end) =>
    start === end ? date(start) : `${date(start)} \u2192 ${date(end)}`;
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const value = (n) => formatGoalValue(n, goalUnit);
  const unit = goalUnit === 'characters' ? 'chars' : 'hrs';

  const hints = {
    goalStatStreak:
      stats.current > 0
        ? `${range(stats.currentStart, stats.currentEnd)} \u00b7 ${days(stats.current)}`
        : '',
    goalStatLongest:
      stats.longest > 0
        ? `${range(stats.longestStart, stats.longestEnd)} \u00b7 ${days(stats.longest)}`
        : '',
    goalStatDays:
      stats.daysMet > 0
        ? `${range(stats.daysMetFirst, stats.daysMetLast)} \u00b7 ${days(stats.daysMet)}`
        : '',
    goalStatBestDay: stats.bestDate
      ? `${date(stats.bestDate)} \u00b7 ${value(stats.bestValue)} ${unit}`
      : '',
    goalStatBestWeek: stats.bestWeekStart
      ? `${range(stats.bestWeekStart, stats.bestWeekEnd)} \u00b7 ${value(stats.bestWeek)} ${unit}`
      : '',
    goalStatFastest: stats.fastestDate
      ? `${date(stats.fastestDate)} \u00b7 ${Math.round(stats.fastestDay).toLocaleString()}/h`
      : '',
  };

  for (const [id, text] of Object.entries(hints)) {
    const stat = document.getElementById(id);
    if (!stat) continue;
    stat.querySelector('.tooltip')?.remove();
    if (!text) continue;
    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.textContent = text;
    stat.appendChild(tip);
  }
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
  const today = sessionDayDate();

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

  // The size variables live on the wrapper so the weekday rail inherits them
  // too; the grid reads them through inheritance.
  const gcBody = document.getElementById('goalCalendarBody') || cal;
  gcBody.style.setProperty('--gc-weeks', String(weeks));
  cal.dataset.weeks = String(weeks);

  // Cells grow to fill the strip when there are few weeks (GitHub shrinks them
  // the other way), capped so a short history does not look like a toy grid.
  const available = cal.clientWidth || 700;
  const gcGap = 3;
  const cellSize = Math.max(
    10,
    Math.min(18, Math.floor((available - (weeks - 1) * gcGap) / weeks)),
  );
  gcBody.style.setProperty('--gc-size', `${cellSize}px`);

  renderMonthRail(cal, data, start, weeks, cellSize);

  // One cell carries two readings: the fill is the amount read (relative to the
  // busiest day shown, in the goal's own unit), and a border marks a day that
  // met the goal. Only today gets a ring, so the three states never collide.
  const goalIsChars = goalUnit === 'characters';
  const intensityOf = (dateKey) => {
    const totals = dayTotals(data[dateKey]);
    return goalIsChars ? totals.chars : totals.minutes;
  };

  let maxIntensity = 0;
  for (let week = 0; week < weeks; week++) {
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + week * 7 + i);
      if (day > today) continue;
      maxIntensity = Math.max(maxIntensity, intensityOf(getDateKey(day)));
    }
  }

  const levelOf = (intensity) => {
    if (intensity <= 0 || maxIntensity <= 0) return 0;
    const share = intensity / maxIntensity;
    if (share <= 0.2) return 1;
    if (share <= 0.4) return 2;
    if (share <= 0.6) return 3;
    if (share <= 0.8) return 4;
    return 5;
  };

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

      cell.className = `gc-cell level-${levelOf(intensityOf(dateKey))}`;
      if (value >= goalValue && value > 0) cell.classList.add('gc-met');
      if (day.getTime() === today.getTime()) cell.classList.add('gc-today');

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

// Month rail: one label per calendar month, pinned to the week where the month
// starts, carrying the month's totals on hover (the tooltip the old activity
// map's month selector had). The labels live in the grid's top padding band and
// are positioned by hand, so they scroll with the strip.
const GC_COL_GAP = 4; // matches the gap declared on .goal-calendar
const MONTH_NAMES = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

function monthTotals(data, key) {
  let minutes = 0;
  let chars = 0;
  let sessions = 0;
  for (const [dateKey, list] of Object.entries(data)) {
    if (!dateKey.startsWith(key)) continue;
    for (const session of list || []) {
      minutes += sessionMinutes(session);
      chars += session.characters || 0;
      sessions++;
    }
  }
  return { minutes, chars, sessions };
}

function renderMonthRail(cal, data, start, weeks, cellSize) {
  const rail = document.createElement('div');
  rail.className = 'gc-months';
  // An extra implicit grid row under the seven weekday rows, spanning every
  // column: in flow it grows the strip by its own height, and inside the scroll
  // box it scrolls sideways with the cells.
  rail.style.gridRow = '8';
  rail.style.gridColumn = '1 / -1';

  // Weeks are grouped by the month their Monday falls in; the label sits on the
  // first week of that month, GitHub style.
  const months = [];
  let seen = '';
  for (let week = 0; week < weeks; week++) {
    const day = new Date(start);
    day.setDate(start.getDate() + week * 7);
    const key = getDateKey(day).slice(0, 7);
    if (key === seen) continue;
    seen = key;
    months.push({ key, week });
  }

  months.forEach(({ key, week }, index) => {
    // Too close to the previous label to be readable.
    if (index > 0 && week - months[index - 1].week < 3) return;

    const label = document.createElement('div');
    label.className = 'gc-month';
    label.textContent =
      `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
    label.style.left = `${week * (cellSize + GC_COL_GAP)}px`;

    const totals = monthTotals(data, key);
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.innerHTML = tooltipLines(
      `${key.slice(0, 4)} ${key.slice(5, 7)}`,
      totals.minutes,
      totals.chars,
      totals.sessions,
    ).join('<br>');
    label.appendChild(tooltip);
    label.addEventListener('mouseenter', () =>
      alignTooltip(cal, label, tooltip),
    );

    rail.appendChild(label);
  });

  cal.appendChild(rail);
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
    // A replaced cover usually lands on the exact same file path, so the
    // renderer's image cache would keep the previous bitmap for the
    // unchanged URL. The query string is ignored when resolving the file,
    // but makes the URL unique, forcing the <img> to reload from disk.
    coverCache.set(title, {
      status: 'manual',
      url: `${result.url}?v=${Date.now()}`,
    });
    showToast('✓ Cover added');
    renderRecentlyRead(await getData());
  } else if (!result?.canceled) {
    showToast(`Cover upload failed: ${result?.error || 'unknown error'}`);
  }
}

// `variant` picks the box the art goes in: the 68x90 chip the cards use, or the
// tall frame of the book sheet. Both keep the upload button in the same corner.
function coverMarkup(title, variant = 'row') {
  const cover = coverCache.get(title);
  const large = variant === 'large';
  // The upload button is shared by both branches: books that already have a
  // cover (found or manual) can replace it by picking a new image.
  const uploadBtn = `<button class="cover-upload-btn" data-cover-title="${escapeHtml(title)}" title="Upload a cover image" aria-label="Upload a cover image">+</button>`;
  if (cover?.url) {
    // The button lives inside the fixed box in both branches, pinned to its
    // bottom-left corner. That corner IS the cover's left edge for every aspect
    // ratio — only the right edge moves, so anchoring right would drift.
    return `
      <div class="${large ? 'book-cover-wrap' : 'recent-cover-wrap'}">
        <img class="${large ? 'book-cover-img' : 'recent-cover'}" src="${cover.url}" alt="${escapeHtml(title)} cover" />
        ${uploadBtn}
      </div>
    `;
  }
  const initial = escapeHtml((title.trim() || '?')[0]);
  return `
    <div class="${large ? 'book-cover-placeholder' : 'recent-cover-placeholder'}">
      <span class="cover-initial">${initial}</span>
      ${uploadBtn}
    </div>
  `;
}

// Shared by the recently-read and recent-entries cards AND the TITLE
// SUGGESTION PANEL: titles too long for one line scroll only while the
// row is hovered. The overflow is measured on hover, not at render time,
// because cover images load asynchronously and would otherwise make the
// title column look wider than it really is (so only the first row would
// ever qualify). Suggestion rows have no covers, but keeping the
// measurement at hover time is what lets them share this one code path.
// Titles scroll only while their row is hovered, and only when the text is
// actually wider than its column: the overflow is measured on hover, not at
// render time, because cover images load asynchronously and would otherwise
// make the title column look wider than it really is. The handler re-reads the
// text each time, so a row whose title gets rewritten (the book sheet reuses
// one node) stays in sync, and one row is only ever wired once.
const marqueeRows = new WeakSet();

function attachTitleMarquee(container) {
  for (const titleEl of container.querySelectorAll(
    '.recent-title, .entry-title, .title-suggestion, .book-title',
  )) {
    const row = titleEl.closest(
      '.recent-book, .entry-item, .title-suggestion, .book-card',
    );
    if (!row || marqueeRows.has(row)) continue;
    marqueeRows.add(row);

    row.addEventListener('mouseenter', () => {
      const inner = row.querySelector(
        '.book-title-text, .recent-title-text, .entry-title-text, .title-suggestion-text',
      );
      const column = inner?.parentElement;
      if (!inner || !column || inner.dataset.marqueeReady) return;

      const textWidth = inner.offsetWidth;
      const visibleWidth = column.offsetWidth;
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

// Same plumbing for every container that renders the shared card element: each
// cover chip gets the upload handler, so a cover-less row can be filled in from
// inside the row itself.
function attachCoverUploads(container) {
  for (const btn of container.querySelectorAll('.cover-upload-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      uploadCoverFor(btn.dataset.coverTitle);
    });
  }
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
      // Highlight the stat that matches the unit of the current goal.
      const goalIsChars = currentGoal.unit === 'characters';
      const charsClass = goalIsChars ? ' recent-stat-chars' : '';
      const timeClass = goalIsChars ? '' : ' recent-stat-time';
      return `
        <div class="recent-book" data-book-title="${escapeHtml(title)}">
          ${coverMarkup(title)}
          <div class="recent-info">
            <span class="recent-title"><span class="recent-title-text">${escapeHtml(title)}</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Characters Read</span> <span class="recent-stat-value${charsClass}">${entry.totalChars.toLocaleString()}</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Reading Speed</span> <span class="recent-stat-value">${Math.round(speed).toLocaleString()}/h</span></span>
            <span class="recent-stat"><span class="recent-stat-label">Total Time</span> <span class="recent-stat-value${timeClass}">${formatDuration(entry.totalMinutes)}</span></span>
          </div>
        </div>
      `;
    })
    .join('');

  attachCoverUploads(list);

  attachTitleMarquee(list);
}

// Reading time state
let rtActivePeriod = 'week';
let rtPeriodOffset = 0; // periods shifted back from the current one
// Set while a vertical drag is paging periods, so releasing it does not also
// open the bucket modal the pointer happens to be over.
let rtDragCycled = false;
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

// The TOTAL TIME stat reads in a single unit: minutes below the hour, whole
// hours above it, so a long period shows "48h" and never "48h 4m".
function rtFormatHoursOnly(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return total >= 60 ? `${Math.floor(total / 60)}h` : `${total}m`;
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

// Dense month charts would be unreadable with a label on every day, so only
// days 1, 5, 10, 15, 20, 25 and 30 get a tick label on the x-axis.
function rtMonthTickLabel(day) {
  return day === 1 || day % 5 === 0 ? String(day) : '';
}

// ---- Reading stats card ---------------------------------------------------
// Three pieces, in order of purity:
//   buildStatsModel({ dataByDate, period, offset, unit })  → plain object
//   buildStatsBody(model)                                  → detached node
//   renderReadingTime(data)                                → mounts it
// The book modal will call the first two with its own session map.

// The [start, end] range for a period. `offset` (0 = current) shifts back by
// whole periods: weeks by 7 days, months and years by calendar units. All
// dates are local so weekday alignment is safe.
function rtPeriodRange(period = rtActivePeriod, offset = rtPeriodOffset) {
  const now = sessionDayDate();
  if (period === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - now.getDay() - offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start, end };
  }
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    return { start, end };
  }
  if (period === 'year') {
    const start = new Date(now.getFullYear() - offset, 0, 1);
    const end = new Date(start.getFullYear(), 11, 31);
    return { start, end };
  }
  return { start: null, end: null };
}

// ---- Columns ---------------------------------------------------------------
// A chart draws one range as an ordered list of columns. The range decides how
// wide a column is: a week is seven days, a month is its own dates, a year is
// twelve months, all-time is one column per year. A book has no calendar to
// borrow, so it takes the widest column that still shows its shape.
const RT_DAY_MS = 86400000;

function rtGranularityOf(period) {
  if (period === 'week' || period === 'month') return 'day';
  if (period === 'year') return 'month';
  return 'year';
}

function rtBookGranularity(start, end) {
  const days = Math.round((end - start) / RT_DAY_MS) + 1;
  if (days <= 92) return 'day';
  if (days <= 1826) return 'month';
  return 'year';
}

// Every column carries what it needs to draw AND what it needs to be clicked:
// `key` groups sessions (a date key, a month key, a year), `label` is the axis
// tick, `tooltip` the date line the tooltip opens with, `scope` + `clickKey` the
// range its click-through opens.
function rtColumns(start, end, granularity) {
  const columns = [];
  if (granularity === 'day') {
    const days = Math.round((end - start) / RT_DAY_MS) + 1;
    // One calendar week keeps the weekday letters the W tab uses; a longer span
    // is labelled by day of month, and the tooltip carries the whole date.
    const weekLetters = days === 7 && start.getDay() === 0;
    const cursor = new Date(start);
    for (let i = 0; i < days; i++) {
      const key = getDateKey(cursor);
      columns.push({
        key,
        label: weekLetters
          ? 'SMTWTFS'[cursor.getDay()]
          : rtMonthTickLabel(cursor.getDate()),
        tooltip: formatTooltipDate(key),
        scope: 'day',
        clickKey: key,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return columns;
  }
  if (granularity === 'month') {
    // One year of months is the JFMA letters the Y tab already uses. A span
    // across years would repeat those letters, so each January carries its year
    // and the rest stay bare.
    const sameYear = start.getFullYear() === end.getFullYear();
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      const month = cursor.getMonth();
      const key = `${cursor.getFullYear()}-${String(month + 1).padStart(2, '0')}`;
      columns.push({
        key,
        label:
          sameYear || month !== 0
            ? 'JFMAMJJASOND'[month]
            : `J ${String(cursor.getFullYear()).slice(2)}`,
        tooltip: key.replace('-', ' '),
        scope: 'month',
        clickKey: key,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return columns;
  }
  for (let year = start.getFullYear(); year <= end.getFullYear(); year++) {
    columns.push({
      key: String(year),
      label: String(year),
      tooltip: String(year),
      scope: 'year',
      clickKey: String(year),
    });
  }
  return columns;
}

// Which column a date falls into. Only all-time needs this on its own: it has no
// range to enumerate, so its columns arrive with the data.
function rtColumnKeyFor(granularity, date) {
  if (granularity === 'day') return getDateKey(date);
  if (granularity === 'month')
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return String(date.getFullYear());
}

// chars/hour around one column. `half` is the rolling window: 0 reads the
// column itself, 1 averages it with its neighbours. Summing characters and
// minutes before dividing is the honest average of a rate (a mean of ratios
// would let a five-minute session weigh as much as a two-hour one).
// Only a column that was actually read gets a rate: a neighbour's minutes may
// fill the window, but quoting "2,430 chars/h" on a day with no sessions reads
// as a bug, and the trend only exists to show days that happened.
function rtSpeedAt(buckets, index, half) {
  if (!buckets[index] || buckets[index].minutes <= 0) return null;
  let chars = 0;
  let minutes = 0;
  for (let i = index - half; i <= index + half; i++) {
    const b = buckets[i];
    if (!b || b.minutes <= 0) continue;
    chars += b.chars;
    minutes += b.minutes;
  }
  return minutes > 0 ? chars / (minutes / 60) : null;
}

// `half` is the rolling window the caller picked for its column width, so a
// month does not turn into a spray of single-day dots.
function rtSpeedSeries(buckets, half) {
  const points = buckets.map((_, i) => rtSpeedAt(buckets, i, half));
  const values = points.filter((v) => v !== null);
  const peak = values.length ? Math.max(...values) : 0;
  const step = peak > 2000 ? 500 : 100;
  const niceMax = peak > 0 ? Math.ceil(peak / step) * step : 0;
  return { points, peak, niceMax, half, hasData: values.length > 0 };
}

// Uniform cubic B-spline through the points, emitted as cubic Beziers.
// It is C2-continuous (no corner at any bucket) and every Bezier control point
// is a convex combination of four neighbouring values, so the curve cannot
// overshoot the data the way an interpolating spline does. The first and last
// points are repeated so the curve still starts and ends on real readings.
function rtSmoothPath(points) {
  const first = points[0];
  const last = points[points.length - 1];
  const P = [first, first, ...points, last, last];
  const at = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  let d = '';
  for (let i = 1; i <= P.length - 3; i++) {
    const p0 = P[i - 1];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2];
    const b0 = {
      x: (p0.x + 4 * p1.x + p2.x) / 6,
      y: (p0.y + 4 * p1.y + p2.y) / 6,
    };
    const c1 = { x: (2 * p1.x + p2.x) / 3, y: (2 * p1.y + p2.y) / 3 };
    const c2 = { x: (p1.x + 2 * p2.x) / 3, y: (p1.y + 2 * p2.y) / 3 };
    const b3 = {
      x: (p1.x + 4 * p2.x + p3.x) / 6,
      y: (p1.y + 4 * p2.y + p3.y) / 6,
    };
    d += (i === 1 ? `M ${at(b0)}` : '') + ` C ${at(c1)} ${at(c2)} ${at(b3)}`;
  }
  return d;
}

// The axis gutter has to hold the widest label it will ever draw ("1,200,000"
// is nine characters), otherwise the text sits on top of the bars. The 0.55rem
// labels run ~5.2px per character.
function rtAxisGutter(label) {
  return `${Math.max(12, Math.ceil(label.length * 5.2) + 6)}px`;
}

function buildStatsModel({
  dataByDate,
  period,
  offset = 0,
  unit = 'minutes',
  range = null,
}) {
  const { start, end } = range || rtPeriodRange(period, offset);
  const useChars = unit === 'characters';
  // A book chart has nothing to step through: its columns span the book itself.
  const granularity =
    start === null
      ? 'year'
      : range
        ? rtBookGranularity(start, end)
        : rtGranularityOf(period);
  const startKey = start === null ? null : getDateKey(start);
  const endKey = end === null ? null : getDateKey(end);

  // The period before this one, for the delta line. A book has no previous
  // book to compare against, so a range never asks for one.
  let prevStart = null;
  let prevEnd = null;
  if (start !== null && !range) {
    prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    if (period === 'week') {
      prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 7);
    } else if (period === 'month') {
      prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
    } else {
      prevStart = new Date(start.getFullYear() - 1, 0, 1);
    }
  }
  const prevStartKey = prevStart === null ? null : getDateKey(prevStart);
  const prevEndKey = prevEnd === null ? null : getDateKey(prevEnd);

  // Every column of the range exists before any data lands, so a day nobody read
  // still holds its place on the axis. All-time has no range to enumerate and
  // grows its columns from the data.
  const byKey = new Map();
  if (start !== null) {
    for (const column of rtColumns(start, end, granularity)) {
      byKey.set(column.key, { ...column, minutes: 0, chars: 0, sessions: 0 });
    }
  }

  let totalMinutes = 0;
  let totalChars = 0;
  let totalSessions = 0;
  let prevMetric = 0;

  for (const [dateKey, sessions] of Object.entries(dataByDate)) {
    if (!Array.isArray(sessions)) continue;
    if (startKey === null || (dateKey >= startKey && dateKey <= endKey)) {
      const key = rtColumnKeyFor(granularity, new Date(dateKey + 'T00:00:00'));
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: key,
          tooltip: key.replace(/-/g, ' '),
          scope: 'year',
          clickKey: key,
          minutes: 0,
          chars: 0,
          sessions: 0,
        };
        byKey.set(key, bucket);
      }
      for (const s of sessions) {
        const minutes = sessionMinutes(s);
        const chars = s.characters || 0;
        bucket.minutes += minutes;
        bucket.chars += chars;
        bucket.sessions += 1;
        totalMinutes += minutes;
        totalChars += chars;
      }
      totalSessions += sessions.length;
    } else if (
      prevStartKey !== null &&
      dateKey >= prevStartKey &&
      dateKey <= prevEndKey
    ) {
      for (const s of sessions) {
        prevMetric += useChars ? s.characters || 0 : sessionMinutes(s);
      }
    }
  }

  const sorted = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));

  const peakChars = sorted.reduce((m, b) => Math.max(m, b.chars), 0);
  const peakMinutes = sorted.reduce((m, b) => Math.max(m, b.minutes), 0);
  const niceChars = rtNiceCeilChars(peakChars);
  const niceMinutes = rtNiceCeil(peakMinutes);

  // Each series averages over the columns where it has something, the same way
  // the single-series chart did — an empty Sunday should not drag the mean.
  const avgOf = (get) => {
    const withValue = sorted.filter((b) => get(b) > 0);
    return withValue.length
      ? withValue.reduce((sum, b) => sum + get(b), 0) / withValue.length
      : 0;
  };
  const avgChars = avgOf((b) => b.chars);
  const avgMinutes = avgOf((b) => b.minutes);

  const totalMetric = useChars ? totalChars : totalMinutes;
  let deltaText = '';
  if (prevStartKey !== null && prevMetric > 0) {
    const periodWord = RT_TABS.find((t) => t.key === period)?.word || 'period';
    const pct = Math.round(((totalMetric - prevMetric) / prevMetric) * 100);
    deltaText = `${pct >= 0 ? '↗' : '↘'} ${Math.abs(pct)}% from previous ${periodWord}`;
  }

  const todayKey = sessionDayKey();
  const todayInRange =
    startKey === null || (startKey <= todayKey && todayKey <= endKey);

  // The rate line widens its window with the column width: a daily column reads
  // itself across a week, a rolling week across a long daily span, a rolling
  // quarter on monthly columns.
  const speedHalf = range
    ? sorted.length > 21
      ? 3
      : 0
    : period === 'week'
      ? 0
      : period === 'month'
        ? 3
        : period === 'year'
          ? 1
          : 0;

  return {
    period,
    granularity,
    useChars,
    start,
    sorted,
    // Charts past twenty columns need a tighter gap to fit the card.
    dense: sorted.length > 20,
    // Only a calendar period has older and newer to step to.
    steppers: !range,
    // When the chart belongs to one book, its click-through must stay in it.
    scopedTitle: range?.scopedTitle || null,
    totalMinutes,
    totalChars,
    totalSessions,
    niceChars,
    niceMinutes,
    avgChars,
    avgMinutes,
    avgMetric: useChars ? avgChars : avgMinutes,
    deltaText,
    rangeLabel:
      start === null ? 'All time' : `${rtShortDate(start)} – ${rtShortDate(end)}`,
    todayBucketKey: todayInRange
      ? rtColumnKeyFor(granularity, sessionDayDate())
      : null,
    speed: rtSpeedSeries(sorted, speedHalf),
  };
}

// Pure DOM: builds the card body from a model and returns the detached node.
// @see attachStatsBody for the step buttons and the tooltip edge alignment.
function buildStatsBody(model) {
  const root = document.createElement('div');
  root.className = 'rt-body';

  const {
    period,
    granularity,
    useChars,
    start,
    sorted,
    dense,
    steppers,
    scopedTitle,
    totalMinutes,
    totalChars,
    totalSessions,
    niceChars,
    niceMinutes,
    avgChars,
    avgMinutes,
    avgMetric,
    deltaText,
    rangeLabel,
    todayBucketKey,
    speed,
  } = model;

  const topOf = (value, nice) => (nice > 0 ? 100 - (value / nice) * 100 : 100);
  // A column with nothing in it draws nothing: thirty empty days should not
  // read as thirty tiny bars along the baseline.
  const heightOf = (value, nice) =>
    value > 0 && nice > 0 ? Math.max(2, (value / nice) * 100) : 0;

  const bars = sorted
    .map((b, i) => {
      const lines = tooltipLines(b.tooltip, b.minutes, b.chars, b.sessions);
      const rate = speed.points[i];
      if (rate !== null) lines.push(`${formatSpeed(rate)} chars/h`);
      const today = b.key === todayBucketKey ? ' today' : '';
      const charsHeight = heightOf(b.chars, niceChars);
      const timeHeight = heightOf(b.minutes, niceMinutes);
      // The tooltip rides just above the taller bar. A tall column cannot do
      // that without climbing over the legend, so it drops into the plot's top
      // band instead — it must never leave the card.
      const tall = Math.max(charsHeight, timeHeight);
      const tipClass = tall > 72 ? ' rt-tip-down' : '';
      return `
        <div class="rt-bar-pair${tipClass}" data-tooltip="${lines.join('\n')}" style="--tip-y: ${tall.toFixed(1)}%" data-scope="${b.scope}" data-key="${b.clickKey}" data-label="${b.tooltip}" title="Open these sessions">
          <div class="rt-bar rt-bar-chars${today}" style="height: ${charsHeight}%"></div>
          <div class="rt-bar rt-bar-time${today}" style="height: ${timeHeight}%"></div>
        </div>
      `;
    })
    .join('');

  // One polyline per run of columns that actually have a rate: a gap in the
  // data is a gap in the line, never a straight interpolation across it.
  // One curve from the first reading day to the last, connected across empty
  // stretches. Only days that were read contribute a point, so no value is
  // invented for a day with no sessions — the curve simply passes over it, and
  // the monotone spline keeps it from diving through the bars on the way.
  const speedLine = (() => {
    if (!speed.hasData) return '';
    const points = [];
    speed.points.forEach((value, i) => {
      if (value === null) return;
      points.push({
        x: ((i + 0.5) / sorted.length) * 100,
        y: 100 - (value / speed.niceMax) * 100,
      });
    });
    // A lone reading day has no segment to curve through: a zero-length path
    // with a round cap is a dot.
    if (points.length === 1) {
      const p = points[0];
      return `<path class="rt-trend-dot" d="M ${p.x.toFixed(2)} ${p.y.toFixed(2)} l 0 0" vector-effect="non-scaling-stroke" />`;
    }
    return `<path class="rt-trend-line" d="${rtSmoothPath(points)}" vector-effect="non-scaling-stroke" />`;
  })();

  const gridlines = [0, 25, 50, 75, 100]
    .map((p) => `<div class="rt-gridline" style="top: ${p}%"></div>`)
    .join('');

  // An average sitting on the top gridline (one column of data does that) would
  // write its label straight over the axis label, so it flips below the line.
  const avgLine = (value, nice, cls) => {
    if (value <= 0) return '';
    const top = topOf(value, nice);
    const flip = top < 8 ? ' rt-avg-label-low' : '';
    return `<div class="rt-avg-line ${cls}" style="top: ${top}%"><span class="rt-avg-label${flip}">avg</span></div>`;
  };
  const avgLines = avgLine(avgChars, niceChars, 'rt-avg-chars') + avgLine(avgMinutes, niceMinutes, 'rt-avg-time');

  const xLabels = sorted.map((b) => `<span>${b.label}</span>`).join('');
  const speedValue =
    totalMinutes > 0 ? formatSpeed(totalChars / (totalMinutes / 60)) : '0';

  root.innerHTML = `
    <div class="rt-chart" style="--rt-gutter-left: ${rtAxisGutter(rtFormatAxisChars(niceChars))}; --rt-gutter-right: ${rtAxisGutter(rtFormatAxis(niceMinutes))}">
      <div class="rt-legend">
        <span class="rt-legend-key rt-legend-chars">CHARACTERS</span>
        <span class="rt-legend-key rt-legend-time">TIME</span>
        ${speed.hasData ? '<span class="rt-legend-key rt-legend-speed">SPEED</span>' : ''}
      </div>
      <div class="rt-plot">
        <div class="rt-gridlines">${gridlines}</div>
        ${avgLines}
        <span class="rt-y-label rt-y-left" style="top: 0%">${rtFormatAxisChars(niceChars)}</span>
        <span class="rt-y-label rt-y-left" style="top: 100%">0</span>
        <span class="rt-y-label rt-y-right" style="top: 0%">${rtFormatAxis(niceMinutes)}</span>
        <span class="rt-y-label rt-y-right" style="top: 100%">0</span>
        <div class="rt-bars"${dense ? ' data-dense' : ''}>${bars}</div>
        <svg class="rt-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${speedLine}</svg>
      </div>
      <div class="rt-x-axis"${dense ? ' data-dense' : ''}>${xLabels}</div>
    </div>
    <div class="rt-footer">
      <div class="rt-summary">
        <div class="rt-caption">
          <span class="rt-range">${rangeLabel} Average</span>
          ${
            steppers
              ? `<div class="rt-period-step">
            <button type="button" class="rt-step" data-step="-1" title="Older period">‹</button>
            <button type="button" class="rt-step" data-step="1" title="Newer period">›</button>
          </div>`
              : ''
          }
        </div>
        <div class="rt-headline">
          <span class="rt-big">${
            useChars ? `${rtFormatChars(avgMetric)} chars` : rtFormatDuration(avgMetric)
          }</span>
          <span class="rt-delta">${deltaText}</span>
        </div>
      </div>
      <div class="rt-stats">
        <div class="rt-stat-col" data-series="sessions">
          <span class="rt-stat-label">SESSIONS</span>
          <span class="rt-stat-value rt-stat-sessions-value">${totalSessions}</span>
        </div>
        <div class="rt-stat-col" data-series="chars">
          <span class="rt-stat-label">CHARACTERS READ</span>
          <span class="rt-stat-value">${totalChars.toLocaleString()}</span>
        </div>
        <div class="rt-stat-col" data-series="time">
          <span class="rt-stat-label">TOTAL TIME</span>
          <span class="rt-stat-value rt-stat-time-value">${rtFormatHoursOnly(totalMinutes)}</span>
        </div>
        <div class="rt-stat-col" data-series="speed">
          <span class="rt-stat-label">READING SPEED</span>
          <span class="rt-stat-value">${speedValue}/h</span>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('.rt-step').forEach((btn) => {
    btn.addEventListener('click', () =>
      shiftReadingPeriod(Number(btn.dataset.step)),
    );
  });

  // Clicking a column opens the sessions behind it, in the same modal the goal
  // calendar cells use.
  root.querySelector('.rt-bars').addEventListener('click', (event) => {
    if (rtDragCycled) return;
    const pair = event.target.closest('.rt-bar-pair');
    if (!pair) return;
    openStatsBucket(
      pair.dataset.scope,
      pair.dataset.key,
      pair.dataset.label,
      scopedTitle,
    );
  });

  return root;
}

async function renderReadingTime(data) {
  const body = document.getElementById('readingTimeBody');
  if (!body) return;

  body.replaceChildren(
    buildStatsBody(
      buildStatsModel({
        dataByDate: data,
        period: rtActivePeriod,
        offset: rtPeriodOffset,
        unit: currentGoal.unit,
      }),
    ),
  );

  const tabs = document.getElementById('readingTimeTabs');
  if (!tabs) return;
  tabs.querySelectorAll('.rt-tab').forEach((el) => el.remove());
  for (const t of RT_TABS) {
    const tab = document.createElement('div');
    tab.className = 'rt-tab' + (t.key === rtActivePeriod ? ' active' : '');
    tab.dataset.key = t.key;
    tab.textContent = t.label;
    tabs.appendChild(tab);
  }
}

// Card interactions: click a tab to switch, or scroll/drag the card to cycle
// ‹ › buttons shift the displayed period by one (older = positive offset).
// The future is the default view, so the offset never goes negative.
function shiftReadingPeriod(direction) {
  const next = Math.max(0, rtPeriodOffset - direction);
  if (next === rtPeriodOffset) return;
  rtPeriodOffset = next;
  getStatsData().then(renderReadingTime);
}

(function () {
  const card = document.getElementById('readingTimeCard');
  if (!card) return;

  function cycle(delta) {
    const idx = RT_TABS.findIndex((t) => t.key === rtActivePeriod);
    if (idx < 0) return;
    rtActivePeriod =
      RT_TABS[(idx + delta + RT_TABS.length) % RT_TABS.length].key;
    rtPeriodOffset = 0;
    getStatsData().then(renderReadingTime);
  }

  card.addEventListener('click', (e) => {
    const tab = e.target.closest('.rt-tab');
    if (!tab) return;
    const target = RT_TABS.find((t) => t.key === tab.dataset.key);
    if (target && target.key !== rtActivePeriod) {
      rtActivePeriod = target.key;
      rtPeriodOffset = 0;
      getStatsData().then(renderReadingTime);
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
    rtDragCycled = false;
  });
  card.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dy) >= 40) {
      rtDragCycled = true;
      cycle(dy > 0 ? 1 : -1);
      dragStartY = e.clientY;
    }
  });
  card.addEventListener('pointerup', () => {
    dragStartY = null;
  });
})();

// Lists the sessions behind a date or a span of dates. The goal calendar
// passes one day; the stats card passes every key inside the clicked column,
// which is a month or a year when the card is on Y / A.
async function openSessionsFor(title, dateKeys, preloaded, scopedTitle = null) {
  const data = preloaded || (await getStatsData());
  const entries = [];
  for (const dateKey of dateKeys) {
    const list = data[dateKey];
    if (!Array.isArray(list)) continue;
    for (const session of list) {
      if (scopedTitle && session.title !== scopedTitle) continue;
      entries.push({ dateKey, session });
    }
  }
  // Newest first, the order the entries card uses.
  entries.sort(
    (a, b) =>
      b.dateKey.localeCompare(a.dateKey) ||
      (b.session.id || 0) - (a.session.id || 0),
  );

  const modal = document.getElementById('modalOverlay');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const footerSummary = document.getElementById('modalFooterSummaryDiv');

  modalTitle.textContent = title;

  if (entries.length === 0) {
    modalBody.innerHTML =
      '<div class="empty-state">No sessions recorded for this period.</div>';
    footerSummary.innerHTML = '';
    modal.classList.add('active');
    return;
  }

  // Covers are resolved by the same helper the Recently Read card uses, so the
  // modal rows show the cover art the card already has for that title.
  await ensureCovers(
    entries.map(({ session }) => ({
      title: session.title || 'Untitled',
      language: session.language,
    })),
  );

  let totalMinutes = 0;
  let totalChars = 0;

  const sessionsHtml = entries
    .map(({ dateKey, session }) => {
      const title = session.title || 'Untitled';
      // Calculate reading speed for this session (characters per hour)
      const durationHours =
        session.unit === 'minutes' ? session.duration / 60 : session.duration;
      const speed =
        durationHours > 0
          ? Math.round((session.characters || 0) / durationHours)
          : 0;
      // Same goal-unit highlight the Recently Read card uses: the session stat
      // that matches the current goal's unit is the one drawn in accent.
      const goalIsChars = currentGoal.unit === 'characters';
      const charsClass = goalIsChars ? ' recent-stat-chars' : '';
      const timeClass = goalIsChars ? '' : ' recent-stat-time';

      // start_at / end_at are ISO timestamps ("2026-11-21T03:17"); rows from
      // before Phase 1 carry none and keep an em dash so the column stays put.
      const clockOf = (iso) =>
        iso && iso.length >= 16
          ? `${iso.slice(0, 10).replaceAll('-', ' ')} ${iso.slice(11, 16)}`
          : '—';
      const startLabel = clockOf(session.start_at);
      const endLabel = clockOf(session.end_at);

      const durationDisplay =
        session.unit === 'minutes'
          ? `${session.duration}m`
          : `${session.duration}h`;
      totalMinutes +=
        session.unit === 'minutes' ? session.duration : session.duration * 60;
      totalChars += session.characters || 0;

      return `
                    <div class="recent-book session-row" data-book-title="${escapeHtml(title)}">
                        ${coverMarkup(title)}
                        <div class="recent-info">
                            <span class="session-title-row">
                                <span class="recent-title"><span class="recent-title-text">${escapeHtml(title)}</span></span>
                                <span class="session-badge session-date-badge">${dateKey.replaceAll('-', ' ')}</span>
                                <button class="entry-del-btn" onclick="deleteSession('${dateKey}', ${session.id})">✖</button>
                            </span>
                            <div class="session-meta">
                                <div class="session-meta-col">
                                    <span class="recent-stat"><span class="recent-stat-label">Start Date</span><span class="recent-stat-value">${startLabel}</span></span>
                                    <span class="recent-stat"><span class="recent-stat-label">End Date</span><span class="recent-stat-value">${endLabel}</span></span>
                                </div>
                                <div class="session-meta-col">
                                    <span class="recent-stat"><span class="recent-stat-label">Duration</span><span class="recent-stat-value${timeClass}">${durationDisplay}</span></span>
                                    <span class="recent-stat"><span class="recent-stat-label">Characters</span><span class="recent-stat-value${charsClass}">${(session.characters || 0).toLocaleString()}</span></span>
                                    <span class="recent-stat"><span class="recent-stat-label">Reading Speed</span><span class="recent-stat-value">${speed.toLocaleString().replace(/\s/g, '')}/h</span></span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
    })
    .join('');

  const totalHours = (totalMinutes / 60).toFixed(1);

  // Calculate average reading speed (total characters / total hours)
  const totalHoursSession = totalMinutes / 60;
  const avgSpeed =
    totalHoursSession > 0 ? Math.round(totalChars / totalHoursSession) : 0;
  const avgSpeedDisplay =
    avgSpeed >= 1000 ? `${(avgSpeed / 1000).toFixed(1)}k` : `${avgSpeed}`;

  // Same treatment as the entry stats and the card stats: the one stat whose
  // unit matches the current goal is the only one that keeps the accent.
  const goalIsChars = currentGoal.unit === 'characters';
  const timeClass = goalIsChars ? '' : ' day-summary-highlight';
  const charsClass = goalIsChars ? ' day-summary-highlight' : '';

  const summaryHtml = `
                <div class="day-summary">
                    <div class="day-summary-item">
                        <div class="day-summary-value">${entries.length}</div>
                        <div class="day-summary-label">Sessions</div>
                    </div>
                    <div class="day-summary-item${timeClass}">
                        <div class="day-summary-value">${totalHours}h</div>
                        <div class="day-summary-label">Total Time</div>
                    </div>
                    <div class="day-summary-item${charsClass}">
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

  attachTitleMarquee(modalBody);
  attachCoverUploads(modalBody);

  modal.classList.add('active');
}

// A calendar cell is a single day.
async function openDaySessions(dateKey) {
  await openSessionsFor(`Sessions - ${dateKey.replaceAll('-', ' ')}`, [dateKey]);
}

// A stats column is a whole bucket: one day on W / M, a month on the year tab,
// a year on all-time.
// `scopedTitle` keeps a book's chart inside its own book: the same day holds
// other books' sessions, and showing those would answer a question nobody asked.
async function openStatsBucket(scope, dataKey, label, scopedTitle = null) {
  // A scoped chart lives inside the book sheet, which is later in the DOM and
  // would paint over the session modal this click opens.
  if (scopedTitle) closeBookModal();
  if (scope === 'day') {
    await openSessionsFor(`Sessions - ${label}`, [dataKey], null, scopedTitle);
    return;
  }
  const data = await getStatsData();
  const keys = Object.keys(data).filter((key) => key.startsWith(dataKey));
  await openSessionsFor(`Sessions - ${label}`, keys, data, scopedTitle);
}

// ===== Book sheet ==========================================================
// One book, end to end: cover and credits on the left, its whole reading
// history on the right. Unlike the dashboard's stats card this one has no tabs
// and no steppers — a book has a first day and a last day, and the chart spans
// exactly that, in day columns for a normal read-through and months or years
// for a long one.
const BOOK_STATUSES = ['reading', 'read', 'dropped'];

function closeBookModal(event) {
  if (!event || event.target.id === 'bookModalOverlay') {
    document.getElementById('bookModalOverlay').classList.remove('active');
  }
}

async function openBookModal(title) {
  const [statsByDay, raw] = await Promise.all([getStatsData(), getData()]);

  // Stats read the session day (a session stopped after midnight counts for the
  // day before); the entries read the day it was recorded under. Both are used.
  const stats = {};
  for (const [dayKey, sessions] of Object.entries(statsByDay)) {
    const mine = sessions.filter((s) => s.title === title);
    if (mine.length) stats[dayKey] = mine;
  }
  const entries = [];
  for (const [dateKey, sessions] of Object.entries(raw)) {
    for (const s of sessions) {
      if (s.title === title) entries.push({ dateKey, session: s });
    }
  }
  entries.sort(
    (a, b) =>
      b.dateKey.localeCompare(a.dateKey) ||
      (b.session.id || 0) - (a.session.id || 0),
  );

  const dayKeys = Object.keys(stats).sort();
  const first = dayKeys[0] || null;
  const last = dayKeys[dayKeys.length - 1] || null;

  document.getElementById('bookTitleText').textContent = title;
  document.getElementById('bookModalHeader').textContent = `DETAILS - ${title}`;
  document.getElementById('bookSpan').textContent = first
    ? `${first.replaceAll('-', ' ')} — ${last.replaceAll('-', ' ')}`
    : 'Not started';
  document.getElementById('bookEntryCount').textContent =
    `${entries.length} session${entries.length === 1 ? '' : 's'}`;
  document.getElementById('bookStatus').dataset.title = title;

  // Cover art comes from the same cache the cards use, in the sheet's frame.
  await ensureCovers([{ title, language: entries[0]?.session.language }]);
  const slot = document.getElementById('bookCoverSlot');
  slot.innerHTML = coverMarkup(title, 'large');
  attachCoverUploads(slot);

  // Credits and status are the only columns a human can fill in; everything
  // else on the row is derived from sessions.
  const book = (await window.electronAPI.getBook(title)) || {
    title,
    status: 'reading',
  };
  setBookCredits(book);
  setBookStatus(book.status);

  const body = document.getElementById('bookStatsBody');
  if (first) {
    body.replaceChildren(
      buildStatsBody(
        buildStatsModel({
          dataByDate: stats,
          period: 'book',
          unit: currentGoal.unit,
          range: {
            start: new Date(`${first}T00:00:00`),
            end: new Date(`${last}T00:00:00`),
            scopedTitle: title,
          },
        }),
      ),
    );
  } else {
    body.innerHTML =
      '<div class="empty-state"><p>No sessions recorded for this book.</p></div>';
  }

  // Every session this book has, newest first, with no cap.
  const list = document.getElementById('bookEntryList');
  list.innerHTML = entries.length
    ? entries
        .map((entry) =>
          entryRowHtml(
            entry,
            `deleteBookSession('${entry.dateKey}', ${entry.session.id})`,
          ),
        )
        .join('')
    : '<div class="empty-state"><p>No entries yet.</p></div>';
  attachTitleMarquee(list);
  attachTitleMarquee(document.querySelector('.book-card'));

  document.getElementById('bookModalOverlay').classList.add('active');
}

// Deleting from inside the sheet keeps the sheet open and refreshes it.
async function deleteBookSession(dateKey, sessionId) {
  await removeSession(dateKey, sessionId);
  await updateAll();
  const title = document.getElementById('bookStatus').dataset.title;
  if (title) await openBookModal(title);
  showToast('Session deleted');
}

function setBookStatus(status) {
  for (const btn of document.querySelectorAll('#bookStatus .book-status-btn')) {
    btn.classList.toggle('active', btn.dataset.status === status);
  }
}

function setBookCredits(book) {
  const fields = [
    ['author', 'bookAuthor', 'Add author'],
    ['series', 'bookSeries', 'Add series'],
  ];
  for (const [field, id, placeholder] of fields) {
    const node = document.getElementById(id);
    const value = (book[field] || '').trim();
    node.textContent = value || placeholder;
    node.classList.toggle('filled', Boolean(value));
  }
}

// Clicking a credit turns it into a one-line input; Enter or blur commits, Esc
// abandons. Neither field is ever derived from sessions, so typing here is the
// only way they get filled in.
function editBookCredit(field) {
  const node = document.getElementById(
    field === 'author' ? 'bookAuthor' : 'bookSeries',
  );
  if (node.querySelector('input')) return;
  const title = document.getElementById('bookStatus').dataset.title;
  if (!title) return;

  const current = node.classList.contains('filled') ? node.textContent : '';
  const input = document.createElement('input');
  input.className = 'book-credit-input';
  input.type = 'text';
  input.value = current;
  input.placeholder = field === 'author' ? 'Author' : 'Series';
  node.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    let book = null;
    if (commit && input.value.trim() !== current) {
      book = await window.electronAPI.updateBook(title, {
        [field]: input.value,
      });
    }
    setBookCredits(book || (await window.electronAPI.getBook(title)) || { title });
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// Wired once: the sheet's shell is static, only its contents are rewritten.
(function wireBookSheet() {
  const status = document.getElementById('bookStatus');
  if (!status) return;
  status.addEventListener('click', async (event) => {
    const btn = event.target.closest('.book-status-btn');
    if (!btn) return;
    const title = status.dataset.title;
    if (!title) return;
    const book = await window.electronAPI.updateBook(title, {
      status: btn.dataset.status,
    });
    if (book) setBookStatus(book.status);
  });
  // Author and series are spans with a button role, so they need the keyboard
  // to behave like one.
  for (const [id, field] of [
    ['bookAuthor', 'author'],
    ['bookSeries', 'series'],
  ]) {
    const node = document.getElementById(id);
    node.addEventListener('click', () => editBookCredit(field));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      editBookCredit(field);
    });
  }

  // Anything that names one book opens that book: a Recently Read row, a
  // session row in the day modal, or an entry in the dashboard's list. The book
  // sheet's own entries are excluded — a row there would open the sheet it is
  // already sitting in — and the delete / cover buttons stop at their own
  // handlers.
  //
  // Capture, because each modal's own wrapper carries an inline
  // `onclick="event.stopPropagation()"` so clicks inside it do not close it:
  // a bubble listener on document never sees a click made inside the session
  // modal.
  document.addEventListener(
    'click',
    (event) => {
      if (event.target.closest('.entry-del-btn, .cover-upload-btn')) return;
      const row = event.target.closest(
        '#recentlyReadList .recent-book, #modalBody .session-row, #entryList .entry-item',
      );
      if (!row) return;
      const title = row.dataset.bookTitle;
      if (title) openBookModal(title);
    },
    true,
  );
})();

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
  if (
    document.getElementById('bookModalOverlay')?.classList.contains('active')
  )
    return closeBookModal();
  if (document.getElementById('modalOverlay')?.classList.contains('active'))
    return closeModal();
  if (document.getElementById('syncModalOverlay')?.classList.contains('active'))
    return closeKindleSyncModal();
});

// One line per session, shared by the dashboard's entries list and the book
// sheet: date, clock range, title, then the three numbers. Sessions from before
// start/end times existed keep an em dash so the columns stay aligned.
function entryRowHtml({ dateKey, session }, deleteCall = null) {
  const title = session.title || 'Untitled';
  const minutes = Math.round(sessionMinutes(session));
  const chars = session.characters || 0;
  // Same speed math the session modal uses: chars per hour.
  const hours =
    session.unit === 'minutes' ? session.duration / 60 : session.duration;
  const speed = hours > 0 ? Math.round(chars / hours) : 0;

  // Highlight the stat that matches the unit of the current goal.
  const goalIsChars = currentGoal.unit === 'characters';
  const durationClass = goalIsChars ? '' : ' entry-highlight';
  const charsClass = goalIsChars ? ' entry-highlight' : '';

  const timeRange =
    session.start_time && session.end_time
      ? `${session.start_time}–${session.end_time}`
      : '—';

  return `
          <div class="entry-item" data-book-title="${escapeHtml(title)}">
            <span class="entry-date">${dateKey.replaceAll('-', ' ')}</span>
            <span class="entry-time">${timeRange}</span>
            <span class="entry-title"><span class="entry-title-text">${escapeHtml(title)}</span></span>
            <div class="entry-stats">
                <div class="entry-stat entry-duration${durationClass}"><span class="entry-stat-value">${minutes}</span><span class="entry-stat-unit">min</span></div>
                <div class="entry-stat entry-chars${charsClass}"><span class="entry-stat-value">${chars.toLocaleString()}</span><span class="entry-stat-unit">chr</span></div>
                <div class="entry-stat entry-speed"><span class="entry-stat-value">${speed.toLocaleString()}</span><span class="entry-stat-unit">/h</span></div>
            </div>
            <button class="entry-del-btn" onclick="${deleteCall || `deleteSession('${dateKey}', ${session.id}, false)`}">✖</button>
          </div>
        `;
}

async function renderEntries() {
  const data = await getData();
  const entryList = document.getElementById('entryList');

  // One line per session, newest first. The card lists sessions, not days.
  const sessions = [];
  for (const [dateKey, daySessions] of Object.entries(data)) {
    if (!Array.isArray(daySessions)) continue;
    for (const s of daySessions) {
      sessions.push({ dateKey, session: s });
    }
  }
  sessions.sort(
    (a, b) =>
      b.dateKey.localeCompare(a.dateKey) ||
      (b.session.id || 0) - (a.session.id || 0),
  );

  document.getElementById('entryCount').textContent =
    `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

  if (sessions.length === 0) {
    entryList.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">読</div><p>No entries yet. Start reading!</p></div>';
    return;
  }

  entryList.innerHTML = sessions
    .slice(0, 100)
    .map((entry) => entryRowHtml(entry))
    .join('');

  attachTitleMarquee(entryList);
}

async function updateAll() {
  const raw = await getData();
  const stats = await getStatsData();
  updateStats(stats);
  await renderEntries();
  await renderGoalCard(stats);
  await renderRecentlyRead(raw);
  await renderReadingTime(stats);
  await refreshTitleSuggestions();
}

// Changing the unit keeps the same real duration: 77 minutes → 1.28 hours.
// Works for a typed value and for a derived suggestion alike.
function updateDurationUnit() {
  const select = document.getElementById('durationUnit');
  const input = document.getElementById('sessionDuration');
  if (!select || !input) return;

  const raw = input.value || input.dataset.derived || '';
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return;

  const converted =
    select.value === 'hours'
      ? Math.round((value / 60) * 100) / 100
      : Math.round(value * 60);
  setDurationValue(converted, !input.value);
}

// ─── Session time fields ───────────────────────────────────────────────────
// Duration and start/end are one value shown twice: editing either updates the
// other. Programmatic writes never dispatch input events, so there is no loop.
function pad2(value) {
  return String(value).padStart(2, '0');
}

function clockToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// The derived time is shown through the field's own placeholder: the value stays
// empty until the user types, so a suggestion never looks like an entry.
function refreshTimeField(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.placeholder = input.dataset.derived || '--:--';
}

// What the field means: typed value, else the derived suggestion.
function timeFieldValue(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return '';
  return input.value || input.dataset.derived || '';
}

function setTimeValue(inputId, value, derived = false) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (derived) {
    input.value = '';
    input.dataset.derived = value;
  } else {
    input.value = value;
    delete input.dataset.derived;
  }
  refreshTimeField(inputId);
}

// Typing is free-form so nobody has to fight a mask; blur turns "935", "9:5"
// or "09.35" into 09:35, and anything impossible becomes empty.
function normalizeTimeText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';

  let hours;
  let minutes;
  if (text.includes(':')) {
    const [h = '', m = ''] = text.split(':');
    hours = Number(h) || 0;
    minutes = Number(m) || 0;
  } else if (digits.length <= 2) {
    hours = Number(digits);
    minutes = 0;
  } else {
    hours = Number(digits.slice(0, digits.length - 2));
    minutes = Number(digits.slice(-2));
  }

  if (hours > 23 || minutes > 59) return '';
  return `${pad2(hours)}:${pad2(minutes)}`;
}

// The duration mirrors the time fields: when it comes from start/end it is a
// suggestion (placeholder, muted) and the input stays empty until typed.
function setDurationValue(value, derived) {
  const input = document.getElementById('sessionDuration');
  if (!input) return;
  if (derived) {
    input.value = '';
    input.dataset.derived = String(value);
  } else {
    input.value = String(value ?? '');
    delete input.dataset.derived;
  }
  input.placeholder = input.dataset.derived || '0';
}

// The number the field currently means, in the selected unit.
function durationValue() {
  const input = document.getElementById('sessionDuration');
  const raw = input?.value || input?.dataset.derived || '';
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function durationInMinutes() {
  const value = durationValue();
  if (value === null) return null;
  const unit = document.getElementById('durationUnit')?.value;
  return Math.round(unit === 'hours' ? value * 60 : value);
}

// Duration typed → end is "now", start is now minus the duration.
function applyDurationToTimes() {
  const input = document.getElementById('sessionDuration');
  const typed = parseFloat(input?.value);
  if (!Number.isFinite(typed) || typed <= 0) {
    // Deleting the duration deletes the times: they only existed because of it.
    delete input?.dataset.derived;
    if (input) input.placeholder = '0';
    setTimeValue('sessionStart', '', false);
    setTimeValue('sessionEnd', '', false);
    return;
  }

  const unit = document.getElementById('durationUnit')?.value;
  const minutes = Math.round(unit === 'hours' ? typed * 60 : typed);
  const end = new Date();
  end.setSeconds(0, 0);
  const start = new Date(end.getTime() - minutes * 60000);
  setTimeValue('sessionStart', formatClock(start), true);
  setTimeValue('sessionEnd', formatClock(end), true);
}

// Start/end picked → duration follows. Crossing midnight counts forward.
function applyTimesToDuration() {
  const start = clockToMinutes(timeFieldValue('sessionStart'));
  const end = clockToMinutes(timeFieldValue('sessionEnd'));
  // Half a range is not a duration; clear it rather than leave a stale number.
  if (start === null || end === null) {
    setDurationValue('', false);
    return;
  }

  let minutes = end - start;
  if (minutes < 0) minutes += 24 * 60;
  const unit = document.getElementById('durationUnit')?.value;
  const value =
    unit === 'hours'
      ? Math.round((minutes / 60) * 100) / 100
      : minutes;
  setDurationValue(value, true);
}

// ─── Custom time picker ────────────────────────────────────────────────────
// The native panel is an unstylable browser widget (white sheet, blue
// selection), so the inputs keep the value while this panel does the picking.
function closeTimePanels() {
  for (const panel of document.querySelectorAll('.time-panel.active')) {
    panel.classList.remove('active');
  }
  for (const btn of document.querySelectorAll('.time-pick-btn')) {
    btn.setAttribute('aria-expanded', 'false');
  }
}

function buildTimePanel(input, panel) {
  const current = clockToMinutes(timeFieldValue(input.id));
  const hour = current === null ? null : Math.floor(current / 60);
  const minute = current === null ? null : current % 60;
  panel.dataset.hour = hour === null ? '' : String(hour);
  panel.dataset.minute = minute === null ? '' : String(minute);

  const hours = Array.from({ length: 24 }, (_, h) =>
    `<button type="button" class="time-cell${h === hour ? ' selected' : ''}" data-hour="${h}">${pad2(h)}</button>`,
  ).join('');
  const minutes = Array.from({ length: 60 }, (_, m) =>
    `<button type="button" class="time-cell${m === minute ? ' selected' : ''}" data-minute="${m}">${pad2(m)}</button>`,
  ).join('');

  panel.innerHTML = `
      <div class="time-panel-head"><span>HOUR</span><span>MIN</span></div>
      <div class="time-columns">
          <div class="time-col" data-col="hour">${hours}</div>
          <div class="time-col" data-col="minute">${minutes}</div>
      </div>`;
}

function toggleTimePanel(button) {
  const inputId = button.dataset.target;
  const panel = document.getElementById(`${inputId}Panel`);
  const input = document.getElementById(inputId);
  if (!panel || !input) return;

  const wasOpen = panel.classList.contains('active');
  closeTimePanels();
  if (wasOpen) return;

  buildTimePanel(input, panel);
  panel.classList.add('active');
  button.setAttribute('aria-expanded', 'true');

  // Bring the selected cells into view — 60 minutes otherwise start at 00.
  for (const cell of panel.querySelectorAll('.time-cell.selected')) {
    cell.scrollIntoView({ block: 'center' });
  }
}

function initSessionTimeFields() {
  const durationInput = document.getElementById('sessionDuration');
  const startInput = document.getElementById('sessionStart');
  const endInput = document.getElementById('sessionEnd');
  if (!durationInput || !startInput || !endInput) return;

  // Typing drops the derived suggestion before the link runs, or a stale
  // suggestion would keep painting after the user replaced it.
  durationInput.addEventListener('input', () => {
    delete durationInput.dataset.derived;
    durationInput.placeholder = '0';
    applyDurationToTimes();
  });

  // Typing drops the derived suggestion — the two must not fight over what the
  // field means. Only clock characters survive the keystroke.
  const onTimeInput = (event) => {
    const input = event.target;
    const cleaned = input.value.replace(/[^\d:]/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    // "0935" becomes "09:35" the moment the fourth digit lands.
    if (/^\d{4}$/.test(input.value)) input.value = normalizeTimeText(input.value);
    delete input.dataset.derived;
    refreshTimeField(input.id);
    applyTimesToDuration();
  };

  // Leaving the field tidies "935" into "09:35".
  const onTimeBlur = (event) => {
    const input = event.target;
    if (input.value) input.value = normalizeTimeText(input.value);
    refreshTimeField(input.id);
    applyTimesToDuration();
  };

  for (const input of [startInput, endInput]) {
    input.addEventListener('input', onTimeInput);
    input.addEventListener('blur', onTimeBlur);
    refreshTimeField(input.id);
  }

  for (const button of document.querySelectorAll('.time-pick-btn')) {
    button.addEventListener('click', () => toggleTimePanel(button));
  }

  for (const panel of document.querySelectorAll('.time-panel')) {
    panel.addEventListener('click', (event) => {
      const cell = event.target.closest('.time-cell');
      if (!cell) return;
      const column = cell.parentElement;
      if (column.dataset.col === 'hour') panel.dataset.hour = cell.dataset.hour;
      else panel.dataset.minute = cell.dataset.minute;

      for (const sibling of column.children) {
        sibling.classList.toggle('selected', sibling === cell);
      }

      const { hour, minute } = panel.dataset;
      if (hour !== '' && minute !== '') {
        setTimeValue(panel.id.replace('Panel', ''), `${pad2(hour)}:${pad2(minute)}`);
        applyTimesToDuration();
        closeTimePanels();
      }
    });
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.time-field')) closeTimePanels();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTimePanels();
  });
}

initSessionTimeFields();

// ─── Clock / stopwatch ─────────────────────────────────────────────────────
// Idle: the current time. Running: elapsed since Start. Stop hands the range to
// the log form, which infers the duration from it. The start moment lives in
// settings, so restarting the app mid-session does not lose it.
const STALE_STOPWATCH_MS = 12 * 60 * 60 * 1000;
let stopwatchStartedAt = null;
let clockInterval = null;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

function renderClock() {
  const card = document.querySelector('.clock-card');
  const timeEl = document.getElementById('clockTime');
  const captionEl = document.getElementById('clockCaption');
  const startBtn = document.getElementById('clockStartBtn');
  const stopBtn = document.getElementById('clockStopBtn');
  if (!card || !timeEl) return;

  const now = new Date();
  const running = stopwatchStartedAt !== null;
  card.classList.toggle('is-running', running);

  if (running) {
    timeEl.textContent = formatElapsed(now.getTime() - stopwatchStartedAt);
    captionEl.textContent = `since ${formatClock(new Date(stopwatchStartedAt))}`;
  } else {
    timeEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    captionEl.textContent = now.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  if (startBtn) startBtn.hidden = running;
  if (stopBtn) stopBtn.hidden = !running;
}

async function startStopwatch() {
  stopwatchStartedAt = Date.now();
  renderClock();
  await window.electronAPI.updateSettings('stopwatch', {
    startedAt: stopwatchStartedAt,
  });
}

async function stopStopwatch() {
  if (stopwatchStartedAt === null) return;
  const startedAt = stopwatchStartedAt;
  const endedAt = Date.now();
  stopwatchStartedAt = null;
  renderClock();
  await window.electronAPI.updateSettings('stopwatch', { startedAt: null });

  // Hand the range to the form; the duration follows as a suggestion. The date
  // stays on the day it was stopped — the boundary rule files the stats under
  // the previous day when the end time is before it.
  setTimeValue('sessionStart', formatClock(new Date(startedAt)));
  setTimeValue('sessionEnd', formatClock(new Date(endedAt)));
  applyTimesToDuration();
  showToast('Stopped — add title and characters');
}

async function initClock() {
  try {
    const settings = await window.electronAPI.getSettings();
    const started = Number(settings?.stopwatchStartedAt);
    stopwatchStartedAt = Number.isFinite(started) && started > 0 ? started : null;
    // A stopwatch left running for half a day is almost certainly forgetfulness,
    // and stopping it would log a session that never happened.
    if (stopwatchStartedAt && Date.now() - stopwatchStartedAt > STALE_STOPWATCH_MS) {
      stopwatchStartedAt = null;
      await window.electronAPI.updateSettings('stopwatch', { startedAt: null });
    }
  } catch {
    stopwatchStartedAt = null;
  }

  document.getElementById('clockStartBtn')?.addEventListener('click', startStopwatch);
  document.getElementById('clockStopBtn')?.addEventListener('click', stopStopwatch);
  renderClock();
  if (clockInterval === null) clockInterval = setInterval(renderClock, 1000);
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
    // Automatic snapshots live beside the app data; starting the picker there
    // keeps the newest one in reach.
    defaultPath: await window.electronAPI.getBackupsPath(),
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
  document.getElementById('sessionDayEndSelect').value =
    settings.sessionDayEnd || '04:00';
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
      sessionDayEnd: document.getElementById('sessionDayEndSelect').value,
      goalUnit: document.getElementById('goalUnitSelect').value,
      goalValue: document.getElementById('goalValue').value,
    };
    const result = await window.electronAPI.saveSettings(data);
    if (result.success) {
      currentGoal = {
        unit: data.goalUnit === 'characters' ? 'characters' : 'minutes',
        value: Number(data.goalValue) > 0 ? Number(data.goalValue) : 60,
      };
      const dayEnd = parseSessionDayEndHour(data.sessionDayEnd);
      if (dayEnd !== sessionDayEndHour) {
        sessionDayEndHour = dayEnd;
        alignToSessionDay();
      }
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
const syncModalForceBtn = document.getElementById('syncModalForceBtn');

let isSyncing = false;

function resetSyncButtons() {
  isSyncing = false;
  for (const btn of [syncModalStartBtn, syncModalForceBtn]) {
    btn?.removeAttribute('disabled');
  }
  syncModalStartBtn.textContent = 'Start Sync';
  syncModalForceBtn.textContent = 'Force Full Sync';
}

async function openKindleSyncModal() {
  if (isSyncing) return;
  syncModalOverlay?.classList.add('active');
  syncModalWaiting.classList.remove('hidden');
  syncModalStatus?.classList.add('hidden');
  syncModalStartBtn?.classList.remove('hidden');
  resetSyncButtons();
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

async function startKindleSync(force = false) {
  if (isSyncing) return;
  isSyncing = true;

  for (const btn of [syncModalStartBtn, syncModalForceBtn]) {
    btn?.setAttribute('disabled', '');
  }
  syncModalStartBtn.textContent = force ? 'Forcing...' : 'Syncing...';
  syncModalWaiting?.classList.add('hidden');
  clearSyncLog();
  addSyncLogMessage(
    force
      ? '⏳ Force full sync: ignoring cached sidecar times...'
      : '⏳ Initializing Kindle sync...',
    'status',
  );

  try {
    // Listen for status updates
    const statusUnsub = window.electronAPI?.onSyncStatus?.((data) => {
      addSyncLogMessage(data.message, 'status');
    });

    // Listen for completion
    const completeUnsub = window.electronAPI?.onSyncComplete?.((data) => {
      try {
        resetSyncButtons();

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
    await window.electronAPI?.triggerKindleSync?.({ force });
  } catch (err) {
    resetSyncButtons();
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
