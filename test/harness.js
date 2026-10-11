// Browser side of the synthetic render harness (served page: /test/plates.html, driven by test/plates_e2e.mjs).
// Builds the fake analysis bundle (with JPEG frames) from test/synth.js, a plan from the real planner and a real
// DotRenderer, then exposes window.H:
//   await H.init({seed, palette, size, fps, aspect, intensity, strobe, opts, fx, synth}) -> summary
//       opts: extra makePlan options, passed straight through (e.g. a future {scene: 'plates'})
//       fx:   fade-lane keys [{t, v}] (default mirrors app.js bindFx: full effect from 0 to dur)
//       synth: options for synthBundle (dur, fps, step, aw, ah, w, h ...)
//   await H.shot(t)  -> {t, n, hash, stats, luma, redFrac, cyanFrac, gl}   hash = FNV-1a 32 of readPixels (default FB)
//   await H.png(t)   -> PNG data URL of the canvas (renders t first when given)
//   H.plan, H.renderer, H.bundle, H.grid, H.glState(), H.keyTimes(), H.sheet(items), H.synthSheet(times), H.digest()
import { DotRenderer } from '../src/renderer.js';
import { makePlan, describePlan } from '../src/planner.js';
import { synthBundle, synthSection, bundleDigest, fnv1a, SCRIPT } from './synth.js';

const cv = document.getElementById('view'), statusEl = document.getElementById('status');
const status = s => { if (statusEl) statusEl.textContent = s; };
const bundles = new Map();
let R = null, vao0 = null, lastBundle = null;

// app.js outSize(), with the video and the aspect select passed in
export function outSize(V, aspect, maxH) {
  const a = aspect;
  const ar = a === 'source' ? (V ? V.srcW / V.srcH : 4 / 3) : a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : 16 / 9;
  let H = maxH, W = H * ar;
  if (ar > 1) { W = maxH * ar; if (W > 1920) { W = 1920; H = W / ar; } }
  const ev = x => Math.max(16, Math.round(x / 2) * 2);
  return [ev(W), ev(H)];
}

async function getBundle(synth = {}) {
  const key = JSON.stringify(synth);
  if (!bundles.has(key)) {
    const t0 = performance.now();
    bundles.set(key, synthBundle({...synth, frames: 'browser', onProgress: p => status(`synthesising frames ${(p * 100).toFixed(0)}%`)}).then(V => {
      console.log(`[H] bundle ${V.w}x${V.h} n=${V.n} dm=${V.dm.length} built in ${((performance.now() - t0) / 1000).toFixed(1)}s`); return V; }));
  }
  return bundles.get(key);
}

function glState() {
  const gl = R.gl, vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const fbName = fb === null ? null : fb === R.fDots ? 'fDots' : fb === R.fA ? 'fA' : fb === R.fB ? 'fB' : 'other';
  return {DEPTH_TEST: gl.isEnabled(gl.DEPTH_TEST), CULL_FACE: gl.isEnabled(gl.CULL_FACE), BLEND: gl.isEnabled(gl.BLEND),
    POLYGON_OFFSET_FILL: gl.isEnabled(gl.POLYGON_OFFSET_FILL), SCISSOR_TEST: gl.isEnabled(gl.SCISSOR_TEST),
    VERTEX_ARRAY_BINDING: vao === null ? null : vao === vao0 ? 'default' : 'other', FRAMEBUFFER_BINDING: fbName, error: gl.getError()};
}

function pixelStats(px) {
  let ls = 0, red = 0, cyan = 0; const N = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    ls += .299 * r + .587 * g + .114 * b;
    if (r > 120 && r > 1.6 * g && r > 1.6 * b) red++;
    if (g > 110 && b > 110 && r < .6 * Math.min(g, b)) cyan++;
  }
  const r4 = x => Math.round(x * 1e4) / 1e4;
  return {luma: r4(ls / N / 255), redFrac: r4(red / N), cyanFrac: r4(cyan / N)};
}

const H = window.H = {
  ready: false, SCRIPT, outSize,
  async init({seed = 1, palette = 'reference', intensity = 1, strobe = .7, size = 540, fps = 30, aspect = 'source', opts = {}, fx = null, synth = {}, stageQ = null} = {}) {
    status('building synthetic bundle…');
    const V = await getBundle(synth), sec = synthSection(V.dur);
    const plan = makePlan(sec.grid, V.dur, V, {seed, intensity, strobe, palette, ...opts});
    plan.fx = fx ? fx.map(k => ({t: k.t, v: k.v})) : [{t: 0, v: 1}, {t: Math.max(.001, plan.dur || 0), v: 1}];   // app.js bindFx default
    if (!R) { R = new DotRenderer(cv); vao0 = R.gl.getParameter(R.gl.VERTEX_ARRAY_BINDING); }
    if (lastBundle && lastBundle !== V) { for (const b of R.bmpCache.values()) b.close?.(); R.bmpCache.clear(); }   // renderer caches bitmaps by frame index
    lastBundle = V;
    const [W, Hh] = outSize(V, aspect, size);
    R.stageQ = stageQ || undefined;
    R.setSize(W, Hh); R.setData(V, plan, fps);
    Object.assign(H, {plan, renderer: R, bundle: V, grid: sec.grid, section: sec, W, H: Hh, fps, cfg: {seed, palette, intensity, strobe, size, fps, aspect, opts, synth}});
    const sum = {W, H: Hh, fps, n: V.n, dur: V.dur, roles: plan.roles, nSched: plan.sched.length, describe: describePlan(plan),
      scene: plan.scene, runs: plan.runs || [], ghosts: (plan.ghosts || []).map(g => ({t: g.t, hidden: g.hidden, seeded: g.seeded})),
      stage: {ok: R.stage.ok, err: R.stage.err || null, hdr: !!R.stage.hdr, samples: R.stage.samples ?? null, soft: R.stage.soft}};
    status(`${W}x${Hh} @${fps} seed ${seed} ${palette}\n${plan.roles.join(' ')}`);
    return sum;
  },
  glState: () => glState(),
  async shot(t) {
    const stats = await R.renderAt(t), gl = R.gl, W = R.W, Hh = R.H, gs = glState();
    const px = new Uint8Array(W * Hh * 4), prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    return {t, n: stats.n, hash: fnv1a(px), stats, ...pixelStats(px), gl: gs};
  },
  async png(t) { if (t != null) await R.renderAt(t); return cv.toDataURL('image/png'); },
  async jpg(t, q = .92) { const st = await R.renderAt(t); return {url: cv.toDataURL('image/jpeg', q), stats: st}; },
  /** footage frame shown at t (holds / freeze move it), for picking comparable times across plans */
  footage: t => R.footageF(Math.round(t * R.fps)),
  digest: () => bundleDigest(H.bundle),
  /** Up to `max` frame-exact times aimed at distinct renderer states of the current plan + the synth script markers. */
  keyTimes(max = 12) {
    const fps = R.fps, dur = H.bundle.dur, last = Math.floor(dur * fps) - 1, out = [];
    const put = (label, f) => { if (f == null || !Number.isFinite(f)) return; f = Math.max(0, Math.min(last, Math.round(f)));
      if (out.length < max && !out.some(o => Math.abs(o.f - f) < 3)) out.push({label, f}); };
    const ev = R.ev, firstEv = (pred, d = 0) => { const e = ev.find(pred); return e ? e.f + d : null; };
    put('strobe-raw', firstEv(e => e.strobe && e.look === 'raw'));
    put('hold', R.holds[0] && Math.floor((R.holds[0].f0 + R.holds[0].f1) / 2));
    put('freeze', R.fz && Math.floor((R.fz.f0 + R.fz.f1) / 2));
    put('still', 6.5 * fps); put('offgrid', 9.8 * fps); put('pan', 12.5 * fps); put('jump', 13.83 * fps);
    put('echo', firstEv(e => /^echo/.test(e.look), 2));
    const det = R.detF.find(f => f > 0); put('det', det == null ? null : det + 4);
    put('reform', R.reform && R.reform.fm);
    put('strobe-flat', firstEv(e => e.strobe && e.look !== 'raw'));
    put('drop', 3);
    for (let k = 0; out.length < max && k < 64; k++) put('even', (k + .5) / 64 * last);
    out.sort((a, b) => a.f - b.f);
    return out.map(o => ({label: o.label, f: o.f, t: o.f / fps}));
  },
  /** Compose images into one PNG: items [{url, label}] (data URLs or ImageBitmap/canvas). */
  async sheet(items, {cols = 4, w = 320, pad = 4, title = ''} = {}) {
    const imgs = await Promise.all(items.map(async it => (typeof it.url === 'string' ? await createImageBitmap(await (await fetch(it.url)).blob()) : it.url)));
    const h = Math.round(w * imgs[0].height / imgs[0].width), rows = Math.ceil(items.length / cols), top = title ? 20 : 0;
    const c = document.createElement('canvas'); c.width = cols * (w + pad) + pad; c.height = rows * (h + pad) + pad + top;
    const g = c.getContext('2d'); g.fillStyle = '#202020'; g.fillRect(0, 0, c.width, c.height); g.font = '12px monospace'; g.textBaseline = 'top';
    if (title) { g.fillStyle = '#ddd'; g.fillText(title, pad, 4); }
    items.forEach((it, i) => { const x = pad + (i % cols) * (w + pad), y = top + pad + Math.floor(i / cols) * (h + pad);
      g.drawImage(imgs[i], x, y, w, h);
      if (it.label) { const tw = g.measureText(it.label).width; g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(x, y + h - 16, tw + 6, 16); g.fillStyle = '#fff'; g.fillText(it.label, x + 3, y + h - 14); } });
    return c.toDataURL('image/png');
  },
  /** Source frame / depth / mask of the synthetic bundle at the given times, one row per time. */
  async synthSheet(times, {w = 300} = {}) {
    const V = H.bundle, items = [];
    const map = (k, ch) => { const d = V.dm[k], c = new OffscreenCanvas(V.aw, V.ah), g = c.getContext('2d'), im = g.createImageData(V.aw, V.ah);
      for (let p = 0; p < V.aw * V.ah; p++) { const v = d[p * 4 + ch]; im.data[p * 4] = im.data[p * 4 + 1] = im.data[p * 4 + 2] = v; im.data[p * 4 + 3] = 255; }
      g.putImageData(im, 0, 0); return c.transferToImageBitmap(); };
    for (const t of times) {
      const fi = Math.min(V.n - 1, Math.floor(t * V.fps)), k = Math.min(V.dm.length - 1, Math.floor(fi / V.step)), p = V.piv[k];
      items.push({url: await createImageBitmap(V.frames[fi]), label: `${t.toFixed(2)}s frame ${fi}`});
      items.push({url: map(k, 0), label: `depth  piv ${p.map(x => x.toFixed(2)).join(',')}`});
      items.push({url: map(k, 1), label: `mask  area ${V.area[k].toFixed(3)}  motion ${V.motion[fi].toFixed(2)}`});
    }
    return H.sheet(items, {cols: 3, w, title: 'synthetic bundle: colour frame | depth (R) | mask (G)'});
  },
};
H.ready = true;
status('ready: await H.init()');
