/* ============================================================
   Gym Tracker — local-first, single-file logic (vanilla JS)
   Modes: Train · Progress · Build · Settings
   Storage: localStorage (+ optional GitHub sync)
   ============================================================ */

'use strict';

const STORE_KEY = 'gymtracker.v1';
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/* ---------- date helpers (local-time safe) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = s => parseYmd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateFull = s => parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/* ---------- state ---------- */
let state = load();
let route = { tab: 'train' };

function defaults() {
  const start = todayStr();
  const mk = (name, type, muscle) => ({ id: uid(), name, type, muscle });
  const ex = {
    bench:  mk('Bench Press', 'lifting', 'Chest'),
    ohp:    mk('Overhead Press', 'lifting', 'Shoulders'),
    incline:mk('Incline DB Press', 'lifting', 'Chest'),
    pushd:  mk('Triceps Pushdown', 'lifting', 'Triceps'),
    squat:  mk('Back Squat', 'lifting', 'Legs'),
    dead:   mk('Deadlift', 'lifting', 'Back'),
    row:    mk('Barbell Row', 'lifting', 'Back'),
    pull:   mk('Pull-up', 'lifting', 'Back'),
    curl:   mk('Barbell Curl', 'lifting', 'Biceps'),
    run:    mk('Running', 'cardio', 'Cardio'),
  };
  return {
    version: 1,
    settings: {
      units: 'kg',
      cycleStartDate: start,
      cycleLengthDays: 8,
      github: { owner: '', repo: '', path: '', branch: 'main', token: '', user: '' },
    },
    exercises: Object.values(ex),
    workouts: [
      { id: uid(), name: 'Push', items: [
        { exerciseId: ex.bench.id, sets: 4 },
        { exerciseId: ex.ohp.id, sets: 3 },
        { exerciseId: ex.incline.id, sets: 3 },
        { exerciseId: ex.pushd.id, sets: 3 },
      ]},
      { id: uid(), name: 'Pull', items: [
        { exerciseId: ex.dead.id, sets: 3 },
        { exerciseId: ex.row.id, sets: 4 },
        { exerciseId: ex.pull.id, sets: 3 },
        { exerciseId: ex.curl.id, sets: 3 },
      ]},
      { id: uid(), name: 'Legs', items: [
        { exerciseId: ex.squat.id, sets: 4 },
      ]},
    ],
    sessions: [],
    supersets: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaults();
    const s = JSON.parse(raw);
    // shallow-heal missing pieces
    s.settings = Object.assign({}, defaults().settings, s.settings);
    s.settings.github = Object.assign({}, defaults().settings.github, s.settings.github || {});
    s.exercises = s.exercises || [];
    s.workouts = s.workouts || [];
    s.sessions = s.sessions || [];
    s.supersets = s.supersets || [];
    return s;
  } catch (e) {
    console.warn('load failed, using defaults', e);
    return defaults();
  }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Could not save locally'); console.error(e); }
  maybeAutoPush();
}

/* ---------- lookups ---------- */
const exById = id => state.exercises.find(e => e.id === id);
const woById = id => state.workouts.find(w => w.id === id);
const ssById = id => (state.supersets || []).find(s => s.id === id);
const supersetName = ss => ss.name || (ss.components || []).map(c => (exById(c.exerciseId) || {}).name).filter(Boolean).join(' + ');
const unit = () => state.settings.units;

function sessionsSorted() {
  return [...state.sessions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function setsVolume(sets) { let v = 0; for (const st of (sets || [])) v += (+st.weight || 0) * (+st.reps || 0); return v; }
function sessionVolume(sess) {
  let v = 0;
  for (const e of sess.entries) {
    if (e.type === 'cardio') continue;
    if (e.type === 'superset') { for (const c of (e.components || [])) v += setsVolume(c.sets); continue; }
    v += setsVolume(e.sets);
  }
  return v;
}
function epley(w, r) { return (+w || 0) * (1 + (+r || 0) / 30); }

/* ---------- cycles ---------- */
const cycleLen = () => state.settings.cycleLengthDays || 8;
function cycleIndexOf(dateStr) {
  return Math.floor(dayDiff(state.settings.cycleStartDate, dateStr) / cycleLen());
}
function cycleRange(idx) {
  const s = addDays(state.settings.cycleStartDate, idx * cycleLen());
  return { index: idx, start: s, end: addDays(s, cycleLen() - 1) };
}
const currentCycleIndex = () => cycleIndexOf(todayStr());

function cycleVolume(idx) {
  return state.sessions
    .filter(s => cycleIndexOf(s.date) === idx)
    .reduce((sum, s) => sum + sessionVolume(s), 0);
}
function cycleSessionCount(idx) {
  return state.sessions.filter(s => cycleIndexOf(s.date) === idx).length;
}

/* ---------- PRs / exercise history ---------- */
function exerciseSetsHistory(exId) {
  // returns [{date, sets:[{weight,reps}], topWeight, best1rm, volume}] newest first
  const out = [];
  for (const s of state.sessions) {
    for (const e of s.entries) {
      if (e.exerciseId !== exId || e.type === 'cardio') continue;
      const sets = e.sets.filter(st => (+st.weight || 0) > 0 || (+st.reps || 0) > 0);
      if (!sets.length) continue;
      const topWeight = Math.max(...sets.map(st => +st.weight || 0));
      // RIR counts as reps left in the tank → effective reps for the 1RM estimate
      const best1rm = Math.max(...sets.map(st => epley(st.weight, (+st.reps || 0) + (+st.rir || 0))));
      const volume = sets.reduce((a, st) => a + (+st.weight || 0) * (+st.reps || 0), 0);
      out.push({ date: s.date, sets, topWeight, best1rm, volume });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
function prsFor(exId) {
  const h = exerciseSetsHistory(exId);
  if (!h.length) return null;
  return {
    topWeight: Math.max(...h.map(x => x.topWeight)),
    best1rm: Math.max(...h.map(x => x.best1rm)),
    bestVolume: Math.max(...h.map(x => x.volume)),
  };
}
function lastSetsForExercise(exId, beforeDate) {
  const h = exerciseSetsHistory(exId).filter(x => !beforeDate || x.date < beforeDate);
  return h.length ? h[0].sets : null;
}
// Full last-time record for an exercise: sets (with rir/fb) + the note you left yourself.
function lastEntryForExercise(exId, beforeDate) {
  for (const s of sessionsSorted()) {
    if (beforeDate && !(s.date < beforeDate)) continue;
    const e = s.entries.find(en => en.exerciseId === exId && en.type !== 'cardio');
    if (e && e.sets && e.sets.length) return { date: s.date, sets: e.sets, note: e.note };
  }
  return null;
}
// Supersets are tracked as their own entity (superset context changes performance).
function supersetHistory(supersetId) {
  const out = [];
  for (const s of sessionsSorted()) {
    const e = s.entries.find(en => en.type === 'superset' && en.supersetId === supersetId);
    if (e) out.push({ date: s.date, components: e.components || [] });
  }
  return out; // newest first
}
function lastSupersetEntry(supersetId, beforeDate) {
  const h = supersetHistory(supersetId).filter(x => !beforeDate || x.date < beforeDate);
  return h.length ? h[0] : null;
}

/* ============================================================
   RENDER
   ============================================================ */
const view = () => $('#view');

function render() {
  const v = view();
  v.scrollTop = 0;
  // the rest bar only lives inside an active workout
  if (typeof stopRest === 'function' && !(route.tab === 'train' && route.workoutId)) stopRest();
  // tabbar active state
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === route.tab));
  // header cycle chip
  const ci = currentCycleIndex();
  const dayInCycle = dayDiff(cycleRange(ci).start, todayStr()) + 1;
  $('#cycle-chip').textContent = `Cycle ${ci + 1} · day ${dayInCycle}/${cycleLen()}`;

  if (route.tab === 'train')    return route.workoutId ? renderSession(v) : renderTrainList(v);
  if (route.tab === 'progress') return route.supersetId ? renderSupersetDetail(v) : route.exerciseId ? renderExerciseDetail(v) : renderProgress(v);
  if (route.tab === 'build')    return route.workoutId ? renderWorkoutEditor(v) : renderBuild(v);
  if (route.tab === 'settings') return renderSettings(v);
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- TRAIN: list of workouts ---------------- */
function renderTrainList(v) {
  if (!state.workouts.length) {
    v.innerHTML = `<h1 class="page-title">Train</h1>` + emptyState('🛠️', 'No workouts yet', 'Head to Build to create your first workout.', 'Go to Build', 'build');
    return;
  }
  const cards = state.workouts.map(w => `<button class="tile" data-action="open-workout" data-id="${w.id}">
      <span class="emoji-badge">🏋️</span>
      <span class="grow"><span class="tile-title">${esc(w.name)}</span></span>
      <span class="tile-chev">›</span>
    </button>`).join('');
  v.innerHTML = `<h1 class="page-title">Train</h1><div class="list">${cards}</div>`;
}

/* ---------------- TRAIN: log a session ----------------
   The live session is a "draft" held in route._draft. Inputs write straight
   into the draft (see the input listener), so values survive +/- set and
   toggles without a re-read. Prefill = last session's real, editable numbers. */
/* ---------- rest targets ---------- */
const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const REST_OPTS = [0, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300];
const restLabel = s => s ? fmtClock(s) : 'Off';

function draftSetsFor(exId, n, date) {
  const last = lastSetsForExercise(exId, date);
  return Array.from({ length: n }, (_, i) => {
    const lp = last && last[i] ? last[i] : null;
    return { weight: lp ? lp.weight : '', reps: lp ? lp.reps : '', rir: lp ? (lp.rir ?? 0) : 0 };
  });
}
// Build one draft exercise (used by buildDraft, swap, and add-exercise). nOverride fixes the set count (Build plan); otherwise use last session's count, else 3.
function draftExercise(exId, date, nOverride) {
  const ex = exById(exId);
  if (ex.type === 'cardio') {
    const lp = (lastSetsForExercise(exId, date) || [])[0] || {};
    return { exId, name: ex.name, type: 'cardio', note: '', cardio: { duration: lp.duration ?? '', distance: lp.distance ?? '' } };
  }
  const le = lastEntryForExercise(exId, date);
  const n = nOverride || (le ? le.sets.length : 3) || 3;
  return { exId, name: ex.name, type: 'lifting', note: '', sets: draftSetsFor(exId, n, date) };
}
function supersetSetsFor(supersetId, exerciseId, rounds, date) {
  const le = lastSupersetEntry(supersetId, date);
  const comp = le && (le.components || []).find(c => c.exerciseId === exerciseId);
  const lastSets = comp ? comp.sets : null;
  return Array.from({ length: rounds }, (_, i) => {
    const lp = lastSets && lastSets[i] ? lastSets[i] : null;
    return { weight: lp ? lp.weight : '', reps: lp ? lp.reps : '', rir: lp ? (lp.rir ?? 0) : 0 };
  });
}
function draftSuperset(ss, rounds, date) {
  const components = (ss.components || []).map(c => {
    const ex = exById(c.exerciseId);
    return { exerciseId: c.exerciseId, name: ex ? ex.name : '?', rest: c.rest || 0,
      sets: supersetSetsFor(ss.id, c.exerciseId, rounds, date) };
  });
  return { type: 'superset', supersetId: ss.id, name: supersetName(ss), rounds, components };
}
function buildDraft(w) {
  const date = todayStr();
  const exercises = w.items.map(item => {
    if (item.supersetId) {
      const ss = ssById(item.supersetId);
      return ss ? draftSuperset(ss, Math.max(1, item.sets || 1), date) : null;
    }
    const ex = exById(item.exerciseId);
    if (!ex) return null;
    const de = draftExercise(item.exerciseId, date, ex.type === 'cardio' ? undefined : Math.max(1, item.sets || 1));
    de.rest = item.rest || 0;  // predetermined rest target (seconds) for the count-up bar
    return de;
  }).filter(Boolean);
  return { workoutId: w.id, date, exercises };
}

function renderSession(v) {
  const w = woById(route.workoutId);
  if (!w) { route.workoutId = null; return render(); }
  if (!route._draft || route._draft.workoutId !== w.id) route._draft = buildDraft(w);
  const draft = route._draft;

  const noteBtn = (xi, on) => `<button class="icon-btn ${on ? 'on' : ''}" data-action="toggle-ex-note" data-xi="${xi}" title="Note" aria-label="note">📝</button>`;
  const menuBtn = (xi) => `<button class="icon-btn" data-action="ex-menu" data-xi="${xi}" title="Swap or skip" aria-label="more">⋯</button>`;
  const noteField = (xi, val) => `<div class="ex-note-field" ${val ? '' : 'hidden'}><input data-xi="${xi}" data-fnote="1" value="${esc(val)}" placeholder="Note to future you — e.g. try a wider grip next time" /></div>`;
  const tags = (exd) => `${exd.swappedFrom ? `<span class="mini-tag">↔ swapped from ${esc(exd.swappedFrom)}</span>` : ''}${exd.added ? `<span class="mini-tag added">＋ added today</span>` : ''}`;

  const blocks = draft.exercises.map((exd, xi) => {
    if (exd.skipped) {
      return `<div class="ex-block skipped" data-xi="${xi}">
        <div class="ex-block-head"><span class="name">${esc(exd.name)}</span>
          <div class="ex-actions"><button class="btn ghost sm" data-action="unskip-exercise" data-xi="${xi}">Undo</button></div></div>
        <div class="skip-line">⤫ Skipped — ${esc(exd.skipReason || '')}</div>
      </div>`;
    }
    if (exd.type === 'superset') {
      const rounds = Array.from({ length: exd.rounds }, (_, r) => {
        const skReason = exd.skippedRounds && exd.skippedRounds[r];
        return `<div class="ss-round ${skReason ? 'skipped' : ''}">
          <button class="ss-round-h" data-action="skip-ss-round" data-xi="${xi}" data-round="${r}" title="${skReason ? 'Tap to restore' : 'Tap to skip this round'}">${skReason ? '⤫ ' : ''}Round ${r + 1}</button>
          ${skReason ? `<div class="skip-line">⤫ skipped — ${esc(skReason)}</div>` : exd.components.map((c, ci) => `<div class="ss-move">
            <span class="ss-name" title="${esc(c.name)}">${esc(c.name)}</span>
            <input inputmode="decimal" data-xi="${xi}" data-ci="${ci}" data-si="${r}" data-f="weight" value="${c.sets[r].weight}" placeholder="${unit()}" />
            <input inputmode="numeric" data-xi="${xi}" data-ci="${ci}" data-si="${r}" data-f="reps" value="${c.sets[r].reps}" placeholder="reps" />
            <input inputmode="numeric" class="rir" data-xi="${xi}" data-ci="${ci}" data-si="${r}" data-f="rir" value="${c.sets[r].rir}" placeholder="0" />
          </div>`).join('')}
        </div>`;
      }).join('');
      const restBadges = exd.components.map(c => `${esc(c.name)} ${restLabel(c.rest)}`).join('　·　');
      return `<div class="ex-block superset" data-xi="${xi}">
        <div class="ex-block-head"><span class="name">🔗 ${esc(exd.name)}</span>
          <div class="ex-actions">${noteBtn(xi, exd.note)}${menuBtn(xi)}</div></div>
        ${tags(exd)}${noteField(xi, exd.note)}
        <div class="ss-legend">rest → ${restBadges}</div>
        <div class="ss-head"><span></span><span>weight (${unit()})</span><span>reps</span><span>RIR</span></div>
        ${rounds}
      </div>`;
    }
    if (exd.type === 'cardio') {
      return `<div class="ex-block" data-xi="${xi}">
        <div class="ex-block-head"><span class="name">${esc(exd.name)}</span>
          <div class="ex-actions"><span class="chip">cardio</span>${noteBtn(xi, exd.note)}${menuBtn(xi)}</div></div>
        ${tags(exd)}${noteField(xi, exd.note)}
        <div class="set-row cardio">
          <input inputmode="decimal" data-xi="${xi}" data-fc="duration" value="${exd.cardio.duration}" placeholder="min" />
          <input inputmode="decimal" data-xi="${xi}" data-fc="distance" value="${exd.cardio.distance}" placeholder="km" />
        </div>
      </div>`;
    }
    // Numbers are already prefilled into the inputs, so the top box only carries a note (if any).
    const le = lastEntryForExercise(exd.exId, draft.date);
    const lastNote = (le && le.note) ? `<div class="last-note">📝 ${esc(le.note).replace(/\n/g, ' · ')}</div>` : '';
    const rows = exd.sets.map((st, si) => `<div class="set-row ${st.skipped ? 'skipped' : ''}">
        <button class="setno" data-action="skip-set" data-xi="${xi}" data-si="${si}" title="${st.skipped ? 'Tap to restore' : 'Tap to skip'}">${st.skipped ? '⤫' : si + 1}</button>
        <input inputmode="decimal" data-xi="${xi}" data-si="${si}" data-f="weight" value="${st.weight}" placeholder="${unit()}" ${st.skipped ? 'disabled' : ''} />
        <input inputmode="numeric" data-xi="${xi}" data-si="${si}" data-f="reps" value="${st.reps}" placeholder="reps" ${st.skipped ? 'disabled' : ''} />
        <input inputmode="numeric" class="rir" data-xi="${xi}" data-si="${si}" data-f="rir" value="${st.rir}" placeholder="0" ${st.skipped ? 'disabled' : ''} />
        ${st.skipped ? `<div class="skip-line">⤫ skipped — ${esc(st.skipReason || '')}</div>` : ''}
      </div>`).join('');
    return `<div class="ex-block" data-xi="${xi}">
      <div class="ex-block-head"><span class="name">${esc(exd.name)}</span>
        <div class="ex-actions">${noteBtn(xi, exd.note)}${menuBtn(xi)}</div></div>
      ${tags(exd)}${noteField(xi, exd.note)}
      ${lastNote}
      <div class="mini-head"><span></span><span>weight (${unit()})</span><span>reps</span><span>RIR</span></div>
      ${rows}
    </div>`;
  }).join('');

  v.innerHTML = `
    <div class="row" style="align-items:center;margin-bottom:6px">
      <button class="btn ghost sm" data-action="back-train">‹ Back</button><div class="spacer"></div>
      <input type="date" value="${draft.date}" data-action="session-date" style="width:auto" />
    </div>
    <h1 class="page-title" style="margin-top:6px">${esc(w.name)}</h1>
    ${blocks || emptyState('➕', 'No exercises', 'Add exercises to this workout in Build.', 'Go to Build', 'build')}
    <button class="btn ghost block" data-action="add-exercise-today" style="margin-top:4px">＋ Add exercise</button>
    <button class="btn primary block" data-action="save-session" style="margin-top:12px">Finish &amp; Save workout</button>
    <div style="height:64px"></div>`;
}

function collectSession() {
  const w = woById(route.workoutId);
  const draft = route._draft || buildDraft(w);
  const joinNotes = (...parts) => parts.map(p => (p || '').trim()).filter(Boolean).join('\n') || undefined;
  const entries = [];
  for (const exd of draft.exercises) {
    if (exd.type === 'superset') {
      if (exd.skipped) {
        entries.push({ supersetId: exd.supersetId, name: exd.name, type: 'superset', skipped: true,
          note: joinNotes(exd.note, exd.skipReason ? 'Skipped: ' + exd.skipReason : ''), components: [] });
        continue;
      }
      const sk = exd.skippedRounds || {};
      const components = exd.components.map(c => ({
        exerciseId: c.exerciseId, name: c.name,
        sets: c.sets.filter((s, ri) => sk[ri] == null && (String(s.weight).trim() !== '' || String(s.reps).trim() !== ''))
          .map(s => ({ weight: +s.weight || 0, reps: +s.reps || 0, rir: +s.rir || 0 }))
      })).filter(c => c.sets.length);
      const roundSkips = Object.keys(sk).sort((a, b) => a - b).map(ri => `Round ${+ri + 1} skipped: ${sk[ri]}`);
      const note = joinNotes(exd.note, ...roundSkips);
      if (components.length || roundSkips.length) entries.push({ supersetId: exd.supersetId, name: exd.name, type: 'superset', note, components });
      continue;
    }
    const ex = exById(exd.exId);
    if (!ex) continue;
    if (exd.skipped) {
      entries.push({ exerciseId: exd.exId, name: exd.name, type: exd.type || 'lifting', skipped: true,
        swappedFrom: exd.swappedFrom, note: joinNotes(exd.note, exd.skipReason ? 'Skipped: ' + exd.skipReason : ''), sets: [] });
      continue;
    }
    if (exd.type === 'cardio') {
      const d = String(exd.cardio.duration).trim(), dist = String(exd.cardio.distance).trim();
      if (d || dist) entries.push({ exerciseId: exd.exId, name: exd.name, type: 'cardio', swappedFrom: exd.swappedFrom, note: joinNotes(exd.note), sets: [{ duration: +d || null, distance: +dist || null }] });
      continue;
    }
    const skipLines = exd.sets.map((s, i) => s.skipped ? `Set ${i + 1} skipped: ${s.skipReason || ''}` : null).filter(Boolean);
    const sets = exd.sets
      .filter(s => !s.skipped && (String(s.weight).trim() !== '' || String(s.reps).trim() !== ''))
      .map(s => ({ weight: +s.weight || 0, reps: +s.reps || 0, rir: +s.rir || 0 }));
    if (sets.length || skipLines.length) {
      entries.push({ exerciseId: exd.exId, name: exd.name, type: 'lifting', swappedFrom: exd.swappedFrom, note: joinNotes(exd.note, ...skipLines), sets });
    }
  }
  return { id: uid(), workoutId: w.id, workoutName: w.name, date: draft.date, entries };
}

/* ---------------- PROGRESS ---------------- */
function renderProgress(v) {
  const ci = currentCycleIndex();
  const curVol = cycleVolume(ci);
  const prevVol = cycleVolume(ci - 1);
  const delta = prevVol > 0 ? Math.round(((curVol - prevVol) / prevVol) * 100) : null;
  const r = cycleRange(ci);

  // last up-to-8 cycles bar chart (only cycles that have data or are recent)
  const bars = [];
  for (let i = ci - 6; i <= ci; i++) {
    bars.push({ label: 'C' + (i + 1), value: cycleVolume(i), dim: i !== ci });
  }

  const totalSessions = state.sessions.length;
  const exercisesWithData = state.exercises.filter(e => exerciseSetsHistory(e.id).length);

  const exTiles = exercisesWithData.map(e => {
    const pr = prsFor(e.id);
    return `<button class="tile" data-action="open-exercise" data-id="${e.id}">
      <span class="emoji-badge">${e.type === 'cardio' ? '🏃' : '🏋️'}</span>
      <span class="grow"><span class="tile-title">${esc(e.name)}</span>
        <span class="tile-sub">PR ${Math.round(pr.topWeight)} ${unit()} · e1RM ${Math.round(pr.best1rm)} ${unit()}</span></span>
      <span class="tile-chev">›</span></button>`;
  }).join('');
  const ssTiles = (state.supersets || []).filter(ss => supersetHistory(ss.id).length).map(ss => {
    const n = supersetHistory(ss.id).length;
    return `<button class="tile" data-action="open-superset" data-id="${ss.id}">
      <span class="emoji-badge">🔗</span>
      <span class="grow"><span class="tile-title">${esc(supersetName(ss))}</span>
        <span class="tile-sub">superset · ${n} session${n > 1 ? 's' : ''}</span></span>
      <span class="tile-chev">›</span></button>`;
  }).join('');
  const exRows = (exTiles + ssTiles) || `<div class="empty small">Log a workout to see per-exercise progress.</div>`;

  const history = sessionsSorted().slice(0, 12).map(s => `
    <button class="tile" data-action="open-session" data-id="${s.id}">
      <span class="emoji-badge">${s.entries.some(e => e.type === 'cardio') ? '🏃' : '🏋️'}</span>
      <span class="grow"><span class="tile-title">${esc(s.workoutName || 'Workout')}</span>
        <span class="tile-sub">${fmtDateFull(s.date)} · ${Math.round(sessionVolume(s)).toLocaleString()} ${unit()}</span></span>
      <span class="tile-chev">›</span></button>`).join('') || `<div class="empty small">No sessions logged yet.</div>`;

  v.innerHTML = `
    <h1 class="page-title">Progress</h1>
    <div class="stat-grid" style="margin-bottom:22px">
      <div class="stat"><div class="k">This cycle volume</div><div class="v">${Math.round(curVol).toLocaleString()}</div>
        <div class="d ${delta === null ? '' : delta >= 0 ? 'up' : 'down'}">${delta === null ? `${unit()}` : (delta >= 0 ? '▲' : '▼') + ' ' + Math.abs(delta) + '% vs last'}</div></div>
      <div class="stat"><div class="k">Cycle ${ci + 1}</div><div class="v">${cycleSessionCount(ci)}</div><div class="d muted">${fmtDate(r.start)}–${fmtDate(r.end)}</div></div>
      <div class="stat"><div class="k">Total sessions</div><div class="v">${totalSessions}</div><div class="d muted">all time</div></div>
      <div class="stat"><div class="k">Exercises</div><div class="v">${state.exercises.length}</div><div class="d muted">in library</div></div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Volume per cycle</h2></div>
      <div class="card">${barChart(bars)}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Per-exercise progress</h2></div>
      <div class="list">${exRows}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>History</h2></div>
      <div class="list">${history}</div>
    </div>`;
}

function renderExerciseDetail(v) {
  const ex = exById(route.exerciseId);
  if (!ex) { route.exerciseId = null; return render(); }
  const h = exerciseSetsHistory(ex.id);
  const pr = prsFor(ex.id);
  const chrono = [...h].reverse(); // oldest→newest for charts

  const weightPts = chrono.map(x => ({ label: fmtDate(x.date), value: x.topWeight }));
  const volPts = chrono.map(x => ({ label: fmtDate(x.date), value: x.volume, dim: false }));

  const histRows = h.slice(0, 20).map(x => {
    const setsTxt = x.sets.map(s => `${s.weight}×${s.reps}`).join('  ');
    const isPR = pr && x.topWeight === pr.topWeight;
    return `<div class="card" style="padding:12px 14px">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <strong>${fmtDate(x.date)}</strong>
        ${isPR ? '<span class="pr-badge">★ PR</span>' : ''}
      </div>
      <div class="muted small" style="margin-top:4px">${esc(setsTxt)}</div>
      <div class="faint small" style="margin-top:2px">Top ${Math.round(x.topWeight)} ${unit()} · e1RM ${Math.round(x.best1rm)} · vol ${Math.round(x.volume).toLocaleString()}</div>
    </div>`;
  }).join('');

  v.innerHTML = `
    <div class="row" style="margin-bottom:6px"><button class="btn ghost sm" data-action="back-progress">‹ Progress</button></div>
    <h1 class="page-title" style="margin-top:6px">${esc(ex.name)}</h1>
    ${!h.length ? emptyState('📈', 'No data yet', 'Log this exercise in a workout to see progress.') : `
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:22px">
      <div class="stat"><div class="k">Heaviest</div><div class="v">${Math.round(pr.topWeight)}</div><div class="d muted">${unit()}</div></div>
      <div class="stat"><div class="k">Best e1RM</div><div class="v">${Math.round(pr.best1rm)}</div><div class="d muted">${unit()}</div></div>
      <div class="stat"><div class="k">Best volume</div><div class="v">${Math.round(pr.bestVolume).toLocaleString()}</div><div class="d muted">1 session</div></div>
    </div>
    <div class="section"><div class="section-head"><h2>Top set over time (${unit()})</h2></div>
      <div class="card">${lineChart(weightPts)}</div></div>
    <div class="section"><div class="section-head"><h2>Volume per session</h2></div>
      <div class="card">${barChart(volPts)}</div></div>
    <div class="section"><div class="section-head"><h2>Log</h2></div><div class="stack">${histRows}</div></div>
    `}`;
}

function renderSupersetDetail(v) {
  const ss = ssById(route.supersetId);
  if (!ss) { route.supersetId = null; return render(); }
  const chrono = [...supersetHistory(ss.id)].reverse(); // oldest→newest
  const comps = (ss.components || []).map(c => {
    const ex = exById(c.exerciseId);
    const series = chrono.map(entry => {
      const cc = (entry.components || []).find(x => x.exerciseId === c.exerciseId);
      const sets = cc ? cc.sets : [];
      return { date: entry.date, top: sets.length ? Math.max(...sets.map(s => +s.weight || 0)) : 0 };
    }).filter(x => x.top);
    const topPR = series.length ? Math.max(...series.map(s => s.top)) : 0;
    const pts = series.map(s => ({ label: fmtDate(s.date), value: s.top }));
    return `<div class="section">
      <div class="section-head"><h2>${esc(ex ? ex.name : '?')}</h2><span class="chip accent">PR ${Math.round(topPR)} ${unit()} · ${restLabel(c.rest)} rest</span></div>
      <div class="card">${lineChart(pts)}</div></div>`;
  }).join('');
  v.innerHTML = `
    <div class="row" style="margin-bottom:6px"><button class="btn ghost sm" data-action="back-progress">‹ Progress</button></div>
    <h1 class="page-title" style="margin-top:6px">🔗 ${esc(supersetName(ss))}</h1>
    <p class="muted small" style="margin:-8px 2px 18px">Tracked on its own — supersetting changes the stimulus, so these numbers stay separate from your solo lifts.</p>
    ${chrono.length ? comps : emptyState('📈', 'No data yet', 'Log this superset in a workout to see progress.')}`;
}

/* ---------------- BUILD ---------------- */
function renderBuild(v) {
  const workouts = state.workouts.map(w => {
    const sub = w.items.length ? w.items.length + ' exercises · ' + w.items.reduce((a, i) => a + (i.sets || 0), 0) + ' sets' : 'Empty';
    return `<button class="tile" data-action="edit-workout" data-id="${w.id}">
      <span class="emoji-badge">🏋️</span>
      <span class="grow"><span class="tile-title">${esc(w.name)}</span><span class="tile-sub">${sub}</span></span>
      <span class="tile-chev">›</span></button>`;
  }).join('') || `<div class="empty small">No workouts yet.</div>`;

  const exList = state.exercises.map(e => `
    <button class="tile" data-action="edit-exercise" data-id="${e.id}">
      <span class="emoji-badge">${e.type === 'cardio' ? '🏃' : '🏋️'}</span>
      <span class="grow"><span class="tile-title">${esc(e.name)}</span>
        <span class="tile-sub">${esc(e.muscle || '—')} · ${e.type}</span></span>
      <span class="tile-chev">›</span></button>`).join('') || `<div class="empty small">No exercises yet.</div>`;

  v.innerHTML = `
    <h1 class="page-title">Build</h1>
    <div class="section">
      <div class="section-head"><h2>Workouts</h2><button class="btn sm primary" data-action="new-workout">+ New</button></div>
      <div class="list">${workouts}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Exercise library</h2><button class="btn sm" data-action="new-exercise">+ Add</button></div>
      <div class="list">${exList}</div>
    </div>`;
}

function renderWorkoutEditor(v) {
  const w = woById(route.workoutId);
  if (!w) { route.workoutId = null; return render(); }
  const items = w.items.map((item, idx) => {
    if (item.supersetId) {
      const ss = ssById(item.supersetId);
      if (!ss) return '';
      const names = (ss.components || []).map(c => `${(exById(c.exerciseId) || {}).name || '?'} · ${restLabel(c.rest)}`).join('  +  ');
      return `<div class="ex-block superset" style="padding:12px 14px;margin-bottom:10px">
        <div class="row" style="align-items:center;gap:12px">
          <div class="reorder">
            <button data-action="move-item" data-idx="${idx}" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button data-action="move-item" data-idx="${idx}" data-dir="1" ${idx === w.items.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <span class="grow"><strong>🔗 ${esc(supersetName(ss))}</strong><div class="faint small">${esc(names)}</div></span>
          <button class="btn ghost icon" data-action="remove-item" data-idx="${idx}" style="color:var(--danger)">✕</button>
        </div>
        <div class="editor-ctls">
          <label><span>Rounds</span><input type="number" min="1" max="20" value="${item.sets || 1}" data-action="item-sets" data-idx="${idx}" /></label>
          <button class="btn sm" data-action="edit-superset" data-ssid="${ss.id}">Edit moves &amp; rest</button>
        </div>
      </div>`;
    }
    const ex = exById(item.exerciseId);
    if (!ex) return '';
    const ctls = ex.type === 'cardio'
      ? `<div class="editor-ctls"><span class="chip">cardio · no rest timer</span></div>`
      : `<div class="editor-ctls">
          <label><span>Sets</span><input type="number" min="1" max="20" value="${item.sets || 1}" data-action="item-sets" data-idx="${idx}" /></label>
          <label><span>Rest</span><select data-action="item-rest" data-idx="${idx}">${REST_OPTS.map(o => `<option value="${o}" ${(item.rest || 0) === o ? 'selected' : ''}>${restLabel(o)}</option>`).join('')}</select></label>
        </div>`;
    return `<div class="ex-block" style="padding:12px 14px;margin-bottom:10px">
      <div class="row" style="align-items:center;gap:12px">
        <div class="reorder">
          <button data-action="move-item" data-idx="${idx}" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button data-action="move-item" data-idx="${idx}" data-dir="1" ${idx === w.items.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <span class="grow"><strong>${esc(ex.name)}</strong><div class="faint small">${esc(ex.muscle || '')}</div></span>
        <button class="btn ghost icon" data-action="remove-item" data-idx="${idx}" style="color:var(--danger)">✕</button>
      </div>
      ${ctls}</div>`;
  }).join('') || `<div class="empty small">No exercises in this workout yet.</div>`;

  v.innerHTML = `
    <div class="row" style="margin-bottom:6px"><button class="btn ghost sm" data-action="back-build">‹ Build</button></div>
    <label class="field"><span class="lbl">Workout name</span>
      <input type="text" data-action="workout-name" value="${esc(w.name)}" /></label>
    <div class="section-head"><h2>Exercises &amp; sets</h2>
      <div class="row" style="gap:6px"><button class="btn sm" data-action="add-superset">+ Superset</button><button class="btn sm primary" data-action="add-item">+ Exercise</button></div></div>
    ${items}
    <button class="btn danger block" data-action="del-workout" style="margin-top:18px">Delete workout</button>
    <div style="height:20px"></div>`;
}

/* ---------------- SETTINGS ---------------- */
function renderSettings(v) {
  const s = state.settings, g = s.github;
  v.innerHTML = `
    <h1 class="page-title">Settings</h1>

    <div class="section">
      <div class="section-head"><h2>Units &amp; cycle</h2></div>
      <div class="card stack">
        <label class="field"><span class="lbl">Units</span>
          <div class="seg" data-action="units">
            <button data-v="kg" class="${s.units === 'kg' ? 'on' : ''}">kg</button>
            <button data-v="lb" class="${s.units === 'lb' ? 'on' : ''}">lb</button>
          </div></label>
        <label class="field"><span class="lbl">Cycle start date (Day 1)</span>
          <input type="date" data-action="cycle-start" value="${s.cycleStartDate}" /></label>
        <label class="field" style="margin-bottom:0"><span class="lbl">Cycle length (days)</span>
          <input type="number" min="1" max="31" data-action="cycle-len" value="${s.cycleLengthDays}" /></label>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>GitHub sync</h2><span class="chip ${g.token && g.owner ? 'accent' : ''}">${g.token && g.owner ? 'configured' : 'off'}</span></div>
      <div class="card stack">
        <p class="muted small" style="margin:0 2px 4px">Syncs your data to a <b>private</b> repo so it follows you across devices. Create a fine-grained token (repo → Contents: Read &amp; Write) and paste it below — it stays on this device only.</p>
        <div class="row"><label class="field" style="flex:1"><span class="lbl">Owner (user)</span><input type="text" data-g="owner" value="${esc(g.owner)}" placeholder="your-github-user"/></label>
          <label class="field" style="flex:1"><span class="lbl">Repo</span><input type="text" data-g="repo" value="${esc(g.repo)}" placeholder="gym-data"/></label></div>
        <div class="row"><label class="field" style="flex:1"><span class="lbl">Your name (file)</span><input type="text" data-g="user" value="${esc(g.user)}" placeholder="mobashir"/></label>
          <label class="field" style="flex:1"><span class="lbl">Branch</span><input type="text" data-g="branch" value="${esc(g.branch || 'main')}" placeholder="main"/></label></div>
        <label class="field"><span class="lbl">Fine-grained token</span><input type="password" data-g="token" value="${esc(g.token)}" placeholder="github_pat_…"/></label>
        <div class="row wrap">
          <button class="btn sm" data-action="gh-save">Save config</button>
          <button class="btn sm primary" data-action="gh-push">⬆ Push to cloud</button>
          <button class="btn sm" data-action="gh-pull">⬇ Pull from cloud</button>
        </div>
        <div id="gh-status" class="faint small"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Data</h2></div>
      <div class="card row wrap">
        <button class="btn sm" data-action="export">Export JSON</button>
        <button class="btn sm" data-action="import">Import JSON</button>
        <button class="btn sm danger" data-action="reset-data">Reset all</button>
      </div>
    </div>
    <p class="faint small center">Gym Tracker · local-first · your data lives on your device${g.token ? ' + your private repo' : ''}.</p>
    <div style="height:12px"></div>`;
}

/* ============================================================
   CHART HELPERS (hand-rolled SVG, theme-aware via CSS)
   ============================================================ */
function lineChart(points, { h = 150 } = {}) {
  if (!points.length) return `<div class="empty small">Not enough data.</div>`;
  if (points.length === 1) points = [{ label: '', value: points[0].value }, points[0]];
  const W = 320, H = h, pad = { l: 30, r: 8, t: 10, b: 20 };
  const xs = (W - pad.l - pad.r), ys = (H - pad.t - pad.b);
  const vals = points.map(p => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min = min - 1; max = max + 1; }
  const x = i => pad.l + (points.length === 1 ? xs / 2 : (i / (points.length - 1)) * xs);
  const y = val => pad.t + ys - ((val - min) / (max - min)) * ys;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `M${x(0).toFixed(1)},${(pad.t + ys).toFixed(1)} ` + points.map((p, i) => `L${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ') + ` L${x(points.length - 1).toFixed(1)},${(pad.t + ys).toFixed(1)} Z`;
  const dots = points.map((p, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6" />`).join('');
  const gridY = [0, .5, 1].map(f => { const gy = pad.t + ys - f * ys; const val = min + f * (max - min); return `<line class="grid-line" x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}"/><text class="axis-lbl" x="2" y="${gy + 3}">${Math.round(val)}</text>`; }).join('');
  const step = Math.max(1, Math.ceil(points.length / 5));
  const xlbls = points.map((p, i) => (i % step === 0 || i === points.length - 1) ? `<text class="axis-lbl" x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(p.label || '')}</text>` : '').join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${gridY}<path class="area" d="${area}"/><path class="line" d="${path}"/>${dots}${xlbls}</svg></div>`;
}

function barChart(bars, { h = 150 } = {}) {
  if (!bars.length || bars.every(b => !b.value)) return `<div class="empty small">No volume logged yet.</div>`;
  const W = 320, H = h, pad = { l: 30, r: 8, t: 10, b: 20 };
  const xs = (W - pad.l - pad.r), ys = (H - pad.t - pad.b);
  const max = Math.max(...bars.map(b => b.value), 1);
  const bw = xs / bars.length;
  const barW = Math.min(38, bw * 0.62);
  const gridY = [0, .5, 1].map(f => { const gy = pad.t + ys - f * ys; const val = f * max; return `<line class="grid-line" x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}"/><text class="axis-lbl" x="2" y="${gy + 3}">${short(val)}</text>`; }).join('');
  const rects = bars.map((b, i) => {
    const bh = (b.value / max) * ys;
    const bx = pad.l + i * bw + (bw - barW) / 2;
    const by = pad.t + ys - bh;
    return `<rect class="bar ${b.dim ? 'dim' : ''}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="4"/>
      <text class="axis-lbl" x="${(bx + barW / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(b.label)}</text>`;
  }).join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${gridY}${rects}</svg></div>`;
}
function short(n) { n = Math.round(n); if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'; return n; }

/* ---------------- shared UI bits ---------------- */
function emptyState(icon, title, sub, btnLabel, btnTab) {
  return `<div class="empty"><div class="big">${icon}</div><h3>${esc(title)}</h3><p>${esc(sub)}</p>
    ${btnLabel ? `<button class="btn primary" data-action="goto" data-tab="${btnTab}" style="margin-top:14px">${esc(btnLabel)}</button>` : ''}</div>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------------- sheets (modals) ---------------- */
function openSheet(title, bodyHtml) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'sheet-backdrop'; back.id = 'sheet';
  back.innerHTML = `<div class="sheet"><div class="sheet-title">${esc(title)}</div>${bodyHtml}</div>`;
  back.addEventListener('click', e => { if (e.target === back) closeSheet(); });
  document.body.appendChild(back);
  return back;
}
function closeSheet() { const s = $('#sheet'); if (s) s.remove(); }

function exercisePicker() {
  const items = state.exercises.map(e => `<button class="tile" data-action="pick-exercise" data-id="${e.id}">
    <span class="emoji-badge">${e.type === 'cardio' ? '🏃' : '🏋️'}</span>
    <span class="grow"><span class="tile-title">${esc(e.name)}</span><span class="tile-sub">${esc(e.muscle || '—')}</span></span></button>`).join('')
    || `<div class="empty small">No exercises yet — add one first.</div>`;
  openSheet('Add exercise', `<div class="list">${items}</div>
    <button class="btn block" data-action="new-exercise" style="margin-top:14px">+ Create new exercise</button>`);
}

function exerciseForm(ex) {
  const editing = !!ex;
  ex = ex || { name: '', type: 'lifting', muscle: '' };
  openSheet(editing ? 'Edit exercise' : 'New exercise', `
    <input type="hidden" data-ef="id" value="${ex.id || ''}" />
    <label class="field"><span class="lbl">Name</span><input type="text" data-ef="name" value="${esc(ex.name)}" placeholder="e.g. Bench Press" /></label>
    <label class="field"><span class="lbl">Type</span>
      <div class="seg" data-action="ef-type">
        <button data-v="lifting" class="${ex.type === 'lifting' ? 'on' : ''}">Lifting</button>
        <button data-v="cardio" class="${ex.type === 'cardio' ? 'on' : ''}">Cardio</button>
      </div></label>
    <label class="field"><span class="lbl">Muscle / group (optional)</span><input type="text" data-ef="muscle" value="${esc(ex.muscle || '')}" placeholder="e.g. Chest" /></label>
    <button class="btn primary block" data-action="save-exercise" style="margin-top:6px">${editing ? 'Save' : 'Add exercise'}</button>
    ${editing ? `<button class="btn danger block" data-action="del-exercise" data-id="${ex.id}" style="margin-top:10px">Delete exercise</button>` : ''}`);
}

function sessionDetailSheet(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  const body = s.entries.map(e => {
    if (e.type === 'superset') {
      const comps = e.skipped ? '<div class="muted small" style="margin-top:3px">⤫ Skipped</div>'
        : (e.components || []).map(c => `<div class="muted small" style="margin-top:3px"><b>${esc(c.name)}</b> · ${c.sets.map(st => `${st.weight}×${st.reps}${st.rir ? ` @${st.rir}` : ''}`).join('  ')}</div>`).join('');
      return `<div class="card" style="padding:11px 13px${e.skipped ? ';opacity:.7' : ''}"><strong>🔗 ${esc(e.name)}</strong>${comps}
        ${e.note ? `<div class="small" style="margin-top:5px;color:var(--warn)">📝 ${esc(e.note).replace(/\n/g, '<br>')}</div>` : ''}</div>`;
    }
    const isCardio = e.type === 'cardio';
    const line = e.skipped ? '⤫ Skipped'
      : isCardio ? (e.sets[0] ? `${e.sets[0].duration ?? '–'} min · ${e.sets[0].distance ?? '–'} km` : '')
      : e.sets.map(st => `${st.weight}×${st.reps}${st.rir ? ` @${st.rir}RIR` : ''}`).join('   ');
    const fbs = (isCardio || e.skipped) ? [] : e.sets.map((st, i) => st.fb ? `<div class="faint small">💬 set ${i + 1}: ${esc(st.fb)}</div>` : '').filter(Boolean);
    return `<div class="card" style="padding:11px 13px${e.skipped ? ';opacity:.7' : ''}"><strong>${esc(e.name || (exById(e.exerciseId) || {}).name || '?')}</strong>
      <div class="muted small" style="margin-top:3px">${esc(line)}</div>
      ${e.swappedFrom ? `<div class="faint small" style="margin-top:2px">↔ swapped from ${esc(e.swappedFrom)}</div>` : ''}
      ${e.note ? `<div class="small" style="margin-top:5px;color:var(--warn)">📝 ${esc(e.note).replace(/\n/g, '<br>')}</div>` : ''}
      ${fbs.length ? `<div style="margin-top:4px">${fbs.join('')}</div>` : ''}</div>`;
  }).join('');
  openSheet(fmtDateFull(s.date), `<div class="stack">${body}</div>
    ${s.note ? `<p class="muted small" style="margin-top:12px">📝 ${esc(s.note)}</p>` : ''}
    <div class="faint small" style="margin-top:12px">Total volume: ${Math.round(sessionVolume(s)).toLocaleString()} ${unit()}</div>
    <button class="btn danger block" data-action="del-session" data-id="${s.id}" style="margin-top:14px">Delete session</button>`);
}

// Friction prompt: a reason is required; it gets saved into the exercise note.
function reasonPrompt(title, chips, cb) {
  const back = openSheet(title, `
    <div class="chips-row">${chips.map(c => `<button class="chip-pick" type="button">${esc(c)}</button>`).join('')}</div>
    <input type="text" id="reason-input" placeholder="Type a reason…" autocomplete="off" style="margin-top:2px" />
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn ghost" data-action="close-sheet" style="flex:1">Cancel</button>
      <button class="btn primary" id="reason-confirm" style="flex:2" disabled>Confirm</button>
    </div>
    <p class="faint small center" style="margin-top:10px">A reason keeps you honest — it's saved to the exercise note.</p>`);
  const input = $('#reason-input', back), confirm = $('#reason-confirm', back);
  const sync = () => { confirm.disabled = !input.value.trim(); };
  input.addEventListener('input', sync);
  $$('.chip-pick', back).forEach(ch => ch.addEventListener('click', () => { input.value = ch.textContent; sync(); input.focus(); }));
  confirm.addEventListener('click', () => { const r = input.value.trim(); if (!r) return; closeSheet(); cb(r); });
  setTimeout(() => input.focus(), 60);
}

// Pick an exercise from the library; calls cb(exerciseId).
function pickExerciseSheet(title, cb) {
  const items = state.exercises.map(e => `<button class="tile" data-pick="${e.id}">
    <span class="emoji-badge">${e.type === 'cardio' ? '🏃' : '🏋️'}</span>
    <span class="grow"><span class="tile-title">${esc(e.name)}</span><span class="tile-sub">${esc(e.muscle || '—')}</span></span></button>`).join('')
    || `<div class="empty small">No exercises yet — add one in Build.</div>`;
  const back = openSheet(title, `<div class="list">${items}</div>`);
  $$('[data-pick]', back).forEach(b => b.addEventListener('click', () => { const id = b.dataset.pick; closeSheet(); cb(id); }));
}

// ⋯ menu on an exercise during a workout (swap / skip). Session-only.
function exerciseMenu(xi) {
  const exd = route._draft.exercises[xi];
  const swap = exd.type === 'superset' ? '' : `<button class="tile" data-action="swap-exercise" data-xi="${xi}">
      <span class="emoji-badge">🔁</span><span class="grow"><span class="tile-title">Swap exercise</span><span class="tile-sub">Machine taken? Pick another — today only</span></span></button>`;
  openSheet(exd.name, `${swap}
    <button class="tile" data-action="skip-exercise" data-xi="${xi}" ${swap ? 'style="margin-top:8px"' : ''}>
      <span class="emoji-badge">⤫</span><span class="grow"><span class="tile-title">Skip ${exd.type === 'superset' ? 'superset' : 'exercise'}</span><span class="tile-sub">Drop it from today, with a reason</span></span></button>`);
}

/* ---------------- superset builder (Build) ---------------- */
function supersetBuilder(existingId) {
  const ss = existingId ? ssById(existingId) : null;
  route._ssb = { id: existingId || null, components: ss ? JSON.parse(JSON.stringify(ss.components)) : [] };
  renderSupersetBuilder();
}
function renderSupersetBuilder() {
  const ssb = route._ssb;
  const rows = ssb.components.map((c, i) => {
    const ex = exById(c.exerciseId);
    return `<div class="ss-builder-row">
      <span class="grow"><strong>${esc(ex ? ex.name : '?')}</strong><div class="faint small">move ${i + 1}</div></span>
      <label class="ss-rest"><span>rest</span><select data-ssb-rest="${i}">${REST_OPTS.filter(o => o > 0).map(o => `<option value="${o}" ${(+c.rest) === o ? 'selected' : ''}>${restLabel(o)}</option>`).join('')}</select></label>
      <button class="btn ghost icon" data-ssb-remove="${i}" style="color:var(--danger)">✕</button>
    </div>`;
  }).join('') || `<div class="empty small">Pick at least two moves — e.g. Bench Press, then Biceps Curl.</div>`;
  const back = openSheet(ssb.id ? 'Edit superset' : 'New superset', `
    <div class="stack">${rows}</div>
    <button class="btn block" data-action="ssb-add" style="margin-top:12px">＋ Add a move</button>
    <button class="btn primary block" data-action="ssb-save" style="margin-top:14px" ${ssb.components.length < 2 ? 'disabled' : ''}>${ssb.id ? 'Save superset' : 'Create superset'}</button>
    <p class="faint small center" style="margin-top:8px">Rest = the pause after each move as you cycle. Set rounds after.</p>`);
  $$('[data-ssb-rest]', back).forEach(sel => sel.addEventListener('change', () => { route._ssb.components[+sel.dataset.ssbRest].rest = +sel.value; }));
  $$('[data-ssb-remove]', back).forEach(b => b.addEventListener('click', () => { route._ssb.components.splice(+b.dataset.ssbRemove, 1); renderSupersetBuilder(); }));
}

/* ---------------- rest timer: counts UP from 0 toward the target, visual only ---------------- */
let restState = null;   // { name, target, start }
let restInterval = null;
function ensureRestBar() {
  let bar = document.getElementById('rest-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'rest-bar'; bar.className = 'rest-bar'; bar.hidden = true;
    bar.title = 'Tap to dismiss';
    bar.addEventListener('click', stopRest);
    document.body.appendChild(bar);
  }
  return bar;
}
function paintRestBar() {
  const bar = ensureRestBar();
  if (!restState) { bar.hidden = true; return; }
  const elapsed = Math.floor((Date.now() - restState.start) / 1000);
  const target = restState.target;
  const done = elapsed >= target;
  const pct = Math.max(0, Math.min(100, (elapsed / target) * 100));
  bar.hidden = false;
  bar.classList.toggle('done', done);
  bar.innerHTML = `<div class="rest-fill" style="width:${pct}%"></div>
    <div class="rest-content">
      <span class="rest-name">${esc(restState.name)}${done ? ' · rested ✓' : ''}</span>
      <span class="rest-time">${fmtClock(elapsed)} <span class="rest-target">/ ${fmtClock(target)}</span></span>
    </div>`;
}
function startRestFor(name, sec) {
  if (!sec || sec <= 0) return;   // no target → no timer
  restState = { name, target: sec, start: Date.now() };
  if (restInterval) clearInterval(restInterval);
  restInterval = setInterval(paintRestBar, 500);
  paintRestBar();
}
function stopRest() {
  restState = null;
  if (restInterval) { clearInterval(restInterval); restInterval = null; }
  const bar = document.getElementById('rest-bar');
  if (bar) bar.hidden = true;
}

/* ============================================================
   EVENTS
   ============================================================ */
$$('.tab').forEach(t => t.addEventListener('click', () => {
  route = { tab: t.dataset.tab };
  render();
}));

// Auto-start the rest timer when you tap OUT of a set's reps field (whether or not you changed it).
document.addEventListener('focusout', e => {
  const t = e.target;
  if (!(t && t.matches && t.matches('input[data-f=reps]') && route._draft)) return;
  const exd = route._draft.exercises[+t.dataset.xi];
  if (!exd) return;
  if (exd.type === 'superset') { const c = exd.components[+t.dataset.ci]; if (c) startRestFor(c.name, c.rest); }
  else startRestFor(exd.name, exd.rest);
});

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action, id = btn.dataset.id;

  switch (a) {
    /* nav */
    case 'goto': route = { tab: btn.dataset.tab }; return render();
    case 'back-train': route = { tab: 'train' }; return render();
    case 'back-progress': route = { tab: 'progress' }; return render();
    case 'back-build': route = { tab: 'build' }; return render();

    /* train */
    case 'open-workout': route = { tab: 'train', workoutId: id, _draft: buildDraft(woById(id)) }; return render();
    case 'toggle-ex-note': {
      const f = $('.ex-note-field', btn.closest('.ex-block'));
      if (f) { f.hidden = !f.hidden; if (!f.hidden) $('input', f).focus(); }
      return;
    }
    case 'skip-set': {
      const st = route._draft.exercises[+btn.dataset.xi].sets[+btn.dataset.si];
      if (st.skipped) { st.skipped = false; delete st.skipReason; return render(); }  // restore instantly
      reasonPrompt(`Why skip set ${+btn.dataset.si + 1}?`, ['Ran out of time', 'Soreness', 'Injury / pain'], reason => {
        st.skipped = true; st.skipReason = reason; render();
      });
      return;
    }
    case 'skip-ss-round': {
      const exd = route._draft.exercises[+btn.dataset.xi];
      const r = +btn.dataset.round;
      exd.skippedRounds = exd.skippedRounds || {};
      if (exd.skippedRounds[r] != null) { delete exd.skippedRounds[r]; return render(); }  // restore instantly
      reasonPrompt(`Why skip round ${r + 1}?`, ['Ran out of time', 'Soreness', 'Injury / pain'], reason => {
        exd.skippedRounds[r] = reason; render();
      });
      return;
    }
    case 'ex-menu': return exerciseMenu(+btn.dataset.xi);
    case 'swap-exercise': {
      const xi = +btn.dataset.xi;
      pickExerciseSheet('Swap for…', newId => {
        const exd = route._draft.exercises[xi];
        const n = exd.type === 'lifting' && exd.sets ? exd.sets.length : undefined;
        const nd = draftExercise(newId, route._draft.date, n);
        nd.swappedFrom = exd.swappedFrom || exd.name;
        nd.rest = exd.rest || 0;  // keep the slot's rest target
        route._draft.exercises[xi] = nd;
        render();
      });
      return;
    }
    case 'skip-exercise': {
      const xi = +btn.dataset.xi;
      reasonPrompt('Why skip this exercise?', ['Machine unavailable', 'Laziness', 'Injury / pain', 'No time'], reason => {
        const exd = route._draft.exercises[xi];
        exd.skipped = true; exd.skipReason = reason; render();
      });
      return;
    }
    case 'unskip-exercise': {
      const exd = route._draft.exercises[+btn.dataset.xi];
      exd.skipped = false; delete exd.skipReason; return render();
    }
    case 'add-exercise-today': {
      pickExerciseSheet('Add exercise for today', newId => {
        const nd = draftExercise(newId, route._draft.date);
        nd.added = true;
        route._draft.exercises.push(nd); render();
      });
      return;
    }
    case 'close-sheet': return closeSheet();
    case 'save-session': {
      const sess = collectSession();
      if (!sess.entries.length) return toast('Nothing logged yet');
      state.sessions.push(sess); save();
      route = { tab: 'progress' }; render();
      // Push to GitHub right now so it never gets forgotten.
      if (ghConfigured()) { toast('☁️ Saving to GitHub…'); ghPush(); }
      else toast('✅ Workout saved');
      return;
    }

    /* progress */
    case 'open-exercise': route = { tab: 'progress', exerciseId: id }; return render();
    case 'open-superset': route = { tab: 'progress', supersetId: id }; return render();
    case 'open-session': return sessionDetailSheet(id);
    case 'del-session': {
      state.sessions = state.sessions.filter(s => s.id !== btn.dataset.id); save();
      closeSheet(); render(); return toast('Session deleted');
    }

    /* build: workouts */
    case 'new-workout': {
      const w = { id: uid(), name: 'New workout', items: [] };
      state.workouts.push(w); save(); route = { tab: 'build', workoutId: w.id }; return render();
    }
    case 'edit-workout': route = { tab: 'build', workoutId: id }; return render();
    case 'del-workout': {
      if (!confirm('Delete this workout? (Past sessions are kept.)')) return;
      state.workouts = state.workouts.filter(w => w.id !== route.workoutId); save();
      route = { tab: 'build' }; return render();
    }
    case 'add-item': return exercisePicker();
    case 'pick-exercise': {
      const w = woById(route.workoutId); const ex = exById(id);
      const cardio = ex && ex.type === 'cardio';
      w.items.push({ exerciseId: id, sets: cardio ? 1 : 3, rest: cardio ? 0 : 90 });
      save(); closeSheet(); return render();
    }
    /* build: supersets */
    case 'add-superset': return supersetBuilder(null);
    case 'edit-superset': return supersetBuilder(btn.dataset.ssid);
    case 'ssb-add':
      pickExerciseSheet('Add a move', exId => { route._ssb.components.push({ exerciseId: exId, rest: 60 }); renderSupersetBuilder(); });
      return;
    case 'ssb-save': {
      const ssb = route._ssb;
      if (!ssb || ssb.components.length < 2) return toast('Add at least 2 moves');
      const name = ssb.components.map(c => (exById(c.exerciseId) || {}).name).filter(Boolean).join(' + ');
      if (ssb.id) { const ss = ssById(ssb.id); ss.components = ssb.components; ss.name = name; }
      else {
        const ss = { id: uid(), name, components: ssb.components };
        state.supersets.push(ss);
        woById(route.workoutId).items.push({ supersetId: ss.id, sets: 3 });
      }
      route._ssb = null; save(); closeSheet(); return render();
    }
    case 'move-item': {
      const w = woById(route.workoutId); const i = +btn.dataset.idx, dir = +btn.dataset.dir, j = i + dir;
      if (j < 0 || j >= w.items.length) return;
      [w.items[i], w.items[j]] = [w.items[j], w.items[i]]; save(); return render();
    }
    case 'remove-item': {
      const w = woById(route.workoutId); w.items.splice(+btn.dataset.idx, 1); save(); return render();
    }

    /* build: exercises */
    case 'new-exercise': return exerciseForm(null);
    case 'edit-exercise': return exerciseForm(exById(id));
    case 'save-exercise': {
      const sheet = $('#sheet');
      const name = $('[data-ef=name]', sheet).value.trim();
      if (!name) return toast('Name required');
      const exId = $('[data-ef=id]', sheet).value;
      const type = $('[data-action=ef-type] .on', sheet)?.dataset.v || 'lifting';
      const muscle = $('[data-ef=muscle]', sheet).value.trim();
      if (exId) { const ex = exById(exId); Object.assign(ex, { name, type, muscle }); }
      else state.exercises.push({ id: uid(), name, type, muscle });
      save(); closeSheet(); return render();
    }
    case 'del-exercise': {
      if (!confirm('Delete this exercise? It will be removed from workouts. Past sessions keep their record.')) return;
      const exId = btn.dataset.id;
      state.exercises = state.exercises.filter(x => x.id !== exId);
      state.workouts.forEach(w => w.items = w.items.filter(i => i.exerciseId !== exId));
      save(); closeSheet(); return render();
    }

    /* settings: data */
    case 'export': return exportData();
    case 'import': return importData();
    case 'reset-data': {
      if (!confirm('Erase ALL local data and start fresh? (Export first if unsure.)')) return;
      state = defaults(); save(); route = { tab: 'train' }; return render();
    }
    /* settings: github */
    case 'gh-save': { readGithubInputs(); save(); return toast('Config saved'); }
    case 'gh-push': { readGithubInputs(); save(); return ghPush(); }
    case 'gh-pull': { readGithubInputs(); save(); return ghPull(); }
  }
});

/* segmented + inline inputs via change/input delegation */
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-action=session-date]')) { if (route._draft) route._draft.date = t.value; return; }
  if (t.matches('[data-action=item-sets]')) {
    const w = woById(route.workoutId); w.items[+t.dataset.idx].sets = Math.max(1, +t.value || 1); save(); return;
  }
  if (t.matches('[data-action=item-rest]')) {
    const w = woById(route.workoutId); w.items[+t.dataset.idx].rest = +t.value || 0; save(); return;
  }
  if (t.matches('[data-action=cycle-start]')) { state.settings.cycleStartDate = t.value; save(); render(); return; }
  if (t.matches('[data-action=cycle-len]')) { state.settings.cycleLengthDays = Math.max(1, +t.value || 8); save(); render(); return; }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-action=workout-name]')) { woById(route.workoutId).name = t.value; save(); return; }
  // live-session draft fields (not persisted until the workout is saved)
  if (route._draft && t.dataset.xi !== undefined) {
    const exd = route._draft.exercises[+t.dataset.xi];
    if (!exd) return;
    if (t.dataset.fnote) exd.note = t.value;
    else if (t.dataset.fc) exd.cardio[t.dataset.fc] = t.value;
    else if (t.dataset.ci !== undefined && t.dataset.si !== undefined) exd.components[+t.dataset.ci].sets[+t.dataset.si][t.dataset.f] = t.value;
    else if (t.dataset.f && t.dataset.si !== undefined) exd.sets[+t.dataset.si][t.dataset.f] = t.value;
  }
});
/* segmented buttons (units, exercise type) */
document.addEventListener('click', e => {
  const seg = e.target.closest('.seg button'); if (!seg) return;
  const wrap = seg.closest('.seg');
  $$('button', wrap).forEach(b => b.classList.toggle('on', b === seg));
  if (wrap.dataset.action === 'units') { state.settings.units = seg.dataset.v; save(); render(); }
});

/* ---------------- data import/export ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `gym-tracker-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported');
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.exercises || !data.workouts) throw new Error('bad file');
        state = data; // replace
        state.settings = Object.assign({}, defaults().settings, data.settings || {});
        state.settings.github = Object.assign({}, defaults().settings.github, (data.settings || {}).github || {});
        save(); route = { tab: 'train' }; render(); toast('Imported');
      } catch (err) { toast('⚠️ Invalid file'); }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ============================================================
   GITHUB SYNC  (fine-grained token, Contents API)
   ============================================================ */
function readGithubInputs() {
  const g = state.settings.github;
  $$('[data-g]').forEach(inp => { g[inp.dataset.g] = inp.value.trim(); });
  if (!g.path) g.path = `data/${(g.user || 'me').replace(/[^a-z0-9_-]/gi, '') || 'me'}.json`;
}
function ghConfigured() {
  const g = state.settings.github;
  return g.owner && g.repo && g.token && (g.user || g.path);
}
function ghPath() {
  const g = state.settings.github;
  return g.path || `data/${(g.user || 'me')}.json`;
}
function ghHeaders() {
  return { Authorization: `Bearer ${state.settings.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function ghUrl() {
  const g = state.settings.github;
  return `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${ghPath()}?ref=${encodeURIComponent(g.branch || 'main')}`;
}
function ghStatus(msg) { const s = $('#gh-status'); if (s) s.textContent = msg; }
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

function syncPayload() {
  const { github, ...settings } = state.settings; // never push the token
  return { version: state.version, settings, exercises: state.exercises, workouts: state.workouts, sessions: state.sessions };
}

async function ghGetSha() {
  try {
    const res = await fetch(ghUrl(), { headers: ghHeaders() });
    if (res.status === 404) return { sha: null, json: null };
    if (!res.ok) throw new Error('GET ' + res.status);
    const data = await res.json();
    return { sha: data.sha, json: JSON.parse(b64decode(data.content)) };
  } catch (e) { throw e; }
}

async function ghPush() {
  clearTimeout(autoPushTimer); // an explicit push cancels any pending debounced one
  if (!ghConfigured()) { ghStatus('⚠️ Fill owner, repo, name and token first.'); return; }
  ghStatus('Pushing…');
  try {
    const { sha } = await ghGetSha();
    const g = state.settings.github;
    const body = {
      message: `gym sync ${new Date().toISOString()}`,
      content: b64encode(JSON.stringify(syncPayload(), null, 2)),
      branch: g.branch || 'main',
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}/contents/${ghPath()}`, {
      method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('PUT ' + res.status + ' — ' + (await res.text()).slice(0, 120));
    ghStatus('✅ Pushed ' + new Date().toLocaleTimeString());
    toast('☁️ Synced');
  } catch (e) { ghStatus('❌ ' + e.message); toast('Sync failed'); }
}

async function ghPull() {
  if (!ghConfigured()) { ghStatus('⚠️ Fill owner, repo, name and token first.'); return; }
  ghStatus('Pulling…');
  try {
    const { json } = await ghGetSha();
    if (!json) { ghStatus('No cloud file yet — push first.'); return; }
    const gh = state.settings.github;
    state = Object.assign({}, json);
    state.settings = Object.assign({}, defaults().settings, json.settings || {}, { github: gh });
    save(); render(); ghStatus('✅ Pulled ' + new Date().toLocaleTimeString()); toast('☁️ Pulled latest');
  } catch (e) { ghStatus('❌ ' + e.message); toast('Pull failed'); }
}

let autoPushTimer;
function maybeAutoPush() {
  if (!ghConfigured() || !navigator.onLine) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => { ghPush().catch(() => {}); }, 4000); // debounce
}

/* ============================================================
   BOOT
   ============================================================ */
render();

const IS_DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !IS_DEV) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
