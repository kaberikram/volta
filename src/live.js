// Live webcam mode. Camera frame -> person mask (MediaPipe, VIDEO mode) -> hybrid depth relief -> a growing analysis
// bundle that looks like the clip analysis -> live ghost director -> the normal renderer. Two clocks: the footage is
// camera time (always the newest frame), the edit is song time (Play / Pause / seek), so any point of the song can be
// tried on the live dancer and every setting re-plans in place.
// Depth is built every frame from cheap signals: the person mask's distance field (round body volume), pose-landmark
// z for the limbs (arms reaching to the camera come forward), apparent size (nearer when closer) and pixel brightness
// for surface detail; the room sits behind on a floor-like gradient.
import { loadVision, POSE_MODEL, SEG_MODEL } from './video.js';
import { poseStatsFrame, bindLive, descDist, distOf, liftSrc, FIG_H, slabBase } from './pose.js';
import { makePlan, ghostMaker, ghostFades, ghostMat, inRun } from './planner.js';
import { gridFor } from './audio.js';
import { clamp, smoothstep, pct, hsh, D0 } from './util.js';

export const LIVE_FPS = 30;
const AW = 266, RING = 64;
const LIMBS = [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [11, 12], [23, 24]];

/** per-frame analysis: mask + hybrid depth packed like the clip analysis (RGBA: R depth, G mask). */
export class LiveAnalyzer {
  constructor({w, h, segmenter = null, log = () => {}} = {}) {
    this.w = w; this.h = h; this.aw = AW; this.ah = Math.max(16, Math.round(AW * h / w)); this.log = log;
    this.inject = segmenter; this.mode = segmenter ? 'injected' : 'none';
    const n = this.aw * this.ah;
    this.lc = new OffscreenCanvas(this.aw, this.ah); this.lx = this.lc.getContext('2d', {willReadFrequently: true});
    this.raw = new Float32Array(n); this.mask = new Float32Array(n); this.dep = new Float32Array(n); this.pdep = new Float32Array(n);
    this.gray = new Float32Array(n); this.pgray = new Float32Array(n); this.dist = new Float32Array(n);
    this.first = true; this.prevDesc = null; this.hRef = 0; this.pdS = .66; this.lastTs = -1; this.skip = false; this.k = 0;
  }
  async init() {
    if (this.inject) return this.mode;
    try {
      const {V, fs} = await loadVision();
      try {
        this.pl = await V.PoseLandmarker.createFromOptions(fs, {baseOptions: {modelAssetPath: POSE_MODEL, delegate: 'GPU'}, runningMode: 'VIDEO', numPoses: 1,
          outputSegmentationMasks: true, minPoseDetectionConfidence: .4, minPosePresenceConfidence: .4, minTrackingConfidence: .4});
        this.mode = 'pose';
      } catch (e) {
        this.log('live: pose landmarker unavailable (' + e.message + '), trying the selfie segmenter');
        this.sg = await V.ImageSegmenter.createFromOptions(fs, {baseOptions: {modelAssetPath: SEG_MODEL, delegate: 'GPU'}, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true});
        this.mode = 'selfie';
      }
    } catch (e) { this.log('live: person detection unavailable (' + e.message + '), using brightness depth (dots only)'); this.mode = 'luma'; }
    return this.mode;
  }
  close() { try { this.pl?.close(); this.sg?.close(); } catch (e) {} this.pl = this.sg = null; this.mode = 'none'; }
  reset() { this.first = true; this.prevDesc = null; this.pdS = .66; }
  // nearest resample of a model mask into the analysis grid, optionally mirrored (the colour frame is drawn mirrored)
  fit(src, mw, mh, mirror, invert) {
    const {aw, ah} = this, out = this.raw;
    for (let y = 0; y < ah; y++) { const sy = Math.min(mh - 1, Math.floor(y * mh / ah)) * mw;
      for (let x = 0; x < aw; x++) { let sx = Math.min(mw - 1, Math.floor(x * mw / aw)); if (mirror) sx = mw - 1 - sx; const v = src[sy + sx]; out[y * aw + x] = invert ? 1 - v : v; } }
  }
  segment(src, ts, mirror) {
    if (this.inject) { const r = this.inject(src, ts) || {}; if (r.mask) this.raw.set(r.mask); else this.raw.fill(0); return r.lm || null; }
    if (this.mode === 'pose') {
      const r = this.pl.detectForVideo(src, ts); let lm = null;
      const m = r.segmentationMasks && r.segmentationMasks[0];
      if (m) { this.fit(m.getAsFloat32Array(), m.width, m.height, mirror, false); } else this.raw.fill(0);
      for (const q of r.segmentationMasks || []) q.close();
      if (r.landmarks && r.landmarks[0]) lm = r.landmarks[0].map(p => ({x: mirror ? 1 - p.x : p.x, y: p.y, z: p.z, v: p.visibility ?? 1}));
      return lm;
    }
    if (this.mode === 'selfie') {
      const r = this.sg.segmentForVideo(src, ts), m = r.confidenceMasks && r.confidenceMasks[0];
      if (m) this.fit(m.getAsFloat32Array(), m.width, m.height, mirror, true); else this.raw.fill(0);
      r.close?.(); return null;
    }
    this.raw.fill(1); return null;                 // luma mode: the whole frame, depth from brightness
  }
  /** colour: the (mirrored) colour canvas; modelSrc: what the model reads (the camera <video>); ts: increasing ms. */
  analyze(colour, modelSrc, ts, {mirror = true, dm = null} = {}) {
    const {aw, ah} = this, N = aw * ah, luma = this.mode === 'luma';
    this.lx.drawImage(colour, 0, 0, aw, ah);
    const img = this.lx.getImageData(0, 0, aw, ah).data, gray = this.gray;
    for (let p = 0; p < N; p++) gray[p] = .299 * img[p * 4] + .587 * img[p * 4 + 1] + .114 * img[p * 4 + 2];
    ts = Math.max(this.lastTs + 1, Math.round(ts)); this.lastTs = ts;
    let lm = this.lm || null;
    if (!(this.skip && (this.k++ & 1))) { lm = this.segment(modelSrc, ts, mirror); this.lm = lm; }
    // temporal agreement: smooth only where the new mask agrees with the last (no trails on fast moves)
    const m = this.mask, raw = this.raw;
    for (let p = 0; p < N; p++) m[p] = this.first || Math.abs(raw[p] - m[p]) >= .3 ? raw[p] : (raw[p] + m[p] * .5) / 1.5;
    // person extent, centroid, mean luma
    let n = 0, sx = 0, sy = 0, sl = 0, x0 = aw, x1 = -1, y0 = ah, y1 = -1;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const p = y * aw + x; if (m[p] > .5) { n++; sx += x; sy += y; sl += gray[p]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    const meanL = n ? sl / n : 128, cut = y1 >= ah - 2;
    // apparent size: shoulder-to-hip length when the landmarks are there (raised arms don't change it), else the bbox
    const L = (i) => lm && lm[i] && lm[i].v > .4 ? lm[i] : null, sh = L(11) && L(12), hp = L(23) && L(24);
    const hFrac = sh && hp ? 3.4 * Math.abs((lm[23].y + lm[24].y) / 2 - (lm[11].y + lm[12].y) / 2) : n ? (y1 - y0 + 1) / ah * (cut ? 1.25 : 1) : 0;
    // apparent size -> person depth (nearer when bigger than at calibration), smoothed
    if (n > 30 && this.hRef > 0 && !luma) { const ratio = clamp(this.hRef / Math.max(.05, hFrac), .55, 1.8), d = distOf(.66) * ratio;
      this.pdS += (clamp((2.4 - d / D0) / 1.8, .4, .9) - this.pdS) * .2; }
    const pd = this.pdS;
    // distance field of the mask (chamfer 3-4, two passes): the body gets round volume, centre nearer than the edge
    const dist = this.dist, INF = 1e6;
    for (let p = 0; p < N; p++) dist[p] = m[p] > .5 ? INF : 0;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const p = y * aw + x; if (!dist[p]) continue; let v = dist[p];
      if (x > 0) v = Math.min(v, dist[p - 1] + 3); if (y > 0) { v = Math.min(v, dist[p - aw] + 3); if (x > 0) v = Math.min(v, dist[p - aw - 1] + 4); if (x < aw - 1) v = Math.min(v, dist[p - aw + 1] + 4); }
      dist[p] = v; }
    for (let y = ah - 1; y >= 0; y--) for (let x = aw - 1; x >= 0; x--) { const p = y * aw + x; if (!dist[p]) continue; let v = dist[p];
      if (x < aw - 1) v = Math.min(v, dist[p + 1] + 3); if (y < ah - 1) { v = Math.min(v, dist[p + aw] + 3); if (x < aw - 1) v = Math.min(v, dist[p + aw + 1] + 4); if (x > 0) v = Math.min(v, dist[p + aw - 1] + 4); }
      dist[p] = v; }
    const R = Math.max(6, .22 * (x1 - x0 + 1) * 3), dep = this.dep;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) { const p = y * aw + x, L = gray[p] / 255;
      if (luma) dep[p] = .15 + .75 * L;                                  // the brightness heightmap (no person found)
      else if (m[p] > .5) dep[p] = pd - .08 + .16 * smoothstep(0, R, dist[p]) + .07 * (gray[p] - meanL) / 255;
      else dep[p] = .14 + .25 * y / ah + .04 * L; }
    // limbs from the landmarks: a joint closer to the camera than the hips pulls its limb forward
    if (lm && n > 30) {
      const rad = Math.max(3, .04 * ah), hz = ((lm[23]?.z ?? 0) + (lm[24]?.z ?? 0)) / 2;
      for (const [a, b] of LIMBS) { const A = lm[a], B = lm[b]; if (!A || !B || A.v < .4 || B.v < .4) continue;
        const ax = A.x * aw, ay = A.y * ah, bx = B.x * aw, by = B.y * ah, za = clamp(-(A.z - hz) * .35, -.1, .16), zb = clamp(-(B.z - hz) * .35, -.1, .16);
        const xa = Math.max(0, Math.floor(Math.min(ax, bx) - rad)), xb = Math.min(aw - 1, Math.ceil(Math.max(ax, bx) + rad)), ya = Math.max(0, Math.floor(Math.min(ay, by) - rad)), yb = Math.min(ah - 1, Math.ceil(Math.max(ay, by) + rad));
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const p = y * aw + x; if (m[p] <= .5) continue;
          const u = clamp(((x - ax) * dx + (y - ay) * dy) / l2), ex = ax + dx * u - x, ey = ay + dy * u - y, d2 = ex * ex + ey * ey;
          if (d2 < rad * rad) dep[p] += (za + (zb - za) * u) * (1 - d2 / (rad * rad)); } }
    }
    // temporal agreement on depth, pack
    const pdep = this.pdep, out = dm || new Uint8Array(N * 4);
    for (let p = 0; p < N; p++) {
      let d = clamp(dep[p]); if (!this.first && Math.abs(d - pdep[p]) < .08) d = (d + pdep[p] * .5) / 1.5; pdep[p] = d;
      out[p * 4] = d * 255; out[p * 4 + 1] = m[p] * 255; out[p * 4 + 2] = 0; out[p * 4 + 3] = 255; }
    let mo = 0; if (!this.first) for (let p = 0; p < N; p++) mo += Math.abs(gray[p] - this.pgray[p]); this.pgray.set(gray);
    const stats = poseStatsFrame(out, aw, ah, this.prevDesc); stats.dd = this.prevDesc ? descDist(stats.desc, this.prevDesc) : 0; this.prevDesc = stats.desc;
    this.first = false;
    return {dm: out, stats, piv: [n ? sx / n / aw : .5, n ? sy / n / ah : .55, stats.ok ? stats.pd : pd], area: n / N, motion: mo / N, hFrac, cut, lm};
  }
}

/** the live analysis bundle: same shape as analyzeVideo's, grown one frame at a time (fps 30, step 1). */
export class LiveBundle {
  constructor({w, h, aw, ah}) {
    Object.assign(this, {live: true, fps: LIVE_FPS, step: 1, n: 0, w, h, srcW: w, srcH: h, aw, ah, dur: 0, frames: [], dm: [], piv: [], area: [], motion: [],
      cut: [], dposS: [], stats: [], info: {depth: 'live hybrid relief', seg: ''}});
    this.fit = {k: 1, A: [], off: [], yb: [], dpos: [], rowFloor: ah - .5, cutFrac: 0, persons: 0};
    this.cache = bindLive(this, {stats: this.stats, fit: this.fit});
    this.am = null; this.calibrated = false; this.ema = [0, 0, 0]; this.emaS = [0, 0, 0]; this.pruned = 0;
  }
  /** fix the stage scale, floor row and stage centre from the first person frames (then they only drift slowly). */
  calibrate(samples) {
    const ok = samples.filter(r => r.stats.ok), {ah} = this, fit = this.fit;
    if (ok.length < 5) return false;
    const heightSrc = s => (s.rb - s.y0 + 1) / ah * 2 * distOf(s.pd) / D0, uncut = ok.filter(r => !r.stats.cut && r.stats.y0 > 1);
    const hs = (uncut.length >= 3 ? uncut : ok).map(r => heightSrc(r.stats));
    fit.k = FIG_H / Math.max(1e-3, pct(hs, .9) * (uncut.length >= 3 ? 1 : 1.25));
    fit.rowFloor = (uncut.length ? pct(uncut.map(r => r.stats.rb), .8) : ah - 1) + .5;
    fit.cutFrac = ok.filter(r => r.stats.cut).length / ok.length; this.mostCut = fit.cutFrac > .6;
    const As = ok.map(r => liftSrc(this, r.piv[0], fit.rowFloor / ah, r.stats.pd));
    this.am = [0, 1, 2].map(i => pct(As.map(a => a[i]), .5));
    this.hRef = pct(ok.map(r => r.hFrac), .5); this.calibrated = true; return true;
  }
  /** store camera frame fi (indices skipped since the last push point at the same frame). */
  push(fi, r) {
    if (!this.calibrated && r.stats.ok) { (this.pre = this.pre || []).push(r); if (this.pre.length >= 15) { this.calibrate(this.pre); this.pre = null; } }
    const fit = this.fit, s = r.stats, ah = this.ah, from = this.n;
    let A = fit.A[from - 1], off = fit.off[from - 1] || 0, yb = fit.yb[from - 1] || 0;
    if (s.ok) {
      A = liftSrc(this, r.piv[0], fit.rowFloor / ah, s.pd);
      const heightSrc = (s.rb - s.y0 + 1) / ah * 2 * distOf(s.pd) / D0, feet = fit.k * (liftSrc(this, r.piv[0], (s.rb + 1) / ah, s.pd)[1] - A[1]);
      const target = s.cut ? (this.mostCut ? 0 : clamp(FIG_H - fit.k * heightSrc, 0, 1)) : feet < .06 ? 0 : Math.min(1, feet);
      off = target - feet; yb = target;
      if (this.calibrated && !s.cut && s.y0 > 1) fit.k += (FIG_H / Math.max(1e-3, heightSrc) - fit.k) / 300;     // very slow drift (~10 s)
    }
    if (!A) A = liftSrc(this, .5, fit.rowFloor / ah, .66);
    const am = this.am || A, raw = [fit.k * (A[0] - am[0]), 0, fit.k * (A[2] - am[2]) * .6], l = Math.hypot(raw[0], raw[2]), c = l > 1.1 ? 1.1 / l : 1;
    for (const i of [0, 2]) { this.ema[i] += (raw[i] * c - this.ema[i]) * .3; this.emaS[i] += (this.ema[i] - this.emaS[i]) * .07; }
    for (let i = from; i <= fi; i++) {
      this.dm[i] = r.dm; this.piv[i] = r.piv; this.area[i] = r.area; this.motion[i] = r.motion; this.stats[i] = s; this.cut[i] = !!(s.ok && s.cut);
      fit.A[i] = A; fit.off[i] = off; fit.yb[i] = yb; fit.dpos[i] = [this.ema[0], 0, this.ema[2]]; this.dposS[i] = [this.emaS[0], 0, this.emaS[2]];
    }
    for (let i = Math.max(0, from - RING - 8); i < fi - RING; i++) this.dm[i] = undefined;     // the colour frames live in the renderer's GPU pool
    this.n = fi + 1; this.dur = this.n / this.fps;
  }
  /** a long session: drop the heavy per-frame data (stats, slab cache) of frames older than keepFrom (the small
   *  arrays stay: a few MB an hour). Frames the renderer holds (a freeze snapshot) are kept. Printed ghosts keep their own copies. */
  prune(keepFrom, pinned = new Set()) {
    if (keepFrom <= this.pruned) return;
    for (let i = this.pruned; i < keepFrom; i++) if (!pinned.has(i)) { this.stats[i] = undefined; this.dm[i] = undefined; }
    for (const k of this.cache.slabs.keys()) if (parseInt(k, 10) < keepFrom) this.cache.slabs.delete(k);
    this.pruned = keepFrom;
  }
}

const ENV_W = 300, ENV_KEEP = 600, CAPS = {drop: 4, half: 4, spark: 2, quarter: 5, accel: 6, freeze: 2, echo: 4, end: 1};
/** spawns live ghosts on the song's beats and the dancer's moves, and integrates the orbit as the song plays.
 *  It owns the ring for the whole session (ghosts, orbit, phase), whatever the scene: a stage plan points at it, a dots
 *  plan leaves it alone, and a seek re-performs from there (later ghosts are dropped, the orbit rewinds). */
export class LiveDirector {
  constructor(V, stage, {seed = 1, dur}) {
    this.V = V; this.stage = stage; this.dur = dur; this.seed0 = seed;
    this.ghosts = []; this.orbit = null; this.phi0 = 0;
    this.env = []; this.raw = []; this.base = 0; this.ef = 0; this.cv = 1; this.av = 0; this.amax = 1e-6;
    this.j = -1; this.lastDesc = null; this.lastT = -1e9; this.perBar = new Map();
  }
  /** a new plan (settings changed): rebuild what comes from the plan, keep the ring and every integrator */
  setPlan(plan) {
    const V = this.V, {P, beats} = plan; this.plan = plan;
    if (!this.orbit) {                // the ring state, from the first plan with a stage (or the seed when it starts on dots)
      const M = Math.ceil(this.dur * LIVE_FPS) + 2;
      this.orbit = plan.orbit && plan.orbit.live ? plan.orbit : {hz: LIVE_FPS, calm: new Float64Array(M), acc: new Float64Array(M), dir: hsh(this.seed0 * 31.7) < .5 ? -1 : 1, n: 0, live: true};
      this.phi0 = plan.live ? plan.live.phi0 : hsh(this.seed0 * 17.3) * 6.283;
    }
    this.bt = b => { const k = Math.floor(b), f = b - k; const t0 = k < beats.length ? beats[k] : beats[beats.length - 1] + (k - beats.length + 1) * P; return t0 + f * P; };
    this.down = new Set(plan.barStarts.map(t => Math.round(t * 1e4))); this.runDown = plan.runs.map(r => plan.barStarts[r.b0] ?? r.t0);
    this.endT = plan.stages.length && plan.stages[plan.stages.length - 1] === 'P' ? plan.barStarts[plan.barStarts.length - 1] : null;
    this.maker = null;
    if (plan.live) {
      plan.orbit = this.orbit; plan.ghosts = this.ghosts; plan.live.phi0 = this.phi0;
      this.maker = ghostMaker({seed: plan.seed, P, sp: plan.live.sp, phi0: this.phi0, video: V, fit: V.fit, st: V.stats, inRunT: t => inRun(plan, t)});
      for (const g of this.ghosts) { g.mat = ghostMat(g, plan.live.sp); g.hidden = !g.seeded && inRun(plan, g.t) < 0; }
      ghostFades(this.ghosts, this.endT, P, plan.dur);
    }
  }
  stillT(t) { const fz = this.plan.freeze; return (fz && t >= fz.t0 && t < fz.t1) || this.plan.holds.some(h => t >= h.t0 && t < h.t1); }
  /** after V.push: movement envelope for the new camera frames (online normalisation over the last ~10 s) */
  frame(fi) {
    const V = this.V;
    for (let i = this.ef; i <= fi; i++) {
      const s = V.stats[i] || {dd: 0}; this.amax = Math.max(this.amax * .9995, V.area[i] || 0);
      const mo = this.raw.slice(-ENV_W), m75 = Math.max(.5, pct(mo.map(x => x[0]), .75)), d75 = Math.max(.012, pct(mo.map(x => x[1]), .75));
      this.raw.push([V.motion[i] || 0, s.dd || 0]);
      const m = Math.max(.5 * (V.motion[i] || 0) / m75, (s.dd || 0) / d75), prev = this.env.length ? this.env[this.env.length - 1].s : m, sm = prev + (m - prev) * .5;
      const hist = this.env.slice(-ENV_W).map(e => e.s), lo = hist.length > 20 ? pct(hist, .3) : 0, hi = hist.length > 20 ? pct(hist, .92) : 1;
      this.env.push({s: sm, e: clamp((sm - lo) / Math.max(hi - lo, .35), 0, 2)});
    }
    this.ef = fi + 1;
    const drop = this.env.length - ENV_KEEP; if (drop >= 60) { this.env.splice(0, drop); this.raw.splice(0, drop); this.base += drop; }
  }
  envAt(i) { const e = this.env[clamp(i - this.base, 0, this.env.length - 1)]; return e ? e.e : 0; }
  /** song time t, newest camera frame ci: orbit up to t, a ghost candidate for every 1/8 grid point passed */
  update(t, ci) {
    const plan = this.plan, o = this.orbit, k = Math.min(o.calm.length - 1, Math.floor(t * o.hz));
    if (k >= o.n) {
      const e0 = this.envAt(ci);
      for (let i = o.n; i <= k; i++) {
        const tgt = 1 - smoothstep(.08, .4, this.stillT(i / o.hz) ? 0 : e0);
        if (i) { const tau = tgt > this.cv ? .7 : .1; this.cv += (tgt - this.cv) * (1 - Math.exp(-1 / o.hz / tau)); this.av += this.cv * this.cv / o.hz; }
        o.calm[i] = this.cv; o.acc[i] = this.av;
      }
      o.n = k + 1;
    }
    // the grid cursor always moves (so switching dots -> plates never replays a backlog); stale points (a stall) are skipped
    for (;;) { const j = this.j + 1, te = this.bt(j / 2); if (te > t) break; this.j = j;
      if (te >= 0 && t - te < .5 && this.maker && plan.runs.length) this.candidate(j, te, ci); }
  }
  /** jump the song to t: re-perform from there. Later ghosts go, the orbit rewinds (or extrapolates forward), no backlog. */
  seek(t) {
    const o = this.orbit, k = clamp(Math.floor(t * o.hz), 0, o.calm.length - 1);
    if (k < o.n) { o.n = k + 1; this.cv = o.calm[k]; this.av = o.acc[k]; }
    else { for (let i = o.n; i <= k; i++) { o.calm[i] = this.cv; o.acc[i] = i ? o.acc[i - 1] + this.cv * this.cv / o.hz : 0; } o.n = k + 1; this.av = o.acc[k]; }
    const m = this.ghosts.findIndex(g => g.t > t + 1e-9); if (m >= 0) this.ghosts.length = m;
    let j = -1; while (this.bt((j + 1) / 2) <= t) j++; this.j = j;
    this.perBar = new Map(); for (const g of this.ghosts) if (g.bar != null) this.perBar.set(g.bar, (this.perBar.get(g.bar) || 0) + 1);
    const lg = this.ghosts[this.ghosts.length - 1]; this.lastT = lg ? lg.t : -1e9; this.lastDesc = lg ? lg.desc || null : null;
    if (this.plan.live) ghostFades(this.ghosts, this.endT, this.plan.P, this.plan.dur);
    this.stage.restoreLive(this.ghosts);
  }
  candidate(j, te, f) {
    const plan = this.plan, V = this.V, P = plan.P, k = j / 2, isBeat = j % 2 === 0, down = isBeat && this.down.has(Math.round(te * 1e4));
    const beat = isBeat && ((plan.kick[k] ?? .6) >= .8 || down) ? 1 : 0, forced = this.runDown.some(r => Math.abs(r - te) < 1e-6);
    // a move: an envelope peak in the last ~100 ms (camera frames) that rose quickly
    let move = 0, mv = 0;
    for (let q = Math.max(6, f - 3); q <= f; q++) { const e = this.envAt(q); if (e < .8) continue; let lo = 9; for (let r = q - 6; r < q; r++) lo = Math.min(lo, this.envAt(r)); if (e - lo >= .35) { move = 1; mv = Math.max(mv, e); } }
    if (!beat && !move && !forced) return;
    let b = -1; for (let i = 0; i < plan.barStarts.length; i++) if (plan.barStarts[i] <= te + 1e-6) b = i;
    const inP = inRun(plan, te) >= 0;
    const cap = inP ? (b >= 0 ? CAPS[plan.roles[b]] || 3 : 1) : (mv >= .9 ? 2 : 1), gap = inP ? Math.max(P / 2, .2) : 2 * P, used = this.perBar.get(b) || 0;
    if (!forced && (used >= cap || te - this.lastT < gap - 1e-6)) return;
    // best pose of the last few camera frames
    let best = -1, bs = -1e9;
    for (let q = Math.max(0, f - 3); q <= f; q++) { const s = V.stats[q]; if (!s || !s.ok || (V.area[q] || 0) < .01) continue;
      const sc = .6 * V.area[q] / this.amax + .4 * s.desc[s.desc.length - 1] - .3 * Math.min(1, this.envAt(q) / 2); if (sc > bs) { bs = sc; best = q; } }
    if (best < 0 || !V.dm[best]) return;
    const desc = V.stats[best].desc, novel = !this.lastDesc || descDist(desc, this.lastDesc) >= .08;
    if (!novel && !forced && !(down && te - this.lastT >= 4 * P)) return;
    const g = this.maker(this.ghosts, {t: te, beat, move, down: down ? 1 : 0, forced}, best, false), sb = slabBase(V, g.di, g.style);
    Object.assign(g, {inst: sb.inst, cnt: sb.count, cut: !!V.cut[best], bar: b, desc});     // a printed ghost keeps its own data
    this.stage.addGhostLive(g, sb.inst, sb.count);
    ghostFades(this.ghosts, this.endT, P, plan.dur);
    this.lastDesc = desc; this.lastT = te; this.perBar.set(b, used + 1);
  }
}

/** quiet bars of the song play the effect a little softer (and the fade lane shows the song's shape). */
export function liveFx(A) {
  const dur = A.duration, bars = A.bars || [], es = bars.map(b => b.e), lo = pct(es, .35), keys = [{t: 0, v: 1}];
  for (const b of bars) { const v = b.e < lo ? .75 : 1; if (b.t > .05 && b.t < dur - .05 && Math.abs(keys[keys.length - 1].v - v) > 1e-6) keys.push({t: b.t, v}); }
  keys.push({t: dur, v: 1}); return keys;
}
/** the live plan: the whole song, plates runs and shots from the music alone. */
export function livePlan(A, V, opts) {
  const db = A.bars && A.bars.length ? A.bars[0].t : null, grid = gridFor(A, 0, A.duration, db);
  return makePlan(grid, A.duration, V, {...opts, live: true});
}

/** the live pipeline without the camera and audio plumbing (what the tests drive): camera frames in, a song time out.
 *  Footage runs on camera time (never rewinds); the edit runs on song time (play, pause, seek). */
export class LiveCore {
  constructor(R, {w, h, aw, ah, mode = 'pose', A, opts, fx}) {
    this.R = R; this.mode = mode; this.A = A; this.dur = A.duration;
    this.V = new LiveBundle({w, h, aw, ah}); this.V.info.seg = mode;
    this.dir = new LiveDirector(this.V, R.stage, {seed: opts.seed || 1, dur: this.dur});
    this.dirty = true; this.fresh = false;
    this.replan(opts, fx);
  }
  /** settings changed: a new plan in place (the ring, the camera frames and every integrator carry over) */
  replan(opts, fx) {
    const luma = this.mode === 'luma', plan = livePlan(this.A, this.V, {...opts, scene: luma ? 'dots' : opts.scene});
    if (luma && opts.scene !== 'dots') plan.sceneNote = 'plates need person detection, showing dots';
    plan.fx = (fx || [{t: 0, v: 1}, {t: this.dur, v: 1}]).map(k => ({t: k.t, v: k.v}));
    this.dir.setPlan(plan); this.plan = plan;
    this.R.setData(this.V, plan, LIVE_FPS);
    this.dirty = true; return plan;
  }
  /** an analysed camera frame (ci: camera frame index, increasing) */
  pushFrame(ci, src, r) {
    const V = this.V, from = V.n; V.push(ci, r); this.R.pushLiveFrame(ci, src, r.dm, from); this.dir.frame(ci);
    if (ci - V.pruned > 960) V.prune(ci - 900, this.R.livePinned());
    this.fresh = true;
  }
  seek(t) { this.dir.seek(clamp(t, 0, this.dur)); this.R.releaseLivePins(); this.dirty = true; }
  /** draw song time t with the newest camera frame */
  async render(t) {
    const V = this.V; if (!V.n) return null;
    this.dir.update(t, V.n - 1); this.dirty = this.fresh = false;
    return this.R.renderAt(Math.floor(t * LIVE_FPS + 1e-6) / LIVE_FPS);
  }
}

/** webcam + song transport. The camera is always live; Play / Pause / seek move the song, and the edit at that point
 *  is applied to the live dancer. Settings re-plan in place (replan). */
export class LiveSession {
  constructor(renderer, ui = {}) { this.R = renderer; this.ui = ui; this.log = ui.log || (() => {}); this.state = 'idle'; this.playing = false; this.renders = 0; }
  get plan() { return this.core ? this.core.plan : null; }
  get V() { return this.core ? this.core.V : null; }
  async openCamera(videoEl, deviceId) {
    this.closeCamera();
    const c = {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}, ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: 'user'})};
    this.stream = await navigator.mediaDevices.getUserMedia({video: c, audio: false});
    videoEl.srcObject = this.stream; videoEl.muted = true; videoEl.playsInline = true; await videoEl.play();
    this.video = videoEl; const st = this.stream.getVideoTracks()[0].getSettings();
    const vw = st.width || videoEl.videoWidth || 1280, vh = st.height || videoEl.videoHeight || 720;
    this.w = 640; this.h = Math.round(640 * vh / vw / 2) * 2;
    return {w: vw, h: vh, label: this.stream.getVideoTracks()[0].label};
  }
  closeCamera() { if (this.stream) for (const t of this.stream.getTracks()) t.stop(); this.stream = null; if (this.video) this.video.srcObject = null; }
  async loadModels(segmenter) {
    if (!this.an || this.an.w !== this.w || this.an.h !== this.h) { this.an?.close(); this.an = new LiveAnalyzer({w: this.w, h: this.h, segmenter, log: this.log}); this.mode = await this.an.init(); }
    return this.mode;
  }
  /** go live, paused at song time `at`; the song starts once the stage is calibrated (or after 1.5 s) */
  async start({songBuf, A, opts, fx, at = 0}) {
    await this.stop();
    const an = this.an; an.reset();
    const core = this.core = new LiveCore(this.R, {w: this.w, h: this.h, aw: an.aw, ah: an.ah, mode: this.mode, A, opts, fx});
    if (this.mode !== 'luma') { try { this.R.stage.ensure(); } catch (e) {} }          // compile the stage now, not mid-song
    this.dur = A.duration; this.songBuf = songBuf; this.off = clamp(at, 0, this.dur); this.lastT = this.off; core.seek(this.off);
    this.colour = new OffscreenCanvas(this.w, this.h); this.cx = this.colour.getContext('2d');
    this.ac = new AudioContext(); await this.ac.resume();
    this.cap0 = null; this.lastCi = -1; this.frameMs = []; this.rms = []; this.degraded = 0; this.renders = 0; this.lastN = -1;
    this.autoT = performance.now(); this.autoPlay = true; this.playing = false; this.R.hold = true;
    this.state = 'live'; this.ui.onState?.('live');
    this.vis = () => { if (document.hidden) this.pause(); };
    document.addEventListener('visibilitychange', this.vis);
    const onFrame = (now, md) => { if (this.state === 'idle') return; try { this.capture(md && md.captureTime ? md.captureTime : (md && md.expectedDisplayTime) || now); } catch (e) { this.log('live: ' + e.message); } this.vcb = this.video.requestVideoFrameCallback(onFrame); };
    this.vcb = this.video.requestVideoFrameCallback(onFrame);
    const tick = () => { if (this.state === 'idle') return; this.loop().catch(e => this.log('live render: ' + e.message)).finally(() => { if (this.state !== 'idle') this.raf = requestAnimationFrame(tick); }); };
    this.raf = requestAnimationFrame(tick);
    return core.plan;
  }
  replan(opts, fx) { if (this.state === 'idle' || !this.core) return null; return this.core.replan(opts, fx); }
  /** the song position the performer hears */
  heard(perfMs) {
    const ac = this.ac; let c;
    if (ac.getOutputTimestamp) { const o = ac.getOutputTimestamp(); c = o.contextTime > 0 ? o.contextTime + (perfMs - o.performanceTime) / 1000 : ac.currentTime; }
    else c = ac.currentTime - (ac.outputLatency || 0) + (perfMs - performance.now()) / 1000;
    return c - this.t0;
  }
  time() {
    if (!this.playing) return this.off;
    this.lastT = clamp(Math.max(this.lastT, this.heard(performance.now())), this.off, this.dur); return this.lastT;
  }
  play() {
    if (this.state !== 'live' || this.playing) return;
    this.autoPlay = false; if (this.off >= this.dur - .05) this.seek(0);
    const ac = this.ac, src = ac.createBufferSource(); src.buffer = this.songBuf; src.connect(ac.destination);
    const when = ac.currentTime + .03; src.start(when, this.off); this.t0 = when - this.off;
    src.onended = () => { if (src !== this.src || !this.playing) return; this.src = null; this.playing = false; this.off = this.dur; this.R.hold = true; this.core.dirty = true; this.ui.onState?.('paused'); };
    this.src = src; this.playing = true; this.lastT = this.off; this.R.hold = false; this.core.dirty = true; this.ui.onState?.('playing');
  }
  pause() {
    this.autoPlay = false; if (!this.playing) return;
    this.off = this.time(); this.playing = false; this.killSrc(); this.R.hold = true; this.core.dirty = true; this.ui.onState?.('paused');
  }
  /** move the song to t (keeps playing if it was) */
  seek(t) {
    if (this.state !== 'live' || !this.core) return;
    const was = this.playing; if (was) { this.killSrc(); this.playing = false; }
    this.off = this.lastT = clamp(t, 0, this.dur); this.core.seek(this.off);
    if (was) this.play();
  }
  killSrc() { const s = this.src; this.src = null; if (s) { s.onended = null; try { s.stop(); } catch (e) {} } }
  capture(capMs) {
    if (this.cap0 == null) this.cap0 = capMs;
    let ci = Math.max(this.lastCi + 1, Math.floor((capMs - this.cap0) * LIVE_FPS / 1000));
    if (ci - this.lastCi > 15) { ci = this.lastCi + 1; this.cap0 = capMs - ci * 1000 / LIVE_FPS; }     // back from a hidden tab: no backlog
    this.cx.setTransform(-1, 0, 0, 1, this.w, 0); this.cx.drawImage(this.video, 0, 0, this.w, this.h); this.cx.setTransform(1, 0, 0, 1, 0, 0);
    const t1 = performance.now(), r = this.an.analyze(this.colour, this.video, capMs, {mirror: true});
    this.frameMs.push(performance.now() - t1); if (this.frameMs.length > 90) this.frameMs.shift();
    this.core.pushFrame(ci, this.colour, r); this.lastCi = ci;
    if (!this.an.hRef && this.core.V.hRef) this.an.hRef = this.core.V.hRef;
  }
  async loop() {
    const core = this.core; if (!core.V.n) return;
    if (this.autoPlay && (core.V.calibrated || performance.now() - this.autoT > 1500)) this.play();
    const t = this.time(), n = Math.floor(t * LIVE_FPS + 1e-6);
    if (n === this.lastN && !core.fresh && !core.dirty) return;
    const t0 = performance.now(); await core.render(t); this.lastN = n; this.renders++;
    this.ui.onTime?.(t, this.dur);
    this.autoDegrade(performance.now() - t0);
  }
  /** keep 30 fps: drop MSAA and the dancer's reflection, then segment every other frame */
  autoDegrade(renderMs) {
    this.rms.push(renderMs); if (this.rms.length < 45) return;
    const avg = this.rms.reduce((a, b) => a + b, 0) / this.rms.length + this.frameMs.reduce((a, b) => a + b, 0) / Math.max(1, this.frameMs.length); this.rms = [];
    if (avg < 30 || this.degraded >= 2) return;
    this.degraded++;
    if (this.degraded === 1) { this.R.stageQ = {...(this.R.stageQ || {}), samples: 0, mirrorDancer: 0}; if (this.R.stage.ok) { this.R.stage.free(); this.R.stage.resize(this.R.W, this.R.H); } this.log(`live: ${avg.toFixed(0)} ms/frame, lighter stage (no MSAA, no dancer reflection)`); }
    else { this.an.skip = true; this.log(`live: ${avg.toFixed(0)} ms/frame, person detection on every other frame`); }
  }
  /** leave live (the camera preview stays on) */
  async stop() {
    if (this.state === 'idle') return; this.state = 'idle';
    cancelAnimationFrame(this.raf); if (this.video && this.vcb != null) this.video.cancelVideoFrameCallback?.(this.vcb);
    document.removeEventListener('visibilitychange', this.vis);
    this.killSrc(); this.playing = false; this.R.hold = false; this.R.releaseLivePins?.();
    try { await this.ac?.close(); } catch (e) {}
    this.ac = null; this.ui.onState?.('idle');
  }
}
