// Synthetic, model-free stand-in for Volta's analysis pipeline (test harness only).
//
// A capsule-figure dancer is scripted at 128 BPM and rasterised analytically into everything analyzeVideo() would
// produce: per-frame motion, depth + person-mask maps (post-processed exactly like src/video.js), area, pivots and,
// in the browser, JPEG colour frames. A matching song analysis (A) and beat grid (via the real gridFor) complete
// the inputs that makePlan() / DotRenderer need. Works in Node 22 and the browser: no DOM is touched at import time,
// and nothing here uses Math.random (variation comes from an integer hash), so every output is deterministic.
//
// Units: pose geometry lives in "frame-height units": y in [0,1] top->bottom, x in [0, aspect] left->right.
import { clamp, gaussSmooth, fillNaN } from '../src/util.js';
import { gridFor, pickSection } from '../src/audio.js';

// ---------------------------------------------------------------------------------------------------------------
// constants shared by the dancer script and the fake song (so the moves land on the grid the planner sees)
export const BPM = 128, BEAT = 60 / BPM;      // 0.46875 s
export const PHASE = 0.05;                     // first beat of the fake song
export const START_PAD = 0.010;                // app.js starts the section 10 ms before the downbeat
export const DROP_BAR = 8;                     // the one drop bar of the fake song (pickSection lands on it)
export const ASPECT = 720 / 404;               // default source aspect (w/h of the default bundle)
export const FLOOR = 0.925, HORIZON = 0.64;    // image y of the feet line, and of the wall/floor seam
export const SCALE = 0.86;                     // figure scale (standing figure ~0.70 of frame height)
export const beatT = j => START_PAD + j * BEAT; // clip-relative time of beat j (clip starts on the drop bar)

// ---------------------------------------------------------------------------------------------------------------
// deterministic hashing / small helpers
export function hash32(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d); x ^= x >>> 12; return x >>> 0;
}
export const hash01 = n => hash32(n) / 4294967296;
const jit = (k, amp) => (hash01(k) * 2 - 1) * amp;
const smooth = u => { u = clamp(u); return u * u * (3 - 2 * u); };
const EASE = {lin: u => u, io: smooth, out: u => 1 - Math.pow(1 - u, 3), step: u => (u < 1 ? 0 : 1)};

/** FNV-1a 32 over bytes (any ArrayBufferView) or a string's UTF-16 code units; returns 8 hex digits. */
export function fnv1a(data, h = 0x811c9dc5) {
  if (typeof data === 'string') { for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i) & 255; h = Math.imul(h, 0x01000193); h ^= data.charCodeAt(i) >>> 8; h = Math.imul(h, 0x01000193); } }
  else { const b = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------------------------
// poses: joint angles in degrees. Angles are measured from "straight down"; positive swings to the figure's outside
// (image-left limbs mirror image-right ones). el/kn are bends relative to the parent segment.
const PARAMS = ['x', 'lean', 'head', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'hipR', 'knR'];
const NEUTRAL = {x: 0, lean: 0, head: 0, shL: 12, elL: 14, shR: 12, elR: 14, hipL: 5, knL: 2, hipR: 5, knR: 2};
const P = o => Object.freeze({...NEUTRAL, ...o});
export const POSES = Object.freeze({
  neutral: P({}),
  still: P({shL: 16, elL: 22, shR: 16, elR: 22, hipL: 7, hipR: 7}),
  armsUp: P({shL: 160, elL: 12, shR: 160, elR: 12, head: -4, hipL: 8, hipR: 8}),
  vee: P({shL: 135, elL: 0, shR: 135, elR: 0, hipL: 10, hipR: 10}),
  tpose: P({shL: 90, elL: 0, shR: 90, elR: 0, hipL: 12, hipR: 12}),
  goal: P({shL: 90, elL: 90, shR: 90, elR: 90, hipL: 9, hipR: 9}),
  punchR: P({x: .02, lean: -7, shR: 95, elR: 4, shL: 35, elL: 115, hipR: 10}),
  pointR: P({lean: 9, head: 8, shR: 150, elR: 0, shL: 25, elL: 70, hipR: 16, knR: 6, hipL: 3}),
  stepR: P({x: .07, lean: 6, shR: 55, elR: 85, shL: 70, elL: 40, hipR: 20, knR: 8, hipL: 2}),
  hips: P({shL: 45, elL: -95, shR: 45, elR: -95, hipL: 9, hipR: 9}),
  crouch: P({hipL: 38, knL: 72, hipR: 38, knR: 72, shL: 55, elL: 75, shR: 55, elR: 75}),
  crouchLow: P({hipL: 50, knL: 100, hipR: 50, knR: 100, shL: 28, elL: 40, shR: 28, elR: 40, head: 6}),
  tuck: P({hipL: 30, knL: 85, hipR: 30, knR: 85, shL: 150, elL: 20, shR: 150, elR: 20}),
});
export const mirror = p => ({...p, x: -p.x, lean: -p.lean, head: -p.head, shL: p.shR, elL: p.elR, shR: p.shL, elR: p.elL, hipL: p.hipR, knL: p.knR, hipR: p.hipL, knR: p.knL});
function variant(name, mir, j) {      // library pose + small hashed per-beat variation
  const b = mir ? mirror(POSES[name]) : POSES[name], o = {...b};
  PARAMS.forEach((k, i) => { o[k] += k === 'x' ? jit(j * 131 + i, .01) : k === 'lean' || k === 'head' ? jit(j * 131 + i, 2.5) : jit(j * 131 + i, 6); });
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// the script: hold-then-snap moves that land on beats, a still stretch, an off-grid snap, crouches, a jump, a pan.
const STILL = [5.45, beatT(18) - .15];          // pose constant (breathing only): [5.45, 8.2975] covers 5.5-8.0
const OFFGRID = [9.765, 9.805];                // sudden move between beats 20 (9.385) and 21 (9.854)
const PAN = [12.0, 13.0], PAN_DX = .15;        // figure translates by 15% of the frame width, pose frozen
const AIR = [13.60, 14.06], AIR_H = .11;       // feet leave the floor
const KEYS = [], HITS = [];
{
  let cur = null;
  const hold = t => KEYS.push({t, p: cur});
  const to = (t, p, e = 'out') => { KEYS.push({t, p, e}); cur = p; };
  const hit = (j, name, mir = 0, lead = .15, e = 'out') => { const tb = beatT(j); hold(tb - lead); to(tb, variant(name, mir, j), e); HITS.push(tb); };
  to(-1, variant('armsUp', 0, 0)); HITS.push(beatT(0));
  hit(1, 'goal'); hit(2, 'punchR'); hit(3, 'punchR', 1); hit(4, 'stepR'); hit(5, 'stepR', 1);
  hit(6, 'crouch', 0, .2, 'io'); hit(7, 'crouchLow', 0, .2, 'io'); hit(8, 'vee'); hit(9, 'pointR'); hit(10, 'pointR', 1); hit(11, 'hips');
  hold(5.25); to(STILL[0], {...POSES.still}, 'io');                                  // settle into the still pose
  hit(18, 'tpose'); hit(19, 'punchR', 1); hit(20, 'goal');                           // energetic again from 8.3 s
  hold(OFFGRID[0]); to(OFFGRID[1], variant('pointR', 1, 21), 'lin');                  // off-grid snap at ~9.78 s
  hit(22, 'stepR', 1); hit(23, 'armsUp'); hit(24, 'hips'); hit(25, 'vee');            // 'vee' is held through the pan
  hit(28, 'crouch', 0, beatT(28) - (PAN[1] + .01), 'io');                             // anticipation crouch after the pan
  hold(13.50); to(13.72, variant('tuck', 0, 29), 'io');                               // jump: tuck in the air
  hold(13.93); to(beatT(30), variant('crouch', 1, 30), 'out');                        // land in a crouch
  hit(31, 'armsUp'); hit(32, 'goal'); hit(33, 'tpose'); hit(34, 'punchR');
  for (let i = 1; i < KEYS.length; i++) if (!(KEYS[i].t >= KEYS[i - 1].t)) throw new Error('synth: keys out of order at ' + KEYS[i].t);
}
/** Markers of the scripted dancer (clip-relative seconds) so tests can aim at specific behaviour. */
export const SCRIPT = Object.freeze({
  bpm: BPM, beat: BEAT, beat0: START_PAD, hits: HITS.filter(t => t >= 0).map(t => +t.toFixed(4)),
  still: STILL, offGrid: 9.78, offGridMove: OFFGRID, pan: PAN, panDx: PAN_DX, jump: AIR, jumpHeight: AIR_H,
  crouch: [[beatT(6), beatT(8) - .15], [beatT(28), 13.5], [beatT(30), beatT(31) - .15]],
});

/** Pose at clip time t (seconds): joint angles + dy (bounce/breath), air (height above floor), pan (frame-width fraction). */
export function poseAt(t) {
  let i = 0; while (i < KEYS.length - 1 && KEYS[i + 1].t <= t) i++;
  const a = KEYS[i], b = KEYS[i + 1], p = {};
  const u = b ? EASE[b.e || 'out'](clamp((t - a.t) / (b.t - a.t))) : 0;
  for (const k of PARAMS) p[k] = b ? a.p[k] + (b.p[k] - a.p[k]) * u : a.p[k];
  let dy = 0;
  // beat bounce (energetic segments only; exactly zero >0.25 s after a hit, so the still and pan stretches stay frozen)
  for (const tb of HITS) { const d = t - tb; if (d > 0 && d < .25 && !(tb > AIR[0] - .1 && tb < AIR[1] + .1)) dy += .010 * (d / .05) * Math.exp(1 - d / .05) * (1 - smooth((d - .15) / .1)); }
  // breathing in the still stretch
  if (t > STILL[0] && t < STILL[1]) { const w = Math.min(1, (t - STILL[0]) / .3, (STILL[1] - t) / .3), br = Math.sin(2 * Math.PI * (t - STILL[0]) / 3.2) * w;
    p.shL += .7 * br; p.shR += .7 * br; dy -= .0012 * br; }
  const air = t > AIR[0] && t < AIR[1] ? 4 * AIR_H * ((t - AIR[0]) / (AIR[1] - AIR[0])) * (1 - (t - AIR[0]) / (AIR[1] - AIR[0])) : 0;
  const pan = t <= PAN[0] ? 0 : PAN_DX * smooth((t - PAN[0]) / (PAN[1] - PAN[0]));
  return {t, ...p, dy, air, pan};
}

// ---------------------------------------------------------------------------------------------------------------
// forward kinematics -> capsules {a:[x,y], b:[x,y], r, depth, col:[r,g,b] 0..1, part}
const COL = {hoodie: [.80, .80, .82], skin: [.78, .60, .48], trousers: [.17, .18, .22], shoes: [.95, .95, .95]};
const D2R = Math.PI / 180;
const dirDown = a => [Math.sin(a * D2R), Math.cos(a * D2R)];
const dirUp = a => [Math.sin(a * D2R), -Math.cos(a * D2R)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, s) => [a[0] * s, a[1] * s];

export function skeleton(p, aspect = ASPECT) {
  const S = SCALE, caps = [];
  const cap = (part, a, b, r, depth, col) => caps.push({part, a, b, r: r * S, depth, col});
  const legs = [[-1, p.hipL, p.knL], [1, p.hipR, p.knR]].map(([s, hip, kn]) => {
    const a1 = s * hip, a2 = a1 - s * kn, h = [s * .055 * S, 0], knee = add(h, mul(dirDown(a1), .19 * S)), ankle = add(knee, mul(dirDown(a2), .19 * S));
    return {s, hip: h, knee, ankle, bend: clamp(Math.abs(kn) / 90)};
  });
  const foot = Math.max(...legs.map(l => l.ankle[1])) + .038 * S;
  const px = (.5 + p.pan) * aspect + p.x, py = FLOOR - foot - p.air + p.dy, O = [px, py];
  for (const l of legs) {
    const hip = add(O, l.hip), knee = add(O, l.knee), ankle = add(O, l.ankle);
    cap('thigh', hip, knee, .044, .62 + .05 * l.bend, COL.trousers);
    cap('shin', knee, ankle, .036, .615 + .03 * l.bend, COL.trousers);
    cap('shoe', add(ankle, [-l.s * .004 * S, .016 * S]), add(ankle, [l.s * .032 * S, .018 * S]), .02, .625, COL.shoes);
  }
  const up = dirUp(p.lean), perp = [Math.cos(p.lean * D2R), Math.sin(p.lean * D2R)];
  const at = (base, along, side = 0) => add(add(base, mul(up, along * S)), mul(perp, side * S));
  cap('hips', at(O, 0, -.055), at(O, 0, .055), .055, .63, COL.trousers);
  cap('torso', at(O, .04), at(O, .20), .072, .64, COL.hoodie);
  const neck = at(O, .255), shL = at(neck, -.015, -.085), shR = at(neck, -.015, .085);
  cap('shoulders', shL, shR, .05, .645, COL.hoodie);
  cap('neck', neck, at(neck, .04), .025, .64, COL.skin);
  const head = add(neck, mul(dirUp(p.lean + p.head), .09 * S));
  cap('head', head, head, .056, .655, COL.hoodie);
  const face = add(head, mul(dirUp(p.lean + p.head), -.006 * S));
  cap('face', face, add(face, mul(dirUp(p.lean + p.head), -.008 * S)), .036, .665, COL.skin);
  for (const [s, sh, el, sp] of [[-1, p.shL, p.elL, shL], [1, p.shR, p.elR, shR]]) {
    const near = s > 0 ? .10 : 0;                    // the image-right arm is nearer to the camera
    const ua = p.lean + s * sh, fa = ua + s * el, elbow = add(sp, mul(dirDown(ua), .135 * S)), wrist = add(elbow, mul(dirDown(fa), .125 * S));
    cap('upperArm', sp, elbow, .032, .62 + near, COL.hoodie);
    cap('foreArm', elbow, wrist, .027, .62 + near, COL.hoodie);
    const hand = add(wrist, mul(dirDown(fa), .022 * S));
    cap('hand', hand, hand, .026, .625 + near, COL.skin);
  }
  caps.forEach((c, i) => { c.i = i; });
  caps.sort((a, b) => a.depth - b.depth || a.i - b.i);       // painter's order: far first
  return {caps, px, py, air: p.air, aspect};
}

// ---------------------------------------------------------------------------------------------------------------
// analytic rasteriser (1 px anti-aliasing). out: {rgb?: Float32Array(W*H*3), dep?: Float32Array(W*H), mask?: Float32Array(W*H)}
const LIGHTS = [-.4, -.15, .1, .32, .68, .9, 1.15];     // stage light columns on the back wall (world x, frame-width units)
function paintBackground(W, H, aspect, pan, out) {
  if (out.rgb) {
    const colI = new Float32Array(W);
    for (let i = 0; i < W; i++) { const u = (i + .5) * aspect / W; let s = 0; for (const c of LIGHTS) { const d = u - (c + pan) * aspect; s += Math.exp(-d * d / (2 * .03 * .03)); } colI[i] = s; }
    for (let j = 0; j < H; j++) {
      const v = (j + .5) / H, wall = v < HORIZON, f = wall ? v / HORIZON : (v - HORIZON) / (1 - HORIZON);
      const g = wall ? .040 + .030 * f : .085 + .075 * f, cf = wall ? .045 * (.3 + .7 * f) : .010 * (1 - f), seam = .03 * Math.exp(-Math.pow((v - HORIZON) / .004, 2));
      const r0 = g + seam, g0 = g + seam, b0 = g * (wall ? 1.18 : 1.06) + seam;
      for (let i = 0; i < W; i++) { const p = (j * W + i) * 3, c = colI[i] * cf; out.rgb[p] = r0 + c; out.rgb[p + 1] = g0 + c * .97; out.rgb[p + 2] = b0 + c * .9; }
    }
  }
  if (out.dep) for (let j = 0; j < H; j++) { const v = (j + .5) / H, d = v < HORIZON ? .15 + .05 * v / HORIZON : .20 + .25 * (v - HORIZON) / (1 - HORIZON); out.dep.fill(d, j * W, (j + 1) * W); }
  if (out.mask) out.mask.fill(0);
}
function paintShadow(sk, W, H, out) {      // soft contact shadow on the floor (colour only); fades while airborne
  const rx = .12 * SCALE, ry = .02 * SCALE, cx = sk.px, cy = FLOOR - .004, fade = clamp(1 - sk.air / .2), sx = sk.aspect / W;
  const i0 = Math.max(0, Math.floor((cx - rx) / sx)), i1 = Math.min(W - 1, Math.ceil((cx + rx) / sx)), j0 = Math.max(0, Math.floor((cy - ry) * H)), j1 = Math.min(H - 1, Math.ceil((cy + ry) * H));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const q = Math.pow(((i + .5) * sx - cx) / rx, 2) + Math.pow(((j + .5) / H - cy) / ry, 2); if (q >= 1) continue;
    const k = 1 - .55 * (1 - q) * fade, p = (j * W + i) * 3; out.rgb[p] *= k; out.rgb[p + 1] *= k; out.rgb[p + 2] *= k;
  }
}
function paintCaps(caps, W, H, aspect, out) {
  const sx = aspect / W, sy = 1 / H, {rgb, dep, mask} = out;
  for (const c of caps) {
    const [ax, ay] = c.a, [bx, by] = c.b, r = c.r, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / sx) - 1), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + r) / sx) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / sy) - 1), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + r) / sy) + 1);
    for (let j = j0; j <= j1; j++) {
      const v = (j + .5) * sy;
      for (let i = i0; i <= i1; i++) {
        const u = (i + .5) * sx; let tt = L2 > 0 ? ((u - ax) * dx + (v - ay) * dy) / L2 : 0; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const ex = u - ax - tt * dx, ey = v - ay - tt * dy, d = Math.sqrt(ex * ex + ey * ey), cov = .5 - (d - r) * H;
        if (cov <= 0) continue;
        const a = cov > 1 ? 1 : cov, q = d / r, k = q < 1 ? Math.sqrt(1 - q * q) : 0, p = j * W + i;
        if (mask) mask[p] += (1 - mask[p]) * a;
        if (dep) dep[p] += (c.depth + .035 * k - dep[p]) * a;
        if (rgb) { const sh = .64 + .30 * k + .06 * clamp(-(ex + ey) / (r + 1e-9), -1, 1); for (let ch = 0; ch < 3; ch++) rgb[p * 3 + ch] += (c.col[ch] * sh - rgb[p * 3 + ch]) * a; }
      }
    }
  }
}
function asPose(pose) { return typeof pose === 'number' ? poseAt(pose) : pose; }
/** Colour render as RGBA bytes (W*H*4), what a decoded video frame would hold. */
export function rasterRGBA(pose, W, H, {aspect = ASPECT} = {}) {
  const sk = skeleton(asPose(pose), aspect), rgb = new Float32Array(W * H * 3);
  paintBackground(W, H, aspect, asPose(pose).pan, {rgb}); paintShadow(sk, W, H, {rgb}); paintCaps(sk.caps, W, H, aspect, {rgb});
  const out = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) { out[p * 4] = rgb[p * 3] * 255; out[p * 4 + 1] = rgb[p * 3 + 1] * 255; out[p * 4 + 2] = rgb[p * 3 + 2] * 255; out[p * 4 + 3] = 255; }
  return out;
}
/** Float depth (0 far .. 1 near, like the normalised Depth-Anything output) and soft person mask before temporal post-processing. */
export function rasterDepthMask(pose, aw, ah, {aspect = ASPECT} = {}) {
  const p = asPose(pose), sk = skeleton(p, aspect), dep = new Float32Array(aw * ah), mask = new Float32Array(aw * ah);
  paintBackground(aw, ah, aspect, p.pan, {dep, mask}); paintCaps(sk.caps, aw, ah, aspect, {dep, mask});
  for (let i = 0; i < dep.length; i++) { dep[i] = clamp(dep[i]); mask[i] = clamp(mask[i]); }
  return {dep, mask};
}
/** Depth/mask map as video.js packs it: RGBA bytes, R = depth*255, G = mask*255, A = 255 (no temporal smoothing). */
export function rasterDM(pose, aw, ah, opts = {}) {
  const {dep, mask} = rasterDepthMask(pose, aw, ah, opts), out = new Uint8Array(aw * ah * 4);
  for (let p = 0; p < dep.length; p++) { out[p * 4] = dep[p] * 255; out[p * 4 + 1] = mask[p] * 255; out[p * 4 + 3] = 255; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// post-processing: a line-for-line mirror of analyzeVideo()'s tail in src/video.js (keep in sync with it)
function components(bin, w, h) {
  const lab = new Int32Array(w * h).fill(-1), out = []; const st = [];
  for (let i = 0; i < w * h; i++) { if (!bin[i] || lab[i] >= 0) continue; const id = out.length; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; st.push(i); lab[i] = id; const px = [];
    while (st.length) { const p = st.pop(); px.push(p); n++; const x = p % w, y = (p / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= w * h || lab[q] >= 0 || !bin[q]) continue; if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue; lab[q] = id; st.push(q); } }
    out.push({px, x0, y0, x1, y1, n}); }
  return out;
}
export function postProcess(dmRaw, aw, ah) {
  const N = dmRaw.length, dm = [], area = [], cxs = [], cys = [], pds = [];
  for (let k = 0; k < N; k++) {
    const {dep, mask} = dmRaw[k], ds = Float32Array.from(dep), ms = Float32Array.from(mask);
    for (const j of [k - 1, k + 1]) { if (j < 0 || j >= N) continue; const b = dmRaw[j];
      for (let p = 0; p < ds.length; p++) { if (Math.abs(b.dep[p] - dep[p]) < .08) ds[p] = (ds[p] + b.dep[p] * .5) / 1.5; if (Math.abs(b.mask[p] - mask[p]) < .3) ms[p] = (ms[p] + b.mask[p] * .5) / 1.5; } }
    const bin = new Uint8Array(ms.length); for (let p = 0; p < ms.length; p++) bin[p] = ms[p] > .4 ? 1 : 0;
    for (const c of components(bin, aw, ah)) { let dsum = 0; for (const p of c.px) dsum += ds[p];
      if ((c.y0 < 3 && c.y1 - c.y0 > .8 * ah && dsum / c.n > .7) || c.n < aw * ah * .002) for (const p of c.px) ms[p] = 0; }
    const rgba = new Uint8Array(aw * ah * 4); let a = 0, sx = 0, sy = 0; const dl = [];
    for (let p = 0; p < ms.length; p++) { rgba[p * 4] = ds[p] * 255; rgba[p * 4 + 1] = ms[p] * 255; rgba[p * 4 + 3] = 255;
      if (ms[p] > .5) { a++; sx += p % aw; sy += (p / aw) | 0; dl.push(ds[p]); } }
    dm.push(rgba); area.push(a / ms.length);
    if (a / ms.length > .01) { dl.sort(); cxs.push(sx / a / aw); cys.push(sy / a / ah); pds.push(dl[dl.length >> 1]); } else { cxs.push(NaN); cys.push(NaN); pds.push(NaN); }
  }
  const sx = gaussSmooth(fillNaN(cxs), 2), sy = gaussSmooth(fillNaN(cys), 2), sp = gaussSmooth(fillNaN(pds), 2);
  return {dm, area, piv: sx.map((x, i) => [x, sy[i], sp[i]])};
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Build an analysis bundle shaped exactly like analyzeVideo()'s:
 * {w,h,srcW,srcH,fps,n,dur,frames:[JPEG Blob],aw,ah,step,dm:[Uint8Array RGBA],motion,area,piv:[[x,y,d]],info}
 * frames: false -> [] (Node / planner-only); 'browser' -> JPEG Blobs at w x h via OffscreenCanvas.convertToBlob.
 */
export async function synthBundle({dur = 16, fps = 30, step = 2, aw = 266, ah = 150, w = 720, h = 404, srcW = w, srcH = h, frames = false, onProgress = null} = {}) {
  const aspect = srcW / srcH, n = Math.floor(dur * fps), outFrames = [], motion = [], dmRaw = [];
  let cc = null, cx = null, pend = [];
  if (frames === 'browser') {
    if (typeof OffscreenCanvas === 'undefined') throw new Error("synthBundle: frames:'browser' needs OffscreenCanvas");
    cc = new OffscreenCanvas(w, h); cx = cc.getContext('2d', {willReadFrequently: true});   // CPU-backed: much faster put + encode under SwiftShader
  } else if (frames) throw new Error('synthBundle: frames must be false or "browser"');
  let prevGray = null;
  for (let i = 0; i < n; i++) {
    const t = (i + .5) / fps, pose = poseAt(t);          // video.js samples frame i at (i + .5) / fps
    if (cc) {
      cx.putImageData(new ImageData(rasterRGBA(pose, w, h, {aspect}), w, h), 0, 0);
      pend.push(cc.convertToBlob({type: 'image/jpeg', quality: .88}));
      if (pend.length >= 8) { outFrames.push(...await Promise.all(pend)); pend = []; }
    }
    // motion (frame diff on gray of the aw x ah 8-bit render), as in video.js
    const img = rasterRGBA(pose, aw, ah, {aspect});
    const gray = new Float32Array(aw * ah); for (let p = 0; p < aw * ah; p++) gray[p] = .299 * img[p * 4] + .587 * img[p * 4 + 1] + .114 * img[p * 4 + 2];
    let md = 0; if (prevGray) { for (let p = 0; p < gray.length; p++) md += Math.abs(gray[p] - prevGray[p]); md /= gray.length; } motion.push(md); prevGray = gray;
    if (i % step === 0) dmRaw.push(rasterDepthMask(pose, aw, ah, {aspect}));
    if (onProgress && i % 30 === 0) onProgress(i / n);
  }
  if (pend.length) outFrames.push(...await Promise.all(pend));
  const {dm, area, piv} = postProcess(dmRaw, aw, ah);
  return {w, h, srcW, srcH, fps, n, dur: n / fps, frames: outFrames, aw, ah, step, dm, motion, area, piv,
    info: {depth: 'synthetic (test/synth.js)', seg: 'synthetic capsule dancer', secPerFrame: 0}};
}

/** Digest of the parts of a bundle that feed the planner/renderer (frames excluded: JPEG bytes are browser-specific). */
export function bundleDigest(V) {
  let h = 0x811c9dc5; for (const d of V.dm) h = parseInt(fnv1a(d, h), 16);
  return {dm: (h >>> 0).toString(16).padStart(8, '0'), motion: fnv1a(JSON.stringify(V.motion)), area: fnv1a(JSON.stringify(V.area)), piv: fnv1a(JSON.stringify(V.piv)),
    shape: `${V.w}x${V.h} src ${V.srcW}x${V.srcH} ${V.fps}fps n=${V.n} dm=${V.dm.length}@${V.aw}x${V.ah}/${V.step}`};
}

// ---------------------------------------------------------------------------------------------------------------
// fake song analysis (the object analyzeAudio() returns) and the beat grid the app would derive from it
/**
 * A-like object: 128 BPM, first beat at PHASE, a song longer than the clip, kicks strongest on beats 1 and 3,
 * per-bar energy e computed with audio.js's formula, and exactly one drop bar (DROP_BAR).
 */
export function synthAnalysis(dur = 16, {songDur = Math.max(64, dur + 48)} = {}) {
  const bpm = BPM, P = 60 / bpm, phase = PHASE;
  const beats = []; for (let t = phase; t < songDur; t += P) beats.push(t);     // same accumulation as audio.js
  // intro with a two-bar build-up (so only the drop bar itself, not the one after it, passes audio.js's drop test)
  const level = bar => bar < DROP_BAR ? (bar === DROP_BAR - 1 ? .50 : bar === DROP_BAR - 2 ? .42 : .30 + .012 * bar) : bar < DROP_BAR + 12 ? .92 + .05 * hash01(bar * 7 + 1) : Math.max(.35, .92 - .06 * (bar - DROP_BAR - 11));
  const beatKick = beats.map((t, k) => { const j = k % 4, bar = k >> 2, loud = bar >= DROP_BAR && bar < DROP_BAR + 12;
    const base = j === 0 ? 1.0 : j === 2 ? .82 : .38 + .14 * hash01(k * 11 + 5);
    return Math.min(1.5, base * (loud ? 1.1 : .75) * (.88 + .24 * hash01(k * 13 + 1))); });
  const beatRms = beats.map((t, k) => level(k >> 2) * (.94 + .12 * hash01(k * 17 + 3)) * (k >> 2 === DROP_BAR && k % 4 === 0 ? 1.25 : 1));
  // bars / drops: verbatim from analyzeAudio (downbeat offset 0: the first beat is a downbeat)
  const dOff = 0, bars = []; for (let k = dOff; k < beats.length; k += 4) bars.push({k, t: beats[k], e: 0});
  for (const b of bars) { let s = 0, kk = 0; for (let j = 0; j < 4 && b.k + j < beats.length; j++) { s += beatRms[b.k + j]; kk += beatKick[b.k + j]; } b.e = (s / 4) * (.5 + kk / 4); }
  const es = bars.map(b => b.e).sort((a, b) => a - b), e70 = es[Math.floor(es.length * .7)] || 0;
  bars.forEach((b, i) => { const prev = i > 1 ? (bars[i - 1].e + bars[i - 2].e) / 2 : i > 0 ? bars[0].e : 0; b.dropS = clamp((b.e / Math.max(prev, 1e-6) - 1) / 3); b.drop = b.e >= e70 && b.dropS > .15; });
  const W = 1200, waveform = new Float32Array(W);
  for (let i = 0; i < W; i++) { const t = (i + .5) / W * songDur, k = Math.max(0, Math.min(beats.length - 1, Math.floor((t - phase) / P))), a = Math.max(0, t - beats[k]);
    waveform[i] = beatRms[k] * (.35 + .65 * Math.exp(-a / .09)) * (.9 + .2 * hash01(i)); }
  return {duration: songDur, bpm, P, phase, beats, beatKick, beatRms, bars, kickOnGrid: 1, nKicks: beats.length, waveform};
}
/** What app.js autoPick() + setStart() do: pick the section (real pickSection), start 10 ms before its downbeat, real gridFor. */
export function synthSection(dur = 16, A = synthAnalysis(dur)) {
  const pick = pickSection(A, dur), db = pick.t;
  const start = clamp(db - START_PAD, 0, Math.max(0, A.duration - dur));
  return {A, pick, start, downbeat: db, grid: gridFor(A, start, dur, db)};
}
export function synthGrid(dur = 16, A) { return synthSection(dur, A).grid; }
