// node --test test/gross_test.mjs
// Gross is pure: stutter, repeat, and gate against the synthetic beat grid. No models, no WebGL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, describePlan } from '../src/planner.js';
import { grossAt, normalizeGross, presetGross, randomPattern, GROSS_PRESETS } from '../src/gross.js';
import { synthSection } from './synth.js';

const DUR = 8;
const {grid} = synthSection(DUR);
const P = grid.P;
const barStarts = [];
for (let k = grid.barOffset || 0; k < grid.beats.length; k += 4) barStarts.push(grid.beats[k]);
const plan = {beats: grid.beats, P, barStarts, dur: DUR, seed: 1};
const barT = barStarts[1];
const at = (t, g, fx = 1, fps = 30) => grossAt(plan, t, g, fx, fps);

function jumps(g, t0, step, fps = 60) {
  const out = [];
  let prev = at(t0, g, 1, fps).src;
  for (let i = 1; i <= 80; i++) {
    const t = t0 + step * i / 80, src = at(t, g, 1, fps).src;
    if (src < prev - 1e-4) out.push((t - t0) / step);
    prev = src;
  }
  return out;
}

test('presets normalise, and off leaves the picture alone', () => {
  for (const name of ['off', 'hyperpop', 'gate', 'repeat']) {
    const g = presetGross(name, DUR);
    assert.equal(g.preset, name);
    assert.equal(g.pattern.length, 16);
    assert.equal(g.t0, 0);
    assert.equal(g.t1, DUR);
  }
  assert.equal(presetGross('hyperpop', DUR).mode, 'stutter');
  assert.equal(presetGross('gate', DUR).mode, 'gate');
  assert.equal(presetGross('gate', DUR).div, '1/16');
  assert.equal(presetGross('repeat', DUR).mode, 'repeat');
  assert.equal(presetGross('repeat', DUR).build, 1);
  const off = presetGross('off', DUR);
  for (let i = 0; i < 20; i++) {
    const t = i * .37;
    const s = at(t, off);
    assert.equal(s.remap, false);
    assert.equal(s.gate, null);
    assert.equal(s.src, t);
  }
  const junk = normalizeGross({amount: 5, mode: 'nope', div: '1/2', frames: 99, repeats: 0, t0: 3, t1: 1, pattern: [1, 0], probability: 4}, DUR);
  assert.equal(junk.amount, 1);
  assert.equal(junk.mode, 'stutter');
  assert.equal(junk.div, '1/16');
  assert.equal(junk.frames, 16);
  assert.equal(junk.repeats, 1);
  assert.ok(junk.t1 >= junk.t0 + .05);
  assert.equal(junk.pattern.length, 16);
  assert.equal(junk.pattern[0], 1);
  assert.equal(junk.pattern[1], 0);
  assert.equal(junk.pattern[2], 0);
  assert.equal(junk.probability, 1);
});

test('stutter retriggers inside the division and stays on the grid', () => {
  const step = P / 4;
  const g = normalizeGross({...GROSS_PRESETS.hyperpop, variation: 0, decay: 0, slice: .34, t0: 0, t1: DUR}, DUR);
  const t0 = barT;
  assert.ok(Math.abs(at(t0, g).src - t0) < 1e-6, 'a division opens on its own start');
  const late = at(t0 + step * .92, g);
  assert.equal(late.remap, true);
  assert.ok(late.src < t0 + step * .5, `late in the 16th the slice has retriggered (${late.src})`);
  const eighth = P / 2, trip = P / 3;
  const g8 = {...g, div: '1/8'};
  const g3 = {...g, div: 'triplet'};
  assert.ok(Math.abs(at(barT + eighth, g8).src - (barT + eighth)) < 1e-6, '1/8 opens on the eighth');
  assert.ok(Math.abs(at(barT + trip, g3).src - (barT + trip)) < 1e-6, 'triplet opens on the triplet');
  const srcs = [];
  for (let i = 0; i < 16; i++) srcs.push(at(t0 + i / 60, g, 1, 60).src);
  assert.ok(srcs.some((s, i) => i && s < srcs[i - 1] - 1e-3), 'the slice jumps backwards inside the division');
  const frames = srcs.map(s => Math.floor(s * 60 + 1e-6));
  assert.ok(frames.some((f, i) => i && f < frames[i - 1]), 'at 60 fps that repeat lands on an earlier frame');
});

test('decay shortens later retriggers; variation is stable per step and depends on the seed', () => {
  const step = P / 4, t0 = barT + P;
  const base = {mode: 'stutter', div: '1/16', amount: 1, slice: .3, variation: 0, chunk: 'beat', frames: 4, repeats: 4, build: 0, fill: 'black', probability: 1, pattern: GROSS_PRESETS.off.pattern, t0: 0, t1: DUR};
  const plain = jumps(normalizeGross({...base, decay: 0, seed: 1}, DUR), t0, step, 60);
  const decayed = jumps(normalizeGross({...base, decay: 1, seed: 1}, DUR), t0, step, 60);
  assert.ok(plain.length >= 2, `undecayed slice wraps more than once (${plain})`);
  assert.ok(decayed.length >= 2, `decayed slice still wraps (${decayed})`);
  assert.ok(Math.abs(plain[0] - .3) < .04, `first wrap stays at the slice (${plain[0]})`);
  assert.ok(decayed[1] < plain[1] - .04, `the second wrap comes sooner once the slice decays (${decayed[1]} vs ${plain[1]})`);
  const varied = normalizeGross({...base, decay: 0, variation: 1, seed: 1, slice: .5}, DUR);
  const other = normalizeGross({...varied, seed: 99}, DUR);
  const t = t0 + step * .08, a = at(t, varied), b = at(t, other), a2 = at(t + .004, varied);
  assert.ok(Math.abs(a.src - b.src) > 1e-3, 'a different seed shifts the slice');
  assert.ok(Math.abs((a2.src - a.src) - .004) < 1e-4, 'inside one retrigger the slice plays forward');
});

test('repeat loops, then releases, and build adds repeats toward the end of the region', () => {
  const g = presetGross('repeat', DUR);
  assert.equal(g.chunk, 'beat');
  const into = (beats) => barT + beats * P;
  const second = at(into(1.25), g);
  assert.equal(second.remap, true);
  assert.ok(second.src < into(1.25) - P * .5, 'the second play jumps back to the downbeat');
  const released = at(into(2.5), g);
  assert.equal(released.remap, false, 'after the programmed repeats the clip runs');
  assert.equal(released.src, into(2.5));
  const share = (tBar) => {
    let n = 0, on = 0;
    for (let i = 0; i < 32; i++) { n++; if (at(tBar + (i + .5) / 32 * 4 * P, g).remap) on++; }
    return on / n;
  };
  const early = share(barStarts[0]);
  const late = share(barStarts[barStarts.length - 2]);
  assert.ok(late > early + .2, `build grows the loop (${early.toFixed(2)} -> ${late.toFixed(2)})`);
  const frames = normalizeGross({...g, chunk: 'frames', frames: 4, build: 0, repeats: 3}, DUR);
  const held = at(barT + .02, frames);
  assert.equal(held.remap, true);
  assert.ok(held.src < barT, 'frame repeat uses the frames just before the bar');
});

test('gate follows the bar pattern, probability, and the cut', () => {
  const g = presetGross('gate', DUR);
  const step = P / 4;
  for (let i = 0; i < 16; i++) {
    const t = barT + (i + .5) * step, s = at(t, g);
    if (g.pattern[i]) {
      assert.equal(s.gate, null, `step ${i} plays`);
      assert.equal(s.remap, false);
    } else {
      assert.equal(s.gate, 'black', `step ${i} cuts`);
      assert.equal(s.mix, 1);
      assert.equal(s.src, t);
    }
  }
  const next = barStarts[2];
  assert.equal(at(next + step * .5, g).gate, null, 'the pattern restarts on the next bar');
  assert.equal(at(next + step * 1.5, g).gate, 'black');
  const mute = {...g, probability: 0};
  for (let i = 0; i < 16; i++) assert.equal(at(barT + (i + .5) * step, mute).gate, null, 'probability 0 never cuts');
  const white = {...g, fill: 'white'};
  assert.equal(at(barT + step * 1.5, white).gate, 'white');
  const freeze = {...g, fill: 'freeze'};
  const a = at(barT + step * 1.1, freeze), b = at(barT + step * 1.8, freeze);
  assert.equal(a.remap, true);
  assert.equal(a.hold, true);
  assert.ok(Math.abs(a.src - b.src) < 1e-6, 'a freeze holds one frame for the step');
  assert.ok(Math.abs(a.src - (barT + step)) < 1e-4, 'the held frame is the step start');
});

test('region, amount, and the fade lane bypass the effect', () => {
  const g = presetGross('hyperpop', DUR);
  g.t0 = 3; g.t1 = 4;
  const step = P / 4;
  const inside = barT > 3 && barT < 4 ? barT : 3.2;
  assert.equal(at(inside - 1, g).remap, false);
  const late = inside + step * .9;
  if (late < 4) assert.equal(at(late, g).remap, true);
  assert.equal(at(4.05, g).remap, false);
  const quiet = presetGross('hyperpop', DUR);
  assert.equal(at(barT + step * .9, quiet, 0).remap, false);
  quiet.amount = 0;
  assert.equal(at(barT + step * .9, quiet, 1).remap, false);
  const gate = presetGross('gate', DUR);
  assert.equal(at(barT + step * 1.5, gate, 0).gate, null);
});

test('sampling is deterministic, and the plan text names the effect', () => {
  const g = presetGross('hyperpop', DUR);
  for (let i = 0; i < 30; i++) {
    const t = i * .2;
    assert.deepEqual(at(t, g), at(t, g));
  }
  const named = {...plan, sched: [], roles: ['half'], ghosts: [], shots: [], gross: g};
  assert.match(describePlan(named), /gross stutter 1\/16/);
  const bare = makePlan(grid, DUR, null, {seed: 1, scene: 'dots'});
  assert.equal(bare.gross, undefined);
  const a = randomPattern(4, .5), b = randomPattern(4, .5), c = randomPattern(5, .5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.includes(0) && a.includes(1));
});
