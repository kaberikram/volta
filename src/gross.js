// Gross: one beat-locked effect. Stutter retriggers a slice, repeat loops a chunk, gate cuts steps to black, white, or a freeze.
import { clamp, hsh, rng } from './util.js';

export const DIVS = {'1/4': 1, '1/8': 2, '1/16': 4, triplet: 3};
export const GROSS_MODES = ['stutter', 'repeat', 'gate'];
export const PATTERN = 16;

const GATE = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0];
const ALT = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];

/** Presets are complete settings. `t0`/`t1` are filled for the clip length by presetGross. */
export const GROSS_PRESETS = {
  off: {preset: 'off', mode: 'stutter', div: '1/16', amount: 0, slice: .35, decay: .5, variation: .25, chunk: 'beat', frames: 4, repeats: 4, build: 0, fill: 'black', probability: 1, pattern: ALT, seed: 1},
  hyperpop: {preset: 'hyperpop', mode: 'stutter', div: '1/16', amount: 1, slice: .34, decay: .72, variation: .4, chunk: 'beat', frames: 4, repeats: 4, build: 0, fill: 'black', probability: 1, pattern: ALT, seed: 1},
  gate: {preset: 'gate', mode: 'gate', div: '1/16', amount: 1, slice: .35, decay: .5, variation: .25, chunk: 'beat', frames: 4, repeats: 4, build: 0, fill: 'black', probability: 1, pattern: GATE, seed: 1},
  repeat: {preset: 'repeat', mode: 'repeat', div: '1/4', amount: 1, slice: .35, decay: .5, variation: .25, chunk: 'beat', frames: 3, repeats: 4, build: 1, fill: 'black', probability: 1, pattern: ALT, seed: 1},
};

const idle = t => ({src: t, remap: false, gate: null, mix: 0, hold: false, holdId: '', mode: 'off'});

export function randomPattern(seed, density = .55, n = PATTERN) {
  const R = rng(seed), p = [];
  for (let i = 0; i < n; i++) p.push(R() < clamp(density) ? 1 : 0);
  if (!p.includes(1)) p[0] = 1;
  if (!p.includes(0)) p[1] = 0;
  return p;
}

function patternOf(src) {
  const p = [];
  for (let i = 0; i < PATTERN; i++) p.push(src && src[i] ? 1 : 0);
  return p;
}

/** Clamp a settings object. Missing pieces fall back to the off preset. */
export function normalizeGross(g = {}, dur = 1e9) {
  const base = GROSS_PRESETS.off;
  const mode = GROSS_MODES.includes(g.mode) ? g.mode : base.mode;
  const div = DIVS[g.div] ? g.div : base.div;
  const pattern = g.pattern ? patternOf(g.pattern) : patternOf(base.pattern);
  const span = Number.isFinite(dur) && dur > 0 ? dur : 1e9;
  let t0 = Number.isFinite(+g.t0) ? +g.t0 : 0;
  let t1 = Number.isFinite(+g.t1) ? +g.t1 : span;
  t0 = clamp(t0, 0, span);
  t1 = clamp(t1, 0, span);
  if (t1 < t0 + .05) t1 = Math.min(span, t0 + .05);
  const fill = g.fill === 'white' || g.fill === 'freeze' ? g.fill : 'black';
  return {
    preset: g.preset || 'custom', mode, div,
    amount: clamp(Number.isFinite(+g.amount) ? +g.amount : 0),
    slice: clamp(Number.isFinite(+g.slice) ? +g.slice : base.slice, .05, 1),
    decay: clamp(Number.isFinite(+g.decay) ? +g.decay : 0),
    variation: clamp(Number.isFinite(+g.variation) ? +g.variation : 0),
    chunk: g.chunk === 'frames' ? 'frames' : 'beat',
    frames: clamp(Math.round(Number.isFinite(+g.frames) ? +g.frames : base.frames), 1, 16),
    repeats: clamp(Math.round(Number.isFinite(+g.repeats) ? +g.repeats : base.repeats), 1, 16),
    build: clamp(Number.isFinite(+g.build) ? +g.build : 0),
    fill, probability: clamp(g.probability == null || !Number.isFinite(+g.probability) ? 1 : +g.probability),
    pattern, seed: Math.round(Number.isFinite(+g.seed) ? +g.seed : 1) || 1,
    t0, t1,
  };
}

export function presetGross(name, dur = 1e9) {
  const p = GROSS_PRESETS[name] || GROSS_PRESETS.off;
  return normalizeGross({...p, pattern: p.pattern.slice(), preset: GROSS_PRESETS[name] ? name : 'off', t0: 0, t1: dur}, dur);
}

function beatAt(plan, t) {
  const beats = plan.beats || [], P = plan.P > 0 ? plan.P : .5;
  if (!beats.length) {
    const k = Math.floor(t / P), t0 = k * P;
    return {k, t0, beatLen: P, u: (t - t0) / P};
  }
  if (t < beats[0] - 1e-9) {
    const back = Math.max(1, Math.ceil((beats[0] - t) / P - 1e-9));
    const t0 = beats[0] - back * P;
    return {k: -back, t0, beatLen: P, u: (t - t0) / P};
  }
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (beats[m] <= t + 1e-9) lo = m; else hi = m - 1;
  }
  const t0 = beats[lo];
  let beatLen = lo + 1 < beats.length ? beats[lo + 1] - t0 : P;
  if (!(beatLen > 1e-4)) beatLen = P;
  if (lo === beats.length - 1 && t >= t0 + beatLen - 1e-9) {
    const extra = Math.floor((t - t0) / beatLen), tt = t0 + extra * beatLen;
    return {k: lo + extra, t0: tt, beatLen, u: (t - tt) / beatLen};
  }
  return {k: lo, t0, beatLen, u: clamp((t - t0) / beatLen, 0, .999999)};
}

function barAt(plan, t) {
  const bars = plan.barStarts || [], P = plan.P > 0 ? plan.P : .5, barLen = P * 4;
  if (!bars.length) {
    const bar = Math.floor(t / barLen), barT = bar * barLen;
    return {bar, barT, barLen};
  }
  let i = 0;
  for (let j = 0; j < bars.length; j++) if (bars[j] <= t + 1e-9) i = j;
  const barT = bars[i];
  const barEnd = i + 1 < bars.length ? bars[i + 1] : barT + barLen;
  return {bar: i, barT, barLen: Math.max(1e-4, barEnd - barT)};
}

/** Subdivision clock. `idx` is the step inside the bar (0..per*4), locked to the analysed beats. */
export function subAt(plan, t, div) {
  const per = DIVS[div] || 2, beat = beatAt(plan, t), bar = barAt(plan, t);
  const step = beat.beatLen / per;
  const s = Math.min(per - 1, Math.max(0, Math.floor((t - beat.t0) / step + 1e-9)));
  const beats = plan.beats || [];
  let origin = 0;
  for (let i = 0; i < beats.length; i++) if (Math.abs(beats[i] - bar.barT) < 1e-3) { origin = i; break; }
  const beatInBar = Math.max(0, beat.k - origin);
  return {beat, bar, per, step, s, stepT: beat.t0 + s * step, idx: beatInBar * per + s, stepId: beat.k * per + s};
}

function engaged(wet, stepId, seed) {
  if (wet >= .999) return true;
  if (wet <= 0) return false;
  return hsh(stepId * 12.989 + seed * .17) < wet;
}

function stutter(plan, t, g, fps, clock, wet) {
  const {step, stepT, stepId} = clock;
  if (!engaged(wet, stepId, g.seed)) return idle(t);
  const full = Math.min(step, Math.max(1 / fps, step * g.slice));
  if (full >= step - 1e-4 && g.decay <= 0 && g.variation <= 0) return idle(t);
  const minLen = Math.max(1 / fps, full * (1 - g.decay * .85));
  const local = Math.max(0, t - stepT);
  let pos = 0, len = full, rep = 0;
  while (pos + len <= local + 1e-8 && rep < 24) {
    pos += len;
    rep++;
    len = Math.max(minLen, full * (1 - g.decay * Math.min(1, rep / 3)));
  }
  const into = Math.min(Math.max(0, local - pos), Math.max(0, len - 1e-4));
  const room = Math.max(0, step - len);
  const offset = room * g.variation * hsh(stepId * .73 + g.seed * 1.91);
  const src = Math.min(plan.dur || t, Math.max(0, stepT + Math.min(step - 1e-4, offset + into)));
  const hold = len <= 1.5 / fps;
  return {src, remap: true, gate: null, mix: 0, hold, holdId: hold ? 's' + stepId : '', mode: 'stutter'};
}

function repeat(plan, t, g, fps, clock, wet) {
  const {bar} = clock;
  if (!engaged(wet, bar.bar * 17 + 3, g.seed)) return idle(t);
  const beat = plan.P > 0 ? plan.P : clock.beat.beatLen;
  const chunk = g.chunk === 'frames' ? Math.max(1, g.frames) / fps : beat;
  const span = Math.max(1e-3, g.t1 - g.t0);
  const u = clamp((bar.barT - g.t0) / span);
  const ramp = 1 - g.build * (1 - u);
  // A single play of the downbeat is just the bar. Build starts at two plays so the loop is already audible.
  const lo = g.build > 0 ? Math.min(2, g.repeats) : g.repeats;
  const reps = Math.max(1, Math.round(lo + (g.repeats - lo) * ramp));
  const into = t - bar.barT;
  const loopFor = Math.min(bar.barLen, chunk * reps);
  if (!(into >= 0) || into >= loopFor - 1e-9) return idle(t);
  const phase = into % chunk;
  const raw = g.chunk === 'frames' ? bar.barT - chunk + phase : bar.barT + phase;
  const src = Math.min(plan.dur || t, Math.max(0, raw));
  const hold = g.chunk === 'frames' && g.frames <= 1;
  return {src, remap: true, gate: null, mix: 0, hold, holdId: hold ? 'r' + bar.bar : '', mode: 'repeat'};
}

function gate(plan, t, g, clock, wet) {
  const {stepT, idx, stepId, bar} = clock;
  const on = g.pattern[idx % g.pattern.length] !== 0;
  if (on) return idle(t);
  const roll = hsh(bar.bar * 19.1 + idx * 3.7 + g.seed * .13);
  if (!(roll < g.probability)) return idle(t);
  if (!engaged(wet, stepId, g.seed)) return idle(t);
  if (g.fill === 'freeze') {
    const src = Math.min(plan.dur || t, Math.max(0, stepT));
    return {src, remap: true, gate: null, mix: 0, hold: true, holdId: 'f' + bar.bar + '-' + idx, mode: 'gate'};
  }
  return {src: t, remap: false, gate: g.fill, mix: clamp(g.amount), hold: false, holdId: '', mode: 'gate'};
}

/**
 * Sample the effect at song time `t`.
 * `fx` is the fade-lane value (0..1). It scales which divisions fire; the composite ducks a black/white gate again.
 * Outside `[t0, t1)` and at amount 0 the clip plays straight through.
 */
export function grossAt(plan, t, gross, fx = 1, fps = 30) {
  if (!gross || !(gross.amount > 0) || !plan || !plan.beats || !plan.beats.length) return idle(t);
  const t0 = gross.t0 || 0, t1 = gross.t1 == null ? Infinity : gross.t1;
  if (t < t0 - 1e-9 || t >= t1 - 1e-9) return idle(t);
  const rate = fps > 0 ? fps : 30;
  const wet = clamp(gross.amount) * clamp(fx);
  if (wet <= 0) return idle(t);
  const clock = subAt(plan, t, gross.div);
  switch (gross.mode) {
    case 'stutter': return stutter(plan, t, gross, rate, clock, wet);
    case 'repeat': return repeat(plan, t, gross, rate, clock, wet);
    case 'gate': return gate(plan, t, gross, clock, wet);
    default: return idle(t);
  }
}
