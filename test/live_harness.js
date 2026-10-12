// Live webcam pipeline on synthetic input (no camera, no models): the synthetic dancer is drawn as the "camera" frame,
// an injected segmenter returns its mask and joint landmarks, and frames go through the real LiveAnalyzer, LiveBundle,
// LiveDirector and DotRenderer exactly as a live take does (song time driven by the harness instead of the audio clock).
import { LiveAnalyzer, LiveBundle, LiveDirector, livePlan, liveFx, LIVE_FPS } from '../src/live.js';
import { DotRenderer } from '../src/renderer.js';
import { orbitAt, ghostsAt } from '../src/planner.js';
import { rasterRGBA, rasterDepthMask, skeleton, poseAt, synthAnalysis, fnv1a, SCRIPT } from './synth.js';

const cv = document.getElementById('view'), statusEl = document.getElementById('status');
const R = new DotRenderer(cv), vao0 = R.gl.getParameter(R.gl.VERTEX_ARRAY_BINDING);
const W = 640, H = 360, ASP = W / H;
const colour = new OffscreenCanvas(W, H), cx = colour.getContext('2d');
// MediaPipe-style landmarks (normalised x, y; z < 0 = nearer than the hips) from the synthetic skeleton
function landmarks(t) {
  const sk = skeleton(poseAt(t), ASP), lm = Array.from({length: 33}, () => ({x: .5, y: .5, z: 0, v: 0}));
  const put = (i, p, depth) => { lm[i] = {x: p[0] / ASP, y: p[1], z: -(depth - .63) * 3, v: 1}; };
  const parts = {}; for (const c of sk.caps) (parts[c.part] = parts[c.part] || []).push(c);
  const byX = arr => [...arr].sort((a, b) => a.a[0] - b.a[0]);
  const [uaL, uaR] = byX(parts.upperArm), [faL, faR] = byX(parts.foreArm), [thL, thR] = byX(parts.thigh), [shL, shR] = byX(parts.shin);
  put(11, uaL.a, uaL.depth); put(13, uaL.b, uaL.depth); put(15, faL.b, faL.depth); put(12, uaR.a, uaR.depth); put(14, uaR.b, uaR.depth); put(16, faR.b, faR.depth);
  put(23, thL.a, .63); put(24, thR.a, .63); put(25, thL.b, thL.depth); put(26, thR.b, thR.depth); put(27, shL.b, shL.depth); put(28, shR.b, shR.depth);
  return lm;
}
let curT = 0;            // the pose the injected segmenter reports = the pose drawn into the current frame
function frameAt(t) { curT = t; const px = rasterRGBA(t, W, H, {aspect: ASP}); cx.putImageData(new ImageData(px, W, H), 0, 0); }
const segment = () => ({mask: rasterDepthMask(curT, 266, 150, {aspect: ASP}).mask, lm: landmarks(curT)});
function glState() {
  const gl = R.gl, vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  return {DEPTH_TEST: gl.isEnabled(gl.DEPTH_TEST), CULL_FACE: gl.isEnabled(gl.CULL_FACE), BLEND: gl.isEnabled(gl.BLEND), POLYGON_OFFSET_FILL: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
    VERTEX_ARRAY_BINDING: vao === vao0 ? 'default' : vao === null ? null : 'other', FRAMEBUFFER_BINDING: fb === null ? null : 'other', error: gl.getError()};
}
const pixels = () => { const gl = R.gl, px = new Uint8Array(R.W * R.H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, R.W, R.H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

window.L = {
  /** run a take of `secs` seconds; render (and snapshot) the frames listed in `shots` (frame indices) */
  async run({secs = 16, size = 540, scene = 'mix', seed = 1, shots = [], luma = false} = {}) {
    const an = new LiveAnalyzer({w: W, h: H, segmenter: luma ? null : segment});
    if (luma) an.mode = 'luma';
    const A = synthAnalysis(secs), V = new LiveBundle({w: W, h: H, aw: an.aw, ah: an.ah});
    const plan = livePlan(A, V, {seed, scene: luma ? 'dots' : scene, intensity: 1, strobe: .7, palette: 'reference'}); plan.fx = liveFx(A);
    const h = size, w = Math.round(h * ASP / 2) * 2; R.setSize(w, h); R.setData(V, plan, LIVE_FPS);
    const dir = new LiveDirector(plan, V, R.stage), out = {shots: [], ms: []};
    // count-in: the dancer's first pose, used to calibrate the stage
    const cal = []; for (let i = 0; i < 20; i++) { frameAt(0); cal.push(an.analyze(colour, null, i * 33, {mirror: false})); }
    V.calibrate(cal); an.hRef = V.hRef;
    for (let fi = 0; fi < secs * LIVE_FPS; fi++) {
      const t = fi / LIVE_FPS; frameAt(t);
      const t0 = performance.now(), r = an.analyze(colour, null, 1000 + t * 1000, {mirror: false}); out.ms.push(performance.now() - t0);
      V.push(fi, r); R.pushLiveFrame(fi, colour, r.dm, fi); dir.frame(fi); dir.update(t);
      if (shots.includes(fi)) { const st = await R.renderAt(t), px = pixels();
        out.shots.push({fi, t, st, hash: fnv1a(px), png: cv.toDataURL('image/png'), gl: glState()}); }
      if (fi % 30 === 0) statusEl.textContent = `live ${t.toFixed(1)}s ghosts ${plan.ghosts.length}`;
    }
    window.L.last = {an, V, plan, dir, A};
    return out;
  },
  /** depth probes on the last analysed frame of a given time */
  probe(t) {
    const {an} = window.L.last, aw = an.aw, ah = an.ah; frameAt(t);
    const r = an.analyze(colour, null, 1e6 + t * 1000, {mirror: false}), d = (u, v) => r.dm[(Math.round(v * ah) * aw + Math.round(u * aw)) * 4] / 255, mk = (u, v) => r.dm[(Math.round(v * ah) * aw + Math.round(u * aw)) * 4 + 1] / 255;
    let ps = 0, pn = 0, bs = 0, bn = 0; for (let p = 0; p < aw * ah; p++) { if (r.dm[p * 4 + 1] > 127) { ps += r.dm[p * 4]; pn++; } else { bs += r.dm[p * 4]; bn++; } }
    const sk = skeleton(poseAt(t), ASP), caps = Object.fromEntries(sk.caps.map(c => [c.part + (c.a[0] > sk.px ? 'R' : 'L'), c]));
    const mid = c => [(c.a[0] + c.b[0]) / 2 / ASP, (c.a[1] + c.b[1]) / 2];
    const torso = caps.torsoL || caps.torsoR, tm = mid(torso), edgeU = (torso.a[0] / ASP) - torso.r / ASP * .8;
    const faL = caps.foreArmL, faR = caps.foreArmR;
    return {person: ps / pn / 255, background: bs / bn / 255, torsoCentre: d(tm[0], tm[1]), torsoEdge: d(edgeU, tm[1]), torsoEdgeMask: mk(edgeU, tm[1]),
      armL: faL ? d(...mid(faL)) : null, armR: faR ? d(...mid(faR)) : null, area: r.area};
  },
  stats() {
    const {V, plan} = window.L.last, ks = [];
    return {n: V.n, calibrated: V.calibrated, k: V.fit.k, dmKept: V.dm.filter(Boolean).length, pool: R.pool.slots.length, ghosts: plan.ghosts.map(g => ({t: g.t, hidden: g.hidden, i: g.i})),
      runs: plan.runs, P: plan.P, beats0: plan.beats[0], orbit: [0, 1, 2, 3, 4, 5, 6, 7, 7.9, 9, 10, 11, 12, 13, 14, 15].map(t => orbitAt(plan, t)), live: [2, 4, 6.5, 7.5, 10, 14].map(t => ghostsAt(plan, t).length), scene: plan.scene, still: SCRIPT.still};
  },
  sheet: async (items, w = 320) => {
    const imgs = await Promise.all(items.map(async u => createImageBitmap(await (await fetch(u)).blob()))), hh = Math.round(w * imgs[0].height / imgs[0].width), cols = 4, rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas'); c.width = cols * w; c.height = rows * hh; const g = c.getContext('2d'); imgs.forEach((im, i) => g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * hh, w, hh)); return c.toDataURL('image/png');
  },
  ready: true,
};
statusEl.textContent = 'ready';
