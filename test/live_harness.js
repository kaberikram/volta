// Live webcam pipeline on synthetic input (no camera, no models): the synthetic dancer is drawn as the "camera" frame,
// an injected segmenter returns its mask and joint landmarks, and frames go through the real LiveAnalyzer and LiveCore
// (bundle, director, renderer) exactly as the live session does: camera frames on camera time, the song on song time
// (the harness drives both clocks instead of the camera and the audio).
import { LiveAnalyzer, LiveCore, LiveSession, liveFx, LIVE_FPS } from '../src/live.js';
import { DotRenderer } from '../src/renderer.js';
import { orbitAt, ghostsAt, stagePal } from '../src/planner.js';
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

const CAL = 20;          // camera frames before the song plays (the dancer's first pose calibrates the stage)
const OPTS = {seed: 1, scene: 'mix', intensity: 1, strobe: .7, palette: 'reference'};
let tsMs = 0;             // analyzer timestamps (monotonic, like rVFC capture times)
const analyse = (an, t) => { frameAt(t); tsMs += 33.4; return an.analyze(colour, null, tsMs, {mirror: false}); };
const shot = async (core, t) => { const st = await core.render(t), px = pixels(); return {t, st, hash: fnv1a(px), mean: px.reduce((a, b) => a + b, 0) / px.length, png: cv.toDataURL('image/png'), gl: glState()}; };

window.L = {
  /** song and camera together for `secs` seconds; render (and snapshot) the song frames listed in `shots` */
  async run({secs = 16, size = 540, scene = 'mix', seed = 1, shots = [], luma = false} = {}) {
    const an = new LiveAnalyzer({w: W, h: H, segmenter: luma ? null : segment});
    if (luma) an.mode = 'luma';
    const A = synthAnalysis(secs), h = size, w = Math.round(h * ASP / 2) * 2; R.setSize(w, h);
    const core = new LiveCore(R, {w: W, h: H, aw: an.aw, ah: an.ah, mode: luma ? 'luma' : 'pose', A, opts: {...OPTS, seed, scene}, fx: liveFx(A)}), out = {shots: [], ms: []};
    let ci = 0; for (; ci < CAL; ci++) core.pushFrame(ci, colour, analyse(an, 0));
    an.hRef = core.V.hRef;
    for (let fi = 0; fi < secs * LIVE_FPS; fi++, ci++) {
      const t = fi / LIVE_FPS; frameAt(t);
      const t0 = performance.now(); tsMs += 33.4; const r = an.analyze(colour, null, tsMs, {mirror: false}); out.ms.push(performance.now() - t0);
      core.pushFrame(ci, colour, r); core.dir.update(t, core.V.n - 1);
      if (shots.includes(fi)) out.shots.push({fi, ...(await shot(core, t))});
      if (fi % 30 === 0) statusEl.textContent = `live ${t.toFixed(1)}s ghosts ${core.dir.ghosts.length}`;
    }
    window.L.last = {an, core, A, ci, V: core.V, plan: core.plan};
    return out;
  },
  /** the transport on the last run (song at its end): seek back / forward, pause with a live camera, holds, live replans */
  async transport() {
    const L = window.L.last, {an, core} = L, V = core.V, dir = core.dir, out = {}, P = core.plan.P;
    const push = (t, k = 1) => { for (let i = 0; i < k; i++) core.pushFrame(L.ci++, colour, analyse(an, t)); };
    const play = async (t0, t1) => { for (let t = t0; t <= t1 + 1e-9; t += 1 / LIVE_FPS) { push(t); dir.update(t, V.n - 1); } };
    const visible = t => ghostsAt(core.plan, t).filter(x => x.coll < 1).length;
    // 1. backward seek into a plates run, a few prints in: later prints go, the ring rewinds, slots are restored
    const vis = dir.ghosts.filter(g => !g.hidden), g3 = vis[2], tb = Math.min(g3.t + .3, core.plan.runs.find(r => g3.t >= r.t0 && g3.t < r.t1).t1 - .1);
    const before = dir.ghosts.length, arr = dir.ghosts;
    core.seek(tb); R.hold = true;
    const sb = await shot(core, tb);
    out.back = {tb, before, after: dir.ghosts.length, same: arr === dir.ghosts, maxT: Math.max(...dir.ghosts.map(g => g.t)), orbitN: dir.orbit.n, nExp: Math.floor(tb * 30) + 1,
      jOk: dir.bt(dir.j / 2) <= tb + 1e-9 && dir.bt((dir.j + 1) / 2) > tb, drawn: sb.st.live, expect: visible(tb), stage: !!sb.st.stage, gl: sb.gl};
    // ... and play on from there: prints again, no burst, still t-sorted
    R.hold = false; const n0 = dir.ghosts.length; await play(tb, tb + 3);
    const ts = dir.ghosts.map(g => g.t);
    out.replay = {added: dir.ghosts.length - n0, sorted: ts.every((t, i) => !i || t >= ts[i - 1]), unique: new Set(ts).size === ts.length, perBarOk: [...dir.perBar.values()].every(v => v <= 6)};
    // 2. forward seek: no backlog of prints, the orbit carries on as extrapolated
    const tf = 13, angPred = orbitAt(core.plan, tf).ang, nF = dir.ghosts.length;
    core.seek(tf); const angAfter = orbitAt(core.plan, tf).ang; push(tf); dir.update(tf + 1 / LIVE_FPS, V.n - 1);
    out.fwd = {added: dir.ghosts.length - nF, angPred, angAfter};
    // 3. paused: the song stays at tf, the camera keeps coming -> the newest frame is on screen
    R.hold = true; push(tf); const p1 = await shot(core, tf); push(3.4); const p2 = await shot(core, tf);
    out.paused = {fi1: p1.st.fi, fi2: p2.st.fi, top: V.n - 1, differ: p1.hash !== p2.hash};
    // 4. a hold window: the frame on entry is pinned (survives 20 new camera frames), released after the window
    const n0h = Math.round(tf * 30) + 3; R.holds = [{f0: n0h, f1: n0h + 15}];
    const h1 = await shot(core, n0h / 30); push(5, 20); const h2 = await shot(core, (n0h + 5) / 30); const h3 = await shot(core, (n0h + 16) / 30);
    out.hold = {pin: h1.st.fi, inside: h2.st.fi, after: h3.st.fi, top: V.n - 1};
    R.holds = []; R.releaseLivePins();
    // 5. paused hold: a downbeat flash frame is not held on screen while paused
    const fl = R.flash.find(x => !x.burst && x.s > .6 && !R.stageOn(x.f) && x.f > 30);
    if (fl) { R.hold = false; const a = await shot(core, fl.f / 30); R.hold = true; const b = await shot(core, fl.f / 30); out.flash = {f: fl.f, open: a.mean, held: b.mean}; }
    // 6. live replans: palette, strobe, punch, seed keep the ring; dots and back keeps it too
    R.hold = false; const ts6 = 9.5; core.seek(ts6); await play(ts6, ts6 + 2);
    const ring = dir.ghosts, orbit = dir.orbit, phi0 = dir.phi0, cnt = ring.length, seeds = ring.map(g => g.seed), mats = ring.map(g => g.mat);
    const t0r = performance.now(); core.replan({...OPTS, palette: 'cool', strobe: .3, intensity: .6, seed: 2}, liveFx(L.A)); const replanMs = performance.now() - t0r;
    const sp = stagePal('cool'), rr = core.plan.runs.find(r => r.t0 < ts6), tStage = rr ? (rr.t0 + Math.min(rr.t1, ts6)) / 2 : ts6;
    const r1 = await shot(core, tStage);
    out.replan = {ms: replanMs, sameRing: core.plan.ghosts === ring && dir.ghosts === ring && ring.length === cnt, sameOrbit: core.plan.orbit === orbit, phi0: core.plan.live && core.plan.live.phi0 === phi0,
      seedsKept: ring.every((g, i) => g.seed === seeds[i]), matsOk: ring.every(g => (sp.mats[g.cls] || [g.mat]).includes(g.mat)), matsChanged: ring.some((g, i) => g.mat !== mats[i]),
      drawn: r1.st.stage ? r1.st.live : null, expect: visible(tStage), gl: r1.gl};
    core.replan({...OPTS, scene: 'dots'}, liveFx(L.A)); const dotsPlan = core.plan;
    await play(ts6 + 2.1, ts6 + 5); core.seek(ts6 + 1); const afterDotsSeek = dir.ghosts.length, maxAfter = Math.max(...dir.ghosts.map(g => g.t));
    core.replan({...OPTS, scene: 'mix'}, liveFx(L.A)); push(ts6 + 1); const nb = dir.ghosts.length; dir.update(ts6 + 1 + 1 / LIVE_FPS, V.n - 1);
    out.dots = {scene: dotsPlan.scene, dotsGhosts: dotsPlan.ghosts.length, kept: afterDotsSeek, maxAfter, tSeek: ts6 + 1, back: core.plan.ghosts === dir.ghosts, burst: dir.ghosts.length - nb};
    return out;
  },
  /** a session that starts on dots, before any camera frame; then plates; then a long paused stretch (memory) */
  async edges() {
    const an = new LiveAnalyzer({w: W, h: H, segmenter: segment}), A = synthAnalysis(16), out = {};
    const core = new LiveCore(R, {w: W, h: H, aw: an.aw, ah: an.ah, mode: 'pose', A, opts: {...OPTS, scene: 'dots'}, fx: liveFx(A)});
    out.empty = {core: await core.render(1), r: (await R.renderAt(1)).fi, gl: glState()};
    out.phi0 = core.dir.phi0; out.orbit = !!core.dir.orbit;
    let ci = 0; for (; ci < CAL; ci++) core.pushFrame(ci, colour, analyse(an, 0));
    core.replan({...OPTS, scene: 'mix'}, liveFx(A));
    for (let fi = 0; fi < 16 * 30; fi += 1, ci++) { const t = fi / 30; core.pushFrame(ci, colour, analyse(an, t)); core.dir.update(t, core.V.n - 1); }
    out.mix = {phi0: core.plan.live.phi0, ghosts: core.dir.ghosts.length, finite: ghostsAt(core.plan, 15).every(x => x.pos.every(Number.isFinite))};
    // long paused session: the same analysed frame pushed 2000 times (camera time runs on, the song does not)
    const r = analyse(an, 6.5), n0 = core.V.n, t0 = performance.now();
    for (let k = 0; k < 2000; k++) core.pushFrame(ci++, colour, r);
    out.memory = {ms: (performance.now() - t0) / 2000, grew: core.V.n - n0, stats0: core.V.stats[0] === undefined, statsTop: !!core.V.stats[core.V.n - 1], env: core.dir.env.length,
      slabs: core.V.cache.slabs.size, pool: R.pool.slots.length, dmKept: core.V.dm.filter(Boolean).length, render: !!(await core.render(15))};
    // the session's camera clock: a 10 s gap (hidden tab) continues at the next index instead of filling 300 frames
    const ses = new LiveSession(R); const src = new OffscreenCanvas(W, H); src.getContext('2d').drawImage(colour, 0, 0);
    Object.assign(ses, {core, an, video: src, w: W, h: H, colour: new OffscreenCanvas(W, H), frameMs: [], lastCi: core.V.n - 1, cap0: null});
    ses.cx = ses.colour.getContext('2d'); ses.cap0 = 5e5 - (core.V.n - 1) * 1000 / 30;
    const nA = core.V.n; ses.capture(5e5 + 33.4); ses.capture(5e5 + 10033.4);
    out.gap = {added: core.V.n - nA};
    // a 4-minute song: what a live settings change costs
    const A4 = synthAnalysis(16, {songDur: 240}), c4 = new LiveCore(R, {w: W, h: H, aw: an.aw, ah: an.ah, mode: 'pose', A: A4, opts: OPTS, fx: liveFx(A4)}), ms = [];
    for (const strobe of [.2, .4, .6, .8, .5]) { const q = performance.now(); c4.replan({...OPTS, strobe}, liveFx(A4)); ms.push(performance.now() - q); }
    out.replan4 = ms.sort((a, b) => a - b)[2];
    out.gl = glState();
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
    const {V, core} = window.L.last, plan = core.plan;
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
