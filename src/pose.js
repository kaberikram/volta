// Pose analysis for the plates stage: per-frame silhouette stats, the source -> stage mapping, a pose-change envelope
// and the horizontal slab geometry of a frozen pose. Pure (no DOM / GL); results are cached per analysis bundle.
import { clamp, gaussSmooth, fillNaN, pct, hsh, D0 } from './util.js';

export const FIG_H = 1.75, PITCH = .085, MAX_RUNS = 4;
// plate families seen in the reference: thin acrylic discs, white bars, fat rounded pebbles
export const STYLES = {
  thin:   {id: 0, t: .36, n: 2.0, rh: .5, over: 1.08},
  bar:    {id: 1, t: .56, n: 3.2, rh: .35, over: 1},
  pebble: {id: 2, t: .80, n: 2.2, rh: .6, over: 1},
};
const DW = 16, DH = 12;                       // pose descriptor grid (bbox-normalised coverage)
export const distOf = d => D0 * (2.4 - 1.8 * d);
const memo = new WeakMap();
const box = V => { let c = memo.get(V); if (!c) { c = {slabs: new Map()}; memo.set(V, c); } return c; };

/** stats of one dm frame (RGBA: R depth, G mask): bbox, lowest row, median person depth, coverage descriptor. */
const hist = new Uint32Array(256);
export function poseStatsFrame(d, aw, ah, prevDesc = null) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; const rowN = new Uint16Array(ah); hist.fill(0);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const p = (y * aw + x) * 4; if (d[p + 1] > 127) { n++; rowN[y]++; hist[d[p]]++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (n < 12) return {ok: false, desc: prevDesc || new Float32Array(DW * DH + 1), dd: 0};
  let rb = y1; while (rb > y0 && rowN[rb] < 3) rb--;
  let med = 0; for (let v = 0, c = 0, half = n >> 1; v < 256; v++) { c += hist[v]; if (c > half) { med = v; break; } }   // == sorted[n >> 1]
  const desc = new Float32Array(DW * DH + 1), bw = x1 - x0 + 1, bh = rb - y0 + 1;
  for (let y = y0; y <= rb; y++) for (let x = x0; x <= x1; x++) if (d[(y * aw + x) * 4 + 1] > 127) {
    const gx = Math.min(DW - 1, Math.floor((x - x0) / bw * DW)), gy = Math.min(DH - 1, Math.floor((y - y0) / bh * DH));
    desc[gy * DW + gx] += DW * DH / (bw * bh); }
  desc[DW * DH] = clamp(bw / bh / 2);
  return {ok: true, x0, x1, y0, y1, rb, n, cut: rb >= ah - 2, pd: med / 255, desc, dd: 0};
}
/** per dm frame stats + descriptor change to the previous frame. */
export function poseStats(V) {
  const c = box(V); if (c.stats) return c.stats;
  const {aw, ah} = V, N = V.dm.length, out = [];
  for (let k = 0; k < N; k++) out.push(poseStatsFrame(V.dm[k], aw, ah, k ? out[k - 1].desc : null));
  for (let k = 1; k < N; k++) out[k].dd = descDist(out[k].desc, out[k - 1].desc);
  if (N > 1) out[0].dd = out[1].dd;
  return (c.stats = out);
}
/** live bundles: seed the cache with arrays the live analyzer grows in place, so every consumer works unchanged. */
export function bindLive(V, {stats, fit}) { const c = box(V); c.stats = stats; c.fit = fit; c.slabs = new Map(); return c; }
export function descDist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// source-camera lift (full frame, source aspect), same formula as the point shader
export const liftSrc = (V, u, v, d) => { const aS = V.w / V.h, s = distOf(d) / D0; return [(u * 2 - 1) * aS * s, (1 - v * 2) * s, -D0 * s]; };

/**
 * Stage space: metres, y up, floor y=0, figure height FIG_H. One affine map per dm frame k:
 *   stage(P) = (k*(P-A_k)) * (1, 1, relief) + (0, off_k, 0)        (local, feet-anchored)  + dpos_k (position on stage)
 * The same map places the dancer's points and a ghost's slabs, so a ghost overlays the dancer when it is printed.
 */
export function stageFit(V) {
  const c = box(V); if (c.fit) return c.fit;
  const st = poseStats(V), N = st.length, ah = V.ah, has = st.filter(s => s.ok);
  const heightSrc = s => (s.rb - s.y0 + 1) / ah * 2 * distOf(s.pd) / D0;
  const uncut = has.filter(s => !s.cut && s.y0 > 1);
  const hs = (uncut.length >= 3 ? uncut : has).map(heightSrc);
  const kS = has.length ? FIG_H / Math.max(1e-3, pct(hs, .9) * (uncut.length >= 3 ? 1 : 1.25)) : 1;
  const rowFloor = (uncut.length ? pct(uncut.map(s => s.rb), .8) : ah - 1) + .5;
  const pds = fillNaN(st.map(s => s.ok ? s.pd : NaN)), px = fillNaN(V.piv.map(p => p[0]));
  const A = [], off = new Float64Array(N), yb = new Float64Array(N), raw = [], mostCut = has.length > 0 && has.filter(s => s.cut).length / has.length > .6;
  for (let k = 0; k < N; k++) {
    const a = liftSrc(V, px[k], rowFloor / ah, pds[k]); A.push(a);
    const s = st[k];
    if (!s.ok) { off[k] = 0; yb[k] = 0; continue; }
    const feet = kS * (liftSrc(V, px[k], (s.rb + 1) / ah, s.pd)[1] - a[1]);
    let target;
    // feet below the frame: lift the visible body to its likely height, unless that is how the whole clip is framed,
    // then it stands on the floor (reads as the dancer standing in the floor haze, not a floating torso)
    if (s.cut) target = mostCut ? 0 : clamp(FIG_H - kS * heightSrc(s), 0, 1);
    else target = feet < .06 ? 0 : Math.min(1, feet);
    off[k] = target - feet; yb[k] = target;
  }
  const am = [0, 1, 2].map(i => pct(A.map(a => a[i]), .5));
  for (let k = 0; k < N; k++) raw.push([kS * (A[k][0] - am[0]), kS * (A[k][2] - am[2]) * .6]);
  const sig = Math.max(1, 6 / (V.step || 1));
  let dx = gaussSmooth(raw.map(r => r[0]), sig), dz = gaussSmooth(raw.map(r => r[1]), sig);
  const dpos = dx.map((x, k) => { const z = dz[k], l = Math.hypot(x, z), s = l > 1.1 ? 1.1 / l : 1; return [x * s, 0, z * s]; });
  const cutFrac = has.length ? has.filter(s => s.cut).length / has.length : 1;
  return (c.fit = {k: kS, A, off, yb, dpos, rowFloor, cutFrac, persons: has.length});
}

/** apply frame k's map to a source-space point (local, before dpos). */
export const toLocal = (fit, k, P, relief) => {
  const a = fit.A[k]; return [fit.k * (P[0] - a[0]), fit.k * (P[1] - a[1]) + fit.off[k], clamp(fit.k * relief * (P[2] - a[2]), -.35, .35)]; };

/** movement envelope per video frame (0 still .. ~1 strong move, up to 2): pose change first, frame difference second. */
export function motionEnv(V) {
  const c = box(V); if (c.env) return c.env;
  const st = poseStats(V), n = V.n, mo = V.motion || [];
  const p75m = Math.max(.5, pct(mo, .75)), dds = st.map(s => s.dd), p75d = Math.max(.012, pct(dds, .75));
  const m = new Float64Array(n);
  for (let f = 0; f < n; f++) { const k = Math.min(st.length - 1, Math.floor(f / V.step)); m[f] = Math.max(.5 * (mo[f] || 0) / p75m, dds[k] / p75d); }
  if (n > 1) m[0] = m[1];
  const s = gaussSmooth(Array.from(m), 1.2), lo = pct(s, .3), hi = pct(s, .92);
  return (c.env = Float64Array.from(s, x => clamp((x - lo) / Math.max(hi - lo, .35), 0, 2)));
}

/**
 * Slabs of the pose in dm frame k, in local stage space (feet-anchored, +z faces the source camera).
 * Returns {inst: Float32Array(8*count) = (xc,cy,cz,jN | a,b,t,rnd), count, H, w}. No seed jitter (applied in the shader).
 */
export function slabBase(V, k, style) {
  const c = box(V), key = k + '|' + style; if (c.slabs.has(key)) return c.slabs.get(key);
  const fit = stageFit(V), s = poseStats(V)[k], S = STYLES[style] || STYLES.bar, {aw, ah} = V, d = V.dm[k];
  if (!s || !s.ok) { const e = {inst: new Float32Array(0), count: 0, H: 0, w: 0}; c.slabs.set(key, e); return e; }
  const upr = fit.k * 2 * distOf(s.pd) / D0 / ah, pr = PITCH / upr;            // metres per mask row, rows per plate
  const N = clamp(Math.ceil((s.rb + 1 - s.y0) / pr), 1, 40);
  const m = (x, y) => { const y0 = clamp(Math.floor(y), 0, ah - 1), y1 = Math.min(ah - 1, y0 + 1), f = clamp(y - y0);
    return (d[(y0 * aw + x) * 4 + 1] * (1 - f) + d[(y1 * aw + x) * 4 + 1] * f) / 255; };
  const colM = 2 * (V.w / V.h) / aw;                                          // source units per column / (dist/D0)
  const mpc = fit.k * colM * distOf(s.pd) / D0, gapPx = Math.max(1, Math.round(.02 / mpc)), minW = Math.max(2, .03 / mpc);
  const bands = [];
  for (let j = 0; j < N; j++) {
    const yb0 = s.rb + 1 - (j + 1) * pr, runs = [];
    let x = s.x0, open = -1, gap = 0;
    const cov = new Float32Array(aw);
    for (let xx = Math.max(0, s.x0 - 1); xx <= Math.min(aw - 1, s.x1 + 1); xx++) cov[xx] = (m(xx, yb0 + .2 * pr) + m(xx, yb0 + .5 * pr) + m(xx, yb0 + .8 * pr)) / 3;
    for (x = Math.max(0, s.x0 - 1); x <= Math.min(aw - 1, s.x1 + 1) + 1; x++) {
      const on = x <= s.x1 + 1 && x < aw && cov[x] > .45;
      if (on) { if (open < 0) open = x; gap = 0; }
      else if (open >= 0) { gap++; if (gap > gapPx || x > s.x1) { runs.push([open, x - gap]); open = -1; gap = 0; } }
    }
    const kept = runs.filter(r => r[1] - r[0] + 1 >= minW).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, MAX_RUNS);
    const out = [];
    for (const [xa, xb] of kept) {
      const ds = []; for (let xx = xa; xx <= xb; xx++) { const y = clamp(Math.round(yb0 + .5 * pr), 0, ah - 1), p = (y * aw + xx) * 4; if (d[p + 1] > 127) ds.push(d[p]); }
      ds.sort((p, q) => p - q); const dz = ds.length ? ds[ds.length >> 1] / 255 : s.pd;
      const L = toLocal(fit, k, liftSrc(V, (xa + xb + 1) / 2 / aw, (yb0 + .5 * pr) / ah, dz), .5);
      const a = .5 * (xb - xa + 1) * colM * distOf(dz) / D0 * fit.k * S.over;
      out.push({x: L[0], y: fit.yb[k] + (j + .5) * PITCH, z: L[2], a, xa, xb});
    }
    bands.push(out);
  }
  // smooth z across x-overlapping runs of neighbouring bands (synthesised depth reads as one body)
  const zs = bands.map(b => b.map(r => r.z));
  for (let j = 0; j < N; j++) for (let i = 0; i < bands[j].length; i++) {
    const r = bands[j][i]; let s2 = zs[j][i] * .5, w = .5;
    for (const jj of [j - 1, j + 1]) { if (jj < 0 || jj >= N) continue; const o = bands[jj].findIndex(q => q.xa <= r.xb && q.xb >= r.xa); if (o >= 0) { s2 += zs[jj][o] * .25; w += .25; } }
    r.z = s2 / w;
  }
  const all = bands.flatMap((b, j) => b.map(r => ({...r, j})));
  const inst = new Float32Array(all.length * 8); let xmin = 1e9, xmax = -1e9;
  all.forEach((r, i) => {
    const b = clamp(.62 * r.a, .045, .14), t = S.t * PITCH;
    inst.set([r.x, r.y, r.z, N > 1 ? r.j / (N - 1) : 0, r.a, b, t, hsh(k * 7.13 + S.id * .71 + i * 1.37)], i * 8);
    xmin = Math.min(xmin, r.x - r.a); xmax = Math.max(xmax, r.x + r.a);
  });
  const res = {inst, count: all.length, H: fit.yb[k] + N * PITCH, w: all.length ? xmax - xmin : 0, bands: N};
  c.slabs.set(key, res); return res;
}
