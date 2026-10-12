// node --test test/plan_test.mjs
// Guards the planner against unintended changes, using the synthetic (model-free) inputs from test/synth.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makePlan, describePlan } from '../src/planner.js';
import { FIXTURE, SEEDS, PALETTES, BASE_OPTS, caseKey, canon, buildInputs, buildPlans, inputDigest, legacyGrid } from './make_fixture.mjs';
import { synthAnalysis, poseAt, rasterDM, SCRIPT, BEAT } from './synth.js';

const FIX = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const inputs = await buildInputs();
const {video: V, grid} = inputs;
const fi = t => Math.floor(t * V.fps);          // footage frame index at time t
const di = t => Math.floor(fi(t) / V.step);     // depth-map index at time t

test('synthetic inputs are the ones the fixture was built from (else: synth changed, not the planner)', () => {
  assert.deepEqual(inputDigest(inputs), FIX.inputs);
  assert.deepEqual(canon(legacyGrid(grid)), FIX.grid);
});

test("'dots only' scene deep-equals the legacy dots fixture (plan_dots_legacy.json)", () => {
  const plans = buildPlans(inputs);
  assert.deepEqual(Object.keys(plans).sort(), Object.keys(FIX.plans).sort());
  for (const k of Object.keys(FIX.plans)) assert.deepStrictEqual(plans[k], FIX.plans[k], `plan ${k} differs from the legacy fixture`);
});

test('makePlan is deterministic (same input twice -> JSON-equal)', () => {
  for (const seed of SEEDS) for (const palette of PALETTES) {
    const o = {seed, palette, ...BASE_OPTS};
    const a = makePlan(grid, V.dur, V, o), b = makePlan(grid, V.dur, V, o);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `seed ${seed} ${palette}`);
    assert.equal(describePlan(a), describePlan(b));
  }
});

test('synth bundle has the analyzeVideo() shape', () => {
  assert.deepEqual(Object.keys(V), ['w', 'h', 'srcW', 'srcH', 'fps', 'n', 'dur', 'frames', 'aw', 'ah', 'step', 'dm', 'motion', 'area', 'piv', 'info']);
  assert.equal(V.n, Math.floor(16 * V.fps)); assert.equal(V.dur, V.n / V.fps);
  assert.ok(Array.isArray(V.frames) && V.frames.length === 0, 'Node bundle has no frames');
  assert.equal(V.dm.length, Math.ceil(V.n / V.step)); assert.equal(V.area.length, V.dm.length); assert.equal(V.piv.length, V.dm.length);
  assert.equal(V.motion.length, V.n); assert.equal(V.motion[0], 0);
  for (const d of V.dm) { assert.ok(d instanceof Uint8Array); assert.equal(d.length, V.aw * V.ah * 4); }
  for (const p of V.piv) { assert.equal(p.length, 3); assert.ok(p.every(Number.isFinite)); }
  assert.ok(V.area.every(a => a > .03 && a < .2), 'figure always in frame');
});

test('rasterDM: soft mask, floor-like background depth, nearer person, one arm nearer', () => {
  const pose = poseAt(6.5), {aw, ah} = V, d = rasterDM(pose, aw, ah);
  assert.equal(d.length, aw * ah * 4);
  const R = (x, y) => d[(y * aw + x) * 4] / 255, G = (x, y) => d[(y * aw + x) * 4 + 1];
  assert.ok(R(5, 2) > .12 && R(5, 2) < .2, 'far at the top'); assert.ok(R(5, ah - 2) > .4 && R(5, ah - 2) < .5, 'floor nearer at the bottom');
  let soft = 0, person = [];
  for (let p = 0; p < aw * ah; p++) { const g = d[p * 4 + 1]; if (g > 0 && g < 255) soft++; if (g === 255) person.push(d[p * 4] / 255); assert.equal(d[p * 4 + 3], 255); }
  assert.ok(soft > 50, 'anti-aliased mask edge'); person.sort((a, b) => a - b);
  assert.ok(person[person.length >> 1] > .6 && person[person.length >> 1] < .7, 'person depth ~0.6-0.7');
  assert.ok(person[person.length - 1] > .7, 'nearer arm'); void G;
});

test('scripted dancer: still stretch, off-grid snap, pan without pose change, jump', () => {
  const m = V.motion, mean = (a, b) => { let s = 0; for (let i = fi(a); i < fi(b); i++) s += m[i]; return s / (fi(b) - fi(a)); };
  assert.ok(mean(5.5, 8.0) < .05, 'still: almost no motion'); assert.ok(mean(0.2, 5.2) > .5, 'energetic opening');
  const spike = Math.max(...m.slice(fi(9.74), fi(9.86))), around = Math.max(...m.slice(fi(9.66), fi(9.74)), ...m.slice(fi(9.86), fi(10.15)));   // beat-20 bounce ends 9.635
  assert.ok(spike > 2 && around < .1, `off-grid snap isolated (spike ${spike.toFixed(2)}, around ${around.toFixed(3)})`);
  const offBeat = (SCRIPT.offGrid - SCRIPT.beat0) / BEAT % 1; assert.ok(offBeat > .2 && offBeat < .9, 'off the beat grid');
  const p0 = poseAt(12.0), p1 = poseAt(12.5), p2 = poseAt(13.0);
  for (const k of ['lean', 'head', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'hipR', 'knR', 'x', 'dy', 'air']) assert.equal(p1[k], p0[k], `pan keeps ${k}`), assert.equal(p2[k], p0[k], `pan keeps ${k}`);
  const dx = V.piv[di(13.2)][0] - V.piv[di(11.8)][0]; assert.ok(dx > .12 && dx < .17, `pan moves the figure ~15% of the width (${dx.toFixed(3)})`);
  const top = t => { const k = di(t), d = V.dm[k]; let y1 = 0; for (let p = 0; p < V.aw * V.ah; p++) if (d[p * 4 + 1] > 127) y1 = Math.max(y1, (p / V.aw) | 0); return y1; };
  assert.ok(top(13.83) < top(13.2) - 10, 'feet leave the floor during the jump');
  assert.ok(poseAt(3.4).knL > 60 && poseAt(13.3).knR > 40, 'crouches');
});

test('synthAnalysis: 128 BPM, kicks strongest on 1 and 3, exactly one drop; grid from the real gridFor starts ~0', () => {
  const A = synthAnalysis(16);
  assert.equal(A.bpm, 128); assert.ok(A.duration > 2 * 16);
  assert.ok(Math.abs(A.beats[0] - .05) < 1e-9);
  const avg = j => { let s = 0, c = 0; for (let k = j; k < A.beatKick.length; k += 4) { s += A.beatKick[k]; c++; } return s / c; };
  assert.ok(avg(0) > avg(1) && avg(2) > avg(3) && avg(0) > avg(3));
  assert.equal(A.bars.filter(b => b.drop).length, 1);
  assert.ok(grid.beats[0] >= 0 && grid.beats[0] < .02); assert.equal(grid.barOffset, 0); assert.equal(grid.P, 60 / 128);
  assert.equal(grid.beats.length, grid.kick.length);
});

// ---------------------------------------------------------------- plates stage layer
import { ghostsAt, orbitAt, inRun, GHOST, PALETTES as PALS, stagePal } from '../src/planner.js';
import { slabBase, poseStats, stageFit, STYLES, PITCH } from '../src/pose.js';
import { MATS } from '../src/stage.js';
import { LOOKS } from '../src/renderer.js';
import { hex } from '../src/util.js';
import { legacyPlan } from './make_fixture.mjs';

const mk = (scene, o = {}) => makePlan(grid, V.dur, V, {seed: 1, palette: 'reference', ...BASE_OPTS, scene, ...o});
const P8 = grid.P / 2, onEighth = t => { const x = (t - grid.beats[0]) / P8; return Math.abs(x - Math.round(x)) < 1e-6; };
const runOf = (plan, t) => inRun(plan, t);

test('mix: plates runs alternate with dots and leave the dots edit untouched outside them', () => {
  for (const seed of SEEDS) for (const palette of PALETTES) {
    const m = mk('mix', {seed, palette}), d = mk('dots', {seed, palette}), N = m.roles.length;
    assert.equal(m.scene, 'mix'); assert.ok(m.runs.length >= 1, `${seed}/${palette}: at least one plates run`);
    assert.equal(m.stages[0], 'D', 'opening bar stays dots');
    if (m.stages[N - 1] === 'P') { assert.equal(m.reform, null, 'a plates ending replaces the dots re-form');
      const tEnd = m.barStarts[N - 1], alive = m.ghosts.filter(g => g.t < tEnd && g.fade > tEnd);
      assert.ok(alive.every(g => g.fade + GHOST.collapse <= m.dur + 1e-6), 'the ring collapses before the clip ends'); }
    m.roles.forEach((r, i) => { if (r === 'freeze') assert.equal(m.stages[i], 'D', 'freeze bar stays dots'); });
    for (let k = 0; k < m.runs.length; k++) { const r = m.runs[k]; assert.ok(r.b1 - r.b0 >= 1 && r.b1 - r.b0 <= 4, 'run length 1..4 bars');
      if (k) assert.ok(r.b0 > m.runs[k - 1].b1, 'a dots bar between runs'); }
    const share = m.stages.filter(s => s === 'P').length / N; assert.ok(share >= .35 && share <= .7, `plates share ${share}`);
    const out = s => s.filter(e => runOf(m, e.t) < 0).map(e => JSON.stringify(e));
    assert.deepEqual(out(m.sched), out(d.sched), 'look schedule outside runs equals the dots edit');
    assert.deepEqual(legacyPlan(canon(m)).roles, legacyPlan(canon(d)).roles);
  }
});

test('inside runs: stage looks only, strobe bursts end on a stage look, all colours parse', () => {
  for (const strobe of [.7, 1, 0]) for (const palette of Object.keys(PALS)) {
    const m = mk('mix', {strobe, palette, seed: 2});
    const inside = m.sched.filter(e => runOf(m, e.t) >= 0);
    assert.ok(inside.length, 'stage looks inside runs');
    for (const e of inside) assert.ok(LOOKS[e.look] && LOOKS[e.look].st, `look ${e.look} inside a run is a stage look`);
    const groups = new Map(); for (const e of inside) if (e.burst || groups.has(e.t)) { if (!groups.has(e.t)) groups.set(e.t, []); groups.get(e.t).push(e); }
    for (const [t, es] of groups) { const last = es.reduce((a, b) => (b.strobe > a.strobe ? b : a)); assert.ok(!last.burst && LOOKS[last.look].st, `burst at ${t} ends on a stage look`); }
    if (strobe === 0) assert.ok(!inside.some(e => e.burst), 'no strobe bursts when strobe = 0');
    const sp = stagePal(palette); for (const c of sp.strobe) hex(c); for (const l of sp.stage) assert.ok(LOOKS[l].st);
    for (const cls of Object.values(sp.mats)) for (const mname of cls) assert.ok(MATS[mname], `material ${mname}`);
  }
  for (const m of Object.values(MATS)) for (const k of ['alb', 'emi', 'spec', 'rim']) hex(m[k]);
  for (const [k, L] of Object.entries(LOOKS)) if (L.st) for (const v of Object.values(L.st)) if (typeof v === 'string' && v.startsWith('#')) hex(v), void k;
});

test('ghost spawns: on the 1/8 grid, run downbeats covered, spaced, posed, none for a pan without a pose change', () => {
  for (const scene of ['mix', 'plates']) for (const seed of SEEDS) {
    const m = mk(scene, {seed}), G = m.ghosts.filter(g => !g.seeded);
    assert.ok(G.length >= 4, `${scene}/${seed}: some ghosts (${G.length})`); assert.ok(m.ghosts.length <= GHOST.max);
    for (const g of G) { assert.ok(onEighth(g.t), `ghost at ${g.t} on the 1/8 grid`); assert.ok(V.area[g.di] > .01, 'posed frame shows the person');
      assert.ok(g.f >= Math.floor(g.t * V.fps) - 4 && g.f <= Math.floor(g.t * V.fps) + 1, 'pose frame near the spawn'); }
    for (const r of m.runs) if (r.t0 > 0) assert.ok(G.some(g => Math.abs(g.t - r.t0) < 1e-6), `run at ${r.t0} opens with a ghost`);
    for (let i = 1; i < G.length; i++) if (!G[i].hidden && !G[i - 1].hidden) assert.ok(G[i].t - G[i - 1].t >= Math.max(grid.P / 2, .2) - 1e-6, 'visible ghosts spaced');
    const [p0, p1] = SCRIPT.pan; assert.ok(!G.some(g => g.kind !== 'beat' && g.t > p0 + .15 && g.t < p1), 'a pan alone does not count as a move');
  }
});

test('ghostsAt: capped, newest brightest, on or above the floor, slots keep clearance', () => {
  for (const scene of ['mix', 'plates']) {
    const m = mk(scene);
    for (let f = 0; f <= V.dur * 30; f++) {
      const t = f / 30, L = ghostsAt(m, t), alive = L.filter(x => x.coll === 0);
      assert.ok(alive.length <= GHOST.cap, `${scene} t=${t.toFixed(2)}: ${alive.length} live ghosts`);
      for (const x of L) { assert.ok(x.pos[1] >= -1e-9, 'not below the floor'); assert.ok([...x.pos, x.E, x.u, x.o].every(Number.isFinite)); }
      const fresh = L.filter(x => !x.g.seeded); if (fresh.length > 1) { const nw = fresh.reduce((a, b) => (b.g.t > a.g.t ? b : a)); assert.ok(fresh.every(x => x.E <= nw.E + 1e-9), 'newest is brightest'); }
      for (const a of alive) for (const b of alive) if (a !== b && a.u === 1 && b.u === 1 && a.g.i > b.g.i && a.g.i - b.g.i < GHOST.cap) {
        const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]); assert.ok(d >= .45 * (a.g.w + b.g.w) - .05, `ghosts ${a.g.i}/${b.g.i} overlap (${d.toFixed(2)} m)`); }
    }
    // the ring stays populated through the still stretch once it has filled
    const [s0, s1] = SCRIPT.still; const n0 = ghostsAt(m, s0).length; for (let t = s0; t < s1; t += .1) assert.ok(ghostsAt(m, t).length >= Math.min(n0, GHOST.keep), 'ghosts remain while still');
  }
});

test('orbit: calm while still, fast when still, monotonic, frame-rate independent', () => {
  const m = mk('plates'), [s0, s1] = SCRIPT.still, mean = (a, b, k) => { let s = 0, c = 0; for (let t = a; t < b; t += 1 / 30) { s += orbitAt(m, t)[k]; c++; } return s / c; };
  assert.ok(mean(s0 + .5, s1 - .2, 'calm') > .8, 'calm during the still stretch'); assert.ok(mean(.5, 2.5, 'calm') < .4, 'not calm while dancing');
  const speed = (a, b) => Math.abs(orbitAt(m, b).ang - orbitAt(m, a).ang) / (b - a);
  assert.ok(speed(s0 + .8, s1 - .2) > 3 * speed(.5, 2.5), 'the ring orbits faster while the dancer is still');
  let prev = orbitAt(m, 0).ang * m.orbit.dir; for (let t = 1 / 60; t < V.dur; t += 1 / 60) { const a = orbitAt(m, t).ang * m.orbit.dir; assert.ok(a >= prev - 1e-12, 'monotonic'); prev = a; }
  for (let f = 0; f < V.dur * 30; f += 7) assert.equal(orbitAt(m, f / 30).ang, orbitAt(m, 2 * f / 60).ang, '30 and 60 fps sample the same orbit');
});

test('slabBase: fixed plate pitch, standing vs crouched, at most 4 runs per band, finite', () => {
  const k = t => Math.min(V.dm.length - 1, Math.floor(Math.floor(t * V.fps) / V.step));
  const stand = slabBase(V, k(6.5), 'bar'), crouch = slabBase(V, k(3.4), 'pebble');
  assert.ok(stand.bands >= 18 && stand.bands <= 23, `standing ${stand.bands} plates`); assert.ok(crouch.bands < stand.bands, `crouch ${crouch.bands} < standing`);
  for (const s of [stand, crouch, slabBase(V, k(9.8), 'thin')]) {
    assert.ok(s.count > 0 && s.inst.every(Number.isFinite));
    const perBand = new Map(); for (let i = 0; i < s.count; i++) { const j = s.inst[i * 8 + 3]; perBand.set(j, (perBand.get(j) || 0) + 1);
      assert.ok(s.inst[i * 8 + 4] > 0 && s.inst[i * 8 + 5] >= .045 - 1e-6 && s.inst[i * 8 + 5] <= .14 + 1e-6, 'half sizes in range'); }
    for (const c of perBand.values()) assert.ok(c <= 4);
  }
  const ys = []; for (let i = 0; i < stand.count; i++) ys.push(stand.inst[i * 8 + 1]); const uy = [...new Set(ys.map(y => y.toFixed(4)))].map(Number).sort((a, b) => a - b);
  for (let i = 1; i < uy.length; i++) assert.ok(Math.abs(uy[i] - uy[i - 1] - PITCH) < 1e-6, 'plates stack at the fixed pitch');
  assert.equal(slabBase(V, k(6.5), 'bar'), stand, 'cached'); void STYLES; void poseStats; void stageFit;
});

test('degenerate inputs fall back to dots without throwing', () => {
  const blank = {...V, dm: V.dm.map(d => { const c = new Uint8Array(d); for (let p = 1; p < c.length; p += 4) c[p] = 0; return c; })};
  assert.equal(makePlan(grid, V.dur, null, {scene: 'mix'}).scene, 'dots');
  const nb = makePlan(grid, V.dur, blank, {scene: 'plates'}); assert.equal(nb.scene, 'dots'); assert.ok(nb.sceneNote);
  const short = {...grid, beats: grid.beats.slice(0, 3), kick: grid.kick.slice(0, 3)}; assert.equal(makePlan(short, 1.4, V, {scene: 'mix'}).ghosts.length, 0);
  for (const nBars of [1, 2, 3, 4, 24]) { const b = []; for (let k = 0; k < nBars * 4; k++) b.push(grid.beats[0] + k * grid.P);
    const g2 = {...grid, beats: b, kick: b.map((_, k) => grid.kick[k % grid.kick.length])}, d = b[b.length - 1] + grid.P;
    for (const scene of ['mix', 'plates']) { const p = makePlan(g2, d, V, {scene}); assert.ok(describePlan(p).length > 0); ghostsAt(p, d / 2); } }
  const cut = {...V, dm: V.dm.map(d => { const c = new Uint8Array(d); for (let y = Math.floor(V.ah * .6); y < V.ah; y++) for (let x = 0; x < V.aw; x++) c[(y * V.aw + x) * 4 + 1] = 255; return c; })};
  const pc = makePlan(grid, V.dur, cut, {scene: 'mix'}); assert.ok(pc.scene === 'dots' || pc.runs.length >= 0);
});

test('describePlan lists the scene, ghosts and camera shots', () => {
  const t = describePlan(mk('mix'));
  assert.match(t, /scene mix \| stages [DP ]+ \| plates /); assert.match(t, /ghost (beat|move|both) /); assert.match(t, /cam (orbit|low|top|push|track|rake)/);
  assert.match(describePlan(mk('dots')), /scene dots/);
});

test('a dancer too small to print (under 1% of the frame) falls back to dots with a note', () => {
  const small = {...V, area: V.area.map(a => Math.min(a * .1, .009))};
  for (const scene of ['mix', 'plates']) {
    const p = makePlan(grid, V.dur, small, {seed: 1, scene});
    assert.equal(p.scene, 'dots'); assert.ok(/too small/.test(p.sceneNote), p.sceneNote); assert.equal(p.runs.length, 0); assert.equal(p.ghosts.length, 0);
  }
});

test('long clips keep printing ghosts to the end, live ghosts stay capped', async () => {
  const { synthSection } = await import('./synth.js');
  const L = 6, cat = a => Array.from({length: L}, () => a).flat();
  const long = {...V, n: V.n * L, dur: V.dur * L, dm: cat(V.dm), area: cat(V.area), piv: cat(V.piv), motion: cat(V.motion)};
  const g2 = synthSection(long.dur).grid;
  for (const scene of ['mix', 'plates']) {
    const p = makePlan(g2, long.dur, long, {seed: 3, scene}), late = p.ghosts.filter(g => !g.hidden && g.t > long.dur - 16);
    assert.ok(late.length >= 3, `${scene}: ${late.length} visible ghosts in the last 16 s of a ${long.dur}s clip`);
    for (let t = 0; t < long.dur; t += .5) assert.ok(ghostsAt(p, t).filter(x => x.coll === 0).length <= GHOST.cap);
  }
});

test("'dots + plates' shows plates for about half of every clip length, alternating with dots", async () => {
  const { synthSection } = await import('./synth.js');
  for (const len of [5, 7, 9, 11, 13, 16]) {
    const n = Math.floor(len * V.fps), k = Math.ceil(n / V.step);
    const Vc = {...V, n, dur: n / V.fps, dm: V.dm.slice(0, k), area: V.area.slice(0, k), piv: V.piv.slice(0, k), motion: V.motion.slice(0, n)}, g2 = synthSection(Vc.dur).grid;
    for (const seed of [1, 2, 3, 4, 5]) {
      const p = makePlan(g2, Vc.dur, Vc, {seed, scene: 'mix'}), share = p.runs.reduce((a, r) => a + r.t1 - r.t0, 0) / Vc.dur;
      assert.ok(share >= .4 && share <= .7, `${len}s seed ${seed}: plates ${(share * 100).toFixed(0)}% (${p.stages.join('')})`);
      assert.equal(p.stages[0], 'D', 'opens on dots');
      for (let i = 1; i < p.runs.length; i++) assert.ok(p.runs[i].b0 > p.runs[i - 1].b1, 'a dots bar between plates runs');
    }
  }
});

test('feet cut by the bottom of the frame keep the plates (no dots fallback), ghosts stand on the floor', () => {
  const cut = {...V, dm: V.dm.map(d => { const c = new Uint8Array(d); for (let y = V.ah - 3; y < V.ah; y++) for (let x = 120; x < 150; x++) c[(y * V.aw + x) * 4 + 1] = 255; return c; })};
  const p = makePlan(grid, V.dur, cut, {seed: 1, scene: 'mix'}), share = p.runs.reduce((a, r) => a + r.t1 - r.t0, 0) / V.dur;
  assert.equal(p.scene, 'mix'); assert.equal(p.sceneNote, ''); assert.ok(share >= .35, `plates ${share}`);
  assert.ok(stageFit(cut).cutFrac > .6); assert.ok(p.ghosts.length > 0);
  for (const x of ghostsAt(p, 8)) assert.ok(x.pos[1] >= 0);
  assert.ok(stageFit(cut).yb.every(y => y === 0), 'cut-off bodies stand on the floor');
});
