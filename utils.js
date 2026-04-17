// ── BIS SWIM GALA — SHARED UTILITIES ─────────────────────────────
// Single source of truth: everything comes from Google Sheets.
// swim_data.js is NO LONGER USED and can be deleted.

const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmYIWdqxPUaboiigVBepi9hlC6QXJyo-mObZzrrAkiuN8dZcf71tl2i12fNb2X6bQHpEcIGRMsAgyy/pub?output=csv';
// Replace above with: File > Share > Publish to web > Sheet1 > CSV > copy URL

const POINTS_MAP = { 1: 5, 2: 3, 3: 1 };

// ── EVENT# SORT KEY ───────────────────────────────────────────────
// Event# is treated as a STRING throughout — never parsed as a number.
// This means '10A' inserted after '10' sorts correctly and never merges.
// Kids managing the sheet: to insert after event 10, name it '10A'.
// To insert two events after 10: '10A' and '10B'. Simple!
function eventSortKey(en) {
  const m = String(en).trim().match(/^(\d+)([A-Za-z]?)$/);
  if (m) return [parseInt(m[1]), (m[2] || '').toUpperCase()];
  return [9999, String(en)];
}

function sortEventNums(nums) {
  return [...new Set(nums)].sort((a, b) => {
    const ka = eventSortKey(a), kb = eventSortKey(b);
    return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1].localeCompare(kb[1]);
  });
}
function parseTime(t) {
  if (!t || t === '' || t === '-') return null;
  t = String(t).trim();
  if (t.toUpperCase() === 'DNS' || t.toUpperCase() === 'DQ') return null;
  if (t.includes(':')) {
    const parts = t.split(':');
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

function formatTime(sec) {
  if (sec === null || isNaN(sec)) return '—';
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }
  return sec.toFixed(2) + 's';
}

// ── DISPLAY HELPERS ───────────────────────────────────────────────
function houseBadge(house) {
  const h = house ? house.trim() : '';
  return `<span class="house-badge house-${h}">${h}</span>`;
}

function nameSpan(name, house) {
  const h = house ? house.trim() : '';
  return `<span class="name-${h}">${name}</span>`;
}

function posBadge(pos) {
  if (!pos || pos === '') return '';
  if (pos === 1) return `<span class="pos-badge pos-1">1</span>`;
  if (pos === 2) return `<span class="pos-badge pos-2">2</span>`;
  if (pos === 3) return `<span class="pos-badge pos-3">3</span>`;
  return ''; // 4th+ → no badge shown anywhere
}

// ── FETCH: NO CACHE, ALWAYS FRESH ────────────────────────────────
// Google's published-CSV endpoint has a server-side cache of ~1-5 min.
// We cannot fully bypass it, but we do everything possible:
//   1. Unique timestamp param on every request (busts browser cache)
//   2. fetch() with cache:'no-store' (tells browser not to cache)
//   3. We also add a random jitter so parallel tab fetches differ
// The remaining ~1-5 min delay is Google's CDN — nothing can bypass it
// except switching to a Google Apps Script web app (see setup guide).

async function fetchResults() {
  if (GOOGLE_SHEET_CSV_URL === 'YOUR_GOOGLE_SHEET_CSV_URL_HERE') {
    console.warn('Google Sheet not connected. No data to show.');
    return [];
  }
  try {
    const sep = GOOGLE_SHEET_CSV_URL.includes('?') ? '&' : '?';
    const jitter = Math.floor(Math.random() * 1000);
    const url = GOOGLE_SHEET_CSV_URL + sep + 'cb=' + Date.now() + '_' + jitter;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return parseCSV(text);
  } catch (e) {
    console.warn('Sheet fetch failed:', e.message);
    return [];
  }
}

// ── CSV PARSING ───────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length < 6) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (vals[idx] || '').trim().replace(/^"|"$/g, '');
    });
    if (row['ParticipantName'] && row['ParticipantName'].trim() !== '') {
      rows.push(row);
    }
  }
  return enrichResults(rows);
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// ── COMPLETED STATUS GATE ─────────────────────────────────────────
// Type COMPLETED in the EventStatus column (or Status column) for any
// one row in the event to mark the whole event as done.
// Until then: times show but no positions/points are awarded.
function isEventCompleted(eventRows) {
  return eventRows.some(r => {
    const a = (r['EventStatus'] || '').trim().toUpperCase();
    const b = (r['Status']      || '').trim().toUpperCase();
    return a === 'COMPLETED' || b === 'COMPLETED';
  });
}

// ── ENRICH: CALCULATE POSITIONS & POINTS ────────────────────────
function enrichResults(rows) {
  // Group by event number — exact string key, no parseInt
  const eventMap = {};
  for (const row of rows) {
    const en = (row['Event#'] || '').trim();
    if (!en) continue;
    if (!eventMap[en]) eventMap[en] = [];
    eventMap[en].push(row);
  }

  // Only rank completed events, across all heats combined
  const positionMap = {};
  for (const [en, eventRows] of Object.entries(eventMap)) {
    if (!isEventCompleted(eventRows)) continue;
    const timed = eventRows
      .filter(r => {
        const t  = parseTime(r['TimeSeconds']);
        const st = (r['Status'] || '').trim().toUpperCase();
        return t !== null && st !== 'DNS' && st !== 'DQ';
      })
      .sort((a, b) => parseTime(a['TimeSeconds']) - parseTime(b['TimeSeconds']));
    timed.forEach((r, i) => {
      const k = `${r['Event#'].trim()}_${r['Heat#']}_${r['Lane']}`;
      positionMap[k] = { position: i + 1, points: POINTS_MAP[i + 1] || 0 };
    });
  }

  for (const row of rows) {
    const en  = (row['Event#'] || '').trim();
    row._timeSec        = parseTime(row['TimeSeconds']);
    row._eventCompleted = isEventCompleted(eventMap[en] || []);
    const k    = `${en}_${row['Heat#']}_${row['Lane']}`;
    const comp = positionMap[k];
    if (comp) {
      row._position = comp.position;
      row._points   = comp.points;
    } else {
      row._position = null;
      row._points   = 0;
    }
  }
  return rows;
}

// ── DERIVE EVENT LIST FROM SHEET ROWS ────────────────────────────
function buildEventList(results) {
  const rawNums = results.map(r => (r['Event#'] || '').trim()).filter(Boolean);
  const sorted  = sortEventNums(rawNums);
  return sorted.map(en => {
    const eRows    = results.filter(r => (r['Event#'] || '').trim() === en);
    const name     = eRows[0]['EventName'] || `Event #${en}`;
    const heatNums = [...new Set(eRows.map(r => parseInt(r['Heat#'])))].sort((a, b) => a - b);
    const totalH   = Math.max(...heatNums);
    const heats    = heatNums.map(hn => ({ heat_number: hn, total_heats: totalH }));
    return { event_number: en, event_name: name, heats };
  });
}

// ── HOUSE TOTALS (completed events only) ─────────────────────────
function calcHouseTotals(results) {
  const totals = { Alpha: 0, Beta: 0, Gamma: 0 };
  for (const r of results) {
    if (!r._eventCompleted) continue;
    const h = (r['House'] || '').trim();
    if (totals[h] !== undefined) totals[h] += (r._points || 0);
  }
  return totals;
}

// ── LAST COMPLETED EVENT ──────────────────────────────────────────
function getLastCompletedEvent(results) {
  const done = new Set();
  for (const r of results) {
    if (r._eventCompleted) done.add((r['Event#'] || '').trim());
  }
  if (done.size === 0) return null;
  const sorted    = sortEventNums([...done]);
  const lastEn    = sorted[sorted.length - 1];
  const eventRows = results.filter(r => (r['Event#'] || '').trim() === lastEn);
  return { event_number: lastEn, rows: eventRows };
}

// ── EVENT DISPLAY STATUS ──────────────────────────────────────────
function getEventDisplayStatus(eventRows) {
  if (isEventCompleted(eventRows)) return 'done';
  const hasTimes = eventRows.some(r => r._timeSec !== null);
  if (hasTimes) return 'partial';
  return 'pending';
}

// ── PARSE EVENT NAME INTO PARTS ───────────────────────────────────
function parseEventName(name) {
  const distMatch   = name.match(/^(\d+M)/i);
  const dist        = distMatch ? distMatch[1].toUpperCase() : '—';
  const strokeMatch = name.match(/\d+M\s+(.+?)\s+\(/i);
  const stroke      = strokeMatch ? strokeMatch[1] : '—';
  const genderMatch = name.match(/\((Girls|Boys)/i);
  const gender      = genderMatch ? genderMatch[1] : '—';
  const ageMatch    = name.match(/(Under \d+)/i);
  const age         = ageMatch ? ageMatch[1] : '—';
  return { dist, stroke, gender, age };
}

// ── NAV ACTIVE STATE ──────────────────────────────────────────────
function setActiveNav() {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === page);
  });
}

// ── AUTO REFRESH ──────────────────────────────────────────────────
function startAutoRefresh(callback, intervalMs = 30000) {
  callback();
  setInterval(callback, intervalMs);
}

// ── NAV HTML ──────────────────────────────────────────────────────
const NAV_HTML = `
<header class="site-header">
  <div class="header-inner">
    <a class="header-logo" href="index.html">🏊 BIS SWIM GALA
      <span>Interhouse Championship · 2025-26</span>
    </a>
    <span class="header-date">18 April 2026 · NSCI</span>
  </div>
</header>
<nav class="site-nav">
  <div class="nav-inner">
    <a class="nav-link" href="index.html">🏠 Home</a>
    <a class="nav-link" href="winners.html">🏅 Winners</a>
    <a class="nav-link" href="live.html">⚡ Live Results</a>
    <a class="nav-link" href="events.html">📋 Events</a>
    <a class="nav-link" href="participants.html">👤 Participants</a>
  </div>
</nav>`;
