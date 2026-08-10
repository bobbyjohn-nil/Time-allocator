/* Time Allocator — deficit-based scheduling of free time.
   All data lives in localStorage; no server. */

(() => {
  'use strict';

  const STORAGE_KEY = 'timeAllocator.v1';
  const TIMER_KEY = 'timeAllocator.timer.v1';
  const SERIES_SLOTS = 8;

  // ---------- State ----------

  let state = load();
  let range = 'week'; // 'week' | '7d' | 'all'
  let mode = 'unknown'; // 'unknown' | 'fixed'
  let timerInterval = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.activities) && Array.isArray(parsed.sessions)) {
          normalizeTargets(parsed.activities);
          if (typeof parsed.unlocked !== 'object' || !parsed.unlocked) parsed.unlocked = {};
          if (typeof parsed.settings !== 'object' || !parsed.settings) parsed.settings = {};
          if (!Array.isArray(parsed.projects)) parsed.projects = [];
          return parsed;
        }
      }
    } catch (e) { /* corrupted storage falls through to fresh state */ }
    return { activities: [], sessions: [], unlocked: {}, settings: {}, projects: [] };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Target percentages ----------
  // Targets are stored as floats that always sum to 100. Changes are spread
  // evenly across the other activities, never below MIN_SHARE each.

  const MIN_SHARE = 5;

  const SVG_LOCK_CLOSED =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const SVG_LOCK_OPEN =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/></svg>';

  // Take `amount` total from vals[idxs], as evenly as possible, never
  // pushing any below `floor`. Mutates vals; returns what was collected.
  function takeEvenly(vals, idxs, amount, floor) {
    let remaining = amount;
    for (let guard = 0; guard < idxs.length + 2 && remaining > 1e-9; guard++) {
      const movable = idxs.filter(i => vals[i] > floor + 1e-9);
      if (!movable.length) break;
      const per = remaining / movable.length;
      for (const i of movable) {
        const take = Math.min(per, vals[i] - floor);
        vals[i] -= take;
        remaining -= take;
      }
    }
    return amount - remaining;
  }

  function normalizeTargets(activities) {
    if (activities.length === 0) return;
    const sum = activities.reduce((a, x) => a + x.targetPercent, 0);
    if (sum > 0) {
      activities.forEach(a => { a.targetPercent = a.targetPercent * 100 / sum; });
    } else {
      activities.forEach(a => { a.targetPercent = 100 / activities.length; });
    }
  }

  // Integer percentages for display that always sum to exactly 100
  // (largest-remainder rounding), keyed by activity id.
  function displayPercents() {
    const floors = state.activities.map(a => ({
      id: a.id,
      floor: Math.floor(a.targetPercent),
      frac: a.targetPercent - Math.floor(a.targetPercent),
    }));
    let leftover = 100 - floors.reduce((a, x) => a + x.floor, 0);
    const order = [...floors].sort((a, b) => b.frac - a.frac);
    const map = {};
    floors.forEach(f => { map[f.id] = f.floor; });
    for (const f of order) {
      if (leftover <= 0) break;
      map[f.id] += 1;
      leftover -= 1;
    }
    return map;
  }

  // ---------- Time helpers ----------

  function startOfWeek(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    const day = (date.getDay() + 6) % 7; // Monday = 0
    date.setDate(date.getDate() - day);
    return date;
  }

  function rangeStart() {
    const now = new Date();
    if (range === 'week') return startOfWeek(now).getTime();
    if (range === '7d') return now.getTime() - 7 * 24 * 60 * 60 * 1000;
    return 0;
  }

  function windowSessions() {
    const start = rangeStart();
    return state.sessions.filter(s => s.timestamp >= start);
  }

  function fmtDuration(mins) {
    mins = Math.round(mins);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function fmtWhen(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(ts); that.setHours(0, 0, 0, 0);
    const days = Math.round((today - that) / 86400000);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Yesterday ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`;
  }

  function colorOf(activity) {
    const idx = state.activities.indexOf(activity);
    return idx < SERIES_SLOTS ? `var(--series-${idx + 1})` : 'var(--series-other)';
  }

  // ---------- Projects (short-term, deadline-driven) ----------

  function projectLogged(p) {
    return state.sessions.filter(s => s.activityId === p.id).reduce((a, s) => a + s.minutes, 0);
  }

  function projectRemaining(p) {
    return Math.max(0, p.neededMinutes - projectLogged(p));
  }

  function projectDaysLeft(p) {
    return (p.deadline - Date.now()) / 86400000;
  }

  // Minutes per day required to finish on time; overdue means all of it now.
  function projectPace(p) {
    const rem = projectRemaining(p);
    const d = projectDaysLeft(p);
    if (d <= 0) return rem;
    return rem / Math.max(d, 0.5);
  }

  function todayLoggedFor(id) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return state.sessions
      .filter(s => s.activityId === id && s.timestamp >= start.getTime())
      .reduce((a, s) => a + s.minutes, 0);
  }

  // The unfinished project with the steepest required pace, or null.
  function urgentProject() {
    const active = state.projects
      .filter(p => projectRemaining(p) > 0)
      .map(p => ({ p, pace: projectPace(p), rem: projectRemaining(p), overdue: projectDaysLeft(p) <= 0 }));
    if (!active.length) return null;
    return active.sort((a, b) => b.pace - a.pace)[0];
  }

  function dueText(p) {
    const d = projectDaysLeft(p);
    if (d <= 0) return 'overdue';
    if (d < 1) return `${Math.max(1, Math.round(d * 24))}h left`;
    return `${Math.ceil(d)}d left`;
  }

  const isProjectId = id => state.projects.some(p => p.id === id);

  // Series colors belong to activities; projects all wear the accent.
  function colorFor(item) {
    return state.activities.includes(item) ? colorOf(item) : 'var(--accent)';
  }

  // ---------- Stats & recommendation ----------

  // Returns per-activity stats over the current range, with targets normalized
  // so they always behave proportionally even if they don't sum to 100.
  function computeStats() {
    // Project time is tracked separately; activity shares split non-project time.
    const actIds = new Set(state.activities.map(a => a.id));
    const sessions = windowSessions().filter(s => actIds.has(s.activityId));
    const totalMins = sessions.reduce((a, s) => a + sessionEffective(s), 0);
    const targetSum = state.activities.reduce((a, x) => a + x.targetPercent, 0);

    const stats = state.activities.map(act => {
      const spent = sessions
        .filter(s => s.activityId === act.id)
        .reduce((a, s) => a + sessionEffective(s), 0);
      const targetShare = targetSum > 0 ? act.targetPercent / targetSum : 0;
      const actualShare = totalMins > 0 ? spent / totalMins : 0;
      const lastDone = state.sessions
        .filter(s => s.activityId === act.id)
        .reduce((a, s) => Math.max(a, s.timestamp), 0);
      return { activity: act, spent, targetShare, actualShare, lastDone };
    });

    return { stats, totalMins, targetSum };
  }

  // Pick the activity furthest behind its target share, measured in minutes:
  // deficit = target share × total tracked time − time spent on it.
  function recommend() {
    const { stats, totalMins } = computeStats();
    if (stats.length === 0) return null;

    if (totalMins === 0) {
      const best = [...stats].sort((a, b) => b.targetShare - a.targetShare)[0];
      return { ...best, deficit: 0, firstTime: true, suggested: suggestMinutes(best, 0) };
    }

    const ranked = [...stats].sort((a, b) => {
      const da = a.targetShare * totalMins - a.spent;
      const db = b.targetShare * totalMins - b.spent;
      if (db !== da) return db - da;
      if (b.targetShare !== a.targetShare) return b.targetShare - a.targetShare;
      return a.lastDone - b.lastDone; // least recently done wins ties
    });

    const best = ranked[0];
    return {
      ...best,
      deficit: best.targetShare * totalMins - best.spent,
      firstTime: false,
      suggested: suggestMinutes(best, totalMins),
    };
  }

  // Split X available minutes across activities so everyone ends as close
  // to target as possible: waterfill toward the level where each active
  // activity's total equals targetShare × (tracked + X), most-behind first.
  function planAllocation(X) {
    const { stats } = computeStats();
    let active = stats.filter(s => s.targetShare > 0);
    if (!active.length) return [];
    for (let guard = 0; guard < stats.length + 2; guard++) {
      const sumT = active.reduce((a, s) => a + s.targetShare, 0);
      const sumS = active.reduce((a, s) => a + s.spent, 0);
      const lambda = (X + sumS) / sumT;
      const next = active.filter(s => s.targetShare * lambda > s.spent + 1e-9);
      if (next.length === active.length) {
        return finalizePlan(active.map(s => ({ stat: s, minutes: s.targetShare * lambda - s.spent })), X);
      }
      active = next;
      if (!active.length) break;
    }
    const sumT = stats.reduce((a, s) => a + s.targetShare, 0) || 1;
    return finalizePlan(stats.map(s => ({ stat: s, minutes: X * s.targetShare / sumT })), X);
  }

  // Round a raw allocation to whole minutes summing exactly to X, ordered
  // most-behind first, folding sub-30-minute slivers into the biggest block.
  function finalizePlan(alloc, X) {
    alloc.sort((a, b) => b.minutes - a.minutes);
    const floors = alloc.map(a => Math.floor(a.minutes));
    let left = X - floors.reduce((a, b) => a + b, 0);
    const order = alloc.map((a, i) => ({ i, frac: a.minutes - floors[i] })).sort((p, q) => q.frac - p.frac);
    for (const o of order) {
      if (left <= 0) break;
      floors[o.i] += 1;
      left -= 1;
    }
    let blocks = alloc.map((a, i) => ({ activity: a.stat.activity, minutes: floors[i] })).filter(b => b.minutes > 0);
    if (blocks.length > 1) {
      const keep = blocks.filter(b => b.minutes >= 30);
      if (keep.length && keep.length < blocks.length) {
        keep[0].minutes += blocks.filter(b => b.minutes < 30).reduce((a, b) => a + b.minutes, 0);
        blocks = keep;
      }
    }
    return blocks;
  }

  // How long to work on it so its share reaches the target:
  // solve (spent + x) / (total + x) = targetShare  →  x = deficit / (1 − targetShare).
  function suggestMinutes(stat, totalMins) {
    let x;
    if (stat.targetShare >= 1 || totalMins === 0) {
      x = 45;
    } else {
      x = (stat.targetShare * totalMins - stat.spent) / (1 - stat.targetShare);
    }
    x = Math.max(15, Math.min(120, x));
    return Math.round(x / 5) * 5;
  }

  // ---------- Achievements ----------

  function totalTracked() {
    return state.sessions.reduce((a, s) => a + s.minutes, 0);
  }

  // Longest run of consecutive days with at least one session.
  function maxStreak() {
    const days = [...new Set(state.sessions.map(s => {
      const d = new Date(s.timestamp);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }))].sort((a, b) => a - b);
    let best = days.length ? 1 : 0;
    let cur = 1;
    for (let i = 1; i < days.length; i++) {
      if (Math.round((days[i] - days[i - 1]) / 86400000) === 1) {
        cur += 1;
        best = Math.max(best, cur);
      } else {
        cur = 1;
      }
    }
    return best;
  }

  function maxActivitiesInADay() {
    const byDay = {};
    state.sessions.forEach(s => {
      const d = new Date(s.timestamp);
      d.setHours(0, 0, 0, 0);
      (byDay[d.getTime()] = byDay[d.getTime()] || new Set()).add(s.activityId);
    });
    return Object.values(byDay).reduce((a, set) => Math.max(a, set.size), 0);
  }

  const FOCUS_LEVELS = {
    1: { sym: '○', label: 'Distracted' },
    2: { sym: '◑', label: 'In and out' },
    3: { sym: '◕', label: 'Mostly focused' },
    4: { sym: '●', label: 'Locked in' },
  };

  // How much of a session "counts" when weighting by focus; unrated
  // sessions count in full.
  const FOCUS_WEIGHT = { 1: 0.5, 2: 0.75, 3: 0.9, 4: 1 };

  function sessionEffective(s) {
    return state.settings.focusWeighted ? s.minutes * (FOCUS_WEIGHT[s.focus] || 1) : s.minutes;
  }

  // Average focus rating for an activity (needs 2+ rated sessions).
  function activityFocusAvg(actId) {
    const rated = state.sessions.filter(s => s.activityId === actId && s.focus);
    if (rated.length < 2) return null;
    return rated.reduce((a, s) => a + s.focus, 0) / rated.length;
  }

  function focusHabit(avg) {
    if (avg >= 3.5) return { sym: '●', text: 'usually locked in' };
    if (avg >= 2.75) return { sym: '◕', text: 'mostly focused' };
    if (avg >= 1.75) return { sym: '◑', text: 'often in and out' };
    return { sym: '○', text: 'usually distracted' };
  }

  // ---------- Best-hours detection ----------

  const HOUR_BANDS = [
    { key: 'morning', label: 'in the morning', from: 5, to: 12 },
    { key: 'afternoon', label: 'in the afternoon', from: 12, to: 17 },
    { key: 'evening', label: 'in the evening', from: 17, to: 22 },
    { key: 'night', label: 'late at night', from: 22, to: 29 }, // wraps past midnight
  ];

  function bandOf(hour) {
    if (hour < 5) hour += 24;
    return HOUR_BANDS.find(b => hour >= b.from && hour < b.to);
  }

  // Average focus per time-of-day band; a band needs 3+ rated sessions.
  function bandAverages() {
    const acc = {};
    state.sessions.filter(s => s.focus).forEach(s => {
      const key = bandOf(new Date(s.timestamp).getHours()).key;
      (acc[key] = acc[key] || []).push(s.focus);
    });
    const out = {};
    for (const k in acc) {
      if (acc[k].length >= 3) out[k] = acc[k].reduce((a, b) => a + b, 0) / acc[k].length;
    }
    return out;
  }

  // Best and worst bands, only when 2+ bands have enough data to compare.
  function focusBands() {
    const avgs = bandAverages();
    const keys = Object.keys(avgs).sort((a, b) => avgs[b] - avgs[a]);
    if (keys.length < 2) return null;
    return {
      best: HOUR_BANDS.find(b => b.key === keys[0]),
      worst: HOUR_BANDS.find(b => b.key === keys[keys.length - 1]),
      avgs,
    };
  }

  // A week whose 5+ rated sessions average Mostly focused or better.
  function hadFocusedWeek() {
    const byWeek = {};
    state.sessions.filter(s => s.focus).forEach(s => {
      const k = startOfWeek(new Date(s.timestamp)).getTime();
      (byWeek[k] = byWeek[k] || []).push(s.focus);
    });
    return Object.values(byWeek).some(v => v.length >= 5 && v.reduce((a, b) => a + b, 0) / v.length >= 3);
  }

  const ACHIEVEMENTS = [
    { id: 'first-session', sym: '★', title: 'First step', desc: 'Log your first session.',
      test: () => ({ done: state.sessions.length >= 1 }) },
    { id: 'three-activities', sym: '◆', title: 'Getting organized', desc: 'Have 3 activities at once.',
      test: () => ({ done: state.activities.length >= 3 }) },
    { id: 'deep-focus', sym: '✦', title: 'Deep focus', desc: 'Log a single session of 2 hours or more.',
      test: () => ({ done: state.sessions.some(s => s.minutes >= 120) }) },
    { id: 'ten-hours', sym: '⧗', title: 'Ten hours in', desc: 'Track 10 hours in total.',
      test: () => ({ done: totalTracked() >= 600, progress: `${fmtDuration(Math.min(totalTracked(), 600))} / 10h` }) },
    { id: 'marathon', sym: '∞', title: 'Marathon', desc: 'Track 50 hours in total.',
      test: () => ({ done: totalTracked() >= 3000, progress: `${fmtDuration(Math.min(totalTracked(), 3000))} / 50h` }) },
    { id: 'century', sym: 'Σ', title: 'Century', desc: 'Log 100 sessions.',
      test: () => ({ done: state.sessions.length >= 100, progress: `${Math.min(state.sessions.length, 100)} / 100` }) },
    { id: 'streak-3', sym: '▲', title: 'Warming up', desc: 'Log time on 3 days in a row.',
      test: () => ({ done: maxStreak() >= 3, progress: `${Math.min(maxStreak(), 3)} / 3 days` }) },
    { id: 'streak-7', sym: '●', title: 'Full week', desc: 'Log time on 7 days in a row.',
      test: () => ({ done: maxStreak() >= 7, progress: `${Math.min(maxStreak(), 7)} / 7 days` }) },
    { id: 'variety', sym: '✧', title: 'Mixing it up', desc: 'Log 3 different activities in one day.',
      test: () => ({ done: maxActivitiesInADay() >= 3 }) },
    { id: 'locked-in', sym: '◎', title: 'Locked in', desc: 'Rate a session as fully locked in.',
      test: () => ({ done: state.sessions.some(s => s.focus === 4) }) },
    { id: 'early-bird', sym: '☼', title: 'Early bird', desc: 'Log a session before 8am.',
      test: () => ({ done: state.sessions.some(s => new Date(s.timestamp).getHours() < 8) }) },
    { id: 'night-owl', sym: '☾', title: 'Night owl', desc: 'Log a session at 10pm or later.',
      test: () => ({ done: state.sessions.some(s => new Date(s.timestamp).getHours() >= 22) }) },
    { id: 'self-aware', sym: '∗', title: 'Self aware', desc: 'Rate 10 sessions.',
      test: () => {
        const n = state.sessions.filter(s => s.focus).length;
        return { done: n >= 10, progress: `${Math.min(n, 10)} / 10` };
      } },
    { id: 'in-the-zone', sym: '◉', title: 'In the zone', desc: 'Average Mostly focused or better across 5+ rated sessions in one week.',
      test: () => ({ done: hadFocusedWeek() }) },
    { id: 'nice', sym: '⌕', title: 'Nice', desc: 'Log exactly 69 minutes in one session.', hidden: true,
      symSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="21" y2="21"/></svg>',
      test: () => ({ done: state.sessions.some(s => s.minutes === 69) }) },
  ];

  // Unlocks persist, so deleting old sessions never takes a badge back.
  function checkAchievements(silent) {
    let changed = false;
    let niceJustUnlocked = false;
    ACHIEVEMENTS.forEach(a => {
      if (a.test().done && !state.unlocked[a.id]) {
        state.unlocked[a.id] = Date.now();
        changed = true;
        if (a.id === 'nice') {
          niceJustUnlocked = true; // gets its own cutscene instead of a toast
          return;
        }
        // Delayed so it outlives the 'Logged Xm' toast the caller shows next.
        if (!silent) setTimeout(() => showToast(`Achievement unlocked: ${a.sym} ${a.title} — ${a.desc}`), 700);
      }
    });
    if (changed) {
      save();
      if (!silent) {
        if (niceJustUnlocked) {
          playNiceCutscene(() => {
            celebrate('pipes');
            showToast('Achievement unlocked: Nice — Log exactly 69 minutes in one session.');
          });
        } else {
          celebrate();
        }
      }
    }
  }

  // ---------- 'Nice' cutscene ----------
  // A detective works a dark street under a flickering lamp until the
  // magnifying glass finds the badge. Click anywhere to skip.

  const NICE_CUTSCENE_SVG = `
<svg viewBox="0 0 800 450" preserveAspectRatio="xMidYMid slice" class="cs-svg" aria-hidden="true">
  <defs>
    <linearGradient id="csLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe9a8" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffe9a8" stop-opacity="0.06"/>
    </linearGradient>
  </defs>
  <rect x="-800" y="-450" width="2400" height="1350" fill="#0a0e18"/>
  <g class="cs-camera">
  <rect x="-400" y="-225" width="1600" height="900" fill="#0a0e18"/>
  <g fill="#c8d4ee">
    <circle cx="80" cy="60" r="1.5" class="cs-star"/>
    <circle cx="200" cy="100" r="1" class="cs-star s2"/>
    <circle cx="330" cy="50" r="1.2" class="cs-star s3"/>
    <circle cx="470" cy="90" r="1.2" class="cs-star s2"/>
    <circle cx="640" cy="70" r="1.4" class="cs-star s3"/>
    <circle cx="730" cy="130" r="1" class="cs-star"/>
  </g>
  <g class="cs-float f2">
    <circle cx="398" cy="72" r="14" fill="none" stroke="#223065" stroke-width="3" opacity="0.6"/>
  </g>
  <rect x="-400" y="245" width="1600" height="700" fill="#0b0f1d"/>
  <rect x="-400" y="242" width="1600" height="5" fill="#161c33"/>
  <!-- far buildings -->
  <rect x="296" y="106" width="62" height="8" fill="#0e1425"/>
  <rect x="300" y="112" width="54" height="168" fill="#11172c"/>
  <g fill="#232c48">
    <rect x="310" y="140" width="10" height="14"/>
    <rect x="332" y="200" width="10" height="14"/>
  </g>
  <rect x="442" y="106" width="64" height="8" fill="#0e1425"/>
  <rect x="446" y="112" width="56" height="168" fill="#11172c"/>
  <rect x="458" y="150" width="10" height="14" fill="#232c48"/>
  <rect x="480" y="200" width="10" height="14" fill="#c9a86a" opacity="0.8"/>
  <!-- mid buildings -->
  <rect x="214" y="50" width="96" height="10" fill="#0e1425"/>
  <rect x="218" y="58" width="88" height="264" fill="#131a30"/>
  <g fill="#242e4e">
    <rect x="234" y="90" width="12" height="18"/>
    <rect x="282" y="150" width="12" height="18"/>
    <rect x="234" y="230" width="12" height="18"/>
  </g>
  <rect x="258" y="150" width="12" height="18" fill="#c9a86a" opacity="0.8"/>
  <rect x="490" y="50" width="96" height="10" fill="#0e1425"/>
  <rect x="494" y="58" width="88" height="264" fill="#131a30"/>
  <g fill="#242e4e">
    <rect x="508" y="90" width="12" height="18"/>
    <rect x="556" y="170" width="12" height="18"/>
    <rect x="508" y="240" width="12" height="18"/>
  </g>
  <rect x="532" y="120" width="12" height="18" fill="#c9a86a" opacity="0.8"/>
  <!-- near buildings -->
  <rect x="70" y="-100" width="162" height="12" fill="#0e1425"/>
  <rect x="76" y="-90" width="150" height="495" fill="#162040"/>
  <g fill="#28335a">
    <rect x="100" y="20" width="18" height="26"/>
    <rect x="170" y="90" width="18" height="26"/>
    <rect x="100" y="170" width="18" height="26"/>
    <rect x="170" y="240" width="18" height="26"/>
    <rect x="100" y="310" width="18" height="26"/>
  </g>
  <rect x="170" y="170" width="18" height="26" fill="#c9a86a" opacity="0.75"/>
  <rect x="152" y="358" width="28" height="47" fill="#0e1425"/>
  <rect x="574" y="-100" width="162" height="12" fill="#0e1425"/>
  <rect x="580" y="-90" width="150" height="495" fill="#162040"/>
  <g fill="#28335a">
    <rect x="686" y="20" width="18" height="26"/>
    <rect x="616" y="90" width="18" height="26"/>
    <rect x="686" y="170" width="18" height="26"/>
    <rect x="616" y="240" width="18" height="26"/>
    <rect x="686" y="310" width="18" height="26"/>
  </g>
  <rect x="616" y="170" width="18" height="26" fill="#c9a86a" opacity="0.75"/>
  <!-- sidewalks with curbs -->
  <polygon points="352,248 368,248 80,450 10,450" fill="#12172b"/>
  <polygon points="448,248 432,248 720,450 790,450" fill="#12172b"/>
  <polygon points="366,248 368,248 80,450 72,450" fill="#1c2440"/>
  <polygon points="434,248 432,248 720,450 728,450" fill="#1c2440"/>
  <!-- road -->
  <polygon points="368,248 432,248 720,450 80,450" fill="#0c101f"/>
  <g fill="#1a2342">
    <rect x="398" y="262" width="4" height="9"/>
    <rect x="397.25" y="284" width="5.5" height="13"/>
    <rect x="396" y="313" width="8" height="18"/>
    <rect x="394.5" y="350" width="11" height="24"/>
    <rect x="392.5" y="396" width="15" height="32"/>
  </g>
  <g class="cs-flicker">
    <polygon points="701,150 560,448 830,448" fill="url(#csLight)"/>
    <ellipse cx="690" cy="444" rx="130" ry="12" fill="#f5d98b" opacity="0.25"/>
    <circle cx="701" cy="146" r="11" fill="#ffe9a8"/>
  </g>
  <g fill="#232a44">
    <rect x="696" y="150" width="9" height="286"/>
    <rect x="681" y="432" width="38" height="9" rx="2"/>
    <rect x="684" y="132" width="34" height="12" rx="5"/>
  </g>
  <ellipse cx="600" cy="417" rx="30" ry="7.5" fill="#18233f"/>
  <ellipse cx="591" cy="415" rx="11" ry="2.5" fill="#2b3d66" opacity="0.7"/>
  <g class="cs-badge" transform="translate(600 412)">
    <rect x="-14" y="-14" width="28" height="28" rx="6" fill="#2a78d6"/>
    <circle cx="-3" cy="-3" r="5.5" fill="none" stroke="#ffffff" stroke-width="2.2"/>
    <line x1="1.5" y1="1.5" x2="8" y2="8" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
  </g>
  <g class="cs-approach">
    <g class="cs-dart">
      <g class="cs-flip">
        <g class="cs-bob">
          <g>
            <polygon points="-13,0 -5,0 -5,-4 -13,-4" fill="#0e1015"/>
            <polygon points="5,0 15,0 15,-4 5,-4" fill="#0e1015"/>
            <rect x="-11" y="-32" width="7" height="28" fill="#191c26"/>
            <rect x="5" y="-32" width="7" height="28" fill="#191c26"/>
            <polygon points="7,-14 13,-15 14,-58 8,-58" fill="#14161f"/>
            <path d="M -11 -68 Q -16 -40 -18 -12 L 7 -12 L 8 -56 L 10 -70 L -4 -74 Z" fill="#737d92"/>
            <path d="M 8 -58 L 18 -78 L 2 -70 Z" fill="#5b6478"/>
            <path d="M -11 -68 L -16 -84 L -1 -73 Z" fill="#5b6478"/>
            <rect x="0" y="-66" width="13" height="9" rx="4" fill="#39415a" transform="rotate(-8 6 -62)"/>
            <rect x="8" y="-58" width="5" height="12" rx="2" fill="#39415a"/>
            <circle cx="3" cy="-82" r="9" fill="#c9b8a6"/>
            <g fill="#241f1a">
              <circle cx="1" cy="-88" r="6.5"/>
              <circle cx="-4" cy="-84" r="5.5"/>
              <circle cx="8" cy="-86" r="5"/>
              <rect x="-9" y="-86" width="4" height="9" rx="2"/>
            </g>
            <path d="M -12 -86 Q -13 -97 1 -98 Q 14 -98 13 -88 Q 0 -84 -12 -86 Z" fill="#4a4438"/>
            <path d="M 13 -88 L 21 -86 Q 13 -83 10 -85 Z" fill="#3a352b"/>
            <g class="cs-smoke" fill="#9aa7c9">
              <circle cx="25" cy="-82" r="2" class="cs-puff"/>
              <circle cx="28" cy="-91" r="2.5" class="cs-puff p2"/>
              <circle cx="31" cy="-100" r="3" class="cs-puff p3"/>
            </g>
            <path d="M 8 -78 L 9 -75 L 19 -68 L 20 -72 Z" fill="#3a2a1e"/>
            <path d="M 19 -73 L 19 -65 Q 19 -59 24.5 -59 Q 30 -59 30 -65 L 30 -73 Z" fill="#5a4030"/>
            <ellipse cx="24.5" cy="-73" rx="5.5" ry="1.8" fill="#241a12"/>
            <g transform="translate(4 -70)">
              <g class="cs-arm">
                <line x1="0" y1="0" x2="9" y2="15" stroke="#737d92" stroke-width="7.5" stroke-linecap="round"/>
                <g transform="translate(9 15)">
                  <g class="cs-forearm">
                    <line x1="0" y1="0" x2="13" y2="9" stroke="#737d92" stroke-width="6" stroke-linecap="round"/>
                    <circle cx="15" cy="10" r="3.5" fill="#c9b8a6"/>
                    <line x1="17" y1="11" x2="21" y2="13" stroke="#2b3040" stroke-width="3.5" stroke-linecap="round"/>
                    <circle cx="26" cy="15" r="9" fill="rgba(200,220,255,0.14)" stroke="#8fa3c7" stroke-width="2.5"/>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </g>
  </g>
  </g>
</svg>`;

  function playNiceCutscene(done) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done();
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'cutscene';
    overlay.innerHTML = NICE_CUTSCENE_SVG +
      '<div class="cutscene-reveal">' +
      '<div class="cutscene-badge"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="21" y2="21"/></svg>' +
      '<span class="cutscene-shine"></span>' +
      '<span class="cutscene-drip d1"></span><span class="cutscene-drip d2"></span><span class="cutscene-drip d3"></span></div>' +
      '<div class="cutscene-title">NICE.</div>' +
      '<div class="cutscene-sub">Achievement found: log exactly 69 minutes.</div>' +
      '</div>' +
      '<div class="cutscene-skip">Click to skip</div>';
    document.body.appendChild(overlay);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      overlay.classList.add('cutscene-out');
      setTimeout(() => {
        overlay.remove();
        done();
      }, 500);
    };
    overlay.addEventListener('click', finish);
    setTimeout(finish, 9200);
  }

  // Two party poppers of confetti from the bottom corners. kind 'pipes'
  // rains little detective pipes instead of paper bits.
  const PIPE_CONFETTI_SVG =
    '<svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">' +
    '<path d="M0 2 L1 5 L10 8 L10 4 Z"/><path d="M9 4 L9 9 Q9 13 12.5 13 Q16 13 16 9 L16 4 Z"/></svg>';
  const PIPE_COLORS = ['#7a5a3a', '#8a6a4a', '#5a4030', '#a37c52'];

  function celebrate(kind) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const container = document.createElement('div');
    container.className = 'confetti';
    document.body.appendChild(container);

    const bursts = [
      { x: 0, y: window.innerHeight, angle: -60 },
      { x: window.innerWidth, y: window.innerHeight, angle: -120 },
    ];

    bursts.forEach(b => {
      for (let i = 0; i < 45; i++) {
        const p = document.createElement('div');
        p.className = 'confetti-piece';
        let scale = 1;
        if (kind === 'pipes') {
          p.innerHTML = PIPE_CONFETTI_SVG;
          p.style.color = PIPE_COLORS[i % PIPE_COLORS.length];
          scale = 0.7 + Math.random() * 0.9;
        } else {
          p.style.background = `var(--series-${(i % SERIES_SLOTS) + 1})`;
          const w = 5 + Math.random() * 6;
          p.style.width = `${w}px`;
          p.style.height = `${Math.random() < 0.5 ? w : w * 0.4}px`;
          if (Math.random() < 0.3) p.style.borderRadius = '50%';
        }
        p.style.left = `${b.x}px`;
        p.style.top = `${b.y}px`;
        container.appendChild(p);

        const angle = (b.angle + (Math.random() - 0.5) * 55) * Math.PI / 180;
        const velocity = 350 + Math.random() * 500;
        const dx = Math.cos(angle) * velocity;
        const dy = Math.sin(angle) * velocity;
        const fall = 300 + Math.random() * 350;
        const rot = (Math.random() - 0.5) * 1080;
        p.animate([
          { transform: `translate(0, 0) rotate(0deg) scale(${scale})`, opacity: 1 },
          { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) rotate(${rot * 0.5}deg) scale(${scale})`, opacity: 1, offset: 0.35 },
          { transform: `translate(${dx}px, ${dy + fall}px) rotate(${rot}deg) scale(${scale})`, opacity: 0 },
        ], {
          duration: kind === 'pipes' ? 4800 + Math.random() * 2400 : 2800 + Math.random() * 1600,
          easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)',
        });
      }
    });

    setTimeout(() => container.remove(), kind === 'pipes' ? 7400 : 4600);
  }

  // ---------- DOM refs ----------

  const $ = id => document.getElementById(id);
  const askBtn = $('ask-btn');
  const recBox = $('recommendation');
  const fixedControls = $('fixed-controls');
  const haveHours = $('have-hours');
  const haveMins = $('have-mins');
  const splitToggle = $('split-toggle');
  const activityList = $('activity-list');
  const targetTotal = $('target-total');
  const activityForm = $('activity-form');
  const newName = $('new-name');
  const projectList = $('project-list');
  const projectForm = $('project-form');
  const projName = $('proj-name');
  const projHours = $('proj-hours');
  const projDays = $('proj-days');
  const logForm = $('log-form');
  const logActivity = $('log-activity');
  const logMinutes = $('log-minutes');
  const quickChips = $('quick-chips');
  const timerActivity = $('timer-activity');
  const timerToggle = $('timer-toggle');
  const timerDisplay = $('timer-display');
  const timerCancel = $('timer-cancel');
  const balanceChart = $('balance-chart');
  const balanceSummary = $('balance-summary');
  const historyList = $('history-list');
  const historyEmpty = $('history-empty');
  const historySummary = $('history-summary');
  const archiveList = $('archive-list');
  const archiveEmpty = $('archive-empty');
  const achGrid = $('ach-grid');
  const achSummary = $('ach-summary');
  const focusBest = $('focus-best');
  const focusTrend = $('focus-trend');
  const focusTrendEmpty = $('focus-trend-empty');
  const focusWeightToggle = $('focus-weight-toggle');
  const tooltip = $('tooltip');
  const toast = $('toast');
  const focusOverlay = $('focus-overlay');

  // ---------- Rendering ----------

  function render() {
    renderActivities();
    renderProjects();
    renderSelects();
    renderBalance();
    renderHistory();
    renderArchive();
    renderInsights();
    checkAchievements(false);
    renderAchievements();
  }

  function renderArchive() {
    archiveList.innerHTML = '';
    const done = state.projects.filter(p => projectRemaining(p) <= 0);
    archiveEmpty.style.display = done.length ? 'none' : '';

    done
      .map(p => ({
        p,
        finishedAt: state.sessions
          .filter(s => s.activityId === p.id)
          .reduce((a, s) => Math.max(a, s.timestamp), p.createdAt),
      }))
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .forEach(({ p, finishedAt }) => {
        const li = document.createElement('li');
        li.className = 'history-item';

        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = 'var(--good)';

        const name = document.createElement('span');
        name.textContent = p.name;

        const mins = document.createElement('span');
        mins.className = 'history-mins';
        mins.textContent = `${fmtDuration(projectLogged(p))} logged`;

        const when = document.createElement('span');
        when.className = 'history-when';
        when.textContent = `finished ${new Date(finishedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

        const del = document.createElement('button');
        del.className = 'icon-btn danger';
        del.title = `Delete ${p.name}`;
        del.textContent = '✕';
        del.addEventListener('click', async () => {
          if (!(await themedConfirm(`Delete the archived project "${p.name}" and its sessions?`, { title: 'Delete project', confirmLabel: 'Delete', danger: true }))) return;
          state.projects = state.projects.filter(x => x.id !== p.id);
          state.sessions = state.sessions.filter(s => s.activityId !== p.id);
          save();
          render();
        });

        li.append(sw, name, mins, when, del);
        archiveList.appendChild(li);
      });
  }

  function renderInsights() {
    const bands = focusBands();
    focusBest.textContent = bands
      ? `You're most locked in ${bands.best.label} (avg ${bands.avgs[bands.best.key].toFixed(1)} of 4) and most distracted ${bands.worst.label} (avg ${bands.avgs[bands.worst.key].toFixed(1)}).`
      : 'Rate sessions at different times of day and the site will learn when you focus best.';

    focusTrend.innerHTML = '';
    const weekMs = 7 * 86400000;
    const thisWeek = startOfWeek(new Date()).getTime();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const start = thisWeek - i * weekMs;
      const rated = state.sessions.filter(s => s.focus && s.timestamp >= start && s.timestamp < start + weekMs);
      weeks.push({
        start,
        n: rated.length,
        avg: rated.length ? rated.reduce((a, s) => a + s.focus, 0) / rated.length : null,
      });
    }

    if (weeks.filter(w => w.avg !== null).length < 2) {
      focusTrendEmpty.textContent = 'Rate sessions in at least two different weeks to see your focus trend.';
      return;
    }

    focusTrendEmpty.textContent = 'Average focus per week (1 = distracted, 4 = locked in).';
    weeks.forEach(w => {
      const col = document.createElement('div');
      col.className = 'trend-col';
      const wrap = document.createElement('div');
      wrap.className = 'trend-bar-wrap';
      if (w.avg !== null) {
        const bar = document.createElement('div');
        bar.className = 'trend-bar';
        bar.style.height = `${(w.avg / 4) * 100}%`;
        wrap.appendChild(bar);
        attachTooltip(wrap, () =>
          `Week of ${new Date(w.start).toLocaleDateString([], { month: 'short', day: 'numeric' })} — avg ${w.avg.toFixed(1)} of 4 (${w.n} rated session${w.n === 1 ? '' : 's'})`
        );
      }
      const label = document.createElement('span');
      label.className = 'trend-label';
      label.textContent = new Date(w.start).toLocaleDateString([], { month: 'short', day: 'numeric' });
      col.append(wrap, label);
      focusTrend.appendChild(col);
    });
  }

  function renderActivities() {
    activityList.innerHTML = '';
    if (state.activities.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No activities yet — add the things you want to spend your free time on below.';
      activityList.appendChild(p);
      targetTotal.textContent = '';
      return;
    }

    const segEls = {};
    const segLabels = {};
    const labelCells = {};
    const labelNames = {};

    function refreshPcts() {
      const p = displayPercents();
      state.activities.forEach(a => {
        segEls[a.id].style.flexGrow = a.targetPercent;
        labelCells[a.id].style.flexGrow = a.targetPercent;
        segLabels[a.id].textContent = `${p[a.id]}%`;
      });
      fitSegLabels();
    }

    // Only show a segment's % label when it actually fits inside the segment,
    // and rotate a name counter-clockwise just far enough that its bounding
    // box fits the width its segment gives it — diagonal when possible,
    // fully vertical only when it must be.
    function fitSegLabels() {
      state.activities.forEach(a => {
        const seg = segEls[a.id];
        const lbl = segLabels[a.id];
        lbl.style.visibility = 'visible';
        if (lbl.offsetWidth + 10 > seg.clientWidth) lbl.style.visibility = 'hidden';
        // Pick label ink by segment luminance so it always reads.
        const rgb = getComputedStyle(seg).backgroundColor.match(/\d+/g);
        if (rgb) {
          const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
          lbl.style.color = lum > 0.62 ? '#0b0b0b' : '#ffffff';
        }

        const nameEl = labelNames[a.id];
        const cell = labelCells[a.id];
        // The text itself never changes mid-drag, so measure it once while
        // it's still untransformed.
        if (!nameEl.dataset.w) {
          nameEl.dataset.w = nameEl.scrollWidth;
          nameEl.dataset.h = nameEl.offsetHeight;
        }
        const w = +nameEl.dataset.w;
        const h = +nameEl.dataset.h;
        const avail = Math.max(cell.clientWidth - 4, h);

        if (w <= avail) {
          nameEl.style.transform = '';
          nameEl.style.marginBottom = '';
          return;
        }

        // Smallest theta with w*cos(t) + h*sin(t) = avail, i.e. the rotated
        // bounding box exactly spans the available width.
        const R = Math.hypot(w, h);
        let theta = Math.atan2(h, w) + Math.acos(Math.max(-1, Math.min(1, avail / R)));
        theta = Math.min(theta, Math.PI / 2);
        const boxH = w * Math.sin(theta) + h * Math.cos(theta);
        // translateY drops the rotated box so its top stays on the row line;
        // the margin reserves its real height so the delete button sits below.
        nameEl.style.transform =
          `translateY(${(boxH - h) / 2}px) rotate(${(-theta * 180 / Math.PI).toFixed(2)}deg)`;
        nameEl.style.marginBottom = `${Math.ceil(boxH - h)}px`;
      });
    }

    // Pushing the divider into a side takes time evenly from the unlocked
    // activities on THAT side and gives it to the activity being enlarged:
    // drag right = grow the activity left of the divider, funded evenly by
    // the right side; drag left = grow the right one, funded by the left
    // side. Locked activities never give or receive.
    function wireHandle(handle, leftIndex, bar) {
      const floor = () => Math.min(MIN_SHARE, 100 / state.activities.length);

      function applyDelta(P0, locked, d) {
        const vals = P0.slice();
        // The grown activity is the nearest UNLOCKED one on the receiving
        // side of the divider — locked segments in between simply slide.
        let receiver = d >= 0 ? leftIndex : leftIndex + 1;
        if (d >= 0) { while (receiver >= 0 && locked[receiver]) receiver--; }
        else { while (receiver < vals.length && locked[receiver]) receiver++; }
        if (receiver < 0 || receiver >= vals.length) return vals;
        const all = vals.map((_, i) => i);
        const givers = (d >= 0 ? all.slice(leftIndex + 1) : all.slice(0, leftIndex + 1))
          .filter(i => !locked[i]);
        vals[receiver] += takeEvenly(vals, givers, Math.abs(d), floor());
        return vals;
      }

      function commit(vals) {
        state.activities.forEach((a, i) => { a.targetPercent = vals[i]; });
        refreshPcts();
      }

      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        const P0 = state.activities.map(a => a.targetPercent);
        const locked = state.activities.map(a => !!a.locked);
        const startX = e.clientX;
        const width = bar.getBoundingClientRect().width;
        const move = ev => commit(applyDelta(P0, locked, ((ev.clientX - startX) / width) * 100));
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          save();
          renderBalance();
          if (!recBox.classList.contains('hidden')) renderRecommendation();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
      handle.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowRight' ? 1 : -1);
        const P0 = state.activities.map(a => a.targetPercent);
        const locked = state.activities.map(a => !!a.locked);
        commit(applyDelta(P0, locked, step));
        save();
        renderBalance();
      });
    }

    const bar = document.createElement('div');
    bar.className = 'alloc-bar';

    state.activities.forEach((act, i) => {
      if (i > 0) {
        const prev = state.activities[i - 1];
        const handle = document.createElement('div');
        handle.className = 'alloc-handle';
        handle.tabIndex = 0;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', `Boundary between ${prev.name} and ${act.name} — arrow keys to adjust`);
        const grip = document.createElement('div');
        grip.className = 'alloc-grip';
        handle.appendChild(grip);
        wireHandle(handle, i - 1, bar);
        bar.appendChild(handle);
      }

      const seg = document.createElement('div');
      seg.className = 'alloc-seg';
      seg.style.background = colorOf(act);
      seg.style.flexGrow = act.targetPercent;
      const lbl = document.createElement('span');
      lbl.className = 'alloc-seg-label';
      seg.appendChild(lbl);
      attachTooltip(seg, () => `${act.name} — ${displayPercents()[act.id]}%`);
      segEls[act.id] = seg;
      segLabels[act.id] = lbl;
      bar.appendChild(seg);
    });

    activityList.appendChild(bar);

    // Labels sit in a second flex row that mirrors the bar's segment
    // widths, so each activity's name stays directly under its segment.
    const labels = document.createElement('div');
    labels.className = 'alloc-labels';
    state.activities.forEach((act, i) => {
      if (i > 0) {
        const spacer = document.createElement('div');
        spacer.className = 'alloc-label-spacer';
        labels.appendChild(spacer);
      }

      const cell = document.createElement('div');
      cell.className = 'alloc-label-cell';
      cell.style.flexGrow = act.targetPercent;

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'alloc-label-name';
      name.textContent = act.name;
      name.title = `${act.name} — click to rename`;
      name.addEventListener('click', () => editActivity(act));
      labelNames[act.id] = name;

      const lock = document.createElement('button');
      lock.className = 'icon-btn alloc-label-lock' + (act.locked ? ' locked' : '');
      lock.title = act.locked
        ? `Unlock ${act.name}`
        : `Lock ${act.name} at its current share`;
      lock.innerHTML = act.locked ? SVG_LOCK_CLOSED : SVG_LOCK_OPEN;
      lock.addEventListener('click', () => {
        act.locked = !act.locked;
        save();
        render();
      });

      const del = document.createElement('button');
      del.className = 'icon-btn danger alloc-label-del';
      del.title = `Delete ${act.name}`;
      del.textContent = '✕';
      del.addEventListener('click', () => deleteActivity(act));

      const actions = document.createElement('span');
      actions.className = 'alloc-label-actions';
      actions.append(lock, del);
      cell.append(name, actions);
      labelCells[act.id] = cell;
      labels.appendChild(cell);
    });
    activityList.appendChild(labels);

    requestAnimationFrame(refreshPcts);

    targetTotal.textContent = state.activities.length > 1
      ? 'Drag the dividers to push time from one activity into another — the bar always totals 100%.'
      : '';
  }

  function renderSelects() {
    for (const sel of [logActivity, timerActivity]) {
      const prev = sel.value;
      sel.innerHTML = '';
      const addOptions = (items, parent) => {
        items.forEach(x => {
          const opt = document.createElement('option');
          opt.value = x.id;
          opt.textContent = x.name;
          parent.appendChild(opt);
        });
      };
      if (state.projects.length === 0) {
        addOptions(state.activities, sel);
      } else {
        for (const [label, items] of [['Activities', state.activities], ['Projects', state.projects]]) {
          if (!items.length) continue;
          const grp = document.createElement('optgroup');
          grp.label = label;
          addOptions(items, grp);
          sel.appendChild(grp);
        }
      }
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }
  }

  function renderProjects() {
    projectList.innerHTML = '';
    const active = state.projects.filter(p => projectRemaining(p) > 0);
    if (active.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = state.projects.length
        ? 'All projects finished — see the archive in the History tab.'
        : 'No projects right now.';
      projectList.appendChild(p);
      return;
    }

    active
      .sort((a, b) => a.deadline - b.deadline)
      .forEach(proj => {
        const logged = projectLogged(proj);
        const rem = projectRemaining(proj);
        const done = false;
        const overdue = projectDaysLeft(proj) <= 0;

        const row = document.createElement('div');
        row.className = 'project-row';

        const head = document.createElement('div');
        head.className = 'project-head';

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'project-name';
        name.textContent = proj.name;
        name.title = `${proj.name} — click to rename`;
        name.addEventListener('click', async () => {
          const newName = await themedPrompt('Rename project', proj.name);
          if (newName === null || !newName.trim()) return;
          proj.name = newName.trim();
          save();
          render();
        });

        const status = document.createElement('span');
        status.className = 'project-status';
        if (done) {
          status.textContent = '✓ done';
          status.classList.add('done');
        } else if (overdue) {
          status.textContent = `overdue · ${fmtDuration(rem)} still needed`;
          status.classList.add('overdue');
        } else {
          status.textContent = `${dueText(proj)} · needs ~${fmtDuration(projectPace(proj))}/day`;
        }

        const del = document.createElement('button');
        del.className = 'icon-btn danger';
        del.title = `Delete ${proj.name}`;
        del.textContent = '✕';
        del.addEventListener('click', async () => {
          const n = state.sessions.filter(s => s.activityId === proj.id).length;
          const msg = n
            ? `Delete "${proj.name}" and its ${n} logged session${n === 1 ? '' : 's'}?`
            : `Delete "${proj.name}"?`;
          if (!(await themedConfirm(msg, { title: 'Delete project', confirmLabel: 'Delete', danger: true }))) return;
          state.projects = state.projects.filter(x => x.id !== proj.id);
          state.sessions = state.sessions.filter(s => s.activityId !== proj.id);
          save();
          render();
        });

        head.append(name, status, del);

        const track = document.createElement('div');
        track.className = 'project-track';
        const fill = document.createElement('div');
        fill.className = 'project-fill' + (done ? ' done' : '');
        fill.style.width = `${Math.min(100, (logged / proj.neededMinutes) * 100)}%`;
        track.appendChild(fill);
        attachTooltip(track, () => `${fmtDuration(logged)} of ${fmtDuration(proj.neededMinutes)} logged`);

        const meta = document.createElement('div');
        meta.className = 'project-meta';
        meta.textContent = `${fmtDuration(logged)} of ${fmtDuration(proj.neededMinutes)}`;

        row.append(head, track, meta);
        projectList.appendChild(row);
      });
  }

  function renderBalance() {
    const { stats, totalMins } = computeStats();
    balanceChart.innerHTML = '';

    if (stats.length === 0) {
      balanceSummary.textContent = 'Add some activities to see your balance.';
      return;
    }

    const rangeLabel = range === 'week' ? 'this week' : range === '7d' ? 'in the last 7 days' : 'in total';
    const kind = state.settings.focusWeighted ? 'focus-weighted time' : 'free time';
    balanceSummary.textContent = totalMins === 0
      ? `Nothing tracked ${rangeLabel} yet.`
      : `${fmtDuration(totalMins)} of ${kind} tracked ${rangeLabel}.`;

    // Axis max: largest of target/actual shares, padded to the next 10%.
    const maxShare = Math.max(
      0.1,
      ...stats.map(s => Math.max(s.targetShare, s.actualShare))
    );
    const axisMax = Math.min(1, Math.ceil(maxShare * 10) / 10);

    const pcts = displayPercents();
    stats.forEach(stat => {
      const actualPct = Math.round(stat.actualShare * 100);
      const targetPct = pcts[stat.activity.id];

      const row = document.createElement('div');
      row.className = 'balance-row';

      const label = document.createElement('div');
      label.className = 'balance-label';
      const name = document.createElement('span');
      name.className = 'balance-name';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = colorOf(stat.activity);
      name.append(sw, document.createTextNode(stat.activity.name));

      const focusAvg = activityFocusAvg(stat.activity.id);
      if (focusAvg !== null) {
        const habit = focusHabit(focusAvg);
        const habitEl = document.createElement('span');
        habitEl.className = 'balance-focus';
        habitEl.textContent = `${habit.sym} ${habit.text}`;
        habitEl.title = `Average focus ${focusAvg.toFixed(1)} of 4 across rated sessions`;
        name.appendChild(habitEl);
      }

      const values = document.createElement('span');
      values.className = 'balance-values';
      if (totalMins === 0) {
        values.textContent = `target ${targetPct}%`;
      } else {
        // A couple of points off is noise, not a deficit.
        const diff = actualPct - targetPct;
        const status = diff >= -2 ? `<span class="ahead">on track</span>` : `${targetPct - actualPct}pt behind`;
        values.innerHTML = `${actualPct}% of ${targetPct}% · ${status}`;
      }

      label.append(name, values);

      const track = document.createElement('div');
      track.className = 'balance-track';

      const fill = document.createElement('div');
      fill.className = 'balance-fill';
      fill.style.background = colorOf(stat.activity);
      fill.style.width = `${Math.min(100, (stat.actualShare / axisMax) * 100)}%`;
      if (stat.actualShare === 0) fill.style.display = 'none';

      const target = document.createElement('div');
      target.className = 'balance-target';
      target.style.left = `calc(${Math.min(100, (stat.targetShare / axisMax) * 100)}% - 1px)`;

      track.append(fill, target);
      attachTooltip(track, () =>
        `${stat.activity.name} — ${fmtDuration(stat.spent)} (${actualPct}% of tracked time) · target ${targetPct}%`
      );

      row.append(label, track);
      balanceChart.appendChild(row);
    });
  }

  function renderHistory() {
    historyList.innerHTML = '';
    const recent = [...state.sessions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200);
    historyEmpty.style.display = recent.length ? 'none' : '';
    historySummary.textContent = state.sessions.length
      ? `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} · ${fmtDuration(totalTracked())} tracked in total${state.sessions.length > 200 ? ' · showing the last 200' : ''}`
      : '';

    // Group into days, newest first; today starts expanded.
    const days = [];
    const byDay = new Map();
    recent.forEach(s => {
      const d = new Date(s.timestamp);
      d.setHours(0, 0, 0, 0);
      const key = d.getTime();
      if (!byDay.has(key)) {
        byDay.set(key, []);
        days.push(key);
      }
      byDay.get(key).push(s);
    });

    days.forEach((key, i) => {
      const sessions = byDay.get(key);
      const total = sessions.reduce((a, s) => a + s.minutes, 0);

      const details = document.createElement('details');
      details.className = 'history-day';
      if (i === 0) details.open = true;

      const summary = document.createElement('summary');
      const caret = document.createElement('span');
      caret.className = 'history-caret';
      caret.textContent = '▸';
      const label = document.createElement('span');
      label.className = 'history-day-label';
      label.textContent = dayLabel(key);
      const meta = document.createElement('span');
      meta.className = 'history-day-meta';
      meta.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${fmtDuration(total)}`;
      summary.append(caret, label, meta);
      details.appendChild(summary);

      const ul = document.createElement('ul');
      ul.className = 'history-list';
      sessions.forEach(s => ul.appendChild(historyItem(s)));
      details.appendChild(ul);

      historyList.appendChild(details);
    });
  }

  function dayLabel(dayTs) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - dayTs) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return new Date(dayTs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function historyItem(s) {
    const act = state.activities.find(a => a.id === s.activityId)
      || state.projects.find(p => p.id === s.activityId);
    const li = document.createElement('li');
    li.className = 'history-item';

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = act ? colorFor(act) : 'var(--series-other)';

    const name = document.createElement('span');
    name.textContent = act ? act.name : '(deleted activity)';

    const mins = document.createElement('span');
    mins.className = 'history-mins';
    mins.textContent = fmtDuration(s.minutes);

    const focus = document.createElement('span');
    focus.className = 'history-focus';
    if (s.focus && FOCUS_LEVELS[s.focus]) {
      focus.textContent = FOCUS_LEVELS[s.focus].sym;
      focus.title = FOCUS_LEVELS[s.focus].label;
    }

    const when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = new Date(s.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.title = 'Delete session';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      state.sessions = state.sessions.filter(x => x.id !== s.id);
      save();
      render();
    });

    li.append(sw, name, mins, focus, when, del);
    return li;
  }

  function renderAchievements() {
    achGrid.innerHTML = '';
    let unlockedCount = 0;

    ACHIEVEMENTS.forEach(a => {
      const result = a.test();
      const unlockedAt = state.unlocked[a.id];
      if (unlockedAt) unlockedCount += 1;

      const secret = a.hidden && !unlockedAt;

      const card = document.createElement('div');
      card.className = 'ach-card' + (unlockedAt ? ' unlocked' : '');

      const sym = document.createElement('span');
      sym.className = 'ach-sym';
      if (secret) {
        sym.textContent = '?';
      } else if (a.symSvg) {
        sym.innerHTML = a.symSvg;
      } else {
        sym.textContent = a.sym;
      }

      const body = document.createElement('div');
      body.className = 'ach-body';

      const title = document.createElement('div');
      title.className = 'ach-title';
      title.textContent = secret ? 'Hidden achievement' : a.title;

      const desc = document.createElement('div');
      desc.className = 'ach-desc';
      desc.textContent = secret ? 'A secret achievement — keep logging.' : a.desc;

      body.append(title, desc);

      const status = document.createElement('div');
      status.className = 'ach-status';
      if (unlockedAt) {
        status.textContent = `Unlocked ${new Date(unlockedAt).toLocaleDateString()}`;
      } else if (result.progress) {
        status.textContent = result.progress;
      } else {
        status.textContent = 'Locked';
      }
      body.appendChild(status);

      card.append(sym, body);
      achGrid.appendChild(card);
    });

    achSummary.textContent = `${unlockedCount} of ${ACHIEVEMENTS.length} unlocked`;
  }

  // ---------- Pages ----------

  const PAGES = ['ask', 'home', 'history', 'achievements'];

  function pageFromHash() {
    const h = location.hash.slice(1);
    return PAGES.includes(h) && h !== 'ask' ? h : 'ask';
  }

  function showPage(page) {
    PAGES.forEach(p => { $('page-' + p).hidden = p !== page; });
    document.querySelectorAll('.tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.page === page));
  }

  function renderRecommendation() {
    recBox.classList.remove('hidden');
    recBox.innerHTML = '';

    if (state.activities.length === 0 && state.projects.length === 0) {
      recBox.innerHTML = `<p class="rec-reason">Add some activities or a project first, then ask again!</p>`;
      return;
    }

    if (mode === 'fixed') {
      renderFixedRecommendation();
    } else {
      renderOpenRecommendation();
    }
  }

  function fixedMinutes() {
    const h = parseInt(haveHours.value, 10) || 0;
    const m = parseInt(haveMins.value, 10) || 0;
    return Math.min(h * 60 + m, 24 * 60);
  }

  function renderFixedRecommendation() {
    const X = fixedMinutes();
    if (X < 5) {
      recBox.innerHTML = `<p class="rec-reason">Enter at least 5 minutes and ask again.</p>`;
      return;
    }

    const up = urgentProject();

    if (!splitToggle.checked) {
      if (projectClaims(up)) {
        renderProjectRecommendation(up, Math.min(X, up.rem));
        return;
      }
      if (state.activities.length === 0) {
        if (up) {
          renderProjectAhead(up, Math.min(X, up.rem));
          return;
        }
        recBox.innerHTML = `<p class="rec-reason">Add some activities or a project first, then ask again!</p>`;
        return;
      }
      const rec = recommend();
      const act = rec.activity;
      const { totalMins } = computeStats();

      const headline = document.createElement('div');
      headline.className = 'rec-headline';
      const sw = document.createElement('span');
      sw.className = 'rec-swatch';
      sw.style.background = colorOf(act);
      headline.append(sw, document.createTextNode(act.name));

      const reason = document.createElement('p');
      reason.className = 'rec-reason';
      if (totalMins === 0) {
        reason.textContent = `Spend your ${fmtDuration(X)} here — nothing is tracked yet, so start with your biggest priority.`;
      } else {
        const actualPct = Math.round(rec.actualShare * 100);
        const targetPct = displayPercents()[act.id];
        reason.textContent = actualPct < targetPct
          ? `Spend the whole ${fmtDuration(X)} on this — you're at ${actualPct}% of a ${targetPct}% target, the furthest behind.`
          : `Everything is at or above target — this one benefits most from your ${fmtDuration(X)}.`;
      }

      const actions = document.createElement('div');
      actions.className = 'rec-actions';
      actions.append(
        makeStartTimerButton(act),
        makeLogButton([{ activity: act, minutes: X }], `Log ${fmtDuration(X)} now`)
      );

      recBox.append(headline, reason, actions);
      return;
    }

    // Deadline projects take what they need for today off the top; the
    // rest of the block waterfills across regular activities.
    let left = X;
    const projectBlocks = [];
    state.projects
      .filter(p => projectRemaining(p) > 0)
      .map(p => ({ p, pace: projectPace(p) }))
      .sort((a, b) => b.pace - a.pace)
      .forEach(({ p, pace }) => {
        if (left <= 0) return;
        const need = Math.min(
          Math.ceil(Math.max(pace - todayLoggedFor(p.id), 0)),
          projectRemaining(p),
          left
        );
        if (need >= 10) {
          projectBlocks.push({ activity: p, minutes: need });
          left -= need;
        }
      });

    // With no regular activities to fall back to, leftover time works
    // ahead on the projects themselves.
    if (left > 0 && state.activities.length === 0) {
      state.projects
        .filter(p => projectRemaining(p) > 0)
        .map(p => ({ p, pace: projectPace(p) }))
        .sort((a, b) => b.pace - a.pace)
        .forEach(({ p }) => {
          if (left <= 0) return;
          const already = projectBlocks.find(b => b.activity === p);
          const cap = projectRemaining(p) - (already ? already.minutes : 0);
          const take = Math.min(left, cap);
          if (take >= 10) {
            if (already) already.minutes += take;
            else projectBlocks.push({ activity: p, minutes: take });
            left -= take;
          }
        });
    }

    const actBlocks = left > 0 && state.activities.length ? planAllocation(left) : [];

    // With enough focus data, order the activity part around how you focus
    // at this hour: hardest first in your best hours, easiest in your worst.
    const bands = focusBands();
    let orderNote = '';
    if (bands && actBlocks.length > 1 && actBlocks.some(b => activityFocusAvg(b.activity.id) !== null)) {
      const nowBand = bandOf(new Date().getHours());
      const avgOf = b => {
        const a = activityFocusAvg(b.activity.id);
        return a === null ? 2.5 : a;
      };
      if (nowBand.key === bands.best.key) {
        actBlocks.sort((a, b) => avgOf(a) - avgOf(b));
        orderNote = `You're usually most locked in ${nowBand.label}, so the plan starts with what you find hardest to focus on.`;
      } else if (nowBand.key === bands.worst.key) {
        actBlocks.sort((a, b) => avgOf(b) - avgOf(a));
        orderNote = `Your focus usually dips ${nowBand.label}, so the plan starts with what you focus on best.`;
      }
    }

    const blocks = [...projectBlocks, ...actBlocks];
    if (!blocks.length) {
      recBox.innerHTML = `<p class="rec-reason">Couldn't build a plan — add activities or a project.</p>`;
      return;
    }

    const headline = document.createElement('div');
    headline.className = 'rec-headline';
    headline.textContent = `Your plan for ${fmtDuration(X)}`;

    const reason = document.createElement('p');
    reason.className = 'rec-reason';
    reason.textContent = projectBlocks.length
      ? 'Deadline work comes off the top; the rest brings your activities toward their targets.'
      : blocks.length === 1
        ? 'One activity is far enough behind that it deserves the whole block.'
        : 'Start with what is furthest behind; the sizes bring everything toward its target.';

    const planBar = document.createElement('div');
    planBar.className = 'plan-bar';
    blocks.forEach(b => {
      const seg = document.createElement('div');
      seg.style.flexGrow = b.minutes;
      seg.style.background = colorFor(b.activity);
      attachTooltip(seg, () => `${b.activity.name} — ${fmtDuration(b.minutes)}`);
      planBar.appendChild(seg);
    });

    const list = document.createElement('ol');
    list.className = 'plan-list';
    blocks.forEach(b => {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = colorFor(b.activity);
      const name = document.createElement('span');
      name.className = 'plan-name';
      name.textContent = b.activity.name;
      const mins = document.createElement('span');
      mins.className = 'plan-mins';
      mins.textContent = fmtDuration(b.minutes);
      li.append(sw, name, mins);
      list.appendChild(li);
    });

    const actions = document.createElement('div');
    actions.className = 'rec-actions';
    actions.append(
      makeStartTimerButton(blocks[0].activity, `Start timer on ${blocks[0].activity.name}`),
      makeLogButton(blocks, 'Log the whole plan')
    );

    recBox.append(headline, reason, planBar, list);
    if (orderNote) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.style.marginBottom = '12px';
      note.textContent = orderNote;
      recBox.appendChild(note);
    }
    recBox.appendChild(actions);
  }

  function makeStartTimerButton(act, label) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = label || 'Start timer';
    btn.addEventListener('click', () => {
      timerActivity.value = act.id;
      startTimer();
      $('timer-section').scrollIntoView({ behavior: 'smooth' });
    });
    return btn;
  }

  function makeLogButton(blocks, label) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const ids = blocks.map(b => addSession(b.activity.id, b.minutes).id);
      const total = blocks.reduce((a, b) => a + b.minutes, 0);
      showToast(`Logged ${fmtDuration(total)} across ${blocks.length} ${blocks.length === 1 ? 'activity' : 'activities'}`);
      renderRecommendation();
      askFocus(ids);
    });
    return btn;
  }

  // A deadline project that hasn't met today's pace outranks activities.
  function projectClaims(up) {
    return up && todayLoggedFor(up.p.id) < up.pace;
  }

  function renderProjectRecommendation(up, minutes) {
    const { p, pace, rem, overdue } = up;

    const headline = document.createElement('div');
    headline.className = 'rec-headline';
    const sw = document.createElement('span');
    sw.className = 'rec-swatch';
    sw.style.background = 'var(--accent)';
    headline.append(sw, document.createTextNode(p.name));

    const reason = document.createElement('p');
    reason.className = 'rec-reason';
    reason.textContent = overdue
      ? `This project is overdue — ${fmtDuration(rem)} still needed. Clear it before anything else.`
      : `Deadline first: it needs about ${fmtDuration(pace)} per day to finish on time (${fmtDuration(rem)} to go, ${dueText(p)}).`;

    const duration = document.createElement('p');
    duration.className = 'rec-duration';
    duration.innerHTML = `Suggested: about <strong>${fmtDuration(minutes)}</strong> on it now.`;

    const actions = document.createElement('div');
    actions.className = 'rec-actions';
    actions.append(
      makeStartTimerButton(p),
      makeLogButton([{ activity: p, minutes }], `Log ${fmtDuration(minutes)} now`)
    );

    recBox.append(headline, reason, duration, actions);
  }

  // A project that has met today's pace is still a normal suggestion —
  // working ahead, just without deadline urgency.
  function renderProjectAhead(up, minutes) {
    const { p, rem } = up;

    const headline = document.createElement('div');
    headline.className = 'rec-headline';
    const sw = document.createElement('span');
    sw.className = 'rec-swatch';
    sw.style.background = 'var(--accent)';
    headline.append(sw, document.createTextNode(p.name));

    const reason = document.createElement('p');
    reason.className = 'rec-reason';
    reason.textContent = `You're on pace for today — get ahead while you can: ${fmtDuration(rem)} to go, ${dueText(p)}.`;

    const duration = document.createElement('p');
    duration.className = 'rec-duration';
    duration.innerHTML = `Suggested: about <strong>${fmtDuration(minutes)}</strong> on it.`;

    const actions = document.createElement('div');
    actions.className = 'rec-actions';
    actions.append(
      makeStartTimerButton(p),
      makeLogButton([{ activity: p, minutes }], `Log ${fmtDuration(minutes)} now`)
    );

    recBox.append(headline, reason, duration, actions);
  }

  function renderOpenRecommendation() {
    const up = urgentProject();
    if (projectClaims(up)) {
      const sug = Math.min(up.rem, Math.max(15, Math.min(180, Math.round(up.pace - todayLoggedFor(up.p.id)))));
      renderProjectRecommendation(up, sug);
      return;
    }
    if (state.activities.length === 0) {
      if (up) {
        renderProjectAhead(up, Math.min(up.rem, 60));
        return;
      }
      recBox.innerHTML = `<p class="rec-reason">Add some activities or a project first, then ask again!</p>`;
      return;
    }

    const rec = recommend();
    const { totalMins } = computeStats();
    const act = rec.activity;

    const headline = document.createElement('div');
    headline.className = 'rec-headline';
    const sw = document.createElement('span');
    sw.className = 'rec-swatch';
    sw.style.background = colorOf(act);
    headline.append(sw, document.createTextNode(act.name));

    const reason = document.createElement('p');
    reason.className = 'rec-reason';
    const targetPctDisplay = displayPercents()[act.id];
    if (rec.firstTime || totalMins === 0) {
      reason.textContent = `Nothing tracked yet in this period, so start with your biggest priority (${targetPctDisplay}% target).`;
    } else {
      const actualPct = Math.round(rec.actualShare * 100);
      const targetPct = targetPctDisplay;
      reason.textContent = actualPct < targetPct
        ? `You've spent ${actualPct}% of your tracked free time on this — your target is ${targetPct}%, so it's the furthest behind.`
        : `Everything is at or above target — this one benefits most from more time right now.`;
    }

    const duration = document.createElement('p');
    duration.className = 'rec-duration';
    duration.innerHTML = `Suggested: about <strong>${fmtDuration(rec.suggested)}</strong> to get back on target.`;

    const actions = document.createElement('div');
    actions.className = 'rec-actions';

    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary';
    startBtn.textContent = 'Start timer';
    startBtn.addEventListener('click', () => {
      timerActivity.value = act.id;
      startTimer();
      $('timer-section').scrollIntoView({ behavior: 'smooth' });
    });

    const logBtn = document.createElement('button');
    logBtn.className = 'btn btn-ghost';
    logBtn.textContent = `Log ${fmtDuration(rec.suggested)} now`;
    logBtn.addEventListener('click', () => {
      const session = addSession(act.id, rec.suggested);
      showToast(`Logged ${fmtDuration(rec.suggested)} of ${act.name}`);
      renderRecommendation();
      askFocus([session.id]);
    });

    actions.append(startBtn, logBtn);
    recBox.append(headline, reason, duration, actions);
  }

  // ---------- Activity CRUD ----------

  // A new activity claims an equal share (100/n), funded evenly by the
  // existing UNLOCKED activities so ratios and locks are preserved.
  function addActivity(name) {
    const n = state.activities.length + 1;
    const act = { id: uid(), name, targetPercent: 100 / n, createdAt: Date.now() };
    if (state.activities.length > 0) {
      const vals = state.activities.map(a => a.targetPercent);
      const idxs = vals.map((_, i) => i).filter(i => !state.activities[i].locked);
      const floor = Math.min(MIN_SHARE, 100 / n);
      act.targetPercent = takeEvenly(vals, idxs, 100 / n, floor);
      state.activities.forEach((a, i) => { a.targetPercent = vals[i]; });
      if (act.targetPercent < 1e-9 && idxs.length === 0) {
        showToast('All other activities are locked — unlock one to give the new activity time.');
      }
    }
    state.activities.push(act);
    save();
    render();
  }

  async function editActivity(act) {
    const name = await themedPrompt('Rename activity', act.name);
    if (name === null || !name.trim()) return;
    act.name = name.trim();
    save();
    render();
  }

  async function deleteActivity(act) {
    const n = state.sessions.filter(s => s.activityId === act.id).length;
    const msg = n
      ? `Delete "${act.name}" and its ${n} logged session${n === 1 ? '' : 's'}?`
      : `Delete "${act.name}"?`;
    if (!(await themedConfirm(msg, { title: 'Delete activity', confirmLabel: 'Delete', danger: true }))) return;
    state.activities = state.activities.filter(a => a.id !== act.id);
    state.sessions = state.sessions.filter(s => s.activityId !== act.id);
    // Hand the freed share evenly to the unlocked survivors.
    if (state.activities.length > 0) {
      const freed = 100 - state.activities.reduce((a, x) => a + x.targetPercent, 0);
      const unlocked = state.activities.filter(a => !a.locked);
      const pool = unlocked.length ? unlocked : state.activities;
      pool.forEach(a => { a.targetPercent += freed / pool.length; });
    }
    save();
    render();
  }

  function addSession(activityId, minutes) {
    const session = { id: uid(), activityId, minutes, timestamp: Date.now() };
    state.sessions.push(session);
    save();
    render();
    return session;
  }

  // ---------- Focus rating ----------

  let focusPendingIds = null;

  function askFocus(sessionIds) {
    focusPendingIds = sessionIds;
    focusOverlay.hidden = false;
  }

  function resolveFocus(level) {
    const ids = focusPendingIds;
    focusPendingIds = null;
    focusOverlay.hidden = true;
    if (!level || !ids) return;
    ids.forEach(id => {
      const s = state.sessions.find(x => x.id === id);
      if (s) s.focus = level;
    });
    save();
    render();
    maybeNudge(level, ids);
  }

  // Two distracted sessions of the same activity in a row earns a nudge.
  function maybeNudge(level, ids) {
    if (level !== 1 || !ids.length) return;
    const s = state.sessions.find(x => x.id === ids[0]);
    if (!s) return;
    const prev = state.sessions
      .filter(x => x.activityId === s.activityId && x.focus && x.id !== s.id && x.timestamp <= s.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (prev && prev.focus === 1) {
      const act = state.activities.find(a => a.id === s.activityId);
      setTimeout(() => showToast(`Two distracted ${act ? act.name + ' ' : ''}sessions in a row — maybe switch to something else for a while?`), 900);
    }
  }

  // ---------- Timer ----------

  function getTimer() {
    try {
      const raw = localStorage.getItem(TIMER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function startTimer() {
    if (!timerActivity.value) {
      showToast('Add an activity first.');
      return;
    }
    localStorage.setItem(TIMER_KEY, JSON.stringify({
      activityId: timerActivity.value,
      startedAt: Date.now(),
    }));
    syncTimerUI();
  }

  function stopTimer() {
    const t = getTimer();
    localStorage.removeItem(TIMER_KEY);
    syncTimerUI();
    if (!t) return;
    const minutes = Math.round((Date.now() - t.startedAt) / 60000);
    if (minutes < 1) {
      showToast('Less than a minute — not logged.');
      return;
    }
    const act = state.activities.find(a => a.id === t.activityId);
    const session = addSession(t.activityId, minutes);
    showToast(`Logged ${fmtDuration(minutes)}${act ? ` of ${act.name}` : ''}`);
    askFocus([session.id]);
  }

  function cancelTimer() {
    localStorage.removeItem(TIMER_KEY);
    syncTimerUI();
  }

  function syncTimerUI() {
    const t = getTimer();
    clearInterval(timerInterval);

    if (t) {
      timerToggle.textContent = 'Stop & log';
      timerDisplay.hidden = false;
      timerCancel.hidden = false;
      timerActivity.value = t.activityId;
      timerActivity.disabled = true;
      const tick = () => {
        const secs = Math.floor((Date.now() - t.startedAt) / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        timerDisplay.textContent = `${m}:${String(s).padStart(2, '0')}`;
      };
      tick();
      timerInterval = setInterval(tick, 1000);
    } else {
      timerToggle.textContent = 'Start';
      timerDisplay.hidden = true;
      timerCancel.hidden = true;
      timerActivity.disabled = false;
    }
  }

  // ---------- Themed dialogs (replace native confirm/prompt) ----------

  function showDialog({ title, message, input, defaultValue = '', confirmLabel = 'OK', danger = false }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';

      if (title) {
        const h = document.createElement('h3');
        h.className = 'modal-title';
        h.textContent = title;
        dialog.appendChild(h);
      }
      if (message) {
        const p = document.createElement('p');
        p.className = 'modal-message';
        p.textContent = message;
        dialog.appendChild(p);
      }

      let field = null;
      if (input) {
        field = document.createElement('input');
        field.type = 'text';
        field.maxLength = 40;
        field.value = defaultValue;
        dialog.appendChild(field);
      }

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = 'Cancel';
      const okBtn = document.createElement('button');
      okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
      okBtn.textContent = confirmLabel;
      actions.append(cancelBtn, okBtn);
      dialog.appendChild(actions);

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const close = result => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      };
      const cancel = () => close(input ? null : false);
      const ok = () => close(input ? field.value : true);
      const onKey = e => {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter' && input) ok();
      };

      okBtn.addEventListener('click', ok);
      cancelBtn.addEventListener('click', cancel);
      overlay.addEventListener('click', e => { if (e.target === overlay) cancel(); });
      document.addEventListener('keydown', onKey);

      if (field) {
        field.focus();
        field.select();
      } else {
        okBtn.focus();
      }
    });
  }

  const themedConfirm = (message, opts = {}) => showDialog({ message, ...opts });
  const themedPrompt = (title, defaultValue) =>
    showDialog({ title, input: true, defaultValue, confirmLabel: 'Save' });

  // ---------- Tooltip & toast ----------

  function attachTooltip(el, getText) {
    el.addEventListener('mousemove', e => {
      tooltip.textContent = getText();
      tooltip.hidden = false;
      const pad = 12;
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      const rect = tooltip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
      if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    });
    el.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  let toastTimeout = null;
  let toastHideTimeout = null;
  function showToast(msg) {
    clearTimeout(toastTimeout);
    clearTimeout(toastHideTimeout);
    toast.textContent = msg;
    toast.hidden = false;
    void toast.offsetWidth; // let the hidden->visible frame land so the fade runs
    toast.classList.add('show');
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      toastHideTimeout = setTimeout(() => { toast.hidden = true; }, 400);
    }, 4000);
  }

  // ---------- Export / import ----------

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'time-allocator-data.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.activities) || !Array.isArray(parsed.sessions)) {
          throw new Error('bad shape');
        }
      } catch (e) {
        showToast("Couldn't read that file — is it a Time Allocator export?");
        return;
      }
      if (!(await themedConfirm('Replace your current data with the imported file?', { title: 'Import data', confirmLabel: 'Replace', danger: true }))) return;
      normalizeTargets(parsed.activities);
      if (typeof parsed.unlocked !== 'object' || !parsed.unlocked) parsed.unlocked = {};
      if (typeof parsed.settings !== 'object' || !parsed.settings) parsed.settings = {};
      state = parsed;
      save();
      render();
      showToast('Data imported.');
    };
    reader.readAsText(file);
  }

  // ---------- Events ----------

  askBtn.addEventListener('click', renderRecommendation);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { location.hash = btn.dataset.page; });
  });
  window.addEventListener('hashchange', () => showPage(pageFromHash()));

  focusOverlay.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => resolveFocus(parseInt(btn.dataset.focus, 10)));
  });
  $('focus-skip').addEventListener('click', () => resolveFocus(null));
  focusOverlay.addEventListener('click', e => {
    if (e.target === focusOverlay) resolveFocus(null);
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
      fixedControls.hidden = mode !== 'fixed';
      if (!recBox.classList.contains('hidden')) renderRecommendation();
    });
  });

  for (const el of [haveHours, haveMins, splitToggle]) {
    el.addEventListener('input', () => {
      if (!recBox.classList.contains('hidden')) renderRecommendation();
    });
  }

  activityForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    addActivity(name);
    newName.value = '';
    newName.focus();
  });

  projectForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = projName.value.trim();
    const hours = parseFloat(projHours.value);
    const days = parseInt(projDays.value, 10);
    if (!name || !(hours > 0) || !(days >= 1)) return;
    state.projects.push({
      id: uid(),
      name,
      neededMinutes: Math.round(hours * 60),
      deadline: Date.now() + days * 86400000,
      createdAt: Date.now(),
    });
    save();
    render();
    projName.value = '';
    projHours.value = '';
    projDays.value = '';
    showToast(`Project added — about ${fmtDuration(Math.round(hours * 60 / days))}/day to finish in time.`);
  });

  logForm.addEventListener('submit', e => {
    e.preventDefault();
    const mins = parseInt(logMinutes.value, 10);
    if (!logActivity.value || !(mins >= 1)) return;
    const session = addSession(logActivity.value, mins);
    const act = state.activities.find(a => a.id === logActivity.value);
    showToast(`Logged ${fmtDuration(mins)}${act ? ` of ${act.name}` : ''}`);
    logMinutes.value = '';
    askFocus([session.id]);
  });

  quickChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || !logActivity.value) return;
    const mins = parseInt(chip.dataset.min, 10);
    const session = addSession(logActivity.value, mins);
    const act = state.activities.find(a => a.id === logActivity.value);
    showToast(`Logged ${fmtDuration(mins)}${act ? ` of ${act.name}` : ''}`);
    askFocus([session.id]);
  });

  timerToggle.addEventListener('click', () => {
    if (getTimer()) stopTimer(); else startTimer();
  });
  timerCancel.addEventListener('click', cancelTimer);

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      range = btn.dataset.range;
      renderBalance();
      if (!recBox.classList.contains('hidden')) renderRecommendation();
    });
  });

  focusWeightToggle.addEventListener('change', () => {
    state.settings.focusWeighted = focusWeightToggle.checked;
    save();
    renderBalance();
    if (!recBox.classList.contains('hidden')) renderRecommendation();
  });

  $('export-btn').addEventListener('click', exportData);

  $('delete-btn').addEventListener('click', async () => {
    const n = state.sessions.length;
    const msg = `Delete ALL data — ${state.activities.length} activities, ${n} logged session${n === 1 ? '' : 's'}, and every achievement? This cannot be undone. (You can Export first to keep a backup.)`;
    if (!(await themedConfirm(msg, { title: 'Delete all data', confirmLabel: 'Delete everything', danger: true }))) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TIMER_KEY);
    state = { activities: [], sessions: [], unlocked: {}, settings: {} };
    focusWeightToggle.checked = false;
    syncTimerUI();
    render();
    showToast('All data deleted.');
  });
  $('import-input').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // ---------- Init ----------

  focusWeightToggle.checked = !!state.settings.focusWeighted;
  checkAchievements(true); // no toast spam for badges earned before this visit
  render();
  syncTimerUI();
  showPage(pageFromHash());
})();
