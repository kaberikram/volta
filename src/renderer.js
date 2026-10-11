// WebGL2 point-cloud renderer: port of clip2_dots_v2 (c3.html) driven by a plan from planner.js.
import { VS, FS, QV, BRIGHT, BLUR, COMP, COMP_HDR } from './shaders.js';
import { Stage, STAGE_PTS } from './stage.js';
import { effectAt } from './planner.js';
import { clamp, easeOut, easeIO, hex, hsh, DEG, FOV0, D0, add, sub, scl, dot, lookAt, persp, mm, rotY, rotX, rotAxis, elastic, snap } from './util.js';

export const LOOKS = {
  led:    {bg: '#1c0604', src: 1, full: 1, rmin: .5},
  ledred: {bg: '#c3341a', src: 1, full: 1, rmin: .45, gain: 1.1},
  macro:  {bg: '#120403', src: 1, full: 1, rmin: .62, gain: 1.15},
  red:    {bg: '#e2401b', dot: '#ffffff'},
  cream:  {bg: '#f2e6c9', dot: '#16111b', ink: 1, grid: 1},
  gold:   {bg: '#000000', dot: '#ffc53a', grid: 1, gain: 1.3},
  pink:   {bg: '#1236ff', dot: '#ffb0cc', grid: .6},
  mono:   {bg: '#000000', dot: '#ffffff', grid: 1, gain: 1.05},
  yellow: {bg: '#ffd21f', dot: '#16111b', ink: 1},
  cyan:   {bg: '#00c6ee', dot: '#0d0d16', ink: 1},
  purple: {bg: '#2a0558', dot: '#f2e6c9', grid: 1},
  invdots:{bg: '#efe7d6', src: 1, full: 1, rmin: .4, inv: 1},
  spark:  {bg: '#000000', dot: '#ffffff', spark: 1}, sparkg: {bg: '#000000', dot: '#ffc53a', spark: 1}, sparkp: {bg: '#1a0533', dot: '#ffb0cc', spark: 1},
  echoB:  {bg: '#1236ff', dot: '#ffffff', echo: 1}, echoO: {bg: '#e2401b', dot: '#ffffff', echo: 1}, echoY: {bg: '#ffd21f', dot: '#ffffff', echo: 1}, echoC: {bg: '#00c6ee', dot: '#ffffff', echo: 1},
  echoK:  {bg: '#f2e6c9', dot: '#16111b', echo: 1}, echoW: {bg: '#000000', dot: '#ffffff', echo: 1},
  scatter:{bg: '#000000', dot: '#ffffff', grid: .5},
  raw:    {mode: 1},
  // plates stage looks (rendered by stage.js; every stage parameter lives under st, fallback = dots look if the stage can't run)
  plates:  {bg: '#06141a', st: {fallback: 'mono', fog: '#06141a', fogD: .06, sky: '#07141a', spot: 1, laser: 1, gridC: '#cfefff', gridK: 1.3}},
  platesR: {bg: '#1a0303', st: {fallback: 'mono', fog: '#1a0303', fogD: .075, sky: '#3a0606', sky2: '#060101', spot: 1, spotTint: '#ff4a3a', laser: 1.6, gridC: '#ffe2dc', gridK: .8, emis: 1.4}},
  platesW: {bg: '#2a3438', st: {fallback: 'mono', fog: '#2a3438', fogD: .085, sky: '#34414a', sky2: '#0b1013', haze: .5, spot: 1.5, laser: 1.1, gridK: 1, con: -.04, refl: .85}},
  platesC: {bg: '#031820', st: {fallback: 'mono', fog: '#031820', fogD: .07, sky: '#05202a', spot: 1.2, laser: 1, red: '#00c6ee', gridK: 1.2}},
  platesK: {bg: '#000000', st: {fallback: 'mono', fog: '#000000', fogD: .04, sky: '#000000', sky2: '#000000', haze: 0, spot: 0, laser: 0, gridK: 0, hoop: .4, emis: 2, dancerK: .25}},
};
export class DotRenderer {
  constructor(canvas) {
    this.cv = canvas;
    const gl = this.gl = canvas.getContext('webgl2', {antialias: false, alpha: false, preserveDrawingBuffer: true});
    if (!gl) throw new Error('WebGL2 not available');
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const prog = (v, f) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}; return {p, U: n => (n in u ? u[n] : (u[n] = gl.getUniformLocation(p, n)))}; };
    this.PD = prog(VS, FS); this.PB = prog(QV, BRIGHT); this.PL = prog(QV, BLUR); this.PC = prog(QV, COMP);
    this.prog = prog; this.vao0 = gl.createVertexArray(); gl.bindVertexArray(this.vao0);
    this.stage = new Stage(this);
    this.NS = 5; this.tRaw = []; this.tD = []; this.lr = []; this.ld = [];
    for (let i = 0; i < this.NS; i++) { this.tRaw.push(this.tex(4, 4, gl.LINEAR, true)); this.tD.push(this.tex(4, 4, gl.NEAREST)); this.lr.push(-1); this.ld.push(-1); }
    this.bmpCache = new Map(); this.fps = 30;
  }
  tex(w, h, filt, mip) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; }
  fbo(t) { const gl = this.gl, f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; }
  setSize(W, H) {
    if (this.W === W && this.H === H) return; const gl = this.gl;
    this.W = W; this.H = H; this.cv.width = W; this.cv.height = H;
    for (const t of [this.tDots, this.tA, this.tB]) if (t) gl.deleteTexture(t);
    this.tDots = this.tex(W, H, gl.LINEAR); this.fDots = this.fbo(this.tDots);
    this.BW = Math.max(8, W >> 2); this.BH = Math.max(8, H >> 2);
    this.tA = this.tex(this.BW, this.BH, gl.LINEAR); this.tB = this.tex(this.BW, this.BH, gl.LINEAR); this.fA = this.fbo(this.tA); this.fB = this.fbo(this.tB);
    if (this.stage.need) this.stage.resize(W, H);
  }
  setData(video, plan, fps) {
    this.V = video; this.plan = plan; this.fps = fps; this.lr.fill(-1); this.ld.fill(-1);
    const ef = t => Math.max(0, Math.floor(t * fps + 1e-6)), SF = fps / 30;
    this.ev = plan.sched.map(e => ({f: ef(e.t) + Math.round((e.strobe || 0) * SF), look: e.look, pitch: e.pitch, strobe: !!e.burst})).sort((a, b) => a.f - b.f);
    this.beatF = plan.beats.map(ef); this.barF = plan.barStarts.map(ef);
    this.flash = plan.flashes.map(x => ({f: ef(x.t) + Math.round((x.step || 0) * SF), c: hex(x.c), s: Math.min(1, x.s), burst: !!x.burst}));
    this.detF = plan.dets.map(ef); this.echoF = plan.echoHits.map(ef);
    this.holds = plan.holds.map(h => ({f0: ef(h.t0), f1: ef(h.t1)}));
    this.fz = plan.freeze ? {...plan.freeze, f0: ef(plan.freeze.t0), f1: ef(plan.freeze.t1)} : null;
    this.reform = plan.reform ? {f0: ef(plan.reform.t0), fm: ef(plan.reform.tm), f1: ef(plan.reform.t1)} : null;
    this.fly = plan.fly ? {f0: ef(plan.fly.t0), f1: ef(plan.fly.t1)} : null;
    this.swings = plan.swings.map(s => ({...s, f: ef(s.t)})); this.barCam = plan.barCam;
    this.SF = SF;
    this.stage.build(video, plan, fps);
    if (this.stage.need && this.stage.ok && this.W) this.stage.resize(this.W, this.H);
  }
  /** the schedule entry on screen at frame n (strobes are skipped where the fade lane is quiet) */
  evAt(n) {
    const g = effectAt(this.plan.fx, n / this.fps), quiet = g < 0.2;
    let ev = this.ev[0] || {look: 'led', pitch: 14, strobe: false};
    for (const e of this.ev) if (e.f <= n && !(quiet && e.strobe)) ev = e;
    if (quiet && ev.strobe) {
      let heldLook = null; for (const e of this.ev) if (e.f <= n && !e.strobe) heldLook = e;
      ev = heldLook || {look: 'led', pitch: ev.pitch || 14, strobe: false};
    }
    return ev;
  }
  stageOn(n) { const L = LOOKS[this.evAt(n).look]; return !!(L && L.st && this.stage.ok && this.stage.need && this.stage.W && effectAt(this.plan.fx, n / this.fps) >= .01); }
  /** beat state at frame n (same formulas as camAt) */
  beatAt(n) {
    const kb = this.lastIdx(this.beatF, n + 1e-6), ka = kb >= 0 ? (n - this.beatF[kb]) / this.fps : 9;
    const isBar = this.barF.includes(kb >= 0 ? this.beatF[kb] : -1), kstr = kb >= 0 ? clamp(.45 + (this.plan.kick[kb] || .6), .5, 1.2) : 1;
    return {kb, ka, isBar, kstr};
  }
  footageF(n) {
    const V = this.V, fz = this.fz;
    if (fz && n >= fz.f0 && n < fz.f1) return Math.min(V.n - 1, fz.frame);
    for (const h of this.holds) if (n >= h.f0 && n < h.f1) return Math.min(V.n - 1, Math.floor(h.f0 / this.fps * V.fps));
    return clamp(Math.floor(n / this.fps * V.fps), 0, V.n - 1);
  }
  crop(fi) {      // source-uv crop rect for the output aspect; follows the figure horizontally (e.g. 9:16 from landscape)
    const V = this.V, sa = V.w / V.h, oa = this.W / this.H, p = V.piv[Math.min(V.piv.length - 1, Math.floor(fi / V.step))];
    if (Math.abs(oa - sa) < .01) return [0, 0, 1, 1];
    if (oa < sa) { const w = oa / sa; const cx = clamp(p[0], w / 2, 1 - w / 2); return [cx - w / 2, 0, w, 1]; }
    const h = sa / oa; const cy = clamp(p[1], h / 2, 1 - h / 2); return [0, cy - h / 2, 1, h];
  }
  pivAt(n) { const fi = this.footageF(n), V = this.V, p = V.piv[Math.min(V.piv.length - 1, Math.floor(fi / V.step))], c = this.crop(fi), asp = this.W / this.H;
    const u = (p[0] - c[0]) / c[2], v = (p[1] - c[1]) / c[3], d = D0 * (2.4 - 1.8 * p[2]); return [(u * 2 - 1) * asp * d / D0, (1 - v * 2) * d / D0, -d]; }
  lastIdx(arr, n) { let k = -1; for (let i = 0; i < arr.length; i++) if (arr[i] <= n) k = i; return k; }
  camAt(nf) {
    const n = nf, fps = this.fps, I = this.plan.intensity, t = n / fps, g = effectAt(this.plan.fx, t);
    const held = this.holds.find(h => n >= h.f0 && n < h.f1);
    const kb = this.lastIdx(this.beatF, n + 1e-6), ka = kb >= 0 ? (n - this.beatF[kb]) / fps : 9;
    const isBar = this.barF.includes(kb >= 0 ? this.beatF[kb] : -1);
    const kstr = kb >= 0 ? clamp(.45 + (this.plan.kick[kb] || .6), .5, 1.2) : 1;
    const k = held ? 0 : elastic(ka) * (isBar ? 1.5 : 1) * I * g * kstr, sgn = kb % 2 ? 1 : -1;
    const bi = Math.max(0, this.lastIdx(this.barF, n + 1e-6)), ba = this.barF.length ? (n - this.barF[bi]) / fps : 0;
    const bc = this.barCam[bi] || {yaw: 0, roll: 0, pitch: 0}, pc = bi > 0 ? this.barCam[bi - 1] : {yaw: 0, roll: 0, pitch: 0}, s = snap(ba);
    let yaw = (pc.yaw + (bc.yaw - pc.yaw) * s) * g * DEG + 6 * DEG * g * Math.sin(2 * Math.PI * t / 5.7) + sgn * 5 * DEG * k;
    let pit = (pc.pitch + (bc.pitch - pc.pitch) * s) * g * DEG + 2.5 * DEG * g * Math.sin(2 * Math.PI * t / 4.3 + 1) + 1.5 * DEG * k * (kb % 3 ? 1 : -1);
    let roll = (pc.roll + (bc.roll - pc.roll) * s) * g * DEG + sgn * 2 * DEG * k;
    let dolly = 1 - .2 * k + .05 * g * Math.sin(2 * Math.PI * t / 6.3);
    let fov = FOV0 * (1 - .08 * k - (isBar ? .1 * I * g * elastic(ka, .09, .3) : 0));
    const lat = [sgn * .05 * k, 0, 0];
    for (const sw of this.swings) { const a = (n - sw.f) / fps; if (a >= 0) yaw += sw.deg * g * DEG * Math.exp(-a / sw.tau) * Math.cos(2 * Math.PI * a / sw.per); }
    if (this.swings.length && this.swings[0].f === 0) { const a0 = n / fps; dolly += .5 * I * g * Math.exp(-a0 / .15); }
    for (const d of this.detF) { const a = (n - d) / fps; if (a >= 0 && a < 1) dolly += .35 * I * g * Math.exp(-a / .12); }
    if (this.fly && n >= this.fly.f0 && n < this.fly.f1) { const u = (n - this.fly.f0) / (this.fly.f1 - this.fly.f0); dolly *= 1 - .9 * g * Math.pow(u, 1.6); }
    if (this.reform && n >= this.reform.f0 && n < this.reform.f1) { const u = (n - this.reform.f0) / (this.reform.f1 - this.reform.f0); yaw += 22 * DEG * g * Math.sin(Math.PI * u); }
    if (held) { const u = (n - held.f0) / (held.f1 - held.f0); dolly *= 1 - .14 * g * easeIO(u); }
    const piv = this.pivAt(n), fz = this.fz;
    if (fz && n >= fz.f0 && n < fz.f1) { const u = Math.sin(Math.PI * easeIO((n - fz.f0) / (fz.f1 - fz.f0))); yaw += fz.deg * DEG * u * g; pit += fz.lift * DEG * u * g; dolly *= 1 - .15 * u * g; }
    const rot = v => rotY(rotX(v, pit), yaw);
    const eye = add(add(piv, scl(rot(scl(piv, -1)), dolly)), rot(lat));
    const fw = rot([0, 0, -1]), up = rotAxis(rot([0, 1, 0]), fw, roll);
    return {eye, fw, up, fov, piv, kb, isBar, focus: Math.max(.2, dot(sub(piv, eye), fw))};
  }
  VPof(c) { return mm(persp(c.fov, this.W / this.H, .02, 80), lookAt(c.eye, add(c.eye, c.fw), c.up)); }
  speed(c0, c1) { const V0 = this.VPof(c0), V1 = this.VPof(c1); let s = 0, m = 0; const W = this.W, H = this.H;
    for (const p of [[-1, -.6, -3], [1, .6, -3], [0, 0, -1.6], [.8, -.5, -5], [-.8, .5, -1.2]]) {
      const pr = V => { const x = V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12], y = V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13], w = V[3] * p[0] + V[7] * p[1] + V[11] * p[2] + V[15]; return [x / w * W / 2, y / w * H / 2, w]; };
      const a = pr(V0), b = pr(V1); if (a[2] > .05 && b[2] > .05) { s += Math.hypot(a[0] - b[0], a[1] - b[1]); m++; } }
    return m ? s / m * (1080 / H) : 0; }
  async bitmap(fi) { if (this.bmpCache.has(fi)) return this.bmpCache.get(fi); const b = await createImageBitmap(this.V.frames[fi]); this.bmpCache.set(fi, b);
    if (this.bmpCache.size > 24) { const k = this.bmpCache.keys().next().value; this.bmpCache.get(k).close?.(); this.bmpCache.delete(k); } return b; }
  async load(slot, fi) { const gl = this.gl, V = this.V; fi = clamp(fi, 0, V.n - 1); const di = Math.min(V.dm.length - 1, Math.floor(fi / V.step));
    if (this.lr[slot] !== fi) { const b = await this.bitmap(fi); gl.bindTexture(gl.TEXTURE_2D, this.tRaw[slot]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b); gl.generateMipmap(gl.TEXTURE_2D); this.lr[slot] = fi; }
    if (this.ld[slot] !== di) { gl.bindTexture(gl.TEXTURE_2D, this.tD[slot]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, V.aw, V.ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, V.dm[di]); this.ld[slot] = di; } }

  async renderAt(t) {
    const gl = this.gl, fps = this.fps, W = this.W, H = this.H, V = this.V, I = this.plan.intensity;
    const n = Math.round(t * fps), SF = this.SF, g = effectAt(this.plan.fx, n / fps), quiet = g < 0.2;
    const ev = this.evAt(n);
    let L = LOOKS[ev.look] || LOOKS.led;
    if (L.st) { if (this.stageOn(n)) return this.renderStage(n, ev, L, g); L = LOOKS[L.st.fallback] || LOOKS.mono; }
    const fi = this.footageF(n);
    const lastAge = arr => { let a = 99; for (const f of arr) if (f <= n) a = (n - f) / fps; return a; };
    const held = this.holds.some(h => n >= h.f0 && n < h.f1);
    const cam = this.camAt(n);
    const ka = cam.kb >= 0 ? (n - this.beatF[cam.kb]) / fps : 9;
    const kick = held ? 0 : Math.exp(-ka / .05) * Math.min(1.3, I) * g;
    const swell = 1 + (cam.isBar ? .5 : .3) * kick;
    const echoAge = lastAge(this.echoF), echoHit = (echoAge < .35 ? Math.exp(-echoAge / .12) : 0) * g;
    const detAge = lastAge(this.detF);
    let det = detAge < .5 ? 1 - Math.exp(-detAge * 6) : 0, detFade = detAge < .5 ? 1 - clamp((detAge - .2) / .2) : 1;
    const rf = this.reform;
    if (rf && n >= rf.f0 && n < rf.f1) { det = n < rf.fm ? easeOut((n - rf.f0) / Math.max(1, rf.fm - rf.f0)) * .95 : .95 * (1 - easeIO((n - rf.fm) / Math.max(1, rf.f1 - rf.fm))); detFade = 1; }
    det *= g;
    const fz = this.fz && n >= this.fz.f0 && n < this.fz.f1;
    let fl = null; for (const x of this.flash) { if (quiet && x.burst) continue; if (n === x.f) fl = {c: x.c, s: x.s}; else if (n > x.f && n <= x.f + SF && !fl) fl = {c: x.c, s: x.s * .25}; }
    const echoLook = !!L.echo, echoN = echoLook ? 4 : (echoHit > 0 ? 3 : 0);
    await this.load(0, fi); for (let k = 1; k <= echoN; k++) await this.load(k, fi - 2 * k);
    const scale = Math.min(W, H) / 1080, pitch = Math.max(3, (ev.pitch || 12) * scale), cols = Math.ceil(W / pitch), rows = Math.ceil(H / pitch), N = cols * rows;
    const pd = V.piv[Math.min(V.piv.length - 1, Math.floor(fi / V.step))][2], area = V.area[Math.min(V.area.length - 1, Math.floor(fi / V.step))];
    const wave = [ka * D0 * 2.6, 0, held || ka > .4 ? 0 : (cam.isBar ? 1 : .7) * Math.exp(-ka / .14) * Math.min(1.3, I) * g];
    const spd = this.speed(this.camAt(n - 1), cam), trails = spd > 6 ? (spd > 25 ? 3 : 2) : 0;
    const crop = this.crop(fi), lod = Math.max(0, Math.log2(pitch * V.w * crop[2] / W) - .2), fx = g < 0.01 ? 0 : g;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fDots); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (fx > 0 && !L.mode) {
      const P = this.PD, U = P.U; gl.useProgram(P.p); gl.enable(gl.BLEND);
      gl.uniform1i(U('uR'), 0); gl.uniform1i(U('uD'), 1);
      const bind = k => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tRaw[k]); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tD[k]); };
      gl.uniform1f(U('uPitch'), pitch); gl.uniform1f(U('uCols'), cols); gl.uniform2f(U('uRes'), W, H); gl.uniform2f(U('uCell0'), 0, 0); gl.uniform4fv(U('uCrop'), crop); gl.uniform1f(U('uLod'), lod);
      gl.uniform1f(U('uInk'), L.ink || 0); gl.uniform1f(U('uSrc'), L.src || 0); gl.uniform1f(U('uFull'), L.full || 0); gl.uniform1f(U('uGrid'), L.grid || 0);
      gl.uniform1f(U('uSpark'), L.spark || 0); gl.uniform1f(U('uRmin'), L.rmin || .5); gl.uniform1f(U('uGain'), L.gain || 1); gl.uniform1f(U('uInv'), L.inv || 0);
      gl.uniform3fv(U('uDot'), hex(L.dot || '#ffffff')); gl.uniform3fv(U('uBg'), hex(L.bg || '#000000')); gl.uniform3fv(U('uTint'), [1, 1, 1]);
      gl.uniform1f(U('uD0'), D0); gl.uniform1f(U('uAsp'), W / H); gl.uniform1f(U('uT'), t); gl.uniform1f(U('uPd'), pd);
      gl.uniform1f(U('uSwell'), swell); gl.uniform1f(U('uHitZ'), kick * (cam.isBar ? 1.4 : 1)); gl.uniform3fv(U('uWave'), wave);
      gl.uniform1f(U('uOccA'), area < .03 ? .3 : .7); gl.uniform1f(U('uEchoZ'), 0); gl.uniform1f(U('uHalo'), 0); gl.uniform1f(U('uLayer'), 0);
      const setCam = c => { gl.uniformMatrix4fv(U('uVP'), false, new Float32Array(this.VPof(c))); gl.uniform3fv(U('uEye'), c.eye); gl.uniform3fv(U('uPiv'), c.piv);
        gl.uniform1f(U('uFocus'), c.focus); gl.uniform1f(U('uFovS'), Math.tan(FOV0 / 2) / Math.tan(c.fov / 2)); gl.uniform1f(U('uFogN'), c.focus * 1.15); gl.uniform1f(U('uFogF'), c.focus * 2.4); };
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const scene = alpha => {
        gl.uniform1f(U('uAlpha'), alpha);
        gl.uniform1f(U('uCat'), 0); gl.drawArrays(gl.POINTS, 0, N);
        if (!L.full && !L.spark) { gl.uniform1f(U('uCat'), 1); for (const l of [3, 2, 1]) { gl.uniform1f(U('uLayer'), l); gl.drawArrays(gl.POINTS, 0, N); } gl.uniform1f(U('uLayer'), 0); }
        if (L.spark || fz) { gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(U('uHalo'), 1); gl.uniform1f(U('uCat'), 2); gl.drawArrays(gl.POINTS, 0, N); gl.uniform1f(U('uHalo'), 0); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
        gl.uniform1f(U('uCat'), 2); gl.drawArrays(gl.POINTS, 0, N);
        gl.uniform1f(U('uCat'), 3); gl.drawArrays(gl.POINTS, 0, N);
      };
      if (echoN) { setCam(cam); gl.uniform1f(U('uCat'), 2);
        const tints = [[1, .25, .2], [1, .75, .1], [.2, 1, .5], [.3, .45, 1]];
        if (echoLook) { gl.uniform1f(U('uSrc'), 0); gl.uniform3fv(U('uDot'), [1, 1, 1]); }
        for (let k = echoN; k >= 1; k--) { bind(k); gl.uniform3fv(U('uTint'), tints[k - 1]); gl.uniform1f(U('uEchoZ'), k * .09); gl.uniform1f(U('uAlpha'), echoLook ? .85 : .55 * echoHit); gl.drawArrays(gl.POINTS, 0, N); }
        gl.uniform3fv(U('uTint'), [1, 1, 1]); gl.uniform1f(U('uEchoZ'), 0); gl.uniform1f(U('uSrc'), L.src || 0); gl.uniform3fv(U('uDot'), hex(L.dot || '#ffffff')); }
      bind(0);
      gl.uniform1f(U('uDet'), det); if (det > 0) gl.uniform1f(U('uFull'), 1);
      for (let j = trails; j >= 1; j--) { setCam(this.camAt(n - j * .5)); scene((det > 0 ? detFade : 1) * (.42 - .1 * j)); }
      setCam(cam);
      if (det > 0 && detFade < 1) { gl.uniform1f(U('uDet'), 0); gl.uniform1f(U('uFull'), L.full || 0); scene(1 - detFade); gl.uniform1f(U('uDet'), det); gl.uniform1f(U('uFull'), 1); }
      scene(det > 0 ? detFade : 1);
      gl.uniform1f(U('uDet'), 0);
      gl.disable(gl.BLEND); gl.viewport(0, 0, this.BW, this.BH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fA); gl.useProgram(this.PB.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tDots); gl.uniform1i(this.PB.U('uT'), 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.useProgram(this.PL.p); gl.uniform1i(this.PL.U('uT'), 0);
      for (let i = 0; i < 2; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fB); gl.bindTexture(gl.TEXTURE_2D, this.tA); gl.uniform2f(this.PL.U('uDir'), 1.6 / this.BW, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fA); gl.bindTexture(gl.TEXTURE_2D, this.tB); gl.uniform2f(this.PL.U('uDir'), 0, 1.6 / this.BH); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
    const C = this.PC; gl.useProgram(C.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tDots); gl.uniform1i(C.U('uDots'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tRaw[0]); gl.uniform1i(C.U('uR'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tA); gl.uniform1i(C.U('uBl'), 2);
    const bgc = hex(L.bg || '#000000'), bgl = .299 * bgc[0] + .587 * bgc[1] + .114 * bgc[2];
    const recoil = detAge < .3 ? Math.exp(-detAge / .06) : 0, shk = ((cam.isBar ? 10 : 5) * kick + 26 * recoil * I * g) * W / 1440, kbs = cam.kb * 7 + (detAge < .3 ? Math.round(detAge * fps) : 0);
    gl.uniform3fv(C.U('uBg'), bgc); gl.uniform1f(C.U('uMode'), L.mode || 0); gl.uniform1f(C.U('uFx'), fx); gl.uniform4fv(C.U('uCrop'), crop); gl.uniform2f(C.U('uRes'), W, H);
    gl.uniform2f(C.U('uShake'), shk * (hsh(kbs * 3.1) - .5) * 2 / W, shk * (hsh(kbs * 5.7) - .5) * 2 / H);
    gl.uniform1f(C.U('uCA'), ((cam.isBar ? 22 : 12) * kick + (14 * recoil + Math.min(10, spd * .25)) * g) * W / 1440); gl.uniform1f(C.U('uCon'), 1 + (L.full ? .2 : .35) * kick);
    gl.uniform1f(C.U('uBloom'), (bgl > .4 ? .2 : L.full ? .35 : .6) * (1 + .6 * kick));
    gl.uniform1f(C.U('uFlash'), fl ? fl.s * g : 0); gl.uniform3fv(C.U('uFlashCol'), fl ? fl.c : [1, 1, 1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return {n, fi, look: ev.look, kick: +kick.toFixed(2), det: +det.toFixed(2), spd: +spd.toFixed(1), freeze: !!fz, held};
  }
  /** plates stage frame: stage.js draws the HDR scene, then the stage composite (bloom, tonemap, CA, flash, fade lane). */
  async renderStage(n, ev, L, g) {
    const gl = this.gl, fps = this.fps, W = this.W, H = this.H, I = this.plan.intensity, SF = this.SF, st = L.st, fx = g < 0.01 ? 0 : g, quiet = g < 0.2;
    const fi = this.footageF(n); await this.load(0, fi);
    const b = this.beatAt(n), held = this.holds.some(h => n >= h.f0 && n < h.f1);
    const kick = held ? 0 : Math.exp(-b.ka / .05) * Math.min(1.3, I) * g;
    let fl = null; for (const x of this.flash) { if (quiet && x.burst) continue; if (n === x.f) fl = {c: x.c, s: x.s}; else if (n > x.f && n <= x.f + SF && !fl) fl = {c: x.c, s: x.s * .25}; }
    const S = this.stage, info = await S.draw(n, {n, g, kick, L, fi});
    const cam = S.cam, cut = S.isCut(n);
    let spd = 0, blur = [0, 0];
    if (!cut && n > 0) {
      const V0 = S.VP(S.camAt(n - 1)), V1 = S.VP(cam); let sx = 0, sy = 0, m = 0;
      for (const o of STAGE_PTS) { const p = [cam.T[0] + o[0], o[1], cam.T[2] + o[2]];
        const pr = V => { const x = V[0] * p[0] + V[4] * p[1] + V[8] * p[2] + V[12], y = V[1] * p[0] + V[5] * p[1] + V[9] * p[2] + V[13], w = V[3] * p[0] + V[7] * p[1] + V[11] * p[2] + V[15]; return [x / w, y / w, w]; };
        const a = pr(V0), c = pr(V1); if (a[2] > .05 && c[2] > .05) { sx += (c[0] - a[0]) / 2; sy += (c[1] - a[1]) / 2; m++; } }
      if (m) { sx /= m; sy /= m; spd = Math.hypot(sx * W, sy * H) * (1080 / H); const l = Math.hypot(sx, sy), k = l * W > 4 ? Math.min(1, .04 / Math.max(l, 1e-6)) * .5 : 0; blur = [sx * k, sy * k]; }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
    const C = S.PCH, U = C.U; gl.useProgram(C.p); gl.bindVertexArray(this.vao0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.tStage); gl.uniform1i(U('uDots'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tRaw[0]); gl.uniform1i(U('uR'), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, S.tSA); gl.uniform1i(U('uBl'), 2);
    const detAge = (() => { let a = 99; for (const f of this.detF) if (f <= n) a = (n - f) / fps; return a; })();
    const recoil = detAge < .3 ? Math.exp(-detAge / .06) : 0, shk = .5 * ((b.isBar ? 10 : 5) * kick + 26 * recoil * I * g) * W / 1440, kbs = b.kb * 7 + (detAge < .3 ? Math.round(detAge * fps) : 0);
    gl.uniform4fv(U('uCrop'), this.crop(fi)); gl.uniform2f(U('uRes'), W, H); gl.uniform1f(U('uFx'), fx);
    gl.uniform2f(U('uShake'), shk * (hsh(kbs * 3.1) - .5) * 2 / W, shk * (hsh(kbs * 5.7) - .5) * 2 / H); gl.uniform2f(U('uBlurV'), blur[0], blur[1]);
    gl.uniform1f(U('uCA'), .5 * ((b.isBar ? 22 : 12) * kick + (14 * recoil + Math.min(10, spd * .25)) * g) * W / 1440);
    gl.uniform1f(U('uCon'), 1.1 + .2 * kick + (st.con || 0)); gl.uniform1f(U('uBloom'), .55 * (1 + .6 * kick) * (st.bloom ?? 1));
    gl.uniform1f(U('uExp'), st.exp ?? 1); gl.uniform1f(U('uTone'), S.hdr ? 1 : 0); gl.uniform1f(U('uN'), n);
    gl.uniform1f(U('uFlash'), fl ? fl.s * g * .6 : 0); gl.uniform3fv(U('uFlashCol'), fl ? fl.c : [1, 1, 1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return {n, fi, look: ev.look, kick: +kick.toFixed(2), det: 0, spd: +spd.toFixed(1), freeze: false, held, stage: true, cut, dancerPts: S.dancerPts, ...info};
  }
}
