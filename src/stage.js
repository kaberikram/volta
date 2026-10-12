// Plates stage: a synthetic dark stage (fog, reflective grid floor, red lasers, cyan/white spots, light pillars, hoop)
// where every strong beat or move freezes the dancer's pose into a stack of horizontal plates that stays on stage,
// glides out to a ring and orbits while the dancer is still. Everything is a pure function of the frame index n.
import { QV, SKY_FS, FLOOR_VS, FLOOR_FS, SLAB_VS, SLAB_FS, BEAM_VS, BEAM_FS, BRIGHT_HDR, COMP_HDR } from './shaders.js';
import { ghostsAt, orbitAt, effectAt } from './planner.js';
import { stageFit, slabBase, poseStats, STYLES } from './pose.js';
import { clamp, hex, hsh, smoothstep, easeOut, angLerp, gaussSmooth, DEG, FOV0, add, sub, scl, nrm, cross, dot, lookAt, persp, mm, rotY, rotAxis, elastic, snap } from './util.js';

export const MATS = {
  redGloss:   {alb: '#a3100c', emi: '#ff2a17', ek: .9, spec: '#ffd6cf', gloss: 90, rim: '#ff6a5a', rk: .5, metal: 0},
  whiteHot:   {alb: '#e8e6e1', emi: '#fff4e6', ek: .55, spec: '#ffffff', gloss: 40, rim: '#cff6ff', rk: .4, metal: 0},
  graphite:   {alb: '#2b373b', emi: '#0f3540', ek: .3, spec: '#a8e4ee', gloss: 60, rim: '#5fdcff', rk: .55, metal: 1},
  tealStone:  {alb: '#4a6066', emi: '#000000', ek: 0, spec: '#d9f3f7', gloss: 30, rim: '#5fdcff', rk: .35, metal: 0},
  gold:       {alb: '#b07a10', emi: '#ffb21f', ek: .8, spec: '#ffe2a0', gloss: 70, rim: '#ffd27a', rk: .4, metal: 1},
  redGlass:   {alb: '#ff2a1f', emi: '#ff2a1f', ek: .9, spec: '#ffffff', gloss: 80, rim: '#ff6a5a', rk: .5, metal: 0, glass: 1, body: .12},
  smokeGlass: {alb: '#9fdfff', emi: '#9fdfff', ek: .5, spec: '#ffffff', gloss: 80, rim: '#cff6ff', rk: .5, metal: 0, glass: 1, body: .12},
  cyanGlass:  {alb: '#00c6ee', emi: '#00c6ee', ek: .8, spec: '#ffffff', gloss: 80, rim: '#9fe8ff', rk: .5, metal: 0, glass: 1, body: .12},
};
const C = {cyan: hex('#47d4ff'), white: hex('#eaf6ff'), red: hex('#ff2414'), pillarW: hex('#e8f6ff'), hoop: hex('#dffbff'), key: hex('#9fdcea')};
const MAXB = 320, HOOP_SEG = 48, HOOP_H = [.04, .95, 1.95];
const STAGE_PTS = [[-2, 1, 0], [2, 1, 0], [0, 1, -2], [0, 0, 2], [3, 2, 3]];
const diagM = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// column-major affine helpers
const mT = v => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
const mRY = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const mRX = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const mS = v => [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1];

export class Stage {
  constructor(r) {
    this.r = r; this.gl = r.gl; this.ok = false; this.tried = false; this.W = 0; this.H = 0; this.need = false;
    let ren = String(this.gl.getParameter(this.gl.RENDERER) || '');
    try { const x = this.gl.getExtension('WEBGL_debug_renderer_info'); if (x) ren += ' ' + this.gl.getParameter(x.UNMASKED_RENDERER_WEBGL); } catch (e) {}
    this.soft = /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(ren);
    this.tier = this.soft ? {samples: 0, segs: 12, mirrorDancer: 0, nSh: 6} : {samples: 4, segs: 24, mirrorDancer: 1, nSh: 16};
  }
  get q() { return {...this.tier, ...(this.r.stageQ || {})}; }
  /** lazy, fail-safe GL setup (programs, slab mesh, beam buffer). */
  ensure() {
    if (this.tried) return this.ok; this.tried = true;
    const gl = this.gl, P = this.r.prog;
    try {
      this.float = !!gl.getExtension('EXT_color_buffer_float');
      this.PS = P(QV, SKY_FS); this.PF = P(FLOOR_VS, FLOOR_FS); this.PG = P(SLAB_VS, SLAB_FS); this.PBm = P(BEAM_VS, BEAM_FS);
      this.PH = P(QV, BRIGHT_HDR); this.PCH = P(QV, COMP_HDR);
      this.buildMesh(this.q.segs);
      this.vaoBeam = gl.createVertexArray(); gl.bindVertexArray(this.vaoBeam);
      this.bBeam = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bBeam); gl.bufferData(gl.ARRAY_BUFFER, MAXB * 64, gl.DYNAMIC_DRAW);
      for (let i = 0; i < 4; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 64, i * 16); gl.vertexAttribDivisor(i, 1); }
      this.beams = new Float32Array(MAXB * 16);
      gl.bindVertexArray(this.r.vao0);
      this.ok = true;
    } catch (e) { this.err = e.message; this.ok = false; console.warn('[dotfx] plates stage disabled:', e.message); gl.bindVertexArray(this.r.vao0); }
    return this.ok;
  }
  buildMesh(segs) {
    const gl = this.gl, v = [], idx = [];
    for (let r = 0; r < 5; r++) for (let s = 0; s < segs; s++) v.push(s / segs * Math.PI * 2, r);
    v.push(0, -1, 0, 5);
    const B = segs * 5, T = B + 1;
    for (let r = 0; r < 4; r++) for (let s = 0; s < segs; s++) { const a = r * segs + s, b = r * segs + (s + 1) % segs, c = a + segs, d = b + segs; idx.push(a, b, d, a, d, c); }
    for (let s = 0; s < segs; s++) { idx.push(B, (s + 1) % segs, s); idx.push(T, 4 * segs + s, 4 * segs + (s + 1) % segs); }
    this.nIdx = idx.length;
    this.vaoSlab = gl.createVertexArray(); gl.bindVertexArray(this.vaoSlab);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    this.bInst = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bInst); gl.bufferData(gl.ARRAY_BUFFER, 32, gl.STATIC_DRAW);
    for (const i of [1, 2]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, (i - 1) * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(this.r.vao0);
  }
  free() {
    const gl = this.gl;
    for (const k of ['tStage', 'tSA', 'tSB']) if (this[k]) { gl.deleteTexture(this[k]); this[k] = null; }
    for (const k of ['fMS', 'fStage', 'fSA', 'fSB']) if (this[k]) { gl.deleteFramebuffer(this[k]); this[k] = null; }
    for (const k of ['rbC', 'rbD']) if (this[k]) { gl.deleteRenderbuffer(this[k]); this[k] = null; }
    this.W = this.H = 0;
  }
  release() { if (this.ok) this.free(); }
  /** HDR render targets: MSAA colour+depth (resolved into tStage) when available, else tStage + depth directly. */
  resize(W, H) {
    if (!this.ok || (W === this.W && H === this.H && this.tStage)) return;
    const gl = this.gl;
    const tryAlloc = (float, samples) => {
      this.free();
      const fmt = float ? gl.RGBA16F : gl.RGBA8, typ = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      const tex = (w, h) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, typ, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
      const fb = t => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };
      const complete = () => gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      let ok = true;
      this.tStage = tex(W, H); this.fStage = fb(this.tStage);
      if (samples > 0) {
        ok = complete();
        this.rbC = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, W, H);
        this.rbD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbD); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
        this.fMS = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fMS);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rbC); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbD);
        ok = ok && complete();
      } else {
        this.rbD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbD); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbD); ok = complete();
      }
      this.BW = Math.max(8, W >> 2); this.BH = Math.max(8, H >> 2);
      this.tSA = tex(this.BW, this.BH); this.fSA = fb(this.tSA); ok = ok && complete();
      this.tSB = tex(this.BW, this.BH); this.fSB = fb(this.tSB); ok = ok && complete();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      if (gl.getError() !== gl.NO_ERROR) ok = false;
      if (ok) { this.W = W; this.H = H; this.samples = samples; this.hdr = float; }
      return ok;
    };
    const maxS = f => { try { const a = gl.getInternalformatParameter(gl.RENDERBUFFER, f, gl.SAMPLES); return a && a.length ? Math.max(...a) : 0; } catch (e) { return 0; } };
    const opts = [];
    if (this.float) { const s = Math.min(this.q.samples, maxS(gl.RGBA16F), maxS(gl.DEPTH_COMPONENT24)); if (s > 0) opts.push([true, s]); opts.push([true, 0]); }
    { const s = Math.min(this.q.samples, maxS(gl.RGBA8), maxS(gl.DEPTH_COMPONENT24)); if (s > 0) opts.push([false, s]); opts.push([false, 0]); }
    for (const [f, s] of opts) if (tryAlloc(f, s)) return;
    this.free(); this.ok = false; this.err = 'no usable render target'; console.warn('[dotfx] plates stage disabled: no usable render target');
  }
  /** per plan: pack every ghost's slabs once, precompute the dancer track. */
  build(V, plan, fps) {
    this.V = V; this.plan = plan; this.fps = fps;
    this.need = !!(plan.runs && plan.runs.length && V && V.dm);
    if (!this.need) { this.release(); return; }
    if (!this.ensure()) return;
    const gl = this.gl, fit = this.fit = stageFit(V), segs = new Map(), parts = []; let off = 0;
    this.cut = poseStats(V).map(s => !!(s.ok && s.cut));
    this.gseg = plan.ghosts.map(g => {
      const key = g.di + '|' + g.style;
      if (!segs.has(key)) { const sb = slabBase(V, g.di, g.style); segs.set(key, {off, cnt: sb.count}); parts.push(sb.inst); off += sb.count; }
      return segs.get(key);
    });
    const all = new Float32Array(Math.max(8, off * 8)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bInst); gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const nF = Math.ceil(plan.dur * fps) + 2, di = n => Math.min(fit.dpos.length - 1, Math.floor(this.r.footageF(clamp(n, 0, nF)) / V.step));
    const xs = [], zs = []; for (let n = 0; n < nF; n++) { const p = fit.dpos[di(n)]; xs.push(p[0]); zs.push(p[2]); }
    const sx = gaussSmooth(xs, .3 * fps), sz = gaussSmooth(zs, .3 * fps);
    this.dposT = sx.map((x, i) => [x, 0, sz[i]]);
    const ef = t => Math.max(0, Math.floor(t * fps + 1e-6));
    const runEnd = t => { const r = plan.runs.find(r => t >= r.t0 - 1e-6 && t < r.t1); return r ? r.t1 : plan.dur; };
    this.shots = plan.shots.map((s, i) => { const nx = plan.shots[i + 1], t1 = Math.min(nx ? nx.t : plan.dur, runEnd(s.t)); return {...s, f: ef(s.t), t1: Math.max(s.t + .05, t1)}; });
    this.barF = plan.barStarts.map(ef);
  }
  dancerAt(n) { const fi = this.r.footageF(n), k = Math.min(this.fit.dpos.length - 1, Math.floor(fi / this.V.step)); return {k, fi, pos: this.fit.dpos[k]}; }
  shotIdx(n) { const s = this.shots; let k = 0; for (let i = 0; i < s.length; i++) if (s[i].f <= n) k = i; return k; }
  isCut(n) { return n > 0 && (this.shotIdx(n) !== this.shotIdx(n - 1) || this.r.stageOn(n) !== this.r.stageOn(n - 1)); }
  /** cinematic camera: per-shot path + beat kicks, spawn / det punches, swings, hand-held drift. Pure in n. */
  camAt(n) {
    const r = this.r, fps = this.fps, t = n / fps, plan = this.plan, si = this.shotIdx(n), S = this.shots[si] || {kind: 'orbit', az: 0, r: 1, h: 1, sgn: 1, t: 0, t1: 1, f: 0};
    const u = clamp((t - S.t) / Math.max(.05, S.t1 - S.t)), g = effectAt(plan.fx, t), I = plan.intensity;
    const dp = this.dposT[clamp(n, 0, this.dposT.length - 1)], T = [dp[0], .95, dp[2]];
    // narrow (9:16) frames: pull back, widen the lens, raise orbits and keep tracked framing near the centre
    const asp = r.W / r.H, narrow = asp < 1, port = narrow ? Math.min(1.4, 1 / Math.sqrt(asp)) : 1, lat = Math.min(1, asp * 9 / 16);
    const portO = narrow ? Math.min(1.7, Math.pow(1 / asp, .8)) : 1;             // orbits pull back further so the ring fits a tall frame
    let eye, tgt = T, fov, roll = 0, up = [0, 1, 0];
    const ring = (R, y, a) => [T[0] + R * Math.sin(a), y, T[2] + R * Math.cos(a)];
    if (S.kind === 'low') { eye = ring(3.0 * S.r * port, .32, S.az + S.sgn * 75 * DEG * u); tgt = [T[0], .85, T[2]]; fov = 52; roll = S.sgn * 3; }
    else if (S.kind === 'top') { const ph = S.az + S.sgn * 50 * DEG * u; eye = [T[0] + .25, port > 1 ? 10 : 8.5, T[2]]; tgt = [T[0], 0, T[2]]; up = [Math.cos(ph), 0, Math.sin(ph)]; fov = 54 - 6 * u; }
    else if (S.kind === 'push') { eye = ring((4.2 - 1.8 * easeOut(u)) * port, .18, S.az); tgt = [T[0], 1.25, T[2]]; fov = 46 - 10 * u; }
    else if (S.kind === 'track') { const nv = [Math.sin(S.az), 0, Math.cos(S.az)], tv = [Math.cos(S.az), 0, -Math.sin(S.az)], s = (-1.6 + 3.2 * u) * lat;
      eye = [T[0] + nv[0] * 3.1 * port + tv[0] * s * S.sgn, .9, T[2] + nv[2] * 3.1 * port + tv[2] * s * S.sgn]; tgt = [T[0] + tv[0] * .48 * lat * S.sgn, .95, T[2] + tv[2] * .48 * lat * S.sgn]; fov = 38; }
    else if (S.kind === 'rake') { const sb = plan.stageBars[S.bar] || {emAz: 0}, E = [8.5 * Math.sin(sb.emAz), .6, 8.5 * Math.cos(sb.emAz)], toC = nrm([-E[0], 0, -E[2]]), d = 1.2 + 1.5 * u;
      eye = [E[0] + toC[0] * d, .9, E[2] + toC[2] * d]; tgt = [T[0], 1.0, T[2]]; fov = 34; }
    else { const hi = S.high; eye = ring((hi ? 4.2 : 4.6) * S.r * portO, hi ? 3.6 : 1.35 * S.h * (narrow ? 1.8 : 1), S.az + S.sgn * 36 * DEG * u + 4 * DEG * Math.sin(2 * Math.PI * t / 3.1)); fov = hi ? 46 : 40;
      if (narrow) tgt = [T[0], hi ? .45 : .7, T[2]]; }
    // swings rotate the eye about the target; beat kicks dolly in and narrow the lens
    let yaw = 0; for (const sw of r.swings) { const a = (n - sw.f) / fps; if (a >= 0) yaw += sw.deg * g * DEG * .5 * Math.exp(-a / sw.tau) * Math.cos(2 * Math.PI * a / sw.per); }
    if (yaw && S.kind !== 'top') { const d = rotY(sub(eye, tgt), yaw); eye = add(tgt, d); }
    const b = r.beatAt(n), held = r.holds.some(h => n >= h.f0 && n < h.f1);
    const k = held ? 0 : elastic(b.ka) * (b.isBar ? 1.5 : 1) * I * g * b.kstr;
    let fw = nrm(sub(tgt, eye)), push = .22 * k;
    for (const d of r.detF) { const a = (n - d) / fps; if (a >= 0 && a < 1) push += .35 * I * g * Math.exp(-a / .12); }
    const nw = this.newestSpawn(t); if (nw != null) push += .35 * g * Math.exp(-(t - nw) / .12);
    eye = add(eye, scl(fw, push));
    eye = add(eye, [.012 * Math.sin(2 * Math.PI * 1.7 * t), .012 * Math.sin(2 * Math.PI * 1.3 * t + 1), .012 * Math.sin(2 * Math.PI * 1.1 * t + 2)]);
    eye[1] = Math.max(.12, eye[1]);
    const dv = sub(eye, tgt), dl = Math.hypot(...dv); if (dl < 1.2) eye = add(tgt, scl(dv, 1.2 / Math.max(dl, 1e-6)));
    fw = nrm(sub(tgt, eye));
    if (Math.abs(dot(fw, nrm(up))) > .98) up = [0, 0, -1];
    roll += (b.kb % 2 ? 1 : -1) * 1.5 * k;
    up = rotAxis(nrm(sub(up, scl(fw, dot(up, fw)))), fw, roll * DEG);
    if (narrow) fov = Math.min(fov * (1 + .45 * (1 - asp)), 62);
    return {eye, fw, up, fov: fov * DEG * (1 - .07 * k), T, si, kind: S.kind};
  }
  newestSpawn(t) { let nw = null; for (const g of this.plan.ghosts) if (!g.seeded && g.t <= t && t - g.t < .6 && !g.hidden) nw = g.t; return nw; }
  VP(c) { return mm(persp(c.fov, this.r.W / this.r.H, .05, 60), lookAt(c.eye, add(c.eye, c.fw), c.up)); }
  /** the dancer's points: billboard yaw about the feet + a backward tilt for high cameras (also the yaw a fresh ghost starts from). */
  dancerPose(n, cam) {
    const d = this.dancerAt(n), p = d.pos, ex = cam.eye[0] - p[0], ez = cam.eye[2] - p[2];
    const yaw = .85 * Math.atan2(ex, ez), elev = Math.atan2(cam.eye[1] - 1, Math.hypot(ex, ez));
    return {...d, yaw, tilt: .8 * elev * smoothstep(40 * DEG, 70 * DEG, elev)};
  }
  /** the point shader lifts pixels into source space; this maps them onto the stage (same map as the ghost slabs). */
  dancerModel(dp) {
    const f = this.fit, k = dp.k, A = f.A[k];
    const map = mm(mT([0, f.off[k], 0]), mm(mS([f.k, f.k, f.k * .35]), mT(scl(A, -1))));
    return mm(mT(dp.pos), mm(mRY(dp.yaw), mm(mRX(-dp.tilt), map)));
  }
  setFog(P, st) { const gl = this.gl; gl.uniform3fv(P.U('uEye'), this.cam.eye); gl.uniform3fv(P.U('uFogC'), hex(st.fog || '#06141a')); gl.uniform1f(P.U('uFogD'), st.fogD || .06); gl.uniform1f(P.U('uFogH'), st.fogH || 3.5); }
  setSpots(P) { const gl = this.gl, s = this.spots;
    gl.uniform3fv(P.U('uSpotP'), s.P); gl.uniform3fv(P.U('uSpotD'), s.D); gl.uniform3fv(P.U('uSpotC'), s.C); gl.uniform1fv(P.U('uSpotCos'), s.cos); }
  /** render the stage for frame n into tStage (+ bloom into tSA). */
  async draw(n, ctx) {
    const gl = this.gl, r = this.r, plan = this.plan, fps = this.fps, tn = n / fps, W = r.W, H = r.H, L = ctx.L, st = L.st, q = this.q;
    this.st = st;
    const cam = this.cam = this.camAt(n), VP = this.VP(cam), VPm = mm(VP, diagM), g = ctx.g, kick = ctx.kick;
    const O = orbitAt(plan, tn), bar = Math.max(0, r.lastIdx(this.barF, n + 1e-6)), sb = plan.stageBars[bar] || {lasers: 'cage', hoop: 1, emAz: 0, redGrid: false};
    const red = hex(st.red || '#ff2414'), emis = st.emis || 1;
    // ghosts alive now (plan state) + the yaw they print with (from the dancer billboard at their spawn frame)
    const live = ghostsAt(plan, tn).filter(x => x.coll < 1 && this.gseg[x.g.i] && this.gseg[x.g.i].cnt);
    let newest = null; for (const x of live) if (!x.g.seeded && (!newest || x.g.t > newest.g.t)) newest = x;
    for (const x of live) {
      const face = x.slotA + x.g.yawOff;
      // a fresh ghost starts in the dancer's billboard pose at its spawn frame (yaw and high-camera tilt), then settles upright
      if (x.u < 1) { const sn = Math.max(0, Math.floor(x.g.t * fps + 1e-6)), d0 = this.dancerPose(sn, this.camAt(sn)); x.yaw = angLerp(d0.yaw, face, x.u) + x.spinA; x.tilt = d0.tilt * (1 - x.u); }
      else { x.yaw = face + x.spinA; x.tilt = 0; }
    }
    const dpose = this.dancerPose(n, cam), dpos = dpose.pos;
    // spots: two follow the dancer, one the newest ghost, two sweep the ring
    const sw = 10 * DEG * Math.sin(2 * Math.PI * .2 * tn), spots = {P: [], D: [], C: [], cos: []};
    for (let i = 0; i < 5; i++) {
      const a = i * 72 * DEG + .3, P = [4 * Math.sin(a), 8, 4 * Math.cos(a)];
      let T = i < 2 ? [dpos[0] + (i ? .35 : -.35), 0, dpos[2]] : i === 2 && newest ? [newest.pos[0], 0, newest.pos[2]] : [2.9 * Math.sin(a + O.ang + 1.3 * i), 0, 2.9 * Math.cos(a + O.ang + 1.3 * i)];
      const D = rotY(nrm(sub(T, P)), sw * (i % 2 ? 1 : -1));
      const col = i % 2 ? C.white : st.spotTint ? hex(st.spotTint) : C.cyan, k = (st.spot ?? 1) * (i < 2 ? 1.25 : .9) * g;
      spots.P.push(...P); spots.D.push(...D); spots.C.push(...col.map(c => c * k)); spots.cos.push(Math.cos((8 + i * .75) * DEG));
    }
    this.spots = spots;
    // beams: pillars, lasers (fan or cage), hoop, spot shafts, laser floor hits
    const B = this.beams; let nb = 0;
    const beam = (A, wA, Bp, wB, col, I, kind) => { if (nb >= MAXB || I <= 0) return; B.set([A[0], A[1], A[2], wA, Bp[0], Bp[1], Bp[2], wB, col[0], col[1], col[2], I, kind, 0, 0, 0], nb * 16); nb++; };
    const P0 = plan.P, b0 = plan.beats[0] || 0, eighth = ((tn - b0) % (P0 / 2) + P0 / 2) % (P0 / 2), e8 = Math.floor((tn - b0) / (P0 / 2));
    const barA = (n - (this.barF[bar] || 0)) / fps, downPulse = Math.exp(-barA / .18);
    const laserK = (st.laser ?? 1) * g * (cam.kind === 'top' ? .45 : 1);
    for (const [N, R0] of [[20, 7.2], [28, 10.5]]) for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (hsh(i * 3.7 + R0) - .5) * 8 * DEG, isRed = hsh(i * 1.9 + R0 * 3.1) < .35, x = R0 * Math.sin(a), z = R0 * Math.cos(a);
      const chase = (i + e8) % 4 === 0 ? 1.6 : 1, I = isRed ? 1.6 * (1 + 2.2 * downPulse) * chase * laserK : 1.3 * (st.gridK ?? 1) * g;
      beam([x, 0, z], isRed ? .066 : .09, [x, 14, z], isRed ? .066 : .09, isRed ? red : C.pillarW, I, 1);
    }
    const hits = [];
    if (sb.lasers === 'fan') {
      const gate = .5 + Math.exp(-eighth / .08), sweep = 18 * DEG * Math.sin(2 * Math.PI * barA / (4 * P0)) * (bar % 2 ? 1 : -1);
      [[sb.emAz, .6], [sb.emAz + .5, 2.8]].forEach(([az, y], e) => {
        const E = [8.5 * Math.sin(az), y, 8.5 * Math.cos(az)], toC = Math.atan2(-E[0], -E[2]);
        for (let k = 0; k < 12; k++) {
          const ya = toC + (k / 11 - .5) * 70 * DEG + sweep * (e ? -1 : 1), el = (-8 + 28 * hsh(k * 1.31 + e)) * DEG + 6 * DEG * Math.sin(1.7 * k + 2 * tn);
          const d = [Math.cos(el) * Math.sin(ya), Math.sin(el), Math.cos(el) * Math.cos(ya)];
          let len = 30; if (d[1] < -1e-3) { len = Math.min(30, -E[1] / d[1]); }
          const end = add(E, scl(d, len)); beam(E, .012, end, .02, red, 2.2 * gate * laserK, 0);
          if (len < 30) hits.push(end);
        }
        beam(E, .5, E, .5, red, 2.5 * laserK, 4);
      });
    } else {
      const top = [0, 14, 0], calmK = O.calm > .6 ? .5 : 1;
      for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2 + O.ang * .5, A = [3.8 * Math.sin(a), 0, 3.8 * Math.cos(a)], tw = a + 12 * DEG, Tt = [1.2 * Math.sin(tw), top[1], 1.2 * Math.cos(tw)];
        beam(A, .012, Tt, .02, red, 1.4 * calmK * laserK * (.6 + .4 * Math.exp(-eighth / .1)), 0); }
    }
    for (const h of hits.slice(0, 24)) beam([h[0], .02, h[2]], .18, h, .18, red, 1.2 * laserK, 4);
    // hoop at the dancer: floor / waist / head, snaps between bars, swells on the kick
    const hb = sb.hoop ?? 1, hp = plan.stageBars[bar - 1] ? plan.stageBars[bar - 1].hoop : hb, hy = HOOP_H[hp] + (HOOP_H[hb] - HOOP_H[hp]) * snap(barA) + .05 * O.calm * Math.sin(Math.PI * tn);
    const hr = .55 * (1 + .1 * kick), hI = 2.6 * (st.hoop ?? 1) * g;
    for (let i = 0; i < HOOP_SEG; i++) { const a0 = i / HOOP_SEG * Math.PI * 2, a1 = (i + 1) / HOOP_SEG * Math.PI * 2;
      beam([dpos[0] + hr * Math.sin(a0), hy, dpos[2] + hr * Math.cos(a0)], .012, [dpos[0] + hr * Math.sin(a1), hy, dpos[2] + hr * Math.cos(a1)], .012, C.hoop, hI, 3); }
    for (let i = 0; i < 5; i++) { const Pp = spots.P.slice(i * 3, i * 3 + 3), Dd = spots.D.slice(i * 3, i * 3 + 3), len = Pp[1] / Math.max(.2, -Dd[1]), half = Math.acos(spots.cos[i]);
      beam(Pp, .05, add(Pp, scl(Dd, len)), Math.tan(half) * len, spots.C.slice(i * 3, i * 3 + 3), .6, 2); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bBeam); gl.bufferSubData(gl.ARRAY_BUFFER, 0, B.subarray(0, nb * 16)); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.nBeams = nb;
    // ---- passes
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fMS || this.fStage); gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(true); gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(r.vao0);
    // 1 sky
    { const P = this.PS, U = P.U; gl.useProgram(P.p); this.setFog(P, st); this.setSpots(P);
      const rt = nrm(cross(cam.fw, cam.up)), upv = cross(rt, cam.fw);
      gl.uniform3fv(U('uFw'), cam.fw); gl.uniform3fv(U('uRt'), rt); gl.uniform3fv(U('uUp'), upv); gl.uniform1f(U('uTanF'), Math.tan(cam.fov / 2)); gl.uniform1f(U('uAsp'), W / H);
      gl.uniform3fv(U('uSky'), hex(st.sky || '#07141a')); gl.uniform3fv(U('uSky2'), hex(st.sky2 || '#010203')); gl.uniform1f(U('uHaze'), st.haze ?? 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    // 2 mirror (planar reflection under the floor)
    this.drawGhosts(live, VPm, true, false, ctx, st, emis, newest);
    if (q.mirrorDancer) await this.drawDancer(VPm, dpose, ctx, true);
    this.drawBeams(VPm, true, cam);
    // 3 floor
    { const P = this.PF, U = P.U; gl.useProgram(P.p); this.setFog(P, st); this.setSpots(P);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 2);
      gl.uniformMatrix4fv(U('uVP'), false, new Float32Array(VP)); gl.uniform3fv(U('uGridC'), hex(st.gridC || '#cfefff')); gl.uniform3fv(U('uRedC'), red);
      gl.uniform3fv(U('uDancer'), dpos); gl.uniform1f(U('uGridK'), (st.gridK ?? 1) * g); gl.uniform1f(U('uRedGrid'), sb.redGrid ? 1 : 0); gl.uniform1f(U('uTheta'), O.ang);
      gl.uniform1f(U('uKick'), kick); gl.uniform1f(U('uRing'), (hb === 0 ? 1 : .35) * g); gl.uniform1f(U('uRefl'), st.refl ?? 1);
      const run = plan.runs.find(x => tn >= x.t0 && tn < x.t1), ra = run && sb.reveal ? tn - run.t0 : 9;
      gl.uniform4f(U('uWaves'), 9 * barA, 1.2 * Math.exp(-barA / .3) * g, 14 * ra, ra < 1.2 ? 2.5 * Math.exp(-ra / .35) * g : 0);
      const sh = [dpos[0], dpos[2], .42, .6]; for (const x of live) if (sh.length < q.nSh * 4) sh.push(x.pos[0], x.pos[2], Math.max(.25, x.g.w * .4), .4 * x.o);
      while (sh.length < 64) sh.push(0, 0, 1, 0);
      gl.uniform4fv(U('uSh'), new Float32Array(sh.slice(0, 64))); gl.uniform1f(U('uNSh'), Math.min(q.nSh, sh.length / 4));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.BLEND); }
    // 4 opaque plates, 5 dancer, 6 additive glass / holo plates + beams
    this.drawGhosts(live, VP, false, false, ctx, st, emis, newest);
    await this.drawDancer(VP, dpose, ctx, false);
    this.drawGhosts(live, VP, false, true, ctx, st, emis, newest);
    this.drawBeams(VP, false, cam);
    // 7 reset GL state for the rest of the renderer
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.BLEND);
    gl.depthFunc(gl.LESS); gl.depthMask(true); gl.colorMask(true, true, true, true); gl.frontFace(gl.CCW); gl.bindVertexArray(r.vao0);
    // 8 resolve + bloom
    if (this.fMS) { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fMS); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fStage); gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); }
    gl.viewport(0, 0, this.BW, this.BH); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fSA);
    gl.useProgram(this.PH.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tStage); gl.uniform1i(this.PH.U('uT'), 0);
    gl.uniform2f(this.PH.U('uPx'), 1 / W, 1 / H); gl.uniform2f(this.PH.U('uTh'), this.hdr ? 1.0 : .6, this.hdr ? 2.4 : 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const PL = r.PL; gl.useProgram(PL.p); gl.uniform1i(PL.U('uT'), 0);
    for (let i = 0; i < 3; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fSB); gl.bindTexture(gl.TEXTURE_2D, this.tSA); gl.uniform2f(PL.U('uDir'), 2 / this.BW, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fSA); gl.bindTexture(gl.TEXTURE_2D, this.tSB); gl.uniform2f(PL.U('uDir'), 0, 2 / this.BH); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const ndc = p => { const x = VP[0] * p[0] + VP[4] * p[1] + VP[8] * p[2] + VP[12], y = VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13], w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15]; return [x / w, y / w, w]; };
    const dn = ndc([dpos[0], .95, dpos[2]]), ring = live.filter(x => x.u >= 1), inF = ring.filter(x => { const q = ndc([x.pos[0], .9, x.pos[2]]); return q[2] > 0 && Math.abs(q[0]) < 1 && Math.abs(q[1]) < 1; }).length;
    return {live: live.length, shot: cam.kind, theta: +O.ang.toFixed(4), newestE: newest ? +newest.E.toFixed(3) : 0, calm: +O.calm.toFixed(3),
      dancerNdcX: +dn[0].toFixed(3), ringInFrame: ring.length ? +(inF / ring.length).toFixed(3) : null};
  }
  drawGhosts(live, VP, mirror, additive, ctx, st, emis, newest) {
    const gl = this.gl, P = this.PG, U = P.U, tn = ctx.n / this.fps;
    gl.useProgram(P.p); this.setFog(P, st); this.setSpots(P); gl.bindVertexArray(this.vaoSlab);
    gl.uniformMatrix4fv(U('uVP'), false, new Float32Array(VP)); gl.uniform1f(U('uMirror'), mirror ? 1 : 0); gl.uniform1f(U('uT'), tn);
    gl.uniform3fv(U('uKeyC'), C.key); gl.uniform3fv(U('uRedC'), hex(st.red || '#ff2414')); gl.uniform1f(U('uLaser'), (st.laser ?? 1) * ctx.g);
    if (additive) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); gl.depthMask(false); }
    else { gl.disable(gl.BLEND); gl.depthMask(true); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bInst);
    for (const x of live) {
      const m = MATS[x.g.mat] || MATS.whiteHot, glass = !!m.glass;
      let sxz; if (additive) sxz = glass ? 1 : 1 - x.o; else { if (glass) continue; sxz = x.o; }
      if (sxz <= .002 || (mirror && additive)) continue;
      const seg = this.gseg[x.g.i], S = STYLES[x.g.style] || STYLES.bar;
      if (additive && x.depthOff) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, seg.off * 32); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, seg.off * 32 + 16);
      gl.uniform3fv(U('uGPos'), x.pos); gl.uniform1f(U('uGYaw'), x.yaw); gl.uniform1f(U('uGTilt'), x.tilt || 0); gl.uniform1f(U('uCut'), this.cut[x.g.di] ? 1 : 0); gl.uniform1f(U('uAge'), x.g.seeded ? 9 : x.age); gl.uniform1f(U('uColl'), x.coll);
      gl.uniform1f(U('uSxz'), sxz); gl.uniform1f(U('uN'), S.n); gl.uniform1f(U('uRh'), S.rh); gl.uniform1f(U('uStyle'), S.id); gl.uniform1f(U('uSeed'), hsh(x.g.i * 3.17 + this.plan.seed));
      gl.uniform1f(U('uTwist'), .12 * x.calm);
      gl.uniform3fv(U('uAlb'), hex(m.alb)); gl.uniform3fv(U('uSpec'), hex(m.spec)); gl.uniform3fv(U('uRimC'), hex(m.rim)); gl.uniform1f(U('uGloss'), m.gloss); gl.uniform1f(U('uRimK'), m.rk); gl.uniform1f(U('uMetal'), m.metal);
      const E = x.E * (x === newest ? 1.25 : 1) * (1 + .25 * ctx.kick) * emis;
      gl.uniform3fv(U('uEmi'), hex(m.emi).map(c => c * m.ek)); gl.uniform1f(U('uE'), additive && !glass ? .45 * Math.max(E, .8) : E); gl.uniform1f(U('uDark'), x.dark);
      gl.uniform1f(U('uAdd'), additive ? 1 : 0); gl.uniform1f(U('uBody'), glass ? (m.body || .12) : .35); gl.uniform1f(U('uNewest'), x === newest ? 1 : 0);
      gl.drawElementsInstanced(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0, seg.cnt);
    }
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindVertexArray(this.r.vao0);
  }
  drawBeams(VP, mirror, cam) {
    if (!this.nBeams) return;
    const gl = this.gl, P = this.PBm, U = P.U;
    gl.useProgram(P.p); this.setFog(P, this.st || {}); gl.bindVertexArray(this.vaoBeam);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    const rt = nrm(cross(cam.fw, cam.up)), upv = cross(rt, cam.fw);
    gl.uniformMatrix4fv(U('uVP'), false, new Float32Array(VP)); gl.uniform1f(U('uMirror'), mirror ? 1 : 0); gl.uniform1f(U('uMirK'), mirror ? .4 : 1);
    gl.uniform1f(U('uPxK'), 2 * Math.tan(cam.fov / 2) / this.r.H); gl.uniform3fv(U('uCamR'), rt); gl.uniform3fv(U('uCamU'), upv);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nBeams);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(this.r.vao0);
  }
  /** the live dancer: the existing point shader, person only, source colour, mapped onto the stage. */
  async drawDancer(VP, dp, ctx, mirror) {
    const gl = this.gl, r = this.r, V = this.V, P = r.PD, U = P.U, W = r.W, H = r.H, st = ctx.L.st;
    const s = poseStats(V)[dp.k]; if (!s || !s.ok) return;
    const aS = V.w / V.h, Hv = H, Wv = Math.round(H * aS), cam = this.cam;
    const M = this.dancerModel(dp), VPm = mm(VP, M);
    // dot pitch from the dancer's on-screen height (about 2.2 px spacing), capped
    const top = [dp.pos[0], 1.75, dp.pos[2]], pj = p => { const x = VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13], w = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15]; return [x / Math.max(.05, w), w]; };
    const a = pj([dp.pos[0], 0, dp.pos[2]]), b = pj(top), hpx = Math.max(20, Math.abs(a[0] - b[0]) * H / 2);
    const bh = (s.rb - s.y0 + 1) / V.ah, rowsP = clamp(hpx / (mirror ? 4.4 : 2.2), 40, mirror ? 140 : 300), pitch = Math.max(1.2, bh * Hv / rowsP);
    const bx0 = Math.max(0, s.x0 - 2) / V.aw, by0 = Math.max(0, s.y0 - 2) / V.ah, bx1 = Math.min(V.aw, s.x1 + 3) / V.aw, by1 = Math.min(V.ah, s.rb + 3) / V.ah;
    const c0 = [Math.floor(bx0 * Wv / pitch), Math.floor(by0 * Hv / pitch)], cols = Math.ceil(bx1 * Wv / pitch) - c0[0] + 1, rows = Math.ceil(by1 * Hv / pitch) - c0[1] + 1;
    gl.useProgram(P.p); gl.bindVertexArray(r.vao0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r.tRaw[0]); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, r.tD[0]); gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(U('uR'), 0); gl.uniform1i(U('uD'), 1);
    gl.uniform1f(U('uPitch'), pitch); gl.uniform1f(U('uCols'), cols); gl.uniform2f(U('uRes'), Wv, Hv); gl.uniform2f(U('uCell0'), c0[0], c0[1]); gl.uniform4fv(U('uCrop'), [0, 0, 1, 1]);
    gl.uniform1f(U('uLod'), Math.max(0, Math.log2(pitch * V.w / Wv) - .2));
    gl.uniform1f(U('uInk'), 0); gl.uniform1f(U('uSrc'), 1); gl.uniform1f(U('uFull'), 1); gl.uniform1f(U('uGrid'), 0); gl.uniform1f(U('uSpark'), 0); gl.uniform1f(U('uRmin'), .62);
    gl.uniform1f(U('uGain'), 1.05); gl.uniform1f(U('uInv'), 0); gl.uniform3fv(U('uDot'), [1, 1, 1]); gl.uniform3fv(U('uBg'), hex(st.fog || '#06141a'));
    const spot = st.dancerTint ? hex(st.dancerTint) : [.95, .99, 1.04]; gl.uniform3fv(U('uTint'), spot.map(c => c * (st.dancerK ?? 1)));
    gl.uniform1f(U('uD0'), 1 / Math.tan(FOV0 / 2)); gl.uniform1f(U('uAsp'), aS); gl.uniform1f(U('uT'), ctx.n / this.fps); gl.uniform1f(U('uPd'), s.pd);
    gl.uniform1f(U('uSwell'), 1 + .2 * ctx.kick); gl.uniform1f(U('uHitZ'), 0); gl.uniform3fv(U('uWave'), [0, 0, 0]); gl.uniform1f(U('uOccA'), .7);
    gl.uniform1f(U('uEchoZ'), 0); gl.uniform1f(U('uHalo'), 0); gl.uniform1f(U('uLayer'), 0); gl.uniform1f(U('uDet'), 0); gl.uniform1f(U('uCat'), 2);
    gl.uniformMatrix4fv(U('uVP'), false, new Float32Array(VPm)); gl.uniform3fv(U('uEye'), [0, 0, 0]); gl.uniform3fv(U('uPiv'), [0, 0, -2]);
    const dist = Math.hypot(...sub(cam.eye, [dp.pos[0], 1, dp.pos[2]]));
    gl.uniform1f(U('uFocus'), dist); gl.uniform1f(U('uFovS'), this.fit.k * Math.tan(FOV0 / 2) / Math.tan(cam.fov / 2)); gl.uniform1f(U('uFogN'), dist + 3); gl.uniform1f(U('uFogF'), dist + 18);
    gl.uniform1f(U('uAlpha'), mirror ? .3 : 1);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, cols * rows);
    gl.depthMask(true); gl.disable(gl.BLEND);
    this.dancerPts = cols * rows;
  }
}
export { STAGE_PTS };
