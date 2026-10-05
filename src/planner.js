// Edit planner: turns a beat grid + video analysis into a deterministic, seeded edit (looks, camera moves, hits).
import { rng } from './util.js';

export const PALETTES = {
  reference: {
    led: ['ledred', 'led'], macro: ['macro'], flat: ['red', 'cream', 'gold', 'pink', 'mono', 'yellow', 'cyan', 'purple'],
    ink: ['cream', 'yellow', 'cyan'], spark: ['spark', 'sparkg', 'sparkp'], echo: ['echoB', 'echoO', 'echoY', 'echoC'], inv: ['invdots']},
  mono: {led: ['led'], macro: ['macro'], flat: ['mono', 'cream', 'gold'], ink: ['cream'], spark: ['spark', 'sparkg'], echo: ['echoK', 'echoW'], inv: ['invdots']},
  hot: {led: ['ledred', 'led'], macro: ['macro'], flat: ['red', 'gold', 'yellow', 'cream'], ink: ['yellow', 'cream'], spark: ['sparkg', 'spark'], echo: ['echoO', 'echoY'], inv: ['invdots']},
  cool: {led: ['led'], macro: ['macro'], flat: ['pink', 'cyan', 'purple', 'mono'], ink: ['cyan', 'cream'], spark: ['spark', 'sparkp'], echo: ['echoB', 'echoC'], inv: ['invdots']},
};

/**
 * grid: {beats:[t...], kick:[...], barOffset, P}; dur: output duration; video: analysis bundle (area per frame)
 * returns plan: {sched:[{t,look,pitch,strobe}], beats, bars, flashes, dets, echoHits, holds, freeze, reform, fly, swings, barCam, params}
 */
export function makePlan(grid, dur, video, {seed = 1, intensity = 1, strobe = .7, palette = 'reference'} = {}) {
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
  const add = (b, look, pitch, strobeStep = 0) => { const t = bt(b); if (t < dur) sched.push({t, look, pitch, strobe: strobeStep}); };
  const pick = cat => R.pick(pal[cat]); let prevLook = null; const pickN = cat => { const l = R.pickNot(pal[cat], prevLook); prevLook = l; return l; };
  const strobes = (b, n) => { if (R() > strobe) return; for (let s = 0; s < n; s++) add(b, s % 2 ? pickN('flat') : 'raw', 12, s); };
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
  return {seed, intensity, strobe, palette, dur, P, beats, kick: grid.kick, barStarts: barStarts.map(k => beats[k]), roles: role, sched, flashes, dets, echoHits, holds, freeze, reform, fly, swings, barCam};
}

export function describePlan(plan) {
  const lines = [`seed ${plan.seed} | ${plan.beats.length} beats, ${plan.barStarts.length} bars | roles: ${plan.roles.join(' ')}`];
  for (const e of plan.sched) lines.push(`${e.t.toFixed(3)}s  ${e.look}${e.strobe ? ' (strobe)' : ''}  pitch ${e.pitch}`);
  return lines.join('\n');
}
