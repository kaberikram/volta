// Edit planner: turns a beat grid + video analysis into a deterministic, seeded edit (looks, camera moves, hits).
import { rng, clamp, hsh, smoothstep, easeIOC, pct } from './util.js';
import { poseStats, stageFit, motionEnv, descDist, STYLES } from './pose.js';

export const PALETTES = {
  reference: {
    led: ['ledred', 'led'], macro: ['macro'], flat: ['red', 'cream', 'gold', 'pink', 'mono', 'yellow', 'cyan', 'purple'],
    ink: ['cream', 'yellow', 'cyan'], spark: ['spark', 'sparkg', 'sparkp'], echo: ['echoB', 'echoO', 'echoY', 'echoC'], inv: ['invdots']},
  mono: {led: ['led'], macro: ['macro'], flat: ['mono', 'cream', 'gold'], ink: ['cream'], spark: ['spark', 'sparkg'], echo: ['echoK', 'echoW'], inv: ['invdots']},
  hot: {led: ['ledred', 'led'], macro: ['macro'], flat: ['red', 'gold', 'yellow', 'cream'], ink: ['yellow', 'cream'], spark: ['sparkg', 'spark'], echo: ['echoO', 'echoY'], inv: ['invdots']},
  cool: {led: ['led'], macro: ['macro'], flat: ['pink', 'cyan', 'purple', 'mono'], ink: ['cyan', 'cream'], spark: ['spark', 'sparkp'], echo: ['echoB', 'echoC'], inv: ['invdots']},
};
// plates stage per palette (missing keys fall back to reference): stage looks, ghost materials, strobe flash colours
const STAGE_PAL = {
  reference: {stage: ['plates', 'platesR', 'plates', 'platesW'], mats: {hit: ['redGloss', 'redGlass'], move: ['whiteHot', 'smokeGlass'], dark: ['graphite', 'tealStone']}, strobe: ['#ff2a1a', '#ffffff']},
  hot: {stage: ['platesR', 'plates'], mats: {move: ['whiteHot', 'gold']}},
  cool: {stage: ['platesC', 'plates'], mats: {hit: ['whiteHot', 'cyanGlass']}, strobe: ['#00c6ee', '#ffffff']},
  mono: {stage: ['platesW', 'plates'], mats: {hit: ['whiteHot']}, strobe: ['#ffffff', '#ffffff']},
};
export const stagePal = name => { const r = STAGE_PAL.reference, p = STAGE_PAL[name] || r; return {stage: p.stage || r.stage, strobe: p.strobe || r.strobe, mats: {...r.mats, ...(p.mats || {})}}; };
export const GHOST = {cap: 14, keep: 8, life: 10, collapse: .6, build: .16, max: Infinity};   // live ghosts are bounded by cap / keep / life
const GLASS = new Set(['redGlass', 'smokeGlass', 'cyanGlass']);
export const SCENES = ['mix', 'dots', 'plates'];

/**
 * grid: {beats:[t...], kick:[...], barOffset, P}; dur: output duration; video: analysis bundle (area per frame)
 * returns plan: {sched:[{t,look,pitch,strobe}], beats, bars, flashes, dets, echoHits, holds, freeze, reform, fly, swings, barCam, params}
 */
export function makePlan(grid, dur, video, {seed = 1, intensity = 1, strobe = .7, palette = 'reference', scene = 'mix', live = false} = {}) {
  const R = rng(seed * 9973 + 17), pal = PALETTES[palette] || PALETTES.reference, P = grid.P;
  const beats = grid.beats.slice(), nb = beats.length;
  const bt = b => { const k = Math.floor(b), f = b - k; const t0 = k < nb ? beats[k] : beats[nb - 1] + (k - nb + 1) * P; return t0 + f * P; };
  const off = grid.barOffset || 0;
  const barStarts = []; for (let k = off; k < nb; k += 4) barStarts.push(k);
  const NBar = barStarts.length;
  // bar roles
  const role = Array(NBar).fill(null); role[0] = 'drop'; if (NBar >= 2) role[NBar - 1] = 'end';
  let fzBar = -1;
  if (NBar >= 5) { const mid = Math.round(NBar / 2); const cands = [...Array(NBar).keys()].filter(i => i > 1 && i < NBar - 2 && role[i] == null);
    fzBar = cands.reduce((m, i) => (m < 0 || Math.abs(i - mid) - (i % 4 === 0 ? .6 : 0) < Math.abs(m - mid) - (m % 4 === 0 ? .6 : 0)) ? i : m, -1);
    if (fzBar > 0) { role[fzBar] = 'freeze'; if (fzBar + 1 < NBar - 1) role[fzBar + 1] = 'echo'; } }
  else if (NBar >= 3) { fzBar = 1; role[1] = 'freeze'; }
  const pool = ['half', 'spark', 'quarter', 'accel']; let last = null;
  for (let i = 0; i < NBar; i++) if (!role[i]) { const r = R.pickNot(pool, last); role[i] = r; last = r; }
  // events
  const sched = [], flashes = [], dets = [], echoHits = [], holds = [], swings = [], barCam = [];
  const add = (b, look, pitch, strobeStep = 0, burst = false) => { const t = bt(b); if (t < dur) sched.push({t, look, pitch, strobe: strobeStep, burst}); };
  const pick = cat => R.pick(pal[cat]); let prevLook = null; const pickN = cat => { const l = R.pickNot(pal[cat], prevLook); prevLook = l; return l; };
  const strobes = (b, n) => { if (R() > strobe) return; for (let s = 0; s < n; s++) add(b, s % 2 ? pickN('flat') : 'raw', 12, s, true); };
  const fl = (b, c, s) => flashes.push({t: bt(b), c, s: s * Math.min(1.2, .6 + .4 * intensity)});
  let freeze = null, reform = null, fly = null;
  for (let i = 0; i < NBar; i++) {
    const b0 = barStarts[i], r = role[i], sgn = i % 2 ? 1 : -1;
    barCam.push({b: b0, yaw: sgn * R.range(9, 15) * intensity, roll: -sgn * R.range(3, 6) * intensity, pitch: R.range(-5, 5) * intensity});
    fl(b0, i % 2 ? '#f2e6c9' : '#ffffff', i === 0 ? 1 : .85);
    if (r === 'drop') { dets.push(bt(b0)); add(b0, pick('led'), 16); add(b0 + 1, 'macro', 72); add(b0 + 1.5, pick('led'), 14); add(b0 + 2, 'macro', 50); add(b0 + 3, pickN('ink'), 12); strobes(b0 + 3.5, 2); add(b0 + 3.75, pickN('flat'), 14); swings.push({t: bt(b0), deg: (R() < .5 ? -1 : 1) * 38 * intensity, tau: .22, per: 1.2}); }
    else if (r === 'half') { for (let h = 0; h < 8; h++) add(b0 + h * .5, h % 2 ? pickN('flat') : (R() < .35 ? pick('led') : pickN('flat')), h % 2 ? R.pick([8, 9, 10]) : R.pick([12, 16, 20, 22])); strobes(b0 + 3.75, 3); }
    else if (r === 'spark') { for (let h = 0; h < 4; h++) add(b0 + h, h === 3 ? 'mono' : pickN('spark'), 7); add(b0 + 3.5, pickN('spark'), 7); if (R() < .6) echoHits.push(bt(b0 + 2)); }
    else if (r === 'quarter') { [0, .25, .5, .75].forEach(q => add(b0 + q, q * 4 % 2 ? pickN('ink') : pick('led'), R.pick([9, 12, 14, 20]))); add(b0 + 1, pick('inv'), 12); echoHits.push(bt(b0 + 1));
      add(b0 + 2, pickN('flat'), 9); add(b0 + 2.5, 'macro', 60); add(b0 + 3, pickN('ink'), 10); add(b0 + 3.5, pickN('flat'), 8); strobes(b0 + 3.75, 3); }
    else if (r === 'accel') { swings.push({t: bt(b0), deg: sgn * 32 * intensity, tau: .25, per: 1.4}); dets.push(bt(b0));
      add(b0, 'macro', 64); add(b0 + .5, pick('led'), 12); add(b0 + 1, pickN('flat'), 10); add(b0 + 1.5, pick('led'), 20); add(b0 + 2, pickN('flat'), 9); add(b0 + 2.5, pickN('ink'), 12); echoHits.push(bt(b0 + 2.5));
      add(b0 + 3, pickN('flat'), 10); add(b0 + 3.25, pick('led'), 16); add(b0 + 3.5, pickN('flat'), 10); strobes(b0 + 3.75, 3); }
    else if (r === 'freeze') { dets.push(bt(b0)); fly = {t0: bt(b0), t1: bt(b0 + 1)}; add(b0, pick('led'), 12); add(b0 + 1, pickN('flat'), 12); add(b0 + 1.5, pick('led'), 12); add(b0 + 2, pickN('spark'), 6);
      const t0 = bt(b0 + 2), t1 = bt(b0 + 4); freeze = {t0, t1, deg: (R() < .5 ? -1 : 1) * 62, lift: -10}; }
    else if (r === 'echo') { dets.push(bt(b0)); const e = [...pal.echo]; for (let h = 0; h < 4; h++) add(b0 + h, e[h % e.length], 7); }
    else if (r === 'end') { const lastB = nb - 1 - b0; if (lastB >= 1) { add(b0, 'scatter', 11); reform = {t0: bt(b0), tm: bt(b0 + .4), t1: bt(b0 + 1)}; add(b0 + 1, pick('led'), 14); fl(b0 + 1, '#f2e6c9', .85); strobes(b0 + 1.25, 4); }
      else { add(b0, pick('led'), 14); } }
    // hold -> slam into the strong bars
    if (i > 0 && ['quarter', 'freeze', 'end'].includes(r)) holds.push({t0: bt(b0 - .25), t1: bt(b0)});
  }
  // lead-in before first downbeat (partial bar): source LED
  if (off > 0) sched.push({t: 0, look: pick('led'), pitch: 14, strobe: 0});
  sched.sort((a, b) => a.t - b.t || a.strobe - b.strobe);
  // freeze frame: the most visible figure frame near the freeze start
  if (freeze && video) { const f0 = Math.floor(freeze.t0 * video.fps); let best = f0, ba = -1;
    for (let f = Math.max(0, f0 - 8); f <= Math.min(video.n - 1, f0); f++) { const a = video.area[Math.floor(f / video.step)] || 0; if (a > ba) { ba = a; best = f; } } freeze.frame = best; }
  const plan = {seed, intensity, strobe, palette, dur, P, beats, kick: grid.kick, barStarts: barStarts.map(k => beats[k]), roles: role, sched, flashes, dets, echoHits, holds, freeze, reform, fly, swings, barCam};
  return addStage(plan, {grid, video, bt, barStarts, off, NBar, role, scene: SCENES.includes(scene) ? scene : 'mix', live});
}

const DOTS = (plan, scene, note) => Object.assign(plan, {scene, sceneNote: note || '', stages: plan.roles.map(() => 'D'), runs: [], stageBars: [], shots: [], ghosts: [], orbit: null});

/** Stage layer: carves plates runs out of the dots edit and plans the pose ghosts. Own RNG streams, so 'dots' is untouched. */
function addStage(plan, {grid, video, bt, barStarts, off, NBar, role, scene, live}) {
  if (scene === 'dots') return DOTS(plan, 'dots');
  const {seed, dur, P, beats, palette} = plan, nb = beats.length;
  // live (webcam): the video doesn't exist yet, so plates runs, looks and shots come from the music; ghosts and the
  // orbit are filled in by the live director as the take runs
  if (!live && (!video || !video.dm || !video.dm.length)) return DOTS(plan, 'dots', 'plates need the video analysis');
  // a pose can be printed when the person is found and covers >= 1% of the frame (video.js tracks the pivot from there)
  const st = live ? [] : poseStats(video), vis = live ? [] : st.map((s, k) => s.ok && (video.area[k] || 0) >= .01);
  if (!live) {
    const nOk = st.filter(s => s.ok).length, nVis = vis.filter(Boolean).length;
    if (!nOk) return DOTS(plan, 'dots', 'no person found, so dots only');
    if (nVis < Math.max(3, .3 * nOk)) return DOTS(plan, 'dots', 'the dancer is too small in frame for plates, so dots only');
  }
  if (nb < 4 || !NBar) return DOTS(plan, 'dots', 'not enough beats for plates');
  const fit = live ? null : stageFit(video);
  const RS = rng(seed * 7919 + 101), RC = rng(seed * 7919 + 202), sp = stagePal(palette), env = live ? null : motionEnv(video);
  const fps = live ? 30 : video.fps, nf = live ? Math.ceil(dur * 30) + 1 : video.n;
  const barT = i => i < NBar ? bt(barStarts[i]) : dur;
  const barEnd = i => i + 1 < NBar ? bt(barStarts[i + 1]) : dur;
  const kickAt = k => grid.kick && grid.kick[k] != null ? grid.kick[k] : .6;
  const envMean = (t0, t1) => { if (live) return 0; let s = 0, c = 0; for (let f = Math.max(0, Math.floor(t0 * fps)); f < Math.min(nf, Math.ceil(t1 * fps)); f++) { s += env[f]; c++; } return c ? s / c : 0; };
  // --- which bars are plates
  const stages = Array(NBar).fill('D'); let note = '';
  if (scene === 'plates') stages.fill('P');
  else {
    const visBar = i => { if (live) return true; let a = 0, c = 0; for (let f = Math.floor(barT(i) * fps); f < Math.min(nf, Math.ceil(barEnd(i) * fps)); f += video.step) { a += vis[Math.min(vis.length - 1, Math.floor(f / video.step))]; c++; } return c && a / c >= .5; };
    // bar 0 (the opening drop) stays dots; the freeze bar is the dots signature unless there is nothing else to use
    const E = new Set(); for (let i = 1; i < NBar; i++) if (role[i] !== 'freeze' && visBar(i)) E.add(i);
    if (E.size < 2) { const f = role.indexOf('freeze'); if (f > 0 && visBar(f)) E.add(f); }
    if (NBar < 2 || !E.size) note = 'the clip is too short for a plates section';
    else {
      const target = Math.max(1, Math.min(Math.round(.5 * NBar), E.size)); let left = target;
      const drops = (grid.drops || []).map(t => t);
      const kicks = barStarts.map((b, i) => { let s = 0, c = 0; for (let k = b; k < Math.min(nb, b + 4); k++) { s += kickAt(k); c++; } return c ? s / c : 0; });
      const kmax = Math.max(...kicks, 1e-6);
      const wins = [];
      for (const i of E) for (let L = 1; L <= 4; L++) {
        let ok = true; for (let j = i; j < i + L; j++) if (!E.has(j)) ok = false; if (!ok) break;
        const t0 = barT(i), t1 = barEnd(i + L - 1), kn = kicks.slice(i, i + L).reduce((a, b) => a + b, 0) / L / kmax;
        const drop = drops.some(t => t >= t0 - .05 && t < t1) || role[i] === 'drop' ? 1 : 0;
        wins.push({i, L, s: .45 * Math.min(1.2, envMean(t0, t1)) + .25 * kn + .35 * drop + .1 * (L === 2 || L === 3) - .2 * (L === 1) + .15 * RS()});
      }
      wins.sort((a, b) => b.s - a.s);
      const taken = i => stages[i] === 'P';
      for (const w of wins) {
        if (left <= 0) break; if (w.L > left) continue;
        let clash = false; for (let j = w.i - 1; j <= w.i + w.L; j++) if (j >= 0 && j < NBar && taken(j)) clash = true;
        if (clash) continue;
        for (let j = w.i; j < w.i + w.L; j++) stages[j] = 'P'; left -= w.L;
      }
      // fill up to ~half: first isolated single-bar runs, then grow runs up to 4 bars; never merge two runs
      const runLen = i => { let a = i, b = i; while (a - 1 >= 0 && taken(a - 1)) a--; while (b + 1 < NBar && taken(b + 1)) b++; return b - a + 1; };
      for (let pass = 0; pass < 2 && left > 0; pass++) for (let i = 1; i < NBar && left > 0; i++) {
        if (taken(i) || !E.has(i)) continue;
        const l = taken(i - 1), r = i + 1 < NBar && taken(i + 1);
        if (pass === 0 ? (l || r) : (l && r) || (!l && !r) || runLen(l ? i - 1 : i + 1) >= 4) continue;
        stages[i] = 'P'; left--;
      }
    }
  }
  const runs = [];
  for (let i = 0; i < NBar; i++) if (stages[i] === 'P' && (i === 0 || stages[i - 1] !== 'P')) { let j = i; while (j + 1 < NBar && stages[j + 1] === 'P') j++; runs.push({b0: i, b1: j + 1, t0: i === 0 && scene === 'plates' ? 0 : barT(i), t1: barEnd(j)}); }
  if (!runs.length) return DOTS(plan, 'mix', note);
  if (scene === 'plates') { plan.freeze = null; plan.reform = null; plan.fly = null; }
  if (plan.reform && stages[NBar - 1] === 'P') plan.reform = null;           // a plates ending replaces the dots re-form
  const inRunT = t => runs.findIndex(r => t >= r.t0 - 1e-6 && t < r.t1 - 1e-6);
  // --- stage bar parameters
  let hoopPrev = [], lastAz = RS() * 6.283;
  const kmed = pct(beats.map((_, k) => kickAt(k)), .5);
  const stageBars = stages.map((sg, i) => {
    const b = barStarts[i], k = kickAt(b), hp = hoopPrev.length >= 2 && hoopPrev[0] === hoopPrev[1] ? [0, 1, 2].filter(x => x !== hoopPrev[0]) : [0, 1, 2];
    const hoop = RS.pick(hp); hoopPrev = [hoop, ...hoopPrev].slice(0, 2); lastAz += RS.range(.6, 2.2) * (RS() < .5 ? -1 : 1);
    const fan = ['drop', 'quarter', 'accel'].includes(role[i]) || k > kmed;
    return {lasers: fan ? 'fan' : 'cage', hoop, emAz: lastAz, redGrid: fan, reveal: !!runs.length && i === runs[0].b0};
  });
  // --- carve the look schedule inside runs
  const sched = [], groups = new Map();
  for (const e of plan.sched) {
    if (inRunT(e.t) < 0) { sched.push(e); continue; }
    if (e.burst) { const g = groups.get(e.t) || 0; groups.set(e.t, Math.max(g, (e.strobe || 0) + 1)); }
  }
  const stageLooks = []; let prevLook = null;
  const addLook = t => { const l = RS.pickNot(sp.stage, prevLook); prevLook = l; stageLooks.push({t, look: l, pitch: 12, strobe: 0}); };
  for (const r of runs) {
    for (let i = r.b0; i < r.b1; i++) { addLook(i === r.b0 ? r.t0 : barT(i)); if (['quarter', 'accel', 'freeze'].includes(role[i]) && bt(barStarts[i] + 2) < barEnd(i)) addLook(bt(barStarts[i] + 2)); }
  }
  const lookAtT = t => { let l = stageLooks[0].look; for (const e of stageLooks) if (e.t <= t + 1e-9) l = e.look; return l; };
  for (const [t, n] of groups) {
    const cur = lookAtT(t);
    for (let s2 = 0; s2 < n; s2++) {
      sched.push({t, look: s2 % 2 ? cur : 'platesK', pitch: 12, strobe: s2, burst: true});
      if (s2 % 2) plan.flashes.push({t, step: s2, c: sp.strobe[(s2 >> 1) % 2], s: .55, burst: true});
    }
    sched.push({t, look: cur, pitch: 12, strobe: n, burst: false});
  }
  sched.push(...stageLooks);
  sched.sort((a, b) => a.t - b.t || a.strobe - b.strobe);
  plan.sched = sched;
  plan.echoHits = plan.echoHits.filter(t => inRunT(t) < 0);
  for (const r of runs) {
    if (r.b0 > 0 && !plan.holds.some(h => Math.abs(h.t1 - r.t0) < 1e-6)) plan.holds.push({t0: bt(barStarts[r.b0] - .25), t1: r.t0});
    if (!plan.dets.some(t => Math.abs(t - r.t0) < 1e-6)) plan.dets.push(r.t0);
  }
  plan.holds.sort((a, b) => a.t0 - b.t0); plan.dets.sort((a, b) => a - b);
  // --- the footage frame on screen at t (mirrors renderer.footageF)
  const sf = t => { const fz = plan.freeze; if (fz && t >= fz.t0 && t < fz.t1) return Math.min(nf - 1, fz.frame);
    for (const h of plan.holds) if (t >= h.t0 && t < h.t1) return Math.min(nf - 1, Math.floor(h.t0 * fps));
    return clamp(Math.floor(t * fps), 0, nf - 1); };
  const stillT = t => { const fz = plan.freeze; return (fz && t >= fz.t0 && t < fz.t1) || plan.holds.some(h => t >= h.t0 && t < h.t1); };
  // --- camera shots (one per plates downbeat, a second mid-bar on quarter / accel bars); calm is all zero while live
  function planShots() {
    const shots = []; let prevKind = null, lastTop = -9, az = RC() * 6.283, nP = 0;
    const calmMean = (t0, t1) => { let s2 = 0, c = 0; for (let i = Math.floor(t0 * OH); i <= Math.min(M - 1, Math.ceil(t1 * OH)); i++) { s2 += calm[i]; c++; } return c ? s2 / c : 0; };
    const addShot = (t, t1, bi, entrance, mid) => {
      const still = calmMean(t, t1) > .6, fan = stageBars[bi].lasers === 'fan';
      let kinds = entrance ? ['push', 'orbit', 'low'] : still && !mid ? ['orbit', 'orbit', 'top'] : ['orbit', 'orbit', 'low', 'top', 'push', 'track', 'track', 'rake'];
      kinds = kinds.filter(k => k !== prevKind && (k !== 'top' || nP - lastTop >= 4) && (k !== 'rake' || fan));
      if (!kinds.length) kinds = ['orbit', 'low'].filter(k => k !== prevKind);
      const kind = RC.pick(kinds); if (kind === 'top') lastTop = nP;
      az += RC.range(70, 150) * Math.PI / 180 * (RC() < .5 ? -1 : 1);
      shots.push({t, kind, az, r: RC.range(.9, 1.15), h: RC.range(.85, 1.2), sgn: still ? -dir : RC() < .5 ? -1 : 1, still, high: kind === 'orbit' && (still || RC() < .3), bar: bi});
      prevKind = kind; nP++;
    };
    for (const r of runs) for (let i = r.b0; i < r.b1; i++) {
      const t0 = i === r.b0 ? r.t0 : barT(i), mid = ['quarter', 'accel'].includes(role[i]) ? bt(barStarts[i] + 2) : null;
      addShot(t0, mid != null && mid < barEnd(i) ? mid : barEnd(i), i, i === r.b0, false);
      if (mid != null && mid < barEnd(i) - .05) addShot(mid, barEnd(i), i, false, true);
    }
    return shots;
  }
  // --- orbit: angle integrates faster when the dancer is still (pure, 30 Hz grid)
  const OH = 30, M = Math.ceil(dur * OH) + 2, calm = new Float64Array(M), acc = new Float64Array(M), dir = RS() < .5 ? -1 : 1;
  if (live) {                       // filled by the live director; orbitAt extrapolates past n
    plan.orbit = {hz: OH, calm, acc, dir, n: 0, live: true};
    const phi0 = RS() * 6.283, ghosts = [];
    return Object.assign(plan, {scene, sceneNote: note, stages, runs, stageBars, shots: planShots(), ghosts, live: {phi0, sp}});
  }
  let cv = 1 - smoothstep(.08, .4, stillT(0) ? 0 : env[sf(0)]), av = 0;
  for (let i = 0; i < M; i++) {
    const t = i / OH, e = stillT(t) ? 0 : env[sf(t)], tgt = 1 - smoothstep(.08, .4, e);
    if (i) { const tau = tgt > cv ? .7 : .1; cv += (tgt - cv) * (1 - Math.exp(-1 / OH / tau)); av += cv * cv / OH; }
    calm[i] = cv; acc[i] = av;
  }
  plan.orbit = {hz: OH, calm, acc, dir};
  // --- ghost spawns: strong beats + pose-change onsets on the 1/8 grid
  const cand = new Map();
  for (let j = 0; ; j++) {
    const te = bt(j / 2); if (te >= dur - .05) break; if (te < 0) continue;
    const k = j / 2, down = j % 2 === 0 && k >= off && (k - off) % 4 === 0;
    if (j % 2 === 0 && (kickAt(k) >= .8 || down)) cand.set(j, {j, t: te, beat: 1, move: 0, down: down ? 1 : 0, mv: 0});
    else if (down) cand.set(j, {j, t: te, beat: 1, move: 0, down: 1, mv: 0});
  }
  const snapW = Math.min(.10, .30 * P);
  for (let f = 6; f < nf - 4; f++) {
    const e = env[f]; if (e < .8) continue;
    let mx = true; for (let q = f - 4; q <= f + 4; q++) if (env[q] > e) mx = false; if (!mx) continue;
    let lo = 9; for (let q = f - 6; q < f; q++) lo = Math.min(lo, env[q]); if (e - lo < .35) continue;
    const tf = f / fps; if (stillT(tf)) continue;
    const jj = Math.round((tf - (beats[0] || 0)) / (P / 2)); const te = bt(jj / 2);
    if (jj < 0 || Math.abs(te - tf) > snapW || te >= dur - .05) continue;
    const c0 = cand.get(jj) || {j: jj, t: te, beat: 0, move: 0, down: 0, mv: 0}; c0.move = 1; c0.mv = Math.max(c0.mv, e); cand.set(jj, c0);
  }
  const caps = {drop: 4, half: 4, spark: 2, quarter: 5, accel: 6, freeze: 2, echo: 4, end: 1};
  const barOf = t => { let b = -1; for (let i = 0; i < NBar; i++) if (barT(i) <= t + 1e-6) b = i; return b; };
  const runDown = runs.map(r => barT(r.b0));
  const list = [...cand.values()].map(c => ({...c, S: .6 * c.beat + .8 * c.move + .3 * (c.beat && c.move) + .25 * c.down, forced: runDown.some(t => Math.abs(t - c.t) < 1e-6)}));
  const byBar = new Map(); for (const c of list) { const b = barOf(c.t); if (!byBar.has(b)) byBar.set(b, []); byBar.get(b).push(c); }
  for (const t of runDown) if (!list.some(c => Math.abs(c.t - t) < 1e-6) && t < dur - .05) { const c = {j: -1, t, beat: 1, move: 0, down: 1, mv: 0, S: 2, forced: true}; const b = barOf(t); if (!byBar.has(b)) byBar.set(b, []); byBar.get(b).push(c); }
  const chosen = [];
  for (const [b, cs] of byBar) {
    const P_ = b >= 0 ? stages[b] === 'P' : scene === 'plates';
    let cap = b >= 0 ? (caps[role[b]] || 3) : 1; if (!P_) cap = cs.some(c => c.mv >= .9) ? 2 : 1;
    const gap = P_ ? Math.max(P / 2, .2) : 2 * P, pick = [];
    cs.sort((a, c) => (c.forced - a.forced) || (c.S - a.S) || (a.t - c.t));
    for (const c of cs) { if (pick.length >= cap) break; if (pick.some(p => Math.abs(p.t - c.t) < gap - 1e-6)) continue; pick.push(c); }
    chosen.push(...pick);
  }
  chosen.sort((a, b) => a.t - b.t);
  // time-ordered pass: pose frame, novelty gate, attributes, ring slots, lifetimes
  const area = video.area, amax = Math.max(...area, 1e-6), step = video.step;
  const ghosts = []; let lastDesc = null, lastT = -1e9;
  const phi0 = RS() * 6.283;
  const mkGhost = (c, i, seeded) => {
    const s0 = sf(c.t); let best = -1, bs = -1e9;
    for (let f = Math.max(0, s0 - 3); f <= Math.min(nf - 1, s0 + 1); f++) { const k = Math.min(st.length - 1, Math.floor(f / step)), s2 = st[k]; if (!vis[k]) continue;
      const sc = .6 * area[k] / amax + .4 * s2.desc[s2.desc.length - 1] - .3 * Math.min(1, env[f] / 2); if (sc > bs) { bs = sc; best = f; } }
    return best;
  };
  const addGhost = ghostMaker({seed, P, sp, phi0, video, fit, st, inRunT}).bind(null, ghosts);
  if (scene === 'plates') {        // pre-seed a ring so a plates-only edit opens on a populated stage
    const qs = [.2, .4, .6, .8], used = [];
    qs.forEach((q, n) => { let best = -1, ba = -1; const c0 = Math.floor(q * nf);
      for (let f = Math.max(0, c0 - 30); f < Math.min(nf, c0 + 30); f++) { const k = Math.min(st.length - 1, Math.floor(f / step)); if (!vis[k]) continue;
        if (used.some(u => descDist(st[u].desc, st[k].desc) < .08)) continue; if (area[k] > ba) { ba = area[k]; best = f; } }
      if (best >= 0) { used.push(Math.min(st.length - 1, Math.floor(best / step))); addGhost({t: -1.5 - (qs.length - n) * P, beat: 0, move: 0, down: 0, forced: false}, best, true); } });
  }
  for (const c of chosen) {
    const f = mkGhost(c); if (f < 0) continue;
    const k = Math.min(st.length - 1, Math.floor(f / step));
    const novel = !lastDesc || descDist(st[k].desc, lastDesc) >= .08;
    if (!novel && !c.forced && !(c.down && c.t - lastT >= 4 * P)) continue;
    addGhost(c, f, false); lastDesc = st[k].desc; lastT = c.t;
  }
  ghostFades(ghosts, stages[NBar - 1] === 'P' ? barT(NBar - 1) : null, P, dur);
  const shots = planShots();
  return Object.assign(plan, {scene, sceneNote: note, stages, runs, stageBars, shots, ghosts});
}

/** a ghost's material under palette sp (same pick as ghostMaker; the plate style stays, so a palette change only recolours). */
export const ghostMat = (g, sp) => { const mats = sp.mats[g.cls]; return mats ? mats[Math.floor(hsh(g.seed * 977.13 + g.i * 13.7 + 2) * mats.length) % mats.length] : g.mat; };
/** ghost attributes (material, plate style, ring slot, timing), shared by the planner and the live director.
 *  Returns add(ghosts, candidate, frame, seeded) which appends a ghost; the draw order of h() is part of the plan. */
export function ghostMaker({seed, P, sp, phi0, video, fit, st, inRunT}) {
  const h = (j, n) => hsh(seed * 977.13 + j * 13.7 + n), matHist = [], step = video.step;
  return (ghosts, c, f, seeded) => {
    const i = ghosts.length, k = Math.min(st.length - 1, Math.floor(f / step));
    let cls = seeded ? 'dark' : (c.forced || c.down) ? 'hit' : (c.move && !c.beat) ? 'move' : h(i, 1) < .4 ? 'hit' : h(i, 1) < .7 ? 'move' : 'dark';
    if (matHist.length >= 2 && matHist[0] === cls && matHist[1] === cls) cls = cls === 'hit' ? 'move' : cls === 'move' ? 'dark' : 'hit';
    matHist.unshift(cls); matHist.length = Math.min(2, matHist.length);
    const mats = sp.mats[cls], mat = mats[Math.floor(h(i, 2) * mats.length) % mats.length];
    const style = GLASS.has(mat) ? 'thin' : mat === 'redGloss' ? (h(i, 5) < .5 ? 'thin' : 'pebble') : mat === 'whiteHot' || mat === 'gold' ? (h(i, 5) < .5 ? 'bar' : 'pebble') : 'pebble';
    const s2 = st[k], w = s2.ok ? (s2.x1 - s2.x0 + 1) / video.aw * 2 * (video.w / video.h) * (2.4 - 1.8 * s2.pd) * fit.k : .6;
    // ring slot: golden angle on the inner ring; else the nearest free spot on 3 rings x 24 angles; else the roomiest
    const pref = phi0 + i * 2.39996, near = ghosts.slice(-GHOST.cap);
    const room = (A, r) => { let mn = 1e9; for (const g of near) mn = Math.min(mn, Math.hypot(r * Math.sin(A) - g.r * Math.sin(g.ang), r * Math.cos(A) - g.r * Math.cos(g.ang)) - (.5 * (w + g.w) + .15)); return mn; };
    let slot = null, best = null;
    for (const r of [2.4 + .5 * h(i, 7), 3.3 + .3 * h(i, 8), 4.2]) {
      for (let q = 0; q < 24; q++) { const A = pref + (q % 2 ? 1 : -1) * Math.ceil(q / 2) * Math.PI / 12, m = room(A, r);
        if (m >= 0) { slot = {A, r}; break; } if (!best || m > best.m) best = {A, r, m}; }
      if (slot) break;
    }
    if (!slot) slot = best;
    const hold = seeded ? 0 : clamp(.5 * P, .2, .3), glide = seeded ? 0 : clamp(1.5 * P, .6, 1);
    const g = {i, t: c.t, f, di: k, kind: seeded ? 'seed' : c.beat && c.move ? 'both' : c.move ? 'move' : 'beat', mat, cls, seed, style, ang: slot.A, r: slot.r, w,
      yawOff: 40 * Math.PI / 180 * (2 * h(i, 3) - 1), spin: (h(i, 4) < .5 ? -1 : 1) * (.25 + .35 * h(i, 6)), hold, glide, seeded: !!seeded,
      root: fit.dpos[k].slice(), hidden: !seeded && inRunT(c.t) < 0, fade: Infinity};
    ghosts.push(g); return g;
  };
}
/** lifetimes: at most cap live, at least keep kept, life seconds; a plates ending collapses the ring one by one. */
export function ghostFades(ghosts, endBarT, P, dur) {
  ghosts.forEach((g, i) => { const tc = ghosts[i + GHOST.cap], tk = ghosts[i + GHOST.keep];
    g.fade = Math.min(tc ? tc.t : Infinity, Math.max(g.t + GHOST.life, tk ? tk.t : Infinity)); });
  if (endBarT != null) {                // plates ending: the ring collapses ghost by ghost, oldest first, before the clip ends
    const t0 = endBarT + .25 * P, span = Math.max(0, dur - t0 - GHOST.collapse - .05), fin = ghosts.filter(g => g.t < endBarT && g.fade > t0);
    fin.forEach((g, k) => { g.fade = Math.min(g.fade, t0 + span * (fin.length > 1 ? k / (fin.length - 1) : 1)); });
  }
}

/** orbit state at t: {ang, calm 0..1, acc = integral of calm^2}. Before 0 the stage keeps its first state. */
export function orbitAt(plan, t) {
  const o = plan.orbit; if (!o) return {ang: 0, calm: 1, acc: Math.max(0, t)};
  const x = t * o.hz;
  if (x <= 0) { const acc = t * o.calm[0] * o.calm[0]; return {ang: o.dir * (.03 * t + .3 * acc), calm: o.calm[0], acc}; }
  if (o.n != null && x >= o.n - 1) { const j = Math.max(0, o.n - 1), c = o.calm[j], acc = o.acc[j] + c * c * (x - j) / o.hz; return {ang: o.dir * (.03 * t + .3 * acc), calm: c, acc}; }
  const i = Math.min(o.acc.length - 2, Math.floor(x)), f = Math.min(1, x - i);
  const acc = o.acc[i] + (o.acc[i + 1] - o.acc[i]) * f, calm = o.calm[i] + (o.calm[i + 1] - o.calm[i]) * f;
  return {ang: o.dir * (.03 * t + .3 * acc), calm, acc};
}
export const inRun = (plan, t) => plan.runs ? plan.runs.findIndex(r => t >= r.t0 - 1e-6 && t < r.t1 - 1e-6) : -1;

/** live ghosts at t (pure). Positions are in stage space; yaw toward the slot is finished by the renderer (needs the camera). */
export function ghostsAt(plan, t) {
  if (!plan.ghosts || !plan.ghosts.length) return [];
  const O = orbitAt(plan, t), out = [];
  for (const g of plan.ghosts) {
    if (g.t > t || t >= g.fade + GHOST.collapse) continue;
    const age = t - g.t, u = g.seeded ? 1 : easeIOC(clamp((age - g.hold) / Math.max(1e-3, g.glide))), o = g.seeded ? 1 : smoothstep(.25, .45, u);
    const slotA = g.ang + O.ang, rr = Math.hypot(g.root[0], g.root[2]), ra = rr < .2 ? slotA : Math.atan2(g.root[0], g.root[2]);
    let da = (slotA - ra) % (2 * Math.PI); if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    const rho = rr + (g.r - rr) * u, al = ra + da * u;
    const y = .18 * Math.sin(Math.PI * u) + .03 * O.calm * (1 + Math.sin(2 * Math.PI * (.35 * t + .37 * g.i)));
    const settle = g.t + g.hold + g.glide, spinA = g.spin * Math.max(0, O.acc - orbitAt(plan, settle).acc);
    const E = .25 + .75 * Math.exp(-age / 2.5) + 1.5 * Math.exp(-age / .12);
    out.push({g, age, u, o, slotA, pos: [rho * Math.sin(al), y, rho * Math.cos(al)], spinA, E, dark: 1 - .6 * smoothstep(3, 10, age),
      coll: clamp((t - g.fade) / GHOST.collapse), depthOff: age < g.hold, calm: O.calm});
  }
  return out;
}

/** 0–1 trim over the automatic edit. Missing keys read as full. Smoothstep between keys. */
export function effectAt(keys, t) {
  if (!keys || !keys.length) return 1;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 1;
  while (i < keys.length - 1 && keys[i].t < t) i++;
  const a = keys[i - 1], b = keys[i], span = b.t - a.t;
  if (!(span > 1e-8)) return b.v;
  const u = (t - a.t) / span, s = u * u * (3 - 2 * u);
  return a.v + (b.v - a.v) * s;
}

export function describePlan(plan) {
  const lines = [`seed ${plan.seed} | ${plan.beats.length} beats, ${plan.barStarts.length} bars | roles: ${plan.roles.join(' ')}`];
  if (plan.scene) {
    const G = plan.ghosts || [], cnt = k => G.filter(g => g.kind === k).length, hid = G.filter(g => g.hidden).length;
    let still = 0; if (plan.orbit) { const c = plan.orbit.calm; for (let i = 0; i < c.length; i++) still += c[i] > .6; still = Math.round(100 * still / c.length); }
    lines.push(`scene ${plan.scene}${plan.stages && plan.stages.length ? ' | stages ' + plan.stages.join(' ') : ''}` + (plan.runs && plan.runs.length ? ` | plates ${plan.runs.map(r => r.t0.toFixed(2) + '–' + r.t1.toFixed(2) + 's').join(', ')}` : '') +
      (G.length ? ` | ghosts ${G.length} (${cnt('beat')} beat, ${cnt('move')} move, ${cnt('both')} both${cnt('seed') ? ', ' + cnt('seed') + ' seeded' : ''}; ${hid} hidden) | still ${still}%` : ''));
    if (plan.sceneNote) lines.push('note: ' + plan.sceneNote);
  }
  if (plan.fx && plan.fx.length) lines.push('fx ' + plan.fx.map(k => `${k.t.toFixed(2)}=${k.v.toFixed(2)}`).join(' '));
  const rows = plan.sched.map(e => ({t: e.t, s: `${e.t.toFixed(3)}s  ${e.look}${e.burst ? ' (strobe)' : ''}  pitch ${e.pitch}`}));
  for (const g of plan.ghosts || []) if (g.t >= 0) rows.push({t: g.t + 1e-7, s: `${g.t.toFixed(3)}s  ghost ${g.kind} ${g.mat}/${g.style}${g.hidden ? ' (hidden)' : ''}`});
  for (const c of plan.shots || []) rows.push({t: c.t + 2e-7, s: `${c.t.toFixed(3)}s  cam ${c.kind}${c.high ? ' high' : ''}${c.still ? ' (still)' : ''}`});
  rows.sort((a, b) => a.t - b.t);
  for (const r of rows) lines.push(r.s);
  return lines.join('\n');
}
