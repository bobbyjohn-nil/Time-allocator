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
  let timerInterval = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.activities) && Array.isArray(parsed.sessions)) {
          normalizeTargets(parsed.activities);
          return parsed;
        }
      }
    } catch (e) { /* corrupted storage falls through to fresh state */ }
    return { activities: [], sessions: [] };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Target percentages ----------
  // Targets are stored as floats that always sum to 100; sliders redistribute
  // the remainder proportionally across the other activities.

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

  // ---------- Stats & recommendation ----------

  // Returns per-activity stats over the current range, with targets normalized
  // so they always behave proportionally even if they don't sum to 100.
  function computeStats() {
    const sessions = windowSessions();
    const totalMins = sessions.reduce((a, s) => a + s.minutes, 0);
    const targetSum = state.activities.reduce((a, x) => a + x.targetPercent, 0);

    const stats = state.activities.map(act => {
      const spent = sessions
        .filter(s => s.activityId === act.id)
        .reduce((a, s) => a + s.minutes, 0);
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

  // ---------- DOM refs ----------

  const $ = id => document.getElementById(id);
  const askBtn = $('ask-btn');
  const recBox = $('recommendation');
  const activityList = $('activity-list');
  const targetTotal = $('target-total');
  const activityForm = $('activity-form');
  const newName = $('new-name');
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
  const tooltip = $('tooltip');
  const toast = $('toast');

  // ---------- Rendering ----------

  function render() {
    renderActivities();
    renderSelects();
    renderBalance();
    renderHistory();
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
    const labelPcts = {};

    function refreshPcts() {
      const p = displayPercents();
      state.activities.forEach(a => {
        segEls[a.id].style.flexGrow = a.targetPercent;
        labelCells[a.id].style.flexGrow = a.targetPercent;
        segLabels[a.id].textContent = `${p[a.id]}%`;
        labelPcts[a.id].textContent = `${p[a.id]}%`;
      });
      fitSegLabels();
    }

    // Only show a segment's % label when it actually fits inside the segment.
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
      });
    }

    // Dragging the divider between two neighbors trades share between
    // them only; everything else stays put, so the bar stays at 100%.
    function wireHandle(handle, a, b, bar) {
      const apply = (aVal, combined) => {
        a.targetPercent = Math.max(0, Math.min(combined, aVal));
        b.targetPercent = combined - a.targetPercent;
        refreshPcts();
      };
      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        const startX = e.clientX;
        const aStart = a.targetPercent;
        const combined = a.targetPercent + b.targetPercent;
        const width = bar.getBoundingClientRect().width;
        const move = ev => apply(aStart + ((ev.clientX - startX) / width) * 100, combined);
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
        apply(a.targetPercent + step, a.targetPercent + b.targetPercent);
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
        wireHandle(handle, prev, act, bar);
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

      const meta = document.createElement('span');
      meta.className = 'alloc-label-meta';
      const pct = document.createElement('span');
      labelPcts[act.id] = pct;

      const del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.title = `Delete ${act.name}`;
      del.textContent = '✕';
      del.addEventListener('click', () => deleteActivity(act));

      meta.append(pct, del);
      cell.append(name, meta);
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
      state.activities.forEach(act => {
        const opt = document.createElement('option');
        opt.value = act.id;
        opt.textContent = act.name;
        sel.appendChild(opt);
      });
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }
  }

  function renderBalance() {
    const { stats, totalMins } = computeStats();
    balanceChart.innerHTML = '';

    if (stats.length === 0) {
      balanceSummary.textContent = 'Add some activities to see your balance.';
      return;
    }

    const rangeLabel = range === 'week' ? 'this week' : range === '7d' ? 'in the last 7 days' : 'in total';
    balanceSummary.textContent = totalMins === 0
      ? `Nothing tracked ${rangeLabel} yet.`
      : `${fmtDuration(totalMins)} of free time tracked ${rangeLabel}.`;

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

      const values = document.createElement('span');
      values.className = 'balance-values';
      if (totalMins === 0) {
        values.textContent = `target ${targetPct}%`;
      } else {
        const diff = actualPct - targetPct;
        const status = diff >= 0 ? `<span class="ahead">on track</span>` : `${targetPct - actualPct}pt behind`;
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
    const recent = [...state.sessions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 25);
    historyEmpty.style.display = recent.length ? 'none' : '';

    recent.forEach(s => {
      const act = state.activities.find(a => a.id === s.activityId);
      const li = document.createElement('li');
      li.className = 'history-item';

      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = act ? colorOf(act) : 'var(--series-other)';

      const name = document.createElement('span');
      name.textContent = act ? act.name : '(deleted activity)';

      const mins = document.createElement('span');
      mins.className = 'history-mins';
      mins.textContent = fmtDuration(s.minutes);

      const when = document.createElement('span');
      when.className = 'history-when';
      when.textContent = fmtWhen(s.timestamp);

      const del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.title = 'Delete session';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        state.sessions = state.sessions.filter(x => x.id !== s.id);
        save();
        render();
      });

      li.append(sw, name, mins, when, del);
      historyList.appendChild(li);
    });
  }

  function renderRecommendation() {
    const rec = recommend();
    recBox.classList.remove('hidden');
    recBox.innerHTML = '';

    if (!rec) {
      recBox.innerHTML = `<p class="rec-reason">Add some activities first, then ask again!</p>`;
      return;
    }

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
      addSession(act.id, rec.suggested);
      showToast(`Logged ${fmtDuration(rec.suggested)} of ${act.name}`);
      renderRecommendation();
    });

    actions.append(startBtn, logBtn);
    recBox.append(headline, reason, duration, actions);
  }

  // ---------- Activity CRUD ----------

  // New activities start with an equal share of everything.
  function addActivity(name) {
    state.activities.push({ id: uid(), name, targetPercent: 0, createdAt: Date.now() });
    state.activities.forEach(a => { a.targetPercent = 100 / state.activities.length; });
    save();
    render();
  }

  function editActivity(act) {
    const name = prompt('Activity name:', act.name);
    if (name === null || !name.trim()) return;
    act.name = name.trim();
    save();
    render();
  }

  function deleteActivity(act) {
    const n = state.sessions.filter(s => s.activityId === act.id).length;
    const msg = n
      ? `Delete "${act.name}" and its ${n} logged session${n === 1 ? '' : 's'}?`
      : `Delete "${act.name}"?`;
    if (!confirm(msg)) return;
    state.activities = state.activities.filter(a => a.id !== act.id);
    state.sessions = state.sessions.filter(s => s.activityId !== act.id);
    normalizeTargets(state.activities);
    save();
    render();
  }

  function addSession(activityId, minutes) {
    state.sessions.push({ id: uid(), activityId, minutes, timestamp: Date.now() });
    save();
    render();
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
    addSession(t.activityId, minutes);
    showToast(`Logged ${fmtDuration(minutes)}${act ? ` of ${act.name}` : ''}`);
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
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 2500);
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
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.activities) || !Array.isArray(parsed.sessions)) {
          throw new Error('bad shape');
        }
        if (!confirm('Replace your current data with the imported file?')) return;
        normalizeTargets(parsed.activities);
        state = parsed;
        save();
        render();
        showToast('Data imported.');
      } catch (e) {
        showToast("Couldn't read that file — is it a Time Allocator export?");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Events ----------

  askBtn.addEventListener('click', renderRecommendation);

  activityForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    addActivity(name);
    newName.value = '';
    newName.focus();
  });

  logForm.addEventListener('submit', e => {
    e.preventDefault();
    const mins = parseInt(logMinutes.value, 10);
    if (!logActivity.value || !(mins >= 1)) return;
    addSession(logActivity.value, mins);
    const act = state.activities.find(a => a.id === logActivity.value);
    showToast(`Logged ${fmtDuration(mins)}${act ? ` of ${act.name}` : ''}`);
    logMinutes.value = '';
  });

  quickChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || !logActivity.value) return;
    const mins = parseInt(chip.dataset.min, 10);
    addSession(logActivity.value, mins);
    const act = state.activities.find(a => a.id === logActivity.value);
    showToast(`Logged ${fmtDuration(mins)}${act ? ` of ${act.name}` : ''}`);
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

  $('export-btn').addEventListener('click', exportData);
  $('import-input').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // ---------- Init ----------

  render();
  syncTimerUI();
})();
